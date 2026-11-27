// The sidebar: a resizable column (256pt by default) on --sidebar. Chrome header (wordmark), the thread header
// (search, Add project, New thread), then the list in the web's order: unsent drafts, pinned
// rows, loose rows, project folders, the Snoozed shelf and the Settled shelf, then the footer.
import { pullRequestsSupported } from "./pullRequest/pullRequestsSupported";
import { issuesSupported } from "./issue/issueStore";
import { cleanup, colorScheme, computed, effect, Image, keymap, signal, Text, token, View } from "nsh";
import { FadeScroll } from "./FadeScroll";
import { noteFocusArea, registerFocusArea } from "../commands/workspaceFocus";
import type { PressEvent, ScrollRef } from "nsh";
import { sidebarFocus } from "./focusHandBack";
import { attachSidebarScroll, beginSidebarMount, noteSidebarScroll, pendingSidebarRouteReveal, routeRevealWidensScope, sidebarRouteReveal } from "./sidebar/routeReveal";
import { projectScopeIds, setProjectScope } from "./sidebar/projectScope";
import { isListedThread } from "./sidebar/subagentRequests";
import { Input, Tooltip } from "nsh/base";
import { titleBar } from "nsh/desktop";
import { SidebarProjectFolder } from "./SidebarProjectFolder";
import { isLocalServer, splitDroppedUris } from "./composer/folderDrop";
import { openLocalWorkspace } from "../desktop/appActivationCoordinator";
import { showToast } from "./toast/toastState";
import {
  allProjects,
  backendStatus,
  backendUrl,
  openAddProjectPalette,
  openSettings,
  openThread,
  openThreadById,
  closeUtility,
  openUsage,
  openUtility,
  setSidebarThreadQuery,
  sidebarDrafts,
  toggleSidebar,
  sidebarThreadQuery,
  utilityPage,
  canLoadOlderSettled,
  loadOlderSettledPage,
  olderSettledStatus,
  retryOlderSettledPage,
  unloadedOlderSettledCount,
} from "../store";
import { SidebarThreadRow } from "./SidebarThreadRow";
import { SidebarDraftRow } from "./SidebarDraftRow";
import { SidebarDraftUndo } from "./SidebarDraftUndo";
import { bindSearchKeys, createSidebarThreadSearch, SidebarThreadSearch } from "./SidebarThreadSearch";
import { SidebarIcon as Icon } from "./SidebarIcon";
import wordmark from "./sidebar-wordmark.svg";
import { CustomSnoozeDialogHost } from "./sidebar/CustomSnoozeDialog";
import { SidebarSectionHeader, SidebarShowMore } from "./sidebar/SidebarSectionHeader";
import { SidebarThreadUndoNotice } from "./sidebar/SidebarThreadUndoNotice";
import {
  SETTLED_TAIL_PAGE_COUNT,
  settledShelfExpanded,
  settledVisibleCount,
  showMoreSettled,
  snoozedShelfExpanded,
  toggleSettledShelf,
  toggleSnoozedShelf,
  toggleWorkingShelf,
  workingShelfExpanded,
} from "./sidebar/sidebarPrefs";
import { folderThreads, hiddenSettledCount, settledThreadCount, sidebarSections, visibleSettled, visibleSnoozed, visibleWorking } from "./sidebar/sidebarModel";
import { createStableRows } from "./stableRows";
import type { SidebarSections } from "./sidebar/sidebarModel";
import type { Thread } from "../store";
import "./sidebar/sidebarKeys";
import { Glyph } from "./sidebar/SidebarGlyph";
import { activeRules } from "../commands/registry";
import { canNavigateHistory, navigateHistory, startNavigationHistory } from "./sidebar/navigationHistory";
import { bindTreeKeys } from "./sidebar/sidebarTree";
import { visibleTreeRows } from "./sidebar/sidebarTreeRows";
import { startTerminalStatus } from "./sidebar/terminalStatus";
import { startWorkingGrace } from "./sidebar/workingState";
import { startThreadVisits } from "./sidebar/threadVisits";
import { DragBoundary, DragGap, DropHint, SidebarDragLayer, dragGapAtEnd, dragTargetSection, draggingFrom, dropZone } from "./sidebar/sidebarDrag";
import { SidebarUpdateButton } from "./sidebar/SidebarUpdateButton";
import { ProviderUpdatePill } from "./sidebar/SidebarProviderUpdatePill";
import { showsUpdateEverything, SidebarUpdateEverythingButton } from "./sidebar/SidebarUpdateEverythingButton";
import { ProjectScopeMenu } from "./sidebar/ProjectScopeMenu";
import { SidebarResizeRail } from "./sidebar/SidebarResizeRail";
import { sidebarWidth } from "./sidebar/sidebarWidth";
import { mixColors } from "./sidebar/mix";
import { SidebarStageBackdrop } from "./sidebar/SidebarStageBackdrop";
import { sidebarBackdropVariant, sidebarPillLabel } from "../pages/settings/environmentIdentification";
import { MotionEach } from "./motion/Motion";
import { startNewThreadFromSidebar } from "./sidebar/newThreadAction";

