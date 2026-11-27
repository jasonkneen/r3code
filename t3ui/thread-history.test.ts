// History paging (client-runtime threads.ts loadEarlier, ThreadHistoryMeta): a bounded snapshot names its cursor; "Load
// earlier turns" GETs /api/orchestration/threads/:id/history, pages until a user-authored turn arrives, and folds the
// older turn items in front of what is shown. A failed page reads as the error line.
import { expect, test } from "nsh/test";
import { mergeTimeline } from "./components/thread/timeline";
import {
  applyShellEventForTest, applyThreadEventForTest, loadEarlierThreadHistory, markThreadSubscribingForTest, openThreadById,
  setBackendStatusForTest, setRequestBackendForTest, setThreadHistoryFetchForTests, threadActivity, threadHistoryFor, threadMessages,
} from "./store";

const at = (minutes: number) => new Date(Date.UTC(2026, 0, 1, 0, minutes)).toISOString();
const userItem = (id: string, minutes: number, text: string) => ({ id, type: "user_message", messageId: `m-${id}`, text, createdBy: "user", status: "completed", startedAt: at(minutes), updatedAt: at(minutes) });
const toolItem = (id: string, minutes: number) => ({ id, type: "command_execution", status: "completed", startedAt: at(minutes), updatedAt: at(minutes) });

function seed(id: string) {
  setRequestBackendForTest(() => Promise.resolve({}));
  setBackendStatusForTest("connected");
  applyShellEventForTest({ kind: "snapshot", snapshot: {
    projects: [{ id: "project-1", title: "legion", workspaceRoot: "/work/legion", createdAt: at(0), updatedAt: at(0) }],
    threads: [{ id, projectId: "project-1", title: "Paged", creationSource: "web", providerInstanceId: "codex", modelSelection: { instanceId: "codex", model: "gpt-6.1-sol" },
      providerInstanceHistory: ["codex"], status: "completed", latestRunId: null, pendingBackgroundTasks: [], pinnedAt: null, settledOverride: null, snoozedUntil: null, createdAt: at(0), updatedAt: at(0) }],
  } });
  openThreadById(id);
  markThreadSubscribingForTest(id);
  applyThreadEventForTest(id, { kind: "snapshot", snapshotSequence: 5, historyCursor: "c1", hasMoreHistory: true, latestLocalTurnOrdinal: 3, projection: {
    messages: [], turnItems: [userItem("u3", 30, "third")], runs: [], checkpoints: [], subagents: [], runtimeRequests: [],
  } });
}

test("a bounded snapshot names its cursor; Load earlier pages until a user turn and prepends it", async () => {
  seed("thread:paged");
  expect(threadHistoryFor("thread:paged")).toEqual({ cursor: "c1", hasMore: true, loading: false, error: null });
  const urls: string[] = [];
  const pages: Record<string, unknown> = {
    c1: { snapshotSequence: 5, items: [{ item: toolItem("t2", 20) }], nextCursor: "c2", hasMoreHistory: true },
    c2: { snapshotSequence: 5, items: [{ item: userItem("u2", 10, "second") }], nextCursor: "c3", hasMoreHistory: true },
  };
  setThreadHistoryFetchForTests(((url: string, init?: RequestInit) => {
    urls.push(`${url} ${(init?.headers as Record<string, string>)["x-t3-orchestration-protocol"]}`);
    const cursor = new URL(url).searchParams.get("cursor") ?? "";
    return Promise.resolve({ ok: true, json: () => Promise.resolve(pages[cursor]) } as Response);
  }) as typeof fetch, { url: "ws://127.0.0.1:9/", bearer: "tok" });
  expect(await loadEarlierThreadHistory("thread:paged")).toBe("loaded");
  expect(urls).toEqual([
    "http://127.0.0.1:9/api/orchestration/threads/thread%3Apaged/history?cursor=c1&deferWork=1 2",
    "http://127.0.0.1:9/api/orchestration/threads/thread%3Apaged/history?cursor=c2&deferWork=1 2",
  ]);
  const bodies = mergeTimeline(threadMessages(), threadActivity()).map((entry) => (entry.kind === "message" ? entry.message.body : entry.id));
  expect(bodies).toEqual(["second", "activity:t2", "third"]);
  expect(threadHistoryFor("thread:paged")).toEqual({ cursor: "c3", hasMore: true, loading: false, error: null });
  setThreadHistoryFetchForTests(null);
});

