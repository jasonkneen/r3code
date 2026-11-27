// One thread row, from sidebar/SidebarThreadRow.tsx. Three variants as the web has them:
//   folder  one line inside a project folder: h-9, gap-2.5, ps-9, status or time on the right
//   card    pinned and loose rows: project line, then the title, then the branch
//   slim    the Snoozed and Settled shelves: project tile, title, time
import { MiddleTruncate } from "./MiddleTruncate";
import { Icon } from "./Icons";
import { colorScheme, effect, openUrl, signal, Text, token, untracked, View } from "nsh";
import { textDirection } from "../textDirection";
import { revealActiveRow } from "./sidebar/routeReveal";
import type { PressEvent, ViewRef } from "nsh";
import { ContextMenu, Input, Menu, MenuItem, MenuSeparator } from "nsh/base";
import { allProjects, allThreads, backendStatus, renameThread, setThreadPinned, settingValue, threadHasUnsentDraft } from "../store";
import type { Thread } from "../store";
import { threadRowSurface } from "./sidebar/rowSurface";
import { panelKeyFor, updatePanel } from "./rightPanel/panelState";
import { openPullRequestsSurface } from "./rightPanel/panelLogic";
import { changeRequestWords, stackBadgePresentation } from "./sidebar/threadPullRequestStack";
import { listRowEnterStyle, MotionLoop } from "./motion/Motion";
import { sidebarRowTravel, statusPulse } from "./motion/motionTokens";
import { trackOpenChange, useOverlayOpen } from "./rightPanel/nativeOcclusion";
import { requestCustomSnooze } from "./sidebar/CustomSnoozeDialog";
import { configLoaded } from "./sidebar/serverFacts";
import { Glyph } from "./sidebar/SidebarGlyph";
import type { GlyphName } from "./sidebar/SidebarGlyph";
import { ProjectTile } from "./sidebar/ProjectTile";
import { minuteNow, relativeTimeNow, secondNow } from "./sidebar/clock";
import { SidebarProviderStack } from "./sidebar/ProviderStack";
import { mixColors } from "./sidebar/mix";
import { resolveSnoozePresets, snoozePresetsFromSetting } from "./sidebar/snooze";
import {
  acknowledgeThreadWoke,
  buildBulkMenu,
  buildThreadMenu,
  bulkMenuState,
  runBulkAction,
  runThreadAction,
  createThreadOnBranch,
  threadActionNotice,
  threadMenuState,
  threadUndo,
  unpinThreadWithUndo,
  unsettleThread,
  unsnoozeThread,
} from "./sidebar/threadActions";
import type { PullRequestBadgeState } from "./sidebar/threadMeta";
import { sharedPullRequestSummary, useLinkedPullRequestSummary } from "./pullRequest/pullRequestState";
import { pullRequestsSupported } from "./pullRequest/pullRequestsSupported";
import { issueStatePresentation } from "./issue/issueLogic";
import { issuesSupported, resolveIssueEnvironmentId, sidebarLinkedIssueState } from "./issue/issueStore";
import { PRIcon } from "./pullRequest/PRIcon";
import { toneColor } from "./pullRequest/pullRequestPresentation";
import { requestBackend, subscribeBackend } from "../store";
import { THREAD_LIST_TOOLTIP_DELAY_MS, Tip } from "./sidebar/Tip";
import { runningTerminalIds, terminalLabel } from "./sidebar/terminalStatus";
import type { ThreadMenuId } from "./sidebar/threadActions";
import { settleAndAdvance } from "./sidebar/settleAndAdvance";
import { threadJumpLabel } from "./sidebar/jumpHints";
import { MENU_POPUP_CLASS, ThreadMenuItems } from "./sidebar/ThreadMenu";
import { MENU_ITEM_ROW_CLASS } from "./menuStyles";
import { canSnooze, isWoke, threadActivityAt, threadSettledAt, resolveSection, resolveTopStatus, shouldRecede, snoozeWakeLabel, statusDurationLabel, threadWokeAt } from "./sidebar/threadStatus";
import type { TopStatusIcon } from "./sidebar/threadStatus";
import { projectScopeIds, toggleProjectScope } from "./sidebar/projectScope";
import { releaseFocusRing, threadRowId, treeRowProps } from "./sidebar/sidebarTree";
import { FocusRing } from "./sidebar/FocusRing";
import { dropFilesOnThread } from "./sidebar/pendingFileDrop";
import { DragGap, DropVerbBadge, dragGapBefore, dragVerb, isDraggingThread, registerDragRow, threadDragHandlers } from "./sidebar/sidebarDrag";
import { reorderWithinSection } from "./sidebar/reorderActions";
import { orderedThreadIds } from "./sidebar/sidebarModel";
import { clearThreadSelection, hasThreadSelection, isThreadSelected, rangeSelectTo, selectedThreadIds, setSelectionAnchor, toggleThreadSelection } from "./sidebar/threadSelection";
import { ThreadHoverCard } from "./sidebar/ThreadHoverCard";
import { useCheckoutBranch } from "./sidebar/vcsBranch";
import { runDropVerb } from "./sidebar/dropActions";
import type { DragSection, DropVerb } from "./sidebar/sidebarDrop";
import { sidebarRelativeTime } from "./SidebarUtils";
import { managedEnvironment } from "../environments/connectionManager";
import { machineKindForUrl } from "./thread/environmentOptions";
import { drawerStateFor, unsuppressDrawerTerminal, updateDrawer } from "./terminal/drawerState";
import { panelStateFor } from "./rightPanel/panelState";
import { revealTerminal } from "./terminal/revealTerminal";


