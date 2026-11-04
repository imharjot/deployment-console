// Your two-step sign-in: new recovery codes, or a new authenticator (then /api/auth/mfa/enroll and /confirm).
// Both need your current password, so an unattended signed-in browser can't take over the second factor.
import { verifyPassword } from "@/lib/password";
import { audit } from "@/lib/server/auth/audit";
import { limits, retryText } from "@/lib/server/auth/limits";
import { mfaRequired, newCodes, startReplace } from "@/lib/server/auth/mfa";
import { userById } from "@/lib/server/auth/users";
import { HttpError } from "@/lib/server/errors";
import { handle, ipOf, json, readJson, userOf } from "@/lib/server/http";

export const POST = handle(async (req) => {
  const user = userOf(req);
  const ip = ipOf(req);
  if (req.headers.get("x-console-auth-via") !== "session") throw new HttpError(400, "Two-step sign-in applies to console password sign-ins.");
  if (!mfaRequired()) throw new HttpError(400, "Two-step sign-in is turned off on this console (CONSOLE_MFA=off).");
  const row = await userById(user.id);
  if (!row?.password_hash) throw new HttpError(400, "Your account has no console password; your identity provider handles two-step sign-in.");
  const wait = limits.password.retryIn(user.id);
  if (wait) throw new HttpError(429, retryText(wait), wait);

  const b = await readJson(req);
  if (typeof b.password !== "string" || !(await verifyPassword(b.password, row.password_hash))) {
    limits.password.fail(user.id);
    await audit({ action: "auth.mfa_settings", actor: user.email, target: user.email, ip, result: "error", detail: "wrong current password" });
    throw new HttpError(400, "Current password is incorrect.");
  }
  limits.password.reset(user.id);
  if (b.action === "recovery-codes") return json({ ok: true, recoveryCodes: await newCodes(row, ip) });
  if (b.action === "replace") return startReplace(req, row);
  throw new HttpError(400, "action must be recovery-codes or replace");
});
