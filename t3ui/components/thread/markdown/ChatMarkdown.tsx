import { cleanup, Clipboard, colorScheme, computed, effect, Image, openUrl, Scroll, signal, Text, token, untracked, View } from "nsh";
import type { ViewRef } from "nsh";
import { headingIds, openMarkdownFragment, registerHeading } from "./markdownFragments";
import { ChevronTurn, enterStyle } from "../../motion/Motion";
import { streamingBlockFadeIn } from "../../motion/motionTokens";
import { Menu, MenuItem, Popover, TextView } from "nsh/base";
import type { TextViewBlock, TextViewClasses, TextViewCustomNode, TextViewDocument, TextViewFootnote, TextViewMath, TextViewStyles, TextViewTable } from "nsh/base";
import { allProjects, openThread, openThreadById, settingValue, threadById } from "../../../store";
import { currentWorkspace, openBrowserAction, openFileAction, openIssueSurface } from "../../rightPanel/panelState";
import { cachedIssueTrackersSnapshot, resolveIssueLinkTarget } from "../../issue/issueLogic";
import { issuesSupported, resolveIssueEnvironmentId } from "../../issue/issueStore";
import { canOpenLinksInApp, openUrlInPreviewTab } from "../../browser/previewOpeners";
import { tokenAlpha } from "../../composer/tokenColor";
import { trackOpenChange, useOverlayOpen } from "../../rightPanel/nativeOcclusion";
import { MarkdownCodeBlock } from "./MarkdownCodeBlock";
import { MermaidCodeBlock } from "./MermaidCodeBlock";
import { mathSource, renderMath } from "./math";
import { classifyMarkdownLink } from "./markdownLinks";
import { tableToCsv, tableToMarkdown } from "./markdownTable";
import { buildReviewCommentRenderablePatch, chipColor, chipifyContextLinks, chipLabel, CONTEXT_CHIP_PATTERN, pullRequestChipKind, pullRequestKindLabel, terminalLineRange, type ContextChipRecord, type PullRequestChipMetadata } from "./contextChips";
import { PRIcon } from "../../pullRequest/PRIcon";
import { PreviewAnnotationChip } from "./PreviewAnnotationChip";
import { FileEntryIcon } from "../../files/FileEntryIcon";
import { resolveState } from "../../pullRequest/pullRequestPresentation";
import { workspaceRelativePath } from "../timeline/turnItemDetail";
import { colorFindOccurrence, FIND_ACTIVE_HIGHLIGHT, holdsFindColor, markFindMatches } from "../threadFind";
import { activeFindQuery, threadFindActive, threadFindActiveBlock } from "../threadFindState";
import { TimelineIcon } from "./TimelineIcon";
import { codeTextStyle } from "../../../typography";
import { extractFenceTitle, splitMarkdownFences, type MarkdownSegment } from "./markdownSegments";
import {
  buildNodes, codeNode, flowOf, footnotesNode, ROOT_CONTEXT, rootGaps, templateNode, type RenderItem, type RenderNode,
} from "./markdownLayout";
import { ArtifactTemplateCard, MarkdownImage } from "./MarkdownMedia";
import { resolveModelMention } from "./modelMentionPresentation";
import { CitationChip, FileChip, ModelChip, openFilePath, SkillChip, ThreadChip, WebLinkChip } from "./MarkdownChips";
import { renderCodexInlineDirectivesAsMarkdown, splitCodexArtifactTemplateMarkdown, type CodexArtifactTemplate } from "./codexDirectives";
import { collectMarkdownGallery, type ExpandedMediaItem } from "./mediaSources";
import { inlinePlainText, labelFileChips, tableCellLabelMaxWidth, transformMarkdownBlocks, type CitationChipData, type FileChipData, type InlineCodeData, type InlineContext, type InlineSkill, type ModelChipData, type SkillChipData, type TableColumnBounds, type ThreadChipData, type WebChipData } from "./markdownInline";
import { resolveMarkdownFileLinkMeta, type MarkdownFileLinkMeta } from "./fileLinkMeta";
import { taskMarkerOffsets } from "./markdownTaskList";
import { mentionableMachines, storeThreadKey } from "../../../environments/machineMentions";
import { serverEnvironment } from "../../../pages/settings/settingsState";
import { Glyph } from "../../sidebar/SidebarGlyph";
import { formatBytes } from "../mediaLayout";

/**
 * Part classes that carry index.css's `.chat-markdown` rules to TextView: 600-weight headings at
 * 1.25 / 1.125 / 1 / 0.875rem with a 1.3 line height, 700-weight strong text, a 2px quote rule.
 *
 * Every margin is zero here. TextView lays blocks out in a plain column, which does not collapse
 * margins as a browser does, so ChatMarkdown draws one block per TextView and spaces them itself
 * from markdownLayout.ts (0.65rem between blocks, 1.25rem above and 0.5rem below a heading, lists
 * and their items as the web lays them out).
 */
export const CHAT_MARKDOWN_CLASSES: TextViewClasses = {
  root: "text-sm leading-relaxed",
  paragraph: "my-0 text-sm leading-relaxed",
  heading: "my-0 font-semibold leading-[1.3] text-foreground",
  heading1: "text-xl",
  heading2: "text-lg",
  heading3: "text-base",
  heading4: "text-sm",
  heading5: "text-sm",
  heading6: "text-sm text-muted-foreground",
  blockquote: "my-0 border-l-2 border-border pl-[0.8rem]",
  list: "my-[0.65rem]",
  listItem: "mt-1",
  listItemContent: "min-w-0",
  codeBlock: "my-0 rounded-none border-0 bg-transparent",
  // Inline `code` spans are rewritten to the "inlinecode" custom node (see InlineCodePill below)
  // because TextView's native code node is a text run and drops box styling (padding/border).
  // This class is kept as the fallback TextView itself would use for any span that slips through.
  code: "rounded bg-secondary px-1 py-0.5 font-mono text-xs",
  strong: "font-bold",
  link: "text-info-foreground",
  rule: "my-0 border-t border-border",
  table: "my-0",
  tableRow: "border-b border-border-60",
  tableCell: "min-w-0 overflow-hidden px-3 py-[7px] text-sm",
  tableHeaderCell: "text-sm font-semibold text-foreground",
  details: "my-0 border-y border-border-60",
  summary: "py-1 text-sm font-medium",
  mathBlock: "my-0",
};

