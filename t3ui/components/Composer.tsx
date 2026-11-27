import { registerComposerMentionDrop } from "./files/fileTreeDragMention";
import { isVideoAttachment } from "../backend/attachments";
import { cycleDraftEnvironment } from "../environments/logicalProjectEnvironments";
import { machineScopedThread, mentionableMachines, offersLinkedEnvironments, serverEnvironmentIdOf } from "../environments/machineMentions";
import { environmentConfigs } from "../environments/connectionManager";
import { linkedEnvironments } from "../environments/linkedEnvironments";
import { pendingLoadBalancingSendWarning } from "../environments/loadBalancing";
import { projectCloneSendBlockReason } from "./palette/addProject/addProjectState";
import { releaseThreadUndoShortcut } from "./sidebar/threadUndoClaim";
import { cleanup, colorScheme, computed, effect, keymap, platform, signal, Speech, Text, untracked, View } from "nsh";
import type { ViewRef } from "nsh";
import { registerFocusArea } from "../commands/workspaceFocus";
import { workLocallyResendDraftId, workLocallyStep } from "./thread/timeline/worktreeWorkLocally";
import {
  addAttachment,
  addAttachmentPath,
  allProjects,
  attachmentCapabilities,
  availableInteractionModes,
  availableModels,
  availableRuntimeModes,
  backendError,
  backendStatus,
  backendUrl,
  composerDraft,
  draftAttachmentFile,
  detachDraftAttachments,
  reattachDraftAttachments,
  freshContextThreads,
  isServerThread,
  serverRuntimeModeFor,
  paletteOpen,
  setFreshContext,
  draftAttachments,
  isSending,
  openSettings,
  openThread,
  openThreadModelSelection,
  providerStatuses,
  providersLoaded,
  threadById,
  removeAttachment,
  requestBackend,
  retryAttachment,
  sendDraft,
  settingValue,
  settingsOpen,
  setComposerDraft,
  setDraftProject,
  setInteractionMode,
  setRuntimeMode,
  setModelOptionSelections,
  setWorkspaceStrategy,
  threadRuns,
  stopThread,
  threadApprovals,
  threadMessages,
  threadUserInputs,
  workspaceStrategy,
  usageOpen,
} from "../store";
import * as store from "../store";
import { rewindPending } from "./thread/rewindState";
import { useThreadScope } from "./sideChat/threadScope";
import { composerOwner, focusMainComposer, focusSideComposer } from "./sideChat/sideChatFocus";
import { composerGlassSurface, composerHighlight, composerOutline, tokenAlpha } from "./composer/tokenColor";
import { SuggestedPrompt } from "./composer/SuggestedPrompt";
import { promptTextStyle } from "../typography";
import { serverEnvironment, serverSettings } from "../pages/settings/settingsState";
import { defineContext, dispatchKeystroke, registerCommands, shortcutLabel } from "../commands/registry";
import { openSideChatSurface } from "./rightPanel/panelLogic";
import { panelKeyFor, updatePanel } from "./rightPanel/panelState";
import { chatWidthClass, enterSubmits } from "./thread/layout";
import { AttachmentControl, AttachmentList, REATTACH_ERROR } from "./thread/AttachmentControls";
import { QueuedAttachmentRow } from "./composer/QueuedAttachmentRow";
import { applyThreadModelPick } from "./composer/threadModelPick";
import { fanoutModelSelection, fanoutSelectionsFor, multipleModelSendBlock, multipleModelTargetError, multipleModelSendDisabledReason, sendMultipleModels } from "./composer/multipleModels";
import { managedRuntimeModeDenial } from "../pages/settings/managedPolicyLocks";
import { serverManagedPolicy } from "../pages/settings/settingsState";
import { confirm, confirmDialogAvailable } from "./toast/confirmDialog";
import { clearDraftAttachments, isLocalDraft, launchModelThread, openThreadById, persistThreadSettingsForNextTurn, supportsWorktreeBootstrap } from "../store";
import { defaultRuntimeChoice, ModeControls, PickerFooter, showsPermissionsChip } from "./thread/ModeControls";
import { ComposerIcon } from "./composer/ComposerIcon";
import { CommandMenu } from "./composer/CommandMenu";
import { ProviderStatusBanner } from "./composer/ProviderStatusBanner";
import { getProviderStatusBannerKey, shouldShowProviderStatusBanner } from "./composer/providerStatusLogic";
import { createAnchor } from "./composer/Popover";
import { applyReplacement, detectComposerTrigger, isClearComposerCommand, parseSideChatCommand } from "./composer/composerTrigger";
import { parsePullRequests, parseSearchEntries, pullRequestEmptyState, pullRequestItems, pullRequestListFailed, searchSlashCommands, skillMenuItems, slashMenuItems } from "./composer/commandItems";
import type { CommandItem } from "./composer/commandItems";
import { environmentMentionItems, isUsageLimitsCommand, modelMentionItems, threadMentionItems } from "./composer/commandItems";
import { isLocalServer, promptWithFolders, REMOTE_FOLDER_MESSAGE, splitDroppedUris } from "./composer/folderDrop";
import { bindComposerPasteAsText, bindComposerSendCommands } from "../commands/shellCommands";
import { CONNECTION_NOTICE_ID, ENVIRONMENT_RECONNECT_WARNING_GRACE_MS, connectionNotice } from "./coordinators/connection.logic";
import { currentConnectionPhase, environmentLabel } from "./coordinators/connectionCoordinator";
import { NoticeCard } from "./banners/BannerParts";
import { ComposerBanners } from "./banners/ComposerBanners";
import type { BannerItem } from "./banners/bannerTypes";
import { pendingFileDrop, takePendingFileDrop } from "./sidebar/pendingFileDrop";
import { sendBackgroundApplies, sendInBackground } from "./composer/sendBackground";
import { showToast } from "./toast/toastState";
import { worktreeSetupBlocksSendNow } from "./thread/timeline/worktreeSetup";
import { feedbackUploadInFlight, parseCodexFeedbackCommand, runCodexFeedback } from "./composer/codexFeedback";
import { threadSessionState } from "./banners/threadSessionState";
import { moveHighlight } from "./composer/modelPickerLogic";
import { buildPromptHistoryEntries, stepPromptHistory } from "./composer/promptHistory";
import type { PromptHistoryPosition } from "./composer/promptHistory";
import { WorkspaceControls } from "./thread/WorkspaceControls";
import { composerQuestionControls } from "./thread/userInputControls";
import { distinctPastedPaths } from "./thread/pastedFiles";
import { ModelPicker } from "./thread/ModelPicker";
import { ComposerPrimaryActions, primaryKind } from "./composer/ComposerPrimaryActions";
import { SpeedControls } from "./composer/SpeedControls";
import { parseCommands, parseSkills, providerUsageLimits, selectedDescriptors, selectedProviderRecord } from "./composer/providerCatalog";
import { createWorkspaceSnapshotRefresher, skillsForCwd, slashCommandsForCwd } from "./composer/workspaceSkills";
import { UsageLimitsBanner } from "./composer/UsageLimitsBanner";
import { FallbackModelNotice } from "./banners/FallbackModelNotice";
import { providerMetaFor } from "./composer/providerCatalog";
import { replaceCurrentValue, selectionsFromDescriptors, ultrathinkPromptControlled } from "./composer/modelTraits";
import { alternateComposerDispatchAction, deriveQueueState, followUpFromSetting, isRunningPhase, parseRuns, resolveSendIntent, submitLabel, submitStatus, submitTooltip } from "./composer/runState";
import type { QueuedMessage } from "./composer/runState";
import { compactThread, continueRun, editQueuedRun, resumeThreadQueue, startSideChat as runSideChat } from "./composer/runCommands";
import { branchPickerOpen, effortFocusPending, modelPickerOpen, requestHostMenu, requestPreviousWorktree, requestWorkspaceMenu, setPermissionsOpen } from "./composer/composerControls";
import { canSendQueuedRun, cancelQueuedEdit, editedQueuedAttachments, editingQueuedRun, removeEditingQueuedAttachment, recoverQueuedEditLeftQueue, endedRunId as endedRun, queueActionError, queueEditing, sendQueuedNow as sendQueuedRun, startQueuedEdit, threadQueue, threadQueueFor } from "./composer/queueState";
import { bindTypeToFocus, shouldRedirectInput, TYPE_TO_FOCUS_KEYS } from "./composer/composerFocusRedirect";
import { pasteIntoComposer } from "./composer/usePasteToFocusComposer";
import { useComposerTypingGuard } from "./composer/useComposerTypingGuard";
import { appOverlayOpen } from "./rightPanel/nativeOcclusion";
import { previewFocused, terminalFocused } from "./terminal/terminalCommands";
import { ComposerStashBadge, ComposerStashMenu } from "./composer/ComposerStash";
import { antigravitySendBlockReason, hasProviderSetup } from "./composer/providerStatusLogic";
import { ORCHESTRATION_OPERATE_SCOPE, scopeAllows } from "../backend/sessionScopes";
import { requestProviderSelection } from "../pages/settings/providers/data";
import { MAX_STASH_ENTRIES, hydrateStash, restoredPrompt, stashEntries, stashPromptDurably, stashPulseKey, takeStashEntry, type StashRecord } from "./composer/promptStash";
import type { StashAttachment, StashEntry } from "./composer/promptStash";
import { COMPACT_COMMAND_PATTERN, deriveSteerState, formatContextWindowTokens, latestTokenUsage, providerState, providerTurnEnded, readActiveRun, shouldOfferResumeCompaction } from "./composer/threadProviderState";
import { compactThreadAvailable, freshSessionAvailable as freshSessionOffered, hasAvailableCompactionProvider, lockedCompactionInstanceId, idleCompactionMode, resumeCompactionOffered, sideChatDisabledReason } from "./composer/composerAvailability";
import { inlineContextIds, attachmentContextId, attachmentReferencedIn, attachedExtraContexts, attachedPullRequests, restorePastedContexts, attachExtraContext, extraContextMarker, threadContextRecord, environmentContextRecord, attachPullRequest, chipsFor, folderMentions, pullRequestContextRecord, pullRequestMarker, settleSendContext, detachPullRequest, rememberMention, removeMentionToken, sendContextFor, textWithMarkers, takeContextRecords, restoreContextRecords } from "./composer/contextChips";
import { ComposerChips } from "./composer/ComposerChips";
import { CitationCommentEditorHost, ComposerCitationChips } from "./thread/citations/CitationUi";
import { importPastedAttachments, pendingDraftWork } from "./composer/pastedAttachments";
import { markerAtCaret, setContextInsertionHandler } from "./composer/terminalContext";
import { PromptEditor, settledLayout } from "./composer/editor/PromptEditor";
import { promptTokenContext } from "./composer/editor/promptContext";
import { serializeComposerFileLink } from "./composer/editor/promptDocument";
import { FreshSessionBanner } from "./composer/FreshSessionBanner";
import { ComposerSpeechButton } from "./composer/ComposerSpeechButton";
import { registerSharedDictation } from "./composer/sharedDictation";
import { makeDictation } from "./composer/dictation";
import { showPrimaryActionStates } from "./composer/forcedRecording";
import { PrimaryActionStates } from "./composer/PrimaryActionStates";
import { canCaptureAudio, discardRecording, startCapture } from "../desktop/audioCapture";
import { speechStreamingAvailable, speechStreamUrl, transcribeCloudSpeechPcm, transcribeSpeechPcm } from "../pages/settings/voice/voiceApi";
import { followWav, openSpeechStream, SPEECH_STREAM_PATH, type SocketLike } from "./composer/liveSpeech";
import { audioGrant, correctionCue, projectCustomWords, speechCustomWords, speechLanguage, voiceMicrophone } from "../pages/settings/voice/voiceState";
import { LiveTranscription, VoiceInputPill } from "./composer/VoiceInputPill";
import { startRealVoiceInput, voiceChoice } from "./speech/voiceSetup";
import { VoiceInputSetup } from "./speech/VoiceInputSetup";
import { readSetting } from "../pages/settings/settingsSync";
import { nativeWebFocus, notePointerOverComposer, pointerOverComposer, releaseWebKeyboard, setComposerFocus, webKeyboardHeld } from "./terminal/webKeyboard";
import { insertText as insertRichText } from "nsh/base";
import { promptLengthValidationMessage, PROVIDER_SEND_TURN_MAX_INPUT_CHARS } from "./composer/promptLength";
import { attachmentBlockReason as attachmentSendBlockReason, attachmentCountMessage, foldPaste, pasteFoldedToast } from "./composer/attachmentIntake";
import { resolveRestingComposerControlsLayout, type RestingComposerControlsLayout } from "./composer/composerFooterLayout";
import { isChoiceOnlyPendingInput } from "./composer/choiceOnly";
import { dismissSuggestion, offeredSuggestion, parsePromptSuggestion, type PromptSuggestion } from "./composer/promptSuggestion";

