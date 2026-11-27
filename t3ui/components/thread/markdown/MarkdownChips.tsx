// The chips chat markdown draws inline (MarkdownFileLink.tsx, MarkdownThreadLink.tsx, SkillInlineText.tsx SkillChipPopover,
// AssistantCitationChip.tsx, MarkdownExternalLink.tsx): each is a View in the line of text, in its kind's accent.
//
// Hover and right-click on a text link are not reported in this runtime, so every chip is a View that takes both: a press is the
// chip's primary action, a right press opens the reference's context menu as a native popup (files/filePopup.ts), and the
// reference's hover tooltips are the View's own `tooltip`. A skill or citation chip, which the reference opens on a press as a
// popover, is a Popover here too.
import { HIcon } from "../../header/HeaderIcons";
import { Clipboard, colorScheme, Image, platform, signal, Text, View } from "nsh";
import { FadeScroll } from "../../FadeScroll";
import type { MenuItem as NativeMenuItem } from "nsh/desktop";
import { Popover } from "nsh/base";
import { openThread, openThreadById, requestBackend, threadById } from "../../../store";
import { parsePullRequestUrl } from "../../pullRequest/linkPullRequestState";
import { threadLinkCommand, threadPullRequestKey } from "../../pullRequest/pullRequestThreadLinks.logic";
import { pullRequestsSupported } from "../../pullRequest/pullRequestsSupported";
import { ORCHESTRATION_OPERATE_SCOPE, scopeAllows } from "../../../backend/sessionScopes";
import { currentPanelKey, currentWorkspace, openFileAction, openSideChatAction, openSurfaceAction } from "../../rightPanel/panelState";
import { isHostPath } from "../../files/explorerState";
import { claimWorkspaceBasenameLookup, needsWorkspaceBasenameLookup, pickStrippedWorkspaceMatch, pickWorkspaceBasenameMatch, stripRepeatedWorkspacePrefix, WORKSPACE_BASENAME_LOOKUP_LIMIT } from "./workspaceBasenameLookup";
import { trackOpenChange, useOverlayOpen } from "../../rightPanel/nativeOcclusion";
import { popupOverOverlay } from "../../files/filePopup";
import { FileEntryIcon } from "../../files/FileEntryIcon";
import { fileMetadata } from "../../files/fileMetadata";
import { formatAttachmentSize } from "../../composer/attachmentIntake";
import { canOperateEnvironment, loadMenuCapabilities, OPEN_EDITOR_SCOPE_MESSAGE, preferredEditorAction } from "../../files/fileActionsRuntime";
import { runLaunch } from "../../files/fileActions";
import { editorLabel, fileManagerName, openInButtonLabel } from "../../header/openInLogic";
import { errorToast, showToast } from "../../toast";
import { chipColor, documentChipKindForFileName } from "./contextChips";
import { TimelineIcon } from "./TimelineIcon";
import { goToCitationSource } from "../citations/citationState";
import { assistantCitationLabel, serializeAssistantCitation, type AssistantCitation } from "./assistantCitations";
import { fileBasename, markdownFileCopyMenuItems, opensInBrowserByDefault, type MarkdownFileLinkMeta } from "./fileLinkMeta";
import { canOpenFileInPreview, openFileInPreview } from "../../browser/previewOpeners";
import { threadLinkLookup } from "./threadLinkMetadata";
import type { CitationChipData, FileChipData, InlineSkill, ModelChipData, SkillChipData, ThreadChipData, WebChipData } from "./markdownInline";
import { skillDisplayName } from "./markdownInline";
import { mediaKindFromPath, mediaPreviewName } from "./mediaSources";
import { expandMedia } from "./ExpandedMedia";
import { ProviderIconView } from "../../../pages/settings/providers/ui";
import globeIcon from "../../../icons/globe.svg";

