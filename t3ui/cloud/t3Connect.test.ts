import { expect, test } from "nsh/test";
import { beginConnectSignIn, connectAuthState, resetConnectSessionForTest, signOutOfConnect } from "./connectSession";
import {
  connectRelayEnvironment, createDpopProof, refreshRelayDiscovery, relayDiscovery, resetRelayDiscovery, setRelayDiscoveryFetchForTest,
} from "./relayDiscovery";
import { cloudListEmptyState, connectCloudEnvironment, presentCloudEnvironmentRow, presentSavedCloudEnvironmentConnection } from "./CloudEnvironmentConnectList";
import { CONNECT_ONBOARDING_OPT_OUT_STORAGE_KEY, createOnboardingMachine, parseOptOutState, type OnboardingInputs } from "./ConnectOnboardingDialog";
import { resolveT3ConnectTurnOn } from "./t3ConnectState";
import { hasCloudPublicConfig } from "./publicConfig";
import { hasCloudPublicConfig as phoneGate } from "../components/onboarding/phoneOffer";
import { resolvePhoneConnect } from "../components/onboarding/PhoneSection";
import { gateReachability, grantableLevelDenials, mcpClientScopes } from "../components/mcp/UseInAnotherAppDialog";
import { resolveMcpGate } from "../components/mcp/mcpGate";

const b64 = (value: unknown) => btoa(JSON.stringify(value)).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
const fakeIdToken = `${b64({ alg: "none" })}.${b64({ sub: "user_1", email: "a@b.c" })}.x`;

async function signIn() {
  resetConnectSessionForTest();
  const request = await beginConnectSignIn((async () => ({ ok: true, status: 200, json: async () => ({ access_token: "oauth-tok", refresh_token: "r", expires_in: 3600, id_token: fakeIdToken }) })) as any);
  await request.finish("c");
}

const decode = (part: string) => JSON.parse(atob(part.replace(/-/gu, "+").replace(/_/gu, "/") + "=".repeat((4 - (part.length % 4)) % 4)));

test("the gates follow the reference: public config on, phone band reads the same function", () => {
  expect(hasCloudPublicConfig()).toBe(true);
  expect(phoneGate()).toBe(true);
  expect(resolveT3ConnectTurnOn({ desktopApp: true, linkableHere: true, cloudConfigured: true, canReadRelay: true, canWriteRelay: true, connectDenial: undefined })).toEqual({ kind: "here" });
  expect(resolveT3ConnectTurnOn({ desktopApp: true, linkableHere: false, cloudConfigured: true, canReadRelay: true, canWriteRelay: true, connectDenial: undefined })).toEqual({ kind: "on-host" });
  expect(resolveT3ConnectTurnOn({ desktopApp: true, linkableHere: true, cloudConfigured: true, canReadRelay: true, canWriteRelay: true, connectDenial: "Acme's policy does not allow T3 Connect." }))
    .toEqual({ kind: "policy", reason: "Acme's policy does not allow T3 Connect." });
});

test("sign-in keeps the Clerk user id from the id token", async () => {
  await signIn();
  const state = connectAuthState();
  expect(state.status).toBe("signed-in");
  expect(state.status === "signed-in" ? state.userId : null).toBe("user_1");
});

test("a DPoP proof is an ES256 JWT with the reference's claims and an ath bound to the token", async () => {
  setRelayDiscoveryFetchForTest(null);
  const proof = await createDpopProof({ method: "POST", url: "https://relay.t3.codes/v1/x", accessToken: "at" });
  const [header, payload, signature] = proof.split(".");
  expect(decode(header!).typ).toBe("dpop+jwt");
  expect(decode(header!).alg).toBe("ES256");
  expect(decode(header!).jwk.crv).toBe("P-256");
  expect(decode(payload!).htm).toBe("POST");
  expect(decode(payload!).htu).toBe("https://relay.t3.codes/v1/x");
  expect(typeof decode(payload!).ath).toBe("string");
  expect(signature!.length).toBe(86);
});