/** A fenced code block with the reference's header: language label on the left, copy on the right. */
type CodeSegment = Extract<MarkdownSegment, { kind: "code" }>;
type TextSegment = Extract<MarkdownSegment, { kind: "text" }>;

export function CodeBlockCard(props: { segment: () => CodeSegment; selectable?: boolean }) {
  return <MarkdownCodeBlock code={() => props.segment().code} language={() => props.segment().language} />;
}

const CONTEXT_CHIP_EXTENSIONS = [{ name: "contextchip", pattern: CONTEXT_CHIP_PATTERN }];

/** One inline context chip: the label in the kind's accent; a thread chip opens the thread, a mention its file. */
function ContextChip(props: { node: TextViewCustomNode; records?: () => Record<string, ContextChipRecord>; onOpenAttachment?: ((attachment: NonNullable<ContextChipRecord["annotationImage"]>) => void) | undefined }) {
  const kind = props.node.attributes?.["1"] ?? "";
  const id = props.node.attributes?.["2"] ?? "";
  const record = props.records?.()[id];
  const label = chipLabel(props.node.attributes?.["3"] ?? "", record, kind);
  const color = chipColor(kind);
  const open = () => {
    const threadKey = record?.kind === "thread" && record.threadId ? storeThreadKey(record.environmentId, record.threadId) : null;
    if (threadKey && threadById(threadKey)) openThreadById(threadKey);
    else if (record?.kind === "mention" && record.path) {
      const link = classifyMarkdownLink(record.path, currentWorkspace()?.cwd);
      if (link.kind === "file" && link.relativePath) openFileAction(link.relativePath);
    }
  };
  // UnavailableUserMessageContextChip: a reference whose record the message no longer has.
  if (props.records && !record && kind !== "mention" && kind !== "skill") return <Text class="font-medium leading-none text-muted-foreground" style={{ verticalAlign: "middle" }} tooltip="This context is no longer available.">{label}</Text>;
  if (record?.kind === "image" && record.annotationImage) return (
    <View class="flex-row items-center gap-[3px]" style={{ verticalAlign: "middle" }} role="button" accessibilityLabel={`Open image ${label}`} onPress={() => props.onOpenAttachment?.(record.annotationImage!)}>
      <FileEntryIcon path={record.annotationImage.name} kind="file" size={12} />
      <Text class="font-medium leading-none" style={color ? { color } : undefined}>{`${label} ${formatBytes(record.annotationImage.sizeBytes)}`}</Text>
    </View>
  );
  if (record?.kind === "file" && record.attachment) return (
    <View class="flex-row items-center gap-[3px]" style={{ verticalAlign: "middle" }} role="button" accessibilityLabel={`Open file ${label}`} onPress={() => props.onOpenAttachment?.(record.attachment!)}>
      <FileEntryIcon path={record.attachment.name} kind="file" size={12} />
      <Text class="font-medium leading-none" style={color ? { color } : undefined}>{`${label} ${formatBytes(record.attachment.sizeBytes)}`}</Text>
    </View>
  );
  if (record?.kind === "terminal" && record.text) return <TerminalContextChip record={record} label={label} />;
  if (record?.kind === "response" && record.citation) return <CitationChip data={() => ({ citation: record.citation! })} reply agentTitles={record.responseAgentTitles} />;
  if (record?.kind === "preview-annotation") return <PreviewAnnotationChip record={record} label={label} onOpenImage={props.onOpenAttachment} />;
  // EnvironmentContextChip: the machine icon and its name here (else the recorded label); the tooltip says whether it is known.
  if (record?.kind === "environment" && record.environmentId) {
    const known = mentionableMachines({ environment: serverEnvironment() }).find((machine) => machine.environmentId === record.environmentId);
    const name = known?.label.trim() || label;
    return (
      <View class="flex-row items-center gap-[3px] rounded-sm" style={{ verticalAlign: "middle" }} accessibilityLabel={`Machine, ${name}`} tooltip={known ? "T3 Code environment" : "Machine not in this app"}>
        <Glyph name={known?.machine === "laptop" ? "laptop" : "server"} size={12} tint={color ?? undefined} />
        <Text class="font-medium leading-none" style={color ? { color } : undefined}>{name}</Text>
      </View>
    );
  }
  // UserMessageMentionChip: the file-type icon before the label; pressing previews the file; the tooltip names its path.
  if (record?.kind === "mention" && record.path) return (
    <View class="flex-row items-center gap-[3px] rounded-sm" style={{ verticalAlign: "middle" }} onPress={open} accessibilityLabel={`Preview ${record.path}`} tooltip={record.path} role="button">
      <FileEntryIcon path={record.path} kind="file" size={12} />
      <Text class="font-medium leading-none" style={color ? { color } : undefined}>{label}</Text>
    </View>
  );
  if (record?.kind === "review-comment" && record.pullRequest) return <PullRequestContextChip pullRequest={record.pullRequest} />;
  if (record?.kind === "review-comment" && !record.hasPullRequest && record.filePath) return <ReviewCommentContextChip record={record} label={label} />;
  return <Text class="font-medium leading-none" style={{ verticalAlign: "middle", ...(color ? { color } : {}) }} onPress={open}>{label}</Text>;
}

/** UserMessagePullRequestContextChip (PullRequestChip): the state glyph and "#<number>" in the state's accent; it opens the
 * pull request, and its tooltip is PullRequestContextDetails (kind and number, state, title, head -> base). */
function PullRequestContextChip(props: { pullRequest: PullRequestChipMetadata }) {
  const pr = props.pullRequest;
  const color = chipColor(pullRequestChipKind(pr));
  const state = resolveState(pr);
  const label = `#${pr.number}`;
  const kindLabel = pullRequestKindLabel(pr);
  const tooltip = `${kindLabel.split(" ").slice(1).join(" ").replace(/^./, (c) => c.toUpperCase())} #${pr.number} \u00b7 ${state.label}\n${pr.title}${pr.headBranch && pr.baseBranch ? `\n${pr.headBranch} \u2192 ${pr.baseBranch}` : ""}`;
  return (
    <View class="flex-row items-center gap-[3px] rounded-sm" style={{ verticalAlign: "middle" }} onPress={() => void openUrl(pr.url)} accessibilityLabel={`Open ${kindLabel} ${label}: ${pr.title}`} tooltip={tooltip} role="button">
      <PRIcon name={state.icon} size={12} tint={color ?? undefined} />
      <Text class="font-medium leading-none" style={color ? { color } : undefined}>{label}</Text>
    </View>
  );
}

