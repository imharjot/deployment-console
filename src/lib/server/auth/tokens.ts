// One-time links (invite, password reset) and the first-run setup token. Only sha256(token) is stored.
import "server-only";
import { hashToken, isTokenShape, newToken } from "../../authn.ts";
import { getDb, type Db } from "../db.ts";
import type { UserRow } from "./users.ts";

export type LinkPurpose = "invite" | "reset";
const LINK_TTL_MS = 7 * 24 * 3_600_000;

// One live link per user: issuing a new one voids any earlier unused link.
export async function issueLink(userId: string, purpose: LinkPurpose, db?: Db): Promise<string> {
  const d = db ?? (await getDb());
  const token = newToken();
  const now = Date.now();
  await d.run("DELETE FROM tokens WHERE (user_id = ? AND used_at IS NULL) OR expires_at < ?", [userId, now - LINK_TTL_MS]);
  await d.run("INSERT INTO tokens (id, user_id, purpose, expires_at) VALUES (?, ?, ?, ?)", [hashToken(token), userId, purpose, now + LINK_TTL_MS]);
  return token;
}

export interface LinkInfo {
  purpose: LinkPurpose;
  user: UserRow;
  expiresAt: number;
}

// Read-only check for the invite page. Unused, unexpired, and the user still exists and is enabled.
export async function peekLink(token: string): Promise<LinkInfo | null> {
  if (!isTokenShape(token)) return null;
  const r = await (await getDb()).get<UserRow & { purpose: string; t_expires: number }>(
    `SELECT t.purpose, t.expires_at AS t_expires, u.id, u.email, u.name, u.role, u.password_hash, u.disabled, u.created_at, u.last_login_at
       FROM tokens t JOIN users u ON u.id = t.user_id
      WHERE t.id = ? AND t.used_at IS NULL AND t.expires_at > ? AND u.disabled = 0`,
    [hashToken(token), Date.now()],
  );
  if (!r || (r.purpose !== "invite" && r.purpose !== "reset")) return null;
  const { purpose, t_expires, ...user } = r;
  return { purpose, user, expiresAt: Number(t_expires) };
}

// Atomic single use: of two concurrent redemptions exactly one UPDATE changes a row.
export async function redeemLink(token: string, db: Db): Promise<LinkInfo | null> {
  const info = await peekLink(token);
  if (!info) return null;
  const n = await db.run("UPDATE tokens SET used_at = ? WHERE id = ? AND used_at IS NULL AND expires_at > ?", [Date.now(), hashToken(token), Date.now()]);
  return n === 1 ? info : null;
}

export async function dropLinks(userId: string, db?: Db) {
  await (db ?? (await getDb())).run("DELETE FROM tokens WHERE user_id = ?", [userId]);
}

// ---------- first-run setup token (settings table) ----------

const SETUP_PREFIX = "setup_token:";
const SETUP_TTL_MS = 24 * 3_600_000;

export async function liveSetupToken(db?: Db): Promise<boolean> {
  const d = db ?? (await getDb());
  const rows = await d.all<{ value: string }>("SELECT value FROM settings WHERE key LIKE ?", [`${SETUP_PREFIX}%`]);
  return rows.some((r) => Number(r.value) > Date.now());
}

// Each instance/boot may add its own token; any printed, unexpired one works until setup completes.
export async function newSetupToken(): Promise<string> {
  const token = newToken();
  await (await getDb()).run("INSERT INTO settings (key, value) VALUES (?, ?)", [`${SETUP_PREFIX}${hashToken(token)}`, String(Date.now() + SETUP_TTL_MS)]);
  return token;
}

export async function checkSetupToken(token: unknown, db: Db): Promise<boolean> {
  if (!isTokenShape(token)) return false;
  const r = await db.get<{ value: string }>("SELECT value FROM settings WHERE key = ?", [`${SETUP_PREFIX}${hashToken(token)}`]);
  return !!r && Number(r.value) > Date.now();
}

export async function clearSetupTokens(db: Db) {
  await db.run("DELETE FROM settings WHERE key LIKE ?", [`${SETUP_PREFIX}%`]);
}
