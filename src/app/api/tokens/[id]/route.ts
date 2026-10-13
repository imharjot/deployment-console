// Revoke a token (your own, or anyone's as an admin). Its pending approval requests are rejected with it.
import { revokeToken } from "@/lib/server/auth/api-tokens";
import { handle, json } from "@/lib/server/http";
import { personOf } from "@/lib/server/ops/caller";

export const DELETE = handle<RouteContext<"/api/tokens/[id]">>(async (req, ctx) => {
  const c = personOf(req);
  return json({ token: await revokeToken(c.user, (await ctx.params).id, c.ip) });
});