/** TerminalContextInlineChip (details "popover"): the terminal's label, the line range and the captured output. */
function TerminalContextChip(props: { record: ContextChipRecord; label: string }) {
  const open = signal(false);
  useOverlayOpen(open, "terminal context popover");
  const color = chipColor("terminal");
  return (
    <View style={{ verticalAlign: "middle" }}>
      <Popover
        onOpenChange={trackOpenChange(open)}
        placement="top"
        popupClass="w-96 rounded-lg border border-border bg-popover-84 p-2"
        trigger={
          <View class="flex-row items-center gap-[3px] rounded-sm" accessibilityLabel={`Terminal excerpt, ${props.label}`} role="button">
            <TimelineIcon name="terminal" size={12} tint={color ?? undefined} />
            <Text class="max-w-72 truncate font-medium leading-none" style={color ? { color } : undefined}>{props.label}</Text>
          </View>
        }
      >
        <View class="overflow-hidden rounded-md border border-border-70">
          <View class="flex-row items-center gap-2 border-b border-border-70 px-3 py-2">
            <TimelineIcon name="terminal" size={16} tint={String(token("success"))} />
            <Text class="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{props.record.terminalLabel ?? props.label}</Text>
            {props.record.lineStart !== undefined ? <Text class="shrink-0 text-xs text-muted-foreground">{terminalLineRange(props.record.lineStart, props.record.lineEnd ?? props.record.lineStart)}</Text> : null}
          </View>
          <Scroll class="max-h-80 bg-muted" accessibilityLabel="Captured terminal output">
            <View class="p-3" selectable><Text class="font-mono text-xs text-foreground" style={codeTextStyle()}>{props.record.text ?? ""}</Text></View>
          </Scroll>
        </View>
      </Popover>
    </View>
  );
}

/** UserMessageContextChips.tsx review-comment: a "Review comment" chip whose popover is UserMessageReviewCommentCard. */
function ReviewCommentContextChip(props: { record: ContextChipRecord; label: string }) {
  const open = signal(false);
  useOverlayOpen(open, "review comment popover");
  const color = chipColor("review-comment");
  const record = props.record;
  const fenceLanguage = record.fenceLanguage ?? "diff";
  const diff = record.diff ?? "";
  const patch = buildReviewCommentRenderablePatch({ filePath: record.filePath ?? "", diff, fenceLanguage });
  return (
    <View style={{ verticalAlign: "middle" }}>
      <Popover
        onOpenChange={trackOpenChange(open)}
        placement="top"
        popupClass="w-96 rounded-lg border border-border bg-popover-84 p-2"
        trigger={
          <View class="flex-row items-center gap-[3px] rounded-sm" accessibilityLabel={`Review comment, ${props.label}`} role="button">
            <TimelineIcon name="message-circle" size={12} tint={color ?? undefined} />
            <Text class="max-w-72 truncate font-medium leading-none" style={color ? { color } : undefined}>{props.label}</Text>
          </View>
        }
      >
      <View class="gap-2 rounded-lg border border-border-70 bg-background p-3">
        <View class="gap-1">
          <Text class="text-xs font-medium text-foreground">{workspaceRelativePath(record.filePath ?? "", currentWorkspace()?.cwd)}</Text>
          <Text class="text-2xs text-muted-foreground">{`${record.sectionTitle ?? ""} \u00b7 ${record.rangeLabel ?? ""}`}</Text>
        </View>
        {(record.text ?? "").length > 0 ? <View selectable><Text class="text-sm text-foreground">{record.text}</Text></View> : null}
        {fenceLanguage !== "diff" && diff.trim().length > 0 ? <MarkdownCodeBlock code={() => diff.trimEnd()} language={() => fenceLanguage} /> : null}
        {patch ? (
          <Scroll class="max-h-80 rounded-md bg-muted-40" accessibilityLabel="Review comment diff">
            <View class="p-2" selectable><Text class="font-mono text-xs text-foreground" style={codeTextStyle()}>{patch}</Text></View>
          </Scroll>
        ) : null}
      </View>
      </Popover>
    </View>
  );
}

/** The copy menu under a table (MarkdownTable.tsx): "Copy as Markdown" and "Copy as CSV". */
export function TableCopyMenu(props: { table: TextViewTable }) {
  const copied = signal(false);
  const menuOpen = signal(false);
  useOverlayOpen(menuOpen, "table copy menu");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const copy = (text: string) => {
    void Clipboard.writeText(text);
    copied.set(true);
    clearTimeout(timer);
    timer = setTimeout(() => copied.set(false), 1200);
  };
  const label = () => (copied() ? "Copied" : "Copy table");
  return (
    <View class="-mx-1 mt-0.5 flex-row items-center justify-end">
      <Menu
        onOpenChange={trackOpenChange(menuOpen)}
        popupClass="min-w-[160px] rounded-lg border border-border bg-popover-84 p-1"
        placement="bottom"
        align="end"
        trigger={
          <View class="size-6 items-center justify-center rounded-md hover:bg-accent active:scale-[0.97] transition-transform duration-150 ease-in-out" accessibilityLabel={label()} tooltip={label()} role="button">
            <TimelineIcon name={copied() ? "check" : "copy"} size={12} />
          </View>
        }
      >
        <MenuItem accessibilityLabel="Copy as Markdown" class="min-h-7 flex-row items-center rounded-sm px-2 py-1 hover:bg-accent" onSelect={() => copy(tableToMarkdown(props.table))}>
          <Text class="text-sm text-popover-foreground">Copy as Markdown</Text>
        </MenuItem>
        <MenuItem accessibilityLabel="Copy as CSV" class="min-h-7 flex-row items-center rounded-sm px-2 py-1 hover:bg-accent" onSelect={() => copy(tableToCsv(props.table))}>
          <Text class="text-sm text-popover-foreground">Copy as CSV</Text>
        </MenuItem>
      </Menu>
    </View>
  );
}

