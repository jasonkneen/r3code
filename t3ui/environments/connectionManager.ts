// One live session per enabled saved environment, beside the primary connection in store.ts.
// Mirrors the reference connection supervisor (packages/client-runtime/src/connection) and the
// per-environment shell (orchestration.subscribeShell), with ids scoped as in
// packages/client-runtime/src/environment/scoped.ts ("<environmentId>:<localId>").
import { classifyConnectionFailure, type ConnectionAttemptError } from "./connectionDiagnosis";
import { requestWithRpcPolicy } from "../backend/rpcConcurrency";
import { signal } from "nsh";
import { BackendClient, record, type SocketConnection } from "../backend/client";
import { issueSocketUrl } from "../backend/auth";
import { loadSessionBearer } from "../backend/sessionCredential";
import { RequestFailure } from "../backend/client";
import { mergeArchiveSnapshot, recordArchiveChange, type ArchiveChanges } from "./archiveSnapshot";
import { clearFamilyRemovals, recordFamilyShellEvent } from "./familyRemovals";
import {
  fetchShellSnapshotWith, noteShellEvent, prepareShellInput, ReconnectLadder, runInConfigLane, isSerialConfigMethod, runShellStream, SERVER_CONFIG_STREAM_INPUT,
  shellIdentityOf, type ShellResumeState,
} from "./environmentSession";

export type EnvironmentConnectionPhase = "available" | "offline" | "connecting" | "reconnecting" | "connected" | "error" | "unsupported";
export interface EnvironmentConnection { phase: EnvironmentConnectionPhase; error: string | null }
export interface ManagedEnvironment { id: string; label: string; url: string; enabled: boolean; ssh?: unknown; relay?: { environmentId: string } }

/** A T3 Connect route's socket URL for one attempt (backend/relayRoute.ts with the DPoP key); set by environments/install.ts. */
let relayRoute: ((relayEnvironmentId: string) => Promise<{ socketUrl: string }>) | null = null;
export function setEnvironmentRelayRoute(route: typeof relayRoute) { relayRoute = route; }

/** Runs before each connect (an SSH environment's tunnel); set by environments/sshSaved.ts. */
let preconnect: ((environment: ManagedEnvironment) => Promise<void>) | null = null;
export function setEnvironmentPreconnect(run: ((environment: ManagedEnvironment) => Promise<void>) | null) { preconnect = run; }
export interface OlderSettledCut { before: string; asOfSequence: number; counts: { projectId: string; count: number }[] }
export type OlderSettledStatus = "ready" | "pending" | "failed" | "done";
export const OLDER_SETTLED_PAGE_SIZE = 25;

export function readOlderSettledCut(value: unknown): OlderSettledCut | null {
  const cut = record(value);
  if (!cut || typeof cut.before !== "string" || typeof cut.asOfSequence !== "number" || !Array.isArray(cut.counts)) return null;
  return {
    before: cut.before,
    asOfSequence: cut.asOfSequence,
    counts: cut.counts.map(record).flatMap((entry) =>
      entry && typeof entry.projectId === "string" && typeof entry.count === "number" ? [{ projectId: entry.projectId, count: entry.count }] : []),
  };
}

export function olderSettledCountRowKeyFor(cut: OlderSettledCut | null, row: Record<string, unknown> | undefined): string | null {
  if (!row || !cut) return null;
  const lineage = record(row.lineage);
  const created = typeof row.createdAt === "string" ? Date.parse(row.createdAt) : NaN;
  if (lineage?.relationshipToParent === "subagent" || lineage?.sideChat === true || created >= Date.parse(cut.before)) return null;
  if (!Number.isFinite(created)) return null;
  const at = typeof row.settledAt === "string" ? Date.parse(row.settledAt) : NaN;
  return `${row.id}:${row.settledOverride === "settled" && at < Date.parse(cut.before) ? 1 : 0}`;
}

export function countUnloadedOlderSettled(
  cut: OlderSettledCut | null,
  rows: Record<string, unknown>[],
  projectIds?: ReadonlySet<string>,
): number {
  if (!cut) return 0;
  const filter = projectIds && projectIds.size > 0 ? projectIds : undefined;
  const total = cut.counts.reduce((sum, entry) => sum + (!filter || filter.has(entry.projectId) ? entry.count : 0), 0);
  const before = Date.parse(cut.before);
  const loaded = rows.filter((row) => {
    const lineage = record(row.lineage);
    const at = typeof row.settledAt === "string" ? Date.parse(row.settledAt) : NaN;
    return (!filter || filter.has(String(row.projectId))) && row.settledOverride === "settled"
      && lineage?.relationshipToParent !== "subagent" && lineage?.sideChat !== true && at < before;
  }).length;
  return Math.max(0, total - loaded);
}

export interface EnvironmentShell {
  projects: Record<string, unknown>[];
  threads: Record<string, unknown>[];
  archived: Record<string, unknown>[];
  loaded: boolean;
  olderSettled?: OlderSettledCut | null;
  olderSettledRows?: Record<string, unknown>[];
}

