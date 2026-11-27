import { expect, test } from "nsh/test";
import { createFakeKeychain } from "./backend/fakeKeychain";
import { CHUNK_SIZE, createHostSecureStorage, keychainServiceName } from "./backend/secureStorage";

test("a secret round-trips through the Keychain and never reaches argv", async () => {
  const keychain = createFakeKeychain();
  await keychain.storage.set("acct", "s3cret-ünï");
  expect(await keychain.storage.get("acct")).toBe("s3cret-ünï");
  expect(keychain.stdinLog.length).toBe(1);
  expect(keychain.stdinLog[0]!.startsWith('add-generic-password -U -a "acct" -s "test-service" -w "')).toBe(true);
  // The secret only ever went down stdin: no argv holds the value or its base64.
  const encoded = btoa(unescape(encodeURIComponent("s3cret-ünï")));
  expect(keychain.argvLog.flat().some((word) => word.includes("s3cret") || word.includes(encoded))).toBe(false);
  expect(await keychain.storage.get("missing")).toBe(null);
});

test("a value past the interactive line limit is chunked and read back whole", async () => {
  const keychain = createFakeKeychain();
  const big = JSON.stringify({ values: Array.from({ length: 900 }, (_, index) => `token-${index}-${"x".repeat(20)}`) });
  await keychain.storage.set("catalog", big);
  expect(keychain.stdinLog.length).toBeGreaterThan(2);
  expect(keychain.stdinLog.every((line) => line.length < 4096)).toBe(true);
  expect(await keychain.storage.get("catalog")).toBe(big);
  // Overwriting with a short value drops the stale chunks.
  await keychain.storage.set("catalog", "small");
  expect([...keychain.items.keys()].filter((name) => name.includes("catalog")).length).toBe(1);
  expect(await keychain.storage.get("catalog")).toBe("small");
  await keychain.storage.set("catalog", "y".repeat(CHUNK_SIZE * 2));
  await keychain.storage.remove("catalog");
  expect(keychain.items.size).toBe(0);
  expect(await keychain.storage.get("catalog")).toBe(null);
});

test("a mixed-up chunk rejects the read and preserves the stored chunks", async () => {
  const keychain = createFakeKeychain();
  await keychain.storage.set("catalog", "z".repeat(CHUNK_SIZE * 2));
  const tail = [...keychain.items.keys()].find((name) => name.endsWith("catalog#1"))!;
  keychain.items.set(tail, "othernonce:AAAA");
  const before = [...keychain.items];
  let message = "";
  await keychain.storage.get("catalog").catch((error: Error) => { message = error.message; });
  expect(message).toBe("Keychain item has incomplete data.");
  expect([...keychain.items]).toEqual(before);
});

test("a failing write throws, unavailable is reported, and the service name follows the data directory", async () => {
  const keychain = createFakeKeychain();
  keychain.failNextWrite = true;
  let message = "";
  await keychain.storage.set("acct", "v").catch((error: Error) => { message = error.message; });
  expect(message.startsWith("Keychain write failed")).toBe(true);
  expect(await keychain.storage.isEncryptionAvailable()).toBe(true);
  const off = createFakeKeychain();
  off.unavailable = true;
  expect(await off.storage.isEncryptionAvailable()).toBe(false);
  expect(keychainServiceName(null)).toBe("T3 Code connection catalog");
  expect(keychainServiceName("/a/b") === keychainServiceName("/a/c")).toBe(false);
  expect(keychainServiceName("/a/b")).toBe(keychainServiceName("/a/b"));
});

test("createHostSecureStorage stores, reads, and removes values through host.call", async () => {
  const store = new Map<string, string>();
  const calls: string[] = [];
  const storage = createHostSecureStorage({
    service: "T3 Code connection catalog (abcd1234)",
    available: () => true,
    call: async (name, data) => {
      calls.push(name);
      const payload = (data ?? {}) as { service?: string; account?: string; value?: string };
      const key = `${payload.service}\0${payload.account}`;
      if (name === "secureStorage.available") return true;
      if (name === "secureStorage.get") return store.get(key) ?? null;
      if (name === "secureStorage.set") {
        store.set(key, String(payload.value ?? ""));
        return null;
      }
      if (name === "secureStorage.remove") {
        store.delete(key);
        return null;
      }
      throw new Error(`unexpected call: ${name}`);
    },
  });

  expect(await storage.isEncryptionAvailable()).toBe(true);
  expect(await storage.get("connection-catalog")).toBeNull();
  await storage.set("connection-catalog", '{"schemaVersion":1,"credentials":[]}');
  expect(await storage.get("connection-catalog")).toBe('{"schemaVersion":1,"credentials":[]}');
  await storage.remove("connection-catalog");
  expect(await storage.get("connection-catalog")).toBeNull();
  expect(calls.filter((name) => name === "secureStorage.available").length).toBe(1);
});

test("createHostSecureStorage reports unavailable when host bridge is absent or rejects", async () => {
  const noHost = createHostSecureStorage({
    service: "svc",
    available: () => false,
    call: async () => true,
  });
  expect(await noHost.isEncryptionAvailable()).toBe(false);

  const failingHost = createHostSecureStorage({
    service: "svc",
    available: () => true,
    call: async () => { throw new Error("unsupported"); },
  });
  expect(await failingHost.isEncryptionAvailable()).toBe(false);
});
