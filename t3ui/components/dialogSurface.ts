// The shared look of a modal: the web's `dialog-backdrop` and `dialog-glass` utilities (apps/web/src/index.css).
//
//   dialog-backdrop: --background at 60% (64% in dark) with `backdrop-filter: blur(4px)`; the app shows dimmed and blurred behind it.
//   dialog-glass:    --background at --glass-opacity over that blurred backdrop, which comes out as the background itself;
//                    the card is NOT the popover token (that one is the lighter slate menus use).
//
// Build the scrim alpha explicitly because NSH squares Tailwind alpha modifiers.
// The macOS GPUI host paints backdrop-filter through its cached Metal blur passes.
import { Animated, cleanup, colorScheme, createMotion, effect, reduceMotion, signal, untracked } from "nsh";
import { tokenAlpha } from "./composer/tokenColor";
import { applyStartValues, specStartValues } from "./motion/Motion";
import { dialogScaleEnter, dialogScaleExit } from "./motion/motionTokens";

/** Blur radius of `dialog-backdrop`, in points. */
export const DIALOG_BACKDROP_BLUR = 4;

/** The scrim's alpha: 64% in dark, 60% in light. */
export const dialogBackdropAlpha = () => (colorScheme() === "dark" ? 0.64 : 0.6);

/** The backdrop's style: the page colour at the scrim alpha, and the blur of what is behind it. */
export function dialogBackdropStyle() {
  return { backgroundColor: tokenAlpha("background", dialogBackdropAlpha()), backdropFilter: `blur(${DIALOG_BACKDROP_BLUR}px)` };
}

/** The classes of a dialog card: the page colour (see above), the 2xl radius and the hairline the web draws. */
export const DIALOG_CARD_CLASS = "rounded-2xl border border-border bg-background";

/**
 * The popup's motion (ui/dialog-styles.ts:8: scale .98 to 1 in, 1 to .98 out, 200ms ease-in-out), for a Dialog's
 * `style`; the Dialog's own `animation="fade"` does the opacity. `open` defaults to "open while mounted".
 */
export function dialogPopupMotion(open: () => boolean = () => true) {
  const initiallyOpen = untracked(open);
  const motion = createMotion(initiallyOpen && !reduceMotion() ? { initial: specStartValues(dialogScaleEnter) } : undefined);
  const id = ++dialogSequence;
  let first = true;
  effect(() => {
    const on = open();
    untracked(() => {
      if (on) { applyStartValues(motion, dialogScaleEnter); void motion.play(dialogScaleEnter); openDialogs.set([...openDialogs().filter((other) => other !== id), id]); }
      else { openDialogs.set(openDialogs().filter((other) => other !== id)); if (!first) void motion.play(dialogScaleExit); }
    });
    first = false;
  });
  cleanup(() => untracked(() => openDialogs.set(openDialogs().filter((other) => other !== id))));
  // ui/dialog-styles.ts:8 --nested-dialogs: a dialog with n dialogs open above it sits 1.25rem higher per level, scaled and
  // faded by .1 per level, moving over 200ms ease-in-out.
  let depth = 0;
  effect(() => {
    const nested = nestedDialogCount(id, openDialogs());
    if (nested === depth) return;
    depth = nested;
    const target = nestedDialogStyle(nested);
    const timing = { duration: 200, easing: dialogScaleEnter.easing };
    untracked(() => void Animated.parallel([
      Animated.timing(motion.scale, { toValue: target.scale, ...timing }),
      Animated.timing(motion.translateY, { toValue: target.translateY, ...timing }),
      Animated.timing(motion.opacity, { toValue: target.opacity, ...timing }),
    ]).start());
  });
  return motion.style;
}

const openDialogs = signal<number[]>([]);
let dialogSequence = 0;

/** How many dialogs opened after this one are still open (--nested-dialogs). */
export function nestedDialogCount(id: number, open: readonly number[]): number {
  const index = open.indexOf(id);
  return index < 0 ? 0 : open.length - 1 - index;
}

/** The nested look: scale 1 - .1n, translateY -1.25rem * n (20 pt), opacity 1 - .1n. */
export function nestedDialogStyle(nested: number): { scale: number; translateY: number; opacity: number } {
  return { scale: 1 - 0.1 * nested, translateY: nested === 0 ? 0 : -20 * nested, opacity: 1 - 0.1 * nested };
}

/**
 * Give a dialog card `onPress={keepPressInDialog}`. On the GPUI host a press inside a Dialog's popup that no view there takes
 * (a title, a label, empty card space) goes on to the backdrop and fires `onOpenChange` with
 * `reason: "backdropPress"`, so a dialog that closes on backdrop presses closed on any click inside it. The card taking the
 * press itself keeps it inside; presses on the real backdrop still close (seen on the scheduled-task editor, 2026-11-12).
 */
export const keepPressInDialog = () => {};
