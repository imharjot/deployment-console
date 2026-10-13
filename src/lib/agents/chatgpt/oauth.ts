// "Sign in with ChatGPT" for plan usage (AGENT_ARCHITECTURE §2; OpenAI's local / open-source route, checked against
// developers.openai.com/siwc/token-sharing-open-source on 5 October 2026). Pure: fetch, the key set and the clock are
// injected, so the fixture tests run a throwaway provider in-process.
//
// The flow, for a console installed on someone's own machine:
//   1. authorize with PKCE S256, a fresh state and nonce, the installation host id (`ext_agent_host_id`) and the plan
//      scopes; a first registration uses client_id `dynamic_agent_client` (plus `agent_name_hint`) and the callback
//      returns the issued client id (`client_id=oaiapp_…`), which every later call uses;
//   2. the callback is the console itself on http://127.0.0.1:<port> (only the port may change between sign-ins);
//   3. the code is exchanged with the issued client id, the exact redirect URI, the verifier and the resource;
//   4. the ID token's signature, issuer, audience (the issued client id), expiry and nonce are verified, and the
//      granted scopes must include the plan-use scope;
//   5. the connection is bound to the token's subject and the client registration — never to an email.
// Access tokens last about an hour; refresh tokens rotate on every refresh. Refreshes of one connection are
// serialised and the new record replaces the old one atomically (createRefresher). Disconnecting revokes the refresh
// token at the provider and says honestly whether the provider confirmed it.
//
// Endpoints are configurable (CONSOLE_CHATGPT_*), because this is a preview route.
import { createLocalJWKSet, jwtVerify, type JSONWebKeySet, type JWTPayload, type JWTVerifyGetKey } from "jose";
import { redact } from "../redact.ts";
import { CHATGPT_START_PATH, CHATGPT_USAGE_URL } from "./info.ts";
import { sameValue } from "./pkce.ts";

export const DYNAMIC_CLIENT_ID = "dynamic_agent_client";
export const PLAN_SCOPES = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
export const PLAN_USE_SCOPE = "chatgpt.tokens.use.direct";
export const CALLBACK_PATH = "/api/agents/oauth/chatgpt/callback";
export const START_PATH = CHATGPT_START_PATH;
export const FLOW_COOKIE = "dc_chatgpt_flow";
export const FLOW_TTL_MS = 10 * 60_000;

export { CHATGPT_USAGE_URL, ELIGIBILITY_NOTE } from "./info.ts";

export interface PlanConfig {
  issuer: string;
  authorizeUrl: string;
  tokenUrl: string;
  revokeUrl?: string; // else the discovery document's revocation_endpoint
  jwksUrl?: string; // else the discovery document's jwks_uri
  apiBase: string; // POST {apiBase}/responses, GET {apiBase}/models
  resource: string;
  scopes: string;
  planScope: string;
  usageUrl: string; // ChatGPT's per-app usage controls
  agentName: string; // agent_name_hint on a first registration
}

export const DEFAULT_PLAN_CONFIG: PlanConfig = {
  issuer: "https://auth.openai.com",
  authorizeUrl: "https://auth.openai.com/api/accounts/authorize",
  tokenUrl: "https://auth.openai.com/api/accounts/oauth/token",
  apiBase: "https://api.openai.com/v1",
  resource: "https://api.openai.com/v1",
  scopes: PLAN_SCOPES,
  planScope: PLAN_USE_SCOPE,
  usageUrl: CHATGPT_USAGE_URL,
  agentName: "Deployment Console",
};

// CONSOLE_CHATGPT_PLAN=eligible turns the connection type on; anything else (the default) keeps it off.
export const planEligible = (env: Record<string, string | undefined>) => env.CONSOLE_CHATGPT_PLAN?.trim().toLowerCase() === "eligible";

const LOOPBACK_HOST = /^(127\.0\.0\.1|localhost|\[::1\])$/i;