/** connectionStatusText (connection/presentation.ts), verbatim. */
export function connectionStatusText(connection: EnvironmentConnection): string {
  switch (connection.phase) {
    case "available": return "Available";
    case "offline": return "Offline";
    case "connecting": return "Connecting...";
    case "reconnecting": return connection.error ? `Failed to connect. Reconnecting... Reason: ${connection.error}` : "Reconnecting...";
    case "connected": return "Connected";
    case "unsupported": return "Client not supported";
    case "error": return connection.error ? `Connection failed. Reason: ${connection.error}` : "Connection failed";
  }
}

export const scopedKey = (environmentId: string, localId: string) => `${environmentId}:${localId}`;
const SAVED_SCOPED_KEY = /^(saved:[^:]+):([\s\S]+)$/;

/** The remote environment and local id of a scoped key, or null for a primary (unscoped) id. */
export function parseScopedKey(key: string): { environmentId: string; localId: string } | null {
  for (const environmentId of sessions.keys()) {
    const prefix = `${environmentId}:`;
    if (key.startsWith(prefix) && key.length > prefix.length) return { environmentId, localId: key.slice(prefix.length) };
  }
  const match = SAVED_SCOPED_KEY.exec(key);
  if (match) return { environmentId: match[1]!, localId: match[2]! };
  return null;
}

/** handleShellEvent's rules (store.ts) over one environment's shell; thread updates replace in place. */
export function foldShellEvent(shell: EnvironmentShell, value: unknown): boolean {
  const event = record(value);
  if (!event) return false;
  const list = (items: unknown) => Array.isArray(items) ? items.map(record).filter((item): item is Record<string, unknown> => item !== null) : [];
  if (event.kind === "snapshot") {
    const snapshot = record(event.snapshot);
    if (!snapshot) return false;
    if (Array.isArray(event.resolvedRepositoryIdentityRoots) && (shell.projects.length > 0 || shell.threads.length > 0)) {
      const byId = new Map(list(snapshot.projects).map((item) => [item.id, item] as const));
      shell.projects = shell.projects.map((project) => {
        const candidate = byId.get(project.id);
        return candidate && candidate.workspaceRoot === project.workspaceRoot && candidate.repositoryIdentity != null
          ? { ...project, repositoryIdentity: candidate.repositoryIdentity } : project;
      });
    } else {
      shell.projects = list(snapshot.projects);
      shell.threads = list(snapshot.threads);
      shell.olderSettled = readOlderSettledCut(snapshot.olderSettled);
      shell.olderSettledRows = [];
      shell.loaded = true;
    }
  } else if (event.kind === "project.updated") {
    const project = record(event.project);
    if (!project || typeof project.id !== "string") return false;
    const index = shell.projects.findIndex((item) => item.id === project.id);
    if (index >= 0) shell.projects[index] = project; else shell.projects.push(project);
  } else if (event.kind === "project.removed") {
    shell.projects = shell.projects.filter((item) => item.id !== event.projectId);
  } else if (event.kind === "thread.updated") {
    const thread = record(event.thread);
    if (!thread || typeof thread.id !== "string") return false;
    const active = shell.threads.findIndex((item) => item.id === thread.id);
    const archive = shell.archived.findIndex((item) => item.id === thread.id);
    if (event.location === "active" && active >= 0 && archive < 0) shell.threads[active] = thread;
    else if (event.location === "archive" && archive >= 0 && active < 0) {
      if (shell.olderSettledRows?.length) shell.olderSettledRows = shell.olderSettledRows.filter((item) => item.id !== thread.id);
      shell.archived[archive] = thread;
    } else {
      shell.threads = shell.threads.filter((item) => item.id !== thread.id);
      shell.archived = shell.archived.filter((item) => item.id !== thread.id);
      if (event.location === "active") shell.threads.push(thread);
      else if (event.location === "archive") {
        if (shell.olderSettledRows?.length) shell.olderSettledRows = shell.olderSettledRows.filter((item) => item.id !== thread.id);
        shell.archived.push(thread);
      }
    }
  } else if (event.kind === "thread.removed") {
    if (shell.olderSettledRows?.length) shell.olderSettledRows = shell.olderSettledRows.filter((item) => item.id !== event.threadId);
    if (event.location === "active") shell.threads = shell.threads.filter((item) => item.id !== event.threadId);
    if (event.location === "archive") shell.archived = shell.archived.filter((item) => item.id !== event.threadId);
  } else return false;
  return true;
}

interface Session {
  identity: number;
  environment: ManagedEnvironment;
  client: BackendClient | null;
  shell: EnvironmentShell;
  generation: number;
  archiveRequest?: number;
  archiveChanges?: ArchiveChanges | null;
  /** supervisor.ts retry ladder (shared with the primary). */
  ladder: ReconnectLadder;
  /** shell.ts cursor and origin, kept across reconnects so the shell resumes. */
  shellResume: ShellResumeState;
  timer: number | undefined;
  /** supervisor.ts failedProbe: the next attempt starts at once on a reset ladder. */
  probeFailed?: boolean;
  olderSettledStatus: OlderSettledStatus;
  olderSettledFrontier: { settledAt: string; threadId?: string } | null;
  olderSettledScopeKey: string;
  olderSettledGeneration: number;
  olderSettledCountGeneration: number;
  olderSettledCountTimer: ReturnType<typeof setTimeout> | null;
  olderSettledPageDropped?: Set<string> | null;
}

