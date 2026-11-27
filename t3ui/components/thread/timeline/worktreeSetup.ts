// Worktree setup progress (packages/contracts worktreeSetup.ts WorktreeSetupSnapshot, client-runtime worktreeSetup.ts,
// ChatView.logic resolveVisibleWorktreeSetup, MessagesTimeline.logic.ts placement of the `worktree-setup` row).
// The snapshot streams from `subscribeWorktreeSetup` ({ threadId }); `worktreeSetup.cancel` stops it.
import { computed, effect, signal } from "nsh";
import { backendConnected, subscribeBackend } from "../../../store";
import type { TimelineRow } from "./workLog";

export type WorktreeSetupStageId = "fetch" | "checkout" | "submodules" | "setup-script" | "agent";
export type WorktreeSetupStageStatus = "pending" | "running" | "done" | "skipped" | "warning" | "failed";
export type WorktreeSetupStage = { id: WorktreeSetupStageId; status: WorktreeSetupStageStatus; startedAt: string | null; endedAt: string | null; percent: number | null; detail: string | null; tail: string[] };
export type WorktreeSetupSnapshot = {
  threadId: string; phase: "running" | "done" | "failed" | "cancelled"; startedAt: string; endedAt: string | null; branch: string | null; baseRef: string | null;
  worktreePath: string | null; setupScript: { name: string; command: string; terminalId: string } | null; stages: WorktreeSetupStage[]; error: string | null; sequence: number;
};

const PHASES = new Set(["running", "done", "failed", "cancelled"]);
const STAGES = new Set(["fetch", "checkout", "submodules", "setup-script", "agent"]);
const STATUSES = new Set(["pending", "running", "done", "skipped", "warning", "failed"]);
const s = (value: unknown) => (typeof value === "string" ? value : null);

/** A stream event as a snapshot; null for `null` (no setup) or anything malformed. */
export function readWorktreeSetupSnapshot(value: unknown): WorktreeSetupSnapshot | null {
  const raw = value as Record<string, unknown> | null;
  if (!raw || typeof raw !== "object" || typeof raw.threadId !== "string" || !PHASES.has(String(raw.phase)) || typeof raw.startedAt !== "string") return null;
  const script = raw.setupScript as Record<string, unknown> | null;
  return {
    threadId: raw.threadId, phase: raw.phase as WorktreeSetupSnapshot["phase"], startedAt: raw.startedAt, endedAt: s(raw.endedAt), branch: s(raw.branch), baseRef: s(raw.baseRef),
    worktreePath: s(raw.worktreePath),
    setupScript: script && typeof script.name === "string" && typeof script.command === "string" && typeof script.terminalId === "string" ? { name: script.name, command: script.command, terminalId: script.terminalId } : null,
    stages: (Array.isArray(raw.stages) ? raw.stages : []).flatMap((value) => {
      const stage = value as Record<string, unknown> | null;
      if (!stage || !STAGES.has(String(stage.id)) || !STATUSES.has(String(stage.status))) return [];
      return [{ id: stage.id as WorktreeSetupStageId, status: stage.status as WorktreeSetupStageStatus, startedAt: s(stage.startedAt), endedAt: s(stage.endedAt),
        percent: typeof stage.percent === "number" ? stage.percent : null, detail: s(stage.detail), tail: Array.isArray(stage.tail) ? stage.tail.filter((line): line is string => typeof line === "string") : [] }];
    }),
    error: s(raw.error), sequence: typeof raw.sequence === "number" ? raw.sequence : 0,
  };
}

/** worktreeSetupStageLabel (contracts). */
export function worktreeSetupStageLabel(id: WorktreeSetupStageId): string {
  switch (id) {
    case "fetch": return "Fetch base branch";
    case "checkout": return "Check out files";
    case "submodules": return "Init submodules";
    case "setup-script": return "Run setup script";
    case "agent": return "Start agent";
  }
}

/** WorktreeSetupCard headerLabel. */
export function worktreeSetupHeaderLabel(snapshot: WorktreeSetupSnapshot): string {
  switch (snapshot.phase) {
    case "running": return "Setting up worktree…";
    case "done": return snapshot.stages.some((stage) => stage.status === "failed") ? "Worktree ready, setup script failed" : "Worktree ready";
    case "failed": return "Worktree setup failed";
    case "cancelled": return "Worktree setup cancelled";
  }
}

export const worktreeSetupAgentStarted = (snapshot: WorktreeSetupSnapshot) => snapshot.stages.some((stage) => stage.id === "agent" && stage.status === "done");

/** resolveVisibleWorktreeSetup with no recorded snapshot and no follow-up sent (the port does not track those). */
export function resolveVisibleWorktreeSetup(snapshot: WorktreeSetupSnapshot | null, turnStarted: boolean): WorktreeSetupSnapshot | null {
  if (!snapshot) return null;
  if (snapshot.phase === "running" || snapshot.phase !== "done" || !turnStarted) return snapshot;
  return snapshot.stages.some((stage) => stage.status === "failed") ? snapshot : null;
}

