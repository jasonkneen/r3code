import { expect, open, test } from "nsh/test";
import {
  decodeThirdPartyLicenseManifest, filterThirdPartyLicenseEntries, formatLicenseBundles, licenseCountLabel, licenseManifestUrl, loadLicenseManifest,
} from "./licensesLogic";

const entry = (overrides: Record<string, unknown> = {}) => ({ bundles: ["web"], kind: "package", license: "MIT", name: "react", noticeText: "text", sourceUrl: null, version: "1.0.0", ...overrides });

test("the manifest decodes strictly: format, shape and duplicates fail with the web's messages", () => {
  expect(decodeThirdPartyLicenseManifest({ schemaVersion: 1, entries: [entry()] }).entries.length).toBe(1);
  expect(() => decodeThirdPartyLicenseManifest({ schemaVersion: 2, entries: [] })).toThrow("The open-source license manifest has an unsupported format.");
  expect(() => decodeThirdPartyLicenseManifest({ schemaVersion: 1, entries: [entry({ bundles: [] })] })).toThrow("License entry 1 has an invalid shape.");
  expect(() => decodeThirdPartyLicenseManifest({ schemaVersion: 1, entries: [entry({ sourceUrl: "ftp://x" })] })).toThrow("License entry 1 has an invalid shape.");
  expect(() => decodeThirdPartyLicenseManifest({ schemaVersion: 1, entries: [entry(), entry()] })).toThrow("contains a duplicate entry");
});

test("a query narrows by every word over name, version, license and bundles", () => {
  const entries = decodeThirdPartyLicenseManifest({ schemaVersion: 1, entries: [entry(), entry({ name: "effect", license: "Apache-2.0", bundles: ["server"], version: "4.0.0" })] }).entries;
  expect(filterThirdPartyLicenseEntries(entries, "").length).toBe(2);
  expect(filterThirdPartyLicenseEntries(entries, "apache server").map((e) => e.name)).toEqual(["effect"]);
  expect(filterThirdPartyLicenseEntries(entries, "react 4.0").length).toBe(0);
  expect(formatLicenseBundles(["ios", "device-tools", "other"])).toBe("iOS, Device tools, other");
  expect(licenseCountLabel(3, 3)).toBe("3 notices");
  expect(licenseCountLabel(1, 3)).toBe("1 of 3");
});

test("the manifest is read from the server's HTTP origin and fails like the web's loader", async () => {
  expect(licenseManifestUrl("ws://127.0.0.1:52689/?token=abc")).toBe("http://127.0.0.1:52689/third-party-licenses.json");
  expect(licenseManifestUrl("wss://host.example/")).toBe("https://host.example/third-party-licenses.json");
  expect(licenseManifestUrl("not a url")).toBeNull();
  const ok = (async () => ({ status: 200, json: async () => ({ schemaVersion: 1, entries: [] }) })) as unknown as typeof fetch;
  expect((await loadLicenseManifest("http://x/third-party-licenses.json", 1000, ok)).entries.length).toBe(0);
  const missing = (async () => ({ status: 404, json: async () => ({}) })) as unknown as typeof fetch;
  await expect(loadLicenseManifest("http://x", 1000, missing)).rejects.toThrow("The license manifest request failed with status 404.");
  const hang = ((_url: string, init: { signal: AbortSignal }) => new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted"))))) as unknown as typeof fetch;
  await expect(loadLicenseManifest("http://x", 20, hang)).rejects.toThrow("The license manifest took too long to load.");
});

test("the page shows the failure, retries, then lists searchable expandable notices", async () => {
  const app = await open("./OpenSourceLicensesFixture.tsx", { width: 1100, height: 900 });
  await app.waitFor("text:Open-source notices are unavailable");
  await expect(app.texts()).toContain("R3 Code");
  await expect(app.texts()).toContain("T3 Code");
  await app.press("label:R3 Code original code license notice");
  expect(app.texts().some((text) => text.includes("GNU AFFERO GENERAL PUBLIC LICENSE"))).toBe(true);
  await app.press("label:R3 Code original code license notice");
  await app.press("label:T3 Code license notice");
  expect(app.texts().some((text) => text.startsWith("MIT License\n\nCopyright (c) 2026 T3 Tools Inc."))).toBe(true);
  await app.press("label:NSH license notice");
  expect(app.texts().some((text) => text.startsWith("Copyright 2026 Longbridge"))).toBe(true);
  await app.press("label:NSH license notice");
  await app.press("label:GPUI Fast license notice");
  expect(app.texts().some((text) => text.startsWith("Copyright 2022 - 2025 Zed Industries, Inc."))).toBe(true);
  await app.press("label:GPUI Fast license notice");
  await app.press("label:CPython license notice");
  expect(app.texts().some((text) => text.includes("PYTHON SOFTWARE FOUNDATION LICENSE VERSION 2"))).toBe(true);
  await app.press("label:CPython license notice");
  await app.press("label:View 620 native dependencies");
  await app.type("label:Search native dependencies", "adler2");
  await app.waitFor("text:1 of 620");
  await app.press("label:adler2 license notice");
  expect(app.texts().some((text) => text.includes("Copyright (C) Jonas Schievink"))).toBe(true);
  await app.press("label:Hide native dependencies");
  await expect(app.texts()).toContain("The license manifest request failed with status 404.");
  await app.press("label:Server recovers");
  await app.press("label:Try again");
  await app.waitFor("text:3 notices");
  for (const text of ["Third-party notices", "react", "19.0.0", "MIT · Web, Desktop", "effect", "Apache-2.0 · Server", "Notification Sound 1", "CC0-1.0 · Assets"]) await expect(app.texts()).toContain(text);
  await expect(app.texts()).not.toContain("Public domain dedication");
  await app.press("label:Notification Sound 1 license notice");
  await app.waitFor("text:Public domain dedication");
  await app.press("label:effect license notice");
  await expect(app.texts()).not.toContain("Public domain dedication");
  await expect(app.texts()).toContain("Apache License text for effect");
  await app.press("label:Search open-source licenses");
  await app.type("label:Search open-source licenses", "apache");
  await app.waitFor("text:1 of 3");
  await expect(app.texts()).not.toContain("Notification Sound 1");
  await app.type("label:Search open-source licenses", "zzzz");
  await app.waitFor("text:No licenses match that search.");
});

test("external native notices handle malformed rows with error and recover on retry", async () => {
  const app = await open("./OpenSourceLicensesFixture.tsx", { width: 1100, height: 900 });
  await app.waitFor("text:Open-source notices are unavailable");
  await app.press("label:Enable external native loader");
  await app.press("label:View 620 native dependencies");
  await app.waitFor("text:Native dependency notices contain an invalid text reference.");
  await app.press("label:Retry native dependencies");
  await app.waitFor("text:sample-crate");
  await app.press("label:sample-crate license notice");
  await app.waitFor("text:Copyright Example");
  expect(app.texts().some((text) => text.includes("Copyright Example"))).toBe(true);
});