/** A formula typeset to an image (math.ts); TeX MathJax cannot read keeps its source, as the reference does while KaTeX cannot parse. */
export function MarkdownMath(props: { math: TextViewMath }) {
  const size = () => (props.math.display ? 14 : 14);
  const typeset = computed(() => { colorScheme(); return renderMath(props.math.tex, props.math.display, size(), String(token("foreground" as never))); });
  const source = () => mathSource(props.math.tex, props.math.display);
  const image = () => { const result = typeset(); return result.ok ? result : null; };
  return props.math.display
    ? (
      <View class="my-[0.65rem] items-center" selectable>
        {image()
          ? <Image src={image()!.url} accessibilityLabel="Display equation" style={{ width: image()!.width, height: image()!.height, maxWidth: "100%", objectFit: "contain" }} />
          : <Text class="font-mono text-sm text-foreground">{source()}</Text>}
      </View>
    )
    : image()
      ? <Image src={image()!.url} accessibilityLabel="Inline equation" style={{ width: image()!.width, height: image()!.height }} />
      : <Text class="font-mono text-[13px] text-foreground">{source()}</Text>;
}

/** A surface may claim a pressed link before the default (the Pull requests page previews pull request links): return true when handled. */
let linkInterceptor: ((href: string) => boolean) | null = null;
export function setMarkdownLinkInterceptor(next: ((href: string) => boolean) | null): () => void {
  linkInterceptor = next;
  return () => { if (linkInterceptor === next) linkInterceptor = null; };
}

/** Whether a press on a web link opens the integrated browser (the "Open links in" setting, resolveLinkTarget). */
export function linksOpenInApp(): boolean {
  return settingValue("browserLinkTarget") === "app" && currentWorkspace() !== null && canOpenLinksInApp();
}

// resolveLinkTarget (browserLinkTarget.ts): Cmd/Ctrl-click opens the system browser. A TextView's link press carries no
// keys, so the keys held over the message (mouse moves report modifier changes too) stand in. Middle click: not reported.
let heldModifiers: { platform: boolean; control: boolean } = { platform: false, control: false };
/** resolveLinkTarget for a chat web link: the app's browser unless a modifier forces the system one, or it is not a web URL. */
export function webLinkTarget(url: string, modifiers: { platform: boolean; control: boolean }, inApp: boolean): "app" | "system" {
  return /^https?:/i.test(url) && !modifiers.platform && !modifiers.control && inApp ? "app" : "system";
}
export const noteLinkModifiers = (modifiers: { platform: boolean; control: boolean }) => { heldModifiers = { platform: modifiers.platform, control: modifiers.control }; };

/** What a pressed markdown link does: threads open in the chat, workspace files in the right panel, web links in the browser the setting names, the rest go to the system. */
export function openMarkdownLink(href: string) {
  if (linkInterceptor?.(href)) return;
  const link = classifyMarkdownLink(href, currentWorkspace()?.cwd);
  if (link.kind === "thread") {
    if (threadById(link.threadId)) openThreadById(link.threadId);
    return;
  }
  if (link.kind === "file") {
    const meta = resolveMarkdownFileLinkMeta(href, currentWorkspace()?.cwd);
    if (meta) void openFilePath(meta);
    else if (link.relativePath) openFileAction(link.relativePath, link.line);
    else void openUrl(`file://${link.path}`).catch(() => undefined);
    return;
  }
  if (link.kind === "external") {
    if (!heldModifiers.platform && !heldModifiers.control) {
      const thread = openThread();
      const envId = resolveIssueEnvironmentId(thread?.projectId ?? "");
      if (issuesSupported(envId)) {
        const target = resolveIssueLinkTarget({
          url: link.url,
          projects: allProjects(),
          ...(thread?.projectId ? { preferredProjectId: thread.projectId } : {}),
          trackers: cachedIssueTrackersSnapshot(envId),
        });
        if (target) {
          openIssueSurface({
            projectId: target.projectId,
            tracker: target.ref.tracker,
            ...(target.ref.host ? { host: target.ref.host } : {}),
            scope: target.ref.scope,
            key: target.ref.key,
            url: link.url,
          });
          return;
        }
      }
    }
    if (webLinkTarget(link.url, heldModifiers, linksOpenInApp()) === "app") {
      // useOpenLink: the visit is recorded; an in-app open that fails falls back to the system browser.
      try { openUrlInPreviewTab(link.url); } catch { void openUrl(link.url).catch(() => undefined); }
    } else void openUrl(link.url).catch(() => undefined);
  }
}

/** What the markdown around a block hands every block: the message's chips, workspace and media. */
export interface MarkdownEnv {
  /** Width available to inline file links in this rendered block. */
  fileLinkWidth?: () => number;
  contexts?: () => Record<string, ContextChipRecord>;
  /** A context chip's attachment opened in the large viewer (a preview annotation's screenshot). */
  onOpenAttachment?: (attachment: { id: string; name: string; mimeType: string; sizeBytes: number; type: string }) => void;
  cwd: () => string | null;
  threadId: () => string | null;
  gallery: () => ExpandedMediaItem[];
  onUseTemplate?: (template: CodexArtifactTemplate) => void;
  /** Toggles the n-th task of the message (the caller writes the new state back into its text). */
  onTaskChange?: (index: number, checked: boolean) => void;
  /** rehypeHeadingIds: the slug id of each heading block of the message. */
  headingId?: (block: TextViewBlock) => string | null;
  /** The message's headings on screen, by id: its `#heading` links look here first. */
  headings?: Map<string, ViewRef>;
  /** The timeline row of the text: only the active find match's row opens its folds (beforematch). */
  findRowId?: () => string;
  /** The code of the block holding the row's active match, when it is not in the text (its first code block with a match). */
  findActiveCode?: () => string | null;
}

/** markdownProseDirection: each block takes the direction of its own text (right to left for Arabic or Hebrew). */
const AUTO_DIRECTION: TextViewStyles = { root: { writingDirection: "auto" } };
/** ::highlight(t3-thread-find): find matches on the search-match colours (light oklch(0.915 0.11 85), dark oklch(0.55 0.1 85)); the active one's background is its node's colour. */
const FIND_STYLES_LIGHT: TextViewStyles = { root: { writingDirection: "auto" }, highlight: { backgroundColor: "#f3d98a", color: "#2a2116" } };
const FIND_STYLES_DARK: TextViewStyles = { root: { writingDirection: "auto" }, highlight: { backgroundColor: "#8a7232", color: "#f7f7f7" } };

