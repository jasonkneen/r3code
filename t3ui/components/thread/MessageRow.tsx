import { Clipboard, computed, effect, signal, Text, untracked, View } from "nsh";
import { findRevealsRow } from "./threadFindState";
import { citationSourceTestId } from "./citations/hostSelection";
import { scheduledTaskTitle } from "./scheduledTaskTitle";
import { availableModels, composerDraft, openSettings, openThreadById, setComposerDraft, settingValue, threadById } from "../../store";
import { appendCodexArtifactTemplateUsePrompt } from "./markdown/codexDirectives";
import type { Message } from "../../store";
import { chatWidthClass } from "./layout";
import { Icon } from "../Icons";
import { ChatMarkdown } from "./markdown/ChatMarkdown";
import { userMessageCopyText } from "./markdown/messageCopy";
import { providerSkills } from "../composer/providerCatalog";
import { parseContextRecords, referencedFileAttachments, withAnnotationImages } from "./markdown/contextChips";
import { TimelineIcon } from "./markdown/TimelineIcon";
import { shouldCollapseUserMessage } from "./timeline/userMessage";
import { foldSummaryOf, isSteerIntent, modelSwitchLabel, resolveUserMessagePresentation, type UserMessageGrouping } from "./timeline/userMessagePresentation";
import { SystemDivider } from "./timeline/TimelineRows";
import { modelDisplayName } from "../composer/commandItems";
import type { MessageAttachment } from "./AttachmentPreview";
import { MessageMedia, type AttachmentLoader } from "./MessageMedia";
import { readAttachment } from "./readAttachment";
import { asTimestampFormat, formatChatTimestampTooltip, formatDayAwareTimestamp } from "./timestampFormat";
import { buildPromptLink } from "../palette/promptLinks";
import { MotionLoop } from "../motion/Motion";
import { ANCHORED_COPY_TOAST_TIMEOUT_MS, showAnchoredCopyErrorToast, showAnchoredCopySuccessToast } from "../toast/anchoredToast";
import type { ViewRef } from "nsh";
import { tailwindPulse } from "../motion/motionTokens";
import { resolveAssistantMessageCopyState } from "./assistantCopy";
import { fadeGradientStyle, resolveFadeColor } from "../FadeScroll";

