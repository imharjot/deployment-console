// Who is making this request? Used by the proxy for every page and API call.
//   session: the console_session cookie → DB session of an enabled user.
//   alb:     the ALB's signed x-amzn-oidc-data header → a users row (invited, or auto-created for allowed domains).
//   dev:     a session cookie if present, else DEV_USER_EMAIL as an admin (local development only).
//   token:   `Authorization: Bearer dc_…` → an API token (resolveTokenIdentity), whatever AUTH_MODE is; cookies ignored.
//   agent:   `Authorization: Bearer da_…` → an agent token (resolveAgentTokenIdentity): the person it acts for, with
//            their current role, plus the token and run; refused (503) while agents are turned off.
import "server-only";
import type { NextRequest } from "next/server";
import { SESSION_COOKIE, normalizeEmail } from "../../authn.ts";
import { parseAllowlist, verifyAlbToken } from "../../auth.ts";
import type { TokenMode } from "../../automation.ts";
import { REGION } from "../../config.ts";
import type { User } from "../../rbac.ts";
import { getDb } from "../db.ts";
import { fatalConfigProblem } from "../config-check.ts";
import { ipOf } from "../http.ts";
import { ensureBootstrap, hasUsers, markHasUsers } from "./bootstrap.ts";
import { authConfig, authMode } from "./config.ts";
import { AGENTS_OFF, agentsEnabled } from "../agents/stop.ts";
import { verifyAgentToken } from "./agent-tokens.ts";
import { verifyToken } from "./api-tokens.ts";
import { ipFail, ipWait, limits, retryText } from "./limits.ts";
import { albCache, lookupSession } from "./sessions.ts";
import { createUser, provision, toUser, userByEmail } from "./users.ts";

export type Via = "session" | "alb" | "dev";

export type Identity =
  | { kind: "user"; user: User; via: Via; renew?: { token: string; until: number } }
  | { kind: "anon"; setup: boolean; verifiedEmail?: string } // setup = no users exist yet
  | { kind: "deny"; status: 401 | 403 | 500; error: string };

async function albIdentity(req: NextRequest): Promise<Identity> {
  const allow = process.env.CONSOLE_ALLOWED_EMAILS;
  const r = await verifyAlbToken(req.headers.get("x-amzn-oidc-data"), {
    albArn: process.env.ALB_ARN ?? "",
    region: REGION, // ALB signing keys are published per region; the ALB is assumed to be in AWS_REGION
    allowed: allow ? parseAllowlist(allow) : undefined,
  });
  if (!r.ok) return { kind: "deny", status: r.status, error: r.error };
  if (!(await hasUsers())) return { kind: "anon", setup: true, verifiedEmail: r.email };
  const hit = albCache.get(r.email); // at most one DB lookup per email per 5 s
  if (hit && Date.now() - hit.at < 5_000) return { kind: "user", user: hit.user, via: "alb" };
  const p = await provision(r.email, null, "alb", ipOf(req));
  if (!p.ok) return { kind: "deny", status: 403, error: p.reason === "disabled" ? "Your account is disabled. Ask an admin to re-enable it." : `${r.email} has not been invited to this console. Ask an admin to invite you.` };
  const user = toUser(p.row);
  albCache.set(r.email, { user, at: Date.now() });
  return { kind: "user", user, via: "alb" };
}

// The dev fallback user is a real row (created as admin on first use), so role changes to it apply like any other.
async function devIdentity(): Promise<Identity> {
  const email = normalizeEmail(process.env.DEV_USER_EMAIL) ?? "dev@localhost";
  const row = (await userByEmail(email)) ?? (await createUser({ email, name: "Dev user", role: "admin" }));
  markHasUsers();
  if (Number(row.disabled)) return { kind: "deny", status: 403, error: `${email} is disabled.` };
  return { kind: "user", user: toUser(row), via: "dev" };
}

