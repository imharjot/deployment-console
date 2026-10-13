// Fixture contract tests for the ChatGPT-plan sign-in (AGENT_ARCHITECTURE §9.5 "credential tests", the OAuth parts):
// wrong state, nonce, account and client; concurrent refresh makes one call; a revoked refresh pauses for auth; and no
// diagnostic ever contains a token. No live OAuth: the provider is an injected fetch and a locally generated key.
import { test } from "node:test";
import assert from "node:assert/strict";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type JWTPayload } from "jose";
import { recoveryFor } from "../inference/errors.ts";
import {
  CALLBACK_PATH,
  DEFAULT_PLAN_CONFIG,
  DYNAMIC_CLIENT_ID,
  PlanOAuthError,
  authorizeUrl,
  checkCallback,
  checkPlanScope,
  checkRebind,
  createRefresher,
  discoverPlan,
  exchangeCode,
  loopbackCallback,
  needsRefresh,
  planConfig,
  planEligible,
  readTokens,
  revokeRefreshToken,
  tokenRecord,
  verifyPlanIdToken,
  type FlowState,
  type PlanFetch,
  type PlanTokens,
  type TokenStore,
} from "./oauth.ts";
import { isHostId, newHostId, pkcePair, s256 } from "./pkce.ts";
import { oauthToInference } from "./responses-plan.ts";
import { planAccountLabel } from "./info.ts";

const cfg = DEFAULT_PLAN_CONFIG;
const ISSUED = "oaiapp_fixture123";
const HOST = "dch_AAAAAAAAAAAAAAAAAAAAAA";
const SENTINEL_REFRESH = "rt_SENTINEL_refresh_token_value_0001";
const SENTINEL_ACCESS = "at_SENTINEL_access_token_value_0001";

const flow = (o: Partial<FlowState> = {}): FlowState => ({
  state: "state-1",
  nonce: "nonce-1",
  verifier: "verifier-1",
  redirectUri: `http://127.0.0.1:3200${CALLBACK_PATH}`,
  clientId: DYNAMIC_CLIENT_ID,
  hostId: HOST,
  userId: "u-ada",
  exp: Date.now() + 60_000,
  ...o,
});

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return e instanceof PlanOAuthError ? e.code : `not a PlanOAuthError: ${(e as Error).message}`;
  }
  return "no error";
};
const codeOf = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e instanceof PlanOAuthError ? e.code : `not a PlanOAuthError: ${(e as Error).message}`;
  }
  return "no error";
};

// A fake provider: records every request; answers from `respond`.
function provider(respond: (url: string, body: URLSearchParams, n: number) => Response | Promise<Response>) {
  const calls: { url: string; body: URLSearchParams; headers: Record<string, string> }[] = [];
  const fetch: PlanFetch = async (url, init) => {
    const body = new URLSearchParams(init.body ?? "");
    calls.push({ url, body, headers: init.headers });
    return respond(url, body, calls.length);
  };
  return { fetch, calls };
}
const jsonRes = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("authorize: PKCE S256, state, nonce, host id, the plan scopes and resource; dynamic registration only the first time", () => {
  const pk = pkcePair();
  assert.equal(pk.verifier.length, 43);
  assert.equal(pk.challenge, s256(pk.verifier));
  assert.notEqual(pkcePair().verifier, pk.verifier);
  assert.ok(isHostId(newHostId()));
  assert.notEqual(newHostId(), newHostId());
  const first = new URL(authorizeUrl(cfg, { clientId: DYNAMIC_CLIENT_ID, hostId: HOST, redirectUri: `http://127.0.0.1:3200${CALLBACK_PATH}`, state: "s", nonce: "n", challenge: pk.challenge }));
  assert.equal(first.origin + first.pathname, "https://auth.openai.com/api/accounts/authorize");
  assert.deepEqual(Object.fromEntries(first.searchParams), {
    response_type: "code",
    client_id: "dynamic_agent_client",
    redirect_uri: "http://127.0.0.1:3200/api/agents/oauth/chatgpt/callback",
    scope: "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
    resource: "https://api.openai.com/v1",
    state: "s",
    nonce: "n",
    code_challenge: pk.challenge,
    code_challenge_method: "S256",
    ext_agent_host_id: HOST,
    agent_name_hint: "Deployment Console",
  });
  const again = new URL(authorizeUrl(cfg, { clientId: ISSUED, hostId: HOST, redirectUri: "http://127.0.0.1:3311/api/agents/oauth/chatgpt/callback", state: "s", nonce: "n", challenge: "c" }));
  assert.equal(again.searchParams.get("client_id"), ISSUED);
  assert.equal(again.searchParams.get("agent_name_hint"), null);
});