const sessions = new Map<string, Session>();
let nextSessionIdentity = 0;
/** Connection state per remote environment id. */
export const environmentConnections = signal<Record<string, EnvironmentConnection>>({});
/** applyServerConfigProjection for a remote environment's cached config; null when the event changes nothing. */
export function foldConfigEvent(config: Record<string, unknown> | null, value: unknown): Record<string, unknown> | null {
  const event = record(value);
  if (!event) return null;
  const payload = record(event.payload) ?? {};
  if (event.type === "snapshot") return record(event.config);
  if (!config) return null;
  if (event.type === "settingsUpdated") return { ...config, settings: payload.settings };
  if (event.type === "providerStatuses") return { ...config, providers: payload.providers };
  if (event.type === "keybindingsUpdated") return { ...config, keybindings: payload.keybindings, issues: payload.issues };
  return null;
}

/** Each saved environment's /.well-known/t3/environment descriptor (label, serverVersion, protocol, capabilities). */
export const environmentDescriptors = signal<Record<string, Record<string, unknown>>>({});
type DescriptorCheck = (url: string) => Promise<{ descriptor: Record<string, unknown> | null; blocked: string | null }>;
let descriptorCheck: DescriptorCheck | null = null;
/** install.ts wires the store's descriptor fetch and protocol check (kept out of this module to avoid an import cycle). */
export function setEnvironmentDescriptorCheck(check: DescriptorCheck | null) { descriptorCheck = check; }
/** A saved environment's server version: its descriptor's, else its config's. */
export function environmentServerVersion(id: string): string | null {
  const fromDescriptor = environmentDescriptors()[id]?.serverVersion;
  if (typeof fromDescriptor === "string") return fromDescriptor;
  const fromConfig = record(environmentConfigs()[id]?.environment)?.serverVersion;
  return typeof fromConfig === "string" ? fromConfig : null;
}

/** server.getConfig of each connected remote environment. */
export const environmentConfigs = signal<Record<string, Record<string, unknown>>>({});
/** Bumped after any remote shell changes; readers then call remoteShell(id). */
export const remoteShellRevision = signal(0);
const remoteOlderSettledRevision = signal(0);
const NONE_SCOPE_KEY = "\0none";

type Opener = (url: string) => Promise<SocketConnection>;
let openSocketOverride: Opener | null = null;
let ticketOverride: ((url: string) => Promise<string>) | null = null;
/** Tests: answer tickets and sockets without a network. */
export function setEnvironmentTransportForTest(transport: { ticket: (url: string) => Promise<string>; open: Opener } | null) {
  ticketOverride = transport?.ticket ?? null;
  openSocketOverride = transport?.open ?? null;
}

/** The supervisor's attempt state per environment (attempts, last classified failure, next retry), for the diagnosis panel. */
export interface EnvironmentAttemptState { attempt: number; lastFailure: ConnectionAttemptError | null; retryAt: number | null }
export const environmentAttempts = signal<Record<string, EnvironmentAttemptState>>({});
function setAttempt(id: string, next: EnvironmentAttemptState | null) {
  environmentAttempts.update((all) => { const copy = { ...all }; if (next) copy[id] = next; else delete copy[id]; return copy; });
}

function setConnection(id: string, next: EnvironmentConnection | null) {
  environmentConnections.update((all) => {
    const copy = { ...all };
    if (next) copy[id] = next; else delete copy[id];
    return copy;
  });
}

export const remoteShell = (id: string): EnvironmentShell | null => sessions.get(id)?.shell ?? null;
export const managedEnvironmentIds = () => [...sessions.keys()];
export const managedEnvironment = (id: string) => sessions.get(id)?.environment ?? null;
/** Changes whenever a linked environment reconnects or is removed. */
export const environmentGeneration = (id: string) => { const session = sessions.get(id); return session ? `${session.identity}:${session.generation}` : "missing"; };

/**
 * One saved environment's session, on the primary's model (environmentSession.ts): rpc/session.ts config stream with the
 * runtime flags (its snapshot is the config, no extra server.getConfig; its failure or end ends the session), then the
 * shell stream (omissions, cursor resume, HTTP /shell snapshot), which retries by itself without closing the socket.
 */