/**
 * useWorktreeSetup's blocksSend: a send waits while setup runs before the agent starts. After the agent hand-off (or
 * while the run itself is preparing or starting) sends queue behind setup instead, so they are not blocked.
 */
export function worktreeSetupBlocksSend(input: { sendQueuesBehindSetup: boolean; visible: WorktreeSetupSnapshot | null; preparingWorktree: boolean }): boolean {
  if (input.sendQueuesBehindSetup) return false;
  return input.visible !== null ? input.visible.phase === "running" && !worktreeSetupAgentStarted(input.visible) : input.preparingWorktree;
}
const blocksSend = signal(false);
/** What ThreadView found for the open thread; the composer reads it ("Preparing worktree" as the send's disabled reason). */
export const worktreeSetupBlocksSendNow = () => blocksSend();
export const publishWorktreeSetupBlocksSend = (value: boolean) => blocksSend.set(value);

export const WORKTREE_SETUP_ROW_ID = "worktree-setup-row";
export type WorktreeSetupRow = { kind: "worktree-setup"; id: string; snapshot: WorktreeSetupSnapshot; embedded: boolean };

/**
 * MessagesTimeline.logic.ts: the setup card goes under the working row while setup owns it, else under the first
 * user message. Once the agent started and the run began, a running setup leaves the timeline for the working
 * row's "Background setup" chip (returned as `background`), and a finished one shows collapsed (embedded).
 */
export function placeWorktreeSetup(rows: TimelineRow[], snapshot: WorktreeSetupSnapshot | null, runStarted: boolean): { rows: Array<TimelineRow | WorktreeSetupRow>; background: WorktreeSetupSnapshot | null } {
  if (!snapshot) return { rows, background: null };
  const handedOff = worktreeSetupAgentStarted(snapshot) && runStarted;
  if (handedOff && snapshot.phase === "running") return { rows, background: snapshot };
  const ownsWorking = !handedOff && (snapshot.phase === "running" || snapshot.phase === "done");
  const row: WorktreeSetupRow = { kind: "worktree-setup", id: WORKTREE_SETUP_ROW_ID, snapshot, embedded: handedOff };
  const next: Array<TimelineRow | WorktreeSetupRow> = [...rows];
  const working = ownsWorking ? next.findIndex((entry) => entry.kind === "working") : -1;
  if (working >= 0) next.splice(working + 1, 0, row);
  else {
    const firstUser = next.findIndex((entry) => entry.kind === "entry" && entry.entry.kind === "message" && entry.entry.message.role === "user");
    const at = firstUser >= 0 ? firstUser + 1 : next.length;
    next.splice(at, 0, ...(ownsWorking ? [{ kind: "working", id: "working-indicator-row", since: Date.parse(snapshot.startedAt) || null } as TimelineRow, row] : [row]));
  }
  return { rows: next, background: null };
}

/** useWorktreeSetup's subscription: the latest snapshot for `threadId` while `active` holds (never an older sequence). */
export function useWorktreeSetupSnapshot(threadId: () => string | null, active: () => boolean, subscribe: typeof subscribeBackend = subscribeBackend) {
  const snapshot = signal<WorktreeSetupSnapshot | null>(null);
  const currentThreadId = computed(() => threadId());
  const subscribedThreadId = computed(() => (active() ? currentThreadId() : null));
  let shownFor: string | null = null;
  effect(() => {
    const id = currentThreadId();
    if (id !== shownFor) { shownFor = id; snapshot.set(null); }
  });
  effect(() => {
    const id = subscribedThreadId();
    if (!id) return;
    backendConnected(); // a reconnect closes the stream: subscribe again (the web's subscription atoms do)
    return subscribe("subscribeWorktreeSetup", { threadId: id }, (value) => {
      const next = readWorktreeSetupSnapshot(value);
      if (!next) return;
      snapshot.update((current) => (current && current.threadId === next.threadId && current.sequence > next.sequence ? current : next));
    }, () => undefined);
  });
  return snapshot;
}

/** formatDuration (shared orchestrationTiming.ts). */
export function formatDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs < 0) return "0ms";
  if (durationMs < 1_000) return `${Math.max(1, Math.round(durationMs))}ms`;
  if (durationMs < 10_000) return `${Math.round(durationMs / 100) / 10}s`;
  const totalSeconds = Math.round(durationMs / 1_000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  return [hours > 0 ? `${hours}h` : "", minutes > 0 ? `${minutes}m` : "", seconds > 0 ? `${seconds}s` : ""].filter(Boolean).join(" ");
}