const projectName = (projectId: string) => allProjects().find((project) => project.id === projectId);

function Tip(props: { label: string }) {
  return (
    <Tooltip placement="top" class="rounded-md border border-border bg-popover px-2 py-1">
      <Text class="text-xs text-popover-foreground">{props.label}</Text>
    </Tooltip>
  );
}

/** SidebarHeaderIconButton: size-7, the control radius, the sidebar hover surface. */
function HeaderButton(props: { label: string; icon: string; onPress: (event?: PressEvent) => void }) {
  return (
    <View
      accessibilityLabel={props.label}
      role="button"
      tooltip={<Tip label={props.label} />}
      class="size-7 items-center justify-center rounded-lg hover:bg-sidebar-row-hover active:scale-[0.97] transition-transform duration-150 ease-in-out"
      onPress={props.onPress}
    >
      <Icon name={props.icon} size={16} />
    </View>
  );
}

/** The ink the header controls use over the backdrop: text-white/90 and a white/10 hover. */
const ON_BACKDROP = "rgba(255,255,255,0.9)";

/** HistoryNavigationButton: size-7 media-navigation over the backdrop, a 14pt arrow, "Go back" / "Go forward" with the shortcut in the tooltip. */
function HistoryButton(props: { direction: "back" | "forward" }) {
  const label = props.direction === "back" ? "Go back" : "Go forward";
  const enabled = () => canNavigateHistory(props.direction);
  const hovered = signal(false);
  const shortcut = () => {
    const keystroke = activeRules().find((rule) => rule.command === `navigation.${props.direction}`)?.keystroke;
    try {
      return keystroke ? ` (${keymap.label(keystroke)})` : "";
    } catch {
      return "";
    }
  };
  return (
    <View
      accessibilityLabel={label}
      role="button"
      disabled={!enabled()}
      tooltip={<Tip label={`${label}${shortcut()}`} />}
      onMouseEnter={() => hovered.set(true)}
      onMouseLeave={() => hovered.set(false)}
      class={`size-7 items-center justify-center rounded-lg ${enabled() ? "" : "opacity-60"}`}
      style={{ backgroundColor: enabled() && hovered() ? "rgba(255,255,255,0.1)" : "transparent" }}
      onPress={() => navigateHistory(props.direction)}
    >
      <Glyph name={props.direction === "back" ? "arrow-left" : "arrow-right"} size={14} tint={ON_BACKDROP} />
    </View>
  );
}

/** SidebarTrigger: the panel toggle that leads the header row, beside the window controls. */
function SidebarToggle() {
  const hovered = signal(false);
  return (
    <View
      accessibilityLabel="Toggle main sidebar"
      role="button"
      tooltip={<Tip label="Toggle Sidebar" />}
      onMouseEnter={() => hovered.set(true)}
      onMouseLeave={() => hovered.set(false)}
      class="size-7 items-center justify-center rounded-lg"
      style={{ backgroundColor: hovered() ? "rgba(255,255,255,0.1)" : "transparent" }}
      onPress={toggleSidebar}
    >
      <Glyph name="panel-left-close" size={16} tint={ON_BACKDROP} />
    </View>
  );
}

/** SidebarUtilityItem: size-8 icon button. The words live on the accessible name and tooltip. */
function UtilityButton(props: { label: string; icon: string; onPress: () => void }) {
  return (
    <View
      accessibilityLabel={props.label}
      role="button"
      tooltip={<Tip label={props.label} />}
      class="size-8 items-center justify-center rounded-lg hover:bg-sidebar-row-hover active:scale-[0.97] transition-transform duration-150 ease-in-out"
      onPress={props.onPress}
    >
      <Icon name={props.icon} size={16} />
    </View>
  );
}

