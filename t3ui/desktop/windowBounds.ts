// DesktopWindow.ts + settings/DesktopAppSettings.ts: the main window keeps its size and place across launches
// (mainWindowBounds / mainWindowMaximized, saved 500 ms after the last move or resize, restored only when it still fits
// on a connected screen, 1 px tolerance) and never gets smaller than 400 x 360.
import { setMainWindowFrame, toggleMainWindowMaximize } from "./windowControl";
import process from "process";
import { desktop } from "./runtime";
import { onDesktopHostEvent, readWindowFrame, setWindowMinSize, setWindowOrigin, isFrame, type ScreenArea, type WindowFrameInfo } from "./desktopHost";

export const MIN_MAIN_WINDOW_SIZE = { width: 400, height: 360 } as const;
export const MAIN_WINDOW_BOUNDS_PERSIST_DEBOUNCE_MS = 500;
export const SAVED_BOUNDS_EDGE_TOLERANCE_PX = 1;
export const WINDOW_BOUNDS_KEY = "main_window_bounds";

export interface SavedWindowBounds { x: number; y: number; width: number; height: number; maximized: boolean }

export function windowFitsWithinDisplay(bounds: ScreenArea, display: ScreenArea): boolean {
  const t = SAVED_BOUNDS_EDGE_TOLERANCE_PX;
  return bounds.x >= display.x - t && bounds.y >= display.y - t
    && bounds.x + bounds.width <= display.x + display.width + t
    && bounds.y + bounds.height <= display.y + display.height + t;
}

export function parseSavedBounds(raw: string | null): SavedWindowBounds | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    const ints = ["x", "y", "width", "height"].every((k) => Number.isInteger(v[k]));
    if (!ints) return null;
    const b = v as unknown as SavedWindowBounds;
    if (b.width < MIN_MAIN_WINDOW_SIZE.width || b.height < MIN_MAIN_WINDOW_SIZE.height) return null;
    return { x: b.x, y: b.y, width: b.width, height: b.height, maximized: v.maximized === true };
  } catch {
    return null;
  }
}

/** resolveInitialMainWindowBounds: the saved bounds when a screen holds them, else null (the default size). */
export function resolveInitialBounds(saved: SavedWindowBounds | null, screens: readonly ScreenArea[]): SavedWindowBounds | null {
  return saved && screens.some((s) => windowFitsWithinDisplay(saved, s)) ? saved : null;
}

/** What a frame report saves: nothing while full screen, the last normal bounds while zoomed. */
export function boundsToSave(frame: WindowFrameInfo, previous: SavedWindowBounds | null): SavedWindowBounds | null {
  if (frame.fullScreen) return null;
  if (frame.maximized) return previous ? { ...previous, maximized: true } : null;
  const b = { x: Math.round(frame.x), y: Math.round(frame.y), width: Math.round(frame.width), height: Math.round(frame.height), maximized: false };
  if (b.width < MIN_MAIN_WINDOW_SIZE.width || b.height < MIN_MAIN_WINDOW_SIZE.height) return null;
  return b;
}

let installed = false;

export function installWindowBounds(options: { restore?: boolean } = {}) {
  if (installed) return;
  installed = true;
  void setWindowMinSize(MIN_MAIN_WINDOW_SIZE.width, MIN_MAIN_WINDOW_SIZE.height);
  // Test copies open at the launcher's fixed size for pixel comparisons (run_local.py sets T3GPUI_NO_WINDOW_RESTORE).
  const restore = options.restore ?? (!process.env.T3GPUI_NO_WINDOW_RESTORE && !process.env.T3GPUI_TEST_WINDOW_ORIGIN);
  let saved: SavedWindowBounds | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let ready = false;
  const persist = (frame: WindowFrameInfo) => {
    const next = boundsToSave(frame, saved);
    if (!next) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      saved = next;
      void desktop().setItem(WINDOW_BOUNDS_KEY, JSON.stringify(next));
    }, MAIN_WINDOW_BOUNDS_PERSIST_DEBOUNCE_MS);
  };
  onDesktopHostEvent<unknown>("window.frameChanged", (frame) => { if (ready && isFrame(frame)) persist(frame); });
  void (async () => {
    saved = parseSavedBounds(await desktop().getItem(WINDOW_BOUNDS_KEY));
    const frame = await readWindowFrame();
    if (restore && frame) {
      const initial = resolveInitialBounds(saved, frame.screens);
      if (initial) {
        // The GPUI host's Window.setFrame sizes but never moves the window (chrome.rs SetFrame: "GPUI sizes a window
        // but leaves its place to the platform"), so the place goes through host patch 0010's window.setOrigin.
        setMainWindowFrame({ size: { width: initial.width, height: initial.height } });
        if (!(await setWindowOrigin(initial.x, initial.y))) setMainWindowFrame({ origin: { x: initial.x, y: initial.y } });
        if (initial.maximized && !frame.maximized) toggleMainWindowMaximize();
      }
    }
    ready = true;
  })();
}
