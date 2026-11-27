// The composer's prompt as a rich editor document, and back (composer-editor-mentions.ts,
// composerInlineTokens.ts, composer-rich-text-doc.ts's buildDocJson / serializeEditorDoc).
// The prompt text stays the single source of truth: `$council` and `@path` are prompt text, as the
// reference sends them; the document shows each one as an inline atom (`token`) with its label.
import { composerMathRanges, type MathRange } from "./composerMath";
import type { RichMarkJSON, RichNodeJSON } from "nsh/base";
import { resolveFileIcon } from "../../files/fileIcons";
import type { FileGlyph } from "../../files/fileIcons";
import { inlineMarkdownUnitMarks, isClosingFence, parseOpeningFence, RICH_TEXT_DELIMITERS } from "./richMarkdown";
import type { RichTextMark } from "./richMarkdown";
import { assistantCitationLabel, collectAssistantCitations } from "../../thread/markdown/assistantCitations";
import { formatBytes } from "../../thread/mediaLayout";

export type PromptTokenKind = "skill" | "file" | "folder" | "model" | "pull-request" | "thread" | "terminal" | "preview-annotation" | "context" | "citation";

export interface PromptToken { kind: PromptTokenKind; value: string; source: string; start: number; end: number }

export type PromptSegment = { type: "text"; text: string } | { type: "token"; token: PromptToken; label: string };

export interface PromptTokenContext {
  /** Display names of the skills the provider offers users, by name: only these chip (composerSkillMeta). */
  skills: ReadonlyMap<string, string>;
  /** Mentions picked as folders (`@path` tokens the `@` menu marked as directories). */
  folders?: ReadonlySet<string>;
  /** Model display names by `instance/model` (ModelMentionChip's label). */
  models?: ReadonlyMap<string, string>;
  /** Sizes of staged files, keyed by the context id in their inline reference. */
  fileAttachments?: ReadonlyMap<string, number>;
  /** composerRichTextEnabled: Markdown marks (bold, italic, strike, code) and fenced code blocks read as rich text. */
  richText?: boolean;
  /** Prompt offsets shown as Markdown source (the styled text the selection touches). */
  reveal?: { start: number; end: number } | null;
}

