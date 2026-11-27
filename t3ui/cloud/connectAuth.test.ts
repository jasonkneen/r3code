import { expect, test } from "nsh/test";
import {
  buildConnectAuthorizeRequestUrl, buildConnectClerkAuthorizeUrl, connectLoopbackRedirectUri, idTokenIdentity, makePkceRequest,
  parsePersistedToken, readConnectCallback, readTokenResponse, tokenNeedsRefresh,
} from "./connectAuth";
import { clerkFrontendApiUrlFromPublishableKey, hasCloudPublicConfig, resolveCloudPublicConfig } from "./publicConfig";
import { beginConnectSignIn, connectAuthState, connectBearer, connectRelaySessionJwt, loadConnectSession, resetConnectSessionForTest, setClerkClientTokenReaderForTest, signOutOfConnect } from "./connectSession";

test("public config is the reference's shipped .env.example and opens the gate", () => {
  const config = resolveCloudPublicConfig();
  expect(config.clerkJwtTemplate).toBe("t3-relay");
  expect(config.relayUrl).toBe("https://relay.t3.codes");
  expect(hasCloudPublicConfig(config)).toBe(true);
  expect(hasCloudPublicConfig({ ...config, relayUrl: null })).toBe(false);
  expect(clerkFrontendApiUrlFromPublishableKey(config.clerkPublishableKey!)).toBe("https://clerk.t3.codes");
});

test("authorize URLs match packages/shared connectAuth", () => {
  const parsed = new URL(buildConnectAuthorizeRequestUrl({ hostedAppUrl: "https://app.t3.codes", state: "s", challenge: "c", loopbackPort: 34338 }));
  expect(parsed.origin).toBe("https://app.t3.codes");
  expect(parsed.pathname).toBe("/connect");
  expect(parsed.search).toBe("");
  expect(parsed.hash).toBe("#state=s&challenge=c&port=34338");
  expect(connectLoopbackRedirectUri(34338)).toBe("http://127.0.0.1:34338/callback");
  const clerk = new URL(buildConnectClerkAuthorizeUrl({ authorizationEndpoint: "https://clerk.t3.codes/oauth/authorize", clientId: "id", redirectUri: "http://127.0.0.1:34338/callback", scopes: ["openid", "email"], state: "s", challenge: "c" }));
  expect(clerk.searchParams.get("scope")).toBe("openid email");
  expect(clerk.searchParams.get("code_challenge_method")).toBe("S256");
});

test("the loopback callback is read and checked against the state", () => {
  expect(readConnectCallback("https://app.t3.codes/connect", "s")).toBe(null);
  expect(readConnectCallback("http://127.0.0.1:34338/callback?code=abc&state=s", "s")).toEqual({ kind: "code", code: "abc" });
  expect(readConnectCallback("http://127.0.0.1:34338/callback?code=abc&state=x", "s")).toEqual({ kind: "invalid" });
  expect(readConnectCallback("http://127.0.0.1:34338/callback?error=access_denied", "s")).toEqual({ kind: "error", message: "access_denied" });
});

test("pkce, token responses and persistence", async () => {
  const pkce = await makePkceRequest();
  expect(pkce.verifier.length).toBe(43);
  expect(pkce.challenge.length).toBe(43);
  expect(pkce.state === pkce.verifier).toBe(false);
  const idToken = `x.${btoa(JSON.stringify({ email: "a@b.c" })).replace(/=+$/u, "")}.y`;
  expect(idTokenIdentity(idToken)).toBe("a@b.c");
  const token = readTokenResponse({ access_token: "A", refresh_token: "R", expires_in: 60, id_token: idToken }, 1000);
  expect(token).toEqual({ accessToken: "A", refreshToken: "R", expiresAtEpochMs: 61000, identity: "a@b.c" });
  expect(tokenNeedsRefresh(token, 0)).toBe(true);
  expect(readTokenResponse({ access_token: "B", expires_in: 3600 }, 0, "R").refreshToken).toBe("R");
  expect(parsePersistedToken(JSON.stringify(token))).toEqual(token);
  expect(parsePersistedToken("nope")).toBe(null);
});