async function open(session: Session) {
  const generation = ++session.generation;
  const { id, url } = session.environment;
  clearFamilyRemovals(id);
  const current = () => sessions.get(id) === session && session.generation === generation;
  setConnection(id, { phase: session.ladder.failureCount === 0 ? "connecting" : "reconnecting", error: environmentConnections()[id]?.error ?? null });
  try {
    let socketUrl: string;
    let bearer: string | null = null;
    if (preconnect && session.environment.ssh) { await preconnect(session.environment); if (!current()) return; }
    // connection/compatibility.ts: the descriptor's protocol version is checked before connecting, as for the primary.
    if (descriptorCheck) {
      const checked = await descriptorCheck(url);
      if (!current()) return;
      if (checked.descriptor) environmentDescriptors.update((all) => ({ ...all, [id]: checked.descriptor! }));
      if (checked.blocked) { setConnection(id, { phase: "unsupported", error: checked.blocked }); return; }
    }
    if (ticketOverride) socketUrl = await ticketOverride(url);
    else if (session.environment.relay) {
      // T3 Connect route: a DPoP key-bound credential, ticket and upgrade proof (no bearer, so no HTTP shell snapshot).
      if (!relayRoute) throw new Error("T3 Connect is not available in this build.");
      socketUrl = (await relayRoute(session.environment.relay.environmentId)).socketUrl;
    } else {
      bearer = await loadSessionBearer(url);
      if (!bearer) throw Object.assign(new Error("Pairing expired. Add the environment again."), { fatal: true });
      socketUrl = await issueSocketUrl(url, bearer);
    }
    if (!current()) return;
    const fail = (error: Error) => {
      if (!current()) return;
      session.client?.close(error);
      session.client = null;
      backoff(session, error);
    };
    const next = openSocketOverride ? new BackendClient(fail, openSocketOverride) : new BackendClient(fail);
    session.client = next;
    await next.connect(socketUrl);
    if (!current()) { next.close(); return; }
    setConnection(id, { phase: "connected", error: null });
    const live = () => current() && session.client === next;
    let configReady = false;
    next.subscribe("subscribeServerConfig", SERVER_CONFIG_STREAM_INPUT, (value) => {
      if (!live()) return;
      const event = record(value);
      if (event?.type === "usageLimitSourcesUpdated") {
        const sources = record(event.payload)?.sources;
        if (Array.isArray(sources)) environmentUsageSources.update((all) => ({ ...all, [id]: sources }));
      }
      const folded = foldConfigEvent(environmentConfigs()[id] ?? null, value);
      if (folded) environmentConfigs.update((all) => ({ ...all, [id]: folded }));
      if (event?.type !== "snapshot" || configReady) return;
      configReady = true;
      const sources = record(event.config)?.usageLimitSources;
      if (Array.isArray(sources)) environmentUsageSources.update((all) => ({ ...all, [id]: sources }));
      session.ladder.established();
      setAttempt(id, null);
      const identity = () => shellIdentityOf(environmentConfigs()[id]);
      const shellStream = runShellStream({
        client: next,
        live,
        prepare: () => prepareShellInput(session.shellResume, identity(),
          bearer && !openSocketOverride ? () => fetchShellSnapshotWith(null, url, bearer!, identity()) : null,
          (snapshot) => {
            if (!live()) return false;
            const event = { kind: "snapshot", snapshot };
            recordFamilyShellEvent(id, event);
            noteShellEvent(session.shellResume, event, identity());
            if (foldShellEvent(session.shell, event)) {
              resetSessionOlderSettled(session);
              remoteShellRevision.update((n) => n + 1);
            }
            return true;
          }),
        receive: (item) => {
          if (!live()) return;
          const event = record(item);
          if (event) {
            recordArchiveChange(session.archiveChanges, event);
            recordFamilyShellEvent(id, event);
          }
          noteShellEvent(session.shellResume, item, identity());
          // shell.ts: snapshot-required keeps the rows and reloads (HTTP snapshot) before the next resume.
          if (event?.kind === "snapshot-required") { shellStream.reload(); return; }
          const authoritativeSnapshot = event?.kind === "snapshot"
            && !(Array.isArray(event.resolvedRepositoryIdentityRoots) && (session.shell.projects.length > 0 || session.shell.threads.length > 0));
          const updatedThreadId = event?.kind === "thread.updated" ? record(event.thread)?.id : undefined;
          if (session.olderSettledPageDropped) {
            if (event?.kind === "thread.removed" && typeof event.threadId === "string") {
              session.olderSettledPageDropped.add(event.threadId);
            } else if (event?.kind === "thread.updated" && typeof updatedThreadId === "string") {
              if (event.location === "archive") session.olderSettledPageDropped.add(updatedThreadId);
              else if (event.location === "active") session.olderSettledPageDropped.delete(updatedThreadId);
            }
          }
          const previousRow = typeof updatedThreadId === "string"
            ? (session.shell.threads.find((row) => row.id === updatedThreadId)
              ?? session.shell.olderSettledRows?.find((row) => row.id === updatedThreadId))
            : undefined;
          const previousCountKey = olderSettledCountRowKeyFor(session.shell.olderSettled ?? null, previousRow);
          if (foldShellEvent(session.shell, item)) {
            if (authoritativeSnapshot) resetSessionOlderSettled(session);
            else if (event?.kind === "thread.updated") {
              const updatedThread = record(event.thread) ?? undefined;
              const nextCountKey = olderSettledCountRowKeyFor(
                session.shell.olderSettled ?? null,
                event.location === "active" ? updatedThread : undefined,
              );
              const archivedMayBeOlder = event.location === "archive" && previousRow === undefined && Boolean(session.shell.olderSettled)
                && (typeof updatedThread?.createdAt !== "string" || olderSettledCountRowKeyFor(session.shell.olderSettled ?? null, updatedThread) !== null);
              if (previousCountKey !== nextCountKey || archivedMayBeOlder) refreshRemoteOlderSettledCounts(session);
            } else if (event?.kind === "thread.removed") {
              refreshRemoteOlderSettledCounts(session);
            }
            remoteShellRevision.update((n) => n + 1);
          }
        },
        stopRetrying: (error) => error instanceof RequestFailure && /authoriz/i.test(error.tag ?? ""),
      });
    }, fail, () => fail(new Error("The environment ended its configuration stream.")));
  } catch (error) {
    if (!current()) return;
    session.client = null;
    const failure = error instanceof Error ? error : new Error(String(error));
    if ((failure as { fatal?: boolean }).fatal || /HTTP 40[13]/.test(failure.message)) {
      setAttempt(id, { attempt: session.ladder.failureCount + 1, lastFailure: classifyConnectionFailure(failure), retryAt: null });
      setConnection(id, { phase: "error", error: failure.message });
      return;
    }
    backoff(session, failure);
  }
}