test("the callback must be the console on 127.0.0.1 (only the port may vary)", () => {
  assert.equal(loopbackCallback("http://127.0.0.1:3200"), "http://127.0.0.1:3200/api/agents/oauth/chatgpt/callback");
  for (const o of ["http://localhost:3200", "https://127.0.0.1:3200", "http://127.0.0.1", "https://console.acme.io", "http://[::1]:3200", "nonsense"]) assert.equal(code(() => loopbackCallback(o)), "loopback", o);
});

test("callback: wrong or expired state, another person, a refusal, and client registration mismatches are refused", () => {
  const q = (o: Record<string, string>) => new URLSearchParams(o);
  assert.deepEqual(checkCallback(q({ state: "state-1", code: "c-1", client_id: ISSUED, scope: "openid chatgpt.tokens.use.direct" }), flow(), "u-ada"), { code: "c-1", clientId: ISSUED, scope: "openid chatgpt.tokens.use.direct" });
  assert.equal(code(() => checkCallback(q({ state: "state-X", code: "c", client_id: ISSUED }), flow(), "u-ada")), "state");
  // Same length in characters, not in bytes: a refusal, not a RangeError from the constant-time compare.
  assert.equal(code(() => checkCallback(q({ state: "state-é", code: "c", client_id: ISSUED }), flow(), "u-ada")), "state");
  assert.equal(code(() => checkCallback(q({ code: "c", client_id: ISSUED }), flow(), "u-ada")), "state");
  assert.equal(code(() => checkCallback(q({ state: "state-1", code: "c", client_id: ISSUED }), null, "u-ada")), "state");
  assert.equal(code(() => checkCallback(q({ state: "state-1", code: "c", client_id: ISSUED }), flow({ exp: Date.now() - 1 }), "u-ada")), "state");
  assert.equal(code(() => checkCallback(q({ state: "state-1", code: "c", client_id: ISSUED }), flow(), "u-mallory")), "state");
  assert.equal(code(() => checkCallback(q({ error: "access_denied", state: "state-1" }), flow(), "u-ada")), "denied");
  // First registration: the issued client id must come back, and it can't be the dynamic one.
  assert.equal(code(() => checkCallback(q({ state: "state-1", code: "c" }), flow(), "u-ada")), "client");
  assert.equal(code(() => checkCallback(q({ state: "state-1", code: "c", client_id: DYNAMIC_CLIENT_ID }), flow(), "u-ada")), "client");
  assert.equal(code(() => checkCallback(q({ state: "state-1", code: "c", client_id: "bad id with spaces" }), flow(), "u-ada")), "client");
  // Re-authorisation: may omit it, must not change it.
  assert.equal(checkCallback(q({ state: "state-1", code: "c" }), flow({ clientId: ISSUED }), "u-ada").clientId, ISSUED);
  assert.equal(code(() => checkCallback(q({ state: "state-1", code: "c", client_id: "oaiapp_other" }), flow({ clientId: ISSUED }), "u-ada")), "client");
});

