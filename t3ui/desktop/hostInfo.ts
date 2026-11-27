// Static host identity for the Diagnostics "Host" panel: the macOS version/build the reference's Electron
// (`os.release()` + Electron/Chrome/V8 versions) shows, ported to this NSH host. NSH's own `os` module gives
// `platform()`/`arch()` (Rust's spellings: "macos"/"aarch64") but no OS release string, so that one field is
// sampled through `sw_vers` the same way hostTelemetry.ts samples `pmset`/`ioreg` — granted in nsh.json's
// `process.execute` allowlist, run through desktop/runtime.ts so tests never shell out for real.
import { platform } from "nsh";
import { arch } from "os";
import { desktop } from "./runtime";

export interface HostIdentity {
  /** "macos", "windows", "linux" (NSH/Rust's spelling, not Node's "darwin"). */
  os: string;
  /** "aarch64", "x86_64" (NSH/Rust's spelling, not Node's "arm64"/"x64"). */
  arch: string;
  /** `sw_vers -productVersion`, e.g. "15.1"; `null` off macOS or when the command failed. */
  macosVersion: string | null;
  /** `sw_vers -buildVersion`, e.g. "24B83"; `null` off macOS or when the command failed. */
  macosBuild: string | null;
}

/** `sw_vers -productVersion`'s bare output (one line, e.g. "15.1\n"). */
export function parseSwVersLine(output: string): string | null {
  const trimmed = output.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Runs `sw_vers -productVersion` / `-buildVersion` (macOS only; any failure, or a non-macOS host, degrades both
 * fields to `null` rather than failing the whole sample — same contract as hostTelemetry.ts's `sampleHostPower`). */
export async function sampleHostIdentity(): Promise<HostIdentity> {
  const runtime = desktop();
  const isMacos = runtime.os() === "macos";
  const [productVersion, buildVersion] = isMacos
    ? await Promise.all([
        runtime.run("/usr/bin/sw_vers", ["-productVersion"]).then((result) => result.stdout, () => ""),
        runtime.run("/usr/bin/sw_vers", ["-buildVersion"]).then((result) => result.stdout, () => ""),
      ])
    : ["", ""];
  return {
    os: runtime.os(),
    arch: arch(),
    macosVersion: parseSwVersLine(productVersion),
    macosBuild: parseSwVersLine(buildVersion),
  };
}

/** The static architecture facts the reference's host-info panel also shows as labels, not samples: this app has
 * no Electron/Chromium/V8, so there is no renderer-process version triad to port. GPUI draws the app's own UI
 * natively; WKWebView is used only inside the in-app browser previews (components/rightPanel/surfaces.tsx,
 * previewMore.tsx), never for the app's own chrome. */
export const GPUI_BACKEND_LABEL = platform.os === "windows" ? "Win32 + Direct2D (native)" : "GPUI (native)";
export const WEBVIEW_ENGINE_LABEL = platform.os === "windows" ? "WebView2 (Edge, previews & terminals)" : "WKWebView (WebKit, previews only)";
