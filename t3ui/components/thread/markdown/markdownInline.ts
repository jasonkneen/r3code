// The inline layer of chat markdown: walks a parsed TextView document and swaps the nodes the reference draws as chips for
// custom nodes (ChatMarkdown's `a` and `code` renderers and SkillInlineText.tsx), so each chip is a View sitting in the line
// of text, and the rest of the text keeps wrapping and selecting as TextView draws it. Pure: no rendering, no store.
import type { TextViewBlock, TextViewDocument, TextViewInline, TextViewListItem } from "nsh/base";
import {
  buildFileLinkParentSuffixByPath,
  fileLinkLabel,
  isMarkdownFileLinkLabel,
  normalizeMarkdownLinkDestination,
  resolveInlineCodeFileLinkMeta,
  resolveMarkdownFileLinkMeta,
  type MarkdownFileLinkMeta,
} from "./fileLinkMeta";
import { parseThreadHref } from "./markdownLinks";
import { parseAssistantCitationHref, type AssistantCitation } from "./assistantCitations";
import { collectComposerModelMentions, type ModelMentionPresentation } from "./modelMentions";

export interface InlineSkill { name: string; displayName: string | null; description?: string | null; path?: string }

export interface InlineContext {
  /** The thread's workspace; without one no link is a file link. */
  cwd: string | null;
  /** The provider's skills: `$name` in text becomes a skill chip. */
  skills: readonly InlineSkill[];
  /** Whether a link to a web page may become a chip (favicon and a context menu). */
  webLinkChips: boolean;
  /** A `model:<instance>/<model>` mention's presentation; null (the model is not offered) leaves it as text, as in ModelMentionChip. */
  models?: (instanceId: string, model: string) => ModelMentionPresentation | null;
}

export type InlineChipName = "filelink" | "threadlink" | "citation" | "skill" | "model" | "weblink" | "inlinecode";

export interface TableColumnBounds { minPx: number; totalMinPx: number }
export interface FileChipData { meta: MarkdownFileLinkMeta; href: string; label: string; copyMarkdown: string; inlineCode: boolean; tableColumn?: TableColumnBounds }
export interface InlineCodeData { code: string }
export interface ThreadChipData { threadId: string; environmentId: string | null; label: string | null; tableColumn?: TableColumnBounds }
export interface CitationChipData { citation: AssistantCitation; tableColumn?: TableColumnBounds }
export interface SkillChipData { skill: InlineSkill; raw: string; tableColumn?: TableColumnBounds }
export interface ModelChipData { presentation: ModelMentionPresentation; source: string; tableColumn?: TableColumnBounds }
export interface WebChipData { url: string; host: string; label: string; tableColumn?: TableColumnBounds }

/** Longest link text a web link chip carries: a chip stays on one line, so a longer link keeps wrapping as text. */
export const WEB_CHIP_MAX_LABEL = 48;

export function inlinePlainText(content: readonly TextViewInline[]): string {
  return content.map((node): string => {
    switch (node.type) {
      case "text": return node.text;
      case "code": return node.code;
      case "keyboard": return node.text;
      case "break": return " ";
      case "math": return node.tex;
      case "image": return node.alt ?? "";
      case "footnoteReference": return "";
      case "custom": return node.text ?? "";
      default: return "content" in node ? inlinePlainText(node.content) : "";
    }
  }).join("");
}

function custom<T>(name: InlineChipName, text: string, data: T): TextViewInline {
  return { type: "custom", name, text, data } as TextViewInline;
}

// ---- skills ----

const SKILL_TOKEN_REGEX = /(^|\s)\p{Sc}(?![0-9][0-9_]*(?:[kKmMbBtT]|[eE][0-9]+)?(?:\s|$))(?=[a-zA-Z0-9:_-]*[a-zA-Z])([a-zA-Z0-9][a-zA-Z0-9:_-]*)(?=\s|$)/gu;