const SKILL_TOKEN = /(^|\s)\p{Sc}(?![0-9][0-9_]*(?:[kKmMbBtT]|[eE][0-9]+)?(?:\s|$))(?=[a-zA-Z0-9:_-]*[a-zA-Z])([a-zA-Z0-9][a-zA-Z0-9:_-]*)(?=\s)/gu;
const MENTION_TOKEN = /(^|\s)@(?:"((?:\\.|[^"\\])*)"|([^\s@"]+))(?=\s)/g;
const FILE_LINK_TOKEN = /(^|\s)\[((?:\\.|[^\]\\]){0,512})\]\(([^)\s]+)\)(?=\s)/g;
const URI_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const WINDOWS_DRIVE = /^[A-Za-z]:[\\/]/;
// formatComposerModelMention: `model:<instance>/<model>`; like a skill it waits for the whitespace after it.
const MODEL_TOKEN = /(^|[\s,(["'])model:([a-zA-Z][a-zA-Z0-9_-]*)\/([^\s,"']+)(?=\s)/g;
// formatComposerContextReference: `[label](t3-context://v1/<kind>/<id>)`, pull requests, threads, terminal output.
const CONTEXT_REFERENCE_TOKEN = /\[((?:\\.|[^\]\\]){0,200})\]\(t3-context:\/\/v1\/([a-z-]+)\/([A-Za-z0-9_-]{1,128})\)/g;
const SCOPED_PACKAGE = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*(?:\/[^\s@"]+)*$/;
const DECORATOR_CALL = /^[\p{ID_Start}_$][\p{ID_Continue}.$\u200c\u200d]*\(/u;

/** collectComposerInlineTokens for `@path` and `$skill`: a token waits for the whitespace after it, so typing never chips early. */
export function collectPromptTokens(text: string, context: PromptTokenContext): PromptToken[] {
  const math = mathRangesFor(text, context);
  return math.length === 0 ? collectRawPromptTokens(text, context) : collectRawPromptTokens(text, context).filter((token) => !math.some((formula) => token.start < formula.end && token.end > formula.start));
}

/** The formulas of `text`; confirmed link mentions are masked first, as the reference does. */
function mathRangesFor(text: string, context: PromptTokenContext): MathRange[] {
  if (!text.includes("$") && !text.includes("\\(")) return [];
  return composerMathRanges(text, collectRawPromptTokens(text, context).filter((token) => token.source.startsWith("[")));
}

function collectRawPromptTokens(text: string, context: PromptTokenContext): PromptToken[] {
  const found: PromptToken[] = [];
  // composer-editor-mentions assistant citations: `[Assistant quote](t3-citation://v1/...)` (formatAssistantCitationForComposer).
  for (const match of collectAssistantCitations(text)) {
    found.push({ kind: "citation", value: assistantCitationLabel(match.citation), source: match.source, start: match.start, end: match.end });
  }
  // `[name](path)`, what a pick from the `@` menu inserts (serializeComposerFileLink).
  for (const match of text.matchAll(FILE_LINK_TOKEN)) {
    const prefix = match[1] ?? "";
    const label = (match[2] ?? "").replace(/\\(.)/g, "$1");
    let path = match[3] ?? "";
    try { path = decodeURIComponent(path); } catch { /* kept encoded */ }
    if (!path || (URI_SCHEME.test(path) && !WINDOWS_DRIVE.test(path)) || label !== basenameOfPath(path)) continue;
    const start = (match.index ?? 0) + prefix.length;
    const end = start + match[0].length - prefix.length;
    const source = text.slice(start, end);
    found.push({ kind: context.folders?.has(source) ? "folder" : "file", value: path, source, start, end });
  }
  for (const match of text.matchAll(MENTION_TOKEN)) {
    const prefix = match[1] ?? "";
    const quoted = match[2];
    const path = quoted !== undefined ? quoted.replace(/\\(.)/g, "$1") : (match[3] ?? "");
    if (!path || (quoted === undefined && (SCOPED_PACKAGE.test(path) || DECORATOR_CALL.test(path)))) continue;
    const start = (match.index ?? 0) + prefix.length;
    const end = start + match[0].length - prefix.length;
    const source = text.slice(start, end);
    found.push({ kind: context.folders?.has(source) ? "folder" : "file", value: path, source, start, end });
  }
  for (const match of text.matchAll(SKILL_TOKEN)) {
    const prefix = match[1] ?? "";
    const value = match[2] ?? "";
    if (!value || !context.skills.has(value)) continue;
    const start = (match.index ?? 0) + prefix.length;
    found.push({ kind: "skill", value, source: text.slice(start, start + match[0].length - prefix.length), start, end: start + match[0].length - prefix.length });
  }
  // collectModelTokens: a model chips only when the server offers it (an unknown or vanished model stays editable text), and
  // never inside a formula.
  const math = text.includes("model:") ? composerMathRanges(text) : [];
  for (const match of text.matchAll(MODEL_TOKEN)) {
    const prefix = match[1] ?? "";
    const slug = (match[3] ?? "").replace(/[.;:!?]+$/, "");
    const start = (match.index ?? 0) + prefix.length;
    const source = `model:${match[2]}/${slug}`;
    if (!slug || text.slice(start + source.length).match(/^\S/)) continue;
    if (!context.models?.has(`${match[2]}/${slug}`)) continue;
    if (math.some((range) => start < range.end && start + source.length > range.start)) continue;
    found.push({ kind: "model", value: `${match[2]}/${slug}`, source, start, end: start + source.length });
  }
  for (const match of text.matchAll(CONTEXT_REFERENCE_TOKEN)) {
    const kind = match[2] ?? "";
    const start = match.index ?? 0;
    const label = (match[1] ?? "").replace(/\\(.)/g, "$1");
    found.push({
      kind: kind === "file" ? "file" : kind === "review-comment" && label.startsWith("#") ? "pull-request" : kind === "thread" ? "thread" : kind === "terminal" ? "terminal" : kind === "preview-annotation" ? "preview-annotation" : "context",
      value: label, source: match[0], start, end: start + match[0].length,
    });
  }
  found.sort((left, right) => left.start - right.start);
  const kept: PromptToken[] = [];
  for (const token of found) if (!kept.length || token.start >= kept[kept.length - 1]!.end) kept.push(token);
  return kept;
}

/** serializeComposerFileLink: a picked path as the prompt carries it, `[basename](encoded path)`. */
export function serializeComposerFileLink(path: string): string {
  const separator = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const label = (separator >= 0 ? path.slice(separator + 1) : path).replaceAll("\\", "\\\\").replaceAll("[", "\\[").replaceAll("]", "\\]");
  const destination = encodeURI(path).replaceAll("(", "%28").replaceAll(")", "%29").replaceAll("#", "%23").replaceAll("?", "%3F").replaceAll("\\", "%5C");
  return `[${label}](${destination})`;
}

export const basenameOfPath = (path: string) => { const trimmed = path.replace(/[\\/]+$/, ""); const slash = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\")); return slash >= 0 ? trimmed.slice(slash + 1) : trimmed; };

/** What a token shows: a skill's display name, a file's or folder's basename (FileTagChip). */
export function tokenLabel(token: PromptToken, context: PromptTokenContext): string {
  if (token.kind === "skill") return context.skills.get(token.value) || token.value;
  if (token.kind === "model") return context.models?.get(token.value) || token.value.slice(token.value.indexOf("/") + 1);
  if (token.kind === "file" || token.kind === "folder") {
    const label = basenameOfPath(token.value) || token.value;
    const id = token.source.match(/^\[[\s\S]*\]\(t3-context:\/\/v1\/file\/([A-Za-z0-9_-]+)\)$/)?.[1];
    const size = id ? context.fileAttachments?.get(id) : undefined;
    return size === undefined ? label : `${label} ${formatBytes(size)}`;
  }
  return token.value;
}

export function splitPrompt(text: string, context: PromptTokenContext): PromptSegment[] {
  const segments: PromptSegment[] = [];
  let cursor = 0;
  for (const token of collectPromptTokens(text, context)) {
    if (token.start > cursor) segments.push({ type: "text", text: text.slice(cursor, token.start) });
    segments.push({ type: "token", token, label: tokenLabel(token, context) });
    cursor = token.end;
  }
  if (cursor < text.length) segments.push({ type: "text", text: text.slice(cursor) });
  return segments;
}

export const TOKEN_NODE = "token";

/** Each kind's icon, a character of the ComposerTokenIcons font (tools/gen_composer_icon_font.py) the token's text starts with. */
export const TOKEN_GLYPHS: Record<PromptTokenKind, string> = {
  skill: "\u{FF000}", file: "\u{FF001}", folder: "\u{FF002}", model: "\u{FF003}", "pull-request": "\u{FF004}", thread: "\u{FF005}", terminal: "\u{FF006}", "preview-annotation": "\u{FF007}", context: "\u{FF001}", citation: "\u{FF008}",
};

/** The file-type marks of the icon font (fileIcons.ts FileGlyph); keep in step with tools/gen_composer_icon_font.py. */
export const FILE_TYPE_GLYPHS: Record<Exclude<FileGlyph, "file">, string> = {
  image: "\u{FF010}", "file-code": "\u{FF011}", "file-text": "\u{FF012}", "file-terminal": "\u{FF013}", "file-spreadsheet": "\u{FF014}",
  "file-cog": "\u{FF015}", "file-archive": "\u{FF016}", film: "\u{FF017}", database: "\u{FF018}",
};

/** A token's icon character: files draw their type's mark (PierreEntryIcon), everything else its kind's. */
export function tokenGlyph(kind: PromptTokenKind, value: string): string {
  if (kind !== "file") return TOKEN_GLYPHS[kind];
  const glyph = resolveFileIcon(value).glyph;
  return glyph === "file" ? TOKEN_GLYPHS.file : FILE_TYPE_GLYPHS[glyph];
}

const tokenNode = (token: PromptToken, label: string): RichNodeJSON => ({
  type: TOKEN_NODE, attrs: { kind: token.kind, value: token.value, source: token.source, label, glyph: tokenGlyph(token.kind, token.value) },
});

/** The rich composer's code block node (ComposerCodeBlockExtension): `language` the info string, `fence` its opening
 * run, `close` the closing line as written (empty while unclosed). */
export const CODE_BLOCK_NODE = "codeBlock";
const RICH_MARKS: readonly RichTextMark[] = ["bold", "italic", "strike", "code"];
/** MARK_NESTING_ORDER: the outermost delimiter first. */
const MARK_NESTING_ORDER: RichTextMark[] = ["strike", "bold", "italic", "code"];
// Stands in for a token while a line's Markdown is parsed, so emphasis can wrap a chip.
const TOKEN_PLACEHOLDER = "\uFFFC";

const isRichMark = (name: unknown): name is RichTextMark => RICH_MARKS.includes(name as RichTextMark);
const nodeMarks = (node: RichNodeJSON): RichTextMark[] => ((node.marks ?? []).some((mark) => mark.type === SOURCE_MARK) ? [] : (node.marks ?? []).map((mark) => mark.type).filter(isRichMark));
const withMarks = (node: RichNodeJSON, marks: readonly RichTextMark[]): RichNodeJSON => {
  const { marks: _old, ...rest } = node;
  return marks.length ? { ...rest, marks: marks.map((type) => ({ type })) } : rest;
};

/** One line's inline content: text and tokens, with the line's Markdown marks when rich text is on. */
/** The mark on Markdown shown as source while the selection touches it (MARKDOWN_SOURCE_MARK); `delimiter` on its
 * `**`, `*`, `~~` and backticks. Text under it writes back as it reads, its other marks only preview the styling. */
export const SOURCE_MARK = "markdownSource";

/** One line's inline content: text and tokens, with the line's Markdown marks when rich text is on. `literal` (offsets in
 * `line`) is shown as Markdown source: its delimiters stay as text (composer-markdown-source.ts revealStyledText). */
function splitAroundMath(line: string, math: readonly MathRange[], context: PromptTokenContext): PromptSegment[] {
  const out: PromptSegment[] = [];
  let at = 0;
  for (const range of math) {
    if (range.start > at) out.push(...splitPrompt(line.slice(at, range.start), context));
    out.push({ type: "text", text: range.source });
    at = range.end;
  }
  if (at < line.length) out.push(...splitPrompt(line.slice(at), context));
  return out;
}

function lineContent(line: string, context: PromptTokenContext, literal: { start: number; end: number } | null = null): RichNodeJSON[] {
  // Formulas stay editable source: no chips inside them and no styling over them (composerMathRanges).
  const math = mathRangesFor(line, context);
  const segments = math.length === 0 ? splitPrompt(line, context) : splitAroundMath(line, math, context);
  if (!context.richText) {
    return segments.map((segment): RichNodeJSON => segment.type === "text" ? { type: "text", text: segment.text } : tokenNode(segment.token, segment.label));
  }
  let flat = "";
  let source = 0;
  let literalStart = -1;
  let literalEnd = -1;
  const tokenAt = new Map<number, RichNodeJSON>();
  const note = (from: number, length: number, flatFrom: number, flatLength: number) => {
    if (!literal) return;
    if (literalStart < 0 && literal.start < from + length) literalStart = flatFrom + Math.min(flatLength, Math.max(0, literal.start - from));
    if (literalEnd < 0 && literal.end <= from + length) literalEnd = flatFrom + Math.min(flatLength, Math.max(0, literal.end - from));
  };
  for (const segment of segments) {
    if (segment.type === "text") { note(source, segment.text.length, flat.length, segment.text.length); source += segment.text.length; flat += segment.text; }
    else { note(source, segment.token.source.length, flat.length, 1); source += segment.token.source.length; tokenAt.set(flat.length, tokenNode(segment.token, segment.label)); flat += TOKEN_PLACEHOLDER; }
  }
  if (literal && literalStart < 0) literalStart = flat.length;
  if (literal && literalEnd < 0) literalEnd = flat.length;
  let styled = flat;
  const shielded = new Set<number>();
  if (math.length > 0) {
    // The sentinel replaces a formula's characters while the marks are read, so its source styles nothing.
    let at = 0;
    for (const segment of segments) {
      if (segment.type === "text") {
        for (const range of math) if (range.source === segment.text) for (let offset = 0; offset < segment.text.length; offset += 1) shielded.add(at + offset);
        at += segment.text.length;
      } else at += 1;
    }
    styled = [...flat].map((char, index) => shielded.has(index) ? TOKEN_PLACEHOLDER : char).join("");
  }
  const units = inlineMarkdownUnitMarks(styled);
  const nodes: RichNodeJSON[] = [];
  for (let index = 0; index < flat.length; index += 1) {
    const unit = shielded.has(index) ? [] : (units[index] ?? null);
    const shown = literal !== null && index >= literalStart && index < literalEnd;
    if (unit === null && !shown) continue;
    const style = unit === null ? [] : MARK_NESTING_ORDER.filter((mark) => unit.includes(mark));
    const marks: RichMarkJSON[] = [...style.map((type) => ({ type })), ...(shown ? [{ type: SOURCE_MARK, attrs: { delimiter: unit === null } }] : [])];
    const token = tokenAt.get(index);
    const node: RichNodeJSON = token ? { ...token } : { type: "text", text: flat[index]! };
    nodes.push(marks.length ? { ...node, marks } : node);
  }
  const merged: RichNodeJSON[] = [];
  for (const node of nodes) {
    const last = merged[merged.length - 1];
    if (last && last.type === "text" && node.type === "text" && JSON.stringify(last.marks ?? []) === JSON.stringify(node.marks ?? [])) last.text = (last.text ?? "") + (node.text ?? "");
    else merged.push(node);
  }
  return merged;
}

const codeBlockNode = (content: string, attrs: { language: string; fence: string; close: string }): RichNodeJSON =>
  ({ type: CODE_BLOCK_NODE, attrs, ...(content ? { content: [{ type: "text", text: content }] } : {}) });

/**
 * The document for a prompt (buildTiptapContent): one paragraph per line, each token an inline atom; with rich text,
 * Markdown emphasis as marks and a fenced block (to its closing fence, or to the end while unclosed) as a code block.
 */
export function promptToDoc(text: string, context: PromptTokenContext): RichNodeJSON {
  const lines = text.split("\n");
  if (!context.richText) {
    return { type: "doc", content: lines.map((line): RichNodeJSON => { const content = lineContent(line, context); return content.length ? { type: "paragraph", content } : { type: "paragraph" }; }) };
  }
  type Entry = { code: RichNodeJSON } | { rule: string } | { heading: { level: number; space: string; inline: RichNodeJSON[] } } | { quote: { prefix: string; inline: RichNodeJSON[] } } | { line: { list: ListLinePrefix | null; inline: RichNodeJSON[] } };
  const entries: Entry[] = [];
  const lineStarts: number[] = [];
  for (let at = 0, index = 0; index < lines.length; index += 1) { lineStarts.push(at); at += lines[index]!.length + 1; }
  // The reveal inside a line's content that starts at prompt offset `from`, in the content's own offsets.
  const literalIn = (from: number, length: number) => {
    const reveal = context.reveal;
    if (!reveal || reveal.end <= from || reveal.start >= from + length) return null;
    return { start: Math.max(0, reveal.start - from), end: Math.min(length, reveal.end - from) };
  };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const lineStart = lineStarts[index]!;
    const opening = parseOpeningFence(line);
    if (opening) {
      let end = index + 1;
      while (end < lines.length && !isClosingFence(lines[end]!, opening.fence)) end += 1;
      const closed = end < lines.length;
      entries.push({ code: codeBlockNode(lines.slice(index + 1, end).join("\n"), { language: opening.language, fence: opening.fence, close: closed ? `\n${lines[end]}` : "" }) });
      index = closed ? end : lines.length;
      continue;
    }
    if (/^([-*_])(?:[ \t]*\1){2,}[ \t]*\r?$/.test(line)) { entries.push({ rule: line }); continue; }
    const heading = /^(#{1,6})([ \t]+)([^\n]*)$/.exec(line);
    if (heading) { const from = lineStart + heading[1]!.length + heading[2]!.length; entries.push({ heading: { level: heading[1]!.length, space: heading[2]!, inline: lineContent(heading[3]!, context, literalIn(from, heading[3]!.length)) } }); continue; }
    const quote = /^(>[ \t]*)([^\n]*)$/.exec(line);
    if (quote) { entries.push({ quote: { prefix: quote[1]!, inline: lineContent(quote[2]!, context, literalIn(lineStart + quote[1]!.length, quote[2]!.length)) } }); continue; }
    const parsed = parseListPrefix(line);
    const contentFrom = parsed ? parsed.markerLength : 0;
    entries.push({ line: { list: parsed?.prefix ?? null, inline: lineContent(line.slice(contentFrom), context, literalIn(lineStart + contentFrom, line.length - contentFrom)) } });
  }
  // buildTiptapContent: consecutive list lines nest by indent, consecutive quote lines with one prefix join one quote.
  const blocks: RichNodeJSON[] = [];
  let rootLists: PendingList[] = [];
  let stack: { indent: string; list: PendingList; container: PendingList[] }[] = [];
  const flushLists = () => { for (const list of rootLists) blocks.push(listJson(list)); rootLists = []; stack = []; };
  const openList = (container: PendingList[], key: string): PendingList => { const list: PendingList = { key, items: [] }; container.push(list); return list; };
  let openQuote: { prefix: string; content: RichNodeJSON[][] } | null = null;
  const flushQuote = () => {
    if (!openQuote) return;
    blocks.push({ type: "blockquote", attrs: { prefix: openQuote.prefix }, content: openQuote.content.map((inline) => paragraphOf(inline)) });
    openQuote = null;
  };
  const proseLine = (entry: Entry | undefined, empty: boolean): boolean =>
    entry !== undefined && "line" in entry && !entry.line.list && (entry.line.inline.length === 0) === empty;
  for (const [index, entry] of entries.entries()) {
    if ("quote" in entry) {
      flushLists();
      if (openQuote && openQuote.prefix !== entry.quote.prefix) flushQuote();
      openQuote ??= { prefix: entry.quote.prefix, content: [] };
      openQuote.content.push(entry.quote.inline);
      continue;
    }
    flushQuote();
    if ("code" in entry) { flushLists(); blocks.push(entry.code); continue; }
    if ("rule" in entry) { flushLists(); blocks.push({ type: "horizontalRule", attrs: { source: entry.rule } }); continue; }
    if ("heading" in entry) {
      flushLists();
      blocks.push({ type: "heading", attrs: { level: entry.heading.level, space: entry.heading.space }, ...(entry.heading.inline.length ? { content: entry.heading.inline } : {}) });
      continue;
    }
    const line = entry.line;
    if (rootLists.length && proseLine(entry, true)) {
      let next = index + 1;
      while (proseLine(entries[next], true)) next += 1;
      if (proseLine(entries[next], false)) {
        flushLists();
        continue;
      }
    }
    if (!line.list) { flushLists(); blocks.push(paragraphOf(line.inline)); continue; }
    const item: PendingItem = { prefix: line.list, content: line.inline, children: [] };
    const key = listKey(line.list);
    const indent = line.list.indent;
    for (;;) {
      const top = stack[stack.length - 1];
      if (!top) { stack.push({ indent, list: openList(rootLists, key), container: rootLists }); continue; }
      if (top.indent === indent) {
        if (top.list.key !== key) top.list = openList(top.container, key);
        top.list.items.push(item);
        break;
      }
      if (top.indent !== "" && !indent.startsWith(top.indent)) {
        if (stack.length > 1) { stack.pop(); continue; }
        top.indent = indent;
        if (top.list.key !== key) top.list = openList(top.container, key);
        top.list.items.push(item);
        break;
      }
      const parent = top.list.items[top.list.items.length - 1];
      if (!parent) { top.list.items.push(item); break; }
      const list = openList(parent.children, key);
      stack.push({ indent, list, container: parent.children });
      list.items.push(item);
      break;
    }
  }
  flushQuote();
  flushLists();
  // buildDocJson: a rule at the end gets a line after it to type in.
  if (blocks[blocks.length - 1]?.type === "horizontalRule") blocks.push({ type: "paragraph" });
  return { type: "doc", content: blocks };
}

const paragraphOf = (inline: RichNodeJSON[]): RichNodeJSON => (inline.length ? { type: "paragraph", content: inline } : { type: "paragraph" });

interface TaskLinePrefix { indent: string; checked: boolean; markerSpace: string; contentSpace: string }
type ListLinePrefix = ({ kind: "task" } & TaskLinePrefix) | { kind: "bullet" | "ordered"; indent: string; marker: string; space: string };
interface PendingItem { prefix: ListLinePrefix; content: RichNodeJSON[]; children: PendingList[] }
interface PendingList { key: string; items: PendingItem[] }

function parseTaskPrefix(head: string): { prefix: TaskLinePrefix; markerLength: number } | null {
  const match = head.match(/^([ \t]*)-([ \t]+)\[([ xX])\]([ \t]*)/);
  if (!match) return null;
  const after = head.slice(match[0].length);
  if (after.length > 0 && !match[4]) return null;
  return { prefix: { indent: match[1] ?? "", checked: (match[3] ?? " ").toLowerCase() === "x", markerSpace: match[2]!, contentSpace: match[4]! }, markerLength: match[0].length };
}

/** parseListPrefix (composer-rich-text-doc.ts). */
function parseListPrefix(line: string): { prefix: ListLinePrefix; markerLength: number } | null {
  const task = parseTaskPrefix(line);
  if (task) return { prefix: { kind: "task", ...task.prefix }, markerLength: task.markerLength };
  const ordered = /^([ \t]*)(\d+[.)])((?:[ \t]+)|$)/.exec(line);
  if (ordered) return { prefix: { kind: "ordered", indent: ordered[1]!, marker: ordered[2]!, space: ordered[3]! }, markerLength: ordered[0].length };
  const bullet = /^([ \t]*)([-*+])((?:[ \t]+)|$)/.exec(line);
  if (bullet) return { prefix: { kind: "bullet", indent: bullet[1]!, marker: bullet[2]!, space: bullet[3]! }, markerLength: bullet[0].length };
  return null;
}

const listKey = (prefix: ListLinePrefix) => (prefix.kind === "task" ? "task" : prefix.kind === "ordered" ? `ordered:${prefix.marker.slice(-1)}` : `bullet:${prefix.marker}`);

function listJson(list: PendingList): RichNodeJSON {
  const first = list.items[0]!.prefix;
  const items = list.items.map((item): RichNodeJSON => {
    const content = [paragraphOf(item.content), ...item.children.map(listJson)];
    if (item.prefix.kind === "task") return { type: "taskItem", attrs: { checked: item.prefix.checked, indent: item.prefix.indent, markerSpace: item.prefix.markerSpace, contentSpace: item.prefix.contentSpace }, content };
    return { type: "listItem", attrs: { indent: item.prefix.indent, marker: item.prefix.marker, space: item.prefix.space }, content };
  });
  if (first.kind === "task") return { type: "taskList", content: items };
  if (first.kind === "ordered") {
    const start = Number.parseInt(first.marker, 10);
    return { type: "orderedList", attrs: { start: Number.isFinite(start) ? start : 1 }, content: items };
  }
  return { type: "bulletList", content: items };
}

const tokenSource = (node: RichNodeJSON): string => String(node.attrs?.source ?? "");
const LEAF_BLOCKS = new Set(["horizontalRule"]);
const LIST_NODES = new Set(["bulletList", "orderedList", "taskList"]);
/** A node's size in document positions (ProseMirror's nodeSize). */
export const nodeSize = (node: RichNodeJSON): number => node.type === "text" ? (node.text ?? "").length
  : node.type === TOKEN_NODE || LEAF_BLOCKS.has(node.type) ? 1
  : 2 + (node.content ?? []).reduce((sum, child) => sum + nodeSize(child), 0);

/** codeBlockSource: the fence lines around the code, a longer fence when the code holds a closing one, and a close
 * before a following block so reading the prompt back does not take that block in as code. */
export function codeBlockSource(node: RichNodeJSON, followed: boolean): { open: string; content: string; close: string } {
  const attrs = node.attrs ?? {};
  let fence = typeof attrs.fence === "string" && attrs.fence ? attrs.fence : "```";
  const language = typeof attrs.language === "string" ? attrs.language : "";
  let close = typeof attrs.close === "string" ? attrs.close : "";
  const content = (node.content ?? []).map((child) => child.text ?? "").join("");
  const longest = Math.max(0, ...content.split("\n").filter((line) => isClosingFence(line, fence)).map((line) => /^[`~]+/.exec(line)![0].length));
  if (longest > 0) {
    fence = fence[0]!.repeat(longest + 1);
    if (close) close = `\n${fence}`;
  }
  if (!close && followed) close = `\n${fence}`;
  return { open: `${fence}${language}${content ? "\n" : ""}`, content, close };
}

/** The prompt text of a document and how its positions and the text's offsets map onto each other. */
interface PromptLayout { text: string; posOffset: number[]; offsetPos: number[]; end: number }

/** The inline children with their delimiters (appendInlineRuns): emphasis never opens or closes on whitespace, and the
 * marks of neighbouring children nest so a shared mark is written once. */
function inlineRuns(children: readonly RichNodeJSON[]): { node: RichNodeJSON; open: string; close: string }[] {
  const parts: RichNodeJSON[] = [];
  for (const child of children) {
    const marks = nodeMarks(child);
    if (child.type !== "text" || marks.includes("code")) { parts.push(child); continue; }
    const text = child.text ?? "";
    const start = text.length - text.trimStart().length;
    const end = Math.max(start, text.trimEnd().length);
    let offset = 0;
    for (const boundary of [start, end, text.length]) {
      if (boundary > offset) parts.push({ ...child, text: text.slice(offset, boundary) });
      offset = boundary;
    }
  }
  for (const mark of MARK_NESTING_ORDER) {
    if (mark === "code") continue;
    for (const direction of [1, -1]) {
      let hasContent = false;
      for (let index = direction === 1 ? 0 : parts.length - 1; index >= 0 && index < parts.length; index += direction) {
        const part = parts[index]!;
        const marks = nodeMarks(part);
        if (!marks.includes(mark)) hasContent = false;
        else if (part.type === "text" && !marks.includes("code") && /^\s+$/.test(part.text ?? "")) {
          if (!hasContent) parts[index] = withMarks(part, marks.filter((item) => item !== mark));
        } else hasContent = true;
      }
    }
  }
  const markEnds = new Map<RichTextMark, number>();
  const ordered: RichTextMark[][] = [];
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const marks = nodeMarks(parts[index]!);
    for (const mark of MARK_NESTING_ORDER) {
      if (!marks.includes(mark)) markEnds.delete(mark);
      else if (!markEnds.has(mark)) markEnds.set(mark, index);
    }
    ordered[index] = marks.sort((a, b) => markEnds.get(b)! - markEnds.get(a)! || MARK_NESTING_ORDER.indexOf(a) - MARK_NESTING_ORDER.indexOf(b));
  }
  for (let index = 1; index < ordered.length; index += 1) {
    const marks = ordered[index]!;
    const retained: RichTextMark[] = [];
    for (const mark of ordered[index - 1]!) { if (!marks.includes(mark)) break; retained.push(mark); }
    ordered[index] = [...retained, ...marks.filter((mark) => !retained.includes(mark))];
  }
  const common = (left: RichTextMark[], right: RichTextMark[]) => { let index = 0; while (index < left.length && left[index] === right[index]) index += 1; return index; };
  return parts.map((node, index) => {
    const marks = ordered[index]!;
    return {
      node,
      open: marks.slice(common(marks, ordered[index - 1] ?? [])).map((mark) => RICH_TEXT_DELIMITERS[mark]).join(""),
      close: marks.slice(common(marks, ordered[index + 1] ?? [])).reverse().map((mark) => RICH_TEXT_DELIMITERS[mark]).join(""),
    };
  });
}

const layouts = new WeakMap<RichNodeJSON, PromptLayout>();
/** serializeEditorDoc: the prompt text a document sends (tokens as their source, marks as their delimiters, code blocks
 * fenced), with each position's offset and each offset's position. */
export function promptLayout(doc: RichNodeJSON): PromptLayout {
  const cached = layouts.get(doc);
  if (cached) return cached;
  let text = "";
  const posOffset: number[] = [];
  const offsetPos: number[] = [];
  const emit = (value: string, pos: number) => { for (let index = 0; index < value.length; index += 1) { offsetPos[text.length] = pos; text += value[index]; } };
  // The end of the last textblock written: where the prompt's end maps to.
  let lastTextEnd = 1;
  // The inline content of a textblock whose content starts at `start`; returns the position after it.
  const inline = (block: RichNodeJSON, start: number): number => {
    let at = start;
    for (const { node, open, close } of inlineRuns(block.content ?? [])) {
      emit(open, at);
      if (node.type === "text") {
        const value = node.text ?? "";
        for (let k = 0; k < value.length; k += 1) { posOffset[at + k] = text.length; emit(value[k]!, at + k); }
      } else {
        const source = node.type === TOKEN_NODE ? tokenSource(node) : "";
        posOffset[at] = text.length;
        // An offset inside a token's source lands after it.
        for (let k = 0; k < source.length; k += 1) { offsetPos[text.length] = k === 0 ? at : at + 1; text += source[k]; }
      }
      at += nodeSize(node);
      emit(close, at);
    }
    posOffset[at] = text.length;
    lastTextEnd = at;
    return at;
  };
  const itemPrefix = (item: RichNodeJSON, empty: boolean, ordered: boolean, orderedNumber: number, delimiter: string): string => {
    const attrs = item.attrs ?? {};
    const indent = typeof attrs.indent === "string" ? attrs.indent : "";
    if (item.type === "taskItem") {
      const markerSpace = typeof attrs.markerSpace === "string" ? attrs.markerSpace : " ";
      const contentSpace = typeof attrs.contentSpace === "string" ? attrs.contentSpace || (empty ? "" : " ") : empty ? "" : " ";
      return `${indent}-${markerSpace}[${attrs.checked === true ? "x" : " "}]${contentSpace}`;
    }
    const rawMarker = typeof attrs.marker === "string" ? attrs.marker : "";
    const marker = ordered
      ? (/^\d+[.)]$/.test(rawMarker) ? rawMarker : `${orderedNumber}${delimiter}`)
      : (/^[-*+]$/.test(rawMarker) ? rawMarker : "-");
    const space = typeof attrs.space === "string" ? attrs.space || (empty ? "" : " ") : empty ? "" : " ";
    return `${indent}${marker}${space}`;
  };
  const walkList = (list: RichNodeJSON, listPos: number) => {
    let itemPos = listPos + 1;
    const ordered = list.type === "orderedList";
    const listStart = ordered && typeof list.attrs?.start === "number" && Number.isFinite(list.attrs.start) ? list.attrs.start : 1;
    const delimiter = ordered
      ? ((list.content ?? []).map((entry) => entry.attrs?.marker).find((m): m is string => typeof m === "string" && /^\d+[.)]$/.test(m))?.slice(-1) ?? ".")
      : "-";
    (list.content ?? []).forEach((item, itemIndex) => {
      if (itemIndex > 0) emit("\n", itemPos);
      let childPos = itemPos + 1;
      const first = item.content?.[0];
      const empty = first?.type === "paragraph" && (first.content ?? []).length === 0;
      emit(itemPrefix(item, empty, ordered, listStart + itemIndex, delimiter), childPos + 1);
      (item.content ?? []).forEach((child, childIndex) => {
        if (childIndex > 0) emit("\n", childPos);
        if (LIST_NODES.has(child.type)) walkList(child, childPos);
        else if (child.type === "paragraph") inline(child, childPos + 1);
        childPos += nodeSize(child);
      });
      itemPos += nodeSize(item);
    });
  };
  const blocks = doc.content ?? [];
  let pos = 0;
  blocks.forEach((block, index) => {
    const previous = blocks[index - 1];
    // isTrailingLineAfterRule: the empty line kept after a closing rule writes nothing.
    const trailingAfterRule = index === blocks.length - 1 && index > 0 && block.type === "paragraph" && (block.content ?? []).length === 0 && previous?.type === "horizontalRule";
    if (index > 0 && !trailingAfterRule) emit("\n", previous?.type === "horizontalRule" ? pos - 1 : lastTextEnd);
    // needsBlankLineAfterQuote: prose after a quote is set apart, or Markdown folds it into the quote.
    if (previous?.type === "blockquote" && block.type === "paragraph" && (block.content ?? []).length > 0) emit("\n", pos + 1);
    if (previous && LIST_NODES.has(previous.type)) {
      let next = index;
      while (blocks[next]?.type === "paragraph" && !blocks[next]?.content?.length) next += 1;
      if (blocks[next]?.type === "paragraph") emit("\n", pos + 1);
    }
    const start = pos + 1;
    if (block.type === CODE_BLOCK_NODE) {
      const { open, content, close } = codeBlockSource(block, index < blocks.length - 1);
      emit(open, start);
      for (let at = 0; at < content.length; at += 1) { posOffset[start + at] = text.length; emit(content[at]!, start + at); }
      posOffset[start + content.length] = text.length;
      lastTextEnd = start + content.length;
      emit(close, start + content.length);
    } else if (LIST_NODES.has(block.type)) {
      walkList(block, pos);
    } else if (block.type === "blockquote") {
      const prefix = typeof block.attrs?.prefix === "string" ? block.attrs.prefix : "> ";
      let childPos = start;
      (block.content ?? []).forEach((child, childIndex) => {
        if (childIndex > 0) emit("\n", childPos);
        emit(prefix, childPos + 1);
        if (child.type === "paragraph") inline(child, childPos + 1);
        childPos += nodeSize(child);
      });
    } else if (block.type === "heading") {
      const level = typeof block.attrs?.level === "number" ? block.attrs.level : 1;
      const space = typeof block.attrs?.space === "string" ? block.attrs.space : " ";
      emit(`${"#".repeat(level)}${space}`, start);
      inline(block, start);
    } else if (block.type === "horizontalRule") {
      const source = typeof block.attrs?.source === "string" && block.attrs.source ? block.attrs.source : "---";
      emit(source, pos + 1);
    } else {
      inline(block, start);
    }
    pos += nodeSize(block);
  });
  const end = lastTextEnd;
  offsetPos[text.length] = end;
  const layout = { text, posOffset, offsetPos, end };
  layouts.set(doc, layout);
  return layout;
}

/** The prompt text a document sends (serializeEditorDoc): text as typed, each token its prompt source. */
export function docToPrompt(doc: RichNodeJSON): string {
  return promptLayout(doc).text;
}

/** A prompt text offset for a document position (the caret), a token counting as its source's length. */
export function posToOffset(doc: RichNodeJSON, pos: number): number {
  const { posOffset, text } = promptLayout(doc);
  for (let at = Math.floor(pos); at >= 0; at -= 1) if (posOffset[at] !== undefined) return posOffset[at]!;
  return text.length > 0 ? 0 : 0;
}

/** The document position for a prompt offset; an offset inside a token's source lands after it. */
export function offsetToPos(doc: RichNodeJSON, target: number): number {
  const { offsetPos, text, end } = promptLayout(doc);
  const at = Math.max(0, Math.min(text.length, Math.floor(target)));
  return offsetPos[at] ?? end;
}

/** Whether two documents show the same thing (the prompt's tokens chip the same way). */
export const sameDoc = (left: RichNodeJSON, right: RichNodeJSON) => JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));

function normalize(node: RichNodeJSON): unknown {
  const content = (node.content ?? []).map(normalize);
  const marks = nodeMarks(node).sort();
  if (node.type === "text") return marks.length ? { x: node.text, m: marks } : node.text;
  return { t: node.type, a: node.type !== "doc" && node.type !== "paragraph" && node.attrs ? Object.entries(node.attrs ?? {}).sort(([x], [y]) => x.localeCompare(y)) : undefined, m: marks.length ? marks : undefined, c: content };
}

/** The document with the tokens its typed text now completes chipped, its existing tokens kept (collectComposerInlineTokens' preserveTrailingFrom: deleting the space after a token does not undo it). */
/** A skill or model chip the context no longer knows. */
function isStaleChip(node: RichNodeJSON, context: PromptTokenContext): boolean {
  if (node.type !== TOKEN_NODE) return false;
  const value = String(node.attrs?.value ?? "");
  if (node.attrs?.kind === "skill") return !context.skills.has(value);
  if (node.attrs?.kind === "model") return !context.models?.has(value);
  return false;
}

export function retokenize(doc: RichNodeJSON, context: PromptTokenContext): RichNodeJSON {
  // Textblocks anywhere (a list item's or a quote's paragraphs too); code stays literal.
  const visit = (block: RichNodeJSON): RichNodeJSON => {
      if (block.type === CODE_BLOCK_NODE || block.type === "horizontalRule") return block;
      if (block.type !== "paragraph" && block.type !== "heading") return block.content ? { ...block, content: block.content.map(visit) } : block;
      const content: RichNodeJSON[] = [];
      let previous = "";
      for (const original of block.content ?? []) {
        // skillChipReplacements: a skill or model chip whose skill or model is gone (a provider switch, a trimmed catalog) reverts to its text.
        const node = isStaleChip(original, context) ? { type: "text", text: tokenSource(original) } : original;
        if (node.type !== "text") { content.push(node); previous = tokenSource(node).slice(-1); continue; }
        // Code is literal: `$x` or `@y` in a code span stays text.
        if (nodeMarks(node).includes("code")) { content.push(node); previous = (node.text ?? "").slice(-1); continue; }
        const text = node.text ?? "";
        // A token needs whitespace (or the line's start) before it: the character before this text decides.
        const lead = previous === "" || /\s/.test(previous) ? "" : "x";
        splitPrompt(lead + text, context).forEach((segment, index) => {
          if (segment.type === "token") { content.push(node.marks ? { ...tokenNode(segment.token, segment.label), marks: node.marks } : tokenNode(segment.token, segment.label)); return; }
          const piece = index === 0 && lead ? segment.text.slice(1) : segment.text;
          if (piece) content.push({ type: "text", text: piece, ...(node.marks ? { marks: node.marks } : {}) });
        });
        previous = text.slice(-1);
      }
      const merged: RichNodeJSON[] = [];
      for (const node of content) {
        const last = merged[merged.length - 1];
        if (last && last.type === "text" && node.type === "text" && JSON.stringify(last.marks ?? []) === JSON.stringify(node.marks ?? [])) last.text = (last.text ?? "") + (node.text ?? "");
        else merged.push({ ...node });
      }
      return merged.length ? { ...block, content: merged } : { type: block.type, ...(block.attrs ? { attrs: block.attrs } : {}) };
  };
  return { ...doc, content: (doc.content ?? []).map(visit) };
}

/** The prompt text a selection holds (the clipboard's copy): tokens as their prompt source, so pasting restores them (composerInlineTokenPaste). */
export function selectedPromptText(doc: RichNodeJSON, from: number, to: number): string {
  const start = posToOffset(doc, Math.min(from, to));
  const end = posToOffset(doc, Math.max(from, to));
  return docToPrompt(doc).slice(start, end);
}

/**
 * The styled text touching prompt offsets `from`..`to` (collectStyledRanges + touches): the run of a line from an opening
 * delimiter through the matching close, or null when the selection is in plain text or a code block.
 */
export function styledRangeAt(doc: RichNodeJSON, text: string, from: number, to: number): { start: number; end: number } | null {
  const lineStart = text.lastIndexOf("\n", from - 1) + 1;
  const lineEndAt = text.indexOf("\n", to);
  const lineEnd = lineEndAt === -1 ? text.length : lineEndAt;
  if (lineEndAt !== -1 && lineEndAt < to) return null;
  // A caret in a code block (or on its fence lines) is in code, not emphasis.
  const pos = offsetToPos(doc, from);
  let at = 1;
  for (const block of doc.content ?? []) {
    const size = nodeSize(block);
    if (pos >= at && pos <= at + size - 2) { if (block.type === CODE_BLOCK_NODE) return null; break; }
    at += size;
  }
  const line = text.slice(lineStart, lineEnd);
  const units = inlineMarkdownUnitMarks(line);
  let start = -1;
  for (let index = 0; index <= line.length; index += 1) {
    const unit = index < line.length ? units[index] : undefined;
    const styled = index < line.length && (unit === null || (unit?.length ?? 0) > 0);
    if (styled && start < 0) start = index;
    if (!styled && start >= 0) {
      const range = { start: lineStart + start, end: lineStart + index };
      // Inclusive edges: a caret right before the opener or right after the closer touches it (touches()).
      if (from <= range.end && to >= range.start && units.slice(start, index).some((item) => item === null)) return range;
      start = -1;
    }
  }
  return null;
}
