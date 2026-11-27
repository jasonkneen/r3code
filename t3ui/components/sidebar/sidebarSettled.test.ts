// Settled is the server's call (settledOverride === "settled" on the shell); auto-settle settings never reach the client's rule.
import { expect, test } from "nsh/test";
import { applyShellEventForTest, updateSetting } from "../../store";
import { replaceServerSettings, resetServerConfig } from "../../pages/settings/settingsState";
import { settledShelfExpanded, toggleSettledShelf } from "./sidebarPrefs";
import { hiddenSettledCount, settledThreadCount, sidebarSections, visibleSettled } from "./sidebarModel";

const NOW = Date.parse("2026-11-11T22:00:00Z");
const iso = (hoursAgo: number) => new Date(NOW - hoursAgo * 3_600_000).toISOString();
const shell = (id: string, over: Record<string, unknown> = {}) => ({
  id, projectId: "project-1", title: id, status: "completed", providerInstanceId: "codex", providerInstanceHistory: ["codex"],
  lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: id }, settledOverride: null, settledAt: null,
  latestRunId: `run:${id}`, latestRunCompletedAt: iso(2), latestUserMessageAt: iso(2), createdAt: iso(3), updatedAt: iso(2), ...over,
});
const load = (threads: Record<string, unknown>[]) => applyShellEventForTest({
  kind: "snapshot",
  snapshot: { projects: [{ id: "project-1", title: "legion", workspaceRoot: "/work/legion", createdAt: iso(5), updatedAt: iso(2) }], threads },
});
const fresh = () => ["a", "b", "c", "d", "e", "f", "g"].map((id) => shell(id));

const variants: [string, unknown][] = [
  ["no server settings yet", null],
  ["server defaults", { sidebarAutoSettleOnMerge: true, sidebarAutoSettleAfterDays: 7, sidebarAutoSettleKeepPullRequests: false }],
  ["auto-settle after 7 days", { sidebarAutoSettleOnMerge: false, sidebarAutoSettleAfterDays: 7 }],
  ["auto-settle after 1 day", { sidebarAutoSettleAfterDays: 1 }],
  ["auto-settle off", { sidebarAutoSettleAfterDays: null }],
];

for (const [name, settings] of variants) {
  test(`hours-old threads stay active with ${name}`, () => {
    updateSetting("boringSidebarEnabled", false);
    resetServerConfig();
    if (settings) replaceServerSettings(settings);
    load(fresh());
    const s = sidebarSections(NOW);
    expect(s.loose.length).toBe(7);
    expect(s.settled.length).toBe(0);
  });
}

test("only a shell the server marked settled is settled, and the expanded shelf lists every one", () => {
  updateSetting("boringSidebarEnabled", false);
  resetServerConfig();
  load([...fresh(), shell("s1", { settledOverride: "settled", settledAt: iso(1) }), shell("s2", { settledOverride: "settled", settledAt: iso(1) }), shell("s3", { settledOverride: "settled", settledAt: iso(1) })]);
  const s = sidebarSections(NOW);
  expect(s.loose.length).toBe(7);
  expect(s.settled.map((t) => t.id).sort()).toEqual(["s1", "s2", "s3"]);
  if (!settledShelfExpanded()) toggleSettledShelf();
  expect(visibleSettled(s).length).toBe(3);
  expect(hiddenSettledCount(s)).toBe(0);
});

test("settled threads are ordered by settle time and then plain id, not message time", () => {
  resetServerConfig();
  load([
    shell("older", { settledOverride: "settled", settledAt: iso(3), latestUserMessageAt: iso(0) }),
    shell("newer-b", { settledOverride: "settled", settledAt: iso(1), latestUserMessageAt: iso(4) }),
    shell("newer-a", { settledOverride: "settled", settledAt: iso(1), latestUserMessageAt: iso(5) }),
  ]);
  expect(sidebarSections(NOW).settled.map((thread) => thread.id)).toEqual(["newer-a", "newer-b", "older"]);
});

test("a settled thread with no activity timestamp falls back to its updated time", () => {
  resetServerConfig();
  load([
    shell("older", { settledOverride: "settled", settledAt: null, latestUserMessageAt: null, latestRunCompletedAt: null, updatedAt: iso(2) }),
    shell("newer", { settledOverride: "settled", settledAt: null, latestUserMessageAt: null, latestRunCompletedAt: null, updatedAt: iso(1) }),
  ]);
  expect(sidebarSections(NOW).settled.map((thread) => thread.id)).toEqual(["newer", "older"]);
});

test("cross-environment delegatedFrom threads with null lineage relationship are unlisted", () => {
  updateSetting("boringSidebarEnabled", false);
  resetServerConfig();
  const delegatedFrom = { environmentId: "env-parent", threadId: "parent-1", title: "Parent" };
  load([
    shell("active-normal"),
    shell("active-delegated", { delegatedFrom }),
    shell("settled-normal", { settledOverride: "settled", settledAt: iso(1), delegatedFrom: null }),
    shell("settled-delegated", { settledOverride: "settled", settledAt: iso(0.5), delegatedFrom }),
  ]);
  const s = sidebarSections(NOW);
  expect(s.loose.map((thread) => thread.id)).toEqual(["active-normal"]);
  expect(s.settled.map((thread) => thread.id)).toEqual(["settled-normal"]);
  expect(settledThreadCount(s)).toBe(1);
});
