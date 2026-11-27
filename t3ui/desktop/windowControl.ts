import { Window } from "nsh/desktop";

type LegacyWindowApi = {
  setTitle?: (title: string) => void;
  setTitleBar?: (options: { style: "default" | "hidden"; height?: number }) => void;
  setFrame?: (frame: { origin?: { x: number; y: number }; size?: { width: number; height: number } }) => void;
  toggleMaximize?: () => void;
  orderFront?: () => void;
  close?: () => void;
};

type DeclarativeWindowRef = {
  state?: () => { mode?: string } | null;
  set?: (attributes: Record<string, unknown>) => void;
  setBounds?: (bounds: { origin?: { x: number; y: number }; size?: { width: number; height: number } }) => void;
  setMode?: (mode: string) => void;
  focus?: () => void;
  close?: () => void;
};

type DeclarativeWindowApi = ((props: Record<string, unknown>) => unknown) & {
  get?: (id: string) => DeclarativeWindowRef | null;
};

export function isDeclarativeWindow(): boolean {
  return typeof (Window as unknown) === "function";
}

export function mainWindowRef(): DeclarativeWindowRef | null {
  const api = Window as unknown as DeclarativeWindowApi;
  return typeof api.get === "function" ? api.get("main") : null;
}

export function setMainWindowTitle(title: string): void {
  if (isDeclarativeWindow()) {
    mainWindowRef()?.set?.({ title });
    return;
  }
  (Window as unknown as LegacyWindowApi).setTitle?.(title);
}

export function setMainWindowTitleBar(options: { style: "default" | "hidden"; height?: number }): void {
  if (isDeclarativeWindow()) {
    mainWindowRef()?.set?.({ titleBar: options });
    return;
  }
  (Window as unknown as LegacyWindowApi).setTitleBar?.(options);
}

export function setMainWindowFrame(frame: { origin?: { x: number; y: number }; size?: { width: number; height: number } }): void {
  if (isDeclarativeWindow()) {
    mainWindowRef()?.setBounds?.(frame);
    return;
  }
  (Window as unknown as LegacyWindowApi).setFrame?.(frame);
}

export function toggleMainWindowMaximize(): void {
  if (isDeclarativeWindow()) {
    const win = mainWindowRef();
    if (!win?.setMode) return;
    const mode = win.state?.()?.mode;
    win.setMode(mode === "maximized" ? "normal" : "maximized");
    return;
  }
  (Window as unknown as LegacyWindowApi).toggleMaximize?.();
}

export function focusMainWindow(): void {
  if (isDeclarativeWindow()) {
    mainWindowRef()?.focus?.();
    return;
  }
  (Window as unknown as LegacyWindowApi).orderFront?.();
}

export function closeMainWindow(): void {
  if (isDeclarativeWindow()) {
    mainWindowRef()?.close?.();
    return;
  }
  (Window as unknown as LegacyWindowApi).close?.();
}
