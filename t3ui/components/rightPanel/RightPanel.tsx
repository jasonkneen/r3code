// The right panel (RightPanelTabs.tsx / ChatRightPanel.tsx): a tab strip with the
// layout controls at its right end, an "Open a surface" launcher while it has no
// tabs, the surfaces themselves, and a drag edge that resizes it. Open state,
// tabs and width are remembered per thread (panelState.ts).
import { FadeScroll } from "../FadeScroll";
import type { ScrollRef } from "nsh";
import { AnimatedValue, Clipboard, computed, createMotion, effect, keymap, Overlay, signal, Text, untracked, View, windowSize } from "nsh";
import { releasePromptKeyboard, settledLayout } from "../composer/editor/PromptEditor";
import type { MotionSpec } from "nsh";
import { handFocusBack, rightPanelFocus, rightPanelTrigger } from "../focusHandBack";
import { noteFocusArea, registerFocusArea } from "../../commands/workspaceFocus";
import { createPresence } from "../motion/Motion";
import { EASE_IN_OUT } from "../motion/motionTokens";
import { animatePanelLayout, panelAnimationMs } from "../motion/panelMotion";
import { Menu, titleBar } from "nsh/desktop";
import { Input, MenuItem, Menu as PopupMenu, Submenu, Tooltip } from "nsh/base";
import { allProjects, isServerThread, openThread, requestBackend, runtimeModeFor, selectedModelFor, serverRuntimeModeFor, settingValue } from "../../store";
import { serverEnvironment } from "../../pages/settings/settingsState";
import { sideChatDisabledReason } from "../composer/composerAvailability";
import { startSideChat as runSideChat } from "../composer/runCommands";
import { focusSideComposer } from "../sideChat/sideChatFocus";
import { errorToast, showToast } from "../toast/toastState";
import { DIcon } from "../device/DeviceIcons";
import { isTabAudioReady, isTabMuted, setTabMuted, tabAudioState } from "./previewAudio";
import { watchPreviewScope } from "./previewScope";
import { watchServerPreviews } from "./serverPreviewSync";
import { clipboardPathFor, tabMenuItems, type TabMenuAction } from "./tabMenuLogic";
import { knownDeviceState, deviceSetupOpen, watchDeviceState } from "../device/deviceState";
import { DevicePanel, DeviceStreamView } from "../device/DevicePanel";
import { applyDeviceSnapshot } from "./agentOpenedDevices";
import { DeviceSetupHost } from "../device/DeviceSetup";
import { needsSetup } from "../device/deviceLogic";
import { launcherRows, rowForKey, stepHighlight, type LauncherId, type LauncherRow } from "./launcherLogic";
import { listedProfiles, parseUserProfiles, resolveProfiles } from "../../pages/settings/browserProfilesLogic";
import { registerCommand } from "../../commands/registry";
import { FileSurface, IssueSurface, PreviewSurface, PullRequestSurface, PullRequestsSurface, SideChatSurface, TerminalSurface, sideChatsOf } from "./surfaces";
import { DiffPanel } from "../diff/DiffPanel";
import { FilePreview } from "../files/FilePreview";
import { FileEntryIcon } from "../files/FileEntryIcon";
import { FilesPanel } from "../files/FilesPanel";
import { HIcon } from "../header/HeaderIcons";
import { PanelLayoutControls, RightPanelMaximizeControl } from "../header/PanelLayoutControls";
import { MENU_ITEM_ROW_CLASS, MENU_POPUP_CLASS, MENU_SUBPOPUP_CLASS } from "../menuStyles";
import {
  openSideChatSurface, activateSurface, deviceSurfaceId, openDeviceSurface, clampPanelWidth, closeAllSurfaces, closeOtherSurfaces, closeSurface, closeSurfacesToRight, dragTargetIndex, moveSurface, panelMaxWidth, panelSheetWidth,
  closeSurfaceTerminal, surfaceTitle, type PanelState, type Surface, type SurfaceKind, type TabSlot,
} from "./panelLogic";
import { sidebarWidth } from "../sidebar/sidebarWidth";
import { FaviconIcon } from "./previewEmpty";
import { createLiveResize } from "./liveResize";
import { keepsPage, keptSurfaceKey, nextKeptSurfaces, type KeptSurface } from "./persistentSurfaces";
import { appOverlayOpen, nativeViewOccluded, overlayOpenBesidesSheet, PANEL_SHEET_LABEL, registerOverlay, useOverlayOpen, webViewsUnderSurface } from "./nativeOcclusion";
import { allMiniPlayers, chatCanvas, chatHeroLayout, chatLaneInsetEnd, closeMiniPlayer, miniPlayerFor, moveMiniPlayer, openDeviceMiniPlayer, resizeMiniPlayer, shouldRenderMiniPlayer } from "./miniPlayerState";
import { DEFAULT_SOURCE_SIZE, MINI_PLAYER_CORNER_RADIUS, resolveChatCanvasLayout, resolveDeviceMiniPlayerCornerRadius, resolveDeviceMiniPlayerSourceSize, type MiniPlayerFrame, type MiniPlayerSize } from "./miniPlayerLayout";
import { isTabRecording } from "./previewRecording";
import { MiniPlayerChrome, MINI_PLAYER_STRIP_HEIGHT, MINI_PLAYER_STRIP_INSET } from "./MiniPlayerChrome";
import { canOperatePreview } from "./previewScope";
import { closeSurfacesAndRelease, setSurfaceCloseDeps } from "./surfaceClose";
import { canLaunchTerminal } from "../terminal/terminalAllocation";
import { confirmTerminalClose } from "../terminal/terminalCommands";
import { canOperateThread } from "../header/sourceControlScope";
import { CHAT_LANE_MAX_WIDTH, chatLaneInset, chatWidthSetting } from "../thread/chatLane";
import { composerLaneHeight, drawerHeightBudget } from "../terminal/terminalLayoutBudget";
import { drawerStateFor } from "../terminal/drawerState";
import { clampTerminalHeight } from "../terminal/terminalLogic";
import {
  closeRightPanelAction, currentPanelKey, currentWorkspace, openBrowserAction, openFileAction, openPullRequestsAction, openPullRequestSurface, openSurfaceAction,
  openDeviceAction, openDevicePlaceholderAction, openTerminalSurfaceAction, panelKeyFor, renameDeviceAction, panelSheetActive, panelStateFor, setPanelWidth, surfaceAvailability, updatePanel,
  closeMiniPlayerAction, dockMiniPlayerAction, togglePreviewFloatAction,
} from "./panelState";

export { SURFACE_UNAVAILABLE_HINTS } from "./launcherLogic";

const SURFACE_ICONS: Record<Surface["kind"], string> = {
  diff: "file-diff", files: "files", file: "file", terminal: "square-terminal", "pull-request": "git-pull-request-arrow", "pull-requests": "git-pull-request-arrow",
  issue: "circle-dot", "side-chat": "messages-square", preview: "globe", device: "smartphone",
};

function Tip(props: { text: string }) {
  return <Tooltip class="max-w-80 rounded-md border border-border bg-popover px-2 py-1"><Text class="text-xs text-popover-foreground">{props.text}</Text></Tooltip>;
}

type Launcher = LauncherRow & { open: () => void };

/** `sideChatsOffered` and `sideChatDisabledReason` (ChatView.tsx), from the open thread and the environment's capabilities. */
function sideChatOffer(): { offered: boolean; reason: string | null } {
  const thread = openThread();
  const lineage = thread?.relations?.lineage;
  const subagent = lineage?.relationshipToParent === "subagent";
  const capabilities = (serverEnvironment()?.capabilities ?? {}) as Record<string, unknown>;
  const offered = thread !== null && currentPanelKey() !== null && lineage?.sideChat !== true && !subagent && capabilities.sideChats === true;
  const reason = sideChatDisabledReason({
    isSideChat: lineage?.sideChat === true, isSubagent: subagent, environmentKnown: serverEnvironment() !== null,
    environmentSupportsSideChats: capabilities.sideChats === true, isServerThread: isServerThread(thread?.id ?? ""),
  });
  return { offered, reason };
}