test("token exchange: the issued client id, the exact redirect URI, the verifier and the resource; no client secret", async () => {
  const p = provider(() => jsonRes(200, { access_token: SENTINEL_ACCESS, refresh_token: SENTINEL_REFRESH, id_token: "x.y.z", token_type: "Bearer", expires_in: 3600, scope: "openid chatgpt.tokens.use.direct" }));
  const r = await exchangeCode(cfg, { code: "c-1", clientId: ISSUED, redirectUri: "http://127.0.0.1:3200/api/agents/oauth/chatgpt/callback", verifier: "v-1" }, p.fetch);
  assert.equal(r.access_token, SENTINEL_ACCESS);
  assert.equal(p.calls[0].url, "https://auth.openai.com/api/accounts/oauth/token");
  assert.deepEqual(Object.fromEntries(p.calls[0].body), {
    grant_type: "authorization_code",
    code: "c-1",
    client_id: ISSUED,
    redirect_uri: "http://127.0.0.1:3200/api/agents/oauth/chatgpt/callback",
    code_verifier: "v-1",
    resource: "https://api.openai.com/v1",
  });
  assert.equal(p.calls[0].headers.authorization, undefined);
});

test("ID token: signature, issuer, audience (the issued client), expiry and nonce; plan and account read for display", async () => {
  const good = await generateKeyPair("RS256");
  const other = await generateKeyPair("RS256");
  const keys = createLocalJWKSet({ keys: [{ ...(await exportJWK(good.publicKey)), kid: "k1", alg: "RS256" }] });
  const sign = (claims: JWTPayload = {}, key: CryptoKey = good.privateKey, o: { iss?: string; aud?: string; exp?: string | number } = {}) =>
    new SignJWT({ nonce: "nonce-1", email: "ada@acme.io", "https://api.openai.com/auth": { chatgpt_plan_type: "pro", chatgpt_account_id: "acct-123" }, ...claims })
      .setProtectedHeader({ alg: "RS256", kid: "k1" })
      .setIssuer(o.iss ?? "https://auth.openai.com")
      .setAudience(o.aud ?? ISSUED)
      .setSubject("user-sub-1")
      .setIssuedAt()
      .setExpirationTime(o.exp ?? "5m")
      .sign(key);
  const v = (t: string, nonce = "nonce-1") => verifyPlanIdToken(t, { issuer: "https://auth.openai.com", clientId: ISSUED, nonce, keys });
  assert.deepEqual(await v(await sign()), { sub: "user-sub-1", plan: "pro", accountId: "acct-123" });
  assert.equal(await codeOf(v(await sign(), "nonce-2")), "nonce");
  assert.equal(await codeOf(v(await sign({}, good.privateKey, { aud: "oaiapp_someone_else" }))), "id_token");
  assert.equal(await codeOf(v(await sign({}, good.privateKey, { iss: "https://evil.example" }))), "id_token");
  assert.equal(await codeOf(v(await sign({}, good.privateKey, { exp: Math.floor(Date.now() / 1000) - 3600 }))), "id_token");
  assert.equal(await codeOf(v(await sign({}, other.privateKey))), "id_token");
  const hs = await new SignJWT({ nonce: "nonce-1" }).setProtectedHeader({ alg: "HS256" }).setIssuer("https://auth.openai.com").setAudience(ISSUED).setSubject("s").setIssuedAt().setExpirationTime("5m").sign(new TextEncoder().encode("k".repeat(32)));
  assert.equal(await codeOf(v(hs)), "id_token");
  assert.equal(await codeOf(v(await sign({ azp: "oaiapp_other" }))), "id_token");
});

