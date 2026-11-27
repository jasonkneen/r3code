// relayEnvironmentDiscovery (packages/client-runtime/src/relay/discovery.ts) and the DPoP half of the managed relay client
// (relay/managedRelay.ts exchangeAccessToken / authorize, apps/web/src/cloud/dpop.ts): the account's environments from
// T3 Connect, each with its relay health, and the relay "connect" call the Add button makes.
//
// The list (GET /v1/environments) runs with the T3 Connect bearer (relayClient.ts). Status and connect are DPoP routes: the
// client exchanges a Clerk `t3-relay` session JWT (or falls back to the OAuth bearer when the host cannot capture a Clerk
// client cookie, as on macOS) at POST /v1/client/dpop-token (`urn:ietf:params:oauth:token-type:jwt`) for a DPoP-bound
// access token, then signs a proof per request.
import { signal } from "nsh";
import { clearCachedRelaySessionJwt, connectBearer, connectRelaySessionJwt, connectSessionEpoch, hasClerkRelaySession, supportsClerkRelayCookieCapture } from "./connectSession";
import { resolveCloudPublicConfig } from "./publicConfig";
import { listRelayEnvironments, relayProtectedErrorMessage, RELAY_REQUEST_TIMEOUT_MS, type RelayEnvironmentRecord } from "./relayClient";

export const RELAY_DPOP_TOKEN_PATH = "/v1/client/dpop-token";
export const RELAY_WEB_CLIENT_ID = "t3-web";
export const RELAY_ENVIRONMENT_STATUS_SCOPE = "environment:status";
export const RELAY_ENVIRONMENT_CONNECT_SCOPE = "environment:connect";

export interface RelayEnvironmentStatus {
  environmentId: string;
  endpoint: { httpBaseUrl: string; wsBaseUrl?: string; providerKind: string };
  status: "online" | "offline";
  checkedAt: string;
  descriptor?: Record<string, unknown>;
  error?: string;
  offlineReason?: "tunnel_released";
  traceId?: string;
}
export type RelayAvailability = "checking" | "online" | "offline" | "error";
export interface RelayDiscoveredEnvironment { environment: RelayEnvironmentRecord; availability: RelayAvailability; status: RelayEnvironmentStatus | null; error: string | null }
export interface RelayDiscoveryState {
  environments: Map<string, RelayDiscoveredEnvironment>;
  refreshing: boolean;
  offline: boolean;
  error: string | null;
  /** True once a refresh has listed the account's machines. */
  listed: boolean;
}

export const EMPTY_RELAY_DISCOVERY: RelayDiscoveryState = { environments: new Map(), refreshing: false, offline: false, error: null, listed: false };
export const relayDiscovery = signal<RelayDiscoveryState>(EMPTY_RELAY_DISCOVERY);

export type RelayEnvironmentRegistration = "registered" | "unregistered" | "unknown";
/** relayEnvironmentRegistration (client-runtime relay/discovery.ts): on the account's list, off it once listed, or not known yet. */
export function relayEnvironmentRegistration(state: RelayDiscoveryState, environmentId: string): RelayEnvironmentRegistration {
  if (state.environments.has(environmentId)) return "registered";
  return state.listed ? "unregistered" : "unknown";
}

export class RelayDpopError extends Error {
  constructor(message: string, readonly status: number | null, readonly traceId: string | null) { super(message); }
}

type Fetcher = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
let fetcherForTest: Fetcher | null = null;
let listForTest: (() => Promise<RelayEnvironmentRecord[]>) | null = null;
export function setRelayDiscoveryFetchForTest(fetcher: Fetcher | null, list: (() => Promise<RelayEnvironmentRecord[]>) | null = null) {
  fetcherForTest = fetcher;
  listForTest = list;
  dpopKey = null;
  tokenCacheGeneration += 1;
  cachedTokens.clear();
  inFlightTokens.clear();
}

// ---- DPoP proof key (dpop.ts generateBrowserDpopKey): one P-256 key per process, never exported.

interface DpopKey { privateKey: unknown; publicJwk: { kty: string; crv: string; x: string; y: string }; thumbprint: string }
let dpopKey: Promise<DpopKey> | null = null;

