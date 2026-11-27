import { expect, test } from "nsh/test";
import { decodeRpcResult, decodeRpcResultAsync, requestWithRpcPolicy, setRpcDecodeFailureSinkForTest, setRpcResultDecodingForTest, setRpcResultEnforcementForTest, rpcConcurrencyFor, rpcPayloadFor, vcsRefsRevision } from "./backend/rpcConcurrency";
import { ensureRpcResultSchema, hasRpcResultSchema, setExternalRpcSchemaLoaderForTest } from "./backend/rpcResultSchema";
import shippedRpcSchemas from "./backend/rpcResultSchemas.json";
import { recordFetchedWorkspaceSnapshot, withFetchedWorkspaceSnapshots } from "./environments/fetchedWorkspaceSnapshots";

// Concurrency tests answer with placeholder replies; the schema test turns decoding back on.
setRpcResultDecodingForTest(false);

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

test("refreshProviders always sends workspaceSnapshotsOnDemand and usageLimitsCommand", () => {
  expect(rpcPayloadFor("server.refreshProviders", { modelCatalogOnly: true })).toEqual({ modelCatalogOnly: true, workspaceSnapshotsOnDemand: true, usageLimitsCommand: true });
  expect(rpcPayloadFor("server.refreshProviders", undefined)).toEqual({ workspaceSnapshotsOnDemand: true, usageLimitsCommand: true });
  expect(rpcPayloadFor("vcs.listRefs", { cwd: "/a" })).toEqual({ cwd: "/a" });
});

test("refreshProviders single-flights on the reference key", async () => {
  const sent: unknown[] = [];
  const gate = deferred<unknown>();
  const send = (payload: unknown) => { sent.push(payload); return gate.promise; };
  const a = requestWithRpcPolicy("env", "server.refreshProviders", { instanceId: "codex", cwd: "/w" }, send);
  const b = requestWithRpcPolicy("env", "server.refreshProviders", { instanceId: "codex", cwd: "/w", reloadSecrets: true }, send);
  const c = requestWithRpcPolicy("env", "server.refreshProviders", { instanceId: "codex", cwd: "/w", fresh: true }, send);
  expect(sent.length).toBe(2);
  gate.resolve({ providers: [{ instanceId: "codex" }] });
  expect(await a).toEqual(await b);
  await c;
  const d = requestWithRpcPolicy("env", "server.refreshProviders", { instanceId: "codex", cwd: "/w" }, async (payload) => { sent.push(payload); return { providers: [] }; });
  await d;
  expect(sent.length).toBe(3);
});

test("vcs commands run one at a time per cwd; another cwd is not held", async () => {
  const order: string[] = [];
  const first = deferred<unknown>();
  const a = requestWithRpcPolicy("env", "vcs.switchRef", { cwd: "/r", refName: "a" }, () => { order.push("a"); return first.promise; });
  const b = requestWithRpcPolicy("env", "vcs.createRef", { cwd: "/r", refName: "b" }, async () => { order.push("b"); return {}; });
  const other = requestWithRpcPolicy("env", "vcs.pull", { cwd: "/other" }, async () => { order.push("other"); return {}; });
  await other;
  expect(order).toEqual(["a", "other"]);
  first.resolve({});
  await a; await b;
  expect(order).toEqual(["a", "other", "b"]);
});

test("projects.createNew and projectClone.cancel are serial per environment", async () => {
  expect(rpcConcurrencyFor("env", "projects.createNew", { name: "x" })).toEqual({ mode: "serial", lane: "project", key: "env" });
  expect(rpcConcurrencyFor("env", "projectClone.cancel", { cloneId: "c" })).toEqual({ mode: "serial", lane: "source-control", key: "env" });
  expect(rpcConcurrencyFor("env", "preview.open", { threadId: "t" })?.key).toBe(JSON.stringify(["env", "t"]));
  const order: string[] = [];
  const gate = deferred<unknown>();
  const a = requestWithRpcPolicy("env", "projects.createNew", { name: "one" }, () => { order.push("one"); return gate.promise; });
  const b = requestWithRpcPolicy("env", "projects.createNew", { name: "two" }, async () => { order.push("two"); return {}; });
  await Promise.resolve();
  expect(order).toEqual(["one"]);
  gate.resolve({});
  await a; await b;
  expect(order).toEqual(["one", "two"]);
});

