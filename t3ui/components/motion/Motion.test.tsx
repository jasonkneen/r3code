import { motions } from "nsh";
import { expect, open, test } from "nsh/test";
import { specStartValues } from "./Motion";
import { backdropEnter, cssEasing, EASE_DRAWER, EASE_OUT, railIndicatorMove, revealIn, routeModalEnter, departures, mergeLeaving, panelMotionActive, rowsEnter, STASH_PULSE_HOLD_MS, toastStackExpand, trackArrivals, statusPulse } from "./motionTokens";

const options = { width: 240, height: 160, platform: "macos" as const, clock: {} };

test("a closing view stays mounted for its exit duration, then unmounts", async () => {
  const app = await open("./MotionFixture.tsx", options);
  await expect(app.texts()).toContain("Open");
  await expect(app.texts()).toContain("Pulsing");
  await app.press("text:Toggle");
  await expect(app.texts()).toContain("Closing");
  await app.wait(100);
  await expect(app.texts()).toContain("Closing");
  await app.wait(150);
  await expect(app.texts()).toContain("Gone");
});

test("reopening while closing keeps it mounted", async () => {
  const app = await open("./MotionFixture.tsx", options);
  await app.press("text:Toggle");
  await app.wait(50);
  await app.press("text:Toggle");
  await app.wait(400);
  await expect(app.texts()).toContain("Open");
});

test("a zero duration unmounts at once, as panelAnimationDurationMs 0 does", async () => {
  const app = await open("./MotionFixture.tsx", options);
  await app.press("text:Instant");
  await app.press("text:Toggle");
  await expect(app.texts()).toContain("Gone");
});

test("panel motion runs only above 0 ms and without reduced motion", () => {
  expect(panelMotionActive(0, false)).toBe(false);
  expect(panelMotionActive(200, false)).toBe(true);
  expect(panelMotionActive(200, true)).toBe(false);
  expect(cssEasing(EASE_DRAWER)).toBe("cubic-bezier(0.32, 0.72, 0, 1)");
});

test("a toast enters only as it arrives; one that left and comes back enters again", () => {
  let arrivals = trackArrivals(new Map(), ["a"], 1000);
  arrivals = trackArrivals(arrivals, ["b", "a"], 1600);
  expect(arrivals.get("a")).toBe(1000);
  expect(arrivals.get("b")).toBe(1600);
  arrivals = trackArrivals(arrivals, ["b"], 2000);
  expect(arrivals.has("a")).toBe(false);
  arrivals = trackArrivals(arrivals, ["a", "b"], 3000);
  expect(arrivals.get("a")).toBe(3000);
});

test("NSH's spin preset is Tailwind's animate-spin (1s linear, forever)", () => {
  expect([motions.spin.duration, motions.spin.easing, motions.spin.iterations]).toEqual([1000, "linear", "infinite"]);
});

test("status-pulse keeps index.css's 2s duty cycle", () => {
  expect(statusPulse.duration).toBe(2000);
  const frames = (statusPulse.keyframes as { opacity: { offset: number; value: number }[] }).opacity;
  expect(frames.map((frame) => [frame.offset, frame.value])).toEqual([[0, 1], [0.4, 1], [0.5, 0.5], [0.9, 0.5], [1, 1]]);
});

test("a toast that leaves the list is the one that plays its exit", () => {
  const a = { id: "a" }, b = { id: "b" };
  expect(departures([a, b], [b], (item) => item.id)).toEqual([a]);
  expect(departures([a], [a, b], (item) => item.id)).toEqual([]);
});

test("sidebar rows enter only into a list that had rows, 40 at most, without reduced motion", () => {
  expect(rowsEnter(0, 5, false)).toBe(false);
  expect(rowsEnter(3, 1, false)).toBe(true);
  expect(rowsEnter(3, 41, false)).toBe(false);
  expect(rowsEnter(3, 1, true)).toBe(false);
});

test("a stacked toast opens out from its peek, scaled 1 - index x .1", () => {
  const frames = toastStackExpand(2, 120).keyframes as Array<{ translateY?: number; scale?: number; opacity?: number }>;
  expect([frames[0].translateY, frames[0].scale, frames[0].opacity]).toEqual([-96, 0.8, 0]);
  expect(frames[2].translateY).toBe(0);
  expect(STASH_PULSE_HOLD_MS).toBe(1200);
});

test("a row that left goes back in at the index it had, marked leaving", () => {
  const rows = mergeLeaving(["a", "c"], (row) => row, [{ key: "b", item: "b", index: 1 }]);
  expect(rows.map((row) => [row.key, row.leaving])).toEqual([["a", false], ["b", true], ["c", false]]);
});

test("a sidebar row that leaves stays drawn for its 150ms exit, then goes", async () => {
  const app = await open("./MotionEachFixture.tsx", { width: 240, height: 200, platform: "macos" });
  await expect(app.texts()).toContain("row b");
  await app.press("text:Remove b");
  await app.waitUntil(() => !app.texts().includes("row b"));
  await expect(app.texts()).toContain("row c");
});

test("the selected-provider bar slides 200ms ease-out from its old top (ModelPickerSidebar.tsx:90)", () => {
  const spec = railIndicatorMove(40);
  expect([spec.duration, spec.easing, spec.keyframes]).toEqual([200, EASE_OUT, { translateY: [40, 0] }]);
  expect(revealIn.duration).toBe(150);
});

test("a provider pill whose key changes plays its exit before the next view shows; a same-key update is at once", async () => {
  const app = await open("./PillSwapFixture.tsx", { width: 240, height: 160, platform: "macos" });
  await expect(app.texts()).toContain("View A");
  await app.press("text:Same key");
  await app.waitFor("text:View A2");
  await app.press("text:Other key");
  await expect(app.texts()).toContain("View A2 (leaving)");
  await app.waitFor("text:View B");
  await app.press("text:Clear");
  await app.waitFor("text:View B (leaving)");
  await app.waitFor("text:nothing");
});

test("specStartValues extracts initial channel values from channel-map and frame-array specs", () => {
  expect(specStartValues(backdropEnter)).toEqual({ opacity: 0 });
  expect(specStartValues(routeModalEnter)).toEqual({ opacity: 0, scale: 0.985 });
  expect(specStartValues(toastStackExpand(2, 120))).toEqual({ translateY: -96, scale: 0.8, opacity: 0 });
  expect(specStartValues(statusPulse)).toEqual({ opacity: 1 });
});