test("sign-in exchanges the code with PKCE, stores the token, signs out", async () => {
  resetConnectSessionForTest();
  await signOutOfConnect();
  resetConnectSessionForTest();
  await loadConnectSession();
  expect(connectAuthState().status).toBe("signed-out");
  const sent: { url: string; body: string }[] = [];
  const fetcher = async (url: string, init: { body: string }) => {
    sent.push({ url, body: init.body });
    return { ok: true, status: 200, json: async () => ({ access_token: "tok", refresh_token: "ref", expires_in: 3600 }) };
  };
  const request = await beginConnectSignIn(fetcher as any);
  expect(request.url.startsWith("https://app.t3.codes/connect#state=")).toBe(true);
  await request.finish("the-code");
  expect(sent[0].url).toBe("https://clerk.t3.codes/oauth/token");
  const body = new URLSearchParams(sent[0].body);
  expect(body.get("grant_type")).toBe("authorization_code");
  expect(body.get("code")).toBe("the-code");
  expect(body.get("client_id")).toBe("hzxSgY2cH10sDU2r");
  expect((body.get("code_verifier") ?? "").length).toBe(43);
  expect(connectAuthState().status).toBe("signed-in");
  expect(await connectBearer(fetcher as any)).toBe("tok");
  await signOutOfConnect();
  expect(connectAuthState().status).toBe("signed-out");
  expect(await connectBearer(fetcher as any)).toBe(null);
});

import { closeConnectSignIn, connectSignInOpen, handleConnectNavigation, openConnectSignIn } from "./ConnectSignIn";

test("the sign-in dialog ignores ordinary navigation and closes on a bad callback", async () => {
  await openConnectSignIn();
  expect(connectSignInOpen()).toBe(true);
  expect(handleConnectNavigation("https://app.t3.codes/connect")).toBe(false);
  expect(connectSignInOpen()).toBe(true);
  expect(handleConnectNavigation("http://127.0.0.1:34338/callback?code=x&state=wrong")).toBe(true);
  expect(connectSignInOpen()).toBe(false);
  closeConnectSignIn();
});