function backoff(session: Session, error: Error) {
  setConnection(session.environment.id, { phase: "reconnecting", error: error.message });
  const probeFailed = session.probeFailed === true;
  session.probeFailed = false;
  if (probeFailed) session.ladder.reset();
  const delay = probeFailed ? 0 : session.ladder.nextDelay();
  setAttempt(session.environment.id, { attempt: session.ladder.failureCount, lastFailure: classifyConnectionFailure(error), retryAt: Date.now() + delay });
  clearTimeout(session.timer);
  session.timer = setTimeout(() => void open(session), delay);
}

function resetSessionOlderSettled(session: Session) {
  session.olderSettledGeneration += 1;
  session.olderSettledCountGeneration += 1;
  if (session.olderSettledCountTimer !== null) clearTimeout(session.olderSettledCountTimer);
  session.olderSettledCountTimer = null;
  session.olderSettledFrontier = null;
  session.olderSettledPageDropped = null;
  session.olderSettledStatus = "ready";
  remoteOlderSettledRevision.update((n) => n + 1);
}

function refreshRemoteOlderSettledCounts(session: Session) {
  const cut = session.shell.olderSettled ?? null;
  const client = session.client;
  if (!cut || !client) return;
  const sessionGeneration = session.generation;
  const generation = ++session.olderSettledCountGeneration;
  if (session.olderSettledCountTimer !== null) clearTimeout(session.olderSettledCountTimer);
  session.olderSettledCountTimer = setTimeout(() => {
    session.olderSettledCountTimer = null;
    if (sessions.get(session.environment.id) !== session || session.generation !== sessionGeneration || session.client !== client) return;
    void client.request("orchestration.getOlderSettledThreads", { before: { settledAt: cut.before }, limit: 0 }).then((value) => {
      if (
        sessions.get(session.environment.id) !== session ||
        session.generation !== sessionGeneration ||
        generation !== session.olderSettledCountGeneration ||
        session.shell.olderSettled?.before !== cut.before
      ) return;
      const page = record(value);
      if (!page || !Array.isArray(page.counts)) return;
      const next = readOlderSettledCut({
        before: cut.before,
        asOfSequence: typeof page.snapshotSequence === "number" ? page.snapshotSequence : cut.asOfSequence,
        counts: page.counts,
      });
      if (next) {
        session.shell.olderSettled = next;
        remoteOlderSettledRevision.update((n) => n + 1);
      }
    }).catch(() => {});
  }, 500);
}

function stop(session: Session) {
  session.generation++;
  session.olderSettledGeneration++;
  session.olderSettledCountGeneration++;
  clearTimeout(session.timer);
  if (session.olderSettledCountTimer !== null) clearTimeout(session.olderSettledCountTimer);
  session.olderSettledCountTimer = null;
  session.olderSettledPageDropped = null;
  if (session.olderSettledStatus === "pending") {
    session.olderSettledStatus = "ready";
    remoteOlderSettledRevision.update((n) => n + 1);
  }
  session.client?.close();
  session.client = null;
}

/** Each saved environment's usage limit sources, from its one config stream (state/server.ts). */
export const environmentUsageSources = signal<Record<string, unknown[]>>({});

/**
 * supervisor.ts: on wake every connection is probed (server.probe, 15 s); an unanswered probe replaces the socket and
 * retries at once on a reset ladder. An RPC error is an answer.
 */
export function probeEnvironments(timeoutMs = 15_000) {
  for (const session of sessions.values()) {
    const current = session.client;
    if (!current || environmentConnections()[session.environment.id]?.phase !== "connected") continue;
    void current.request("server.probe", {}, { timeoutMs }).catch((error: unknown) => {
      if (error instanceof RequestFailure || session.client !== current) return;
      session.probeFailed = true;
      current.abandon(new Error("The environment did not respond to a connection health check."));
    });
  }
}

/** Keeps exactly one session per enabled environment; disabled ones are shown offline, removed ones dropped. */
export function syncEnvironments(list: ManagedEnvironment[]) {
  const wanted = new Map(list.map((item) => [item.id, item] as const));
  for (const [id, session] of sessions) {
    const next = wanted.get(id);
    if (!next || next.url !== session.environment.url) {
      stop(session);
      sessions.delete(id);
      setConnection(id, null);
      setAttempt(id, null);
      remoteOlderSettledRevision.update((n) => n + 1);
      remoteShellRevision.update((n) => n + 1);
    }
  }
  for (const environment of list) {
    const existing = sessions.get(environment.id);
    if (existing) {
      const wasEnabled = existing.environment.enabled;
      existing.environment = environment;
      if (wasEnabled && !environment.enabled) {
        stop(existing);
        setConnection(environment.id, { phase: "offline", error: null });
        remoteOlderSettledRevision.update((n) => n + 1);
        remoteShellRevision.update((n) => n + 1);
      } else if (!wasEnabled && environment.enabled) {
        existing.ladder.reset();
        void open(existing);
      }
      continue;
    }
    const session: Session = {
      identity: ++nextSessionIdentity,
      environment,
      client: null,
      shell: { projects: [], threads: [], archived: [], loaded: false, olderSettled: null, olderSettledRows: [] },
      generation: 0,
      ladder: new ReconnectLadder(),
      shellResume: { cursor: null, origin: null },
      timer: undefined,
      olderSettledStatus: "ready",
      olderSettledFrontier: null,
      olderSettledScopeKey: "",
      olderSettledGeneration: 0,
      olderSettledCountGeneration: 0,
      olderSettledCountTimer: null,
    };
    sessions.set(environment.id, session);
    if (environment.enabled) void open(session);
    else setConnection(environment.id, { phase: "offline", error: null });
  }
}

