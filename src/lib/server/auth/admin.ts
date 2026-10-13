// User administration (admin role only; the routes check). Every change is audited inside its transaction and
// never leaves the console without an active admin.
import "server-only";
import { isRole, type Role, type User } from "../../rbac.ts";
import { HttpError } from "../errors.ts";
import { getDb, type Db } from "../db.ts";
import { auditOrFail } from "./audit.ts";
import { loginMethods } from "./config.ts";
import { deleteUserSessions, forgetCachedSessions } from "./sessions.ts";
import { dropLinks, issueLink, type LinkPurpose } from "./tokens.ts";
import { activeAdminIds, createUser, listUsers, userByEmail, userById, type UserRow } from "./users.ts";

export interface UserListItem {
  id: string;
  email: string;
  name: string | null;
  role: Role;
  disabled: boolean;
  hasPassword: boolean;
  invitePending: boolean; // an unused invite link exists and they never signed in
  createdAt: number;
  lastLoginAt: number | null;
}

const item = (r: UserRow, pending: Set<string>): UserListItem => ({
  id: r.id,
  email: r.email,
  name: r.name,
  role: isRole(r.role) ? r.role : "viewer",
  disabled: !!Number(r.disabled),
  hasPassword: !!r.password_hash,
  invitePending: pending.has(r.id) && !r.last_login_at,
  createdAt: Number(r.created_at),
  lastLoginAt: r.last_login_at ? Number(r.last_login_at) : null,
});

async function pendingInvites(): Promise<Set<string>> {
  const rows = await (await getDb()).all<{ user_id: string }>("SELECT user_id FROM tokens WHERE purpose = 'invite' AND used_at IS NULL AND expires_at > ?", [Date.now()]);
  return new Set(rows.map((r) => r.user_id));
}

export async function listUserItems(): Promise<UserListItem[]> {
  const [rows, pending] = await Promise.all([listUsers(), pendingInvites()]);
  return rows.map((r) => item(r, pending));
}

// Would this change leave zero active admins? Checked inside the transaction (rows locked on Postgres).
async function guardLastAdmin(db: Db, row: UserRow, change: string) {
  if (row.role !== "admin" || Number(row.disabled)) return;
  const admins = await activeAdminIds(db);
  if (admins.length <= 1 && admins.includes(row.id)) throw new HttpError(409, `Can't ${change} the last active admin. Make someone else an admin first.`);
}

const linkUrl = (origin: string, token: string) => `${origin}/invite/${token}`;

// Pending approval requests made with someone's API tokens die with their account (their tokens already stop working).
const rejectAgentRequests = (db: Db, userId: string, by: string, why: string) =>
  db.run("UPDATE approvals SET status = 'rejected', decided_at = ?, decided_by = ?, detail = ? WHERE status = 'pending' AND token_id IN (SELECT id FROM api_tokens WHERE user_id = ?)", [Date.now(), by, why, userId]);

export async function inviteUser(actor: User, input: { email: string; role: Role; name: string | null }, ip: string | undefined, origin: string) {
  // Links set a password, so none when password sign-in is off — including behind an ALB, where the load balancer
  // signs people in and an invite is just the users row.
  const withLink = loginMethods().password;
  const db = await getDb();
  const { row, token } = await db.tx(async (tx) => {
    if (await userByEmail(input.email, tx)) throw new HttpError(409, `${input.email} already has an account.`);
    const row = await createUser({ email: input.email, name: input.name, role: input.role }, tx);
    const token = withLink ? await issueLink(row.id, "invite", tx) : null;
    await auditOrFail({ action: "user.invite", actor: actor.email, target: row.email, ip, params: { role: row.role, link: !!token } });
    return { row, token };
  });
  return { user: item(row, new Set(token ? [row.id] : [])), link: token ? linkUrl(origin, token) : null };
}

export async function updateUser(actor: User, id: string, patch: { role?: unknown; disabled?: unknown; name?: string | null }, ip: string | undefined) {
  if (patch.role !== undefined && !isRole(patch.role)) throw new HttpError(400, "role must be viewer, developer, operator or admin");
  if (patch.disabled !== undefined && typeof patch.disabled !== "boolean") throw new HttpError(400, "disabled must be true or false");
  const db = await getDb();
  await db.tx(async (tx) => {
    const row = await userById(id, tx);
    if (!row) throw new HttpError(404, "user not found");
    const base = { actor: actor.email, target: row.email, ip };
    if (isRole(patch.role) && patch.role !== row.role) {
      if (patch.role !== "admin") await guardLastAdmin(tx, row, "demote");
      await tx.run("UPDATE users SET role = ? WHERE id = ?", [patch.role, id]);
      await auditOrFail({ ...base, action: "user.role", params: { from: row.role, to: patch.role } });
    }
    if (typeof patch.disabled === "boolean" && patch.disabled !== !!Number(row.disabled)) {
      if (patch.disabled) await guardLastAdmin(tx, { ...row, role: isRole(patch.role) ? patch.role : row.role }, "disable");
      await tx.run("UPDATE users SET disabled = ? WHERE id = ?", [patch.disabled ? 1 : 0, id]);
      if (patch.disabled) {
        await deleteUserSessions(id, undefined, tx);
        await rejectAgentRequests(tx, id, actor.email, "the token's owner was disabled");
      }
      await auditOrFail({ ...base, action: patch.disabled ? "user.disable" : "user.enable" });
    }
    if (patch.name !== undefined && patch.name !== row.name) {
      await tx.run("UPDATE users SET name = ? WHERE id = ?", [patch.name, id]);
      await auditOrFail({ ...base, action: "user.rename" });
    }
  });
  forgetCachedSessions(); // role changes apply on the very next request
  const [row, pending] = await Promise.all([userById(id), pendingInvites()]);
  return item(row!, pending);
}

export async function deleteUser(actor: User, id: string, ip: string | undefined) {
  const db = await getDb();
  await db.tx(async (tx) => {
    const row = await userById(id, tx);
    if (!row) throw new HttpError(404, "user not found");
    await guardLastAdmin(tx, row, "delete");
    await deleteUserSessions(id, undefined, tx);
    await dropLinks(id, tx);
    await rejectAgentRequests(tx, id, actor.email, "the token's owner was deleted");
    await tx.run("DELETE FROM users WHERE id = ?", [id]);
    await auditOrFail({ action: "user.delete", actor: actor.email, target: row.email, ip, params: { role: row.role } });
  });
  forgetCachedSessions();
}

// New one-time link. For a reset, the old password and every session stop working now: whoever holds the link
// (and only them) sets the next password.
export async function resetUser(actor: User, id: string, ip: string | undefined, origin: string) {
  if (!loginMethods().password) throw new HttpError(400, "Password sign-in is disabled on this console; users sign in with SSO or through the load balancer.");
  const db = await getDb();
  const { token, purpose } = await db.tx(async (tx) => {
    const row = await userById(id, tx);
    if (!row) throw new HttpError(404, "user not found");
    if (Number(row.disabled)) throw new HttpError(409, "Enable the user before issuing a link.");
    const purpose: LinkPurpose = row.password_hash || row.last_login_at ? "reset" : "invite";
    await tx.run("UPDATE users SET password_hash = NULL WHERE id = ?", [id]);
    await deleteUserSessions(id, undefined, tx);
    const token = await issueLink(id, purpose, tx);
    await auditOrFail({ action: purpose === "reset" ? "user.reset" : "user.invite", actor: actor.email, target: row.email, ip, params: { reissue: purpose === "invite" } });
    return { token, purpose };
  });
  forgetCachedSessions();
  return { link: linkUrl(origin, token), purpose };
}