const openExternalUrl = (url: string) => { void openUrl(url).catch(() => undefined); };

/** Inline code uses the reference's transparent outline and foreground-tinted surface. */
function InlineCodePill(props: { data: () => InlineCodeData }) {
  return (
    <View class="rounded-[0.25rem] border border-transparent px-1 py-px" style={{ backgroundColor: tokenAlpha("foreground", 0.1), verticalAlign: "middle" }}>
      <Text class="font-mono text-xs leading-none text-foreground">{props.data().code}</Text>
    </View>
  );
}

function MarkdownCustom(props: { node: TextViewCustomNode; env: MarkdownEnv }) {
  const node = props.node;
  const env = props.env;
  const tableWidth = (column?: TableColumnBounds) => column ? () => tableCellLabelMaxWidth(column, env.fileLinkWidth?.() ?? 600) : undefined;
  switch (node.name) {
    case "filelink": {
      const data = node.data as FileChipData;
      return <FileChip data={() => data} threadId={env.threadId} maxLabelWidth={tableWidth(data.tableColumn) ?? env.fileLinkWidth} />;
    }
    case "threadlink": {
      const data = node.data as ThreadChipData;
      return <ThreadChip data={() => data} maxLabelWidth={tableWidth(data.tableColumn)} />;
    }
    case "skill": {
      const data = node.data as SkillChipData;
      return <SkillChip data={() => data} maxLabelWidth={tableWidth(data.tableColumn)} />;
    }
    case "model": {
      const data = node.data as ModelChipData;
      return <ModelChip data={() => data} maxLabelWidth={tableWidth(data.tableColumn)} />;
    }
    case "citation": {
      const data = node.data as CitationChipData;
      return <CitationChip data={() => data} maxLabelWidth={tableWidth(data.tableColumn)} />;
    }
    case "weblink": {
      const data = node.data as WebChipData;
      return <WebLinkChip data={() => data} maxLabelWidth={tableWidth(data.tableColumn)} onOpen={openMarkdownLink} openExternal={openExternalUrl} openInApp={currentWorkspace() !== null ? openBrowserAction : null} />;
    }
    case "inlinecode": return <InlineCodePill data={() => node.data as InlineCodeData} />;
    default: return <ContextChip node={node} records={env.contexts} onOpenAttachment={env.onOpenAttachment} />;
  }
}

/** One block of markdown, drawn by a TextView of its own so the surrounding layout can space it. */
function MarkdownLeaf(props: { document: () => TextViewDocument; env: MarkdownEnv }) {
  // The block drawing the active find match is where the transcript scrolls (useThreadFindNavigation's range).
  let node: ViewRef | null = null;
  const fileLinkWidth = signal(288);
  const env = { ...props.env, fileLinkWidth };
  const active = computed(() => holdsFindColor(props.document(), FIND_ACTIVE_HIGHLIGHT));
  effect(() => { if (active() && node) { const self = node; untracked(() => threadFindActiveBlock.set(self)); } });
  cleanup(() => { if (node && untracked(threadFindActiveBlock) === node) threadFindActiveBlock.set(null); });
  return (
    <View class="min-w-0" ref={(ref) => { node = ref; if (ref && untracked(active)) threadFindActiveBlock.set(ref); }} onLayout={(event) => { const width = Math.max(0, Math.floor(event.bounds.size.width) - 18); if (width !== untracked(fileLinkWidth)) fileLinkWidth.set(width); }} onMouseMove={(event) => noteLinkModifiers(event.modifiers)}>
    <TextView
      document={props.document()}
      extensions={props.env.contexts ? CONTEXT_CHIP_EXTENSIONS : undefined}
      renderCustom={(node) => <MarkdownCustom node={node} env={env} />}
      renderImage={(image) => <MarkdownImage image={image} ctx={props.env} />}
      selectable
      links="report"
      onLinkPress={(event) => { if (event.url.startsWith("#")) { openMarkdownFragment(event.url, props.env.headings); return; } openMarkdownLink(event.url); }}
      renderTableActions={(table) => <TableCopyMenu table={table} />}
      renderMath={(math) => <MarkdownMath math={math} />}
      classes={CHAT_MARKDOWN_CLASSES}
      styles={activeFindQuery() ? (colorScheme() === "dark" ? FIND_STYLES_DARK : FIND_STYLES_LIGHT) : AUTO_DIRECTION}
    />
    </View>
  );
}

/** The marker column of a list item: a disc, ring or square by depth, a number, or a task's box. */
function ListMarker(props: { style: () => string; item: () => RenderItem; env: MarkdownEnv }) {
  const style = props.style;
  const toggle = () => { const item = props.item(); if (props.env.onTaskChange && item.taskIndex !== undefined) props.env.onTaskChange(item.taskIndex, !item.checked); };
  return (
    <>
      {props.item().checked !== undefined ? (
        // `input[type=checkbox]` in a `li.task-list-item`: the box replaces the marker.
        <View
          class={props.item().checked ? "mt-[5px] size-[13px] items-center justify-center rounded-[3px] border border-primary bg-primary" : "mt-[5px] size-[13px] rounded-[3px] border border-input bg-background"}
          accessibilityLabel={props.env.onTaskChange ? "Toggle task" : props.item().checked ? "Completed" : "Not completed"}
          accessibilityState={{ checked: props.item().checked === true }}
          role={props.env.onTaskChange ? "checkbox" : undefined}
          onPress={props.env.onTaskChange ? toggle : undefined}
        >
          {props.item().checked ? <TimelineIcon name="check" size={10} /> : null}
        </View>
      ) : style() === "disc" ? (
        // The list-style marker sits 7px before the text (Chromium's marker padding), about a third of an em wide.
        <View class="mt-2.5 mr-[7px] size-[5px] rounded-full bg-foreground" />
      ) : style() === "circle" ? (
        <View class="mt-2.5 mr-[7px] size-[5px] rounded-full border border-foreground" />
      ) : style() === "square" ? (
        <View class="mt-2.5 mr-[7px] size-[5px] bg-foreground" />
      ) : (
        <Text class="pr-1 text-sm leading-relaxed text-foreground">{props.item().label}</Text>
      )}
    </>
  );
}

