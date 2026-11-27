import { expect, test } from "nsh/test";
import type { SocketConnection } from "../backend/client";
import {
  allProjects, allThreads, applyShellEventForTest, archivedThreads, canLoadOlderSettled, isServerThread, loadOlderSettledPage,
  olderSettledStatus, refreshArchivedThreads, refreshMergedShell, requestBackend, setRequestBackendForTest, unloadedOlderSettledCount,
} from "../store";
import { savedEnvironmentStatus } from "../pages/settings/environments/savedEnvironments";
import { projectEnvironmentDescription } from "./EnvironmentBadges";
import { readThreadAttachment } from "../components/thread/readAttachment";
import { environmentConnections, reconnectEnvironment, refreshRemoteArchive, remoteShell, remoteShellThread, resetEnvironmentsForTest, setEnvironmentTransportForTest, syncEnvironments } from "./connectionManager";

class FakeSocket implements SocketConnection {
  sent: string[] = [];
  private incoming: (string | null)[] = [];
  private reader: ((value: string | null) => void) | null = null;
  async write(data: string | Uint8Array) { this.sent.push(typeof data === "string" ? data : new TextDecoder().decode(data)); }
  read(): Promise<string | Uint8Array | null> {
    if (this.incoming.length) return Promise.resolve(this.incoming.shift() ?? null);
    return new Promise((resolve) => { this.reader = resolve; });
  }
  async close() { this.push(null); }
  push(value: string | null) { const r = this.reader; this.reader = null; if (r) r(value); else this.incoming.push(value); }
  frame(value: unknown) { this.push(JSON.stringify(value)); }
}

async function until(check: () => boolean) {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
  expect(check()).toBe(true);
}