// An endpoint must be https — or http on a loopback host (a local test provider).
function endpoint(name: string, v: string | undefined, fallback: string | undefined): string | undefined {
  const raw = v?.trim();
  if (!raw) return fallback;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new PlanOAuthError("config", `${name} is not a valid URL`);
  }
  if (u.protocol !== "https:" && !(u.protocol === "http:" && LOOPBACK_HOST.test(u.host.replace(/:\d+$/, "")))) throw new PlanOAuthError("config", `${name} must be an https URL`);
  if (u.username || u.password || u.hash) throw new PlanOAuthError("config", `${name} must not carry credentials or a fragment`);
  return u.toString().replace(/\/+$/, "");
}

export function planConfig(env: Record<string, string | undefined>): PlanConfig {
  const d = DEFAULT_PLAN_CONFIG;
  const c: PlanConfig = {
    ...d,
    issuer: endpoint("CONSOLE_CHATGPT_ISSUER", env.CONSOLE_CHATGPT_ISSUER, d.issuer)!,
    authorizeUrl: endpoint("CONSOLE_CHATGPT_AUTHORIZE_URL", env.CONSOLE_CHATGPT_AUTHORIZE_URL, d.authorizeUrl)!,
    tokenUrl: endpoint("CONSOLE_CHATGPT_TOKEN_URL", env.CONSOLE_CHATGPT_TOKEN_URL, d.tokenUrl)!,
    apiBase: endpoint("CONSOLE_CHATGPT_API_BASE", env.CONSOLE_CHATGPT_API_BASE, d.apiBase)!,
  };
  const revokeUrl = endpoint("CONSOLE_CHATGPT_REVOKE_URL", env.CONSOLE_CHATGPT_REVOKE_URL, undefined);
  const jwksUrl = endpoint("CONSOLE_CHATGPT_JWKS_URL", env.CONSOLE_CHATGPT_JWKS_URL, undefined);
  return { ...c, ...(revokeUrl ? { revokeUrl } : {}), ...(jwksUrl ? { jwksUrl } : {}) };
}

// ---------- errors ----------

// `code` is stable (it goes into the redirect back to Automation); `message` never holds a token, a code or a verifier.
export type PlanErrorCode =
  | "config" // an endpoint setting is wrong
  | "loopback" // the console isn't reached on 127.0.0.1, so the callback can't be a loopback URL
  | "state" // missing, expired or wrong state, or another person's sign-in
  | "denied" // the person (or their plan) didn't authorise plan usage
  | "client" // the client registration doesn't match
  | "token" // the token endpoint refused the code or answered nonsense
  | "id_token" // the ID token failed verification (signature, issuer, audience, expiry)
  | "nonce" // the ID token's nonce isn't this sign-in's
  | "scope" // the plan-use scope wasn't granted
  | "account" // a re-authorisation signed in to a different ChatGPT account
  | "revoked" // the refresh token is unusable: sign in again
  | "temporary"; // the provider is unavailable: try again later

export class PlanOAuthError extends Error {
  readonly code: PlanErrorCode;
  readonly status?: number;
  readonly providerCode?: string;
  constructor(code: PlanErrorCode, message: string, o: { status?: number; providerCode?: string } = {}) {
    super(message);
    this.name = "PlanOAuthError";
    this.code = code;
    this.status = o.status;
    this.providerCode = o.providerCode;
  }
}
export const isPlanOAuthError = (e: unknown): e is PlanOAuthError => e instanceof PlanOAuthError || (!!e && typeof e === "object" && (e as { name?: unknown }).name === "PlanOAuthError");

// ---------- the callback URL ----------

// The console's own origin must be http://127.0.0.1:<port>: OpenAI accepts only loopback callbacks on 127.0.0.1 for
// this route, with the same path every time (only the port may change).
export function loopbackCallback(origin: string): string {
  let u: URL;
  try {
    u = new URL(origin);
  } catch {
    throw new PlanOAuthError("loopback", "the console's address isn't a valid URL");
  }
  if (u.protocol !== "http:" || u.hostname !== "127.0.0.1" || !u.port) throw new PlanOAuthError("loopback", "open the console at http://127.0.0.1:<port> to connect a ChatGPT plan (the sign-in returns to a loopback address)");
  return `http://127.0.0.1:${u.port}${CALLBACK_PATH}`;
}

// ---------- step 1: authorize ----------