export async function resolveIdentity(req: NextRequest, publicPath: boolean): Promise<Identity> {
  const mode = authMode();
  if (!mode.ok) return { kind: "deny", status: 500, error: mode.error };
  const fatal = fatalConfigProblem();
  if (fatal) return { kind: "deny", status: 500, error: fatal };
  await getDb();
  await ensureBootstrap();
  if (mode.mode === "alb") return albIdentity(req);

  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const hit = token ? await lookupSession(token, authConfig().ttlMs) : null;
  if (hit) return { kind: "user", user: hit.user, via: "session", renew: hit.renewedUntil && token ? { token, until: hit.renewedUntil } : undefined };
  // Public pages (/login, /setup, /invite) stay reachable in dev so real sign-in can be tried locally.
  if (mode.mode === "dev" && !publicPath) return devIdentity();
  return { kind: "anon", setup: mode.mode === "session" && !(await hasUsers()) };
}

export type TokenResolution =
  | { kind: "token"; user: User; token: { id: string; name: string; mode: TokenMode } }
  | { kind: "deny"; status: 401 | 429 | 500; error: string; retryAfterMs?: number };

// Agents. Valid tokens are rate-limited per token and never wait on anyone else's failures; unknown, revoked or
// expired tokens are throttled per client address (only when it is known — see ipWait). Tokens are 256-bit, so the
// throttle is about load, not guessing. The token's user is its owner with the token's effective role (api-tokens.ts).
export async function resolveTokenIdentity(req: NextRequest, token: string): Promise<TokenResolution> {
  const mode = authMode();
  if (!mode.ok) return { kind: "deny", status: 500, error: mode.error };
  const fatal = fatalConfigProblem();
  if (fatal) return { kind: "deny", status: 500, error: fatal };
  const addr = ipOf(req);
  await getDb();
  const r = await verifyToken(token);
  if (!r.ok) {
    const bad = ipWait(limits.apiTokenBad, addr);
    if (bad) return { kind: "deny", status: 429, error: retryText(bad), retryAfterMs: bad };
    ipFail(limits.apiTokenBad, addr);
    return { kind: "deny", status: 401, error: r.error };
  }
  const wait = limits.apiToken.retryIn(r.id.token.id);
  if (wait) return { kind: "deny", status: 429, error: `rate limit: ${limits.apiToken.max} requests per minute per token`, retryAfterMs: wait };
  limits.apiToken.fail(r.id.token.id);
  return { kind: "token", user: r.id.user, token: r.id.token };
}

export type AgentTokenResolution =
  | { kind: "agent"; user: User; token: { id: string; name: string; runId: string; kind: "run" | "external" } }
  | { kind: "deny"; status: 401 | 429 | 500 | 503; error: string; retryAfterMs?: number };

// Agent tokens: the same throttles as API tokens (per token while valid, per address while not), refused outright
// while agents are off. The user is the delegator with their current role; the registry adds the policy.
export async function resolveAgentTokenIdentity(req: NextRequest, token: string): Promise<AgentTokenResolution> {
  const mode = authMode();
  if (!mode.ok) return { kind: "deny", status: 500, error: mode.error };
  const fatal = fatalConfigProblem();
  if (fatal) return { kind: "deny", status: 500, error: fatal };
  const addr = ipOf(req);
  await getDb();
  if (!(await agentsEnabled()).on) return { kind: "deny", status: 503, error: AGENTS_OFF };
  const r = await verifyAgentToken(token);
  if (!r.ok) {
    const bad = ipWait(limits.apiTokenBad, addr);
    if (bad) return { kind: "deny", status: 429, error: retryText(bad), retryAfterMs: bad };
    ipFail(limits.apiTokenBad, addr);
    return { kind: "deny", status: 401, error: r.error };
  }
  const wait = limits.apiToken.retryIn(r.id.token.id);
  if (wait) return { kind: "deny", status: 429, error: `rate limit: ${limits.apiToken.max} requests per minute per token`, retryAfterMs: wait };
  limits.apiToken.fail(r.id.token.id);
  return { kind: "agent", user: r.id.user, token: { id: r.id.token.id, name: r.id.token.name, runId: r.id.token.runId, kind: r.id.token.kind } };
}
