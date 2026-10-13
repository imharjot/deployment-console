// Auth and user-admin events in the console audit table (phase "result"). Never pass passwords or tokens here.
import "server-only";
import { writeAudit } from "../audit.ts";

export interface AuthEvent {
  action: string; // auth.login, auth.login_failed, auth.logout, user.invite, user.role, user.disable, user.delete, user.reset, …
  actor: string; // who did it (email); for failed logins, the email that was tried
  target?: string; // affected user's email
  ip?: string;
  params?: Record<string, unknown>;
  result?: "ok" | "error";
  detail?: string;
}

const entry = (e: AuthEvent) => ({
  at: Date.now(),
  phase: "result" as const,
  env: "",
  target: e.target ?? "",
  action: e.action,
  user: e.actor.slice(0, 254),
  ip: e.ip,
  params: e.params ?? {},
  result: e.result ?? ("ok" as const),
  detail: e.detail?.slice(0, 500),
});

// User-admin changes: throws, so the caller's transaction rolls back when the audit row can't be written.
export const auditOrFail = (e: AuthEvent) => writeAudit(entry(e));

// Sign-in events: best effort, a failed audit write must not lock everyone out.
export async function audit(e: AuthEvent) {
  try {
    await writeAudit(entry(e));
  } catch (err) {
    console.error(JSON.stringify({ level: 50, msg: "audit write failed", action: e.action, err: String((err as Error)?.message ?? err) }));
  }
}
