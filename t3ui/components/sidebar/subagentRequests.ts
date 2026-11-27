// pendingSubagentRequestsByThread (client-runtime threadShell.ts): a live child asking for approval flags every
// ancestor up its subagent chain, so the parent row reads as needing attention and leaves Working. Not a wire field.
import type { Thread } from "../../store";

const LIVE = new Set(["preparing", "starting", "running", "waiting"]);

const childLive = (thread: Thread) => {
  const meta = thread.meta;
  if (!meta) return thread.status === "running";
  return meta.activityRunStatus !== null ? true : LIVE.has(meta.runStatus);
};

/** Subagents, side chats and cross-environment delegated children live inside their parent's view, never in thread lists (isListedThreadLineage). */
export const isListedThread = (thread: Thread): boolean => {
  if (thread.relations?.delegatedFrom) return false;
  const lineage = thread.relations?.lineage;
  return !(lineage && (lineage.relationshipToParent === "subagent" || lineage.sideChat));
};

/** Ids of the threads flagged with a child's approval request. User questions are the coordinator's to answer. */
export function threadsWithSubagentRequest(threads: readonly Thread[]): Set<string> {
  const byId = new Map(threads.map((thread) => [thread.id, thread] as const));
  const flagged = new Set<string>();
  for (const child of threads) {
    const lineage = child.relations?.lineage;
    const kind = child.meta?.pendingRequestKind;
    if (!lineage || !kind || kind === "auth_refresh" || kind === "user_input") continue;
    const isSideChat = lineage.sideChat;
    if (!isSideChat && (lineage.relationshipToParent !== "subagent" || !childLive(child))) continue;
    const seen = new Set([child.id]);
    let parentId = lineage.parentThreadId;
    while (parentId !== null && !seen.has(parentId)) {
      seen.add(parentId);
      flagged.add(parentId);
      const parent = byId.get(parentId);
      const up = parent?.relations?.lineage;
      parentId = up && (up.relationshipToParent === "subagent" || up.sideChat) ? up.parentThreadId : null;
    }
  }
  return flagged;
}

/** The listed threads, with the flagged ones carrying `pendingSubagentRequest`. */
export function listedWithSubagentRequests(threads: readonly Thread[]): Thread[] {
  const flagged = threadsWithSubagentRequest(threads);
  return threads.filter(isListedThread).map((thread) =>
    flagged.has(thread.id) && thread.meta ? { ...thread, meta: { ...thread.meta, pendingSubagentRequest: true } } : thread);
}
