// Users admin: issue a one-time password link (reset, or a fresh invite if they never signed in). Admin role only.
import { resetUser } from "@/lib/server/auth/admin";
import { publicOrigin } from "@/lib/server/auth/config";
import { handle, ipOf, json, requirePerm, userOf } from "@/lib/server/http";

export const POST = handle<RouteContext<"/api/users/[id]/reset">>(async (req, ctx) => {
  const actor = userOf(req);
  requirePerm(actor, "admin");
  const { id } = await ctx.params;
  return json(await resetUser(actor, id, ipOf(req), publicOrigin(req)));
});
