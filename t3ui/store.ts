// The app's state. Signals stay private here; pages read and change them
// through these functions, so nothing outside owns a copy that can go stale.
import { noteUserInput } from "./components/userActivity";
import { readVersionedDrafts, withDraftVersion } from "./draftSchema";
import { ensureLegacyLocalStorageImported } from "./desktop/legacyLocalStorageImport";
import { handOffAttachmentPreview } from "./components/thread/attachmentPreviewHandoff";
import { resolveConfiguredEnvMode, resolveNewThreadEnvMode } from "./components/thread/newThreadEnvMode";
import { T3_PROJECT_FILE_NAME } from "./components/header/t3ProjectFile";
import { batch, computed, effect, lifecycle, platform, reduceMotion, signal, Storage, setColorScheme, untracked } from "nsh";
import { resolveEffectiveComposerModel } from "./components/composer/modelFixup";
import { preservedOpenCodeOptions } from "./components/composer/composerProviderState";
import { toggleWithLayout } from "./components/motion/Motion";
import { panelMotionActive } from "./components/motion/motionTokens";
import { forgetSessionBearer, loadSessionBearer, saveSessionBearer } from "./backend/sessionCredential";
import { observeServerConfigEvent, serverSettings } from "./pages/settings/settingsState";
import { clientDefaults, defaultOfSetting, scopeOfSetting, settingOverrides, validSavedValues } from "./pages/settings/settingsDefaults";
import { emptyProviderState, foldProviderThreadItem, observeThreadItem, providerState, providerTurnEnded, readActiveRun, resetThreadProviderState, restoreThreadProviderState, type ProviderState } from "./components/composer/threadProviderState";
import { activityFromTurnItem, type ActivityFields } from "./components/thread/timeline/ingestActivity";
import { overlaySubagent } from "./components/thread/timeline/subagents";
import { activeRun, createStableMessageList, deriveWorking, itemTextOmitted, mergeItemMessage, mergeTranscriptItem, messageFromTurnItem, runlessSubagentWork } from "./components/thread/timeline/ingest";
import { deriveThreadTitleSeed, sendTitleFallbackLabels } from "./components/composer/threadTitleSeed";
import { ATTACHMENT_UPLOAD_COULD_NOT_START, ATTACHMENT_UPLOAD_FAILED, attachmentUploadRejected, attachmentsToReleaseOnUploadCapabilityLoss, fileAttachmentTooLargeMessage } from "./components/composer/attachmentIntake";
import { nextTurnSettingsCommands } from "./components/composer/nextTurnSettings";
import { appendAttachmentReference, attachmentContextId, attachmentContextRecords, removeAttachmentReference, stripInlineContextReferences, attachedExtraContexts, attachedPullRequests, clearSendContext, sendExtrasFor } from "./components/composer/contextChips";
import { projectPendingUserInputAnswer } from "./components/thread/userInputAnswerLinks";
import { sendWithSteerFallback } from "./components/composer/runState";
import { showToast } from "./components/toast/toastState";
import { redirectPendingApprovals } from "./components/approvals/approvalLogic";
import { BackendClient, record, RequestFailure } from "./backend/client";
import { createThreadWireDecoder, forgetDeferredWork } from "./backend/threadWire";
import {
  countUnloadedOlderSettled, environmentConfigs, hasConnectedRemoteOlderSettled, loadRemoteOlderSettledPages, managedEnvironment,
  OLDER_SETTLED_PAGE_SIZE, olderSettledCountRowKeyFor, parseScopedKey, probeEnvironments, readOlderSettledCut,
  remoteOlderSettledProjectCount, remoteOlderSettledStatuses, remoteShellThread, remoteUnloadedOlderSettledCount,
  requestEnvironment, resetFailedRemoteOlderSettled, routePayload, scopeResult, subscribeEnvironment, withRemoteShells,
  type OlderSettledCut, type OlderSettledStatus,
} from "./environments/connectionManager";
export type { OlderSettledCut } from "./environments/connectionManager";
import { mergeArchiveSnapshot, recordArchiveChange, type ArchiveChanges } from "./environments/archiveSnapshot";
import { clearFamilyRemovals, recordFamilyShellEvent } from "./environments/familyRemovals";
import { fetchShellSnapshotWith, isSerialConfigMethod, ReconnectLadder, runInConfigLane, runShellStream } from "./environments/environmentSession";
import { requestWithRpcPolicy } from "./backend/rpcConcurrency";
import { recordFetchedWorkspaceSnapshot, withFetchedWorkspaceSnapshots, type FetchedWorkspaceSnapshot } from "./environments/fetchedWorkspaceSnapshots";
import { trackRpcPromise } from "./components/coordinators/rpcLatency";
import { recordPromptSent } from "./components/coordinators/githubStarPrompt";
import { exchangePairingToken, issueSocketUrl, waitForAuthenticatedSession } from "./backend/auth";
import { consumeLocalBootstrap } from "./backend/bootstrap";
import { CLIENT_APP_VERSION } from "./components/coordinators/connection.logic";
import { clearStartupRecovery, lastStartedVersion, presentStartupRecovery, recordStartedVersion, resolveStartupRecoveryOffer, startupRecoveryOffer } from "./desktop/startupRecovery";
import { savedEnvironments, savedEnvironmentsLoaded, upsertBootstrapSavedEnvironment } from "./pages/settings/environments/savedEnvironments";
import { importableProviderInstances, providerToggleMutation } from "./backend/providers";
import { ProviderSetupClient } from "./backend/providerSetup";
import type { ProviderAuthResponse, ProviderAuthStartOptions, ProviderAuthState, ProviderInstallState } from "./backend/providerSetup";
export { isSafeProviderAuthUrl } from "./backend/providerSetup";
export type { ProviderAuthInteraction, ProviderAuthMethod, ProviderAuthResponse, ProviderAuthStartOptions, ProviderAuthState, ProviderInstallState } from "./backend/providerSetup";
import { showAddProject } from "./components/SidebarAddProjectState";
import { threadMetaFromShell } from "./components/sidebar/threadMeta";
import { threadRelationsFromShell, type ThreadRelations } from "./components/header/threadRelations";
import { threadBannerFromShell, type ThreadBannerShell } from "./components/banners/threadBannerShell";
import { readChoice, resolveNewThreadModelSelection, type FallbackResolution, type ModelChoice } from "./components/banners/fallbackModel";
import { emptyBannerThreadState, foldBannerThreadItem, observeBannerThreadItem, resetBannerThreadState, restoreBannerThreadState, threadSessionState, type ThreadSessionState } from "./components/banners/threadSessionState";
import { readProjectScripts, type ProjectScript } from "./components/header/projectScripts";
import type { ThreadSidebarMeta } from "./components/sidebar/threadMeta";
import { sortSidebarProjects } from "./components/SidebarUtils";
import { parseUsagePagePreferences, serializeUsagePagePreferences, USAGE_PAGE_PREFERENCES_KEY } from "./components/usage/usagePagePreferences";
import { latestThreadOf } from "./components/sidebar/threadSort";
import { parseWorkspaceRefs } from "./components/thread/workspaceRefs";
import { isInteractionMode, isRuntimeMode, RUNTIME_MODES, validWorkspaceStrategy } from "./backend/launch";
import type { RuntimeMode, InteractionMode, WorkspaceStrategy } from "./backend/launch";
import { attachmentFileFromPath, attachmentMimeType, attachmentUploadUrl, progressUploadBody, videoMimeType, IMAGE_TYPES, MAX_ATTACHMENT_COUNT, MAX_FILE_BYTES, MAX_IMAGE_BYTES, MAX_TOTAL_IMAGE_BYTES } from "./backend/attachments";
import type { AttachmentCapabilities, DraftAttachment } from "./backend/attachments";
import { readFile, readdir, stat } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
export type { RuntimeMode, InteractionMode, WorkspaceStrategy } from "./backend/launch";
export type { AttachmentCapabilities, DraftAttachment } from "./backend/attachments";
import { SETTINGS_NAV, SETTINGS_SUBPAGES } from "./settingsNav";
import { SETTINGS_PANELS } from "./settingsPanels";
import { NATIVE_SEARCH_PLATFORM, SETTINGS_SECTION_LABELS, searchSettings } from "./pages/settings/settingsSearch";
import { availableSettingsSearchItems } from "./pages/settings/settingsSearchAvailability";

export type ThreadStatus = "running" | "awaiting" | "idle" | "stopped";

export interface Thread {
  id: string;
  projectId: string;
  /** Set for a thread of a saved (remote) environment; its id and projectId are then scoped "<environmentId>:<id>". */
  environmentId?: string;
  title: string;
  status: ThreadStatus;
  pinned: boolean;
  updatedAt: number;
  createdAt?: number;
  latestUserMessageAt?: number;
  path?: string;
  /** The thread shell's branch (OrchestrationV2ThreadShell.branch), when it has one. */
  branch?: string;
  /** The shell's persisted linkedPullRequest (ThreadLinkedPullRequest), which useThreadLinkedPullRequest relinks. */
  linkedPullRequest?: { projectId: string; repository: string; number: number; url: string };
  error?: string;
  /** Shell fields the sidebar reads: pending request kind, unread watermark, snooze. */
  meta?: ThreadSidebarMeta;
  /** Parent thread, link origin and guest share, for the thread header. */
  relations?: ThreadRelations;
  /** The shell fields the chat banners read (failure class and code, usage-limit recovery, goal, background work, stop). */
  banner?: ThreadBannerShell;
}

export interface Project {
  id: string;
  name: string;
  /** Set for a project of a saved (remote) environment (scoped id). */
  environmentId?: string;
  threads: Thread[];
  path?: string;
  createdAt?: number;
  updatedAt?: number;
  pinned?: boolean;
  /** The project's scripts, run from the thread details card. */
  scripts?: ProjectScript[];
  /** The icon override and favicon path from the shell snapshot, as the server sent them. */
  projectIcon?: unknown;
  faviconPath?: string;
  /** The legacy per-project defaults of the shell snapshot (`defaultModelSelection`, `defaultThreadEnvMode`, `autoPull`), which settings resolve until the server folds them into overrides. */
  legacyDefaults?: { defaultModelSelection?: unknown; defaultThreadEnvMode?: unknown; autoPull?: boolean };
  /** The repository the folder belongs to, as the shell snapshot sent it (the sidebar groups checkouts of one repository by it). */
  repositoryIdentity?: unknown;
}

export interface Message {
  id: string;
  itemId?: string;
  delegatedCompletionTaskIds?: string[];
  role: "user" | "assistant";
  body: string;
  order?: number;
  ordinal?: number;
  streaming?: boolean;
  attachments?: { id: string; name: string; mimeType: string; sizeBytes: number; type: string; /** `source._tag` ("pasted-text" for a long paste folded into a file). */ source?: string }[];
  /** The server's structured composer context for a user message (records for its chips). */
  context?: unknown;
  /** The turn item's status (`completed`, `running`, `failed`, ...): the reference's chip shows any other than completed. */
  status?: string;
  /** When the turn item last changed, epoch milliseconds: the time under an assistant message. */
  updatedAt?: number;
  /** An optimistic send: shown before the server echoes it, dropped once the server's copy (same id) arrives. */
  pending?: boolean;
  /** The user message's turn-item fields the row's variants read (OrchestrationV2 user_message). */
  inputIntent?: string;
  createdBy?: string;
  creationSource?: string;
  /** OrchestrationV2 user_message idleCompaction: why T3 Code sent this `/compact` itself. */
  idleCompaction?: string;
  scheduledTaskId?: string;
  senderThreadId?: string;
  /** `/clear` or an automation started a new provider session at this message. */
  freshContext?: boolean;
  /** A same-harness model or effort change recorded at this message (`{ from, to }` model selections). */
  modelSwitch?: { from: unknown; to: unknown };
  runId?: string;
}

const projects = signal<Project[]>([]);

/** Threads that have no project. The web lists these in the active list, not a folder. */
const loose = signal<Thread[]>([]);

/**
 * Unpromoted drafts. T3's SidebarDraftBlock lists one only after it has user
 * content, and never as an ordinary row inside the project folder.
 */
const unpromoted = signal<Thread[]>([]);

/** Collapsed project ids; a project not listed here is expanded. */
const collapsed = signal<string[]>([]);

/** The sidebar column. `sidebar.toggle` is mod+b in packages/shared keybindings. */
const sidebarVisible = signal(true);
export const sidebarOpen = () => sidebarVisible();
export function toggleSidebar() {
  // ui/sidebar.tsx:364 animates the column's width over the panelAnimationDurationMs setting (R3 default 225, 0 = at once), ease-out, not with
  // reduced motion; the port's layout change runs through LayoutAnimation around this one user toggle.
  const ms = Number(settingValue("panelAnimationDurationMs") ?? 225);
  if (panelMotionActive(ms, reduceMotion())) toggleWithLayout(ms, () => sidebarVisible.update((open) => !open), "easeOut");
  else sidebarVisible.update((open) => !open);
  persistSidebarOpen();
}

/** ui/sidebar.tsx with storageKey "chat_thread_sidebar_open" (AppSidebarLayout.tsx): the open state is written on every toggle and read at start. */
export const SIDEBAR_OPEN_STORAGE_KEY = "chat_thread_sidebar_open";
function persistSidebarOpen() {
  void Storage.setItem(SIDEBAR_OPEN_STORAGE_KEY, JSON.stringify(sidebarVisible())).catch((error: unknown) => { console.error("[LOCALSTORAGE] Could not update stored value.", error); });
}
let sidebarOpenLoading: Promise<void> | null = null;
export function loadSidebarOpen(): Promise<void> {
  sidebarOpenLoading ??= (async () => {
    try {
      const raw = await Storage.getItem(SIDEBAR_OPEN_STORAGE_KEY);
      if (raw === "true" || raw === "false") sidebarVisible.set(raw === "true");
    } catch (error) {
      console.error("Could not restore persisted sidebar state.", error);
    }
  })();
  return sidebarOpenLoading;
}
void loadSidebarOpen();

/** Sidebar thread search (`placeholder="Search"`, aria-label "Search threads"). */
const threadSearch = signal("");
export const sidebarThreadQuery = () => threadSearch();
export function setSidebarThreadQuery(text: string) {
  threadSearch.set(text);
}

/** True when the sidebar query is empty or the title contains it. */
export function threadMatchesQuery(title: string) {
  const q = threadSearch().trim().toLowerCase();
  return q.length === 0 || title.toLowerCase().includes(q);
}

export const sidebarProjects = () => {
  const q = threadSearch().trim().toLowerCase();
  const all = projects();
  if (!q) return all;
  return all.filter(
    (project) =>
      project.name.toLowerCase().includes(q) ||
      project.threads.some((thread) => thread.title.toLowerCase().includes(q)),
  );
};

export function visibleProjectThreads(project: Project): Thread[] {
  const q = threadSearch().trim().toLowerCase();
  if (!q) return project.threads;
  if (project.name.toLowerCase().includes(q)) return project.threads;
  return project.threads.filter((thread) => thread.title.toLowerCase().includes(q));
}

/** The open thread, or null when the index is showing. */
const openThreadId = signal<string | null>(null);
/** The thread a store action applies to: the open thread, or the thread a scoped view (a side chat) runs it for. */
let scopeOverride: string | null = null;
const scopeId = () => scopeOverride ?? openThreadId();
/** Runs a store action (draft, send, attachments, stop, responses) for `id` instead of the open thread. */
export function withThreadScope<T>(id: string | null, run: () => T): T {
  const previous = scopeOverride;
  scopeOverride = id;
  try { return run(); } finally { scopeOverride = previous; }
}
/** The thread a scoped action is running for, or null in the open thread's scope. */
export const threadScopeOverride = () => scopeOverride;

/** Every project, in sidebar order. */
export const allProjects = () => projects();

/** A draft has user content once its composer text, attachments, attached contexts or its transcript is non-empty (composerDraftHasUserContent). */
function draftHasUserContent(id: string) {
  const text = (draftsByThread()[id] ?? "").trim();
  return text.length > 0 || (attachmentDrafts()[id]?.length ?? 0) > 0 || (transcripts()[id]?.length ?? 0) > 0 || (pendingEchoes()[id]?.length ?? 0) > 0 || attachedExtraContexts(id).length > 0 || attachedPullRequests(id).length > 0;
}

/** Drafts that belong in the sidebar's separate block. Empty ones stay hidden. */
export const sidebarDrafts = () => unpromoted().filter((thread) => draftHasUserContent(thread.id));

/** Every promoted thread, plus drafts that already have user content, newest first. */
export const allThreads = () =>
  [...projects().flatMap((p) => p.threads), ...loose(), ...sidebarDrafts()].sort(
    (a, b) => b.updatedAt - a.updatedAt,
  );

/** Threads with no project, excluding ones already shown in the pinned section. */
export const unpinnedLooseThreads = () => loose().filter((thread) => !thread.pinned);

/** Pinned threads, which the sidebar lists above the folders. */
export const pinnedThreads = () => allThreads().filter((t) => t.pinned);

/** One thread by id, or undefined when it is gone. */
export const threadById = (id: string) => threadIndex().get(id);
/** id -> thread over projects, loose and drafts (first one wins, as a find over that order did); rebuilt once per change, not per lookup. */
const threadIndex = computed(() => {
  const index = new Map<string, Thread>();
  for (const thread of [...projects().flatMap((p) => p.threads), ...loose(), ...unpromoted()]) if (!index.has(thread.id)) index.set(thread.id, thread);
  return index;
});

/** threadRoutes.ts resolveThreadRouteRenderState for the selected thread: "loading" while a selected thread waits for the
 * first shell snapshot (the view stays blank, as ThreadRouteView renders nothing), "ready" once it is shown, null when none
 * is selected or it is gone (the no-thread state). */
export function openThreadRouteState(): "loading" | "ready" | null {
  const id = openThreadId();
  if (!id) return null;
  if (threadById(id)) return "ready";
  return shellSnapshotReceived() ? null : "loading";
}

/** The thread currently open, if any. */
export const openThread = () => {
  const id = openThreadId();
  return id ? threadById(id) : undefined;
};

/** Whether a project's folder is collapsed. */
export const isCollapsed = (projectId: string) => collapsed().includes(projectId);

/** Collapses or expands one project's folder. */
export function toggleProject(projectId: string) {
  collapsed.update((list) =>
    list.includes(projectId) ? list.filter((id) => id !== projectId) : [...list, projectId],
  );
}

/** Leaves a utility page when a thread is chosen. Assigned once that signal exists. */
let onThreadShown = () => {};

/** Opens a thread in the chat pane. */
export function openThreadById(id: string) {
  // One flush for the id and its detail together: a separate flush between them would show the new thread's id
  // against the previous thread's still-live turnItems/activity for a frame (store.ts's eager computeds).
  batch(() => {
    openThreadId.set(id);
    onThreadShown();
    subscribeOpenThread();
  });
  scheduleDraftSave();
}

/** How many threads are working right now. */
export const runningCount = () =>
  allThreads().filter((t) => t.status === "running" || t.status === "awaiting").length;

/** Transcripts keyed by thread id; a thread with no entry is empty. */
const transcripts = signal<Record<string, Message[]>>({});

/** The open thread's transcript. A thread with no entry is empty. */
const orderedMessageCache = new WeakMap<Message, { ordinal: number; value: Message }>();
const stableOpenMessages = createStableMessageList();
const stableSideMessages = new Map<string, ReturnType<typeof createStableMessageList>>();
function messageWithOrdinal(message: Message, item: Record<string, unknown> | undefined): Message {
  if (typeof item?.ordinal !== "number" || message.ordinal === item.ordinal) return message;
  let cached = orderedMessageCache.get(message);
  if (!cached || cached.ordinal !== item.ordinal) {
    cached = { ordinal: item.ordinal, value: { ...message, ordinal: item.ordinal } };
    orderedMessageCache.set(message, cached);
  }
  return cached.value;
}
export const threadMessages = computed<Message[]>(() => {
  const id = openThreadId();
  if (!id) return stableOpenMessages(null, []);
  const items = messageItemIndex(turnItems());
  return stableOpenMessages(id, withPendingEchoes(id, (transcripts()[id] ?? []).map((message) => {
    return messageWithOrdinal(message, items.get(message.id));
  })));
});

/**
 * Optimistic sends (useComposerSend's optimistic user messages): a message shown the moment it is sent, before the server
 * has echoed it. It drops out of the transcript as soon as the server's copy (same message id) is in it.
 */
const pendingEchoes = signal<Record<string, Message[]>>({});
function withPendingEchoes(threadId: string, list: Message[]): Message[] {
  const echoes = pendingEchoes()[threadId];
  if (!echoes || echoes.length === 0) return list;
  const known = new Set(list.map((message) => message.id));
  // A send the server queued behind a running turn shows in the composer's queue, not here.
  const queued = new Set(threadRunsFor(threadId).filter((run) => run.status === "queued" && typeof run.userMessageId === "string").map((run) => run.userMessageId));
  const extra = echoes.filter((message) => !known.has(message.id) && !queued.has(message.id));
  return extra.length === 0 ? list : [...list, ...extra];
}
function dropPendingEcho(threadId: string, messageId: string) {
  pendingEchoes.update((all) => {
    const list = all[threadId];
    if (!list || !list.some((message) => message.id === messageId)) return all;
    const rest = list.filter((message) => message.id !== messageId);
    if (rest.length > 0) return { ...all, [threadId]: rest };
    const { [threadId]: _dropped, ...others } = all;
    return others;
  });
}

/**
 * Optimistic queued sends (QueuedRunsControl's optimisticMessages with inputIntent "queued_turn"): a message queued behind a
 * running turn shows in the composer's queue as "Saving" until the server's queued run (or its message) arrives.
 */
export interface PendingQueuedSend { id: string; text: string; attachments: { id: string; name: string; mimeType: string; sizeBytes: number; type: string }[] }
const pendingQueuedSends = signal<Record<string, PendingQueuedSend[]>>({});
export function pendingQueuedSendsFor(threadId: string): PendingQueuedSend[] {
  const pending = pendingQueuedSends()[threadId];
  if (!pending || pending.length === 0) return [];
  // Run-only acknowledgements can resurrect pending rows after cancellation or startup: a message the thread holds is acknowledged.
  const acknowledged = new Set([...(transcripts()[threadId] ?? []).map((message) => message.id), ...threadRunsFor(threadId).flatMap((run) => typeof run.userMessageId === "string" ? [run.userMessageId] : [])]);
  return pending.filter((item) => !acknowledged.has(item.id));
}
function dropPendingQueuedSend(threadId: string, messageId: string) {
  pendingQueuedSends.update((all) => {
    const list = all[threadId];
    if (!list || !list.some((item) => item.id === messageId)) return all;
    const rest = list.filter((item) => item.id !== messageId);
    if (rest.length > 0) return { ...all, [threadId]: rest };
    const { [threadId]: _dropped, ...others } = all;
    return others;
  });
}

/**
 * The thread-level error slot (ChatView's localServerError / setThreadError): a send, rewind, fork or resume that failed.
 * The banner lane shows it ahead of the server's own `lastError`; the next send clears it.
 */
const threadErrors = signal<Record<string, string>>({});
export const threadLocalError = (threadId: string): string | null => threadErrors()[threadId] ?? null;
export function setThreadError(threadId: string, message: string | null) {
  threadErrors.update((all) => {
    if (message === null) {
      if (!(threadId in all)) return all;
      const { [threadId]: _cleared, ...rest } = all;
      return rest;
    }
    return all[threadId] === message ? all : { ...all, [threadId]: message };
  });
}
/** messageId -> its first user/assistant message turn item (what a find over the list returned), built in one pass. */
const messageItemIndexes = new WeakMap<Record<string, unknown>[], Map<unknown, Record<string, unknown>>>();
function messageItemIndex(items: Record<string, unknown>[]): Map<unknown, Record<string, unknown>> {
  const cached = messageItemIndexes.get(items);
  if (cached) return cached;
  const index = new Map<unknown, Record<string, unknown>>();
  for (const entry of items) if ((entry.type === "user_message" || entry.type === "assistant_message") && !index.has(entry.messageId)) index.set(entry.messageId, entry);
  messageItemIndexes.set(items, index);
  return index;
}

/** Composer text per thread. A new draft starts empty, so it stays out of the sidebar. */
const draftsByThread = signal<Record<string, string>>({});
interface InternalAttachment extends DraftAttachment { file?: File; uploadedId?: string; /** ChatImageAttachment.source: a SnapShot's window (SnapShotCoordinator deliverSnapShot). */ source?: unknown }
const attachmentDrafts = signal<Record<string, InternalAttachment[]>>({});
const reportedAttachmentCapabilities = signal<AttachmentCapabilities>({ supported: false, files: false, maxCount: MAX_ATTACHMENT_COUNT,
  maxImageBytes: MAX_IMAGE_BYTES, maxFileBytes: MAX_FILE_BYTES, maxTotalImageBytes: MAX_TOTAL_IMAGE_BYTES });
const attachmentControllers = new Map<string, AbortController>();
const attachmentOperations = new Map<string, object>();

export const attachmentCapabilities = () => reportedAttachmentCapabilities();
/** attachmentUploadsCapabilityKnown: the environment has reported its capabilities since this connection began. */
const attachmentCapabilitiesKnownSignal = signal(false);
export const attachmentCapabilitiesKnown = () => attachmentCapabilitiesKnownSignal();
/** chatViewSend.ts prepareTurnAttachments: a server that reports no `attachmentUploads` takes images inline as data URLs,
 * stored at send time by `assets.persistChatAttachments` (operations/commands.ts persistAttachments). */
export const attachmentsUseDataUrls = () => backendStatus() === "connected" && attachmentCapabilitiesKnown() && !attachmentCapabilities().supported;
export const isSending = () => { const id = openThreadId(); return id ? sendingThreadIds().includes(id) : false; };
export const draftAttachments = (): DraftAttachment[] => {
  const id = openThreadId();
  return id ? (attachmentDrafts()[id] ?? []).map(({ file: _file, uploadedId: _uploadedId, ...item }) => item) : [];
};
/** The bytes behind a staged attachment, for its thumbnail; absent once a draft is restored from disk. */
export const draftAttachmentFile = (attachmentId: string): File | undefined => {
  const id = openThreadId();
  return id ? attachmentDrafts()[id]?.find((item) => item.id === attachmentId)?.file : undefined;
};
/** useComposerContextImport: the attachment behind an image or file chip pasted from another composer's prompt (found by its context id
 * in the other threads' drafts), with its bytes when this process still holds them; `onlyOutside` skips the thread the paste is in. */
export function findDraftAttachmentByContextId(contextId: string, onlyOutside: string): { name: string; mimeType: string; sizeBytes: number; file?: File; uploadedId?: string } | undefined {
  for (const [threadId, items] of Object.entries(attachmentDrafts())) {
    if (threadId === onlyOutside) continue;
    const found = items.find((item) => attachmentContextId(item.kind, item.id) === contextId);
    if (found && (found.file || found.uploadedId)) return { name: found.name, mimeType: found.mimeType, sizeBytes: found.sizeBytes, file: found.file, uploadedId: found.uploadedId };
  }
  return undefined;
}
/** Whether a thread's own draft holds the attachment a chip's context id names. */
export function draftHasAttachmentContext(threadId: string, contextId: string): boolean {
  return (attachmentDrafts()[threadId] ?? []).some((item) => attachmentContextId(item.kind, item.id) === contextId);
}
interface ThreadOptions { runtime: RuntimeMode; interaction: InteractionMode; workspace: WorkspaceStrategy }
const optionsByThread = signal<Record<string, ThreadOptions>>({});
interface DiscardedDraft {
  thread: Thread;
  index: number;
  text: string;
  attachments: InternalAttachment[];
  options?: ThreadOptions;
  messages?: Message[];
  wasOpen: boolean;
  fallbackId: string | null;
}
const discardedDraftsByEnvironment = signal<Record<string, DiscardedDraft[]>>({});
const discardTimers = new Map<string, number>();
const pendingDiscardAttachmentDeletes = new Map<string, Set<string>>();
const discardCleanupTimers = new Map<string, number>();
const discardCleanupInFlight = new Set<string>();
const serverOptionsByThread = signal<Record<string, ThreadOptions>>({});
const supportedModesByProvider = signal<Record<string, RuntimeMode[]>>({});
const supportsPlanByProvider = signal<Record<string, boolean>>({});
const runtimeCeiling = signal<RuntimeMode | null>(null);

function defaultThreadOptions(): ThreadOptions {
  const configured = settingValue("defaultRuntimeMode");
  return { runtime: isRuntimeMode(configured) ? configured : "full-access", interaction: "default", workspace: { type: "root" } };
}

/** resolveProjectSettings for a new thread: the project's defaultRuntimeMode and defaultModelSelection over the environment's. */
function newThreadProjectDefaults(projectId: string | null): { runtime: RuntimeMode; model: { instanceId: string; model: string } | null } {
  const base = (serverSettings() ?? {}) as Record<string, unknown>;
  const project = projectId ? projects().find((item) => item.id === projectId) : undefined;
  const stored = projectId ? record(record(base.projectSettingsOverrides)?.[projectId]) : null;
  const legacy = base.projectSettingsFolded !== true ? project?.legacyDefaults : undefined;
  const runtime = stored?.defaultRuntimeMode ?? base.defaultRuntimeMode ?? settingValue("defaultRuntimeMode");
  const selection = record(stored?.defaultModelSelection ?? legacy?.defaultModelSelection ?? null);
  const instanceId = typeof selection?.instanceId === "string" ? selection.instanceId : typeof selection?.provider === "string" ? selection.provider : null;
  return {
    runtime: isRuntimeMode(runtime) ? runtime : defaultThreadOptions().runtime,
    model: instanceId && typeof selection?.model === "string" ? { instanceId, model: selection.model } : null,
  };
}

/** resolveNewThreadModelSelection for a new thread in the project: its default model (project, then environment) and,
 * when that provider is out of usage, the "Fallback model" setting with the exhausted window. */
export function newThreadFallback(projectId: string | null, now: number): { defaultSelection: ModelChoice | null; resolution: FallbackResolution } {
  const base = (serverSettings() ?? {}) as Record<string, unknown>;
  const defaultSelection = newThreadProjectDefaults(projectId).model ?? readChoice(base.defaultModelSelection);
  return { defaultSelection, resolution: resolveNewThreadModelSelection({
    defaultSelection, fallbackSelection: readChoice(base.fallbackModelSelection), providers: rawProviders(), now, settings: base, projectId,
  }) };
}

/**
 * resolveDefaultEnvMode + resolveNewDraftStartFromOrigin for a new draft: the project's defaultThreadEnvMode (override,
 * then legacy, then the environment's, else "local"). A worktree draft starts from the checkout's current local branch
 * (else its first ref), as the env-mode menu seeds it, with newWorktreesStartFromOrigin. Applied only while the draft
 * is still empty and still on its project folder. With no override and no environment setting, the repository's t3.json
 * decides (components/thread/newThreadEnvMode.ts); a project under the new-projects root starts local until its first thread.
 */
export async function applyNewThreadWorkspaceDefault(id: string, projectId: string | null, request: (method: string, payload: unknown) => Promise<unknown> = requestBackend): Promise<void> {
  if (!projectId) return;
  const base = (serverSettings() ?? {}) as Record<string, unknown>;
  const project = projects().find((item) => item.id === projectId);
  const stored = record(record(base.projectSettingsOverrides)?.[projectId]);
  const legacy = base.projectSettingsFolded !== true ? project?.legacyDefaults : undefined;
  if (!project?.path) return;
  const projectPath = project.path;
  const configured = await resolveConfiguredEnvMode({
    override: stored?.defaultThreadEnvMode ?? legacy?.defaultThreadEnvMode,
    environment: base.defaultThreadEnvMode,
    readFile: async () => {
      const result = record(await request("projects.readFile", { cwd: projectPath, relativePath: T3_PROJECT_FILE_NAME, allowMissing: true }));
      return !result || result.exists === false || result.truncated === true || typeof result.contents !== "string" ? null : result.contents;
    },
  });
  // The new-projects root is read only when it can change the answer.
  // readThreadShells + readUnloadedThreadCount: threads below the older-settled cut count too.
  const parsedProject = parseScopedKey(projectId);
  const olderProjectCount = parsedProject
    ? remoteOlderSettledProjectCount(parsedProject.environmentId, parsedProject.localId)
    : (olderSettledCut()?.counts.find((entry) => entry.projectId === projectId)?.count ?? 0);
  const projectHasThreads = project.threads.length > 0 || olderProjectCount > 0;
  let newProjectsRoot: string | null = null;
  if (configured.mode === "worktree" && configured.source === "environment" && !projectHasThreads) {
    try { const root = record(await request("server.getConfig", {}))?.newProjectsRoot; newProjectsRoot = typeof root === "string" && root.length > 0 ? root : null; } catch { newProjectsRoot = null; }
  }
  const mode = resolveNewThreadEnvMode({ ...configured, workspaceRoot: projectPath, newProjectsRoot, projectHasThreads });
  if (mode !== "worktree") return;
  let baseRef: string | null = null;
  try {
    const refs = parseWorkspaceRefs(await request("vcs.listRefs", { cwd: project.path, limit: 100, refKind: "all" }));
    baseRef = refs.isRepo ? (refs.refs.find((ref) => ref.current && !ref.isRemote)?.name ?? refs.refs[0]?.name ?? null) : null;
  } catch { return; }
  if (!baseRef || !unpromoted().some((thread) => thread.id === id) || draftHasUserContent(id)) return;
  const current = optionsByThread()[id];
  if (current && current.workspace.type !== "root") return;
  const fromOrigin = stored?.newWorktreesStartFromOrigin ?? base.newWorktreesStartFromOrigin;
  optionsByThread.update((all) => ({ ...all, [id]: { ...(all[id] ?? defaultThreadOptions()), workspace: { type: "worktree", baseRef: baseRef!, ...(fromOrigin === true ? { startFromOrigin: true } : {}) } } }));
  scheduleDraftSave();
}

function activeThreadOptions(): ThreadOptions {
  const id = openThreadId();
  if (!id) return defaultThreadOptions();
  return optionsByThread()[id] ?? serverOptionsByThread()[id] ?? defaultThreadOptions();
}

export const runtimeMode = () => activeThreadOptions().runtime;
export const interactionMode = () => activeThreadOptions().interaction;
/** A thread's own options (a side chat pane reads its child thread, not the open one). */
const optionsFor = (id: string): ThreadOptions => optionsByThread()[id] ?? serverOptionsByThread()[id] ?? defaultThreadOptions();
export const runtimeModeFor = (id: string) => optionsFor(id).runtime;
/** The runtime mode the server holds for a thread, or null before its shell arrived. */
export const serverRuntimeModeFor = (id: string): string | null => serverOptionsByThread()[id]?.runtime ?? null;
export const interactionModeFor = (id: string) => optionsFor(id).interaction;
export const workspaceStrategy = () => activeThreadOptions().workspace;
/** The modes the selected provider supports, the administrator's ceiling not applied: the permissions menu lists the
 * ones above it disabled with the reason (resolveRuntimeModeOptions). */
export function listedRuntimeModes(): RuntimeMode[] {
  const choice = selectedModel();
  const supported = choice ? supportedModesByProvider()[choice.provider] : undefined;
  return supported?.length ? RUNTIME_MODES.filter((item) => supported.includes(item)) : [...RUNTIME_MODES];
}
export function availableRuntimeModes(): RuntimeMode[] {
  const choice = selectedModel();
  const supported = choice ? supportedModesByProvider()[choice.provider] : undefined;
  const modes = supported?.length ? RUNTIME_MODES.filter((item) => supported.includes(item)) : RUNTIME_MODES;
  const ceiling = runtimeCeiling();
  return ceiling ? modes.filter((item) => RUNTIME_MODES.indexOf(item) <= RUNTIME_MODES.indexOf(ceiling)) : [...modes];
}
export const availableInteractionModes = (): InteractionMode[] => {
  const choice = selectedModel();
  return choice && supportsPlanByProvider()[choice.provider] ? ["default", "plan"] : ["default"];
};

export async function setRuntimeMode(next: RuntimeMode): Promise<void> {
  const id = scopeId();
  if (!id || !availableRuntimeModes().includes(next)) throw new Error("This provider does not support the selected runtime mode");
  if (isServerThread(id)) {
    const generation = connectionGeneration;
    await dispatch({ type: "thread.runtime-mode.set", threadId: id, runtimeMode: next });
    if (generation !== connectionGeneration) return;
    serverOptionsByThread.update((all) => ({ ...all, [id]: { ...(all[id] ?? defaultThreadOptions()), runtime: next } }));
  } else {
    optionsByThread.update((all) => ({ ...all, [id]: { ...(all[id] ?? defaultThreadOptions()), runtime: next } }));
    scheduleDraftSave();
  }
}