test("connectRelaySessionJwt mints a t3-relay template JWT via Clerk Native API and persists rotated client tokens", async () => {
  resetConnectSessionForTest();
  await signOutOfConnect();
  resetConnectSessionForTest();
  setClerkClientTokenReaderForTest(async () => "h.client1.s");
  const calls: { url: string; method: string; auth?: string }[] = [];
  const exp = Math.floor(Date.now() / 1000) + 120;
  const idToken = `h.${btoa(JSON.stringify({ sub: "user_1", email: "a@b.c" })).replace(/=+$/u, "")}.sig`;
  const mintedJwt = `h.${btoa(JSON.stringify({ sub: "user_1", aud: "t3-relay", exp })).replace(/=+$/u, "")}.sig`;
  const fetcher = async (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => {
    calls.push({ url, method: init.method, auth: init.headers.authorization });
    if (url.endsWith("/oauth/token")) {
      return { ok: true, status: 200, json: async () => ({ access_token: "oauth-tok", refresh_token: "ref", expires_in: 3600, id_token: idToken }) };
    }
    if (url.includes("/v1/client?")) {
      return {
        ok: true,
        status: 200,
        headers: { get: (name: string) => (name.toLowerCase() === "authorization" ? "h.client2.s" : null) },
        json: async () => ({
          response: {
            last_active_session_id: "sess_123",
            sessions: [{ id: "sess_123", status: "active", user: { id: "user_1" } }],
          },
        }),
      };
    }
    if (url.includes("/v1/client/sessions/sess_123/tokens/t3-relay")) {
      return { ok: true, status: 200, json: async () => ({ object: "token", jwt: mintedJwt }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const request = await beginConnectSignIn(fetcher as any);
  await request.finish("code-1");
  const [jwt1, jwt2] = await Promise.all([connectRelaySessionJwt(fetcher as any), connectRelaySessionJwt(fetcher as any)]);
  expect(jwt1).toBe(mintedJwt);
  expect(jwt2).toBe(mintedJwt);
  expect(calls.filter((c) => c.url.includes("/v1/client?")).length).toBe(1);
  expect(calls.find((c) => c.url.includes("/v1/client?"))?.auth).toBe("h.client1.s");
  expect(calls.find((c) => c.url.includes("/tokens/t3-relay"))?.auth).toBe("h.client2.s");
  expect(await connectRelaySessionJwt(fetcher as any)).toBe(mintedJwt);
  expect(calls.filter((c) => c.url.includes("/tokens/t3-relay")).length).toBe(1);
  await signOutOfConnect();
  resetConnectSessionForTest();
});

test("connectRelaySessionJwt matches Clerk session to signed-in userId and rejects mismatched JWT subjects", async () => {
  resetConnectSessionForTest();
  await signOutOfConnect();
  resetConnectSessionForTest();
  setClerkClientTokenReaderForTest(async () => "h.client1.s");
  const exp = Math.floor(Date.now() / 1000) + 120;
  const makeJwt = (payload: Record<string, unknown>) =>
    `h.${btoa(JSON.stringify(payload)).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "")}.sig`;
  const idToken = makeJwt({ sub: "user_target", email: "target@example.com" });
  const targetRelayJwt = makeJwt({ sub: "user_target", aud: "t3-relay", exp });
  const wrongRelayJwt = makeJwt({ sub: "user_other", aud: "t3-relay", exp });
  const requestedPaths: string[] = [];

  const fetcher = async (url: string) => {
    requestedPaths.push(url);
    if (url.endsWith("/oauth/token")) {
      return { ok: true, status: 200, json: async () => ({ access_token: "oauth-target", refresh_token: "ref", expires_in: 3600, id_token: idToken }) };
    }
    if (url.includes("/v1/client?")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          response: {
            last_active_session_id: "sess_other",
            sessions: [
              { id: "sess_other", status: "active", user: { id: "user_other" } },
              { id: "sess_target", status: "active", user: { id: "user_target" } },
            ],
          },
        }),
      };
    }
    if (url.includes("/sessions/sess_target/tokens/t3-relay")) {
      return { ok: true, status: 200, json: async () => ({ object: "token", jwt: targetRelayJwt }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };

  const req = await beginConnectSignIn(fetcher as any);
  await req.finish("code-1");
  expect(await connectRelaySessionJwt(fetcher as any)).toBe(targetRelayJwt);
  expect(requestedPaths.some((p) => p.includes("/sessions/sess_other/"))).toBe(false);

  resetConnectSessionForTest();
  await signOutOfConnect();
  resetConnectSessionForTest();
  setClerkClientTokenReaderForTest(async () => "h.client2.s");
  const mismatchFetcher = async (url: string) => {
    if (url.endsWith("/oauth/token")) {
      return { ok: true, status: 200, json: async () => ({ access_token: "oauth-target-2", refresh_token: "ref", expires_in: 3600, id_token: idToken }) };
    }
    if (url.includes("/v1/client?")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          response: {
            last_active_session_id: "sess_target",
            sessions: [{ id: "sess_target", status: "active", user: { id: "user_target" } }],
          },
        }),
      };
    }
    if (url.includes("/tokens/t3-relay")) {
      return { ok: true, status: 200, json: async () => ({ object: "token", jwt: wrongRelayJwt }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const req2 = await beginConnectSignIn(mismatchFetcher as any);
  await req2.finish("code-2");
  expect(await connectRelaySessionJwt(mismatchFetcher as any)).toBe("oauth-target-2");

  // Without an OAuth id_token (no userId), fail closed to the OAuth bearer instead of guessing a Clerk session.
  resetConnectSessionForTest();
  await signOutOfConnect();
  resetConnectSessionForTest();
  setClerkClientTokenReaderForTest(async () => "h.client3.s");
  const noIdCalls: string[] = [];
  const noIdFetcher = async (url: string) => {
    noIdCalls.push(url);
    if (url.endsWith("/oauth/token")) {
      return { ok: true, status: 200, json: async () => ({ access_token: "oauth-no-id", refresh_token: "ref", expires_in: 3600 }) };
    }
    return { ok: true, status: 200, json: async () => ({ response: { last_active_session_id: "sess_other" } }) };
  };
  const req3 = await beginConnectSignIn(noIdFetcher as any);
  await req3.finish("code-3");
  expect(await connectRelaySessionJwt(noIdFetcher as any)).toBe("oauth-no-id");
  expect(noIdCalls.some((u) => u.includes("/v1/client"))).toBe(false);
  await signOutOfConnect();
  resetConnectSessionForTest();
});

test("in-flight OAuth refresh cannot overwrite or sign out a newer account", async () => {
  resetConnectSessionForTest();
  await signOutOfConnect();
  resetConnectSessionForTest();
  const makeJwt = (payload: Record<string, unknown>) =>
    `h.${btoa(JSON.stringify(payload)).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "")}.sig`;
  const idA = makeJwt({ sub: "user_a", email: "a@example.com" });
  const idB = makeJwt({ sub: "user_b", email: "b@example.com" });

  let resolveRefresh!: (v: any) => void;
  const pendingRefresh = new Promise<any>((r) => { resolveRefresh = r; });

  const fetcherA = async (_url: string, init: { body: string }) => {
    const grant = new URLSearchParams(init.body).get("grant_type");
    if (grant === "authorization_code") {
      return { ok: true, status: 200, json: async () => ({ access_token: "tok-a", refresh_token: "ref-a", expires_in: 60, id_token: idA }) };
    }
    return pendingRefresh;
  };
  const reqA = await beginConnectSignIn(fetcherA as any);
  await reqA.finish("code-a");
  const refreshPromise = connectBearer(fetcherA as any);

  const fetcherB = async () => ({ ok: true, status: 200, json: async () => ({ access_token: "tok-b", refresh_token: "ref-b", expires_in: 3600, id_token: idB }) });
  const reqB = await beginConnectSignIn(fetcherB as any);
  await reqB.finish("code-b");

  resolveRefresh({ ok: false, status: 401, json: async () => ({}) });
  expect(await refreshPromise).toBe(null);
  expect(connectAuthState()).toEqual({ status: "signed-in", identity: "b@example.com", userId: "user_b" });
  expect(await connectBearer(fetcherB as any)).toBe("tok-b");

  let resolveRefresh2!: (v: any) => void;
  const pendingRefresh2 = new Promise<any>((r) => { resolveRefresh2 = r; });
  const fetcherA2 = async (_url: string, init: { body: string }) => {
    const grant = new URLSearchParams(init.body).get("grant_type");
    if (grant === "authorization_code") {
      return { ok: true, status: 200, json: async () => ({ access_token: "tok-a2", refresh_token: "ref-a2", expires_in: 60, id_token: idA }) };
    }
    return pendingRefresh2;
  };
  const reqA2 = await beginConnectSignIn(fetcherA2 as any);
  await reqA2.finish("code-a2");
  const refreshPromise2 = connectBearer(fetcherA2 as any);
  const reqB2 = await beginConnectSignIn(fetcherB as any);
  await reqB2.finish("code-b2");
  resolveRefresh2({ ok: true, status: 200, json: async () => ({ access_token: "stale-a2", refresh_token: "stale-ref", expires_in: 3600, id_token: idA }) });
  expect(await refreshPromise2).toBe(null);
  expect(connectAuthState()).toEqual({ status: "signed-in", identity: "b@example.com", userId: "user_b" });
  expect(await connectBearer(fetcherB as any)).toBe("tok-b");

  let resolveLateSignInA!: (v: any) => void;
  const lateSignInA = new Promise<any>((r) => { resolveLateSignInA = r; });
  const reqLateA = await beginConnectSignIn((async () => lateSignInA) as any);
  const lateAFinish = reqLateA.finish("code-late-a");
  const reqFreshB = await beginConnectSignIn(fetcherB as any);
  await reqFreshB.finish("code-fresh-b");
  resolveLateSignInA({ ok: true, status: 200, json: async () => ({ access_token: "tok-late-a", refresh_token: "ref-a", expires_in: 3600, id_token: idA }) });
  await lateAFinish;
  expect(connectAuthState()).toEqual({ status: "signed-in", identity: "b@example.com", userId: "user_b" });
  expect(await connectBearer(fetcherB as any)).toBe("tok-b");
  await signOutOfConnect();
  resetConnectSessionForTest();
});
