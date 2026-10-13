// First run: create the first admin with the one-time token printed to the server log. Closed once any user exists.
import { cleanName, normalizeEmail } from "@/lib/authn";
import { hashPassword, passwordProblem } from "@/lib/password";
import { auditOrFail } from "@/lib/server/auth/audit";
import { markHasUsers } from "@/lib/server/auth/bootstrap";
import { authMode } from "@/lib/server/auth/config";
import { ipFail, ipWait, limits, retryText } from "@/lib/server/auth/limits";
import { signIn } from "@/lib/server/auth/signin";
import { checkSetupToken, clearSetupTokens } from "@/lib/server/auth/tokens";
import { countUsers, createUser } from "@/lib/server/auth/users";
import { getDb } from "@/lib/server/db";
import { HttpError } from "@/lib/server/errors";
import { handle, ipOf, json, readJson } from "@/lib/server/http";

export const POST = handle(async (req) => {
  const mode = authMode();
  if (!mode.ok) throw new HttpError(500, mode.error);
  const addr = ipOf(req);
  const wait = ipWait(limits.links, addr, "setup|");
  if (wait) throw new HttpError(429, retryText(wait), wait);

  const b = await readJson(req);
  const email = normalizeEmail(b.email);
  if (!email) throw new HttpError(400, "Enter a valid email address.");
  // Behind an ALB the admin must be the identity the load balancer verified (the proxy passes it on).
  const verified = req.headers.get("x-console-user-verified-email");
  if (mode.mode === "alb" && email !== verified) throw new HttpError(400, `You're signed in to the load balancer as ${verified ?? "nobody"}; the first admin must be that account.`);
  const needPassword = mode.mode !== "alb";
  const problem = needPassword ? passwordProblem(b.password) : null;
  if (problem) throw new HttpError(400, problem);
  const hash = needPassword ? await hashPassword(b.password) : null; // before the transaction: hashing is slow

  const user = await (await getDb()).tx(async (tx) => {
    if ((await countUsers(tx)) > 0) throw new HttpError(409, "Setup is already complete. Sign in instead.");
    if (!(await checkSetupToken(typeof b.token === "string" ? b.token.trim() : b.token, tx))) {
      ipFail(limits.links, addr, "setup|");
      throw new HttpError(403, "That setup token isn't valid. Copy the latest one from the server log.");
    }
    const row = await createUser({ email, name: cleanName(b.name), role: "admin", passwordHash: hash }, tx);
    await clearSetupTokens(tx);
    await auditOrFail({ action: "user.bootstrap", actor: email, target: email, ip: addr, params: { source: "setup" } });
    return row;
  });
  markHasUsers();
  if (mode.mode === "alb") return json({ ok: true }); // the load balancer already signed them in
  return signIn(req, json({ ok: true }), user, "setup", addr);
});
