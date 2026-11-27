// The Pull requests page, ported from components/pullRequest/PullRequestsPage.tsx and
// PullRequestsColumn.tsx. List state lives in pullRequestListModel; this file lays it out.
import { colorScheme, effect, openUrl, Scroll, signal, Storage, Text, untracked, View, windowSize } from "nsh";
import { titleBar } from "nsh/desktop";
import { pullRequestPanelWidth } from "../components/rightPanel/panelLogic";
import { createLiveResize } from "../components/rightPanel/liveResize";
import { createPullRequestPanelWidth } from "../components/pullRequest/pullRequestPanelWidth";
import { Menu as PopupMenu, MenuItem } from "nsh/base";
import { createPullRequestLinkPreviewModel, PullRequestLinkPreview } from "../components/pullRequest/PullRequestLinkPreview";
import { setMarkdownLinkInterceptor } from "../components/thread/markdown/ChatMarkdown";
import { setActivePullRequest } from "../components/pullRequest/activePullRequest";
import { BranchMark, PRIcon } from "../components/pullRequest/PRIcon";
import { PullRequestListGhost } from "../components/pullRequest/PullRequestGhosts";
import { PullRequestDetailPanel } from "../components/pullRequest/PullRequestDetailPanel";
import type { DiffFetchDeps } from "../components/pullRequest/pullRequestDiff.logic";
import { createPullRequestDetailModel } from "../components/pullRequest/pullRequestDetailModel";
import { entryKey } from "../components/pullRequest/pullRequestList.logic";
import { PullRequestCondensedTopbar, PullRequestListToolbar } from "../components/pullRequest/PullRequestListFilters";
import { PullRequestListEmptyState, PullRequestsUnavailableState } from "../components/pullRequest/PullRequestListEmptyState";
import { PullRequestListGroups } from "../components/pullRequest/PullRequestListGroups";
import { createPullRequestListModel } from "../components/pullRequest/pullRequestListModel";
import { consumePendingGuideOpen, guideRunKey, pendingGuideOpen, setShownGuide } from "../components/pullRequest/guide/guideRunCoordinator";
import { allProjects, backendBearer, backendError, backendUrl, backendStatus, createThread, openAddProjectPalette, openSettings, openThread, openThreadById, requestBackend, requestBackendUnrouted, setComposerDraft, setWorkspaceStrategy, sidebarOpen, subscribeBackend, supportsPullRequestChecks } from "../store";
import { invalidatePullRequests, usePullRequestRefreshes, type Subscribe } from "../components/pullRequest/pullRequestState";
import { PRIMARY_ROUTING_ENVIRONMENT } from "../components/pullRequest/pullRequestRoutingInstall";
import { showToast, updateToast } from "../components/toast";
import { changeRequestTerm } from "../components/pullRequest/pullRequestCheckout.logic";
import { createPullRequestHandoffModel } from "../components/pullRequest/pullRequestHandoffModel";
import { pullRequestsSupported } from "../components/pullRequest/pullRequestsSupported";
import { createPullRequestCheckoutModel, type CheckoutToasts, type CheckoutWorkspace } from "../components/pullRequest/pullRequestCheckoutModel";
import type { PullRequestEntry } from "./utility-data";
import { useLiveRefresh } from "../components/coordinators/liveRefresh";
import { MENU_ITEM_ROW_CLASS, MENU_POPUP_CLASS } from "../components/menuStyles";
import { createPullRequestMultiEnvironment, type PullRequestEnvironmentTarget } from "../components/pullRequest/pullRequestMultiEnvironment";
import { environmentConfigs, environmentConnections, managedEnvironment, managedEnvironmentIds, parseScopedKey, requestEnvironment, routePayload, scopeResult, subscribeEnvironment } from "../environments/connectionManager";
import { serverEnvironment } from "./settings/settingsState";
import { loadSessionBearer } from "../backend/sessionCredential";
import { retainPullRequestRefreshes, pullRequestRefreshTick } from "../components/pullRequest/pullRequestState";