test("a failed page reads as the error line and keeps the cursor for a retry", async () => {
  seed("thread:failing");
  setThreadHistoryFetchForTests((() => Promise.resolve({ ok: false, json: () => Promise.resolve({}) } as Response)) as typeof fetch, { url: "ws://127.0.0.1:9/", bearer: "tok" });
  expect(await loadEarlierThreadHistory("thread:failing")).toBe("error");
  expect(threadHistoryFor("thread:failing")).toEqual({ cursor: "c1", hasMore: true, loading: false, error: "Could not load earlier activity." });
  setThreadHistoryFetchForTests(null);
});

test("a history page from before a replacement snapshot cannot overwrite the new history", async () => {
  const id = "thread:stale-history";
  seed(id);
  let resolvePage: ((response: Response) => void) | undefined;
  setThreadHistoryFetchForTests((() => new Promise<Response>((resolve) => { resolvePage = resolve; })) as typeof fetch, { url: "ws://127.0.0.1:9/", bearer: "tok" });
  const pending = loadEarlierThreadHistory(id);
  while (!resolvePage) await Promise.resolve();
  applyThreadEventForTest(id, { kind: "snapshot", snapshotSequence: 6, historyCursor: "fresh", hasMoreHistory: true, projection: {
    messages: [], turnItems: [userItem("fresh", 40, "fresh snapshot")], runs: [], checkpoints: [], subagents: [], runtimeRequests: [],
  } });
  resolvePage({ ok: true, json: () => Promise.resolve({ items: [{ item: userItem("old", 1, "stale page") }], nextCursor: "old-next", hasMoreHistory: true }) } as Response);
  expect(await pending).toBe("noop");
  expect(threadHistoryFor(id)).toEqual({ cursor: "fresh", hasMore: true, loading: false, error: null });
  expect(threadMessages().map((message) => message.body)).toEqual(["fresh snapshot"]);
  setThreadHistoryFetchForTests(null);
});

test("a page requested before switching away cannot apply after switching back", async () => {
  const id = "thread:switch-history";
  seed(id);
  let resolvePage: ((response: Response) => void) | undefined;
  setThreadHistoryFetchForTests((() => new Promise<Response>((resolve) => { resolvePage = resolve; })) as typeof fetch, { url: "ws://127.0.0.1:9/", bearer: "tok" });
  const pending = loadEarlierThreadHistory(id);
  while (!resolvePage) await Promise.resolve();
  openThreadById("thread:other");
  openThreadById(id);
  resolvePage({ ok: true, json: () => Promise.resolve({ items: [{ item: userItem("old-switch", 1, "stale switch page") }], nextCursor: "old-next", hasMoreHistory: true }) } as Response);
  expect(await pending).toBe("noop");
  expect(threadHistoryFor(id)).toEqual({ cursor: "c1", hasMore: true, loading: false, error: null });
  expect(threadMessages().some((message) => message.body === "stale switch page")).toBe(false);
  setThreadHistoryFetchForTests(null);
});

test("a stale failed request cannot clear a newer history load", async () => {
  const id = "thread:history-overlap";
  seed(id);
  const replies: Array<(response: Response) => void> = [];
  setThreadHistoryFetchForTests((() => new Promise<Response>((resolve) => { replies.push(resolve); })) as typeof fetch, { url: "ws://127.0.0.1:9/", bearer: "tok" });
  const old = loadEarlierThreadHistory(id);
  while (replies.length < 1) await Promise.resolve();
  applyThreadEventForTest(id, { kind: "snapshot", snapshotSequence: 6, historyCursor: "fresh", hasMoreHistory: true, projection: {
    messages: [], turnItems: [userItem("fresh-overlap", 40, "fresh")], runs: [], checkpoints: [], subagents: [], runtimeRequests: [],
  } });
  const latest = loadEarlierThreadHistory(id);
  while (replies.length < 2) await Promise.resolve();
  replies[0]!({ ok: false, json: () => Promise.resolve({ message: "old failure" }) } as Response);
  expect(await old).toBe("noop");
  expect(threadHistoryFor(id)).toEqual({ cursor: "fresh", hasMore: true, loading: true, error: null });
  replies[1]!({ ok: true, json: () => Promise.resolve({ items: [{ item: userItem("new-page", 1, "new page") }], nextCursor: null, hasMoreHistory: false }) } as Response);
  expect(await latest).toBe("loaded");
  expect(threadMessages().map((message) => message.body)).toEqual(["new page", "fresh"]);
  setThreadHistoryFetchForTests(null);
});


