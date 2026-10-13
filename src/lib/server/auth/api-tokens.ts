// API tokens for agents and scripts (`Authorization: Bearer dc_…`). Trust boundary: a token is a person's delegate,
// never more. Its role is fixed at creation (≤ the creator's) and capped by the owner's current role on every request;
// a disabled or deleted owner, or a revoked or expired token, gets 401. Only sha256(token) is stored — a leaked database
// or backup can't be replayed — and the plain token is shown exactly once. Where a token may go (the operations API
// only) is decided in the proxy with tokenRoute(); what it may do there is decided by gate() in src/lib/automation.ts.
import "server-only";
import { hashToken, newToken } from "../../authn.ts";
import {
  API_TOKENS_OFF, MAX_TOKENS_PER_USER, TOKEN_EXPIRY_DAYS, TOKEN_PREFIX, apiTokensEnabled, isApiTokenShape, isTokenMode, minRole, roleAtMost,
  tokenDisplayPrefix, tokenNameProblem, type TokenMode,
} from "../../automation.ts";
import { isRole, type Role, type User } from "../../rbac.ts";
import { getDb, newId } from "../db.ts";
import { HttpError } from "../errors.ts";
import { auditOrFail } from "./audit.ts";
import { toUser } from "./users.ts";

export interface TokenItem {
  id: string;
  name: string;
  prefix: string; // "dc_AbCdEfG" — enough to recognise a token, useless to use one
  role: Role;
  mode: TokenMode;
  owner: { id: string; email: string | null };
  createdAt: number;
  lastUsedAt: number | null;
  expiresAt: number | null;
  revokedAt: number | null;
  uses: number; // operation calls (flushed every ~30 s, so it may trail by a few)
  status: "active" | "expired" | "revoked";
}

interface Row {
  id: string;
  name: string;
  user_id: string;
  role: string;
  mode: string;
  prefix: string;
  created_at: number;
  last_used_at: number | null;
  expires_at: number | null;
  revoked_at: number | null;
  uses: number;
  email?: string | null;
}

const COLS = "t.id, t.name, t.user_id, t.role, t.mode, t.prefix, t.created_at, t.last_used_at, t.expires_at, t.revoked_at, t.uses, u.email";

const toItem = (r: Row, now = Date.now()): TokenItem => ({
  id: r.id,
  name: r.name,
  prefix: r.prefix,
  role: isRole(r.role) ? r.role : "viewer",
  mode: isTokenMode(r.mode) ? r.mode : "read",
  owner: { id: r.user_id, email: r.email ?? null },
  createdAt: Number(r.created_at),
  lastUsedAt: r.last_used_at ? Number(r.last_used_at) : null,
  expiresAt: r.expires_at ? Number(r.expires_at) : null,
  revokedAt: r.revoked_at ? Number(r.revoked_at) : null,
  uses: Number(r.uses ?? 0),
  status: r.revoked_at ? "revoked" : r.expires_at && Number(r.expires_at) <= now ? "expired" : "active",
});

// ---------- manage (people only: the proxy never lets a token reach /api/tokens) ----------

export interface NewToken {
  name: unknown;
  role: unknown;
  mode: unknown;
  expiresInDays: unknown; // 7 | 30 | 90 | null (never)
}