export async function setInteractionMode(next: InteractionMode): Promise<void> {
  const id = scopeId();
  if (!id || !availableInteractionModes().includes(next)) throw new Error("This provider does not support the selected interaction mode");
  if (isServerThread(id)) {
    const generation = connectionGeneration;
    await dispatch({ type: "thread.interaction-mode.set", threadId: id, interactionMode: next });
    if (generation !== connectionGeneration) return;
    serverOptionsByThread.update((all) => ({ ...all, [id]: { ...(all[id] ?? defaultThreadOptions()), interaction: next } }));
  } else {
    optionsByThread.update((all) => ({ ...all, [id]: { ...(all[id] ?? defaultThreadOptions()), interaction: next } }));
    scheduleDraftSave();
  }
}

export function setWorkspaceStrategy(next: WorkspaceStrategy): void {
  const id = openThreadId();
  if (!id || isServerThread(id)) throw new Error("Workspace can only be changed before the thread starts");
  const workspace = validWorkspaceStrategy(next);
  optionsByThread.update((all) => ({ ...all, [id]: { ...(all[id] ?? defaultThreadOptions()), workspace } }));
  scheduleDraftSave();
}

export function setDraftProject(projectId: string): void {
  const id = openThreadId();
  if (!id || !unpromoted().some((thread) => thread.id === id)) throw new Error("Only a new thread can change project");
  if (!projects().some((project) => project.id === projectId)) throw new Error("Project is no longer available");
  unpromoted.update((items) => items.map((thread) => thread.id === id ? { ...thread, projectId, updatedAt: Date.now() } : thread));
  optionsByThread.update((all) => ({ ...all, [id]: { ...(all[id] ?? defaultThreadOptions()), workspace: { type: "root" } } }));
  // DraftHeroHeadline selectProject: a draft without an explicit model pick takes the new project's default model.
  if (!draftModelByThread[id]) {
    const preferred = newThreadProjectDefaults(projectId).model;
    const match = preferred ? models().find((item) => item.provider === preferred.instanceId && item.model === preferred.model) : undefined;
    if (match) model.set(match);
  }
  scheduleDraftSave();
}

export const composerDraft = () => {
  const id = openThreadId();
  if (!id) return "";
  return draftsByThread()[id] ?? "";
};

export function setComposerDraft(text: string) {
  noteUserInput();
  const id = scopeId();
  if (!id) return;
  draftsByThread.update((all) => ({ ...all, [id]: text }));
  scheduleDraftSave();
}

/** useThreadHasUnsentDraft (composerDraftStore.ts): the thread's composer holds text or attachments not yet sent. */
export function threadHasUnsentDraft(id: string): boolean {
  return (draftsByThread()[id] ?? "").trim().length > 0 || (attachmentDrafts()[id]?.length ?? 0) > 0 || attachedExtraContexts(id).length > 0 || attachedPullRequests(id).length > 0;
}

export function draftSummary(id: string): { text: string; attachmentCount: number } {
  if (!unpromoted().some((thread) => thread.id === id)) return { text: "", attachmentCount: 0 };
  return { text: draftsByThread()[id] ?? "", attachmentCount: attachmentDrafts()[id]?.length ?? 0 };
}

export const canUndoDiscardDraft = () => (discardedDraftsByEnvironment()[connectionUrl()]?.length ?? 0) > 0;

async function flushDiscardedAttachments(endpoint: string): Promise<void> {
  if (discardCleanupInFlight.has(endpoint) || endpoint !== connectionUrl() || backendStatus() !== "connected") return;
  const pending = pendingDiscardAttachmentDeletes.get(endpoint);
  if (!pending?.size) return;
  const generation = connectionGeneration;
  discardCleanupInFlight.add(endpoint);
  try {
    for (const attachmentId of [...pending]) {
      if (generation !== connectionGeneration || endpoint !== connectionUrl() || backendStatus() !== "connected") return;
      try {
        await requestBackend("attachments.delete", { attachmentId });
        pending.delete(attachmentId);
      } catch {
        break;
      }
    }
  } finally {
    discardCleanupInFlight.delete(endpoint);
    if (!pending.size) {
      pendingDiscardAttachmentDeletes.delete(endpoint);
      clearTimeout(discardCleanupTimers.get(endpoint));
      discardCleanupTimers.delete(endpoint);
    }
    else if (endpoint === connectionUrl() && backendStatus() === "connected" && !discardCleanupTimers.has(endpoint)) {
      discardCleanupTimers.set(endpoint, setTimeout(() => {
        discardCleanupTimers.delete(endpoint);
        void flushDiscardedAttachments(endpoint);
      }, 30000));
    }
  }
}

function expireDiscardedDrafts(endpoint: string): void {
  discardTimers.delete(endpoint);
  const history = discardedDraftsByEnvironment()[endpoint] ?? [];
  if (!history.length) return;
  discardedDraftsByEnvironment.update((all) => ({ ...all, [endpoint]: [] }));
  const pending = pendingDiscardAttachmentDeletes.get(endpoint) ?? new Set<string>();
  for (const draft of history) for (const attachment of draft.attachments) {
    if (attachment.uploadedId) pending.add(attachment.uploadedId);
  }
  if (pending.size) {
    pendingDiscardAttachmentDeletes.set(endpoint, pending);
    void flushDiscardedAttachments(endpoint);
  }
}

/** Discard only an unsent local draft. Keep its contents available for undo. */
export async function discardDraft(id: string): Promise<void> {
  try {
    const index = unpromoted().findIndex((thread) => thread.id === id);
    if (index < 0 || isServerThread(id)) throw new Error("This draft is no longer available");
    if (sendingThreadIds().includes(id)) throw new Error("Wait for the draft to finish sending before discarding it");
    const thread = unpromoted()[index];
    const wasOpen = openThreadId() === id;
    const endpoint = connectionUrl();
    const attachments = (attachmentDrafts()[id] ?? []).map((item) => {
      attachmentOperations.delete(item.id);
      attachmentControllers.get(item.id)?.abort();
      attachmentControllers.delete(item.id);
      return item.status === "uploading"
        ? { ...item, status: "failed" as const, error: "Upload interrupted. Retry this attachment." }
        : item;
    });
    const snapshot: DiscardedDraft = { thread, index, text: draftsByThread()[id] ?? "", attachments,
      options: optionsByThread()[id], messages: transcripts()[id], wasOpen, fallbackId: null };
    unpromoted.update((items) => items.filter((item) => item.id !== id));
    draftsByThread.update((all) => { const { [id]: _removed, ...rest } = all; return rest; });
    attachmentDrafts.update((all) => { const { [id]: _removed, ...rest } = all; return rest; });
    optionsByThread.update((all) => { const { [id]: _removed, ...rest } = all; return rest; });
    transcripts.update((all) => { const { [id]: _removed, ...rest } = all; return rest; });
    if (wasOpen) {
      snapshot.fallbackId = allThreads()[0]?.id ?? null;
      openThreadId.set(snapshot.fallbackId);
      subscribeOpenThread();
    }
    discardedDraftsByEnvironment.update((all) => ({ ...all, [endpoint]: [...(all[endpoint] ?? []), snapshot] }));
    clearTimeout(discardTimers.get(endpoint));
    discardTimers.set(endpoint, setTimeout(() => expireDiscardedDrafts(endpoint), 5000));
    scheduleDraftSave();
  } catch (error) {
    reportError(error);
    throw error;
  }
}

/** Undo is scoped to the environment and never replaces existing draft content. */
export async function undoDiscardDraft(): Promise<void> {
  try {
    const endpoint = connectionUrl();
    const history = discardedDraftsByEnvironment()[endpoint] ?? [];
    const snapshot = history[history.length - 1];
    if (!snapshot) throw new Error("There is no discarded draft to restore");
    const id = snapshot.thread.id;
    if (threadById(id) || draftsByThread()[id] || (attachmentDrafts()[id]?.length ?? 0) > 0 || (transcripts()[id]?.length ?? 0) > 0) {
      throw new Error("The draft has new content or has become a server thread");
    }
    unpromoted.update((items) => {
      const restored = [...items];
      restored.splice(Math.min(snapshot.index, restored.length), 0, snapshot.thread);
      return restored;
    });
    draftsByThread.update((all) => ({ ...all, [id]: snapshot.text }));
    attachmentDrafts.update((all) => ({ ...all, [id]: snapshot.attachments }));
    const options = snapshot.options;
    const messages = snapshot.messages;
    if (options) optionsByThread.update((all) => ({ ...all, [id]: options }));
    if (messages) transcripts.update((all) => ({ ...all, [id]: messages }));
    if (snapshot.wasOpen && openThreadId() === snapshot.fallbackId) {
      openThreadId.set(id);
      subscribeOpenThread();
    }
    discardedDraftsByEnvironment.update((all) => ({ ...all, [endpoint]: history.slice(0, -1) }));
    if (history.length === 1) {
      clearTimeout(discardTimers.get(endpoint));
      discardTimers.delete(endpoint);
    }
    scheduleDraftSave();
  } catch (error) {
    reportError(error);
    throw error;
  }
}

/** Dispatches through the connected environment. Text remains in the composer on failure. */
/** Threads whose next message starts a fresh provider session (`/clear` armed it; the send consumes it). */
/** freshSessionArms.ts: keyed by thread, valued by when it was armed (strictly increasing, so two arms never tie). */
const freshContextArmed = signal<Record<string, number>>({});
let lastArmAt = 0;
export const freshContextThreads = () => Object.keys(freshContextArmed());
export const freshContextArm = (threadId: string): number | undefined => freshContextArmed()[threadId];
export function setFreshContext(threadId: string, armed: boolean) {
  if (armed) {
    lastArmAt = Math.max(Date.now(), lastArmAt + 1);
    const at = lastArmAt;
    freshContextArmed.update((all) => ({ ...all, [threadId]: at }));
  } else {
    freshContextArmed.update((all) => { const { [threadId]: _removed, ...rest } = all; return rest; });
  }
}
/** With `arm`, clears only that arm, so a send never consumes one made while it was in flight. */
export function disarmFreshContext(threadId: string, arm?: number) {
  const current = freshContextArmed()[threadId];
  if (current === undefined || (arm !== undefined && current !== arm)) return;
  setFreshContext(threadId, false);
}

export function sendDraft(fromInput?: { text?: string; intent?: SendIntent }) {
  const id = scopeId();
  const body = (fromInput?.text ?? (id ? draftsByThread()[id] ?? "" : "")).trim();
  if (!id || (!body && (attachmentDrafts()[id]?.length ?? 0) === 0)) return;
  const shown = threadApprovalsFor(id);
  if (shown.length === 0) {
    void sendThreadMessage(id, body, draftsByThread()[id] ?? "", fromInput?.intent);
    void recordPromptSent();
    return;
  }
  // useComposerSend.ts: a message sent while approvals are pending redirects the agent: the shown approvals are
  // declined first (or, when the first takes feedback, declined with this text), then the message goes out.
  const draftAtSend = draftsByThread()[id] ?? "";
  const scopeAtSend = scopeOverride;
  void redirectPendingApprovals({ shown, message: body, hasAttachmentsOrContext: (attachmentDrafts()[id]?.length ?? 0) > 0 || Boolean(sendExtrasFor(id).context) }, {
    pending: () => threadApprovalsFor(id),
    responding: () => respondingApprovalIds(),
    draftKey: () => JSON.stringify([draftsByThread()[id] ?? "", (attachmentDrafts()[id] ?? []).map((item) => item.id)]),
    respond: (requestId, decision, feedback) => withThreadScope(id, () => respondToApproval(requestId, decision, feedback)).then(() => true, () => false),
    clearDraft: () => { draftsByThread.update((all) => ({ ...all, [id]: "" })); scheduleDraftSave(); },
    setError: (message) => setThreadError(id, message),
    toast: (title, description) => showToast({ type: "info", title, description }),
  }).then((send) => {
    if (!send) return;
    withThreadScope(scopeAtSend, () => void sendThreadMessage(id, body, draftAtSend, fromInput?.intent));
    void recordPromptSent();
  });
}

/** Sends a standalone command (`/goal resume`) to the open thread without touching its draft (the banners' goal row). */
export async function sendThreadCommand(text: string): Promise<void> {
  const id = scopeId();
  if (!id || !text.trim()) return;
  await sendThreadMessage(id, text.trim(), "\u0000standalone-command");
}

// ---- Command palette (⌘K) ----

export interface PaletteRow {
  id: string;
  group: string;
  title: string;
  hint?: string;
  /** Leading glyph. T3 paints an icon on every result row. */
  mark: string;
  /** Badge from shortcutCommand. Absent when T3 has no shortcut on that item. */
  shortcut?: string;
  /** Trailing chevron for a submenu row. */
  submenu?: boolean;
}

/** Whether the palette is up. */
const palette = signal(false);
export const paletteOpen = () => palette();

/** What the palette's field holds. */
const query = signal("");
export const paletteQuery = () => query();

export function setPaletteQuery(text: string) {
  query.set(text);
}

type PaletteMode = "root" | "projects" | "add-project";
const paletteMode = signal<PaletteMode>("root");

/** CommandPaletteContent shows Backspace Back only inside a submenu. */
export function paletteShowsBackHint() {
  return paletteMode() !== "root";
}

/** Leave a submenu for the root list. The palette stays open. */
export function paletteBack() {
  paletteMode.set("root");
  query.set("");
}

export function openPalette() {
  paletteMode.set("root");
  query.set("");
  palette.set(true);
}

export function closePalette() {
  palette.set(false);
  query.set("");
  paletteMode.set("root");
}

export function togglePalette() {
  if (palette()) closePalette();
  else openPalette();
}

function activeProject(): Project | undefined {
  const current = openThread();
  if (current?.projectId) return projects().find((project) => project.id === current.projectId);
  return projects()[0];
}

/** The field placeholder. Root and submenu copy are getCommandPaletteInputPlaceholder. */
export function palettePlaceholder(): string {
  return paletteMode() === "root"
    ? "Search commands, projects, and threads..."
    : "Search...";
}

function matches(row: PaletteRow, q: string) {
  return row.title.toLowerCase().includes(q) || (row.hint?.toLowerCase().includes(q) ?? false);
}

/** The palette's rows. Empty query is Actions then Recent Threads; a query also searches projects. */
export const paletteRows = computed<PaletteRow[]>(() => {
  const q = query().trim().toLowerCase();
  const mode = paletteMode();

  if (mode === "projects") {
    const rows: PaletteRow[] = sortSidebarProjects(projects(), settingValue("sidebarProjectSortOrder")).map((project) => ({
      id: `new-in:${project.id}`,
      group: "Projects",
      title: project.name,
      mark: "folder",
      ...(project.environmentId ? { hint: managedEnvironment(project.environmentId)?.label ?? "Remote" } : {}),
    }));
    rows.push({ id: "new-in:none", group: "Projects", title: "No project", mark: "message-square-dashed" });
    return q ? rows.filter((row) => matches(row, q)) : rows;
  }

  if (mode === "add-project") {
    const rows: PaletteRow[] = [
      {
        id: "cmd:connect-environment",
        group: "",
        title: "Connect an environment",
        hint: "No connected environment can add a project",
        mark: "settings",
      },
    ];
    return q ? rows.filter((row) => matches(row, q)) : rows;
  }

  const project = activeProject();
  const actions: PaletteRow[] = [];
  if (project) {
    actions.push({
      id: `new-here:${project.id}`,
      group: "Actions",
      title: `New thread in ${project.name}`,
      mark: "square-pen",
      shortcut: "⌘⇧N",
    });
  }
  actions.push(
    { id: "menu:new-thread-in", group: "Actions", title: "New thread in...", mark: "square-pen", submenu: true },
    { id: "menu:add-project", group: "Actions", title: "Add project", mark: "folder-plus", submenu: true },
    { id: "cmd:pull-requests", group: "Actions", title: "Open pull requests", mark: "git-pull-request-arrow" },
    { id: "cmd:issues", group: "Actions", title: "Open issues", mark: "circle-dot" },
    { id: "cmd:usage", group: "Actions", title: "Open usage", mark: "chart-no-axes-column", shortcut: "⌘U" },
    { id: "cmd:settings", group: "Actions", title: "Open settings", mark: "settings" },
    { id: "cmd:project-settings", group: "Actions", title: "Project settings", mark: "folder" },
  );

  if (!q) {
    return [
      ...actions,
      ...allThreads().map((thread) => ({
        id: `thread:${thread.id}`,
        group: "Recent Threads",
        title: thread.title,
        mark: "message-square",
        ...(thread.environmentId ? { hint: managedEnvironment(thread.environmentId)?.label ?? "Remote" } : {}),
      })),
    ];
  }

  // filterCommandPaletteGroups drops Recent Threads while searching, then adds
  // Threads, then Projects, after the commands that match.
  return [
    ...actions.filter((row) => matches(row, q)),
    ...allThreads()
      .filter((thread) => thread.title.toLowerCase().includes(q))
      .map((thread) => ({ id: `thread:${thread.id}`, group: "Threads", title: thread.title, mark: "message-square" })),
    ...sortSidebarProjects(projects(), settingValue("sidebarProjectSortOrder"))
      .filter((item) => item.name.toLowerCase().includes(q))
      .map((item) => ({ id: `proj:${item.id}`, group: "Projects", title: item.name, mark: "folder" })),
  ];
});

/** Runs the first row, or the one named. Submenus stay open; actions do what the title says. */
export function runPaletteRow(id?: string) {
  const rows = paletteRows();
  const row = id ? rows.find((item) => item.id === id) : rows[0];
  if (!row) {
    closePalette();
    return;
  }
  if (row.id === "menu:new-thread-in") {
    paletteMode.set("projects");
    query.set("");
    return;
  }
  if (row.id === "menu:add-project") {
    openAddProjectPalette();
    return;
  }
  if (row.id.startsWith("new-here:")) {
    createThread(row.id.slice("new-here:".length));
    return;
  }
  if (row.id.startsWith("new-in:")) {
    const projectId = row.id.slice("new-in:".length);
    createThread(projectId === "none" ? null : projectId);
    return;
  }
  if (row.id.startsWith("thread:")) {
    openThreadById(row.id.slice("thread:".length));
    closePalette();
    return;
  }
  if (row.id.startsWith("proj:")) {
    const project = projects().find((item) => item.id === row.id.slice("proj:".length));
    if (project) {
      const latest = latestThreadOf(project.threads);
      if (latest) openThreadById(latest.id);
      else createThread(project.id);
    }
    closePalette();
    return;
  }
  if (row.id === "cmd:project-settings") {
    openSettings("/settings/projects");
    closePalette();
    return;
  }
  if (row.id === "cmd:settings") {
    openSettings();
    closePalette();
    return;
  }
  if (row.id === "cmd:usage") {
    openUsage();
    closePalette();
    return;
  }
  if (row.id === "cmd:pull-requests") {
    openUtility("pull-requests");
    closePalette();
    return;
  }
  if (row.id === "cmd:issues") {
    openUtility("issues");
    closePalette();
    return;
  }
  if (row.id === "cmd:connect-environment") {
    openSettings("/settings/connections");
    closePalette();
    return;
  }
  closePalette();
}

/** Bumped each time Add project is asked for, so an already open palette moves to its Sources view. */
const addProjectRequests = signal(0);
export const addProjectIntent = () => addProjectRequests();

/** The sidebar's Add project button, the empty states and the palette's own action all open the palette's Add project view. */
export function openAddProjectPalette() {
  paletteMode.set("add-project");
  query.set("");
  palette.set(true);
  addProjectRequests.update((count) => count + 1);
}

// ---- Utility pages ----

/**
 * Which sidebar utility page is showing over the chat pane, or null. The web
 * reaches these from the sidebar's footer icons (`SidebarUtilityMenu`), and
 * they are utility pages rather than app modals: `isSidebarUtilityPage` covers
 * `/pull-requests` and `/projects/*` in components/sidebar/mainAppLocation.ts.
 * `/projects/*` is only a redirect onto `/settings/projects`, so Pull requests
 * is the one page here.
 */
export type UtilityPage = "pull-requests" | "issues";

const utility = signal<UtilityPage | null>(null);
export const utilityPage = () => utility();

export function openUtility(page: UtilityPage) {
  settings.set(false);
  usage.set(false);
  utility.set(page);
}

onThreadShown = () => {
  utility.set(null);
};

export function closeUtility() {
  utility.set(null);
}

// ---- Usage ----

/**
 * The connected environments Usage reads diagnostics from. The web's page
 * draws "Connect an environment to see usage." when none is connected. This
 * store has no environment, so that disconnected sentence is what the page shows.
 */
export interface UsageEnvironment {
  id: string;
  label: string;
}

const environments = signal<UsageEnvironment[]>([]);

export const usageEnvironments = () => environments();

/** The environment filter's selection; empty means "all of them". */
const selectedEnvironments = signal<string[]>([]);
export const usageSelectedEnvironments = () => selectedEnvironments();

/**
 * Whether the Usage page is up. In the web app it is an app modal page
 * (`isAppModalPage("/usage")`) that renders over the thread which opened it,
 * so it is a sibling of Settings rather than a settings section -- and its
 * shortcut is `mod+u` (`usage.open`), not `mod+,`.
 */
const usage = signal(false);
export const usageOpen = () => usage();

/** The period and metric. T3's usagePagePreferences default is limits / 30 days. */
const usageWindowDays = signal(30);
export const usagePeriod = () => usageWindowDays();

const usageMetric = signal<"cost" | "tokens" | "limits">("limits");
export const usageMetricValue = () => usageMetric();

export function openUsage() {
  // /usage and /settings are both app-modal routes, so opening one leaves the other.
  settings.set(false);
  usage.set(true);
}

export function closeUsage() {
  usage.set(false);
}

function saveUsagePagePreferences() {
  const windowDays = usageWindowDays();
  if (windowDays !== 1 && windowDays !== 7 && windowDays !== 30 && windowDays !== 90) return;
  void Storage.setItem(USAGE_PAGE_PREFERENCES_KEY, serializeUsagePagePreferences({ metric: usageMetric(), windowDays })).catch(() => undefined);
}

export function setUsagePeriod(days: number) {
  usageWindowDays.set(days);
  saveUsagePagePreferences();
}

export function setUsageMetric(next: "cost" | "tokens" | "limits") {
  usageMetric.set(next);
  saveUsagePagePreferences();
}

/** Restores the saved metric and window (usagePagePreferences.ts), once per launch. */
let usagePagePreferencesRestored = false;
export function restoreUsagePagePreferences() {
  if (usagePagePreferencesRestored) return;
  usagePagePreferencesRestored = true;
  void Storage.getItem(USAGE_PAGE_PREFERENCES_KEY).then((raw) => {
    if (raw == null) return;
    const saved = parseUsagePagePreferences(raw);
    usageMetric.set(saved.metric);
    usageWindowDays.set(saved.windowDays);
  }).catch(() => undefined);
}

/** The Breakdown table's tab: per model, or per day/hour. */
const breakdown = signal<"model" | "time">("model");
export const breakdownTab = () => breakdown();

export function setBreakdownTab(next: "model" | "time") {
  breakdown.set(next);
}

// ---- Settings ----

/** Whether the settings screen is up (the web app routes to /settings/*). */
const settings = signal(false);
export const settingsOpen = () => settings();

/** Which settings section is showing; defaults to the web app's first. */
const settingsPath = signal("/settings/general");
export const settingsSection = () => settingsPath();

/** Settings nav search. Placeholder "Search", aria-label "Search settings". */
const settingsQuery = signal("");
export const settingsSearchQuery = () => settingsQuery();
export function setSettingsSearchQuery(text: string) {
  settingsQuery.set(text);
}

export interface SettingsSearchHit {
  id: string;
  title: string;
  path: string;
  section: string;
  /** The row to reveal when it is not `id` (the web's `item.targetId ?? item.id`). */
  targetId?: string;
}

/**
 * T3 shows Secrets only when the env flag is "1" or "true"
 * (`isSecretsFeatureEnabled` in env.ts). It is off unless that value is set.
 */
export function isSecretsFeatureEnabled() {
  return false;
}

/**
 * The web's settings search (components/settings/settingsSearch.ts): tokenised, keyword and
 * section matching, ranked, filtered to what the connected server offers. The index is generated
 * from the web's source; see pages/settings/settingsSearch.ts.
 */
export const settingsSearchHits = computed<SettingsSearchHit[]>(() => {
  const q = settingsQuery();
  if (q.trim().length === 0) return [];
  return searchSettings(q, availableSettingsSearchItems(), { ...NATIVE_SEARCH_PLATFORM, secretsEnabled: isSecretsFeatureEnabled() }).map((item) => ({
    id: item.id,
    title: item.title,
    path: item.to,
    section: SETTINGS_SECTION_LABELS[item.to] ?? item.to,
    ...(item.targetId ? { targetId: item.targetId } : {}),
  }));
});

/**
 * The setting a search result opened, kept until the user navigates elsewhere: the web keeps it as the
 * URL hash, and a target the selected scope cannot show gets a notice (SettingsScopeBoundary).
 */
const settingsLandingTarget = signal<{ path: string; targetId: string } | null>(null);
export const settingsLanding = () => settingsLandingTarget();
export function setSettingsLanding(value: { path: string; targetId: string } | null) {
  settingsLandingTarget.set(value);
}

export function openSettings(path = "/settings/general") {
  settingsLandingTarget.set(null);
  settingsPath.set(path);
  settingsQuery.set("");
  usage.set(false);
  settings.set(true);
}

export function closeSettings() {
  settings.set(false);
}

/** The selected section's label, as the nav shows it. */
export function settingsSectionLabel(): string {
  const path = settingsPath();
  for (const group of SETTINGS_NAV)
    for (const section of group.sections)
      if (section.path === path) return section.label;
  // Two subpages are reached by a link row rather than the nav
  // (`Diagnostics` from Maintenance, `Open source licenses` from About), so
  // their labels live in the web's SETTINGS_BREADCRUMB_LABELS, not the nav.
  for (const section of SETTINGS_SUBPAGES)
    if (section.path === path) return section.label;
  return "Settings";
}

/**
 * General settings, with the web app's real defaults — the field names and
 * defaults below are read from packages/contracts/src/settings.ts, not
 * guessed (inAppNotificationsEnabled is false, confirmThreadDelete is true).
 */
const general = signal({
  inAppNotificationsEnabled: false,
  sidebarProjectGroupingMode: "repository",
  sidebarProjectSortOrder: "updated_at",
  sidebarWorkingShelfEnabled: true,
  confirmThreadUnpin: false,
  confirmThreadArchive: false,
  confirmThreadDelete: true,
  timestampFormat: "locale",
});

export const generalSettings = () => general();

export function updateGeneral(patch: Partial<ReturnType<typeof generalSettings>>) {
  general.update((current) => ({ ...current, ...patch }));
  void Storage.setItem("general", JSON.stringify(general())).catch(reportError);
}

/**
 * Client settings seeded from the web app's shipped defaults (generated from the shipped settings defaults).
 * Server settings are not seeded here: they belong to the server (`settingValue` reads them
 * from the config stream) and never live in the local blob.
 */
function seedSettings(): Record<string, string | boolean | number> {
  return clientDefaults();
}

/**
 * The saved settings worth restoring. A value saved by an older build can have the wrong type
 * for its field (a select once drawn as a switch saved `false`), a stale option, or belong to
 * the server; restoring it would show a layout no control can produce. A value equal to its
 * default is not an override and is dropped.
 */
export function validSavedSettings(saved: Record<string, unknown>, defaults: Record<string, string | boolean | number>): Record<string, string | boolean | number> {
  return validSavedValues(saved, defaults);
}

const settingDefaults = seedSettings();
/** Only the values the user changed from their default. */
const settingsValues = signal<Record<string, string | boolean | number>>({});

export function settingValue(field: string): string | boolean | number | undefined {
  if (scopeOfSetting(field) === "server") {
    const reported = backendStatus() === "connected" ? serverSettings() : null;
    const value = reported?.[field];
    return typeof value === "string" || typeof value === "boolean" || typeof value === "number" ? value : defaultOfSetting(field);
  }
  const overrides = settingsValues();
  return field in overrides ? overrides[field] : settingDefaults[field] ?? defaultOfSetting(field);
}

export function updateSetting(field: string, value: string | boolean | number) {
  settingsValues.update((all) => {
    const { [field]: _previous, ...rest } = all;
    return field in settingDefaults && settingDefaults[field] === value ? rest : { ...rest, [field]: value };
  });
  void Storage.setItem("settings", JSON.stringify(settingOverrides(settingsValues(), settingDefaults))).catch(reportError);
}

/** What `initializeBackend` restores from the saved blob (exported for tests). */
export function restoreSavedSettings(blob: string): void {
  const values = record(JSON.parse(blob));
  if (!values) return;
  const valid = validSavedValues(values, settingDefaults);
  settingsValues.update((current) => ({ ...current, ...valid }));
  const scheme = valid.colorScheme;
  if (scheme === "light" || scheme === "dark" || scheme === "system") setColorScheme(scheme);
}



/** The project a New thread action uses: the open thread's, else the first. */
export function activeProjectId(): string | null {
  const current = openThread();
  if (current?.projectId) return current.projectId;
  // resolveDefaultProjectRef: the first project that is not archived.
  return projects().find((project) => !isProjectArchived(project.id))?.id ?? null;
}

/**
 * Starts a draft titled "New thread". It stays out of the project folder.
 * The sidebar lists it only once the composer or the transcript has user content.
 */
/**
 * useHandleNewThread: the project's empty draft is reused (it keeps an explicit pick; otherwise it takes the project's
 * default runtime), the open thread's interaction mode carries over, and the project's default model applies.
 * `prompt` seeds the composer unless the draft already has text; `workspace` (the branch / worktreePath / envMode /
 * startFromOrigin options) is set as given instead of the project default.
 */
export function createThread(projectId: string | null, options?: { prompt?: string; workspace?: WorkspaceStrategy }) {
  const carryInteraction = openThreadId() ? activeThreadOptions().interaction : null;
  const projectDefaults = newThreadProjectDefaults(projectId);
  // useHandleNewThread: the default model's provider out of usage starts the draft on the fallback model.
  const fallbackResolution = newThreadFallback(projectId, Date.now()).resolution;
  const startModel = fallbackResolution.fallback ? fallbackResolution.selection : projectDefaults.model;
  if (startModel) {
    const match = models().find((item) => item.provider === startModel.instanceId && item.model === startModel.model);
    if (match) model.set(match);
  }
  const seed = (threadId: string) => {
    if (options?.prompt === undefined || (draftsByThread()[threadId] ?? "").trim().length > 0) return;
    draftsByThread.update((all) => ({ ...all, [threadId]: options.prompt! }));
  };
  const reusable = unpromoted().find((thread) => thread.projectId === (projectId ?? "") && !draftHasUserContent(thread.id));
  if (reusable) {
    const alreadyOpen = openThreadId() === reusable.id;
    optionsByThread.update((all) => {
      const current = all[reusable.id] ?? defaultThreadOptions();
      return { ...all, [reusable.id]: { ...current, ...(!alreadyOpen ? { runtime: projectDefaults.runtime } : {}), ...(carryInteraction ? { interaction: carryInteraction } : {}), ...(options?.workspace ? { workspace: options.workspace } : {}) } };
    });
    seed(reusable.id);
    if (!alreadyOpen) {
      openThreadId.set(reusable.id);
      subscribeOpenThread();
      if (!options?.workspace) void applyNewThreadWorkspaceDefault(reusable.id, projectId);
    }
    utility.set(null);
    settings.set(false);
    usage.set(false);
    closePalette();
    scheduleDraftSave();
    return;
  }
  const id = `thread:${crypto.randomUUID()}`;
  optionsByThread.update((all) => ({ ...all, [id]: { ...defaultThreadOptions(), runtime: projectDefaults.runtime, ...(carryInteraction ? { interaction: carryInteraction } : {}), ...(options?.workspace ? { workspace: options.workspace } : {}) } }));
  seed(id);
  const thread: Thread = {
    id,
    projectId: projectId ?? "",
    title: "New thread",
    status: "idle",
    pinned: false,
    updatedAt: Date.now(),
  };
  unpromoted.update((list) => [thread, ...list]);
  openThreadId.set(id);
  subscribeOpenThread();
  if (!options?.workspace) void applyNewThreadWorkspaceDefault(id, projectId);
  utility.set(null);
  settings.set(false);
  usage.set(false);
  closePalette();
  scheduleDraftSave();
}

// ---- Environment connection ----

export type BackendStatus = "disconnected" | "connecting" | "connected" | "error";
export interface AvailableModel { provider: string; model: string; label: string; driver?: string; optionDescriptors?: unknown[] }
export interface ProviderStatus {
  instanceId: string; driver: string; name: string; enabled: boolean; installed: boolean; available: boolean; status: string;
  authStatus: string; authLabel: string | null; version: string | null; unavailableReason: string | null;
  message: string | null; checkedAt: string | null; canInstall: boolean; canAuthenticate: boolean; models: { id: string; name: string }[];
  /** The in-place update's progress, as the server reports it (queued, running, succeeded, failed, unchanged). */
  updateState?: { status: string; message: string | null; finishedAt: string | null } | null;
  /** `versionAdvisory.latestVersion`: the version an update would install. */
  latestVersion?: string | null;
}
export interface LocalEnvironmentCandidate { endpoint: string; label: string; serverVersion: string }
export type ApprovalDecision = "accept" | "acceptForSession" | "acceptAlways" | "decline" | "cancel";
export interface ApprovalOption { decision: ApprovalDecision; label: string; warning?: string }
export interface PendingApproval { id: string; kind: string; title: string; detail: string; decisions: ApprovalDecision[]; options: ApprovalOption[]; /** responseCapability.supportsFeedback: a decline can carry the composer text. */ supportsFeedback?: boolean;
  /** threadRequests.ts: the item's reason, the app it is for, why full access still asks, and whether the provider can still take an answer. */
  reason?: string; appName?: string; fullAccessOverride?: string; responseCapability?: "live" | "not_resumable" }
export interface ActivityItem extends ActivityFields {}
export interface UserInputOption { label: string; description: string; value?: string }
export interface UserInputQuestion { id: string; header: string; question: string; options: UserInputOption[]; multiSelect: boolean; allowCustomAnswer: boolean; required: boolean; initialAnswer?: string }
export interface PendingUserInput { id: string; title: string; questions: UserInputQuestion[]; /** Message-mode requests may be dismissed without an answer. */ dismissible?: boolean }

const connectionStatus = signal<BackendStatus>("disconnected");
const connectionError = signal<string | null>(null);
const connectionUrl = signal("");
const localServerEngineSignal = signal<"t3" | "r3" | null>(null);
let localBootstrapEndpoint = "";
const models = signal<AvailableModel[]>([]);
const providerList = signal<ProviderStatus[]>([]);
const rawProviders = signal<Record<string, unknown>[]>([]);
/** The config's providers as the server sent them (before fetched workspace snapshots are merged in). */
let configProviderRecords: Record<string, unknown>[] = [];
/** capabilities.providerWorkspaceSnapshotsOnDemand of the connected environment. */
let workspaceSnapshotsOnDemandCapability = false;
/** state/server.ts fetchedWorkspaceSnapshotsAtom, per environment endpoint (kept across reconnects, as keepAlive). */
const fetchedWorkspaceSnapshots = new Map<string, readonly FetchedWorkspaceSnapshot[]>();
const providerListLoaded = signal(false);
const cachedProviderList = signal<ProviderStatus[]>([]);
const cachedProviderListLoaded = signal(false);
const projectOrganization = signal(false);
const commandOutputStreamingCapability = signal(false);
/** The environment streams command output to expanded rows (EnvironmentCapabilities.commandOutputStreaming). */
export const commandOutputStreaming = () => commandOutputStreamingCapability();
const modelCatalogRefreshCapability = signal(false);
const worktreeBootstrapCapability = signal(false);
/** environment.capabilities.pullRequestChecks: the server answers pullRequests.checks (usePullRequestDetail.ts:64). */
const pullRequestChecksCapability = signal(false);
/** environment.capabilities.serverBrowser: the environment runs browser tabs of its own (previewRuntime.ts). */
const serverBrowserCapability = signal(false);
export const environmentSupportsServerBrowser = () => serverBrowserCapability();
/** ServerConfig.threadSnapshotPagination / threadFind: the server pages thread history and searches a whole thread. */
const threadSnapshotPaginationCapability = signal(false);
const threadFindCapability = signal(false);
/** ServerConfig secretRequestReferences: the server accepts a secret provider reference as a secret request's answer. */
const secretRequestReferencesCapability = signal(false);
export const serverSecretRequestReferences = () => secretRequestReferencesCapability();
export const serverThreadFind = () => threadFindCapability();
/** ServerConfig.threadFindProgressive: find answers stream (`orchestration.searchThreadStream`) until `complete`. */
const threadFindProgressiveCapability = signal(false);
export const serverThreadFindProgressive = () => threadFindProgressiveCapability();
/** ProviderModelPicker.tsx refreshModelCatalog: on every picker open, ask the server for newly released models
 * (server.refreshProviders { modelCatalogOnly: true }) when it advertises `capabilities.modelCatalogRefresh`
 * (an older server drops the field and probes every provider, so it is not asked). Failures are not reported. */
