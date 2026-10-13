// Sign out: the session row is deleted (so the cookie is dead even if a copy survives) and the cookie cleared.
import { audit } from "@/lib/server/auth/audit";
import { clearSessionCookie, deleteSession, sessionIdOf } from "@/lib/server/auth/sessions";
import { handle, ipOf, json } from "@/lib/server/http";

export const POST = handle(async (req) => {
  const id = sessionIdOf(req);
  const email = req.headers.get("x-console-user-email"); // set by the proxy when the session was still valid
  if (id) await deleteSession(id);
  if (email && req.headers.get("x-console-auth-via") === "session") await audit({ action: "auth.logout", actor: email, target: email, ip: ipOf(req) });
  const res = json({ ok: true });
  clearSessionCookie(res, req);
  return res;
});
