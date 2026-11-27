// Asking for a theme pick (or a contrast change) to show up. NSH fixes the palette when the bundle is
// built, so a running window cannot recolour itself on its own; two paths get there, chosen by capability,
// not by guess (`liveCapable`, below):
//
//  - Live (a host with the `theme.setOverrides` patch, third_party/nsh-host/README.md "live theme"): the
//    app writes theme-live-request.json, tools/build_theme.py's LiveThemeWatcher (polled far more often
//    than the rebuild loop) generates the same theme.json shape into theme-live.json and answers in
//    theme-live-status.json, and this module reads that result and calls `host.call("theme.setOverrides",
//    theme)` itself: no rebuild, no restart, under `host.call`'s own round trip.
//  - Rebuild (the stock host, unchanged): the app writes theme-request.json, tools/run_local.py sees it
//    change, generates the theme into a build copy (tools/build_theme.py), rebuilds and restarts only the
//    window (the server keeps running), and this app signs back in with its saved session and shows what
//    was built (builtTheme.ts). Answered in theme-status.json: {requestId, ok, message}.
//
// Either way the choice is also written to theme-last.json (never watched for a rebuild: read only at the
// next launch, LauncherThemes.start()), so a live apply's choice still starts themed, without a flash, on
// the next launch. A failure on either path leaves the running window and its theme as they were; the app
// shows the error as a toast while preserving the user's selection for a later retry.
import { effect, host, signal, untracked } from "nsh";
import { readFile, rename, writeFile } from "fs/promises";
import { homedir } from "os";
import { settingValue } from "../../store";
import { showToast } from "../../components/toast/toastState";
import { THEME_CARDS, type ThemeAppearance } from "../../themePreviews";
import { builtContrast, builtThemeForMode, DEFAULT_CONTRAST, MAX_CONTRAST, MIN_CONTRAST, setBuiltTheme, themeRebuildAvailable } from "./builtTheme";
import { customThemeById, customThemes, type CustomTheme } from "./customThemes";
import { environmentThemeById, environmentThemes } from "./environmentThemes";
import { generateLiveTheme } from "./liveThemeGenerator";

export const REQUEST_FIELDS = { light: "themeLight", dark: "themeDark", contrast: "appearanceContrast" } as const;

export interface DesiredTheme { light: string; dark: string; contrast: number }

export interface ThemeRequestIo {
  /** Replaces the request file with this text. */
  writeRequest(text: string): Promise<void>;
  /** The launcher's status file, null when it has none yet. */
  readStatus(): Promise<string | null>;
  /** The live-apply fast path and persistence, all optional: a test's `io` that omits them keeps
   * the rebuild path even when `host.available()` is true (`liveCapable` requires every one). */
  /** Replaces the live-apply request file with this text. */
  writeLiveRequest?(text: string): Promise<void>;
  /** The live watcher's status file, null when it has none yet. */
  readLiveStatus?(): Promise<string | null>;
  /** The live watcher's generated `{requestId, theme, meta}`, null when it has none yet. */
  readLiveResult?(): Promise<string | null>;
  /** Persists the choice for the next launch's themed first build (never read by the rebuild
   * loop's `changed()`, so this alone never queues a rebuild). */
  writeLast?(text: string): Promise<void>;
}

export interface ThemeSyncOptions {
  io?: ThemeRequestIo;
  /** Wait after a theme pick before asking (picking a second theme right away replaces the first). */
  pickDelayMs?: number;
  /** Wait after a contrast change: the slider fires on every step, the request is sent once it rests. */
  contrastDelayMs?: number;
  pollMs?: number;
  /** The live path's own poll interval (LiveThemeWatcher's own generation is ~20 ms): far shorter
   * than `pollMs`, which the rebuild path uses and whose cadence a live apply must not be held to
   * (third_party/nsh-host/README.md "live theme", the under-300-ms-to-repaint target). */
  livePollMs?: number;
  /** Give up waiting for the launcher's answer after this long. */
  timeoutMs?: number;
  /** Whether a live apply can be tried (`liveCapable`'s own `host.available()` check, overridable so
   * a test can exercise the live path without a real host bridge): defaults to `host.available()`. */
  isLiveCapable?: () => boolean;
  /** Calls the host (`host.call`, overridable for the same reason): defaults to it exactly. */
  callHost?: (name: string, data: unknown) => Promise<unknown>;
  /** Generates the theme JSON in-process and applies it directly via `theme.setOverrides` (for hosts without a launcher theme supervisor, e.g. Windows). */
  directLive?: boolean;
}

/** The folder the launcher put this window's bootstrap file in (a test copy has its own), else the main one. */
const bootstrapDirectory = () => {
  const main = `${homedir()}/.t3codegpui/bootstrap`;
  let file: string | undefined;
  try { file = process.env.T3GPUI_BOOTSTRAP_FILE; } catch { file = undefined; }
  const folder = file ? file.slice(0, file.lastIndexOf("/")) : "";
  return folder.startsWith(`${main}/`) ? folder : main;
};