test("diff file contents single-flight (review and pull requests)", async () => {
  let calls = 0;
  const gate = deferred<unknown>();
  const input = { cwd: "/r", sourceKind: "branch", baseRef: "main", headRef: "HEAD", oldPath: "a", newPath: "a", changeType: "modified" };
  const send = () => { calls += 1; return gate.promise; };
  const a = requestWithRpcPolicy("env", "review.getDiffFileContents", input, send);
  const b = requestWithRpcPolicy("env", "review.getDiffFileContents", { ...input }, send);
  const pr = { projectId: "p", host: "GitHub.com", repository: "o/r", number: 1, changeType: "modified", oldPath: "a", newPath: "a" };
  const c = requestWithRpcPolicy("env", "pullRequests.diffFileContents", pr, send);
  const d = requestWithRpcPolicy("env", "pullRequests.diffFileContents", { ...pr, host: "github.com" }, send);
  expect(calls).toBe(2);
  gate.resolve({});
  await Promise.all([a, b, c, d]);
});

test("createRef / switchRef / preparePullRequestThread invalidate the cwd's branch list on success and failure", async () => {
  const before = vcsRefsRevision("/inv");
  await requestWithRpcPolicy("env", "vcs.createRef", { cwd: "/inv", refName: "x" }, async () => ({ refName: "x" }));
  expect(vcsRefsRevision("/inv")).toBe(before + 1);
  await requestWithRpcPolicy("env", "vcs.switchRef", { cwd: "/inv", refName: "y" }, async () => { throw new Error("refused"); }).catch(() => {});
  expect(vcsRefsRevision("/inv")).toBe(before + 2);
  await requestWithRpcPolicy("env", "git.preparePullRequestThread", { cwd: "/inv", reference: "1", mode: "local" }, async () => ({}));
  expect(vcsRefsRevision("/inv")).toBe(before + 3);
  await requestWithRpcPolicy("env", "vcs.listRefs", { cwd: "/inv" }, async () => ({}));
  expect(vcsRefsRevision("/inv")).toBe(before + 3);
});

test("a reply is decoded with its generated contract success schema; a mismatch rejects with the schema issue", async () => {
  setRpcResultDecodingForTest(true);
  setRpcResultEnforcementForTest(true);
  setRpcDecodeFailureSinkForTest(null);
  expect(() => decodeRpcResult("projects.listIgnoredFiles", { files: [{ path: "a" }], truncated: false })).toThrow('Missing key\n  at ["files"][0]["byteLength"]');
  expect(() => decodeRpcResult("projects.listIgnoredFiles", { files: [{ path: 1, byteLength: 2 }], truncated: false })).toThrow('Expected string, got 1\n  at ["files"][0]["path"]');
  expect(decodeRpcResult("projects.listIgnoredFiles", { files: [{ path: "a", byteLength: 2 }], truncated: false })).toEqual({ files: [{ path: "a", byteLength: 2 }], truncated: false });
  expect(() => decodeRpcResult("provider.consumeResetCredit", { outcome: "maybe" })).toThrow('got "maybe"');
  expect(decodeRpcResult("provider.consumeResetCredit", { outcome: "reset" })).toEqual({ outcome: "reset" });
  expect(hasRpcResultSchema("vcs.listRefs")).toBe(true);
  expect(hasRpcResultSchema("orchestration.subscribeThread")).toBe(false);
  let error: unknown;
  await requestWithRpcPolicy("env", "server.refreshProviders", {}, async () => ({ nope: true })).catch((cause) => { error = cause; });
  expect((error as Error).message).toBe('Missing key\n  at ["providers"]');
  setRpcResultDecodingForTest(false);
  setRpcResultEnforcementForTest(null);
});

