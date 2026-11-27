// The thread view's top bar: ChatHeader.tsx's breadcrumb (project / title, with
// the title's action menu and in-place rename) and the panel layout controls at
// the right. While the right panel is open the controls move into its tab bar,
// as in ChatView.
import { cleanup, effect, signal, Text, token, untracked, View } from "nsh";
import { Icon } from "../Icons";
import { textDirection } from "../../textDirection";
import type { ViewRef } from "nsh";
import { ContextMenu, Input, Menu, MenuItem, Tooltip } from "nsh/base";
import { MENU_ITEM_ROW_CLASS } from "../menuStyles";
import { allProjects, allThreads, backendStatus, createThread, isServerThread, openThread, openThreadById, renameThread, requestBackend, settingValue, sidebarOpen, toggleSidebar } from "../../store";
import { Glyph } from "../sidebar/SidebarGlyph";
import { titleBar } from "nsh/desktop";
import type { Thread } from "../../store";
import { showSidebarProjectSettings } from "../SidebarProjectSettingsState";
import { requestCustomSnooze } from "../sidebar/CustomSnoozeDialog";
import { ProjectTile } from "../sidebar/ProjectTile";
import { projectScopeIds, toggleProjectScope } from "../sidebar/projectScope";
import { resolveSnoozePresets, snoozePresetsFromSetting } from "../sidebar/snooze";
import { hasCommandHandler } from "../../commands/registry";
import { buildThreadMenu, createThreadOnBranch, runThreadAction, threadMenuState } from "../sidebar/threadActions";
import type { ThreadMenuId } from "../sidebar/threadActions";
import { useOverlayOpen } from "../rightPanel/nativeOcclusion";
import { MENU_POPUP_CLASS, ThreadMenuItems } from "../sidebar/ThreadMenu";
import { HIcon } from "./HeaderIcons";
import { resolveRenameCommit, shouldCollapseParentTitle } from "./headerLogic";
import { isScratchProjectPath, scratchWorkspaceRoot } from "../sidebar/serverFacts";
import { ORCHESTRATION_OPERATE_SCOPE, scopeAllows } from "../../backend/sessionScopes";
import { guestShareLabel, parentBreadcrumbTitle, type ThreadRelations } from "./threadRelations";
import { PanelLayoutControls } from "./PanelLayoutControls";
import { currentPanelKey, panelStateFor } from "../rightPanel/panelState";
import { ThreadDetailsCard } from "./ThreadDetailsCard";
import { showToast } from "../toast";
import { handFocusBack, sidebarFocus, sidebarTrigger } from "../focusHandBack";
import { formatSubagentDisplayTitle } from "./lineageLogic";

export interface HeaderThread { id: string; title: string; status: string; pinned: boolean; path?: string; relations?: ThreadRelations }

export interface ThreadHeaderProps {
  thread?: () => HeaderThread | undefined;
  project?: () => { id: string; name: string; path?: string } | undefined;
  isServer?: () => boolean;
  onRename?: (threadId: string, title: string) => void;
  onNewThread?: (projectId: string) => void;
  /** Opens the parent thread; defaults to the store. */
  onOpenThread?: (threadId: string) => void;
  /** Ends the guest share; defaults to `thread.guest-share.close`. */
  onStopGuestShare?: (threadId: string) => Promise<void> | void;
  /** The parent thread's title, when this client knows the parent. */
  parentTitle?: (parentId: string) => string | undefined;
}