export interface AuthorizeInput {
  clientId: string; // the issued client id, or DYNAMIC_CLIENT_ID for a first registration
  hostId: string;
  redirectUri: string;
  state: string;
  nonce: string;
  challenge: string;
}

export function authorizeUrl(cfg: PlanConfig, a: AuthorizeInput): string {
  const u = new URL(cfg.authorizeUrl);
  const q: Record<string, string> = {
    response_type: "code",
    client_id: a.clientId,
    redirect_uri: a.redirectUri,
    scope: cfg.scopes,
    resource: cfg.resource,
    state: a.state,
    nonce: a.nonce,
    code_challenge: a.challenge,
    code_challenge_method: "S256",
    ext_agent_host_id: a.hostId,
    ...(a.clientId === DYNAMIC_CLIENT_ID ? { agent_name_hint: cfg.agentName } : {}),
  };
  for (const [k, v] of Object.entries(q)) u.searchParams.set(k, v);
  return u.toString();
}

// ---------- step 2: the callback ----------

// What the console keeps between start and callback (sealed in a short-lived, path-scoped cookie).
export interface FlowState {
  state: string;
  nonce: string;
  verifier: string;
  redirectUri: string;
  clientId: string; // DYNAMIC_CLIENT_ID for a new registration, else the connection's issued client id
  hostId: string;
  userId: string; // the person who started it; nobody else can finish it
  connectionId?: string; // re-authorising this connection
  exp: number;
}

export const CLIENT_ID = /^[A-Za-z0-9_.:-]{3,200}$/;

export function checkCallback(q: URLSearchParams, flow: FlowState | null | undefined, userId: string, now = Date.now()): { code: string; clientId: string; scope?: string } {
  if (!flow || typeof flow.exp !== "number" || flow.exp < now) throw new PlanOAuthError("state", "the sign-in expired or was started in another browser — start again");
  if (!sameValue(flow.userId, userId)) throw new PlanOAuthError("state", "this sign-in was started by someone else");
  const err = q.get("error");
  if (err) {
    const code = /^[a-z0-9_.-]{1,64}$/i.test(err) ? err : "error";
    if (code === "access_denied") throw new PlanOAuthError("denied", "ChatGPT didn't authorise plan usage for this app (the account or its plan isn't eligible, or the request was declined)", { providerCode: code });
    throw new PlanOAuthError("token", `ChatGPT sign-in failed (${code})`, { providerCode: code });
  }
  if (!sameValue(q.get("state"), flow.state)) throw new PlanOAuthError("state", "the sign-in's state doesn't match — start again");
  const code = q.get("code");
  if (!code || code.length > 4096) throw new PlanOAuthError("token", "the sign-in returned no authorisation code");
  const issued = q.get("client_id");
  let clientId: string;
  if (flow.clientId === DYNAMIC_CLIENT_ID) {
    // A first registration must come back with the client id OpenAI issued; that id is what we keep.
    if (!issued || !CLIENT_ID.test(issued) || issued === DYNAMIC_CLIENT_ID) throw new PlanOAuthError("client", "the sign-in didn't return an issued client registration");
    clientId = issued;
  } else {
    // A re-authorisation may omit it; when it is there it must be the registration we asked for.
    if (issued && !sameValue(issued, flow.clientId)) throw new PlanOAuthError("client", "the sign-in returned a different client registration than this connection's");
    clientId = flow.clientId;
  }
  const scope = q.get("scope") ?? undefined;
  return { code, clientId, ...(scope ? { scope } : {}) };
}

// ---------- the token endpoint ----------

export type PlanFetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<Response>;

export interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  token_type?: string;
  expires_in?: number;
  scope?: string;
  earliest_refresh_at?: number;
}

// Refresh errors that mean the refresh token is gone for good: clear it and sign in again.
export const UNUSABLE_REFRESH = new Set(["invalid_grant", "invalid_refresh_token", "token_expired", "refresh_token_expired", "refresh_token_invalidated", "refresh_token_reused"]);

const providerCode = (v: unknown) => (typeof v === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(v) ? v : undefined);

