// The native capabilities the reference's Electron main process provides (packages/contracts ipc.ts DesktopBridge), in one
// place. This app IS the desktop client: every bridge capability is served here through NSH's own runtime (`process`,
// `fs/promises`, `openUrl`, `Storage`). Tests swap the runtime with `configureDesktop`, so no test ever runs a real
// command (a real screencapture would capture the owner's screen or raise a macOS permission prompt).
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "fs/promises";
import { openUrl, platform, Storage } from "nsh";
import { homedir } from "os";
import process from "process";

export interface RunResult { code?: number | null; signal?: string | null; stdout: string; stderr: string }

/** The subset of `fetch`'s `Response` that updateCheck.ts needs (the GitHub releases API: the only network call
 * this build makes on its own — no updater, so nothing else reaches out unprompted). Kept this small so a test can
 * fake it with a plain object instead of a real `Response`. */
export interface DesktopFetchResponse { ok: boolean; status: number; json: () => Promise<unknown> }

/** A long-running child (the SnapShot modifier-pair shortcut's osascript poller): line-buffered output, no
 * deadline. Tests fake this, so no test ever starts a real osascript process. */
export interface DesktopChildProcess {
  /** Delivers complete lines (the stream's decoded UTF-8, split on newlines, no trailing newline). */
  onLine: (stream: "stdout" | "stderr", handler: (line: string) => void) => void;
  onExit: (handler: (result: { code: number | null; signal: string | null }) => void) => void;
  kill: () => void;
}

export interface DesktopRuntime {
  /** `process.run`: an absolute executable granted by nsh.json `capabilities.process.execute`. */
  run: (command: string, args: string[], options?: { timeoutMs?: number | null }) => Promise<RunResult>;
  /** `process.spawn`: a long-running child, line-buffered, no default deadline. */
  spawn: (command: string, args: string[]) => DesktopChildProcess;
  writeFile: (path: string, data: string | Uint8Array) => Promise<void>;
  /** Raw bytes, for formats this app parses itself (browser cookie databases: components/browser/*CookieImport.ts). */
  readFile: (path: string) => Promise<Uint8Array>;
  mkdir: (path: string) => Promise<void>;
  unlink: (path: string) => Promise<void>;
  /** The size of a file, `null` when it does not exist. */
  fileSize: (path: string) => Promise<number | null>;
  /** The entries of a directory, `[]` when it does not exist (desktop/legacyLocalStorage.ts). */
  readdir: (path: string) => Promise<string[]>;
  /** A file or directory's mtime in epoch ms, `null` when it does not exist. */
  mtime: (path: string) => Promise<number | null>;
  /** Renames (or moves) a file, for the pending SnapShot queue's write-then-rename metadata files. */
  rename: (from: string, to: string) => Promise<void>;
  openUrl: (url: string) => Promise<boolean>;
  /** GET-only; updateCheck.ts is the only caller. Never used to download or install anything. */
  fetch: (url: string) => Promise<DesktopFetchResponse>;
  getItem: (key: string) => Promise<string | null>;
  setItem: (key: string, value: string) => Promise<void>;
  /** "macos", "windows", "linux" ... (NSH's spelling). */
  os: () => string;
  /** The app's writable data directory. */
  dataDir: () => string | null;
  /** The user's home directory (`$HOME`; already in nsh.json `capabilities.process.env`), or `null` if unset. */
  homeDir: () => string | null;
  randomId: () => string;
  now: () => Date;
}

const realRuntime: DesktopRuntime = {
  run: (command, args, options) => process.run(command, args, { timeoutMs: options?.timeoutMs ?? null }),
  spawn: (command, args) => {
    const child = process.spawn(command, args, { lines: true });
    return {
      onLine: (stream, handler) => { child.on(stream, handler); },
      onExit: (handler) => { child.on("exit", (result) => handler({ code: result.code ?? null, signal: result.signal ?? null })); },
      kill: () => child.kill(),
    };
  },
  writeFile: (path, data) => writeFile(path, data),
  readFile: async (path) => new Uint8Array(await readFile(path)),
  mkdir: (path) => mkdir(path, { recursive: true }),
  unlink: (path) => unlink(path),
  fileSize: async (path) => {
    try { return (await stat(path)).size; } catch { return null; }
  },
  readdir: async (path) => {
    try { return await readdir(path); } catch { return []; }
  },
  mtime: async (path) => {
    try { return (await stat(path)).mtimeMs; } catch { return null; }
  },
  rename: (from, to) => rename(from, to),
  openUrl: async (url) => (await openUrl(url)).opened,
  fetch: async (url) => {
    const response = await fetch(url, { headers: { accept: "application/vnd.github+json" } });
    return { ok: response.ok, status: response.status, json: () => response.json() };
  },
  getItem: (key) => Storage.getItem(key),
  setItem: (key, value) => Storage.setItem(key, value),
  os: () => platform.os,
  dataDir: () => process.dataDir,
  homeDir: () => {
    try { return homedir(); }
    catch { return process.env.HOME ?? process.env.USERPROFILE ?? null; }
  },
  randomId: () => crypto.randomUUID(),
  now: () => new Date(),
};

let runtime: DesktopRuntime = realRuntime;

/** Tests replace parts of the runtime; the app never calls this. */
export function configureDesktop(next: Partial<DesktopRuntime>) {
  runtime = { ...runtime, ...next };
}

export const desktop = (): DesktopRuntime => runtime;

/** The folder the native helpers write to: `<dataDir>/snapshots` (granted in nsh.json `capabilities.fs.write`). */
export function snapshotsDir(): string | null {
  const dir = runtime.dataDir();
  return dir ? `${dir.replace(/\/+$/, "")}/snapshots` : null;
}

export const isMac = () => runtime.os() === "macos";