export function refreshModelCatalog(): void {
  if (!modelCatalogRefreshCapability() || backendStatus() !== "connected") return;
  void requestBackend("server.refreshProviders", { modelCatalogOnly: true }).catch(() => {});
}
const localCandidates = signal<LocalEnvironmentCandidate[]>([]);
const model = signal<AvailableModel | null>(null);
const runtimeRequests = signal<Record<string, unknown>[]>([]);
const turnItems = signal<Record<string, unknown>[]>([]);
/** The open thread's raw turn items (read-only), e.g. for the diff panel's live tool-call revision. */
export const openThreadTurnItems = () => turnItems();
const turnItemOrders = signal<Record<string, number>>({});
/** The thread's live subagent records (projection.subagents, then `subagent.updated`), by subagentId. */
const subagentRecords = signal<Record<string, Record<string, unknown>>>({});
const archived = signal<Thread[]>([]);
const archiveIsLoading = signal(false);
const archiveProblem = signal<string | null>(null);
export const backendStatus = () => connectionStatus();
/** Whether the environment is connected, changing only on connect and disconnect: a live stream reads it so a reconnect
 * subscribes again (a status that moves between "connecting" and "error" does not resubscribe anything). */
const connectedNow = computed(() => connectionStatus() === "connected");
export const backendConnected = () => connectedNow();
export const backendError = () => connectionError();
export const backendUrl = () => connectionUrl();
export const localServerEngine = () => localServerEngineSignal();
export const availableModels = () => models();
export const providerStatuses = () => providerList();
/** The server's provider snapshots as sent: commands, skills, usage limits, driver and accent. */
export const rawProviderRecords = () => rawProviders();
export const providersLoaded = () => providerListLoaded();
export const localCachedProviders = () => cachedProviderList();
export const localProviderCacheLoaded = () => cachedProviderListLoaded();
export const localEnvironments = () => localCandidates();
export const projectOrganizationSupported = () => projectOrganization();
export const backendConnectionGeneration = () => connectionGeneration;
/** The environment's bearer token, for the few HTTP-only endpoints (the pull request diff). */
export const backendBearer = () => bearerToken;
export const selectedModel = () => model();
/** Models picked in a side chat pane, per thread; the open thread's pick is the global `model`. */
const modelByScopedThread = signal<Record<string, AvailableModel>>({});
/** A thread's model: its own pick, else the one its shell names, else the current one. */
/** composerDraftStore.setModelSelection for a scoped composer (a side chat's draft): records its model pick. */
export function setScopedThreadModel(id: string, provider: string, modelName: string): void {
  const match = models().find((item) => item.provider === provider && item.model === modelName);
  if (match) modelByScopedThread.update((all) => ({ ...all, [id]: match }));
}
export function selectedModelFor(id: string): AvailableModel | null {
  const picked = modelByScopedThread()[id];
  if (picked) return models().find((item) => item.provider === picked.provider && item.model === picked.model) ?? null;
  const selection = record(shellThreads.find((thread) => thread.id === id)?.modelSelection);
  const named = selection ? models().find((item) => item.provider === selection.instanceId && item.model === selection.model) : undefined;
  return named ?? model();
}

/** The open thread's own model selection as its shell names it, listed or not (instanceId, model). */
export function openThreadModelSelection(): { instanceId: string; model: string } | null {
  const selection = record(shellThreads.find((thread) => thread.id === openThreadId())?.modelSelection);
  return selection && typeof selection.instanceId === "string" && typeof selection.model === "string" ? { instanceId: selection.instanceId, model: selection.model } : null;
}

/** Option selections (effort, fast mode, ...) the user picked, per "instanceId:model". */
const modelOptionSelections = signal<Record<string, { id: string; value: string | boolean }[]>>({});
/** withImplicitFastModeDefault (composerProviderState.tsx): a model with a boolean fastMode option sends false unless the
 * user picked it (Cursor ACP would otherwise default Fast to true). */
export function withImplicitFastModeDefault(descriptors: unknown[] | undefined, options: { id: string; value: string | boolean }[] | undefined): { id: string; value: string | boolean }[] | undefined {
  if (options?.some((selection) => selection.id === "fastMode")) return options;
  const hasFast = descriptors?.some((descriptor) => { const d = record(descriptor); return d?.type === "boolean" && d.id === "fastMode"; });
  return hasFast ? [...(options ?? []), { id: "fastMode", value: false }] : options;
}
export const modelOptionsFor = (provider: string, modelName: string) => modelOptionSelections()[`${provider}:${modelName}`];
export function setModelOptionSelections(provider: string, modelName: string, options: { id: string; value: string | boolean }[] | undefined) {
  const key = `${provider}:${modelName}`;
  modelOptionSelections.update((all) => {
    const { [key]: _previous, ...rest } = all;
    return options && options.length ? { ...rest, [key]: options } : rest;
  });
  // setProviderModelOptions / stickyModelOptions: the picks outlive a restart.
  void Storage.setItem("modelOptions", JSON.stringify(modelOptionSelections())).catch(() => {});
}
/** setStickyModelSelection: the last model picked in a composer, which a new draft starts with after a restart too. */
let stickyModelPick: { provider: string; model: string } | null = null;

/** The open thread's runs, from its projection snapshot and run.created / run.updated events. */
const runList = signal<Record<string, unknown>[]>([]);
export const threadRuns = () => runList();
/** The open thread's run attempts and execution nodes (projection.attempts / .nodes, then run-attempt.created /
 * run-attempt.updated / node.updated): the timeline maps each turn item to its attempt to fold superseded attempts. */
const attemptList = signal<Record<string, unknown>[]>([]);
const nodeList = signal<Record<string, unknown>[]>([]);
export const threadAttempts = () => attemptList();
export const threadExecutionNodes = () => nodeList();
/** The open thread's checkpoints (projection.checkpoints, then `checkpoint.captured`): the proactive panels read each turn's changed files. */
const checkpointList = signal<Record<string, unknown>[]>([]);
export const threadCheckpoints = () => checkpointList();

/**
 * A snapshot of the signals above (runtimeRequests, turnItems, turnItemOrders, subagentRecords, runList,
 * checkpointList) for a thread that is not currently open. subscribeOpenThread stashes the outgoing thread's
 * values here and restores a visited thread's values from here, so switching back to it repaints activity,
 * notices and turn folds in the same frame instead of clearing them and waiting on a fresh server snapshot.
 */
interface ThreadDetailCache {
  runtimeRequests: Record<string, unknown>[];
  turnItems: Record<string, unknown>[];
  turnItemOrders: Record<string, number>;
  subagentRecords: Record<string, Record<string, unknown>>;
  runList: Record<string, unknown>[];
  checkpointList: Record<string, unknown>[];
  attemptList?: Record<string, unknown>[];
  nodeList?: Record<string, unknown>[];
  /** Whether a real server snapshot (not just this cache) had arrived for this thread before it was left. */
  loaded: boolean;
  /** The rest of what the thread stream had delivered, so a revisit resumes the stream instead of asking for a snapshot. */
  threadRecord: Record<string, unknown> | null;
  providerSessions: Record<string, unknown>[];
  providerThreads: Record<string, unknown>[];
  providerState: ProviderState;
  bannerState: ThreadSessionState;
  /** The last stream sequence applied to this detail (the reference's ThreadResumeSnapshot.sequence); null when unknown. */
  sequence: number | null;
}
function maxThreadDetailCache(): number {
  try { return platform.os === "windows" ? 3 : 8; } catch { return 8; }
}
const threadDetailCache = new Map<string, ThreadDetailCache>();
function stashThreadDetail(threadId: string) {
  threadDetailCache.delete(threadId);
  threadDetailCache.set(threadId, {
    runtimeRequests: runtimeRequests(), turnItems: turnItems(), turnItemOrders: turnItemOrders(),
    subagentRecords: subagentRecords(), runList: runList(), checkpointList: checkpointList(),
    attemptList: attemptList(), nodeList: nodeList(),
    loaded: snapshotLoadedFor() === threadId,
    threadRecord: threadRecord(), providerSessions: providerSessionRecords(), providerThreads: providerThreadRecords(),
    providerState: providerState(), bannerState: threadSessionState(), sequence: openThreadSequence,
  });
  const limit = maxThreadDetailCache();
  if (threadDetailCache.size <= limit) return;
  const activeId = untracked(openThreadId);
  const evictedDetails: string[] = [];
  const evictedTranscripts: string[] = [];
  for (const candidate of threadDetailCache.keys()) {
    if (threadDetailCache.size <= limit) break;
    if (candidate === threadId || candidate === activeId || sideSubscriptions.has(candidate)) continue;
    threadDetailCache.delete(candidate);
    threadWireDecoders.delete(`open:${candidate}`);
    threadHistoryLoadVersions.delete(candidate);
    evictedDetails.push(candidate);
    if (isServerThread(candidate)) evictedTranscripts.push(candidate);
  }
  if (evictedTranscripts.length > 0) {
    transcripts.update((all) => {
      let changed = false;
      const next = { ...all };
      for (const id of evictedTranscripts) {
        if (id in next) { delete next[id]; changed = true; }
      }
      return changed ? next : all;
    });
  }
  if (evictedDetails.length > 0) {
    threadHistoryByThread.update((all) => {
      let changed = false;
      const next = { ...all };
      for (const id of evictedDetails) {
        if (id in next) { delete next[id]; changed = true; }
      }
      return changed ? next : all;
    });
  }
}
/** The open thread's own record and provider sessions/threads as the stream delivers them (projection.thread, .providerSessions, .providerThreads). */
const threadRecord = signal<Record<string, unknown> | null>(null);
const providerSessionRecords = signal<Record<string, unknown>[]>([]);
const providerThreadRecords = signal<Record<string, unknown>[]>([]);
const contextTransfersByThread = signal<Record<string, Record<string, unknown>[]>>({});
/** The last `sequence` applied to the open thread's detail; a resubscribe resumes after it (`afterSequence`). */
let openThreadSequence: number | null = null;
/**
 * The open thread's projection as the live subscription holds it, in the shape `orchestration.getThreadProjection`
 * answers (thread, runs, subagents, providerSessions, providerThreads). Null until that thread's detail is loaded, or
 * for any other thread. Views read this instead of polling the RPC, as the reference reads its thread state.
 */
export function liveThreadProjection(threadId: string): Record<string, unknown> | null {
  if (openThreadId() !== threadId || snapshotLoadedFor() !== threadId) return null;
  return {
    thread: threadRecord(), runs: runList(), subagents: Object.values(subagentRecords()),
    providerSessions: providerSessionRecords(), providerThreads: providerThreadRecords(), contextTransfers: contextTransfersByThread()[threadId] ?? [],
  };
}
function updateCheckpoint(value: unknown) {
  const item = record(value);
  if (!item || typeof item.id !== "string") return;
  const id = item.id;
  checkpointList.update((items) => items.some((entry) => entry.id === id) ? items.map((entry) => entry.id === id ? item : entry) : [...items, item]);
}
const automaticQueueMessages = signal<Record<string, string[]>>({});
const noAutomaticQueueMessages: readonly string[] = [];
export const automaticQueueMessageIdsFor = (threadId: string): readonly string[] => automaticQueueMessages()[threadId] ?? noAutomaticQueueMessages;

function rememberAutomaticQueueMessages(threadId: string, values: readonly unknown[], replace: boolean) {
  const previous = automaticQueueMessageIdsFor(threadId);
  const ids = new Set(replace ? [] : previous);
  for (const value of values) {
    const message = record(value);
    if (!message || typeof message.id !== "string") continue;
    if (message.delegatedCompletion !== undefined || message.notification !== undefined) ids.add(message.id);
    else ids.delete(message.id);
  }
  if (ids.size === previous.length && previous.every((id) => ids.has(id))) return;
  automaticQueueMessages.update((all) => ({ ...all, [threadId]: [...ids] }));
}

function updateRun(value: unknown) {
  const item = record(value);
  if (!item || typeof item.id !== "string") return;
  const id = item.id;
  runList.update((items) => items.some((entry) => entry.id === id) ? items.map((entry) => entry.id === id ? item : entry) : [...items, item]);
}

/** How a send behaves while a turn is active; the composer resolves it from the follow-up setting. */
export type SendIntent = "auto" | "queue" | "steer";
export const threadApprovals = computed<PendingApproval[]>(() => approvalsFrom(runtimeRequests(), turnItems()));
function approvalsFrom(requests: Record<string, unknown>[], items: Record<string, unknown>[]): PendingApproval[] {
  const approvals: PendingApproval[] = [];
  for (const request of requests) {
    if (request.status !== "pending" || typeof request.id !== "string" || typeof request.kind !== "string") continue;
    // threadRequests.ts: questions, auth refreshes and dynamic tool calls are not approvals; a request the provider
    // can no longer answer still shows (not_resumable) with its actions disabled.
    if (request.kind === "user_input" || request.kind === "auth_refresh" || request.kind === "dynamic_tool_call") continue;
    const capability = record(request.responseCapability);
    const live = capability?.type === "live";
    const item = items.find((entry) => entry.type === "approval_request" && entry.requestId === request.id);
    if (!item) continue;
    const detail = typeof item.prompt === "string" ? item.prompt : "";
    const reason = typeof item.reason === "string" ? item.reason : "";
    const choices: ApprovalOption[] = Array.isArray(item.options) ? item.options.map(record).flatMap((option) =>
      option && isApprovalDecision(option.decision) && typeof option.label === "string"
        ? [{ decision: option.decision, label: option.label, ...(typeof option.warning === "string" ? { warning: option.warning } : {}) }] : []) : [];
    const options: ApprovalOption[] = choices.length ? choices : [{ decision: "accept", label: "Approve" }, { decision: "decline", label: "Decline" }];
    approvals.push({ id: request.id, kind: request.kind, title: typeof item.title === "string" && item.title ? item.title : "Approval requested",
      detail, decisions: options.map((option) => option.decision), options, ...(live && capability?.supportsFeedback === true ? { supportsFeedback: true } : {}),
      ...(reason ? { reason } : {}), ...(typeof item.appName === "string" && item.appName ? { appName: item.appName } : {}),
      ...(typeof item.fullAccessOverride === "string" && item.fullAccessOverride ? { fullAccessOverride: item.fullAccessOverride } : {}),
      responseCapability: live ? "live" : "not_resumable" });
  }
  return approvals;
}
export const threadUserInputs = computed<PendingUserInput[]>(() => userInputsFrom(runtimeRequests(), turnItems()));
function userInputsFrom(requests: Record<string, unknown>[], items: Record<string, unknown>[]): PendingUserInput[] {
  const inputs: PendingUserInput[] = [];
  for (const request of requests) {
    if (request.status !== "pending" || request.kind !== "user_input" || typeof request.id !== "string") continue;
    const capability = record(request.responseCapability)?.type;
    if (capability !== "live" && capability !== "message") continue;
    const item = items.find((entry) => entry.type === "user_input_request" && entry.requestId === request.id);
    if (!item || !Array.isArray(item.questions)) continue;
    const questions: UserInputQuestion[] = item.questions.map(record).flatMap((question) => {
      if (!question || typeof question.id !== "string" || typeof question.header !== "string" || typeof question.question !== "string" || !Array.isArray(question.options)) return [];
      const options: UserInputOption[] = question.options.map(record).flatMap((option) => {
        if (!option || typeof option.label !== "string" || typeof option.description !== "string") return [];
        return [{ label: option.label, description: option.description, ...(typeof option.value === "string" ? { value: option.value } : {}) }];
      });
      if (options.length !== question.options.length) return [];
      return [{ id: question.id, header: question.header, question: question.question, options,
        multiSelect: question.multiSelect === true, allowCustomAnswer: question.allowCustomAnswer !== false,
        required: question.required !== false, ...(typeof question.initialAnswer === "string" ? { initialAnswer: question.initialAnswer } : {}) }];
    });
    if (questions.length && questions.length === item.questions.length) inputs.push({ id: request.id, title: typeof item.title === "string" && item.title ? item.title : "Input requested", questions, dismissible: item.responseMode === "message" || capability === "message" });
  }
  return inputs;
}
/** Whether the open thread is working and since when, from its runs (shell status only before the runs arrive). */
const workState = computed(() => {
  const id = openThreadId();
  const shellRunning = (id ? threadById(id)?.status : undefined) === "running";
  const runless = runlessSubagentWork(threadRecord(), nodeList());
  if (runless) return runless;
  return deriveWorking(runList(), shellRunning, threadApprovals().length > 0 || threadUserInputs().length > 0,
    (run) => typeof run.id === "string" && providerTurnEnded(providerState(), readActiveRun(runList(), run.id)));
});
export const threadWorking = () => workState().working;
export const threadWorkStartedAt = () => workState().startedAt;
/** The active run is still preparing its worktree (OrchestrationV2RunStatus "preparing"): the timeline says "Setting up worktree...". */
export const threadRunPreparing = () => activeRun(runList())?.status === "preparing";
export const threadActiveRunId = () => { const run = activeRun(runList()); return typeof run?.id === "string" ? run.id : null; };

/**
 * deriveWorkspaceMutationId (client-runtime threadDetail.ts): changes when the agent may have changed the workspace (the
 * newest settled command, file change, dynamic tool or subagent item, and the newest checkpoint's completedAt), so open
 * file and diff views refetch. Null before either exists.
 */
export const workspaceMutationId = computed<string | null>(() => {
  const orders = turnItemOrders();
  const items = [...turnItems()].sort((a, b) => (orders[String(a.id)] ?? 0) - (orders[String(b.id)] ?? 0));
  let itemId: string | null = null;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]!;
    if (item.type !== "command_execution" && item.type !== "file_change" && item.type !== "dynamic_tool" && item.type !== "subagent") continue;
    if (item.status === "pending" || item.status === "running" || item.status === "waiting") continue;
    itemId = typeof item.id === "string" ? item.id : null;
    break;
  }
  const checkpoints = checkpointList();
  const last = checkpoints.length > 0 ? checkpoints[checkpoints.length - 1] : undefined;
  const completedAt = typeof last?.completedAt === "string" ? last.completedAt : null;
  return itemId === null && completedAt === null ? null : JSON.stringify([itemId, completedAt]);
});
// Updates replace only the affected turn item. Reuse the expensive conversion of
// the rest, especially tool inputs in long conversations, on every streamed event.
const activityCache = new WeakMap<Record<string, unknown>, { order: number; value: ActivityItem | null }>();
// A visited thread restores these immutable inputs by reference. Keep its
// projected activity too, so switching back need not walk the whole history.
const projectedActivityCache = new WeakMap<Record<string, unknown>[], { orders: Record<string, number>; agents: Record<string, Record<string, unknown>>; value: ActivityItem[] }>();
function projectActivity(items: Record<string, unknown>[], orders: Record<string, number>, agents: Record<string, Record<string, unknown>>): ActivityItem[] {
  const previous = projectedActivityCache.get(items);
  if (previous && previous.orders === orders && previous.agents === agents) return previous.value;
  const value = items.flatMap((item) => {
    const order = typeof item.id === "string" ? orders[item.id] ?? 0 : 0;
    let cached = activityCache.get(item);
    if (!cached || cached.order !== order) {
      cached = { order, value: activityFromTurnItem(item, order) };
      activityCache.set(item, cached);
    }
    const activity = cached.value;
    if (!activity) return [];
    return activity.subagent ? [{ ...activity, subagent: overlaySubagent(activity.subagent, agents[activity.subagent.subagentId]) }] : [activity];
  });
  projectedActivityCache.set(items, { orders, agents, value });
  return value;
}
export const threadActivity = computed<ActivityItem[]>(() => projectActivity(turnItems(), turnItemOrders(), subagentRecords()));
/** The open thread's fork, run_interrupt_result and compaction turn items by id, as the server sent them: what their dividers say and open. */
export const threadLifecycleItems = computed<Record<string, Record<string, unknown>>>(() => {
  const found: Record<string, Record<string, unknown>> = {};
  for (const item of turnItems()) if ((item.type === "fork" || item.type === "run_interrupt_result" || item.type === "compaction") && typeof item.id === "string") found[item.id] = item;
  return found;
});
/** Lifecycle items for a selected or retained conversation, keyed by item id. */
export function threadLifecycleItemsFor(threadId: string): Record<string, Record<string, unknown>> {
  if (threadId === openThreadId()) return threadLifecycleItems();
  const found: Record<string, Record<string, unknown>> = {};
  for (const item of sideProjections()[threadId]?.items ?? []) {
    if ((item.type === "fork" || item.type === "run_interrupt_result" || item.type === "compaction") && typeof item.id === "string") found[item.id] = item;
  }
  return found;
}
export const archivedThreads = () => archived();
export const isServerThread = (id: string) => shellThreads.some((thread) => thread.id === id) || remoteShellThread(id) !== null;
/** Whether the shell snapshot marks the project archived (adding its folder again brings it back). */
export const isProjectArchived = (projectId: string) => shellProjects.some((item) => item.id === projectId && item.archivedAt != null);
export const archiveLoading = () => archiveIsLoading();
export const archivedError = () => archiveProblem();

let client: BackendClient | null = null;
let connectionGeneration = 0;
let unsubscribeThread: (() => void) | null = null;
let shellProjects: Record<string, unknown>[] = [];
let shellThreads: Record<string, unknown>[] = [];
let archivedShellThreads: Record<string, unknown>[] = [];
let subscribedThreadId: string | null = null;
/** The thread whose detail (turnItems, runs, subagents, checkpoints, runtimeRequests) the signals above currently
 * hold, regardless of whether its live subscription has connected yet. See subscribeOpenThread / threadDetailCache. */
let currentDetailThreadId: string | null = null;
/** True once the connected environment's shell snapshot arrived (the first-run gate reads it); false again on a reset. */
const shellSnapshotReceived = signal(false);
export const shellSnapshotLoaded = () => shellSnapshotReceived();
const sendingThreadIds = signal<string[]>([]);
let initialized = false;
let reconnectTimer: number | undefined;
/** supervisor.ts retry ladder (environmentSession.ts, shared with saved environments). */
const reconnectLadder = new ReconnectLadder();
let bearerToken: string | null = null;
let managedImportGeneration: number | null = null;
let providerImportInFlight: number | null = null;
type LocalDraftState = { drafts: Record<string, string>; threads: Thread[]; selectedId: string | null; options: Record<string, ThreadOptions>; attachments: Record<string, InternalAttachment[]> };
const draftsByEnvironment = new Map<string, LocalDraftState>();
const deliveryWarnings = new Map<string, string>();
let draftSaveTimer: number | undefined;
let draftRevision = 0;

function rememberDraftState() {
  draftsByEnvironment.set(connectionUrl(), { drafts: draftsByThread(), threads: unpromoted(), selectedId: openThreadId(), options: optionsByThread(), attachments: attachmentDrafts() });
}

function saveDraftStates() {
  rememberDraftState();
  const serializable = Object.fromEntries([...draftsByEnvironment].map(([endpoint, state]) => [endpoint, {
    ...state, attachments: Object.fromEntries(Object.entries(state.attachments).map(([threadId, items]) => [threadId,
      items.map(({ file: _file, ...item }) => item)])),
  }]));
  void Storage.setItem("draftStates", JSON.stringify(withDraftVersion(serializable))).catch(reportError);
}

function scheduleDraftSave() {
  draftRevision++;
  clearTimeout(draftSaveTimer);
  draftSaveTimer = setTimeout(() => { draftSavePending = false; saveDraftStates(); }, DRAFT_PERSIST_DEBOUNCE_MS);
  draftSavePending = true;
}

/** composerDraftStore.ts DEBOUNCE_MS (300) and its flush on unload: a pending draft save writes now. */
const DRAFT_PERSIST_DEBOUNCE_MS = 300;
let draftSavePending = false;
export function flushPendingDraftSave(): void {
  if (!draftSavePending) return;
  draftSavePending = false;
  clearTimeout(draftSaveTimer);
  saveDraftStates();
}

function readDraftState(value: unknown): LocalDraftState | null {
  const data = record(value);
  const rawDrafts = record(data?.drafts);
  if (!data || !rawDrafts || !Array.isArray(data.threads)) return null;
  const drafts: Record<string, string> = {};
  for (const [id, text] of Object.entries(rawDrafts)) if (typeof text === "string") drafts[id] = text;
  const threads: Thread[] = data.threads.map(record).flatMap((thread) => {
    if (!thread || typeof thread.id !== "string" || typeof thread.projectId !== "string" || typeof thread.title !== "string" ||
      typeof thread.updatedAt !== "number" || typeof thread.pinned !== "boolean" ||
      (thread.status !== "idle" && thread.status !== "running" && thread.status !== "awaiting" && thread.status !== "stopped")) return [];
    return [{ id: thread.id, projectId: thread.projectId, title: thread.title, updatedAt: thread.updatedAt, pinned: thread.pinned, status: thread.status }];
  });
  if (threads.length !== data.threads.length) return null;
  const options: Record<string, ThreadOptions> = {};
  const rawOptions = record(data.options);
  if (rawOptions) for (const [id, value] of Object.entries(rawOptions)) {
    const item = record(value);
    const workspace = record(item?.workspace);
    if (!item || !workspace || !isRuntimeMode(item.runtime) || !isInteractionMode(item.interaction)) continue;
    try {
      let strategy: WorkspaceStrategy;
      const branch = typeof workspace.branch === "string" ? workspace.branch : undefined;
      if (workspace.type === "root") strategy = { type: "root", ...(branch ? { branch } : {}) };
      else if (workspace.type === "existing_worktree" && typeof workspace.worktreePath === "string") strategy = { type: "existing_worktree", worktreePath: workspace.worktreePath, ...(branch ? { branch } : {}) };
      else if (workspace.type === "worktree" && typeof workspace.baseRef === "string") strategy = { type: "worktree", baseRef: workspace.baseRef, ...(branch ? { branch } : {}), ...(typeof workspace.startFromOrigin === "boolean" ? { startFromOrigin: workspace.startFromOrigin } : {}) };
      else continue;
      options[id] = { runtime: item.runtime, interaction: item.interaction, workspace: validWorkspaceStrategy(strategy) };
    } catch { /* Invalid saved choices fall back to the defaults. */ }
  }
  const attachments: Record<string, InternalAttachment[]> = {};
  const rawAttachments = record(data.attachments);
  if (rawAttachments) for (const [threadId, value] of Object.entries(rawAttachments)) {
    if (!Array.isArray(value)) continue;
    attachments[threadId] = value.map(record).flatMap((item) => {
      if (!item || typeof item.id !== "string" || typeof item.name !== "string" || typeof item.mimeType !== "string" ||
        typeof item.sizeBytes !== "number" || (item.kind !== "image" && item.kind !== "file")) return [];
      const uploadedId = typeof item.uploadedId === "string" ? item.uploadedId : undefined;
      return [{ id: item.id, name: item.name, mimeType: item.mimeType, sizeBytes: item.sizeBytes, kind: item.kind,
        status: uploadedId ? "ready" : "failed", ...(uploadedId ? { uploadedId } : { error: "Choose this file again to retry the upload." }) }];
    });
  }
  return { drafts, threads, selectedId: typeof data.selectedId === "string" ? data.selectedId : null, options, attachments };
}

function reportError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  connectionError.set(message.replace(/([?&](?:wsTicket|dpop|token|access_token)=)[^\s&]+/gi, "$1[redacted]"));
}

function clearEnvironment() {
  clearFamilyRemovals("");
  resetOlderSettled(null);
  if (unsubscribeThread) unsubscribeThread();
  unsubscribeThread = null;
  subscribedThreadId = null;
  currentDetailThreadId = null;
  shellProjects = [];
  shellThreads = [];
  archivedShellThreads = [];
  shellSnapshotReceived.set(false);
  shellCursor = null;
  shellOrigin = null;
  archived.set([]);
  archiveIsLoading.set(false);
  archiveProblem.set(null);
  projects.set([]);
  loose.set([]);
  unpromoted.set([]);
  transcripts.set({});
  stableSideMessages.clear();
  contextTransfersByThread.set({});
  automaticQueueMessages.set({});
  threadDetailCache.clear();
  snapshotLoadedFor.set(null);
  subscribingFor.set(null);
  pendingEchoes.set({});
  pendingQueuedSends.set({});
  threadErrors.set({});
  draftsByThread.set({});
  attachmentDrafts.set({});
  attachmentCapabilitiesKnownSignal.set(false);
  reportedAttachmentCapabilities.set({ supported: false, files: false, maxCount: MAX_ATTACHMENT_COUNT,
    maxImageBytes: MAX_IMAGE_BYTES, maxFileBytes: MAX_FILE_BYTES, maxTotalImageBytes: MAX_TOTAL_IMAGE_BYTES });
  optionsByThread.set({});
  serverOptionsByThread.set({});
  supportedModesByProvider.set({});
  supportsPlanByProvider.set({});
  runtimeCeiling.set(null);
  openThreadId.set(null);
  runtimeRequests.set([]);
  turnItems.set([]);
  turnItemOrders.set({});
  subagentRecords.set({});
  environments.set([]);
  models.set([]);
  providerList.set([]);
  providerListLoaded.set(false);
  projectOrganization.set(false);
  model.set(null);
}

function safeUrl(text: string): string {
  const url = new URL(text);
  if (url.protocol !== "ws:" && url.protocol !== "wss:") throw new Error("Enter a ws:// or wss:// environment URL");
  if (url.username || url.password) throw new Error("Credentials cannot be embedded in the URL");
  if (url.search || url.hash) throw new Error("Enter the server address without a query or fragment; use the pairing token field separately");
  return url.toString();
}

export function configureBackend(value: string, pairingToken = "", options?: { importLocalProviders?: boolean }) {
  const input = value.trim();
  let endpoint = "";
  if (input) {
    try {
      endpoint = safeUrl(input);
    } catch (error) {
      reportError(error);
      return;
    }
  }
  const previousEndpoint = connectionUrl();
  if (endpoint !== localBootstrapEndpoint) localServerEngineSignal.set(null);
  draftsByEnvironment.set(previousEndpoint, {
    drafts: draftsByThread(), threads: unpromoted(), selectedId: openThreadId(), options: optionsByThread(), attachments: attachmentDrafts(),
  });
  draftRevision++;
  const previous = client;
  client = null;
  const generation = ++connectionGeneration;
  managedImportGeneration = options?.importLocalProviders ? generation : null;
  clearTimeout(reconnectTimer);
  for (const controller of attachmentControllers.values()) controller.abort();
  attachmentControllers.clear();
  bearerToken = null;
  reconnectLadder.reset();
  previous?.close();
  clearEnvironment();
  connectionError.set(null);
  if (!input) {
    connectionUrl.set("");
    connectionStatus.set("disconnected");
    void Storage.removeItem("environmentUrl").catch(reportError);
    if (previousEndpoint) void forgetSessionBearer(previousEndpoint).catch(reportError);
    saveDraftStates();
    return;
  }
  connectionUrl.set(endpoint);
  const saved = draftsByEnvironment.get(endpoint) ?? (previousEndpoint === "" ? draftsByEnvironment.get("") : undefined);
  draftsByThread.set(saved?.drafts ?? {});
  attachmentDrafts.set(saved?.attachments ?? {});
  optionsByThread.set(saved?.options ?? {});
  unpromoted.set(saved?.threads ?? []);
  openThreadId.set(saved?.selectedId ?? null);
  saveDraftStates();
  if (deliveryWarnings.has(endpoint)) connectionError.set(deliveryWarnings.get(endpoint) ?? null);
  void Storage.setItem("environmentUrl", endpoint).catch(reportError);
  if (!pairingToken.trim()) {
    // No new pairing token: resume with the session credential this environment issued earlier.
    connectionStatus.set("disconnected");
    connectionError.set("Enter an environment pairing token to connect.");
    void resumeSavedSession(endpoint, generation);
    return;
  }
  connectionStatus.set("connecting");
  void exchangePairingToken(endpoint, pairingToken.trim()).then(async (bearer) => {
    // auth.ts bootstrapServerAuth: the exchanged session must read authenticated before the app goes on.
    await waitForAuthenticatedSession(endpoint, bearer);
    return bearer;
  }).then((bearer) => {
    if (generation !== connectionGeneration) return;
    bearerToken = bearer;
    void saveSessionBearer(endpoint, bearer).catch(reportError);
    void connectEnvironment(endpoint, generation);
  }).catch((error: unknown) => {
    if (generation !== connectionGeneration) return;
    connectionStatus.set("error");
    // The pairing page shows why the credential was refused (PairingRouteSurface's error alert).
    if (error instanceof Error) connectionError.set(error.message);
    reportError(error);
  });
}

/** Reconnects with the saved session credential of `endpoint`, when it has one. */
async function resumeSavedSession(endpoint: string, generation: number) {
  try {
    const saved = await loadSessionBearer(endpoint);
    if (!saved || generation !== connectionGeneration || bearerToken) return;
    bearerToken = saved;
    connectionError.set(null);
    await connectEnvironment(endpoint, generation);
  } catch (error) {
    reportError(error);
  }
}

async function connectEnvironment(endpoint: string, generation: number) {
  if (generation !== connectionGeneration || !bearerToken) return;
  const bearer = bearerToken;
  connectionStatus.set("connecting");
  try {
    // connection/compatibility.ts: a server on another orchestration protocol blocks the connection instead of retrying.
    const blocked = orchestrationProtocolCompatibilityError(await fetchEnvironmentDescriptor(endpoint));
    if (generation !== connectionGeneration) return;
    connectionBlockedSignal.set(blocked);
    if (blocked) {
      connectionStatus.set("error");
      connectionError.set(blocked.detail);
      return;
    }
    const socketUrl = await issueSocketUrl(endpoint, bearer);
    if (generation !== connectionGeneration) return;
    const next = new BackendClient((error) => {
      if (generation !== connectionGeneration) return;
      client = null;
      providerListLoaded.set(false);
      unsubscribeThread = null;
      subscribedThreadId = null;
      reportError(error);
      scheduleReconnect(endpoint, generation);
    });
    client = next;
    await next.connect(socketUrl);
    if (generation !== connectionGeneration) { next.close(); return; }
    connectionStatus.set("connected");
    if (!deliveryWarnings.has(endpoint)) connectionError.set(null);
    // rpc/session.ts: the config subscription is the session's own; when it fails or ends, the session is gone.
    const onConfigFailure = (error: Error) => {
      if (generation !== connectionGeneration || client !== next) return;
      next.close(error);
      client = null;
      providerListLoaded.set(false);
      unsubscribeThread = null;
      subscribedThreadId = null;
      reportError(error);
      scheduleReconnect(endpoint, generation);
    };
    serverConfigReplay = null;
    let configReady = false;
    next.subscribe("subscribeServerConfig", SERVER_CONFIG_STREAM_INPUT, (value) => {
      handleConfigEvent(value);
      if (configReady || record(value)?.type !== "snapshot" || generation !== connectionGeneration || client !== next) return;
      configReady = true;
      // supervisor.ts: the session is established once its config arrived; the ladder resets only after 30 s connected.
      reconnectLadder.established();
      // shell.ts / threads.ts read the session's initial config (omissions, threadSnapshotPagination) before subscribing.
      startShellStream(next, endpoint, generation);
      // Thread subscriptions resume at once after a reconnect (afterSequence), without waiting for the shell snapshot.
      subscribeOpenThread();
    }, onConfigFailure, () => onConfigFailure(new Error("The environment ended its configuration stream.")));
    syncSideSubscriptions();
    void flushDiscardedAttachments(endpoint);
    if (managedImportGeneration === generation) void importLocalProviderSettings(endpoint, generation);
  } catch (error) {
    if (generation !== connectionGeneration) return;
    client = null;
    reportError(error);
    if (error instanceof Error && (error.message.includes("HTTP 401") || error.message.includes("HTTP 403"))) {
      bearerToken = null;
      void forgetSessionBearer(endpoint).catch(reportError);
      connectionStatus.set("error");
      connectionError.set("Environment authorization expired. Enter a new pairing token.");
      return;
    }
    scheduleReconnect(endpoint, generation);
  }
}