// Provider text for a diagnostic: bounded, with every secret pattern redacted and the values we sent removed.
export function safeText(text: unknown, sent: readonly string[] = [], max = 200): string {
  let t = typeof text === "string" ? text : "";
  for (const s of sent) if (s && s.length >= 6) t = t.split(s).join("[redacted]");
  t = redact(t).text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

async function tokenCall(cfg: PlanConfig, body: URLSearchParams, fetch: PlanFetch, what: "exchange" | "refresh", signal?: AbortSignal): Promise<TokenResponse> {
  const sent = [...body.values()];
  let res: Response;
  try {
    res = await fetch(cfg.tokenUrl, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body: body.toString(), signal: signal ?? AbortSignal.timeout(15_000) });
  } catch {
    throw new PlanOAuthError("temporary", "the ChatGPT sign-in service couldn't be reached");
  }
  const text = await res.text().catch(() => "");
  let j: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) j = parsed as Record<string, unknown>;
  } catch {
    // not JSON
  }
  if (!res.ok) {
    const code = providerCode(j.error);
    const detail = safeText(j.error_description ?? j.detail, sent);
    const msg = `the ChatGPT sign-in service refused the ${what === "refresh" ? "renewal" : "code"} (HTTP ${res.status}${code ? `, ${code}` : ""})${detail ? `: ${detail}` : ""}`;
    if (code && UNUSABLE_REFRESH.has(code)) throw new PlanOAuthError(what === "refresh" ? "revoked" : "token", msg, { status: res.status, providerCode: code });
    if (code === "invalid_client" || code === "unauthorized_client") throw new PlanOAuthError("client", msg, { status: res.status, providerCode: code });
    if (res.status >= 500 || res.status === 429) throw new PlanOAuthError("temporary", msg, { status: res.status, providerCode: code });
    if (what === "refresh" && (res.status === 400 || res.status === 401)) throw new PlanOAuthError("revoked", msg, { status: res.status, providerCode: code });
    throw new PlanOAuthError("token", msg, { status: res.status, providerCode: code });
  }
  if (typeof j.access_token !== "string" || !j.access_token) throw new PlanOAuthError("token", "the token response has no access token");
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined);
  return {
    access_token: j.access_token,
    ...(typeof j.refresh_token === "string" && j.refresh_token ? { refresh_token: j.refresh_token } : {}),
    ...(typeof j.id_token === "string" && j.id_token ? { id_token: j.id_token } : {}),
    ...(typeof j.token_type === "string" ? { token_type: j.token_type } : {}),
    ...(num(j.expires_in) ? { expires_in: num(j.expires_in) } : {}),
    ...(typeof j.scope === "string" ? { scope: j.scope } : {}),
    ...(num(j.earliest_refresh_at) ? { earliest_refresh_at: num(j.earliest_refresh_at) } : {}),
  };
}

export function exchangeCode(cfg: PlanConfig, o: { code: string; clientId: string; redirectUri: string; verifier: string }, fetch: PlanFetch): Promise<TokenResponse> {
  const body = new URLSearchParams({ grant_type: "authorization_code", code: o.code, client_id: o.clientId, redirect_uri: o.redirectUri, code_verifier: o.verifier, resource: cfg.resource });
  return tokenCall(cfg, body, fetch, "exchange");
}

export function refreshTokens(cfg: PlanConfig, o: { clientId: string; refreshToken: string }, fetch: PlanFetch, signal?: AbortSignal): Promise<TokenResponse> {
  const body = new URLSearchParams({ grant_type: "refresh_token", client_id: o.clientId, refresh_token: o.refreshToken, resource: cfg.resource });
  return tokenCall(cfg, body, fetch, "refresh", signal);
}

// Revokes the renewable session. True only for the provider's confirmation (HTTP 200); network failures and 5xx are
// retried a couple of times while the token is still at hand, then reported as unconfirmed.
export async function revokeRefreshToken(revokeUrl: string, o: { clientId: string; refreshToken: string }, fetch: PlanFetch, sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))): Promise<boolean> {
  const body = new URLSearchParams({ token: o.refreshToken, token_type_hint: "refresh_token", client_id: o.clientId }).toString();
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(revokeUrl, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body, signal: AbortSignal.timeout(10_000) });
      await res.text().catch(() => "");
      if (res.status === 200) return true;
      if (res.status < 500 && res.status !== 429) return false;
    } catch {
      // network: retry
    }
    if (attempt < 2) await sleep(500 * 2 ** attempt);
  }
  return false;
}