/** Reconnect now (the reference's retry action), resetting the backoff. */
export function reconnectEnvironment(id: string) {
  const session = sessions.get(id);
  if (!session || !session.environment.enabled) return;
  stop(session);
  session.ladder.reset();
  void open(session);
}

export function requestEnvironment(id: string, method: string, payload: unknown, options?: { timeoutMs?: number }): Promise<unknown> {
  const session = sessions.get(id);
  if (!session?.client || environmentConnections()[id]?.phase !== "connected") return Promise.reject(new Error("Connect an environment first"));
  const client = session.client;
  // state/server.ts configConcurrency "serial": config edits run one at a time per environment.
  if (isSerialConfigMethod(method)) return runInConfigLane(id, () => client.request(method, payload, options));
  // createEnvironmentRpcCommand concurrency (singleFlight / serial lanes) and refreshProviders flags, as the reference.
  return requestWithRpcPolicy(id, method, payload, (sent) => client.request(method, sent, options));
}

/** Load an individual linked environment's archived shells for relationship views. */
export async function refreshRemoteArchive(id: string): Promise<void> {
  const session = sessions.get(id);
  const client = session?.client;
  if (!session || !client || environmentConnections()[id]?.phase !== "connected") throw new Error("Connect an environment first");
  const generation = session.generation;
  const request = session.archiveRequest = (session.archiveRequest ?? 0) + 1;
  const changes: ArchiveChanges = new Map();
  session.archiveChanges = changes;
  try {
    const snapshot = record(await client.request("orchestration.getArchivedShellSnapshot", {}));
    if (!snapshot || !Array.isArray(snapshot.threads)) throw new Error("Invalid archived thread list");
    if (sessions.get(id) !== session || session.client !== client || session.generation !== generation || session.archiveRequest !== request) return;
    session.shell.archived = mergeArchiveSnapshot(snapshot.threads.map(record).filter((thread): thread is Record<string, unknown> => thread !== null), changes);
    remoteShellRevision.update((n) => n + 1);
  } finally {
    if (session.archiveChanges === changes) session.archiveChanges = null;
  }
}

export function subscribeEnvironment(id: string, method: string, payload: unknown, onValue: (value: unknown) => void, onError: (error: Error) => void): () => void {
  const session = sessions.get(id);
  if (!session?.client || environmentConnections()[id]?.phase !== "connected") { onError(new Error("Connect an environment first")); return () => {}; }
  return session.client.subscribe(method, payload, onValue, onError);
}

// Remote shell records with scoped ids and their environmentId, cached by source object so the
// store's memo-by-identity (shellLoad.perf.test.ts) still skips unchanged rows.
const scopedCache = new WeakMap<Record<string, unknown>, Map<string, Record<string, unknown>>>();
export function scopeShellRecord(environmentId: string, item: Record<string, unknown>): Record<string, unknown> {
  const cached = scopedCache.get(item)?.get(environmentId);
  if (cached) return cached;
  const next: Record<string, unknown> = { ...item, environmentId };
  if (typeof item.id === "string") next.id = item.id.startsWith(`${environmentId}:`) ? item.id : scopedKey(environmentId, item.id);
  if (typeof item.projectId === "string") next.projectId = item.projectId.startsWith(`${environmentId}:`) ? item.projectId : scopedKey(environmentId, item.projectId);
  // Lineage and run-fork links refer to threads on this same environment.
  // delegatedFrom, by contrast, explicitly names a different environment.
  if (item.lineage != null) next.lineage = scopeResult(environmentId, item.lineage);
  if (item.forkedFrom != null) next.forkedFrom = scopeResult(environmentId, item.forkedFrom);
  const environments = scopedCache.get(item) ?? new Map<string, Record<string, unknown>>();
  environments.set(environmentId, next);
  scopedCache.set(item, environments);
  return next;
}

function sessionShellThreads(shell: EnvironmentShell): Record<string, unknown>[] {
  const older = shell.olderSettledRows;
  if (!older || older.length === 0) return shell.threads;
  const present = new Set(shell.threads.map((thread) => thread.id));
  return [...shell.threads, ...older.filter((thread) => !present.has(thread.id))];
}

function sessionScopeFor(environmentId: string, projectIds: readonly string[] | undefined): { key: string; localIds: string[] | undefined; targeted: boolean } {
  if (!projectIds || projectIds.length === 0) return { key: "", localIds: undefined, targeted: true };
  const localIds: string[] = [];
  for (const id of projectIds) {
    const parsed = parseScopedKey(id);
    if (parsed?.environmentId === environmentId) localIds.push(parsed.localId);
  }
  if (localIds.length === 0) return { key: NONE_SCOPE_KEY, localIds: undefined, targeted: false };
  return { key: [...localIds].sort().join("\n"), localIds, targeted: true };
}

