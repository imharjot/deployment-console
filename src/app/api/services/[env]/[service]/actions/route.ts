import { act } from "@/lib/server/console";
import { envInfo } from "@/lib/server/discovery";
import { envOf, handle, ipOf, json, readJson, requirePerm, userOf } from "@/lib/server/http";

// 202 with { requestId, operationId, verification: "accepted" }: AWS accepted the change; the sampler marks the
// operation verified once the service is steady on the new state (or failed after 15 min).
export const POST = handle<RouteContext<"/api/services/[env]/[service]/actions">>(async (req, ctx) => {
  const user = userOf(req);
  const { env, service } = await ctx.params;
  requirePerm(user, "act", (await envInfo(envOf(env))).protected);
  return json(await act(envOf(env), service, await readJson(req), { display: user.email, kind: "person", userId: user.id }, ipOf(req)), 202);
});