test("the plan scope must be granted; a re-authorisation must be the same account and registration; display never shows an email", () => {
  assert.deepEqual(checkPlanScope(cfg, "openid offline_access chatgpt.tokens.use.direct"), ["openid", "offline_access", "chatgpt.tokens.use.direct"]);
  assert.deepEqual(checkPlanScope(cfg, undefined, "openid chatgpt.tokens.use.direct").length, 2);
  assert.equal(code(() => checkPlanScope(cfg, "openid profile email offline_access")), "scope");
  assert.equal(code(() => checkPlanScope(cfg, undefined, undefined)), "scope");
  const bound = { subject: "user-sub-1", clientRegistrationId: ISSUED, installationHostId: HOST };
  assert.equal(code(() => checkRebind(bound, { sub: "user-sub-1", clientId: ISSUED })), "no error");
  assert.equal(code(() => checkRebind(bound, { sub: "user-sub-2", clientId: ISSUED })), "account");
  assert.equal(code(() => checkRebind(bound, { sub: "user-sub-1", clientId: "oaiapp_other" })), "client");
  assert.equal(code(() => checkRebind({}, { sub: "user-sub-1", clientId: ISSUED })), "account");
  assert.equal(planAccountLabel({ subject: "user-abcdefghijklmnop", plan: "pro" }), "ChatGPT pro account user-a…mnop");
  assert.equal(planAccountLabel(undefined), "ChatGPT account (not signed in)");
});

test("token records: expiry from expires_in, the refresh token kept when a refresh doesn't return one", () => {
  const t = tokenRecord(undefined, { access_token: "a1", refresh_token: "r1", expires_in: 3600, scope: "s" }, ISSUED, 1_000);
  assert.deepEqual(t, { access_token: "a1", refresh_token: "r1", token_type: "Bearer", expires_at: 3_601_000, scope: "s", client_id: ISSUED, obtained_at: 1_000 });
  const t2 = tokenRecord(t, { access_token: "a2", earliest_refresh_at: 1_700_000_000 }, ISSUED, 2_000);
  assert.equal(t2.refresh_token, "r1");
  assert.equal(t2.earliest_refresh_at, 1_700_000_000_000);
  assert.equal(code(() => tokenRecord(undefined, { access_token: "a" }, ISSUED)), "token");
  assert.deepEqual(readTokens({ ...t }), t);
  assert.equal(readTokens({ access_token: "a" }), undefined);
  assert.equal(needsRefresh(t, 3_601_000 - 120_001), false);
  assert.equal(needsRefresh(t, 3_601_000 - 120_000), true);
});

// An in-memory token store with the broker's contract: replace only at the version read.
function store(initial: PlanTokens) {
  let rec: Record<string, unknown> = { ...initial };
  let version = 1;
  const replaced: Record<string, unknown>[] = [];
  const s: TokenStore = {
    read: async () => ({ tokens: { ...rec }, version }),
    replace: async (next, v) => {
      if (v !== version) throw new Error("409 the secret was rotated by someone else first");
      rec = { ...next };
      version++;
      replaced.push(next);
      return { version };
    },
  };
  return { s, replaced, get: () => rec };
}

test("concurrent refresh: one call to the token endpoint, both callers get the rotated token, the record is replaced once", async () => {
  const st = store({ access_token: "old-access", refresh_token: SENTINEL_REFRESH, token_type: "Bearer", expires_at: Date.now() - 1, scope: "s", client_id: ISSUED, obtained_at: 0 });
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const p = provider(async (_u, body) => {
    await gate;
    assert.equal(body.get("grant_type"), "refresh_token");
    assert.equal(body.get("refresh_token"), SENTINEL_REFRESH);
    assert.equal(body.get("client_id"), ISSUED);
    assert.equal(body.get("resource"), "https://api.openai.com/v1");
    return jsonRes(200, { access_token: "new-access", refresh_token: "rt-rotated", expires_in: 3600, scope: "s" });
  });
  const r = createRefresher({ config: () => cfg, fetch: p.fetch, locks: new Map() });
  const a = r.access("conn-1", st.s);
  const b = r.access("conn-1", st.s);
  const c = r.access("conn-1", st.s);
  setTimeout(release, 20);
  assert.deepEqual(await Promise.all([a, b, c]), ["new-access", "new-access", "new-access"]);
  assert.equal(p.calls.length, 1, "exactly one refresh");
  assert.equal(st.replaced.length, 1);
  assert.equal(st.get().refresh_token, "rt-rotated", "the rotated refresh token replaced the old one");
  // A fresh token needs no call; a token the provider just refused is renewed once, even before it expires.
  assert.equal(await r.access("conn-1", st.s), "new-access");
  assert.equal(p.calls.length, 1);
});

