// client-runtime state/runtime.ts createAtomCommandScheduler: per-command concurrency, keyed as the reference keys it.
// - singleFlight: an identical in-flight request (same key) is answered by the one already running.
// - serial: requests that share a lane (same scheduler + key) run one at a time, in order.
// Lanes shared across methods follow the reference's shared schedulers (vcsCommandScheduler, preview lifecycleScheduler,
// projectScheduler, sourceControl commandScheduler).
import { signal } from "nsh";
import { ensureRpcResultSchema, isExternalRpcSchemaCatalog, rpcResultSchemaIssue } from "./rpcResultSchema";
import { writeDecodeFailure } from "./rpcDecodeLog";

type Dict = Record<string, unknown>;
const dict = (value: unknown): Dict => (value && typeof value === "object" && !Array.isArray(value) ? (value as Dict) : {});

export interface RpcConcurrency { readonly mode: "serial" | "singleFlight" | "latest"; readonly lane: string; readonly key: string }

/** state/vcsCommandScheduler.ts: serial per [environmentId, cwd], shared by vcs.ts, git.ts and sourceControl publish. */
const VCS_COMMANDS = new Set(["vcs.refreshBranch", "vcs.pull", "vcs.refreshStatus", "vcs.createWorktree", "vcs.removeWorktree",
  "vcs.createRef", "vcs.switchRef", "vcs.init", "git.preparePullRequestThread", "sourceControl.publishRepository"]);
/** state/preview.ts lifecycleConcurrency: serial per [environmentId, threadId]. */
const PREVIEW_LIFECYCLE = new Set(["preview.open", "preview.resize", "preview.adjust", "preview.close"]);
/** state/projectCommands.ts projectScheduler, key environmentId. */
const PROJECT_ENVIRONMENT = new Set(["projects.createNew", "projects.createFromThread"]);
/** state/sourceControl.ts commandScheduler, key environmentId. */
const CLONE_COMMANDS = new Set(["projectClone.start", "projectClone.cancel", "projectClone.retry"]);

export function rpcConcurrencyFor(environment: string, method: string, payload: unknown): RpcConcurrency | undefined {
  const input = dict(payload);
  if (VCS_COMMANDS.has(method)) return { mode: "serial", lane: "vcs", key: JSON.stringify([environment, input.cwd]) };
  if (PREVIEW_LIFECYCLE.has(method)) return { mode: "serial", lane: "preview-lifecycle", key: JSON.stringify([environment, input.threadId]) };
  if (PROJECT_ENVIRONMENT.has(method)) return { mode: "serial", lane: "project", key: environment };
  if (CLONE_COMMANDS.has(method)) return { mode: "serial", lane: "source-control", key: environment };
  // state/preview.ts: reportProfiles "latest" per environment; reportStatus "latest" per [environment, threadId, tabId].
  if (method === "preview.reportProfiles") return { mode: "latest", lane: method, key: environment };
  if (method === "preview.reportStatus") return { mode: "latest", lane: method, key: JSON.stringify([environment, input.threadId, input.tabId]) };
  if (method === "server.refreshProviders") {
    return { mode: "singleFlight", lane: method, key: JSON.stringify([environment, input.instanceId ?? null, input.cwd ?? null,
      input.fresh ?? false, input.refreshModels ?? false, input.modelCatalogOnly ?? false]) };
  }
  if (method === "review.getDiffFileContents") {
    return { mode: "singleFlight", lane: method, key: JSON.stringify([environment, input.cwd, input.sourceKind, input.baseRef,
      input.headRef, input.oldPath, input.newPath, input.changeType]) };
  }
  if (method === "pullRequests.diffFileContents") {
    const host = typeof input.host === "string" ? input.host.toLowerCase() : null;
    return { mode: "singleFlight", lane: method, key: JSON.stringify([environment, input.projectId, host, input.repository,
      input.number, input.commit ?? null, input.changeType, input.oldPath, input.newPath]) };
  }
  return undefined;
}

/**
 * state/server.ts refreshProviders execute: every refresh asks for workspace snapshots on demand, and (web runtime.ts
 * usageLimitsCommand: true) for /usage-limits in the replied snapshot.
 */
export function rpcPayloadFor(method: string, payload: unknown): unknown {
  if (method !== "server.refreshProviders") return payload;
  return { ...dict(payload), workspaceSnapshotsOnDemand: true, usageLimitsCommand: true };
}

const singleFlight = new Map<string, Promise<unknown>>();
/**
 * runtime.ts "latest": one request runs at a time per key; while it runs, a newer one replaces any still waiting, and
 * every caller that waited gets the newest request's result.
 */
interface LatestLane { running: boolean; pending: { execute: () => Promise<unknown>; settle: { resolve: (value: unknown) => void; reject: (error: unknown) => void }[] } | undefined }
const latest = new Map<string, LatestLane>();
function runLatest<T>(id: string, execute: () => Promise<T>): Promise<T> {
  let lane = latest.get(id);
  if (!lane) { lane = { running: false, pending: undefined }; latest.set(id, lane); }
  const active = lane;
  const result = new Promise<T>((resolve, reject) => {
    const settle = { resolve: resolve as (value: unknown) => void, reject };
    if (!active.pending) active.pending = { execute, settle: [settle] };
    else { active.pending.execute = execute; active.pending.settle.push(settle); }
  });
  if (!active.running) {
    active.running = true;
    void (async () => {
      while (active.pending) {
        const batch = active.pending;
        active.pending = undefined;
        try { const value = await batch.execute(); for (const item of batch.settle) item.resolve(value); }
        catch (error) { for (const item of batch.settle) item.reject(error); }
      }
      active.running = false;
      if (latest.get(id) === active) latest.delete(id);
    })();
  }
  return result;
}
const serial = new Map<string, Promise<unknown>>();

