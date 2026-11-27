// SSH environments (packages/ssh/src: command.ts baseSshArgs, config.ts discoverSshHosts, tunnel.ts startSshTunnel).
// The NSH Process API runs /usr/bin/ssh (capabilities.process.execute) with SSH_AUTH_SOCK passed through
// (capabilities.process.env). Key and agent login run in batch mode; a host that refuses them for a password or
// keyboard-interactive login is tried again without batch mode when the launcher set up the askpass helper
// (desktop/sshPasswordPrompts.ts), and its prompts go to the SSH verification dialog. Without the helper such hosts
// get SSH_KEY_ONLY_MESSAGE. Nothing here logs or stores a credential.
import process from "process";
import { askpassAvailable, sshPasswordPrompts, watchSshPrompts } from "../desktop/sshPasswordPrompts";

export function defaultSshCommand(os: string = process.platform): string {
  return os === "windows" ? "ssh.exe" : "/usr/bin/ssh";
}

export const SSH_COMMAND = defaultSshCommand();
export const SSH_KEY_ONLY_MESSAGE = "This host asks for a password. This build supports SSH key or agent login only: add a key to ssh-agent or ~/.ssh/config and try again.";

export interface SshTarget { alias: string; hostname: string; username: string | null; port: number | null }
export interface DiscoveredSshHost extends SshTarget { source: "ssh-config" | "known-hosts" }

/** The process seam: `run` and `spawn` of the "process" module; tests pass a fake. */
export interface ProcessRunner {
  run(command: string, args: string[], options?: { timeoutMs?: number }): Promise<{ code?: number | null; stdout: string; stderr: string }>;
  spawn(command: string, args: string[], options?: { lines?: boolean; stdin?: "pipe" | "null" }): {
    on(event: "stdout" | "stderr", handler: (text: string) => void): unknown;
    on(event: "exit", handler: (result: { code?: number | null; signal?: string | null }) => void): unknown;
    kill(): void;
  };
}

/** Host aliases from ~/.ssh/config (no wildcard patterns) and hosts from known_hosts, as the reference lists them. */
export function parseSshHosts(config: string, knownHosts: string): DiscoveredSshHost[] {
  const hosts = new Map<string, DiscoveredSshHost>();
  let current: string[] = [];
  for (const raw of config.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(\S+)\s*=?\s*(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1]!.toLowerCase();
    const value = match[2]!.trim();
    if (key === "host") {
      current = value.split(/\s+/).filter((alias) => alias && !/[*?!]/.test(alias));
      for (const alias of current) if (!hosts.has(alias)) hosts.set(alias, { alias, hostname: alias, username: null, port: null, source: "ssh-config" });
    } else if (key === "hostname") {
      for (const alias of current) { const host = hosts.get(alias); if (host) host.hostname = value; }
    }
  }
  const configured = new Set([...hosts.values()].map((host) => host.hostname.toLowerCase()));
  for (const raw of knownHosts.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith("|") || line.startsWith("@")) continue;
    for (const entry of (line.split(/\s+/)[0] ?? "").split(",")) {
      const bracket = /^\[([^\]]+)\]:(\d+)$/.exec(entry);
      const hostname = bracket ? bracket[1]! : entry;
      if (!hostname || /[*?]/.test(hostname) || configured.has(hostname.toLowerCase()) || hosts.has(hostname)) continue;
      hosts.set(hostname, { alias: hostname, hostname, username: null, port: bracket ? Number(bracket[2]) : null, source: "known-hosts" });
    }
  }
  return [...hosts.values()];
}

/** baseSshArgs: batch mode unless the attempt may ask (askpass), as the reference's interactive auth does. */
export function baseSshArgs(target: SshTarget, interactive = false): string[] {
  return [...(interactive ? [] : ["-o", "BatchMode=yes"]), "-o", "ConnectTimeout=10", ...(target.port !== null ? ["-p", String(target.port)] : [])];
}
/** Hosts that answered only to a password or code this session: their tunnels ask too. */
const interactiveHosts = new Set<string>();
export const isInteractiveHost = (target: SshTarget) => interactiveHosts.has(hostSpec(target));

/** Runs `attempt` with the prompt queue watching, as one connection attempt for `target`. */
export async function withSshPrompts<T>(target: SshTarget, attempt: () => Promise<T>): Promise<T> {
  const prompts = sshPasswordPrompts();
  prompts?.begin(target.alias, target.username);
  watchSshPrompts(true);
  try { return await attempt(); } finally { watchSshPrompts(false); prompts?.end(); }
}
export const hostSpec = (target: SshTarget) => (target.username ? `${target.username}@${target.alias}` : target.alias);