test("log-only mode: a mismatch is logged with method and path and the reply is returned", async () => {
  setRpcResultDecodingForTest(true);
  setRpcResultEnforcementForTest(false);
  const logged: { method: string; issue: string; at: string }[] = [];
  setRpcDecodeFailureSinkForTest((entry) => logged.push(entry));
  expect(await requestWithRpcPolicy("env", "server.refreshProviders", {}, async () => ({ nope: true }))).toEqual({ nope: true });
  expect(logged).toEqual([{ method: "server.refreshProviders", issue: 'Missing key\n  at ["providers"]', at: logged[0]?.at }]);
  setRpcDecodeFailureSinkForTest(null);
  setRpcResultEnforcementForTest(null);
  setRpcResultDecodingForTest(false);
});

test("external per-method RPC schemas load on demand, validate, and fail closed on host errors", async () => {
  setRpcResultDecodingForTest(true);
  setRpcResultEnforcementForTest(true);
  setRpcDecodeFailureSinkForTest(null);
  const requested: string[] = [];
  setExternalRpcSchemaLoaderForTest(async (method) => {
    requested.push(method);
    if (method === "vcs.listRefs") {
      return {
        found: true,
        schema: { $ref: "#/$defs/ListRefsResult" },
        definitions: {
          ListRefsResult: {
            type: "object",
            required: ["branches"],
            properties: { branches: { type: "array", items: { type: "string" } } },
          },
        },
      };
    }
    if (method === "orchestration.getTurnDiff") {
      return {
        found: true,
        schema: { $ref: "#/$defs/OrchestrationTurnDiffRange" },
        definitions: {},
      };
    }
    if (method === "vcs.listRefsNoDefs") {
      return {
        found: true,
        schema: { $ref: "#/$defs/ListRefsResult" },
        definitions: {},
      };
    }
    if (method === "deep.refChain") {
      const defs: Record<string, Record<string, unknown>> = {};
      for (let i = 0; i < 33; i += 1) {
        defs[`D${i}`] = i < 32 ? { $ref: `#/$defs/D${i + 1}` } : { type: "string" };
      }
      return { found: true, schema: { $ref: "#/$defs/D0" }, definitions: defs };
    }
    if (method === "server.getConfig") {
      const catalog = shippedRpcSchemas as unknown as { methods: Record<string, unknown>; definitions: Record<string, unknown> };
      return { found: true, schema: catalog.methods["server.getConfig"], definitions: catalog.definitions };
    }
    if (method === "orchestration.subscribeThread") return { found: false };
    throw new Error("schema disk error");
  });
  try {
    expect(() => decodeRpcResult("vcs.listRefs", { branches: [] })).toThrow("RPC result schema was not loaded before decoding.");
    await expect(decodeRpcResultAsync("vcs.listRefs", {})).rejects.toThrow('Missing key\n  at ["branches"]');
    expect(await decodeRpcResultAsync("vcs.listRefs", { branches: ["main"] })).toEqual({ branches: ["main"] });
    // Even after ListRefsResult was cached globally by vcs.listRefs, a response omitting it must still fail.
    await expect(decodeRpcResultAsync("vcs.listRefsNoDefs", { branches: ["main"] })).rejects.toThrow("ListRefsResult");
    await expect(decodeRpcResultAsync("orchestration.getTurnDiff", { anything: true })).rejects.toThrow("OrchestrationTurnDiffRange");
    await expect(decodeRpcResultAsync("deep.refChain", "ok")).rejects.toThrow("depth exceeded");
    // Deeply nested shipped schemas (e.g. server.getConfig) must load without tripping the $ref-hop limit.
    await expect(decodeRpcResultAsync("server.getConfig", {})).rejects.toThrow("Missing key");
    expect(await decodeRpcResultAsync("orchestration.subscribeThread", { any: 1 })).toEqual({ any: 1 });
    await expect(decodeRpcResultAsync("broken.method", {})).rejects.toThrow("schema disk error");
    expect(requested).toEqual([
      "vcs.listRefs",
      "vcs.listRefsNoDefs",
      "orchestration.getTurnDiff",
      "deep.refChain",
      "server.getConfig",
      "orchestration.subscribeThread",
      "broken.method",
    ]);
  } finally {
    setExternalRpcSchemaLoaderForTest(null);
    setRpcResultDecodingForTest(false);
    setRpcResultEnforcementForTest(null);
  }
});