test("a bounded refresh retains loaded earlier turns and the history frontier", async () => {
  const id = "thread:refresh-history";
  seed(id);
  setThreadHistoryFetchForTests(async () => new Response(JSON.stringify({ items: [{ item: { ...userItem("u1", 1, "first"), ordinal: 1 } }], nextCursor: null, hasMoreHistory: false })), { url: "ws://127.0.0.1:9/", bearer: "tok" });
  await loadEarlierThreadHistory(id);
  applyThreadEventForTest(id, { kind: "snapshot", snapshotSequence: 6, historyCursor: "c1", hasMoreHistory: true, projection: {
    messages: [], turnItems: [{ ...userItem("u3", 30, "third updated"), ordinal: 3 }], runs: [], checkpoints: [], subagents: [], runtimeRequests: [],
  } });
  expect(threadMessages().map((message) => message.body)).toEqual(["first", "third updated"]);
  expect(threadHistoryFor(id).hasMore).toBe(false);
  setThreadHistoryFetchForTests(null);
});

test("an evicted thread's stale history response resolving last cannot overwrite a reopened load", async () => {
  const id = "thread:evicted-history";
  const others = Array.from({ length: 9 }, (_, index) => `thread:evict-other-${index}`);
  const threadRow = (threadId: string) => ({
    id: threadId, projectId: "project-1", title: threadId, creationSource: "web", providerInstanceId: "codex",
    modelSelection: { instanceId: "codex", model: "gpt-6.1-sol" }, providerInstanceHistory: ["codex"], status: "completed",
    latestRunId: null, pendingBackgroundTasks: [], pinnedAt: null, settledOverride: null, snoozedUntil: null, createdAt: at(0), updatedAt: at(0),
  });
  setRequestBackendForTest(() => Promise.resolve({}));
  setBackendStatusForTest("connected");
  applyShellEventForTest({ kind: "snapshot", snapshot: {
    projects: [{ id: "project-1", title: "legion", workspaceRoot: "/work/legion", createdAt: at(0), updatedAt: at(0) }],
    threads: [threadRow(id), ...others.map(threadRow)],
  } });
  openThreadById(id);
  markThreadSubscribingForTest(id);
  applyThreadEventForTest(id, { kind: "snapshot", snapshotSequence: 5, historyCursor: "c1", hasMoreHistory: true, projection: {
    messages: [], turnItems: [userItem("u3", 30, "third")], runs: [], checkpoints: [], subagents: [], runtimeRequests: [],
  } });
  const replies: Array<(response: Response) => void> = [];
  setThreadHistoryFetchForTests((() => new Promise<Response>((resolve) => { replies.push(resolve); })) as typeof fetch, { url: "ws://127.0.0.1:9/", bearer: "tok" });
  const old = loadEarlierThreadHistory(id);
  while (replies.length < 1) await Promise.resolve();
  for (const other of others) {
    openThreadById(other);
    markThreadSubscribingForTest(other);
    applyThreadEventForTest(other, { kind: "snapshot", snapshotSequence: 1, projection: {
      messages: [], turnItems: [userItem(`u-${other}`, 10, other)], runs: [], checkpoints: [], subagents: [], runtimeRequests: [],
    } });
  }
  expect(threadHistoryFor(id)).toEqual({ cursor: null, hasMore: false, loading: false, error: null });
  openThreadById(id);
  markThreadSubscribingForTest(id);
  applyThreadEventForTest(id, { kind: "snapshot", snapshotSequence: 6, historyCursor: "reopened", hasMoreHistory: true, projection: {
    messages: [], turnItems: [userItem("u-reopened", 40, "reopened latest")], runs: [], checkpoints: [], subagents: [], runtimeRequests: [],
  } });
  const latest = loadEarlierThreadHistory(id);
  while (replies.length < 2) await Promise.resolve();
  replies[1]!({ ok: true, json: () => Promise.resolve({ items: [{ item: userItem("u-new", 20, "reopened page") }], nextCursor: null, hasMoreHistory: false }) } as Response);
  expect(await latest).toBe("loaded");
  replies[0]!({ ok: true, json: () => Promise.resolve({ items: [{ item: userItem("u-stale", 1, "stale evicted page") }], nextCursor: "stale-next", hasMoreHistory: true }) } as Response);
  expect(await old).toBe("noop");
  expect(threadHistoryFor(id)).toEqual({ cursor: null, hasMore: false, loading: false, error: null });
  expect(threadMessages().map((message) => message.body)).toEqual(["reopened page", "reopened latest"]);
  setThreadHistoryFetchForTests(null);
});