const STATUS_GLYPH: Record<TopStatusIcon, GlyphName> = {
  working: "circle-dashed",
  waiting: "circle-dot-dashed",
  input: "message-circle-question",
  request: "user-round",
  approval: "shield-question",
  failed: "circle-alert",
  done: "circle-check",
  woke: "alarm-clock",
};

/** The Tailwind text class of a status maps to the token its glyph is tinted with. */
function statusTint(icon: TopStatusIcon, scheme: "light" | "dark"): string {
  switch (icon) {
    case "working": return token("info-foreground");
    case "waiting": return token("muted-foreground");
    case "approval": return token("warning-foreground");
    case "input": return scheme === "dark" ? "#a5b4fc" : "#4f46e5";
    case "request": return token("guest-foreground");
    case "failed": return token("error-foreground");
    case "done": return token("success-foreground");
    case "woke": return token("warning-foreground");
  }
}

const PR_LOOK: Record<PullRequestBadgeState, { label: string; glyph: GlyphName; tint: (scheme: "light" | "dark") => string }> = {
  open: { label: "open", glyph: "git-pull-request", tint: () => token("success-foreground") },
  draft: { label: "draft", glyph: "git-pull-request-draft", tint: () => token("muted-foreground") },
  merged: { label: "merged", glyph: "git-merge", tint: (scheme) => (scheme === "dark" ? "#c084fc" : "#9333ea") },
  closed: { label: "closed", glyph: "git-pull-request-closed", tint: () => token("error-foreground") },
};

const MENU_ITEM_CLASS = MENU_ITEM_ROW_CLASS;

/** formatWorktreePathForDisplay: the last segment of the worktree path. */
export function worktreeDisplayName(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) return path;
  const last = trimmed.replace(/\\/g, "/").replace(/\/+$/, "").split("/").pop()?.trim() ?? "";
  return last.length > 0 ? last : trimmed;
}

/**
 * One of the row's small icon buttons: text-muted-foreground, text-foreground on hover, no surface.
 * The label (Settle) sits beside the icon on the card variant.
 */
function RowButton(props: {
  label: string;
  glyph: GlyphName;
  size: number;
  text?: string;
  tip?: string;
  class: string;
  onPress: () => void;
  onFocus: () => void;
  onBlur: () => void;
}) {
  const hovered = signal(false);
  const tint = () => (hovered() ? token("foreground") : token("muted-foreground"));
  return (
    <View
      accessibilityLabel={props.label}
      role="button"
      tooltip={props.tip ? <Tip delay={THREAD_LIST_TOOLTIP_DELAY_MS} label={props.tip} /> : undefined}
      onMouseEnter={() => hovered.set(true)}
      onMouseLeave={() => hovered.set(false)}
      onFocus={props.onFocus}
      onBlur={props.onBlur}
      onPress={props.onPress}
      class={`flex-row items-center justify-center gap-1 rounded-md ${props.class}`}
    >
      <Glyph name={props.glyph} size={props.size} tint={tint()} />
      {props.text ? <Text class="text-xs" style={{ color: tint() }}>{props.text}</Text> : null}
    </View>
  );
}

const pressed = new Map<string, Thread>();

export type ThreadRowVariant = "folder" | "card" | "slim";

