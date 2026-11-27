// apps/web/src/desktopAppActivation.ts + components/desktop/DesktopAppActivationCoordinator.tsx, 1:1 in outcome
// (find or create the project for the path, open a thread in it, return projectId/threadId), wired onto the
// file-drop listener in appActivation.ts rather than the reference's IPC channel. Started once, from
// installCoordinators.ts, alongside webLinks and windowBounds.
import { exists, mkdir, readdir, readFile, rename, unlink, writeFile } from "fs/promises";
import { homedir } from "os";
import process from "process";
import { activationDirectoryFor } from "./cliCommand";
import { revealWindow } from "./desktopHost";
import { activationFailure, activationSuccess, startActivationListener, type ActivationFs, type ActivationListener, type ActivationResponse } from "./appActivation";
import { allProjects, backendStatus, backendUrl, createProject, createThread, openThread } from "../store";

const fs: ActivationFs = {
  exists: (path) => exists(path),
  readText: (path) => readFile(path, "utf8"),
  writeText: (path, text) => writeFile(path, text),
  mkdirp: (path) => mkdir(path, { recursive: true }),
  rename: (from, to) => rename(from, to),
  unlink: (path) => unlink(path),
  list: async (dir) => {
    try { return await readdir(dir); } catch { return []; }
  },
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** DesktopAppActivationCoordinator's open-workspace: find the project at this path, create it if none exists yet,
 * open a thread in it. Matches the reference's error codes where this port has an equivalent failure. */
export async function openLocalWorkspace(workspaceRoot: string, requestId: string): Promise<ActivationResponse> {
  const endpoint = backendUrl();
  const connected = () => backendStatus() === "connected" && backendUrl() === endpoint;
  if (backendStatus() !== "connected") {
    return activationFailure(requestId, "environment-unavailable", "No environment is connected.");
  }
  let project = allProjects().find((p) => p.path === workspaceRoot);
  if (!project) {
    try {
      await createProject(workspaceRoot);
    } catch (error) {
      return activationFailure(requestId, "project-create-failed", error instanceof Error ? error.message : "R3 Code could not create a project for this path.");
    }
    // The project appears in the client store once the server round-trip lands (createThread's own wait, repeated).
    for (let i = 0; i < 40 && connected() && !(project = allProjects().find((p) => p.path === workspaceRoot)); i++) await sleep(250);
    if (!connected()) return activationFailure(requestId, "environment-unavailable", "The environment connection changed.");
    if (!project) return activationFailure(requestId, "project-create-failed", "The project did not appear.");
  }
  createThread(project.id);
  const threadId = openThread()?.id;
  if (!threadId) return activationFailure(requestId, "thread-open-failed", "R3 Code could not open a thread for this project.");
  return activationSuccess(requestId, project.id, threadId);
}

let listener: ActivationListener | null = null;

/** Starts polling `~/.t3codegpui/activation` once, idempotently. No-op where `process.env.HOME` is unavailable. */
export function installAppActivationListener(): void {
  if (listener) return;
  let home: string | null = null;
  try { home = homedir(); } catch { home = process.env.HOME ?? process.env.USERPROFILE ?? null; }
  if (!home) return;
  listener = startActivationListener({
    dir: activationDirectoryFor(home),
    fs,
    isReady: () => backendStatus() === "connected",
    activate: () => { revealWindow(); },
    handle: ({ workspaceRoot, requestId }) => openLocalWorkspace(workspaceRoot, requestId),
  });
}