function MarkdownList(props: { node: () => Extract<RenderNode, { kind: "list" }>; env: MarkdownEnv }) {
  const gaps = () => flowOf(props.node().items.map((item) => item.flow)).gaps;
  const items = () => props.node().items.map((item, index) => ({ item, index }));
  return (
    <View class="min-w-0">
      <Each of={items()} key="index">
        {(entry) => (
          <View class="flex-row" style={{ marginTop: gaps()[entry().index] ?? 0 }}>
            <View class="shrink-0 items-end" style={{ width: props.node().gutter }}>
              <ListMarker style={() => props.node().style} item={() => entry().item} env={props.env} />
            </View>
            <View class="min-w-0 flex-auto">
              <MarkdownFlow nodes={() => entry().item.children} env={props.env} />
            </View>
          </View>
        )}
      </Each>
    </View>
  );
}

/** GITHUB_ALERT_PRESENTATIONS: the rule, the title's icon and label, in the alert's colours (dark uses the 400 shade, amber stays 500). */
const ALERTS: Record<string, { label: string; icon: string; rule: string; light: string; dark: string }> = {
  note: { label: "Note", icon: "info", rule: "59,130,246", light: "#2563eb", dark: "#60a5fa" },
  tip: { label: "Tip", icon: "lightbulb", rule: "16,185,129", light: "#059669", dark: "#34d399" },
  important: { label: "Important", icon: "message-square-warning", rule: "168,85,247", light: "#9333ea", dark: "#c084fc" },
  warning: { label: "Warning", icon: "triangle-alert", rule: "245,158,11", light: "#d97706", dark: "#f59e0b" },
  caution: { label: "Caution", icon: "octagon-alert", rule: "239,68,68", light: "#dc2626", dark: "#f87171" },
};

function MarkdownAlert(props: { node: () => Extract<RenderNode, { kind: "alert" }>; env: MarkdownEnv }) {
  const presentation = () => ALERTS[props.node().alert] ?? ALERTS.note!;
  const color = () => (colorScheme() === "dark" ? presentation().dark : presentation().light);
  const gaps = () => flowOf([{ mt: 10.4, mb: 10.4 }, ...props.node().children.map((child) => child.flow)]).gaps;
  return (
    <View class="min-w-0 border-l-2 pl-3" style={{ borderColor: `rgba(${presentation().rule},0.7)` }} accessibilityLabel={presentation().label}>
      <View class="flex-row items-center gap-1.5">
        <TimelineIcon name={presentation().icon} size={14} tint={color()} />
        <Text class="text-sm font-medium" style={{ color: color() }}>{presentation().label}</Text>
      </View>
      <Each of={props.node().children.map((child, index) => ({ child, index }))} key="index">
        {(entry) => (
          <View class="min-w-0" style={{ marginTop: gaps()[entry().index + 1] ?? 0 }}>
            <MarkdownNode node={() => entry().child} env={props.env} />
          </View>
        )}
      </Each>
    </View>
  );
}

/** Whether a find query occurs in a details block's hidden content (its text, as the parsed blocks hold it). */
export function detailsHoldsFindMatch(children: unknown, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return false;
  const texts: string[] = [];
  const visit = (value: unknown) => {
    if (typeof value === "string") { texts.push(value); return; }
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (value && typeof value === "object") for (const [key, entry] of Object.entries(value)) if (key !== "flow" && key !== "kind" && key !== "type") visit(entry);
  };
  visit(children);
  return texts.join(" ").toLowerCase().includes(needle);
}

/** MarkdownDetails: `my-2 border-y border-border/60`, a chevron that turns, the summary ("Details" when empty), the blocks indented 1.5rem. */
function MarkdownDetails(props: { node: () => Extract<RenderNode, { kind: "details" }>; env: MarkdownEnv }) {
  const open = signal(props.node().open);
  // markdownFindContext / foldHiding: a find match inside a closed details block opens it, so the match can show.
  // beforematch: only the row holding the active match opens its folds (a text with no row: any match).
  const activeRow = () => { const rowId = props.env.findRowId?.(); return rowId === undefined || threadFindActive()?.rowId === rowId; };
  effect(() => { if (activeRow() && detailsHoldsFindMatch(props.node().children, activeFindQuery())) untracked(() => open.set(true)); });
  return (
    <View class="min-w-0 border-y border-border-60">
      <View class="flex-row items-center gap-2 py-2" role="button" accessibilityLabel={open() ? "Collapse details" : "Expand details"} accessibilityState={{ expanded: open() }} onPress={() => open.update((value) => !value)}>
        <ChevronTurn open={open}><TimelineIcon name="chevron-right" size={16} /></ChevronTurn>
        {props.node().summary.length > 0
          ? <MarkdownLeaf document={() => ({ blocks: [{ type: "paragraph", content: props.node().summary }] })} env={props.env} />
          : <Text class="text-sm font-medium text-foreground">Details</Text>}
      </View>
      {open() ? <View class="min-w-0 pb-3 ps-6"><MarkdownFlow nodes={() => props.node().children} env={props.env} /></View> : null}
    </View>
  );
}

/** A heading block with its slug id: registered while mounted, so `#heading` links can scroll to it. */
function HeadingLeaf(props: { block: () => TextViewBlock; env: MarkdownEnv }) {
  const id = () => props.env.headingId?.(props.block()) ?? null;
  let node: ViewRef | null = null;
  let release: (() => void) | null = null;
  const attach = () => {
    release?.();
    release = null;
    const current = id();
    if (!node || !current) return;
    props.env.headings?.set(current, node);
    const off = registerHeading(node, current);
    const headings = props.env.headings;
    const self = node;
    release = () => { off(); if (headings?.get(current) === self) headings.delete(current); };
  };
  effect(() => { id(); untracked(attach); });
  cleanup(() => release?.());
  return (
    <View class="min-w-0" testID={id() ?? undefined} ref={(ref) => { node = ref; attach(); }}>
      <MarkdownLeaf document={() => ({ blocks: [props.block()] })} env={props.env} />
    </View>
  );
}