let sideChatStarting = false;

/** useSideChat.open: forks the thread into a side chat with no first message and shows its tab. One start at a time. */
export async function startPanelSideChat(): Promise<boolean> {
  const thread = openThread();
  if (!thread || sideChatStarting || sideChatOffer().reason !== null) return false;
  sideChatStarting = true;
  const target = `thread:${crypto.randomUUID()}`;
  try {
    const choice = selectedModelFor(thread.id);
    const started = await runSideChat({
      parentId: thread.id, targetId: target, prompt: "", runtimeMode: runtimeModeFor(thread.id), arrived: () => isServerThread(target), forkRuntimeMode: () => serverRuntimeModeFor(target),
      modelSelection: choice ? { instanceId: choice.provider, model: choice.model } : null,
    });
    if (started === null) return false;
    updatePanel(panelKeyFor(thread.id), (state) => openSideChatSurface(state, target));
    focusSideComposer(target);
    return true;
  } catch (cause) {
    errorToast("Could not start a side chat.", cause instanceof Error ? cause.message : undefined);
    return false;
  } finally {
    sideChatStarting = false;
  }
}

/** addDeviceSurface (useRightPanelActions.ts): the setup wizard until devices are set up, then the Device tab. */
export function openDeviceFromLauncher() {
  const known = knownDeviceState();
  if (known !== null && needsSetup(known, true)) deviceSetupOpen.set(true);
  else openDevicePlaceholderAction();
}

function launchers(copy: "launcher" | "menu" = "launcher"): Launcher[] {
  const available = surfaceAvailability();
  const links = openThread()?.relations?.pullRequests ?? [];
  const latest = links[0];
  const projectId = openThread()?.projectId ?? "";
  const side = sideChatOffer();
  const opens: Record<LauncherId, () => void> = {
    browser: () => openBrowserAction(),
    terminal: openTerminalSurfaceAction,
    files: () => openSurfaceAction("files"),
    diff: () => openSurfaceAction("diff"),
    "pull-request": () => { if (latest) openPullRequestSurface({ projectId, ...(latest.host ? { host: latest.host } : {}), repository: latest.repository, number: latest.number, url: latest.url }); },
    "pull-requests": openPullRequestsAction,
    device: openDeviceFromLauncher,
    "side-chat": () => { void startPanelSideChat(); },
  };
  // RightPanelTabs.tsx's order: Browser, Terminal, Files, Diff, Pull request, Linked pull requests, Device, Side chat.
  return launcherRows({
    browser: available.rightPanel, terminal: available.terminal, files: available.files, diff: available.diff, pullRequest: latest !== undefined, pullRequests: links.length > 0,
    device: currentPanelKey() !== null, sideChatOffered: side.offered, sideChatReason: side.reason,
  }, copy).map((row) => ({ ...row, open: opens[row.id] }));
}

/** The "Open a surface" launcher shown while the panel has no tabs (RightPanelEmptyState). */
export function SurfaceLauncher() {
  const highlight = signal(-1);
  const focused = signal(false);
  const rows = () => launchers("launcher");
  const open = () => rows().filter((row) => row.available);
  const highlighted = () => (open().length === 0 ? -1 : Math.min(highlight(), open().length - 1));
  // The reference listens for a letter on the window while nothing is being typed into: the keymap's `notEditing` is that test.
  // Only the letters of available rows are bound, so every other key still reaches type-to-focus.
  effect(() => {
    const unbind = open().map((row) => keymap.bind(row.shortcut.toLowerCase(), (event) => {
      if (appOverlayOpen()) return;
      rowForKey(rows(), event.keystroke)?.open();
    }, { when: "notEditing" }));
    return () => { for (const release of unbind) release(); };
  });
  // Arrows move the highlight and Enter opens it, while the launcher holds the keyboard focus.
  effect(() => {
    if (!focused()) return;
    const step = (key: "down" | "right" | "up" | "left") => () => { if (!appOverlayOpen()) highlight.set(stepHighlight(open().length, highlighted(), key)); };
    const unbind = [
      keymap.bind("down", step("down"), { when: "notEditing" }), keymap.bind("right", step("right"), { when: "notEditing" }),
      keymap.bind("up", step("up"), { when: "notEditing" }), keymap.bind("left", step("left"), { when: "notEditing" }),
    ];
    if (highlighted() >= 0) unbind.push(keymap.bind("enter", () => { if (!appOverlayOpen()) open()[highlighted()]?.open(); }, { when: "notEditing" }));
    return () => { for (const release of unbind) release(); };
  });
  return (
    <View class="min-h-0 flex-1 items-center justify-center px-6 pb-[52px]" accessibilityLabel="Open a surface">
      <View class="w-full max-w-xs py-6">
        <Text class="mb-3 text-center text-sm font-medium text-foreground">Open a surface</Text>
        <View class="gap-0.5">
          {rows().map((item) => {
            const index = () => open().findIndex((row) => row.id === item.id);
            return (
              <View
                role="button"
                accessibilityLabel={item.label}
                disabled={!item.available}
                tooltip={!item.available ? <Tip text={item.hint} /> : undefined}
                onPress={item.open}
                onFocus={() => focused.set(true)}
                onBlur={() => focused.set(false)}
                onMouseEnter={() => { if (item.available) highlight.set(index()); }}
                onMouseLeave={() => { if (highlight() === index()) highlight.set(-1); }}
                class={`h-8 w-full flex-row items-center gap-2.5 rounded-lg px-2.5 transition-colors duration-150 ease-in-out ${item.available ? (index() === highlighted() ? "bg-accent-50" : "hover:bg-accent-50") : "opacity-50"}`}
              >
                <HIcon name={item.icon} size={16} />
                <Text class="min-w-0 flex-1 truncate text-sm text-foreground">{item.label}</Text>
                {item.id === "browser" && item.available && resolveProfiles(parseUserProfiles(settingValue("browserProfiles"))).length > 1 ? <LauncherProfileMenu onOpen={item.open} /> : null}
                <View class="h-5 min-w-5 items-center justify-center rounded bg-muted-30 px-1"><Text class="text-xs font-medium text-muted-foreground">{item.shortcut}</Text></View>
              </View>
            );
          })}
        </View>
      </View>
    </View>
  );
}

/**
 * The launcher's Browser row chevron (RightPanelTabs.tsx "Open browser in a profile"): shown while more than one profile
 * resolves (the built-in incognito one counts, as in resolveBrowserProfiles), a menu of every profile. The port's browser
 * tabs have no per-profile session, so each profile opens a browser tab, as the add menu's profile submenu does.
 */
function LauncherProfileMenu(props: { onOpen: () => void }) {
  const open = signal(false);
  useOverlayOpen(() => open(), "launcher profile menu");
  return (
    <PopupMenu
      open={open()}
      onOpenChange={(event) => open.set(event.open)}
      popupClass={`${MENU_POPUP_CLASS} max-w-56`}
      trigger={<View role="button" accessibilityLabel="Open browser in a profile" class="size-6 shrink-0 items-center justify-center rounded-md hover:bg-accent"><HIcon name="chevron-down" size={14} /></View>}
    >
      {resolveProfiles(parseUserProfiles(settingValue("browserProfiles"))).map((profile) => (
        <MenuItem accessibilityLabel={profile.name} class={MENU_ITEM_ROW_CLASS} onSelect={() => { open.set(false); props.onOpen(); }}>
          <Text class="min-w-0 truncate text-sm text-popover-foreground">{profile.name}</Text>
        </MenuItem>
      ))}
    </PopupMenu>
  );
}

