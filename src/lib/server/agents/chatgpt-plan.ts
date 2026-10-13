// The ChatGPT-plan connection, server side (master plan C4 item 4, AGENT_ARCHITECTURE §2): the sign-in flow behind
// /api/agents/oauth/chatgpt/{start,callback}, the installation host id, the provider-side sign-out on disconnect, and
// the inference adapter the registry adds behind the flag. Everything is off unless CONSOLE_CHATGPT_PLAN=eligible.
//
// Custody: the token record is sealed by the credential broker (credentials.ts) and opened only through it; refreshes
// are serialised per connection (a globalThis lock map, shared by the route and worker bundles) and the rotated record
// replaces the old one only if nobody replaced it first. Diagnostics, audit rows and redirects carry error codes,
// never a token, code, verifier or ID token. The connection is bound to the ChatGPT subject and the client
// registration (never an email); the protocol rules are pure in src/lib/agents/chatgpt/.
import "server-only";
import type { NextRequest, NextResponse } from "next/server";
import {
  DYNAMIC_CLIENT_ID,
  FLOW_COOKIE,
  FLOW_TTL_MS,
  PlanOAuthError,
  authorizeUrl,
  checkCallback,
  checkPlanScope,
  checkRebind,
  createRefresher,
  discoverPlan,
  exchangeCode,
  isPlanOAuthError,
  keysFrom,
  loopbackCallback,
  planConfig,
  planEligible,
  readTokens,
  revokeRefreshToken,
  tokenRecord,
  verifyPlanIdToken,
  type FlowState,
  type PlanBinding,
  type PlanConfig,
  type PlanFetch,
} from "../../agents/chatgpt/oauth.ts";
import { isHostId, newHostId, pkcePair, randomValue } from "../../agents/chatgpt/pkce.ts";
import { createPlanAdapter, LABEL } from "../../agents/chatgpt/responses-plan.ts";
import { InferenceError, type InferenceAdapter } from "../../agents/inference/types.ts";
import { safeFetch } from "../../plugins/http.ts";
import type { User } from "../../rbac.ts";
import { audit } from "../auth/audit.ts";
import { secureRequest } from "../auth/config.ts";
import { getDb } from "../db.ts";
import { HttpError } from "../errors.ts";
import { seal, unseal } from "../secrets.ts";
import { createConnection, markConnectionStatus, registerRemoteRevoke, rotateConnection } from "./credentials.ts";

export const chatgptPlanOn = () => planEligible(process.env);
export const chatgptConfig = (): PlanConfig => planConfig(process.env);

// The routes answer 404 while the flag is off, as if they didn't exist.
export function requireChatgptPlan() {
  if (!chatgptPlanOn()) throw new HttpError(404, "not found");
}

// ---------- outbound calls ----------

const LOOPBACK_URL = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?\//i;

// The plan's endpoints through safeFetch: one DNS resolution, every address checked and pinned, link-local refused,
// private addresses only for an explicitly configured loopback test endpoint, and no redirects followed.
const planFetch: PlanFetch = (url, init) => safeFetch(url, { method: init.method, headers: init.headers, body: init.body ?? null, signal: init.signal, redirect: "error" }, { allowPrivate: LOOPBACK_URL.test(url) });

interface Shared {
  locks: Map<string, Promise<unknown>>;
  keys: Map<string, ReturnType<typeof keysFrom>>;
  revokeRegistered?: boolean;
}
const g = globalThis as { __consoleChatgptPlan?: Shared };
const shared = (): Shared => (g.__consoleChatgptPlan ??= { locks: new Map(), keys: new Map() });

function keysFor(url: string) {
  const s = shared();
  let k = s.keys.get(url);
  if (!k) s.keys.set(url, (k = keysFrom(url, planFetch)));
  return k;
}

// ---------- the installation host id ----------

const HOST_KEY = "agents:host-id";

// Random once per installation (never derived from the machine), kept in settings, the same for every sign-in.
export async function installationHostId(): Promise<string> {
  const db = await getDb();
  const read = async () => (await db.get<{ value: string }>("SELECT value FROM settings WHERE key = ?", [HOST_KEY]))?.value;
  const v = await read();
  if (isHostId(v)) return v;
  if (v === undefined) await db.run("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO NOTHING", [HOST_KEY, newHostId()]);
  else await db.run("UPDATE settings SET value = ? WHERE key = ? AND value = ?", [newHostId(), HOST_KEY, v]); // an unreadable value
  const now = await read();
  if (!isHostId(now)) throw new HttpError(503, "couldn't record this installation's host id");
  return now;
}

// ---------- the flow cookie ----------

const COOKIE_PATH = "/api/agents/oauth/chatgpt";

// AES-GCM sealed (secrets.ts): the browser carries it but can't read the verifier or forge the state. Path-scoped to
// these routes; Lax so it survives the top-level redirect back from ChatGPT.
export function setFlowCookie(res: NextResponse, req: NextRequest, flow: FlowState) {
  res.cookies.set({ name: FLOW_COOKIE, value: seal(JSON.stringify(flow)), httpOnly: true, sameSite: "lax", secure: secureRequest(req), path: COOKIE_PATH, maxAge: FLOW_TTL_MS / 1000 });
}

