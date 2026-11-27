// Issues utility page (IssuesPage.tsx): multi-environment issue browsing grouped by tracker,
// filter toolbar + saved views + search + sort, failed-only retry (#39536), and resizable right detail pane
// holding the selected issue or a linked pull request.
import { cleanup, computed, effect, openUrl, Overlay, Scroll, signal, Storage, Text, untracked, View } from "nsh";
import { titleBar } from "nsh/desktop";
import {
  allProjects, allThreads, backendStatus, closeUtility, openSettings, openThreadById, requestBackend, sidebarOpen, toggleSidebar,
} from "../store";
import { createPullRequestDetailModel } from "../components/pullRequest/pullRequestDetailModel";
import { PullRequestDetailPanel } from "../components/pullRequest/PullRequestDetailPanel";
import { PullRequestListGhost } from "../components/pullRequest/PullRequestGhosts";
import { pullRequestsSupported } from "../components/pullRequest/pullRequestsSupported";
import { PullRequestsUnavailableState } from "../components/pullRequest/PullRequestsUnavailableState";
import { PRIcon } from "../components/pullRequest/PRIcon";
import { PRIMARY_ROUTING_ENVIRONMENT } from "../components/pullRequest/pullRequestRoutingInstall";
import { clampPanelWidth } from "../components/rightPanel/panelLogic";
import { environmentIssueKey, issueTrackerPresentation, type EnvironmentIssueEntry, type IssueRef } from "../components/issue/issueLogic";
import {
  DEFAULT_ISSUE_LIST_PREFERENCES,
  ISSUE_LIST_PREFERENCES_STORAGE_KEY,
  normalizeIssuePreferences,
  readIssueListPreferences,
  type IssueListPreferences,
} from "../components/issue/issueListPreferences";
import { activeIssueEnvironmentIds, createIssueListModel, environmentLabel, issuesSupported, type IssueListTarget, type RequestFn } from "../components/issue/issueStore";
import { IssueListToolbar, type IssueFilterProject } from "../components/issue/IssueListFilterPickers";
import { IssueRow, type IssueRowTarget } from "../components/issue/IssueRow";
import { IssueDetailPanel } from "../components/issue/IssueDetailPanel";
import { PULL_REQUEST_PANEL_WIDTH_KEY } from "../components/pullRequest/pullRequestPanelWidth";
import type { PullRequestEntry } from "./utility-data";

const LIST_DEFAULT_MIN = 360;
const DETAIL_DEFAULT = 520;
const DETAIL_MIN = 360;

export interface IssuesPageDeps {
  status: () => "connecting" | "connected" | "disconnected";
  supported?: () => boolean;
  environmentIds?: () => string[];
  projects: () => { id: string; title: string; environmentId?: string }[];
  threads: () => { id: string; title: string; projectId: string; updatedAt: number }[];
  projectName: (projectId: string) => string;
  request?: RequestFn;
  onBack: () => void;
  onOpenSettings?: () => void;
  onOpenThread: (threadId: string) => void;
  onOpenHost: (url: string) => void;
}