export function MessageRow(props: {
  message: () => Message;
  /** The last assistant reply of its turn (deriveTerminalAssistantMessageIds); only it shows a copy button. Defaults to true. */
  terminalReply?: () => boolean;
  /** The message belongs to the response currently being generated. */
  activeResponse?: () => boolean;
  /** AssistantMessageMeta alwaysVisible: the reply's meta after a tool group of its run shows without hover. */
  metaAlwaysVisible?: () => boolean;
  onOpenAttachment?: (attachment: MessageAttachment) => void;
  onForkResponse?: (messageId: string) => void;
  onReplyToResponse?: (message: Message) => void;
  forkEnabled?: () => boolean;
  forkBusy?: () => boolean;
  /** Edit from here: asks to rewind to before this user message. */
  onRewind?: (messageId: string) => void;
  /** Whether the thread has a restorable checkpoint for this user message. */
  rewindAvailable?: (messageId: string) => boolean;
  /** A rewind is running, or the turn is still working. */
  rewindBusy?: () => boolean;
  loadAttachment?: AttachmentLoader;
  /** Whether this message groups with the reader's own messages around it (tighter spacing and bubble corners). */
  grouping?: () => UserMessageGrouping;
}) {
  const isUser = () => props.message().role === "user";
  const showAssistantMeta = () => !isUser() && (props.terminalReply?.() ?? true) && !props.activeResponse?.();
  // TimelineUserMessageRow: who the message is from, and the variants that follow (a folded agent or automation message,
  // a guest's bubble, "Sent by T3 Code", the Steer marker, the New session and model-switch dividers).
  const presentation = computed(() => resolveUserMessagePresentation(props.message()));
  const attribution = () => (isUser() ? presentation().attribution : null);
  const folded = () => attribution() === "agent" || attribution() === "automation";
  const foldOpen = signal(false);
  const bodyText = () => (isUser() ? presentation().text : props.message().body);
  const contexts = computed(() => withAnnotationImages(parseContextRecords(props.message().context), props.message().attachments ?? []));
  const fileReferences = computed(() => referencedFileAttachments(bodyText(), contexts()));
  const fileCardsOnly = computed(() => isUser() && fileReferences().ids.size > 0 && !fileReferences().remaining.trim() && (props.message().attachments ?? []).every((attachment) => attachment.type === "file"));
  const visibleAttachments = computed(() => fileCardsOnly() ? (props.message().attachments ?? []) : (props.message().attachments ?? []).filter((attachment) => !fileReferences().ids.has(attachment.id)));
  const assistantCopy = () => resolveAssistantMessageCopyState({ text: bodyText() || null, showCopyButton: props.terminalReply?.() ?? true, streaming: props.message().streaming === true });
  const senderThreadId = () => props.message().senderThreadId;
  const foldLabel = () => (attribution() === "automation" ? "Automation" : (senderThreadId() ? threadById(senderThreadId()!)?.title.trim() : "") || "Agent");
  // An automation's fold reads its scheduled task's title, else the prompt's first line.
  const foldSummary = () => (attribution() === "automation" ? scheduledTaskTitle(props.message().scheduledTaskId) : undefined) ?? foldSummaryOf(bodyText());
  const steerMarker = () => (isUser() && isSteerIntent(props.message().inputIntent) && !props.grouping?.().continuesSteer ? props.message().inputIntent : null);
  const switchLabel = () => {
    const change = props.message().modelSwitch;
    return isUser() && change ? modelSwitchLabel(change, (selection) => { const found = availableModels().find((item) => item.provider === selection.instanceId && item.model === selection.model); return found ? modelDisplayName(found.label) : selection.model; }) : null;
  };
  // UserMessageProjectedStatus: a user message that failed or was interrupted says so.
  const userStatus = () => { const status = props.message().status; return isUser() && status && status !== "completed" && status !== "pending" && status !== "waiting" ? status : null; };
  const corners = () => `${props.grouping?.().groupedWithPrevious ? " rounded-tr-md" : ""}${props.grouping?.().groupedWithNext ? " rounded-br-md" : ""}`;
  const expanded = signal(false);
  const canCollapse = computed(() => !folded() && shouldCollapseUserMessage(bodyText()));
  const collapsed = () => canCollapse() && !expanded();
  const copied = signal(false);
  // threadFindHighlights beforematch (TimelineUserMessageRow findRevealRef): the active find match inside a folded or
  // collapsed user message opens it, so the match shows.
  const findRowId = () => `message:${props.message().id}`;
  effect(() => {
    if (!isUser() || !findRevealsRow(findRowId(), bodyText())) return;
    untracked(() => { if (folded()) foldOpen.set(true); else if (canCollapse()) expanded.set(true); });
  });
  // The reference stamps an assistant message with its item's updatedAt, a user message with its creation time.
  const stampAt = () => (isUser() ? props.message().order : props.message().updatedAt ?? props.message().order) ?? 0;
  const stamp = () => formatDayAwareTimestamp(stampAt(), asTimestampFormat(settingValue("timestampFormat")));
  const stampTooltip = () => formatChatTimestampTooltip(stampAt(), asTimestampFormat(settingValue("timestampFormat")));
  // A turn item that is not completed (running, failed, interrupted ...) wears its status as a chip.
  const statusChip = () => { const status = props.message().status; return !isUser() && status && status !== "completed" ? status : null; };
  let copyTimer: ReturnType<typeof setTimeout> | undefined;
  // MessageCopyButton: the anchored "Copied!" / "Failed to copy" toast under the button (ui/anchoredCopyToast.ts).
  let copyButton: ViewRef | null = null;
  // TimelineUserMessageRow: a user message with a promptable body also offers a link that opens it as a new thread.
  const linkCopied = signal(false);
  const promptLink = () => buildPromptLink(bodyText() ?? "");
  let linkTimer: ReturnType<typeof setTimeout> | undefined;
  // `group`/`group-hover:` on a plain View does not reveal a descendant here (confirmed by a
  // headless test: the actions row showed before any hover at all - this runtime's "group"
  // combinator is wired up only for nsh's own built-in widgets, such as ScrollBar/SplitView
  // handles, not for an app View). SidebarThreadRow.tsx works around the same gap with its own
  // `hovered` signal from onMouseEnter/onMouseLeave; this row does the same.
  const rowHovered = signal(false);
  const actionsFocused = signal(false);
  const rowWidth = signal(0);
  const bubbleWidth = signal(0);
  // T3 floats actions beside grouped user bubbles once the lane is 37rem wide.
  // Below that width they stay below the bubble, where there is room for them.
  const floatActions = () => isUser() && props.grouping?.().groupedWithNext === true && rowWidth() >= 592;
  const actionsVisible = () => rowHovered() || actionsFocused() || (!isUser() && props.metaAlwaysVisible?.() === true);
  return (
    <View class={`mx-auto w-full ${props.grouping?.().groupedWithNext ? "pb-1" : !isUser() && !showAssistantMeta() ? "pb-2" : "pb-4"} ${chatWidthClass()}`}>
      {isUser() && props.message().freshContext ? <SystemDivider label="New session" icon="eraser" /> : null}
      {switchLabel() ? <SystemDivider label={switchLabel()!} /> : null}
      <View
        class={isUser() ? "relative w-full items-end" : "items-start"}
        onLayout={(event) => { const width = event.bounds.size.width; if (width !== untracked(rowWidth)) rowWidth.set(width); }}
        onMouseEnter={() => rowHovered.set(true)}
        onMouseLeave={() => rowHovered.set(false)}
      >
        {attribution() === "t3code" ? <Text class="mb-1 me-1 text-2xs text-muted-foreground-70" accessibilityLabel="Sent by R3 Code">Sent by R3 Code</Text> : null}
        {attribution() === "guest" ? <Text class="mb-1 me-1 text-2xs text-guest-foreground" accessibilityLabel={`${presentation().guestName ?? ""} (guest)`}>{presentation().guestName ?? ""}</Text> : null}
        {steerMarker() ? (
          <View class="mb-1 me-1 flex-row items-center justify-end gap-1" accessibilityLabel="Steer" tooltip={steerMarker() === "promoted_queued_to_steer" ? "Originally queued, then promoted to steer the active turn" : "Steered the active turn"}>
            <TimelineIcon name="redo-2" size={12} />
            <Text class="text-xs text-muted-foreground">Steer</Text>
          </View>
        ) : null}
        {visibleAttachments().length ? (
          <View class={bodyText() ? "mb-1 max-w-[80%] items-end" : "max-w-[80%] items-end"}>
            <MessageMedia attachments={visibleAttachments} sending={() => props.message().pending === true} load={props.loadAttachment ?? readAttachment} onOpen={(attachment) => props.onOpenAttachment?.(attachment)} />
          </View>
        ) : null}
        {isUser() && (!bodyText() || fileCardsOnly()) ? null : <View
          selectable
          onLayout={isUser() ? (event) => { const width = event.bounds.size.width; if (width !== untracked(bubbleWidth)) bubbleWidth.set(width); } : undefined}
          testID={isUser() ? undefined : citationSourceTestId(props.message().id)}
          class={
            isUser()
              ? `${folded() && foldOpen() ? "w-full" : "max-w-[80%]"} rounded-2xl ${attribution() === "guest" ? "bg-guest-surface" : "bg-message-surface"}${folded() ? "" : " p-3"}${corners()}`
              : "w-full"
          }
        >
          {folded() ? (
            <View
              class="w-full flex-row items-center gap-1.5 rounded-2xl px-3 py-2"
              onPress={() => foldOpen.update((value) => !value)}
              accessibilityLabel={`${foldLabel()}: ${foldSummary()}`}
              accessibilityState={{ expanded: foldOpen() }}
              role="button"
            >
              <TimelineIcon name={attribution() === "automation" ? "calendar-clock" : "messages-square"} size={16} />
              <Text class="max-w-[50%] shrink-0 truncate text-sm text-muted-foreground">{foldLabel()}</Text>
              <Text class="min-w-0 flex-1 truncate text-sm text-message-foreground">{foldSummary()}</Text>
              <TimelineIcon name={foldOpen() ? "chevron-up" : "chevron-down"} size={14} />
            </View>
          ) : null}
          {(bodyText() || (!isUser() && !props.message().streaming && !props.message().attachments?.length)) && (!folded() || foldOpen()) ? (
            isUser() ? (
              <View class={folded() ? "max-h-96 px-3 pb-3" : collapsed() ? "relative max-h-44 overflow-hidden" : ""}>
                <ChatMarkdown text={bodyText} findRowId={findRowId} contexts={contexts} onOpenAttachment={(attachment) => props.onOpenAttachment?.(attachment as never)} skills={() => providerSkills()} modelMentions class="text-message-foreground" />
                {collapsed() ? <View class="absolute inset-x-0 bottom-0 h-9" style={{ ...fadeGradientStyle("bottom", resolveFadeColor(attribution() === "guest" ? "guest-surface" : "message-surface")), pointerEvents: "none" }} /> : null}
              </View>
            ) : (
              <ChatMarkdown text={() => props.message().body || (props.message().streaming ? "" : "(empty response)")} findRowId={findRowId} streaming={() => props.message().streaming === true} skills={() => providerSkills()} modelMentions class="px-1 py-0.5 text-foreground" onUseArtifactTemplate={(template) => setComposerDraft(appendCodexArtifactTemplateUsePrompt(composerDraft(), template))} />
            )
          ) : null}
          {isUser() && canCollapse() ? (
            <View
              class="mt-1.5 self-end rounded-md px-1 py-0.5 hover:bg-accent"
              onPress={() => expanded.update((value) => !value)}
              accessibilityLabel={expanded() ? "Show less" : "Show full message"}
              accessibilityState={{ expanded: expanded() }}
              role="button"
            >
              <Text class="text-xs text-muted-foreground">{expanded() ? "Show less" : "Show full message"}</Text>
            </View>
          ) : null}
        </View>}
        {isUser() && userStatus() ? <View class="mt-1 me-1 flex-row items-center gap-1.5" accessibilityLabel="Message status"><View class="rounded-full border border-destructive px-1.5 py-0.5"><Text class="text-[10px] font-medium text-destructive">{userStatus()}</Text></View></View> : null}
        {(attribution() === "automation" && !foldOpen()) || (!isUser() && !showAssistantMeta()) ? null : <View style={floatActions() ? { position: "absolute", right: bubbleWidth() + 8, top: 8 } : undefined} class={`${isUser() ? "mt-1 flex-row items-center justify-end gap-2 pe-1" : "mt-0.5 flex-row items-center gap-1 px-1"} transition-opacity duration-200 ease-in-out ${actionsVisible() ? "opacity-100" : "opacity-0"}`}>
          {attribution() === "agent" && senderThreadId() ? (
            <View class="rounded-sm" onPress={() => openThreadById(senderThreadId()!)} accessibilityLabel="Open thread" role="button"><Text class="text-xs text-muted-foreground hover:underline">Open thread</Text></View>
          ) : null}
          {attribution() === "automation" && presentation().scheduledTaskId ? (
            <View class="rounded-sm" onPress={() => openSettings("/settings/scheduled-tasks")} accessibilityLabel="Open automation" role="button"><Text class="text-xs text-muted-foreground hover:underline">Open automation</Text></View>
          ) : null}
          {isUser() && stamp() ? <Text class="text-xs tabular-nums text-muted-foreground" tooltip={stampTooltip()}>{stamp()}</Text> : null}
          {statusChip() ? <View class="rounded-full border border-border-60 px-1.5 py-0.5" accessibilityLabel="Message status"><Text class="font-mono text-[10px] text-muted-foreground">{statusChip()}</Text></View> : null}
          <View class="flex-row items-center gap-0.5">
            {!isUser() && !props.message().streaming && props.message().itemId && bodyText().trim() && props.onReplyToResponse ? <View
              class="h-6 w-7 items-center justify-center rounded-md focus:opacity-100 hover:bg-accent"
              onPress={() => props.onReplyToResponse?.(props.message())}
              onFocus={() => actionsFocused.set(true)}
              onBlur={() => actionsFocused.set(false)}
              accessibilityLabel="Reply to this response"
              tooltip="Reply to this response"
              role="button"
            >
              <TimelineIcon name="message-circle" size={13} />
            </View> : null}
            {isUser() && props.onRewind && props.rewindAvailable?.(props.message().id) ? <View
              class="h-6 w-7 items-center justify-center rounded-md hover:bg-accent"
              disabled={props.rewindBusy?.()}
              onPress={() => props.onRewind?.(props.message().id)}
              onFocus={() => actionsFocused.set(true)}
              onBlur={() => actionsFocused.set(false)}
              accessibilityLabel="Edit from here"
              tooltip="Edit from here"
              role="button"
            >
              <TimelineIcon name="pencil" size={12} />
            </View> : null}
            {(isUser() ? bodyText() : assistantCopy().visible) ? <View
              class="h-6 w-7 items-center justify-center rounded-md focus:opacity-100 hover:bg-accent"
              ref={(node: ViewRef | null) => { copyButton = node; }}
              onPress={() => {
                const anchor = copyButton;
                let written: Promise<unknown>;
                try { written = Promise.resolve(Clipboard.writeText(isUser() ? userMessageCopyText(bodyText(), Object.fromEntries(Object.values(parseContextRecords(props.message().context)).map((record) => [record.contextId, record.label]))) : assistantCopy().text ?? bodyText())); } catch (error) { written = Promise.reject(error); }
                void written.then(() => {
                  copied.set(true);
                  clearTimeout(copyTimer);
                  copyTimer = setTimeout(() => copied.set(false), ANCHORED_COPY_TOAST_TIMEOUT_MS);
                  if (anchor) void showAnchoredCopySuccessToast(anchor);
                }, (error: unknown) => {
                  if (anchor) void showAnchoredCopyErrorToast(anchor, error instanceof Error ? error : new Error(String(error)));
                });
              }}
              onFocus={() => actionsFocused.set(true)}
              onBlur={() => actionsFocused.set(false)}
              accessibilityLabel={isUser() ? "Copy user message" : "Copy assistant message"}
              tooltip="Copy message"
              role="button"
            >
              <TimelineIcon name={copied() ? "check" : "copy"} size={12} />
            </View> : null}
            {isUser() && promptLink() !== null ? <View
              class="h-6 w-7 items-center justify-center rounded-md hover:bg-accent"
              onPress={() => {
                void Clipboard.writeText(promptLink()!);
                linkCopied.set(true);
                clearTimeout(linkTimer);
                linkTimer = setTimeout(() => linkCopied.set(false), 1500);
              }}
              onFocus={() => actionsFocused.set(true)}
              onBlur={() => actionsFocused.set(false)}
              accessibilityLabel="Copy prompt link"
              tooltip="Copy prompt link"
              role="button"
            >
              <TimelineIcon name={linkCopied() ? "check" : "link"} size={12} />
            </View> : null}
            {!isUser() && !props.message().streaming && props.onForkResponse ? <View
              class="size-7 items-center justify-center rounded-md hover:bg-accent active:scale-[0.97] transition-transform duration-150 ease-in-out"
              disabled={!props.forkEnabled?.() || props.forkBusy?.()}
              onPress={() => props.onForkResponse?.(props.message().id)}
              onFocus={() => actionsFocused.set(true)}
              onBlur={() => actionsFocused.set(false)}
              accessibilityLabel="Fork from this response"
              tooltip={props.forkBusy?.() ? "Forking response..." : props.forkEnabled?.() ? "Fork from this response" : "Connect the environment to fork this response"}
              role="button"
            >
              {props.forkBusy?.() ? <MotionLoop spec={tailwindPulse}><Icon name="git-branch" size={13} /></MotionLoop> : <Icon name="git-branch" size={13} />}
            </View> : null}
          </View>
          {!isUser() && !props.message().streaming && stamp() ? <Text class="text-xs tabular-nums text-muted-foreground" tooltip={stampTooltip()}>{stamp()}</Text> : null}
        </View>}
      </View>
    </View>
  );
}