const base64Url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
const base64UrlText = (text: string) => base64Url(new TextEncoder().encode(text));
// The runtime implements ECDSA P-256 and JWK export (probed headless); its typings declare a narrower surface.
const subtle = crypto.subtle as any;
const sha256 = async (text: string) => new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));

function proofKey(): Promise<DpopKey> {
  dpopKey ??= (async () => {
    const pair = (await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as { privateKey: unknown; publicKey: unknown };
    const jwk = (await subtle.exportKey("jwk", pair.publicKey)) as Record<string, string>;
    const publicJwk = { kty: jwk.kty!, crv: jwk.crv!, x: jwk.x!, y: jwk.y! };
    // RFC 7638: the thumbprint over the required members in lexicographic order.
    const thumbprint = base64Url(await sha256(JSON.stringify({ crv: publicJwk.crv, kty: publicJwk.kty, x: publicJwk.x, y: publicJwk.y })));
    return { privateKey: pair.privateKey, publicJwk, thumbprint };
  })();
  return dpopKey;
}

/** A DPoP proof JWT (RFC 9449) for one request; `ath` binds it to the access token when there is one. */
export async function createDpopProof(input: { method: string; url: string; accessToken?: string }): Promise<string> {
  const key = await proofKey();
  const header = { typ: "dpop+jwt", alg: "ES256", jwk: key.publicJwk };
  const payload = {
    jti: crypto.randomUUID(),
    htm: input.method,
    htu: input.url,
    iat: Math.floor(Date.now() / 1000),
    ...(input.accessToken ? { ath: base64Url(await sha256(input.accessToken)) } : {}),
  };
  const signingInput = `${base64UrlText(JSON.stringify(header))}.${base64UrlText(JSON.stringify(payload))}`;
  const signature = new Uint8Array(await subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key.privateKey, new TextEncoder().encode(signingInput)));
  return `${signingInput}.${base64Url(signature)}`;
}

export const dpopThumbprint = async () => (await proofKey()).thumbprint;

// ---- Requests

async function send(url: string, init: { method: string; headers: Record<string, string>; body?: string }, label: string) {
  const fetcher = fetcherForTest ?? (fetch as unknown as Fetcher);
  let response: Awaited<ReturnType<Fetcher>>;
  try {
    response = await Promise.race([
      fetcher(url, init),
      new Promise<never>((_, reject) => setTimeout(() => reject(new RelayDpopError(`${label} timed out.`, null, null)), RELAY_REQUEST_TIMEOUT_MS)),
    ]);
  } catch (error) {
    if (error instanceof RelayDpopError) throw error;
    throw new RelayDpopError(error instanceof Error ? error.message : String(error), null, null);
  }
  const json = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!response.ok) {
    const tagged = json && typeof json._tag === "string" ? json : null;
    const traceId = typeof tagged?.traceId === "string" ? tagged.traceId : null;
    // Never echo the request: it carries the subject token.
    const message = (tagged && relayProtectedErrorMessage(tagged)) ?? (response.status === 504
      ? "Relay timed out before it finished the request (HTTP 504). Try again in a few minutes. If it keeps failing, copy the trace ID when you report it."
      : `Relay returned an unexpected HTTP ${response.status}.`);
    throw new RelayDpopError(message, response.status, traceId);
  }
  return json ?? {};
}

let tokenCacheGeneration = 0;
const cachedTokens = new Map<string, { accessToken: string; expiresAt: number }>();
const inFlightTokens = new Map<string, Promise<string>>();

function tokenCacheKey(epoch: number, relayUrl: string, scope: string): string {
  return `${epoch}\u0000${relayUrl}\u0000${scope}`;
}

function pruneStaleTokenCaches(epoch: number): void {
  const prefix = `${epoch}\u0000`;
  for (const key of cachedTokens.keys()) if (!key.startsWith(prefix)) cachedTokens.delete(key);
  for (const key of inFlightTokens.keys()) if (!key.startsWith(prefix)) inFlightTokens.delete(key);
}

