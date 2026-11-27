// The commands behind the application menu's items (apps/desktop/src/window/DesktopApplicationMenu.ts): each menu item runs one of these
// through the command registry, so the menu, the palette and a keybinding all reach the same code. They are not DEFAULT_KEYBINDINGS
// commands; their chords belong to the menu (and, for the app zoom, to the keystroke fallbacks below).
import { keymap } from "nsh";
import { closeMainWindow } from "../desktop/windowControl";
import { backendUrl, configureBackend } from "../store";
import { zoomApp, type ZoomDirection } from "../shell/appZoom";
import { zoomHoveredSurface } from "../shell/surfaceZoom";
import { showUpdateCheckToast } from "../desktop/updateCheck";
import { dispatchKeystroke, registerCommands, registerKeystrokeFallback, runCommand } from "./registry";

export const APP_COMMAND = {
  checkForUpdates: "app.checkForUpdates",
  closeWindow: "app.closeWindow",
  pasteAsText: "app.pasteAsText",
  reload: "app.reload",
  forceReload: "app.forceReload",
  zoomIn: "app.zoomIn",
  zoomOut: "app.zoomOut",
  zoomReset: "app.zoomReset",
} as const;

/** The chord the preview's own command holds for each zoom direction: with a preview focused it takes the press, else the app zoom does. */
const ZOOM_CHORD: Record<ZoomDirection, string> = { in: "mod+plus", out: "mod+minus", reset: "mod+0" };

function zoom(direction: ZoomDirection) {
  if (dispatchKeystroke(ZOOM_CHORD[direction])) return;
  zoomContext(direction);
}

/** A diff or file preview under the pointer zooms its own text (shell/surfaceZoom.ts); elsewhere the whole app zooms. */
function zoomContext(direction: ZoomDirection) {
  if (!zoomHoveredSurface(direction)) zoomApp(direction);
}

/** The app's "Reload": this app has no page to reload, so it reconnects to its server and reads everything again. */
function reload() {
  if (dispatchKeystroke("mod+r")) return;
  const url = backendUrl();
  if (url) configureBackend(url);
}

let installed = false;

export function installAppCommands() {
  if (installed) return;
  installed = true;
  registerCommands({
    // Check-only: queries GitHub's releases API (desktop/updateCheck.ts) and always shows a result, including
    // offline/rate-limit errors. No download/install — this build is ad-hoc signed and not notarized.
    [APP_COMMAND.checkForUpdates]: () => { void showUpdateCheckToast(); },
    [APP_COMMAND.closeWindow]: () => { closeMainWindow(); },
    // composer.pasteAsText is registered by the open composer (shellCommands bindComposerPasteAsText); false lets a native paste stand.
    [APP_COMMAND.pasteAsText]: () => (runCommand("composer.pasteAsText") ? undefined : false),
    [APP_COMMAND.reload]: reload,
    [APP_COMMAND.forceReload]: reload,
    [APP_COMMAND.zoomIn]: () => zoom("in"),
    [APP_COMMAND.zoomOut]: () => zoom("out"),
    [APP_COMMAND.zoomReset]: () => zoom("reset"),
  });
  // The registry holds one binding per chord and answers it with the preview's command while a preview has the focus; with none, the press is the app's.
  registerKeystrokeFallback("mod+plus", () => zoomContext("in"));
  registerKeystrokeFallback("mod+minus", () => zoomContext("out"));
  registerKeystrokeFallback("mod+0", () => zoomContext("reset"));
  // Cmd++ on a US keyboard is Cmd+Shift+=: the web menu lists it as a hidden twin of Zoom In.
  try { keymap.bind("mod+shift+plus", () => zoom("in")); } catch { /* a layout the keymap rejects */ }
}