/** The shared look of an inline chip: an icon and a label in the kind's accent, `font-medium`, one line. */
function ChipShell(props: {
  kind: string;
  icon: unknown;
  label: string;
  accessibilityLabel: string;
  tooltip?: string | ReturnType<typeof View>;
  onPress?: (event: { modifiers?: { platform?: boolean; control?: boolean } }) => void;
  onContextMenu?: (event: { pagePosition: { x: number; y: number } }) => void;
  disabled?: boolean;
  maxLabelWidth?: () => number;
}) {
  const color = () => chipColor(props.kind) ?? undefined;
  return (
    <View
      class="max-w-full flex-row items-center gap-[3px] rounded-sm active:opacity-80"
      style={{ verticalAlign: "middle" }}
      accessibilityLabel={props.accessibilityLabel}
      tooltip={props.tooltip}
      role="button"
      disabled={props.disabled}
      onPress={props.onPress}
      onContextMenu={props.onContextMenu as never}
    >
      {props.icon as never}
      <Text class="truncate font-medium leading-none" style={{ maxWidth: props.maxLabelWidth?.() ?? 288, ...(color() ? { color: color() } : {}) }}>{props.label}</Text>
    </View>
  );
}

// ---- opening a file wherever it is ----

/** The panel path of a file link (ChatMarkdown fileLinkChip): the workspace-relative path, else a host path that is not previewable media. */
export function filePanelPath(meta: Pick<MarkdownFileLinkMeta, "filePath" | "workspaceRelativePath">): string | null {
  return meta.workspaceRelativePath ?? (mediaKindFromPath(meta.filePath) === null && isHostPath(meta.filePath) ? meta.filePath : null);
}

type Entry = { path: string; kind: "file" | "directory" };

/** findWorkspaceFileMatch: a name written without its folders, or with the project's folders repeated, is looked up in the workspace. */
async function findWorkspaceFileMatch(meta: Pick<MarkdownFileLinkMeta, "workspaceLookupPath">, cwd: string, search: (query: string) => Promise<Entry[]>): Promise<string | null> {
  const written = meta.workspaceLookupPath;
  if (!written) return null;
  const isBasename = needsWorkspaceBasenameLookup(written);
  const stripped = isBasename ? null : stripRepeatedWorkspacePrefix(written, cwd);
  if (!isBasename && stripped === null) return null;
  const entries = await search(stripped ?? written);
  return stripped === null ? pickWorkspaceBasenameMatch(written, entries) : pickStrippedWorkspaceMatch(stripped, cwd, entries);
}

async function searchWorkspace(cwd: string, query: string): Promise<Entry[]> {
  const value = await requestBackend("projects.searchEntries", { cwd, query, limit: WORKSPACE_BASENAME_LOOKUP_LIMIT, kind: "file" }) as { entries?: Entry[] } | null;
  return Array.isArray(value?.entries) ? value!.entries! : [];
}

/** openFileInPanel: the right panel's file tab at `path` (the workspace root opens the explorer), after the lookup when the link needs one. */
export async function openInFilePanel(meta: Pick<MarkdownFileLinkMeta, "workspaceLookupPath" | "line">, panelPath: string, search: (cwd: string, query: string) => Promise<Entry[]> = searchWorkspace): Promise<void> {
  const claimed = claimWorkspaceBasenameLookup();
  const cwd = currentWorkspace()?.cwd ?? null;
  const open = (path: string) => { if (path === "." || path === "") openSurfaceAction("files"); else openFileAction(path, meta.line); };
  if (meta.workspaceLookupPath === null || meta.workspaceLookupPath === undefined || !cwd || (!needsWorkspaceBasenameLookup(panelPath) && stripRepeatedWorkspacePrefix(panelPath, cwd) === null)) { open(panelPath); return; }
  let match: string | null = null;
  try { match = await findWorkspaceFileMatch(meta, cwd, (query) => search(cwd, query)); } catch { match = null; }
  if (claimed()) open(match ?? panelPath);
}

/**
 * A press on a file chip (MarkdownFileLink handleOpenInFilePreview): with a panel path the file opens in the app's file panel,
 * at its line; otherwise a previewable media file opens its preview, otherwise the editor. The modified press (Command on
 * macOS, Control elsewhere: shouldOpenMarkdownFileLinkInEditor) goes straight to the editor. A directory takes the same road:
 * the file tab reads a folder as a folder view.
 */
const canOpenFileInBrowser = (path: string) => canOpenFileInPreview(path);
function openFileLinkInBrowser(threadId: string, filePath: string) {
  void openFileInPreview({ threadId, filePath, workspaceRoot: currentWorkspace()?.cwd ?? undefined }).catch((cause: unknown) => errorToast("Unable to open file in browser", cause instanceof Error && cause.message ? cause.message : "An error occurred."));
}

