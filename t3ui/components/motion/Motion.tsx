// The shared motion helpers: every animated site in the port goes through these, with the specs and
// constants of motionTokens.ts (quoted from the reference web app).
import { Animated, cleanup, computed, LayoutAnimation, createAnimatedValue, createMotion, effect, lifecycle, platform, reduceMotion, signal, untracked, View } from "nsh";
import { departures, DURATION_DEFAULT_MS, railIndicatorMove, EASE_DEFAULT, MAX_FADED_ROWS_PER_UPDATE, mergeLeaving, previewLoadingDone, previewLoadingRun, rowsEnter, searchTargetPulse, SIDEBAR_ROW_MS, sidebarRowEnter, sidebarRowExit, sidebarRowMove, sidebarRowTravel } from "./motionTokens";
import type { LeavingRow } from "./motionTokens";
import { createStableRows } from "../stableRows";
import { isDeclarativeWindow } from "../../desktop/windowControl";
import type { MotionSpec, StyleProp, ViewStyle } from "nsh";

type Content = ReturnType<typeof View>;
type MotionChannel = "opacity" | "translateX" | "translateY" | "rotate" | "rotateX" | "rotateY" | "scale" | "scaleX" | "scaleY";
const MOTION_CHANNELS: readonly MotionChannel[] = ["opacity", "translateX", "translateY", "rotate", "rotateX", "rotateY", "scale", "scaleX", "scaleY"];

export function specStartValues(spec: MotionSpec): Partial<Record<MotionChannel, number>> {
  const start: Partial<Record<MotionChannel, number>> = {};
  const frames = spec.keyframes;
  if (Array.isArray(frames)) {
    const first = frames[0] as Record<string, unknown> | undefined;
    if (first) {
      for (const channel of MOTION_CHANNELS) {
        const value = first[channel];
        if (typeof value === "number") start[channel] = value;
      }
    }
    return start;
  }
  const byChannel = frames as Record<string, readonly unknown[] | undefined>;
  for (const channel of MOTION_CHANNELS) {
    const list = byChannel[channel];
    if (!list || list.length === 0) continue;
    const first = list[0];
    if (typeof first === "number") start[channel] = first;
    else if (first && typeof first === "object" && typeof (first as { value?: unknown }).value === "number") {
      start[channel] = (first as { value: number }).value;
    }
  }
  return start;
}

function shouldAnimateSpec(spec: MotionSpec): boolean {
  return !reduceMotion() || spec.ignoreReduceMotion === true;
}

export function applyStartValues(motion: ReturnType<typeof createMotion>, spec: MotionSpec): void {
  if (!shouldAnimateSpec(spec)) return;
  const start = specStartValues(spec);
  for (const channel of MOTION_CHANNELS) {
    const value = start[channel];
    if (value !== undefined) motion[channel].set(value);
  }
}

function cappedLoopSpec(spec: MotionSpec): MotionSpec {
  if (platform.os === "windows" && isDeclarativeWindow() && spec.iterations === "infinite") {
    return { ...spec, frameRate: 15 } as MotionSpec;
  }
  return spec;
}

export function isWindowsLoopPaused(
  os: string = platform.os,
  declarative: boolean = isDeclarativeWindow(),
  readLifecycle: () => string = lifecycle,
): boolean {
  if (os !== "windows" || !declarative) return false;
  const appLifecycle = readLifecycle();
  return appLifecycle === "inactive" || appLifecycle === "background";
}

/**
 * Plays `spec` once when it mounts: the port's stand-in for Base UI's `data-starting-style` (the view
 * starts at the spec's first frame and eases to rest). Input is never blocked: the view is laid out and
 * hit-tested at its final frame from the start; only opacity and transform move.
 */
export function MotionEnter(props: { spec: MotionSpec; when?: () => boolean; class?: string; style?: StyleProp<ViewStyle>; testID?: string; children?: Content }) {
  const initiallyOn = untracked(() => (props.when ? props.when() : true));
  const motion = createMotion(initiallyOn && shouldAnimateSpec(props.spec) ? { initial: specStartValues(props.spec) } : undefined);
  effect(() => {
    const on = props.when ? props.when() : true;
    if (on) untracked(() => { applyStartValues(motion, props.spec); void motion.play(props.spec); });
  });
  return (
    <View class={props.class} testID={props.testID} style={[props.style, motion.style] as StyleProp<ViewStyle>}>
      {props.children}
    </View>
  );
}