let sidebarFocusTarget: { focus(): void } | null = null;

function WorkingShelf(props: { sections: () => SidebarSections; row: (thread: () => Thread, variant: "card" | "slim") => ReturnType<typeof View> }) {
  return <>
    <SidebarSectionHeader label="Working" shelf="working" count={props.sections().working.length} expanded={workingShelfExpanded()} onToggle={toggleWorkingShelf} />
    <Each of={visibleWorking(props.sections())} key={(thread) => thread.id}>
      {(thread) => props.row(thread, "card")}
    </Each>
  </>;
}

export function Sidebar() {
  const fileDragActive = signal(false);
  const acceptsFolderDrop = () => backendStatus() === "connected" && isLocalServer(backendUrl());
  async function openDroppedFolders(uris: readonly string[]) {
    const endpoint = backendUrl();
    const { folders } = await splitDroppedUris(uris);
    for (const path of new Set(folders)) {
      if (backendUrl() !== endpoint || !acceptsFolderDrop()) {
        showToast({ type: "error", title: "Connect to this computer’s server to add dropped folders" });
        return;
      }
      const response = await openLocalWorkspace(path, crypto.randomUUID());
      if (!response.ok) showToast({ type: "error", title: "Could not add folder", description: response.message });
    }
  }
  const newThread = (event?: PressEvent) => {
    startNewThreadFromSidebar(event?.modifiers?.shift === true);
  };
  // ui/sidebar.tsx: a collapse with the focus in here hands it to the trigger outside (focusHandBack.ts).
  sidebarFocus.reset();
  // olderSettledShelf useOlderSettledShelfGrowth: an open shelf reads older pages while its rows cannot fill what it shows.
  effect(() => {
    const scope = projectScopeIds();
    if (!settledShelfExpanded() || olderSettledStatus(scope) !== "ready" || unloadedOlderSettledCount(new Set(scope)) === 0) return;
    if (sidebarSections(Date.now()).settled.length < settledVisibleCount()) void loadOlderSettledPage(scope);
  });
  // workspaceFocus: the sidebar area takes the keyboard at its search field.
  cleanup(registerFocusArea({ id: "sidebar", focus: () => sidebarFocusTarget?.focus(), available: () => sidebarFocusTarget !== null }));
  startThreadVisits();
  startNavigationHistory();
  startTerminalStatus();
  startWorkingGrace();
  // routeReveal: each mount and each change of the open thread scroll its row into view once;
  // a route change widens a project scope that hides the open thread (not while searching).
  beginSidebarMount();
  effect(() => {
    const open = openThread();
    const pendingKey = pendingSidebarRouteReveal(sidebarRouteReveal, open?.id ?? null);
    if (routeRevealWidensScope({ pendingKey, isSearching: sidebarThreadQuery().trim().length > 0, scopeIds: projectScopeIds(), threadProjectId: open?.projectId, listedWithoutScope: open ? isListedThread(open) : false })) {
      setProjectScope([]);
    }
  });
  const search = createSidebarThreadSearch();
  const selectThread = (id: string) => {
    openThreadById(id);
    if (sidebarThreadQuery().trim()) setSidebarThreadQuery("");
  };
  const row = (thread: () => ReturnType<typeof openThread> & object, variant: "card" | "slim") => (
    <SidebarThreadRow
      thread={thread()}
      variant={variant}
      active={openThread()?.id === thread().id}
      projectName={projectName(thread().projectId)?.name}
      projectPath={projectName(thread().projectId)?.path}
      onPress={() => selectThread(thread().id)}
    />
  );
  // Up and Down move the highlight and Escape clears, only while the field has the keyboard.
  const searchFocused = signal(false);
  const searchHovered = signal(false);
  bindTreeKeys(visibleTreeRows);
  bindSearchKeys(searchFocused, () => search.results().length > 0, search.move);
  const stablePinned = createStableRows<Thread>((thread) => thread.id);
  const stableLoose = createStableRows<Thread>((thread) => thread.id);
  const stableWorking = createStableRows<Thread>((thread) => thread.id);
  const stableSnoozed = createStableRows<Thread>((thread) => thread.id);
  const stableSettled = createStableRows<Thread>((thread) => thread.id);
  const sections = computed(() => {
    const next = sidebarSections();
    return { ...next, pinned: stablePinned("", next.pinned), loose: stableLoose("", next.loose), working: stableWorking("", next.working), snoozed: stableSnoozed("", next.snoozed), settled: stableSettled("", next.settled) };
  });
  // Keep the conditional independent of row updates: otherwise each streamed
  // shell event can tear down and recreate the entire working shelf.
  const hasWorking = computed(() => sections().working.length > 0);
  const totalThreads = () => {
    const current = sections();
    return current.pinned.length + current.loose.length + current.working.length + current.snoozed.length + current.settled.length +
      current.projects.reduce((count, project) => count + folderThreads(project).length, 0);
  };
  return (
    // bg-sidebar surface-grain: the web lays a 3.5% mid-grey noise over the sidebar, which brightens it by ~3 on the
    // dark theme; flattened here (the generator's tokens carry no grain).
    <View
      {...sidebarFocus.listen}
      class="relative border-r border-sidebar-border bg-sidebar"
      style={{ width: sidebarWidth(), backgroundColor: (colorScheme(), mixColors("#808080", token("sidebar"), 0.035)) }}
      onFileDragEnter={() => fileDragActive.set(true)}
      onFileDragLeave={() => fileDragActive.set(false)}
      onFileDrop={(event) => { fileDragActive.set(false); void openDroppedFolders(event.uris); }}
    >
      {/* SidebarStageBackdrop: the blueprint art behind the chrome header and the search row. */}
      {sidebarBackdropVariant() ? <SidebarStageBackdrop width={sidebarWidth()} variant={sidebarBackdropVariant()!} /> : null}
      {/* T3 places its brand 40px after the control origin; the toggle itself starts 1px in and is 28px wide. */}
      <View
        class="h-[52px] flex-row items-center gap-[11px] pr-3"
        style={{ paddingLeft: titleBar().left + 12 }}
        desktop={{ windowDrag: true }}
      >
        <SidebarToggle />
        <View class="flex-row items-center gap-1">
          {/* The mark is one cap-height tall and sits on the text baseline: centring a 10pt mark in the 20pt line does that (an Image has no baseline of its own). */}
          <View class="flex-row items-center gap-1">
            <Image src={wordmark} style={{ width: 17, height: 10, tintColor: sidebarBackdropVariant() ? "#ffffff" : token("sidebar-foreground") }} />
            <Text class="text-sm font-medium" style={{ color: sidebarBackdropVariant() ? "rgba(255,255,255,0.7)" : token("sidebar-muted-foreground") }}>Code</Text>
          </View>
          <View class="flex-row items-center">
            <HistoryButton direction="back" />
            <HistoryButton direction="forward" />
          </View>
          {/* environment identification "pill": the Badge (secondary, sm) with the stage name. */}
          {sidebarPillLabel() ? (
            <View class="ml-1 h-4 min-w-4 items-center justify-center rounded-[4px] bg-secondary px-[3px]" accessibilityLabel={`${sidebarPillLabel()} environment`} testID="Environment identification pill">
              <Text class="text-3xs font-medium leading-none text-secondary-foreground">{sidebarPillLabel()}</Text>
            </View>
          ) : null}
        </View>
      </View>

      {/* SidebarThreadHeader: the search field, then Add project (with projects) and New thread. */}
      <View class="flex-row items-center gap-1 p-2">
        {/* text-sidebar-muted-foreground until hovered or focused, then text-sidebar-foreground on the row-hover surface with a ring-1 inset ring-ring/70. */}
        <View
          class={`h-8 min-w-0 flex-1 flex-row items-center gap-2 rounded-md px-2 py-1.5 ${searchFocused() ? "bg-sidebar-row-hover" : "hover:bg-sidebar-row-hover"}`}
          onMouseEnter={() => searchHovered.set(true)}
          onMouseLeave={() => searchHovered.set(false)}
        >
          {searchFocused() ? <View class="absolute inset-0 rounded-md border border-ring" style={{ pointerEvents: "none" }} /> : null}
          <Icon name="search" size={16} />
          <Input
            value={sidebarThreadQuery()}
            placeholder="Search"
            accessibilityLabel="Search threads"
            ref={(node: { focus(): void } | null) => { sidebarFocusTarget = node; }}
            onChange={(event) => setSidebarThreadQuery(event.value)}
            onFocus={() => { searchFocused.set(true); noteFocusArea("sidebar"); }}
            onBlur={() => searchFocused.set(false)}
            onSubmit={() => search.openHighlighted(selectThread)}
            class="h-8 min-w-0 flex-1 bg-transparent text-sm font-medium"
            style={{ color: searchFocused() || searchHovered() || sidebarThreadQuery().length > 0 ? token("sidebar-foreground") : token("sidebar-muted-foreground"), placeholderColor: token("sidebar-foreground") }}
          />
          {sidebarThreadQuery().trim().length > 0 ? (
            <View
              accessibilityLabel="Clear thread search"
              // Button size icon-micro variant ghost-muted: size-5 rounded-sm, `[:hover]:bg-accent`.
              class="size-5 items-center justify-center rounded-sm hover:bg-accent active:scale-[0.97] transition-transform duration-150 ease-in-out"
              onPress={() => setSidebarThreadQuery("")}
            >
              <Icon name="x" size={12} />
            </View>
          ) : null}
        </View>
        <View class="flex-row items-center">
          {allProjects().length > 0 ? (
            <>
              <ProjectScopeMenu />
              <HeaderButton label="Add project" icon="folder-plus" onPress={openAddProjectPalette} />
            </>
          ) : null}
          <HeaderButton label="New thread" icon="square-pen" onPress={newThread} />
        </View>
      </View>

      <FadeScroll
        class="flex-1"
        contentClass="grow gap-px px-2 pb-2"
        fadeColor={() => (colorScheme(), mixColors("#808080", token("sidebar"), 0.035))}
        ref={(node: ScrollRef | null) => attachSidebarScroll(node)}
        onScroll={(event) => noteSidebarScroll(event.offset.y)}
      >
        {sidebarThreadQuery().trim() ? <SidebarThreadSearch search={search} onSelect={selectThread} /> : <>
        <Each of={sidebarDrafts()} key={(thread) => `draft:${thread.id}`}>
          {(thread) => (
            <SidebarDraftRow
              thread={thread}
              active={openThread()?.id === thread().id}
              onSelect={() => selectThread(thread().id)}
            />
          )}
        </Each>
        <View class="gap-px" {...dropZone("pinned")}>
          <DragBoundary section="pinned" label="Pinned" />
          <MotionEach of={() => sections().pinned} key={(t) => t.id}>
            {(thread) => row(thread, "card")}
          </MotionEach>
          {dragGapAtEnd("pinned") ? <DragGap /> : null}
        </View>
        <View class="gap-px" {...dropZone("active")}>
          <DragBoundary section="active" label="Active" />
          <DropHint
            section="active"
            label="Active"
            show={draggingFrom() !== null && sections().loose.length === 0 && sections().projects.every((project) => folderThreads(project).length === 0)}
          />
          <MotionEach of={() => sections().loose} key={(t) => t.id}>
            {(thread) => row(thread, "card")}
          </MotionEach>
          {dragGapAtEnd("active") ? <DragGap /> : null}
          <Each of={sections().projects} key={(p) => p.id}>
            {(project) => <SidebarProjectFolder project={project} />}
          </Each>
        </View>

        {/* Empty state sits with the main list (not the bottom shelves below), right under the header,
            matching the reference (apps/web/src/components/Sidebar.tsx): it is the only content when
            there is nothing else, not a block pushed to the bottom by the shelves' own mt-auto. */}
        {totalThreads() === 0 && sidebarDrafts().length === 0 ? (
          <View class="items-center gap-2 px-2 py-6">
            {allProjects().length === 0 ? (
              <>
                <Text class="text-center text-xs text-muted-foreground">No projects yet</Text>
                <View
                  role="button"
                  accessibilityLabel="Add project"
                  onPress={openAddProjectPalette}
                  class="h-6 flex-row items-center gap-1.5 rounded-md border border-sidebar-border px-2.5 hover:bg-sidebar-row-hover transition-colors duration-150 ease-in-out"
                >
                  <View class="-mx-0.5"><Icon name="plus" size={12} /></View>
                  <Text class="text-2xs font-medium text-sidebar-muted-foreground">Add project</Text>
                </View>
              </>
            ) : (
              <Text class="text-center text-xs text-muted-foreground">
                {allProjects().length === 1 ? `No threads in ${allProjects()[0].name} yet` : "No threads yet"}
              </Text>
            )}
          </View>
        ) : null}

        {/* The shelves sit at the bottom of the list (mt-auto on the first header): Working, Snoozed, Settled. */}
        <View class="mt-auto gap-px pt-2">
          {hasWorking() ? (
            <WorkingShelf sections={sections} row={row} />
          ) : null}
          {sections().snoozed.length > 0 ? (
            <>
              <SidebarSectionHeader
                label="Snoozed"
                shelf="snoozed"
                count={sections().snoozed.length}
                expanded={snoozedShelfExpanded()}
                onToggle={toggleSnoozedShelf}
              />
              <MotionEach of={() => visibleSnoozed(sections())} key={(t) => t.id}>
                {(thread) => row(thread, "slim")}
              </MotionEach>
            </>
          ) : null}
          {allProjects().length > 0 ? (
            <View class="gap-px" {...dropZone("settled")}>
              <SidebarSectionHeader
                label="Settled"
                shelf="settled"
                count={settledThreadCount(sections())}
                expanded={settledShelfExpanded()}
                onToggle={toggleSettledShelf}
                dropTarget={dragTargetSection() === "settled"}
                dragging={draggingFrom() !== null}
              />
              <DropHint section="settled" label="Settled" show={draggingFrom() !== null && visibleSettled(sections()).length === 0} />
              <MotionEach of={() => visibleSettled(sections())} key={(t) => t.id}>
                {(thread) => row(thread, "slim")}
              </MotionEach>
              {hiddenSettledCount(sections()) > 0 ? (
                <SidebarShowMore
                  label={olderSettledStatus(projectScopeIds()) === "pending" ? "Loading" : olderSettledStatus(projectScopeIds()) === "failed" ? "Could not load older threads. Retry" : `Show ${Math.min(hiddenSettledCount(sections()), SETTLED_TAIL_PAGE_COUNT)} more`}
                  disabled={olderSettledStatus(projectScopeIds()) === "pending" || (sections().settled.length <= settledVisibleCount() && !canLoadOlderSettled(projectScopeIds()))}
                  onPress={() => { if (olderSettledStatus(projectScopeIds()) === "failed") void retryOlderSettledPage(projectScopeIds()); showMoreSettled(); }}
                />
              ) : null}
            </View>
          ) : null}
        </View>
        </>}
      </FadeScroll>

      <CustomSnoozeDialogHost />
      <SidebarDragLayer />

      {/* SidebarChromeFooter. A utility page shows ArrowLeft plus the word Back. Otherwise the
          trio is icon buttons: Settings, Pull requests, Usage. */}
      <View class="gap-1 px-2 pt-1 pb-2">
      <ProviderUpdatePill />
      <View class="flex-row items-center gap-1">
        {utilityPage() !== null ? (
          <View
            accessibilityLabel="Back"
            role="button"
            class="h-8 min-w-0 flex-1 flex-row items-center gap-2 rounded-lg px-2.5 hover:bg-sidebar-row-hover"
            onPress={closeUtility}
          >
            <Icon name="arrow-left" size={16} />
            <Text class="text-sm font-medium text-sidebar-muted-foreground">Back</Text>
          </View>
        ) : (
          <View class="flex-row items-center gap-1">
            <UtilityButton label="Settings" icon="settings" onPress={() => openSettings()} />
            {pullRequestsSupported() ? <UtilityButton label="Pull requests" icon="git-pull-request-arrow" onPress={() => openUtility("pull-requests")} /> : null}
            {issuesSupported() ? <UtilityButton label="Issues" icon="circle-dot" onPress={() => openUtility("issues")} /> : null}
            <UtilityButton label="Usage" icon="chart-no-axes-column" onPress={openUsage} />
          </View>
        )}
        <SidebarThreadUndoNotice />
        <SidebarDraftUndo />
        <SidebarUpdateEverythingButton />
        {showsUpdateEverything() ? null : <SidebarUpdateButton />}
      </View>
      </View>
      <SidebarResizeRail />
      {fileDragActive() && acceptsFolderDrop() ? (
        <View class="absolute inset-2 z-40 items-center justify-center rounded-xl border-2 border-dashed border-primary" style={{ pointerEvents: "none" }}>
          <Text class="rounded-lg bg-background px-3 py-2 text-sm font-medium text-foreground">Drop folders to add projects</Text>
        </View>
      ) : null}
    </View>
  );
}