test("a token the API refused is renewed unless someone already did; a revoked refresh pauses the run for sign-in (paused_auth)", async () => {
  const fresh = { access_token: "a-live", refresh_token: "r-live", token_type: "Bearer", expires_at: Date.now() + 3_600_000, scope: "s", client_id: ISSUED, obtained_at: 0 };
  const st = store(fresh);
  const ok = provider(() => jsonRes(200, { access_token: "a-next", refresh_token: "r-next", expires_in: 3600 }));
  const r = createRefresher({ config: () => cfg, fetch: ok.fetch, locks: new Map() });
  assert.equal(await r.access("c", st.s, { rejected: "a-live" }), "a-next");
  assert.equal(await r.access("c", st.s, { rejected: "a-live" }), "a-next", "already renewed by the first");
  assert.equal(ok.calls.length, 1);

  for (const err of ["invalid_grant", "refresh_token_reused", "refresh_token_expired", "refresh_token_invalidated", "token_expired", "invalid_refresh_token"]) {
    const revoked: string[] = [];
    const bad = provider(() => jsonRes(400, { error: err, error_description: `refresh token ${SENTINEL_REFRESH} is no longer valid` }));
    const rr = createRefresher({ config: () => cfg, fetch: bad.fetch, locks: new Map(), onRevoked: (id) => void revoked.push(id) });
    const st2 = store({ ...fresh, refresh_token: SENTINEL_REFRESH, expires_at: 0 });
    let caught: unknown;
    try {
      await rr.access("conn-9", st2.s);
    } catch (e) {
      caught = e;
    }
    assert.ok(caught instanceof PlanOAuthError && caught.code === "revoked", err);
    assert.deepEqual(revoked, ["conn-9"], "the connection is marked as needing a sign-in");
    assert.ok(!(caught as Error).message.includes(SENTINEL_REFRESH), "the refresh token never reaches a diagnostic");
    const ie = oauthToInference(caught);
    assert.equal(ie.kind, "auth");
    assert.deepEqual(recoveryFor(ie), { action: "pause", state: "paused_auth", cause: ie.message });
    assert.equal(st2.replaced.length, 0);
  }
  // Temporary trouble at the provider is a retry, not a sign-out.
  const down = provider(() => jsonRes(503, { error: "temporarily_unavailable" }));
  const rd = createRefresher({ config: () => cfg, fetch: down.fetch, locks: new Map(), onRevoked: () => assert.fail("not revoked") });
  const e = await rd.access("c", store({ ...fresh, expires_at: 0 }).s).catch((x) => x);
  assert.equal(e.code, "temporary");
  assert.equal(oauthToInference(e).kind, "unavailable");
  // No record at all: sign in again.
  const empty: TokenStore = { read: async () => ({ tokens: {}, version: 1 }), replace: async () => ({ version: 2 }) };
  assert.equal(await codeOf(rd.access("c", empty)), "revoked");
});