export function ThreadHeader(props: ThreadHeaderProps = {}) {
  const renamingId = signal<string | null>(null);
  const draft = signal("");
  const menuOpen = signal(false);
  const contextOpen = signal(false);
  // The title menu drops over the page below the header (a native web view): it steps aside while open.
  useOverlayOpen(() => menuOpen() || contextOpen(), "thread title menu");
  const titleHover = signal(false);
  const headerNode = signal<ViewRef | null>(null);
  // moveFocusOutOfCollapsingSidebar: collapsing the sidebar with the focus in it gives the focus to this header's
  // toggle, which mounts with the collapse (focusHandBack.ts, host patch 0013).
  let sidebarWasOpen = sidebarOpen();
  effect(() => {
    const open = sidebarOpen();
    untracked(() => { if (sidebarWasOpen && !open) handFocusBack(sidebarFocus, sidebarTrigger); });
    sidebarWasOpen = open;
  });
  let renameDone = false;
  const thread = props.thread ?? (() => openThread());
  const project = props.project ?? (() => allProjects().find((item) => item.id === openThread()?.projectId));
  /** ChatHeader activeProjectName: the scratch project reads "No project". */
  const projectName = () => { const current = project(); return current && isScratchProjectPath(current.path, scratchWorkspaceRoot()) ? "No project" : current?.name; };
  const server = props.isServer ?? (() => {
    const current = openThread();
    return Boolean(current && isServerThread(current.id));
  });
  const renaming = () => renamingId() !== null && renamingId() === thread()?.id;
  const panelOpen = () => panelStateFor(currentPanelKey()).open;
  const crumbWidth = signal(0);
  const collapseParent = () => crumbWidth() > 0 && shouldCollapseParentTitle({ available: crumbWidth(), projectName: projectName() ?? null, parentTitle: parentTitle(), title: titleText() });
  const parentId = () => thread()?.relations?.parentThreadId ?? null;
  const parentTitle = () => {
    const id = parentId();
    return parentBreadcrumbTitle(id ? (props.parentTitle ? props.parentTitle(id) : allThreads().find((item) => item.id === id)?.title) : undefined);
  };
  const openParent = () => { const id = parentId(); if (id) (props.onOpenThread ?? openThreadById)(id); };
  const share = () => thread()?.relations?.guestShare ?? null;
  const now = signal(new Date().toISOString());
  const nowTimer = setInterval(() => now.set(new Date().toISOString()), 30000);
  cleanup(() => clearInterval(nowTimer));
  const stopping = signal(false);
  async function stopSharing() {
    const current = thread();
    if (!current || stopping()) return;
    stopping.set(true);
    try {
      if (props.onStopGuestShare) await props.onStopGuestShare(current.id);
      else await requestBackend("orchestration.dispatchCommand", { type: "thread.guest-share.close", threadId: current.id, commandId: `command:${crypto.randomUUID()}` });
    } catch (cause) { showToast({ type: "error", title: "Failed to stop guest share", description: cause instanceof Error ? cause.message : undefined }); }
    stopping.set(false);
  }

  function startRename() {
    const current = thread();
    // ChatHeader: rename needs orchestration:operate.
    if (!current || !server() || !scopeAllows(ORCHESTRATION_OPERATE_SCOPE)) return;
    renameDone = false;
    menuOpen.set(false);
    draft.set(current.title);
    renamingId.set(current.id);
  }
  function commitRename() {
    if (renameDone || !renaming()) return;
    renameDone = true;
    const current = thread();
    renamingId.set(null);
    if (!current) return;
    const resolution = resolveRenameCommit({ title: draft(), originalTitle: current.title });
    if (resolution.action === "reject-empty") showToast({ type: "warning", title: "Thread title cannot be empty" });
    else if (resolution.action === "commit") (props.onRename ?? renameThread)(current.id, resolution.title);
  }
  function cancelRename() {
    renameDone = true;
    renamingId.set(null);
  }
  const presets = () => resolveSnoozePresets(new Date(), snoozePresetsFromSetting(settingValue("snoozePresets")));
  // The sidebar's own menu builder, so the title menu and a row's menu match useThreadActionMenu.
  const menuThread = (): Thread | null => {
    const current = thread();
    if (!current) return null;
    const stored = allThreads().find((item) => item.id === current.id);
    if (stored) return stored;
    return {
      id: current.id,
      projectId: project()?.id ?? "",
      title: current.title,
      status: current.status as Thread["status"],
      pinned: current.pinned,
      updatedAt: 0,
      path: current.path,
      relations: current.relations,
    };
  };
  const menuItems = () => {
    const current = menuThread();
    if (!current) return [];
    return buildThreadMenu(threadMenuState({
      thread: current,
      now: Date.now(),
      connected: backendStatus() === "connected",
      hasProject: Boolean(project()),
      presets: presets(),
      project: project() ?? undefined,
      scopeIds: projectScopeIds(),
      omitProjectFilter: true,
      // "Find in thread" runs `chat.find`, which the thread view registers.
      canFind: server() && hasCommandHandler("chat.find"),
    }));
  };
  const onMenuSelect = (id: ThreadMenuId) => {
    const current = menuThread();
    if (!current) return;
    menuOpen.set(false);
    void runThreadAction(id, {
      thread: current,
      startRename,
      requestCustomSnooze,
      presets: presets(),
      projectPath: project()?.path,
      toggleProjectFilter: () => { if (current.projectId) toggleProjectScope(current.projectId); },
      newThreadOnBranch: (branch, worktreePath) => createThreadOnBranch(current.projectId || null, branch, worktreePath),
    });
  };

  const titleText = () => {
    const current = thread();
    if (!current) return "No active thread";
    return current.relations?.lineage?.relationshipToParent === "subagent" ? formatSubagentDisplayTitle(current.title) : current.title;
  };

  return (
    <View ref={(node) => headerNode.set(node)} class="relative h-[52px] shrink-0 flex-row items-center gap-3 bg-background" style={{ paddingLeft: sidebarOpen() ? 20 : titleBar().left + 20, paddingRight: (panelOpen() ? 0 : titleBar().right) + 13, paddingTop: 2 }} desktop={{ windowDrag: true }} testID="Thread header">
      {/* With the sidebar collapsed its own toggle is gone, so the header carries one (the web's SidebarTrigger). */}
      {sidebarOpen() ? null : (
        <View ref={sidebarTrigger.ref} accessibilityLabel="Toggle main sidebar" role="button" desktop={{ windowDrag: false }} onPress={toggleSidebar} class="size-7 shrink-0 items-center justify-center rounded-lg hover:bg-accent active:scale-[0.97] transition-transform duration-150 ease-in-out">
          <Glyph name="panel-left-close" size={16} />
        </View>
      )}
      <View class="min-w-0 flex-1" role="navigation" accessibilityLabel="Thread breadcrumb" onLayout={(event) => crumbWidth.set(event.bounds.size.width)}>
      <ContextMenu
        popupClass={MENU_POPUP_CLASS}
        onOpenChange={(event) => contextOpen.set(event.open)}
        disabled={renaming() || (!server() && !project())}
        trigger={
        <View class="min-w-0 flex-row items-center gap-3">
          {project() ? (
            <>
              <View
                role="button"
                accessibilityLabel={`New thread in ${projectName()}`}
                tooltip={<Tooltip class="rounded-md border border-border bg-popover px-2 py-1"><Text class="text-xs text-popover-foreground">{`New thread in ${projectName()}`}</Text></Tooltip>}
                desktop={{ windowDrag: false }}
                onPress={() => { const id = project()?.id ?? null; if (props.onNewThread && id) props.onNewThread(id); else createThread(id); }}
                class="shrink flex-row items-center gap-1.5 rounded-sm"
              >
                <ProjectTile name={project()?.name ?? ""} size={14} projectId={project()?.id} />
                <Text class="max-w-40 truncate text-sm font-medium text-muted-foreground hover:text-foreground transition-colors duration-150 ease-in-out">{projectName() ?? ""}</Text>
              </View>
              <Text class="shrink-0 text-sm text-icon-muted">/</Text>
            </>
          ) : null}
          {parentId() ? (
            <>
              <View
                role="button"
                accessibilityLabel={`Open parent thread: ${parentTitle()}`}
                tooltip={<Tooltip class="rounded-md border border-border bg-popover px-2 py-1"><Text class="text-xs text-popover-foreground">{parentTitle()}</Text></Tooltip>}
                desktop={{ windowDrag: false }}
                onPress={openParent}
                class="shrink flex-row items-center rounded-sm"
              >
                <Text class="max-w-40 truncate text-sm font-medium text-muted-foreground hover:text-foreground transition-colors duration-150 ease-in-out">{collapseParent() ? "..." : parentTitle()}</Text>
              </View>
              <Text class="shrink-0 text-sm text-icon-muted">/</Text>
            </>
          ) : null}
          <View class="min-w-10 flex-1 flex-row items-center gap-2">
            {renaming() ? (
              <Input
                autoFocus
                accessibilityLabel="Thread title"
                value={draft()}
                onChange={(event) => draft.set(event.value)}
                onSubmit={commitRename}
                onBlur={commitRename}
                onKeyPress={(event) => { if (event.key === "Escape") cancelRename(); }}
                class="h-7 min-w-0 flex-1 rounded-sm border border-ring bg-transparent px-1 text-sm font-medium text-foreground"
              />
            ) : server() ? (
              <Menu
                popupClass={MENU_POPUP_CLASS}
                // ui/menu.tsx MenuPopup sideOffset 4.
                offset={4}
                open={menuOpen()}
                onOpenChange={(event) => menuOpen.set(event.open)}
                trigger={
                  <View
                    role="button"
                    accessibilityLabel={`Thread actions for ${titleText()}`}
                    tooltip={<Tooltip class="rounded-md border border-border bg-popover px-2 py-1"><Text class="text-xs text-popover-foreground">{titleText()}</Text></Tooltip>}
                    desktop={{ windowDrag: false }}
                    onPress={(event) => { if (event.clickCount >= 2) startRename(); }}
                    onMouseEnter={() => titleHover.set(true)}
                    onMouseLeave={() => titleHover.set(false)}
                    class="group min-w-0 shrink flex-row items-center gap-1 rounded-sm"
                  >
                    <Text class="min-w-0 truncate text-sm font-medium text-foreground" style={{ writingDirection: textDirection(titleText()) ?? "auto" }}>{titleText()}</Text>
                    <View class="size-[14px] transition-opacity" style={{ opacity: titleHover() || menuOpen() ? 1 : 0 }}><HIcon name="chevron-down" size={14} /></View>
                  </View>
                }
              >
                <ThreadMenuItems items={menuItems()} onSelect={onMenuSelect} />
              </Menu>
            ) : (
              <Text accessibilityLabel={titleText()} class="min-w-0 flex-1 truncate text-sm font-medium text-foreground" style={{ writingDirection: textDirection(titleText()) ?? "auto" }}>{titleText()}</Text>
            )}
            {!renaming() && thread()?.relations?.linkOrigin ? (
              <View
                tooltip={<Tooltip class="max-w-80 rounded-md border border-border bg-popover px-2 py-1"><Text class="text-xs text-popover-foreground">{`Started by an agent on ${thread()?.relations?.linkOrigin} through a linked environment.`}</Text></Tooltip>}
                class="h-5 shrink-0 items-center justify-center rounded-sm bg-info-28 px-1.5 dark:bg-info-40"
              >
                <Text class="text-xs text-info-foreground">{`From ${thread()?.relations?.linkOrigin}`}</Text>
              </View>
            ) : null}
          </View>
        </View>
        }
      >
        {server() ? (
          <ThreadMenuItems items={menuItems()} onSelect={onMenuSelect} />
        ) : (
          <MenuItem accessibilityLabel="Project settings" class={MENU_ITEM_ROW_CLASS} onSelect={() => { const id = project()?.id; if (id) showSidebarProjectSettings(id); }}>
            <Icon name="settings" size={16} tint={token("muted-foreground")} />
            <Text class="flex-1 truncate text-sm text-popover-foreground">Project settings</Text>
          </MenuItem>
        )}
      </ContextMenu>
      </View>
      {server() && share() ? (
        <View class="shrink-0 flex-row items-center gap-1" accessibilityLabel="Guest share" desktop={{ windowDrag: false }}>
          <HIcon name="user" size={14} />
          <Text class="text-xs text-muted-foreground">{guestShareLabel(share()!, now())}</Text>
          <View
            role="button"
            accessibilityLabel="Stop sharing"
            disabled={stopping()}
            onPress={() => { void stopSharing(); }}
            class={`h-6 items-center justify-center rounded-md px-2 ${stopping() ? "opacity-64" : "hover:bg-accent"}`}
          >
            <Text class="text-xs text-muted-foreground">Stop sharing</Text>
          </View>
        </View>
      ) : null}
      <PanelLayoutControls show={panelOpen() ? "details" : "all"} />
      <ThreadDetailsCard anchor={headerNode} />
    </View>
  );
}