/** Writes `text` to `name` under the bootstrap directory, atomically (a temporary file renamed over it). */
async function writeBootstrapFile(name: string, text: string): Promise<void> {
  const target = `${bootstrapDirectory()}/${name}`;
  const temporary = `${target}.tmp`;
  await writeFile(temporary, text);
  await rename(temporary, target);
}

/** `name` under the bootstrap directory, or null when it does not exist yet. */
async function readBootstrapFile(name: string): Promise<string | null> {
  try {
    return await readFile(`${bootstrapDirectory()}/${name}`, "utf8");
  } catch {
    return null;
  }
}

/** The request, status, live-apply and persistence files the launcher watches and writes
 * (tools/build_theme.py REQUEST_FILE, STATUS_FILE, LIVE_REQUEST_FILE, LIVE_STATUS_FILE,
 * LIVE_RESULT_FILE, LAST_FILE). */
export const fileIo: ThemeRequestIo = {
  writeRequest: (text) => writeBootstrapFile("theme-request.json", text),
  readStatus: () => readBootstrapFile("theme-status.json"),
  writeLiveRequest: (text) => writeBootstrapFile("theme-live-request.json", text),
  readLiveStatus: () => readBootstrapFile("theme-live-status.json"),
  readLiveResult: () => readBootstrapFile("theme-live.json"),
  writeLast: (text) => writeBootstrapFile("theme-last.json", text),
};

const applying = signal(false);
/** True from the moment a choice is made until the launcher has swapped the window or answered. */
export const applyingTheme = () => applying();

const known = (id: string) => THEME_CARDS.some((card) => card.id === id) || customThemeById(id) !== null || environmentThemeById(id) !== null;

function savedTheme(mode: ThemeAppearance): string {
  const value = settingValue(REQUEST_FIELDS[mode]);
  // A custom theme that is not loaded yet is not a choice to act on; the library signal reruns this when it is.
  return typeof value === "string" && known(value) ? value : builtThemeForMode(mode);
}

/** What the settings ask for: the picked theme per mode (the built one when unset) and the contrast. */
export function desiredTheme(): DesiredTheme {
  const saved = settingValue(REQUEST_FIELDS.contrast);
  const contrast = typeof saved === "number" && Number.isInteger(saved) && saved >= MIN_CONTRAST && saved <= MAX_CONTRAST ? saved : builtContrast();
  return { light: savedTheme("light"), dark: savedTheme("dark"), contrast };
}

const builtDesired = (): DesiredTheme => ({ light: builtThemeForMode("light"), dark: builtThemeForMode("dark"), contrast: builtContrast() });

function usedCustoms(desired: DesiredTheme, preview?: CustomTheme | null): CustomTheme[] {
  const ids = new Set([desired.light, desired.dark]);
  // A saved theme wins over a published one with its id; a published palette goes in as a custom one would, so a
  // republished palette is a new request (startEnvironmentThemeRepaint).
  const saved = customThemes().filter((theme) => ids.has(theme.id));
  const published = environmentThemes().filter((theme) => ids.has(theme.id) && !saved.some((own) => own.id === theme.id));
  return [...saved, ...published, ...(preview && ids.has(preview.id) ? [preview] : [])].sort((a, b) => (a.id < b.id ? -1 : 1));
}

/** The contents of a request: equal signatures need no new build. */
function signature(desired: DesiredTheme, preview?: CustomTheme | null): string {
  return JSON.stringify({ ...desired, customs: usedCustoms(desired, preview) });
}

export function requestBody(desired: DesiredTheme, requestId: string, preview?: CustomTheme | null): string {
  return JSON.stringify({
    version: 1,
    requestId,
    themeLight: desired.light,
    themeDark: desired.dark,
    contrast: desired.contrast,
    // variants carry the other appearance's palette (tools/build_theme.py validate_custom); collection and managed ride along.
    customThemes: usedCustoms(desired, preview).map(({ id, label, appearance, colors, variants, collection, managed }) => ({
      id, label, appearance, colors, ...(variants ? { variants } : {}), ...(collection ? { collection } : {}), ...(managed ? { managed: true } : {}),
    })),
  });
}

let config: Required<ThemeSyncOptions> | null = null;
let installed = false;
let timer: ReturnType<typeof setTimeout> | null = null;
let poll: ReturnType<typeof setTimeout> | null = null;
let lastSent = "";
let lastContrast = DEFAULT_CONTRAST;
let counter = 0;
let inFlight: string | null = null;
let previewRequest: string | null = null;
const editorPreview = signal<CustomTheme | null>(null);