export async function createToken(creator: User, input: NewToken, ip: string | undefined): Promise<{ token: string; item: TokenItem }> {
  if (!apiTokensEnabled()) throw new HttpError(403, API_TOKENS_OFF);
  const problem = tokenNameProblem(input.name);
  if (problem) throw new HttpError(400, problem);
  const name = String(input.name).trim();
  const role: Role = input.role === undefined ? creator.role : isRole(input.role) ? input.role : (() => { throw new HttpError(400, "role must be viewer, developer, operator or admin"); })();
  if (!roleAtMost(role, creator.role)) throw new HttpError(403, `a token can't have more access than you (${creator.role})`);
  const mode: TokenMode = input.mode === undefined ? "propose" : isTokenMode(input.mode) ? input.mode : (() => { throw new HttpError(400, "mode must be read, propose or act"); })();
  const days = input.expiresInDays;
  if (days !== null && days !== undefined && !(TOKEN_EXPIRY_DAYS as readonly unknown[]).includes(days)) throw new HttpError(400, `expiresInDays must be ${TOKEN_EXPIRY_DAYS.join(", ")} or null (never)`);
  const now = Date.now();
  const expiresAt = typeof days === "number" ? now + days * 86_400_000 : null;

  const token = TOKEN_PREFIX + newToken();
  const id = newId();
  const db = await getDb();
  await db.tx(async (tx) => {
    const live = await tx.get<{ n: number }>("SELECT COUNT(*) AS n FROM api_tokens WHERE user_id = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)", [creator.id, now]);
    if (Number(live?.n ?? 0) >= MAX_TOKENS_PER_USER) throw new HttpError(409, `you already have ${MAX_TOKENS_PER_USER} active tokens — revoke one first`);
    await tx.run("INSERT INTO api_tokens (id, name, user_id, role, mode, hash, prefix, created_at, expires_at, uses) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)", [
      id, name, creator.id, role, mode, hashToken(token), tokenDisplayPrefix(token), now, expiresAt,
    ]);
    await auditOrFail({ action: "token.create", actor: creator.email, target: name, ip, params: { id, role, mode, expiresAt } });
  });
  const item = await tokenById(id);
  return { token, item: item! };
}

export async function tokenById(id: string): Promise<TokenItem | undefined> {
  const r = await (await getDb()).get<Row>(`SELECT ${COLS} FROM api_tokens t LEFT JOIN users u ON u.id = t.user_id WHERE t.id = ?`, [id]);
  return r ? toItem(r) : undefined;
}

// Own tokens; admins may ask for everyone's. Newest first, revoked ones last.
export async function listTokens(user: User, all: boolean): Promise<TokenItem[]> {
  const db = await getDb();
  const rows = all
    ? await db.all<Row>(`SELECT ${COLS} FROM api_tokens t LEFT JOIN users u ON u.id = t.user_id ORDER BY t.created_at DESC LIMIT 500`)
    : await db.all<Row>(`SELECT ${COLS} FROM api_tokens t LEFT JOIN users u ON u.id = t.user_id WHERE t.user_id = ? ORDER BY t.created_at DESC LIMIT 200`, [user.id]);
  const now = Date.now();
  const order = { active: 0, expired: 1, revoked: 2 };
  return rows.map((r) => toItem(r, now)).sort((a, b) => order[a.status] - order[b.status] || b.createdAt - a.createdAt);
}

// Own token, or anyone's for an admin. Pending approval requests from the token are rejected with it: revoking is how
// a person says "stop this agent", and a queued change shouldn't outlive that.
export async function revokeToken(actor: User, id: string, ip: string | undefined): Promise<TokenItem> {
  const t = await tokenById(id);
  if (!t || (t.owner.id !== actor.id && actor.role !== "admin")) throw new HttpError(404, "no such token");
  if (t.revokedAt) return t;
  const now = Date.now();
  const db = await getDb();
  await db.tx(async (tx) => {
    await tx.run("UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL", [now, id]);
    await tx.run("UPDATE approvals SET status = 'rejected', decided_at = ?, decided_by = ?, detail = ? WHERE token_id = ? AND status = 'pending'", [now, actor.email, "token revoked", id]);
    await auditOrFail({ action: "token.revoke", actor: actor.email, target: t.name, ip, params: { id, owner: t.owner.email } });
  });
  forgetCachedTokens();
  return (await tokenById(id))!;
}

// For long-lived connections (the event stream): is the token still usable? Checked again every heartbeat.
export async function tokenStillValid(id: string): Promise<boolean> {
  const r = await (await getDb()).get<{ revoked_at: number | null; expires_at: number | null; disabled: number | null; u_id: string | null }>(
    "SELECT t.revoked_at, t.expires_at, u.disabled, u.id AS u_id FROM api_tokens t LEFT JOIN users u ON u.id = t.user_id WHERE t.id = ?",
    [id],
  );
  return !!r && !r.revoked_at && !(r.expires_at && Number(r.expires_at) <= Date.now()) && !!r.u_id && !Number(r.disabled);
}

// ---------- verify (the proxy, on every request that carries a token) ----------

export interface TokenIdentity {
  user: User; // the owner, with the token's effective role
  token: { id: string; name: string; mode: TokenMode };
}