const primaryId = () => typeof serverEnvironment()?.environmentId === "string" ? String(serverEnvironment()!.environmentId) : PRIMARY_ROUTING_ENVIRONMENT;
const environmentForProject = (projectId: string) => parseScopedKey(projectId)?.environmentId ?? primaryId();
const pullRequestEnvironments = (): PullRequestEnvironmentTarget[] => {
  const connections = environmentConnections();
  const label = serverEnvironment()?.label;
  return [
    { id: primaryId(), label: typeof label === "string" && label ? label : "This machine", connected: backendStatus() === "connected" },
    ...managedEnvironmentIds().flatMap((id) => { const env = managedEnvironment(id); return env?.enabled && id !== primaryId() ? [{ id, label: env.label, connected: connections[id]?.phase === "connected" }] : []; }),
  ];
};
const multiEnvironment = createPullRequestMultiEnvironment({
  environments: pullRequestEnvironments,
  environmentForProject,
  request: (id, method, payload) => {
    if (id === primaryId()) return requestBackendUnrouted(method, payload);
    const routed = routePayload(payload);
    if (routed && routed.environmentId !== id) return Promise.reject(new Error("The selected project belongs to another environment."));
    return requestEnvironment(id, method, routed?.payload ?? payload).then((value) => scopeResult(id, value));
  },
});

export interface PullRequestsDeps {
  request: (method: string, payload: unknown) => Promise<unknown>;
  /** The refresh stream's transport (pullRequests.subscribeRefreshes); defaults to the connected environment. */
  subscribe?: Subscribe;
  /** environment.capabilities.pullRequestChecks; defaults to the connected environment's. */
  supportsChecks?: () => boolean;
  status: () => "disconnected" | "connecting" | "connected" | "error";
  hasProjects: () => boolean;
  /** The projects the list can be scoped to; defaults to the app's. */
  projects?: () => { id: string; title: string }[];
  debounceMs?: number;
  cacheNamespace?: () => string;
  environments?: () => readonly PullRequestEnvironmentTarget[];
  environmentForProject?: (projectId: string) => string;
  multiEnvironment?: ReturnType<typeof createPullRequestMultiEnvironment>;
  /** How the diff is fetched over HTTP; defaults to the connected environment. */
  http?: DiffFetchDeps;
  /** What Check out reaches in the app (the project's folder, a new thread, the toasts); defaults to the store's. */
  /** Puts the task in the composer of the thread a handoff opened; defaults to the store's. */
  setDraft?: (text: string) => void;
  /** The app's threads (the picker and the linked-threads list); defaults to the store's. */
  threads?: { all: () => { id: string; title: string; projectId: string; updatedAt: number }[]; projectName: (projectId: string) => string; open: (threadId: string) => void };
  /** Linking threads needs an environment's config; defaults to the Pull requests entry's own rule. */
  threadLinksSupported?: () => boolean;
  checkout?: {
    projectPath: (projectId: string) => string | null;
    newThread: (projectId: string) => string | null;
    selectWorkspace: (workspace: CheckoutWorkspace) => void;
    toasts: CheckoutToasts;
  };
}

export function PullRequests() {
  return <PullRequestsPage
    request={(method, payload) => requestBackend(method, payload)}
    status={() => pullRequestEnvironments().some((environment) => environment.connected) ? "connected" : backendStatus()}
    hasProjects={() => allProjects().length > 0}
    cacheNamespace={() => JSON.stringify([backendUrl(), backendBearer(), pullRequestEnvironments().map((environment) => [environment.id, environment.connected])])}
    environments={pullRequestEnvironments}
    environmentForProject={environmentForProject}
    multiEnvironment={multiEnvironment}
  />;
}

