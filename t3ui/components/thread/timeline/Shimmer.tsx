import { cleanup, createMotion, effect, platform, reduceMotion, signal, Text, untracked, View } from "nsh";
import type { MotionSpec } from "nsh";
import { tokenOver } from "../../composer/tokenColor";
import { isDeclarativeWindow } from "../../../desktop/windowControl";
import { isWindowsLoopPaused } from "../../motion/Motion";

const BAND = 72;
const STEPS = 30;
const STEP_MS = 73;

export function shimmerCenter(step: number, width: number): number {
  return -BAND / 2 + ((width + BAND) * (step % STEPS)) / STEPS;
}

/** Amount of foreground colour at a character's approximate position. */
export function shimmerStrength(index: number, count: number, step: number, width: number): number {
  if (count <= 0 || width <= 0) return 0;
  const position = ((index + 0.5) / count) * width;
  return Math.max(0, 1 - Math.abs(position - shimmerCenter(step, width)) / (BAND / 2));
}

export function useWindowsShimmerPulse(os: string = platform.os, declarative: boolean = isDeclarativeWindow()): boolean {
  return os === "windows" && declarative;
}

const shimmerPulse: MotionSpec = {
  keyframes: { opacity: [1, 0.45, 1] },
  duration: 1800,
  easing: "easeInOut",
  iterations: "infinite",
  frameRate: 15,
} as MotionSpec;

function WindowsShimmerText(props: { text: () => string; active: () => boolean; class?: string; tabular?: boolean }) {
  const motion = createMotion();
  effect(() => {
    const on = props.active() && !reduceMotion() && !isWindowsLoopPaused();
    untracked(() => {
      if (on) {
        void motion.play(shimmerPulse);
      } else {
        motion.reset();
      }
    });
  });
  cleanup(() => motion.stop());
  return (
    <View class="min-w-0 shrink" style={motion.style}>
      <Text class={`${props.class ?? ""} truncate text-muted-foreground ${props.tabular ? "tabular-nums" : ""}`} accessibilityLabel={props.active() ? "Working shimmer" : undefined}>
        {props.text()}
      </Text>
    </View>
  );
}

function CharacterBandShimmerText(props: { text: () => string; active: () => boolean; class?: string; tabular?: boolean }) {
  const step = signal(0);
  const width = signal(0);
  effect(() => {
    if (!props.active()) return;
    const timer = setInterval(() => step.update((value) => (value + 1) % STEPS), STEP_MS);
    return () => clearInterval(timer);
  });
  return (
    <View class="min-w-0 shrink" onLayout={(event) => width.set(event.bounds.size.width)}>
      <Text class={`${props.class ?? ""} truncate text-muted-foreground ${props.tabular ? "tabular-nums" : ""}`} accessibilityLabel={props.active() ? "Working shimmer" : undefined}>
        {props.active() ? Array.from(props.text()).map((character, index, chars) => (
          <Text style={{ color: tokenOver("foreground", "muted-foreground", shimmerStrength(index, chars.length, step(), width() || chars.length * 7)) }}>{character}</Text>
        )) : props.text()}
      </Text>
    </View>
  );
}

export function ShimmerText(props: { text: () => string; active: () => boolean; class?: string; tabular?: boolean }) {
  return useWindowsShimmerPulse() ? <WindowsShimmerText {...props} /> : <CharacterBandShimmerText {...props} />;
}