// ---------- discovery and the ID token ----------

export interface PlanDiscovery {
  jwksUrl: string;
  revokeUrl?: string;
}

const trimSlash = (s: string) => s.replace(/\/+$/, "");

export async function discoverPlan(cfg: PlanConfig, fetch: PlanFetch): Promise<PlanDiscovery> {
  if (cfg.jwksUrl && cfg.revokeUrl) return { jwksUrl: cfg.jwksUrl, revokeUrl: cfg.revokeUrl };
  let d: Record<string, unknown>;
  try {
    const res = await fetch(`${trimSlash(cfg.issuer)}/.well-known/openid-configuration`, { method: "GET", headers: { accept: "application/json" }, signal: AbortSignal.timeout(8_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    d = (await res.json()) as Record<string, unknown>;
  } catch (e) {
    throw new PlanOAuthError("temporary", `the ChatGPT sign-in service's discovery document couldn't be read (${safeText((e as Error)?.message)})`);
  }
  if (typeof d.issuer !== "string" || trimSlash(d.issuer) !== trimSlash(cfg.issuer)) throw new PlanOAuthError("config", "the discovery document names another issuer");
  const jwks = cfg.jwksUrl ?? (typeof d.jwks_uri === "string" ? endpoint("jwks_uri", d.jwks_uri, undefined) : undefined);
  if (!jwks) throw new PlanOAuthError("config", "the discovery document has no usable jwks_uri");
  const revoke = cfg.revokeUrl ?? (typeof d.revocation_endpoint === "string" ? endpoint("revocation_endpoint", d.revocation_endpoint, undefined) : undefined);
  return { jwksUrl: jwks, ...(revoke ? { revokeUrl: revoke } : {}) };
}

// A key set read through the injected fetch (so the server can pin it with safeFetch), kept an hour and read again
// at most once a minute when a token names an unknown key.
export function keysFrom(jwksUrl: string, fetch: PlanFetch, now = () => Date.now()): JWTVerifyGetKey {
  let cached: { at: number; get: JWTVerifyGetKey } | undefined;
  let lastMiss = 0;
  const load = async () => {
    const res = await fetch(jwksUrl, { method: "GET", headers: { accept: "application/json" }, signal: AbortSignal.timeout(8_000) });
    if (!res.ok) throw new PlanOAuthError("temporary", `the ChatGPT key set couldn't be read (HTTP ${res.status})`);
    const set = (await res.json()) as JSONWebKeySet;
    cached = { at: now(), get: createLocalJWKSet(set) };
    return cached.get;
  };
  return async (header, token) => {
    const get = cached && now() - cached.at < 3_600_000 ? cached.get : await load();
    try {
      return await get(header, token);
    } catch (e) {
      if (now() - lastMiss < 60_000) throw e;
      lastMiss = now();
      return (await load())(header, token);
    }
  };
}

// Public-key algorithms only: an ID token must be verifiable with the provider's published keys.
const ALGS = ["RS256", "RS384", "RS512", "PS256", "PS384", "PS512", "ES256", "ES384", "ES512", "EdDSA"];
export const AUTH_CLAIM = "https://api.openai.com/auth";

export interface PlanIdentity {
  sub: string;
  plan?: string; // the ChatGPT plan type, when the token says (for display: "plus", "pro", …)
  accountId?: string; // the ChatGPT account (workspace) id, when the token says — opaque
}

export async function verifyPlanIdToken(token: string, o: { issuer: string; clientId: string; nonce: string; keys: JWTVerifyGetKey; now?: Date }): Promise<PlanIdentity> {
  let p: JWTPayload;
  try {
    ({ payload: p } = await jwtVerify(token, o.keys, { issuer: o.issuer, audience: o.clientId, algorithms: ALGS, requiredClaims: ["exp", "iat", "sub"], clockTolerance: 60, currentDate: o.now }));
  } catch (e) {
    throw new PlanOAuthError("id_token", `the ChatGPT ID token was rejected: ${safeText((e as Error)?.message, [], 120)}`);
  }
  if (!sameValue(p.nonce, o.nonce)) throw new PlanOAuthError("nonce", "the ChatGPT ID token's nonce doesn't belong to this sign-in");
  if ((Array.isArray(p.aud) && p.aud.length > 1) || p.azp !== undefined) {
    if (p.azp !== o.clientId) throw new PlanOAuthError("id_token", "the ChatGPT ID token was issued to another client");
  }
  if (typeof p.sub !== "string" || !p.sub || p.sub.length > 200) throw new PlanOAuthError("id_token", "the ChatGPT ID token has no usable subject");
  const auth = p[AUTH_CLAIM] && typeof p[AUTH_CLAIM] === "object" ? (p[AUTH_CLAIM] as Record<string, unknown>) : {};
  const plan = typeof auth.chatgpt_plan_type === "string" && /^[a-z0-9_-]{1,40}$/i.test(auth.chatgpt_plan_type) ? auth.chatgpt_plan_type : undefined;
  const account = typeof auth.chatgpt_account_id === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(auth.chatgpt_account_id) ? auth.chatgpt_account_id : undefined;
  return { sub: p.sub, ...(plan ? { plan } : {}), ...(account ? { accountId: account } : {}) };
}

// The plan-use scope must have been granted (the token response's scope; the callback's when the response has none).
export function checkPlanScope(cfg: PlanConfig, tokenScope: string | undefined, callbackScope?: string): string[] {
  const granted = (tokenScope ?? callbackScope ?? "").split(/\s+/).filter(Boolean);
  if (!granted.includes(cfg.planScope)) throw new PlanOAuthError("scope", `ChatGPT didn't grant plan usage (${cfg.planScope}) — the account may not be eligible`);
  return granted;
}

// ---------- the connection's binding ----------

export interface PlanBinding {
  subject: string;
  clientRegistrationId: string;
  installationHostId: string;
  plan?: string;
  accountId?: string;
}

// A re-authorisation must come back as the same ChatGPT account under the same client registration; a different
// account is a new connection, never a silent swap of who pays.
export function checkRebind(existing: Partial<PlanBinding> | undefined, next: { sub: string; clientId: string }) {
  if (!existing?.subject || !existing.clientRegistrationId) throw new PlanOAuthError("account", "this connection has no recorded ChatGPT account — disconnect it and connect again");
  if (!sameValue(existing.subject, next.sub)) throw new PlanOAuthError("account", "you signed in to a different ChatGPT account than this connection's — disconnect it and connect the other account separately");
  if (!sameValue(existing.clientRegistrationId, next.clientId)) throw new PlanOAuthError("client", "the sign-in used a different client registration than this connection's");
}

// ---------- the stored token record ----------

export interface PlanTokens {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_at: number; // epoch ms, from the response's expires_in (never a constant baked into a workflow)
  scope: string;
  client_id: string;
  obtained_at: number;
  earliest_refresh_at?: number; // epoch ms
}

export function tokenRecord(prev: Partial<PlanTokens> | undefined, r: TokenResponse, clientId: string, now = Date.now()): PlanTokens {
  const refresh = r.refresh_token ?? prev?.refresh_token;
  if (!refresh) throw new PlanOAuthError("token", "the token response has no refresh token (offline_access wasn't granted)");
  return {
    access_token: r.access_token,
    refresh_token: refresh,
    token_type: r.token_type ?? "Bearer",
    expires_at: now + (r.expires_in ?? 3600) * 1000,
    scope: r.scope ?? prev?.scope ?? "",
    client_id: clientId,
    obtained_at: now,
    // earliest_refresh_at is Unix seconds in the token reference.
    ...(r.earliest_refresh_at ? { earliest_refresh_at: r.earliest_refresh_at < 1e12 ? r.earliest_refresh_at * 1000 : r.earliest_refresh_at } : {}),
  };
}

export function readTokens(raw: Record<string, unknown> | undefined): PlanTokens | undefined {
  if (!raw) return undefined;
  const s = (k: string) => (typeof raw[k] === "string" && raw[k] ? (raw[k] as string) : undefined);
  const access = s("access_token");
  const refresh = s("refresh_token");
  const client = s("client_id");
  if (!access || !refresh || !client) return undefined;
  const expires = typeof raw.expires_at === "number" ? raw.expires_at : 0;
  return {
    access_token: access,
    refresh_token: refresh,
    client_id: client,
    token_type: s("token_type") ?? "Bearer",
    expires_at: expires,
    scope: s("scope") ?? "",
    obtained_at: typeof raw.obtained_at === "number" ? raw.obtained_at : 0,
    ...(typeof raw.earliest_refresh_at === "number" ? { earliest_refresh_at: raw.earliest_refresh_at } : {}),
  };
}

// Renew two minutes before the access token expires.
export const REFRESH_SKEW_MS = 120_000;
export const needsRefresh = (t: Pick<PlanTokens, "expires_at">, now = Date.now(), skew = REFRESH_SKEW_MS) => !(t.expires_at - skew > now);

// ---------- serialised refresh ----------

// The broker's view of one connection's token record (resolveConnection(...).tokens): read with a version, replace
// only when nobody else replaced it first.
export interface TokenStore {
  read(): Promise<{ tokens: Record<string, unknown>; version: number }>;
  replace(next: Record<string, unknown>, version: number): Promise<{ version: number }>;
}

export interface Refresher {
  // A usable access token. `rejected`: the provider just refused this token (HTTP 401) — renew unless someone already
  // did. Throws PlanOAuthError ("revoked" → sign in again; "temporary" → try later).
  access(connectionId: string, store: TokenStore, o?: { rejected?: string; signal?: AbortSignal }): Promise<string>;
}

export function createRefresher(deps: {
  config(): PlanConfig;
  fetch: PlanFetch;
  locks: Map<string, Promise<unknown>>; // per connection; the server keeps it on globalThis
  now?: () => number;
  onRevoked?(connectionId: string): Promise<void> | void; // mark the connection "needs_auth"
}): Refresher {
  const now = deps.now ?? (() => Date.now());
  // One refresh at a time per connection: a rotating refresh token used twice would be refused (or end the session).
  const serial = <T>(id: string, fn: () => Promise<T>): Promise<T> => {
    const prev = deps.locks.get(id) ?? Promise.resolve();
    const run = prev.catch(() => undefined).then(fn);
    const tail = run.catch(() => undefined);
    deps.locks.set(id, tail);
    void tail.then(() => {
      if (deps.locks.get(id) === tail) deps.locks.delete(id);
    });
    return run;
  };
  const usable = (t: PlanTokens | undefined, rejected?: string) => !!t && !needsRefresh(t, now()) && t.access_token !== rejected;
  return {
    async access(id, store, o = {}) {
      const first = readTokens((await store.read()).tokens);
      if (!first) throw new PlanOAuthError("revoked", "this ChatGPT connection has no usable sign-in — sign in again");
      if (usable(first, o.rejected)) return first.access_token;
      return serial(id, async () => {
        const cur = await store.read();
        const t = readTokens(cur.tokens);
        if (!t) throw new PlanOAuthError("revoked", "this ChatGPT connection has no usable sign-in — sign in again");
        if (usable(t, o.rejected)) return t.access_token; // renewed by whoever held the lock before us
        let r: TokenResponse;
        try {
          r = await refreshTokens(deps.config(), { clientId: t.client_id, refreshToken: t.refresh_token }, deps.fetch, o.signal);
        } catch (e) {
          if (isPlanOAuthError(e) && (e.code === "revoked" || e.code === "client")) await deps.onRevoked?.(id);
          throw e;
        }
        const next = tokenRecord(t, r, t.client_id, now());
        try {
          await store.replace({ ...next }, cur.version);
        } catch {
          // Another console process replaced it first: theirs is the record of record.
          const again = readTokens((await store.read()).tokens);
          if (again && again.access_token !== t.access_token) return again.access_token;
          throw new PlanOAuthError("temporary", "the renewed ChatGPT sign-in couldn't be saved — try again");
        }
        return next.access_token;
      });
    },
  };
}