/** exchangeAccessToken: the token-exchange grant for a DPoP-bound access token with `scopes`. */
async function obtainAccessToken(relayUrl: string, scopes: readonly string[], epoch: number): Promise<string> {
  pruneStaleTokenCaches(epoch);
  const scope = [...scopes].sort().join(" ");
  const key = tokenCacheKey(epoch, relayUrl, scope);
  const cached = cachedTokens.get(key);
  if (cached && cached.expiresAt - 30_000 > Date.now()) return cached.accessToken;
  const pending = inFlightTokens.get(key);
  if (pending) return pending;
  const cacheGen = tokenCacheGeneration;
  const run = (async (): Promise<string> => {
    const subject = await connectRelaySessionJwt(fetcherForTest ?? undefined);
    if (connectSessionEpoch() !== epoch || tokenCacheGeneration !== cacheGen) {
      throw new RelayDpopError("T3 Connect session changed.", 401, null);
    }
    if (!subject) throw new RelayDpopError("Sign in to T3 Connect before enabling this.", 401, null);
    const url = `${relayUrl}${RELAY_DPOP_TOKEN_PATH}`;
    const body = new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token: subject,
      subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
      requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
      resource: relayUrl,
      scope,
      client_id: RELAY_WEB_CLIENT_ID,
    }).toString();
    const dpop = await createDpopProof({ method: "POST", url });
    if (connectSessionEpoch() !== epoch || tokenCacheGeneration !== cacheGen) {
      throw new RelayDpopError("T3 Connect session changed.", 401, null);
    }
    let json: Record<string, unknown>;
    try {
      json = await send(url, { method: "POST", headers: { dpop, "content-type": "application/x-www-form-urlencoded" }, body }, "Relay DPoP access token exchange");
    } catch (error) {
      if (error instanceof RelayDpopError && error.status === 401 && connectSessionEpoch() === epoch) {
        clearCachedRelaySessionJwt();
        if (supportsClerkRelayCookieCapture() && !hasClerkRelaySession() && !fetcherForTest) {
          throw new RelayDpopError("Sign out and sign in to T3 Connect again to enable cloud relay access.", error.status, error.traceId);
        }
      }
      throw error;
    }
    if (connectSessionEpoch() !== epoch || tokenCacheGeneration !== cacheGen) {
      throw new RelayDpopError("T3 Connect session changed.", 401, null);
    }
    const accessToken = typeof json.access_token === "string" ? json.access_token : null;
    const expiresIn = typeof json.expires_in === "number" ? json.expires_in : 0;
    if (!accessToken || expiresIn <= 0) throw new RelayDpopError("Relay returned an invalid DPoP access token.", null, null);
    const granted = typeof json.scope === "string" ? json.scope.split(/\s+/u).filter(Boolean).sort().join(" ") : "";
    if (granted !== scope) throw new RelayDpopError(`Relay granted unexpected scopes (${granted || "none"}).`, null, null);
    cachedTokens.set(key, { accessToken, expiresAt: Date.now() + expiresIn * 1000 });
    return accessToken;
  })();
  inFlightTokens.set(key, run);
  try {
    return await run;
  } finally {
    if (inFlightTokens.get(key) === run) inFlightTokens.delete(key);
  }
}