export function PullRequestsPage(deps: PullRequestsDeps) {
  const initialDetailWidth = Math.floor(windowSize().width / 2);
  const pageWidth = signal(windowSize().width);
  const panelWidth = createPullRequestPanelWidth(Storage);
  const clampDetailWidth = (width: number) => pullRequestPanelWidth(width, windowSize().width, pageWidth());
  const resize = createLiveResize({ axis: "x", direction: -1, size: () => clampDetailWidth(panelWidth.saved() ?? initialDetailWidth), clamp: clampDetailWidth, commit: panelWidth.commit });
  const model = createPullRequestListModel({
    request: deps.request,
    connected: () => deps.status() === "connected",
    hasProjects: deps.hasProjects,
    projects: deps.projects ?? (() => allProjects().map((project) => ({ id: project.id, title: project.name }))),
    ...(deps.debounceMs === undefined ? {} : { debounceMs: deps.debounceMs }),
    ...(deps.cacheNamespace ? { cacheNamespace: deps.cacheNamespace } : {}),
    ...(deps.environments ? { environments: deps.environments } : {}),
    ...(deps.environmentForProject ? { environmentForProject: deps.environmentForProject } : {}),
    ...(deps.multiEnvironment ? { multiEnvironment: deps.multiEnvironment } : {}),
  });
  const selected = signal<PullRequestEntry | null>(null);
  const openTabs = signal<PullRequestEntry[]>([]);
  const detailMaximized = signal(false);
  effect(() => {
    if (!selected() || detailMaximized()) untracked(() => resize.cancel());
  });
  const selectPullRequest = (entry: PullRequestEntry) => {
    const tabs = openTabs();
    openTabs.set(tabs.some((tab) => entryKey(tab) === entryKey(entry))
      ? tabs.map((tab) => entryKey(tab) === entryKey(entry) ? entry : tab)
      : [...tabs, entry]);
    selected.set(entry);
  };
  const closePullRequest = (entry: PullRequestEntry) => {
    const tabs = openTabs();
    const index = tabs.findIndex((tab) => entryKey(tab) === entryKey(entry));
    const remaining = tabs.filter((tab) => entryKey(tab) !== entryKey(entry));
    openTabs.set(remaining);
    if (selected() && entryKey(selected()!) === entryKey(entry)) selected.set(remaining[Math.min(index, remaining.length - 1)] ?? null);
    if (remaining.length === 0) detailMaximized.set(false);
  };
  const selectedEnvironment = () => { const id = selected() && deps.environmentForProject ? deps.environmentForProject(selected()!.projectId) : primaryId(); return id === primaryId() ? PRIMARY_ROUTING_ENVIRONMENT : id; };
  const detailSubscribe: Subscribe = (method, payload, onValue, onError) => {
    const id = selectedEnvironment();
    return deps.multiEnvironment && id !== PRIMARY_ROUTING_ENVIRONMENT ? subscribeEnvironment(id, method, payload, onValue, onError) : (deps.subscribe ?? subscribeBackend)(method, payload, onValue, onError);
  };
  const detailHttp: DiffFetchDeps = deps.http ?? { endpoint: backendUrl, bearer: backendBearer, fetch, ...(deps.multiEnvironment ? { resolve: async (ref) => {
    const scoped = parseScopedKey(ref.projectId);
    if (!scoped) return { endpoint: backendUrl(), bearer: backendBearer(), ref };
    const environment = managedEnvironment(scoped.environmentId);
    if (!environment || environment.relay) throw new Error("This environment does not provide an authorized HTTP diff endpoint.");
    return { endpoint: environment.url, bearer: await loadSessionBearer(environment.url), ref: { ...ref, projectId: scoped.localId } };
  } } : {}) };
  const detail = createPullRequestDetailModel({ request: deps.request, entry: () => selected(), isListed: (entry) => model.view().entries.some((row) => entryKey(row) === entryKey(entry)), http: detailHttp, threadLinks: { supported: deps.threadLinksSupported ?? pullRequestsSupported, toast: (input) => { showToast(input); } }, onAction: (action) => { const current = selected(); if (current && action !== "merge") model.recordAction(current, action); }, live: { environmentId: selectedEnvironment, connected: () => deps.status() === "connected", subscribe: detailSubscribe, supportsChecks: deps.supportsChecks ?? (() => { const id = selectedEnvironment(); if (!deps.multiEnvironment || id === PRIMARY_ROUTING_ENVIRONMENT) return supportsPullRequestChecks(); const environment = environmentConfigs()[id]?.environment as { capabilities?: { pullRequestChecks?: boolean } } | undefined; return environment?.capabilities?.pullRequestChecks === true; }) } });
  const now = signal(Date.now());
  // The copy-number command reads the open pull request from here; leaving the page clears it.
  effect(() => { const current = selected(); setActivePullRequest(current ? { number: current.number, provider: current.provider, url: current.url } : null); return () => setActivePullRequest(null); });
  // data-guide-shown: a run's toast is skipped while its guide tab is on screen.
  effect(() => {
    const current = selected();
    setShownGuide(current && detail.tab() === "guide" ? guideRunKey({ projectId: current.projectId, ...(current.host ? { host: current.host } : {}), repository: current.repository, number: current.number }) : null);
    return () => setShownGuide(null);
  });
  // "Open guide" from a run's toast: the pull request opens on its Guide tab once the list has it.
  effect(() => {
    const target = pendingGuideOpen();
    if (!target) return;
    const match = model.entries().find((entry) => entry.projectId === target.projectId && entry.number === target.number && entry.repository.toLowerCase() === target.repository.toLowerCase());
    if (!match) return;
    consumePendingGuideOpen();
    selectPullRequest(match);
    detail.tab.set("guide");
  });
  const actionError = signal("");
  // A link to a pull request in a description or comment shows its card first (PullRequestLinkPreview).
  const linkPreview = createPullRequestLinkPreviewModel({
    request: deps.request,
    projectId: () => selected()?.projectId ?? null,
    openInApp: (card) => {
      const known = model.entries().find((entry) => entry.number === card.number && entry.repository.toLowerCase() === card.repository.toLowerCase());
      if (!known) return false;
      selectPullRequest(known);
      return true;
    },
    openOnHost: (url) => void openOnHost(url),
  });
  effect(() => setMarkdownLinkInterceptor((href) => linkPreview.handle(href)));
  const checkout = createPullRequestCheckoutModel({
    request: deps.request,
    subject: () => { const current = selected(); return current ? { url: current.url, projectId: current.projectId, term: changeRequestTerm(current.provider) } : null; },
    projectPath: deps.checkout?.projectPath ?? ((projectId) => allProjects().find((project) => project.id === projectId)?.path ?? null),
    newThread: deps.checkout?.newThread ?? ((projectId) => { createThread(projectId); return openThread()?.id ?? null; }),
    selectWorkspace: deps.checkout?.selectWorkspace ?? ((workspace) => setWorkspaceStrategy(workspace)),
    toasts: deps.checkout?.toasts ?? { show: showToast, update: updateToast },
  });

  const handoff = createPullRequestHandoffModel({
    subject: () => { const current = selected(); return current ? { number: current.number, title: current.title, url: current.url, headBranch: current.headBranch, baseBranch: current.baseBranch, provider: current.provider, projectId: current.projectId } : null; },
    newThread: deps.checkout?.newThread ?? ((projectId) => { createThread(projectId); return openThread()?.id ?? null; }),
    setDraft: deps.setDraft ?? ((text) => setComposerDraft(text)),
    checkout: (mode, withTask) => checkout.start(mode, withTask),
    toast: (input) => { showToast(input); },
  });

  async function openOnHost(url: string) {
    if (!url) return;
    try {
      const result = await openUrl(url);
      if (!result.opened) actionError.set("No application could open this pull request.");
    } catch (cause) {
      actionError.set(cause instanceof Error ? cause.message : "Could not open this pull request.");
    }
  }

  const invalidating = signal(false);
  const refreshing = () => invalidating() || model.status() === "loading";
  const refresh = () => { now.set(Date.now()); void model.refresh(); };
  // PullRequestsPage refreshFromHost: pullRequests.invalidate {} (only a person's refresh spends host requests), then the
  // list and its stats, then the open detail (its own invalidate { reference }).
  const refreshFromHost = async () => {
    invalidating.set(true);
    if (deps.multiEnvironment) await deps.multiEnvironment.invalidate(model.environmentId());
    else await invalidatePullRequests(deps.request, {});
    invalidating.set(false);
    refresh();
    if (selected()) void detail.refreshFromHost();
  };
  // refreshTrigger (list, first page only): a refresh the environment pushes re-reads the list from its first page.
  usePullRequestRefreshes({ environmentId: () => PRIMARY_ROUTING_ENVIRONMENT, connected: () => deps.status() === "connected", subscribe: deps.subscribe ?? subscribeBackend, onRefresh: () => { if (model.status() !== "loading") refresh(); } });
  effect(() => {
    if (!deps.multiEnvironment || !deps.environments) return;
    const environments = deps.environments().filter((environment) => environment.connected && environment.id !== primaryId() && (!model.environmentId() || model.environmentId() === environment.id));
    const releases = environments.map((environment) => retainPullRequestRefreshes(environment.id, (method, payload, onValue, onError) => subscribeEnvironment(environment.id, method, payload, onValue, onError)));
    return () => { for (const release of releases) release(); };
  });
  let remoteTicks = new Map<string, number>();
  effect(() => {
    if (!deps.multiEnvironment || !deps.environments) return;
    const environments = deps.environments().filter((environment) => environment.connected && environment.id !== primaryId() && (!model.environmentId() || model.environmentId() === environment.id));
    const next = new Map(environments.map((environment) => [environment.id, pullRequestRefreshTick(environment.id)]));
    const changed = [...next].some(([id, tick]) => remoteTicks.has(id) && remoteTicks.get(id) !== tick);
    remoteTicks = next;
    if (changed && untracked(model.status) !== "loading") untracked(refresh);
  });
  // PullRequestsPage.tsx:671 useLiveRefresh(refreshList): focus / 5 min refresh (minimal hook, shell-stores fix).
  useLiveRefresh(() => { if (deps.status() === "connected") refresh(); });
  const connected = () => deps.status() === "connected";
  const shown = () => model.view().entries.length;
  const condensed = signal(false);
  const toolbarHeight = signal(32);

  return (
    <View class="min-h-0 flex-1 flex-row bg-background" onLayout={(event) => pageWidth.set(event.bounds.size.width)}>
      <View class={detailMaximized() && selected() ? "hidden" : "min-w-0 flex-1 flex-col bg-background"}>
        {/* WorkspacePageHeader: 52pt, gutters 1.25rem, no rule; the breadcrumb is `text-sm font-medium` with a `Pull requests` h1. */}
        {/* PullRequestsColumn: once the in-flow filters scroll out of view (its IntersectionObserver on the marker under
            them), the header condenses into the "Pull request scope" breadcrumb with compact filters, search and Refresh. */}
        <View class="h-[52px] min-h-[52px] shrink-0 flex-row items-center gap-3 bg-background" style={{ paddingLeft: sidebarOpen() ? 20 : titleBar().left + 20, paddingRight: (selected() ? 0 : titleBar().right) + 20 }} desktop={{ windowDrag: true }}>
          {condensed() ? <PullRequestCondensedTopbar model={model} refreshing={refreshing} onRefresh={() => void refreshFromHost()} /> : (
            <View class="min-w-0 flex-row items-center" role="navigation" accessibilityLabel="Pull requests breadcrumb">
              <Text class="min-w-0 truncate text-sm font-medium text-foreground">Pull requests</Text>
            </View>
          )}
        </View>
        {/* WorkspacePageContainer width="expanded": mx-auto, max-w-6xl, px-5 sm:px-6, pt-6 pb-12, gap-4. */}
        <Scroll class="min-h-0 flex-1" contentClass="px-6 pb-12 pt-6" onScroll={(event) => condensed.set(event.offset.y > 24 + toolbarHeight())}>
          <View class="mx-auto w-full max-w-6xl flex-col gap-4">
            <View class="z-10 shrink-0" onLayout={(event) => toolbarHeight.set(event.bounds.size.height)}>
              <PullRequestListToolbar model={model} refreshing={refreshing} onRefresh={() => void refreshFromHost()} />
            </View>
              {!connected() ? (
                <View class="items-center gap-4 px-6 py-16">
                  <BranchMark />
                  <Text class="text-lg font-semibold text-foreground">{deps.status() === "connecting" ? "Connecting to environment..." : "Connect an environment"}</Text>
                  <Text class="text-center text-sm text-muted-foreground">{backendError() ?? "Connect a R3 Code server in Settings to see pull requests."}</Text>
                  <View accessibilityLabel="Open environment settings" role="button" onPress={() => openSettings("/settings/connections")} class="h-8 flex-row items-center rounded-md border border-border px-3 hover:bg-accent-50"><Text class="text-sm text-foreground">Open settings</Text></View>
                </View>
              ) : null}
              {connected() && !pullRequestsSupported() ? <PullRequestsUnavailableState title="Pull requests unavailable" error="Update your T3 Code servers to browse pull requests." /> : null}
              {connected() && pullRequestsSupported() && model.status() === "loading" && model.entries().length === 0 ? <PullRequestListGhost caption="Loading pull requests…" /> : null}
              {connected() && model.status() === "error" && model.entries().length === 0 ? (
                <PullRequestsUnavailableState error={model.error()} refreshing={refreshing()} onRetry={() => void model.retry()} />
              ) : null}
              {actionError() ? <Text class="text-sm text-destructive">{actionError()}</Text> : null}
              <Each of={connected() ? model.errors() : []} key={(message: string) => message}>
                {(message) => (
                  <View class="flex-row items-center justify-between gap-2">
                    <Text class="min-w-0 flex-1 text-xs text-destructive">{message()}</Text>
                    {deps.multiEnvironment ? (
                      <View accessibilityLabel="Retry failed environments" role="button" onPress={() => void model.retry()} class="h-6 flex-row items-center rounded-md border border-border px-2 hover:bg-accent-50"><Text class="text-xs text-foreground">Retry</Text></View>
                    ) : null}
                  </View>
                )}
              </Each>
              {connected() && model.status() === "loaded" && shown() === 0 ? (
                <PullRequestListEmptyState
                  kind={model.emptyKind()}
                  query={model.search()}
                  canLoadMore={model.hasMore()}
                  loadingMore={model.loadingMore()}
                  refreshing={refreshing()}
                  onClearQuery={() => model.search.set("")}
                  onLoadMore={() => void model.loadMore()}
                  onRefresh={() => void refreshFromHost()}
                  onAddProject={openAddProjectPalette}
                />
              ) : null}
              {connected() && shown() > 0 ? (
                <PullRequestListGroups
                  groups={() => model.view().groups}
                  selectedKey={() => (selected() ? entryKey(selected()!) : null)}
                  now={() => now()}
                  onSelect={selectPullRequest}
                  onIntent={(entry) => detail.intent(entry)}
                  query={() => model.search()}
                  onActionDone={(entry, action) => model.recordAction(entry, action)}
                  request={deps.request}
                  hostActions={(host) => new Set(model.providers().find((provider) => provider.host === host)?.actions ?? [])}
                  onActed={refresh}
                />
              ) : null}
              {connected() && model.status() === "error" && model.entries().length > 0 ? (
                <View class="flex-row items-center justify-between gap-3 rounded-lg border border-warning bg-warning-surface px-3 py-2">
                  <Text class="min-w-0 flex-1 text-xs text-foreground">{`${model.error()} Showing the last pull requests loaded.`}</Text>
                  <View accessibilityLabel="Retry" role="button" onPress={() => void model.retry()} class="h-6 flex-row items-center rounded-md border border-border px-2 hover:bg-accent-50"><Text class="text-xs text-foreground">Retry</Text></View>
                </View>
              ) : null}
              {connected() && model.status() === "loaded" && model.hasMore() && shown() > 0 ? (
                model.loadingMore()
                  ? <View class="items-center py-3" accessibilityLabel="Loading more"><Text class="text-xs text-muted-foreground">Loading more</Text></View>
                  : <View accessibilityLabel="Load more pull requests" role="button" onPress={() => void model.loadMore()} class="h-8 items-center justify-center rounded-md border border-border hover:bg-accent-50">
                    <Text class="text-sm text-foreground">Load more pull requests</Text>
                  </View>
              ) : null}
              {connected() && model.status() === "loaded" && model.truncated() && !model.hasMore() && shown() > 0 ? (
                <View class="items-center py-3"><Text class="text-xs text-muted-foreground">Narrow your search to find more pull requests.</Text></View>
              ) : null}
          </View>
        </Scroll>
      </View>
      {selected() ? (
          <View class={detailMaximized() ? "relative min-w-0 flex-1 flex-col border-l border-border" : "relative min-w-0 shrink-0 flex-col border-l border-border"} style={detailMaximized() ? undefined : { width: resize.live() ?? clampDetailWidth(panelWidth.saved() ?? initialDetailWidth) }}>
            {!detailMaximized() ? <View role="button" accessibilityLabel="Resize pull request panel" focusable={false} class="absolute inset-y-0 left-0 z-20 w-2" {...resize.handle}>{resize.overlay()}</View> : null}
            <View class="h-[52px] min-h-[52px] shrink-0 flex-row items-center gap-1 pl-3" style={{ paddingRight: titleBar().right + 12 }} desktop={{ windowDrag: true }} accessibilityLabel="Pull request tabs">
              <View class="min-w-0 flex-1 flex-row items-center gap-1">
                <Each of={openTabs()} key={(entry: PullRequestEntry) => entryKey(entry)}>
                  {(entry) => <View role="button" accessibilityLabel={`Open pull request ${entry().number}`} onPress={() => selected.set(entry())} class={selected() && entryKey(selected()!) === entryKey(entry()) ? "h-7 flex-row items-center gap-1 rounded-md bg-accent-50 px-2" : "h-7 flex-row items-center gap-1 rounded-md px-2 hover:bg-accent-50"}>
                    <PRIcon name="git-pull-request" size={13} />
                    <Text class="text-xs text-foreground">{`#${entry().number}`}</Text>
                    <View role="button" accessibilityLabel={`Close pull request ${entry().number}`} onPress={() => closePullRequest(entry())} class="size-4 items-center justify-center"><PRIcon name="x" size={11} /></View>
                  </View>}
                </Each>
                <PopupMenu popupClass={`${MENU_POPUP_CLASS} w-[189px]`} trigger={<View role="button" accessibilityLabel="Add panel surface" class="size-6 shrink-0 items-center justify-center rounded-lg hover:bg-accent"><PRIcon name="plus" size={14} /></View>}>
                  {[["Browser", "B"], ["Terminal", "T"], ["Files", "F"], ["Diff", "D"], ["Pull request", "P"], ["Linked pull requests", "L"], ["Device", "V"]].map(([label, shortcut]) => <MenuItem disabled accessibilityLabel={`Add ${label}`} class={`${MENU_ITEM_ROW_CLASS} opacity-64`}><Text class="min-w-0 flex-1 text-sm text-popover-foreground">{label}</Text><Text class="text-xs text-muted-foreground">{shortcut}</Text></MenuItem>)}
                </PopupMenu>
              </View>
              <View role="button" accessibilityLabel={detailMaximized() ? "Restore pull request panel" : "Maximize pull request panel"} onPress={() => detailMaximized.set(!detailMaximized())} class="size-7 items-center justify-center rounded-md hover:bg-accent-50"><PRIcon name={detailMaximized() ? "minimize-2" : "maximize-2"} size={14} /></View>
              <View role="button" accessibilityLabel="Collapse pull request panel" onPress={() => { selected.set(null); detailMaximized.set(false); }} class="size-7 items-center justify-center rounded-md hover:bg-accent-50"><PRIcon name="panel-right" size={14} /></View>
            </View>
            <PullRequestDetailPanel entry={() => selected()} model={detail} now={() => now()} checkout={checkout} handoff={handoff} threads={deps.threads ?? { all: () => allProjects().flatMap((project) => project.threads.map((thread) => ({ id: thread.id, title: thread.title, projectId: project.id, updatedAt: thread.updatedAt }))), projectName: (projectId) => allProjects().find((project) => project.id === projectId)?.name ?? "", open: (threadId) => openThreadById(threadId) }} closeInTabStrip onClose={() => selected.set(null)} onOpenNumber={(layer) => { const current = selected(); if (current) selectPullRequest({ ...current, number: layer.number, title: layer.title || current.title, headBranch: layer.headBranch || current.headBranch, state: layer.state || current.state, isDraft: layer.isDraft, url: current.url.replace(/\/\d+$/u, `/${layer.number}`) }); }} onOpenHost={(url) => void openOnHost(url)} />
          </View>
        ) : null}
      <PullRequestLinkPreview model={linkPreview} now={() => now()} scheme={colorScheme()} />
    </View>
  );
}