/** `$name` tokens in a text that name one of the skills (shared inlineSkills.ts `matchInlineSkills`). */
export function matchInlineSkills(text: string, skills: readonly InlineSkill[]): { start: number; end: number; skill: InlineSkill; raw: string }[] {
  const found: { start: number; end: number; skill: InlineSkill; raw: string }[] = [];
  const byName = new Map<string, InlineSkill | undefined>();
  for (const match of text.matchAll(SKILL_TOKEN_REGEX)) {
    const name = match[2] ?? "";
    if (!byName.has(name)) byName.set(name, skills.find((candidate) => candidate.name === name));
    const skill = byName.get(name);
    if (!skill) continue;
    const start = (match.index ?? 0) + (match[1]?.length ?? 0);
    found.push({ start, end: (match.index ?? 0) + match[0].length, skill, raw: `$${name}` });
  }
  return found;
}

export const skillDisplayName = (skill: Pick<InlineSkill, "name" | "displayName">): string => skill.displayName?.trim() || skill.name;

/** SkillInlineText: the `$skill` and `model:<instance>/<model>` references of a text, in order, the earlier one winning an overlap. */
function splitSkills(
  text: string,
  skills: readonly InlineSkill[],
  models: InlineContext["models"],
  tableColumn?: TableColumnBounds,
): TextViewInline[] | null {
  const chips: { start: number; end: number; node: TextViewInline }[] = [];
  const column = tableColumn ? { tableColumn } : {};
  if (skills.length > 0 && text.includes("$")) {
    for (const match of matchInlineSkills(text, skills)) chips.push({ start: match.start, end: match.end, node: custom<SkillChipData>("skill", match.raw, { skill: match.skill, raw: match.raw, ...column }) });
  }
  if (models) {
    for (const mention of collectComposerModelMentions(text)) {
      const presentation = models(mention.instanceId, mention.model);
      if (presentation) chips.push({ start: mention.start, end: mention.end, node: custom<ModelChipData>("model", mention.source, { presentation, source: mention.source, ...column }) });
    }
  }
  if (chips.length === 0) return null;
  const out: TextViewInline[] = [];
  let cursor = 0;
  for (const chip of chips.sort((left, right) => left.start - right.start)) {
    if (chip.start < cursor) continue;
    if (chip.start > cursor) out.push({ type: "text", text: text.slice(cursor, chip.start) });
    out.push(chip.node);
    cursor = chip.end;
  }
  if (cursor < text.length) out.push({ type: "text", text: text.slice(cursor) });
  return out;
}

// ---- web links ----

/** The host of an http(s) link (also a protocol-relative one), else null. */
export function externalWebLinkHost(href: string | null | undefined): string | null {
  if (!href) return null;
  try {
    const url = new URL(href.startsWith("//") ? `https:${href}` : href);
    return (url.protocol === "http:" || url.protocol === "https:") && url.hostname ? url.hostname : null;
  } catch {
    return null;
  }
}

// ---- the walk ----

interface Walk { context: InlineContext; files: MarkdownFileLinkMeta[] }

function tableLineWidthEm(line: string): number {
  let width = 0;
  for (const ch of line) {
    const code = ch.codePointAt(0) ?? 0;
    if (code === 0x20) width += 0.3;
    else if (
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe4f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x1f300 && code <= 0x1faff) ||
      (code >= 0x20000 && code <= 0x3fffd)
    ) width += 1.0;
    else width += 0.6;
  }
  return width;
}

export function tableColumnWidths(block: Extract<TextViewBlock, { type: "table" }>): TableColumnBounds[] {
  const rows = [block.head, ...(block.rows ?? [])];
  const cellSpan = (cell: { colspan?: number }) => Math.max(1, cell.colspan ?? 1);
  const contentWidths: number[] = [];
  for (const row of rows) {
    let col = 0;
    for (const cell of row) {
      const span = cellSpan(cell);
      while (contentWidths.length < col + span) contentWidths.push(0);
      if (span === 1) {
        let cellMax = contentWidths[col]!;
        for (const line of inlinePlainText(cell.content).split("\n")) cellMax = Math.max(cellMax, tableLineWidthEm(line));
        contentWidths[col] = cellMax;
      }
      col += span;
    }
  }
  const floors = contentWidths.map((content) => Math.min(content + 2, Math.max(10, Math.min(30, content / 2))) * 16);
  const totalMinPx = floors.reduce((sum, width) => sum + width, 0);
  return floors.map((minPx) => ({ minPx, totalMinPx }));
}