export async function openFilePath(meta: Pick<MarkdownFileLinkMeta, "filePath" | "workspaceRelativePath" | "line"> & { workspaceLookupPath?: string | null; basename?: string }, options: { modified?: boolean; search?: (cwd: string, query: string) => Promise<Entry[]> } = {}): Promise<void> {
  // MarkdownFileLink.logic: a PDF opens in the integrated browser by default when the preview is available.
  const browserThreadId = currentWorkspace()?.threadId ?? null;
  if (!options.modified && browserThreadId && opensInBrowserByDefault(meta.filePath) && canOpenFileInBrowser(meta.filePath)) {
    openFileLinkInBrowser(browserThreadId, meta.filePath);
    return;
  }
  const panelPath = filePanelPath(meta);
  if (!options.modified && panelPath !== null && currentPanelKey() !== null) {
    await openInFilePanel(meta, panelPath, options.search);
    return;
  }
  const mediaKind = mediaKindFromPath(meta.filePath);
  const threadId = currentWorkspace()?.threadId ?? null;
  if (!options.modified && mediaKind !== null && (mediaKind === "image" || mediaKind === "video") && threadId) {
    expandMedia({ items: [{ name: mediaPreviewName(meta.basename ?? fileBasename(meta.filePath), mediaKind), kind: mediaKind, source: { kind: "file", path: meta.filePath, threadId } }], index: 0 });
    return;
  }
  try {
    if (!(await canOperateEnvironment())) throw new Error(OPEN_EDITOR_SCOPE_MESSAGE);
    const action = await preferredEditorAction();
    await runLaunch(action, meta.filePath, requestBackend);
  } catch (cause) {
    errorToast("Unable to open file", cause instanceof Error ? cause.message : "An error occurred.");
  }
}

async function copyPath(value: string, title: string) {
  try {
    await Clipboard.writeText(value);
    showToast({ type: "success", title: `${title} copied`, description: value });
  } catch (cause) {
    errorToast(`Failed to copy ${title.toLowerCase()}`, cause instanceof Error ? cause.message : "An error occurred.");
  }
}

/** The file link menu (MarkdownFileLink showFileContextMenu): Preview media, the editor, the file manager, then the copy items. */
export async function fileChipMenuItems(meta: MarkdownFileLinkMeta, threadId: string | null): Promise<NativeMenuItem[]> {
  const capabilities = await loadMenuCapabilities();
  const items: NativeMenuItem[] = [];
  const kind = mediaKindFromPath(meta.filePath);
  if ((kind === "image" || kind === "video") && threadId) {
    items.push({ label: "Preview media", onSelect: () => expandMedia({ items: [{ name: mediaPreviewName(meta.basename, kind), kind, source: { kind: "file", path: meta.filePath, threadId } }], index: 0 }) });
  }
  const editors = capabilities.editors.filter((id) => id !== "file-manager");
  if (editors.length > 0) {
    const action = await preferredEditorAction();
    const label = openInButtonLabel(action.id === "editor" ? { value: action.editor, label: editorLabel(action.editor, capabilities.os) } : null);
    items.push({ label, onSelect: () => { void runLaunch(action, meta.filePath, requestBackend).catch((cause: unknown) => errorToast("Unable to open file", cause instanceof Error ? cause.message : "An error occurred.")); } });
  }
  // ChatMarkdown onOpenInBrowser: browser-previewable files (HTML, PDF) open in the integrated browser.
  const browserThreadId = currentWorkspace()?.threadId ?? null;
  if (browserThreadId && canOpenFileInBrowser(meta.filePath)) {
    items.push({ label: "Open in integrated browser", onSelect: () => openFileLinkInBrowser(browserThreadId, meta.filePath) });
  }
  if (capabilities.canReveal && capabilities.editors.includes("file-manager")) {
    items.push({
      label: `Reveal in ${fileManagerName(capabilities.os)}`,
      onSelect: () => { void runLaunch({ id: "reveal" }, meta.filePath, requestBackend).catch((cause: unknown) => errorToast("Unable to reveal file", cause instanceof Error ? cause.message : "An error occurred.")); },
    });
  }
  for (const item of markdownFileCopyMenuItems(meta)) items.push({ label: item.label, onSelect: () => void copyPath(item.value, item.title) });
  return items;
}

