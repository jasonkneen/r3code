// The T3 Connect account on this client: the OAuth token from the native sign-in (connectAuth.ts), kept across
// restarts the way sessionCredential.ts keeps environment bearers, refreshed before expiry (CliTokenManager's
// getExisting), and removed on sign-out. Tokens are never logged or shown.
import { host, platform, signal, Storage } from "nsh";
import { secureStorage } from "../backend/secureStorage";
import {
  buildConnectAuthorizeRequestUrl, CONNECT_LOOPBACK_PORT, connectLoopbackRedirectUri, DEFAULT_HOSTED_APP_URL, makePkceRequest,
  parsePersistedToken, readTokenResponse, tokenNeedsRefresh, type ConnectToken,
} from "./connectAuth";
import { clerkFrontendApiUrlFromPublishableKey, hasCloudPublicConfig, resolveCloudPublicConfig } from "./publicConfig";

const STORAGE_KEY = "t3connect:oauthToken";

/** connection/platform.ts CloudSession.clerkToken: the ConnectionBlockedError (authentication) detail of a T3 Connect route with no signed-in session. */
export const SIGN_IN_TO_CONNECT_ENVIRONMENT_DETAIL = "Sign in to T3 Connect to connect this environment.";

export type ConnectAuthState = { status: "loading" } | { status: "signed-out" } | { status: "signed-in"; identity: string | null; userId: string | null };
const state = signal<ConnectAuthState>({ status: "loading" });
export const connectAuthState = () => state();

let token: ConnectToken | null = null;
let loaded = false;
let loadPromise: Promise<void> | null = null;
let sessionEpoch = 0;
let signInAttemptSeq = 0;
let activeSignInAttempt = 0;
let cachedRelayJwt: { jwt: string; expiresAtMs: number; epoch: number } | null = null;
let inFlightRelayJwt: { epoch: number; promise: Promise<string | null> } | null = null;
let inFlightRefresh: { epoch: number; promise: Promise<string | null> } | null = null;
let persistQueue: Promise<void> = Promise.resolve();
let clerkClientTokenReaderForTest: (() => Promise<string | null>) | null = null;

export const connectSessionEpoch = (): number => sessionEpoch;
export const supportsClerkRelayCookieCapture = (): boolean => platform.os === "windows" && host.available();

export function cancelPendingConnectSignIn(): void {
  activeSignInAttempt = ++signInAttemptSeq;
}

const CLERK_JS_VERSION = "5.0.0";
const RELAY_JWT_REFRESH_EARLY_MS = 15_000;
const RELAY_JWT_FALLBACK_TTL_MS = 45_000;

export function setClerkClientTokenReaderForTest(reader: (() => Promise<string | null>) | null): void {
  clerkClientTokenReaderForTest = reader;
}