export function tableCellLabelMaxWidth(bounds: TableColumnBounds, availableBlockWidth: number): number {
  const colPx = bounds.totalMinPx >= availableBlockWidth || bounds.totalMinPx <= 0
    ? bounds.minPx
    : Math.max(bounds.minPx, (bounds.minPx / bounds.totalMinPx) * availableBlockWidth);
  return Math.max(64, Math.min(288, Math.floor(colPx) - 42));
}

function fileChipFor(href: string, label: string, walk: Walk, tableColumn?: TableColumnBounds): TextViewInline | null {
  const meta = resolveMarkdownFileLinkMeta(normalizeMarkdownLinkDestination(href), walk.context.cwd);
  if (!meta) return null;
  walk.files.push(meta);
  return custom<FileChipData>("filelink", label, {
    meta,
    href: normalizeMarkdownLinkDestination(href),
    label: "",
    copyMarkdown: "",
    inlineCode: false,
    ...(tableColumn ? { tableColumn } : {}),
  });
}

function transformLink(node: Extract<TextViewInline, { type: "link" }>, walk: Walk, tableColumn?: TableColumnBounds): TextViewInline[] {
  const url = node.url;
  const written = inlinePlainText(node.content);
  const column = tableColumn ? { tableColumn } : {};
  const citation = parseAssistantCitationHref(url);
  if (citation) return [custom<CitationChipData>("citation", written, { citation, ...column })];
  const thread = parseThreadHref(url);
  if (thread) {
    // An autolink's text is its own URL, which is no label.
    const label = written && parseThreadHref(written) === null ? written : null;
    return [custom<ThreadChipData>("threadlink", label ?? "", { threadId: thread.threadId, environmentId: thread.environmentId, label, ...column })];
  }
  if (url.startsWith("t3-context://")) return [node];
  if (walk.context.cwd) {
    const chip = fileChipFor(url, written, walk, tableColumn);
    if (chip) {
      const standalone = isMarkdownFileLinkLabel(written, url);
      const copyMarkdown = `[${(written || (chip as { data: FileChipData }).data.meta.basename).replace(/[\\[\]]/g, "\\$&")}](${normalizeMarkdownLinkDestination(url)})`;
      (chip as { data: FileChipData }).data.copyMarkdown = copyMarkdown;
      return standalone ? [chip] : [...node.content.map((child) => transformInline(child, walk, false, tableColumn)).flat(), { type: "text", text: " " }, chip];
    }
  }
  const host = externalWebLinkHost(url);
  if (walk.context.webLinkChips && host !== null && written.length > 0 && written.length <= WEB_CHIP_MAX_LABEL && node.content.every((child) => child.type === "text")) {
    return [custom<WebChipData>("weblink", written, { url, host, label: written, ...column })];
  }
  return [{ ...node, content: node.content.flatMap((child) => transformInline(child, walk, true, tableColumn)) }];
}

function transformInline(node: TextViewInline, walk: Walk, insideLink = false, tableColumn?: TableColumnBounds): TextViewInline[] {
  switch (node.type) {
    case "link":
      return insideLink ? [node] : transformLink(node, walk, tableColumn);
    case "code": {
      if (insideLink) return [node];
      if (walk.context.cwd) {
        const meta = resolveInlineCodeFileLinkMeta(node.code, walk.context.cwd);
        if (meta) {
          walk.files.push(meta);
          return [custom<FileChipData>("filelink", node.code, { meta, href: "", label: "", copyMarkdown: `\`${node.code}\``, inlineCode: true, ...(tableColumn ? { tableColumn } : {}) })];
        }
      }
      // TextView's native "code" node is a styled text run, so Tailwind padding/border/background
      // classes on it are silently dropped (it cannot box an inline run). Draw it as a real pill
      // View instead, as the reference's `<code>` does (padding ~0.1em 0.35em, rounded, bordered).
      return [custom<InlineCodeData>("inlinecode", node.code, { code: node.code })];
    }
    case "text":
      return (!insideLink && splitSkills(node.text, walk.context.skills, walk.context.models, tableColumn)) || [node];
    case "strong": case "emphasis": case "strikethrough": case "underline": case "superscript": case "subscript": case "small": case "highlight":
      return [{ ...node, content: node.content.flatMap((child) => transformInline(child, walk, insideLink, tableColumn)) } as TextViewInline];
    default:
      return [node];
  }
}