export function SidebarThreadRow(props: {
  thread: Thread;
  variant: ThreadRowVariant;
  active: boolean;
  projectName?: string;
  projectPath?: string;
  /** boringSidebarMultilineRows: a folder row adds the card's branch and pull request line under the title. */
  multiline?: boolean;
  /** Digit shown while the jump modifier is held. */
  jumpLabel?: string | null;
  onPress: () => void;
  /** Whether the row drags; by default while connected. */
  dragEnabled?: () => boolean;
  /** What a drop does; by default the thread menu's own actions. */
  onDrop?: (verb: DropVerb, to: DragSection) => void;
}) {
  const hovered = signal(false);
  const fileOver = signal(false);
  const focused = signal(false);
  const menuOpen = signal(false);
  const contextOpen = signal(false);
  useOverlayOpen(() => menuOpen() || contextOpen(), "thread row menu");
  const editing = signal(false);
  const titleDraft = signal("");
  let blurTimer: ReturnType<typeof setTimeout> | undefined;
  const focusIn = () => {
    clearTimeout(blurTimer);
    focused.set(true);
  };
  const focusOut = () => {
    clearTimeout(blurTimer);
    blurTimer = setTimeout(() => focused.set(false), 200);
  };

  const thread = () => props.thread;
  // useLinkedThreadPullRequest: a legacy linked (no server config yet) or branch pull request reads its state from the
  // linked summary (pullRequests.summary), shared with every other answer about it.
  const fallbackLink = () => {
    const fallback = thread().meta?.pullRequest?.fallback;
    return fallback && (fallback.kind === "branch" || !pullRequestsSupported()) ? fallback : null;
  };
  let fallbackHost: string | undefined;
  useLinkedPullRequestSummary({
    environmentId: () => "primary",
    reference: () => {
      const link = fallbackLink();
      if (!link) return null;
      try { fallbackHost = new URL(link.url).host || undefined; } catch { fallbackHost = undefined; }
      return { projectId: link.projectId, repository: link.repository, number: link.number, ...(fallbackHost ? { host: fallbackHost } : {}) };
    },
    connected: () => backendStatus() === "connected",
    request: requestBackend,
    subscribe: subscribeBackend,
  });
  const fallbackState = (): PullRequestBadgeState | null => {
    const link = fallbackLink();
    const summary = link ? sharedPullRequestSummary("primary", link) : null;
    if (!summary) return null;
    return summary.state === "merged" ? "merged" : summary.state === "closed" ? "closed" : summary.isDraft === true ? "draft" : "open";
  };
  const tree = treeRowProps(threadRowId(props.thread.id));
  let rowNode: ViewRef | null = null;
  // Settle, snooze and pin wait for the server config (`settlement: configLoaded`), as the web gates them.
  const connected = () => backendStatus() === "connected" && configLoaded();
  const section = () => resolveSection(thread(), minuteNow(), configLoaded());
  const drag = threadDragHandlers({
    id: () => thread().id,
    title: () => thread().title,
    from: section,
    enabled: () => (props.dragEnabled ? props.dragEnabled() : connected()),
    onDrop: (verb, to) => (props.onDrop ?? ((v: DropVerb) => { void runDropVerb(thread(), v); }))(verb, to),
    // Only the card rows (pinned and loose) arrange themselves; folder and shelf rows just move between sections.
    onReorder: props.variant === "card" ? (to, index) => { void reorderWithinSection(thread(), to, index); } : undefined,
    row: () => rowNode,
  });
  const selected = () => isThreadSelected(thread().id);
  const top = () => resolveTopStatus(thread(), minuteNow());
  const receded = () => shouldRecede({ thread: thread(), active: props.active, selected: selected(), now: minuteNow() });
  const revealed = () => hovered() || focused() || menuOpen();
  const faded = () => (!props.active || section() === "settled") && !revealed();
  const unread = () => top()?.icon === "done";
  const woke = () => isWoke(thread(), minuteNow());

  const startRename = () => {
    titleDraft.set(thread().title);
    editing.set(true);
  };
  const commitRename = () => {
    if (!editing()) return;
    const title = titleDraft().trim();
    editing.set(false);
    if (title.length > 0 && title !== thread().title) renameThread(thread().id, title);
  };

  const ownProject = () => allProjects().find((project) => project.id === thread().projectId);
  const presets = () => resolveSnoozePresets(new Date(), snoozePresetsFromSetting(settingValue("snoozePresets")));
  const menuItems = () =>
    buildThreadMenu(threadMenuState({
      thread: thread(),
      now: Date.now(),
      connected: connected(),
      hasProject: Boolean(thread().projectId),
      presets: presets(),
      project: ownProject(),
      scopeIds: projectScopeIds(),
    }));
  const onMenuSelect = (id: ThreadMenuId) => {
    void runThreadAction(id, {
      thread: thread(),
      startRename,
      requestCustomSnooze,
      presets: presets(),
      projectPath: props.projectPath,
      toggleProjectFilter: () => { if (thread().projectId) toggleProjectScope(thread().projectId); },
      newThreadOnBranch: (branch, worktreePath) => createThreadOnBranch(thread().projectId || null, branch, worktreePath),
    });
  };

  // A right-click on a row inside a multi-row selection acts on the whole selection.
  const bulk = () => selected() && selectedThreadIds().length > 0;
  // The store's live copy wins; a row selected by a press keeps its own as the fallback.
  const bulkThreads = () => selectedThreadIds().flatMap((id) => {
    const found = allThreads().find((item) => item.id === id) ?? pressed.get(id);
    return found ? [found] : [];
  });
  const bulkItems = () => buildBulkMenu(bulkMenuState(bulkThreads(), presets(), connected()));
  const onBulkSelect = (id: ThreadMenuId) => {
    void runBulkAction(id, bulkThreads(), { presets: presets(), requestCustomSnooze });
  };

  const handlePress = (event?: PressEvent) => {
    releaseFocusRing();
    if (editing()) return;
    const modifiers = event?.modifiers;
    if (modifiers?.platform || modifiers?.control) {
      pressed.set(thread().id, thread());
      toggleThreadSelection(thread().id);
      return;
    }
    if (modifiers?.shift) {
      rangeSelectTo(thread().id, orderedThreadIds());
      return;
    }
    if (hasThreadSelection()) clearThreadSelection();
    setSelectionAnchor(thread().id);
    props.onPress();
  };

  const inFolder = () => props.variant === "folder";
  const isCard = () => props.variant === "card";
  const rowFailure = (title: string) => (error: unknown) =>
    threadActionNotice.failure(title, error);
  // variantAction: Settle on active and pinned rows, Un-settle on the Settled shelf, Wake on Snoozed.
  const rowAction = () => {
    if (section() === "settled") {
      return { label: "Un-settle thread", glyph: "undo-2" as GlyphName, size: 14, text: undefined, run: () => unsettleThread(thread().id).catch(rowFailure("Failed to un-settle thread")) };
    }
    if (section() === "snoozed") {
      return { label: "Wake thread now", glyph: "alarm-clock-off" as GlyphName, size: 12, text: undefined, run: () => unsnoozeThread(thread().id).catch(rowFailure("Failed to wake thread")) };
    }
    return {
      label: "Settle thread",
      glyph: "check" as GlyphName,
      size: isCard() ? 14 : 12,
      text: isCard() ? "Settle" : undefined,
      run: () => settleAndAdvance(thread().id).then((settled) => { if (settled) threadUndo.show("Settled", () => unsettleThread(thread().id), thread().id); }).catch(rowFailure("Failed to settle thread")),
    };
  };

  // Slim rows (the shelves) dim to secondary-label unless they matter; folder and card rows use foreground.
  const titleColor = () => {
    colorScheme();
    const slim = props.variant === "slim";
    if (slim) {
      if (receded() && !revealed()) return token("secondary-label");
      if (revealed() || props.active || woke() || top()?.icon === "input" || top()?.icon === "request") return token("foreground");
      if (unread()) return token("muted-foreground");
      return mixColors(token("secondary-label"), token("sidebar"), 0.7);
    }
    if (receded() && !revealed()) return mixColors(token("foreground"), token("sidebar"), 0.75);
    if (top()?.icon === "failed" && !unread() && !woke()) return mixColors(token("foreground"), token("sidebar"), 0.95);
    return token("foreground");
  };

  const accessibleLabel = () => [thread().title, top()?.label ?? null, props.projectName ?? null].filter(Boolean).join(", ");

  const dismissWoke = () => {
    const at = threadWokeAt(thread(), Date.now());
    if (at !== null) void acknowledgeThreadWoke(thread().id, at).catch(rowFailure("Failed to dismiss Woke"));
  };
  const wokeButton = (size: number) => (
    <View
      accessibilityLabel="Dismiss Woke notification"
      role="button"
      tooltip={<Tip delay={THREAD_LIST_TOOLTIP_DELAY_MS} label="Dismiss Woke notification" />}
      onFocus={focusIn}
      onBlur={focusOut}
      onPress={dismissWoke}
      class="flex-row items-center gap-1 rounded-sm"
    >
      <Glyph name="alarm-clock" size={size} tint={token("warning-foreground")} />
      <Text class="text-xs font-medium text-warning-foreground">Woke</Text>
    </View>
  );

  const duration = () => statusDurationLabel(thread(), secondNow());

  const trail = () => {
    colorScheme();
    const current = thread();
    // JumpHintBadge: while the jump modifiers are held the slot shows the row's shortcut instead.
    const jump = threadJumpLabel(current.id);
    if (jump) return <View class="h-5 min-w-5 items-center justify-center rounded bg-command-footer-kbd px-1" accessibilityElementsHidden><Text class="text-xs font-medium text-muted-foreground">{jump}</Text></View>;
    if (section() === "snoozed" && current.meta?.snoozedUntil != null) {
      return (
        <View class="flex-row items-center gap-1">
          <Glyph name="alarm-clock" size={12} tint={token("info-foreground")} />
          <Text class="text-xs text-info-foreground">{snoozeWakeLabel(current.meta.snoozedUntil, minuteNow())}</Text>
        </View>
      );
    }
    const status = top();
    // Folder and card rows put the status in the time slot; a shelf row only ever shows Woke.
    const wokeShown = isCard() || inFolder() ? status?.icon === "woke" : woke();
    if (wokeShown) return wokeButton(isCard() ? 16 : 12);
    if (status && (inFolder() || isCard())) {
      const elapsed = status.icon === "working" || status.icon === "waiting" ? duration() : null;
      return (
        <View class="flex-row items-center gap-1">
          <Glyph name={STATUS_GLYPH[status.icon]} size={isCard() ? 16 : 12} tint={statusTint(status.icon, colorScheme())} />
          <Text class={`text-xs font-medium ${status.className}`}>{status.label}</Text>
          {elapsed ? <Text class={`text-xs font-medium ${status.className}`}>{elapsed}</Text> : null}
        </View>
      );
    }
    return <Text class="text-xs text-secondary-label">{sidebarRelativeTime(timeLabelAt(), timeLabelNow())}</Text>;
  };

  // useRelativeTimeState: the row's time label re-renders exactly when its text changes.
  const timeLabelAt = () => (section() === "settled" ? threadSettledAt(thread()) : threadActivityAt(thread()));
  const timeLabelNow = relativeTimeNow(timeLabelAt);

  const snoozeButton = () => (
    <Menu
      popupClass={MENU_POPUP_CLASS}
      onOpenChange={trackOpenChange(menuOpen)}
      trigger={
        <View
          accessibilityLabel="Snooze thread"
          role="button"
          tooltip={<Tip delay={THREAD_LIST_TOOLTIP_DELAY_MS} label="Snooze thread" />}
          onFocus={focusIn}
          onBlur={focusOut}
          class="h-full items-center justify-center rounded-md px-1.5"
        >
          <Glyph name="clock" size={12} tint={token("muted-foreground")} />
        </View>
      }
    >
      {presets().map((preset) => (
        <MenuItem
          accessibilityLabel={preset.label}
          class={MENU_ITEM_CLASS}
          onSelect={() => onMenuSelect(`snooze:${preset.id}` as ThreadMenuId)}
        >
          <Text class="flex-1 text-sm text-popover-foreground">{preset.label}</Text>
          <Text class="ml-auto text-xs text-muted-foreground">{preset.whenLabel}</Text>
        </MenuItem>
      ))}
      {presets().length > 0 ? <MenuSeparator class="my-1 h-px bg-border" /> : null}
      <MenuItem accessibilityLabel="Custom…" class={MENU_ITEM_CLASS} onSelect={() => onMenuSelect("snooze:custom")}>
        <Text class="flex-1 text-sm text-popover-foreground">Custom…</Text>
      </MenuItem>
    </Menu>
  );

  // The hover controls. The web has no ellipsis button: a shelf or folder row gets its one sweep action
  // (Settle, Un-settle or Wake), the card gets Snooze and Settle with its label; the thread menu is the
  // right-click menu.
  const actions = () => {
    const action = rowAction();
    return (
      <View class="flex-row items-center self-stretch">
        {isCard() && connected() && section() !== "snoozed" && section() !== "settled" && canSnooze(thread(), secondNow()) ? snoozeButton() : null}
        {connected() ? (
          <RowButton
            label={action.label}
            glyph={action.glyph}
            size={action.size}
            text={action.text}
            tip={action.label}
            class={isCard() ? "-mr-1 px-1.5" : action.glyph === "check" ? "px-2" : "-mr-1 px-1.5"}
            onFocus={focusIn}
            onBlur={focusOut}
            onPress={() => { void action.run(); }}
          />
        ) : null}
      </View>
    );
  };

  const title = () => editing() ? (
    <Input
      autoFocus
      accessibilityLabel="Thread name"
      value={titleDraft()}
      onChange={(event) => titleDraft.set(event.value)}
      onSubmit={commitRename}
      onBlur={commitRename}
      onKeyPress={(event) => { if (event.key === "Escape") editing.set(false); }}
      class="h-7 min-w-0 flex-1 rounded-sm border border-input bg-card px-1 text-sm font-medium text-card-foreground"
    />
  ) : (
    thread().meta?.titleRegenerating ? (
      <MotionLoop spec={statusPulse} class="min-w-0 flex-1 flex-row items-center overflow-hidden">
        <Text
          class={`min-w-0 flex-1 truncate text-sm ${receded() ? "font-normal" : "font-medium"} opacity-55`}
          style={{ color: titleColor(), writingDirection: textDirection(thread().title) ?? "auto" }}
        >
          {thread().title}
        </Text>
      </MotionLoop>
    ) : (
      <Text
        class={`min-w-0 flex-1 truncate text-sm ${receded() ? "font-normal" : "font-medium"}`}
        style={{ color: titleColor(), writingDirection: textDirection(thread().title) ?? "auto" }}
      >
        {thread().title}
      </Text>
    )
  );

  // Pinned rows carry a small pin; while the server can write it, it is the Unpin button and swaps to
  // the crossed pin on hover.
  const pinHovered = signal(false);
  const pinMark = () => {
    if (!thread().pinned || isDraggingThread(thread().id)) return null;
    const idle = mixColors(token("muted-foreground"), token("sidebar"), 0.65);
    if (!connected()) return <Glyph name="pin" size={12} tint={idle} />;
    return (
      <View
        accessibilityLabel="Unpin thread"
        role="button"
        tooltip={<Tip delay={THREAD_LIST_TOOLTIP_DELAY_MS} label="Unpin thread" />}
        class="items-center justify-center rounded-sm"
        onMouseEnter={() => pinHovered.set(true)}
        onMouseLeave={() => pinHovered.set(false)}
        onPress={() => { void unpinThreadWithUndo(thread()); }}
      >
        <Glyph name={pinHovered() ? "pin-off" : "pin"} size={12} tint={pinHovered() ? token("foreground") : idle} />
      </View>
    );
  };

  // remoteMachineIcon: a thread of another (saved) environment carries that machine's icon, its label as the tooltip.
  const remoteMachineMark = () => {
    const environmentId = thread().environmentId;
    if (!environmentId) return null;
    const environment = managedEnvironment(environmentId);
    const label = environment?.label ?? environmentId;
    return (
      <View accessibilityLabel={label} tooltip={<Tip delay={THREAD_LIST_TOOLTIP_DELAY_MS} label={label} />} class="items-center justify-center">
        <Glyph name={machineKindForUrl(environment?.url ?? null) === "laptop" ? "laptop" : "server"} size={14} tint={mixColors(token("sidebar-muted-foreground"), token("sidebar"), 0.7)} />
      </View>
    );
  };

  const terminals = () => runningTerminalIds(thread().id);
  const terminalHovered = signal(false);
  const terminalMark = () => terminals().length > 0 ? (
    <View
      accessibilityLabel={terminalLabel(terminals().length)}
      role="button"
      tooltip={<Tip delay={THREAD_LIST_TOOLTIP_DELAY_MS} label={terminalLabel(terminals().length)} />}
      class="items-center justify-center rounded-sm"
      style={{ opacity: terminalHovered() ? 0.8 : 1 }}
      onMouseEnter={() => terminalHovered.set(true)}
      onMouseLeave={() => terminalHovered.set(false)}
      onPress={() => {
        const terminalId = terminals()[0];
        if (!terminalId) return;
        const key = panelKeyFor(thread().id);
        const next = revealTerminal(panelStateFor(key), drawerStateFor(key), terminalId);
        unsuppressDrawerTerminal(key, terminalId);
        updateDrawer(key, () => next.drawer);
        updatePanel(key, () => next.panel);
        props.onPress();
      }}
    >
      <MotionLoop spec={statusPulse}><Glyph name="square-terminal" size={14} tint={colorScheme() === "dark" ? "#5eead4" : "#0d9488"} /></MotionLoop>
    </View>
  ) : null;
  const prBadge = () => {
    const shellPr = thread().meta?.pullRequest;
    if (!shellPr) return null;
    const pr = { ...shellPr, state: fallbackState() ?? shellPr.state };
    const look = PR_LOOK[pr.state];
    // ThreadPullRequestBadgeControl: several links read as "Stack of N" or "+N" with their overall state, and open the thread's linked pull requests list.
    if (pr.many) {
      const presentation = stackBadgePresentation(pr.many, { number: pr.number, url: pr.url, singleLabel: `${changeRequestWords(pr.url).shortLabel} #${pr.number}, ${look.label}` });
      const overall = PR_LOOK[presentation.state];
      return (
        <View
          accessibilityLabel={presentation.label}
          role="button"
          tooltip={<Tip delay={THREAD_LIST_TOOLTIP_DELAY_MS} label={presentation.label} />}
          class="flex-row items-center gap-1 rounded-sm"
          onPress={() => { props.onPress(); updatePanel(panelKeyFor(thread().id), openPullRequestsSurface); }}
        >
          <Glyph name={presentation.glyph === "layers" ? "layers" : overall.glyph} size={12} tint={overall.tint(colorScheme())} />
          <Text class="text-xs text-secondary-label">{presentation.text}</Text>
        </View>
      );
    }
    return (
      <View
        accessibilityLabel={`Pull request #${pr.number}, ${look.label}`}
        role="button"
        class="flex-row items-center gap-1 rounded-sm"
        onPress={() => { void openUrl(pr.url).catch(() => undefined); }}
      >
        <Glyph name={look.glyph} size={12} tint={look.tint(colorScheme())} />
        <Text class="text-xs text-secondary-label">{pr.number}</Text>
      </View>
    );
  };
  // ThreadWorktreeIndicator: the folder-git mark ahead of the branch while the thread runs in a worktree.
  const worktreeMark = () => {
    const path = thread().path?.trim();
    if (!path) return null;
    const label = thread().meta?.branch
      ? `Worktree: ${worktreeDisplayName(path)} (${thread().meta!.branch})`
      : `Worktree: ${worktreeDisplayName(path)}`;
    return (
      <View accessibilityLabel={label} tooltip={<Tip delay={THREAD_LIST_TOOLTIP_DELAY_MS} label={label} />} class="items-center justify-center">
        <Glyph name="folder-git-2" size={14} tint={token("icon-muted")} />
      </View>
    );
  };

  // isFileDragOver: files over the row light it with the hover surface and a primary ring.
  const surface = () => threadRowSurface({ active: props.active, selected: selected(), fileOver: fileOver(), unsentDraft: threadHasUnsentDraft(thread().id) });

  // The slot holds the time or status; on hover the controls take it, except a Woke label, which stays.
  const slot = () => {
    const keepsWoke = (isCard() || inFolder() ? top()?.icon === "woke" : woke()) && section() !== "snoozed";
    return (
      <View class={`${isCard() ? "h-5" : "h-6"} min-w-8 flex-row items-center justify-end gap-1`}>
        {editing() ? null : isDraggingThread(thread().id) ? (dragVerb() ? <DropVerbBadge verb={dragVerb()!} /> : null) : revealed() ? (
          <>
            {keepsWoke ? trail() : null}
            {actions()}
          </>
        ) : trail()}
      </View>
    );
  };

  const issueBadge = () => {
    const issueLinks = thread().relations?.issues;
    if (!issueLinks?.length) return null;
    const envId = resolveIssueEnvironmentId(thread().projectId);
    if (!issuesSupported(envId)) return null;
    const state = sidebarLinkedIssueState(envId, issueLinks);
    if (!state) return null;
    const pres = issueStatePresentation(state);
    const scheme = colorScheme() === "light" ? "light" : "dark";
    return (
      <View accessibilityLabel={`${issueLinks[0]!.displayKey}: ${pres.label}`} tooltip={`${issueLinks[0]!.displayKey}: ${pres.label}`} class="shrink-0">
        <PRIcon name={pres.icon} size={12} tint={toneColor(pres.tone, scheme)} />
      </View>
    );
  };

  const metaLineEmpty = () => !thread().meta?.branch && !thread().meta?.pullRequest && !(thread().relations?.issues?.length) && terminals().length === 0;

  // The line under the title: branch, terminal mark, pull request, provider marks. Empty, the marks move up beside the title.
  const metaLine = () => metaLineEmpty() ? null : (
    <View class="mt-0.5 flex-row items-center gap-1.5">
      {thread().meta?.branch ? (
        <>
          {worktreeMark()}
          <MiddleTruncate value={thread().meta!.branch!} showTitle={false} class="flex-1" textClass="text-xs text-secondary-label" />
        </>
      ) : <View class="flex-1" />}
      {terminalMark()}
      {prBadge()}
      {issueBadge()}
      <SidebarProviderStack thread={thread()} />
    </View>
  );
  const folderMultiline = () => inFolder() && props.multiline === true;

  const body = () => {
    if (isCard()) {
      return (
        <View class={`px-2.5 py-2 ${metaLineEmpty() ? "" : "h-[78px]"}`}>
          <View class="h-5 flex-row items-center gap-1.5">
            {!props.active && threadHasUnsentDraft(thread().id) ? <View accessibilityLabel="Unsent draft"><Icon name="square-pen" size={12} tint={token("warning-foreground")} /></View> : null}
            {props.projectName ? <ProjectTile name={props.projectName} projectId={thread().projectId} /> : null}
            {pinMark()}
            {remoteMachineMark()}
            <Text class="min-w-0 flex-1 truncate text-xs font-normal text-secondary-label">{props.projectName ?? ""}</Text>
            {slot()}
          </View>
          <View class="mt-1 flex-row items-center gap-1.5">
            {title()}
            {metaLineEmpty() ? <SidebarProviderStack thread={thread()} /> : null}
          </View>
          {metaLine()}
        </View>
      );
    }
    if (folderMultiline()) {
      // folder-multiline: px-2.5 py-1.5 ps-9, a h-6 title line, then the card's meta line.
      return (
        <View class="justify-center px-2.5 py-1.5 ps-9">
          <View class="h-6 min-w-0 flex-row items-center gap-2.5">
            {!props.active && threadHasUnsentDraft(thread().id) ? <View accessibilityLabel="Unsent draft"><Icon name="square-pen" size={12} tint={token("warning-foreground")} /></View> : null}
            {title()}
            {metaLineEmpty() ? <SidebarProviderStack thread={thread()} /> : null}
            {pinMark()}
            {remoteMachineMark()}
            {slot()}
          </View>
          {metaLine()}
        </View>
      );
    }
    return (
      <View class={`h-9 flex-row items-center gap-2.5 px-2.5 ${inFolder() ? "ps-9" : ""}`}>
        {/* The project mark is opacity-40 grayscale until hovered or focused; a settled row keeps it even while open. */}
        {!inFolder() && props.projectName ? (
          <View style={faded() ? { opacity: 0.4, filter: "grayscale(1)" } : undefined}>
            <ProjectTile name={props.projectName} projectId={thread().projectId} />
          </View>
        ) : null}
        {!props.active && threadHasUnsentDraft(thread().id) ? <View accessibilityLabel="Unsent draft"><Icon name="square-pen" size={12} tint={token("warning-foreground")} /></View> : null}
        {title()}
        {pinMark()}
        {remoteMachineMark()}
        {terminalMark()}
        {slot()}
      </View>
    );
  };

  // useSidebarRowSubscriptionLease + vcsEnvironment.branch: the row holds its checkout's branch stream while mounted.
  const checkoutBranch = useCheckoutBranch(thread);
  const hoverCard = () => (
    <ThreadHoverCard thread={thread()} projectName={props.projectName} terminalCount={terminals().length} currentBranch={checkoutBranch} />
  );

  // A receded preparing/working row: `opacity-70 transition-opacity hover:opacity-100 focus-within:opacity-100`.
  const dimmedWhileWorking = () => receded() && top()?.icon === "working" && !revealed();
  const rowClass = () => `w-full rounded-md ${surface()} ${isDraggingThread(thread().id) ? "opacity-60" : dimmedWhileWorking() ? "opacity-70" : ""} transition-opacity`;

  // Sidebar.motion.ts: a row that appears in a list already showing rows fades in from min(height, 40) above, 150ms;
  // compact rows are h-9 (36 pt), card and folder-multiline rows are taller than 40.
  const enter = listRowEnterStyle("sidebar-threads", sidebarRowTravel(untracked(() => (isCard() || folderMultiline() ? 40 : 36))));
  // routeReveal: a row that becomes the open one after it mounted scrolls itself into view.
  effect(() => {
    if (props.active) revealActiveRow(rowNode, thread().id, untracked(hovered));
  });
  return (
    <View class={isCard() ? "py-0.5" : ""} style={enter}>
      {dragGapBefore(thread().id) ? <DragGap /> : null}
      <ContextMenu
        popupClass={MENU_POPUP_CLASS}
        onOpenChange={trackOpenChange(contextOpen)}
        trigger={
          <View
            role="button"
            ref={(node: ViewRef | null) => {
              rowNode = node;
              tree.ref(node);
              if (props.active) revealActiveRow(node, thread().id, untracked(hovered));
              if (isCard()) registerDragRow(thread().id, section, node);
            }}
            accessibilityLabel={accessibleLabel()}
            accessibilityState={{ selected: selected() }}
            tooltip={editing() || menuOpen() ? undefined : hoverCard()}
            onPress={handlePress}
            onMouseEnter={() => hovered.set(true)}
            onMouseLeave={() => hovered.set(false)}
            onFileDragEnter={() => fileOver.set(true)}
            onFileDragLeave={() => fileOver.set(false)}
            onFileDrop={(event) => {
              fileOver.set(false);
              void dropFilesOnThread(thread().id, event.uris, () => { props.onPress(); return true; });
            }}
            onMouseMove={drag.onMouseMove}
            onPanStart={drag.onPanStart}
            onPanEnd={drag.onPanEnd}
            onFocus={() => { focusIn(); tree.onFocus(); }}
            onBlur={() => { focusOut(); tree.onBlur(); }}
            class={rowClass()}
          >
            <FocusRing id={threadRowId(thread().id)} />
            {fileOver() ? (
              <View
                accessibilityLabel="Drop files on thread"
                class="absolute inset-0 rounded-md border"
                style={{ borderColor: (colorScheme(), mixColors(token("primary"), token("sidebar"), 0.7)), pointerEvents: "none" }}
              />
            ) : null}
            {body()}
          </View>
        }
      >
        {bulk() ? (
          <ThreadMenuItems items={bulkItems()} onSelect={onBulkSelect} />
        ) : (
          <ThreadMenuItems items={menuItems()} onSelect={onMenuSelect} />
        )}
      </ContextMenu>
    </View>
  );
}
