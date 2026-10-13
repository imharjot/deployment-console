// Change your own password (needs the current one). Your other sessions are signed out; this one stays.
// One exception: the local dev user (AUTH_MODE=dev) starts without a password and may set a first one, so switching
// the same data dir to AUTH_MODE=session doesn't lock you out. That password outlives dev mode, so it is only minted for
// a request addressed to a loopback host (F02; the proxy checks this too).
import { hashPassword, passwordProblem, verifyPassword } from "@/lib/password";
import { audit } from "@/lib/server/auth/audit";
import { assertDevLoopback } from "@/lib/server/auth/config";
import { limits, retryText } from "@/lib/server/auth/limits";
import { deleteUserSessions, sessionIdOf } from "@/lib/server/auth/sessions";
import { userById } from "@/lib/server/auth/users";
import { getDb } from "@/lib/server/db";
import { HttpError } from "@/lib/server/errors";
import { handle, ipOf, json, readJson, userOf } from "@/lib/server/http";

export const POST = handle(async (req) => {
  const user = userOf(req);
  const ip = ipOf(req);
  const row = await userById(user.id);
  if (!row) throw new HttpError(401, "not authenticated");
  if (!row.password_hash) {
    if (req.headers.get("x-console-auth-via") !== "dev") throw new HttpError(400, "Your account has no password to change (you sign in with SSO or an invite link).");
    assertDevLoopback(req);
    const b = await readJson(req);
    const problem = passwordProblem(b.next);
    if (problem) throw new HttpError(400, problem);
    await (await getDb()).run("UPDATE users SET password_hash = ? WHERE id = ? AND password_hash IS NULL", [await hashPassword(b.next), user.id]);
    await audit({ action: "auth.password_change", actor: user.email, target: user.email, ip, detail: "first password (dev user)" });
    return json({ ok: true });
  }
  const wait = limits.password.retryIn(user.id);
  if (wait) throw new HttpError(429, retryText(wait), wait);

  const b = await readJson(req);
  // 400, not 401: a wrong current password must not look like an expired session to the client.
  if (typeof b.current !== "string" || !(await verifyPassword(b.current, row.password_hash))) {
    limits.password.fail(user.id);
    await audit({ action: "auth.password_change", actor: user.email, target: user.email, ip, result: "error", detail: "wrong current password" });
    throw new HttpError(400, "Current password is incorrect.");
  }
  const problem = passwordProblem(b.next);
  if (problem) throw new HttpError(400, problem);
  if (b.next === b.current) throw new HttpError(400, "Choose a password different from the current one.");

  limits.password.reset(user.id);
  await (await getDb()).run("UPDATE users SET password_hash = ? WHERE id = ?", [await hashPassword(b.next), user.id]);
  await deleteUserSessions(user.id, sessionIdOf(req) ?? undefined);
  await audit({ action: "auth.password_change", actor: user.email, target: user.email, ip });
  return json({ ok: true });
});
