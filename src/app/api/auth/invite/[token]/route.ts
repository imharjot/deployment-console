// Accept an invite or a password-reset link: set the password (and name), end old sessions, sign in.
import { cleanName } from "@/lib/authn";
import { hashPassword, passwordProblem } from "@/lib/password";
import { auditOrFail } from "@/lib/server/auth/audit";
import { loginMethods } from "@/lib/server/auth/config";
import { ipFail, ipWait, limits, retryText } from "@/lib/server/auth/limits";
import { deleteUserSessions } from "@/lib/server/auth/sessions";
import { signIn } from "@/lib/server/auth/signin";
import { redeemLink } from "@/lib/server/auth/tokens";
import { getDb } from "@/lib/server/db";
import { HttpError } from "@/lib/server/errors";
import { handle, ipOf, json, readJson } from "@/lib/server/http";

export const POST = handle<RouteContext<"/api/auth/invite/[token]">>(async (req, ctx) => {
  const { token } = await ctx.params;
  const addr = ipOf(req);
  const wait = ipWait(limits.links, addr, "link|");
  if (wait) throw new HttpError(429, retryText(wait), wait);
  if (!loginMethods().password) throw new HttpError(400, "Password sign-in is disabled on this console. Sign in with SSO instead.");

  const b = await readJson(req);
  const problem = passwordProblem(b.password);
  if (problem) throw new HttpError(400, problem);
  const hash = await hashPassword(b.password);

  const link = await (await getDb()).tx(async (tx) => {
    const l = await redeemLink(token, tx);
    if (!l) {
      ipFail(limits.links, addr, "link|");
      throw new HttpError(410, "This link is invalid, expired or already used. Ask an admin for a new one.");
    }
    await tx.run("UPDATE users SET password_hash = ?, name = COALESCE(?, name) WHERE id = ?", [hash, cleanName(b.name), l.user.id]);
    await deleteUserSessions(l.user.id, undefined, tx);
    await auditOrFail({ action: l.purpose === "invite" ? "user.invite_accepted" : "user.password_reset", actor: l.user.email, target: l.user.email, ip: addr });
    return l;
  });

  return signIn(req, json({ ok: true }), link.user, link.purpose, addr);
});
