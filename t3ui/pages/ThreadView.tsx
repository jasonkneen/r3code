import { announce, cleanup, computed, createMotion, effect, Image, List, reduceMotion, signal, Text, untracked, View, windowSize } from "nsh";
import type { StyleProp, ViewStyle } from "nsh";
import { panelAnimationMs } from "../components/motion/panelMotion";
import { EASE_DEFAULT } from "../components/motion/motionTokens";
import { registerCommand } from "../commands/registry";
import { requestWorkspaceFocus } from "../commands/workspaceFocus";
import { replyPrompt } from "../components/composer/contextChips";
import type { ListRef, ViewRef } from "nsh";
import { Composer } from "../components/Composer";
import { settledLayout } from "../components/composer/editor/PromptEditor";
import { QueuedMessages } from "../components/composer/QueuedMessages";
import { Icon } from "../components/Icons";
import { appOverlayOpen } from "../components/rightPanel/nativeOcclusion";
import { sidebarSearchNavigation, type SidebarSearchNavigation } from "../components/SidebarThreadSearch";
import { MessageRow } from "../components/thread/MessageRow";
import { createServerThreadFind, rowIdsForEntry, startForRow } from "../components/thread/threadFindServer";
import { parseScopedKey } from "../environments/connectionManager";
import { machineScopedThread } from "../environments/machineMentions";
import { serverEnvironment } from "./settings/settingsState";
import { attachCitationNavigation, citationPositioning } from "../components/thread/citations/citationNavigation";
import { AssistantSelectionToolbar } from "../components/thread/citations/CitationUi";
import { citationSourceTestId, hostSelection, refreshHostSelection, sourceTexts, startSelectionHost, type HostRect } from "../components/thread/citations/hostSelection";
import { readAssistantText } from "../components/thread/citations/citationText";
import { responseSubagents } from "../components/thread/timeline/subagents";
import { EscapeCancel } from "../components/EscapeCancel";
import { ThreadHistoryControl } from "../components/thread/timeline/ThreadHistoryControl";
import { HtmlRenderFrame } from "../components/thread/timeline/HtmlRender";
import { settleSupersededReasoning, withoutStoppedCompactionInterrupts, withoutSubagentDelegationRows } from "../components/thread/timeline/workLog";
import { ChangedFilesCard, checkpointSummary, openTurnDiff, showChangedFileMenu } from "../components/thread/timeline/ChangedFilesCard";
import { isWorkflowScriptMessage, resolveWorkflowOpening, useParentWorkflowAgents, WorkflowOpeningBlock, type WorkflowOpening } from "../components/thread/timeline/WorkflowOpeningBlock";
import { LinkRequestCard } from "../components/thread/timeline/LinkRequestCard";
import { pageScrollTarget, registerTimelinePageScroll } from "../components/thread/timeline/pageScroll";
import { ErrorRow } from "../components/thread/timeline/ErrorRow";
import { BackgroundSetupChip, WorktreeSetupRow } from "../components/thread/timeline/WorktreeSetupCard";
import { workLocally } from "../components/thread/timeline/worktreeWorkLocally";
import { placeWorktreeSetup, publishWorktreeSetupBlocksSend, resolveVisibleWorktreeSetup, useWorktreeSetupSnapshot, worktreeSetupBlocksSend, type WorktreeSetupRow as SetupRow } from "../components/thread/timeline/worktreeSetup";
import { linkRequestFromTurnItem } from "../components/thread/timeline/linkRequest";
import { AttachmentPreview, type MessageAttachment } from "../components/thread/AttachmentPreview";
import { readThreadAttachment } from "../components/thread/readAttachment";
import { draftPreview, readDraftPreview } from "../components/composer/draftPreview";
import { forkMessage } from "../components/thread/forkMessage";
import { DraftHeroHeadline, isTriageDraft, TriageDraftHero } from "../components/thread/DraftHero";
import { RewindConfirm } from "../components/thread/RewindConfirm";
import { cancelRewind, confirmRewind, isRewindable, requestRewind, rewindConfirm, rewindPending, trackRewindable } from "../components/thread/rewindState";
import { ActivityRow } from "../components/thread/ActivityRow";
import { ApprovalPanel } from "../components/thread/ApprovalPanel";
import { ChildThreadApprovals } from "../components/approvals/ChildThreadApprovals";
import { chatCanvasSize, chatLaneInset, chatLaneLeft, chatWidthSetting, dockedDetailsInsetEnd, threadDetailsDocks } from "../components/thread/chatLane";
import { ProviderSubagentBar } from "../components/chat/ProviderSubagentBar";
import { NativeChildWorkDialog } from "../components/chat/NativeChildWorkDialog";
import { providerMetaFor } from "../components/composer/providerCatalog";
import { subagentStatusFor } from "../components/chat/providerSubagentLogic";
import { ComposerLane } from "../components/thread/ComposerLane";
import { ThemeBackground } from "../components/thread/ThemeBackground";
import { ThreadStatusLine } from "../components/thread/ThreadStatusLine";
import { ThreadFindBar } from "../components/thread/ThreadFindBar";
import { findEntriesFor, findStartIndex, findThreadMatches, stepThreadFindIndex } from "../components/thread/threadFind";
import { threadFindActive, threadFindActiveBlock } from "../components/thread/threadFindState";
import { findRevealDelta } from "../components/thread/threadFind";
import { closeThreadFind, pendingThreadFind, threadFindActiveIndex, threadFindFocusRequest, threadFindOpen, threadFindQuery, threadFindViewportRowId } from "../components/thread/threadFindState";
import { UserInputPanel } from "../components/thread/UserInputPanel";
import { dismissUserInput } from "../components/thread/userInputDismiss";
import { NoActiveThreadState, NoProjectsHero } from "../components/thread/EmptyStates";
import { DraftStartError } from "../shell/DraftStartError";
import { draftStartFailed } from "../components/coordinators/indexDraftLanding";
import { TerminalDrawer } from "../components/terminal/TerminalDrawer";
import { PersistentTerminalDrawers } from "../components/terminal/PersistentTerminalDrawers";
import { chatColumnHeight, composerLaneHeight } from "../components/terminal/terminalLayoutBudget";
import { ThreadHeader } from "../components/header/ThreadHeader";
import { BannerLane } from "../components/banners/BannerLane";
import { openThreadNowSlots, ThreadNow } from "../components/banners/ThreadNow";
import { queueDeps } from "../components/composer/queueState";
import { GuestPendingMessages } from "../components/header/GuestShareControls";
import { useThreadScope } from "../components/sideChat/threadScope";
import { RightPanel } from "../components/rightPanel/RightPanel";
import { chatHeroLayout, chatLaneInsetEnd, reportChatCanvas } from "../components/rightPanel/miniPlayerState";
import { currentPanelKey, currentWorkspace, detailsPanelKey, openAttachmentAction, panelStateFor, toggleTerminalAction } from "../components/rightPanel/panelState";
import { bindTerminalKeys } from "../components/terminal/terminalCommands";
import { bindPanelKeys } from "../components/rightPanel/panelKeys";
import { mergeTimeline, type TimelineEntry } from "../components/thread/timeline";
import { terminalAssistantMessageIds } from "../components/thread/assistantCopy";
import { queuePendingFileDrop } from "../components/sidebar/pendingFileDrop";
import { WorkspaceFileDropOverlay } from "../components/thread/WorkspaceFileDropOverlay";
import { providerSkills } from "../components/composer/providerCatalog";
import { McpAppFrame } from "../components/thread/timeline/McpAppFrame";
import { createThreadActivityAnnouncer } from "../components/thread/threadActivityAnnouncement";
import { asKind, attachCreatedThreadSummaries, buildTimelineRows, rowMessage, type TimelineRow } from "../components/thread/timeline/workLog";
import { applyToolCallVisibility, asToolCallVisibility, liveAnswerPreview } from "../components/thread/timeline/toolVisibility";
import { SubagentGroupRow } from "../components/thread/timeline/SubagentRows";
import { ThreadContextDivider } from "../components/thread/timeline/ThreadContextDivider";
import { parentThreadLinkFor } from "../components/thread/timeline/parentThreadLink";
import { resolveUserMessageGrouping, type UserMessageGrouping } from "../components/thread/timeline/userMessagePresentation";
import { AttemptFoldRow, CreatedThreadRow, LiveWorkRow, NoticeRow, ProposedPlanCard, SystemDivider, ThinkingRow, TurnFoldRow, WorkGroupRow, WorkingRow } from "../components/thread/timeline/TimelineRows";
import { SecretRequestCard } from "../components/thread/timeline/SecretRequestCard";
import { ScrollToEndButton } from "../components/thread/timeline/ScrollToEndButton";
import { ThreadSyncLine } from "../components/thread/timeline/ThreadSyncLine";
import { releaseMinimapPassThrough, TimelineMinimap } from "../components/thread/timeline/TimelineMinimap";
import { createTimelineWheelForwarder, createTimelineWheelGesture } from "../components/thread/timeline/timelineMinimapWheel";
import { forwardArtifactWheel as forwardArtifactWheelEvent } from "../components/thread/timeline/htmlRenderWheel";
import { registerFragmentScroller } from "../components/thread/markdown/markdownFragments";
import { deriveTimelineMinimapItems, viewableRange } from "../components/thread/timeline/minimapLogic";
import { anchoredEndSpace, anchorReleasedByToolActivity, CHAT_TIMELINE_ANCHOR_OFFSET, firstViewableId, restoreTarget, rowRestoreOffset, settleListScroll, shouldAnchorNewUserMessage, timelinePositions } from "../components/thread/timeline/timelinePosition";
import { createTimelineFollow, TIMELINE_FOLLOW_REARM_THRESHOLD } from "../components/thread/timeline/timelineFollow";
import { createStableTimelineRows } from "../components/thread/timeline/stableTimelineRows";
import { foldCompletedTurns, foldHiding, type FoldedRow, type LatestRun } from "../components/thread/timeline/turnFolds";
import { attemptFoldHiding, foldSupersededAttempts } from "../components/thread/timeline/attemptFolds";
import {
  activeProjectId,
  composerDraft,
  setComposerDraft,
  type Message,
  allProjects,
  backendError,
  backendConnectionGeneration,
  backendStatus,
  backendUrl,
  createThread,
  isServerThread,
  isSending,
  workspaceStrategy,
  openAddProjectPalette,
  openSettings,
  openThread,
  openThreadById,
  respondToApproval,
  respondToUserInput,
  setThreadError,
  settingValue,
  threadById,
  threadLifecycleItemsFor,
  threadRunsFor,
  threadAttemptSourcesFor,
  threadApprovalsFor,
  threadUserInputsFor,
  threadSyncPhase,
  threadActivity,
  threadExecutionNodes,
  threadRunPreparing,
  threadActiveRunId,
  threadApprovals,
  threadUserInputs,
  threadWorking,
  threadWorkStartedAt,
  threadMessages,
  openThreadTurnItems,
  threadSubagentRecordsFor,
  requestBackend,
  threadHistoryFor,
  loadEarlierThreadHistory,
  serverThreadFind,
  serverThreadFindProgressive,
  subscribeBackend,
  openThreadRouteState,
} from "../store";
import { chatWidthClass } from "../components/thread/layout";