const dismissedProviderBanner = signal<string | null>(null);
/** Request ids the typing guard holds back while the user is typing (useComposerTypingGuard): panels skip these. */
export const heldRequestIds = signal<ReadonlySet<string>>(new Set());
export const DEFAULT_COMPOSER_PLACEHOLDER = "Ask anything. @ files, $ skills, / commands";

/** The composer card's laid-out size (tests measure it against the reference). */
export const composerCardSize = signal({ width: 0, height: 0 });

export function Composer() {
  // The thread in scope: the open thread, or a side chat's child thread (sideChat/threadScope.ts). These shadow the
  // store's open-thread reads and run its actions for the scoped thread.
  const threadScope = useThreadScope();
  const scoped = threadScope.scoped;
  const openThread = threadScope.thread;
  const questionControls = () => scoped ? null : composerQuestionControls(JSON.stringify([backendUrl(), openThread()?.id ?? ""]));
  const composerDraft = () => questionControls()?.text ?? threadScope.draft();
  const draftAttachments = threadScope.draftAttachments;
  const draftAttachmentFile = threadScope.draftAttachmentFile;
  const isSending = threadScope.isSending;
  const threadApprovals = threadScope.approvals;
  const threadUserInputs = threadScope.userInputs;
  const threadMessages = threadScope.messages;
  const setComposerDraft = (text: string) => {
    const question = questionControls();
    if (question) question.setText(text);
    else threadScope.run(() => store.setComposerDraft(text));
  };
  const sendDraft = (input?: Parameters<typeof store.sendDraft>[0]) => threadScope.run(() => store.sendDraft(input));
  // useLinkedEnvironments: the machines the open thread's environment links to.
  const openThreadLinkedEnvironments = () => {
    const remote = openThread()?.environmentId;
    const primaryConfig = { environment: serverEnvironment(), settings: serverSettings() };
    return linkedEnvironments(remote ?? "primary", remote ? environmentConfigs()[remote] ?? null : primaryConfig, primaryConfig);
  };
  // useComposerMenuItems offersMachines: `@` names other machines when the thread's environment offers links.
  const machineMentionItems = (query: string) => {
    const remote = openThread()?.environmentId;
    const primaryConfig = { environment: serverEnvironment(), settings: serverSettings() };
    const config = remote ? environmentConfigs()[remote] ?? null : primaryConfig;
    if (!offersLinkedEnvironments(config)) return [];
    return environmentMentionItems(mentionableMachines(primaryConfig), { environmentId: serverEnvironmentIdOf(remote ?? "primary", primaryConfig) ?? undefined, query });
  };
  const stopThread = () => threadScope.run(() => store.stopThread());
  const addAttachment = (file: File) => threadScope.run(() => store.addAttachment(file));
  const addAttachmentPath = (path: string) => threadScope.run(() => store.addAttachmentPath(path));
  const removeAttachmentNow = (id: string) => threadScope.run(() => store.removeAttachment(id));
  // useComposerAttachmentIntake removeComposerImage: an image the prompt references asks before it goes (its chips go with it).
  const removeAttachment = (id: string) => {
    const item = draftAttachments().find((entry) => entry.id === id);
    if (item?.kind === "image" && confirmDialogAvailable() && attachmentReferencedIn(composerDraft(), item)) {
      void confirm(`Remove ${item.name} from the message?\nIt is referenced in your text; removing it also removes every reference.`, { variant: "destructive" }).then((confirmed) => { if (confirmed) removeAttachmentNow(id); });
      return;
    }
    removeAttachmentNow(id);
  };
  const retryAttachment = (id: string) => threadScope.run(() => store.retryAttachment(id));
  const detachDraftAttachments = () => threadScope.run(() => store.detachDraftAttachments());
  const reattachDraftAttachments = (items: Parameters<typeof store.reattachDraftAttachments>[0]) => threadScope.run(() => store.reattachDraftAttachments(items));
  // A side chat's pickers read and write its own thread (selectedModelFor, runtimeModeFor); the main composer the open thread's.
  const selectedModel = scoped ? () => store.selectedModelFor(openThread()?.id ?? "") : store.selectedModel;
  // ChatComposer: skills and slash commands come from the selected provider's snapshot for this composer's cwd
  // (resolveProviderSkillsForCwd), kept fresh by useProviderWorkspaceSnapshotRefresh (on mount, provider change, typing).
  const skillsCwd = () => { const thread = openThread(); return thread?.path ?? allProjects().find((item) => item.id === thread?.projectId)?.path ?? null; };
  const providerSkills = computed(() => parseSkills(skillsForCwd(selectedProviderRecord(), skillsCwd())));
  const providerCommands = computed(() => parseCommands(slashCommandsForCwd(selectedProviderRecord(), skillsCwd())));
  const workspaceSnapshots = createWorkspaceSnapshotRefresher({ request: (instanceId, cwd) => store.refreshProviderWorkspaceSnapshot(instanceId, cwd) });
  const refreshWorkspaceSnapshot = () => untracked(() => workspaceSnapshots.check(selectedModel()?.provider, skillsCwd(), selectedProviderRecord()));
  effect(() => { selectedModel()?.provider; skillsCwd(); if (backendStatus() === "connected") refreshWorkspaceSnapshot(); });
  { let typed = untracked(composerDraft); effect(() => { const draft = composerDraft(); if (draft !== typed) { typed = draft; if (untracked(backendStatus) === "connected") refreshWorkspaceSnapshot(); } }); }
  const workspaceSkillsScanning = () => workspaceSnapshots.scanning(selectedModel()?.provider, skillsCwd());
  const runtimeMode = scoped ? () => store.runtimeModeFor(openThread()?.id ?? "") : store.runtimeMode;
  const interactionMode = scoped ? () => store.interactionModeFor(openThread()?.id ?? "") : store.interactionMode;
  const setSelectedModel = (provider: string, model: string) => threadScope.run(() => store.setSelectedModel(provider, model));
  const setRuntimeMode = (mode: Parameters<typeof store.setRuntimeMode>[0]) => threadScope.run(() => store.setRuntimeMode(mode));
  const setInteractionMode = (mode: Parameters<typeof store.setInteractionMode>[0]) => threadScope.run(() => store.setInteractionMode(mode));
  const inputHeight = signal(46);
  const focused = signal(false);
  const attachmentError = signal("");
  // ComposerPromptLengthValidation: shown once a send is refused for length, then follows the prompt until it fits.
  const lengthRefused = signal(false);
  const promptLengthError = () => lengthRefused() ? promptLengthValidationMessage(composerDraft()) : null;
  // Once the prompt fits (or another thread opens in this one composer) the line stays away until the next refused send.
  // showThreadUndoNotice: a text edit hands mod+z back to the editor's own undo.
  { let lastDraft = untracked(composerDraft); effect(() => { const draft = composerDraft(); if (draft !== lastDraft) { lastDraft = draft; releaseThreadUndoShortcut(); } }); }
  effect(() => { openThread()?.id; if (untracked(lengthRefused) && promptLengthValidationMessage(composerDraft()) === null) lengthRefused.set(false); });
  effect(() => { openThread()?.id; lengthRefused.set(false); });
  // usePromptSuggestion: settings.promptSuggestionsEnabled (an older server decodes it false), the thread's latest run.
  const suggestionData = signal<PromptSuggestion | null>(null);
  const latestRun = () => {
    const runs = store.threadRuns();
    const run = runs[runs.length - 1];
    return run && typeof run.id === "string" ? { id: run.id, status: typeof run.status === "string" ? run.status : "" } : null;
  };
  effect(() => {
    const id = openThread()?.id;
    suggestionData.set(null);
    if (!id || backendStatus() !== "connected" || settingValue("promptSuggestionsEnabled") !== true || latestRun() === null) return;
    const stop = store.subscribeBackend("orchestration.subscribePromptSuggestion", { threadId: id }, (value) => suggestionData.set(parsePromptSuggestion(value)), () => suggestionData.set(null));
    cleanup(stop);
  });
  // offeredPromptSuggestion: only where the default placeholder would show (not running or sending, no fresh session armed,
  // no context chips, no approval or question waiting).
  const suggestionAllowed = () => !isRunning() && !isSending() && !freshArmed() && threadApprovals().length === 0 && threadUserInputs().length === 0
    && chipsFor(openThread()?.id, composerDraft()).length === 0;
  const offered = () => composerDraft().length === 0 && suggestionAllowed() ? offeredSuggestion({ environment: backendUrl(), data: suggestionData(), latestRun: latestRun() }) : null;
  const acceptSuggestion = () => { const text = offered(); if (text !== null) { setComposerDraft(text); forcedRange.set({ start: text.length }); } };
  const dismissOffered = () => { const data = suggestionData(); if (data && offered() !== null) dismissSuggestion(backendUrl(), data.runId); };
  // The reference's placeholder variants (ChatComposer), most specific state first.
  const placeholder = () => {
    if (threadApprovals().length > 0) return threadApprovals()[0].supportsFeedback ? "Send feedback to decline this request" : "Send a message to decline and redirect the agent";
    if (isChoiceOnlyPendingInput(threadUserInputs())) return "Choose an option above";
    if (threadUserInputs().length > 0) return "Type your own answer, or leave this blank to use the selected option";
    if (backendStatus() === "connected" && !openThread()?.projectId) return "Choose a project above to start a thread";
    // showProviderUnavailable: only once the provider catalog is known (providerCatalogPending keeps the default copy).
    if (backendStatus() === "connected" && providersLoaded() && availableModels().length === 0) return "Enable a provider in Settings to send a message";
    return offered() ?? DEFAULT_COMPOSER_PLACEHOLDER;
  };
  const suggestionPlaceholder = () => {
    const suggestion = offered();
    return suggestion !== null && placeholder() === suggestion ? suggestion : null;
  };
  // ChatComposer `disabled`: no project chosen yet (projectSelectionRequired) or a choice-only question. A focused editor
  // is never flipped to read-only: settledLayout lets the editors give the keyboard up first (releasePromptKeyboard).
  const editorDisabled = settledLayout(() => (backendStatus() === "connected" && !openThread()?.projectId) || isChoiceOnlyPendingInput(threadUserInputs()));
  const editorEditable = () => !editorDisabled();
  const hasDraft = () => composerDraft().trim().length > 0;
  const hasContent = () => hasDraft() || draftAttachments().length > 0;
  // Promoting a queued message steers the running turn only when its provider can take steering
  // (the session's turn capabilities), as deriveThreadQueueWorkflowState does.
  const scopedQueue = scoped ? threadQueueFor(() => openThread()?.id ?? "") : null;
  const queue = scopedQueue?.queue ?? threadQueue;
  const endedRunId = scopedQueue?.endedRunId ?? endedRun;
  // Any active run can be interrupted; only a running or waiting one is "running" for follow-ups (derivePhase).
  // A run that is still preparing or starting takes the send as "auto" and the server queues it.
  const hasActiveRun = () => endedRunId() === null && (queue().activeRun !== null || openThread()?.status === "running" || openThread()?.status === "awaiting");
  const runStatus = () => queue().activeRun?.status ?? (hasActiveRun() ? "running" : null);
  const isRunning = () => isRunningPhase(runStatus());
  const followUp = () => followUpFromSetting(readSetting("followUpBehavior", "server"));
  // A running /compact cannot be steered into (isCompacting): a send queues behind it.
  // A steer needs a run in `running` with a running provider turn whose session takes steering input; in any other
  // state (the gap before the turn starts or after it ends, waiting on a request, stopping) the send queues, so the
  // server never has to refuse it (Orchestrator.steerActiveRun).
  const canSteer = () => !queue().promoteSkipsCompaction && queue().canPromoteToSteer;
  const freshArmed = () => { const id = openThread()?.id; return id !== undefined && freshContextThreads().includes(id); };
  const dispatchMode = () => resolveSendIntent({ runStatus: runStatus(), alternateModifier: false, activeTurnDefault: followUp(), canSteer: canSteer() });
  const actionError = signal("");
  // Editing a queued message (queueState): its text sits in the composer, and the draft that was there waits aside.
  const editingQueued = scoped ? () => { const current = queueEditing(); return current !== null && current.threadId === openThread()?.id ? current : null; } : editingQueuedRun;
  // useQueuedRunEdit onRunLeftQueue: the run being edited started or was cancelled elsewhere.
  if (!scoped) effect(() => {
    const edit = editingQueued();
    if (!edit || queue().queued.some((item) => item.runId === edit.runId)) return;
    untracked(() => recoverQueuedEditLeftQueue(composerDraft(), threadById(edit.threadId)?.title, (input) => showToast(input)));
  });
  const savingQueuedEdit = signal(false);
  const providerSetupTarget = () => providerStatuses().find((status) => hasProviderSetup(status))?.instanceId ?? null;
  const reportAction = (cause: unknown) => actionError.set(cause instanceof Error ? cause.message : String(cause));
  const canAttach = () => backendStatus() === "connected" && attachmentCapabilities().supported && !isSending() && !rewindPending() && draftAttachments().length < attachmentCapabilities().maxCount;
  // ChatComposer attachmentBlockReason: the copy for why the attachments in the draft cannot be sent.
  const attachmentBlockReason = () => {
    const items = draftAttachments();
    if (items.length === 0) return null;
    const caps = attachmentCapabilities();
    return attachmentSendBlockReason({
      known: store.attachmentCapabilitiesKnown(), supported: caps.supported, maxFileBytes: caps.files ? caps.maxFileBytes : null,
      files: items.filter((item) => item.kind === "file"),
      questionWithoutAttachmentSupport: threadUserInputs().length > 0 && !caps.supported,
      hasAttachments: true,
      needsReattachCount: items.filter((item) => item.status === "failed" && item.error === REATTACH_ERROR && !draftAttachmentFile(item.id)).length,
    });
  };
  // ChatComposer sendDisabledReason: a thread above the administrator's runtime-mode ceiling would be refused, and a
  // multiple-model selection needs at least one model.
  const sendDisabledReason = () => (scoped ? null : worktreeSetupBlocksSendNow() ? "Preparing worktree" : projectCloneSendBlockReason(openThread()?.projectId) ?? multipleModelSendDisabledReason(fanoutSelectionsFor(openThread()?.id)) ?? attachmentBlockReason() ?? (threadUserInputs().length > 0 ? null : managedRuntimeModeDenial(serverManagedPolicy(), runtimeMode()) ?? (fanoutSelectionsFor(openThread()?.id) === null ? antigravitySendBlockReason(providerStatuses().find((item) => item.instanceId === selectedModel()?.provider), selectedModel()?.model ?? "") : null)));
  const canSend = () => sendDisabledReason() === null && hasContent() && Boolean(openThread()?.projectId) && draftAttachments().every((item) => item.status === "uploaded") && !isSending() && backendStatus() === "connected" && selectedModel() !== null;
  const canInterrupt = () => hasActiveRun() && !isSending() && backendStatus() === "connected";
  // useComposerResume's per-route in-flight lock: a second resume while one runs is ignored.
  const resuming = signal(false);
  const canResume = () => backendStatus() === "connected" && !isSending() && !resuming() && (queue().resumableRunId !== null || queue().isHeld);
  const kind = () => primaryKind({ canInterrupt: canInterrupt(), hasSendableContent: hasContent(), editingQueued: editingQueued() !== null, canResume: canResume(), mode: dispatchMode() });
  const primaryDisabled = () => kind() === "resume" ? !canResume() : kind() === "update" ? !hasDraft() || backendStatus() !== "connected" || isSending() : !canSend();
  const label = () => submitLabel({ showResume: kind() === "resume", editingQueued: editingQueued() !== null, running: isRunning(), mode: dispatchMode(), compactsBeforeSend: compactsBeforeSend() });
  const submit = (text?: string, alternate = false) => {
    const question = questionControls();
    if (question) { if (question.canAdvance && !question.responding) question.advance(); return; }
    if (backendStatus() !== "connected" || isSending()) return;
    // ChatComposer onSubmit: attached context still being brought in (a pasted image or file chip) holds the send.
    const importing = openThread();
    if (importing && pendingDraftWork.has(importing.id)) {
      showToast({ type: "info", title: "Still bringing attached context into this message.", description: "Send again once its chip resolves." });
      return;
    }
    queueActionError.set("");
    const edit = editingQueued();
    if (edit) {
      const next = (text ?? composerDraft()).trim();
      // useQueuedRunEdit: one save at a time; a failure without a message reads "Could not save the edited queued message."
      if (!next || savingQueuedEdit()) return;
      actionError.set("");
      savingQueuedEdit.set(true);
      void editQueuedRun(edit.threadId, edit.runId, next, editedQueuedAttachments(edit))
        .then(() => { setComposerDraft(edit.stash); queueEditing.set(null); })
        .catch((cause: unknown) => actionError.set(cause instanceof Error && cause.message ? cause.message : "Could not save the edited queued message."))
        .finally(() => savingQueuedEdit.set(false));
      return;
    }
    // useComposerSend: a typed /usage-limits (no attachments or contexts) opens the usage banner instead of sending.
    const usageThread = openThread();
    if (providerUsageLimits() !== null && draftAttachments().length === 0 && (!usageThread || (attachedExtraContexts(usageThread.id).length === 0 && attachedPullRequests(usageThread.id).length === 0)) && isUsageLimitsCommand(text ?? composerDraft())) {
      usageLimitsOpen.set(true);
      setComposerDraft("");
      return;
    }
    if (kind() !== "update" && sendDisabledReason() !== null) return;
    if (selectedModel() === null || !openThread()?.projectId) return;
    if (!(text ?? composerDraft()).trim() && draftAttachments().length === 0) return;
    if (draftAttachments().some((item) => item.status !== "uploaded")) return;
    if (promptLengthValidationMessage(text ?? composerDraft()) !== null) { lengthRefused.set(true); return; }
    lengthRefused.set(false);
    actionError.set("");
    typingGuard.onSend();
    const draft = (text ?? composerDraft()).trim();
    const thread = openThread();
    // useComposerSend: a typed Codex `/feedback [reason]` (plain text only) uploads the thread's session to OpenAI.
    const feedbackCommand = thread && (selectedModel()?.driver ?? selectedModel()?.provider) === "codex" && draftAttachments().length === 0
      && attachedExtraContexts(thread.id).length === 0 && attachedPullRequests(thread.id).length === 0 && fanoutSelectionsFor(thread.id) === null ? parseCodexFeedbackCommand(draft) : null;
    if (thread && feedbackCommand) {
      const session = threadSessionState();
      if (!isServerThread(thread.id) || session.threadId !== thread.id || session.activeProviderThreadId === null) {
        showToast({ type: "warning", title: "Start a Codex thread first", description: "Send a message before you submit feedback." });
        return;
      }
      if (feedbackUploadInFlight(thread.id)) return;
      void runCodexFeedback({ threadId: thread.id, command: draft, ...(feedbackCommand.reason ? { reason: feedbackCommand.reason } : {}), clearDraft: () => setComposerDraft(""), request: requestBackend });
      return;
    }
    if (thread && isClearComposerCommand(draft) && freshSessionAvailable()) { setFreshContext(thread.id, true); setComposerDraft(""); return; }
    const side = parseSideChatCommand(draft);
    // useComposerSend: `/side` carries any staged attachments and context into the side chat and clears them once started.
    if (thread && side) {
      const reason = sideChatReason();
      if (reason !== null && threadUserInputs().length === 0) { showToast({ type: "warning", title: "Side chat not started", description: reason }); return; }
      if (reason === null) {
        void startSideChat(thread.id, side.prompt, draft);
        return;
      }
    }
    // A multiple-model selection starts one background thread per model (useComposerSend's multipleModelSelections path).
    const fanout = !scoped && thread ? fanoutSelectionsFor(thread.id) : null;
    if (thread && fanout) {
      const strategy = workspaceStrategy();
      const branch = strategy.type === "worktree" ? strategy.baseRef : strategy.branch ?? null;
      const block = multipleModelSendBlock({ selectionCount: fanout.length, serverSupportsWorktreeBootstrap: supportsWorktreeBootstrap(), isLocalDraftThread: isLocalDraft(thread.id), isGitRepo: branch !== null, branch });
      if (block === "server-outdated") { actionError.set("Update this server before starting multiple models."); return; }
      if (block === "needs-new-git-thread") {
        showToast({ type: "warning", title: "Choose models and a base branch", description: "Multiple models need a new thread in a Git project. Each gets its own worktree." });
        return;
      }
      const targetError = multipleModelTargetError(fanout, providerStatuses());
      if (targetError) { actionError.set(targetError); return; }
      const withMarkers = textWithMarkers(draft, settleSendContext(thread.id, draft, inlinePullRequests));
      void sendMultipleModels({
        draftId: thread.id, selections: fanout, text: withMarkers, models: availableModels(),
        clearDraft: () => setComposerDraft(""), restoreDraft: () => { if (composerDraft() === "") setComposerDraft(draft); },
        releaseAttachments: () => clearDraftAttachments(thread.id),
        deps: {
          launch: (threadId, item) => launchModelThread({ draftId: thread.id, threadId, modelSelection: fanoutModelSelection(item), text: withMarkers, branch: branch!, ...(strategy.type === "worktree" && strategy.startFromOrigin ? { startFromOrigin: true } : {}) }),
          newThreadId: () => `thread:${crypto.randomUUID()}`,
          toast: (input) => { showToast({ type: input.type, title: input.title, ...(input.description ? { description: input.description } : {}), ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}), actions: (input.actions ?? []).map((action) => ({ label: action.label, run: action.run })) }); },
          openThread: (threadId) => openThreadById(threadId),
          confirm: (message) => confirm(message),
        },
      });
      return;
    }
    // useComposerSend: an automatic draft waits for its machine (or a manual pick) before it sends.
    const balanceWarning = pendingLoadBalancingSendWarning();
    if (balanceWarning) { showToast({ type: "warning", ...balanceWarning }); return; }
    const mode = resolveSendIntent({ runStatus: runStatus(), alternateModifier: alternate, activeTurnDefault: followUp(), canSteer: canSteer(), freshContext: freshArmed() });
    const compactFirst = compactsBeforeSend() && !COMPACT_COMMAND_PATTERN.test(draft);
    const withContext = thread ? textWithMarkers(draft, settleSendContext(thread.id, draft, inlinePullRequests)) : draft;
    const send = () => sendDraft({ text: withContext, intent: compactFirst || mode === "queue" ? "queue" : mode === "steer" ? "steer" : "auto" });
    if (compactFirst && thread) {
      // A stale conversation is summarized first; the message queues behind that /compact run.
      const choice = selectedModel();
      void compactThread(thread.id, choice ? { instanceId: choice.provider, model: choice.model } : null).then(send).catch(reportAction);
      return;
    }
    send();
  };
  // ---- Side chat, /clear and compact-before-send ----
  const environmentCapabilities = () => (serverEnvironment()?.capabilities ?? {}) as Record<string, unknown>;
  const sideChatReason = () => sideChatDisabledReason({
    isSideChat: openThread()?.relations?.lineage?.sideChat === true, isSubagent: openThread()?.relations?.lineage?.relationshipToParent === "subagent",
    environmentKnown: serverEnvironment() !== null, environmentSupportsSideChats: environmentCapabilities().sideChats === true, isServerThread: isServerThread(openThread()?.id ?? ""),
  });
  const pendingRequests = () => threadApprovals().length > 0 || threadUserInputs().length > 0;
  const freshSessionAvailable = () => freshSessionOffered({
    messageCount: threadMessages().length, environmentSupportsFreshContext: environmentCapabilities().freshContext === true, pendingRequests: pendingRequests(),
  });
  // compaction.logic hasAvailableCompactionProvider: the instance a send would use among the selected driver's instances,
  // narrowed to the started thread's continuation group, must list `compact`.
  const providerOffersCompact = () => {
    const providers = store.rawProviderRecords() as Record<string, unknown>[];
    const instanceId = selectedModel()?.provider ?? null;
    const driverKind = (providers.find((item) => item.instanceId === instanceId)?.driver as string | undefined) ?? null;
    const threadId = openThread()?.id;
    const lockedInstanceId = threadId ? lockedCompactionInstanceId(store.liveThreadProjection(threadId) as Record<string, unknown> | null) : null;
    return hasAvailableCompactionProvider({ providers, driverKind, instanceId, lockedInstanceId });
  };
  const compactAvailable = () => compactThreadAvailable({
    connected: backendStatus() === "connected", isServerThread: isServerThread(openThread()?.id ?? ""), hasMessages: threadMessages().length > 0,
    providerOffersCompact: providerOffersCompact(), running: isRunning(), pendingRequests: pendingRequests(),
  });
  const keepFullHistory = signal<string[]>([]);
  const keepingHistory = () => keepFullHistory().includes(openThread()?.id ?? "");
  const nowMinute = signal(Date.now());
  const clock = setInterval(() => nowMinute.set(Date.now()), 60_000);
  cleanup(() => clearInterval(clock));
  /** resumeCompactionTokens: a stale Claude thread, with idle compaction on and nothing held. */
  const resumeCompactionTokens = computed<number | null>(() => {
    const choice = selectedModel();
    const usage = latestTokenUsage(providerState());
    if (!choice || !usage) return null;
    const offered = resumeCompactionOffered({
      compactAvailable: compactAvailable(), idleCompactionMode: idleCompactionMode(serverSettings(), choice.provider), hasHeldQueue: queue().isHeld,
      usageOffered: shouldOfferResumeCompaction({ provider: choice.driver ?? choice.provider, usage, now: nowMinute() }),
    });
    return offered && !freshArmed() ? usage.usedTokens : null;
  });
  const compactsBeforeSend = () => resumeCompactionTokens() !== null && !keepingHistory();
  async function startSideChat(parentId: string, prompt: string, draft: string) {
    actionError.set("");
    const target = `thread:${crypto.randomUUID()}`;
    try {
      const choice = selectedModel();
      const attachments = store.uploadedDraftAttachments(parentId);
      const sentText = textWithMarkers(prompt, settleSendContext(parentId, prompt, inlinePullRequests));
      const context = sendContextFor(parentId, sentText);
      const started = await runSideChat({
        parentId, targetId: target, prompt: sentText, attachments,
        ...(context ? { context } : {}),
        runtimeMode: runtimeMode(), arrived: () => isServerThread(target), forkRuntimeMode: () => serverRuntimeModeFor(target),
        modelSelection: choice ? { instanceId: choice.provider, model: choice.model } : null,
      });
      if (started === null) return;
      updatePanel(panelKeyFor(parentId), (state) => openSideChatSurface(state, target));
      focusSideComposer(target);
      if (openThread()?.id === parentId && composerDraft().trim() === draft) {
        setComposerDraft("");
        clearDraftAttachments(parentId);
      }
    } catch (cause) { reportAction(cause); }
  }
  function resume() {
    const thread = openThread();
    if (!thread || !canResume()) return;
    actionError.set("");
    const choice = selectedModel();
    const run = queue().resumableRunId;
    const release = () => queue().isHeld ? resumeThreadQueue(thread.id) : Promise.resolve();
    // useComposerResume: the thread takes the composer's modes (and a moved checkout's branch) before the turn starts.
    const start = run === null
      ? resumeThreadQueue(thread.id)
      : persistThreadSettingsForNextTurn(thread.id, { runtime: runtimeMode(), interaction: interactionMode() })
        .then(() => continueRun(thread.id, run, choice ? { instanceId: choice.provider, model: choice.model } : null)).then(release);
    resuming.set(true);
    // useComposerResume: "Could not resume thread." when the failure carries no message.
    void start.catch((cause: unknown) => actionError.set(cause instanceof Error && cause.message ? cause.message : "Could not resume thread.")).finally(() => resuming.set(false));
  }
  const canSendRun = (item: QueuedMessage) => threadScope.run(() => canSendQueuedRun(item));
  const startEdit = (item: QueuedMessage) => threadScope.run(() => startQueuedEdit(item));
  const cancelEdit = () => threadScope.run(() => cancelQueuedEdit());
  const changeTrait = (id: string, value: string | boolean) => {
    const choice = selectedModel();
    if (!choice) return;
    setModelOptionSelections(choice.provider, choice.model, selectionsFromDescriptors(replaceCurrentValue(selectedDescriptors(), id, value)));
    // onDraftModelOptionsChange: an existing thread takes the new options at once.
    if (!scoped) applyThreadModelPick(openThread()?.id, choice.provider, choice.model);
  };
  const scope = () => JSON.stringify([backendUrl(), openThread()?.id ?? ""]);
  let lastScope = "";
  effect(() => {
    const current = scope();
    if (current !== lastScope) { lastScope = current; attachmentError.set(""); }
  });
  // foldPastedText: a paste of 32 KB or more (or one that would overflow the prompt) leaves the prompt as it was and is
  // attached as a pasted-text file; one that cannot be attached and would overflow is refused with a toast.
  function foldLargePaste(before: string, after: string): boolean {
    if (after.length - before.length < 1024 && after.length <= PROVIDER_SEND_TURN_MAX_INPUT_CHARS) return false;
    const fold = foldPaste({
      before, after, maxInputChars: PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
      canAttach: canAttach(), fileLimit: attachmentCapabilities().files ? attachmentCapabilities().maxFileBytes : null,
      reservedNames: draftAttachments().map((item) => item.name),
    });
    if (fold.kind === "inline") return false;
    // The editor already holds the paste: setting the prompt back rebuilds its document from the text.
    setComposerDraft(before + " ");
    setComposerDraft(before);
    if (fold.kind === "refuse") { showToast({ type: "error", title: fold.title, description: fold.description }); return true; }
    const file = fold.file;
    void addAttachment(file)
      .then(() => showToast({ type: "info", ...pasteFoldedToast(fold.name, file.size, true) }))
      .catch((cause) => attachmentError.set(cause instanceof Error ? cause.message : String(cause)));
    return true;
  }

  async function stageFiles(files: File[], uris: string[]) {
    const originalScope = scope();
    // Folders are mentioned, not attached (addComposerFolders): a path on this computer, for a server that shares it.
    const dropped = await splitDroppedUris(uris);
    if (dropped.folders.length > 0) {
      // addComposerFolders reports these as error toasts.
      if (!isLocalServer(backendUrl())) showToast({ type: "error", title: REMOTE_FOLDER_MESSAGE });
      else if (scope() !== originalScope) showToast({ type: "error", title: "Unable to add folder", description: "The composer is busy; try again once it is ready." });
      else {
        const added = promptWithFolders(composerDraft(), dropped.folders);
        const id = openThread()?.id;
        setComposerDraft(added.text);
        if (id) for (const source of added.sources) rememberMention(id, source, "folder");
        cursor.set(added.text.length);
        forcedRange.set({ start: added.text.length });
      }
      uris = dropped.files;
      if (files.length === 0 && uris.length === 0) return;
    }
    if (!canAttach() && backendStatus() === "connected" && attachmentCapabilities().supported && !isSending() && draftAttachments().length >= attachmentCapabilities().maxCount) { attachmentError.set(attachmentCountMessage(attachmentCapabilities().maxCount)); return; }
    if (!canAttach()) { if (!rewindPending()) attachmentError.set("Attachments are unavailable for this environment."); return; }
    attachmentError.set("");
    // addComposerAttachments: every file is tried; the last refusal is the one shown, and a full draft reads the reference's count copy.
    let error = "";
    const take = async (add: () => Promise<void>) => {
      if (draftAttachments().length >= attachmentCapabilities().maxCount) { error = attachmentCountMessage(attachmentCapabilities().maxCount); return; }
      try { await add(); } catch (cause) { error = cause instanceof Error ? cause.message : String(cause); }
    };
    for (const file of files) {
      if (scope() !== originalScope) return;
      await take(() => addAttachment(file));
    }
    for (const uri of distinctPastedPaths(files.map((file) => file.name), uris)) {
      if (scope() !== originalScope) return;
      await take(() => addAttachmentPath(uri));
    }
    if (scope() === originalScope && error) attachmentError.set(error);
  };
  const requiresModifier = () => { const shortcut = settingValue("sendShortcut"); return shortcut === "mod-enter" || shortcut === "mod-enter-multiline"; };
  // With modified-Enter sending, Command-Enter is the send itself; otherwise it is composer.sendAlternate (while a turn runs).
  effect(() => {
    if (!focused() || settingsOpen() || usageOpen() || !requiresModifier()) return;
    return keymap.bind("mod+enter", () => submit(), { when: "always" });
  });

  const providerStatus = () => providerStatuses().find((item) => item.instanceId === selectedModel()?.provider) ?? null;
  const showProviderBanner = () => backendStatus() === "connected" && shouldShowProviderStatusBanner(providerStatus(), dismissedProviderBanner());

  // ---- Slash / @ suggestion menu (ComposerCommandMenu) ----
  const card = createAnchor();
  const cardWidth = signal(0);
  // isDragOverComposer: files over the composer tint the surface (bg-accent/45 ring-1 ring-inset ring-primary/70).
  const dragOver = signal(false);
  // useRestingComposerControlsLayout: the footer controls host, the model picker (fixed) and the permissions chip (the one
  // resting block), measured; the chip goes icon-only, then into the "More composer controls" overflow.
  const controlsHostWidth = signal<number | null>(null);
  const pickerWidth = signal(0);
  const modeNaturalWidth = signal(0);
  // The chip's icon-only and overflow triggers: ps-1.5 pe-2 around a 16 pt icon.
  const RESTING_ICON_WIDTH = 30;
  let restingLayout: RestingComposerControlsLayout = { hiddenCount: 0, iconOnlyCount: 0, visible: true };
  const restingCollapse = computed(() => {
    const host = controlsHostWidth();
    if (host === null || modeNaturalWidth() === 0) return "natural" as const;
    restingLayout = resolveRestingComposerControlsLayout({
      gap: 2, naturalFixedWidth: pickerWidth(), minimumFixedWidth: Math.min(pickerWidth(), 52),
      blockWidths: [modeNaturalWidth()], iconOnlyBlockWidths: [RESTING_ICON_WIDTH], overflowWidth: RESTING_ICON_WIDTH,
      hostWidth: host, previous: untracked(() => restingLayout),
    });
    return restingLayout.hiddenCount > 0 ? "overflow" as const : (restingLayout.iconOnlyCount ?? 0) > 0 ? "icon" as const : "natural" as const;
  });
  const cursor = signal(0);
  const forcedRange = signal<{ start: number } | undefined>(undefined);
  const dismissed = signal("");
  const activeIndex = signal(0);
  const usageLimitsOpen = signal(false);
  // useUsageLimitsPanel: the panel belongs to the thread it was opened on; switching threads closes it.
  { let shownFor = untracked(() => openThread()?.id); effect(() => { const id = openThread()?.id; if (id !== shownFor) { shownFor = id; untracked(() => usageLimitsOpen.set(false)); } }); }
  const stashOpen = signal(false);
  const pathResults = signal<CommandItem[]>([]);
  const pathLoading = signal(false);
  const pullRequestEntries = signal<ReturnType<typeof parsePullRequests>>([]);
  const pullRequestsLoading = signal(false);
  const pullRequestsFailed = signal(false);
  const trigger = computed(() => detectComposerTrigger(composerDraft(), cursor()));
  const triggerKey = () => { const found = trigger(); return found ? `${found.kind}:${found.rangeStart}:${found.query}` : ""; };
  // A page or the palette over the composer takes the suggestion menu with it (its popup would draw above them), and brings it back when it closes.
  const menuTrigger = () => (!appOverlayOpen() && triggerKey() !== "" && triggerKey() !== dismissed() ? trigger() : null);
  const menuItems = computed<CommandItem[]>(() => {
    const found = menuTrigger();
    if (!found) return [];
    const provider = selectedModel()?.provider ?? "";
    if (found.kind === "slash-command") {
      const draft = composerDraft();
      const items = slashMenuItems({
        commands: providerCommands(), skills: providerSkills(), provider, showSkills: settingValue("showSkillsInSlashMenu") !== false, atPromptStart: found.rangeStart === 0,
        usageLimitsOffered: providerUsageLimits() !== null,
        // Every thread can start a side chat from the menu; the row says why it cannot (useComposerMenuItems).
        sideChatAvailable: openThread() !== undefined, sideChatDisabledReason: sideChatReason(), freshSessionAvailable: freshSessionAvailable(),
        // /compact lists only as the whole message, on a thread that can be compacted, with nothing else attached.
        compactAvailable: compactAvailable() && draft.slice(0, found.rangeStart).trim() === "" && draft.slice(found.rangeEnd).trim() === "" && draftAttachments().length === 0,
      });
      return searchSlashCommands(items, found.query);
    }
    if (found.kind === "skill") return skillMenuItems(providerSkills(), provider, found.query);
    if (found.kind === "pull-request") return pullRequestItems(pullRequestEntries(), null, found.query);
    // Models matching an `@` mention come before files (rankComposerModelMentions).
    const threadChoices = [
      ...allProjects().flatMap((project) => project.threads).map((item) => machineScopedThread(item, { environment: serverEnvironment() })),
      ...store.allThreads()
        .filter((item) => item.relations?.lineage?.sideChat === true)
        .map((item) => ({ ...machineScopedThread(item, { environment: serverEnvironment() }), sideChat: true })),
    ];
    return [...modelMentionItems(availableModels(), found.query), ...threadMentionItems(threadChoices, { linkedEnvironments: openThreadLinkedEnvironments(), environmentId: serverEnvironmentIdOf(openThread()?.environmentId ?? "primary", { environment: serverEnvironment() }) ?? store.usageEnvironments()[0]?.id, excludeThreadId: openThread()?.id, query: found.query }), ...machineMentionItems(found.query), ...pathResults()];
  });
  const menuLoading = () => (menuTrigger()?.kind === "path" ? pathLoading() && (menuTrigger()?.query.length ?? 0) > 0 : menuTrigger()?.kind === "pull-request" ? pullRequestsLoading() : menuTrigger()?.kind === "skill" || menuTrigger()?.kind === "slash-command" ? workspaceSkillsScanning() : false);
  const searchCwd = () => {
    const thread = openThread();
    return thread?.path ?? allProjects().find((item) => item.id === thread?.projectId)?.path ?? null;
  };
  let searchSerial = 0;
  effect(() => {
    const found = menuTrigger();
    const cwd = searchCwd();
    const serial = ++searchSerial;
    activeIndex.set(0);
    if (found?.kind !== "path" || !cwd || backendStatus() !== "connected") { pathResults.set([]); pathLoading.set(false); return; }
    const query = found.query.slice(0, 256);
    pathLoading.set(true);
    const timer = setTimeout(() => { void requestBackend("projects.searchEntries", { cwd, query, limit: 80 })
      .then((value) => { if (serial === searchSerial) pathResults.set(parseSearchEntries(value)); })
      .catch(() => { if (serial === searchSerial) pathResults.set([]); })
      .finally(() => { if (serial === searchSerial) pathLoading.set(false); }); }, 120);
    return () => clearTimeout(timer);
  });
  let pullRequestSerial = 0;
  effect(() => {
    const found = menuTrigger();
    const projectId = openThread()?.projectId;
    if (found?.kind !== "pull-request" || !projectId || backendStatus() !== "connected") { pullRequestEntries.set([]); pullRequestsLoading.set(false); return; }
    const serial = ++pullRequestSerial;
    const text = found.query.length > 0 && !/^\d+$/.test(found.query) ? { query: found.query.slice(0, 200) } : {};
    pullRequestsLoading.set(true);
    pullRequestsFailed.set(false);
    requestBackend("pullRequests.list", { state: "all", projectId, limit: 99, ...text })
      .then(async (value) => {
        if (serial !== pullRequestSerial) return;
        let entries = parsePullRequests(value);
        pullRequestEntries.set(entries);
        pullRequestsFailed.set(pullRequestListFailed(value, projectId));
        // A number the recent list does not hold is looked up on its own (useComposerMenuItems' exact pull request lookup).
        const number = /^\d+$/.test(found.query) ? Number(found.query) : 0;
        const repository = entries[0]?.repository;
        if (!Number.isSafeInteger(number) || number <= 0 || !repository || entries.some((entry) => entry.number === number)) return;
        try {
          const exact = parsePullRequests({ entries: [await requestBackend("pullRequests.detail", { projectId, repository, number })] });
          if (serial === pullRequestSerial && exact.length > 0) { entries = [...exact, ...entries]; pullRequestEntries.set(entries); }
        } catch { /* the number names no pull request here: the list's own answer stands */ }
      })
      .catch(() => { if (serial === pullRequestSerial) { pullRequestEntries.set([]); pullRequestsFailed.set(true); } })
      .finally(() => { if (serial === pullRequestSerial) pullRequestsLoading.set(false); });
  });
  const inlinePullRequests = inlineContextIds;
  function chooseItem(item: CommandItem) {
    const found = menuTrigger();
    if (!found) return;
    const thread = openThread();
    // Each row says what picking it does: /model, /clear and /usage-limits execute (open the picker, arm a
    // fresh session, show the banner), a `#` pull request attaches a context reference, /side and /btw start a
    // side chat message, and everything else inserts text.
    const usage = item.type === "provider-slash-command" && item.command.name === "usage-limits";
    // A `#` pull request goes inline as its context reference (`[#12](t3-context://...)`), shown as a token.
    const pullRequest = false;
    if (item.type === "slash-command" && (item.command === "side" || item.command === "btw") && sideChatReason() !== null) return;
    const replacement = (item.type === "slash-command" && item.command !== "side" && item.command !== "btw") || usage || pullRequest ? ""
      : item.type === "slash-command" ? `/${item.command} `
      : item.type === "path" ? `${serializeComposerFileLink(item.path)} `
      : item.type === "provider-slash-command" ? `/${item.command.name} `
      : item.type === "skill" ? `$${item.skill.name} `
      : item.type === "pull-request" ? `${pullRequestMarker(pullRequestContextRecord(item.pullRequest))} `
      : item.type === "model" ? `${item.source} `
      : item.type === "thread" ? `${extraContextMarker(threadContextRecord(item.thread, item.label))} `
      : item.type === "environment" ? `${extraContextMarker(environmentContextRecord(item.environmentId, item.label))} `
      : "";
    const next = applyReplacement(composerDraft(), found, replacement);
    setComposerDraft(next.text);
    cursor.set(next.cursor);
    forcedRange.set({ start: next.cursor });
    if (thread && item.type === "path") rememberMention(thread.id, serializeComposerFileLink(item.path), item.pathKind === "directory" ? "folder" : "file");
    if (thread && item.type === "skill") rememberMention(thread.id, `$${item.skill.name}`, "skill");
    if (thread && item.type === "environment") { const record = environmentContextRecord(item.environmentId, item.label); attachExtraContext(thread.id, record); inlinePullRequests.add(record.contextId); }
    if (thread && item.type === "thread") { const record = threadContextRecord(item.thread, item.label); attachExtraContext(thread.id, record); inlinePullRequests.add(record.contextId); }
    if (thread && item.type === "pull-request") { attachPullRequest(thread.id, item.pullRequest); inlinePullRequests.add(pullRequestContextRecord(item.pullRequest).contextId); }
    if (item.type === "slash-command" && item.command === "model") modelPickerOpen.set(true);
    if (item.type === "slash-command" && item.command === "clear" && thread) setFreshContext(thread.id, true);
    if (usage) usageLimitsOpen.set(true);
  }
  // The focused editor takes every key, so it hands the menu's, the history's and the send's keys back
  // here while they apply (PromptEditor's captured keys); unfocused, the keymap still serves the menu.
  const editingEscape = () => !menuTrigger() && editingQueued() !== null && !appOverlayOpen();
  const menuKey = (key: "escape" | "up" | "down" | "enter" | "tab") => {
    const hasItems = menuItems().length > 0;
    if (key === "escape") { dismissed.set(triggerKey()); return; }
    if (!hasItems) return;
    if (key === "up") activeIndex.set(moveHighlight(activeIndex(), -1, menuItems().length));
    else if (key === "down") activeIndex.set(moveHighlight(activeIndex(), 1, menuItems().length));
    else { const item = menuItems()[activeIndex()]; if (item) chooseItem(item); }
  };
  effect(() => {
    if (focused() || !menuTrigger()) return;
    return keymap.bind({ escape: () => menuKey("escape"), up: () => menuKey("up"), down: () => menuKey("down"), enter: () => menuKey("enter"), tab: () => menuKey("tab") }, { when: "always", repeat: true });
  });

  // ---- Prompt history: Up recalls earlier messages (composerPromptHistory) ----
  let historyPosition: PromptHistoryPosition | null = null;
  function recall(direction: "backward" | "forward") {
    const entries = buildPromptHistoryEntries(threadMessages());
    const step = stepPromptHistory({ direction, entries, position: historyPosition, currentPrompt: composerDraft() });
    if (!step) return;
    historyPosition = step.position;
    setComposerDraft(step.prompt);
    cursor.set(step.prompt.length);
    forcedRange.set({ start: step.prompt.length });
  }
  effect(() => {
    const draft = composerDraft();
    if (historyPosition && historyPosition.recalled !== draft) historyPosition = null;
  });
  // composerCommandKey navigatePromptHistory: history answers Up/Down only when nothing else is in the message (no question being
  // answered, no attachments or contexts) and the composer is empty or a recalled prompt is being walked, and only while the
  // caret is on the visual edge for the key (first visual line for Up, last for Down; PromptEditor measures it with
  // coordsAtPos, so a multiline or soft-wrapped recalled prompt walks lines first, then history).
  const historyKeys = (caretOnVisualEdge: boolean) => {
    if (!focused() || menuTrigger() || stashOpen() || settingsOpen() || usageOpen()) return false;
    const threadId = openThread()?.id;
    if (threadUserInputs().length > 0 || draftAttachments().length > 0 || attachedExtraContexts(threadId).length > 0 || attachedPullRequests(threadId).length > 0) return false;
    const draft = composerDraft();
    if (historyPosition === null && draft.length > 0) return false;
    return caretOnVisualEdge;
  };

  // ---- Prompt stash (composer.stash, mod+s) ----
  hydrateStash();
  function restoreStash(entry: StashEntry) {
    const taken = takeStashEntry(entry.id);
    if (!taken) return;
    stashOpen.set(false);
    reattachDraftAttachments(taken.attachments ?? []);
    const restoreThreadId = openThread()?.id;
    if (restoreThreadId && taken.records?.length) restoreContextRecords(restoreThreadId, taken.records);
    const next = restoredPrompt(composerDraft(), taken.prompt);
    setComposerDraft(next);
    cursor.set(next.length);
    forcedRange.set({ start: next.length });
  }
  function deleteStash(entry: StashEntry) {
    takeStashEntry(entry.id);
    if (stashEntries().length === 0) stashOpen.set(false);
  }
  /** With a prompt or attachments, sets them aside and clears the composer; empty, restores the only entry or toggles the menu. */
  function stashShortcut() {
    if (paletteOpen()) return;
    const prompt = composerDraft().trim();
    if (prompt.length === 0) {
      if (draftAttachments().length > 0) {
        if (draftAttachments().some((item) => item.status !== "uploaded")) { actionError.set("Wait for attachments to finish uploading before stashing."); return; }
      } else {
        const entries = stashEntries();
        if (entries.length === 1) restoreStash(entries[0]!);
        else stashOpen.set(!stashOpen());
        return;
      }
    } else if (draftAttachments().some((item) => item.status !== "uploaded")) {
      actionError.set("Wait for attachments to finish uploading before stashing.");
      return;
    }
    const attachments = detachDraftAttachments().flatMap((item): StashAttachment[] => item.uploadedId
      ? [{ id: item.id, name: item.name, mimeType: item.mimeType, sizeBytes: item.sizeBytes, kind: item.kind, status: "uploaded", uploadedId: item.uploadedId, ...(item.file ? { file: item.file } : {}) }] : []);
    // useComposerStash: the entry carries the composer's context records (chips); the composer clears only once the
    // write succeeded, and a refused write puts the attachments and records back and leaves the prompt as it was.
    const stashThreadId = openThread()?.id;
    const records = stashThreadId ? takeContextRecords(stashThreadId) : [];
    void stashPromptDurably(prompt, Date.now(), attachments, records as unknown as StashRecord[]).then(({ evicted, written }) => {
      if (!written) {
        reattachDraftAttachments(attachments);
        if (stashThreadId) restoreContextRecords(stashThreadId, records);
        showToast({ type: "error", title: "Could not stash this prompt", description: "Storage rejected the write, so the composer was left as-is. Free up disk space and try again." });
        return;
      }
      // A full stash drops its oldest entry and says so.
      if (evicted) showToast({ type: "warning", title: "Oldest stashed prompt discarded", description: `The stash holds ${MAX_STASH_ENTRIES} prompts; the oldest was removed to make room.` });
      if (composerDraft().trim() === prompt) {
        setComposerDraft("");
        cursor.set(0);
        forcedRange.set({ start: 0 });
      }
      historyPosition = null;
    });
  }
  let stashDraft = composerDraft();
  effect(() => {
    const draft = composerDraft();
    const open = menuTrigger() !== null;
    if (draft === stashDraft && !open) return;
    stashDraft = draft;
    if (stashOpen()) stashOpen.set(false);
  });

  // ---- Keyboard focus (composerFocusRedirect / usePasteToFocusComposer) ----
  // The composer holds the keyboard whenever no overlay owns it: after a thread or draft opens, and
  // after the palette, settings, usage dialog, model picker or a menu closes, so typing never beeps.
  let inputNode: { focus: () => void; blur?: () => void } | null = null;
  let promptSession: { run(command: unknown): unknown } | null = null;
  // A focused rich editor takes every key it does not forward, Escape included, so an app-level overlay over it (Settings,
  // usage, the palette) would never hear Escape: the editor gives the keyboard up while one is open.
  effect(() => {
if (appOverlayOpen()) inputNode?.blur?.();
  });
  effect(() => {
    openThread()?.id;
    // The keyboard goes to the composer that owns it: a side chat's composer while it was just opened or clicked.
    if (composerOwner() !== (scoped ? openThread()?.id ?? "" : null)) return;
    const overlay = paletteOpen() || settingsOpen() || usageOpen() || modelPickerOpen() || menuTrigger() !== null || stashOpen();
    if (overlay) return;
    // Never pull the keyboard out of a terminal or the browser preview the user is typing in.
// Ownership is checked again when the frame comes: a frame queued for the composer that owned the keyboard then, run
  // after the other composer took it, focused it back, and the two composers passed the keyboard to each other forever.
requestAnimationFrame(() => { if (composerOwner() !== (scoped ? openThread()?.id ?? "" : null)) return; if (!terminalFocused() && !previewFocused()) inputNode?.focus(); });
  });

  // ComposerCitationCommentContext: the composer citation chips by their link, for the comment editor's anchor.
  const citationChipRefs = new Map<string, ViewRef>();
  // Type-to-focus and paste-to-focus: with nothing holding the keyboard, a typed character or a paste lands in the
  // composer instead of beeping (composerFocusRedirect, usePasteToFocusComposer).
  function insertAtEnd(text: string) {
    const next = composerDraft() + text;
    inputNode?.focus();
    setComposerDraft(next);
    cursor.set(next.length);
    forcedRange.set({ start: next.length });
    // usePasteToFocusComposer: a pasted marker brings its context record back as a chip (readPastedComposerContext).
    const id = openThread()?.id;
    if (id) { restorePastedContexts(id, text); void importPastedAttachments(id, text); }
  }
  // pasteTextAtEnd: the paste chord with nothing focused takes the same large-paste fold as a paste into the editor; Paste as Text
  // (bindComposerPasteAsText) inserts as typed, which is the web's 1 s bypass window (an armed shortcut skips auto-attachment).
  function pasteAtEnd(text: string) {
    const before = composerDraft();
    if (foldLargePaste(before, before + text)) return;
    insertAtEnd(text);
  }
  effect(() => {
    if (!openThread() || scoped) return;
    return bindTypeToFocus({
      // A terminal or the browser preview holding the keyboard is a native web view, which the keymap
      // sees as "not editing": without this guard every key typed in the terminal was pulled into the
      // composer and the terminal lost focus.
      enabled: () => !terminalFocused() && !previewFocused() && shouldRedirectInput({
        paletteOpen: paletteOpen(), settingsOpen: settingsOpen(), usageOpen: usageOpen(), modelPickerOpen: modelPickerOpen(),
        suggestionMenuOpen: menuTrigger() !== null, stashOpen: stashOpen(), overlayOpen: appOverlayOpen(),
      }),
      onText: insertAtEnd,
      onPaste: () => { const originalScope = scope(); void pasteIntoComposer({ isCurrent: () => scope() === originalScope, insertText: pasteAtEnd, attachPaths: (uris) => { inputNode?.focus(); void stageFiles([], uris); }, attachFiles: (files) => { inputNode?.focus(); void stageFiles(files, []); } }); },
    });
  });
  // While a terminal WebView is still the window's first responder (it stays so after its page is blurred; nothing in the
  // app can move it back, workspace/nsh-runtime-bugs.md "First-responder hand-back"), the editor gets its named keys
  // (Backspace, arrows) but no typed characters: those go to the WebView's input context. The keymap still sees them, so
  // while that holds and the editor has the focus, typing keys are inserted at the caret from here.
  effect(() => {
    // Not on a host that moves first responder natively (nativeWebFocus): a press on the editor already took the keyboard
    // back there, and its typed characters arrive by themselves (bound here as well, every key typed twice).
    if (scoped || nativeWebFocus() || !webKeyboardHeld() || !focused()) return;
    releaseWebKeyboard();
    const removers: Array<() => void> = [];
    for (const { keystroke, text } of TYPE_TO_FOCUS_KEYS) {
      try { removers.push(keymap.bind(keystroke, () => { promptSession?.run(insertRichText(text)); }, { when: "always", repeat: true })); } catch { /* a layout the keymap rejects */ }
    }
    return () => { for (const remove of removers) remove(); };
  });
  // A press on the composer while a terminal page holds the keyboard reaches only the page (webKeyboard.ts pageBlurredByPress).
  effect(() => { if (scoped) return; const release = setComposerFocus(() => { focusMainComposer(); inputNode?.focus(); }); return () => { release(); pointerOverComposer.set(false); }; });
  // ChatView workLocallyResend: after "Work locally" cancelled the setup and the launch handed the message back, the draft
  // switches to local and the waiting message is sent again once sending is idle.
  if (!scoped) effect(() => {
    const id = openThread()?.id ?? null;
    const step = workLocallyStep({ pendingDraftId: workLocallyResendDraftId(), draftId: id, isDraft: id !== null && !isServerThread(id), sending: isSending(), connected: backendStatus() === "connected", workspaceType: store.workspaceStrategy().type });
    if (step === "wait") return;
    untracked(() => {
      if (step === "switch") { try { store.setWorkspaceStrategy({ type: "root" }); } catch { workLocallyResendDraftId.set(null); } return; }
      workLocallyResendDraftId.set(null);
      submit();
    });
  });
  // workspaceFocus "thread" (the reference's content area): the main composer takes the keyboard.
  if (!scoped) cleanup(registerFocusArea({ id: "thread", focus: () => { focusMainComposer(); inputNode?.focus(); }, available: () => inputNode !== null && inputNode !== undefined }));
  const typingGuard = useComposerTypingGuard(() => scope(), () => [...threadApprovals().map((item) => item.id), ...threadUserInputs().map((item) => item.id)]);
  effect(() => { if (!scoped) heldRequestIds.set(typingGuard.held()); });
  let draftSeen = composerDraft();
  effect(() => { const draft = composerDraft(); if (draft === draftSeen) return; draftSeen = draft; typingGuard.onDraftChange(); });

  // ---- Shortcuts (command registry) and the when-contexts they read ----
  if (!scoped) defineContext("composerFocus", () => focused());
  if (!scoped) defineContext("modelPickerOpen", () => modelPickerOpen());
  // The context strip names the permissions on a new thread (permissionsShownInStrip).
  const stripShowsPermissions = () => openThread() !== undefined && !isServerThread(openThread()!.id) && allProjects().some((item) => item.id === openThread()?.projectId);
  // composerProviderState composerSurfaceClassName while the prompt names Ultrathink: a 1px white inset ring (shadow-[0_0_0_1px_rgba(255,255,255,0.07)_inset]).
  const ultrathinkSurface = () => ultrathinkPromptControlled(selectedDescriptors(), composerDraft()) ? ", inset 0 0 0 1px rgba(255,255,255,0.07)" : "";
  const canPickModel = () => Boolean(openThread()?.id) && !isSending() && backendStatus() === "connected" && availableModels().length > 0;
  const openModeControl = () => {
    if (backendStatus() !== "connected" || !selectedModel() || availableRuntimeModes().length === 0 || isSending()) return false;
    // The chip owns the shortcut while the mode differs from the default; otherwise the picker's footer holds Permissions.
    if (stripShowsPermissions() || showsPermissionsChip(runtimeMode(), defaultRuntimeChoice())) { setPermissionsOpen("chip", true); return; }
    modelPickerOpen.set(true);
    setPermissionsOpen("footer", true);
  };
  // Dictation (composer/dictation.ts): gated and shaped by the Voice settings, on the system recognizer.
  const dictationDeps: Parameters<typeof makeDictation>[0] = {
    speech: Speech as never,
    // The reference records and sends audio to the granted destination (the environment's model or its cloud provider).
    recorder: {
      available: () => canCaptureAudio() && audioGrant() !== null,
      start: (options) => startCapture({ ...options, deviceId: voiceMicrophone() || null }),
      discard: discardRecording,
      transcribe: (pcm) => {
        const bool = (field: string, fallback: boolean) => { const value = readSetting(field, "client"); return typeof value === "boolean" ? value : fallback; };
        const options = {
          speechLanguage: speechLanguage(), speechTranslateToEnglish: bool("speechTranslateToEnglish", false),
          speechCustomWords: [...speechCustomWords(), ...projectCustomWords()], speechRemoveFillerWords: bool("speechRemoveFillerWords", true),
          speechSilenceFiltering: bool("speechSilenceFiltering", true), ...(correctionCue() ? { speechCorrectionWord: correctionCue() } : {}),
        };
        const destination = audioGrant()?.destination;
        if (destination?.kind === "cloud") return transcribeCloudSpeechPcm(destination.provider, pcm, options, destination.provider === "openrouter" ? destination.model : undefined);
        return transcribeSpeechPcm(pcm, options);
      },
      // The environment's own model streams live text over /ws/voice when its status says so; cloud destinations do not.
      follow: (path) => followWav(path),
      live: async (onText, onError) => {
        if (audioGrant()?.destination.kind !== "environment") return null;
        if (!(await speechStreamingAvailable())) return null;
        const bool = (field: string, fallback: boolean) => { const value = readSetting(field, "client"); return typeof value === "boolean" ? value : fallback; };
        const url = await speechStreamUrl(SPEECH_STREAM_PATH);
        const socket = new WebSocket(url);
        socket.binaryType = "arraybuffer";
        return openSpeechStream({
          socket: socket as unknown as SocketLike,
          options: {
            speechLanguage: speechLanguage(), speechTranslateToEnglish: bool("speechTranslateToEnglish", false),
            speechCustomWords: [...speechCustomWords(), ...projectCustomWords()], speechRemoveFillerWords: bool("speechRemoveFillerWords", true),
            speechSilenceFiltering: bool("speechSilenceFiltering", true), ...(correctionCue() ? { speechCorrectionWord: correctionCue() } : {}),
          },
          canSend: () => audioGrant() !== null,
          onText, onError,
        });
      },
    },
    choice: voiceChoice,
    language: () => { const value = readSetting("speechLanguage", "client"); return typeof value === "string" && value ? value : "auto"; },
    removeFillers: () => readSetting("speechRemoveFillerWords", "client") !== false,
    threadId: () => openThread()?.id, prompt: () => composerDraft(), caret: () => cursor(),
    insert: (text, caret) => { setComposerDraft(text); cursor.set(caret); forcedRange.set({ start: caret }); },
    openSetup: () => openSettings("/settings/voice"),
  };
  const dictation = makeDictation(dictationDeps);
  if (!scoped) registerSharedDictation(dictationDeps);
  // The mic button and the shortcut go through the setup flow (speech/voiceSetup.ts): settings on a first run, the setup dialog for a missing model.
  const startDictation = () => { if (dictating() && dictation.state().phase !== "error") return; void startRealVoiceInput(() => dictation.start()); };
  const dictating = () => dictation.state().phase !== "idle";
  // Files dropped on this thread's sidebar row wait in the queue until its composer is up (queuePendingFileDrop); stage them once.
  effect(() => {
    const id = openThread()?.id;
    if (!id || pendingFileDrop(id) === null) return;
    const uris = takePendingFileDrop(id);
    if (uris.length > 0) void stageFiles([], uris);
  });
  // composer.sendBackground (a draft: start it and leave a fresh composer) and composer.sendAndNewThread (a server thread).
  const sendBackgroundCommand = (command: "composer.sendBackground" | "composer.sendAndNewThread") => {
    const id = openThread()?.id;
    if (!id || !sendBackgroundApplies(command, !isServerThread(id))) return false;
    return sendInBackground({
      threadId: () => openThread()?.id, projectId: () => openThread()?.projectId, isDraft: () => !isServerThread(id), canSend, submit: () => { if (command === "composer.sendBackground") store.markBackgroundSend(id); submit(); },
      isSending, newThread: (projectId) => store.createThread(projectId), open: (threadId) => store.openThreadById(threadId),
      toast: (input) => { showToast({ type: input.type, title: input.title, ...(input.description ? { description: input.description } : {}), ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}), ...(input.actions ? { actions: input.actions } : {}) }); },
    }) ? undefined : false;
  };
  if (!scoped) cleanup(bindComposerSendCommands({
    sendBackground: () => void sendBackgroundCommand("composer.sendBackground"),
    sendAndNewThread: () => void sendBackgroundCommand("composer.sendAndNewThread"),
  }));
  // setContextInsertionHandler: a terminal selection or preview annotation added to chat lands at the caret of this editor.
  if (!scoped) cleanup(setContextInsertionHandler((marker) => {
    if (!promptSession || openThread() === null) return false;
    promptSession.run(insertRichText(markerAtCaret(composerDraft().slice(0, cursor()), marker)));
    return true;
  }));
  if (!scoped) cleanup(bindComposerPasteAsText((text) => { if (promptSession) promptSession.run(insertRichText(text)); else insertAtEnd(text); }));
  // The connection banner (useSystemComposerBanners): "<label> is reconnecting" once held past the grace period, "<label> is offline" with Reconnect.
  const reconnectGrace = signal(false);
  effect(() => {
    if (currentConnectionPhase() !== "reconnecting") { reconnectGrace.set(false); return; }
    const timer = setTimeout(() => reconnectGrace.set(true), ENVIRONMENT_RECONNECT_WARNING_GRACE_MS);
    return () => clearTimeout(timer);
  });
  const connectionBanner = (): BannerItem | null => {
    const notice = connectionNotice({ phase: currentConnectionPhase(), label: environmentLabel(), error: backendError(), graceElapsed: reconnectGrace(), hasSession: store.backendBearer() !== null });
    if (!notice) return null;
    return {
      id: CONNECTION_NOTICE_ID, variant: notice.variant, group: "environment", icon: notice.variant === "error" ? "wifi-off" : "refresh-cw", title: notice.title,
      ...(notice.description ? { description: notice.description } : {}),
      actions: notice.action === null ? [] : [{
        id: "connection-action", label: notice.action, tone: "button",
        run: () => { if (notice.action === "Reconnect") void store.configureBackend(store.backendUrl()); else openSettings("/settings/connections"); },
      }],
    };
  };
  // The main composer owns the shortcuts; a side chat's composer takes typed and submitted input only.
  if (!scoped) registerCommands({
    "composer.stash": stashShortcut,
    "modelPicker.toggle": () => { if (!canPickModel()) return false; modelPickerOpen.set(!modelPickerOpen()); },
    "composer.effort": () => { if (!canPickModel()) return false; effortFocusPending.set(true); modelPickerOpen.set(true); },
    "composer.mode": openModeControl,
    "composer.host": () => { const id = openThread()?.id; if (!id || isServerThread(id) || backendStatus() !== "connected") return false; requestHostMenu(); },
    "composer.cycleHost": () => cycleDraftEnvironment() ? undefined : false,
    "composer.workspace": () => { const id = openThread()?.id; if (!id || isServerThread(id)) return false; requestWorkspaceMenu(); },
    "composer.branch": () => { if (!openThread()) return false; branchPickerOpen.set(true); },
    "composer.previousWorktree": () => { const id = openThread()?.id; if (!id || isServerThread(id)) return false; requestPreviousWorktree(); },
    "composer.dictation": () => { if (dictation.state().phase === "recording") dictation.confirm(); else startDictation(); },
    // Command-Enter flips the follow-up action while a turn runs, unless modified Enter is the send itself.
    "composer.sendAlternate": () => { if (!isRunning()) return false; submit(undefined, true); },
    "thread.steerQueuedMessage": () => { const first = queue().queued[0]; if (!first || !canSendRun(first)) return false; void sendQueuedRun(first); },
    "thread.editQueuedMessage": () => { const last = queue().queued[queue().queued.length - 1]; if (!last || editingQueued() || Math.min(cursor(), composerDraft().length) !== 0) return false; startEdit(last); },
  });

  return (
    <View ref={(node) => registerComposerMentionDrop(node, (active) => dragOver.set(active))} class={`mx-auto w-full min-w-0 shrink-0 pb-3 ${chatWidthClass()}`}>
      <ComposerBanners hideEnvironment freshSession={() => ({ available: freshSessionAvailable(), armed: freshArmed() })} />
      {usageLimitsOpen() && providerUsageLimits() ? (
        <UsageLimitsBanner
          title={(() => { const choice = selectedModel(); const meta = choice ? providerMetaFor(choice.provider) : null; return meta?.displayName ?? "Provider"; })()}
          limits={() => providerUsageLimits()!}
          now={() => Date.now()}
          onDismiss={() => usageLimitsOpen.set(false)}
        />
      ) : null}
      {connectionBanner() ? <NoticeCard item={connectionBanner()!} first last /> : null}
      {backendError() && !connectionBanner() ? (
        <View class="mb-2 rounded-lg border border-error bg-error-surface px-3 py-2">
          <Text class="text-xs text-destructive">{backendError()}</Text>
        </View>
      ) : backendStatus() === "disconnected" ? (
        <View class="mb-2 rounded-lg border border-border px-3 py-2">
          <Text class="text-xs text-muted-foreground">Environment disconnected. Your draft is kept here.</Text>
        </View>
      ) : null}
      {attachmentError() ? <Text class="mb-2 text-xs text-destructive">{attachmentError()}</Text> : null}
      {actionError() || queueActionError() ? <Text class="mb-2 text-xs text-destructive">{actionError() || queueActionError()}</Text> : null}
      {backendStatus() === "connected" && !openThread()?.projectId ? <Text class="mb-2 text-xs text-muted-foreground">Choose or add a project before sending.</Text> : null}
      {stashEntries().length > 0 ? <ComposerStashBadge count={() => stashEntries().length} menuOpen={stashOpen} pulseKey={stashPulseKey} onToggle={() => stashOpen.set(!stashOpen())} /> : null}
      {stashOpen() && !menuTrigger() ? (
        <ComposerStashMenu
          entries={stashEntries}
          shortcutLabel={shortcutLabel("composer.stash")}
          now={() => Date.now()}
          onRestore={restoreStash}
          onDelete={deleteStash}
          onClose={() => stashOpen.set(false)}
        />
      ) : null}
      <View
        ref={card.ref}
        onLayout={(event) => { cardWidth.set(event.bounds.size.width); composerCardSize.set({ width: event.bounds.size.width, height: event.bounds.size.height }); }}
        class="rounded-2xl pt-4 pb-2"
        // The glass surface at the configured opacity over the page background, its 1px
        // outline drawn inside (ComposerSurface's after:border), and --shadow-composer in light only (dark:shadow-none).
        style={{
          backgroundColor: dragOver() ? tokenAlpha("accent", 0.45) : composerGlassSurface(),
          ...(platform.os === "windows" ? {} : { backdropFilter: colorScheme() === "dark" ? "blur(16px) saturate(1.08)" : "blur(12px) saturate(1.14)" }),
          boxShadow: dragOver() ? `inset 0 0 0 1px ${tokenAlpha("primary", 0.7)}` : colorScheme() === "dark"
            ? `inset 0 0 0 1px ${composerOutline()}, inset 0 1px 2px ${composerHighlight()}${ultrathinkSurface()}`
            : `0 1px 2px rgba(0,0,0,0.05), inset 0 0 0 1px ${composerOutline()}${ultrathinkSurface()}`,
        }}
      >
        {menuTrigger() ? (
          <CommandMenu
            anchor={card.anchor}
            kind={menuTrigger()!.kind}
            items={menuItems}
            active={activeIndex}
            loading={menuLoading}
            emptyText={() => menuTrigger()?.kind === "pull-request" ? pullRequestEmptyState({ available: Boolean(openThread()?.projectId), failed: pullRequestsFailed(), query: menuTrigger()!.query }) : null}
            width={cardWidth}
            onHighlight={(index) => activeIndex.set(index)}
            onSelect={chooseItem}
            onClose={() => dismissed.set(triggerKey())}
          />
        ) : null}
        <View class="px-4 pb-2">
        {chipsFor(openThread()?.id, composerDraft()).some((chip) => chip.kind === "pull-request") ? (
          <ComposerChips
            chips={() => chipsFor(openThread()?.id, composerDraft()).filter((chip) => chip.kind === "pull-request")}
            onRemove={(chip) => {
              const id = openThread()?.id;
              if (!id) return;
              if (chip.token === null) detachPullRequest(id, chip.id);
              else setComposerDraft(removeMentionToken(composerDraft(), chip.token));
            }}
          />
        ) : null}
        {scoped ? null : <ComposerCitationChips draft={composerDraft} chipRefs={citationChipRefs} />}
        {scoped ? null : <CitationCommentEditorHost chipRef={(source) => citationChipRefs.get(source)} onSubmitAndSend={() => submit()} onRestoreFocus={() => inputNode?.focus()} />}
        {editingQueued()?.attachments?.length ? <QueuedAttachmentRow attachments={() => editingQueued()?.attachments ?? []} onRemove={removeEditingQueuedAttachment} /> : null}
        {draftAttachments().length ? <AttachmentList items={() => draftAttachments().filter((item) => item.kind !== "file" || isVideoAttachment(item) || item.status !== "uploaded" || !attachmentReferencedIn(composerDraft(), item))} fileFor={draftAttachmentFile} uploadedIdFor={(id) => store.draftAttachmentUploadedIdFor(openThread()?.id ?? "", id)} fileLimit={() => attachmentCapabilities().files ? attachmentCapabilities().maxFileBytes : null} disabled={isSending} onRemove={removeAttachment} onRetry={retryAttachment} /> : null}
        <View class="relative min-h-[46px] w-full" onMouseEnter={() => { if (!scoped) notePointerOverComposer(true); }} onMouseLeave={() => { if (!scoped) notePointerOverComposer(false); }}>
          <PromptEditor
            accessibilityLabel={() => { const title = openThread()?.title; return title ? `Message ${title}` : "Message"; }}
            ref={(handle) => { inputNode = handle; promptSession = handle.editor; }}
            value={composerDraft}
            documentKey={() => openThread()?.id ?? ""}
            onChange={(text) => { const before = composerDraft(); if (foldLargePaste(before, text)) return; const removed = draftAttachments().filter((item) => item.kind === "file" && attachmentReferencedIn(before, item) && !attachmentReferencedIn(text, item)); setComposerDraft(text); for (const item of removed) removeAttachment(item.id); const id = openThread()?.id; if (id) { restorePastedContexts(id, text); void importPastedAttachments(id, text); } }}
            onCaret={(offset) => cursor.set(offset)}
            forcedCaret={() => forcedRange()?.start}
            onForcedCaretApplied={() => forcedRange.set(undefined)}
            context={() => promptTokenContext(providerSkills(), folderMentions(openThread()?.id), availableModels(), new Map(draftAttachments().filter((item) => item.kind === "file").map((item) => [attachmentContextId("file", item.id), item.sizeBytes])))}
            placeholder={() => suggestionPlaceholder() === null ? placeholder() : ""}
            editable={editorEditable}
            textStyle={promptTextStyle}
            minHeight={46}
            maxHeight={200}
            onFocus={() => { focused.set(true); typingGuard.onFocus(); const id = openThread()?.id; if (scoped && id) focusSideComposer(id); else if (!scoped && composerOwner() !== null) focusMainComposer(); }}
            onBlur={() => { focused.set(false); typingGuard.onBlur(); }}
            onPasteFiles={(files, uris) => { if (files.length || uris.length) void stageFiles(files, uris); }}
            keys={{
              captureEnter: () => menuTrigger() !== null || enterSubmits(settingValue("sendShortcut"), composerDraft()),
              captureArrows: (_key, caretOnVisualEdge) => menuTrigger() !== null || historyKeys(caretOnVisualEdge),
              captureTab: () => menuTrigger() !== null || offered() !== null,
              captureEscape: () => menuTrigger() !== null || editingEscape() || offered() !== null,
              menuOpen: () => menuTrigger() !== null,
              onKey: (key) => {
                if (key === "Mod-Enter") { if (requiresModifier()) submit(); else dispatchKeystroke("mod+enter"); return; }
                if (menuTrigger()) { menuKey(key === "Enter" ? "enter" : key === "Tab" ? "tab" : key === "Escape" ? "escape" : key === "ArrowUp" ? "up" : "down"); return; }
                if (key === "Tab") { acceptSuggestion(); return; }
                if (key === "Escape") { if (editingEscape()) cancelEdit(); else dismissOffered(); return; }
                if (key === "ArrowUp") { recall("backward"); return; }
                if (key === "ArrowDown") { recall("forward"); return; }
                if (key === "Enter") submit();
              },
            }}
          />
          <SuggestedPrompt text={suggestionPlaceholder} />
        </View>
        </View>
        {promptLengthError() ? <Text role="alert" class="px-4 pb-2 text-xs text-destructive">{promptLengthError()}</Text> : null}
        <LiveTranscription dictation={dictation} />
        <View class="flex-row items-center px-2 pb-0">
          <View class="me-2">
            <AttachmentControl enabled={canAttach} filesAllowed={() => attachmentCapabilities().files} onAddFile={addAttachment} onAddPath={addAttachmentPath} />
          </View>
          <View class="min-w-0 flex-1 flex-row items-center justify-end gap-2">
            <View class="min-w-0 flex-1 flex-row items-center justify-end gap-0.5" onLayout={(event) => controlsHostWidth.set(event.bounds.size.width)}>
              {availableModels().length > 0 ? (
                <View class="min-w-0 shrink flex-row" onLayout={(event) => pickerWidth.set(event.bounds.size.width)}>
                <ModelPicker
                  models={availableModels}
                  selected={selectedModel}
                  open={modelPickerOpen}
                  disabled={isSending}
                  onSelect={setSelectedModel}
                  descriptors={selectedDescriptors}
                  onTraitChange={changeTrait}
                  footer={
                    backendStatus() === "connected" && selectedModel() ? (
                      <PickerFooter
                        leading={<SpeedControls descriptors={selectedDescriptors} onChange={changeTrait} />}
                        disabled={isSending}
                        runtime={runtimeMode}
                        availableRuntime={availableRuntimeModes}
                        interaction={interactionMode}
                        availableInteraction={availableInteractionModes}
                        onRuntime={(mode) => void setRuntimeMode(mode).catch((cause) => attachmentError.set(cause instanceof Error ? cause.message : String(cause)))}
                        onInteraction={(mode) => void setInteractionMode(mode).catch((cause) => attachmentError.set(cause instanceof Error ? cause.message : String(cause)))}
                      />
                    ) : undefined
                  }
                />
                </View>
              ) : backendStatus() === "connecting" ? (
                <Text class="px-2 text-sm text-muted-foreground">Connecting...</Text>
              ) : backendStatus() === "connected" && providersLoaded() ? (
                // ComposerControlsBar showProviderUnavailable: no usable provider; open the first one with setup, else say none.
                <View
                  class={`h-7 flex-row items-center gap-1.5 rounded-md px-2 ${providerSetupTarget() ? "hover:bg-accent" : "opacity-64"}`}
                  disabled={!providerSetupTarget()}
                  onPress={() => { const target = providerSetupTarget(); if (!target) return; requestProviderSelection(target); openSettings("/settings/providers"); }}
                  accessibilityLabel={providerSetupTarget() ? "Open provider settings" : "No provider available"}
                  role="button"
                >
                  <ComposerIcon name="circle-alert" size={16} />
                  <Text class="text-sm font-medium text-foreground">{providerSetupTarget() ? "Open provider settings" : "No provider available"}</Text>
                </View>
              ) : backendStatus() === "connected" ? (
                // ComposerControlsBar providerCatalogPending: the picker stays, disabled, on the thread's own model until the catalog arrives.
                <View class="h-7 flex-row items-center gap-1.5 rounded-md px-2 opacity-64" disabled role="button" testID="Provider catalog pending">
                  <Text class="truncate text-sm font-medium text-foreground">{openThreadModelSelection()?.model ?? selectedModel()?.model ?? ""}</Text>
                </View>
              ) : (
                <View
                  class="h-7 flex-row items-center gap-1.5 rounded-md px-2 hover:bg-accent"
                  onPress={() => openSettings("/settings/connections")}
                  accessibilityLabel="Connect an environment"
                  role="button"
                >
                  <ComposerIcon name="circle-alert" size={16} />
                  <Text class="text-sm font-medium text-foreground">Connect an environment</Text>
                </View>
              )}
              {backendStatus() === "connected" && selectedModel() ? (
                <View class="shrink-0 flex-row" onLayout={(event) => { if (restingCollapse() === "natural") modeNaturalWidth.set(event.bounds.size.width); }}>
                  <ModeControls shownInStrip={stripShowsPermissions} disabled={isSending} runtime={runtimeMode} availableRuntime={availableRuntimeModes} onRuntime={setRuntimeMode} collapse={restingCollapse} />
                </View>
              ) : null}
            </View>
            <ComposerPrimaryActions
              kind={() => questionControls() ? "stop" : kind()}
              label={label}
              tooltip={() => submitTooltip({ status: backendStatus() !== "connected" ? "Environment disconnected" : sendDisabledReason() ?? submitStatus({ environmentUnavailable: backendStatus() !== "connected", voicePreparing: dictation.state().phase === "preparing", preparingWorktree: store.threadRunPreparing(), sending: isSending(), editingQueued: editingQueued() !== null }), alternateShortcut: shortcutLabel("composer.sendAlternate"), running: isRunning(), editingQueued: editingQueued() !== null, canSteer: canSteer(), followUp: followUp(), label: label(), mac: true, compactTokens: compactsBeforeSend() && kind() !== "resume" && kind() !== "update" ? formatContextWindowTokens(resumeCompactionTokens()) : null })}
              disabled={primaryDisabled}
              busy={isSending}
              onInterrupt={stopThread}
              onResume={resume}
              onSubmit={(alternate) => submit(undefined, alternate)}
              compactTokens={() => { const tokens = resumeCompactionTokens(); return tokens === null ? null : formatContextWindowTokens(tokens); }}
              keepFullHistory={keepingHistory}
              onToggleKeepFullHistory={() => { const id = openThread()?.id; if (id) keepFullHistory.update((ids) => ids.includes(id) ? ids.filter((item) => item !== id) : [...ids, id]); }}
              canOperate={() => backendStatus() === "connected" && scopeAllows(ORCHESTRATION_OPERATE_SCOPE)}
            >
              <VoiceInputPill dictation={dictation} cancelShortcutLabel={null} onOpenSettings={() => openSettings("/settings/voice")} onRetry={startDictation} />
              {voiceChoice() === "off" ? null : <ComposerSpeechButton shortcutLabel={shortcutLabel("composer.dictation")} disabled={isSending()} state={{ phase: dictation.state().phase, error: dictation.state().error ?? undefined }} onStart={startDictation} />}
            </ComposerPrimaryActions>
            {questionControls()?.canGoBack ? <View role="button" accessibilityLabel="Previous question" onPress={() => questionControls()?.previous()} class="h-8 justify-center rounded-lg border border-input px-3"><Text class="text-sm text-foreground">Previous</Text></View> : null}
            {questionControls() ? <View role="button" accessibilityLabel={questionControls()?.isLast ? "Submit answers" : "Next question"} disabled={!questionControls()?.canAdvance || questionControls()?.responding} onPress={() => questionControls()?.advance()} class={`h-8 items-center justify-center rounded-full bg-message-action px-4 ${!questionControls()?.canAdvance || questionControls()?.responding ? "opacity-64" : ""}`}><Text class="text-sm font-medium text-message-action-foreground">{questionControls()?.isLast ? "Submit" : "Next"}</Text></View> : null}
          </View>
        </View>
      </View>
      {scoped ? null : <VoiceInputSetup />}
      {!scoped && showPrimaryActionStates() ? <PrimaryActionStates /> : null}
      {scoped || isServerThread(openThread()?.id ?? "") ? null : <WorkspaceControls strategy={workspaceStrategy} onSelectProject={setDraftProject} onSelectWorkspace={setWorkspaceStrategy} />}
      {scoped ? null : <FallbackModelNotice />}
    </View>
  );
}
