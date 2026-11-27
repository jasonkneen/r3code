// OS secure storage for secrets (the reference's ElectronSafeStorage: apps/desktop/src/electron/ElectronSafeStorage.ts and
// the encrypted-at-rest catalog of app/DesktopConnectionCatalogStore.ts). Electron's safeStorage encrypts with the macOS
// Keychain; this app has no such API, so the secret lives in the Keychain itself through the `security` CLI under a
// dedicated service name (process.execute grants /usr/bin/security in nsh.json).
//
// Argv tradeoff: `security add-generic-password -w <secret>` would put the secret on the process list. The command is fed
// to `security -i` on stdin instead, so a secret never appears in argv. Reads use `find-generic-password -w` (the secret
// comes back on stdout), deletes carry no secret. `security -i` reads one line of about 4 KiB at most, so a value is
// stored as base64 chunks of CHUNK_SIZE characters: the head item `<account>` holds `<count>:<nonce>:<chunk 0>` and chunk i
// lives in `<account>#<i>` as `<nonce>:<chunk>`. The head is written last, so a reader never sees a half-written value
// as complete. A missing chunk or nonce mismatch fails the read.
//
// Reference parity note (app/ClerkTokenStore.ts): that file guards a plaintext-on-disk token file written by
// electron-store (0700 directory, 0600 file, lstat-before-open symlink/regular-file checks) and migrates it from a
// legacy path (the app's userData root) to a private `clerk/` subdirectory. None of that applies here:
//   - Symlink / regular-file checks guard a file path this module never creates — every secret lives in Keychain items
//     reached only through `security`'s `-a`/`-s` flags, so there is no on-disk path for a symlink attack to target.
//   - The 0700/0600 permission tightening has no analogue: the Keychain enforces its own access control.
//   - Legacy-path migration: `git log --follow` on this file (single commit, `04d63f5`) shows `keychainServiceName`
//     has always included the per-`dataDir` hash suffix; there was never an earlier unhashed service name or account
//     scheme in this port to migrate from. If a future scheme change needs one, follow ClerkTokenStore's shape: read
//     the old account/service once, write it under the new one, then remove the old item.
import { host } from "nsh";
import process, { run, spawn } from "process";

export interface SecureStorage {
  /** safeStorage.isEncryptionAvailable. */
  isEncryptionAvailable(): Promise<boolean>;
  get(account: string): Promise<string | null>;
  set(account: string, value: string): Promise<void>;
  remove(account: string): Promise<void>;
}

/** The text of the reference's failed save (connection/storage.ts makeCatalogBackend write). */
export const SECURE_STORAGE_UNAVAILABLE_MESSAGE = "Desktop secure storage is unavailable in this system context.";

export interface SecurityCliResult { code: number | null; stdout: string; stderr: string }
/** The `security` CLI, as far as this storage needs it (a fake stands in for it in tests). */
export interface SecurityCli {
  available(): Promise<boolean>;
  run(args: string[]): Promise<SecurityCliResult>;
  /** Feeds one command line to `security -i` on stdin: the way a secret reaches the CLI without argv. */
  runInteractive(line: string): Promise<SecurityCliResult>;
}

const SECURITY = "/usr/bin/security";
const TIMEOUT_MS = 15_000;
/** Base64 characters per Keychain item: well under the interactive line limit with the command around it. */
export const CHUNK_SIZE = 1800;
const NOT_FOUND = 44;

export const realSecurityCli: SecurityCli = {
  async available() {
    if (process.platform !== "macos") return false;
    try { return (await run(SECURITY, ["default-keychain"], { timeoutMs: TIMEOUT_MS })).code === 0; } catch { return false; }
  },
  async run(args) {
    const result = await run(SECURITY, args, { timeoutMs: TIMEOUT_MS });
    return { code: result.code ?? null, stdout: result.stdout, stderr: result.stderr };
  },
  runInteractive(line) {
    return new Promise<SecurityCliResult>((resolve, reject) => {
      let stdout = "";
      let stderr = "";
      let settled = false;
      const child = spawn(SECURITY, ["-i"], { stdin: "pipe", timeoutMs: TIMEOUT_MS });
      child.on("stdout", (text) => { stdout += text; });
      child.on("stderr", (text) => { stderr += text; });
      child.on("exit", (result) => {
        if (settled) return;
        settled = true;
        if (result.error) reject(new Error(result.error));
        else resolve({ code: result.code ?? null, stdout, stderr });
        child.dispose();
      });
      try {
        child.write(`${line}\n`);
        child.end();
      } catch (error) {
        if (!settled) { settled = true; reject(error); }
      }
    });
  },
};

const encodeUtf8Base64 = (text: string) => {
  let binary = "";
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary);
};
const decodeUtf8Base64 = (encoded: string) => {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
};

