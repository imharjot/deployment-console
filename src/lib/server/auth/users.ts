// Users table access and SSO/ALB provisioning.
import "server-only";
import { provisionDecision } from "../../authn.ts";
import { subjectDecision } from "../../oidc.ts";
import { isRole, type Role, type User } from "../../rbac.ts";
import { getDb, newId, type Db } from "../db.ts";
import { audit } from "./audit.ts";
import { authConfig } from "./config.ts";

export interface UserRow {
  id: string;
  email: string;
  name: string | null;
  role: string;
  password_hash: string | null;
  disabled: number;
  created_at: number;
  last_login_at: number | null;
}

const COLS = "id, email, name, role, password_hash, disabled, created_at, last_login_at";

// An unrecognised role in the DB (hand-edited row) degrades to viewer, never up.
export const toUser = (r: Pick<UserRow, "id" | "email" | "name" | "role">): User => ({ id: r.id, email: r.email, name: r.name, role: isRole(r.role) ? r.role : "viewer" });

const on = async (db?: Db) => db ?? (await getDb());

export async function userByEmail(email: string, db?: Db) {
  return (await on(db)).get<UserRow>(`SELECT ${COLS} FROM users WHERE email = ?`, [email]);
}

export async function userById(id: string, db?: Db) {
  return (await on(db)).get<UserRow>(`SELECT ${COLS} FROM users WHERE id = ?`, [id]);
}

export async function listUsers() {
  return (await getDb()).all<UserRow>(`SELECT ${COLS} FROM users ORDER BY created_at ASC`);
}

export async function countUsers(db?: Db) {
  const r = await (await on(db)).get<{ n: number }>("SELECT COUNT(*) AS n FROM users");
  return Number(r?.n ?? 0);
}

// ON CONFLICT DO NOTHING: concurrent first-boot / first-SSO paths may race on the same email.
export async function createUser(u: { email: string; name?: string | null; role: Role; passwordHash?: string | null }, db?: Db): Promise<UserRow> {
  const d = await on(db);
  await d.run("INSERT INTO users (id, email, name, role, password_hash, disabled, created_at) VALUES (?, ?, ?, ?, ?, 0, ?) ON CONFLICT (email) DO NOTHING", [
    newId(), u.email, u.name ?? null, u.role, u.passwordHash ?? null, Date.now(),
  ]);
  return (await userByEmail(u.email, d))!;
}

export async function touchLogin(id: string) {
  await (await getDb()).run("UPDATE users SET last_login_at = ? WHERE id = ?", [Date.now(), id]);
}

// Active admins, locked on Postgres so two admins demoting each other can't both pass the last-admin check.
export async function activeAdminIds(db: Db): Promise<string[]> {
  const lock = db.kind === "postgres" ? " FOR UPDATE" : "";
  return (await db.all<{ id: string }>(`SELECT id FROM users WHERE role = 'admin' AND disabled = 0${lock}`)).map((r) => r.id);
}

export type Provisioned = { ok: true; row: UserRow } | { ok: false; reason: "disabled" | "denied" };

// SSO / ALB identities: an invited row wins; else auto-create for AUTH_ALLOWED_DOMAINS with AUTH_DEFAULT_ROLE.
export async function provision(email: string, name: string | null, via: "oidc" | "alb", ip?: string): Promise<Provisioned> {
  const cfg = authConfig();
  const row = await userByEmail(email);
  const d = provisionDecision(row, email, cfg.allowedDomains);
  if (d === "use") {
    if (!row!.name && name) await (await getDb()).run("UPDATE users SET name = ? WHERE id = ?", [name, row!.id]);
    return { ok: true, row: row! };
  }
  if (d !== "create") return { ok: false, reason: d };
  const created = await createUser({ email, name, role: cfg.defaultRole });
  await audit({ action: "user.provision", actor: email, target: email, ip, params: { via, role: created.role } });
  return Number(created.disabled) ? { ok: false, reason: "disabled" } : { ok: true, row: created };
}

// F63: bind the account to the SSO subject of its first SSO sign-in, then accept only that subject. The subject never
// leaves this table (it isn't in COLS, so user lists and views don't carry it). A subject already bound to another
// account (the provider changed that person's email) is refused too: an admin deletes or fixes the stale account.
export type SubjectBinding = { ok: true; bound: boolean } | { ok: false; reason: "mismatch" | "taken" };

const isUniqueViolation = (e: unknown) => (e as { code?: string })?.code === "23505" || /UNIQUE constraint failed/i.test(String((e as Error)?.message));

export async function bindSubject(userId: string, sub: string): Promise<SubjectBinding> {
  const db = await getDb();
  const bound = async () => (await db.get<{ oidc_sub: string | null }>("SELECT oidc_sub FROM users WHERE id = ?", [userId]))?.oidc_sub ?? null;
  const d = subjectDecision(await bound(), sub);
  if (d !== "bind") return d === "match" ? { ok: true, bound: false } : { ok: false, reason: "mismatch" };
  let n: number;
  try {
    n = await db.run("UPDATE users SET oidc_sub = ? WHERE id = ? AND oidc_sub IS NULL", [sub, userId]);
  } catch (e) {
    if (isUniqueViolation(e)) return { ok: false, reason: "taken" };
    throw e;
  }
  if (n) return { ok: true, bound: true };
  // Another sign-in to the same account bound a subject first: accept only if it was this one.
  return subjectDecision(await bound(), sub) === "match" ? { ok: true, bound: false } : { ok: false, reason: "mismatch" };
}