interface Live {
  id: string;
  name: string;
  role: string;
  mode: string;
  expiresAt: number | null;
  owner: User;
  ownerDisabled: boolean;
  cachedAt: number;
}

// ≤5 s lookup cache on globalThis (the proxy and the routes are separate bundles). Revocation and user changes clear
// it on this instance; across instances the TTL bounds staleness, as for sessions.
const CACHE_MS = 5_000;
const g = globalThis as typeof globalThis & { __consoleApiTokens?: Map<string, Live | null>; __consoleApiTokenUse?: Map<string, { n: number; flushedAt: number; timer?: ReturnType<typeof setTimeout> }> };
const cache = (g.__consoleApiTokens ??= new Map<string, Live | null>());
export const forgetCachedTokens = () => cache.clear();

export type TokenCheck = { ok: true; id: TokenIdentity } | { ok: false; error: string };

export async function verifyToken(token: string): Promise<TokenCheck> {
  if (!isApiTokenShape(token)) return { ok: false, error: "malformed API token" };
  const hash = hashToken(token);
  const now = Date.now();
  let live = cache.get(hash);
  if (live === undefined || (live && now - live.cachedAt > CACHE_MS) || (live === null && cache.size > 5_000)) {
    const r = await (await getDb()).get<Row & { u_id: string | null; u_name: string | null; u_role: string | null; u_disabled: number | null }>(
      `SELECT t.id, t.name, t.role, t.mode, t.expires_at, u.id AS u_id, u.email, u.name AS u_name, u.role AS u_role, u.disabled AS u_disabled
         FROM api_tokens t LEFT JOIN users u ON u.id = t.user_id
        WHERE t.hash = ? AND t.revoked_at IS NULL`,
      [hash],
    );
    live = r
      ? {
          id: r.id, name: r.name, role: r.role, mode: r.mode, expiresAt: r.expires_at ? Number(r.expires_at) : null, cachedAt: now,
          owner: toUser({ id: r.u_id ?? "", email: r.email ?? "", name: r.u_name, role: r.u_role ?? "viewer" }),
          ownerDisabled: !r.u_id || !!Number(r.u_disabled),
        }
      : null;
    cache.set(hash, live);
    if (cache.size > 5_000) for (const [k, v] of cache) if (!v || now - v.cachedAt > CACHE_MS) cache.delete(k);
  }
  if (!live) return { ok: false, error: "invalid or revoked API token" };
  if (live.expiresAt && live.expiresAt <= now) return { ok: false, error: "this API token has expired — create a new one under Automation → API tokens" };
  if (live.ownerDisabled) return { ok: false, error: "the owner of this API token is disabled or no longer exists" };
  noteUse(live.id, 0);
  const role = minRole(isRole(live.role) ? live.role : "viewer", live.owner.role);
  return { ok: true, id: { user: { ...live.owner, role }, token: { id: live.id, name: live.name, mode: isTokenMode(live.mode) ? live.mode : "read" } } };
}

// Cheap usage tracking: counts accumulate in memory and are written at most every 30 s per token (last_used_at with
// them) — by the next use, or by a timer when a burst goes quiet. A crash can lose up to 30 s of counts; nothing
// depends on them being exact.
const use = (g.__consoleApiTokenUse ??= new Map<string, { n: number; flushedAt: number; timer?: ReturnType<typeof setTimeout> }>());
function flush(tokenId: string) {
  const u = use.get(tokenId);
  if (!u) return;
  if (u.timer) clearTimeout(u.timer);
  u.timer = undefined;
  const add = u.n, now = Date.now();
  u.n = 0;
  u.flushedAt = now;
  void getDb()
    .then((db) => db.run("UPDATE api_tokens SET last_used_at = ?, uses = uses + ? WHERE id = ?", [now, add, tokenId]))
    .catch(() => {
      u.n += add; // try again with the next flush
    });
}
export function noteUse(tokenId: string, n = 1) {
  const u = use.get(tokenId) ?? { n: 0, flushedAt: 0 };
  u.n += n;
  use.set(tokenId, u);
  const wait = 30_000 - (Date.now() - u.flushedAt);
  if (wait <= 0) return flush(tokenId);
  if (!u.timer) {
    u.timer = setTimeout(() => flush(tokenId), wait);
    u.timer.unref?.();
  }
}