export function clearFlowCookie(res: NextResponse, req: NextRequest) {
  res.cookies.set({ name: FLOW_COOKIE, value: "", httpOnly: true, sameSite: "lax", secure: secureRequest(req), path: COOKIE_PATH, maxAge: 0 });
}

export function readFlowCookie(req: NextRequest): FlowState | null {
  const raw = req.cookies.get(FLOW_COOKIE)?.value;
  if (!raw) return null;
  try {
    const f = JSON.parse(unseal(raw)) as FlowState;
    const strings = [f.state, f.nonce, f.verifier, f.redirectUri, f.clientId, f.hostId, f.userId];
    if (strings.some((s) => typeof s !== "string" || !s) || typeof f.exp !== "number") return null;
    return f;
  } catch {
    return null; // tampered, sealed under another key, or garbage
  }
}

// ---------- where the browser is ----------

// The console as this request reached it (not CONSOLE_PUBLIC_URL: the sign-in must start and end on the loopback
// address the browser actually used).
export function requestOrigin(req: NextRequest): { origin: string; host: string; port: string; loopbackName: boolean } {
  const host = (req.headers.get("host") ?? req.nextUrl.host).trim();
  const m = /^(127\.0\.0\.1|localhost|\[::1\])(?::(\d{1,5}))?$/i.exec(host);
  const proto = req.nextUrl.protocol === "https:" ? "https" : "http";
  return { origin: `${proto}://${host}`, host, port: m?.[2] ?? "", loopbackName: !!m };
}

// Back to Automation → Connections, with a stable result code (never provider text).
export function automationUrl(req: NextRequest, result: string): URL {
  return new URL(`/automation?chatgpt=${encodeURIComponent(result)}#connections`, requestOrigin(req).origin);
}

// ---------- the connection being re-authorised ----------

interface PlanRow {
  id: string;
  owner_id: string | null;
  provider: string;
  binding: string | null;
  revoked_at: number | null;
}

async function ownPlanConnection(id: string, user: User): Promise<{ id: string; binding: Partial<PlanBinding> }> {
  if (!/^[A-Za-z0-9-]{1,64}$/.test(id)) throw new HttpError(400, "connection must be a connection id");
  const r = await (await getDb()).get<PlanRow>("SELECT id, owner_id, provider, binding, revoked_at FROM agent_connections WHERE id = ?", [id]);
  if (!r || r.provider !== "chatgpt-plan") throw new HttpError(404, "no such ChatGPT plan connection");
  if (r.owner_id !== user.id) throw new HttpError(403, "only the connection's owner can sign in to it again");
  if (r.revoked_at) throw new HttpError(409, "this connection was disconnected — connect again");
  let binding: Partial<PlanBinding> = {};
  try {
    binding = r.binding ? (JSON.parse(r.binding) as Partial<PlanBinding>) : {};
  } catch {
    // unreadable: checkRebind refuses it
  }
  return { id: r.id, binding };
}

// ---------- step 1 ----------

// Where the person's browser goes next, and the flow to keep in the cookie. `origin` is the console as the browser
// reached it; it must be http://127.0.0.1:<port> (the start route redirects other loopback names there first).
export async function startSignIn(user: User, origin: string, connectionId?: string): Promise<{ url: string; flow: FlowState }> {
  requireChatgptPlan();
  const cfg = chatgptConfig();
  const redirectUri = loopbackCallback(origin);
  // A new connection is a new registration (dynamic_agent_client); signing in to an existing one reuses its client.
  let clientId = DYNAMIC_CLIENT_ID;
  if (connectionId) {
    const c = await ownPlanConnection(connectionId, user);
    if (!c.binding.clientRegistrationId) throw new HttpError(409, "this connection has no client registration — disconnect it and connect again");
    clientId = c.binding.clientRegistrationId;
  }
  const { verifier, challenge } = pkcePair();
  const flow: FlowState = {
    state: randomValue(),
    nonce: randomValue(),
    verifier,
    redirectUri,
    clientId,
    hostId: await installationHostId(),
    userId: user.id,
    ...(connectionId ? { connectionId } : {}),
    exp: Date.now() + FLOW_TTL_MS,
  };
  return { url: authorizeUrl(cfg, { clientId, hostId: flow.hostId, redirectUri, state: flow.state, nonce: flow.nonce, challenge }), flow };
}

// ---------- step 2 ----------

