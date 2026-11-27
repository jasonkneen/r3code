// The quit shortcut's confirmation (apps/desktop/src/window/QuitHold.ts and components/QuitHoldOverlay.tsx in the web app).
// The saved setting `confirmQuit` is "direct" (quit at once), "hold" (hold the key for 1.2 s or press it twice) or "double-click"
// (press it twice). Electron sees key events and key-ups; NSH only has the menu: the application menu's Quit item (⌘Q) calls
// `pressQuitShortcut` once per activation, a held key's auto-repeats arrive as quick successive activations, so a gap
// under REPEAT_GAP_MS is a repeat of the key still being held and a longer one is a new press.
import { host, platform, signal } from "nsh";
import { Menu } from "nsh/desktop";
import { closeMainWindow } from "../desktop/windowControl";
import { settingValue } from "../store";
import { toggleSettings } from "../commands/standardCommands";
import { installAppCommands } from "../commands/appCommands";
import { runCommand } from "../commands/registry";
import { buildApplicationMenu, parseHostMenuRoles } from "./applicationMenu";
import { stopAllSshTunnels } from "../environments/ssh";

export type QuitMode = "direct" | "hold" | "double-click";
export type QuitHint = "hold" | "double-click";

export const QUIT_HOLD_DURATION_MS = 1200;
export const QUIT_DOUBLE_PRESS_MS = 500;
/** The hint of a hold stays this long after the key was last seen. */
export const HOLD_HINT_LINGER_MS = 1200;
/** Auto-repeat arrives faster than this; a second press by hand does not. */
export const REPEAT_GAP_MS = 250;

export interface QuitClock {
  now: () => number;
  setTimer: (run: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
}

export interface QuitController {
  /** One activation of the quit shortcut. */
  press: () => void;
  /** The hint that shows now, or null. */
  hint: () => QuitHint | null;
}

const realClock: QuitClock = { now: () => Date.now(), setTimer: (run, ms) => setTimeout(run, ms), clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>) };

export function createQuitController(input: { mode: () => QuitMode; quit: () => void; clock?: QuitClock }): QuitController {
  const clock = input.clock ?? realClock;
  const hint = signal<QuitHint | null>(null);
  let lastPressAt = 0;
  let heldSince = 0;
  let timer: unknown = null;

  const hideAfter = (ms: number) => {
    if (timer !== null) clock.clearTimer(timer);
    timer = clock.setTimer(() => { timer = null; hint.set(null); lastPressAt = 0; }, ms);
  };
  const quitNow = () => {
    if (timer !== null) clock.clearTimer(timer);
    timer = null;
    hint.set(null);
    lastPressAt = 0;
    input.quit();
  };

  return {
    hint: () => hint(),
    press: () => {
      const now = clock.now();
      const gap = lastPressAt === 0 ? Infinity : now - lastPressAt;
      lastPressAt = now;
      if (gap <= REPEAT_GAP_MS) {
        // The key is still down: a hold quits once it has lasted long enough.
        if (hint() === "hold" && now - heldSince >= QUIT_HOLD_DURATION_MS) { quitNow(); return; }
        if (hint() === "hold") hideAfter(HOLD_HINT_LINGER_MS);
        return;
      }
      if (gap <= QUIT_DOUBLE_PRESS_MS) { quitNow(); return; }
      const mode = input.mode();
      if (mode === "direct") { quitNow(); return; }
      heldSince = now;
      hint.set(mode);
      hideAfter(mode === "double-click" ? QUIT_DOUBLE_PRESS_MS : HOLD_HINT_LINGER_MS);
    },
  };
}

/** The saved `confirmQuit`, or the default (hold) for anything else. */
export function savedQuitMode(): QuitMode {
  const value = settingValue("confirmQuit");
  return value === "direct" || value === "double-click" ? value : "hold";
}

// SSH tunnels (environments/ssh.ts) end before the window closes, so no ssh child outlives the app.
let quitAction = () => { stopAllSshTunnels(); closeMainWindow(); };
/** Tests replace what quitting does. */
export function setQuitAction(next: (() => void) | null) { quitAction = next ?? (() => { stopAllSshTunnels(); closeMainWindow(); }); }
const live = createQuitController({ mode: savedQuitMode, quit: () => quitAction() });

export const quitHint = () => live.hint();
export const pressQuitShortcut = () => live.press();

/** The shortcut as the hint spells it. */
export function quitShortcutLabel(): string {
  return platform.os === "macos" ? "⌘Q" : "Ctrl+Q";
}

export function quitHintMessage(hint: QuitHint): string {
  const shortcut = quitShortcutLabel();
  return hint === "hold" ? `Hold ${shortcut} or press twice to quit` : `Press ${shortcut} again to quit`;
}

/**
 * The application menu (DesktopApplicationMenu.ts), built in shell/applicationMenu.ts: the app menu with the Quit item that carries the
 * confirmation, File, Edit, View, Window and Help. Its items run commands of the registry (commands/appCommands.ts).
 */
export function installApplicationMenu() {
  installAppCommands();
  const install = (hostRoles?: ReadonlySet<string>) => {
    try {
      Menu.setApplicationMenu(buildApplicationMenu({ os: platform.os, run: (id) => { runCommand(id); }, openSettings: toggleSettings, quit: pressQuitShortcut, ...(hostRoles ? { hostRoles } : {}) }));
      if (platform.os !== "macos") (Menu as { setMenuBar?: (mode: "shown" | "autoHide") => void }).setMenuBar?.("autoHide");
    } catch {
      // A platform without an application menu has no ⌘Q to confirm either.
    }
  };
  install();
  // Patch 0014's roles (Services, Delete, Speech, Bring All to Front): only once the host names them.
  try {
    void host.call("menu.roles", null).then((value) => {
      const roles = parseHostMenuRoles(value);
      if (roles.size > 0) install(roles);
    }, () => {});
  } catch { /* no host channel */ }
}