const thread = (id: string, projectId: string) => ({ id, projectId, title: id, status: "idle", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" });

test("a saved environment's shell merges into the store with scoped ids, and its commands route to it", async () => {
  applyShellEventForTest({ kind: "snapshot", snapshot: { projects: [{ id: "p", title: "Primary" }], threads: [thread("a", "p")] } });
  const primaryProjects = allProjects();
  refreshMergedShell();
  // No saved environment: the primary lists are untouched.
  expect(allProjects() === primaryProjects).toBe(true);

  const socket = new FakeSocket();
  setEnvironmentTransportForTest({ ticket: async (url) => url, open: async () => socket });
  syncEnvironments([{ id: "saved:box", label: "box", url: "ws://box/ws", enabled: true }]);
  await until(() => socket.sent.some((text) => text.includes("subscribeServerConfig")));
  // rpc/session.ts: the config stream comes first (with the runtime flags); the shell follows its snapshot.
  expect(JSON.parse(socket.sent.find((text) => text.includes("subscribeServerConfig"))!).payload).toEqual({ environmentThemes: true, usageLimitSources: true, usageLimitsCommand: true, workspaceSnapshotsOnDemand: true });
  socket.frame({ _tag: "Chunk", requestId: "1", values: [{ type: "snapshot", config: { environment: { label: "box", serverVersion: "1" } } }] });
  await until(() => socket.sent.some((text) => text.includes("orchestration.subscribeShell")));
  socket.frame({ _tag: "Chunk", requestId: "2", values: [{ kind: "snapshot", snapshot: { projects: [{ id: "p", title: "Remote" }], threads: [{ ...thread("a", "p"), lineage: { parentThreadId: "parent", rootThreadId: "root", relationshipToParent: "subagent" }, forkedFrom: { type: "run", threadId: "fork-source" }, delegatedFrom: { environmentId: "other", threadId: "other-thread", title: "Other" } }] } }] });
  await until(() => remoteShell("saved:box")?.loaded === true);
  refreshMergedShell();

  const remote = allProjects().find((project) => project.id === "saved:box:p");
  expect(remote?.environmentId).toBe("saved:box");
  expect(remote?.threads[0]?.id).toBe("saved:box:a");
  expect(remote?.threads[0]?.relations?.lineage?.parentThreadId).toBe("saved:box:parent");
  expect(remote?.threads[0]?.relations?.lineage?.rootThreadId).toBe("saved:box:root");
  expect(remote?.threads[0]?.relations?.forkSourceThreadId).toBe("saved:box:fork-source");
  expect(remote?.threads[0]?.relations?.delegatedFrom?.threadId).toBe("other-thread");
  expect(allProjects().some((project) => project.id === "p")).toBe(true);
  expect(allThreads().filter((item) => item.environmentId === "saved:box").length).toBe(1);
  expect(isServerThread("saved:box:a")).toBe(true);
  expect(projectEnvironmentDescription(remote?.environmentId)).toBe("On box");
  expect(savedEnvironmentStatus({ id: "saved:box", label: "box", url: "ws://box/ws", enabled: true, addedAt: 0 }, undefined).text).toBe("Connected");

  const titles = requestBackend("orchestration.getThreadTitles", { threadIds: ["saved:box:parent"] });
  await until(() => socket.sent.some((text) => text.includes("orchestration.getThreadTitles")));
  const titlesRequest = JSON.parse(socket.sent.find((text) => text.includes("orchestration.getThreadTitles"))!);
  expect(titlesRequest.payload.threadIds).toEqual(["parent"]);
  socket.frame({ _tag: "Exit", requestId: String(titlesRequest.id), exit: { _tag: "Success", value: { parent: "Parent title" } } });
  expect(await titles).toEqual({ parent: "Parent title" });

  const originalFetch = globalThis.fetch;
  const fetched: string[] = [];
  try {
    globalThis.fetch = async (input) => { fetched.push(String(input)); return new Response("remote image", { status: 200 }); };
    const reading = readThreadAttachment("saved:box:a", "remote-asset", { signal: new AbortController().signal, maxBytes: 100 });
    await until(() => socket.sent.some((text) => text.includes("assets.createUrl")));
    const assetRequest = JSON.parse(socket.sent.find((text) => text.includes("assets.createUrl"))!);
    expect(assetRequest.payload.resource.attachmentId).toBe("remote-asset");
    socket.frame({ _tag: "Exit", requestId: String(assetRequest.id), exit: { _tag: "Success", value: { relativeUrl: "/api/assets/signed/image", expiresAt: 1800000000000 } } });
    expect(await (await reading).text()).toBe("remote image");
    expect(fetched).toEqual(["http://box/api/assets/signed/image"]);
  } finally {
    globalThis.fetch = originalFetch;
  }

  const loadRemoteArchive = refreshRemoteArchive("saved:box");
  await until(() => socket.sent.some((text) => text.includes("getArchivedShellSnapshot")));
  const archiveRequest = JSON.parse(socket.sent.find((text) => text.includes("getArchivedShellSnapshot"))!);
  socket.frame({ _tag: "Chunk", requestId: "2", values: [{ kind: "thread.updated", location: "archive", thread: thread("new-remote", "p") }] });
  await until(() => remoteShell("saved:box")!.archived.some((item) => item.id === "new-remote"));
  socket.frame({ _tag: "Chunk", requestId: "2", values: [{ kind: "thread.updated", location: "active", thread: thread("restored", "p") }] });
  await until(() => remoteShell("saved:box")!.threads.some((item) => item.id === "restored"));
  socket.frame({ _tag: "Exit", requestId: String(archiveRequest.id), exit: { _tag: "Success", value: { threads: [thread("archived", "p"), thread("restored", "p")] } } });
  await loadRemoteArchive;
  expect(remoteShell("saved:box")!.archived.map((item) => item.id)).toEqual(["archived", "new-remote"]);
  refreshMergedShell();
  expect(archivedThreads().some((item) => item.id === "saved:box:archived")).toBe(true);
  setRequestBackendForTest(async () => ({ threads: [thread("primary-archived", "p")] }));
  await refreshArchivedThreads();
  setRequestBackendForTest(null);
  expect(archivedThreads().some((item) => item.id === "primary-archived")).toBe(true);
  expect(archivedThreads().some((item) => item.id === "saved:box:archived")).toBe(true);

  const reply = requestBackend("orchestration.dispatchCommand", { command: { type: "thread.archive", threadId: "saved:box:a" } });
  await until(() => socket.sent.some((text) => text.includes("dispatchCommand")));
  const sent = socket.sent.find((text) => text.includes("dispatchCommand")) ?? "";
  expect(sent.includes('"threadId":"a"')).toBe(true);
  socket.frame({ _tag: "Exit", requestId: String(JSON.parse([...socket.sent].reverse().find((text) => text.includes("dispatchCommand")) ?? "{}").id), exit: { _tag: "Success", value: { sequence: 1, threadId: "a", thread: { projectId: "p" } } } });
  const answer = await reply as { threadId: string; thread: { projectId: string } };
  // Ids in a remote answer come back scoped, so opening what it names works.
  expect(answer.threadId).toBe("saved:box:a");
  expect(answer.thread.projectId).toBe("saved:box:p");

  // clearComposerDraftsEnvironment: a draft in the remote project goes when its environment is removed.
  const { createThread, openThread, setComposerDraft, sidebarDrafts } = await import("../store");
  const { clearComposerDraftsEnvironment, hasDraftThreadsInEnvironment } = await import("./environmentDrafts");
  createThread("saved:box:p");
  setComposerDraft("remote draft");
  expect(openThread()?.projectId).toBe("saved:box:p");
  expect(hasDraftThreadsInEnvironment("saved:box")).toBe(true);
  clearComposerDraftsEnvironment("saved:box");
  expect(hasDraftThreadsInEnvironment("saved:box")).toBe(false);
  expect(sidebarDrafts().length).toBe(0);

  syncEnvironments([]);
  refreshMergedShell();
  expect(allProjects().some((project) => project.environmentId)).toBe(false);
  resetEnvironmentsForTest();
  setEnvironmentTransportForTest(null);
});

test("remote environments contribute olderSettled counts, scope filtering, paging and count refresh", async () => {
  const before = "2026-02-01T00:00:00.000Z";
  const settledIso = "2026-01-15T00:00:00.000Z";
  const settledRow = (id: string, projectId: string) => ({
    ...thread(id, projectId),
    status: "completed",
    settledOverride: "settled",
    settledAt: settledIso,
    createdAt: settledIso,
    updatedAt: settledIso,
  });

  applyShellEventForTest({
    kind: "snapshot",
    snapshot: {
      snapshotSequence: 1,
      projects: [{ id: "p", title: "Primary" }],
      threads: [],
      olderSettled: { before, asOfSequence: 1, counts: [{ projectId: "p", count: 4 }] },
    },
  });

  const socket = new FakeSocket();
  setEnvironmentTransportForTest({ ticket: async (url) => url, open: async () => socket });
  syncEnvironments([{ id: "saved:box", label: "box", url: "ws://box/ws", enabled: true }]);
  await until(() => socket.sent.some((text) => text.includes("subscribeServerConfig")));
  socket.frame({
    _tag: "Chunk",
    requestId: "1",
    values: [{ type: "snapshot", config: { environment: { label: "box", serverVersion: "1" }, shellThreadFamilies: true, shellOlderSettled: true } }],
  });
  await until(() => socket.sent.some((text) => text.includes("orchestration.subscribeShell")));
  socket.frame({
    _tag: "Chunk",
    requestId: "2",
    values: [{
      kind: "snapshot",
      snapshot: {
        snapshotSequence: 10,
        projects: [{ id: "rp1", title: "Remote 1" }, { id: "rp2", title: "Remote 2" }],
        threads: [],
        olderSettled: { before, asOfSequence: 10, counts: [{ projectId: "rp1", count: 2 }, { projectId: "rp2", count: 3 }] },
      },
    }],
  });
  await until(() => remoteShell("saved:box")?.loaded === true);
  refreshMergedShell();

  expect(unloadedOlderSettledCount()).toBe(9);
  expect(unloadedOlderSettledCount(new Set(["p"]))).toBe(4);
  expect(unloadedOlderSettledCount(new Set(["saved:box:rp1"]))).toBe(2);
  expect(unloadedOlderSettledCount(new Set(["p", "saved:box:rp2"]))).toBe(7);

  socket.frame({ _tag: "Chunk", requestId: "2", values: [{ kind: "thread.updated", location: "active", thread: settledRow("old-1", "rp1") }] });
  await until(() => remoteShell("saved:box")!.threads.some((item) => item.id === "old-1"));
  refreshMergedShell();
  expect(unloadedOlderSettledCount(new Set(["saved:box:rp1"]))).toBe(1);
  expect(unloadedOlderSettledCount()).toBe(8);

  const primaryCalls: unknown[] = [];
  setRequestBackendForTest(async (method, payload) => { primaryCalls.push({ method, payload }); return { snapshotSequence: 1, threads: [], counts: [] }; });
  const paging = loadOlderSettledPage(["saved:box:rp1"]);
  await until(() => socket.sent.some((text) => text.includes("getOlderSettledThreads")));
  const pageReq = JSON.parse(socket.sent.find((text) => text.includes("getOlderSettledThreads"))!);
  expect(pageReq.payload).toEqual({ before: { settledAt: before }, projectIds: ["rp1"], limit: 25 });
  expect(primaryCalls).toEqual([]);
  socket.frame({
    _tag: "Exit",
    requestId: String(pageReq.id),
    exit: { _tag: "Success", value: { snapshotSequence: 10, threads: [settledRow("old-1", "rp1"), settledRow("old-2", "rp1")], counts: [] } },
  });
  await paging;

  expect(unloadedOlderSettledCount(new Set(["saved:box:rp1"]))).toBe(0);
  expect(olderSettledStatus(["saved:box:rp1"])).toBe("done");
  expect(olderSettledStatus(["saved:box:rp2"])).toBe("ready");
  expect(allThreads().some((item) => item.id === "saved:box:old-2")).toBe(true);
  expect(remoteShellThread("saved:box:old-2")?.id).toBe("old-2");

  const sentBeforeArchive = socket.sent.length;
  socket.frame({ _tag: "Chunk", requestId: "2", values: [{ kind: "thread.updated", location: "archive", thread: settledRow("old-2", "rp1") }] });
  await until(() => socket.sent.slice(sentBeforeArchive).some((text) => text.includes("getOlderSettledThreads")));
  const archiveCountReq = JSON.parse(socket.sent.slice(sentBeforeArchive).find((text) => text.includes("getOlderSettledThreads"))!);
  expect(archiveCountReq.payload).toEqual({ before: { settledAt: before }, limit: 0 });
  socket.frame({
    _tag: "Exit",
    requestId: String(archiveCountReq.id),
    exit: { _tag: "Success", value: { snapshotSequence: 11, threads: [], counts: [{ projectId: "rp1", count: 1 }, { projectId: "rp2", count: 3 }] } },
  });
  await until(() => unloadedOlderSettledCount(new Set(["saved:box:rp1"])) === 0 && unloadedOlderSettledCount() === 7);

  const sentBeforeUnloadedArchive = socket.sent.length;
  socket.frame({ _tag: "Chunk", requestId: "2", values: [{ kind: "thread.updated", location: "archive", thread: settledRow("rp2-unloaded-archived", "rp2") }] });
  await until(() => socket.sent.slice(sentBeforeUnloadedArchive).some((text) => text.includes("getOlderSettledThreads")));
  const unloadedArchiveReq = JSON.parse(socket.sent.slice(sentBeforeUnloadedArchive).find((text) => text.includes("getOlderSettledThreads"))!);
  expect(unloadedArchiveReq.payload).toEqual({ before: { settledAt: before }, limit: 0 });
  socket.frame({
    _tag: "Exit",
    requestId: String(unloadedArchiveReq.id),
    exit: { _tag: "Success", value: { snapshotSequence: 12, threads: [], counts: [{ projectId: "rp1", count: 1 }, { projectId: "rp2", count: 2 }] } },
  });
  await until(() => unloadedOlderSettledCount(new Set(["saved:box:rp2"])) === 2);

  const sentBeforeInFlight = socket.sent.length;
  const inFlightPage = loadOlderSettledPage(["saved:box:rp2"]);
  await until(() => socket.sent.slice(sentBeforeInFlight).some((text) => text.includes("getOlderSettledThreads")));
  const inFlightReq = JSON.parse(socket.sent.slice(sentBeforeInFlight).find((text) => text.includes("getOlderSettledThreads"))!);
  socket.frame({ _tag: "Chunk", requestId: "2", values: [{ kind: "thread.removed", location: "active", threadId: "rp2-deleted" }] });
  socket.frame({ _tag: "Chunk", requestId: "2", values: [{ kind: "thread.updated", location: "archive", thread: settledRow("rp2-archived", "rp2") }] });
  await until(() => remoteShell("saved:box")!.archived.some((item) => item.id === "rp2-archived"));
  socket.frame({
    _tag: "Exit",
    requestId: String(inFlightReq.id),
    exit: {
      _tag: "Success",
      value: {
        snapshotSequence: 13,
        threads: [settledRow("rp2-deleted", "rp2"), settledRow("rp2-archived", "rp2"), settledRow("rp2-kept", "rp2")],
        counts: [],
      },
    },
  });
  await inFlightPage;
  expect(allThreads().some((item) => item.id === "saved:box:rp2-deleted")).toBe(false);
  expect(allThreads().some((item) => item.id === "saved:box:rp2-archived")).toBe(false);
  expect(remoteShellThread("saved:box:rp2-deleted")).toBe(null);
  expect(remoteShellThread("saved:box:rp2-archived")).toBe(null);
  expect(allThreads().some((item) => item.id === "saved:box:rp2-kept")).toBe(true);
  expect(olderSettledStatus(["saved:box:rp2"])).toBe("done");

  let reconnectedSocket: FakeSocket | null = null;
  setEnvironmentTransportForTest({
    ticket: async (url) => url,
    open: async () => {
      reconnectedSocket = new FakeSocket();
      return reconnectedSocket;
    },
  });
  await socket.close();
  await until(() => environmentConnections()["saved:box"]?.phase === "reconnecting");
  expect(canLoadOlderSettled(["saved:box:rp2"])).toBe(false);
  expect(olderSettledStatus(["saved:box:rp2"])).toBe("done");

  reconnectEnvironment("saved:box");
  await until(() => reconnectedSocket !== null && reconnectedSocket.sent.some((text) => text.includes("subscribeServerConfig")));
  reconnectedSocket!.frame({
    _tag: "Chunk",
    requestId: "1",
    values: [{ type: "snapshot", config: { environment: { label: "box", serverVersion: "1" }, shellThreadFamilies: true, shellOlderSettled: true } }],
  });
  await until(() => reconnectedSocket!.sent.some((text) => text.includes("orchestration.subscribeShell")));
  reconnectedSocket!.frame({
    _tag: "Chunk",
    requestId: "2",
    values: [{
      kind: "snapshot",
      snapshot: {
        snapshotSequence: 13,
        projects: [{ id: "rp1", title: "Remote 1" }, { id: "rp2", title: "Remote 2" }],
        threads: [],
        olderSettled: { before, asOfSequence: 13, counts: [{ projectId: "rp2", count: 2 }] },
      },
    }],
  });
  await until(() => environmentConnections()["saved:box"]?.phase === "connected" && canLoadOlderSettled(["saved:box:rp2"]));
  expect(olderSettledStatus(["saved:box:rp2"])).toBe("ready");

  setRequestBackendForTest(null);
  syncEnvironments([]);
  refreshMergedShell();
  resetEnvironmentsForTest();
  setEnvironmentTransportForTest(null);
});
