// Native T3 Connect sign-in, ported from packages/shared/src/connectAuth.ts and the server's CLI login
// (apps/server/src/cloud/CliTokenManager.ts): the public CLI OAuth app, authorization code + PKCE, opened
// through the hosted /connect route ("Clerk's signed-out redirect can lose OAuth query parameters"), with the
// loopback redirect registered on that app. The port catches the redirect navigation in a WebView instead of
// listening on the port.

export const DEFAULT_HOSTED_APP_URL = "https://app.t3.codes";
export const CONNECT_OAUTH_SCOPES = ["openid", "profile", "email", "offline_access"] as const;
/** CLOUD_CLI_OAUTH_LOOPBACK_PORT (apps/server/src/cloud/publicConfig.ts). */
export const CONNECT_LOOPBACK_PORT = 34338;

export function connectLoopbackRedirectUri(port: number): string {
  return `http://127.0.0.1:${port}/callback`;
}

export function buildConnectAuthorizeRequestUrl(input: { hostedAppUrl: string; state: string; challenge: string; loopbackPort: number }): string {
  const url = new URL("/connect", input.hostedAppUrl);
  url.hash = new URLSearchParams([
    ["state", input.state],
    ["challenge", input.challenge],
    ["port", String(input.loopbackPort)],
  ]).toString();
  return url.toString();
}

export function buildConnectClerkAuthorizeUrl(input: {
  authorizationEndpoint: string; clientId: string; redirectUri: string; scopes: readonly string[]; state: string; challenge: string;
}): string {
  const url = new URL(input.authorizationEndpoint);
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", input.scopes.join(" "));
  url.searchParams.set("state", input.state);
  url.searchParams.set("code_challenge", input.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

export type CallbackResult = { kind: "code"; code: string } | { kind: "invalid" } | { kind: "error"; message: string } | null;

/** Reads a navigation: null when it is not the loopback callback; "invalid" on a state mismatch or missing code
 * (the server answers "Invalid T3 Connect authorization callback."). */
export function readConnectCallback(navigationUrl: string, expectedState: string, port = CONNECT_LOOPBACK_PORT): CallbackResult {
  let url: URL;
  try { url = new URL(navigationUrl); } catch { return null; }
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.port !== String(port) || url.pathname !== "/callback") return null;
  const error = url.searchParams.get("error");
  if (error) return { kind: "error", message: url.searchParams.get("error_description") || error };
  const code = url.searchParams.get("code");
  if (url.searchParams.get("state") !== expectedState || !code) return { kind: "invalid" };
  return { kind: "code", code };
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
}

/** makePkceRequest: 32 random bytes each for the verifier and state, S256 challenge. */
export async function makePkceRequest(): Promise<{ verifier: string; challenge: string; state: string }> {
  const verifier = base64Url(crypto.getRandomValues(new Uint8Array(32)));
  const state = base64Url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: base64Url(new Uint8Array(digest)), state };
}

export interface ConnectToken {
  accessToken: string;
  refreshToken: string;
  expiresAtEpochMs: number;
  identity?: string;
  /** The Clerk user id (`sub`), what the reference reads as useAuth().userId. */
  userId?: string;
  /** Clerk Frontend API client JWT (`__client`), used to mint `t3-relay` session JWTs for DPoP relay routes. */
  clerkClientToken?: string;
  /** Active Clerk session id associated with `clerkClientToken`. */
  clerkSessionId?: string;
}

/** idTokenIdentity: the id token's email, preferred_username or sub. */
export function idTokenIdentity(idToken: unknown): string | null {
  if (typeof idToken !== "string") return null;
  const payload = idToken.split(".")[1];
  if (!payload) return null;
  try {
    const json = atob(payload.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (payload.length % 4)) % 4));
    const claims = JSON.parse(json);
    for (const value of [claims?.email, claims?.preferred_username, claims?.sub]) {
      if (typeof value === "string" && value.length > 0) return value;
    }
  } catch { /* not a JWT */ }
  return null;
}

/** idTokenUserId: the id token's `sub`, the Clerk user id. */
export function idTokenUserId(idToken: unknown): string | null {
  if (typeof idToken !== "string") return null;
  const payload = idToken.split(".")[1];
  if (!payload) return null;
  try {
    const claims = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (payload.length % 4)) % 4)));
    return typeof claims?.sub === "string" && claims.sub.length > 0 ? claims.sub : null;
  } catch { return null; }
}

/** readTokenResponse: the OAuth token endpoint's JSON into the persisted shape. */
export function readTokenResponse(body: unknown, now: number, previousRefreshToken = ""): ConnectToken {
  const value = body as Record<string, unknown> | null;
  if (!value || typeof value.access_token !== "string" || typeof value.expires_in !== "number") {
    throw new Error("T3 Connect returned an invalid token response.");
  }
  const identity = idTokenIdentity(value.id_token);
  const userId = idTokenUserId(value.id_token);
  return {
    accessToken: value.access_token,
    refreshToken: typeof value.refresh_token === "string" ? value.refresh_token : previousRefreshToken,
    expiresAtEpochMs: now + value.expires_in * 1000,
    ...(identity === null ? {} : { identity }),
    ...(userId === null ? {} : { userId }),
  };
}

/** CLOUD_CLI_OAUTH_REFRESH_EARLY_MS: refresh five minutes before expiry. */
export const REFRESH_EARLY_MS = 5 * 60 * 1000;
export const tokenNeedsRefresh = (token: ConnectToken, now: number) => token.expiresAtEpochMs - REFRESH_EARLY_MS <= now;

export function parsePersistedToken(raw: unknown): ConnectToken | null {
  if (typeof raw !== "string") return null;
  try {
    const value = JSON.parse(raw);
    if (value && typeof value.accessToken === "string" && typeof value.refreshToken === "string" && typeof value.expiresAtEpochMs === "number") {
      return {
        accessToken: value.accessToken,
        refreshToken: value.refreshToken,
        expiresAtEpochMs: value.expiresAtEpochMs,
        ...(typeof value.identity === "string" ? { identity: value.identity } : {}),
        ...(typeof value.userId === "string" ? { userId: value.userId } : {}),
        ...(typeof value.clerkClientToken === "string" && value.clerkClientToken.length > 0 ? { clerkClientToken: value.clerkClientToken } : {}),
        ...(typeof value.clerkSessionId === "string" && value.clerkSessionId.length > 0 ? { clerkSessionId: value.clerkSessionId } : {}),
      };
    }
  } catch { /* corrupt */ }
  return null;
}