/** Set while a shell stream runs: asks it to reload (snapshot-required) on the same session. */
let shellReloadRequested: (() => void) | null = null;
/** rpc/client.ts MAX_EXPECTED_FAILURE_RETRY_DELAY_MS, and shell.ts / threads.ts retryExpectedFailureAfter. */
const STREAM_RETRY_BASE_MS = 250;
const STREAM_RETRY_MAX_MS = 30000;
export const streamRetryDelay = (failures: number) => Math.min(STREAM_RETRY_MAX_MS, STREAM_RETRY_BASE_MS * 2 ** Math.min(failures, 7));
function isAuthorizationFailure(error: Error): boolean {
  return error instanceof RequestFailure && (error.tag === "EnvironmentAuthorizationError" || /authoriz/i.test(error.tag ?? ""));
}
/**
 * shell.ts subscribeDynamicWithSession: the shell stream retries on its own (250 ms, doubling to 30 s, reset by the first
 * item) and rebuilds its input each time, so a refusal or failure never takes the socket and the other streams down.
 */
function startShellStream(next: BackendClient, endpoint: string, generation: number) {
  const live = () => generation === connectionGeneration && client === next;
  const stream = runShellStream({
    client: next,
    live,
    prepare: () => prepareShellSubscribe(endpoint, bearerToken),
    receive: handleShellEvent,
    onError: reportError,
    stopRetrying: isAuthorizationFailure,
  });
  shellReloadRequested = () => { if (live()) stream.reload(); };
}

/** connection/model.ts ConnectionBlockedError for the primary environment, or null (OutdatedServerUpdateAction reads it). */
export interface ConnectionBlocked { reason: "unsupported"; detail: string; serverUpdateRequired?: true; descriptor: Record<string, unknown> }
const connectionBlockedSignal = signal<ConnectionBlocked | null>(null);
export const connectionBlocked = () => connectionBlockedSignal();
/** Test seam: the fetch the environment descriptor goes through. */
let descriptorFetch: typeof fetch = (input, init) => fetch(input, init);
export function setDescriptorFetchForTests(next: typeof fetch | null) { descriptorFetch = next ?? ((input, init) => fetch(input, init)); }
/** GET /.well-known/t3/environment, or null when it cannot be read (the socket then decides). */
export async function fetchEnvironmentDescriptor(endpoint: string): Promise<Record<string, unknown> | null> {
  try {
    const url = new URL(endpoint);
    url.protocol = url.protocol === "wss:" || url.protocol === "https:" ? "https:" : "http:";
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), 10000); });
    const load = (async () => {
      const response = await descriptorFetch(`${url.origin}/.well-known/t3/environment`, { method: "GET" });
      return response.status === 200 ? record(await response.json()) : null;
    })();
    const result = await Promise.race([load, timeout]);
    clearTimeout(timer);
    return result;
  } catch { return null; }
}
const ORCHESTRATION_PROTOCOL_VERSION = 2;
/** connection/compatibility.ts orchestrationProtocolCompatibilityError, copy included. */
export function orchestrationProtocolCompatibilityError(descriptor: Record<string, unknown> | null): ConnectionBlocked | null {
  if (!descriptor) return null;
  const label = typeof descriptor.label === "string" ? descriptor.label : "this environment";
  // Servers shipped before negotiation use the original wire protocol.
  const version = typeof descriptor.orchestrationProtocolVersion === "number" ? descriptor.orchestrationProtocolVersion : 1;
  if (version === ORCHESTRATION_PROTOCOL_VERSION) return null;
  if (version > ORCHESTRATION_PROTOCOL_VERSION) {
    return { reason: "unsupported", detail: `This client is not supported by this server. Update your app or use a compatible release to connect to ${label}.`, descriptor };
  }
  const caps = record(descriptor.capabilities);
  const selfUpdate = caps?.serverSelfUpdate !== undefined && (caps.serverSelfUpdate !== "desktop-managed" || caps.desktopAppUpdate === true);
  return { reason: "unsupported", detail: `This client requires a newer server. Update T3 Code on ${label} to connect.`, ...(selfUpdate ? { serverUpdateRequired: true as const } : {}), descriptor };
}

function scheduleReconnect(endpoint: string, generation: number) {
  if (generation !== connectionGeneration || !bearerToken) return;
  connectionStatus.set("connecting");
  const delay = reconnectLadder.nextDelay();
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => void connectEnvironment(endpoint, generation), delay);
}

export async function initializeBackend() {
  if (initialized) return;
  initialized = true;
  const generation = connectionGeneration;
  const bootstrapFile = process.env.T3GPUI_BOOTSTRAP_FILE;
  const localStartupFailed = process.env.T3GPUI_LOCAL_STARTUP_FAILED === "1";
  if (!localStartupFailed) void discoverLocalEnvironment(generation, !bootstrapFile);
  const revision = draftRevision;
  await ensureLegacyLocalStorageImported(); // One-time V1 Electron localStorage import; must finish before "draftStates" below is read.
  try {
    const [savedUrl, savedSettings, savedGeneral, savedDrafts] = await Promise.all([
      Storage.getItem("environmentUrl"), Storage.getItem("settings"), Storage.getItem("general"), Storage.getItem("draftStates"),
    ]);
    if (savedDrafts) {
      const parsed = record(JSON.parse(savedDrafts));
      const values = parsed ? readVersionedDrafts(parsed) : null;
      if (values) for (const [key, value] of Object.entries(values)) {
        try {
          if (key && safeUrl(key) !== key) continue;
          const state = readDraftState(value);
          if (state && !draftsByEnvironment.has(key)) draftsByEnvironment.set(key, state);
        } catch { /* Ignore an invalid saved environment key. */ }
      }
    }
    void Storage.getItem("stickyModel").then((saved) => {
      const pick = saved ? record(JSON.parse(saved)) : null;
      if (!stickyModelPick && pick && typeof pick.provider === "string" && typeof pick.model === "string") stickyModelPick = { provider: pick.provider, model: pick.model };
    }).catch(() => {});
    void Storage.getItem("modelOptions").then((saved) => {
      const values = saved ? record(JSON.parse(saved)) : null;
      if (!values) return;
      const restored: Record<string, { id: string; value: string | boolean }[]> = {};
      for (const [key, list] of Object.entries(values)) {
        if (!Array.isArray(list)) continue;
        const kept = list.flatMap((entry) => { const item = record(entry); return item && typeof item.id === "string" && (typeof item.value === "string" || typeof item.value === "boolean") ? [{ id: item.id, value: item.value }] : []; });
        if (kept.length > 0) restored[key] = kept;
      }
      // What was picked this session wins over what was saved.
      modelOptionSelections.update((current) => ({ ...restored, ...current }));
    }).catch(() => {});
    void Storage.getItem("draftModels").then((saved) => {
      const values = saved ? record(JSON.parse(saved)) : null;
      if (values) for (const [id, value] of Object.entries(values)) {
        const pick = record(value);
        if (!draftModelByThread[id] && pick && typeof pick.provider === "string" && typeof pick.model === "string") draftModelByThread[id] = { provider: pick.provider, model: pick.model };
      }
    }).catch(() => {});
    if (savedSettings) restoreSavedSettings(savedSettings);
    if (savedGeneral) {
      const values = record(JSON.parse(savedGeneral));
      if (values) {
        const current = general();
        general.set({
          inAppNotificationsEnabled: typeof values.inAppNotificationsEnabled === "boolean" ? values.inAppNotificationsEnabled : current.inAppNotificationsEnabled,
          sidebarProjectGroupingMode: typeof values.sidebarProjectGroupingMode === "string" ? values.sidebarProjectGroupingMode : current.sidebarProjectGroupingMode,
          sidebarProjectSortOrder: typeof values.sidebarProjectSortOrder === "string" ? values.sidebarProjectSortOrder : current.sidebarProjectSortOrder,
          sidebarWorkingShelfEnabled: typeof values.sidebarWorkingShelfEnabled === "boolean" ? values.sidebarWorkingShelfEnabled : current.sidebarWorkingShelfEnabled,
          confirmThreadUnpin: typeof values.confirmThreadUnpin === "boolean" ? values.confirmThreadUnpin : current.confirmThreadUnpin,
          confirmThreadArchive: typeof values.confirmThreadArchive === "boolean" ? values.confirmThreadArchive : current.confirmThreadArchive,
          confirmThreadDelete: typeof values.confirmThreadDelete === "boolean" ? values.confirmThreadDelete : current.confirmThreadDelete,
          timestampFormat: typeof values.timestampFormat === "string" ? values.timestampFormat : current.timestampFormat,
        });
      }
    }
    let restoredUrl = "";
    if (savedUrl) {
      try { restoredUrl = safeUrl(savedUrl); }
      catch { reportError(new Error("Saved environment address is invalid. Enter it again in Connections.")); }
    }
    if (restoredUrl && generation === connectionGeneration) {
      connectionUrl.set(restoredUrl);
      const saved = draftsByEnvironment.get(restoredUrl);
      if (saved && revision === draftRevision) {
        draftsByThread.set(saved.drafts);
        attachmentDrafts.set(saved.attachments);
        optionsByThread.set(saved.options);
        unpromoted.set(saved.threads);
        openThreadId.set(saved.selectedId);
      }
      connectionError.set("Enter an environment pairing token to connect.");
      void resumeSavedSession(restoredUrl, generation);
    } else if (!restoredUrl && generation === connectionGeneration && revision === draftRevision) {
      const saved = draftsByEnvironment.get("");
      if (saved) {
        draftsByThread.set(saved.drafts);
        attachmentDrafts.set(saved.attachments);
        optionsByThread.set(saved.options);
        unpromoted.set(saved.threads);
        openThreadId.set(saved.selectedId);
      }
    }
  } catch (error) {
    reportError(error);
  }
  if (bootstrapFile || localStartupFailed) {
    try {
      if (!bootstrapFile) throw new Error("The packaged launcher could not start the local server.");
      const bootstrap = await consumeLocalBootstrap(bootstrapFile);
      if (bootstrap.additionalEnvironments?.length && generation === connectionGeneration) {
        void Promise.allSettled(bootstrap.additionalEnvironments.map((entry) => upsertBootstrapSavedEnvironment(entry)));
      }
      // environments/primary/target.ts PrimaryEnvironmentDisabledError: with the Local environment switch off
      // (pages/settings/environments/LocalEnvironment.tsx) the app does not connect to this computer's server.
      if (await Storage.getItem("localEnvironmentDisabled").catch(() => null) === "1") {
        if (generation === connectionGeneration) { connectionStatus.set("disconnected"); connectionError.set(LOCAL_ENVIRONMENT_DISABLED_MESSAGE); }
        return;
      }
      if (generation === connectionGeneration) {
        localBootstrapEndpoint = safeUrl(bootstrap.endpoint);
        localServerEngineSignal.set(bootstrap.serverEngine ?? null);
        configureBackend(bootstrap.endpoint, bootstrap.token, { importLocalProviders: bootstrap.importProviders });
        // app/DesktopStartupRecovery.ts records the build only once it is known to work: a bootstrap this far
        // along means the launcher's handshake with this build succeeded, so it is a build worth reinstalling
        // if a later launch of a different one fails here.
        void recordStartedVersion(CLIENT_APP_VERSION);
        clearStartupRecovery();
      }
    } catch {
      // DesktopStartupRecovery: the local backend never came up (the launcher's bootstrap handshake failed, not a
      // later disconnect, which `connectEnvironment`'s own reconnect ladder already handles). Block startup behind
      // the recovery screen instead of leaving a silent connection error.
      if (generation === connectionGeneration) {
        connectionStatus.set("error");
        connectionError.set("Could not start the local environment. Restart the app.");
        void lastStartedVersion().then((version) => {
          // A managed-policy offer already up always wins (resolveStartupRecoveryOffer); don't race it off the screen.
          if (generation === connectionGeneration && startupRecoveryOffer()?.kind !== "managed-policy") {
            presentStartupRecovery(resolveStartupRecoveryOffer({ managedPolicyError: null, lastStartedVersion: version, currentVersion: CLIENT_APP_VERSION }));
          }
        });
      }
    }
  }
}

function providerFromValue(value: unknown): ProviderStatus | null {
  const provider = record(value);
  if (!provider || typeof provider.instanceId !== "string") return null;
  const auth = record(provider.auth);
  const setup = record(provider.setup);
  const models = Array.isArray(provider.models) ? provider.models.map(record).flatMap((entry) =>
    entry && typeof entry.slug === "string" ? [{ id: entry.slug, name: typeof entry.name === "string" ? entry.name : entry.slug }] : []) : [];
  return { instanceId: provider.instanceId, driver: typeof provider.driver === "string" ? provider.driver : provider.instanceId,
    name: typeof provider.displayName === "string" ? provider.displayName : provider.instanceId,
    enabled: provider.enabled === true, installed: provider.installed === true, available: provider.availability !== "unavailable",
    status: typeof provider.status === "string" ? provider.status : "unknown", authStatus: typeof auth?.status === "string" ? auth.status : "unknown",
    authLabel: typeof auth?.label === "string" ? auth.label : null, version: typeof provider.version === "string" ? provider.version : null,
    unavailableReason: typeof provider.unavailableReason === "string" ? provider.unavailableReason : null,
    message: typeof provider.message === "string" ? provider.message : null, checkedAt: typeof provider.checkedAt === "string" ? provider.checkedAt : null,
    canInstall: setup?.canInstall === true, canAuthenticate: setup?.canAuthenticate === true, models,
    updateState: record(provider.updateState) ? { status: String(record(provider.updateState)?.status ?? "idle"), message: typeof record(provider.updateState)?.message === "string" ? String(record(provider.updateState)?.message) : null, finishedAt: typeof record(provider.updateState)?.finishedAt === "string" ? String(record(provider.updateState)?.finishedAt) : null } : null,
    latestVersion: typeof record(provider.versionAdvisory)?.latestVersion === "string" ? String(record(provider.versionAdvisory)?.latestVersion) : null };
}

/** environments/primary/target.ts PrimaryEnvironmentDisabledError's message. */
export const LOCAL_ENVIRONMENT_DISABLED_MESSAGE = "The local environment is disabled.";

async function discoverLocalEnvironment(generation: number, allowPrefill = true) {
  let home: string;
  try { home = homedir(); }
  catch { cachedProviderListLoaded.set(true); return; }
  if (!home) { cachedProviderListLoaded.set(true); return; }
  const root = join(home, ".t3");
  void (async () => {
    const providers: ProviderStatus[] = [];
    try {
      const directory = join(root, "caches");
      const names = (await readdir(directory)).filter((name) => /^[a-z0-9_-]+\.json$/i.test(name)).slice(0, 128);
      for (const name of names) {
        try {
          const path = join(directory, name);
          const info = await stat(path);
          if (!info.isFile() || info.size > 2 * 1024 * 1024) continue;
          const provider = providerFromValue(JSON.parse(await readFile(path, "utf8")));
          if (provider) providers.push(provider);
        } catch { /* A stale or unreadable cache entry is skipped. */ }
      }
    } catch { /* A machine without a T3 cache has nothing to display. */ }
    cachedProviderList.set(providers.sort((a, b) => a.name.localeCompare(b.name)));
    cachedProviderListLoaded.set(true);
  })();
  const candidates: LocalEnvironmentCandidate[] = [];
  for (const directory of ["userdata", "dev"]) {
    try {
      const state = record(JSON.parse(await readFile(join(root, directory, "server-runtime.json"), "utf8")));
      if (!state || typeof state.origin !== "string") continue;
      const origin = new URL(state.origin);
      if (origin.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname) || origin.username || origin.password) continue;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2500);
      let response: Response;
      try { response = await fetch(new URL("/.well-known/t3/environment", origin).toString(), { redirect: "error", signal: controller.signal }); }
      finally { clearTimeout(timeout); }
      if (!response.ok) continue;
      const descriptor = record(await response.json());
      if (!descriptor || typeof descriptor.label !== "string" || typeof descriptor.serverVersion !== "string" || descriptor.orchestrationProtocolVersion !== 2) continue;
      const endpoint = `ws://${origin.host}/ws`;
      if (!candidates.some((item) => item.endpoint === endpoint)) candidates.push({ endpoint, label: descriptor.label, serverVersion: descriptor.serverVersion });
    } catch { /* Ignore stale state or an unavailable local server. */ }
  }
  localCandidates.set(candidates);
  if (allowPrefill && generation === connectionGeneration && !connectionUrl() && candidates[0]) {
    connectionUrl.set(candidates[0].endpoint);
    connectionError.set("Local environment found. Pair it to connect.");
  }
}

let requestOverrideForTest: ((method: string, payload: unknown) => Promise<unknown>) | null = null;
/** Test seam: answers requestBackend in place of a connection (null restores the real client). */
export function setRequestBackendForTest(handler: ((method: string, payload: unknown) => Promise<unknown>) | null) {
  requestOverrideForTest = handler;
}
function linkedPullRequestOf(value: unknown): { projectId: string; repository: string; number: number; url: string } | null {
  const link = record(value);
  return link && typeof link.projectId === "string" && typeof link.repository === "string" && typeof link.number === "number" && typeof link.url === "string"
    ? { projectId: link.projectId, repository: link.repository, number: link.number, url: link.url } : null;
}
let pullRequestRouter: ((method: string, payload: unknown, options?: { timeoutMs?: number }) => Promise<unknown>) | null = null;
/** client-runtime pullRequestRouting.ts: every pullRequests.* call goes through the router once it is installed. */
export function setPullRequestRouter(router: typeof pullRequestRouter) { pullRequestRouter = router; }
export function requestBackend(method: string, payload: unknown, options?: { timeoutMs?: number }): Promise<unknown> {
  if (requestOverrideForTest) return requestOverrideForTest(method, payload);
  if (pullRequestRouter && method.startsWith("pullRequests.")) return pullRequestRouter(method, payload, options);
  return requestBackendUnrouted(method, payload, options);
}
/** requestBackend without the pull request router (the router's own transport). */
export function requestBackendUnrouted(method: string, payload: unknown, options?: { timeoutMs?: number }): Promise<unknown> {
  if (requestOverrideForTest) return requestOverrideForTest(method, payload);
  try {
    const routed = routePayload(payload);
    if (routed) return trackRpcPromise(method, requestEnvironment(routed.environmentId, method, routed.payload, options).then((value) => scopeResult(routed.environmentId, value)));
  } catch (error) { return Promise.reject(error); }
  if (!client || connectionStatus() !== "connected") return Promise.reject(new Error("Connect an environment first"));
  if (method === "server.getConfig") return sharedServerConfig(client, options);
  const current = client;
  // state/server.ts configConcurrency "serial": config edits run one at a time per environment.
  if (isSerialConfigMethod(method)) return trackRpcPromise(method, runInConfigLane(connectionUrl() || "primary", () => current.request(method, payload, options)));
  // createEnvironmentRpcCommand concurrency (singleFlight / serial lanes) and refreshProviders flags, as the reference.
  return trackRpcPromise(method, requestWithRpcPolicy(connectionUrl() || "primary", method, payload, (sent) => current.request(method, sent, options)));
}

/**
 * connection/supervisor.ts: when the app comes back to the front, the connection is checked with `server.probe`
 * (CONNECTION_PROBE_TIMEOUT 15 s). An unanswered probe replaces the socket (a reconnect); an RPC error answer is an answer.
 */
export const CONNECTION_PROBE_TIMEOUT_MS = 15_000;
export function probeConnection(current: BackendClient | null = client): Promise<"alive" | "replaced" | "skipped"> {
  if (!current || connectionStatus() !== "connected") return Promise.resolve("skipped");
  return current.request("server.probe", {}, { timeoutMs: CONNECTION_PROBE_TIMEOUT_MS }).then(
    () => "alive" as const,
    (error: unknown) => {
      if (error instanceof RequestFailure) return "alive" as const;
      current.abandon(new Error("The environment did not respond to a connection health check."));
      return "replaced" as const;
    },
  );
}
let probeWasActive = true;
effect(() => {
  const active = lifecycle() === "active";
  const woke = active && !probeWasActive;
  probeWasActive = active;
  if (woke) void untracked(() => {
    probeEnvironments(CONNECTION_PROBE_TIMEOUT_MS);
    // threads.ts foregroundResubscriptions: a surviving socket's open thread resubscribes (resuming after its sequence).
    void probeConnection().then((result) => { if (result === "alive") resubscribeOpenThreadOnForeground(); });
  });
});

/**
 * One `server.getConfig` per connection, shared by every reader (the web reads it once per session and keeps it current
 * from the config stream). A config stream snapshot replaces the cached answer; any other config event drops it so the next
 * reader fetches the current config once.
 */
let sharedConfig: { client: BackendClient; value: Promise<unknown> } | null = null;
function sharedServerConfig(current: BackendClient, options?: { timeoutMs?: number }): Promise<unknown> {
  if (sharedConfig?.client === current) return sharedConfig.value;
  const entry = { client: current, value: trackRpcPromise("server.getConfig", current.request("server.getConfig", {}, options)) };
  sharedConfig = entry;
  entry.value.catch(() => { if (sharedConfig === entry) sharedConfig = null; });
  return entry.value;
}
function refreshSharedServerConfig(event: Record<string, unknown>) {
  const config = event.type === "snapshot" ? record(event.config) : null;
  sharedConfig = config && client ? { client, value: Promise.resolve(config) } : null;
}

async function importLocalProviderSettings(endpoint: string, generation: number): Promise<void> {
  if (providerImportInFlight === generation) return;
  providerImportInFlight = generation;
  const active = () => generation === connectionGeneration && managedImportGeneration === generation && backendStatus() === "connected";
  const marker = `localProviderImport:${endpoint}`;
  try {
    if (await Storage.getItem(marker) || !active()) return;
    let source: unknown;
    try {
      const path = join(homedir(), ".t3", "dev", "settings.json");
      const info = await stat(path);
      if (!info.isFile() || info.size > 2 * 1024 * 1024) throw new Error("Invalid settings file");
      source = JSON.parse(await readFile(path, "utf8"));
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
        if (active()) await Storage.setItem(marker, "done");
        return;
      }
      throw error;
    }
    if (!active()) return;
    const target = record(await requestBackend("server.getConfig", {}));
    const existing = record(record(target?.settings)?.providerInstances);
    if (!existing) throw new Error("Provider settings are unavailable");
    for (const candidate of importableProviderInstances(source)) {
      if (!active()) return;
      if (Object.prototype.hasOwnProperty.call(existing, candidate.instanceId)) continue;
      try {
        await requestBackend("server.updateSettings", { patch: {}, providerInstanceMutation: { operation: "create", ...candidate } });
      } catch (error) {
        if (!active()) return;
        // A concurrent settings edit may have created this instance after the snapshot.
        const latest = record(await requestBackend("server.getConfig", {}));
        const instances = record(record(latest?.settings)?.providerInstances);
        if (!instances || !Object.prototype.hasOwnProperty.call(instances, candidate.instanceId)) throw error;
      }
    }
    if (active()) await Storage.setItem(marker, "done");
  } catch {
    if (active() && !connectionError()) connectionError.set("Some local provider settings could not be imported. Restart the app to retry.");
  } finally {
    if (providerImportInFlight === generation) providerImportInFlight = null;
  }
}

export async function setProviderEnabled(instanceId: string, enabled: boolean): Promise<void> {
  try {
    const generation = connectionGeneration;
    const config = await requestBackend("server.getConfig", {});
    if (generation !== connectionGeneration) throw new Error("The environment changed before the provider could be updated");
    const mutation = providerToggleMutation(config, instanceId, enabled);
    await requestBackend("server.updateSettings", { patch: {}, providerInstanceMutation: mutation });
  } catch (error) {
    reportError(error);
    throw error;
  }
}

export async function createProviderInstance(input: { instanceId: string; driver: string; displayName: string }): Promise<void> {
  try {
    const { instanceId, driver, displayName } = input;
    if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(instanceId) || !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(driver) || !displayName.trim()) {
      throw new Error("Enter a valid provider id, type and name");
    }
    await requestBackend("server.updateSettings", { patch: {}, providerInstanceMutation: {
      operation: "create", instanceId, instance: { driver, displayName: displayName.trim() },
    } });
  } catch (error) {
    reportError(error);
    throw error;
  }
}

/** EnvironmentRpcSubscriptionObserver (backgroundActivityReporter.ts layerObserver): told of every primary-environment
 * stream started through subscribeBackend; the release it returns runs when that stream is stopped. */
let subscriptionObserver: ((method: string, payload: unknown) => () => void) | null = null;
export function setSubscriptionObserver(observer: ((method: string, payload: unknown) => () => void) | null) { subscriptionObserver = observer; }

/** `onEnd`, when given, receives a normal end of the stream (backend/client.ts), which is then not an error. */
export function subscribeBackend(method: string, payload: unknown, onValue: (value: unknown) => void, onError: (error: Error) => void, onEnd?: () => void): () => void {
  let routedHere = false;
  try { routedHere = routePayload(payload) !== null; } catch { routedHere = true; }
  const observed = routedHere ? null : (subscriptionObserver?.(method, payload) ?? null);
  if (observed) { const stop = subscribeBackendUnobserved(method, payload, onValue, onError, onEnd); let done = false; return () => { stop(); if (!done) { done = true; observed(); } }; }
  return subscribeBackendUnobserved(method, payload, onValue, onError, onEnd);
}

function subscribeBackendUnobserved(method: string, payload: unknown, onValue: (value: unknown) => void, onError: (error: Error) => void, onEnd?: () => void): () => void {
  let routed: ReturnType<typeof routePayload> = null;
  try { routed = routePayload(payload); } catch (error) { onError(error instanceof Error ? error : new Error(String(error))); return () => {}; }
  if (routed) { const target = routed.environmentId; return subscribeEnvironment(target, method, routed.payload, (value) => onValue(scopeResult(target, value)), onError); }
  const current = client;
  if (!current || connectionStatus() !== "connected") {
    onError(new Error("Connect an environment first"));
    return () => {};
  }
  const generation = connectionGeneration;
  return current.subscribe(method, payload, (value) => {
    if (generation === connectionGeneration && current === client) onValue(value);
  }, (error) => {
    if (generation === connectionGeneration) onError(error);
  }, onEnd ? () => { if (generation === connectionGeneration) onEnd(); } : undefined);
}

const providerSetup = new ProviderSetupClient({
  request: (method, payload) => requestBackend(method, payload),
  subscribe: (method, payload, onValue, onError) => subscribeBackend(method, payload, onValue, onError),
  generation: () => connectionGeneration,
});

function liveProvider(instanceId: string): ProviderStatus {
  if (backendStatus() !== "connected") throw new Error("Connect an environment first");
  const provider = providersLoaded() ? providerStatuses().find((item) => item.instanceId === instanceId) : undefined;
  if (!provider) throw new Error("Provider status is unavailable");
  return provider;
}

async function providerAction<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); }
  catch (error) { reportError(error); throw error; }
}

export function subscribeProviderAuth(instanceId: string, onState: (state: ProviderAuthState) => void, onError: (error: Error) => void): () => void {
  return providerSetup.subscribeAuth(instanceId, onState, onError);
}
export function subscribeProviderInstall(instanceId: string, onState: (state: ProviderInstallState) => void, onError: (error: Error) => void): () => void {
  return providerSetup.subscribeInstall(instanceId, onState, onError);
}
export function startProviderAuth(instanceId: string, options?: ProviderAuthStartOptions): Promise<ProviderAuthState> {
  return providerAction(() => {
    const provider = liveProvider(instanceId);
    if (!provider.enabled || !provider.installed || (!provider.canAuthenticate && provider.driver !== "acpRegistry")) {
      throw new Error("This provider does not currently support sign-in");
    }
    return providerSetup.startAuth(instanceId, options);
  });
}
export function respondProviderAuth(instanceId: string, flowId: string, interactionId: string, response: ProviderAuthResponse): Promise<ProviderAuthState> {
  return providerAction(() => providerSetup.respondAuth(instanceId, flowId, interactionId, response));
}
export function completeProviderAuth(instanceId: string, flowId: string, callbackUrl: string): Promise<ProviderAuthState> {
  return providerAction(() => providerSetup.completeAuth(instanceId, flowId, callbackUrl));
}
export function cancelProviderAuth(instanceId: string, flowId: string): Promise<ProviderAuthState> {
  return providerAction(() => providerSetup.cancelAuth(instanceId, flowId));
}
export function logoutProvider(instanceId: string): Promise<ProviderAuthState> {
  return providerAction(() => providerSetup.logout(instanceId));
}
export function removeProviderAuthMethod(instanceId: string, methodId: string): Promise<ProviderAuthState> {
  return providerAction(() => providerSetup.removeAuthMethod(instanceId, methodId));
}
export function startProviderInstall(instanceId: string): Promise<ProviderInstallState> {
  return providerAction(() => {
    if (!liveProvider(instanceId).canInstall) throw new Error("This provider does not currently support installation");
    return providerSetup.startInstall(instanceId);
  });
}
export function cancelProviderInstall(instanceId: string, operationId: string): Promise<ProviderInstallState> {
  return providerAction(() => providerSetup.cancelInstall(instanceId, operationId));
}
export function removeProviderInstall(instanceId: string): Promise<ProviderInstallState> {
  return providerAction(() => providerSetup.removeInstall(instanceId));
}
export function refreshProviderStatuses(options: { instanceId?: string; fresh?: boolean; refreshModels?: boolean; reloadSecrets?: boolean } = {}): Promise<ProviderStatus[]> {
  return providerAction(async () => {
    if (backendStatus() !== "connected") throw new Error("Connect an environment first");
    const generation = connectionGeneration;
    let result: unknown;
    try { result = await requestBackend("server.refreshProviders", options); }
    catch (error) {
      if (generation !== connectionGeneration) throw new Error("The environment changed during provider refresh");
      throw new Error(error instanceof Error && error.message.startsWith("Request timed out") ? "Provider refresh timed out. Try again." : "Could not refresh providers. Try again.");
    }
    if (generation !== connectionGeneration) throw new Error("The environment changed during provider refresh");
    const value = record(result);
    if (!Array.isArray(value?.providers)) throw new Error("The environment returned an invalid provider list");
    const providers = value.providers.map(providerFromValue);
    if (providers.some((provider) => !provider)) throw new Error("The environment returned an invalid provider list");
    return providers.filter((provider): provider is ProviderStatus => provider !== null);
  });
}

/**
 * useProviderWorkspaceSnapshotRefresh's request: rescan one provider's workspace (skills and slash commands) for `cwd`.
 * Resolves with that provider's raw record as the server returned it, and keeps it so the composer reads the new
 * snapshot at once; rejects on failure (the caller cools down and retries).
 */
export async function refreshProviderWorkspaceSnapshot(instanceId: string, cwd: string): Promise<Record<string, unknown> | undefined> {
  if (backendStatus() !== "connected") throw new Error("Connect an environment first");
  const generation = connectionGeneration;
  const endpoint = connectionUrl();
  const value = record(await requestBackend("server.refreshProviders", { instanceId, cwd, workspaceSnapshotsOnDemand: true }));
  if (generation !== connectionGeneration || !Array.isArray(value?.providers)) return undefined;
  const fresh = value.providers.map(record).find((item) => item?.instanceId === instanceId) ?? undefined;
  if (workspaceSnapshotsOnDemandCapability) {
    // state/server.ts refreshProviders onSuccess: keep the fetched snapshot and merge it into the config's providers.
    const current = fetchedWorkspaceSnapshots.get(endpoint) ?? [];
    const next = recordFetchedWorkspaceSnapshot(current, { instanceId, cwd, fresh: false }, value.providers, configProviderRecords.find((item) => item.instanceId === instanceId));
    if (next !== current) fetchedWorkspaceSnapshots.set(endpoint, next);
    rawProviders.set(withFetchedWorkspaceSnapshots(configProviderRecords, next, true));
  } else if (fresh) rawProviders.set(rawProviders().map((item) => (item.instanceId === instanceId ? fresh : item)));
  return fresh;
}

function attachmentFor(endpoint: string, generation: number, threadId: string, id: string): InternalAttachment | undefined {
  const all = generation === connectionGeneration && endpoint === connectionUrl()
    ? attachmentDrafts() : draftsByEnvironment.get(endpoint)?.attachments;
  return all?.[threadId]?.find((item) => item.id === id);
}

function updateAttachment(endpoint: string, generation: number, threadId: string, id: string, patch: Partial<InternalAttachment>) {
  if (generation === connectionGeneration && endpoint === connectionUrl()) {
    attachmentDrafts.update((all) => {
      // A question's attachments move between the thread key and its question bucket while they upload.
      const base = threadId.split("\u0000")[0];
      const owner = (all[threadId] ?? []).some((item) => item.id === id) ? threadId
        : Object.keys(all).find((candidate) => (candidate === base || candidate.startsWith(`${base}\u0000`)) && all[candidate].some((item) => item.id === id)) ?? threadId;
      return { ...all, [owner]: (all[owner] ?? []).map((item) => item.id === id ? { ...item, ...patch } : item) };
    });
    scheduleDraftSave();
    return;
  }
  const cached = draftsByEnvironment.get(endpoint);
  if (!cached) return;
  draftsByEnvironment.set(endpoint, { ...cached, attachments: { ...cached.attachments,
    [threadId]: (cached.attachments[threadId] ?? []).map((item) => item.id === id ? { ...item, ...patch } : item) } });
  saveDraftStates();
}