/** A file or inline-code path: the type's icon and the file's name (with its folder when another chip shares the name, and its line). */
export function FileChip(props: { data: () => FileChipData; threadId: () => string | null; maxLabelWidth?: () => number }) {
  const data = props.data;
  const kind = () => documentChipKindForFileName(data().meta.filePath) ?? "mention";
  const label = () => data().label || data().meta.basename;
  // WorkspaceEntryIcon / WorkspaceEntryTooltip: the server's answer for the path sets the icon kind and adds the size.
  const metadata = () => fileMetadata(data().meta.filePath, currentWorkspace()?.cwd);
  const entryKind = () => (metadata()?.kind === "directory" ? "directory" : "file");
  const press = (event?: { modifiers?: { platform?: boolean; control?: boolean } }) => { void openFilePath(data().meta, { modified: platform.os === "macos" ? event?.modifiers?.platform === true && event?.modifiers?.control !== true : event?.modifiers?.control === true && event?.modifiers?.platform !== true }); };
  return (
    <ChipShell
      kind={kind()}
      maxLabelWidth={props.maxLabelWidth}
      icon={<FileEntryIcon path={data().meta.filePath} kind={entryKind()} size={12} />}
      label={label()}
      accessibilityLabel={`File ${label()}`}
      tooltip={<View class="max-w-96 flex-row items-center gap-1.5"><FileEntryIcon path={data().meta.filePath} kind={entryKind()} size={12} /><Text class="min-w-0 text-xs text-popover-foreground">{`${data().meta.targetPath}${metadata()?.byteLength === undefined ? "" : ` \u00b7 ${formatAttachmentSize(metadata()!.byteLength!)}`}`}</Text></View>}
      onPress={press}
      onContextMenu={(event) => { void fileChipMenuItems(data().meta, props.threadId()).then((items) => popupOverOverlay(items, event.pagePosition, "file link menu")); }}
    />
  );
}

// ---- threads ----

/** Thread no longer available / on another machine (shared threadLinks.ts unknownThreadLinkLabel). */
export function unknownThreadLinkLabel(environmentId: string | null, messageEnvironmentId: string | null): string {
  return environmentId === null || environmentId === messageEnvironmentId ? "Thread no longer available" : "Thread on another machine";
}

export function ThreadChip(props: { data: () => ThreadChipData; maxLabelWidth?: () => number }) {
  const shell = () => threadById(props.data().threadId);
  // MarkdownThreadLink.tsx: a thread the shell lacks is looked up (getThreadLinkMetadata); it is unresolved only once
  // the server answered without it.
  const lookup = () => (shell() ? null : threadLinkLookup(props.data().threadId));
  const found = () => { const l = lookup(); return l?.state === "found" ? l.metadata : null; };
  const thread = () => shell() ?? found() ?? (lookup()?.state === "pending" ? { title: "" } : null);
  const label = () => shell()?.title?.trim() || found()?.title.trim() || props.data().label || "Thread";
  return thread() ? (
    <ChipShell
      kind="thread"
      maxLabelWidth={props.maxLabelWidth}
      icon={<TimelineIcon name="message-square" size={12} tint={chipColor("thread") ?? undefined} />}
      label={label()}
      accessibilityLabel={`Thread ${label()}`}
      tooltip={label()}
      onPress={() => {
        const s = shell();
        if (s?.relations?.lineage?.sideChat) {
          const parentId = s.relations.lineage.parentThreadId;
          if (parentId && openThread()?.id !== parentId) openThreadById(parentId);
          openSideChatAction(props.data().threadId);
          return;
        }
        openThreadById(props.data().threadId);
      }}
    />
  ) : (
    <Text class="leading-none text-muted-foreground" style={{ verticalAlign: "middle" }} tooltip={unknownThreadLinkLabel(props.data().environmentId, null)} accessibilityLabel={props.data().label ?? unknownThreadLinkLabel(props.data().environmentId, null)}>
      {props.data().label ?? unknownThreadLinkLabel(props.data().environmentId, null)}
    </Text>
  );
}

// ---- skills ----

