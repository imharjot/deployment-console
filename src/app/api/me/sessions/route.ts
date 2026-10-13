// Your own sessions: list, revoke one, or revoke every other one.
import { audit } from "@/lib/server/auth/audit";
import { deleteUserSessions, forgetCachedSessions, sessionIdOf, userSessions } from "@/lib/server/auth/sessions";
import { getDb } from "@/lib/server/db";
import { HttpError } from "@/lib/server/errors";
import { handle, ipOf, json, readJson, userOf } from "@/lib/server/http";

export const GET = handle(async (req) => {
  const user = userOf(req);
  return json({ current: sessionIdOf(req), sessions: await userSessions(user.id) });
});

export const POST = handle(async (req) => {
  const user = userOf(req);
  const { revoke } = await readJson(req);
  if (typeof revoke !== "string" || !revoke) throw new HttpError(400, 'revoke must be a session id or "others"');
  const current = sessionIdOf(req);
  if (revoke === "others") {
    await deleteUserSessions(user.id, current ?? undefined);
  } else {
    // Scoped to the caller: a session id of someone else matches nothing.
    const n = await (await getDb()).run("DELETE FROM sessions WHERE id = ? AND user_id = ?", [revoke, user.id]);
    if (!n) throw new HttpError(404, "session not found");
    forgetCachedSessions();
  }
  await audit({ action: "auth.session_revoke", actor: user.email, target: user.email, ip: ipOf(req), params: { which: revoke === "others" ? "others" : revoke === current ? "current" : "one" } });
  return json({ ok: true });
});