/** The device tab's inline name field: Enter or leaving it commits, Escape keeps the old name (RightPanelTabs.tsx). */
function DeviceTabNameField(props: { title: string; onFinish: (title: string) => void }) {
  const draft = signal(props.title);
  let done = false;
  const finish = (value: string) => { if (done) return; done = true; props.onFinish(value); };
  return (
    <Input
      autoFocus
      accessibilityLabel="Device tab name"
      value={draft()}
      onChange={(event) => draft.set(event.value)}
      onSubmit={() => finish(draft())}
      onBlur={() => finish(draft())}
      onKeyPress={(event) => { if (event.key === "Escape") finish(props.title); }}
      desktop={{ windowDrag: false }}
      class="h-4 w-24 min-w-0 rounded-sm bg-background px-1 text-xs text-foreground ring-1 ring-ring"
    />
  );
}

/** workspaceFocus "rightPanel": the active tab takes the keyboard (requestWorkspaceFocus({ area: "panel" })). */
const tabFocusTargets = new Map<string, { focus(): void }>();
const activeTabFocusTarget = () => { const state = panelStateFor(currentPanelKey()); return state.activeId ? tabFocusTargets.get(state.activeId) ?? null : null; };
let panelFocusRegistered = false;
function registerPanelFocusArea() {
  if (panelFocusRegistered) return;
  panelFocusRegistered = true;
  registerFocusArea({ id: "rightPanel", focus: () => activeTabFocusTarget()?.focus(), available: () => activeTabFocusTarget() !== null && panelStateFor(currentPanelKey()).open });
}

function PanelTab(props: {
  surface: Surface;
  active: boolean;
  onActivate: () => void;
  onClose: () => void;
  onMenu: (point: { x: number; y: number }) => void;
  /** Where the tab sits in the strip, so a drag can find the tab it lands on. */
  onSlot: (slot: { x: number; width: number }) => void;
  /** The tab was dropped after moving `translationX`. */
  onDrop: (translationX: number) => void;
  /** A device tab's inline name field is open (RightPanelTabs.tsx `renaming`); double-clicking the tab asks for it. */
  renaming?: boolean;
  canRename?: boolean;
  onStartRename?: () => void;
  onFinishRename?: (title: string) => void;
}) {
  const hovered = signal(false);
  const dragging = signal(false);
  // The drag binds to this value on the UI thread, so the tab follows the pointer every frame.
  const offset = new AnimatedValue(0);
  const title = () => surfaceTitle(props.surface);
  return (
    <View
      role="tab"
      ref={(node: { focus(): void } | null) => { if (node) tabFocusTargets.set(props.surface.id, node); else tabFocusTargets.delete(props.surface.id); }}
      onFocus={() => noteFocusArea("rightPanel")}
      accessibilityLabel={title()}
      accessibilityState={{ selected: props.active }}
      pan={{ x: offset }}
      style={{ transform: [{ translateX: offset }] }}
      onLayout={(event) => props.onSlot({ x: event.bounds.origin.x, width: event.bounds.size.width })}
      onPanStart={() => dragging.set(true)}
      onPanEnd={(event) => {
        dragging.set(false);
        offset.set(0);
        if (!event.cancelled) props.onDrop(event.translation.x);
      }}
      onMouseEnter={() => hovered.set(true)}
      onMouseLeave={() => hovered.set(false)}
      onContextMenu={(event) => props.onMenu(event.pagePosition)}
      desktop={{ windowDrag: false }}
      onPress={(event) => { props.onActivate(); if (event.clickCount === 2 && props.surface.kind === "device" && props.canRename) props.onStartRename?.(); }}
      classList={{ "relative z-10 opacity-90": dragging() }}
      class={`h-6 max-w-36 shrink-0 flex-row items-center gap-0.5 rounded-md pl-1.5 pr-2 ${props.active ? "bg-accent" : "hover:bg-accent-50"}`}
    >
      <View
        role="button"
        accessibilityLabel={`Close ${title()}`}
        onPress={props.onClose}
        class="size-4 shrink-0 items-center justify-center rounded-sm hover:bg-muted"
      >
        {hovered() ? <HIcon name="x" size={12} /> : props.surface.kind === "file" ? <FileEntryIcon path={props.surface.relativePath ?? ""} kind="file" size={12} /> : props.surface.kind === "preview" && (props.surface.previewUrl ?? "") !== "" ? <FaviconIcon url={props.surface.previewUrl ?? ""} size={12} /> : <HIcon name={SURFACE_ICONS[props.surface.kind]} size={12} />}
      </View>
      {props.surface.kind === "preview" && tabAudioState(props.surface.id) !== "none" ? (
        <View
          role="button"
          accessibilityLabel={`${tabAudioState(props.surface.id) === "muted" ? "Unmute" : "Mute"} ${title()}`}
          tooltip={<Tip text={tabAudioState(props.surface.id) === "muted" ? "Unmute tab" : "Mute tab"} />}
          onPress={() => setTabMuted(props.surface.id, tabAudioState(props.surface.id) !== "muted")}
          class="size-4 shrink-0 items-center justify-center rounded-sm hover:bg-muted"
        >
          <DIcon name={tabAudioState(props.surface.id) === "muted" ? "volume-off" : "volume-2"} size={12} />
        </View>
      ) : null}
      {props.renaming ? (
        <DeviceTabNameField title={title()} onFinish={(next) => props.onFinishRename?.(next)} />
      ) : (
        // PanelTabCloseButton takes no tooltip here; the title button carries the tab's title tooltip. An inactive tab
        // turns `hover:text-foreground`.
        <View role="button" accessibilityLabel={`Select ${title()}`} tooltip={<Tip text={title()} />} class="min-w-0 shrink flex-row items-center overflow-hidden">
          <Text class={`min-w-0 shrink truncate text-xs ${props.active || hovered() ? "text-foreground" : "text-muted-foreground"}`}>{title()}</Text>
        </View>
      )}
    </View>
  );
}

/** The reference hides the tab list's scrollbars (hideScrollbars); a horizontal view keeps its bar on the desktop, so it is drawn invisible. */
const HIDDEN_SCROLLBAR = { horizontal: { style: { opacity: 0 }, thumbStyle: { opacity: 0 } } };

/** A view that takes no presses itself while its children do. */
const PASS_THROUGH = { pointerEvents: "box-none" as const };
/** ui/sheet.tsx `data-starting-style:translate-x-8`: 2rem. */
const SHEET_TRAVEL = 32;
const SHEET_REST: MotionSpec = { keyframes: { opacity: [1, 1], translateX: [0, 0] }, duration: 0, ignoreReduceMotion: true };

/** `rightPanel.new` (mod+t): opens the add-surface menu. */
export const addSurfaceMenuOpen = signal(false);

/** SurfaceMenuItem (RightPanelTabs.tsx): an unavailable row is dimmed and explains itself in a tooltip. */
function surfaceRow(item: Launcher, trailing?: ReturnType<typeof HIcon>) {
  return (
    <MenuItem
      accessibilityLabel={`Add ${item.label}`}
      disabled={!item.available}
      tooltip={!item.available ? <Tip text={item.hint} /> : undefined}
      class={`${MENU_ITEM_ROW_CLASS} ${item.available ? "" : "opacity-64"}`}
      onSelect={() => { addSurfaceMenuOpen.set(false); item.open(); }}
    >
      <HIcon name={item.icon} size={16} />
      <Text class="shrink-0 whitespace-nowrap text-sm text-popover-foreground">{item.label}</Text>
      <Text class="ms-auto text-xs font-medium tracking-widest text-muted-foreground">{item.shortcut}</Text>
      {trailing ?? null}
    </MenuItem>
  );
}