/**
 * Loops `spec` while `active()` (status pulses, skeletons, pings); still at rest otherwise. The specs
 * respect reduced motion as the reference's `motion-safe:` does.
 */
export function MotionLoop(props: { spec: MotionSpec; active?: () => boolean; class?: string; style?: StyleProp<ViewStyle>; children?: Content }) {
  const motion = createMotion();
  effect(() => {
    const on = (props.active ? props.active() : true) && !isWindowsLoopPaused();
    untracked(() => {
      if (on) void motion.play(cappedLoopSpec(props.spec));
      else motion.reset();
    });
  });
  cleanup(() => motion.stop());
  return (
    <View class={props.class} style={[props.style, motion.style] as StyleProp<ViewStyle>}>
      {props.children}
    </View>
  );
}

/**
 * panelAnimations.ts usePanelPresence: keeps a closing view mounted for `durationMs()` so its exit can
 * play, then unmounts it. With a duration of 0 (or `animated()` false) it follows `open()` at once.
 * `present()` says whether to render; `closing()` whether it is on its way out (render it inert).
 */
export function createPresence(open: () => boolean, durationMs: () => number, animated: () => boolean = () => true) {
  const present = signal(untracked(open));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const clear = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  effect(() => {
    const isOpen = open();
    const ms = durationMs();
    const anim = animated();
    untracked(() => {
      clear();
      if (isOpen) {
        present.set(true);
        return;
      }
      if (!anim || ms <= 0) {
        present.set(false);
        return;
      }
      if (!present()) return;
      timer = setTimeout(() => {
        timer = undefined;
        present.set(false);
      }, ms);
    });
  });
  cleanup(clear);
  return {
    present: () => present(),
    closing: () => present() && !open(),
  };
}

/**
 * MotionEnter as a style, for a view whose own props (role, absolute position, refs) must stay on it:
 * `style={enterStyle(fadeInStart)}`. Call it in the component body that renders the view.
 */
export function enterStyle(spec: MotionSpec, when?: () => boolean) {
  const initiallyOn = untracked(() => (when ? when() : true));
  const motion = createMotion(initiallyOn && shouldAnimateSpec(spec) ? { initial: specStartValues(spec) } : undefined);
  effect(() => {
    const on = when ? when() : true;
    if (on) untracked(() => { applyStartValues(motion, spec); void motion.play(spec); });
  });
  return motion.style;
}

/**
 * Enter while `open()` turns true, exit while it turns false (Base UI's data-starting-style and data-ending-style on
 * one view). For hosts that keep the view mounted through its exit: nsh/base Dialog during its own fade, or a view
 * kept by `createPresence` / `<Presence>`.
 */
export function presenceStyle(enter: MotionSpec, exit: MotionSpec, open: () => boolean) {
  const initiallyOpen = untracked(open);
  const motion = createMotion(initiallyOpen && shouldAnimateSpec(enter) ? { initial: specStartValues(enter) } : undefined);
  let first = true;
  effect(() => {
    const on = open();
    untracked(() => {
      if (on) {
        applyStartValues(motion, enter);
        void motion.play(enter);
      } else if (!first) {
        void motion.play(exit);
      }
    });
    first = false;
  });
  return motion.style;
}

/**
 * Renders `children(closing)` while `when()` is true and for `ms` after it turns false, so the child can play its
 * exit (usePanelPresence). A closing child must not take input: pass `closing` on to it.
 */
export function Presence(props: { when: () => boolean; ms: number; children: (closing: () => boolean) => Content }) {
  const presence = createPresence(props.when, () => props.ms);
  return () => (presence.present() ? untracked(() => props.children(presence.closing)) : null);
}

/**
 * A right-pointing chevron that turns 90 degrees to point down while `open()` (the reference's ChevronRight with
 * `transition-transform` + `rotate-90`): it starts at its resting angle and turns only on a change. Pass the
 * chevron-right icon as the child.
 */
export function ChevronTurn(props: { open: () => boolean; durationMs?: number; degrees?: number; stillWithReducedMotion?: boolean; children?: Content }) {
  const turn = props.degrees ?? 90;
  const angle = createAnimatedValue(untracked(props.open) ? turn : 0);
  effect(() => {
    const to = props.open() ? turn : 0;
    untracked(() => {
      const still = props.stillWithReducedMotion === true && reduceMotion();
      const timing = Animated.timing(angle, { toValue: to, duration: still ? 0 : props.durationMs ?? DURATION_DEFAULT_MS, easing: EASE_DEFAULT });
      void timing.start();
    });
  });
  return <View style={{ transform: [{ rotate: angle }] }}>{props.children}</View>;
}

