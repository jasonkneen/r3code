// ui/spinner.tsx: a Loader2 mark turning forever (animate-spin).
import { cleanup, createMotion, effect, platform, untracked, View } from "nsh";
import { isDeclarativeWindow } from "../../desktop/windowControl";
import { isWindowsLoopPaused } from "../motion/Motion";
import { Glyph } from "./SidebarGlyph";

export function Spinner(props: { size?: number; tint?: string }) {
  const motion = createMotion();
  effect(() => {
    const paused = isWindowsLoopPaused();
    untracked(() => {
      if (paused) {
        motion.stop();
        return;
      }
      void (platform.os === "windows" && isDeclarativeWindow()
        ? motion.play("spin", { frameRate: 20 } as Record<string, unknown>)
        : motion.play("spin"));
    });
  });
  cleanup(() => motion.stop());
  const size = props.size ?? 14;
  return (
    <View accessibilityLabel="Loading" style={{ ...motion.style, width: size, height: size }}>
      <Glyph name="loader-circle" size={size} tint={props.tint} />
    </View>
  );
}