async function dpopRequest(path: string, scopes: readonly string[], label: string, body?: unknown): Promise<Record<string, unknown>> {
  const relayUrl = resolveCloudPublicConfig().relayUrl;
  if (!relayUrl) throw new RelayDpopError("T3CODE_RELAY_URL is not configured.", null, null);
  const url = `${relayUrl}${path}`;
  const scope = [...scopes].sort().join(" ");
  const epoch = connectSessionEpoch();
  const attempt = async (retry: boolean): Promise<Record<string, unknown>> => {
    const accessToken = await obtainAccessToken(relayUrl, scopes, epoch);
    const dpop = await createDpopProof({ method: "POST", url, accessToken });
    if (connectSessionEpoch() !== epoch) {
      throw new RelayDpopError("T3 Connect session changed.", 401, null);
    }
    try {
      const result = await send(url, {
        method: "POST",
        headers: { authorization: `DPoP ${accessToken}`, dpop, ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }, label);
      if (connectSessionEpoch() !== epoch) {
        throw new RelayDpopError("T3 Connect session changed.", 401, null);
      }
      return result;
    } catch (error) {
      // runDpopRequest: a rejected cached token is dropped and fetched once more.
      if (retry && error instanceof RelayDpopError && error.status === 401 && connectSessionEpoch() === epoch) {
        cachedTokens.delete(tokenCacheKey(epoch, relayUrl, scope));
        return attempt(false);
      }
      throw error;
    }
  };
  return attempt(true);
}

export async function getRelayEnvironmentStatus(environmentId: string): Promise<RelayEnvironmentStatus> {
  const json = await dpopRequest(`/v1/environments/${encodeURIComponent(environmentId)}/status`, [RELAY_ENVIRONMENT_STATUS_SCOPE, RELAY_ENVIRONMENT_CONNECT_SCOPE], "Relay environment status request");
  // validateStatus: the answer must be about the environment asked for.
  if (json.environmentId !== environmentId || (json.status !== "online" && json.status !== "offline")) {
    throw new RelayDpopError("Relay returned status for a different environment.", null, null);
  }
  return json as unknown as RelayEnvironmentStatus;
}

export interface RelayConnectResponse { environmentId: string; endpoint: { httpBaseUrl: string; wsBaseUrl?: string; providerKind: string }; credential: string; expiresAt: string }

/** connectEnvironment: the relay mints an environment credential bound to this client's proof key. */
export async function connectRelayEnvironment(environmentId: string): Promise<RelayConnectResponse> {
  const json = await dpopRequest(`/v1/environments/${encodeURIComponent(environmentId)}/connect`, [RELAY_ENVIRONMENT_CONNECT_SCOPE], "Relay environment connect request",
    { clientProofKeyThumbprint: await dpopThumbprint() });
  if (json.environmentId !== environmentId) throw new RelayDpopError("Relay returned credentials for a different environment.", null, null);
  return json as unknown as RelayConnectResponse;
}

// ---- Discovery

let generation = 0;

/** relayEnvironmentDiscovery.refresh: list the machines, then read each one's health. */
export async function refreshRelayDiscovery(): Promise<void> {
  const ticket = ++generation;
  relayDiscovery.set({ ...relayDiscovery(), environments: new Map(), listed: false, refreshing: true, offline: false, error: null });
  // Sign-out settles to an empty list; only relay-side failures surface.
  if (!listForTest && !(await connectBearer())) {
    if (ticket === generation) relayDiscovery.set({ ...relayDiscovery(), refreshing: false });
    return;
  }
  let list: RelayEnvironmentRecord[];
  try {
    list = await (listForTest ?? listRelayEnvironments)();
  } catch (error) {
    if (ticket !== generation) return;
    relayDiscovery.set({ ...relayDiscovery(), refreshing: false, error: error instanceof Error ? error.message : "Could not load T3 Connect environments." });
    return;
  }
  if (ticket !== generation) return;
  relayDiscovery.set({
    ...relayDiscovery(),
    refreshing: false,
    listed: true,
    environments: new Map(list.map((environment) => [environment.environmentId, { environment, availability: "checking" as const, status: null, error: null }])),
  });
  await Promise.all(list.map(async (environment) => {
    let next: Partial<RelayDiscoveredEnvironment>;
    try {
      const status = await getRelayEnvironmentStatus(environment.environmentId);
      next = { availability: status.status, status, error: null };
    } catch (error) {
      next = { availability: "error", error: error instanceof Error ? error.message : "Relay status unavailable" };
    }
    if (ticket !== generation) return;
    const current = relayDiscovery();
    const entry = current.environments.get(environment.environmentId);
    if (!entry) return;
    const environments = new Map(current.environments);
    environments.set(environment.environmentId, { ...entry, ...next });
    relayDiscovery.set({ ...current, environments });
  }));
}

export function resetRelayDiscovery() {
  generation++;
  tokenCacheGeneration += 1;
  cachedTokens.clear();
  inFlightTokens.clear();
  relayDiscovery.set(EMPTY_RELAY_DISCOVERY);
}