// Rows of one list that mount in the same update, and how many rows were live before it (Sidebar.motion.ts).
const rowLists = new Map<string, { live: number; before: number; batch: Array<() => void> | null }>();

/**
 * The style of a list row that enters as the reference's sidebar rows do: a row that mounts into a list that already
 * had rows fades in from `travel` above (150ms ease-out); the list's first rows, bursts of more than 40 and reduced
 * motion stay still. Rows leaving and rows moving are not animated (see the inventory).
 */
export function listRowEnterStyle(list: string, travel: number) {
  let state = rowLists.get(list);
  if (!state) { state = { live: 0, before: 0, batch: null }; rowLists.set(list, state); }
  const entry = state;
  const motion = createMotion();
  if (!entry.batch) {
    entry.before = entry.live;
    entry.batch = [];
    queueMicrotask(() => {
      const batch = entry.batch ?? [];
      const animate = rowsEnter(entry.before, batch.length, reduceMotion());
      entry.batch = null;
      if (animate) for (const play of batch) play();
    });
  }
  entry.batch.push(() => {
    const spec = sidebarRowEnter(travel);
    applyStartValues(motion, spec);
    void motion.play(spec);
  });
  entry.live += 1;
  cleanup(() => { entry.live -= 1; });
  return motion.style;
}

/** MotionLoop as a style for a view that keeps its own props: `style={loopStyle(skeletonPulse)}`. */
export function loopStyle(spec: MotionSpec) {
  const motion = createMotion();
  effect(() => {
    const paused = isWindowsLoopPaused();
    untracked(() => {
      if (paused) motion.reset();
      else void motion.play(cappedLoopSpec(spec));
    });
  });
  cleanup(() => motion.stop());
  return motion.style;
}

/**
 * `<Each>` with the reference sidebar's list motion (Sidebar.motion.ts) for the leaving and moving rows: a row that
 * leaves stays where it was (out of the flow, inert) fading out and moving min(height, 40) down for 150ms; a row whose
 * place changes runs from its old place to the new one (FLIP from its last onLayout), 150ms ease-out. Skipped with
 * reduced motion and when more than 40 rows leave at once (MAX_FADED_ROWS_PER_UPDATE). Entering rows are the row's own
 * (listRowEnterStyle). Rows are not virtualised in the sidebar, so every row has a measured place.
 */
export function MotionEach<T>(props: { of: () => readonly T[]; key: (item: T) => string; children: (item: () => T) => Content }) {
  const leaving = signal<LeavingRow<T>[]>([]);
  let previous: readonly T[] = untracked(props.of);
  const timers = new Set<ReturnType<typeof setTimeout>>();
  effect(() => {
    const next = props.of();
    untracked(() => {
      const gone = departures(previous, next, props.key);
      const indexes = new Map(previous.map((item, index) => [props.key(item), index] as const));
      previous = next;
      if (gone.length === 0 || reduceMotion() || gone.length > MAX_FADED_ROWS_PER_UPDATE) return;
      const rows = gone.map((item) => ({ key: props.key(item), item, index: indexes.get(props.key(item)) ?? 0 }));
      leaving.set([...leaving().filter((row) => !rows.some((gone) => gone.key === row.key)), ...rows]);
      const timer = setTimeout(() => {
        timers.delete(timer);
        leaving.set(leaving().filter((row) => !rows.includes(row)));
      }, SIDEBAR_ROW_MS);
      timers.add(timer);
    });
  });
  cleanup(() => { for (const timer of timers) clearTimeout(timer); });
  const stableRows = createStableRows<{ key: string; item: T; leaving: boolean }>((row) => row.key);
  const rows = computed(() => stableRows("", mergeLeaving(props.of(), props.key, leaving())));
  return (
    <Each of={rows()} key={(row: { key: string; item: T; leaving: boolean }) => row.key}>
      {(row) => <MotionEachRow leaving={() => row().leaving} item={() => row().item} render={props.children} />}
    </Each>
  );
}