test("every shipped method schema loads cleanly through the external schema validator", async () => {
  const catalog = shippedRpcSchemas as unknown as { methods: Record<string, unknown>; definitions: Record<string, unknown> };
  const methodNames = Object.keys(catalog.methods);
  expect(methodNames.length).toBeGreaterThan(100);
  setExternalRpcSchemaLoaderForTest(async (method) => {
    const schema = catalog.methods[method];
    return schema ? { found: true, schema, definitions: catalog.definitions } : { found: false };
  });
  try {
    for (const method of methodNames) {
      await ensureRpcResultSchema(method);
      expect(hasRpcResultSchema(method)).toBe(true);
    }
  } finally {
    setExternalRpcSchemaLoaderForTest(null);
  }
});

test("preview.reportStatus / reportProfiles run latest-wins per key", async () => {
  const sent: unknown[] = [];
  const gate = deferred<unknown>();
  const send = (payload: unknown) => { sent.push(payload); return sent.length === 1 ? gate.promise : Promise.resolve({ ok: (payload as { url: string }).url }); };
  const status = (url: string) => ({ threadId: "t", tabId: "a", url });
  const a = requestWithRpcPolicy("env", "preview.reportStatus", status("1"), send);
  const b = requestWithRpcPolicy("env", "preview.reportStatus", status("2"), send);
  const c = requestWithRpcPolicy("env", "preview.reportStatus", status("3"), send);
  const other = requestWithRpcPolicy("env", "preview.reportStatus", { ...status("x"), tabId: "b" }, async (payload) => { sent.push(payload); return {}; });
  await other;
  expect(sent.map((item) => (item as { url: string }).url)).toEqual(["1", "x"]);
  gate.resolve({ ok: "1" });
  expect(await a).toEqual({ ok: "1" });
  expect(await b).toEqual({ ok: "3" });
  expect(await c).toEqual({ ok: "3" });
  expect(sent.map((item) => (item as { url: string }).url)).toEqual(["1", "x", "3"]);
  expect(rpcConcurrencyFor("env", "preview.reportProfiles", {})).toEqual({ mode: "latest", lane: "preview.reportProfiles", key: "env" });
});

test("fetched workspace snapshots merge back into an on-demand config, and drop when the basis changes", () => {
  const configCodex = { instanceId: "codex", enabled: true, skills: [], slashCommands: [] };
  const reply = [{ ...configCodex, workspaceSnapshots: [{ cwd: "/w", skills: [{ name: "s" }], slashCommands: [] }] }];
  const fetched = recordFetchedWorkspaceSnapshot([], { instanceId: "codex", cwd: "/w", fresh: false }, reply, configCodex);
  expect(fetched.length).toBe(1);
  expect(recordFetchedWorkspaceSnapshot(fetched, { instanceId: "codex", cwd: "/w", fresh: false }, reply, configCodex)).toBe(fetched);
  const merged = withFetchedWorkspaceSnapshots([configCodex, { instanceId: "claude" }], fetched, true);
  expect(merged[0].workspaceSnapshots).toEqual([{ cwd: "/w", skills: [{ name: "s" }], slashCommands: [] }]);
  expect(merged[1].workspaceSnapshots).toBe(undefined);
  expect(withFetchedWorkspaceSnapshots([configCodex], fetched, false)[0].workspaceSnapshots).toBe(undefined);
  expect(withFetchedWorkspaceSnapshots([{ ...configCodex, enabled: false }], fetched, true)[0].workspaceSnapshots).toBe(undefined);
  expect(recordFetchedWorkspaceSnapshot(fetched, { instanceId: "claude", cwd: "/w", fresh: true }, [], undefined).length).toBe(0);
});