/** A refusal that a password or keyboard-interactive login would have answered. */
export function needsInteractiveAuth(stderr: string): boolean {
  const methods = /Permission denied \(([^)]*)\)/i.exec(stderr)?.[1] ?? "";
  return /\b(?:password|keyboard-interactive)\b/i.test(methods);
}

/** Runs `true` on the host with key or agent login; throws the reference's message, or SSH_KEY_ONLY_MESSAGE. */
export async function testSshConnection(runner: ProcessRunner, target: SshTarget): Promise<void> {
  const result = await runner.run(SSH_COMMAND, [...baseSshArgs(target), "--", hostSpec(target), "true"], { timeoutMs: 20000 });
  if (result.code === 0) return;
  if (!needsInteractiveAuth(result.stderr)) throw new Error(result.stderr.trim() || "SSH connection failed.");
  if (!askpassAvailable()) throw new Error(SSH_KEY_ONLY_MESSAGE);
  // The prompt waits up to three minutes for the user (SSH_PASSWORD_PROMPT_TIMEOUT_MS).
  const asked = await withSshPrompts(target, () => runner.run(SSH_COMMAND, [...baseSshArgs(target, true), "--", hostSpec(target), "true"], { timeoutMs: 200_000 }));
  if (asked.code === 0) { interactiveHosts.add(hostSpec(target)); return; }
  sshPasswordPrompts()?.forget(target.alias);
  throw new Error(asked.stderr.trim() || "SSH connection failed.");
}

interface Tunnel { kill: () => void }
const tunnels = new Map<string, Tunnel>();
export const activeSshTunnels = () => [...tunnels.keys()];

/** startSshTunnel's ssh -N -L with the reference's options; resolves once ssh is up, and is torn down by stopSshTunnel. */
export function startSshTunnel(runner: ProcessRunner, key: string, target: SshTarget, localPort: number, remotePort: number): Promise<void> {
  stopSshTunnel(key);
  const interactive = isInteractiveHost(target) && askpassAvailable();
  const args = [
    ...baseSshArgs(target, interactive),
    "-o", "ExitOnForwardFailure=yes", "-o", "ControlMaster=no", "-o", "ControlPath=none", "-o", "ControlPersist=no",
    "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3",
    "-n", "-N", "-L", `${localPort}:127.0.0.1:${remotePort}`, "--", hostSpec(target),
  ];
  if (interactive) { sshPasswordPrompts()?.begin(target.alias, target.username); watchSshPrompts(true); }
  const child = runner.spawn(SSH_COMMAND, args, { lines: true, stdin: "null" });
  let stderr = "";
  const tunnel: Tunnel = { kill: () => child.kill() };
  tunnels.set(key, tunnel);
  return new Promise((resolve, reject) => {
    let settled = false;
    child.on("stderr", (line) => { stderr = `${stderr}${line}\n`.slice(-16384); });
    child.on("exit", () => {
      if (tunnels.get(key) === tunnel) tunnels.delete(key);
      if (!settled) { settled = true; reject(new Error(needsInteractiveAuth(stderr) ? SSH_KEY_ONLY_MESSAGE : stderr.trim() || "SSH tunnel exited.")); }
    });
    // ssh -N prints nothing on success: a tunnel still up after the connect timeout's first second is taken as established;
    // the caller then checks the forwarded server (waitForHttpReady) before using it.
    setTimeout(() => { if (!settled) { settled = true; resolve(); } }, 1000);
    if (interactive) setTimeout(() => { watchSshPrompts(false); sshPasswordPrompts()?.end(); }, 200_000);
  });
}

export function stopSshTunnel(key: string) {
  const tunnel = tunnels.get(key);
  if (!tunnel) return;
  tunnels.delete(key);
  tunnel.kill();
}

/** On disconnect of every SSH environment and on app quit: no ssh child outlives the app. */
export function stopAllSshTunnels() {
  for (const key of [...tunnels.keys()]) stopSshTunnel(key);
}

/** waitForHttpReady (shared/httpReadiness): the forwarded server answers /api/auth/session within the deadline. */
export async function waitForForwardedServer(localPort: number, timeoutMs = 20000, fetcher: typeof fetch = fetch): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetcher(`http://127.0.0.1:${localPort}/api/auth/session`);
      if (response.status < 500) return;
    } catch { /* not up yet */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`The SSH tunnel to 127.0.0.1:${localPort} did not answer in time.`);
}
