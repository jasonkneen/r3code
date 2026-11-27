// DesktopSshEnvironment / SshEnvironmentManager (packages/ssh/src/tunnel.ts ensureEnvironment): an environment reached
// over SSH. Launch or reuse the T3 server on the host (the reference's remote launch script, run as `sh -l -s` with the
// script on stdin), forward a local port to it with an ssh tunnel, wait for it to answer, then issue a pairing
// credential on the host (`t3 auth pairing create`). Key and agent login run in batch mode; a host that wants a
// password is retried without batch mode through the askpass prompts (desktop/sshPasswordPrompts.ts).
//
// The port keeps one fixed local port per saved SSH environment, so its address and saved session stay the same across
// launches; a reconnect re-runs the launch (which reuses a running server) and re-opens the tunnel on that port.
import { readFile } from "fs/promises";
import { homedir } from "os";
import { join } from "path";
import process from "process";
import { askpassAvailable } from "../desktop/sshPasswordPrompts";
import {
  baseSshArgs, hostSpec, needsInteractiveAuth, parseSshHosts, SSH_COMMAND, SSH_KEY_ONLY_MESSAGE, startSshTunnel, stopSshTunnel,
  waitForForwardedServer, withSshPrompts, type DiscoveredSshHost, type ProcessRunner, type SshTarget,
} from "./ssh";
import { buildRemoteLaunchScript, buildRemotePairingScript, buildRemoteStopScript, type RemoteT3RunnerOptions } from "./sshRemoteScripts";

const REMOTE_LAUNCH_TIMEOUT_MS = 90_000;
const REMOTE_ARCHIVE_LAUNCH_TIMEOUT_MS = 900_000;

/** A child whose stdin can be written (process.spawn with stdin "pipe"). */
export interface ScriptRunner extends ProcessRunner {
  spawn(command: string, args: string[], options?: { lines?: boolean; stdin?: "pipe" | "null" }): ReturnType<ProcessRunner["spawn"]> & { write?(text: string): void; end?(): void };
}

/** targetConnectionKey (packages/ssh/src/command.ts). */
export const targetConnectionKey = (target: SshTarget) => `${target.alias}\u0000${target.hostname}\u0000${target.username ?? ""}\u0000${target.port ?? ""}`;

/** remoteStateKey: the first 16 hex digits of the key's SHA-256, the directory under ~/.t3/ssh-launch on the host. */
export async function remoteStateKey(target: SshTarget): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(targetConnectionKey(target)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, 16);
}

/** getLastNonEmptyOutputLine + the lenient JSON decode: the last line of output that holds a JSON object. */
export function lastJsonLine(stdout: string): Record<string, unknown> | null {
  const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index]!;
    const start = line.indexOf("{");
    const end = line.lastIndexOf("}");
    if (start < 0 || end <= start) continue;
    try { const value = JSON.parse(line.slice(start, end + 1)); if (value && typeof value === "object") return value as Record<string, unknown>; } catch { /* not JSON */ }
  }
  return null;
}

/** The last few lines of remote output, for an error a person can act on. */
const outputTail = (stdout: string) => stdout.trim().split(/\r?\n/).slice(-5).join(" | ").slice(-600)

/** runSshCommand with the script on stdin; key/agent first, then, when the host asks for a password, the prompts. */
export async function runSshScript(runner: ScriptRunner, target: SshTarget, remoteArgs: string[], script: string, timeoutMs: number): Promise<string> {
  const attempt = (interactive: boolean) => new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = runner.spawn(SSH_COMMAND, [...baseSshArgs(target, interactive), "-T", "--", hostSpec(target), ...remoteArgs], { stdin: "pipe" });
    let stdout = ""; let stderr = ""; let done = false;
    const timer = setTimeout(() => { if (!done) { done = true; child.kill(); resolve({ code: null, stdout, stderr: `${stderr}\nSSH command timed out.` }); } }, timeoutMs);
    child.on("stdout", (text) => { stdout += text; });
    child.on("stderr", (text) => { stderr = `${stderr}${text}`.slice(-16384); });
    child.on("exit", (result) => { if (done) return; done = true; clearTimeout(timer); resolve({ code: result.code ?? null, stdout, stderr }); });
    child.write?.(script);
    child.end?.();
  });
  let result = await attempt(false);
  if (result.code !== 0 && needsInteractiveAuth(result.stderr)) {
    if (!askpassAvailable()) throw new Error(SSH_KEY_ONLY_MESSAGE);
    result = await withSshPrompts(target, () => attempt(true));
  }
  if (result.code !== 0) throw new Error(result.stderr.trim() || "SSH command failed.");
  return result.stdout;
}

export interface SshEnvironmentBootstrap { httpBaseUrl: string; wsBaseUrl: string; pairingToken: string | null; remotePort: number }

export interface SshEnvironmentDeps {
  runner: ScriptRunner;
  cliRunner: RemoteT3RunnerOptions;
  /** waitForHttpReady over the tunnel. */
  waitReady?: (localPort: number) => Promise<void>;
}