export function remoteUnloadedOlderSettledCount(projectIds?: ReadonlySet<string>): number {
  remoteShellRevision();
  remoteOlderSettledRevision();
  const filter = projectIds && projectIds.size > 0 ? projectIds : undefined;
  let byEnv: Map<string, Set<string>> | null = null;
  if (filter) {
    byEnv = new Map();
    for (const id of filter) {
      const parsed = parseScopedKey(id);
      if (!parsed) continue;
      let ids = byEnv.get(parsed.environmentId);
      if (!ids) { ids = new Set(); byEnv.set(parsed.environmentId, ids); }
      ids.add(parsed.localId);
    }
    if (byEnv.size === 0) return 0;
  }
  let total = 0;
  for (const [id, session] of sessions) {
    if (!session.environment.enabled || !session.shell.loaded || !session.shell.olderSettled) continue;
    const localFilter = byEnv ? byEnv.get(id) : undefined;
    if (byEnv && !localFilter) continue;
    total += countUnloadedOlderSettled(session.shell.olderSettled, sessionShellThreads(session.shell), localFilter);
  }
  return total;
}

export function remoteOlderSettledProjectCount(environmentId: string, localProjectId: string): number {
  remoteShellRevision();
  remoteOlderSettledRevision();
  const session = sessions.get(environmentId);
  if (!session || !session.environment.enabled || !session.shell.loaded || !session.shell.olderSettled) return 0;
  return session.shell.olderSettled.counts.find((entry) => entry.projectId === localProjectId)?.count ?? 0;
}

export function hasConnectedRemoteOlderSettled(projectIds?: readonly string[]): boolean {
  remoteShellRevision();
  remoteOlderSettledRevision();
  const connections = environmentConnections();
  for (const [id, session] of sessions) {
    if (!session.environment.enabled || !session.shell.loaded || !session.shell.olderSettled) continue;
    if (!session.client || connections[id]?.phase !== "connected") continue;
    const target = sessionScopeFor(id, projectIds);
    if (!target.targeted) continue;
    const localFilter = target.localIds ? new Set(target.localIds) : undefined;
    if (countUnloadedOlderSettled(session.shell.olderSettled, sessionShellThreads(session.shell), localFilter) > 0) return true;
  }
  return false;
}

export function remoteOlderSettledStatuses(projectIds?: readonly string[]): OlderSettledStatus[] {
  remoteShellRevision();
  remoteOlderSettledRevision();
  const connections = environmentConnections();
  const statuses: OlderSettledStatus[] = [];
  for (const [id, session] of sessions) {
    if (!session.environment.enabled || !session.shell.loaded || !session.shell.olderSettled) continue;
    if (!session.client || connections[id]?.phase !== "connected") continue;
    if (projectIds !== undefined) {
      const target = sessionScopeFor(id, projectIds);
      if (!target.targeted) continue;
      statuses.push(target.key === session.olderSettledScopeKey ? session.olderSettledStatus : "ready");
    } else {
      if (session.olderSettledScopeKey === NONE_SCOPE_KEY) continue;
      statuses.push(session.olderSettledStatus);
    }
  }
  return statuses;
}

export function resetFailedRemoteOlderSettled(projectIds?: readonly string[]) {
  let changed = false;
  for (const [id, session] of sessions) {
    if (!session.environment.enabled || !session.shell.loaded || !session.shell.olderSettled) continue;
    if (!sessionScopeFor(id, projectIds).targeted) continue;
    if (session.olderSettledStatus === "failed") {
      session.olderSettledStatus = "ready";
      changed = true;
    }
  }
  if (changed) remoteOlderSettledRevision.update((n) => n + 1);
}