function AddSurfaceMenu() {
  useOverlayOpen(() => addSurfaceMenuOpen(), "add surface menu");
  // handleAddSurfaceMenuKeyDown (RightPanelTabs.tsx): while the menu is open a row's letter opens it. The reference's popup
  // holds the focus; an nsh popup leaves it where it was (the composer, or a terminal the "+" press took it back from), so
  // the letters are bound for every target ("always") only while the menu is open, or they typed into that field.
  effect(() => {
    if (!addSurfaceMenuOpen()) return;
    const rows = untracked(() => launchers("menu"));
    const unbind = rows.filter((row) => row.available).map((row) => keymap.bind(row.shortcut.toLowerCase(), (event) => {
      const found = rowForKey(rows, event.keystroke);
      if (!found) return;
      addSurfaceMenuOpen.set(false);
      found.open();
    }, { when: "always" }));
    return () => { for (const release of unbind) release(); };
  });
  return (
    <PopupMenu
      open={addSurfaceMenuOpen()}
      onOpenChange={(event) => addSurfaceMenuOpen.set(event.open)}
      // The reference's popup is as wide as its widest row ("Linked pull requests" and its letter: 189pt measured).
      // An nsh popup does not grow past its minimum width for its rows (the label wrapped at min-w-40), so the width is set.
      popupClass={`${MENU_POPUP_CLASS} w-[189px]`}
      trigger={<View role="button" accessibilityLabel="Add panel surface" tooltip={<Tip text="Add panel surface" />} desktop={{ windowDrag: false }} class="size-6 shrink-0 items-center justify-center rounded-lg hover:bg-accent active:scale-[0.97] transition-transform duration-150 ease-in-out"><HIcon name="plus" size={14} /></View>}
    >
      {launchers("menu").map((item) => {
        if (item.label !== "Browser" || !item.available) return surfaceRow(item);
        // The Browser row opens a submenu of browser profiles (RightPanelTabs.tsx MenuSub); every profile opens a tab.
        const profiles = listedProfiles(parseUserProfiles(settingValue("browserProfiles")));
        return (
          <Submenu trigger={surfaceRow(item, <HIcon name="chevron-right" size={16} />)}>
            <View class={MENU_SUBPOPUP_CLASS}>
              {profiles.map((profile) => (
                <MenuItem accessibilityLabel={profile.name} class={MENU_ITEM_ROW_CLASS} onSelect={() => { addSurfaceMenuOpen.set(false); item.open(); }}>
                  <Text class="min-w-0 truncate text-sm text-popover-foreground">{profile.name}</Text>
                </MenuItem>
              ))}
            </View>
          </Submenu>
        );
      })}
    </PopupMenu>
  );
}

/** One of the "Scroll tabs left/right" chevrons that show while the tabs overflow (Button size icon-xs, variant ghost). */
function TabScrollButton(props: { direction: -1 | 1; enabled: () => boolean; onPress: () => void }) {
  const label = props.direction < 0 ? "Scroll tabs left" : "Scroll tabs right";
  return (
    <View
      role="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !props.enabled() }}
      disabled={!props.enabled()}
      tooltip={<Tip text={label} />}
      desktop={{ windowDrag: false }}
      onPress={props.onPress}
      class={`size-6 shrink-0 items-center justify-center rounded-lg ${props.enabled() ? "hover:bg-accent" : "opacity-64"}`}
    >
      <HIcon name={props.direction < 0 ? "chevron-left" : "chevron-right"} size={14} />
    </View>
  );
}