function transformTableRow<T extends { content: TextViewInline[]; colspan?: number }>(row: T[], columns: TableColumnBounds[], walk: Walk): T[] {
  let col = 0;
  return row.map((cell) => {
    const span = Math.max(1, cell.colspan ?? 1);
    const spanned = columns.slice(col, col + span);
    const bounds: TableColumnBounds | undefined = spanned.length > 0
      ? { minPx: spanned.reduce((sum, entry) => sum + entry.minPx, 0), totalMinPx: spanned[0]!.totalMinPx }
      : undefined;
    col += span;
    return { ...cell, content: cell.content.flatMap((node) => transformInline(node, walk, false, bounds)) };
  });
}

function transformBlock(block: TextViewBlock, walk: Walk): TextViewBlock {
  switch (block.type) {
    case "paragraph": case "heading":
      return { ...block, content: block.content.flatMap((node) => transformInline(node, walk)) };
    case "blockquote":
      return { ...block, children: block.children.map((child) => transformBlock(child, walk)) };
    case "list":
      return { ...block, items: block.items.map((item): TextViewListItem => ({ ...item, children: item.children.map((child) => transformBlock(child, walk)) })) };
    case "table": {
      const columns = tableColumnWidths(block);
      return {
        ...block,
        head: transformTableRow(block.head, columns, walk),
        rows: block.rows?.map((row) => transformTableRow(row, columns, walk)),
      };
    }
    case "details":
      return { ...block, summary: block.summary.flatMap((node) => transformInline(node, walk)), children: block.children.map((child) => transformBlock(child, walk)) };
    default:
      return block;
  }
}

/**
 * Swaps the chips in. File links share a label rule (`name · folder · L3`): files of one message that share a basename show
 * their parent folders, which needs every file of the message, so the labels are written after the walk.
 */
export function transformMarkdownBlocks(blocks: TextViewBlock[], context: InlineContext, files: MarkdownFileLinkMeta[] = []): TextViewBlock[] {
  const walk: Walk = { context, files };
  return blocks.map((block) => transformBlock(block, walk));
}

/** Writes each file chip's label once every file of the message is known. */
export function labelFileChips(blocks: TextViewBlock[], files: readonly MarkdownFileLinkMeta[]): void {
  const suffixes = buildFileLinkParentSuffixByPath(files.map((meta) => meta.filePath));
  const visitInlines = (content: readonly TextViewInline[]) => {
    for (const node of content) {
      if (node.type === "custom" && node.name === "filelink") {
        const data = node.data as FileChipData;
        data.label = fileLinkLabel({ path: data.meta.filePath, ...(data.meta.line !== undefined ? { line: data.meta.line } : {}), ...(data.meta.column !== undefined ? { column: data.meta.column } : {}) }, suffixes);
      } else if ("content" in node && Array.isArray(node.content)) visitInlines(node.content);
    }
  };
  const visit = (list: readonly TextViewBlock[]) => {
    for (const block of list) {
      if (block.type === "paragraph" || block.type === "heading") visitInlines(block.content);
      else if (block.type === "blockquote") visit(block.children);
      else if (block.type === "list") for (const item of block.items) visit(item.children);
      else if (block.type === "table") {
        for (const cell of block.head) visitInlines(cell.content);
        for (const row of block.rows ?? []) for (const cell of row) visitInlines(cell.content);
      } else if (block.type === "details") { visitInlines(block.summary); visit(block.children); }
    }
  };
  visit(blocks);
}

/** The transform on a whole document (blocks, then labels), for callers that hold a document. */
export function transformMarkdownDocument(document: TextViewDocument, context: InlineContext): TextViewDocument {
  const files: MarkdownFileLinkMeta[] = [];
  const blocks = transformMarkdownBlocks(document.blocks, context, files);
  labelFileChips(blocks, files);
  return { ...document, blocks };
}