function decodeJwtClaims(jwt: string): Record<string, unknown> | null {
  const payload = jwt.split(".")[1];
  if (!payload) return null;
  try {
    const decoded = JSON.parse(atob(payload.replace(/-/gu, "+").replace(/_/gu, "/") + "=".repeat((4 - (payload.length % 4)) % 4)));
    return decoded && typeof decoded === "object" ? (decoded as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function jwtExpiryMs(jwt: string): number | null {
  const exp = decodeJwtClaims(jwt)?.exp;
  return typeof exp === "number" && Number.isFinite(exp) ? exp * 1000 : null;
}

function jwtSubject(jwt: string): string | null {
  const sub = decodeJwtClaims(jwt)?.sub;
  return typeof sub === "string" && sub.length > 0 ? sub : null;
}

async function readClerkClientTokenFromHost(frontendApi: string): Promise<string | null> {
  if (clerkClientTokenReaderForTest) {
    try { return await clerkClientTokenReaderForTest(); } catch { return null; }
  }
  try {
    if (platform.os !== "windows" || !host.available()) return null;
    const value = await host.call("r3.readClerkClientToken", { url: `${frontendApi}/` }, { timeout: 5000 });
    return typeof value === "string" && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

export const hasClerkRelaySession = (): boolean => Boolean(token?.clerkClientToken);

export async function loadConnectSession(): Promise<void> {
  if (loaded) return;
  if (loadPromise) return loadPromise;
  const startEpoch = sessionEpoch;
  const run = (async () => {
    // The token is a secret: it lives in the Keychain (backend/secureStorage.ts). One kept in plain Storage by an
    // earlier version moves there once and the plain copy goes.
    let raw: string | null = null;
    try { raw = await secureStorage().isEncryptionAvailable() ? await secureStorage().get(STORAGE_KEY) : null; } catch { raw = null; }
    if (startEpoch !== sessionEpoch || loaded) return;
    if (raw === null) {
      const legacy = await Storage.getItem(STORAGE_KEY).catch(() => null);
      if (startEpoch !== sessionEpoch || loaded) return;
      if (legacy && parsePersistedToken(legacy)) {
        const migrate = persistQueue.then(async () => {
          if (startEpoch !== sessionEpoch || loaded) return;
          try {
            if (await secureStorage().isEncryptionAvailable()) {
              if (startEpoch !== sessionEpoch || loaded) return;
              await secureStorage().set(STORAGE_KEY, legacy);
              await Storage.removeItem(STORAGE_KEY).catch(() => undefined);
              raw = legacy;
            }
          } catch {
            // Secure storage cannot take it: the plain copy stays where it is, unread.
          }
        });
        persistQueue = migrate.catch(() => undefined);
        await migrate;
      }
    }
    if (startEpoch !== sessionEpoch || loaded) return;
    token = parsePersistedToken(raw);
    loaded = true;
    state.set(token ? { status: "signed-in", identity: token.identity ?? null, userId: token.userId ?? null } : { status: "signed-out" });
  })();
  loadPromise = run;
  try {
    await run;
  } finally {
    if (loadPromise === run) loadPromise = null;
  }
}

async function persist(next: ConnectToken | null, expectedEpoch?: number): Promise<void> {
  if (expectedEpoch !== undefined && expectedEpoch !== sessionEpoch) return;
  if (!next) {
    sessionEpoch += 1;
    activeSignInAttempt = ++signInAttemptSeq;
    cachedRelayJwt = null;
    inFlightRelayJwt = null;
    inFlightRefresh = null;
  }
  const writeEpoch = sessionEpoch;
  token = next;
  // What was just signed in (or out) is the truth: a later load must not replace it with what secure storage could not keep.
  loaded = true;
  state.set(next ? { status: "signed-in", identity: next.identity ?? null, userId: next.userId ?? null } : { status: "signed-out" });
  const serialized = next ? JSON.stringify(next) : null;
  const op = persistQueue.then(async () => {
    if (writeEpoch !== sessionEpoch) return;
    // Held in memory for this run whatever secure storage does; a failed write only means the sign-in is not kept across restarts.
    try {
      if (serialized !== null) await secureStorage().set(STORAGE_KEY, serialized);
      else await secureStorage().remove(STORAGE_KEY);
    } catch (error) {
      console.warn("Could not keep the T3 Connect session in secure storage.", error instanceof Error ? error.message : String(error));
    }
    await Storage.removeItem(STORAGE_KEY).catch(() => undefined);
  });
  persistQueue = op.catch(() => undefined);
  await op;
}

function oauthConfig() {
  const config = resolveCloudPublicConfig();
  if (!hasCloudPublicConfig(config) || !config.clerkPublishableKey || !config.clerkCliOAuthClientId) return null;
  const frontendApi = clerkFrontendApiUrlFromPublishableKey(config.clerkPublishableKey);
  return { clientId: config.clerkCliOAuthClientId, tokenEndpoint: `${frontendApi}/oauth/token`, redirectUri: connectLoopbackRedirectUri(CONNECT_LOOPBACK_PORT) };
}

type FetchResponse = { ok: boolean; status: number; headers?: { get(name: string): string | null }; json(): Promise<unknown> };
type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<FetchResponse>;

async function exchange(params: Record<string, string>, previousRefreshToken = "", fetcher: Fetch = fetch as unknown as Fetch): Promise<ConnectToken> {
  const config = oauthConfig();
  if (!config) throw new Error("T3 Connect is not configured.");
  const response = await fetcher(config.tokenEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
  if (!response.ok) throw new Error(`T3 Connect sign-in failed (${response.status}).`);
  return readTokenResponse(await response.json(), Date.now(), previousRefreshToken);
}

/** A pending sign-in: the URL the dialog's WebView loads, and how to finish with the callback's code. */
export interface ConnectSignInRequest { url: string; state: string; finish(code: string): Promise<void> }

export async function beginConnectSignIn(fetcher?: Fetch): Promise<ConnectSignInRequest> {
  const config = oauthConfig();
  if (!config) throw new Error("T3 Connect is not configured.");
  const publicConfig = resolveCloudPublicConfig();
  const frontendApi = clerkFrontendApiUrlFromPublishableKey(publicConfig.clerkPublishableKey!);
  const attemptId = ++signInAttemptSeq;
  activeSignInAttempt = attemptId;
  const pkce = await makePkceRequest();
  return {
    url: buildConnectAuthorizeRequestUrl({ hostedAppUrl: DEFAULT_HOSTED_APP_URL, state: pkce.state, challenge: pkce.challenge, loopbackPort: CONNECT_LOOPBACK_PORT }),
    state: pkce.state,
    finish: async (code: string) => {
      if (attemptId !== activeSignInAttempt) return;
      const [next, clerkClientToken] = await Promise.all([
        exchange({ grant_type: "authorization_code", code, redirect_uri: config.redirectUri, client_id: config.clientId, code_verifier: pkce.verifier }, "", fetcher),
        readClerkClientTokenFromHost(frontendApi),
      ]);
      if (attemptId !== activeSignInAttempt) return;
      sessionEpoch += 1;
      cachedRelayJwt = null;
      inFlightRelayJwt = null;
      inFlightRefresh = null;
      await persist({ ...next, ...(clerkClientToken ? { clerkClientToken } : {}) }, sessionEpoch);
    },
  };
}

/** The bearer for relay client routes (verifyRelayClientBearerToken accepts Clerk OAuth tokens), refreshed when due. */
export async function connectBearer(fetcher?: Fetch): Promise<string | null> {
  await loadConnectSession();
  const snapshot = token;
  if (!snapshot) return null;
  if (!tokenNeedsRefresh(snapshot, Date.now())) return snapshot.accessToken;
  const epoch = sessionEpoch;
  if (inFlightRefresh && inFlightRefresh.epoch === epoch) {
    return inFlightRefresh.promise;
  }
  const config = oauthConfig();
  if (!config || !snapshot.refreshToken) {
    await persist(null, epoch);
    return null;
  }
  const run = (async (): Promise<string | null> => {
    try {
      const refreshed = await exchange(
        { grant_type: "refresh_token", refresh_token: snapshot.refreshToken, client_id: config.clientId },
        snapshot.refreshToken,
        fetcher,
      );
      if (epoch !== sessionEpoch) return null;
      const sameEpoch = token;
      const clerkClientToken = sameEpoch?.clerkClientToken ?? snapshot.clerkClientToken;
      const clerkSessionId = sameEpoch?.clerkSessionId ?? snapshot.clerkSessionId;
      await persist(
        {
          ...refreshed,
          ...(snapshot.identity && !refreshed.identity ? { identity: snapshot.identity } : {}),
          ...(snapshot.userId && !refreshed.userId ? { userId: snapshot.userId } : {}),
          ...(clerkClientToken ? { clerkClientToken } : {}),
          ...(clerkSessionId ? { clerkSessionId } : {}),
        },
        epoch,
      );
      return epoch === sessionEpoch ? refreshed.accessToken : null;
    } catch {
      if (epoch === sessionEpoch) await persist(null, epoch);
      return null;
    }
  })();
  const entry = { epoch, promise: run };
  inFlightRefresh = entry;
  try {
    return await run;
  } finally {
    if (inFlightRefresh === entry) inFlightRefresh = null;
  }
}

async function clerkNativeRequest(
  frontendApi: string,
  path: string,
  method: "GET" | "POST",
  fetcher: Fetch,
  epoch: number,
): Promise<{ ok: boolean; status: number; json: Record<string, unknown> | null }> {
  const current = token?.clerkClientToken;
  if (!current || epoch !== sessionEpoch) return { ok: false, status: 401, json: null };
  const sep = path.includes("?") ? "&" : "?";
  const url = `${frontendApi}${path}${sep}_is_native=1&_clerk_js_version=${CLERK_JS_VERSION}`;
  const response = await fetcher(url, {
    method,
    headers: { authorization: current, accept: "application/json", "user-agent": "R3Code" },
  });
  const rotated = response.headers?.get?.("authorization")?.trim();
  if (rotated && rotated.split(".").length === 3 && rotated !== current && token && epoch === sessionEpoch) {
    await persist({ ...token, clerkClientToken: rotated }, epoch);
  }
  const json = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  return { ok: response.ok, status: response.status, json };
}

function sessionUserId(rec: Record<string, unknown>): string | null {
  const user = rec.user as Record<string, unknown> | null | undefined;
  if (user && typeof user.id === "string" && user.id.length > 0) return user.id;
  if (typeof rec.user_id === "string" && rec.user_id.length > 0) return rec.user_id;
  return null;
}

function pickActiveSessionId(body: Record<string, unknown> | null, expectedUserId: string): string | null {
  const client = (body?.response ?? body?.client ?? body) as Record<string, unknown> | null;
  if (!client || typeof client !== "object") return null;
  const lastActive = typeof client.last_active_session_id === "string" && client.last_active_session_id.length > 0
    ? client.last_active_session_id
    : null;
  const sessions = Array.isArray(client.sessions) ? client.sessions : null;
  if (!sessions) return null;
  const matching: { id: string; status: string }[] = [];
  for (const entry of sessions) {
    const rec = entry as Record<string, unknown> | null;
    if (!rec || typeof rec.id !== "string" || rec.id.length === 0) continue;
    if (rec.status !== "active" && rec.status !== "pending") continue;
    if (sessionUserId(rec) === expectedUserId) matching.push({ id: rec.id, status: rec.status });
  }
  if (lastActive && matching.some((s) => s.id === lastActive)) return lastActive;
  const active = matching.find((s) => s.status === "active");
  return active?.id ?? matching[0]?.id ?? null;
}

/** Mints a Clerk session JWT from the configured `t3-relay` template for relay DPoP token exchange. */
export async function connectRelaySessionJwt(fetcher: Fetch = fetch as unknown as Fetch): Promise<string | null> {
  await loadConnectSession();
  const initialToken = token;
  if (!initialToken) return null;
  const epoch = sessionEpoch;
  if (cachedRelayJwt && cachedRelayJwt.epoch === epoch && cachedRelayJwt.expiresAtMs - RELAY_JWT_REFRESH_EARLY_MS > Date.now()) {
    return cachedRelayJwt.jwt;
  }
  if (inFlightRelayJwt && inFlightRelayJwt.epoch === epoch) {
    return inFlightRelayJwt.promise;
  }
  const expectedUserId = initialToken.userId ?? null;
  if (!expectedUserId) return connectBearer(fetcher);
  const run = (async (): Promise<string | null> => {
    const config = resolveCloudPublicConfig();
    if (!hasCloudPublicConfig(config) || !config.clerkPublishableKey || !config.clerkJwtTemplate) {
      return connectBearer(fetcher);
    }
    const frontendApi = clerkFrontendApiUrlFromPublishableKey(config.clerkPublishableKey);
    if (!token?.clerkClientToken && epoch === sessionEpoch) {
      const recovered = await readClerkClientTokenFromHost(frontendApi);
      if (recovered && token && epoch === sessionEpoch) await persist({ ...token, clerkClientToken: recovered }, epoch);
    }
    if (epoch !== sessionEpoch || !token) return null;
    if (!token.clerkClientToken) return connectBearer(fetcher);

    const mintForSession = async (sessionId: string): Promise<{ ok: boolean; status: number; jwt: string | null; mismatchedUser?: boolean }> => {
      const res = await clerkNativeRequest(
        frontendApi,
        `/v1/client/sessions/${encodeURIComponent(sessionId)}/tokens/${encodeURIComponent(config.clerkJwtTemplate!)}`,
        "POST",
        fetcher,
        epoch,
      );
      const jwt = typeof res.json?.jwt === "string" && res.json.jwt.length > 0 ? res.json.jwt : null;
      if (!res.ok || !jwt) return { ok: false, status: res.status, jwt: null };
      if (jwtSubject(jwt) !== expectedUserId) {
        return { ok: false, status: 403, jwt: null, mismatchedUser: true };
      }
      return { ok: true, status: res.status, jwt };
    };

    const resolveSessionId = async (): Promise<string | null> => {
      const clientRes = await clerkNativeRequest(frontendApi, "/v1/client", "GET", fetcher, epoch);
      if (!clientRes.ok) return null;
      const found = pickActiveSessionId(clientRes.json, expectedUserId);
      if (found && token && epoch === sessionEpoch) await persist({ ...token, clerkSessionId: found }, epoch);
      return found;
    };

    let sessionId = token.clerkSessionId ?? null;
    if (!sessionId) {
      sessionId = await resolveSessionId();
    }
    if (epoch !== sessionEpoch || !token) return null;
    if (!sessionId) return connectBearer(fetcher);

    let minted = await mintForSession(sessionId);
    if (!minted.ok && (minted.status === 401 || minted.status === 404 || minted.mismatchedUser) && epoch === sessionEpoch) {
      const refreshedId = await resolveSessionId();
      if (refreshedId && epoch === sessionEpoch) {
        minted = await mintForSession(refreshedId);
      }
    }
    if (epoch !== sessionEpoch || !token) return null;
    if (!minted.ok || !minted.jwt) return connectBearer(fetcher);

    const expiresAtMs = jwtExpiryMs(minted.jwt) ?? (Date.now() + RELAY_JWT_FALLBACK_TTL_MS);
    cachedRelayJwt = { jwt: minted.jwt, expiresAtMs, epoch };
    return minted.jwt;
  })();

  const entry = { epoch, promise: run };
  inFlightRelayJwt = entry;
  try {
    return await run;
  } finally {
    if (inFlightRelayJwt === entry) inFlightRelayJwt = null;
  }
}

/** CloudSession.clerkToken: a T3 Connect route needs a signed-in session; without one the attempt is blocked (fatal: not retried). */
export async function requireConnectSession(fetcher?: Fetch): Promise<void> {
  if (!(await connectBearer(fetcher))) throw Object.assign(new Error(SIGN_IN_TO_CONNECT_ENVIRONMENT_DETAIL), { fatal: true });
}

export function clearCachedRelaySessionJwt(): void {
  cachedRelayJwt = null;
}

export async function signOutOfConnect(): Promise<void> {
  await persist(null);
}

/** Tests only. */
export function resetConnectSessionForTest(): void {
  sessionEpoch += 1;
  activeSignInAttempt = ++signInAttemptSeq;
  token = null;
  loaded = false;
  loadPromise = null;
  cachedRelayJwt = null;
  inFlightRelayJwt = null;
  inFlightRefresh = null;
  persistQueue = Promise.resolve();
  clerkClientTokenReaderForTest = null;
  state.set({ status: "loading" });
}