/** SkillChipPopover: the skill's name and description, and View instructions when its file is known. */
export function SkillChip(props: { data: () => SkillChipData; maxLabelWidth?: () => number }) {
  const open = signal(false);
  useOverlayOpen(open, "skill chip popover");
  const skill = (): InlineSkill => props.data().skill;
  const label = () => skillDisplayName(skill());
  const description = () => skill().description?.trim() || null;
  const viewInstructions = () => {
    const path = skill().path;
    if (!path) return;
    open.set(false);
    const workspace = currentWorkspace()?.cwd ?? null;
    const relative = workspace && path.startsWith(`${workspace.replace(/\/+$/, "")}/`) ? path.slice(workspace.replace(/\/+$/, "").length + 1) : null;
    void openFilePath({ filePath: path, workspaceRelativePath: relative, line: undefined });
  };
  return (
    <View style={{ verticalAlign: "middle" }}>
      <Popover
        onOpenChange={trackOpenChange(open)}
        placement="top"
        popupClass="w-72 gap-3 rounded-lg border border-border bg-popover-84 p-3"
        trigger={
          <View class="flex-row items-center gap-[3px] rounded-sm" accessibilityLabel={`Skill ${label()}. Show details`} role="button" tooltip={`Skill ${label()}`}>
            <TimelineIcon name="package" size={12} tint={chipColor("skill") ?? undefined} />
            <Text class="truncate font-medium leading-none" style={{ maxWidth: props.maxLabelWidth?.() ?? 288, color: chipColor("skill") ?? undefined }}>{label()}</Text>
          </View>
        }
      >
        <View class="gap-3">
          <Text class="text-sm font-medium text-popover-foreground">{label()}</Text>
          <Text class="text-sm text-popover-foreground">{description() ?? "No description is available for this skill."}</Text>
          {skill().path ? (
            <View class="h-8 self-start items-center justify-center rounded-lg border border-input px-3 hover:bg-accent-50 active:scale-[0.97] transition-transform duration-150 ease-in-out" role="button" accessibilityLabel="View instructions" onPress={viewInstructions}>
              <Text class="text-sm font-medium text-foreground">View instructions</Text>
            </View>
          ) : null}
        </View>
      </Popover>
    </View>
  );
}

// ---- models ----

/** ModelMentionChip: the model's name with its provider's mark; the popover names the model, its provider and the source text. */
export function ModelChip(props: { data: () => ModelChipData; maxLabelWidth?: () => number }) {
  const open = signal(false);
  useOverlayOpen(open, "model chip popover");
  const presentation = () => props.data().presentation;
  const color = () => chipColor("model") ?? undefined;
  return (
    <View style={{ verticalAlign: "middle" }}>
      <Popover
        onOpenChange={trackOpenChange(open)}
        placement="top"
        popupClass="w-64 gap-1 rounded-lg border border-border bg-popover-84 p-3"
        trigger={
          <View class="flex-row items-center gap-[3px] rounded-sm" accessibilityLabel={`Model ${presentation().label}. Show details`} role="button" tooltip={`Model ${presentation().label}`}>
            <ProviderIconView driver={presentation().driver} instanceId={presentation().instanceId} name={presentation().providerDisplayName} accentColor={presentation().accentColor} size={14} />
            <Text class="truncate font-medium leading-none" style={{ maxWidth: props.maxLabelWidth?.() ?? 288, color: color() }}>{presentation().label}</Text>
          </View>
        }
      >
        <View class="gap-1" selectable>
          <Text class="text-sm font-medium text-popover-foreground">{presentation().label}</Text>
          <Text class="text-sm text-muted-foreground">{presentation().providerLabel}</Text>
          <Text class="font-mono text-xs text-muted-foreground">{props.data().source}</Text>
        </View>
      </Popover>
    </View>
  );
}

// ---- citations ----