/** A word safe inside a double-quoted `security -i` argument. */
function quoted(value: string): string {
  if (/["\\\r\n\0]/.test(value)) throw new Error("Keychain names cannot contain quotes, backslashes or line breaks.");
  return `"${value}"`;
}

const HEAD = /^(\d+):([a-z0-9]+):([A-Za-z0-9+/=]*)$/;
const TAIL = /^([a-z0-9]+):([A-Za-z0-9+/=]*)$/;

export function createKeychainStorage(options: { cli: SecurityCli; service: string }): SecureStorage {
  const { cli, service } = options;
  let available: Promise<boolean> | null = null;
  const tailAccount = (account: string, index: number) => `${account}#${index}`;

  const readItem = async (account: string): Promise<string | null> => {
    const result = await cli.run(["find-generic-password", "-a", account, "-s", service, "-w"]);
    if (result.code === 0) return result.stdout.replace(/\r?\n$/, "");
    if (result.code === NOT_FOUND) return null;
    throw new Error(`Keychain read failed (exit ${result.code}): ${result.stderr.trim()}`);
  };
  const writeItem = async (account: string, value: string) => {
    const result = await cli.runInteractive(`add-generic-password -U -a ${quoted(account)} -s ${quoted(service)} -w ${quoted(value)}`);
    // `security -i` exits 0 whatever a command did; a failing command prints "<command>: returned <n>" or "security: ...".
    const output = `${result.stdout}\n${result.stderr}`;
    if (/returned [1-9]|unknown command|^security: /m.test(output)) throw new Error(`Keychain write failed: ${output.trim().split("\n").pop() ?? ""}`.slice(0, 200));
  };
  const removeItem = async (account: string) => {
    const result = await cli.run(["delete-generic-password", "-a", account, "-s", service]);
    if (result.code !== 0 && result.code !== NOT_FOUND) throw new Error(`Keychain delete failed (exit ${result.code}): ${result.stderr.trim()}`);
  };
  const headCount = async (account: string): Promise<number> => {
    const head = await readItem(account);
    const match = head === null ? null : HEAD.exec(head);
    return match ? Number(match[1]) : 0;
  };

  return {
    isEncryptionAvailable() {
      available ??= cli.available().catch(() => false);
      return available;
    },
    async get(account) {
      const head = await readItem(account);
      if (head === null) return null;
      const match = HEAD.exec(head);
      // A head that is not ours reads as itself: the catalog's decode rejects it and the corrupt-catalog recovery runs.
      if (!match) return head;
      const count = Number(match[1]);
      const nonce = match[2]!;
      let encoded = match[3]!;
      for (let index = 1; index < count; index++) {
        const tail = await readItem(tailAccount(account, index));
        const parsed = tail === null ? null : TAIL.exec(tail);
        if (!parsed || parsed[1] !== nonce) throw new Error("Keychain item has incomplete data.");
        encoded += parsed[2]!;
      }
      return decodeUtf8Base64(encoded);
    },
    async set(account, value) {
      const encoded = encodeUtf8Base64(value);
      const chunks: string[] = [];
      for (let at = 0; at < encoded.length || chunks.length === 0; at += CHUNK_SIZE) chunks.push(encoded.slice(at, at + CHUNK_SIZE));
      const nonce = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
      const previous = await headCount(account);
      for (let index = 1; index < chunks.length; index++) await writeItem(tailAccount(account, index), `${nonce}:${chunks[index]}`);
      await writeItem(account, `${chunks.length}:${nonce}:${chunks[0]}`);
      for (let index = chunks.length; index < previous; index++) await removeItem(tailAccount(account, index));
    },
    async remove(account) {
      const count = await headCount(account);
      for (let index = 1; index < count; index++) await removeItem(tailAccount(account, index));
      await removeItem(account);
    },
  };
}

const BASE_SERVICE = "T3 Code connection catalog";

function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) hash = Math.imul(hash ^ text.charCodeAt(index), 0x01000193) >>> 0;
  return hash.toString(16).padStart(8, "0");
}

/** The Keychain service of this app copy: a copy with its own data directory (a `--data-name` test copy) gets its own items. */
export function keychainServiceName(dataDir: string | null = process.dataDir): string {
  return dataDir ? `${BASE_SERVICE} (${fnv1a(dataDir)})` : BASE_SERVICE;
}

export interface HostSecureStorageOptions {
  service: string;
  available?: () => boolean;
  call?: (name: string, data: unknown, options?: { timeout?: number }) => Promise<unknown>;
}

export function createHostSecureStorage(options: HostSecureStorageOptions): SecureStorage {
  const { service } = options;
  const hostReady = options.available ?? (() => host.available());
  const invoke = options.call ?? ((name, data, callOptions) => host.call(name, data, callOptions));
  let available: Promise<boolean> | null = null;

  return {
    isEncryptionAvailable() {
      available ??= (async () => {
        if (!hostReady()) return false;
        try {
          return (await invoke("secureStorage.available", null, { timeout: 5000 })) === true;
        } catch {
          return false;
        }
      })();
      return available;
    },
    async get(account) {
      const value = await invoke("secureStorage.get", { service, account }, { timeout: TIMEOUT_MS });
      return typeof value === "string" ? value : null;
    },
    async set(account, value) {
      await invoke("secureStorage.set", { service, account, value }, { timeout: TIMEOUT_MS });
    },
    async remove(account) {
      await invoke("secureStorage.remove", { service, account }, { timeout: TIMEOUT_MS });
    },
  };
}

let shared: SecureStorage | null = null;
let override: SecureStorage | null = null;

export function secureStorage(): SecureStorage {
  if (override) return override;
  shared ??= process.platform === "macos"
    ? createKeychainStorage({ cli: realSecurityCli, service: keychainServiceName() })
    : createHostSecureStorage({ service: keychainServiceName() });
  return shared;
}

/** Tests only: a storage built on a fake keychain (backend/fakeKeychain.ts); null restores the real one. */
export function setSecureStorageForTest(storage: SecureStorage | null) {
  override = storage;
}