const WORKSPACE_IMAGE_PREVIEW_EXTENSIONS = [".avif", ".bmp", ".gif", ".ico", ".jpeg", ".jpg", ".png", ".svg", ".tif", ".tiff", ".webp"];
/** composerAttachmentFiles.ts classifyComposerAttachmentFile's "unsupported-image" (SVG, DNG and HEIC/HEIF stay files here: no re-encode on this runtime). */
export function isUnsupportedComposerImage(name: string, mimeType: string): boolean {
  const lower = name.toLowerCase();
  if (!mimeType.startsWith("image/") || IMAGE_TYPES.includes(mimeType)) return false;
  if (mimeType === "image/svg+xml" || lower.endsWith(".svg") || lower.endsWith(".dng") || /^image\/(x-)?(adobe-)?dng$/.test(mimeType)) return false;
  if (/^image\/hei[cf](-sequence)?$/.test(mimeType) || /\.hei[cf]$/.test(lower)) return false;
  return !WORKSPACE_IMAGE_PREVIEW_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

/**
 * attachmentsToReleaseOnUploadCapabilityLoss: when the server stops offering uploads (reconnect, version skew) the uploads of images
 * and not-yet-uploaded files are released so they upload again later; an uploaded file keeps its server copy (hydrated files still
 * need it). A restored entry without its bytes has nothing to re-upload from, so it also stays.
 */
/** `only` narrows the release (ChatComposer's oversize files: a smaller limit releases the uploads of files over it). */
export function releaseUnpersistedUploads(only?: (item: InternalAttachment) => boolean): void {
  let changed = false;
  const next: Record<string, InternalAttachment[]> = {};
  for (const [threadId, items] of Object.entries(attachmentDrafts())) {
    const released = new Set(attachmentsToReleaseOnUploadCapabilityLoss(only ? items.filter(only) : items).map((item) => item.id));
    next[threadId] = items.map((item) => {
      if (!released.has(item.id)) return item;
      attachmentOperations.delete(item.id);
      attachmentControllers.get(item.id)?.abort();
      attachmentControllers.delete(item.id);
      if (item.uploadedId && backendStatus() === "connected") void requestBackend("attachments.delete", { attachmentId: item.uploadedId }).catch(() => {});
      changed = true;
      const { uploadedId: _released, error: _error, ...rest } = item;
      return { ...rest, status: "ready" as const };
    });
  }
  if (!changed) return;
  attachmentDrafts.set(next);
  scheduleDraftSave();
}

/** Drafts sent with composer.sendBackground whose send is still in flight (their failure toasts "Background task failed"). */
const backgroundSendIds = new Set<string>();
export function markBackgroundSend(id: string): void { backgroundSendIds.add(id); }

/** composerDraftStore.ts composerFileDedupKey. */
export const composerFileDedupKey = (file: { mimeType: string; sizeBytes: number; name: string }) => `${file.mimeType}\u0000${file.sizeBytes}\u0000${file.name}`;

export async function addAttachment(file: File, extra: { source?: unknown } = {}): Promise<void> {
  const threadId = scopeId();
  if (!threadId) throw new Error("Open a thread before attaching a file");
  const name = file.name.trim();
  // composerFileAttachmentMimeType: a video keeps its video type even when the source gave none or a generic one.
  const mimeType = videoMimeType({ name, mimeType: file.type }) ?? attachmentMimeType(name, file.type);
  const kind = IMAGE_TYPES.includes(mimeType) ? "image" : "file";
  // classifyComposerAttachmentFile: an image type providers cannot take, and that is not previewable as a file, is refused.
  if (isUnsupportedComposerImage(name, mimeType)) throw new Error(`'${name}' is not a supported image type. Attach GIF, HEIC, HEIF, JPEG, PNG, or WebP images.`);
  const caps = attachmentCapabilities();
  // useComposerAttachmentIntake: while a question is asked, attachments go with its answer, when it can take them.
  const asking = activeUserInputQuestions()[threadId];
  if (threadUserInputsFor(threadId).length > 0 && (!caps.supported || asking?.allowCustomAnswer === false || asking?.responding === true)) {
    throw new Error("This question cannot accept attachments.");
  }
  const current = attachmentDrafts()[threadId] ?? [];
  if (!name || name.length > 255 || mimeType.length > 100) throw new Error("The attachment name or type is invalid");
  if (current.length >= caps.maxCount) throw new Error(`A message can have at most ${caps.maxCount} attachments`);
  // useComposerAttachmentIntake's file refusals, in its order and copy.
  if (kind === "file" && backendStatus() === "connected" && (!caps.supported || !caps.files)) throw new Error("This server does not support file attachments.");
  if (kind === "file" && (!Number.isFinite(file.size) || file.size <= 0)) throw new Error(`'${name}' is empty or could not be read.`);
  if (kind === "file" && file.size > Math.min(MAX_FILE_BYTES, backendStatus() === "connected" ? caps.maxFileBytes : MAX_FILE_BYTES)) throw new Error(fileAttachmentTooLargeMessage(name, Math.min(MAX_FILE_BYTES, backendStatus() === "connected" ? caps.maxFileBytes : MAX_FILE_BYTES)));
  if (!Number.isFinite(file.size) || file.size < 1 || file.size > (kind === "image" ? MAX_IMAGE_BYTES : MAX_FILE_BYTES)) throw new Error(kind === "image" ? "Images must be between 1 byte and 10 MiB" : "Files must be between 1 byte and 50 MiB");
  if (kind === "image" && current.filter((item) => item.kind === "image").reduce((sum, item) => sum + item.sizeBytes, file.size) > caps.maxTotalImageBytes) throw new Error("Images can total up to 80 MiB per message");
  if (backendStatus() === "connected" && !(kind === "image" && attachmentsUseDataUrls()) && (!caps.supported || (kind === "file" && (!caps.files || file.size > caps.maxFileBytes)))) {
    throw new Error(kind === "file" ? "This environment does not support this file attachment" : "This environment does not support attachment uploads");
  }
  // composerFileDedupKey: the same file (type, size, name) added again is dropped, or fills a restored entry that lost its bytes.
  if (kind === "file") {
    const duplicate = current.find((item) => item.kind === "file" && composerFileDedupKey(item) === composerFileDedupKey({ mimeType, sizeBytes: file.size, name }));
    if (duplicate) {
      if (duplicate.file || duplicate.uploadedId) return;
      attachmentDrafts.update((all) => ({ ...all, [threadId]: (all[threadId] ?? []).map((item) => (item.id === duplicate.id ? { ...item, file, status: "ready", error: undefined } : item)) }));
      scheduleDraftSave();
      if (backendStatus() === "connected") await uploadAttachment(threadId, duplicate.id);
      return;
    }
  }
  const id = `attachment-${crypto.randomUUID()}`;
  attachmentDrafts.update((all) => ({ ...all, [threadId]: [...(all[threadId] ?? []), { id, name, mimeType, sizeBytes: file.size, kind, status: "ready", file, ...(extra.source !== undefined && kind === "image" ? { source: extra.source } : {}) }] }));
  // insertAttachmentReferences: the attachment shows as an inline chip in the prompt (appended at its end here). An image gets one only
  // when the prompt already has text of its own or a question is being answered (imageAttachmentsGetChips); a file always does.
  const imageGetsChip = kind === "image" && (threadUserInputsFor(threadId).length > 0 || stripInlineContextReferences(draftsByThread()[threadId] ?? "").trim().length > 0);
  if (kind === "file" || imageGetsChip) draftsByThread.update((all) => ({ ...all, [threadId]: appendAttachmentReference(all[threadId] ?? "", { id, kind, name }) }));
  scheduleDraftSave();
  if (backendStatus() === "connected" && !attachmentsUseDataUrls()) await uploadAttachment(threadId, id);
}

export async function addAttachmentPath(path: string, extra: { source?: unknown } = {}): Promise<void> {
  const id = scopeId();
  const scoped = scopeOverride !== null;
  const generation = connectionGeneration;
  if (!path.trim()) throw new Error("Enter a local file path");
  const file = await attachmentFileFromPath(path);
  if (generation !== connectionGeneration || (!scoped && id !== openThreadId())) throw new Error("The thread changed while reading the file; attach it again");
  await withThreadScope(scoped ? id : null, () => addAttachment(file, extra));
}

export async function retryAttachment(id: string): Promise<void> {
  const threadId = scopeId();
  if (!threadId) throw new Error("Open the thread containing this attachment");
  await uploadAttachment(threadId, id);
}

async function uploadAttachment(threadId: string, id: string): Promise<void> {
  const endpoint = connectionUrl();
  const generation = connectionGeneration;
  const item = attachmentFor(endpoint, generation, threadId, id);
  if (!item) throw new Error("Attachment is no longer in this draft");
  if (item.status === "uploading") return;
  const caps = attachmentCapabilities();
  if (backendStatus() !== "connected" || !caps.supported || (item.kind === "file" && (!caps.files || item.sizeBytes > caps.maxFileBytes))) {
    throw new Error("Connect an environment that supports this attachment");
  }
  if (!item.file && !item.uploadedId) throw new Error("Choose this file again to retry the upload");
  const operation = {};
  attachmentOperations.set(id, operation);
  const currentOperation = () => attachmentOperations.get(id) === operation;
  if (!item.file && item.uploadedId) {
    updateAttachment(endpoint, generation, threadId, id, { status: "uploading", error: undefined });
    try {
      const verified = record(await requestBackend("assets.createUrl", { resource: { _tag: "attachment", attachmentId: item.uploadedId } }));
      if (!verified || typeof verified.relativeUrl !== "string") throw new Error("Invalid attachment verification response");
      if (!currentOperation() || generation !== connectionGeneration || !attachmentFor(endpoint, generation, threadId, id)) return;
      updateAttachment(endpoint, generation, threadId, id, { status: "uploaded", error: undefined });
      return;
    } catch {
      const message = "The uploaded attachment could not be verified. Retry or choose the file again.";
      if (currentOperation()) updateAttachment(endpoint, generation, threadId, id, { status: "failed", error: message });
      throw new Error(message);
    } finally {
      if (currentOperation()) attachmentOperations.delete(id);
    }
  }
  if (!item.file) throw new Error("Choose this file again to retry the upload");
  const controller = new AbortController();
  attachmentControllers.set(id, controller);
  updateAttachment(endpoint, generation, threadId, id, { status: "uploading", error: undefined, progress: 0 });
  let uploadedId: string | undefined;
  try {
    let minted: ReturnType<typeof record>;
    try {
      minted = record(await requestBackend("attachments.createUploadUrl", {
        type: item.kind, name: item.name, mimeType: item.mimeType, sizeBytes: item.sizeBytes,
      }));
    } catch { throw new Error(ATTACHMENT_UPLOAD_COULD_NOT_START); }
    if (!minted || typeof minted.attachmentId !== "string" || typeof minted.relativeUrl !== "string") throw new Error(ATTACHMENT_UPLOAD_COULD_NOT_START);
    uploadedId = minted.attachmentId;
    if (!currentOperation() || generation !== connectionGeneration || !attachmentFor(endpoint, generation, threadId, id) || controller.signal.aborted) throw new Error("Attachment upload cancelled");
    const url = attachmentUploadUrl(endpoint, minted.relativeUrl);
    let response: Response;
    try {
      // attachmentUploadQueue uploadBytes: progress on the tile while the bytes go up (streamed body).
      const body = progressUploadBody(item.file, (progress) => {
        if (currentOperation() && !controller.signal.aborted) updateAttachment(endpoint, generation, threadId, id, { progress });
      });
      response = await fetch(url, { method: "POST", headers: { "content-type": item.mimeType }, body, duplex: "half", redirect: "error", signal: controller.signal });
    } catch { throw new Error(ATTACHMENT_UPLOAD_FAILED); }
    if (!response.ok) throw new Error(attachmentUploadRejected(response.status));
    if (!currentOperation() || generation !== connectionGeneration || !attachmentFor(endpoint, generation, threadId, id) || controller.signal.aborted) throw new Error("Attachment upload cancelled");
    updateAttachment(endpoint, generation, threadId, id, { status: "uploaded", uploadedId, error: undefined });
  } catch (error) {
    if (uploadedId && generation === connectionGeneration && backendStatus() === "connected") {
      void requestBackend("attachments.delete", { attachmentId: uploadedId }).catch(() => {});
    }
    const message = error instanceof Error ? error.message : "Attachment upload failed";
    if (currentOperation()) updateAttachment(endpoint, generation, threadId, id, { status: generation === connectionGeneration ? "failed" : "ready", error: message });
    throw new Error(message);
  } finally {
    if (attachmentControllers.get(id) === controller) attachmentControllers.delete(id);
    if (currentOperation()) attachmentOperations.delete(id);
  }
}

export function removeAttachment(id: string): void {
  const threadId = scopeId();
  if (!threadId || sendingThreadIds().includes(threadId)) return;
  const item = (attachmentDrafts()[threadId] ?? []).find((entry) => entry.id === id);
  if (!item) return;
  attachmentOperations.delete(id);
  attachmentControllers.get(id)?.abort();
  attachmentControllers.delete(id);
  attachmentDrafts.update((all) => ({ ...all, [threadId]: (all[threadId] ?? []).filter((entry) => entry.id !== id) }));
  // The attachment's inline chip goes with it (ComposerAttachmentStrip remove reconciles the prompt).
  draftsByThread.update((all) => (all[threadId] === undefined ? all : { ...all, [threadId]: removeAttachmentReference(all[threadId]!, item) }));
  scheduleDraftSave();
  if (item.uploadedId && backendStatus() === "connected") void requestBackend("attachments.delete", { attachmentId: item.uploadedId }).catch(() => {});
}

/** SideChatPane.tsx delete: releaseComposerDraftUploads + clearDraftThread for a deleted thread's draft. */
/** useRemoveClonedProject: a removed project's draft goes with it, and a view of that draft goes home. */
export function forgetProjectDrafts(projectId: string): void {
  const drafts = unpromoted().filter((thread) => thread.projectId === projectId);
  if (drafts.length === 0) return;
  for (const draft of drafts) releaseThreadDraft(draft.id);
  const ids = new Set(drafts.map((draft) => draft.id));
  unpromoted.update((items) => items.filter((item) => !ids.has(item.id)));
  if (ids.has(openThreadId() ?? "")) openThreadId.set(null);
  scheduleDraftSave();
}

export function releaseThreadDraft(threadId: string): void {
  withThreadScope(threadId, () => { for (const item of attachmentDrafts()[threadId] ?? []) removeAttachment(item.id); });
  attachmentDrafts.update((all) => { const { [threadId]: _gone, ...rest } = all; return rest; });
  draftsByThread.update((all) => { const { [threadId]: _gone, ...rest } = all; return rest; });
  scheduleDraftSave();
}

/** An attachment as the prompt stash keeps it: the upload stays on the server, only the draft entry moves. */
export type StashedAttachment = DraftAttachment & { file?: File; uploadedId?: string };

/** Takes the open thread's attachments out of its draft without deleting their uploads (stashing a prompt). */
export function detachDraftAttachments(): StashedAttachment[] {
  const threadId = scopeId();
  if (!threadId || sendingThreadIds().includes(threadId)) return [];
  const items = (attachmentDrafts()[threadId] ?? []).filter((item) => item.status === "uploaded" && item.uploadedId);
  if (items.length === 0) return [];
  const moved = new Set(items.map((item) => item.id));
  attachmentDrafts.update((all) => ({ ...all, [threadId]: (all[threadId] ?? []).filter((item) => !moved.has(item.id)) }));
  scheduleDraftSave();
  return items;
}

/** Puts stashed attachments back into the open thread's draft (restoring a stash entry), up to the attachment limit. */
export function reattachDraftAttachments(items: readonly StashedAttachment[]): void {
  const threadId = scopeId();
  if (!threadId || items.length === 0) return;
  attachmentDrafts.update((all) => {
    const current = all[threadId] ?? [];
    const room = Math.max(0, attachmentCapabilities().maxCount - current.length);
    const added = items.filter((item) => !current.some((entry) => entry.id === item.id)).slice(0, room);
    return { ...all, [threadId]: [...current, ...added] };
  });
  scheduleDraftSave();
}

/** Listeners on the one `subscribeServerConfig` stream the store holds (the web keeps one per environment, not one per reader). */
const serverConfigEventListeners = new Set<(event: Record<string, unknown>) => void>();
/**
 * rpc/session.ts serverConfigReplayEvents: a reader that attaches late gets the current projection as a snapshot, then
 * the latest environmentThemesUpdated / usageLimitSourcesUpdated events (serverConfigProjection.ts keeps the rest).
 */
let serverConfigReplay: { config: Record<string, unknown>; themesEvent?: Record<string, unknown>; sourcesEvent?: Record<string, unknown> } | null = null;
export function onServerConfigEvent(listener: (event: Record<string, unknown>) => void): () => void {
  serverConfigEventListeners.add(listener);
  const replay = serverConfigReplay;
  if (replay) {
    for (const event of [{ type: "snapshot", config: replay.config }, replay.themesEvent, replay.sourcesEvent]) {
      if (!event || !serverConfigEventListeners.has(listener)) continue;
      try { listener(event); } catch (error) { console.error(error); }
    }
  }
  return () => { serverConfigEventListeners.delete(listener); };
}
/** serverConfigProjection.ts applyServerConfigProjection, on the store's one config stream. */
function projectServerConfig(event: Record<string, unknown>) {
  const payload = record(event.payload) ?? {};
  if (event.type === "snapshot") {
    const config = record(event.config);
    if (config) serverConfigReplay = { ...(serverConfigReplay ?? {}), config };
    return;
  }
  const current = serverConfigReplay;
  if (!current) return;
  if (event.type === "keybindingsUpdated") current.config = { ...current.config, keybindings: payload.keybindings, issues: payload.issues };
  else if (event.type === "providerStatuses") current.config = { ...current.config, providers: payload.providers };
  else if (event.type === "settingsUpdated") current.config = { ...current.config, settings: payload.settings };
  else if (event.type === "environmentThemesUpdated") current.themesEvent = event;
  else if (event.type === "usageLimitSourcesUpdated") current.sourcesEvent = event;
}
/** The input of the store's config stream: the web's (apps/web state/server.ts, connection/runtime.ts) flags. */
// rpc/session.ts onDemandSnapshots: the config stream leaves per-cwd provider snapshots out; the composer fetches them.
export const SERVER_CONFIG_STREAM_INPUT = { environmentThemes: true, usageLimitSources: true, usageLimitsCommand: true, workspaceSnapshotsOnDemand: true } as const;

function handleConfigEvent(value: unknown) {
  const event = record(value);
  if (!event) return;
  observeServerConfigEvent(event);
  projectServerConfig(event);
  refreshSharedServerConfig(event);
  for (const listener of [...serverConfigEventListeners]) { try { listener(event); } catch (error) { console.error(error); } }
  const config = event.type === "snapshot" ? record(event.config) : record(event.payload);
  if (!config) return;
  if (typeof config.threadSnapshotPagination === "boolean") threadSnapshotPaginationCapability.set(config.threadSnapshotPagination);
  if (typeof config.threadFind === "boolean") threadFindCapability.set(config.threadFind);
  if (typeof config.secretRequestReferences === "boolean") secretRequestReferencesCapability.set(config.secretRequestReferences);
  if (typeof config.threadFindProgressive === "boolean") threadFindProgressiveCapability.set(config.threadFindProgressive);
  const environment = record(config.environment);
  if (environment && typeof environment.environmentId === "string" && typeof environment.label === "string") {
    environments.set([{ id: environment.environmentId, label: environment.label }]);
    const caps = record(environment.capabilities);
    projectOrganization.set(caps?.projectOrganization === true);
    commandOutputStreamingCapability.set(caps?.commandOutputStreaming === true);
    modelCatalogRefreshCapability.set(caps?.modelCatalogRefresh === true);
    worktreeBootstrapCapability.set(caps?.requiredWorktreeBootstrap === true);
    pullRequestChecksCapability.set(caps?.pullRequestChecks === true);
    serverBrowserCapability.set(caps?.serverBrowser === true);
    workspaceSnapshotsOnDemandCapability = caps?.providerWorkspaceSnapshotsOnDemand === true;
    const files = record(caps?.fileAttachments);
    const fileLimit = typeof files?.maxUploadBytes === "number" && files.maxUploadBytes > 0 ? Math.min(files.maxUploadBytes, MAX_FILE_BYTES) : 0;
    reportedAttachmentCapabilities.set({ supported: caps?.attachmentUploads === true, files: caps?.attachmentUploads === true && fileLimit > 0,
      maxCount: MAX_ATTACHMENT_COUNT, maxImageBytes: MAX_IMAGE_BYTES, maxFileBytes: fileLimit, maxTotalImageBytes: MAX_TOTAL_IMAGE_BYTES });
    attachmentCapabilitiesKnownSignal.set(true);
    if (caps?.attachmentUploads === true) {
      // ChatComposer's invalidFiles: a file over the reported limit (or any file when files are not offered) loses its in-flight upload.
      releaseUnpersistedUploads((item) => item.kind === "file" && (fileLimit === 0 || item.sizeBytes > fileLimit));
      for (const [threadId, items] of Object.entries(attachmentDrafts())) for (const item of items) {
        if (item.status === "ready" && item.uploadedId && !item.file) void uploadAttachment(threadId, item.id).catch(() => {});
        // Released on an earlier capability loss (or staged while the server was unreachable): upload again from its bytes.
        else if (item.status === "ready" && item.file && !item.uploadedId && !attachmentControllers.has(item.id) && (item.kind === "image" || (fileLimit > 0 && item.sizeBytes <= fileLimit))) void uploadAttachment(threadId, item.id).catch(() => {});
      }
    } else releaseUnpersistedUploads();
  }
  if (!Array.isArray(config.providers)) return;
  const available: AvailableModel[] = [];
  const providers: ProviderStatus[] = [];
  const supported: Record<string, RuntimeMode[]> = {};
  const planSupport: Record<string, boolean> = {};
  for (const providerValue of config.providers) {
    const provider = record(providerValue);
    if (!provider || typeof provider.instanceId !== "string") continue;
    const summary = providerFromValue(provider);
    if (summary) providers.push(summary);
    if (provider.enabled === false || provider.availability === "unavailable" || !Array.isArray(provider.models)) continue;
    supported[provider.instanceId] = Array.isArray(provider.supportedRuntimeModes) ? provider.supportedRuntimeModes.filter(isRuntimeMode) : [];
    planSupport[provider.instanceId] = provider.showInteractionModeToggle === true;
    for (const modelValue of provider.models) {
      const entry = record(modelValue);
      if (!entry || typeof entry.slug !== "string") continue;
      const providerLabel = typeof provider.displayName === "string" ? provider.displayName : provider.instanceId;
      const modelLabel = typeof entry.name === "string" ? entry.name : entry.slug;
      const capabilities = record(entry.capabilities);
      available.push({ provider: provider.instanceId, model: entry.slug, label: `${providerLabel}: ${modelLabel}`,
        ...(typeof provider.driver === "string" ? { driver: provider.driver } : {}),
        ...(Array.isArray(capabilities?.optionDescriptors) ? { optionDescriptors: capabilities.optionDescriptors } : {}) });
    }
  }
  models.set(available);
  configProviderRecords = config.providers.map(record).filter((item): item is Record<string, unknown> => item !== null);
  rawProviders.set(withFetchedWorkspaceSnapshots(configProviderRecords, fetchedWorkspaceSnapshots.get(connectionUrl()) ?? [], workspaceSnapshotsOnDemandCapability));
  providerList.set(providers);
  providerListLoaded.set(true);
  supportedModesByProvider.set(supported);
  supportsPlanByProvider.set(planSupport);
  const policy = record(config.managedPolicy);
  const ceiling = record(policy?.limits)?.maxRuntimeMode;
  if (event.type === "snapshot") runtimeCeiling.set(isRuntimeMode(ceiling) ? ceiling : null);
  const current = model();
  const selectedShell = shellThreads.find((thread) => thread.id === openThreadId());
  const selection = record(selectedShell?.modelSelection);
  // deriveEffectiveComposerModelState: the thread's pick, else its instance's default, else the selectable driver's default.
  const threadSelection = selection && typeof selection.instanceId === "string" && typeof selection.model === "string" ? { provider: selection.instanceId, model: selection.model } : null;
  model.set(resolveEffectiveComposerModel({ selection: threadSelection, available, records: rawProviders(), retained: current ?? stickyModelPick }));
}

export function setSelectedModel(provider: string, modelName: string) {
  const match = models().find((item) => item.provider === provider && item.model === modelName);
  if (!match) return;
  if (scopeOverride !== null) modelByScopedThread.update((all) => ({ ...all, [scopeOverride!]: match }));
  else {
    model.set(match);
    stickyModelPick = { provider: match.provider, model: match.model };
    void Storage.setItem("stickyModel", JSON.stringify(stickyModelPick)).catch(() => {});
    const id = openThreadId();
    if (id && unpromoted().some((thread) => thread.id === id)) { draftModelByThread[id] = { provider: match.provider, model: match.model }; draftPickVersion.update((n) => n + 1); persistDraftModels(); }
  }
}
/** Writes the draft model picks of drafts that still exist, so a draft reopens with its pick after a restart. */
function persistDraftModels() {
  const kept = Object.fromEntries(Object.entries(draftModelByThread).filter(([draftId]) => unpromoted().some((thread) => thread.id === draftId)));
  void Storage.setItem("draftModels", JSON.stringify(kept)).catch(() => {});
}
/** The model picked in each unsent draft (composerDraftStore's per-draft modelSelection), by draft thread id. */
const draftModelByThread: Record<string, { provider: string; model: string }> = {};
/** composerModelSelectionExplicit: the user picked a model in this draft. */
const draftPickVersion = signal(0);
export function draftModelPicked(id: string): boolean { draftPickVersion(); return Object.hasOwn(draftModelByThread, id); }

export function threadFromShell(value: Record<string, unknown>): Thread | null {
  if (typeof value.id !== "string" || typeof value.projectId !== "string" || typeof value.title !== "string") return null;
  const rawStatus = value.status;
  const pending = value.pendingRuntimeRequest != null;
  const status: ThreadStatus = pending ? "awaiting" :
    rawStatus === "running" || rawStatus === "starting" || rawStatus === "preparing" || rawStatus === "queued" || rawStatus === "waiting" ? "running" :
    rawStatus === "cancelled" || rawStatus === "interrupted" || rawStatus === "failed" ? "stopped" : "idle";
  const latestUserMessageAt = typeof value.latestUserMessageAt === "string" ? Date.parse(value.latestUserMessageAt) : NaN;
  return { id: value.id, projectId: value.projectId, title: value.title, status, pinned: value.pinnedAt != null,
    updatedAt: timestamp(value.updatedAt), createdAt: timestamp(value.createdAt), ...(Number.isFinite(latestUserMessageAt) ? { latestUserMessageAt } : {}),
    path: typeof value.worktreePath === "string" ? value.worktreePath : undefined,
    ...(typeof value.branch === "string" && value.branch ? { branch: value.branch } : {}),
    ...(linkedPullRequestOf(value.linkedPullRequest) ? { linkedPullRequest: linkedPullRequestOf(value.linkedPullRequest)! } : {}),
    error: typeof value.lastError === "string" ? value.lastError : undefined, ...(typeof value.environmentId === "string" ? { environmentId: value.environmentId } : {}), meta: threadMetaFromShell(value), relations: threadRelationsFromShell(value), banner: threadBannerFromShell(value) };
}

function timestamp(value: unknown): number {
  const time = typeof value === "string" ? Date.parse(value) : 0;
  return Number.isFinite(time) ? time : 0;
}

// Structural sharing for updateShell: a shell event about one thread (an agent-history import streams hundreds) must not
// rebuild every other Thread/Project object or notify every reader, or each event re-renders the whole sidebar.
// Entries are keyed by id and reused while the server record is the same object or serialises identically.
type ShellMemo<T> = { source: Record<string, unknown>; json: string | null; value: T };
const shellThreadMemo = new Map<string, ShellMemo<Thread | null>>();
const shellOptionsMemo = new Map<string, ShellMemo<ThreadOptions>>();
const shellProjectMemo = new Map<string, ShellMemo<Project> & { threads: Thread[] }>();
const sameItems = <T,>(a: readonly T[], b: readonly T[]) => a.length === b.length && a.every((item, index) => item === b[index]);
function memoized<T>(memo: Map<string, ShellMemo<T>>, seen: Set<string>, id: string, source: Record<string, unknown>, build: () => T): T {
  seen.add(id);
  const previous = memo.get(id);
  if (previous && previous.source === source) return previous.value;
  const json = JSON.stringify(source);
  if (previous && (previous.json ?? JSON.stringify(previous.source)) === json) {
    memo.set(id, { source, json, value: previous.value });
    return previous.value;
  }
  const value = build();
  memo.set(id, { source, json, value });
  return value;
}
function pruneMemo(memo: Map<string, unknown>, seen: Set<string>) {
  for (const id of memo.keys()) if (!seen.has(id)) memo.delete(id);
}
function setIfChanged<T>(target: { (): T[]; set(value: T[]): void }, next: T[]) {
  if (!sameItems(target(), next)) target.set(next);
}

function updateShell() {
  // Publish the related sidebar signals together so a shell event cannot render
  // an intermediate mixture of old and new project/thread lists.
  batch(() => {
  // Saved environments' shells follow the primary's, scoped by environment; with none the arrays are the primary's own.
  const shellThreads = withRemoteShells(primaryShellThreads(), "threads");
  const shellProjects = withRemoteShells(primaryShellProjects(), "projects");
  const archivedShellThreads = withRemoteShells(primaryArchivedShellThreads(), "archived");
  const seenThreads = new Set<string>();
  const threadOf = (item: Record<string, unknown>) => typeof item.id === "string" ? memoized(shellThreadMemo, seenThreads, item.id, item, () => threadFromShell(item)) : threadFromShell(item);
  const threads = shellThreads.map(threadOf).filter((thread): thread is Thread => thread !== null);
  const seenOptions = new Set<string>();
  const serverOptions: Record<string, ThreadOptions> = {};
  for (const thread of shellThreads) {
    if (typeof thread.id !== "string") continue;
    serverOptions[thread.id] = memoized(shellOptionsMemo, seenOptions, thread.id, thread, () => {
      const branch = typeof thread.branch === "string" ? thread.branch : undefined;
      const workspace: WorkspaceStrategy = typeof thread.worktreePath === "string"
        ? { type: "existing_worktree", worktreePath: thread.worktreePath, ...(branch ? { branch } : {}) }
        : { type: "root", ...(branch ? { branch } : {}) };
      return { runtime: isRuntimeMode(thread.runtimeMode) ? thread.runtimeMode : "full-access", interaction: isInteractionMode(thread.interactionMode) ? thread.interactionMode : "default", workspace };
    });
  }
  pruneMemo(shellOptionsMemo, seenOptions);
  const previousOptions = serverOptionsByThread();
  const optionIds = Object.keys(serverOptions);
  if (optionIds.length !== Object.keys(previousOptions).length || optionIds.some((id) => previousOptions[id] !== serverOptions[id])) serverOptionsByThread.set(serverOptions);
  const threadsByProject = new Map<string, Thread[]>();
  for (const thread of threads) {
    const list = threadsByProject.get(thread.projectId);
    if (list) list.push(thread);
    else threadsByProject.set(thread.projectId, [thread]);
  }
  const seenProjects = new Set<string>();
  setIfChanged(projects, shellProjects.flatMap((item) => {
    if (typeof item.id !== "string" || typeof item.title !== "string") return [];
    const projectId = item.id;
    const projectThreads = threadsByProject.get(projectId) ?? [];
    seenProjects.add(projectId);
    const previous = shellProjectMemo.get(projectId);
    if (previous && sameItems(previous.threads, projectThreads) &&
      (previous.source === item || (previous.json ?? JSON.stringify(previous.source)) === JSON.stringify(item))) {
      if (previous.source !== item) shellProjectMemo.set(projectId, { ...previous, source: item, json: null });
      return [previous.value];
    }
    const value: Project = { id: projectId, ...(typeof item.environmentId === "string" ? { environmentId: item.environmentId } : {}), name: item.title, path: typeof item.workspaceRoot === "string" ? item.workspaceRoot : undefined,
      createdAt: timestamp(item.createdAt), updatedAt: timestamp(item.updatedAt), pinned: item.pinnedAt != null,
      scripts: readProjectScripts(item.scripts),
      projectIcon: item.projectIcon ?? undefined, faviconPath: typeof item.faviconPath === "string" ? item.faviconPath : undefined,
      repositoryIdentity: item.repositoryIdentity ?? undefined,
      legacyDefaults: { defaultModelSelection: item.defaultModelSelection ?? undefined, defaultThreadEnvMode: item.defaultThreadEnvMode ?? undefined, autoPull: item.autoPull === true },
      threads: projectThreads };
    shellProjectMemo.set(projectId, { source: item, json: null, value, threads: projectThreads });
    return [value];
  }));
  pruneMemo(shellProjectMemo, seenProjects);
  setIfChanged(archived, archivedShellThreads.map(threadOf).filter((thread): thread is Thread => thread !== null));
  pruneMemo(shellThreadMemo, seenThreads);
  const projectIds = new Set(projects().map((project) => project.id));
  setIfChanged(loose, threads.filter((thread) => !projectIds.has(thread.projectId)));
  const ids = new Set(threads.map((thread) => thread.id));
  // A draft on a saved environment's project was sent with its local id; the server's thread comes back scoped.
  const promotedRemote = new Map<string, string>();
  for (const thread of threads) {
    const scoped = thread.environmentId ? parseScopedKey(thread.id) : null;
    if (scoped) promotedRemote.set(`${thread.projectId}|${scoped.localId}`, thread.id);
  }
  if (promotedRemote.size > 0) {
    const selectedDraft = openThreadId();
    for (const item of unpromoted()) {
      const scopedId = promotedRemote.get(`${item.projectId}|${item.id}`);
      if (!scopedId) continue;
      ids.add(item.id);
      if (selectedDraft === item.id) openThreadId.set(scopedId);
    }
  }
  setIfChanged(unpromoted, unpromoted().filter((item) => !ids.has(item.id)));
  const selected = openThreadId();
  const selectedScope = selected ? parseScopedKey(selected) : null;
  const deletedSavedSelection = Boolean(
    selectedScope && savedEnvironmentsLoaded() &&
    !managedEnvironment(selectedScope.environmentId) &&
    !savedEnvironments().some((item) => item.id === selectedScope.environmentId),
  );
  if (deletedSavedSelection) {
    openThreadId.set(threads[0]?.id ?? null);
    if (threads.length) subscribeOpenThread();
  } else if (!selected && threads.length) {
    openThreadId.set(threads[0].id);
    subscribeOpenThread();
  }
  });
}

const primaryShellThreads = () => {
  if (olderSettledRows.length === 0) return shellThreads;
  // threadFamilies.ts snapshotAtom: read rows merge behind the shell rows, which win (deltas carry every change).
  const present = new Set(shellThreads.map((thread) => thread.id));
  return [...shellThreads, ...olderSettledRows.filter((thread) => !present.has(thread.id))];
};

// ---- Older settled threads (olderSettledThreads.ts, web state/olderSettledShelf.ts) ----
const olderSettledCutSignal = signal<OlderSettledCut | null>(null);
export const olderSettledCut = () => olderSettledCutSignal();
/** Rows read below the cut with orchestration.getOlderSettledThreads, newest settle first. */
let olderSettledRows: Record<string, unknown>[] = [];
const olderSettledLoaded = signal(0);
export const olderSettledLoadedCount = () => olderSettledLoaded();
const olderSettledStatusSignal = signal<OlderSettledStatus>("ready");
const olderSettledScopeKeySignal = signal("");
const NONE_SCOPE_KEY = "\0none";
let olderSettledFrontier: { settledAt: string; threadId?: string } | null = null;
let olderSettledGeneration = 0;
let olderSettledCountGeneration = 0;
let olderSettledCountTimer: ReturnType<typeof setTimeout> | null = null;
let olderSettledPageDropped: Set<string> | null = null;

function primaryScopeFor(projectIds: readonly string[] | undefined): { key: string; localIds: string[] | undefined; targeted: boolean } {
  if (!projectIds || projectIds.length === 0) return { key: "", localIds: undefined, targeted: true };
  const localIds = projectIds.filter((id) => parseScopedKey(id) === null);
  if (localIds.length === 0) return { key: NONE_SCOPE_KEY, localIds: undefined, targeted: false };
  return { key: [...localIds].sort().join("\n"), localIds, targeted: true };
}

export const olderSettledStatus = (projectIds?: readonly string[]): OlderSettledStatus => {
  const statuses: OlderSettledStatus[] = [];
  const cut = olderSettledCutSignal();
  const currentScopeKey = olderSettledScopeKeySignal();
  if (cut) {
    if (projectIds !== undefined) {
      const target = primaryScopeFor(projectIds);
      if (target.targeted) statuses.push(target.key === currentScopeKey ? olderSettledStatusSignal() : "ready");
    } else if (currentScopeKey !== NONE_SCOPE_KEY) {
      statuses.push(olderSettledStatusSignal());
    }
  }
  statuses.push(...remoteOlderSettledStatuses(projectIds));
  if (statuses.length === 0) return projectIds !== undefined ? "done" : olderSettledStatusSignal();
  if (statuses.includes("pending")) return "pending";
  if (statuses.includes("ready")) return "ready";
  if (statuses.includes("failed")) return "failed";
  return "done";
};

export function canLoadOlderSettled(projectIds?: readonly string[]): boolean {
  const primaryTarget = primaryScopeFor(projectIds);
  const cut = olderSettledCutSignal();
  if (cut && primaryTarget.targeted) {
    olderSettledLoaded();
    projects();
    loose();
    const filter = primaryTarget.localIds ? new Set(primaryTarget.localIds) : undefined;
    if (countUnloadedOlderSettled(cut, primaryShellThreads(), filter) > 0) return true;
  }
  return hasConnectedRemoteOlderSettled(projectIds);
}

/** An authoritative snapshot names a new cut: the pages read below the old one are dropped. */
function resetOlderSettled(cut: OlderSettledCut | null) {
  olderSettledGeneration += 1;
  olderSettledCountGeneration += 1;
  if (olderSettledCountTimer !== null) clearTimeout(olderSettledCountTimer);
  olderSettledCountTimer = null;
  olderSettledRows = [];
  olderSettledFrontier = null;
  olderSettledPageDropped = null;
  olderSettledCutSignal.set(cut);
  olderSettledLoaded.set(0);
  olderSettledStatusSignal.set("ready");
}

/** Match T3's debounced count-only read after a change that can affect the cut. */
function refreshOlderSettledCounts() {
  const cut = olderSettledCutSignal();
  if (!cut) return;
  const generation = ++olderSettledCountGeneration;
  if (olderSettledCountTimer !== null) clearTimeout(olderSettledCountTimer);
  olderSettledCountTimer = setTimeout(() => {
    olderSettledCountTimer = null;
    void requestBackend("orchestration.getOlderSettledThreads", { before: { settledAt: cut.before }, limit: 0 }).then((value) => {
      if (generation !== olderSettledCountGeneration || olderSettledCutSignal()?.before !== cut.before) return;
      const page = record(value);
      if (!page || !Array.isArray(page.counts)) return;
      const next = readOlderSettledCut({ before: cut.before, asOfSequence: typeof page.snapshotSequence === "number" ? page.snapshotSequence : cut.asOfSequence, counts: page.counts });
      if (next) olderSettledCutSignal.set(next);
    }).catch(() => { /* Keep the last authoritative counts until the next read. */ });
  }, 500);
}

function olderSettledCountRowKey(row: Record<string, unknown> | undefined): string | null {
  return olderSettledCountRowKeyFor(olderSettledCutSignal(), row);
}
/** Older settled threads in scope this client does not hold (unloadedOlderSettledCount). */
export function unloadedOlderSettledCount(projectIds?: ReadonlySet<string>): number {
  const filter = projectIds && projectIds.size > 0 ? projectIds : undefined;
  const primaryFilter = filter ? new Set([...filter].filter((id) => parseScopedKey(id) === null)) : undefined;
  let total = 0;
  const cut = olderSettledCutSignal();
  if (cut && (!filter || primaryFilter!.size > 0)) {
    olderSettledLoaded();
    projects();
    loose();
    total += countUnloadedOlderSettled(cut, primaryShellThreads(), primaryFilter);
  }
  total += remoteUnloadedOlderSettledCount(filter);
  return total;
}
/** Reads the next page below the cut (olderSettledThreads.ts pageRowsAtom, 25 per page). */
/** The sidebar's project scope (olderSettledScopes): pages are read per scope, so another scope starts from the cut again. */
function useOlderSettledScope(key: string) {
  if (key === olderSettledScopeKeySignal()) return;
  olderSettledScopeKeySignal.set(key);
  olderSettledGeneration += 1;
  olderSettledRows = [];
  olderSettledFrontier = null;
  olderSettledPageDropped = null;
  olderSettledLoaded.set(0);
  olderSettledStatusSignal.set("ready");
  updateShell();
}
export async function loadOlderSettledPage(projectIds?: readonly string[]): Promise<void> {
  const primaryTarget = primaryScopeFor(projectIds);
  useOlderSettledScope(primaryTarget.key);
  const runPrimary = async () => {
    const cut = olderSettledCutSignal();
    const status = olderSettledStatusSignal();
    if (!primaryTarget.targeted || !cut || status !== "ready") return;
    const generation = olderSettledGeneration;
    const dropped = new Set<string>();
    olderSettledPageDropped = dropped;
    olderSettledStatusSignal.set("pending");
    try {
      const page = record(await requestBackend("orchestration.getOlderSettledThreads", {
        before: olderSettledFrontier ?? { settledAt: cut.before },
        ...(primaryTarget.localIds ? { projectIds: [...primaryTarget.localIds] } : {}),
        limit: OLDER_SETTLED_PAGE_SIZE,
      }));
      if (generation !== olderSettledGeneration) return;
      const threads = Array.isArray(page?.threads) ? page.threads.map(record).filter((item): item is Record<string, unknown> => item !== null) : [];
      olderSettledRows = [...olderSettledRows, ...threads.filter((thread) => !dropped.has(String(thread.id)) && !olderSettledRows.some((row) => row.id === thread.id))];
      const last = threads[threads.length - 1];
      if (threads.length < OLDER_SETTLED_PAGE_SIZE || typeof last?.settledAt !== "string") olderSettledStatusSignal.set("done");
      else { olderSettledFrontier = { settledAt: last.settledAt, threadId: String(last.id) }; olderSettledStatusSignal.set("ready"); }
      olderSettledLoaded.set(olderSettledRows.length);
      updateShell();
    } catch (error) {
      if (generation !== olderSettledGeneration) return;
      olderSettledStatusSignal.set("failed");
      reportError(error);
    } finally {
      if (olderSettledPageDropped === dropped) olderSettledPageDropped = null;
    }
  };
  const [, remoteChanged] = await Promise.all([
    runPrimary(),
    loadRemoteOlderSettledPages(projectIds, reportError),
  ]);
  if (remoteChanged) updateShell();
}
/** Retry after a failed page read (olderSettledShelf retry). */
export function retryOlderSettledPage(projectIds?: readonly string[]): Promise<void> {
  if (olderSettledStatusSignal() === "failed") olderSettledStatusSignal.set("ready");
  resetFailedRemoteOlderSettled(projectIds);
  return loadOlderSettledPage(projectIds);
}
const primaryShellProjects = () => shellProjects;
const primaryArchivedShellThreads = () => archivedShellThreads;
/** Re-folds the merged shell after a saved environment's shell changed (environments/install.ts). */
export function refreshMergedShell() {
  updateShell();
  subscribeOpenThread();
  syncSideSubscriptions();
}

function shellRecordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(record).filter((item): item is Record<string, unknown> => item !== null) : [];
}

