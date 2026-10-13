// Revoke an external agent token (yours, or anyone's for an admin): the token stops at once, its run is cancelled and
// its pending approval requests are rejected.
import { revokeAgentToken } from "@/lib/server/auth/agent-tokens";
import { handle, json } from "@/lib/server/http";
import { personOf } from "@/lib/server/ops/caller";

export const DELETE = handle<RouteContext<"/api/agents/tokens/[id]">>(async (req, ctx) => {
  const c = personOf(req);
  return json({ token: await revokeAgentToken(c.user, (await ctx.params).id, c.ip) });
});