export async function loadRemoteOlderSettledPages(
  projectIds: readonly string[] | undefined,
  onError: (error: unknown) => void,
): Promise<boolean> {
  let rowsChanged = false;
  let statusChanged = false;
  const tasks: Promise<void>[] = [];
  const connections = environmentConnections();
  for (const [id, session] of sessions) {
    if (!session.environment.enabled || !session.shell.loaded) continue;
    const target = sessionScopeFor(id, projectIds);
    if (target.key !== session.olderSettledScopeKey) {
      session.olderSettledScopeKey = target.key;
      session.olderSettledGeneration += 1;
      if (session.shell.olderSettledRows?.length) {
        session.shell.olderSettledRows = [];
        rowsChanged = true;
      }
      session.olderSettledFrontier = null;
      session.olderSettledStatus = "ready";
      statusChanged = true;
    }
    const cut = session.shell.olderSettled ?? null;
    const client = session.client;
    if (!target.targeted || !cut || !client || connections[id]?.phase !== "connected") continue;
    if (session.olderSettledStatus !== "ready") continue;
    const generation = session.olderSettledGeneration;
    const sessionGeneration = session.generation;
    const dropped = new Set<string>();
    session.olderSettledPageDropped = dropped;
    session.olderSettledStatus = "pending";
    statusChanged = true;
    tasks.push((async () => {
      try {
        const page = record(await client.request("orchestration.getOlderSettledThreads", {
          before: session.olderSettledFrontier ?? { settledAt: cut.before },
          ...(target.localIds ? { projectIds: [...target.localIds] } : {}),
          limit: OLDER_SETTLED_PAGE_SIZE,
        }));
        if (sessions.get(id) !== session || session.generation !== sessionGeneration || generation !== session.olderSettledGeneration) return;
        const threads = Array.isArray(page?.threads) ? page.threads.map(record).filter((item): item is Record<string, unknown> => item !== null) : [];
        const existing = session.shell.olderSettledRows ?? [];
        const added = threads.filter((thread) => !dropped.has(String(thread.id)) && !existing.some((row) => row.id === thread.id));
        if (added.length > 0) {
          session.shell.olderSettledRows = [...existing, ...added];
          rowsChanged = true;
        }
        const last = threads[threads.length - 1];
        if (threads.length < OLDER_SETTLED_PAGE_SIZE || typeof last?.settledAt !== "string") session.olderSettledStatus = "done";
        else { session.olderSettledFrontier = { settledAt: last.settledAt, threadId: String(last.id) }; session.olderSettledStatus = "ready"; }
        remoteOlderSettledRevision.update((n) => n + 1);
        if (added.length > 0) remoteShellRevision.update((n) => n + 1);
      } catch (error) {
        if (sessions.get(id) !== session || session.generation !== sessionGeneration || generation !== session.olderSettledGeneration) return;
        session.olderSettledStatus = "failed";
        remoteOlderSettledRevision.update((n) => n + 1);
        onError(error);
      } finally {
        if (session.olderSettledPageDropped === dropped) session.olderSettledPageDropped = null;
      }
    })());
  }
  if (statusChanged) remoteOlderSettledRevision.update((n) => n + 1);
  if (rowsChanged) remoteShellRevision.update((n) => n + 1);
  if (tasks.length > 0) await Promise.all(tasks);
  return rowsChanged;
}

/** `primary` followed by every connected remote environment's records, scoped. The same array when there are none. */
export function withRemoteShells(primary: Record<string, unknown>[], part: "projects" | "threads" | "archived"): Record<string, unknown>[] {
  let merged: Record<string, unknown>[] | null = null;
  for (const [id, session] of sessions) {
    if (!session.environment.enabled || !session.shell.loaded) continue;
    const items = part === "threads" ? sessionShellThreads(session.shell) : session.shell[part];
    if (items.length === 0) continue;
    merged ??= [...primary];
    for (const item of items) merged.push(scopeShellRecord(id, item));
  }
  return merged ?? primary;
}

/** The remote environment's raw shell thread for a scoped id. */
export function remoteShellThread(key: string): Record<string, unknown> | null {
  const parsed = parseScopedKey(key);
  if (!parsed) return null;
  const shell = sessions.get(parsed.environmentId)?.shell;
  if (!shell) return null;
  return shell.threads.find((item) => item.id === parsed.localId)
    ?? shell.olderSettledRows?.find((item) => item.id === parsed.localId)
    ?? null;
}

const ID_KEY = /(^id$|Id$)/;
const IDS_KEY = /Ids$/;
/** Unscopes every remote id under an `...Id` key; the single environment they name, or null when none (primary). */
export function routePayload(payload: unknown): { environmentId: string; payload: unknown } | null {
  let target: string | null = null;
  let conflict = false;
  const unScope = (id: string): string => {
    const parsed = parseScopedKey(id);
    if (!parsed) return id;
    if (target && target !== parsed.environmentId) conflict = true;
    target = parsed.environmentId;
    return parsed.localId;
  };
  const walk = (value: unknown, depth: number): unknown => {
    if (depth > 5) return value;
    if (Array.isArray(value)) return value.map((item) => walk(item, depth + 1));
    const data = record(value);
    if (!data) return value;
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(data)) {
      if (typeof item === "string" && ID_KEY.test(key)) {
        out[key] = unScope(item);
        continue;
      }
      if (Array.isArray(item) && IDS_KEY.test(key)) {
        out[key] = item.map((entry) => typeof entry === "string" ? unScope(entry) : walk(entry, depth + 1));
        continue;
      }
      out[key] = walk(item, depth + 1);
    }
    return out;
  };
  const next = walk(payload, 0);
  if (!target) return null;
  if (conflict) throw new Error("A request cannot span two environments");
  return { environmentId: target, payload: next };
}

const RESULT_ID_KEY = /(^threadId$|^projectId$|ThreadId$|ProjectId$)/;
/** The reverse of routePayload for a remote environment's answer: thread and project ids come back scoped. */
export function scopeResult(environmentId: string, value: unknown, depth = 0): unknown {
  if (depth > 6) return value;
  if (Array.isArray(value)) return value.map((item) => scopeResult(environmentId, item, depth + 1));
  const data = record(value);
  if (!data) return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(data)) {
    out[key] = typeof item === "string" && RESULT_ID_KEY.test(key) && !item.startsWith(`${environmentId}:`)
      ? scopedKey(environmentId, item) : scopeResult(environmentId, item, depth + 1);
  }
  return out;
}

/** Test hook: drop every session. */
export function resetEnvironmentsForTest() {
  for (const session of sessions.values()) { stop(session); clearFamilyRemovals(session.environment.id); }
  sessions.clear();
  environmentConnections.set({});
  environmentConfigs.set({});
  environmentUsageSources.set({});
  environmentDescriptors.set({});
  remoteShellRevision.set(0);
  remoteOlderSettledRevision.set(0);
}