/**
 * shell.ts's subscribe input: a reconnect to the same environment resumes after the last applied sequence (the server
 * replays what was missed, or answers with a fresh snapshot when it cannot); a first connect asks for the snapshot.
 * `requestCompletionMarker` makes the server say when the replay is done (`synchronized`).
 */
let shellCursor: { endpoint: string; sequence: number } | null = null;
/** shell.ts ShellOriginIdentity, read from the connection's config snapshot. */
interface ShellIdentity { serverVersion: unknown; databaseMigration: unknown; omitIdleSubagents: boolean; omitOlderSettled: boolean }
/** shell.ts `origin`: the identity of the server whose authoritative snapshot the held rows came from, and when. */
let shellOrigin: (ShellIdentity & { endpoint: string; snapshotAt: number }) | null = null;
const SHELL_RESUME_MAX_AGE_MS = 12 * 60 * 60 * 1000;
function shellIdentity(): ShellIdentity | null {
  const config = serverConfigReplay?.config;
  const environment = record(config?.environment);
  if (!config || !environment) return null;
  // shell.ts: idle subagent children come from getThreadFamily (threadFamilyDelete.ts) and older settled threads from
  // getOlderSettledThreads (the sidebar's Settled shelf), as the reference reads them.
  const omitIdleSubagents = config.shellThreadFamilies === true;
  return { serverVersion: environment.serverVersion, databaseMigration: environment.databaseMigration ?? null, omitIdleSubagents, omitOlderSettled: config.shellOlderSettled === true && omitIdleSubagents };
}
/** shell.ts canResumeFrom: same server build, same migration, same omissions, and a snapshot under 12 hours old. */
function canResumeShell(endpoint: string, identity: ShellIdentity | null, now = Date.now()): boolean {
  const origin = shellOrigin;
  if (!origin || !identity || origin.endpoint !== endpoint) return false;
  const age = now - origin.snapshotAt;
  return origin.serverVersion === identity.serverVersion && origin.databaseMigration === identity.databaseMigration
    && origin.omitIdleSubagents === identity.omitIdleSubagents && origin.omitOlderSettled === identity.omitOlderSettled && age >= 0 && age < SHELL_RESUME_MAX_AGE_MS;
}
function shellOmission(identity: ShellIdentity | null): Record<string, true> {
  return { ...(identity?.omitIdleSubagents ? { omitIdleSubagents: true } : {}), ...(identity?.omitOlderSettled ? { omitOlderSettled: true } : {}) };
}
/**
 * The subscribe input when no HTTP snapshot is loaded first: rows held from a matching server resume from their cursor,
 * with `httpSnapshotFallback` so a gap the server cannot replay answers `snapshot-required` instead of a socket snapshot.
 */
export function shellSubscribeInput(endpoint: string): Record<string, unknown> {
  const identity = shellIdentity();
  const omission = shellOmission(identity);
  return shellCursor && shellCursor.endpoint === endpoint && shellSnapshotReceived() && canResumeShell(endpoint, identity)
    ? { afterSequence: shellCursor.sequence, httpSnapshotFallback: true, ...omission, requestCompletionMarker: true }
    : { ...omission, requestCompletionMarker: true };
}
/** Test seam: the fetch the shell snapshot goes through. */
let shellFetch: typeof fetch = (input, init) => fetch(input, init);
export function setShellFetchForTests(next: typeof fetch | null) { shellFetch = next ?? ((input, init) => fetch(input, init)); }
/** shellSnapshotHttp.ts: the deadline of GET /api/orchestration/shell; on failure the socket snapshot is used. */
const SHELL_SNAPSHOT_TIMEOUT_MS = 20000;
/** shellSnapshotHttp.ts fetchEnvironmentShellSnapshot: the shell snapshot over HTTP, or null (the socket snapshot is used). */
export function fetchShellSnapshot(endpoint: string, bearer: string, identity: ShellIdentity | null): Promise<Record<string, unknown> | null> {
  return fetchShellSnapshotWith(shellFetch, endpoint, bearer, identity);
}
/**
 * shell.ts makeSubscribeInput: rows that may resume do so from their cursor; anything else loads the HTTP snapshot first
 * and subscribes after its cursor (without `httpSnapshotFallback`, so a refusal of that fresh cursor cannot loop).
 */
export async function prepareShellSubscribe(endpoint: string, bearer: string | null): Promise<Record<string, unknown>> {
  const identity = shellIdentity();
  if (shellCursor && shellCursor.endpoint === endpoint && shellSnapshotReceived() && canResumeShell(endpoint, identity)) return shellSubscribeInput(endpoint);
  const snapshot = bearer ? await fetchShellSnapshot(endpoint, bearer, identity) : null;
  if (snapshot && connectionUrl() === endpoint) {
    handleShellEvent({ kind: "snapshot", snapshot });
    return { afterSequence: snapshot.snapshotSequence, ...shellOmission(identity), requestCompletionMarker: true };
  }
  return { ...shellOmission(identity), requestCompletionMarker: true };
}
function advanceShellCursor(sequence: unknown) {
  if (typeof sequence !== "number") return;
  const endpoint = connectionUrl();
  if (!shellCursor || shellCursor.endpoint !== endpoint || sequence > shellCursor.sequence) shellCursor = { endpoint, sequence };
}

function handleShellEvent(value: unknown) {
  const event = record(value);
  if (!event) return;
  recordFamilyShellEvent("", event);
  recordArchiveChange(pendingArchiveChanges, event);
  if (event.kind === "snapshot-required") {
    // shell.ts: the rows stay on screen but reload (HTTP) before the next resume.
    shellOrigin = null;
    shellReloadRequested?.();
    return;
  }
  if (event.kind === "snapshot") {
    const snapshot = record(event.snapshot);
    if (!snapshot) return;
    if (!Array.isArray(event.resolvedRepositoryIdentityRoots) && typeof snapshot.snapshotSequence === "number") {
      shellCursor = { endpoint: connectionUrl(), sequence: snapshot.snapshotSequence };
      const identity = shellIdentity();
      shellOrigin = identity ? { ...identity, endpoint: connectionUrl(), snapshotAt: Date.now() } : null;
    }
    // mergeShellSnapshotProjects: a snapshot carrying resolvedRepositoryIdentityRoots is a project
    // identity enrichment (its threads list is empty), not an authoritative reset of the shell.
    if (Array.isArray(event.resolvedRepositoryIdentityRoots) && (shellProjects.length > 0 || shellThreads.length > 0)) {
      const roots = new Set(event.resolvedRepositoryIdentityRoots);
      const byId = new Map(shellRecordArray(snapshot.projects).map((item) => [item.id, item] as const));
      shellProjects = shellProjects.map((project) => {
        const candidate = byId.get(project.id);
        if (!candidate || candidate.workspaceRoot !== project.workspaceRoot) return project;
        if (roots.has(project.workspaceRoot) || (project.repositoryIdentity == null && candidate.repositoryIdentity != null)) {
          return { ...project, repositoryIdentity: candidate.repositoryIdentity };
        }
        return project;
      });
    } else {
      shellProjects = shellRecordArray(snapshot.projects);
      shellThreads = shellRecordArray(snapshot.threads);
      resetOlderSettled(readOlderSettledCut(snapshot.olderSettled));
      shellSnapshotReceived.set(true);
    }
  } else if (event.kind === "project.updated") {
    advanceShellCursor(event.sequence);
    const project = record(event.project);
    if (!project || typeof project.id !== "string") return;
    shellProjects = [...shellProjects.filter((item) => item.id !== project.id), project];
  } else if (event.kind === "project.removed") {
    advanceShellCursor(event.sequence);
    shellProjects = shellProjects.filter((item) => item.id !== event.projectId);
  } else if (event.kind === "thread.updated") {
    advanceShellCursor(event.sequence);
    const thread = record(event.thread);
    if (!thread || typeof thread.id !== "string") return;
    if (olderSettledPageDropped) {
      if (event.location === "archive") olderSettledPageDropped.add(thread.id);
      else if (event.location === "active") olderSettledPageDropped.delete(thread.id);
    }
    const previousRow = shellThreads.find((item) => item.id === thread.id)
      ?? olderSettledRows.find((item) => item.id === thread.id);
    const previousCountKey = olderSettledCountRowKey(previousRow);
    // An update in the same location replaces the record where it is, so the list order (and every other row) stays put.
    const activeIndex = shellThreads.findIndex((item) => item.id === thread.id);
    const archiveIndex = archivedShellThreads.findIndex((item) => item.id === thread.id);
    if (event.location === "active" && activeIndex >= 0 && archiveIndex < 0) shellThreads[activeIndex] = thread;
    else if (event.location === "archive" && archiveIndex >= 0 && activeIndex < 0) {
      olderSettledRows = olderSettledRows.filter((item) => item.id !== thread.id);
      archivedShellThreads[archiveIndex] = thread;
    } else {
      shellThreads = shellThreads.filter((item) => item.id !== thread.id);
      archivedShellThreads = archivedShellThreads.filter((item) => item.id !== thread.id);
      if (event.location === "active") shellThreads.push(thread);
      else if (event.location === "archive") {
        olderSettledRows = olderSettledRows.filter((item) => item.id !== thread.id);
        archivedShellThreads.push(thread);
      }
    }
    const archivedMayBeOlder = event.location === "archive" && previousRow === undefined && Boolean(olderSettledCutSignal())
      && (typeof thread.createdAt !== "string" || olderSettledCountRowKey(thread) !== null);
    if (previousCountKey !== olderSettledCountRowKey(event.location === "active" ? thread : undefined) || archivedMayBeOlder) refreshOlderSettledCounts();
  } else if (event.kind === "thread.removed") {
    advanceShellCursor(event.sequence);
    if (olderSettledPageDropped && typeof event.threadId === "string") olderSettledPageDropped.add(event.threadId);
    olderSettledRows = olderSettledRows.filter((item) => item.id !== event.threadId);
    if (event.location === "active") shellThreads = shellThreads.filter((item) => item.id !== event.threadId);
    if (event.location === "archive") archivedShellThreads = archivedShellThreads.filter((item) => item.id !== event.threadId);
    refreshOlderSettledCounts();
    // threadRoutes.ts resolveThreadRouteRenderState "missing" + ThreadRouteView: a thread removed (deleted or archived)
    // while it is open leaves its view for home.
    if (event.location === "active" && typeof event.threadId === "string" && openThreadId() === event.threadId) openThreadId.set(null);
  } else return;
  updateShell();
  subscribeOpenThread();
  syncSideSubscriptions();
}

/** A `message.updated` record has none of the user message's turn-item fields: the entry's own survive it. */
function keepTurnItemFields(current: Message, incoming: Message): Message {
  const kept: Partial<Message> = {};
  for (const key of ["itemId", "delegatedCompletionTaskIds", "inputIntent", "createdBy", "creationSource", "idleCompaction", "scheduledTaskId", "senderThreadId", "freshContext", "modelSwitch", "runId", "status", "updatedAt", "ordinal"] as const) {
    if (current[key] !== undefined && incoming[key] === undefined) (kept as Record<string, unknown>)[key] = current[key];
  }
  if (incoming.context === undefined && current.context !== undefined) kept.context = current.context;
  return { ...incoming, ...kept };
}

export function readMessage(value: unknown): Message | null {
  const message = record(value);
  if (!message || typeof message.id !== "string" || typeof message.text !== "string" || (message.role !== "user" && message.role !== "assistant")) return null;
  // A message that carries a notification (T3 Code restarted and resumed this turn) is shown as its notification turn item, never as a bubble.
  if (message.role === "user" && record(message.notification)) return null;
  const attachments = Array.isArray(message.attachments) ? message.attachments.map(record).flatMap((item) => {
    if (!item || typeof item.id !== "string" || typeof item.name !== "string" || typeof item.mimeType !== "string" ||
      typeof item.sizeBytes !== "number" || typeof item.type !== "string") return [];
    const source = record(item.source)?._tag;
    return [{ id: item.id, name: item.name, mimeType: item.mimeType, sizeBytes: item.sizeBytes, type: item.type, ...(typeof source === "string" ? { source } : {}) }];
  }) : [];
  const taskIds = record(message.delegatedCompletion)?.taskIds;
  const delegatedCompletionTaskIds = Array.isArray(taskIds) ? taskIds.filter((id): id is string => typeof id === "string") : [];
  return { id: message.id, role: message.role, body: message.text, order: timestamp(message.createdAt), streaming: message.streaming === true, attachments, ...(message.context ? { context: message.context } : {}), ...(delegatedCompletionTaskIds.length ? { delegatedCompletionTaskIds } : {}) };
}

/** A visibleTurnItems row's item; a row inherited from another thread (a fork) or synthetic keeps that as `rowVisibility`. */
function visibleRowItem(row: unknown): unknown {
  const value = record(row);
  const item = record(value?.item);
  if (!item) return value?.item;
  return value?.visibility === "inherited" || value?.visibility === "synthetic" ? { ...item, rowVisibility: value.visibility } : item;
}

function updateRuntimeRequest(value: unknown) {
  const item = record(value);
  if (!item || typeof item.id !== "string") return;
  const id = item.id;
  runtimeRequests.update((items) => [...items.filter((entry) => entry.id !== id), item]);
}

function updateSubagent(value: unknown) {
  const agent = record(value);
  if (!agent || typeof agent.id !== "string") return;
  const id = agent.id;
  subagentRecords.update((all) => ({ ...all, [id]: restoreSubagentBodies(agent, all[id]) }));
}

function restoreSubagentBodies(agent: Record<string, unknown>, previous: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!previous) return agent;
  const restorePrompt = agent.promptOmitted === true && previous.promptOmitted !== true;
  const restoreResult = agent.resultOmitted === true && previous.resultOmitted !== true;
  if (!restorePrompt && !restoreResult) return agent;
  const restored = { ...agent };
  if (restorePrompt) { restored.prompt = previous.prompt; delete restored.promptOmitted; }
  if (restoreResult) { restored.result = previous.result; delete restored.resultOmitted; }
  return restored;
}

function subagentSnapshot(values: unknown): Record<string, Record<string, unknown>> {
  const agents: Record<string, Record<string, unknown>> = Object.create(null);
  if (!Array.isArray(values)) return agents;
  for (const value of values) {
    const agent = record(value);
    if (agent && typeof agent.id === "string") {
      const previous = agents[agent.id];
      agents[agent.id] = restoreSubagentBodies(agent, previous);
    }
  }
  return agents;
}

function updateTurnItem(value: unknown, threadId?: string) {
  const item = record(value);
  if (!item || typeof item.id !== "string") return;
  const id = item.id;
  // A message also arrives as a turn item carrying its text; that is the path the web transcript is built from.
  const itemMessage = threadId ? messageFromTurnItem(item) : null;
  batch(() => {
    if (threadId && itemMessage) {
      const omitted = itemTextOmitted(item);
      transcripts.update((all) => mergeTranscriptItem(all, threadId, itemMessage, omitted));
    }
    turnItemOrders.update((orders) => orders[id] !== undefined ? orders : { ...orders, [id]: timestamp(item.startedAt) || timestamp(item.updatedAt) });
    turnItems.update((items) => {
      const index = items.findIndex((entry) => entry.id === id);
      if (index < 0) return [...items, item];
      return items.map((entry, current) => current === index ? item : entry);
    });
  });
}

function isApprovalDecision(value: unknown): value is ApprovalDecision {
  return value === "accept" || value === "acceptForSession" || value === "acceptAlways" || value === "decline" || value === "cancel";
}

function activityTitle(type: string): string {
  const titles: Record<string, string> = {
    command_execution: "Command", file_change: "File change", file_search: "File search", web_search: "Web search",
    dynamic_tool: "Tool", reasoning: "Reasoning", proposed_plan: "Plan", todo_list: "Tasks", user_input_request: "Input requested",
    subagent: "Subagent", system_notice: "Notice", error: "Error", checkpoint: "Checkpoint", compaction: "Compacted context",
  };
  return titles[type] ?? type.replace(/_/g, " ");
}

function activityDetail(item: Record<string, unknown>): string {
  const parts: string[] = [];
  const add = (value: unknown) => { if (typeof value === "string" && value.trim()) parts.push(value); };
  switch (item.type) {
    case "command_execution": add(item.input); add(item.output); break;
    case "file_change": add(item.fileName); add(item.diffStr); break;
    case "file_search": add(item.pattern); break;
    case "web_search": if (Array.isArray(item.patterns)) for (const value of item.patterns) add(value); break;
    case "dynamic_tool": add(item.toolName); if (typeof item.input === "string") add(item.input); else if (item.input != null) add(JSON.stringify(item.input)); if (typeof item.output === "string") add(item.output); break;
    case "reasoning": add(item.text); break;
    case "proposed_plan": add(item.markdown); break;
    case "subagent": add(item.prompt); add(item.progress); add(item.result); break;
    case "error": add(record(item.failure)?.message); break;
    case "user_input_request": if (Array.isArray(item.questions)) for (const question of item.questions) add(record(question)?.question); break;
    default: add(item.message); add(item.summary);
  }
  if (item.outputOmitted === true) parts.push("[Output omitted by the environment]");
  const detail = parts.join("\n\n");
  return detail.length > 12000 ? `${detail.slice(0, 12000)}\n\n[Output truncated]` : detail;
}

/** updateRun / updateRuntimeRequest over a whole list at once: same result (replace in place, or move to the end), one pass. */
function upsertAll(start: Record<string, unknown>[], values: unknown[], moveToEnd = false): Record<string, unknown>[] {
  const byId = new Map<string, Record<string, unknown>>();
  for (const entry of start) if (typeof entry.id === "string") byId.set(entry.id, entry);
  for (const value of values) {
    const item = record(value);
    if (!item || typeof item.id !== "string") continue;
    if (moveToEnd) byId.delete(item.id);
    byId.set(item.id, item);
  }
  return [...byId.values()];
}

/** updateTurnItem over a snapshot's rows into fresh lists: the same items, first-seen orders and merged messages. */
function foldTurnItems(rows: unknown[], startMessages: Message[]) {
  const items: Record<string, unknown>[] = [];
  const positions = new Map<string, number>();
  const orders: Record<string, number> = {};
  let messages = startMessages;
  const messagePositions = new Map<string, number>(startMessages.map((message, index) => [message.id, index] as const));
  for (const row of rows) {
    const item = record(row);
    if (!item || typeof item.id !== "string") continue;
    const id = item.id;
    const itemMessage = messageFromTurnItem(item);
    if (itemMessage) {
      const at = messagePositions.get(itemMessage.id);
      if (at === undefined) {
        if (messages === startMessages) messages = [...startMessages];
        messagePositions.set(itemMessage.id, messages.length);
        messages.push(itemMessage);
      } else {
        const merged = mergeItemMessage([messages[at]], itemMessage, itemTextOmitted(item));
        if (merged[0] !== messages[at]) {
          if (messages === startMessages) messages = [...startMessages];
          messages[at] = merged[0];
        }
      }
    }
    if (orders[id] === undefined) orders[id] = timestamp(item.startedAt) || timestamp(item.updatedAt);
    const at = positions.get(id);
    if (at === undefined) { positions.set(id, items.length); items.push(item); }
    else items[at] = item;
  }
  return { items, orders, messages };
}

function handleThreadEvent(threadId: string, value: unknown) {
  if (openThreadId() !== threadId) return;
  const item = record(value);
  if (!item) return;
  threadRetryCount = 0;
  // The end-of-replay marker (requestCompletionMarker): nothing to fold.
  if (item.kind === "synchronized") return;
  if (item.kind === "event" && typeof item.sequence === "number") {
    // applyEventsLocked: a replay after `afterSequence` can overlap what is already applied; dedupe by sequence.
    if (openThreadSequence !== null && item.sequence <= openThreadSequence) return;
    openThreadSequence = item.sequence;
  }
  observeThreadItem(item);
  observeBannerThreadItem(threadId, item);
  if (item.kind === "snapshot") {
    const projection = record(item.projection);
    if (!projection) return;
    openThreadSequence = typeof item.snapshotSequence === "number" ? item.snapshotSequence : null;
    // One flush for the whole snapshot: writing these one at a time (as before) let this runtime's eager computeds
    // render the thread with turnItems/activity briefly cleared to empty between the reset and the refill below.
    const messageRecords = Array.isArray(projection.messages) ? projection.messages.map(readMessage).filter((entry): entry is Message => entry !== null) : [];
    const rows = Array.isArray(projection.visibleTurnItems) ? projection.visibleTurnItems.map(visibleRowItem)
      : Array.isArray(projection.turnItems) ? projection.turnItems : [];
    const numbered = rows.map(record).filter((row): row is Record<string, unknown> => row !== null && typeof row.ordinal === "number");
    const firstOrdinal = numbered.reduce((first, row) => Math.min(first, row.ordinal as number), Infinity);
    const earlierItems = item.hasMoreHistory === true && Number.isFinite(firstOrdinal)
      ? turnItems().filter((row) => typeof row.ordinal === "number" && row.ordinal < firstOrdinal) : [];
    const earlierMessages = earlierItems.length > 0
      ? (transcripts()[threadId] ?? []).filter((message) => message.ordinal !== undefined && message.ordinal < firstOrdinal) : [];
    const incomingIds = new Set(messageRecords.map((message) => message.id));
    const folded = foldTurnItems([...earlierItems, ...rows], [...earlierMessages.filter((message) => !incomingIds.has(message.id)), ...messageRecords]);
    const previousHistory = threadHistoryFor(threadId);
    const previousRuns = earlierItems.length > 0 ? runList() : [];
    batch(() => {
      snapshotLoadedFor.set(threadId);
      // A bounded snapshot names where earlier history continues (historyCursor / hasMoreHistory).
      invalidateThreadHistoryLoad(threadId);
      setThreadHistory(threadId, { cursor: earlierItems.length > 0 ? previousHistory.cursor : typeof item.historyCursor === "string" ? item.historyCursor : null, hasMore: earlierItems.length > 0 ? previousHistory.hasMore : item.hasMoreHistory === true, loading: false, error: null });
      rememberAutomaticQueueMessages(threadId, Array.isArray(projection.messages) ? projection.messages : [], true);
      transcripts.update((all) => ({ ...all, [threadId]: folded.messages }));
      turnItems.set(folded.items);
      turnItemOrders.set(folded.orders);
      runtimeRequests.set(Array.isArray(projection.runtimeRequests) ? upsertAll([], projection.runtimeRequests, true) : []);
      subagentRecords.set(subagentSnapshot(projection.subagents));
      runList.set(Array.isArray(projection.runs) ? upsertAll(previousRuns, projection.runs) : previousRuns);
      attemptList.set(Array.isArray(projection.attempts) ? upsertAll([], projection.attempts) : []);
      nodeList.set(Array.isArray(projection.nodes) ? upsertAll([], projection.nodes) : []);
      threadRecord.set(record(projection.thread));
      providerSessionRecords.set(shellRecordArray(projection.providerSessions));
      providerThreadRecords.set(shellRecordArray(projection.providerThreads));
      contextTransfersByThread.update((all) => ({ ...all, [threadId]: shellRecordArray(projection.contextTransfers) }));
      checkpointList.set(Array.isArray(projection.checkpoints) ? projection.checkpoints.map(record).filter((entry): entry is Record<string, unknown> => entry !== null) : []);
    });
  } else if (item.kind === "event") {
    const event = record(item.event);
    if (event?.type === "message.updated") {
      rememberAutomaticQueueMessages(threadId, [event.payload], false);
      const message = readMessage(event.payload);
      if (!message) return;
      transcripts.update((all) => {
        const list = all[threadId] ?? [];
        const found = list.some((entry) => entry.id === message.id);
        return { ...all, [threadId]: found ? list.map((entry) => entry.id === message.id ? keepTurnItemFields(entry, message) : entry) : [...list, message] };
      });
    } else if (event?.type === "context-transfer.created" || event?.type === "context-transfer.updated") {
      const transfer = record(event.payload);
      if (transfer && typeof transfer.id === "string") contextTransfersByThread.update((all) => ({ ...all, [threadId]: upsertById(all[threadId] ?? [], transfer) }));
    } else if (event?.type === "runtime-request.updated") updateRuntimeRequest(event.payload);
    else if (event?.type === "turn-item.updated") updateTurnItem(event.payload, threadId);
    else if (event?.type === "subagent.updated") updateSubagent(event.payload);
    else if (event?.type === "run.created" || event?.type === "run.updated") updateRun(event.payload);
    else if (event?.type === "run-attempt.created" || event?.type === "run-attempt.updated" || event?.type === "node.updated") {
      const entity = record(event.payload);
      if (entity && typeof entity.id === "string") (event.type === "node.updated" ? nodeList : attemptList).update((list) => upsertById(list, entity));
    }
    else if (event?.type === "checkpoint.captured") updateCheckpoint(event.payload);
    else if (event?.type === "provider-session.attached" || event?.type === "provider-session.updated") {
      const session = record(event.payload);
      if (session && typeof session.id === "string") providerSessionRecords.update((list) => upsertById(list, session));
    } else if (event?.type === "provider-session.detached") {
      const payload = record(event.payload);
      const gone = payload?.providerSessionId ?? payload?.id;
      providerSessionRecords.update((list) => list.filter((session) => session.id !== gone));
    } else if (event?.type === "provider-thread.updated") {
      const entry = record(event.payload);
      if (entry && typeof entry.id === "string") providerThreadRecords.update((list) => upsertById(list, entry));
    } else if (event?.type === "thread.pull-request-link-updated") {
      threadRecord.update((thread) => patchThreadPullRequest(thread, event.payload));
    } else if (typeof event?.type === "string" && THREAD_RECORD_EVENTS.has(event.type)) {
      const next = record(event.payload);
      if (next && typeof next.id === "string") threadRecord.set(next);
    }
  }
}

function patchThreadPullRequest(thread: ReturnType<typeof record>, payload: unknown): ReturnType<typeof record> {
  const link = record(payload);
  if (!thread || !link || typeof link.host !== "string" || typeof link.repository !== "string" || typeof link.number !== "number" || !Array.isArray(thread.pullRequests)) return thread;
  const host = link.host.toLowerCase();
  const repository = link.repository.toLowerCase();
  const index = thread.pullRequests.findIndex((value) => {
    const current = record(value);
    return current?.source !== "stack-dismissed" && current?.number === link.number
      && typeof current.host === "string" && current.host.toLowerCase() === host
      && typeof current.repository === "string" && current.repository.toLowerCase() === repository;
  });
  if (index < 0) return thread;
  const links = [...thread.pullRequests];
  links[index] = link;
  return { ...thread, pullRequests: links };
}

/** applyOrchestrationV2ProjectionEvent: the events whose payload is the thread record itself. */
const THREAD_RECORD_EVENTS = new Set([
  "thread.created", "thread.archived", "thread.unarchived", "thread.settled", "thread.unsettled", "thread.snoozed", "thread.unsnoozed",
  "thread.auto-settle-set", "thread.pinned", "thread.unpinned", "thread.pin-reordered", "thread.active-reordered", "thread.metadata-updated",
  "thread.pull-request-synced", "thread.runtime-mode-updated", "thread.interaction-mode-updated", "thread.model-selection-updated",
  "thread.provider-switched", "thread.guest-share-updated", "thread.visited", "thread.tags-updated", "thread.marked-unread",
]);
/** Consecutive failures of the open thread's subscription; any delivered item clears it. */
let threadRetryCount = 0;
/** threads.ts retryExpectedFailureAfter: 250 ms, doubling to rpc/client.ts's 30 s cap, so a failing thread cannot storm. */
function retryOpenThreadSubscription(id: string) {
  // threads.ts: a cold open that failed over the socket asks HTTP (/bounded), which also tells a missing thread apart.
  // A thread the server said is missing stays parked (only a new open of it tries again).
  if (missingThreadIds.has(id)) return;
  if (snapshotLoadedFor() !== id) {
    void loadBoundedThreadSnapshot(id).then((result) => {
      if (openThreadId() !== id || subscribedThreadId !== null) return;
      if (result === "missing") { missingThreadIds.add(id); missingThreadHook?.(id); return; }
      if (result === "present") { subscribeOpenThread(); return; }
      setTimeout(() => { if (openThreadId() === id && subscribedThreadId === null) subscribeOpenThread(); }, streamRetryDelay(threadRetryCount++));
    });
    return;
  }
  // A saved environment's thread asks that environment the same question (environments/missingThreadRoute.ts).
  if (parseScopedKey(id) && remoteThreadProbe) {
    void remoteThreadProbe(id).then((result) => {
      if (result === "missing" && openThreadId() === id && !missingThreadIds.has(id)) { missingThreadIds.add(id); missingThreadHook?.(id); }
    }).catch(() => undefined);
  }
  const delay = streamRetryDelay(threadRetryCount++);
  setTimeout(() => { if (openThreadId() === id && subscribedThreadId === null) subscribeOpenThread(); }, delay);
}
/** ThreadRouteView: told when the open thread is confirmed missing (environments/missingThreadRoute.ts). */
let missingThreadHook: ((id: string) => void) | null = null;
export function setMissingThreadHook(hook: ((id: string) => void) | null) { missingThreadHook = hook; }
/** Asks a saved environment whether a scoped thread exists (its bounded snapshot answering 404). */
let remoteThreadProbe: ((id: string) => Promise<"present" | "missing" | "unavailable">) | null = null;
export function setRemoteThreadProbe(probe: typeof remoteThreadProbe) { remoteThreadProbe = probe; }
/** Navigate home: no thread open (the reference's navigate({ to: "/" })). */
export function closeOpenThread() { openThreadId.set(null); scheduleDraftSave(); }
/** Threads the bounded HTTP snapshot answered 404 for: parked (threads.ts setDeleted) instead of retried against a missing id. */
const missingThreadIds = new Set<string>();
/** Test seam: the fetch the bounded thread snapshot goes through. */
let boundedThreadFetch: typeof fetch = (input, init) => fetch(input, init);
let boundedThreadEndpoint: { url: string; bearer: string } | null = null;
export function setBoundedThreadFetchForTests(next: typeof fetch | null, endpoint: { url: string; bearer: string } | null = null) {
  boundedThreadFetch = next ?? ((input, init) => fetch(input, init));
  boundedThreadEndpoint = endpoint;
}
/**
 * Where a thread's HTTP routes (/bounded, /history) go: a saved environment's thread (scoped key) asks that environment
 * with its own session bearer and local id, as threads.ts does for every environment; anything else asks the primary.
 */
async function threadHttpTarget(threadId: string, seam: { url: string; bearer: string | null } | null): Promise<{ origin: string; bearer: string; localId: string; primaryEndpoint: string | null } | null> {
  const scoped = parseScopedKey(threadId);
  let endpoint: string | null | undefined;
  let bearer: string | null | undefined;
  if (seam) { endpoint = seam.url; bearer = seam.bearer; }
  else if (scoped) {
    const environment = managedEnvironment(scoped.environmentId);
    endpoint = environment?.url;
    bearer = environment ? await loadSessionBearer(environment.url) : null;
  } else { endpoint = backendUrl(); bearer = backendBearer(); }
  if (!endpoint || !bearer) return null;
  const url = new URL(endpoint);
  url.protocol = url.protocol === "wss:" || url.protocol === "https:" ? "https:" : "http:";
  return { origin: url.origin, bearer, localId: scoped ? scoped.localId : threadId, primaryEndpoint: scoped || seam ? null : endpoint };
}
/** threadSnapshotPagination of the environment that owns the thread. */
function threadPaginates(threadId: string): boolean {
  const scoped = parseScopedKey(threadId);
  return scoped ? environmentConfigs()[scoped.environmentId]?.threadSnapshotPagination === true : threadSnapshotPaginationCapability();
}
/** boundedThreadSnapshotHttp.ts DEFAULT_BOUNDED_THREAD_SNAPSHOT_TIMEOUT_MS. */
const BOUNDED_THREAD_SNAPSHOT_TIMEOUT_MS = 6000;
/**
 * boundedThreadSnapshotHttp.ts: GET /api/orchestration/threads/:id/bounded, applied as the thread's snapshot. "missing" is
 * the server's EnvironmentResourceNotFoundError (404); any other failure leaves the snapshot to the socket.
 */