test("disconnect: revocation is confirmed only by the provider's 200; 5xx is retried while the token is at hand", async () => {
  const sleep = async () => {};
  const ok = provider(() => new Response("", { status: 200 }));
  assert.equal(await revokeRefreshToken("https://auth.openai.com/oauth/revoke", { clientId: ISSUED, refreshToken: SENTINEL_REFRESH }, ok.fetch, sleep), true);
  assert.deepEqual(Object.fromEntries(ok.calls[0].body), { token: SENTINEL_REFRESH, token_type_hint: "refresh_token", client_id: ISSUED });
  const flaky = provider((_u, _b, n) => new Response("", { status: n < 3 ? 503 : 200 }));
  assert.equal(await revokeRefreshToken("https://x.test/revoke", { clientId: ISSUED, refreshToken: "r" }, flaky.fetch, sleep), true);
  assert.equal(flaky.calls.length, 3);
  const refused = provider(() => new Response("", { status: 400 }));
  assert.equal(await revokeRefreshToken("https://x.test/revoke", { clientId: ISSUED, refreshToken: "r" }, refused.fetch, sleep), false);
  assert.equal(refused.calls.length, 1);
  const offline: PlanFetch = async () => {
    throw new Error("ECONNRESET");
  };
  assert.equal(await revokeRefreshToken("https://x.test/revoke", { clientId: ISSUED, refreshToken: "r" }, offline, sleep), false);
});

test("diagnostics never contain a token: provider error text echoing what we sent is redacted", async () => {
  const echo = provider((_u, body) => jsonRes(400, { error: "invalid_request", error_description: `bad code ${body.get("code")} with verifier ${body.get("code_verifier")} Bearer ${SENTINEL_ACCESS}` }));
  let caught: Error | undefined;
  try {
    await exchangeCode(cfg, { code: "code_SENTINEL_value_123", clientId: ISSUED, redirectUri: "http://127.0.0.1:1/cb", verifier: "verifier_SENTINEL_value_456" }, echo.fetch);
  } catch (e) {
    caught = e as Error;
  }
  assert.ok(caught instanceof PlanOAuthError);
  for (const s of ["code_SENTINEL_value_123", "verifier_SENTINEL_value_456", SENTINEL_ACCESS]) assert.ok(!caught.message.includes(s), `${s} in ${caught.message}`);
  assert.match(caught.message, /HTTP 400, invalid_request/);
  const net = await codeOf(exchangeCode(cfg, { code: "c", clientId: ISSUED, redirectUri: "http://127.0.0.1:1/cb", verifier: "v" }, async () => Promise.reject(new Error(`connect failed for ${SENTINEL_ACCESS}`))));
  assert.equal(net, "temporary");
});

test("configuration: off unless CONSOLE_CHATGPT_PLAN=eligible; endpoints configurable but https (or a loopback test provider)", async () => {
  assert.equal(planEligible({}), false);
  assert.equal(planEligible({ CONSOLE_CHATGPT_PLAN: "true" }), false);
  assert.equal(planEligible({ CONSOLE_CHATGPT_PLAN: " Eligible " }), true);
  assert.deepEqual(planConfig({}), DEFAULT_PLAN_CONFIG);
  const local = planConfig({ CONSOLE_CHATGPT_TOKEN_URL: "http://127.0.0.1:9999/token", CONSOLE_CHATGPT_API_BASE: "https://proxy.acme.io/v1/" });
  assert.equal(local.tokenUrl, "http://127.0.0.1:9999/token");
  assert.equal(local.apiBase, "https://proxy.acme.io/v1");
  assert.equal(code(() => planConfig({ CONSOLE_CHATGPT_TOKEN_URL: "http://auth.example.com/token" })), "config");
  assert.equal(code(() => planConfig({ CONSOLE_CHATGPT_ISSUER: "https://u:p@auth.example.com" })), "config");
  // Discovery: the issuer must match; jwks and revocation come from it unless configured.
  const disco = provider(() => jsonRes(200, { issuer: "https://auth.openai.com", jwks_uri: "https://auth.openai.com/.well-known/jwks.json", revocation_endpoint: "https://auth.openai.com/oauth/revoke" }));
  assert.deepEqual(await discoverPlan(cfg, disco.fetch), { jwksUrl: "https://auth.openai.com/.well-known/jwks.json", revokeUrl: "https://auth.openai.com/oauth/revoke" });
  const evil = provider(() => jsonRes(200, { issuer: "https://evil.example", jwks_uri: "https://evil.example/jwks" }));
  assert.equal(await codeOf(discoverPlan(cfg, evil.fetch)), "config");
});