test("discovery lists the machines, exchanges for a DPoP token, then reads each status", async () => {
  await signIn();
  const calls: { url: string; headers: Record<string, string>; body?: string }[] = [];
  const env = (id: string) => ({ environmentId: id, label: id.toUpperCase(), endpoint: { httpBaseUrl: `https://${id}.t3.codes`, wsBaseUrl: `wss://${id}.t3.codes`, providerKind: "cloudflare_tunnel" }, linkedAt: "x" });
  setRelayDiscoveryFetchForTest(async (url, init) => {
    calls.push({ url, headers: init.headers, body: init.body });
    if (url.endsWith("/v1/client/dpop-token")) return { ok: true, status: 200, json: async () => ({ access_token: "dpop-at", issued_token_type: "urn:ietf:params:oauth:token-type:access_token", token_type: "DPoP", expires_in: 300, scope: "environment:status environment:connect" }) };
    if (url.includes("/v1/environments/a/status")) return { ok: true, status: 200, json: async () => ({ environmentId: "a", endpoint: env("a").endpoint, status: "online", checkedAt: "t" }) };
    if (url.includes("/v1/environments/b/status")) return { ok: true, status: 200, json: async () => ({ environmentId: "b", endpoint: env("b").endpoint, status: "offline", checkedAt: "t", offlineReason: "tunnel_released" }) };
    return { ok: false, status: 401, json: async () => ({ _tag: "RelayUnauthorizedError" }) };
  }, async () => [env("a"), env("b"), env("c")]);
  await refreshRelayDiscovery();
  const exchange = calls.find((call) => call.url.endsWith("/v1/client/dpop-token"))!;
  const form = new URLSearchParams(exchange.body);
  expect(form.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:token-exchange");
  expect(form.get("subject_token_type")).toBe("urn:ietf:params:oauth:token-type:jwt");
  expect(form.get("client_id")).toBe("t3-web");
  expect(form.get("resource")).toBe("https://relay.t3.codes");
  expect(form.get("subject_token")).toBe("oauth-tok");
  expect(typeof exchange.headers.dpop).toBe("string");
  const status = calls.find((call) => call.url.endsWith("/v1/environments/a/status"))!;
  expect(status.headers.authorization).toBe("DPoP dpop-at");
  const state = relayDiscovery();
  expect(state.listed).toBe(true);
  expect(state.environments.get("a")!.availability).toBe("online");
  expect(state.environments.get("b")!.availability).toBe("offline");
  expect(state.environments.get("c")!.availability).toBe("error");
  // The offline reason and a failed status read render as the reference does.
  expect(presentCloudEnvironmentRow({ discovered: state.environments.get("b")!, saved: undefined, savedWithoutRelay: false, connecting: false, anyConnecting: false }).statusText)
    .toBe("Offline for a while, so its T3 Connect tunnel was removed. Start T3 Code on that computer and update it to the latest version to reconnect.");
  expect(presentCloudEnvironmentRow({ discovered: state.environments.get("c")!, saved: undefined, savedWithoutRelay: false, connecting: false, anyConnecting: false }).statusTone).toBe("error");
  setRelayDiscoveryFetchForTest(null);
  resetRelayDiscovery();
});

test("relay DPoP credentials are invalidated across sign-out and account switch even while an exchange is pending", async () => {
  const idA = `${b64({ alg: "none" })}.${b64({ sub: "user_a", email: "a@b.c" })}.x`;
  const idB = `${b64({ alg: "none" })}.${b64({ sub: "user_b", email: "b@b.c" })}.x`;
  resetConnectSessionForTest();
  const reqA = await beginConnectSignIn((async () => ({ ok: true, status: 200, json: async () => ({ access_token: "oauth-a", refresh_token: "ra", expires_in: 3600, id_token: idA }) })) as any);
  await reqA.finish("ca");

  let markExchangeStarted!: () => void;
  const exchangeStarted = new Promise<void>((r) => { markExchangeStarted = r; });
  let releaseFirstExchange!: (v: any) => void;
  const firstExchange = new Promise<any>((r) => { releaseFirstExchange = r; });
  const dpopSubjects: string[] = [];
  const connectAuthHeaders: string[] = [];

  setRelayDiscoveryFetchForTest(async (url, init) => {
    if (url.endsWith("/v1/client/dpop-token")) {
      const subject = new URLSearchParams(init.body).get("subject_token") ?? "";
      dpopSubjects.push(subject);
      if (subject === "oauth-a") {
        markExchangeStarted();
        return firstExchange;
      }
      return { ok: true, status: 200, json: async () => ({ access_token: `dpop-${subject}`, expires_in: 300, scope: "environment:connect" }) };
    }
    connectAuthHeaders.push(init.headers.authorization ?? "");
    return { ok: true, status: 200, json: async () => ({ environmentId: "env1", endpoint: { httpBaseUrl: "https://env1.t3.codes", providerKind: "cloudflare_tunnel" }, credential: "cred", expiresAt: "x" }) };
  });

  const pendingA = connectRelayEnvironment("env1");
  await exchangeStarted;
  await signOutOfConnect();
  const reqB = await beginConnectSignIn((async () => ({ ok: true, status: 200, json: async () => ({ access_token: "oauth-b", refresh_token: "rb", expires_in: 3600, id_token: idB }) })) as any);
  await reqB.finish("cb");

  releaseFirstExchange({ ok: true, status: 200, json: async () => ({ access_token: "dpop-oauth-a", expires_in: 300, scope: "environment:connect" }) });
  await expect(pendingA).rejects.toThrow("T3 Connect session changed.");

  await connectRelayEnvironment("env1");
  expect(dpopSubjects).toEqual(["oauth-a", "oauth-b"]);
  expect(connectAuthHeaders).toEqual(["DPoP dpop-oauth-b"]);

  let markConnectStarted!: () => void;
  const connectStarted = new Promise<void>((r) => { markConnectStarted = r; });
  let releaseConnect!: (v: any) => void;
  const pendingConnectReply = new Promise<any>((r) => { releaseConnect = r; });
  setRelayDiscoveryFetchForTest(async (url) => {
    if (url.endsWith("/v1/client/dpop-token")) {
      return { ok: true, status: 200, json: async () => ({ access_token: "dpop-b2", expires_in: 300, scope: "environment:connect" }) };
    }
    markConnectStarted();
    return pendingConnectReply;
  });
  const pendingConnect = connectRelayEnvironment("env1");
  await connectStarted;
  await signOutOfConnect();
  releaseConnect({ ok: true, status: 200, json: async () => ({ environmentId: "env1", endpoint: { httpBaseUrl: "https://env1.t3.codes", providerKind: "cloudflare_tunnel" }, credential: "stale-cred", expiresAt: "x" }) });
  await expect(pendingConnect).rejects.toThrow("T3 Connect session changed.");
  setRelayDiscoveryFetchForTest(null);
  resetRelayDiscovery();
  await signOutOfConnect();
});

test("signed out, discovery settles to an empty, unlisted list", async () => {
  await signOutOfConnect();
  setRelayDiscoveryFetchForTest(null);
  await refreshRelayDiscovery();
  expect(relayDiscovery().listed).toBe(false);
  expect(relayDiscovery().error).toBe(null);
  expect(relayDiscovery().environments.size).toBe(0);
});

test("row copy: Not added / Saved without T3 Connect / Client not supported, and the buttons", () => {
  const online = { availability: "online" as const, status: null, error: null };
  expect(presentCloudEnvironmentRow({ discovered: online, saved: undefined, savedWithoutRelay: false, connecting: false, anyConnecting: false }))
    .toEqual({ statusText: "T3 Connect · Not added · Relay online", tooltip: "Relay online", dot: "success", ping: false, statusTone: "muted", button: { label: "Add", kind: "add", disabled: false } });
  const routed = presentCloudEnvironmentRow({ discovered: { availability: "offline", status: null, error: null }, saved: undefined, savedWithoutRelay: true, connecting: false, anyConnecting: false });
  expect(routed.statusText).toBe("T3 Connect · Saved without T3 Connect · Relay offline");
  expect(routed.button.label).toBe("Add route");
  expect(presentCloudEnvironmentRow({ discovered: { availability: "checking", status: null, error: null }, saved: undefined, savedWithoutRelay: false, connecting: true, anyConnecting: true }).button)
    .toEqual({ label: "Adding…", kind: "add", disabled: true });
  const unsupported = presentCloudEnvironmentRow({ discovered: online, saved: undefined, savedWithoutRelay: false, connecting: false, anyConnecting: false, compatibilityError: "Update T3 Code" });
  expect(unsupported.statusText).toBe("T3 Connect · Not added · Client not supported");
  expect(unsupported.button).toEqual({ label: "Add", kind: "unsupported", disabled: true });
  const saved = presentCloudEnvironmentRow({ discovered: online, saved: { environmentId: "a", relayManaged: true, connection: { phase: "error", error: "boom" } }, savedWithoutRelay: false, connecting: false, anyConnecting: false });
  expect(saved.button).toEqual({ label: "Connection failed", kind: "saved", disabled: true });
  expect(saved.statusText).toBe("Connection failed. Reason: boom");
  expect(presentSavedCloudEnvironmentConnection({ phase: "available", error: null }).buttonLabel).toBe("Not connected");
  expect(cloudListEmptyState({ refreshWhileEmpty: false, refreshing: true, listedCount: 0, offline: false, error: null })).toBe("skeleton");
  expect(cloudListEmptyState({ refreshWhileEmpty: false, refreshing: false, listedCount: 0, offline: true, error: null })).toEqual({ problem: "You appear to be offline." });
  expect(cloudListEmptyState({ refreshWhileEmpty: false, refreshing: false, listedCount: 0, offline: false, error: "x" })).toEqual({ problem: "x" });
});

test("Add: a relay failure ends in the failure toast; a relay connect saves the T3 Connect route", async () => {
  await signIn();
  setRelayDiscoveryFetchForTest(async (url) => url.endsWith("/v1/client/dpop-token")
    ? { ok: false, status: 400, json: async () => ({ _tag: "RelayInternalError", reason: "bad subject", traceId: "trace-1" }) }
    : { ok: false, status: 500, json: async () => null });
  await expect(connectRelayEnvironment("a")).rejects.toThrow("Relay encountered an internal error (bad subject).");
  expect(await connectCloudEnvironment({ environmentId: "a", label: "A" }, false)).toBe(false);
  const saved: unknown[] = [];
  // No endpoint in the answer: nothing to save.
  expect(await connectCloudEnvironment({ environmentId: "a", label: "A" }, false, { connect: async () => ({}), save: (input) => saved.push(input) })).toBe(false);
  expect(await connectCloudEnvironment({ environmentId: "a", label: "A" }, false, {
    connect: async () => ({ environmentId: "a", endpoint: { httpBaseUrl: "https://a.relay.example", providerKind: "cloudflare" }, credential: "c", expiresAt: "x" }),
    save: (input) => saved.push(input),
  })).toBe(true);
  expect(saved).toEqual([{ relayEnvironmentId: "a", label: "A", url: "wss://a.relay.example" }]);
  setRelayDiscoveryFetchForTest(null);
});

test("onboarding opens only on a fresh sign-in, with Publish when the relay can be managed, and keeps the opt-out", () => {
  expect(CONNECT_ONBOARDING_OPT_OUT_STORAGE_KEY).toBe("t3code:connect-onboarding-opt-out:v1");
  expect(parseOptOutState(JSON.stringify({ optOutAccounts: ["u"] }))).toEqual({ optOutAccounts: ["u"] });
  expect(parseOptOutState("bad")).toEqual({ optOutAccounts: [] });
  const base: OnboardingInputs = { auth: { isLoaded: true, isSignedIn: true, userId: "u1" }, optOutAccounts: [], canManageRelay: true, hasTarget: true, sessionScopesKnown: true };
  // Already signed in at load: never opens.
  const atLoad = createOnboardingMachine();
  atLoad.observe(base, null);
  atLoad.observe(base, null);
  expect(atLoad.openForAccount()).toBe(null);
  // Signed out, then signed in: opens on Publish.
  const fresh = createOnboardingMachine();
  fresh.observe({ ...base, auth: { isLoaded: true, isSignedIn: false, userId: null } }, null);
  fresh.observe(base, null);
  fresh.observe(base, null);
  expect(fresh.openForAccount()).toBe("u1");
  expect(fresh.step()).toBe("publish");
  // Prefill from a link this account owns.
  fresh.observe(base, { linked: true, cloudUserId: "u1", managedTunnelActive: false, publishAgentActivity: false });
  expect(fresh.exposeEnvironment()).toBe(false);
  expect(fresh.publishAgentActivity()).toBe(false);
  fresh.dontShowAgain.set(true);
  expect(fresh.complete([])).toEqual(["u1"]);
  expect(fresh.openForAccount()).toBe(null);
  // Opted out: stays closed. Without relay permissions: devices only.
  const opted = createOnboardingMachine();
  opted.observe({ ...base, auth: { isLoaded: true, isSignedIn: false, userId: null } }, null);
  opted.observe({ ...base, optOutAccounts: ["u1"] }, null);
  expect(opted.openForAccount()).toBe(null);
  const viewer = createOnboardingMachine();
  viewer.observe({ ...base, auth: { isLoaded: true, isSignedIn: false, userId: null }, canManageRelay: false }, null);
  viewer.observe({ ...base, canManageRelay: false }, null);
  expect(viewer.openForAccount()).toBe("u1");
  expect(viewer.step()).toBe("devices");
  // A signed-in snapshot without userId does not count as a sign-in.
  const partial = createOnboardingMachine();
  partial.observe({ ...base, auth: { isLoaded: true, isSignedIn: false, userId: null } }, null);
  partial.observe({ ...base, auth: { isLoaded: true, isSignedIn: true, userId: null } }, null);
  expect(partial.openForAccount()).toBe(null);
});

test("phone band states follow PhoneConnectLink", () => {
  const link = { linked: true, cloudUserId: "u", managedTunnelActive: true };
  expect(resolvePhoneConnect({ auth: "signed-out", userId: null, link: null, linkError: null, linkPending: false })).toEqual({ kind: "signed-out", loaded: true });
  expect(resolvePhoneConnect({ auth: "loading", userId: null, link: null, linkError: null, linkPending: false })).toEqual({ kind: "signed-out", loaded: false });
  expect(resolvePhoneConnect({ auth: "signed-in", userId: "u", link: null, linkError: null, linkPending: true })).toEqual({ kind: "checking" });
  expect(resolvePhoneConnect({ auth: "signed-in", userId: "u", link: null, linkError: "x", linkPending: false })).toEqual({ kind: "check-failed" });
  expect(resolvePhoneConnect({ auth: "signed-in", userId: "u", link: { ...link, reachability: { status: "reachable" } }, linkError: null, linkPending: false })).toEqual({ kind: "reachable" });
  expect(resolvePhoneConnect({ auth: "signed-in", userId: "u", link, linkError: null, linkPending: false })).toEqual({ kind: "on" });
  expect(resolvePhoneConnect({ auth: "signed-in", userId: "u", link: { ...link, reachability: { status: "unreachable" } }, linkError: null, linkPending: false })).toEqual({ kind: "signed-in", shared: true });
  expect(resolvePhoneConnect({ auth: "signed-in", userId: "other", link, linkError: null, linkPending: false })).toEqual({ kind: "signed-in", shared: false });
});

test("MCP wizard: grantable levels, reachability merge and the gate opening on this machine's tunnel", () => {
  expect(mcpClientScopes("full-access")).toEqual(["orchestration:read", "orchestration:operate", "settings:write", "source-control:write"]);
  const denials = grantableLevelDenials({ label: "Studio", canMint: true, sessionScopes: ["orchestration:read", "orchestration:operate"], policy: null });
  expect(denials.get("full-access")).toBe("This device cannot grant this on Studio.");
  expect(denials.has("auto")).toBe(false);
  expect(grantableLevelDenials({ label: "Studio", canMint: false, sessionScopes: [], policy: null }).get("read-only")).toBe("This device needs the Manage access permission on Studio.");
  const reachable = { status: "reachable" as const, checkedAt: "2", readyConnections: 1, protocol: "http2" };
  expect(gateReachability("running", undefined)).toBe("checking");
  expect(gateReachability({ result: null, since: "1" }, reachable)).toBe(reachable);
  const gate = resolveMcpGate({ signedIn: true, connected: true, approvalCodes: true, canReadRelay: true, linkState: { linked: true, managedTunnelActive: true, tunnelHostname: "abc.t3coderelay.com" }, linkStateError: null, thisMachine: true, relay: { status: "loading" }, reachability: reachable });
  expect(gate).toEqual({ kind: "open", mcpUrl: "https://abc.t3coderelay.com/mcp" });
  expect(resolveMcpGate({ signedIn: false, connected: true, approvalCodes: true, canReadRelay: true, linkState: null, linkStateError: null, thisMachine: true, relay: { status: "loading" }, reachability: null }).kind).toBe("sign-in");
});