/** AssistantCitationChip (message variant): the quote in a popover, with Go to source. */
export function CitationChip(props: { data: () => CitationChipData; reply?: boolean; agentTitles?: readonly string[]; maxLabelWidth?: () => number }) {
  const open = signal(false);
  useOverlayOpen(open, "citation chip popover");
  const citation = (): AssistantCitation => props.data().citation;
  const label = () => assistantCitationLabel(citation());
  const goToSource = () => {
    open.set(false);
    goToCitationSource(citation());
  };
  return (
    <View style={{ verticalAlign: "middle" }}>
      <Popover
        onOpenChange={trackOpenChange(open)}
        placement="top"
        popupClass="w-80 rounded-lg border border-border bg-popover-84 p-3"
        trigger={
          <View class="flex-row items-center gap-[3px] rounded-sm" accessibilityLabel={`${props.reply ? "Reply to response" : "Quoted assistant text"}: ${label()}. Show details`} role="button" tooltip={serializeAssistantCitation(citation()).length > 0 ? label() : undefined}>
            <TimelineIcon name="quote" size={12} tint={chipColor("citation") ?? undefined} />
            <Text class="truncate font-medium leading-none" style={{ maxWidth: props.maxLabelWidth?.() ?? 288, color: chipColor("citation") ?? undefined }}>{label()}</Text>
          </View>
        }
      >
        <View class="items-start gap-3" selectable>
          {props.agentTitles?.length ? <Text class="text-sm text-popover-foreground">{props.agentTitles.join(", ")}</Text> : null}
          <FadeScroll surface="popover-84" class="max-h-64 self-stretch"><View class="border-l-2 border-border pl-3"><Text class="text-sm text-muted-foreground">{citation().text}</Text></View></FadeScroll>
          {citation().comment ? <Text class="text-sm text-popover-foreground">{citation().comment}</Text> : null}
          <View class="h-8 flex-row items-center gap-1.5 rounded-lg border border-input px-3 hover:bg-accent-50 active:scale-[0.97] transition-transform duration-150 ease-in-out" role="button" accessibilityLabel="Go to source" onPress={goToSource}>
            <TimelineIcon name="arrow-up-right" size={14} />
            <Text class="text-sm font-medium text-foreground">Go to source</Text>
          </View>
        </View>
      </Popover>
    </View>
  );
}

// ---- web links ----

const failedFaviconHosts = new Set<string>();

/** The hosts whose /favicon.ico would be a request into a private network: no favicon for these. */
export function isPublicFaviconHost(host: string): boolean {
  const lower = host.toLowerCase();
  if (lower === "localhost" || lower.endsWith(".localhost") || lower.endsWith(".local") || lower.endsWith(".internal") || !lower.includes(".")) return false;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(lower)) return false;
  return !lower.includes(":");
}

/** A favicon for a page: GitHub's themed mark, else the host's own /favicon.ico. */
export function faviconUrlForHost(host: string, dark: boolean): string | null {
  const lower = host.toLowerCase();
  if (lower === "github.com") return dark ? "https://github.githubassets.com/favicons/favicon-dark.svg" : "https://github.githubassets.com/favicons/favicon.svg";
  return isPublicFaviconHost(lower) ? `https://${lower}/favicon.ico` : null;
}

/** MarkdownExternalLink sourceControlHostIcon: a source-control host with a public domain shows its brand mark (findByPublicDomain). */
const SOURCE_CONTROL_PUBLIC_HOSTS: readonly (readonly [string, string])[] = [["gitlab.com", "host-gitlab"], ["bitbucket.org", "host-bitbucket"], ["codeberg.org", "host-forgejo"], ["git.cafe", "host-gitcafe"]];
export function sourceControlHostIconName(host: string): string | null {
  const lower = host.toLowerCase();
  return SOURCE_CONTROL_PUBLIC_HOSTS.find(([domain]) => lower === domain || lower.endsWith(`.${domain}`))?.[1] ?? null;
}

function Favicon(props: { host: string }) {
  const brand = sourceControlHostIconName(props.host);
  if (brand) return <HIcon name={brand} size={14} />;
  const failed = signal(false);
  const url = () => (failed() || failedFaviconHosts.has(props.host) ? null : faviconUrlForHost(props.host, colorScheme() === "dark"));
  return url()
    ? <Image src={url()!} style={{ width: 14, height: 14, borderRadius: 2 }} onError={() => { failedFaviconHosts.add(props.host); failed.set(true); }} />
    : <Image src={globeIcon} style={{ width: 14, height: 14 }} />;
}

/**
 * ChatMarkdown's threadLinkAction: a pull request URL already linked to the thread offers Unlink, one that parses
 * offers Link, anything else (or no operate scope, or no server config yet) neither.
 */