/** A temporary editor palette. It is never written to the user's settings or launch theme. */
export function setEditorThemePreview(preview: CustomTheme | null) {
  editorPreview.set(preview);
}

function effectiveTheme(): { desired: DesiredTheme; preview: CustomTheme | null } {
  const desired = desiredTheme();
  const preview = liveCapable() ? editorPreview() : null;
  return { desired: preview ? { ...desired, [preview.appearance]: preview.id } : desired, preview };
}
// Native theme applications can finish asynchronously. Serialize them so an
// older request cannot repaint the window after a newer request has applied.
let hostApplyQueue: Promise<void> = Promise.resolve();
let liveWriteQueue: Promise<void> = Promise.resolve();
let lastWriteQueue: Promise<void> = Promise.resolve();

function clearTimers() {
  if (timer !== null) clearTimeout(timer);
  if (poll !== null) clearTimeout(poll);
  timer = poll = null;
}

function finish() {
  inFlight = null;
  applying.set(false);
}

/** A failed paint leaves the active palette unchanged, but must not erase the user's saved choice.
 * Forget the request signature so selecting the same theme again can retry it. */
function fail(message: string) {
  lastSent = "";
  finish();
  showToast({ type: "error", title: "Could not apply theme", description: message || "The theme could not be applied." });
}

function watch(requestId: string, deadline: number) {
  const current = config;
  if (!current) return;
  poll = setTimeout(() => {
    void current.io.readStatus().then((text) => {
      if (inFlight !== requestId) return;
      let status: { requestId?: unknown; ok?: unknown; message?: unknown } | null = null;
      try { status = text ? JSON.parse(text) : null; } catch { status = null; }
      if (status && status.requestId === requestId) {
        // ok: the launcher had nothing to rebuild (the window already shows it); otherwise the window restarts.
        if (status.ok === true) finish();
        else fail(typeof status.message === "string" ? status.message : "");
        return;
      }
      if (Date.now() >= deadline) { fail("The launcher did not answer the theme request."); return; }
      watch(requestId, deadline);
    });
  }, current.pollMs);
}

/** Whether a live apply can be tried instead of a rebuild: a host with the `theme.setOverrides`
 * capability (detected, not guessed: `host.available()` only turns true once a handler of some
 * name is registered, third_party/nsh-host/README.md "live theme") and an `io` that implements the
 * live path (the default `fileIo` does; a test's own `io` opts in by implementing it, or stays on
 * the rebuild path by omitting it, as `ThemeSync.test.tsx`'s fixture does). */
function liveCapable(): boolean {
  const current = config;
  if (!current) return false;
  if (!current.directLive && (!current.io.writeLiveRequest || !current.io.readLiveStatus || !current.io.readLiveResult)) return false;
  try {
    return current.isLiveCapable();
  } catch {
    return false;
  }
}

function watchLive(requestId: string, deadline: number) {
  const current = config;
  if (!current) return;
  poll = setTimeout(() => {
    void current.io.readLiveStatus!().then((text) => {
      if (inFlight !== requestId) return;
      let status: { requestId?: unknown; ok?: unknown; message?: unknown } | null = null;
      try { status = text ? JSON.parse(text) : null; } catch { status = null; }
      if (status && status.requestId === requestId) {
        if (status.ok === true) void applyLive(requestId);
        else fail(typeof status.message === "string" ? status.message : "");
        return;
      }
      if (Date.now() >= deadline) { fail("The launcher did not answer the theme request."); return; }
      watchLive(requestId, deadline);
    });
  }, current.livePollMs);
}

/** The live watcher generated a theme: read it and hand it to the host (`theme.setOverrides`),
 * which applies it to the live window at once, no rebuild and no restart. */
async function applyLive(requestId: string): Promise<void> {
  const current = config;
  if (!current) return;
  try {
    const text = await current.io.readLiveResult!();
    const parsed = text ? (JSON.parse(text) as { requestId?: unknown; theme?: unknown; meta?: unknown }) : null;
    if (!parsed || parsed.requestId !== requestId || !parsed.theme || !parsed.meta) {
      throw new Error("The launcher's live theme result was not in the expected shape.");
    }
    const apply = hostApplyQueue.catch(() => {}).then(async () => {
      if (config !== current || inFlight !== requestId) return false;
      await current.callHost("theme.setOverrides", parsed.theme);
      return true;
    });
    hostApplyQueue = apply.then(() => {}, () => {});
    if (!(await apply)) return;
    if (inFlight !== requestId) return;
    // The selection rings and "which theme is showing" follow the live apply at once: the same
    // signal a themed rebuild sets from T3GPUI_BUILT_THEME at startup (builtTheme.ts).
    if (previewRequest !== requestId) setBuiltTheme(parsed.meta as { light: string; dark: string; contrast: number });
    finish();
  } catch (error) {
    if (inFlight === requestId) fail(error instanceof Error ? error.message : "The theme could not be applied live.");
  }
}