export async function finishSignIn(q: URLSearchParams, flow: FlowState | null, user: User, ip?: string): Promise<{ connectionId: string; created: boolean }> {
  requireChatgptPlan();
  const cfg = chatgptConfig();
  const { code, clientId, scope } = checkCallback(q, flow, user.id);
  const f = flow!;
  const tokens = await exchangeCode(cfg, { code, clientId, redirectUri: f.redirectUri, verifier: f.verifier }, planFetch);
  // From here the provider has issued a session: any refusal below signs it out again rather than leave it live.
  const abandon = async (e: unknown): Promise<never> => {
    if (tokens.refresh_token) {
      const d = await discoverPlan(cfg, planFetch).catch(() => undefined);
      if (d?.revokeUrl) await revokeRefreshToken(d.revokeUrl, { clientId, refreshToken: tokens.refresh_token }, planFetch).catch(() => false);
    }
    throw e;
  };
  try {
    if (!tokens.id_token) throw new PlanOAuthError("id_token", "the token response has no ID token (openid wasn't granted)");
    const d = await discoverPlan(cfg, planFetch);
    const who = await verifyPlanIdToken(tokens.id_token, { issuer: cfg.issuer, clientId, nonce: f.nonce, keys: keysFor(d.jwksUrl) });
    checkPlanScope(cfg, tokens.scope, scope);
    const record = tokenRecord(undefined, tokens, clientId);
    const actor = { user, ip };
    if (f.connectionId) {
      const c = await ownPlanConnection(f.connectionId, user);
      checkRebind(c.binding, { sub: who.sub, clientId });
      await rotateConnection(c.id, { tokens: { ...record } }, actor);
      return { connectionId: c.id, created: false };
    }
    const binding: PlanBinding = { subject: who.sub, clientRegistrationId: clientId, installationHostId: f.hostId, ...(who.plan ? { plan: who.plan } : {}), ...(who.accountId ? { accountId: who.accountId } : {}) };
    const view = await createConnection(
      { provider: "chatgpt-plan", authKind: "oauth-plan", label: `ChatGPT ${who.plan ? `${who.plan} ` : ""}plan`.slice(0, 80), scope: "personal", secret: { tokens: { ...record } } },
      actor,
      { via: "oauth", binding: { ...binding } },
    );
    return { connectionId: view.id, created: true };
  } catch (e) {
    return abandon(e);
  }
}

// The redirect code for Automation → Connections (a stable code, never provider text).
export function signInErrorCode(e: unknown): string {
  if (isPlanOAuthError(e)) return e.code;
  if (e instanceof HttpError) return e.status === 403 ? "forbidden" : e.status === 404 ? "not_found" : e.status === 409 ? "conflict" : "failed";
  return "failed";
}

export async function auditSignInFailure(user: User, e: unknown, ip?: string) {
  const code = signInErrorCode(e);
  const detail = isPlanOAuthError(e) || e instanceof HttpError ? (e as Error).message : "unexpected error";
  console.error(JSON.stringify({ level: 40, msg: "chatgpt plan sign-in failed", code, err: detail.slice(0, 300) }));
  await audit({ action: "connection.signin_failed", actor: user.email, ip, result: "error", detail: detail.slice(0, 300), params: { provider: "chatgpt-plan", code } });
}

// ---------- disconnect: the provider-side sign-out ----------

// Registered with the broker: revokeConnection() calls it with the opened secret and records revoke_confirmed from the
// answer (true only when the provider confirmed with HTTP 200).
function registerRevoke() {
  const s = shared();
  if (s.revokeRegistered) return;
  s.revokeRegistered = true;
  registerRemoteRevoke("chatgpt-plan", async (secret) => {
    if (secret.kind !== "oauth-plan") return false;
    const t = readTokens(secret.tokens);
    if (!t) return false;
    const cfg = chatgptConfig();
    const d = await discoverPlan(cfg, planFetch).catch(() => undefined);
    const url = cfg.revokeUrl ?? d?.revokeUrl;
    if (!url) return false;
    return revokeRefreshToken(url, { clientId: t.client_id, refreshToken: t.refresh_token }, planFetch);
  });
}
registerRevoke();

// ---------- inference ----------

const refresher = createRefresher({
  config: chatgptConfig,
  fetch: planFetch,
  locks: shared().locks,
  onRevoked: (id) => markConnectionStatus(id, "needs_auth").catch(() => undefined),
});

const core = createPlanAdapter({ config: chatgptConfig, fetch: planFetch, refresher, markStatus: (id, s) => markConnectionStatus(id, s) });

const off = () => new InferenceError("invalid_request", `${LABEL} connections are turned off on this console (CONSOLE_CHATGPT_PLAN)`, { provider: LABEL, code: "disabled" });

// What the inference registry adds for provider "chatgpt-plan" (the wave-C cross-package step), behind the flag: with
// it off every call is refused, and nothing falls back to another connection or to API billing.
export const chatgptPlanAdapter: InferenceAdapter = {
  provider: "chatgpt-plan",
  label: LABEL,
  async validate(conn, o) {
    if (!chatgptPlanOn()) return { ok: false, error: { kind: "invalid_request", message: off().message } };
    return core.validate(conn, o);
  },
  async models(conn, o) {
    if (!chatgptPlanOn()) throw off();
    return core.models(conn, o);
  },
  async generate(conn, req) {
    if (!chatgptPlanOn()) throw off();
    return core.generate(conn, req);
  },
};