export function RightPanel(props: { rowWidth?: () => number | undefined; windowWidth?: () => number; request?: (method: string, payload: unknown) => Promise<unknown>; onWidth?: (width: number) => void }) {
  registerPanelFocusArea();
  // The session's grant of the preview operate scope: without it the browser tab shows no page (PreviewPanel.tsx).
  watchPreviewScope();
  // Server-hosted tabs (an agent's preview_open): panel tabs, and a float when revealed (serverPreviewSync.ts).
  watchServerPreviews();
  // The launcher tells a set-up environment from one that is not (addDeviceSurface), and the setup dialog it opens lives here.
  const deviceWatch = watchDeviceState();
  // The panel follows the open thread's key only once a focused prompt editor in it (a side chat's composer) gave the
  // keyboard up: a thread switch swapped the side chat out while it held the keyboard (PromptEditor.tsx).
  const settledKey = signal(untracked(currentPanelKey));
  effect(() => {
    const next = currentPanelKey();
    if (next === untracked(settledKey)) return;
    void releasePromptKeyboard().then(() => settledKey.set(currentPanelKey()));
  });
  const key = () => settledKey();
  const state = (): PanelState => panelStateFor(key());
  const workspace = () => currentWorkspace();
  const projectName = () => allProjects().find((project) => project.id === openThread()?.projectId)?.name ?? null;
  // Until the row has been measured, assume the sidebar takes its share of the window.
  const rowWidth = () => props.rowWidth?.() ?? (props.windowWidth ? undefined : viewportWidth() - sidebarWidth());
  const viewportWidth = () => props.windowWidth?.() ?? windowSize().width;
  const maxWidth = () => panelMaxWidth(viewportWidth(), rowWidth());
  const sheet = () => (props.windowWidth ? viewportWidth() <= 980 && !state().maximized : panelSheetActive());
  // The narrow-layout sheet is a floating surface over the chat (and any web view in it).
  useOverlayOpen(() => sheet() && !!workspace() && state().open, PANEL_SHEET_LABEL);
  // The docked panel as a boolean that flips only after a focused prompt editor in it (a side chat's composer) gave the
  // keyboard up: closing it by the toggle while that composer held the keyboard left its key table behind (PromptEditor.tsx).
  const docked = settledLayout(() => !!(state().open && workspace() && !sheet()), () => { animatePanelLayout(); });
  // Keeps the docked panel's chrome mounted while it slides closed to width 0, then clears it.
  const dockedPresence = createPresence(docked, panelAnimationMs);
  const dockedVisible = computed(() => docked() || dockedPresence.present());
  // PreviewPanelShell.tsx: collapsing the panel with the focus in it gives the focus to the header's toggle
  // (focusHandBack.ts, host patch 0013).
  let wasDocked = untracked(docked);
  effect(() => {
    const now = docked();
    untracked(() => { if (wasDocked && !now) handFocusBack(rightPanelFocus, rightPanelTrigger); else if (!wasDocked && now) rightPanelFocus.reset(); });
    wasDocked = now;
  });
  // A memo, so the fragment below is evaluated again only when a branch flips. Its two branches are evaluated together:
  // read inline, `workspace()` (a new object on every thread or project update) and `state()` (every panel update, a
  // terminal taking the focus among them) built the docked panel again each time, which destroyed every web view in it. A
  // terminal's web view that had just become first responder by a click was removed, and the window was left with no
  // first responder: nothing could be typed anywhere (workspace/host-focus/results.md).
  const sheetShown = computed(() => !!(sheet() && workspace()));
  // The sheet is the panel's own view laid over the chat (not an nsh Sheet, whose content is made again on every
  // opening): its kept pages are the same rows as the docked panel's, so switching between the two layouts, or opening
  // and closing the sheet, never makes a browser or terminal web view again (persistentSurfaces.ts).
  const sheetOpen = computed(() => sheetShown() && state().open);
  // SheetPopup (ui/sheet.tsx) with RightPanelSheet's transitionDurationMs = the panel animation setting: the popup fades
  // and slides 2rem from the right, the backdrop fades, `duration-200 ease-in-out` timing at that duration (0: at once).
  // The sheet keeps its layout through the exit (createPresence), so its pages are never hidden mid-slide.
  const sheetPresence = createPresence(sheetOpen, panelAnimationMs);
  const sheetLayer = computed(() => sheetShown() && sheetPresence.present());
  const sheetMotion = createMotion();
  const backdropMotion = createMotion();
  // A view keeps the animated values it was bound to after its style drops them: once the exit has played, the sheet's
  // view goes back to rest, or the docked panel or a floating card in it would stay faded out and shifted.
  effect(() => { if (!sheetPresence.present()) untracked(() => { void sheetMotion.play(SHEET_REST); void backdropMotion.play(SHEET_REST); }); });
  let sheetWasOpen = false;
  effect(() => {
    const on = sheetOpen();
    untracked(() => {
      // Only a change plays: a docked panel at start (closed sheet) must not play the sheet's exit onto its own view.
      if (on === sheetWasOpen) return;
      sheetWasOpen = on;
      const ms = panelAnimationMs();
      if (ms <= 0) { void sheetMotion.play(SHEET_REST); void backdropMotion.play(SHEET_REST); return; }
      void sheetMotion.play({ keyframes: on ? { opacity: [0, 1], translateX: [SHEET_TRAVEL, 0] } : { opacity: [1, 0], translateX: [0, SHEET_TRAVEL] }, duration: ms, easing: EASE_IN_OUT, ignoreReduceMotion: true });
      void backdropMotion.play({ keyframes: { opacity: on ? [0, 1] : [1, 0] }, duration: ms, easing: EASE_IN_OUT, ignoreReduceMotion: true });
    });
  });
  effect(() => {
    if (!sheetOpen()) return;
    return keymap.bind("escape", () => { if (!overlayOpenBesidesSheet()) closeRightPanelAction(); });
  });
  const edit = (change: (current: PanelState) => PanelState) => { const k = key(); if (k) updatePanel(k, change); };
  // useRightPanelSurfaceClose: a closed tab releases its terminal sessions, unused side chat or server browser session.
  const closeDeps = { rpc: props.request ?? requestBackend, canOperateTerminal: canLaunchTerminal, canOperateThread, canOperatePreview, confirmTerminalClose };
  setSurfaceCloseDeps(closeDeps);
  const closeAndRelease = (change: (current: PanelState) => PanelState, single?: Surface) => void closeSurfacesAndRelease({
    threadId: workspace()?.threadId ?? null, state, apply: edit, change, single, deps: closeDeps,
  });
  // Browser and terminal tabs keep their page (persistentSurfaces.ts): each stays mounted, hidden while it is not the tab
  // in front, while its thread is not the open one, and while the panel is closed. A thread without a folder shows no
  // page at all, so it keeps none.
  const kept = signal<readonly KeptSurface[]>([]);
  const canKeep = computed(() => !!workspace()?.cwd);
  effect(() => {
    const panelKey = key();
    const space = workspace();
    const surfaces = state().surfaces;
    // The settled key lags the open thread while a prompt editor gives the keyboard up: only a matching pair names a panel.
    const current = panelKey !== null && panelKey === currentPanelKey() && space && space.cwd ? { panelKey, threadId: space.threadId, cwd: space.cwd, surfaces } : null;
    const alive = (otherKey: string, id: string) => panelStateFor(otherKey).surfaces.some((item) => item.id === id);
    untracked(() => kept.update((all) => nextKeptSurfaces(all, current, alive)));
  });
  // The floating browser preview (ThreadPreviewMiniPlayer.tsx): the thread's floating tab shows as a card over the chat
  // unless the panel shows that very tab. It is the same kept page: its row below changes where it is laid out, so the
  // web view is not made again when it leaves the panel or goes back.
  const floatId = computed<string | null>(() => {
    const k = key();
    const entry = miniPlayerFor(k);
    if (!entry || k === null || k !== currentPanelKey()) return null;
    const current = state();
    // DeviceMiniPlayer: a device stream floats whether or not the panel has its tab, unless the panel shows that tab.
    if (entry.device) return current.open && current.maximized ? null : shouldRenderMiniPlayer(entry.tabId, current.open ? current.activeId : null) ? entry.tabId : null;
    if (!canKeep() || !canOperatePreview()) return null;
    const tab = current.surfaces.find((surface) => surface.id === entry.tabId && surface.kind === "preview");
    if (!tab || (tab.previewUrl ?? "") === "") return null;
    // A maximized panel hides the chat the card floats over.
    if (current.open && current.maximized) return null;
    return shouldRenderMiniPlayer(entry.tabId, current.open ? current.activeId : null) ? entry.tabId : null;
  });
  // Each browser tab's page size while it shows in the panel; the floating card keeps the proportions it had there.
  const pageSizes = new Map<string, MiniPlayerSize>();
  const floatSource = computed<MiniPlayerSize>(() => {
    if (floatId() === null) return DEFAULT_SOURCE_SIZE;
    // resolveDeviceMiniPlayerSourceSize: the stream page reports no screen size here, so a device keeps the phone default.
    const device = miniPlayerFor(key())?.device;
    if (device) return resolveDeviceMiniPlayerSourceSize(device.platform, null);
    return pageSizes.get(`${key()}\n${floatId()}`) ?? DEFAULT_SOURCE_SIZE;
  });
  // The chat canvas: the chat column under the thread header, less an open terminal drawer.
  const floatContainer = computed<MiniPlayerSize>(() => {
    const canvas = chatCanvas();
    const k = key();
    const drawer = k !== null && state().terminalOpen ? clampTerminalHeight(drawerStateFor(k).height, windowSize().height, drawerHeightBudget()) : 0;
    return { width: canvas.width, height: Math.max(0, canvas.height - drawer) };
  });
  const floatLayout = computed(() => {
    const entry = miniPlayerFor(key());
    if (floatId() === null || !entry) return null;
    const container = floatContainer();
    return resolveChatCanvasLayout({
      container,
      preview: { width: entry.width, position: entry.position, source: floatSource(), lastInteraction: entry.lastInteraction },
      padding: chatLaneInset(container.width),
      maxChatWidth: CHAT_LANE_MAX_WIDTH[chatWidthSetting(settingValue("chatWidth"))],
      composerHeight: chatHeroLayout() ? 0 : composerLaneHeight(),
    });
  });
  const floatFrame = computed<MiniPlayerFrame | null>(() => floatLayout()?.frame ?? null);
  const floatShown = computed(() => floatId() !== null && floatFrame() !== null);
  // The floating device stream (DeviceMiniPlayer): its own stream view, not the panel tab's.
  const floatingDevice = computed(() => (floatShown() ? miniPlayerFor(key())?.device ?? null : null));
  const floatDeviceKey = computed(() => { const device = floatingDevice(); return device ? `${key()}\n${device.hostId}\n${device.deviceId}` : ""; });
  // applyDeviceSnapshot (agentOpenedPreviews.ts): a device an agent opens floats over its thread's chat, or opens as a
  // panel tab when floating previews are off; a floating device whose session ended closes.
  let deviceBaseline: ReadonlySet<string> | undefined;
  effect(() => {
    if (!deviceWatch.loaded()) return;
    const snapshot = deviceWatch.state();
    untracked(() => {
      const floating = Object.entries(allMiniPlayers()).flatMap(([panelKey, entry]) => {
        if (!entry.device) return [];
        let threadId: unknown = null;
        try { threadId = (JSON.parse(panelKey) as unknown[])[1]; } catch { /* not a thread key */ }
        return typeof threadId === "string" ? [{ panelKey, threadId, target: entry.device }] : [];
      });
      const result = applyDeviceSnapshot(deviceBaseline, snapshot, floating, {
        sheetLayout: sheet(),
        autoShowFloatingPreview: settingValue("browserAutoShowFloatingPreview") !== false,
      });
      deviceBaseline = result.baseline;
      for (const threadId of result.close) for (const entry of floating) if (entry.threadId === threadId) closeMiniPlayer(entry.panelKey);
      for (const item of result.float) openDeviceMiniPlayer(panelKeyFor(item.threadId), deviceSurfaceId(item.target), item.target);
      for (const item of result.openTab) {
        const panelKey = panelKeyFor(item.threadId);
        if (panelStateFor(panelKey).surfaces.some((surface) => surface.id === deviceSurfaceId(item.target))) continue;
        updatePanel(panelKey, (current) => openDeviceSurface(current, item.target));
      }
    });
  });
  // The chat lane keeps clear of the card while a readable lane fits beside it (ChatCanvas.tsx `--chat-lane-inset-end`).
  effect(() => { const layout = floatLayout(); const inset = layout && layout.frame ? Math.round(layout.chat.insetEnd) : 0; untracked(() => chatLaneInsetEnd.set(inset)); });
  const isFloating = (entry: KeptSurface) => floatShown() && entry.panelKey === key() && entry.id === floatId() && entry.kind === "preview";
  // The docked panel stays mounted at width 0 while closed so LayoutAnimation can ease 0 <-> width on open/close,
  // and so kept WebViews are never destroyed.
  const panelMounted = computed(() => dockedVisible() || sheetShown() || kept().length > 0 || floatShown() || workspace() !== null);
  // The drag edge exists while the panel is on screen and not maximized (a memo: it is made again only when that flips).
  const edgeShown = computed(() => docked() && !state().maximized);
  const regularSurfaces = () => (canKeep() ? state().surfaces.filter((surface) => !keepsPage(surface.kind)) : state().surfaces);
  /** closeEndedPanelTerminal for a kept tab: it closes the terminal in the tab's own panel, which need not be the open thread's. */
  function closeKeptTerminal(entry: KeptSurface, terminalId: string) {
    updatePanel(entry.panelKey, (current) => closeSurfaceTerminal(current, terminalId));
    void requestBackend("terminal.close", { threadId: entry.threadId, terminalId, deleteHistory: true })
      .catch(() => requestBackend("terminal.write", { threadId: entry.threadId, terminalId, data: "exit\n" }).catch(() => {}));
  }
  // The width follows the pointer while the edge is dragged; it is stored when the drag ends.
  const resize = createLiveResize({
    axis: "x",
    direction: -1,
    size: () => clampPanelWidth(state().width, maxWidth()),
    clamp: (value) => clampPanelWidth(value, maxWidth()),
    commit: (value) => { const k = key(); if (k) setPanelWidth(k, value); },
  });
  const width = () => resize.live() ?? clampPanelWidth(state().width, maxWidth());
  const slots = new Map<string, { x: number; width: number }>();
  // A tab opened past the visible part of the tab list is scrolled to (the list ends with the add button).
  let tabScroll: ScrollRef | null = null;
  let tabCount = 0;
  // The tab list's overflow (RightPanelTabs.tsx updateTabScrollState): its chevrons show only while the tabs do not fit.
  const TAB_SCROLL_EDGE_TOLERANCE = 1;
  const tabViewport = signal(0);
  const tabContent = signal(0);
  const tabOffset = signal(0);
  const hasOverflow = () => tabContent() - tabViewport() > TAB_SCROLL_EDGE_TOLERANCE;
  const canScrollLeft = () => hasOverflow() && tabOffset() > TAB_SCROLL_EDGE_TOLERANCE;
  const canScrollRight = () => hasOverflow() && tabOffset() + tabViewport() < tabContent() - TAB_SCROLL_EDGE_TOLERANCE;
  const scrollTabs = (direction: -1 | 1) => {
    const step = Math.max(120, tabViewport() * 0.75);
    const x = Math.max(0, Math.min(tabContent() - tabViewport(), tabOffset() + direction * step));
    tabScroll?.scrollTo({ x, animated: true });
  };
  effect(() => {
    const count = state().surfaces.length;
    if (count > tabCount) setTimeout(() => tabScroll?.scrollToEnd({ animated: false }), 50);
    tabCount = count;
  });
  effect(() => { props.onWidth?.(width()); });

  function dropTab(surface: Surface, translationX: number) {
    const order = state().surfaces.map((item) => item.id);
    const tabSlots: TabSlot[] = [];
    for (const id of order) {
      const slot = slots.get(id);
      if (!slot) return;
      tabSlots.push({ id, ...slot });
    }
    const target = dragTargetIndex(tabSlots, surface.id, translationX);
    if (target !== null) edit((current) => moveSurface(current, surface.id, target));
  }

  // The device tab whose name is being edited.
  const renamingId = signal<string | null>(null);

  async function copyPath(relativePath: string) {
    const cwd = workspace()?.cwd ?? "";
    const text = clipboardPathFor(relativePath, cwd);
    try {
      await Clipboard.writeText(text);
      showToast({ type: "success", title: "Path copied", description: text });
    } catch (cause) {
      errorToast("Failed to copy path", cause instanceof Error && cause.message ? cause.message : "An error occurred.");
    }
  }

  function tabMenu(surface: Surface, at: { x: number; y: number }) {
    const index = state().surfaces.findIndex((item) => item.id === surface.id);
    const items = tabMenuItems(surface, {
      count: state().surfaces.length, index,
      ...(surface.kind === "preview" ? { mute: { ready: isTabAudioReady(surface.id), muted: isTabMuted(surface.id) } } : {}),
    });
    const run: Record<TabMenuAction, () => void> = {
      rename: () => renamingId.set(surface.id),
      "copy-path": () => { if (surface.kind === "file" && surface.relativePath) void copyPath(surface.relativePath); },
      "toggle-mute": () => setTabMuted(surface.id, !isTabMuted(surface.id)),
      close: () => closeAndRelease((current) => closeSurface(current, surface.id), surface),
      "close-others": () => closeAndRelease((current) => closeOtherSurfaces(current, surface.id)),
      "close-to-right": () => closeAndRelease((current) => closeSurfacesToRight(current, surface.id)),
      "close-all": () => closeAndRelease(closeAllSurfaces),
    };
    // The tab menu floats over whatever is under it, a native web view included: they step aside until it closes.
    const release = registerOverlay("panel tab menu");
    void Menu.popup(items.map((item) => ({ label: item.label, ...(item.disabled ? { disabled: true } : {}), onSelect: run[item.id] })), at).then(release, release);
  }

  const content = (surface: Surface) => {
    const space = workspace();
    if (!space || !space.cwd) return <Text class="px-4 py-6 text-sm text-muted-foreground">This thread does not have a project folder.</Text>;
    if (surface.kind === "terminal") return <TerminalSurface surface={surface} threadId={space.threadId} cwd={space.cwd} />;
    if (surface.kind === "pull-request") return <PullRequestSurface surface={surface} onClose={() => edit((current) => closeSurface(current, surface.id))} {...(props.request ? { request: props.request } : {})} />;
    if (surface.kind === "pull-requests") return <PullRequestsSurface projectId={openThread()?.projectId ?? null} />;
    if (surface.kind === "issue") return <IssueSurface surface={surface} onClose={() => edit((current) => closeSurface(current, surface.id))} {...(props.request ? { request: props.request } : {})} />;
    if (surface.kind === "side-chat") return <SideChatSurface surface={surface} onClose={() => closeAndRelease((current) => closeSurface(current, surface.id), surface)} />;
    if (surface.kind === "preview") return <PreviewSurface surface={surface} active={() => state().activeId === surface.id} />;
    if (surface.kind === "device") return <DevicePanel surface={surface} threadId={space.threadId} visible={() => state().open && state().activeId === surface.id} onCloseSurface={() => edit((current) => closeSurface(current, surface.id))} onOpened={openDeviceAction} />;
    if (surface.kind === "diff") return <DiffPanel threadId={space.threadId} cwd={space.cwd} {...(props.request ? { request: props.request } : {})} />;
    if (surface.kind === "files") return <FilesPanel cwd={space.cwd} projectName={projectName()} selectedPath={() => state().surfaces.find((item) => item.id === state().activeId)?.relativePath ?? null} onOpenFile={openFileAction} {...(props.request ? { request: props.request } : {})} />;
    return <FileSurface surface={surface} cwd={space.cwd} projectName={projectName()} onOpenFile={openFileAction} {...(props.request ? { request: props.request } : {})} />;
  };

  // The tab strip, the launcher and the tabs that are made again with their thread (everything but the kept pages below).
  const chrome = (inSheet: boolean) => (
    <>
      <View class="h-[52px] shrink-0 flex-row items-center gap-1 pl-2" style={{ paddingRight: (inSheet ? 0 : titleBar().right) + 12 }} accessibilityLabel="Right panel tabs" desktop={{ windowDrag: true }}>
        {/* The reference's tab list is a horizontal scroll area that holds the tabs and the add button (tabs keep their size, max-w-36, and scroll). */}
        <FadeScroll
          surface="background"
          ref={(node: ScrollRef | null) => { tabScroll = node; }}
          horizontal
          scrollbar={HIDDEN_SCROLLBAR}
          class="h-full min-w-0 flex-1"
          contentClass="h-full w-max min-w-full flex-row items-center gap-1"
          role="tablist"
          desktop={{ windowDrag: false }}
          scrollEventThrottle={16}
          onLayout={(event) => tabViewport.set(event.bounds.size.width)}
          onContentLayout={(size) => tabContent.set(size.width)}
          onScroll={(event) => { tabOffset.set(event.offset.x); tabContent.set(event.contentSize.width); tabViewport.set(event.size.width); }}
        >
          <Each of={state().surfaces} key={(surface) => surface.id}>
            {(surface) => (
              <PanelTab
                surface={surface()}
                active={surface().id === state().activeId}
                onActivate={() => edit((current) => activateSurface(current, surface().id))}
                onClose={() => closeAndRelease((current) => closeSurface(current, surface().id), surface())}
                onMenu={(at) => tabMenu(surface(), at)}
                onSlot={(slot) => slots.set(surface().id, slot)}
                onDrop={(translationX) => dropTab(surface(), translationX)}
                renaming={renamingId() === surface().id}
                canRename
                onStartRename={() => renamingId.set(surface().id)}
                onFinishRename={(title) => { renameDeviceAction(surface().id, title); renamingId.set(null); }}
              />
            )}
          </Each>
          <AddSurfaceMenu />
        </FadeScroll>
        {hasOverflow() ? (
          <View class="shrink-0 flex-row items-center gap-0.5" role="group" accessibilityLabel="Scroll panel tabs" desktop={{ windowDrag: false }}>
            <TabScrollButton direction={-1} enabled={canScrollLeft} onPress={() => scrollTabs(-1)} />
            <TabScrollButton direction={1} enabled={canScrollRight} onPress={() => scrollTabs(1)} />
          </View>
        ) : null}
        <View class="shrink-0 flex-row items-center gap-1">
          {/* ChatView.tsx layoutControls: the maximize control shows whenever the panel is open, tabs or not. */}
          {!inSheet ? <RightPanelMaximizeControl /> : null}
          <PanelLayoutControls show={inSheet ? "all" : "rest"} />
        </View>
      </View>
      {state().surfaces.length === 0 ? <SurfaceLauncher /> : null}
      <Each of={regularSurfaces()} key={(surface) => surface.id}>
        {(surface) => {
          // The surface's content mounts again only when what it shows changes (its fields, the thread's folder), not on
          // every update of the panel state or the workspace object: each update remounted a side chat's composer while it
          // held the keyboard (twice per send), which left its key table behind and passed the focus to the main composer.
          const shown = computed(() => {
            const space = surface().kind === "side-chat" ? null : workspace();
            // A device tab's name is edited in place: a rename must not remount the panel and drop its video.
            const { title: _title, ...stable } = surface();
            return JSON.stringify([surface().kind === "device" ? stable : surface(), space?.threadId ?? null, space?.cwd ?? null]);
          });
          return (
            <View class={surface().id === state().activeId ? "min-h-0 w-full min-w-0 flex-1" : "hidden"}>
              <Each of={[shown()]} key={(key) => key}>{() => untracked(() => content(surface()))}</Each>
            </View>
          );
        }}
      </Each>
    </>
  );

  const body = (inSheet: boolean) => (
    <>
      {inSheet || dockedVisible() || sheetLayer() ? chrome(inSheet || sheetLayer()) : null}
      <Each of={kept()} key={keptSurfaceKey}>
        {(entry) => {
          // A row is made once per tab and never again: its address, terminals and split are read live from its own panel's
          // state, so a new address navigates the same WebView and a split adds a terminal beside the ones there.
          const own = untracked(entry);
          let last: Surface = untracked(() => panelStateFor(own.panelKey).surfaces.find((item) => item.id === own.id)) ?? { id: own.id, kind: own.kind };
          const live = computed(() => { const found = panelStateFor(own.panelKey).surfaces.find((item) => item.id === own.id); if (found) last = found; return last; });
          const current = computed(() => key() === own.panelKey);
          const visible = computed(() => current() && (state().open || (sheetLayer() && sheetPresence.closing())) && state().activeId === own.id);
          // The floating card: this same row, taken out of the panel's flow and placed on the chat canvas. Its place is
          // given from the row's own parent, which starts at the docked panel's content, or at the thread row while the
          // panel is closed.
          const floating = computed(() => isFloating(own));
          // Read live: the host's answer (nativeOcclusion.ts `detectWebViewsUnderSurface`) can arrive after a row is made.
          const under = () => webViewsUnderSurface();
          const card = () => {
            const frame = floatFrame();
            if (!frame) return undefined;
            const parentLeft = sheetLayer()
              ? Math.max(0, (rowWidth() ?? viewportWidth()) - panelSheetWidth(viewportWidth()))
              : docked() ? Math.max(0, (rowWidth() ?? viewportWidth()) - width()) + (edgeShown() ? 8 : 0) : 0;
            return {
              left: frame.x - parentLeft, top: chatCanvas().top + frame.y, width: frame.width, height: frame.height,
              borderRadius: MINI_PLAYER_CORNER_RADIUS, boxShadow: "0 25px 50px -12px rgba(0,0,0,0.35)",
            };
          };
          // The page inside the card: all of it where the toolbar is drawn over the page, less the strip and edge elsewhere.
          const pageScale = () => { const frame = floatFrame(); return frame ? Math.max(0.05, (frame.width - (under() ? 0 : MINI_PLAYER_STRIP_INSET * 2)) / floatSource().width) : 1; };
          return (
            <View
              class={floating() ? "absolute bg-muted" : visible() ? "min-h-0 w-full min-w-0 flex-1" : "hidden"}
              style={floating() ? card() : undefined}
              testID={`Kept tab ${own.id}`}
              accessibilityLabel={floating() ? "Floating browser preview" : undefined}
            >
              <View
                class={floating() ? "min-h-0 w-full min-w-0 flex-1 overflow-hidden" : "min-h-0 w-full min-w-0 flex-1"}
                style={floating() ? (under() ? { borderRadius: MINI_PLAYER_CORNER_RADIUS } : { borderRadius: MINI_PLAYER_CORNER_RADIUS, paddingTop: MINI_PLAYER_STRIP_HEIGHT, paddingLeft: MINI_PLAYER_STRIP_INSET, paddingRight: MINI_PLAYER_STRIP_INSET, paddingBottom: MINI_PLAYER_STRIP_INSET }) : undefined}
              >
                {own.kind === "terminal"
                  ? <TerminalSurface surface={live()} threadId={own.threadId} cwd={own.cwd} onTerminalExited={(terminalId) => closeKeptTerminal(own, terminalId)} visible={visible} />
                  : (
                    <PreviewSurface
                      surface={live()} active={visible} current={current}
                      float={{
                        floating, scale: pageScale,
                        pinned: () => current() && miniPlayerFor(own.panelKey)?.tabId === own.id,
                        onToggle: () => togglePreviewFloatAction(own.id),
                        onPageSize: (size) => { pageSizes.set(keptSurfaceKey(own), size); },
                      }}
                    />
                  )}
              </View>
              {floating() ? (
                <MiniPlayerChrome
                  frame={() => floatFrame() ?? { x: 0, y: 0, width: 0, height: 0 }}
                  source={floatSource}
                  container={floatContainer}
                  strip={!under()}
                  recording={() => isTabRecording(own.id)}
                  onMove={(position) => moveMiniPlayer(own.panelKey, own.id, position)}
                  onResize={(frame) => resizeMiniPlayer(own.panelKey, own.id, frame.width, { x: frame.x, y: frame.y })}
                  onOpenInPanel={dockMiniPlayerAction}
                  onClose={closeMiniPlayerAction}
                />
              ) : null}
            </View>
          );
        }}
      </Each>
      {floatingDevice() ? (
        <Each of={[floatDeviceKey()]} key={(item) => item}>
          {() => {
            const target = untracked(floatingDevice)!;
            const summary = () => deviceWatch.state().devices.find((entry) => entry.hostId === target.hostId && entry.id === target.deviceId);
            const hostOf = () => deviceWatch.state().hosts.find((entry) => entry.id === target.hostId);
            const radius = () => { const frame = floatFrame(); return frame ? resolveDeviceMiniPlayerCornerRadius(target.platform, frame) : MINI_PLAYER_CORNER_RADIUS; };
            const card = () => {
              const frame = floatFrame();
              if (!frame) return undefined;
              const parentLeft = sheetLayer()
                ? Math.max(0, (rowWidth() ?? viewportWidth()) - panelSheetWidth(viewportWidth()))
                : docked() ? Math.max(0, (rowWidth() ?? viewportWidth()) - width()) + (edgeShown() ? 8 : 0) : 0;
              return { left: frame.x - parentLeft, top: chatCanvas().top + frame.y, width: frame.width, height: frame.height, borderRadius: radius(), boxShadow: "0 25px 50px -12px rgba(0,0,0,0.35)" };
            };
            return (
              <View class="absolute bg-muted" style={card()} accessibilityLabel="Floating device preview">
                <View class="min-h-0 w-full min-w-0 flex-1 overflow-hidden" style={webViewsUnderSurface() ? { borderRadius: radius() } : { borderRadius: radius(), paddingTop: MINI_PLAYER_STRIP_HEIGHT, paddingLeft: MINI_PLAYER_STRIP_INSET, paddingRight: MINI_PLAYER_STRIP_INSET, paddingBottom: MINI_PLAYER_STRIP_INSET }}>
                  <DeviceStreamView
                    device={summary() ?? { hostId: target.hostId, id: target.deviceId, platform: target.platform, name: target.name, version: target.platform, booted: true, physical: false }}
                    hostLabel={hostOf()?.label ?? "Device host"}
                    hostKind={hostOf()?.kind}
                    hubBasePath={deviceWatch.state().hubBasePath}
                    visible={() => true}
                    occluded={nativeViewOccluded}
                  />
                </View>
                <MiniPlayerChrome
                  device
                  frame={() => floatFrame() ?? { x: 0, y: 0, width: 0, height: 0 }}
                  source={floatSource}
                  container={floatContainer}
                  strip={!webViewsUnderSurface()}
                  onMove={(position) => { const k = key(); if (k) moveMiniPlayer(k, deviceSurfaceId(target), position); }}
                  onResize={(frame) => { const k = key(); if (k) resizeMiniPlayer(k, deviceSurfaceId(target), frame.width, { x: frame.x, y: frame.y }); }}
                  onOpenInPanel={dockMiniPlayerAction}
                  onClose={closeMiniPlayerAction}
                />
              </View>
            );
          }}
        </Each>
      ) : null}
    </>
  );

  return (
    <>
      <DeviceSetupHost state={deviceWatch.state} />
      {panelMounted() ? (
        <View
          {...rightPanelFocus.listen}
          accessibilityLabel={docked() || sheetLayer() || floatShown() ? "Workspace panel" : undefined}
          testID="Right panel"
          accessibilityValue={{ now: width(), text: String(width()) }}
          accessibilityElementsHidden={!docked() && !floatShown() && !sheetLayer()}
          // Closed with a tab floating: the panel's view covers the thread row and takes no presses itself, so the card
          // inside it can sit anywhere over the chat. The open sheet covers it too, over its backdrop.
          // Closed and docked: stays in the flex row at width 0 (overflow-hidden, pointerEvents: none) so LayoutAnimation
          // eases width 0 <-> width() cleanly in lockstep with the chat column.
          class={sheetLayer() ? "absolute inset-0" : !docked() ? (floatShown() ? "absolute inset-0" : "relative min-h-0 shrink-0 overflow-hidden bg-background") : `relative min-h-0 overflow-hidden bg-background ${state().maximized ? "min-w-0 flex-1 border-l border-border" : "shrink-0"}`}
          style={sheetLayer() ? (sheetPresence.closing() ? { pointerEvents: "none" as const } : PASS_THROUGH) : !docked() ? (floatShown() ? PASS_THROUGH : { width: 0, pointerEvents: "none" as const }) : state().maximized ? undefined : { width: width() }}
        >
          {/* The sheet's backdrop (the reference's bg-background/88; an alpha class is squared here, so opacity). */}
          {sheetLayer() ? (
            <View class="absolute inset-0" style={backdropMotion.style}>
              <View accessibilityLabel="Close right panel sheet" class="absolute inset-0 bg-background" style={{ opacity: 0.88 }} onPress={() => closeRightPanelAction()} />
            </View>
          ) : null}
          {/* The drag edge has a strip of its own beside the content. A native web view (browser, terminal)
              is drawn above everything in its frame, so an edge laid over the content cannot be grabbed
              once such a view fills the panel. */}
          <View
            class={sheetLayer() ? "absolute inset-y-0 right-0 min-w-0 flex-row border-l border-border bg-background" : "min-h-0 flex-1 flex-row"}
            style={sheetLayer() ? { ...sheetMotion.style, width: panelSheetWidth(viewportWidth()) } : docked() ? sheetMotion.style : { ...sheetMotion.style, ...PASS_THROUGH }}
          >
            {edgeShown() ? (
              <View
                accessibilityLabel="Resize right panel"
                role="button"
                focusable={false}
                class="w-[8px] shrink-0 self-stretch"
                style={{ cursor: "col-resize" }}
                onMouseMove={resize.follow}
                onPress={() => {}}
                onPanStart={resize.handle.onPanStart}
                onPanEnd={resize.handle.onPanEnd}
              >
                {/* The reference's edge: the panel's border line at its very left, lit while dragged. */}
                <View class={`absolute inset-y-0 left-0 w-px transition-colors duration-150 ease-in-out ${resize.live() !== null ? "bg-primary" : "bg-border"}`} />
                {resize.live() !== null
                  ? <Overlay class="inset-0 z-50" accessibilityLabel="Resizing panel" style={{ cursor: "col-resize" }} onMouseMove={resize.follow} />
                  : null}
              </View>
            ) : null}
            <View class="min-h-0 min-w-0 flex-1" style={docked() || sheetLayer() ? undefined : PASS_THROUGH}>{body(false)}</View>
          </View>
        </View>
      ) : null}
      {/* The narrow-layout sheet is the panel's view above (sheetOpen), so its pages are kept. */}
    </>
  );
}

export type { SurfaceKind };