export async function loadBoundedThreadSnapshot(threadId: string): Promise<"present" | "missing" | "unavailable"> {
  try {
    const target = await threadHttpTarget(threadId, boundedThreadEndpoint);
    if (!target) return "unavailable";
    const query = new URLSearchParams({ compactTurnItems: "1", dedupeBodies: "1", compactIds: "1", deferWork: "1" });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"unavailable">((resolve) => { timer = setTimeout(() => resolve("unavailable"), BOUNDED_THREAD_SNAPSHOT_TIMEOUT_MS); });
    const load = (async (): Promise<"present" | "missing" | "unavailable"> => {
      const response = await boundedThreadFetch(`${target.origin}/api/orchestration/threads/${encodeURIComponent(target.localId)}/bounded?${query.toString()}`, {
        method: "GET",
        headers: { authorization: `Bearer ${target.bearer}`, "x-t3-orchestration-protocol": "2" },
      });
      const body = record(await response.json().catch(() => null));
      if (response.status === 404 && body?._tag === "EnvironmentResourceNotFoundError") return "missing";
      if (response.status !== 200 || !body || typeof body.snapshotSequence !== "number" || !record(body.projection)) return "unavailable";
      if (openThreadId() !== threadId || (target.primaryEndpoint !== null && backendUrl() !== target.primaryEndpoint)) return "unavailable";
      // A fresh decoder: the HTTP body is one self-contained response (its own id table and deduped bodies).
      const decoder = createThreadWireDecoder();
      threadWireDecoders.delete(`open:${threadId}`);
      handleThreadEvent(threadId, threadWire(`open:${threadId}`)(decoder({ ...body, kind: "snapshot" })));
      return "present";
    })();
    const result = await Promise.race([load, timeout]);
    clearTimeout(timer);
    if (result === "unavailable") console.warn("Could not load the bounded thread snapshot over HTTP; using the socket snapshot instead.");
    return result;
  } catch (error) {
    console.warn("Could not load the bounded thread snapshot over HTTP; using the socket snapshot instead.", error);
    return "unavailable";
  }
}
/** The subscribeThread input: resume after the last applied sequence when the detail is already held (afterSequence). */
function threadSubscribeInput(threadId: string, resumeAfter: number | null, bounded = false) {
  // A server that pages snapshots (threadSnapshotPagination) sends a bounded window; earlier turns load on request.
  // threads.ts sends the compact forms with the bounded opt-in and deduped bodies always; backend/threadWire.ts undoes
  // them. Deferred work rows load on expand (loadDeferredWork).
  return {
    threadId, ...(resumeAfter !== null ? { afterSequence: resumeAfter } : {}), requestCompletionMarker: true,
    ...(bounded && threadPaginates(threadId) ? { acceptBoundedSnapshot: true, acceptDeferredWork: true, acceptCompactTurnItems: true, acceptCompactIds: true } : {}),
    acceptDedupedBodies: true,
  };
}
/** A saved environment's open thread: the same input as the primary's, with that environment's pagination capability. */
function savedThreadSubscribeInput(key: string, localId: string, resumeAfter: number | null) {
  return { ...threadSubscribeInput(localId, resumeAfter), ...(threadPaginates(key) ? { acceptBoundedSnapshot: true, acceptDeferredWork: true, acceptCompactTurnItems: true, acceptCompactIds: true } : {}), acceptDedupedBodies: true };
}
/** One wire decoder per subscribed thread: deduped event bodies restore from what that thread's stream delivered. */
const threadWireDecoders = new Map<string, (value: unknown) => unknown>();
function threadWire(key: string): (value: unknown) => unknown {
  let decoder = threadWireDecoders.get(key);
  if (!decoder) { decoder = createThreadWireDecoder(); threadWireDecoders.set(key, decoder); }
  return decoder;
}

/** A resumed stream may omit bodies already held by the previous subscription. */
function seedThreadWire(key: string, threadId: string, detail: ThreadDetailCache) {
  threadWire(key)({ kind: "snapshot", projection: {
    messages: (transcripts()[threadId] ?? []).map((message) => ({ id: message.id, text: message.body })),
    checkpoints: detail.checkpointList, subagents: Object.values(detail.subagentRecords), turnItems: detail.turnItems,
  } });
}

/** The open thread's paged history (ThreadHistoryMeta): where "Load earlier turns" continues, and its state. */
export interface ThreadHistoryState { cursor: string | null; hasMore: boolean; loading: boolean; error: string | null }
const threadHistoryByThread = signal<Record<string, ThreadHistoryState>>({});
const threadHistoryLoadVersions = new Map<string, number>();
let nextThreadHistoryLoadVersion = 0;
function invalidateThreadHistoryLoad(threadId: string): number {
  const version = ++nextThreadHistoryLoadVersion;
  threadHistoryLoadVersions.set(threadId, version);
  return version;
}
const NO_HISTORY: ThreadHistoryState = { cursor: null, hasMore: false, loading: false, error: null };
export const threadHistoryFor = (threadId: string | null | undefined): ThreadHistoryState => (threadId ? threadHistoryByThread()[threadId] ?? NO_HISTORY : NO_HISTORY);
function setThreadHistory(threadId: string, patch: Partial<ThreadHistoryState>) {
  threadHistoryByThread.update((all) => ({ ...all, [threadId]: { ...(all[threadId] ?? NO_HISTORY), ...patch } }));
}
/** Test seam: the fetch, endpoint and bearer the history pages go through. */
let historyFetch: typeof fetch = (input, init) => fetch(input, init);
let historyEndpoint: (() => { url: string; bearer: string | null }) | null = null;
export function setThreadHistoryFetchForTests(next: typeof fetch | null, endpoint: { url: string; bearer: string } | null = null) {
  historyFetch = next ?? ((input, init) => fetch(input, init));
  historyEndpoint = endpoint ? () => endpoint : null;
}

/**
 * ThreadState.loadEarlier: GET /api/orchestration/threads/:id/history pages until a user-authored turn arrives (or, with
 * `throughEntryId`, until that entry is loaded), and folds each page's turn items in front of what is shown.
 */
export async function loadEarlierThreadHistory(threadId: string, throughEntryId?: string): Promise<"loaded" | "noop" | "busy" | "error"> {
  const current = threadHistoryFor(threadId);
  if (current.cursor === null || !current.hasMore) return "noop";
  if (current.loading) return "busy";
  const version = invalidateThreadHistoryLoad(threadId);
  const isCurrent = () => threadHistoryLoadVersions.get(threadId) === version && openThreadId() === threadId;
  const stale = () => {
    if (threadHistoryLoadVersions.get(threadId) === version) setThreadHistory(threadId, { loading: false });
    return "noop" as const;
  };
  setThreadHistory(threadId, { loading: true, error: null });
  let cursor: string = current.cursor;
  const fail = (message: string) => { if (!isCurrent()) return stale(); setThreadHistory(threadId, { loading: false, error: message }); return "error" as const; };
  try {
    while (true) {
      const target = await threadHttpTarget(threadId, historyEndpoint ? historyEndpoint() : null);
      if (!target) return fail("Environment is not connected.");
      const query = new URLSearchParams({ cursor, ...(throughEntryId ? { throughEntryId } : { deferWork: "1" }) });
      const response = await historyFetch(`${target.origin}/api/orchestration/threads/${encodeURIComponent(target.localId)}/history?${query.toString()}`, {
        method: "GET",
        headers: { authorization: `Bearer ${target.bearer}`, "x-t3-orchestration-protocol": "2" },
      });
      if (!isCurrent()) return stale();
      if (!response.ok) {
        let message = "";
        try { const body = record(await response.json()); message = typeof body?.message === "string" ? body.message : ""; } catch { /* not JSON */ }
        return fail(message.trim() || "Could not load earlier activity.");
      }
      const page = record(await response.json());
      if (!isCurrent()) return stale();
      if (!page || !Array.isArray(page.items)) return fail("Could not load earlier activity.");
      const rows = page.items.map((row) => record(row)?.item);
      const nextCursor = typeof page.nextCursor === "string" && page.nextCursor ? page.nextCursor : null;
      const hasMore = page.hasMoreHistory === true;
      const userTurn = rows.some((row) => { const item = record(row); return item?.type === "user_message" && item.createdBy === "user"; });
      const reached = throughEntryId ? rows.some((row) => { const item = record(row); return item?.id === throughEntryId || item?.messageId === throughEntryId; }) : false;
      const keepPaging = hasMore && (throughEntryId ? !reached : !userTurn);
      if (keepPaging && (nextCursor === null || nextCursor === cursor)) return fail("History did not advance.");
      batch(() => {
        const folded = foldTurnItems(rows, []);
        const shown = transcripts()[threadId] ?? [];
        const known = new Set(shown.map((message) => message.id));
        transcripts.update((all) => ({ ...all, [threadId]: [...folded.messages.filter((message) => !known.has(message.id)), ...shown] }));
        const present = new Set(turnItems().map((item) => item.id));
        turnItems.set([...folded.items.filter((item) => !present.has(item.id)), ...turnItems()]);
        turnItemOrders.set({ ...folded.orders, ...turnItemOrders() });
        setThreadHistory(threadId, { cursor: nextCursor, hasMore, loading: keepPaging, error: null });
      });
      if (!keepPaging) return "loaded";
      cursor = nextCursor!;
    }
  } catch (cause) {
    return fail(cause instanceof Error && cause.message.trim() ? cause.message : "Could not load earlier activity.");
  }
}

/** Work anchors with a deferred-work read in flight (threads.ts loadEarlier with a workAnchorId). */
const deferredWorkLoads = new Map<string, Promise<"loaded" | "noop" | "error">>();
/**
 * threads.ts loadEarlier(undefined, workAnchorId) + threadHistoryMerge.ts mergeOlderHistoryIntoProjection's work branch:
 * a settled turn's collapsed work (an item carrying `deferredWork`, sent for acceptDeferredWork) is read with
 * GET /history?view=work from its cursor through the anchor, keeping only that thread's items between the anchor's
 * ordinal and `deferredWork.lastOrdinal`; they land after the anchor, and the anchor drops `deferredWork` once complete.
 */
export function loadDeferredWork(threadId: string, anchorId: string): Promise<"loaded" | "noop" | "error"> {
  const key = `${threadId}\n${anchorId}`;
  const running = deferredWorkLoads.get(key);
  if (running) return running;
  const load = (async (): Promise<"loaded" | "noop" | "error"> => {
    const anchorOf = () => openThreadId() === threadId ? turnItems().find((item) => item.id === anchorId) : undefined;
    const deferredOf = (item: Record<string, unknown> | undefined) => {
      const deferred = record(item?.deferredWork);
      return deferred && typeof deferred.cursor === "string" && typeof deferred.lastOrdinal === "number" ? { cursor: deferred.cursor, lastOrdinal: deferred.lastOrdinal } : null;
    };
    const first = deferredOf(anchorOf());
    if (!first) return "noop";
    let cursor = first.cursor;
    try {
      while (true) {
        const target = await threadHttpTarget(threadId, historyEndpoint ? historyEndpoint() : null);
        if (!target) return "error";
        const query = new URLSearchParams({ cursor, throughEntryId: anchorId, view: "work" });
        const response = await historyFetch(`${target.origin}/api/orchestration/threads/${encodeURIComponent(target.localId)}/history?${query.toString()}`, {
          method: "GET",
          headers: { authorization: `Bearer ${target.bearer}`, "x-t3-orchestration-protocol": "2" },
        });
        if (!response.ok) return "error";
        const page = record(await response.json());
        if (!page || !Array.isArray(page.items)) return "error";
        const anchor = anchorOf();
        const deferred = deferredOf(anchor);
        // "Work history changed": the anchor moved on (or the thread closed) while the page was read.
        if (!anchor || !deferred || deferred.cursor !== cursor) return deferred ? "error" : "noop";
        const nextCursor = typeof page.nextCursor === "string" && page.nextCursor ? page.nextCursor : null;
        if (nextCursor !== null && nextCursor === cursor) return "error";
        const anchorOrdinal = typeof anchor.ordinal === "number" ? anchor.ordinal : -Infinity;
        const rows = page.items.map(record).filter((row): row is Record<string, unknown> => row !== null).flatMap((row) => {
          const item = record(row.item);
          if (!item || item.id === anchorId) return [];
          if (row.sourceThreadId !== undefined && anchor.threadId !== undefined && row.sourceThreadId !== anchor.threadId) return [];
          const ordinal = typeof item.ordinal === "number" ? item.ordinal : NaN;
          return ordinal >= anchorOrdinal && ordinal <= deferred.lastOrdinal ? [item] : [];
        });
        batch(() => {
          const present = new Set(turnItems().map((item) => item.id));
          const folded = foldTurnItems(rows.filter((item) => !present.has(item.id)), []);
          const shown = transcripts()[threadId] ?? [];
          const known = new Set(shown.map((message) => message.id));
          if (folded.messages.some((message) => !known.has(message.id))) transcripts.update((all) => ({ ...all, [threadId]: [...shown, ...folded.messages.filter((message) => !known.has(message.id))] }));
          const list = turnItems();
          const at = list.findIndex((item) => item.id === anchorId);
          const current = list[at]!;
          const nextAnchor: Record<string, unknown> = nextCursor === null
            ? (({ deferredWork: _done, ...rest }) => rest)(current)
            : { ...current, deferredWork: { ...record(current.deferredWork), cursor: nextCursor } };
          turnItems.set([...list.slice(0, at), nextAnchor, ...folded.items, ...list.slice(at + 1)]);
          turnItemOrders.set({ ...turnItemOrders(), ...folded.orders });
        });
        if (nextCursor === null) { forgetDeferredWork(threadWire(`open:${threadId}`), anchorId); return "loaded"; }
        cursor = nextCursor;
      }
    } catch {
      return "error";
    }
  })();
  deferredWorkLoads.set(key, load);
  void load.finally(() => deferredWorkLoads.delete(key));
  return load;
}

/** The open thread whose detail snapshot has arrived (threadSync.ts: the detail exists). */
const snapshotLoadedFor = signal<string | null>(null);
const subscribingFor = signal<string | null>(null);
/**
 * resolveThreadSyncPhase: "loading" while a server thread's detail has not arrived yet, so the timeline shows no empty-state copy
 * and the end of it reads "Loading messages...". The port keeps no cache, so there is no "syncing" phase.
 */
export function threadSyncPhase(): "loading" | null {
  const id = openThreadId();
  if (!id || connectionStatus() !== "connected") return null;
  const serverThread = threadById(id) !== undefined && !unpromoted().some((thread) => thread.id === id);
  // Only while a subscription for it is live: with none (no client, no shell) or after it failed, nothing is loading.
  return serverThread && snapshotLoadedFor() !== id && subscribingFor() === id ? "loading" : null;
}

/** threads.ts foregroundResubscriptions: the open thread's stream restarts from its last sequence. */
function resubscribeOpenThreadOnForeground() {
  const id = openThreadId();
  if (!id || subscribedThreadId !== id) return;
  if (unsubscribeThread) unsubscribeThread();
  unsubscribeThread = null;
  subscribedThreadId = null;
  subscribeOpenThread();
}
function subscribeOpenThread() {
  const id = openThreadId();
  if (id === subscribedThreadId) return;
  // handleShellEvent calls this on every shell update (a burst of them arrives while other threads' shells are
  // created during an import), harmless only because of the guard above. If something else ever nulls
  // subscribedThreadId for the thread that is still open and already showing its detail (a dropped low-level
  // subscription, or an intentional resubscribe such as sendDraft's after a send), id !== subscribedThreadId here
  // even though nothing about the open thread changed. currentDetailThreadId is what tracks that: unlike
  // subscribedThreadId it is not reset by those paths, so this re-entry case is told apart from an actual switch.
  const sameThreadReentry = currentDetailThreadId !== null && currentDetailThreadId === id;
  // composerDraftStore modelSelectionByProvider / activeProvider: a draft reopens with the model picked in it.
  if (!sameThreadReentry && id) {
    const picked = draftModelByThread[id];
    const match = picked && unpromoted().some((thread) => thread.id === id) ? models().find((item) => item.provider === picked.provider && item.model === picked.model) : undefined;
    if (match) model.set(match);
  }
  // Leaving a thread stashes its detail (turn items, runs, subagents, ...) so a quick switch back restores it
  // from here instead of wiping it and waiting a full round trip on the server's snapshot again.
  if (!sameThreadReentry) {
    // threads.ts: a 404 parks the mount only; a new open of the thread asks again (it may have been created since).
    if (id) missingThreadIds.delete(id);
    if (currentDetailThreadId) {
      invalidateThreadHistoryLoad(currentDetailThreadId);
      if (threadHistoryFor(currentDetailThreadId).loading) setThreadHistory(currentDetailThreadId, { loading: false });
      stashThreadDetail(currentDetailThreadId);
    }
    currentDetailThreadId = id;
  }
  const previous = !sameThreadReentry && id ? threadDetailCache.get(id) : undefined;
  const retained = !sameThreadReentry && id ? retainedThreadDetail(id) : undefined;
  // A background subscription has continued applying updates while this thread was not visible.
  // Adopt it only when it is at least as recent as the saved open-thread projection.
  const cached = retained && (!previous?.loaded || previous.sequence === null || (retained.sequence !== null && retained.sequence >= previous.sequence))
    ? retained : previous;
  // One flush for the whole switch: this runtime's computeds run eagerly per signal write, so writing these
  // one at a time would let the thread timeline, activity and sync phase each re-render on stale, mismatched data.
  batch(() => {
    if (sameThreadReentry) {
      // The open thread's own detail is already live in these signals: a re-entry for it (whatever caused it)
      // only re-establishes the subscription below, and must not clear or replace what is already shown.
    } else if (cached) {
      runtimeRequests.set(cached.runtimeRequests);
      turnItems.set(cached.turnItems);
      turnItemOrders.set(cached.turnItemOrders);
      subagentRecords.set(cached.subagentRecords);
      runList.set(cached.runList);
      checkpointList.set(cached.checkpointList);
      attemptList.set(cached.attemptList ?? []);
      nodeList.set(cached.nodeList ?? []);
      threadRecord.set(cached.threadRecord);
      providerSessionRecords.set(cached.providerSessions);
      providerThreadRecords.set(cached.providerThreads);
      // A visited thread that had fully loaded before paints at once, with no "loading" blip while the live
      // subscription below quietly refreshes it; one that was still loading keeps asking.
      if (cached.loaded) snapshotLoadedFor.set(id);
      else if (snapshotLoadedFor() !== id) snapshotLoadedFor.set(null);
    } else {
      // A resubscribe of the same thread (after a send) keeps what is shown; only another thread starts loading.
      if (snapshotLoadedFor() !== id) snapshotLoadedFor.set(null);
      runtimeRequests.set([]);
      turnItems.set([]);
      turnItemOrders.set({});
      subagentRecords.set({});
      runList.set([]);
      checkpointList.set([]);
      attemptList.set([]);
      nodeList.set([]);
      threadRecord.set(null);
      providerSessionRecords.set([]);
      providerThreadRecords.set([]);
    }
    subscribingFor.set(null);
  });
  if (!sameThreadReentry) openThreadSequence = cached?.loaded ? cached.sequence : null;
  // Held detail resumes the stream after its last sequence (the server replays what was missed, or sends a
  // snapshot when it cannot); anything else asks for the snapshot.
  const resumeAfter = id !== null && snapshotLoadedFor() === id ? openThreadSequence : null;
  if (unsubscribeThread) unsubscribeThread();
  unsubscribeThread = null;
  subscribedThreadId = null;
  if (!sameThreadReentry) {
    // A revisited thread gets back what its stream had delivered: a resumed subscription sends no new snapshot.
    if (cached) { restoreThreadProviderState(cached.providerState); restoreBannerThreadState(cached.bannerState); }
    else { resetThreadProviderState(); resetBannerThreadState(); }
    if (id && cached === retained && cached) seedThreadWire(`open:${id}`, id, cached);
  }
  const scoped = id ? parseScopedKey(id) : null;
  if (id && scoped) {
    // A saved environment's thread: subscribe on that environment's session with its own id.
    const remoteThread = remoteShellThread(id);
    if (!remoteThread) return;
    subscribedThreadId = id;
    subscribingFor.set(id);
    unsubscribeThread = subscribeEnvironment(scoped.environmentId, "orchestration.subscribeThread", savedThreadSubscribeInput(id, scoped.localId, resumeAfter), (value) => handleThreadEvent(id, threadWire(`open:${id}`)(value)), (error) => {
      if (subscribedThreadId !== id) return;
      unsubscribeThread = null;
      subscribedThreadId = null;
      subscribingFor.set(null);
      reportError(error);
      retryOpenThreadSubscription(id);
    });
    return;
  }
  // A shell that omits idle subagents (or older settled threads) does not hold every openable thread: threads.ts
  // subscribes by id regardless, and a missing one answers 404 over HTTP (parked below).
  if (!id || !client || (!shellThreads.some((thread) => thread.id === id) && !(shellIdentity()?.omitIdleSubagents && !unpromoted().some((thread) => thread.id === id)))) return;
  const remote = shellThreads.find((thread) => thread.id === id);
  const selection = record(remote?.modelSelection);
  if (selection && typeof selection.instanceId === "string" && typeof selection.model === "string") setSelectedModel(selection.instanceId, selection.model);
  subscribedThreadId = id;
  subscribingFor.set(id);
  unsubscribeThread = client.subscribe("orchestration.subscribeThread", threadSubscribeInput(id, resumeAfter, true), (value) => handleThreadEvent(id, threadWire(`open:${id}`)(value)), (error) => {
    if (subscribedThreadId !== id) return;
    unsubscribeThread = null;
    subscribedThreadId = null;
    subscribingFor.set(null);
    reportError(error);
    retryOpenThreadSubscription(id);
  });
}


// ---- Further thread subscriptions (a side chat shown beside the open thread) ----
// The client runtime keeps one projection per subscribed thread (packages/client-runtime/src/state); the open
// thread keeps the signals above, and every other retained thread gets its own projection here, reference counted
// so its subscription ends when the last view holding it closes.
interface ThreadProjection {
  loaded: boolean;
  thread: Record<string, unknown> | null;
  nodes: Record<string, unknown>[];
  attempts: Record<string, unknown>[];
  checkpoints: Record<string, unknown>[];
  runs: Record<string, unknown>[];
  requests: Record<string, unknown>[];
  items: Record<string, unknown>[];
  orders: Record<string, number>;
  subagents: Record<string, Record<string, unknown>>;
  providerSessions: Record<string, unknown>[];
  providerThreads: Record<string, unknown>[];
  providerState: ProviderState;
  bannerState: ThreadSessionState;
}
const emptyProjection = (): ThreadProjection => ({ loaded: false, thread: null, nodes: [], attempts: [], checkpoints: [], runs: [], requests: [], items: [], orders: {}, subagents: {}, providerSessions: [], providerThreads: [], providerState: emptyProviderState(), bannerState: emptyBannerThreadState() });
const sideProjections = signal<Record<string, ThreadProjection>>({});
const sideSubscriptions = new Map<string, { count: number; stop: (() => void) | null; client: BackendClient | null; sequence: number | null }>();

/** The retained projection can become the open projection without waiting for another snapshot. */
function retainedThreadDetail(threadId: string): ThreadDetailCache | undefined {
  const entry = sideSubscriptions.get(threadId);
  const projection = sideProjections()[threadId];
  if (!entry || !projection?.loaded) return undefined;
  return {
    loaded: true, sequence: entry.sequence, threadRecord: projection.thread,
    runtimeRequests: projection.requests, turnItems: projection.items, turnItemOrders: projection.orders,
    subagentRecords: projection.subagents, runList: projection.runs, checkpointList: projection.checkpoints,
    attemptList: projection.attempts, nodeList: projection.nodes, providerSessions: projection.providerSessions,
    providerThreads: projection.providerThreads, providerState: projection.providerState, bannerState: projection.bannerState,
  };
}

function upsertById(list: Record<string, unknown>[], item: Record<string, unknown>): Record<string, unknown>[] {
  const index = list.findIndex((entry) => entry.id === item.id);
  return index < 0 ? [...list, item] : list.map((entry, current) => current === index ? item : entry);
}

function projectTurnItem(projection: ThreadProjection, threadId: string, value: unknown): ThreadProjection {
  const item = record(value);
  if (!item || typeof item.id !== "string") return projection;
  const id = item.id;
  const itemMessage = messageFromTurnItem(item);
  if (itemMessage) {
    const omitted = itemTextOmitted(item);
    transcripts.update((all) => mergeTranscriptItem(all, threadId, itemMessage, omitted));
  }
  const orders = projection.orders[id] !== undefined ? projection.orders : { ...projection.orders, [id]: timestamp(item.startedAt) || timestamp(item.updatedAt) };
  return { ...projection, orders, items: upsertById(projection.items, item) };
}

function projectSubagent(projection: ThreadProjection, value: unknown): ThreadProjection {
  const agent = record(value);
  if (!agent || typeof agent.id !== "string") return projection;
  const previous = projection.subagents[agent.id];
  return { ...projection, subagents: { ...projection.subagents, [agent.id]: restoreSubagentBodies(agent, previous) } };
}

/** handleThreadEvent for a retained thread that is not the open one: the same contract, its own projection. */
function handleSideThreadEvent(threadId: string, value: unknown) {
  const held = sideSubscriptions.get(threadId);
  if (!held) return;
  const item = record(value);
  if (!item) return;
  if (item.kind === "event" && typeof item.sequence === "number") {
    if (held.sequence !== null && item.sequence <= held.sequence) return;
    held.sequence = item.sequence;
  }
  let next = sideProjections()[threadId] ?? emptyProjection();
  if (item.kind === "snapshot") {
    const projection = record(item.projection);
    if (!projection) return;
    contextTransfersByThread.update((all) => ({ ...all, [threadId]: shellRecordArray(projection.contextTransfers) }));
    held.sequence = typeof item.snapshotSequence === "number" ? item.snapshotSequence : null;
    rememberAutomaticQueueMessages(threadId, Array.isArray(projection.messages) ? projection.messages : [], true);
    const messages = Array.isArray(projection.messages) ? projection.messages.map(readMessage).filter((entry): entry is Message => entry !== null) : [];
    transcripts.update((all) => ({ ...all, [threadId]: messages }));
    next = {
      ...emptyProjection(), loaded: true, thread: record(projection.thread),
      nodes: Array.isArray(projection.nodes) ? upsertAll([], projection.nodes) : [],
      attempts: Array.isArray(projection.attempts) ? upsertAll([], projection.attempts) : [],
      checkpoints: Array.isArray(projection.checkpoints) ? upsertAll([], projection.checkpoints) : [],
      subagents: subagentSnapshot(projection.subagents),
      providerSessions: shellRecordArray(projection.providerSessions),
      providerThreads: shellRecordArray(projection.providerThreads),
      providerState: foldProviderThreadItem(emptyProviderState(), item),
      bannerState: foldBannerThreadItem(threadId, emptyBannerThreadState(), item),
    };
    if (Array.isArray(projection.runs)) next = { ...next, runs: upsertAll([], projection.runs) };
    if (Array.isArray(projection.runtimeRequests)) next = { ...next, requests: upsertAll([], projection.runtimeRequests, true) };
    const rows = Array.isArray(projection.visibleTurnItems) ? projection.visibleTurnItems.map(visibleRowItem)
      : Array.isArray(projection.turnItems) ? projection.turnItems : null;
    if (rows) {
      const folded = foldTurnItems(rows, messages);
      transcripts.update((all) => ({ ...all, [threadId]: folded.messages }));
      next = { ...next, items: folded.items, orders: folded.orders };
    }
  } else if (item.kind === "event") {
    const event = record(item.event);
    next = { ...next, providerState: foldProviderThreadItem(next.providerState, item), bannerState: foldBannerThreadItem(threadId, next.bannerState, item) };
    if (event?.type === "message.updated") {
      rememberAutomaticQueueMessages(threadId, [event.payload], false);
      const message = readMessage(event.payload);
      if (!message) return;
      transcripts.update((all) => {
        const list = all[threadId] ?? [];
        const found = list.some((entry) => entry.id === message.id);
        return { ...all, [threadId]: found ? list.map((entry) => entry.id === message.id ? keepTurnItemFields(entry, message) : entry) : [...list, message] };
      });
      sideProjections.update((all) => ({ ...all, [threadId]: next }));
      return;
    }
    const payload = record(event?.payload);
    if (event?.type === "context-transfer.created" || event?.type === "context-transfer.updated") { if (payload && typeof payload.id === "string") contextTransfersByThread.update((all) => ({ ...all, [threadId]: upsertById(all[threadId] ?? [], payload) })); }
    else if (event?.type === "runtime-request.updated") { if (payload && typeof payload.id === "string") next = { ...next, requests: [...next.requests.filter((old) => old.id !== payload.id), payload] }; }
    else if (event?.type === "turn-item.updated") next = projectTurnItem(next, threadId, payload);
    else if (event?.type === "subagent.updated") next = projectSubagent(next, payload);
    else if (event?.type === "run.created" || event?.type === "run.updated") { if (payload && typeof payload.id === "string") next = { ...next, runs: upsertById(next.runs, payload) }; }
    else if (event?.type === "node.updated") { if (payload && typeof payload.id === "string") next = { ...next, nodes: upsertById(next.nodes, payload) }; }
    else if (event?.type === "run-attempt.created" || event?.type === "run-attempt.updated") { if (payload && typeof payload.id === "string") next = { ...next, attempts: upsertById(next.attempts, payload) }; }
    else if (event?.type === "checkpoint.captured") { if (payload && typeof payload.id === "string") next = { ...next, checkpoints: upsertById(next.checkpoints, payload) }; }
    else if (event?.type === "provider-session.attached" || event?.type === "provider-session.updated") { if (payload && typeof payload.id === "string") next = { ...next, providerSessions: upsertById(next.providerSessions, payload) }; }
    else if (event?.type === "provider-session.detached") {
      const gone = payload?.providerSessionId ?? payload?.id;
      next = { ...next, providerSessions: next.providerSessions.filter((session) => session.id !== gone) };
    }
    else if (event?.type === "provider-thread.updated") { if (payload && typeof payload.id === "string") next = { ...next, providerThreads: upsertById(next.providerThreads, payload) }; }
    else if (event?.type === "thread.pull-request-link-updated") next = { ...next, thread: patchThreadPullRequest(next.thread, payload) };
    else if (typeof event?.type === "string" && THREAD_RECORD_EVENTS.has(event.type)) { if (payload && typeof payload.id === "string") next = { ...next, thread: payload }; }
  } else return;
  sideProjections.update((all) => ({ ...all, [threadId]: next }));
}

function subscribeSideThread(threadId: string) {
  const entry = sideSubscriptions.get(threadId);
  const scoped = parseScopedKey(threadId);
  if (entry && scoped) {
    // A saved environment's thread subscribes on that environment's session, once.
    if (entry.stop || !remoteShellThread(threadId)) return;
    let failed = false;
    const stop = subscribeEnvironment(scoped.environmentId, "orchestration.subscribeThread", threadSubscribeInput(scoped.localId, entry.sequence), (value) => { sideFailures.delete(threadId); handleSideThreadEvent(threadId, threadWire(`side:${threadId}`)(value)); }, (error) => {
      failed = true;
      const current = sideSubscriptions.get(threadId);
      if (current) current.stop = null;
      reportError(error);
      retrySideThread(threadId, current, error);
    });
    if (!failed) entry.stop = stop;
    return;
  }
  if (!entry || (entry.stop && entry.client === client)) return;
  entry.stop?.();
  entry.stop = null;
  entry.client = null;
  if (!client || !shellThreads.some((thread) => thread.id === threadId)) return;
  const owner = client;
  entry.client = owner;
  entry.stop = owner.subscribe("orchestration.subscribeThread", threadSubscribeInput(threadId, entry.sequence), (value) => { sideFailures.delete(threadId); handleSideThreadEvent(threadId, threadWire(`side:${threadId}`)(value)); }, (error) => {
    const current = sideSubscriptions.get(threadId);
    if (!current || current.client !== owner) return;
    current.stop = null;
    current.client = null;
    reportError(error);
    retrySideThread(threadId, current, error);
  });
}

/** threads.ts retryExpectedFailureAfter applies to every subscribed thread: a retained thread retries 250 ms doubling to 30 s. */
const sideFailures = new Map<string, number>();
function retrySideThread(threadId: string, entry: unknown, error: Error) {
  if (!entry || isAuthorizationFailure(error)) return;
  const failures = sideFailures.get(threadId) ?? 0;
  sideFailures.set(threadId, failures + 1);
  setTimeout(() => {
    const current = sideSubscriptions.get(threadId);
    if (current === entry && !current.stop) subscribeSideThread(threadId);
  }, streamRetryDelay(failures));
}

/** Subscribes retained threads that are not yet subscribed on the current connection (after a reconnect too). */
function syncSideSubscriptions() {
  for (const threadId of sideSubscriptions.keys()) subscribeSideThread(threadId);
}

/**
 * Keeps `threadId` subscribed while a view shows it beside the open thread; the returned release ends the
 * subscription and drops its projection once nothing holds it.
 */
export function retainThread(threadId: string): () => void {
  const entry = sideSubscriptions.get(threadId);
  if (entry) entry.count += 1;
  else {
    const cached = threadDetailCache.get(threadId);
    const saved: ThreadProjection = cached?.loaded ? {
      loaded: true, thread: cached.threadRecord, nodes: cached.nodeList ?? [], attempts: cached.attemptList ?? [],
      checkpoints: cached.checkpointList, runs: cached.runList, requests: cached.runtimeRequests,
      items: cached.turnItems, orders: cached.turnItemOrders, subagents: cached.subagentRecords,
      providerSessions: cached.providerSessions, providerThreads: cached.providerThreads,
      providerState: cached.providerState, bannerState: cached.bannerState,
    } : emptyProjection();
    sideSubscriptions.set(threadId, { count: 1, stop: null, client: null, sequence: cached?.loaded ? cached.sequence : null });
    sideProjections.update((all) => ({ ...all, [threadId]: all[threadId] ?? saved }));
    if (cached?.loaded) seedThreadWire(`side:${threadId}`, threadId, cached);
    subscribeSideThread(threadId);
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const current = sideSubscriptions.get(threadId);
    if (!current) return;
    current.count -= 1;
    if (current.count > 0) return;
    current.stop?.();
    sideSubscriptions.delete(threadId);
    threadWireDecoders.delete(`side:${threadId}`);
    stableSideMessages.delete(threadId);
    sideProjections.update((all) => { const { [threadId]: _dropped, ...rest } = all; return rest; });
    if (threadId !== untracked(openThreadId) && !threadDetailCache.has(threadId) && isServerThread(threadId)) {
      transcripts.update((all) => {
        if (!(threadId in all)) return all;
        const { [threadId]: _dropped, ...rest } = all;
        return rest;
      });
    }
  };
}
/** How many views hold `threadId`'s extra subscription (0 when none), for tests and diagnostics. */
export const retainedThreadCount = (threadId: string) => (sideProjections()[threadId] ? sideSubscriptions.get(threadId)?.count ?? 0 : 0);
/** Whether `threadId` has a live extra subscription on the current connection. */
export const isThreadSubscribed = (threadId: string) => threadId === subscribedThreadId || Boolean(sideSubscriptions.get(threadId)?.stop);

const projectionOf = (threadId: string) => sideProjections()[threadId] ?? emptyProjection();
const isOpen = (threadId: string) => threadId === openThreadId();