export function threadPullRequestLinkAction(url: string, input: { threadId: string | null; canOperate: boolean; supported: boolean; linked: readonly { host: string; repository: string; number: number }[] }): "link-to-thread" | "unlink-from-thread" | undefined {
  if (!input.canOperate || !input.supported || input.threadId === null) return undefined;
  const parsed = parsePullRequestUrl(url);
  if (parsed === null) return undefined;
  const key = threadPullRequestKey(parsed);
  const isLinked = input.linked.some((entry) => { const other = threadPullRequestKey(entry); return other.host === key.host && other.repository === key.repository && other.number === key.number; });
  return isLinked ? "unlink-from-thread" : "link-to-thread";
}

/** updateThreadPullRequestLink (usePullRequestLinking.changeLink): thread.pull-request.link (manual) or .unlink. */
export async function updateThreadPullRequestLink(threadId: string, url: string, linked: boolean): Promise<void> {
  const parsed = parsePullRequestUrl(url);
  if (parsed === null) throw new Error("The pull request is not available in this environment.");
  await requestBackend("orchestration.dispatchCommand", { ...threadLinkCommand(threadId, { ...parsed, url }, linked), commandId: `command:${crypto.randomUUID()}` });
}

function openThreadLinkAction(url: string): "link-to-thread" | "unlink-from-thread" | undefined {
  const thread = openThread();
  return threadPullRequestLinkAction(url, { threadId: thread?.id ?? null, canOperate: scopeAllows(ORCHESTRATION_OPERATE_SCOPE), supported: pullRequestsSupported(), linked: thread?.relations?.pullRequests ?? [] });
}

/** The menu of a web link (externalLinkContextMenu.ts): [Link to thread | Unlink from thread], Open in integrated browser, Open in system browser, Copy Link. */
export function externalLinkMenuItems(url: string, handlers: { openExternal: (url: string) => void; openInApp: ((url: string) => void) | null; threadLink?: { action: "link-to-thread" | "unlink-from-thread"; run: (linked: boolean) => Promise<void> } }): NativeMenuItem[] {
  const threadLink = handlers.threadLink;
  return [
    ...(threadLink ? [{ label: threadLink.action === "link-to-thread" ? "Link to thread" : "Unlink from thread", onSelect: () => {
      const linked = threadLink.action === "link-to-thread";
      void threadLink.run(linked).catch((cause: unknown) => errorToast(linked ? "Unable to link pull request" : "Unable to unlink pull request", cause instanceof Error ? cause.message : "The request failed."));
    } }] : []),
    ...(handlers.openInApp ? [{ label: "Open in integrated browser", onSelect: () => handlers.openInApp?.(url) }] : []),
    { label: "Open in system browser", onSelect: () => handlers.openExternal(url) },
    { label: "Copy Link", onSelect: () => { void Clipboard.writeText(url).catch((cause: unknown) => errorToast("Failed to copy link", cause instanceof Error ? cause.message : "An error occurred.")); } },
  ];
}

/** A short web link: a favicon and its text in the link colour; a press opens it, a right press has the reference's link menu. */
export function WebLinkChip(props: { data: () => WebChipData; onOpen: (url: string) => void; openExternal: (url: string) => void; openInApp: ((url: string) => void) | null; maxLabelWidth?: () => number }) {
  return (
    <View
      class="flex-row items-center gap-[3px] rounded-sm"
      style={{ verticalAlign: "middle" }}
      accessibilityLabel={props.data().label}
      tooltip={props.data().url}
      role="link"
      onPress={() => props.onOpen(props.data().url)}
      onContextMenu={((event: { pagePosition: { x: number; y: number } }) => { const url = props.data().url; const action = openThreadLinkAction(url); const threadId = openThread()?.id ?? null; void popupOverOverlay(externalLinkMenuItems(url, { openExternal: props.openExternal, openInApp: props.openInApp, threadLink: action && threadId ? { action, run: (linked) => updateThreadPullRequestLink(threadId, url, linked) } : undefined }), event.pagePosition, "link menu"); }) as never}
    >
      <Favicon host={props.data().host} />
      <Text class={props.maxLabelWidth ? "truncate leading-none text-info-foreground" : "leading-none text-info-foreground"} style={props.maxLabelWidth ? { maxWidth: props.maxLabelWidth() } : undefined}>{props.data().label}</Text>
    </View>
  );
}