export function terminalOverlayOpen() {
  return appOverlayOpen();
}

function projectName() {
  const projectId = openThread()?.projectId;
  return allProjects().find((project) => project.id === projectId)?.name;
}

function isDraft() {
  return openThread()?.title === "New thread" && threadMessages().length === 0 && threadActivity().length === 0 && threadApprovals().length === 0 && threadUserInputs().length === 0;
}

function searchText(value: string) {
  return value.replace(/!?\[([^\]\n]*)\]\([^\)\s]*\)/g, "$1")
    .replace(/\*\*|`+/g, "").replace(/\s+/g, " ").trim()
    .normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

export function searchResultTimelineIndex(entries: TimelineEntry[], target: SidebarSearchNavigation): number {
  if (target.match.messageId) {
    return entries.findIndex((entry) => entry.kind === "message" && entry.message.id === target.match.messageId);
  }
  // Older servers omit messageId. Their snippet is taken from the rendered
  // message text, with whitespace collapsed and ellipses at cropped edges.
  const snippet = searchText(target.match.snippet.replace(/^…|…$/g, ""));
  if (!snippet) return -1;
  return entries.findIndex((entry) => entry.kind === "message" && entry.message.role === target.match.source && searchText(entry.message.body).includes(snippet));
}

function asFold(row: FoldedRow) {
  return row.kind === "fold" ? row : undefined;
}

export function ThreadTimeline(props: {
  entries: () => TimelineEntry[];
  scope: () => { environment: string; generation: number; threadId: string | null };
  expandedActivity: () => Record<string, boolean>;
  onToggleActivity: (id: string) => void;
  onOpenAttachment: (attachment: MessageAttachment) => void;
  onForkResponse?: (messageId: string) => void;
  onReplyToResponse?: (message: Message) => void;
  forkEnabled?: () => boolean;
  forkBusy?: () => boolean;
  onRewind?: (messageId: string) => void;
  rewindAvailable?: (messageId: string) => boolean;
  rewindBusy?: () => boolean;
  /** The row holding the active find match: it is scrolled into view and highlighted. */
  findRowId?: () => string | null;
  /** The live-turn state; the open thread's runs by default. */
  working?: () => { running: boolean; startedAt: number | null };
  /** Reports where a row was laid out (its top edge in the list), for tests of row order. */
  onRowLayout?: (id: string, top: number, width?: number) => void;
  /** The chat lane's inset each side of the transcript (the reference's 3rem at 640pt and up); 0.75rem by default. */
  laneInset?: () => number;
  /** The last items of the transcript, scrolling with it (the web's list footer: queued messages). */
  footer?: () => ReturnType<typeof View>;
  /** Space at the end while the transcript scrolls behind the floating composer. */
  bottomInset?: () => number;
  /** The first item of the transcript, scrolling with it (a child thread's "Subagent of <title>" divider). */
  header?: () => ReturnType<typeof View>;
  /** The Scroll to end pill's summary (`waitingLabel · N queued`). */
  scrollSummary?: () => string | null;
  /** A workflow coordinator's opening: its message row draws the WorkflowOpeningBlock instead of the bubble. */
  workflowOpening?: () => WorkflowOpening | null;
}) {
  const list = signal<ListRef | null>(null);
  const timelineWidth = signal(0);
  const messageLeft = () => {
    return chatLaneLeft(timelineWidth(), props.laneInset?.() ?? 12, chatWidthSetting(settingValue("chatWidth")));
  };
  // Row views by id, so restore, the new-turn anchor and heading links measure where a row sits in the view.
  // The List reuses a row's view for another entry, so each view is kept with the entry it shows now.
  const rowCells = new Map<ViewRef, () => string>();
  const rowRefs = { get: (id: string) => { for (const [node, current] of rowCells) if (current() === id) return node; return undefined; }, has: (id: string) => rowRefs.get(id) !== undefined };
  /** A row's top in the list's viewport (points), measured; undefined when it is not mounted. */
  const rowTopInView = async (id: string): Promise<number | undefined> => {
    const row = rowRefs.get(id);
    const current = list();
    if (!row || !current) return undefined;
    const [rowBox, listBox] = await Promise.all([row.measure(), current.measure()]);
    return rowBox && listBox ? rowBox.pagePosition.y - listBox.pagePosition.y : undefined;
  };
  // The latest scroll metrics of the list (onScroll).
  let scrollMetrics = { top: 0, contentHeight: 0, viewportHeight: 0 };
  // Measurements complete asynchronously, potentially after another scroll in the same row.
  let scrollMeasurementSerial = 0;
  let positionMeasurementFrame: number | undefined;
  let pendingPositionMeasurement: (() => void) | undefined;
  cleanup(() => { if (positionMeasurementFrame !== undefined) cancelAnimationFrame(positionMeasurementFrame); });
  // useTimelineFollow anchorNewTurn: a message the reader just sent pins CHAT_TIMELINE_ANCHOR_OFFSET below the top, with
  // the anchored end space after the last row, until tool activity in its turn releases it to follow the end.
  // forwardWheelToTimeline: a wheel over the minimap rail scrolls the transcript.
  const minimapWheel = createTimelineWheelForwarder({
    offset: () => scrollMetrics.top,
    maxOffset: () => Math.max(0, scrollMetrics.contentHeight - scrollMetrics.viewportHeight),
    scrollTo: (offset) => list()?.scrollToOffset({ offset, animated: false }),
    now: () => Date.now(),
    requestFrame: (callback) => requestAnimationFrame(() => callback(Date.now())),
    cancelFrame: (frame) => cancelAnimationFrame(frame),
    reducedMotion: () => reduceMotion(),
  });
  // handleMarkdownFragmentClick scrollIntoView({ block: "start" }): a `#heading` link brings its heading to the top.
  effect(() => {
    if (threadScope.scoped) return;
    return registerFragmentScroller((target) => {
      const current = list();
      if (!current) return;
      void Promise.all([target.measure(), current.measure()]).then(([box, listBox]) => {
        if (!box || !listBox || list() !== current) return;
        follow.release();
        current.scrollToOffset({ offset: Math.max(0, scrollMetrics.top + box.pagePosition.y - listBox.pagePosition.y), animated: false });
      });
    });
  });
  const anchorRowId = signal<string | null>(null);
  const endSpace = signal(0);
  // The thread in scope (sideChat/threadScope.ts): the open thread, or a side chat's child thread.
  const threadScope = useThreadScope();
  const live = () => props.working?.() ?? { running: threadScope.working(), startedAt: threadScope.workStartedAt() };
  // "Tool calls in chat": what each value hides is toolVisibility.ts; zen also drops the turn folds and previews the answer.
  const visibility = () => { const value = asToolCallVisibility(settingValue("toolCallVisibility")); return value === "zen" && threadFindOpen() ? "hideAll" : value; };
  // MessagesTimeline.logic zen: a message the reader was sent to (a search hit) shows; once the latest run's answer has landed
  // the working row goes, even while background work keeps the thread busy.
  // (Signals, filled by effects below once the latest run and the search highlight exist: computeds here run eagerly.)
  const revealedMessageId = signal<string | null>(null);
  const zenAnswerLanded = signal(false);
  const builtRows = computed(() => {
    const threadId = props.scope().threadId;
    const lifecycle = !threadScope.scoped && threadId ? threadLifecycleItemsFor(threadId) : null;
    return buildTimelineRows(applyToolCallVisibility(withoutStoppedCompactionInterrupts(withoutSubagentDelegationRows(settleSupersededReasoning(props.entries()))), visibility(), live().running, revealedMessageId()), live().running && !zenAnswerLanded(), live().startedAt, { preparingWorktree: props.working || threadScope.scoped ? false : threadRunPreparing(), lifecycle: lifecycle ? (id) => lifecycle[id] : undefined });
  });
  // useWorktreeSetup: the setup snapshot streams while the run prepares or the thread has a worktree (not in a side chat).
  // useWorktreeSetup localPreparing: a draft sending onto a new worktree streams its setup before the server's thread arrives.
  const draftPreparingWorktree = () => { const id = props.scope().threadId ?? null; return id !== null && !isServerThread(id) && isSending() && workspaceStrategy().type === "worktree"; };
  const worktreeSetup = useWorktreeSetupSnapshot(() => props.scope().threadId ?? null, () => !props.working && !threadScope.scoped && (threadRunPreparing() || draftPreparingWorktree() || Boolean(threadById(props.scope().threadId ?? "")?.path)));
  // The thread's latest run: an interrupted one makes its turn's fold read "You stopped after <duration>".
  const foldRunStates = computed(() => {
    const states = new Map<string, LatestRun>();
    const threadId = props.scope().threadId;
    if (!threadId) return states;
    const at = (value: unknown) => { const parsed = typeof value === "string" ? Date.parse(value) : NaN; return Number.isFinite(parsed) ? parsed : null; };
    for (const run of threadRunsFor(threadId)) {
      if (typeof run.id === "string" && typeof run.status === "string") states.set(run.id, { status: run.status, startedAt: at(run.startedAt), completedAt: at(run.completedAt) });
    }
    return states;
  });
  const latestRun = computed(() => {
    const threadId = props.scope().threadId;
    if (!threadId) return null;
    let latest: Record<string, unknown> | null = null;
    for (const run of threadRunsFor(threadId)) if (!latest || (typeof run.ordinal === "number" ? run.ordinal : 0) >= (typeof latest.ordinal === "number" ? latest.ordinal : 0)) latest = run;
    const at = (value: unknown) => { const parsed = typeof value === "string" ? Date.parse(value) : NaN; return Number.isFinite(parsed) ? parsed : null; };
    return latest && typeof latest.status === "string" ? { status: latest.status, startedAt: at(latest.startedAt), completedAt: at(latest.completedAt) } : null;
  });
  // ThreadActivityAnnouncer: the open thread's turn changes are spoken (Working, Needs approval, Needs your input, Done, Failed, Stopped).
  {
    const say = createThreadActivityAnnouncer((message) => announce(message));
    effect(() => {
      const threadId = props.scope().threadId ?? null;
      if (threadScope.scoped) return;
      let latest: Record<string, unknown> | null = null;
      for (const run of threadId ? threadRunsFor(threadId) : []) if (!latest || (typeof run.ordinal === "number" ? run.ordinal : 0) >= (typeof latest.ordinal === "number" ? latest.ordinal : 0)) latest = run;
      const approvals = threadId ? threadApprovalsFor(threadId) : [];
      const inputs = threadId ? threadUserInputsFor(threadId) : [];
      const status = approvals.length > 0 ? "approval" : inputs.length > 0 ? "input" : live().running ? "working" : "idle";
      const requestId = approvals[0]?.id ?? inputs[0]?.id ?? null;
      const snapshot = { status, requestId, runId: typeof latest?.id === "string" ? latest.id : null, runStatus: typeof latest?.status === "string" ? latest.status : null } as const;
      untracked(() => say(threadId, snapshot));
    });
  }
  effect(() => zenAnswerLanded.set(visibility() === "zen" && ["completed", "failed", "interrupted", "cancelled"].includes(latestRun()?.status ?? "")));
  const placedSetup = computed(() => placeWorktreeSetup(builtRows(), resolveVisibleWorktreeSetup(worktreeSetup(), latestRun()?.startedAt != null), latestRun()?.startedAt != null));
  const built = computed(() => placedSetup().rows as TimelineRow[]);
  // useWorktreeSetup blocksSend: the composer holds a send while setup runs before the agent starts.
  effect(() => {
    if (threadScope.scoped || props.working) return;
    const threadId = props.scope().threadId ?? "";
    const status = latestRun()?.status;
    publishWorktreeSetupBlocksSend(worktreeSetupBlocksSend({ sendQueuesBehindSetup: isServerThread(threadId) && (status === "preparing" || status === "starting"), visible: resolveVisibleWorktreeSetup(worktreeSetup(), latestRun()?.startedAt != null), preparingWorktree: threadRunPreparing() }));
  });
  cleanup(() => publishWorktreeSetupBlocksSend(false));
  // Superseded attempts stay folded while the thread's retained projection receives updates.
  const attemptSources = computed(() => { const threadId = props.scope().threadId; const sources = threadId && !threadScope.scoped ? threadAttemptSourcesFor(threadId) : null; return sources ? { ...sources, runs: threadRunsFor(threadId!) } : null; });
  const stabilizeRows = createStableTimelineRows();
  const rows = computed<FoldedRow[]>(() => {
    const scope = props.scope();
    return stabilizeRows(JSON.stringify([scope.environment, scope.generation, scope.threadId]), attachCreatedThreadSummaries(visibility() === "zen" ? built() : foldSupersededAttempts(foldCompletedTurns(built(), { running: live().running, expanded: props.expandedActivity(), latestRun: latestRun(), runStates: foldRunStates() }), attemptSources(), props.expandedActivity())));
  });
  /** A row hidden inside a collapsed turn fold opens that fold, so find and search can scroll to it. */
  const revealRow = (id: string) => {
    const fold = foldHiding(built(), id, live().running, foldRunStates());
    if (fold && !props.expandedActivity()[fold]) props.onToggleActivity(fold);
    // A match inside a superseded attempt opens that attempt's fold too.
    const attempt = attemptFoldHiding(foldCompletedTurns(built(), { running: live().running, expanded: new Proxy({} as Record<string, boolean>, { get: () => true }), runStates: foldRunStates() }), attemptSources(), id);
    if (attempt && !props.expandedActivity()[attempt]) props.onToggleActivity(attempt);
  };
  // useAssistantCitationTarget / AssistantCitationSource: Go to source pages, unfolds, scrolls and pulses the quote.
  const citationNav = attachCitationNavigation({
    scope: () => props.scope(),
    messages: () => props.entries().flatMap((entry) => (entry.kind === "message" ? [{ id: entry.message.id, role: entry.message.role, entryId: entry.id }] : [])),
    rowIds: () => rows().map((row) => row.id),
    revealRow,
    list: () => list(),
    scrollTop: () => scrollMetrics.top,
    viewportHeight: () => scrollMetrics.viewportHeight,
    releaseFollow: () => follow.release(),
  });
  // AssistantSelectionToolbar's viewport: the list's frame in the window, measured as it scrolls.
  const listFrame = signal<HostRect | null>(null);
  const measureListFrame = () => { void list()?.measure().then((box) => { if (box) listFrame.set({ x: box.pagePosition.x, y: box.pagePosition.y, width: box.bounds.size.width, height: box.bounds.size.height }); }); };
  void startSelectionHost();
  // selectionActions SELECTION_SCROLL_SETTLE_MS: the toolbar hides while the timeline scrolls and comes back where the
  // selection is once it settles.
  const selectionScrolling = signal(false);
  let selectionSettle: ReturnType<typeof setTimeout> | undefined;
  const noteSelectionScroll = () => {
    // With no selection there is no toolbar or range to reposition. Avoid a signal
    // update on every scroll event and a host round trip when the gesture settles.
    if (untracked(hostSelection).empty) return;
    selectionScrolling.set(true);
    clearTimeout(selectionSettle);
    selectionSettle = setTimeout(() => {
      selectionScrolling.set(false);
      if (!untracked(hostSelection).empty) void refreshHostSelection();
    }, 150);
  };
  cleanup(() => clearTimeout(selectionSettle));
  // MessagesTimeline.logic: consecutive messages of the reader's own group (tighter spacing, squared corners, one Steer marker).
  const groupings = computed(() => {
    const list = rows();
    const found = new Map<string, UserMessageGrouping>();
    const messageAt = (index: number) => { const row = list[index]; return row ? rowMessage(row as TimelineRow) : undefined; };
    list.forEach((row, index) => {
      const message = messageAt(index);
      if (!message || message.role !== "user") return;
      const grouping = resolveUserMessageGrouping(message, messageAt(index - 1), messageAt(index + 1));
      if (grouping.groupedWithPrevious || grouping.groupedWithNext) found.set(row.id, grouping);
    });
    return found;
  });
  const terminalReplies = computed(() => terminalAssistantMessageIds(built().map((row) => rowMessage(row)).filter((message): message is NonNullable<typeof message> => !!message)));
  // attachTrailingToolGroupsToAssistant: a reply followed by its run's tool group keeps its meta (time, copy) visible.
  const metaAfterTools = computed(() => {
    const list = rows();
    const out = new Set<string>();
    list.forEach((row, index) => {
      const message = row.kind === "entry" ? rowMessage(row as TimelineRow) : undefined;
      if (message?.role !== "assistant" || !message.runId) return;
      for (let next = index + 1; next < list.length; next += 1) {
        const candidate = list[next];
        if (candidate.kind === "entry") break;
        if ((candidate.kind === "work" && candidate.items.some((item) => (item.item as Record<string, unknown> | undefined)?.runId === message.runId))
          || (candidate.kind === "divider" && candidate.resourceSummary && candidate.runId === message.runId)) { out.add(message.id); break; }
      }
    });
    return out;
  });
  const NO_GROUPING: UserMessageGrouping = { groupedWithPrevious: false, groupedWithNext: false, continuesSteer: false };
  const answerPreview = () => (live().running && visibility() === "zen" ? liveAnswerPreview(props.entries()) : null);
  const following = signal(true);
  const pillShown = signal(false);
  // TimelineMinimap: the rows in view, and one strip per user message (a folded turn's answer is read from the unfolded rows).
  const viewRows = signal<{ start: number; end: number } | null>(null);
  const minimapItems = computed(() => deriveTimelineMinimapItems(rows(), built()));
  const follow = createTimelineFollow({
    scrollToEnd: (options) => list()?.scrollToEnd(options),
    motionEnabled: () => !reduceMotion(),
    following: { get: () => following(), set: (value) => following.set(value) },
    showPill: { get: () => pillShown(), set: (value) => pillShown.set(value) },
  });
  effect(() => () => follow.dispose());
  // pageScrollController: PageUp / PageDown from the composer page the timeline (24 = the list's bottom padding).
  let pageMetrics: { top: number; contentHeight: number; viewportHeight: number } | null = null;
  effect(() => registerTimelinePageScroll((key) => {
    const target = pageMetrics ? pageScrollTarget(pageMetrics, key, 24) : null;
    if (target === null) return false;
    // navigationReleasesFollow "key": PageUp releases when the content can scroll up, PageDown only away from the end.
    follow.navigate({ source: "key", direction: key === "PageUp" ? "up" : "down" });
    list()?.scrollToOffset({ offset: target, animated: !reduceMotion() });
    return true;
  }));
  // threadFindStore: opening find is manual navigation and releases live follow.
  { let findWasOpen = untracked(threadFindOpen); effect(() => { const open = threadFindOpen(); if (open && !findWasOpen && !threadScope.scoped) untracked(() => follow.release()); findWasOpen = open; }); }
  // A message the reader just sent re-arms follow and anchors at the top of the view (useTimelineFollow anchorNewTurn,
  // onTimelineAnchorReady: up to 12 frames for the row to mount, then scrollToIndex with the anchor offset).
  let lastUserId: string | null | undefined;
  let anchorEpoch = 0;
  const releaseAnchor = () => { anchorEpoch += 1; anchorRowId.set(null); endSpace.set(0); };
  /** The anchored end space for the current layout (the content height without the space itself). */
  const measureEndSpace = async () => {
    const id = untracked(anchorRowId);
    if (!id) return;
    const top = await rowTopInView(id);
    if (top === undefined || untracked(anchorRowId) !== id) return;
    const space = anchoredEndSpace({ anchorTopInContent: scrollMetrics.top + top, contentHeight: scrollMetrics.contentHeight - untracked(endSpace), viewportHeight: scrollMetrics.viewportHeight });
    if (Math.abs(space - untracked(endSpace)) > 1) endSpace.set(space);
  };
  const latestUserId = (entries: readonly TimelineEntry[]) => {
    let latest: string | null = null;
    for (const entry of entries) if (entry.kind === "message" && entry.message.role === "user") latest = entry.id;
    return latest;
  };
  effect(() => {
    const entries = props.entries();
    const latest = latestUserId(entries);
    const previous = lastUserId;
    lastUserId = latest;
    if (previous === undefined || latest === null || latest === previous) return;
    // Only a send from this window should create an anchor. A message arriving
    // from another client must not insert a viewport-sized spacer in this one.
    const message = entries.find((entry) => entry.id === latest);
    if (!shouldAnchorNewUserMessage(message)) return;
    untracked(() => {
      follow.reset();
      const epoch = ++anchorEpoch;
      anchorRowId.set(latest);
      const position = (attempts: number) => requestAnimationFrame(() => {
        if (epoch !== anchorEpoch) return;
        const index = rows().findIndex((row) => row.id === latest);
        if (index < 0 || !rowRefs.has(latest!)) { if (attempts > 0) position(attempts - 1); else releaseAnchor(); return; }
        void measureEndSpace().then(() => requestAnimationFrame(() => {
          if (epoch !== anchorEpoch) return;
          list()?.scrollToIndex({ index, animated: !reduceMotion(), viewPosition: 0, viewOffset: CHAT_TIMELINE_ANCHOR_OFFSET });
        }));
      });
      requestAnimationFrame(() => position(12));
    });
  });
  // The anchor lets go once its turn shows tool activity: the transcript follows the end again.
  effect(() => {
    const id = anchorRowId();
    if (!id || !anchorReleasedByToolActivity(rows(), id)) return;
    untracked(() => { releaseAnchor(); follow.scrollToEnd(false); });
  });
  const rowIndex = (entries: TimelineEntry[], target: SidebarSearchNavigation) => {
    const index = searchResultTimelineIndex(entries, target);
    return index < 0 ? -1 : rows().findIndex((row) => row.id === entries[index].id);
  };
  const highlighted = signal<string | null>(null);
  let highlightTimer: ReturnType<typeof setTimeout> | undefined;
  effect(() => { const id = highlighted(); revealedMessageId.set(id?.startsWith("message:") ? id.slice("message:".length) : null); });
  let shownScope = "";
  let scrollEpoch = 0;
  // useTimelinePositionRestore: a user gesture cancels restoration and any sent-message anchor.
  const settling = signal(false);
  let restoreCancelled = false;
  const minimapGesture = createTimelineWheelGesture({
    wheel: minimapWheel.wheel,
    stop: minimapWheel.stop,
    cancelRestore: () => { restoreCancelled = true; settling.set(false); releaseAnchor(); },
    follow,
  });
  cleanup(() => minimapGesture.stop());
  const forwardArtifactWheel = (delta: number) => {
    forwardArtifactWheelEvent(delta, {
      cancelRestore: () => { restoreCancelled = true; settling.set(false); releaseAnchor(); },
      follow,
      scroll: (distance) => { minimapWheel.wheel({ deltaY: distance, precise: true, ctrl: false }); },
    });
  };
  let restoring = true;
  let firstInView: string | null = null;
  effect(() => {
    const scope = props.scope();
    const key = JSON.stringify([scope.environment, scope.generation, scope.threadId]);
    if (key === shownScope) return;
    minimapGesture.stop();
    shownScope = key;
    follow.reset();
    releaseAnchor();
    // The thread just shown has sent nothing yet: only a later user message anchors.
    lastUserId = untracked(() => (props.entries().length > 0 ? latestUserId(props.entries()) : undefined));
    highlighted.set(null);
    clearTimeout(highlightTimer);
    const epoch = ++scrollEpoch;
    restoring = true;
    restoreCancelled = false;
    const pendingNow = untracked(sidebarSearchNavigation);
    const blockedBySearch = Boolean(pendingNow && pendingNow.environment === scope.environment && pendingNow.generation === scope.generation && pendingNow.threadId === scope.threadId);
    const currentNow = untracked(list);
    const rowsNow = untracked(rows);
    if (currentNow && !blockedBySearch && rowsNow.length > 0) {
      const immediateTarget = restoreTarget(timelinePositions.recall(key), rowsNow.map((row) => row.id));
      if (immediateTarget.kind === "row") {
        follow.release();
        currentNow.scrollToIndex({ index: immediateTarget.index, animated: false, viewPosition: 0, viewOffset: -immediateTarget.offsetWithinRow });
      } else if (immediateTarget.kind === "offset") {
        follow.release();
        currentNow.scrollToOffset({ offset: immediateTarget.offset, animated: false });
      } else {
        currentNow.scrollToEnd({ animated: false });
      }
    }
    requestAnimationFrame(() => {
      // The reader can scroll between switching threads and this first frame.
      // Do not reset their cancellation or apply the remembered position after it.
      if (epoch === scrollEpoch && restoreCancelled) { restoring = false; return; }
      const pending = sidebarSearchNavigation();
      if (epoch === scrollEpoch && shownScope === key && !(pending && pending.environment === scope.environment && pending.generation === scope.generation && pending.threadId === scope.threadId)) {
        // A thread left in its history opens where it was left (useTimelinePositionRestore), else at its end.
        const target = untracked(() => restoreTarget(timelinePositions.recall(key), rows().map((row) => row.id)));
        const current = list();
        const settle = (offset: () => Promise<number | undefined> | number | undefined) => current ? settleListScroll({
          requestFrame: (callback) => { requestAnimationFrame(callback); },
          scrollOffset: () => scrollMetrics.top,
          target: offset,
          scrollToOffset: (to) => current.scrollToOffset({ offset: to, animated: false }),
          isCancelled: () => restoreCancelled || epoch !== scrollEpoch || list() !== current,
        }) : Promise.resolve();
        settling.set(true);
        const maxOffset = () => Math.max(0, scrollMetrics.contentHeight - scrollMetrics.viewportHeight);
        let settled: Promise<void>;
        if (target.kind === "row") {
          follow.release();
          current?.scrollToIndex({ index: target.index, animated: false, viewPosition: 0, viewOffset: -target.offsetWithinRow });
          // Keep the saved row in place until its measured position and the scroll agree.
          settled = settle(async () => { const top = await rowTopInView(target.rowId); return top === undefined ? undefined : rowRestoreOffset({ scrollOffset: scrollMetrics.top, rowTopInView: top, offsetWithinRow: target.offsetWithinRow, maxOffset: maxOffset() }); });
        } else if (target.kind === "offset") { follow.release(); current?.scrollToOffset({ offset: target.offset, animated: false }); settled = Promise.resolve(); }
        else { current?.scrollToEnd({ animated: false }); settled = settle(() => (untracked(following) ? maxOffset() : undefined)); }
        void settled.then(() => {
          if (epoch !== scrollEpoch) return;
          // A scrollToIndex/end leaves the native list pinned until its visible rows are measured.
          // End that temporary pin when restore finishes, or a later measurement can pull the reader back.
          if (!restoreCancelled && list() === current) current?.scrollToOffset({ offset: scrollMetrics.top, animated: false });
          settling.set(false);
          requestAnimationFrame(() => { if (epoch === scrollEpoch) restoring = false; });
        });
        return;
      }
      requestAnimationFrame(() => { if (epoch === scrollEpoch) restoring = false; });
    });
  });
  effect(() => {
    const target = sidebarSearchNavigation();
    const scope = props.scope();
    const entries = props.entries();
    const currentList = list();
    if (!target) return;
    if (target.environment !== scope.environment || target.generation !== scope.generation || target.threadId !== scope.threadId) {
      // A side chat's transcript never consumes the main view's search target.
      if (!threadScope.scoped) sidebarSearchNavigation.set(null);
      return;
    }
    ++scrollEpoch;
    if (!currentList) return;
    if (rowIndex(entries, target) < 0) {
      const at = searchResultTimelineIndex(entries, target);
      if (at >= 0) untracked(() => revealRow(entries[at].id));
      return;
    }
    const frame = requestAnimationFrame(() => {
      const currentScope = props.scope();
      if (sidebarSearchNavigation() !== target || currentScope.environment !== target.environment || currentScope.generation !== target.generation || currentScope.threadId !== target.threadId || list() !== currentList) return;
      const index = rowIndex(props.entries(), target);
      if (index < 0) return;
      const entry = rows()[index];
      follow.release();
      currentList.scrollToIndex({ index, animated: false, viewPosition: 0.5 });
      highlighted.set(entry.id);
      clearTimeout(highlightTimer);
      highlightTimer = setTimeout(() => highlighted.set(null), 4000);
      sidebarSearchNavigation.set(null);
    });
    return () => cancelAnimationFrame(frame);
  });
  effect(() => () => clearTimeout(highlightTimer));
  // revealThreadFindMatch: once the active match's block is drawn, scroll it inside the view with the 96pt margin; while
  // earlier history loads above it, it stays where it was revealed (pagingPosition).
  let pinned: { block: ViewRef; top: number } | null = null;
  const blockTop = async (block: ViewRef) => {
    const current = list();
    if (!current) return undefined;
    const [box, listBox] = await Promise.all([block.measure(), current.measure()]);
    return box && listBox ? { top: box.pagePosition.y - listBox.pagePosition.y, height: box.bounds.size.height } : undefined;
  };
  effect(() => {
    const block = threadFindActiveBlock();
    if (!block || !threadFindOpen() || threadScope.scoped) { pinned = null; return; }
    const frame = requestAnimationFrame(() => {
      void blockTop(block).then((box) => {
        if (!box || untracked(threadFindActiveBlock) !== block) return;
        const delta = findRevealDelta(box, scrollMetrics.viewportHeight);
        follow.release();
        if (Math.abs(delta) >= 1) list()?.scrollToOffset({ offset: Math.max(0, scrollMetrics.top + delta), animated: false });
        pinned = { block, top: box.top - delta };
      });
    });
    return () => cancelAnimationFrame(frame);
  });
  let firstEntryId: string | undefined;
  effect(() => {
    const first = props.entries()[0]?.id;
    const prepended = firstEntryId !== undefined && first !== firstEntryId;
    firstEntryId = first;
    const hold = pinned;
    // Only earlier history paging in above the match moves it; streaming below does not.
    if (!hold || !prepended) return;
    const restore = () => void blockTop(hold.block).then((box) => {
      if (!box || pinned !== hold) return;
      const delta = box.top - hold.top;
      if (Math.abs(delta) >= 1) list()?.scrollToOffset({ offset: Math.max(0, scrollMetrics.top + delta), animated: false });
    });
    // The list measures rows inserted above after its first layout pass.
    requestAnimationFrame(() => requestAnimationFrame(restore));
  });
  effect(() => {
    const target = props.findRowId?.();
    const currentList = list();
    if (!target || !currentList) return;
    const index = rows().findIndex((row) => row.id === target);
    if (index < 0) { untracked(() => revealRow(target)); return; }
    const frame = requestAnimationFrame(() => { follow.release(); currentList.scrollToIndex({ index, animated: false, viewPosition: 0.35 }); });
    return () => cancelAnimationFrame(frame);
  });
  return (
    <View class="relative min-h-0 flex-1" onLayout={(event) => timelineWidth.set(event.bounds.size.width)} onMouseMove={(event) => releaseMinimapPassThrough(event.pressedButton)}>
    <List
      ref={(node) => list.set(node)}
      class="min-h-0 flex-1"
      each={rows()}
      header={props.header}
      footer={() => (<>{props.footer?.()}{endSpace() > 0 ? <View style={{ height: endSpace() }} testID="Anchored end space" /> : null}</>)}
      keyExtractor={(entry) => entry.id}
      // Rows are far taller than the 50pt default; a closer estimate stops rows jumping as they are measured.
      estimatedItemSize={160}
      initialScrollIndex={Math.max(0, rows().length - 1)}
      maintainVisibleContentPosition={{ autoscrollToBottomThreshold: TIMELINE_FOLLOW_REARM_THRESHOLD }}
      onViewableItemsChange={(info) => { firstInView = firstViewableId(info.viewableItems) ?? firstInView; const next = viewableRange(info.viewableItems); const previous = untracked(viewRows); if (next?.start !== previous?.start || next?.end !== previous?.end) viewRows.set(next); if (!threadScope.scoped) threadFindViewportRowId.set(firstInView); }}
      onLayout={() => measureListFrame()}
      onScrollDragStart={() => {
        minimapGesture.stop();
        const interrupted = settling() || anchorRowId() !== null;
        restoreCancelled = true; settling.set(false); releaseAnchor();
        if (interrupted) follow.release();
        follow.beginUserScroll();
      }}
      // Drag release can be followed by trackpad momentum; only end the gesture once scrolling rests.
      onScrollEnd={() => follow.endUserScroll()}
      onScroll={(event) => {
        const measurementSerial = ++scrollMeasurementSerial;
        citationNav.onScroll(event.offset.y);
        noteSelectionScroll();
        pageMetrics = { top: event.offset.y, contentHeight: event.contentSize.height, viewportHeight: event.size.height };
        scrollMetrics = { top: event.offset.y, contentHeight: event.contentSize.height, viewportHeight: event.size.height };
        follow.onScroll({ top: event.offset.y, contentHeight: event.contentSize.height, viewportHeight: event.size.height });
        if (untracked(anchorRowId)) void measureEndSpace();
        if (!restoring && shownScope) {
          const scope = shownScope;
          const rowId = firstInView;
          const position = { rowId, atEnd: untracked(following), scrollOffset: event.offset.y };
          timelinePositions.remember(scope, { ...position, offsetWithinRow: timelinePositions.recall(scope)?.rowId === rowId ? timelinePositions.recall(scope)?.offsetWithinRow : 0 });
          // timelineScrollAnchoring offsetWithinRow: how far the view's top is into its first row, measured after the scroll.
          if (rowId) {
            pendingPositionMeasurement = () => { void rowTopInView(rowId).then((top) => { if (measurementSerial === scrollMeasurementSerial && top !== undefined && !restoring && shownScope === scope && firstInView === rowId) timelinePositions.remember(scope, { ...position, offsetWithinRow: Math.max(0, -top) }); }); };
            if (positionMeasurementFrame === undefined) positionMeasurementFrame = requestAnimationFrame(() => { positionMeasurementFrame = undefined; const measure = pendingPositionMeasurement; pendingPositionMeasurement = undefined; measure?.(); });
          }
        }
      }}
      contentStyle={{ paddingLeft: props.laneInset?.() ?? 12, paddingRight: props.laneInset?.() ?? 12, paddingTop: 16, paddingBottom: 24 + (props.bottomInset?.() ?? 0) }}
      testID="Thread messages"
    >
      {(entry) => (
        <View ref={(node) => { if (node) rowCells.set(node, () => entry().id); }} onLayout={props.onRowLayout ? (event) => props.onRowLayout?.(entry().id, event.bounds.origin.y, event.bounds.size.width) : undefined} testID={highlighted() === entry().id ? "Selected search match" : props.findRowId?.() === entry().id ? "Active find match" : undefined} class={highlighted() === entry().id || props.findRowId?.() === entry().id ? "rounded-lg bg-muted-40" : ""}>
          <If when={asFold(entry())}>
            {(fold) => fold().attempt ? <AttemptFoldRow label={() => fold().label} expanded={() => fold().expanded} onToggle={() => props.onToggleActivity(fold().id)} deferredWorkItemIds={() => fold().deferredWorkItemIds} /> : <TurnFoldRow label={() => fold().label} expanded={() => fold().expanded} onToggle={() => props.onToggleActivity(fold().id)} createdAt={() => fold().createdAt ?? undefined} deferredWorkItemIds={() => fold().deferredWorkItemIds} />}
          </If>
          <If when={rowMessage(entry() as TimelineRow)}>
            {(message) => props.workflowOpening?.()?.messageId === message().id ? <View class={`mx-auto w-full ${chatWidthClass()}`}><WorkflowOpeningBlock opening={() => props.workflowOpening!()!} onOpenThread={openThreadById} /></View> : <MessageRow message={message} terminalReply={() => terminalReplies().has(message().id)} activeResponse={() => live().running && (!!message().streaming || (!threadScope.scoped && !!message().runId && message().runId === threadActiveRunId()))} metaAlwaysVisible={() => metaAfterTools().has(message().id)} grouping={() => groupings().get(entry().id) ?? NO_GROUPING} loadAttachment={(id, options) => readThreadAttachment(props.scope().threadId, id, options)} onOpenAttachment={props.onOpenAttachment} onForkResponse={props.onForkResponse} onReplyToResponse={props.onReplyToResponse} forkEnabled={props.forkEnabled} forkBusy={props.forkBusy} onRewind={props.onRewind} rewindAvailable={props.rewindAvailable} rewindBusy={props.rewindBusy} />}
          </If>
          <If when={asKind(entry() as TimelineRow, "work")}>
            {(group) => (
              <WorkGroupRow id={group().id} items={() => group().items} active={() => group().active} expandedActivity={props.expandedActivity} onToggle={props.onToggleActivity} />
            )}
          </If>
          <If when={asKind(entry() as TimelineRow, "live")}>
            {(live) => <LiveWorkRow row={live} expandedActivity={props.expandedActivity} onToggle={props.onToggleActivity} />}
          </If>
          <If when={asKind(entry() as TimelineRow, "thinking")}>
            {() => <ThinkingRow label={answerPreview} />}
          </If>
          <If when={asKind(entry() as TimelineRow, "subagents")}>
            {(group) => <SubagentGroupRow id={group().id} agents={() => group().items.map((item) => item.subagent)} expandedActivity={props.expandedActivity} onToggle={props.onToggleActivity} />}
          </If>
          <If when={asKind(entry() as TimelineRow, "failure")}>
            {(failure) => <ErrorRow item={() => failure().item} />}
          </If>
          <If when={asKind(entry() as TimelineRow, "link")}>
            {(link) => (linkRequestFromTurnItem(link().item.item) ? <LinkRequestCard item={() => linkRequestFromTurnItem(link().item.item)!} /> : null)}
          </If>
          <If when={asKind(entry() as TimelineRow, "mcp-app")}>
            {(row) => <View class={`mx-auto w-full ${chatWidthClass()}`}><McpAppFrame app={() => row().mcpApp} threadId={() => props.scope().threadId ?? null} itemId={() => String((row().item.item as Record<string, unknown> | undefined)?.id ?? row().item.id)} toolCall={() => { const item = (row().item.item ?? {}) as Record<string, unknown>; return { arguments: item.arguments ?? item.input, result: item.output }; }} onTimelineWheel={forwardArtifactWheel} /></View>}
          </If>
          <If when={asKind(entry() as TimelineRow, "html-render")}>
            {(page) => <View class={`mx-auto w-full ${chatWidthClass()}`}><HtmlRenderFrame reference={() => page().htmlRender} onTimelineWheel={forwardArtifactWheel} /></View>}
          </If>
          <If when={asKind(entry() as TimelineRow, "changed-files")}>
            {(card) => (checkpointSummary(card().item.item) ? <ChangedFilesCard id={card().id} summary={() => checkpointSummary(card().item.item)!} onOpenTurnDiff={(runId, filePath) => openTurnDiff(openThread()?.id, runId, filePath)} onFileContextMenu={(filePath, position) => showChangedFileMenu(currentWorkspace()?.cwd, openThread()?.id ?? null, filePath, position)} /> : null)}
          </If>
          <If when={asKind(entry() as TimelineRow, "plan")}>
            {(plan) => <ProposedPlanCard item={() => plan().item} findRowId={() => plan().id} />}
          </If>
          <If when={asKind(entry() as TimelineRow, "secret")}>
            {(secret) => <SecretRequestCard id={secret().item.id} request={() => secret().item.secret} />}
          </If>
          <If when={asKind(entry() as TimelineRow, "notice")}>
            {(notice) => <NoticeRow item={() => notice().item} expanded={() => Boolean(props.expandedActivity()[notice().id])} onToggle={props.onToggleActivity} onOpenThread={openThreadById} parentThreadId={() => props.scope().threadId ?? null} />}
          </If>
          <If when={asKind(entry() as TimelineRow, "divider")}>
            {(divider) => divider().action?.label === "Open chat" ? <CreatedThreadRow title={() => divider().detail || null} resourceSummary={() => divider().resourceSummary === true} onOpen={() => openThreadById(divider().action!.threadId)} /> : <SystemDivider label={divider().label} detail={divider().detail} tone={divider().tone} compaction={divider().compaction} active={divider().active} icon={divider().icon} wrapDetail={divider().wrapDetail} actionLabel={divider().action?.label} onAction={divider().action ? () => openThreadById(divider().action!.threadId) : undefined} />}
          </If>
          <If when={asKind(entry() as TimelineRow, "working")}>
            {(working) => <WorkingRow since={() => working().since} compacting={() => working().compacting === true} preparing={() => working().preparing === true} trailing={() => (placedSetup().background ? <BackgroundSetupChip snapshot={() => placedSetup().background!} /> : null)} />}
          </If>
          <If when={(entry() as unknown as SetupRow).kind === "worktree-setup" ? (entry() as unknown as SetupRow) : undefined}>
            {(setup) => <WorktreeSetupRow snapshot={() => setup().snapshot} embedded={() => setup().embedded} onWorkLocally={(() => {
              // ChatView passes onWorktreeSetupWorkLocally only while the route is a draft.
              const id = props.scope().threadId ?? null;
              return id && !isServerThread(id) ? () => void workLocally({ draftId: id, setupRunning: setup().snapshot.phase === "running", threadId: setup().snapshot.threadId, send: requestBackend }) : undefined;
            })()} />}
          </If>
        </View>
      )}
    </List>
    <TimelineMinimap items={minimapItems} gutter={messageLeft} range={viewRows} onWheel={(event) => { minimapGesture.wheel(event); }} onSelect={(item) => { minimapGesture.stop(); follow.release(); list()?.scrollToIndex({ index: item.rowIndex, animated: !reduceMotion(), viewPosition: 0, viewOffset: 24 }); }} />
    {threadScope.scoped ? null : <AssistantSelectionToolbar threadRef={() => { const scope = props.scope(); return scope.threadId ? { environmentId: scope.environment, threadId: scope.threadId } : null; }} viewport={listFrame} windowSize={windowSize} hidden={selectionScrolling} />}
    {citationPositioning() ? <EscapeCancel onCancel={() => citationNav.dismiss()} /> : null}
    {pillShown() && !threadFindOpen() ? <ScrollToEndButton bottomInset={props.bottomInset} summary={props.scrollSummary} onScrollToEnd={() => { releaseAnchor(); follow.scrollToEnd(!reduceMotion()); }} /> : null}
    </View>
  );
}