function MotionEachRow<T>(props: { leaving: () => boolean; item: () => T; render: (item: () => T) => Content }) {
  const motion = createMotion();
  let top: number | undefined;
  let height = 0;
  const frozenTop = signal<number | null>(null);
  effect(() => {
    if (!props.leaving()) { frozenTop.set(null); return; }
    untracked(() => {
      frozenTop.set(top ?? 0);
      void motion.play(sidebarRowExit(sidebarRowTravel(height)));
    });
  });
  const onLayout = (event: { bounds: { origin: { y: number }; size: { height: number } } }) => {
    if (untracked(props.leaving)) return;
    const y = event.bounds.origin.y;
    height = event.bounds.size.height;
    if (top !== undefined && y !== top && !reduceMotion()) {
      const move = sidebarRowMove(top - y);
      applyStartValues(motion, move);
      void motion.play(move);
    }
    top = y;
  };
  return (
    <View
      onLayout={onLayout}
      style={[
        frozenTop() !== null ? { position: "absolute", top: frozenTop()!, left: 0, right: 0, pointerEvents: "none" } : null,
        motion.style,
      ] as StyleProp<ViewStyle>}
      accessibilityElementsHidden={props.leaving()}
      importantForAccessibility={props.leaving() ? "no-hide-descendants" : "auto"}
    >
      {props.render(props.item)}
    </View>
  );
}

/** The settings search destination ring (index.css:923-935): drawn over its row, pulsing twice, then gone. */
export function SearchTargetPulse() {
  return <View class="absolute inset-0 rounded-xl border-2 border-primary" style={[{ pointerEvents: "none", opacity: 0 }, loopStyle(searchTargetPulse)] as StyleProp<ViewStyle>} />;
}

/** The last non-null value `value()` had: what a popup keeps showing while it plays its exit after its data went away. */
export function holdLast<T>(value: () => T | null | undefined): () => T | null {
  let last: T | null = null;
  const held = computed(() => {
    const now = value();
    if (now !== null && now !== undefined) last = now;
    return last;
  });
  return held;
}

/** The preview's loading bar (PreviewChromeRow.tsx:293): a h-0.5 primary bar along the chrome row's bottom edge. */
export function PreviewLoadingBar(props: { loading: () => boolean }) {
  const motion = createMotion({ initial: { opacity: 0, scaleX: 1 } });
  let first = true;
  effect(() => {
    const on = props.loading();
    untracked(() => {
      if (reduceMotion()) {
        motion.stop();
        motion.opacity.set(on ? 1 : 0);
        motion.scaleX.set(on ? 0.9 : 1);
      } else if (on) void motion.play(previewLoadingRun);
      else if (!first) void motion.play(previewLoadingDone);
    });
    first = false;
  });
  return <View class="absolute bottom-0 left-0 z-10 h-0.5 w-full rounded-r-full bg-primary" style={[{ pointerEvents: "none", transformOrigin: "left" }, motion.style] as StyleProp<ViewStyle>} />;
}

/**
 * A user's toggle of a collapsible, with the reference's height motion (ui/collapsible.tsx:29: height, 200ms, default
 * curve, none with reduced motion). NSH cannot animate a height on its own, so this configures LayoutAnimation for the
 * one commit the toggle makes: frames that change in it (the panel's parent and everything below) move over `ms`, and
 * removed content fades out with it. Only for direct user toggles: LayoutAnimation covers everything that commit changes,
 * so it must never wrap a server event.
 */
export function toggleWithLayout(ms: number, toggle: () => void, curve: "easeInEaseOut" | "easeOut" = "easeInEaseOut") {
  if (!reduceMotion()) LayoutAnimation.configureNext({ duration: ms, update: { type: curve }, delete: { type: curve, property: "opacity" } });
  toggle();
}

/**
 * ModelPickerSidebar.tsx:88-93: one bar (`h-5 w-0.75 rounded-full bg-primary`) that follows the selected row by animating `top`
 * (200ms ease-out). `top()` is where the bar sits in its parent, or null for no selection; a change between two places slides it
 * from the old one (FLIP: it is laid out at the new top and starts translated back), it appears in place otherwise.
 */
export function RailIndicator(props: { top: () => number | null; class?: string }) {
  const motion = createMotion();
  let previous: number | null = untracked(props.top);
  effect(() => {
    const next = props.top();
    untracked(() => {
      if (previous !== null && next !== null && previous !== next) {
        const move = railIndicatorMove(previous - next);
        applyStartValues(motion, move);
        void motion.play(move);
      }
      previous = next;
    });
  });
  return (
    <View
      class={props.class ?? "absolute right-1 z-10 h-5 w-[3px] rounded-full bg-primary"}
      style={[{ top: props.top() ?? 0, opacity: props.top() === null ? 0 : 1, pointerEvents: "none" }, motion.style] as StyleProp<ViewStyle>}
    />
  );
}