export function runWithRpcConcurrency<T>(environment: string, method: string, payload: unknown, execute: () => Promise<T>): Promise<T> {
  const policy = rpcConcurrencyFor(environment, method, payload);
  if (!policy) return execute();
  const id = `${policy.lane}\u0000${policy.key}`;
  if (policy.mode === "latest") return runLatest(id, execute);
  const lanes = policy.mode === "singleFlight" ? singleFlight : serial;
  const previous = lanes.get(id) as Promise<T> | undefined;
  if (policy.mode === "singleFlight" && previous) return previous;
  const current = previous === undefined ? execute() : previous.then(execute, execute);
  lanes.set(id, current);
  const release = () => { if (lanes.get(id) === current) lanes.delete(id); };
  current.then(release, release);
  return current;
}

/**
 * state/vcs.ts invalidateRefs (createRef, switchRef, removeWorktree) and state/git.ts preparePullRequestThread
 * onSettled: the cwd's cached branch list is invalidated on success and on failure. Branch lists read
 * `vcsRefsRevision(cwd)` and reload when it moves.
 */
const REFS_INVALIDATING = new Set(["vcs.createRef", "vcs.switchRef", "vcs.removeWorktree", "git.preparePullRequestThread"]);
const refsRevisions = signal<Record<string, number>>({});
export const vcsRefsRevision = (cwd: string | null | undefined): number => (cwd ? refsRevisions()[cwd] ?? 0 : 0);
export function invalidateVcsRefs(cwd: unknown): void {
  if (typeof cwd !== "string" || !cwd) return;
  refsRevisions.update((all) => ({ ...all, [cwd]: (all[cwd] ?? 0) + 1 }));
}

/**
 * effect rpc RpcClient decodeExit + Effect.orDie: every request's reply is decoded with its contract success schema
 * (backend/rpcResultSchemas.json, generated from packages/contracts), so a reply of the wrong shape fails the call with
 * the schema issue ("Expected string, got 1\n  at ["files"][0]["path"]") instead of being read loosely.
 */
export class RpcResultDecodeError extends Error {
  readonly _tag = "RpcResultDecodeError";
  constructor(readonly method: string, readonly issue: string) { super(issue); }
}

let resultDecoding = true;
/** Test seam: concurrency tests answer with placeholder replies. */
export function setRpcResultDecodingForTest(enabled: boolean) { resultDecoding = enabled; }

/**
 * Enforcement: a mismatch fails the call (the reference's behaviour) only while enforcing. The default is set by
 * RPC_DECODE_ENFORCE_DEFAULT; `T3_RPC_DECODE_ENFORCE=1|0` in the environment overrides it. Every mismatch is logged
 * either way (console and `<dataDir>/rpc-decode/failures.ndjson`).
 */
export const RPC_DECODE_ENFORCE_DEFAULT = true; // flipped after harness runs on multienv + multienv2 (97 replies, 0 mismatches)
let enforceOverride: boolean | null = null;
export function setRpcResultEnforcementForTest(enforce: boolean | null) { enforceOverride = enforce; }
export function rpcResultEnforced(): boolean {
  if (enforceOverride !== null) return enforceOverride;
  const flag = typeof process !== "undefined" ? process.env?.T3_RPC_DECODE_ENFORCE : undefined;
  return flag === "1" ? true : flag === "0" ? false : RPC_DECODE_ENFORCE_DEFAULT;
}
let failureSink: ((entry: { method: string; issue: string; at: string }) => void) | null = writeDecodeFailure;
export function setRpcDecodeFailureSinkForTest(sink: typeof failureSink) { failureSink = sink; }

export function decodeRpcResult<T>(method: string, value: T): T {
  if (!resultDecoding) return value;
  const issue = rpcResultSchemaIssue(method, value);
  if (issue) {
    // Effect.orDie: the reference logs the decode defect; the call fails with it.
    console.error(`RpcResultDecodeError ${method}: ${issue}`);
    try { failureSink?.({ method, issue, at: new Date().toISOString() }); } catch { /* logging never fails the call */ }
    if (rpcResultEnforced()) throw new RpcResultDecodeError(method, issue);
  }
  return value;
}

export async function decodeRpcResultAsync<T>(method: string, value: T): Promise<T> {
  if (!resultDecoding) return value;
  if (isExternalRpcSchemaCatalog()) {
    try {
      await ensureRpcResultSchema(method);
    } catch (cause) {
      const issue = cause instanceof Error && cause.message ? cause.message : "Could not load RPC result schema.";
      console.error(`RpcResultDecodeError ${method}: ${issue}`);
      try { failureSink?.({ method, issue, at: new Date().toISOString() }); } catch { /* logging never fails the call */ }
      if (rpcResultEnforced()) throw new RpcResultDecodeError(method, issue);
      return value;
    }
  }
  return decodeRpcResult(method, value);
}

/** Reference wrapper: payload flags plus the keyed concurrency, for one environment's request function. */
export function requestWithRpcPolicy<T>(environment: string, method: string, payload: unknown, send: (payload: unknown) => Promise<T>): Promise<T> {
  const sent = rpcPayloadFor(method, payload);
  const result = runWithRpcConcurrency(environment, method, sent, () => send(sent).then((value) => decodeRpcResultAsync(method, value)));
  if (REFS_INVALIDATING.has(method)) {
    const settle = () => invalidateVcsRefs(dict(sent).cwd);
    result.then(settle, settle);
  }
  return result;
}