export function ThreadView() {
  // The layout branch as booleans that notify only when they flip. Read straight from openThread() and the thread's
  // lists, the branch expression re-ran on every server update and mounted the whole Composer again each time (seven
  // times while a thread loads), and a composer taken out while focused left its editor's key table behind, which took
  // Backspace, the arrows and Escape away from every plain text field (PromptEditor.tsx).
  // A flip that takes the composer out waits for its editor to give the keyboard up (releasePromptKeyboard).
  const hasOpenThread = settledLayout(() => !!openThread());
  const chatFileDrag = signal(false);
  const draftLayout = settledLayout(() => isDraft());
  // The floating preview reads the hero layout (miniPlayerState.ts chatHeroLayout).
  effect(() => { const hero = draftLayout(); untracked(() => chatHeroLayout.set(hero)); });
  const expandedActivity = signal<Record<string, boolean>>({});
  const preview = signal<MessageAttachment | null>(null);
  const forkPending = signal(false);
  const actionScope = () => JSON.stringify([backendUrl(), backendConnectionGeneration(), openThread()?.id ?? ""]);
  const forkEnabled = () => {
    const thread = openThread();
    return backendStatus() === "connected" && Boolean(thread && isServerThread(thread.id));
  };
  async function forkResponse(messageId: string) {
    if (forkPending() || !forkEnabled()) return;
    const scope = actionScope();
    const threadId = openThread()?.id;
    forkPending.set(true);
    if (threadId) setThreadError(threadId, null);
    try { await forkMessage(messageId); }
    catch (cause) {
      // useTimelineRewind: a failed fork is the thread's error banner.
      if (threadId && scope === actionScope()) setThreadError(threadId, cause instanceof Error && cause.message ? cause.message : "Failed to fork this response.");
    } finally { forkPending.set(false); }
  }
  let previewScope = "";
  effect(() => {
    const current = JSON.stringify([backendUrl(), backendConnectionGeneration(), backendStatus(), openThread()?.id ?? ""]);
    if (current !== previewScope) {
      previewScope = current;
      preview.set(null);
    }
  });
  effect(() => { if (terminalOverlayOpen()) preview.set(null); });
  effect(() => {
    const target = sidebarSearchNavigation();
    const environment = backendUrl();
    backendStatus();
    const generation = backendConnectionGeneration();
    const threadId = openThread()?.id ?? null;
    if (target && (target.environment !== environment || target.generation !== generation || target.threadId !== threadId)) sidebarSearchNavigation.set(null);
  });
  // The terminal is a native web view above GPUI's own overlays, so it steps aside while one is open.
  const currentTerminalTarget = () => {
    const space = currentWorkspace();
    const key = currentPanelKey();
    return space && space.cwd && key && panelStateFor(key).terminalOpen ? { key, threadId: space.threadId, cwd: space.cwd } : null;
  };
  const visibleTerminalTargets = computed(() => {
    if (terminalOverlayOpen() || preview() || rewindConfirm()) return [];
    const space = currentWorkspace();
    const key = currentPanelKey();
    return space && space.cwd && key && panelStateFor(key).terminalOpen ? [{ key, threadId: space.threadId, cwd: space.cwd }] : [];
  });
  // useDraftHeroLayoutTransition: when the draft becomes a thread (or back), the composer slides from where it was to
  // where it now is (FLIP: old top minus new top, to rest), over the panel animation duration.
  const heroMotion = createMotion();
  let composerAt: { y: number; draft: boolean } | null = null;
  const composerMoved = (y: number) => {
    const draft = draftLayout();
    const before = composerAt;
    composerAt = { y, draft };
    const ms = panelAnimationMs();
    if (!before || before.draft === draft || ms <= 0 || reduceMotion()) return;
    const delta = before.y - y;
    if (Math.abs(delta) < 0.5) return;
    void heroMotion.play({ keyframes: { translateY: [delta, 0] }, duration: ms, easing: EASE_DEFAULT });
  };
  const rowWidth = signal<number | undefined>(undefined);
  const heroHeight = signal(0);
  const chatArea = signal(0);
  // A provider-native subagent takes no messages: the bar stands where the composer would.
  const providerSubagent = () => openThread()?.relations?.providerSubagent ?? null;
  // As the draft branch above: a boolean, so a server update of the thread does not mount the Composer again.
  const subagentLayout = settledLayout(() => providerSubagent() !== null);
  const openParentThread = () => { const id = openThread()?.relations?.parentThreadId ?? openThread()?.relations?.lineage?.parentThreadId; return id ? () => openThreadById(id) : null; };
  const laneInset = () => chatLaneInset(windowSize().width);
  // The docked thread details card narrows the lane (the reference's --chat-lane-inset-end).
  const detailsInsetEnd = () => panelStateFor(detailsPanelKey()).detailsOpen && threadDetailsDocks(chatCanvasSize(), windowSize().width)
    ? dockedDetailsInsetEnd(chatArea(), windowSize().width, chatWidthSetting(settingValue("chatWidth"))) : 0;
  // A child thread starts with a divider naming the thread it came from (ChatView's parentThreadLink).
  const parentLink = computed(() => parentThreadLinkFor(openThread()?.relations, (id) => threadById(id)?.title, openThreadById));
  // The composer shares the transcript's lane inset; its pb-3 plus pb-1 here is the reference's 16pt window-bottom margin.
  const chatHidden = () => { const state = panelStateFor(currentPanelKey()); return state.open && state.maximized; };
  registerCommand("terminal.toggle", () => { if (!terminalOverlayOpen() && !preview()) toggleTerminalAction(); });
  bindPanelKeys();
  bindTerminalKeys();
  trackRewindable();
  const timeline = computed(() => mergeTimeline(threadMessages(), threadActivity(), threadRunsFor(openThread()?.id ?? "")));
  // resolveWorkflowOpening: a provider-native subagent thread whose first user message is a workflow script.
  const workflowParentId = () => {
    const relations = openThread()?.relations;
    if (!relations?.providerSubagent || relations.lineage?.relationshipToParent !== "subagent") return null;
    const first = threadMessages().find((message) => message.role === "user");
    return first && isWorkflowScriptMessage({ role: first.role, text: first.body }) ? relations.lineage.parentThreadId : null;
  };
  const parentWorkflowAgents = useParentWorkflowAgents(workflowParentId, (method, payload) => requestBackend(method, payload));
  const workflowOpening = computed(() => {
    const thread = openThread();
    if (!thread?.relations?.providerSubagent || thread.relations.lineage?.relationshipToParent !== "subagent") return null;
    const first = threadMessages().find((message) => message.role === "user");
    return resolveWorkflowOpening({
      threadId: thread.id,
      providerNativeSubagent: true,
      messages: first ? [{ id: first.id, role: first.role, text: first.body }] : [],
      parentAgents: parentWorkflowAgents(),
    });
  });
  const findMatches = computed(() => { const query = threadFindQuery(); return query.trim() ? findThreadMatches(findEntriesFor(timeline(), providerSkills()), query) : []; });
  const findRowIdLocal = () => (threadFindOpen() ? findMatches()[Math.min(threadFindActiveIndex(), Math.max(0, findMatches().length - 1))]?.entryId ?? null : null);
  const findRowId = () => (serverFindThread() ? findRowIdServer() : findRowIdLocal());
  let findThreadId = "";
  effect(() => {
    const id = openThread()?.id ?? "";
    if (id !== findThreadId) {
      findThreadId = id;
      closeThreadFind();
    }
  });
  const localStepFind = (delta: number) => threadFindActiveIndex.set(stepThreadFindIndex(threadFindActiveIndex(), findMatches().length, delta));
  // useThreadFind: a server that searches the whole thread (ServerConfig.threadFind) answers find, so matches in
  // history not loaded yet count; the active match's history is paged in (throughEntryId) before it is scrolled to.
  const serverFind = createServerThreadFind({ request: (method, payload) => requestBackend(method, payload), subscribe: subscribeBackend, progressive: serverThreadFindProgressive });
  const serverFindThread = () => { const id = openThread()?.id; return id && serverThreadFind() && !parseScopedKey(id) && isServerThread(id) ? id : null; };
  const findRowIdServer = () => {
    const match = serverFind.result()?.match;
    if (!threadFindOpen() || !match) return null;
    const ids = new Set(timeline().map((entry) => entry.id));
    return rowIdsForEntry(match.entryId).find((id) => ids.has(id)) ?? null;
  };
  effect(() => {
    const id = serverFindThread();
    const match = serverFind.result()?.match;
    if (!id || !threadFindOpen() || !match) return;
    const loaded = untracked(() => findRowIdServer()) !== null;
    if (!loaded && untracked(() => threadHistoryFor(id).hasMore)) void loadEarlierThreadHistory(id, match.entryId);
  });
  effect(() => { if (!threadFindOpen()) serverFind.reset(); });
  // The active match (row and occurrence) for the highlights and the folds that open for it.
  effect(() => {
    const rowId = findRowId();
    const occurrence = serverFindThread() ? serverFind.result()?.match?.occurrence ?? 0 : findMatches()[Math.min(threadFindActiveIndex(), Math.max(0, findMatches().length - 1))]?.occurrence ?? 0;
    threadFindActive.set(rowId ? { rowId, occurrence } : null);
  });
  cleanup(() => threadFindActive.set(null));
  // openThreadFindOnQuery: a palette message hit opens find on its query at that message, once the thread has loaded.
  effect(() => {
    const pending = pendingThreadFind();
    const id = openThread()?.id;
    if (!pending || pending.threadId !== id || timeline().length === 0) return;
    untracked(() => {
      pendingThreadFind.set(null);
      threadFindOpen.set(true);
      threadFindQuery.set(pending.query);
      threadFindFocusRequest.update((value) => value + 1);
      const serverId = serverFindThread();
      if (serverId) { serverFind.search(serverId, pending.query, pending.start); return; }
      const entries = findEntriesFor(timeline(), providerSkills());
      const rowId = pending.start ? `message:${pending.start.entryId}` : threadFindViewportRowId();
      threadFindActiveIndex.set(findStartIndex(entries, findThreadMatches(entries, pending.query), rowId));
    });
  });
  const stepFind = (delta: number) => {
    const id = serverFindThread();
    if (id) serverFind.step(id, threadFindQuery(), delta);
    else localStepFind(delta);
  };
  // The thread layout's transcript and request panels, above the shared composer.
  // ThreadTimeline (and its List) stays mounted across an empty<->populated flip instead of being swapped for the
  // empty-state copy: toggling it off and on (as a thread switch could do for a moment, between the old thread's
  // activity being dropped and the new one's arriving) remounted the List and its footer (ThreadNow, the status
  // line, queued messages), which is the late-arriving-rows jump the reader saw. The empty/loading copy now draws
  // as an opaque overlay above the same persistent List instead of replacing it.
  const unmatchedApprovals = () => {
    const matched = new Set(threadActivity().flatMap((item) => (item.type === "approval_request" && typeof (item as { requestId?: unknown }).requestId === "string" ? [(item as { requestId: string }).requestId] : [])));
    return threadApprovals().filter((approval) => !matched.has(approval.id));
  };
  let responseReplySequence = 0;
  async function replyToResponse(message: Message) {
    const thread = openThread();
    if (!thread || !message.itemId) return;
    const source = machineScopedThread(thread, { environment: serverEnvironment() });
    const environmentId = source.machineEnvironmentId;
    if (!environmentId) return;
    const tasks = new Map(threadMessages().map((entry) => [entry.id, entry.delegatedCompletionTaskIds]));
    const subagents = responseSubagents(openThreadTurnItems(), threadSubagentRecordsFor(thread.id), message.itemId, (id) => tasks.get(id) ?? [])
      .map((agent) => agent.environmentId ? agent : {
        ...agent,
        threadId: parseScopedKey(agent.threadId)?.localId ?? agent.threadId,
        title: agent.title === "Agent" ? (threadById(agent.threadId)?.title.trim() || agent.title) : agent.title,
      });
    const sequence = ++responseReplySequence;
    const generation = backendConnectionGeneration();
    const rendered = await sourceTexts(citationSourceTestId(message.id));
    if (sequence !== responseReplySequence || openThread()?.id !== thread.id || backendConnectionGeneration() !== generation) return;
    const body = rendered ? readAssistantText(rendered.texts).text : "";
    setComposerDraft(replyPrompt(thread.id, composerDraft(), {
      environmentId, threadId: source.localId ?? thread.id, messageId: message.id, itemId: message.itemId, body: body.trim() ? body : message.body, subagents,
    }));
    requestWorkspaceFocus("thread");
  }
  const ThreadBody = () => (
    <>
      <View class="relative min-h-0 flex-1">
        <ThreadTimeline
          entries={timeline}
          bottomInset={() => composerLaneHeight()}
          scope={() => { backendStatus(); return { environment: backendUrl(), generation: backendConnectionGeneration(), threadId: openThread()?.id ?? null }; }}
          expandedActivity={expandedActivity}
          onToggleActivity={(id) => expandedActivity.update((current) => ({ ...current, [id]: !current[id] }))}
          onOpenAttachment={(attachment) => (attachment.type === "image" ? preview.set(attachment) : openAttachmentAction({ id: attachment.id, name: attachment.name, mimeType: attachment.mimeType, sizeBytes: attachment.sizeBytes, threadId: openThread()?.id }))}
          onForkResponse={(id) => void forkResponse(id)}
          onReplyToResponse={(message) => void replyToResponse(message)}
          forkEnabled={forkEnabled}
          forkBusy={forkPending}
          onRewind={requestRewind}
          rewindAvailable={isRewindable}
          rewindBusy={() => rewindPending() || openThread()?.status === "running"}
          findRowId={findRowId}
          workflowOpening={workflowOpening}
          laneInset={laneInset}
          // ChatView's scrollToEndSummary: what is waiting on the reader, then how many messages are queued.
          header={() => (<><ThreadHistoryControl history={() => threadHistoryFor(openThread()?.id)} onLoadEarlier={() => { const id = openThread()?.id; if (id) void loadEarlierThreadHistory(id); }} />{parentLink() && !threadHistoryFor(openThread()?.id).hasMore ? <ThreadContextDivider link={() => parentLink()!} /> : null}</>)}
          scrollSummary={() => {
            const queued = queueDeps.queue().queued.length;
            return [openThreadNowSlots().attention?.waitingLabel ?? null, queued === 0 ? null : `${queued} queued`].filter((part) => part !== null).join(" \u00b7 ") || null;
          }}
          footer={() => (<>
            <View style={{ marginLeft: -12, marginRight: -12 }}><ThreadNow /></View>
            <View style={{ marginLeft: -12, marginRight: -12 }}><ThreadSyncLine /></View>
            <View style={{ marginLeft: -12, marginRight: -12 }}><ThreadStatusLine /></View>
            <View style={{ marginLeft: -12, marginRight: -12 }}><GuestPendingMessages /></View>
            <View style={{ marginLeft: -laneInset(), marginRight: -laneInset() }}><QueuedMessages area={chatArea} /></View>
            {/* MessagesTimeline's list footer: a pending approval with an approval_request row in the work log draws there
                (TimelineRows pendingApprovalForItem); only the unmatched ones are listed after the footer. */}
            {unmatchedApprovals().length > 0 ? (
              <View style={{ marginLeft: -laneInset(), marginRight: -laneInset() }} testID="Timeline pending approvals">
                <ApprovalPanel scope={() => JSON.stringify([backendUrl(), openThread()?.id ?? ""])} approvals={unmatchedApprovals} onRespond={respondToApproval} />
              </View>
            ) : null}
          </>)}
        />
        {timeline().length === 0 ? (
          // MessagesTimeline: while the thread's detail loads the empty state is a blank surface, not the empty-thread copy.
          threadSyncPhase() === "loading" ? <View class="absolute inset-0 bg-background" testID="Timeline loading" /> : (
          <View class="absolute inset-0 items-center justify-center bg-background">
            <Text class="text-sm text-muted-foreground">Send a message to start the conversation.</Text>
          </View>
          )
        ) : null}
      </View>
      {/* ChatView.tsx: approvals waiting in a subagent or side chat, answerable from here. */}
      <ChildThreadApprovals />
    </>
  );
  return (
    <View class="relative flex-1 flex-row bg-background" onLayout={(event) => rowWidth.set(event.bounds.size.width)}>
      {/* The docked right panel is a sibling of the whole chat column (ChatView.tsx): the thread header ends at the panel's
          edge and the panel's own top bar shares the header row. */}
      <View class={chatHidden() ? "hidden" : "relative min-h-0 min-w-[360px] flex-1"}>
      {/* NoProjectsHero (_chat.index.tsx) keeps only the electron titlebar strip: no title, no panel toggles. */}
      {!hasOpenThread() && backendStatus() === "connected" && allProjects().length === 0
        ? <View class="h-[52px] shrink-0 bg-background" desktop={{ windowDrag: true }} />
        : <ThreadHeader />}
      <View class="relative min-h-0 flex-1" onLayout={(event) => { chatArea.set(event.bounds.size.width); chatCanvasSize.set({ width: event.bounds.size.width, height: event.bounds.size.height }); chatColumnHeight.set(event.bounds.size.height); reportChatCanvas(event.bounds); }}>
      {hasOpenThread() ? (
        <ThreadFindBar
          open={threadFindOpen}
          query={threadFindQuery}
          matchCount={() => (serverFindThread() ? serverFind.result()?.totalMatches ?? 0 : findMatches().length)}
          activeIndex={() => (serverFindThread() ? serverFind.result()?.activeIndex ?? 0 : threadFindActiveIndex())}
          focusRequest={threadFindFocusRequest}
          status={() => (serverFindThread() ? serverFind.status() : null)}
          counting={() => (serverFindThread() ? serverFind.result()?.complete === false : false)}
          onRetry={() => serverFind.retry()}
          onQueryChange={(query) => {
            threadFindQuery.set(query);
            const serverId = serverFindThread();
            if (serverId) { serverFind.search(serverId, query, startForRow(threadFindViewportRowId())); return; }
            const entries = findEntriesFor(timeline(), providerSkills());
            threadFindActiveIndex.set(findStartIndex(entries, findThreadMatches(entries, query), threadFindViewportRowId()));
          }}
          onNext={() => stepFind(1)}
          onPrevious={() => stepFind(-1)}
          onClose={closeThreadFind}
        />
      ) : null}
      <BannerLane insetEnd={() => chatLaneInsetEnd() + detailsInsetEnd()} />
      {!hasOpenThread() ? (
        <View class="flex-1 items-center justify-center gap-3 px-8">
          {backendStatus() === "connecting" ? (
            <>
              <Text class="text-base font-medium text-foreground">Connecting to environment...</Text>
              <Text class="text-sm text-muted-foreground">Your projects and threads will appear here.</Text>
            </>
          ) : backendStatus() !== "connected" ? (
            <>
              <Text class="text-base font-medium text-foreground">Connect an environment</Text>
              <Text class="text-center text-sm text-muted-foreground">
                {backendError() ?? "Connect a R3 Code environment to access your projects and threads."}
              </Text>
              <View
                class="mt-1 h-9 items-center justify-center rounded-md bg-primary px-4 active:scale-[0.97] transition-transform duration-150 ease-in-out"
                onPress={() => openSettings("/settings/connections")}
                accessibilityLabel="Connect environment"
                role="button"
              >
                <Text class="text-sm font-medium text-primary-foreground">Connect environment</Text>
              </View>
            </>
          ) : openThreadRouteState() === "loading" ? null : allProjects().length === 0 ? (
            <NoProjectsHero />
          ) : draftStartFailed() ? (
            <DraftStartError />
          ) : (
            <NoActiveThreadState />
          )}
        </View>
      ) : (
        // One composer for the draft and the thread it becomes: the first send turns the draft into a server thread
        // while the composer holds the keyboard, and a second Composer mounted for the thread layout took the focused
        // editor out, which left its key table behind (PromptEditor.tsx). Only the content around it switches.
        <View
          class={`relative ${draftLayout() ? "flex-1 justify-center pb-8" : "min-h-0 flex-1"}`}
          style={{ paddingRight: chatLaneInsetEnd() + detailsInsetEnd() }}
          // ChatView isWorkspaceFileDragActive: files dragged over the chat show the drop overlay; a drop attaches them.
          onFileDragEnter={() => chatFileDrag.set(true)}
          onFileDragLeave={() => chatFileDrag.set(false)}
          onFileDrop={(event) => { chatFileDrag.set(false); const id = openThread()?.id; if (id && event.uris.length > 0) queuePendingFileDrop(id, event.uris); }}
        >
          <ThemeBackground />
          {chatFileDrag() ? <WorkspaceFileDropOverlay /> : null}
          {draftLayout() ? (
            <View class="pb-4" style={{ paddingLeft: laneInset(), paddingRight: laneInset() }} onLayout={(event) => heroHeight.set(event.bounds.size.height)}>
              {isTriageDraft(openThread()?.projectId) ? <TriageDraftHero /> : <DraftHeroHeadline projectId={() => openThread()?.projectId} />}
            </View>
          ) : (
            <ThreadBody />
          )}
          <View class={draftLayout() ? "shrink-0" : "absolute bottom-0 left-0"} style={{ ...heroMotion.style as StyleProp<ViewStyle>, ...(draftLayout() ? {} : { right: chatLaneInsetEnd() + detailsInsetEnd() }), pointerEvents: "box-none" }} onLayout={(event) => composerMoved(event.bounds.origin.y)}>
          <ComposerLane area={chatArea} bottomGap={() => !draftLayout()} onHeight={(height) => composerLaneHeight.set(height)}>
            {!subagentLayout() && threadUserInputs().length > 0 ? (
              <UserInputPanel integrated scope={() => JSON.stringify([backendUrl(), openThread()?.id ?? ""])} threadId={() => openThread()?.id ?? ""} requests={threadUserInputs} onRespond={respondToUserInput} onDismiss={dismissUserInput} />
            ) : null}
            {subagentLayout() ? (
              <View class="rounded-2xl bg-card shadow-sm">
                <ProviderSubagentBar
                  instanceId={() => providerSubagent()?.instanceId ?? ""}
                  model={() => providerSubagent()?.model ?? ""}
                  effort={() => providerSubagent()?.effort ?? null}
                  status={() => subagentStatusFor(threadExecutionNodes())}
                  onOpenParent={openParentThread()}
                  actions={providerMetaFor(providerSubagent()?.instanceId ?? "")?.driver === "antigravity" ? () => <NativeChildWorkDialog threadId={() => openThread()?.id ?? ""} /> : undefined}
                />
              </View>
            ) : (
              <Composer />
            )}
          </ComposerLane>
          </View>
          {/* The reference floats the headline above a vertically centred composer (it takes no room); this spacer under the
              composer balances the headline's room above it. */}
          {draftLayout() ? <View class="shrink-0" style={{ height: heroHeight() }} /> : null}
        </View>
      )}
      {/* Each visited thread's drawer stays mounted and is only hidden: unmounting destroyed the terminal's
          web view, so every thread switch or dialog reloaded it, flashed it blank and dropped its focus. */}
      <PersistentTerminalDrawers current={currentTerminalTarget} suspended={() => terminalOverlayOpen() || !!preview() || !!draftPreview() || !!rewindConfirm()} />
      </View>
      </View>
      <RightPanel rowWidth={() => rowWidth()} />
      {rewindConfirm() ? <RewindConfirm onCancel={cancelRewind} onConfirm={(restoreFiles) => void confirmRewind(restoreFiles)} /> : null}
      <If when={preview()}>
        {(attachment) => <AttachmentPreview attachment={attachment} load={(id, options) => readThreadAttachment(openThread()?.id, id, options)} onClose={() => preview.set(null)} />}
      </If>
      <If when={draftPreview()}>
        {(current) => <AttachmentPreview attachment={() => current().attachment} load={readDraftPreview} onClose={() => draftPreview.set(null)} />}
      </If>
    </View>
  );
}