function MarkdownNode(props: { node: () => RenderNode; env: MarkdownEnv }) {
  const node = props.node;
  return (
    <>
      {node().kind === "leaf" && props.env.headingId?.((node() as Extract<RenderNode, { kind: "leaf" }>).block) ? (
        <HeadingLeaf block={() => (node() as Extract<RenderNode, { kind: "leaf" }>).block} env={props.env} />
      ) : node().kind === "leaf" ? (
        <MarkdownLeaf document={() => ({ blocks: [(node() as Extract<RenderNode, { kind: "leaf" }>).block] })} env={props.env} />
      ) : node().kind === "code" && (node() as Extract<RenderNode, { kind: "code" }>).language.toLowerCase() === "mermaid" ? (
        <MermaidCodeBlock
          findRowId={props.env.findRowId}
          code={() => (node() as Extract<RenderNode, { kind: "code" }>).code}
          open={() => (node() as Extract<RenderNode, { kind: "code" }>).open === true}
          title={() => (node() as Extract<RenderNode, { kind: "code" }>).title ?? null}
        />
      ) : node().kind === "code" ? (
        <MarkdownCodeBlock
          flush
          findActive={() => props.env.findActiveCode?.() === (node() as Extract<RenderNode, { kind: "code" }>).code}
          code={() => (node() as Extract<RenderNode, { kind: "code" }>).code}
          language={() => (node() as Extract<RenderNode, { kind: "code" }>).language}
          open={() => (node() as Extract<RenderNode, { kind: "code" }>).open === true}
          title={() => (node() as Extract<RenderNode, { kind: "code" }>).title ?? null}
        />
      ) : node().kind === "list" ? (
        <MarkdownList node={() => node() as Extract<RenderNode, { kind: "list" }>} env={props.env} />
      ) : node().kind === "alert" ? (
        <MarkdownAlert node={() => node() as Extract<RenderNode, { kind: "alert" }>} env={props.env} />
      ) : node().kind === "details" ? (
        <MarkdownDetails node={() => node() as Extract<RenderNode, { kind: "details" }>} env={props.env} />
      ) : node().kind === "template" ? (
        <ArtifactTemplateCard template={() => (node() as Extract<RenderNode, { kind: "template" }>).template} onUse={props.env.onUseTemplate} />
      ) : node().kind === "quote" ? (
        // `blockquote`: a 2px rule and 0.8rem of padding on the inline start.
        <View class="min-w-0 border-l-2 border-border pl-[0.8rem]">
          <MarkdownFlow nodes={() => (node() as Extract<RenderNode, { kind: "quote" }>).children} env={props.env} />
        </View>
      ) : (
        <MarkdownLeaf document={() => ({ blocks: [], footnotes: (node() as Extract<RenderNode, { kind: "footnotes" }>).footnotes })} env={props.env} />
      )}
    </>
  );
}

/** A column of blocks, each `margin-top` the collapsed gap the web would put above it. */
function MarkdownFlow(props: { nodes: () => RenderNode[]; root?: boolean; env: MarkdownEnv; streaming?: () => boolean }) {
  const gaps = () => (props.root ? rootGaps(props.nodes().map((node) => node.flow)) : flowOf(props.nodes().map((node) => node.flow)).gaps);
  const entries = () => props.nodes().map((node, index) => ({ node, index }));
  return (
    <View class="min-w-0">
      <Each of={entries()} key="index">
        {(entry) => (
          <View class="min-w-0" style={[{ marginTop: gaps()[entry().index] ?? 0 }, untracked(() => props.streaming?.()) ? enterStyle(streamingBlockFadeIn) : null]}>
            <MarkdownNode node={() => entry().node} env={props.env} />
          </View>
        )}
      </Each>
    </View>
  );
}

export interface MarkdownNodesOptions {
  /** The thread's workspace: file links and inline-code paths resolve against it. */
  cwd?: string | null;
  /** The provider's skills: `$name` becomes a skill chip. */
  skills?: readonly InlineSkill[];
  /** The "Math rendering" setting: off keeps `$x$` as written. */
  math?: boolean;
  /** `model:<instance>/<model>` mentions become model chips for the models this resolves. */
  models?: InlineContext["models"];
  /** Web links with short text become favicon chips (default on). */
  webLinkChips?: boolean;
}

/** The leaf and nested blocks of a render tree, for the media gallery. */
export function renderNodeBlocks(nodes: readonly RenderNode[]): TextViewBlock[] {
  const out: TextViewBlock[] = [];
  const visit = (list: readonly RenderNode[]) => {
    for (const node of list) {
      if (node.kind === "leaf") out.push(node.block);
      else if (node.kind === "list") for (const item of node.items) visit(item.children);
      else if (node.kind === "quote" || node.kind === "alert" || node.kind === "details") visit(node.children);
    }
  };
  visit(nodes);
  return out;
}

/** The blocks of a message: its text segments parsed, each fenced code block a card between them, and an artifact template a card. */
export function markdownNodes(text: string, streaming: boolean, withChips: boolean, query: string, chipify: (text: string) => string, mark: (text: string, query: string) => string, options: MarkdownNodesOptions = {}): RenderNode[] {
  const nodes: RenderNode[] = [];
  const footnotes: TextViewFootnote[] = [];
  const everyBlock: TextViewBlock[] = [];
  const files: MarkdownFileLinkMeta[] = [];
  const inline: InlineContext = { cwd: options.cwd ?? null, skills: options.skills ?? [], webLinkChips: options.webLinkChips !== false, ...(options.models ? { models: options.models } : {}) };
  const mathEnabled = options.math === true;
  const layout = { ...ROOT_CONTEXT, tasks: { count: 0 } };
  const parse = (markdown: string) => {
    const source = mark(withChips ? chipify(markdown) : markdown, query);
    let blocks: TextViewBlock[];
    try {
      const document = TextView.parse(source, { streaming, math: mathEnabled }, withChips ? CONTEXT_CHIP_EXTENSIONS : undefined);
      blocks = transformMarkdownBlocks(document.blocks, inline, files);
      for (const footnote of document.footnotes ?? []) footnotes.push({ ...footnote, children: transformMarkdownBlocks(footnote.children, inline, files) });
    } catch {
      blocks = [{ type: "paragraph", content: [{ type: "text", text: markdown }] }];
    }
    everyBlock.push(...blocks);
    nodes.push(...buildNodes(blocks, layout));
  };
  for (const segment of splitMarkdownFences(text)) {
    if (segment.kind === "code") {
      if (mathEnabled && segment.language.toLowerCase() === "math" && !(segment.open || streaming)) nodes.push(...buildNodes([{ type: "math", tex: segment.code }], layout));
      else nodes.push(codeNode(segment.language, segment.code, segment.open || streaming, extractFenceTitle(segment.meta)));
      continue;
    }
    const directed = renderCodexInlineDirectivesAsMarkdown(segment.text);
    for (const piece of splitCodexArtifactTemplateMarkdown(directed)) {
      if (piece.kind === "artifact-template") nodes.push(templateNode(piece.template));
      else if (piece.markdown.trim() !== "") parse(piece.markdown);
    }
  }
  labelFileChips([...everyBlock, ...footnotes.flatMap((footnote) => footnote.children)], files);
  if (footnotes.length > 0) nodes.push(footnotesNode(footnotes));
  return nodes;
}

