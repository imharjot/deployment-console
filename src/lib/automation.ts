// Rules for agents and API tokens, pure so the proxy, the operations registry, the UI and the tests share them:
// token shape, which routes a token may reach, how a token's role is capped, and the mode gate that decides whether
// an operation runs, waits for a person's approval, or is refused.
import { ROLES, type Role } from "./rbac.ts";
import type { Risk } from "./server/ops/types.ts";

// ---------- tokens ----------

export type TokenMode = "read" | "propose" | "act";
export const TOKEN_MODES: TokenMode[] = ["read", "propose", "act"];
export const isTokenMode = (v: unknown): v is TokenMode => typeof v === "string" && (TOKEN_MODES as string[]).includes(v);

// Plain-language explanations, shown when creating a token and in the docs.
export const MODE_INFO: Record<TokenMode, { label: string; hint: string }> = {
  read: { label: "Read only", hint: "Status, logs, metrics, CI, audit. Anything that changes something is refused." },
  propose: { label: "Propose", hint: "Reads freely. Every change becomes an approval request a person accepts or rejects." },
  act: { label: "Act", hint: "Reads and makes routine changes on non-protected environments. Protected environments and dangerous operations still need approval." },
};

// "dc_" + 32 random bytes (base64url). The prefix makes a leaked token easy to recognise in secret scanners.
// CONSOLE_API_TOKENS=false turns the agent surface off: bearer requests are refused and no token can be created.
// Existing tokens stay in the database (revocable) and work again if it is switched back on. Unset or true/1/yes/on
// = on; anything else (false, 0, FALSE, a typo) = off — a security switch fails closed.
export const apiTokensEnabled = () => {
  const v = process.env.CONSOLE_API_TOKENS?.trim().toLowerCase();
  return !v || v === "true" || v === "1" || v === "yes" || v === "on";
};
export const API_TOKENS_OFF = "API tokens are turned off on this console (CONSOLE_API_TOKENS is set to something other than true).";

export const TOKEN_PREFIX = "dc_";
export const isApiTokenShape = (t: unknown): t is string => typeof t === "string" && /^dc_[A-Za-z0-9_-]{43}$/.test(t);
export const tokenDisplayPrefix = (t: string) => t.slice(0, 10);

// `Authorization: Bearer dc_…` (an API token) or `Bearer da_…` (an agent token: a run's own, or an external agent's
// from the Connect screen). Any other Authorization header is not ours and is ignored (cookies still apply).
export function bearerToken(header: string | null | undefined): string | null {
  const m = /^Bearer\s+(d[ca]_\S*)\s*$/i.exec(header ?? "");
  return m ? m[1] : null;
}
export const isAgentBearer = (t: string) => t.startsWith("da_");

// A token never outranks its owner: its role is fixed at creation (≤ the creator's) and capped again by the owner's
// current role on every request, so demoting a person demotes their tokens.
const rank = (r: Role) => ROLES.indexOf(r);
export const minRole = (a: Role, b: Role): Role => (rank(a) <= rank(b) ? a : b);
export const roleAtMost = (role: Role, cap: Role) => rank(role) <= rank(cap);

export const TOKEN_EXPIRY_DAYS = [7, 30, 90] as const;
export const MAX_TOKENS_PER_USER = 25;

export function tokenNameProblem(v: unknown): string | undefined {
  if (typeof v !== "string" || !v.trim()) return "name is required";
  if (v.trim().length > 60) return "name must be at most 60 characters";
  // Names end up in audit actors and response headers: keep them to plain printable ASCII.
  if (!/^[A-Za-z0-9 ._:@/-]+$/.test(v.trim())) return "name may use letters, digits, spaces and . _ : @ / -";
  return undefined;
}

// ---------- where a token may go ----------

// The agent surface. Everything else (pages, users, tokens, integrations, settings, variable reveal, deciding
// approvals) is for people only. Checked in the proxy before the token is even looked up.
const TOKEN_ROUTES: [RegExp, string[]][] = [
  [/^\/api\/ops\/?$/, ["GET"]],
  [/^\/api\/ops\/[^/]+\/?$/, ["POST"]],
  [/^\/api\/approvals\/?$/, ["GET"]],
  [/^\/api\/approvals\/[^/]+\/?$/, ["GET"]],
  [/^\/api\/events\/?$/, ["GET"]],
  [/^\/api\/mcp\/?$/, ["GET", "POST", "DELETE"]], // the route answers GET/DELETE with 405 itself
  [/^\/api\/me\/?$/, ["GET"]],
];

// Agent tokens (`da_`) reach exactly the routes API tokens (`dc_`) do; only the wording of a refusal names them.
export function tokenRoute(method: string, path: string, kind: "api" | "agent" = "api"): { ok: true } | { ok: false; error: string } {
  const m = method === "HEAD" ? "GET" : method.toUpperCase();
  const who = kind === "agent" ? "Agent tokens" : "API tokens";
  if (/^\/api\/approvals\/[^/]+\/?$/.test(path) && m !== "GET") return { ok: false, error: `${who} can't approve or reject requests — a person decides in the console (Automation → Approvals).` };
  if (TOKEN_ROUTES.some(([re, methods]) => re.test(path) && methods.includes(m))) return { ok: true };
  return { ok: false, error: `${who} can only use the operations API: GET /api/ops, POST /api/ops/<name>, /api/mcp, GET /api/approvals, GET /api/events and GET /api/me. See /docs/automation.` };
}

// ---------- the mode gate ----------

export type Via = "session" | "alb" | "dev" | "token" | "agent";
export type Gate = "run" | "approve" | "deny";

// Runs after the role check (RBAC decides *whether* the caller may do it at all; the gate decides *how*).
// People confirm in the UI and act directly. Tokens: read → reads only; propose → every change needs approval;
// act → routine changes run, but anything dangerous or on a protected environment still needs approval.
// Agents (`via: "agent"`) are never decided here: the registry asks the policy engine (src/lib/agents/policy.ts), and a
// caller that forgets to gets "deny" — the gate never lets an agent run anything on its own.
export function gate(mode: TokenMode | undefined, risk: Risk, protectedEnv: boolean, via: Via): Gate {
  if (via === "agent") return "deny";
  if (via !== "token") return "run";
  if (risk === "read") return "run";
  if (mode === "act") return risk === "change" && !protectedEnv ? "run" : "approve";
  if (mode === "propose") return "approve";
  return "deny"; // read-only, or an unknown mode (fail closed)
}

export const gateRefusal = (mode: TokenMode | undefined) =>
  `this token is ${mode === "read" ? "read-only" : "not allowed to make changes"} — create a token in "propose" or "act" mode to request changes`;

// ---------- approvals ----------

export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired" | "done" | "failed";
export const APPROVAL_TTL_MS = 24 * 3_600_000;

// "approved" is transient: set atomically when a person approves, then "done" or "failed" once the operation ran.
export const effectiveStatus = (status: string, createdAt: number, now = Date.now()): ApprovalStatus =>
  status === "pending" && now - createdAt >= APPROVAL_TTL_MS ? "expired" : (status as ApprovalStatus);

export type ApprovalDecision = "approve" | "reject";