/** launchOrReuseRemoteServer: the remote port the host's T3 server listens on. */
export async function launchOrReuseRemoteServer(target: SshTarget, deps: SshEnvironmentDeps): Promise<{ remotePort: number; serverKind: string | null }> {
  const stateKey = await remoteStateKey(target);
  const stdout = await runSshScript(deps.runner, target, ["sh", "-l", "-s", "--", stateKey], buildRemoteLaunchScript(deps.cliRunner), deps.cliRunner.nodeScriptPath ? REMOTE_LAUNCH_TIMEOUT_MS : REMOTE_ARCHIVE_LAUNCH_TIMEOUT_MS);
  const parsed = lastJsonLine(stdout);
  if (!parsed) throw new Error(stdout.trim() ? `SSH launch returned unparseable output: ${outputTail(stdout)}` : "SSH launch did not return a remote port.");
  if (!Number.isInteger(parsed.remotePort)) throw new Error(`SSH launch returned an invalid remote port: ${String(parsed.remotePort)}.`);
  return { remotePort: parsed.remotePort as number, serverKind: typeof parsed.serverKind === "string" ? parsed.serverKind : null };
}

/** issueRemotePairingToken: `t3 auth pairing create` on the host. */
export async function issueRemotePairingToken(target: SshTarget, deps: SshEnvironmentDeps): Promise<string> {
  const stateKey = await remoteStateKey(target);
  const stdout = await runSshScript(deps.runner, target, ["sh", "-s"], buildRemotePairingScript(stateKey, deps.cliRunner), deps.cliRunner.nodeScriptPath ? 30_000 : REMOTE_ARCHIVE_LAUNCH_TIMEOUT_MS);
  const parsed = lastJsonLine(stdout);
  if (!parsed) throw new Error(stdout.trim() ? `SSH pairing returned unparseable output: ${outputTail(stdout)}` : "SSH pairing did not return a credential.");
  const credential = typeof parsed.credential === "string" ? parsed.credential.trim() : "";
  if (!credential) throw new Error("SSH pairing command returned an invalid credential.");
  return credential;
}

/** A free-looking local port for a new SSH environment; the tunnel's ExitOnForwardFailure catches a taken one. */
export const pickLocalTunnelPort = (random: () => number = Math.random) => 41000 + Math.floor(random() * 20000);

/** ensureEnvironment: launch or reuse, tunnel on `localPort`, wait for the server, and with `issuePairingToken` pair. */
export async function ensureSshEnvironment(target: SshTarget, localPort: number, deps: SshEnvironmentDeps, options: { issuePairingToken?: boolean } = {}): Promise<SshEnvironmentBootstrap> {
  const { remotePort } = await launchOrReuseRemoteServer(target, deps);
  await startSshTunnel(deps.runner, targetConnectionKey(target), target, localPort, remotePort);
  try { await (deps.waitReady ?? ((port: number) => waitForForwardedServer(port)))(localPort); }
  catch (error) { stopSshTunnel(targetConnectionKey(target)); throw error; }
  const pairingToken = options.issuePairingToken ? await issueRemotePairingToken(target, deps) : null;
  return { httpBaseUrl: `http://127.0.0.1:${localPort}/`, wsBaseUrl: `ws://127.0.0.1:${localPort}/`, pairingToken, remotePort };
}

/** disconnectEnvironment: close the tunnel and stop the host's managed server. */
export async function disconnectSshEnvironment(target: SshTarget, deps: SshEnvironmentDeps): Promise<void> {
  stopSshTunnel(targetConnectionKey(target));
  const stateKey = await remoteStateKey(target);
  await runSshScript(deps.runner, target, ["sh", "-s"], buildRemoteStopScript(stateKey), 30_000).catch(() => undefined);
}

/** discoverSshHosts: ~/.ssh/config aliases and known_hosts entries. */
export async function discoverSshHosts(read: (path: string) => Promise<string> = (path) => readFile(path, "utf8")): Promise<DiscoveredSshHost[]> {
  let home = "";
  try { home = homedir(); } catch { home = process.env.HOME ?? process.env.USERPROFILE ?? ""; }
  if (!home) return [];
  const [config, known] = await Promise.all([
    read(join(home, ".ssh", "config")).catch(() => ""),
    read(join(home, ".ssh", "known_hosts")).catch(() => ""),
  ]);
  return parseSshHosts(config, known);
}

/** resolveSshTarget for a typed destination: `user@host:port` or an alias from the discovered hosts. */
export function resolveTypedSshTarget(input: { host: string; username: string; port: string }, known: readonly DiscoveredSshHost[]): SshTarget {
  let host = input.host.trim();
  let username = input.username.trim() || null;
  let port = input.port.trim() ? Number(input.port.trim()) : null;
  const at = host.lastIndexOf("@");
  if (at > 0) { username ??= host.slice(0, at); host = host.slice(at + 1); }
  const colon = /^(.*):(\d+)$/.exec(host);
  if (colon && port === null) { host = colon[1]!; port = Number(colon[2]); }
  if (!host || /\s/.test(host) || host.startsWith("-")) throw new Error("Enter an SSH host, such as devbox or user@devbox.");
  if (port !== null && (!Number.isInteger(port) || port < 1 || port > 65535)) throw new Error("The SSH port must be between 1 and 65535.");
  const discovered = known.find((entry) => entry.alias === host);
  return { alias: host, hostname: discovered?.hostname ?? host, username: username ?? discovered?.username ?? null, port: port ?? discovered?.port ?? null };
}

/** formatDesktopSshConnectionError (ConnectionsSettings.logic.ts:285): the fallback and the error's message. */
export function formatDesktopSshConnectionError(error: unknown): string {
  const fallback = "Failed to connect SSH host.";
  const rawMessage = error instanceof Error ? error.message : fallback;
  return rawMessage.replace(/^Ssh[A-Za-z]+Error:\s*/u, "").trim() || fallback;
}
