// The desktop functions the reference's Electron main process serves (dock badge, window bounds, minimum size, native
// notifications, open-url / open-file / second-instance links), asked of the GPUI host by name (third_party/nsh-host
// patch 0010: `desktop.capabilities`, `dock.setBadge`, `window.frame`, `window.setMinSize`, `window.setOrigin`, `notifications.post`; events
// `app.openUrls`, `app.reopen`, `window.frameChanged`, `notifications.clicked`). A host without the patch rejects
// `desktop.capabilities`: every function here then does nothing and resolves false, and the app keeps its fallbacks.
import { host } from "nsh";
import { focusMainWindow } from "./windowControl";
import process from "process";

export interface ScreenArea { x: number; y: number; width: number; height: number }
export interface WindowFrameInfo extends ScreenArea { maximized: boolean; fullScreen: boolean; screens: ScreenArea[] }

let capabilities: Promise<ReadonlySet<string>> | null = null;

/** The 0010 calls this host carries (asked once). */
export function desktopHostCapabilities(): Promise<ReadonlySet<string>> {
  if (capabilities) return capabilities;
  capabilities = (async () => {
    try {
      if (!host.available()) return new Set<string>();
      const names = await host.call("desktop.capabilities", null, { timeout: 5000 });
      return new Set(Array.isArray(names) ? names.filter((n): n is string => typeof n === "string") : []);
    } catch {
      return new Set<string>();
    }
  })();
  return capabilities;
}

/** Tests only: forget the cached answer. */
export function resetDesktopHostCapabilities() { capabilities = null; }

async function callIf(name: string, data: unknown): Promise<unknown | undefined> {
  if (!(await desktopHostCapabilities()).has(name)) return undefined;
  try { return await host.call(name, data, { timeout: 5000 }); } catch { return undefined; }
}

/** `app.setBadgeCount` (ipc/methods/notificationBadge.ts): a count of 0 clears the badge. */
export async function setDockBadge(count: number): Promise<boolean> {
  const label = count > 0 ? String(Math.floor(count)) : null;
  if (!(await desktopHostCapabilities()).has("dock.setBadge")) return false;
  try { await host.call("dock.setBadge", label, { timeout: 5000 }); return true; } catch { return false; }
}

export async function readWindowFrame(): Promise<WindowFrameInfo | null> {
  const value = await callIf("window.frame", null);
  return isFrame(value) ? value : null;
}

export async function setWindowMinSize(width: number, height: number): Promise<boolean> {
  if (!(await desktopHostCapabilities()).has("window.setMinSize")) return false;
  try { await host.call("window.setMinSize", { width, height }, { timeout: 5000 }); return true; } catch { return false; }
}

/** Moves the window's top left corner (points, primary screen's top left, y down). */
export async function setWindowOrigin(x: number, y: number): Promise<boolean> {
  if (!(await desktopHostCapabilities()).has("window.setOrigin")) return false;
  try { await host.call("window.setOrigin", { x, y }, { timeout: 5000 }); return true; } catch { return false; }
}

/** A native notification whose click comes back as `notifications.clicked` with `id`; false when the host has none. */
export async function postNativeNotification(input: { id: string; title: string; body?: string; sound?: boolean }): Promise<boolean> {
  if (!(await desktopHostCapabilities()).has("notifications.post")) return false;
  try { await host.call("notifications.post", input, { timeout: 5000 }); return true; } catch { return false; }
}

/** Listens to a host event; nothing on a platform without a host. */
export function onDesktopHostEvent<T>(name: string, listener: (data: T) => void): () => void {
  try {
    if (!host.available()) return () => {};
    return host.on<T>(name, listener);
  } catch {
    return () => {};
  }
}

/** DesktopWindow.activate: brings the window forward. Test copies set T3GPUI_NO_ACTIVATE so they never take the
 *  owner's keyboard; they report the request instead. */
export function revealWindow(): boolean {
  if (process.env.T3GPUI_NO_ACTIVATE) {
    console.log("desktop: revealWindow (suppressed by T3GPUI_NO_ACTIVATE)");
    return false;
  }
  focusMainWindow();
  return true;
}

export function isFrame(value: unknown): value is WindowFrameInfo {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return ["x", "y", "width", "height"].every((k) => typeof v[k] === "number" && Number.isFinite(v[k] as number))
    && Array.isArray(v.screens);
}