export function Issues(props: { deps?: IssuesPageDeps } = {}) {
  const deps: IssuesPageDeps = props.deps ?? {
    status: () => (backendStatus() === "connected" ? "connected" : "disconnected"),
    projects: () => allProjects().map((p) => ({ id: p.id, title: p.name, environmentId: PRIMARY_ROUTING_ENVIRONMENT })),
    threads: () => allThreads().map((t) => ({ id: t.id, title: t.title, projectId: t.projectId, updatedAt: t.updatedAt })),
    projectName: (projectId) => allProjects().find((p) => p.id === projectId)?.name ?? "",
    onBack: closeUtility,
    onOpenSettings: () => openSettings("/settings/source-control"),
    onOpenThread: openThreadById,
    onOpenHost: (url) => { void openUrl(url).catch(() => undefined); },
  };

  const supported = () => (deps.supported ?? issuesSupported)();
  const prefs = signal<IssueListPreferences>(DEFAULT_ISSUE_LIST_PREFERENCES);
  let prefsDirty = false;
  const now = signal(Date.now());
  const selected = signal<(IssueRef & { host: string; url: string; environmentId: string }) | null>(null);
  const linkedPr = signal<PullRequestEntry | null>(null);

  const pageWidth = signal(0);
  const detailWidth = signal(DETAIL_DEFAULT);
  const resizing = signal<false | { startX: number; startWidth: number }>(false);

  const timer = setInterval(() => now.set(Date.now()), 60_000);
  cleanup(() => clearInterval(timer));

  void Storage.getItem(ISSUE_LIST_PREFERENCES_STORAGE_KEY).then((raw) => {
    if (!prefsDirty && raw !== null) prefs.set(readIssueListPreferences(raw));
  }).catch(() => {});

  void Storage.getItem(PULL_REQUEST_PANEL_WIDTH_KEY).then((raw) => {
    if (!raw) return;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === "number" && Number.isFinite(parsed)) detailWidth.set(parsed);
    } catch { /* ignore invalid saved width */ }
  }).catch(() => {});

  const updatePreferences = (patch: Partial<IssueListPreferences>) => {
    prefsDirty = true;
    const next = normalizeIssuePreferences({ ...prefs(), ...patch });
    prefs.set(next);
    void Storage.setItem(ISSUE_LIST_PREFERENCES_STORAGE_KEY, JSON.stringify(next)).catch(() => {});
  };
  const replacePreferences = (next: IssueListPreferences) => {
    prefsDirty = true;
    const normalized = normalizeIssuePreferences(next);
    prefs.set(normalized);
    void Storage.setItem(ISSUE_LIST_PREFERENCES_STORAGE_KEY, JSON.stringify(normalized)).catch(() => {});
  };

  const model = createIssueListModel(deps.request ? { request: deps.request } : undefined);

  const activeEnvIds = computed(() => {
    if (deps.environmentIds) return deps.environmentIds();
    const active = activeIssueEnvironmentIds();
    return active.length > 0 ? active : [PRIMARY_ROUTING_ENVIRONMENT];
  });

  const filterProjects = computed<IssueFilterProject[]>(() =>
    deps.projects().map((p) => ({
      id: p.id,
      environmentId: p.environmentId ?? PRIMARY_ROUTING_ENVIRONMENT,
      title: p.title,
    })),
  );

  // Trigger list fetch whenever preferences, connected status, or project list changes.
  effect(() => {
    if (deps.status() !== "connected" || !supported()) return;
    const p = prefs();
    const envIds = activeEnvIds();
    const allProjs = filterProjects();
    const hidden = new Set((p.hideProjects ?? []).map(([e, id]) => `${e}:${id}`));
    const targets: IssueListTarget[] = envIds.map((environmentId) => {
      const envProjects = allProjs.filter((proj) => proj.environmentId === environmentId);
      const visibleIds = envProjects.filter((proj) => !hidden.has(`${proj.environmentId}:${proj.id}`)).map((proj) => proj.id);
      return {
        environmentId,
        input: {
          ...(visibleIds.length < envProjects.length ? { projectIds: visibleIds } : {}),
          ...(p.host ? { host: p.host } : {}),
          state: p.status,
          involvement: p.who,
          ...(p.order ? { sort: p.order } : {}),
          ...(p.q ? { query: p.q } : {}),
          ...(p.label?.length ? { labels: p.label } : {}),
          ...(p.assignee ? { assignee: p.assignee } : {}),
        },
      };
    });
    untracked(() => { void model.load(targets, "initial"); });
  });

  const prDetailModel = createPullRequestDetailModel({
    request: deps.request ?? requestBackend,
    entry: () => linkedPr(),
    isListed: () => false,
    threadLinks: { supported: pullRequestsSupported },
  });

  const detailOpen = () => selected() !== null || linkedPr() !== null;
  const maxDetailWidth = () => Math.max(DETAIL_MIN, (pageWidth() || 1200) - LIST_DEFAULT_MIN);
  const effectiveDetailWidth = () => clampPanelWidth(detailWidth(), DETAIL_MIN, maxDetailWidth());

  function selectIssueRow(entry: IssueRowTarget) {
    linkedPr.set(null);
    selected.set({
      environmentId: entry.environmentId,
      projectId: entry.projectId,
      tracker: entry.tracker,
      host: entry.host,
      scope: entry.scope,
      key: entry.key,
      url: entry.url,
    });
  }

  const selectedRowKey = () => {
    const s = selected();
    return s ? environmentIssueKey(s.environmentId, s) : null;
  };

  const groups = () => model.groups();
  const totalCount = () => model.entries().length;
  const multiScope = () => new Set(model.entries().map((e) => e.scope)).size > 1;
  const multiEnv = () => activeEnvIds().length > 1;

  const trackerThreadsProp = {
    all: deps.threads,
    projectName: deps.projectName,
    open: deps.onOpenThread,
  };

  return (
    <View
      class="min-w-0 flex-1 flex-row bg-background"
      accessibilityLabel="Issues page"
      onLayout={(event) => pageWidth.set(event.bounds.width)}
    >
      {resizing() ? (
        <Overlay
          class="inset-0 z-50"
          accessibilityLabel="Resizing issue detail pane"
          onMouseMove={(event) => {
            const drag = resizing();
            if (!drag) return;
            detailWidth.set(clampPanelWidth(drag.startWidth + (drag.startX - event.pagePosition.x), DETAIL_MIN, maxDetailWidth()));
          }}
          onMouseUp={() => {
            resizing.set(false);
            void Storage.setItem(PULL_REQUEST_PANEL_WIDTH_KEY, JSON.stringify(detailWidth())).catch(() => {});
          }}
        />
      ) : null}

      <View class="min-w-0 flex-1 flex-col">
        <View class="shrink-0 flex-col gap-3 border-b border-border py-4" style={{ paddingLeft: sidebarOpen() ? 24 : titleBar().left + 24, paddingRight: (detailOpen() ? 0 : titleBar().right) + 24 }} desktop={{ windowDrag: true }}>
          <View class="flex-row items-center justify-between gap-3">
            <View class="min-w-0 flex-row items-center gap-2">
              {!sidebarOpen() ? (
                <View role="button" accessibilityLabel="Show sidebar" onPress={toggleSidebar} class="size-7 items-center justify-center rounded-md hover:bg-accent-50">
                  <PRIcon name="panel-right" size={16} />
                </View>
              ) : null}
              <View role="button" accessibilityLabel="Back to chat" onPress={deps.onBack} class="size-7 items-center justify-center rounded-md hover:bg-accent-50">
                <PRIcon name="arrow-left" size={16} />
              </View>
              <PRIcon name="circle-dot" size={18} />
              <Text class="text-lg font-semibold text-foreground">Issues</Text>
              {totalCount() > 0 ? <Text class="text-sm text-muted-foreground">{String(totalCount())}</Text> : null}
            </View>

            <View class="shrink-0 flex-row items-center gap-2">
              {deps.onOpenSettings ? (
                <View
                  role="button"
                  accessibilityLabel="Issue tracker settings"
                  onPress={deps.onOpenSettings}
                  class="h-8 flex-row items-center gap-1.5 rounded-lg border border-input px-2.5 hover:bg-accent-50"
                >
                  <PRIcon name="plug-2" size={14} />
                  <Text class="text-xs text-foreground">Trackers</Text>
                </View>
              ) : null}
            </View>
          </View>

          <IssueListToolbar
            preferences={prefs}
            onUpdatePreferences={updatePreferences}
            onReplacePreferences={replacePreferences}
            trackers={() => model.view().trackers}
            scopes={() => model.view().scopes ?? []}
            projects={() => filterProjects()}
            refreshing={model.refreshing}
            onRefresh={() => void model.refresh("manual")}
            request={deps.request}
          />
        </View>

        <Scroll class="min-h-0 flex-1">
          <View class="flex-col gap-4 p-4">
            {deps.status() === "connected" && !supported() ? (
              <PullRequestsUnavailableState
                title="Issues unavailable"
                error="Update your T3 Code servers to browse issues."
              />
            ) : null}

            {model.environmentErrors().size > 0 ? (
              <View class="flex-row items-center justify-between gap-3 rounded-lg border border-border bg-card px-3 py-2.5">
                <View class="min-w-0 flex-1 flex-col gap-0.5">
                  <Text class="text-xs font-medium text-foreground">Some environments could not be read</Text>
                  <Text class="text-xs text-muted-foreground">{[...model.environmentErrors().values()].join(" · ")}</Text>
                </View>
                <View
                  role="button"
                  accessibilityLabel="Retry failed environments"
                  onPress={() => void model.retryFailed()}
                  class="h-7 shrink-0 flex-row items-center gap-1.5 rounded-md border border-border px-2.5 hover:bg-accent-50"
                >
                  <PRIcon name="refresh-cw" size={12} />
                  <Text class="text-xs text-foreground">Retry</Text>
                </View>
              </View>
            ) : null}

            {deps.status() === "connected" && supported() && model.status() === "loading" && totalCount() === 0 ? (
              <PullRequestListGhost caption="Loading issues..." />
            ) : null}

            {deps.status() === "connected" && supported() && model.status() === "ready" && groups().length === 0 ? (
              <View class="flex-col items-center justify-center gap-2 py-12">
                <PRIcon name="circle-dot" size={24} />
                <Text class="text-sm font-medium text-foreground">
                  {prefs().q ? `Nothing matches “${prefs().q!}”` : "No issues found"}
                </Text>
                <Text class="text-center text-xs text-muted-foreground">
                  Bind projects to GitHub, GitLab, or Linear in Source control settings to see issues here.
                </Text>
                {prefs().q ? (
                  <View
                    role="button"
                    accessibilityLabel="Clear issue search"
                    onPress={() => updatePreferences({ q: "" })}
                    class="mt-2 h-7 flex-row items-center rounded-md border border-border px-3 hover:bg-accent-50"
                  >
                    <Text class="text-xs text-foreground">Clear search</Text>
                  </View>
                ) : null}
              </View>
            ) : null}

            <Each of={groups()} key={(group) => `${group.tracker.tracker}:${group.tracker.host}`}>
              {(group) => (
                <View class="flex-col gap-1.5">
                  <View class="flex-row items-center gap-2 px-3 pb-1">
                    <PRIcon name={issueTrackerPresentation(group().tracker.tracker).icon} size={14} />
                    <Text class="shrink-0 text-xs font-medium text-foreground">{issueTrackerPresentation(group().tracker.tracker).providerName}</Text>
                    {group().tracker.host ? <Text class="shrink-0 text-xs text-muted-foreground">{group().tracker.host}</Text> : null}
                    <Text class="shrink-0 text-xs text-muted-foreground">{String(group().rows.length)}</Text>
                    <View class="h-px min-w-2 flex-1 bg-border" />
                  </View>

                  {!group().tracker.configured && group().tracker.detail ? (
                    <View class="mx-3 rounded-md border border-border-60 bg-muted-30 px-3 py-2">
                      <Text class="text-xs text-muted-foreground">{group().tracker.detail}</Text>
                    </View>
                  ) : null}

                  {group().errors.map((err) => (
                    <View class="mx-3 rounded-md border border-border-60 bg-card px-3 py-2">
                      <Text class="text-xs font-medium text-foreground">{err.projectTitle}</Text>
                      <Text class="text-xs text-muted-foreground">{err.message}</Text>
                    </View>
                  ))}

                  <View class="flex-col gap-0.5">
                    <Each of={group().rows} key={(entry: EnvironmentIssueEntry) => environmentIssueKey(entry.environmentId, entry)}>
                      {(entry) => (
                        <IssueRow
                          entry={entry()}
                          now={now}
                          showScope={multiScope()}
                          showTracker={groups().length > 1}
                          environmentLabel={multiEnv() ? environmentLabel(entry().environmentId) : undefined}
                          selected={() => selectedRowKey() === environmentIssueKey(entry().environmentId, entry())}
                          onSelect={selectIssueRow}
                        />
                      )}
                    </Each>
                  </View>

                  {group().more.length > 0 ? (
                    <View
                      role="button"
                      accessibilityLabel={`Load more ${issueTrackerPresentation(group().tracker.tracker).providerName} issues`}
                      accessibilityState={{ disabled: model.loadingMore() }}
                      onPress={() => void model.loadMore(group().more, group().tracker.host)}
                      class="mx-3 mt-1 h-8 items-center justify-center rounded-md border border-border hover:bg-accent-50"
                    >
                      <Text class="text-xs text-foreground">{model.loadingMore() ? "Loading..." : "Load more"}</Text>
                    </View>
                  ) : null}
                </View>
              )}
            </Each>
          </View>
        </Scroll>
      </View>

      {detailOpen() ? (
        <View style={{ width: effectiveDetailWidth() }} class="relative h-full shrink-0 flex-row">
          <View
            accessibilityLabel="Resize issue detail pane"
            onMouseDown={(event) => resizing.set({ startX: event.pagePosition.x, startWidth: effectiveDetailWidth() })}
            class="absolute inset-y-0 left-0 z-20 w-1.5 cursor-col-resize hover:bg-primary/40"
          />
          {linkedPr() ? (
            <PullRequestDetailPanel
              entry={() => linkedPr()}
              model={prDetailModel}
              now={now}
              onClose={() => linkedPr.set(null)}
              onOpenHost={deps.onOpenHost}
              threads={trackerThreadsProp}
            />
          ) : selected() ? (
            <IssueDetailPanel
              environmentId={selected()!.environmentId}
              reference={selected()!}
              now={now}
              onClose={() => selected.set(null)}
              onOpenHost={deps.onOpenHost}
              threads={trackerThreadsProp}
              onOpenPullRequest={(pr) => {
                const s = selected()!;
                linkedPr.set({
                  host: s.host,
                  provider: s.tracker === "gitlab" ? "gitlab" : "github",
                  projectId: s.projectId,
                  repository: pr.repository,
                  number: pr.number,
                  title: pr.title,
                  url: pr.url,
                  author: "",
                  authorAvatarUrl: "",
                  state: pr.state,
                  isDraft: pr.isDraft,
                  reviewDecision: "",
                  checksState: "",
                  baseBranch: "",
                  headBranch: "",
                  additions: 0,
                  deletions: 0,
                  updatedAt: new Date().toISOString(),
                  createdAt: new Date().toISOString(),
                  labels: [],
                  watching: false,
                  involvement: "others",
                  score: 0,
                  readyToMerge: false,
                });
              }}
              onStateChanged={(nextState) => {
                const s = selected();
                if (s) model.updateEntryState(s.environmentId, s, nextState);
              }}
              request={deps.request}
            />
          ) : null}
        </View>
      ) : null}
    </View>
  );
}
