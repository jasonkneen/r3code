// LocalApi dialogs.pickFolder (Electron showOpenDialog in the reference). NSH's Picker picks images only, so on macOS the
// system folder dialog comes from `osascript` (StandardAdditions `choose folder`, which needs no Automation permission).
import { host } from "nsh";
import { desktop, isMac } from "./runtime";

export const OSASCRIPT = "/usr/bin/osascript";

/** AppleScript string literal. */
const quote = (text: string) => `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

export function pickFolderArgs(initialPath?: string): string[] {
  const from = initialPath ? ` default location (POSIX file ${quote(initialPath)})` : "";
  return ["-e", `POSIX path of (choose folder${from})`];
}

export const canPickFolder = () => isMac() || host.available();

/** The chosen folder's path (no trailing slash), `null` when the user cancels (error -128). */
export async function pickFolder(options: { initialPath?: string } = {}): Promise<string | null> {
  if (!isMac()) {
    if (!host.available()) throw new Error("The folder dialog is not available.");
    const picked = await host.call("dialogs.pickFolder", options.initialPath ? { initialPath: options.initialPath } : {}, { timeout: 0 });
    return typeof picked === "string" && picked.length > 0 ? picked : null;
  }
  const output = await desktop().run(OSASCRIPT, pickFolderArgs(options.initialPath), { timeoutMs: null });
  if (output.code !== 0) {
    if (/-128/.test(output.stderr)) return null;
    throw new Error(output.stderr.trim() || "The folder dialog is not available.");
  }
  const path = output.stdout.trim().replace(/\/+$/, "");
  return path.length > 0 ? path : "/";
}

export function pickImageFileArgs(initialPath?: string): string[] {
  const from = initialPath ? ` default location (POSIX file ${quote(initialPath)})` : "";
  return ["-e", `POSIX path of (choose file of type {"public.image"}${from})`];
}

/** The chosen image file's path, `null` when the user cancels (the project favicon picker's "Open in Finder"). */
export async function pickImageFile(options: { initialPath?: string } = {}): Promise<string | null> {
  if (!isMac()) {
    if (!host.available()) throw new Error("The file dialog is not available.");
    const picked = await host.call("dialogs.pickFiles", {
      imagesOnly: true,
      multiple: false,
      ...(options.initialPath ? { initialPath: options.initialPath } : {}),
    }, { timeout: 0 });
    return Array.isArray(picked) && typeof picked[0] === "string" && picked[0].length > 0 ? picked[0] : null;
  }
  const output = await desktop().run(OSASCRIPT, pickImageFileArgs(options.initialPath), { timeoutMs: null });
  if (output.code !== 0) {
    if (/-128/.test(output.stderr)) return null;
    throw new Error(output.stderr.trim() || "The file dialog is not available.");
  }
  const path = output.stdout.trim();
  return path.length > 0 ? path : null;
}

/** `choose file with multiple selections allowed`, one POSIX path per line (the composer's "Attach files", an `<input type="file" multiple>` in the reference). */
export function pickFilesArgs(options: { imagesOnly?: boolean } = {}): string[] {
  const ofType = options.imagesOnly ? ` of type {"public.image"}` : "";
  return [
    "-e", "set out to \"\"",
    "-e", `repeat with picked in (choose file${ofType} with multiple selections allowed)`,
    "-e", "set out to out & POSIX path of picked & linefeed",
    "-e", "end repeat",
    "-e", "return out",
  ];
}

/** The chosen files' paths, `[]` when the user cancels (error -128). */
export async function pickFiles(options: { imagesOnly?: boolean } = {}): Promise<string[]> {
  if (!isMac()) {
    if (!host.available()) throw new Error("The file dialog is not available.");
    const picked = await host.call("dialogs.pickFiles", { imagesOnly: options.imagesOnly === true, multiple: true }, { timeout: 0 });
    return Array.isArray(picked) ? picked.filter((entry): entry is string => typeof entry === "string" && entry.length > 0) : [];
  }
  const output = await desktop().run(OSASCRIPT, pickFilesArgs(options), { timeoutMs: null });
  if (output.code !== 0) {
    if (/-128/.test(output.stderr)) return [];
    throw new Error(output.stderr.trim() || "The file dialog is not available.");
  }
  return output.stdout.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
}
