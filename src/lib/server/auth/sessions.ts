// DB sessions. The cookie holds a random 32-byte token; the DB holds only sha256(token) as sessions.id,
// so a leaked database or backup can't be replayed as a login.
import "server-only";
import type { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, hashToken, isTokenShape, newToken, renewedExpiry, sessionCookie } from "../../authn.ts";
import type { User } from "../../rbac.ts";
import { getDb, type Db } from "../db.ts";
import { secureRequest } from "./config.ts";
import { toUser } from "./users.ts";

interface Live {
  user: User;
  createdAt: number;
  expiresAt: number;
  cachedAt: number;
}

// ≤5 s lookup cache on globalThis: the proxy and route handlers are separate bundles in one process, and routes must
// be able to drop what the proxy cached (logout, disable, role change). Across instances the 5 s TTL bounds staleness.
const CACHE_MS = 5_000;
const g = globalThis as typeof globalThis & { __consoleSessions?: Map<string, Live>; __consoleAlbUsers?: Map<string, { user: User; at: number }> };
const cache = (g.__consoleSessions ??= new Map<string, Live>());
// ALB mode: verified email → user, same 5 s bound.
export const albCache = (g.__consoleAlbUsers ??= new Map<string, { user: User; at: number }>());
// Any change to a user (role, disable, delete, reset) drops every cached identity — API tokens included, since a
// token's effective role and validity follow its owner (see api-tokens.ts).
export const forgetCachedSessions = () => {
  cache.clear();
  albCache.clear();
  (globalThis as { __consoleApiTokens?: Map<string, unknown> }).__consoleApiTokens?.clear();
};

export async function createSession(userId: string, ttlMs: number, meta: { ip?: string; userAgent?: string | null }, db?: Db): Promise<string> {
  const d = db ?? (await getDb());
  const token = newToken();
  const now = Date.now();
  await d.run("DELETE FROM sessions WHERE expires_at < ?", [now]); // housekeeping; the table stays small
  await d.run("INSERT INTO sessions (id, user_id, created_at, expires_at, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?)", [
    hashToken(token), userId, now, now + ttlMs, meta.ip?.slice(0, 64) ?? null, meta.userAgent?.slice(0, 300) ?? null,
  ]);
  return token;
}

export interface SessionHit {
  user: User;
  id: string;
  renewedUntil?: number; // set when this request extended the session: re-issue the cookie
}

// Valid, unexpired session of an enabled user — with sliding renewal at most every 10 minutes.
export async function lookupSession(token: string | undefined, ttlMs: number): Promise<SessionHit | null> {
  if (!isTokenShape(token)) return null;
  const id = hashToken(token);
  const now = Date.now();
  let live = cache.get(id);
  if (!live || now - live.cachedAt > CACHE_MS || live.expiresAt <= now) {
    const db = await getDb();
    const r = await db.get<{ s_created: number; s_expires: number; id: string; email: string; name: string | null; role: string }>(
      `SELECT s.created_at AS s_created, s.expires_at AS s_expires, u.id, u.email, u.name, u.role
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.id = ? AND s.expires_at > ? AND u.disabled = 0`,
      [id, now],
    );
    if (!r) {
      cache.delete(id);
      return null;
    }
    live = { user: toUser(r), createdAt: Number(r.s_created), expiresAt: Number(r.s_expires), cachedAt: now };
    cache.set(id, live);
    if (cache.size > 5_000) for (const [k, v] of cache) if (now - v.cachedAt > CACHE_MS) cache.delete(k);
  }
  const next = renewedExpiry(live, now, ttlMs);
  if (!next) return { user: live.user, id };
  await (await getDb()).run("UPDATE sessions SET expires_at = ? WHERE id = ?", [next, id]);
  live.expiresAt = next;
  return { user: live.user, id, renewedUntil: next };
}

export async function deleteSession(id: string) {
  cache.delete(id);
  await (await getDb()).run("DELETE FROM sessions WHERE id = ?", [id]);
}

// Disable, password reset, delete: every session of the user ends now (optionally keeping the caller's own).
export async function deleteUserSessions(userId: string, keepId?: string, db?: Db) {
  forgetCachedSessions();
  const d = db ?? (await getDb());
  if (keepId) await d.run("DELETE FROM sessions WHERE user_id = ? AND id <> ?", [userId, keepId]);
  else await d.run("DELETE FROM sessions WHERE user_id = ?", [userId]);
}

export interface SessionInfo {
  id: string;
  createdAt: number;
  expiresAt: number;
  ip: string | null;
  userAgent: string | null;
}

export async function userSessions(userId: string): Promise<SessionInfo[]> {
  const rows = await (await getDb()).all<{ id: string; created_at: number; expires_at: number; ip: string | null; user_agent: string | null }>(
    "SELECT id, created_at, expires_at, ip, user_agent FROM sessions WHERE user_id = ? AND expires_at > ? ORDER BY created_at DESC",
    [userId, Date.now()],
  );
  return rows.map((r) => ({ id: r.id, createdAt: Number(r.created_at), expiresAt: Number(r.expires_at), ip: r.ip, userAgent: r.user_agent }));
}

// The caller's own session id (hash of their cookie), for "this device" and logout.
export function sessionIdOf(req: NextRequest): string | null {
  const t = req.cookies.get(SESSION_COOKIE)?.value;
  return isTokenShape(t) ? hashToken(t) : null;
}

export function setSessionCookie(res: NextResponse, req: NextRequest, token: string, ttlMs: number) {
  res.cookies.set(sessionCookie(token, secureRequest(req), ttlMs));
}

export function clearSessionCookie(res: NextResponse, req: NextRequest) {
  res.cookies.set(sessionCookie("", secureRequest(req), 0));
}