/**
 * Port of ChatMarkdown: markdown with the web app's block spacing, link
 * colour and code block cards. Partial markdown from a streaming reply is
 * safe: an unclosed fence renders as an open code card.
 *
 * The text is parsed into blocks and laid out here (markdownLayout.ts) rather than handed whole to
 * one TextView, because TextView stacks blocks with plain margins and the web collapses them; every
 * block is drawn by a TextView of its own, lists by the markers and gutters of index.css.
 */
export function ChatMarkdown(props: {
  text: () => string;
  streaming?: () => boolean;
  class?: string;
  /** Context records of a user message: its t3-context links render as chips. */
  contexts?: () => Record<string, ContextChipRecord>;
  /** A context chip's attachment opened in the large viewer (a preview annotation's screenshot). */
  onOpenAttachment?: (attachment: { id: string; name: string; mimeType: string; sizeBytes: number; type: string }) => void;
  /** The workspace file links resolve against (the open thread's by default). */
  cwd?: () => string | null;
  /** The skills `$name` chips are drawn for; none by default, so only a message surface turns them on. */
  skills?: () => readonly InlineSkill[];
  /** Model mention chips (`model:<instance>/<model>`): a message surface turns them on, as it does skills. */
  modelMentions?: boolean;
  /** Use template: appends the template's prompt to the composer draft. Without it a template card has no button. */
  onUseArtifactTemplate?: (template: CodexArtifactTemplate) => void;
  /** Toggling a task item writes `[x]` / `[ ]` back at `markerOffset` of `text()` (the caller edits its source). */
  onTaskListChange?: (change: { markerOffset: number; checked: boolean }) => void;
  /** Web links keep their text-link form instead of a favicon chip. */
  plainLinks?: boolean;
  /** The timeline row the text is in: the active find match in it is drawn in the active colour. */
  findRowId?: () => string;
}) {
  const cwd = () => props.cwd?.() ?? currentWorkspace()?.cwd ?? null;
  const threadId = () => currentWorkspace()?.threadId ?? null;
  const parsedNodes = computed(() => markdownNodes(props.text(), props.streaming?.() === true, props.contexts !== undefined, activeFindQuery(), chipifyContextLinks, markFindMatches, {
    cwd: cwd(),
    skills: props.skills?.() ?? [],
    math: settingValue("mathRenderingEnabled") === true,
    webLinkChips: props.plainLinks !== true,
    ...(props.modelMentions ? { models: resolveModelMention } : {}),
  }));
  // threadFindHighlights active range: the active occurrence in this row takes the active colour.
  const nodes = computed(() => {
    const active = threadFindActive();
    const parsed = parsedNodes();
    return active && props.findRowId && active.rowId === props.findRowId() ? colorFindOccurrence(parsed, active.occurrence, FIND_ACTIVE_HIGHLIGHT) : parsed;
  });
  const gallery = computed(() => collectMarkdownGallery(renderNodeBlocks(nodes()), cwd(), threadId()));
  // The active match is in the row but not drawn in its text: the first code block holding the query has it.
  const findActiveCode = computed(() => {
    const active = threadFindActive();
    const query = activeFindQuery().toLowerCase();
    if (!query || !active || !props.findRowId || active.rowId !== props.findRowId() || holdsFindColor(nodes(), FIND_ACTIVE_HIGHLIGHT)) return null;
    const visit = (list: readonly RenderNode[]): string | null => {
      for (const node of list) {
        if (node.kind === "code" && node.language.toLowerCase() !== "mermaid" && node.code.toLowerCase().includes(query)) return node.code;
        const nested = node.kind === "list" ? node.items.flatMap((item) => item.children) : node.kind === "quote" || node.kind === "alert" || node.kind === "details" ? node.children : [];
        const found = nested.length ? visit(nested) : null;
        if (found) return found;
      }
      return null;
    };
    return visit(nodes());
  });
  // rehypeHeadingIds: every heading of the message, in order, gets its GitHub slug id.
  const headingIdsByBlock = computed(() => {
    const blocks = renderNodeBlocks(nodes()).filter((block) => block.type === "heading");
    const ids = headingIds(blocks.map((block) => inlinePlainText((block as Extract<TextViewBlock, { type: "heading" }>).content)));
    const map = new Map<TextViewBlock, string>();
    blocks.forEach((block, index) => { const id = ids[index]; if (id) map.set(block, id); });
    return map;
  });
  const env: MarkdownEnv = {
    contexts: props.contexts,
    onOpenAttachment: props.onOpenAttachment,
    cwd,
    threadId,
    gallery: () => gallery(),
    headingId: (block) => headingIdsByBlock().get(block) ?? null,
    headings: new Map(),
    findRowId: props.findRowId,
    findActiveCode: () => findActiveCode(),
    onUseTemplate: props.onUseArtifactTemplate,
    onTaskChange: props.onTaskListChange
      ? (index, checked) => {
        const markerOffset = taskMarkerOffsets(props.text())[index];
        if (markerOffset !== undefined) props.onTaskListChange?.({ markerOffset, checked });
      }
      : undefined,
  };
  return (
    <View class={`min-w-0 ${props.class ?? ""}`}>
      <MarkdownFlow nodes={nodes} root env={env} streaming={props.streaming} />
    </View>
  );
}