function send() {
  timer = null;
  const current = config;
  if (!current) return;
  const { desired, preview } = effectiveTheme();
  const sig = signature(desired, preview);
  if (sig === lastSent) { if (inFlight === null) applying.set(false); return; }
  const requestId = `${Date.now()}-${++counter}`;
  lastSent = sig;
  inFlight = requestId;
  previewRequest = preview ? requestId : null;
  applying.set(true);
  const body = requestBody(desired, requestId, preview);
  // Persists the choice for the next launch's themed first build, live apply or rebuild alike
  // (LauncherThemes.start() reads it before the rebuild loop's own request file, so it is never
  // what triggers a rebuild). Best-effort: a failure here never fails the request itself.
  if (!preview && !current.directLive && current.io.writeLast) {
    // Atomic writes use the same temporary filename, so concurrent writes can
    // otherwise collide or leave an older selection as the next launch theme.
    const writeLast = current.io.writeLast;
    lastWriteQueue = lastWriteQueue.catch(() => {}).then(() => writeLast(body)).catch(() => {});
  }
  if (current.directLive && liveCapable()) {
    const customs = usedCustoms(desired, preview);
    const apply = hostApplyQueue.catch(() => {}).then(async () => {
      if (config !== current || inFlight !== requestId) return false;
      const theme = generateLiveTheme(desired, customs);
      await current.callHost("theme.setOverrides", theme);
      return true;
    });
    hostApplyQueue = apply.then(() => {}, () => {});
    void apply.then(
      (applied) => {
        if (!applied || inFlight !== requestId) return;
        if (previewRequest !== requestId) setBuiltTheme(desired);
        finish();
      },
      (error: unknown) => {
        if (inFlight === requestId) fail(error instanceof Error ? error.message : "The theme could not be applied live.");
      },
    );
    return;
  }
  if (liveCapable()) {
    const write = liveWriteQueue.catch(() => {}).then(async () => {
      if (config !== current || inFlight !== requestId) return false;
      await current.io.writeLiveRequest!(body);
      return true;
    });
    liveWriteQueue = write.then(() => {}, () => {});
    void write.then(
      (written) => { if (written && inFlight === requestId) watchLive(requestId, Date.now() + current.timeoutMs); },
      (error: unknown) => { if (inFlight === requestId) fail(error instanceof Error ? error.message : "The theme request could not be saved."); },
    );
    return;
  }
  void current.io.writeRequest(body).then(
    () => { if (inFlight === requestId) watch(requestId, Date.now() + current.timeoutMs); },
    (error: unknown) => { if (inFlight === requestId) fail(error instanceof Error ? error.message : "The theme request could not be saved."); },
  );
}

function schedule() {
  const current = config;
  if (!current) return;
  const { desired, preview } = effectiveTheme();
  const sig = signature(desired, preview);
  const contrastMoved = desired.contrast !== lastContrast;
  lastContrast = desired.contrast;
  if (timer !== null) { clearTimeout(timer); timer = null; }
  if (sig === lastSent) { if (inFlight === null) applying.set(false); return; }
  applying.set(true);
  timer = setTimeout(send, contrastMoved ? current.contrastDelayMs : current.pickDelayMs);
}

/**
 * Starts answering theme and contrast choices with a rebuild request. The app does this once on start when
 * the launcher built it; tests install it with their own `io`. Calling it again replaces the options.
 */
export function installThemeSync(options: ThemeSyncOptions = {}) {
  clearTimers();
  config = {
    io: options.io ?? fileIo,
    pickDelayMs: options.pickDelayMs ?? 150,
    contrastDelayMs: options.contrastDelayMs ?? 700,
    pollMs: options.pollMs ?? 400,
    livePollMs: options.livePollMs ?? 15,
    timeoutMs: options.timeoutMs ?? 180_000,
    isLiveCapable: options.isLiveCapable ?? (() => host.available()),
    callHost: options.callHost ?? ((name, data) => host.call(name, data)),
    directLive: options.directLive ?? (options.io === undefined && !themeRebuildAvailable()),
  };
  inFlight = null;
  applying.set(false);
  untracked(() => { lastSent = signature(builtDesired()); lastContrast = desiredTheme().contrast; });
  if (installed) return;
  installed = true;
  effect(() => {
    // Everything a request is made of: a change to any of it schedules the (debounced) check.
    desiredTheme();
    editorPreview();
    customThemes();
    environmentThemes();
    untracked(schedule);
  });
}

/** Test hook: stop answering and forget what was sent. */
export function stopThemeSync() {
  clearTimers();
  config = null;
  inFlight = null;
  applying.set(false);
}