/** threadMessages for any thread: the open thread's, or a retained thread's own transcript. */
export function threadMessagesFor(threadId: string): Message[] {
  if (isOpen(threadId)) return threadMessages();
  const items = messageItemIndex(projectionOf(threadId).items);
  const next = withPendingEchoes(threadId, (transcripts()[threadId] ?? []).map((message) => messageWithOrdinal(message, items.get(message.id))));
  // Retained side views can be read repeatedly as other threads stream.
  if (!sideSubscriptions.has(threadId)) return next;
  let stable = stableSideMessages.get(threadId);
  if (!stable) { stable = createStableMessageList(); stableSideMessages.set(threadId, stable); }
  return stable(threadId, next);
}
/** Each retained thread's own subagent records, including updates while it is not selected. */
export function threadSubagentRecordsFor(threadId: string): Record<string, unknown>[] {
  return Object.values(isOpen(threadId) ? subagentRecords() : projectionOf(threadId).subagents);
}
/** Attempt-fold inputs for the selected thread or an available retained projection. */
export function threadAttemptSourcesFor(threadId: string): { attempts: Record<string, unknown>[]; nodes: Record<string, unknown>[]; messageItems: Map<unknown, Record<string, unknown>> } | null {
  if (isOpen(threadId)) return { attempts: attemptList(), nodes: nodeList(), messageItems: messageItemIndex(turnItems()) };
  const projection = sideProjections()[threadId];
  return projection ? { attempts: projection.attempts, nodes: projection.nodes, messageItems: messageItemIndex(projection.items) } : null;
}
export function threadRunsFor(threadId: string): Record<string, unknown>[] {
  return isOpen(threadId) ? runList() : projectionOf(threadId).runs;
}
/** Provider state for a selected or retained thread. */
export function threadProviderStateFor(threadId: string): ProviderState {
  return isOpen(threadId) ? providerState() : projectionOf(threadId).providerState;
}
export function threadApprovalsFor(threadId: string): PendingApproval[] {
  if (isOpen(threadId)) return threadApprovals();
  const projection = projectionOf(threadId);
  return approvalsFrom(projection.requests, projection.items);
}
export function threadUserInputsFor(threadId: string): PendingUserInput[] {
  if (isOpen(threadId)) return threadUserInputs();
  const projection = projectionOf(threadId);
  return userInputsFrom(projection.requests, projection.items);
}
export function threadActivityFor(threadId: string): ActivityItem[] {
  if (isOpen(threadId)) return threadActivity();
  const projection = projectionOf(threadId);
  return projectActivity(projection.items, projection.orders, projection.subagents);
}
/** Whether a selected or retained thread is working and since when. */
export function threadWorkFor(threadId: string): { working: boolean; startedAt: number | null } {
  if (isOpen(threadId)) return { working: threadWorking(), startedAt: threadWorkStartedAt() };
  const projection = projectionOf(threadId);
  const runless = runlessSubagentWork(projection.thread, projection.nodes);
  if (runless) return runless;
  const runs = projection.runs;
  const state = deriveWorking(runs, threadById(threadId)?.status === "running", threadApprovalsFor(threadId).length > 0 || threadUserInputsFor(threadId).length > 0,
    (run) => typeof run.id === "string" && providerTurnEnded(projection.providerState, readActiveRun(runs, run.id)));
  return { working: state.working, startedAt: state.startedAt ?? null };
}
export function threadActiveRunIdFor(threadId: string): string | null {
  if (isOpen(threadId)) return threadActiveRunId();
  const run = activeRun(projectionOf(threadId).runs);
  return typeof run?.id === "string" ? run.id : null;
}
export const composerDraftFor = (threadId: string) => draftsByThread()[threadId] ?? "";
export const isSendingFor = (threadId: string) => sendingThreadIds().includes(threadId);
export const draftAttachmentsFor = (threadId: string): DraftAttachment[] =>
  (attachmentDrafts()[threadId] ?? []).map(({ file: _file, uploadedId: _uploadedId, ...item }) => item);
export const draftAttachmentFileFor = (threadId: string, attachmentId: string): File | undefined =>
  attachmentDrafts()[threadId]?.find((item) => item.id === attachmentId)?.file;
/** The server's id for an uploaded draft attachment (a file preview reads it back through the signed-asset route). */
export const draftAttachmentUploadedIdFor = (threadId: string, attachmentId: string): string | undefined =>
  attachmentDrafts()[threadId]?.find((item) => item.id === attachmentId)?.uploadedId;

/** Test seam: feeds one subscribeThread item for `threadId` through the path its subscription takes. */
export function applyThreadEventForTest(threadId: string, value: unknown) {
  if (isOpen(threadId)) handleThreadEvent(threadId, value);
  else handleSideThreadEvent(threadId, value);
}

function commandId() { return `command:${crypto.randomUUID()}`; }

/** The draft has not been launched yet (a local draft thread: multiple-model sends start from one). */
export const isLocalDraft = (id: string) => unpromoted().some((thread) => thread.id === id);
/** environment.capabilities.requiredWorktreeBootstrap: the server can launch a thread into a worktree it prepares. */
export const supportsWorktreeBootstrap = () => worktreeBootstrapCapability();
export const supportsPullRequestChecks = () => pullRequestChecksCapability();
/** The draft's attachments that are on the server, as a message sends them. */
export function uploadedDraftAttachments(id: string): { type: string; id: string; name: string; mimeType: string; sizeBytes: number }[] {
  return (attachmentDrafts()[id] ?? []).flatMap((item) => item.uploadedId ? [{ type: item.kind, id: item.uploadedId, name: item.name, mimeType: item.mimeType, sizeBytes: item.sizeBytes, ...(item.source !== undefined ? { source: item.source } : {}) }] : []);
}
/** Drops a draft's attachments once every thread of a multiple-model send took them. */
export function clearDraftAttachments(id: string): void {
  attachmentDrafts.update((all) => ({ ...all, [id]: [] }));
  scheduleDraftSave();
}

/**
 * One thread of a multiple-model send (useMultipleModelSend's startTurn with a worktree bootstrap): a new thread of the
 * draft's project on `branch`, in its own worktree, starting with the message. Resolves with the new thread's id.
 */
export async function launchModelThread(input: {
  draftId: string; threadId: string; modelSelection: Record<string, unknown>; text: string; branch: string; startFromOrigin?: boolean;
}): Promise<void> {
  const thread = threadById(input.draftId);
  if (!thread?.projectId) throw new Error("This draft no longer points to an available project.");
  const options = optionsByThread()[input.draftId] ?? serverOptionsByThread()[input.draftId] ?? defaultThreadOptions();
  const attachments = uploadedDraftAttachments(input.draftId);
  await requestBackend("orchestration.launchThread", {
    commandId: commandId(), creationSource: "web", threadId: input.threadId, projectId: thread.projectId,
    title: deriveThreadTitleSeed({ text: input.text, attachments: attachments.map((item) => ({ kind: item.type, name: item.name })), fallbackLabels: sendTitleFallbackLabels(sendExtrasFor(input.draftId).context?.records ?? []) }), generateTitle: Boolean(input.text), modelSelection: input.modelSelection,
    runtimeMode: options.runtime, interactionMode: options.interaction,
    workspaceStrategy: { type: "worktree", baseRef: input.branch, ...(input.startFromOrigin ? { startFromOrigin: true } : {}) },
    initialMessage: { messageId: `message:${crypto.randomUUID()}`, text: input.text, attachments, ...sendExtrasFor(input.draftId) },
  });
}
async function dispatch(command: Record<string, unknown>) {
  return requestBackend("orchestration.dispatchCommand", { ...command, commandId: commandId() });
}

/** The branch a thread's local checkout moved to (ComposerBanners publishes it); null once it matches again. */
const checkoutBranchByThread = new Map<string, string>();
export function publishLocalCheckoutBranch(threadId: string, currentBranch: string | null): void {
  if (currentBranch === null) checkoutBranchByThread.delete(threadId); else checkoutBranchByThread.set(threadId, currentBranch);
}

/**
 * persistThreadSettingsForNextTurn: a server thread takes the composer's branch (a moved local checkout) and its
 * permission and interaction modes before the turn starts. A failure aborts the turn, as in the reference.
 */
function nextTurnSettingsFor(threadId: string, composer: { runtime: string; interaction: string }): Record<string, unknown>[] {
  const server = serverOptionsByThread()[threadId];
  if (!server || !isServerThread(threadId)) return [];
  return nextTurnSettingsCommands({ threadId, server: { runtime: server.runtime, interaction: server.interaction, branch: threadById(threadId)?.branch ?? null }, runtime: composer.runtime, interaction: composer.interaction, checkoutBranch: checkoutBranchByThread.get(threadId) ?? null });
}
async function runNextTurnSettings(threadId: string, commands: Record<string, unknown>[]): Promise<void> {
  const generation = connectionGeneration;
  for (const command of commands) {
    await dispatch(command);
    if (generation !== connectionGeneration) return;
    if (command.type === "thread.runtime-mode.set") serverOptionsByThread.update((all) => ({ ...all, [threadId]: { ...(all[threadId] ?? defaultThreadOptions()), runtime: command.runtimeMode as RuntimeMode } }));
    if (command.type === "thread.interaction-mode.set") serverOptionsByThread.update((all) => ({ ...all, [threadId]: { ...(all[threadId] ?? defaultThreadOptions()), interaction: command.interactionMode as InteractionMode } }));
  }
}
export async function persistThreadSettingsForNextTurn(threadId: string, composer: { runtime: string; interaction: string }): Promise<void> {
  await runNextTurnSettings(threadId, nextTurnSettingsFor(threadId, composer));
}

/** Safety net: an echo the server accepted but never delivered into the transcript is dropped after this long. */
const ECHO_GRACE_MS = 30_000;
const STANDALONE_COMMAND_DRAFT = "\u0000standalone-command";
const redactedMessage = (error: unknown, fallback: string) => {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return (message || fallback).replace(/([?&](?:wsTicket|dpop|token|access_token)=)[^\s&]+/gi, "$1[redacted]");
};

/** operations/commands.ts persistAttachments: images still held as files go up as data URLs in one
 * `assets.persistChatAttachments`; the stored attachments come back in the same order. */
type StoredChatAttachment = { type: string; id: string; name: string; mimeType: string; sizeBytes: number; source?: unknown };
export async function persistInlineAttachments(threadId: string, messageId: string, items: readonly InternalAttachment[], request: (method: string, payload: unknown) => Promise<unknown> = requestBackend): Promise<StoredChatAttachment[]> {
  const stored = new Map<InternalAttachment, StoredChatAttachment>();
  const uploads: InternalAttachment[] = [];
  for (const item of items) {
    if (item.uploadedId) stored.set(item, { type: item.kind, id: item.uploadedId, name: item.name, mimeType: item.mimeType, sizeBytes: item.sizeBytes, ...(item.source !== undefined ? { source: item.source } : {}) });
    else uploads.push(item);
  }
  if (uploads.length > 0) {
    const payload = await Promise.all(uploads.map(async (item) => {
      if (!item.file) throw new Error(`Attachment '${item.name}' failed to upload.`);
      const bytes = new Uint8Array(await item.file.arrayBuffer());
      let binary = "";
      for (let at = 0; at < bytes.length; at += 0x8000) binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
      // chatViewSend.ts prepareTurnAttachments: the composer id (and source, when the draft has one) go with the data URL.
      const source = (item as { source?: unknown }).source;
      return { type: "image" as const, id: item.id, name: item.name, mimeType: item.mimeType, sizeBytes: item.sizeBytes, dataUrl: `data:${item.mimeType};base64,${btoa(binary)}`, ...(source ? { source } : {}) };
    }));
    const result = record(await request("assets.persistChatAttachments", { threadId, messageId, attachments: payload }));
    const persisted = Array.isArray(result?.attachments) ? result.attachments.map(record) : [];
    uploads.forEach((item, index) => {
      const value = persisted[index];
      if (value && typeof value.id === "string") stored.set(item, { type: typeof value.type === "string" ? value.type : "image", id: value.id, name: typeof value.name === "string" ? value.name : item.name, mimeType: typeof value.mimeType === "string" ? value.mimeType : item.mimeType, sizeBytes: typeof value.sizeBytes === "number" ? value.sizeBytes : item.sizeBytes });
    });
  }
  return items.flatMap((item) => { const value = stored.get(item); return value ? [value] : []; });
}

async function sendThreadMessage(id: string, text: string, originalDraft: string, intent?: SendIntent) {
  if (sendingThreadIds().includes(id)) return;
  const thread = threadById(id);
  const choice = scopeOverride !== null ? selectedModelFor(id) : selectedModel();
  if (backendStatus() !== "connected") {
    // useComposerSend: a warning toast, and the draft stays where it is.
    showToast({ type: "warning", title: "Not connected: message not sent", description: "Reconnecting to the environment. Try again once it is connected." });
    return;
  }
  if (!thread?.projectId) {
    showToast({ type: "warning", title: "Choose a project first", description: "This draft no longer points to an available project." });
    return;
  }
  if (!choice) { setThreadError(id, "No provider model is available in this environment"); return; }
  if (text.length > 120000) { setThreadError(id, "Messages cannot exceed 120,000 characters"); return; }
  const options = optionsByThread()[id] ?? serverOptionsByThread()[id] ?? defaultThreadOptions();
  if (!availableRuntimeModes().includes(options.runtime) || !availableInteractionModes().includes(options.interaction)) {
    setThreadError(id, "Choose a mode supported by the selected provider"); return;
  }
  if (unpromoted().some((item) => item.id === id) && options.workspace.type === "worktree" && !options.workspace.baseRef?.trim()) {
    setThreadError(id, "Select a base branch before sending in New worktree mode."); return;
  }
  const selectedAttachments = attachmentDrafts()[id] ?? [];
  const inlineAttachments = attachmentsUseDataUrls();
  if (inlineAttachments && selectedAttachments.some((item) => item.kind !== "image" || (!item.file && !item.uploadedId))) {
    setThreadError(id, selectedAttachments.some((item) => item.kind !== "image") ? "This server does not support file attachments." : "Choose this file again to retry the upload"); return;
  }
  if (!inlineAttachments && selectedAttachments.some((item) => item.status !== "uploaded" || !item.uploadedId)) {
    setThreadError(id, selectedAttachments.some((item) => item.status === "failed") ? "Retry or remove failed uploads before sending." : "Wait for attachments to finish uploading, or retry failed uploads");
    return;
  }
  let attachments: StoredChatAttachment[] = selectedAttachments.flatMap((item) => item.uploadedId ? [{ type: item.kind, id: item.uploadedId,
    name: item.name, mimeType: item.mimeType, sizeBytes: item.sizeBytes, ...(item.source !== undefined ? { source: item.source } : {}) }] : []);
  sendingThreadIds.update((ids) => [...ids, id]);
  const generation = connectionGeneration;
  const endpoint = connectionUrl();
  deliveryWarnings.delete(endpoint);
  connectionError.set(null);
  // getComposerProviderState: an OpenCode model the catalog no longer lists keeps its saved options (without the plan agent).
  const savedOptions = modelOptionsFor(choice.provider, choice.model);
  const preserved = preservedOpenCodeOptions({ driver: choice.driver, model: choice.model, catalog: models().filter((entry) => entry.provider === choice.provider), options: savedOptions });
  const pickedOptions = preserved.applies ? preserved.options : withImplicitFastModeDefault(choice.optionDescriptors, savedOptions);
  const modelSelection = { instanceId: choice.provider, model: choice.model, ...(pickedOptions ? { options: pickedOptions } : {}) };
  // Read before the first await: a /clear armed while this send is in flight is for the next message.
  const freshArm = freshContextArm(id);
  const messageId = `message:${crypto.randomUUID()}`;
  if (inlineAttachments && selectedAttachments.some((item) => !item.uploadedId)) {
    try {
      attachments = await persistInlineAttachments(id, messageId, selectedAttachments);
    } catch (error) {
      sendingThreadIds.update((ids) => ids.filter((item) => item !== id));
      setThreadError(id, error instanceof Error ? error.message : String(error));
      return;
    }
  }
  const baseExtras = sendExtrasFor(id);
  // uploadedAttachmentContextRecord: attachments whose chip is in the text travel as image / file context records too.
  const attachmentRecords = attachmentContextRecords(text, selectedAttachments);
  const extras = attachmentRecords.length === 0 ? baseExtras : { context: { version: 1 as const, records: [...(baseExtras.context?.records ?? []), ...attachmentRecords] } };
  // The optimistic send (optimisticUserMessages.ts): the message is in the transcript and the draft is clear at once; a failure
  // takes the echo back out and restores the draft and its attachments. A queued send shows in the composer's queue, not here.
  setThreadError(id, null);
  if (intent !== "queue" && originalDraft !== STANDALONE_COMMAND_DRAFT) {
    const echo: Message = { id: messageId, role: "user", body: text, order: Date.now(), streaming: false, pending: true,
      attachments: attachments.map((item) => ({ id: item.id, name: item.name, mimeType: item.mimeType, sizeBytes: item.sizeBytes, type: item.type })),
      ...(extras.context ? { context: extras.context } : {}), ...(intent === "steer" ? { inputIntent: "steer" } : {}) };
    pendingEchoes.update((all) => ({ ...all, [id]: [...(all[id] ?? []), echo] }));
    for (const item of selectedAttachments) if (item.file && item.uploadedId) handOffAttachmentPreview(item.uploadedId, item.file, item.kind);
  }
  if (intent === "queue" && originalDraft !== STANDALONE_COMMAND_DRAFT) {
    pendingQueuedSends.update((all) => ({ ...all, [id]: [...(all[id] ?? []), { id: messageId, text, attachments: attachments.map((item) => ({ id: item.id, name: item.name, mimeType: item.mimeType, sizeBytes: item.sizeBytes, type: item.type })) }] }));
  }
  const clearedDraft = originalDraft !== STANDALONE_COMMAND_DRAFT && draftsByThread()[id] === originalDraft;
  if (clearedDraft) draftsByThread.update((all) => ({ ...all, [id]: "" }));
  const sentIds = new Set(selectedAttachments.map((item) => item.id));
  if (sentIds.size > 0) attachmentDrafts.update((all) => ({ ...all, [id]: (all[id] ?? []).filter((item) => !sentIds.has(item.id)) }));
  scheduleDraftSave();
  try {
    if (unpromoted().some((item) => item.id === id)) {
      await requestBackend("orchestration.launchThread", {
        commandId: commandId(), creationSource: "web", threadId: id, projectId: thread.projectId,
        title: deriveThreadTitleSeed({ text, attachments: selectedAttachments, fallbackLabels: sendTitleFallbackLabels(extras.context?.records ?? []) }), generateTitle: Boolean(text), modelSelection,
        runtimeMode: options.runtime, interactionMode: options.interaction,
        workspaceStrategy: options.workspace, initialMessage: { messageId, text, attachments, ...extras },
      });
    } else {
      // Awaited only when something differs, so a plain send still dispatches in the same turn.
      const settingsCommands = nextTurnSettingsFor(id, { runtime: options.runtime, interaction: options.interaction });
      if (settingsCommands.length > 0) await runNextTurnSettings(id, settingsCommands);
      const send = (mode: SendIntent) => dispatch({
        type: "message.dispatch", createdBy: "user", creationSource: "web", threadId: id,
        messageId, text, attachments, modelSelection, ...extras,
        // As startThreadTurn: a queue is queue_after_active; anything else starts immediately and names its delivery
        // intent, so the server queues an "auto" send behind a run that is still starting.
        ...(mode !== "queue" ? { deliveryIntent: mode } : {}),
        dispatchMode: { type: mode === "queue" ? "queue_after_active" : "start_immediately" },
        ...(freshArm !== undefined ? { freshContext: true } : {}),
      });
      await sendWithSteerFallback(send, intent ?? "auto");
    }
    setTimeout(() => { dropPendingEcho(id, messageId); dropPendingQueuedSend(id, messageId); }, ECHO_GRACE_MS);
    if (generation !== connectionGeneration) return;
    if (freshArm !== undefined) disarmFreshContext(id, freshArm);
    clearSendContext(id);
    optionsByThread.update((all) => { const { [id]: _removed, ...remaining } = all; return remaining; });
    scheduleDraftSave();
    // The thread's live subscription already delivers the turn: a send only subscribes a thread that had no
    // subscription yet (a draft just launched), and never asks for the snapshot again.
    subscribeOpenThread();
  } catch (error) {
    dropPendingEcho(id, messageId);
    dropPendingQueuedSend(id, messageId);
    if (generation === connectionGeneration) {
      // The reference restores only into an empty composer: text typed since stays.
      if (clearedDraft && (draftsByThread()[id] ?? "") === "") draftsByThread.update((all) => ({ ...all, [id]: originalDraft }));
      if (sentIds.size > 0) {
        attachmentDrafts.update((all) => {
          const current = all[id] ?? [];
          const present = new Set(current.map((item) => item.id));
          return { ...all, [id]: [...selectedAttachments.filter((item) => !present.has(item.id)), ...current] };
        });
      }
      scheduleDraftSave();
      setThreadError(id, redactedMessage(error, "Failed to send message."));
      // useComposerSend: a draft whose send failed after the reader left it (or sent it in the background) says so.
      if (unpromoted().some((item) => item.id === id) && (backgroundSendIds.has(id) || openThreadId() !== id)) {
        const background = backgroundSendIds.has(id);
        showToast({ type: "error", title: background ? "Background task failed" : "Could not start thread", description: redactedMessage(error, "Failed to send message."), actions: [{ label: "Open draft", run: () => openThreadById(id) }] });
      }
    } else {
      const saved = draftsByEnvironment.get(endpoint);
      if (clearedDraft && saved && !saved.drafts[id]) draftsByEnvironment.set(endpoint, { ...saved, drafts: { ...saved.drafts, [id]: originalDraft } });
      deliveryWarnings.set(endpoint, "A message's delivery could not be confirmed after disconnecting. Check the thread before sending again.");
    }
  } finally {
    backgroundSendIds.delete(id);
    sendingThreadIds.update((ids) => ids.filter((item) => item !== id));
  }
}

export function stopThread() {
  const id = scopeId();
  if (id) void dispatch({ type: "thread.stop", threadId: id }).catch(reportError);
}

/** Approvals whose answer is in flight (useThreadRequests respondingRequestIds): a send over them does not decline them again. */
const respondingApprovals = signal<string[]>([]);
export const respondingApprovalIds = () => respondingApprovals();
export async function respondToApproval(requestId: string, decision: ApprovalDecision, feedback?: string): Promise<void> {
  const id = scopeId();
  const request = (id ? threadApprovalsFor(id) : threadApprovals()).find((item) => item.id === requestId);
  // A redirect declines whatever the request offers (threadRequests.ts declinePendingApprovals).
  if (!id || !request || (!request.decisions.includes(decision) && decision !== "decline")) throw new Error("This approval is no longer available");
  if (request.responseCapability === "not_resumable") throw new Error("Provider process is gone. Interrupt or restart the run to respond.");
  respondingApprovals.update((ids) => [...ids, requestId]);
  try {
    await dispatch({ type: "runtime-request.respond", threadId: id, requestId, decision, ...(feedback === undefined ? {} : { feedback }) });
  } catch (error) {
    reportError(error);
    throw error;
  } finally {
    respondingApprovals.update((ids) => ids.filter((item) => item !== requestId));
  }
}

const answeredUserInputIds = new Set<string>();

/**
 * Moves the composer's attachments (`threadId`'s) into bucket `from` and brings bucket `to` back as the composer's.
 * With `pending`, question buckets of requests outside it are dropped — or returned to `threadId` when `answered`
 * is provided and those closed requests were never answered (stopped/expired). Exported for tests.
 */
export function parkQuestionAttachments<T>(
  all: Record<string, T[]>,
  threadId: string,
  from: string,
  to: string,
  pending: ReadonlySet<string> | null,
  answered?: ReadonlySet<string>,
): Record<string, T[]> {
  const next = { ...all };
  const parked = [...(next[from] ?? []), ...(next[threadId] ?? [])];
  if (parked.length > 0) next[from] = parked; else delete next[from];
  next[threadId] = next[to] ?? [];
  delete next[to];
  if (pending) {
    const returned: T[] = [];
    const prefix = `${threadId}\u0000question:`;
    for (const key of Object.keys(next)) {
      if (!key.startsWith(prefix)) continue;
      const [requestId] = JSON.parse(key.slice(prefix.length)) as [string, string];
      if (!pending.has(requestId)) {
        if (answered && !answered.has(requestId)) returned.push(...(next[key] ?? []));
        delete next[key];
      }
    }
    if (returned.length > 0) {
      const seen = new Set(next[threadId].map((item) => (typeof item === "object" && item !== null && "id" in item ? (item as { id: unknown }).id : item)));
      const extra = returned.filter((item) => {
        const id = typeof item === "object" && item !== null && "id" in item ? (item as { id: unknown }).id : item;
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
      });
      if (extra.length > 0) next[threadId] = [...next[threadId], ...extra];
    }
  }
  return next;
}
/** questionAttachmentDraftId: the attachment draft of one question of a pending request. */
export const questionAttachmentKey = (threadId: string, requestId: string, questionId: string) => `${threadId}\u0000question:${JSON.stringify([requestId, questionId])}`;
const threadAttachmentBucket = (threadId: string) => `${threadId}\u0000thread-draft`;
export interface ActiveUserInputQuestion { requestId: string; questionId: string; allowCustomAnswer: boolean; responding: boolean }
const activeUserInputQuestions = signal<Record<string, ActiveUserInputQuestion>>({});

/**
 * The question the composer answers on a thread (or null once none is asked). The composer's attachments are that
 * question's: switching questions parks them in the question's draft and brings back the next one's, and the thread's
 * own draft attachments wait aside until no question is asked. Drafts of requests no longer pending are dropped
 * (pruneResolvedQuestionAttachmentDrafts).
 */
export function setActiveUserInputQuestion(threadId: string, active: ActiveUserInputQuestion | null): void {
  untracked(() => switchQuestionAttachments(threadId, active));
}
// Which question owned the composer's attachments when the app last ran, so a reload mid-question puts them back with
// that question instead of the next message (questionAttachments drafts persist across reloads in the reference).
const QUESTION_OWNER_STORAGE_KEY = "t3code:question-attachment-owner:v1";
let restoredQuestionOwners: Record<string, { requestId: string; questionId: string }> = {};
void Storage.getItem(QUESTION_OWNER_STORAGE_KEY).then((raw) => {
  try { const parsed = raw ? JSON.parse(raw) : null; if (parsed && typeof parsed === "object") restoredQuestionOwners = { ...parsed, ...restoredQuestionOwners }; } catch { /* ignore a damaged value */ }
}, () => undefined);
function saveQuestionOwners() {
  const owners = Object.fromEntries(Object.entries(activeUserInputQuestions()).map(([threadId, active]) => [threadId, { requestId: active.requestId, questionId: active.questionId }]));
  void Storage.setItem(QUESTION_OWNER_STORAGE_KEY, JSON.stringify(owners)).catch(() => undefined);
}
/** The bucket the composer's attachments came from: the open question, else the one restored from the last run. Exported for tests. */
export function questionAttachmentOwner(threadId: string, previous: { requestId: string; questionId: string } | undefined, restored: Record<string, { requestId: string; questionId: string }>): string {
  const owner = previous ?? restored[threadId];
  return owner ? questionAttachmentKey(threadId, owner.requestId, owner.questionId) : threadAttachmentBucket(threadId);
}
function switchQuestionAttachments(threadId: string, active: ActiveUserInputQuestion | null): void {
  const previous = activeUserInputQuestions()[threadId];
  const { [threadId]: _old, ...rest } = activeUserInputQuestions();
  activeUserInputQuestions.set(active ? { ...rest, [threadId]: active } : rest);
  const from = questionAttachmentOwner(threadId, previous, restoredQuestionOwners);
  if (!previous) { const { [threadId]: _restored, ...others } = restoredQuestionOwners; restoredQuestionOwners = others; }
  saveQuestionOwners();
  const to = active ? questionAttachmentKey(threadId, active.requestId, active.questionId) : threadAttachmentBucket(threadId);
  if (from === to) return;
  attachmentDrafts.update((all) => parkQuestionAttachments(all, threadId, from, to, active ? null : new Set(threadUserInputsFor(threadId).map((request) => request.id)), active ? undefined : answeredUserInputIds));
  scheduleDraftSave();
}

export async function respondToUserInput(requestId: string, answers: Record<string, unknown>, activeQuestionId?: string): Promise<void> {
  const id = scopeId();
  if (!id || !threadUserInputsFor(id).some((item) => item.id === requestId)) throw new Error("This question is no longer available");
  // usePendingThreadRequests: thread chips in a typed answer become thread links (projectPendingUserInputAnswer), and
  // the composer's attachments go with the question that was open (attachmentsByQuestionId), once all are uploaded.
  const threadRecords = attachedExtraContexts(id).filter((record): record is Extract<typeof record, { kind: "thread" }> => record.kind === "thread");
  const providerAnswers = Object.fromEntries(Object.entries(answers).map(([questionId, answer]) => [questionId, projectPendingUserInputAnswer(answer, threadRecords)]));
  // Each question keeps its own attachment draft (questionAttachments.ts); the open question's are the composer's.
  const request = threadUserInputsFor(id).find((item) => item.id === requestId);
  const questionIds = request?.questions.map((question) => question.id) ?? [];
  const all = attachmentDrafts();
  const itemsFor = (questionId: string) => (questionId === activeQuestionId ? all[id] ?? [] : all[questionAttachmentKey(id, requestId, questionId)] ?? []);
  const byQuestion: Record<string, ReturnType<typeof uploadedDraftAttachments>> = {};
  for (const questionId of new Set([...questionIds, ...(activeQuestionId ? [activeQuestionId] : [])])) {
    const items = itemsFor(questionId);
    if (items.length === 0) continue;
    if (items.some((item) => !item.uploadedId)) throw new Error("Wait for attachments to finish uploading, or remove failed uploads.");
    byQuestion[questionId] = items.map((item) => ({ type: item.kind, id: item.uploadedId!, name: item.name, mimeType: item.mimeType, sizeBytes: item.sizeBytes }));
  }
  const attachmentsByQuestionId = Object.keys(byQuestion).length > 0 ? byQuestion : undefined;
  try {
    await dispatch({ type: "runtime-request.respond", threadId: id, requestId, answers: providerAnswers, ...(attachmentsByQuestionId ? { attachmentsByQuestionId } : {}) });
    answeredUserInputIds.add(requestId);
    attachmentDrafts.update((current) => {
      const next = { ...current };
      for (const questionId of questionIds) delete next[questionAttachmentKey(id, requestId, questionId)];
      if (activeQuestionId && attachmentsByQuestionId?.[activeQuestionId]) next[id] = [];
      return next;
    });
    scheduleDraftSave();
  } catch (error) {
    reportError(error);
    throw error;
  }
}

export function setThreadPinned(id: string, pinned: boolean) {
  void dispatch({ type: pinned ? "thread.pin" : "thread.unpin", threadId: id }).catch(reportError);
}
export async function archiveThread(id: string): Promise<void> {
  try {
    await dispatch({ type: "thread.archive", threadId: id });
    await refreshArchivedThreads();
  } catch (error) {
    reportError(error);
    throw error;
  }
}
export async function restoreThread(id: string): Promise<void> {
  try {
    await dispatch({ type: "thread.unarchive", threadId: id });
    await refreshArchivedThreads();
  } catch (error) {
    reportError(error);
    throw error;
  }
}

let archiveRefresh = 0;
let pendingArchiveChanges: ArchiveChanges | null = null;
export async function refreshArchivedThreads(): Promise<void> {
  const generation = connectionGeneration;
  const request = ++archiveRefresh;
  const changes: ArchiveChanges = new Map();
  pendingArchiveChanges = changes;
  archiveIsLoading.set(true);
  archiveProblem.set(null);
  try {
    const snapshot = record(await requestBackend("orchestration.getArchivedShellSnapshot", {}));
    if (!snapshot || !Array.isArray(snapshot.threads)) throw new Error("Invalid archived thread list");
    if (generation !== connectionGeneration || request !== archiveRefresh) return;
    archivedShellThreads = mergeArchiveSnapshot(shellRecordArray(snapshot.threads), changes);
    // Preserve linked environments' archives and the memoized shell identities, just as a shell event does.
    updateShell();
  } catch (error) {
    if (generation === connectionGeneration && request === archiveRefresh) archiveProblem.set("Failed to load archived threads."); // createArchivedThreadSnapshotsAtomFamily: any failure reads the same.
  } finally {
    if (pendingArchiveChanges === changes) pendingArchiveChanges = null;
    if (generation === connectionGeneration && request === archiveRefresh) archiveIsLoading.set(false);
  }
}
export function renameThread(id: string, title: string) {
  // ChatHeader: a failed rename toasts "Failed to rename thread" with the error.
  if (title.trim()) void dispatch({ type: "thread.metadata.update", threadId: id, title: title.trim() }).catch((error: unknown) => {
    showToast({ type: "error", title: "Failed to rename thread", description: error instanceof Error ? error.message : "An error occurred." });
  });
}

export async function createProject(path: string, name?: string): Promise<void> {
  const workspaceRoot = path.trim();
  if (!workspaceRoot) throw new Error("Enter a project folder path");
  const title = name?.trim() || workspaceRoot.replace(/\/+$/, "").split("/").pop() || workspaceRoot;
  try {
    await requestBackend("projects.mutate", {
      type: "project.create", commandId: commandId(), projectId: `project:${crypto.randomUUID()}`,
      title, workspaceRoot,
    });
  } catch (error) {
    reportError(error);
    throw error;
  }
}

export async function setProjectPinned(id: string, pinned: boolean): Promise<void> {
  if (!projectOrganizationSupported()) throw new Error("This environment does not support organizing projects");
  try {
    await requestBackend("projects.mutate", { type: "project.update", commandId: commandId(), projectId: id, pinned });
  } catch (error) {
    reportError(error);
    throw error;
  }
}

/** Test seam: feeds one runtime request and its turn item through the same path server events take. */
export function applyRuntimeRequestForTest(request: Record<string, unknown>, item: Record<string, unknown>) {
  updateRuntimeRequest(request);
  updateTurnItem(item);
}

/** Test seam: feeds one shell stream event (snapshot, thread.updated ...) through the path server events take. */
export function applyShellEventForTest(event: Record<string, unknown>) {
  handleShellEvent(event);
}

/** Test seam: runs the shell stream (HTTP snapshot, resume rule, per-stream retry) on a stand-in client. */
export function startShellStreamForTest(fake: unknown, endpoint: string, bearer: string | null) {
  client = fake as BackendClient;
  bearerToken = bearer;
  startShellStream(fake as BackendClient, endpoint, connectionGeneration);
}

/** Test seam: feeds one server config stream event (snapshot, providerStatuses ...) through the path server events take. */
export function applyConfigEventForTest(event: Record<string, unknown>) {
  handleConfigEvent(event);
}

/** Test seam: the open thread has a live detail subscription (the tests have no client to make one). */
export function markThreadSubscribingForTest(threadId: string | null) {
  subscribingFor.set(threadId);
}

/**
 * Test seam: stands in for a real BackendClient so subscribeOpenThread's real subscribe path runs (it otherwise
 * returns early with no client), letting a test count how many times `orchestration.subscribeThread` is actually
 * called — the thing a shell update for an unrelated thread must not do to the open thread — and fail the most
 * recent one, as a dropped live subscription would (the error callback at its call site nulls subscribedThreadId
 * without the thread having actually changed, which is what a shell update later re-entering subscribeOpenThread
 * for the still-open thread exercises).
 */
export function setFakeClientForTest(): {
  subscribeThreadCalls: () => number; failCurrentSubscription: (error: Error) => void;
  /** The input of every `orchestration.subscribeThread` call so far, in order. */
  subscribeThreadInputs: () => unknown[];
  /** Delivers one stream item to the most recent thread subscription. */
  emitToCurrentSubscription: (value: unknown) => void;
  /** Every request method sent so far, in order (each answers `{}`). */
  requestMethods: () => string[];
} {
  const requestMethods: string[] = [];
  let count = 0;
  let currentReject: ((error: Error) => void) | null = null;
  let currentReceive: ((value: unknown) => void) | null = null;
  const inputs: unknown[] = [];
  client = {
    subscribe: (method: string, payload: unknown, receive: (value: unknown) => void, reject: (error: Error) => void) => {
      if (method === "orchestration.subscribeThread") { count += 1; currentReject = reject; currentReceive = receive; inputs.push(payload); }
      return () => {};
    },
    request: (method: string) => { requestMethods.push(method); return Promise.resolve({}); },
  } as unknown as BackendClient;
  return {
    subscribeThreadCalls: () => count,
    failCurrentSubscription: (error: Error) => currentReject?.(error),
    subscribeThreadInputs: () => inputs,
    emitToCurrentSubscription: (value: unknown) => currentReceive?.(value),
    requestMethods: () => [...requestMethods],
  };
}

/** Test seam: marks the environment connected (or not) without a socket, so fixtures run the connected paths. */
export function setBackendStatusForTest(status: BackendStatus, url = "ws://test.invalid/ws") {
  connectionUrl.set(status === "disconnected" ? "" : url);
  connectionStatus.set(status);
}

/** Ids of threads whose message dispatch is in flight (the sidebar shows them as Working before the shell arrives). */
export const sendingThreadIdList = (): readonly string[] => sendingThreadIds();
