import { revisions } from "@/lib/server/console";
import { envOf, handle, json, userOf } from "@/lib/server/http";

// Each revision with its image check (present / missing / unknown + why, digest, mutable-tag warning) and whether
// database migrations changed against the live one (true / false / "unknown" + why) — R24, F68, F07, R25.
export const GET = handle<RouteContext<"/api/services/[env]/[service]/revisions">>(async (req, ctx) => {
  userOf(req);
  const { env, service } = await ctx.params;
  return json(await revisions(envOf(env), service));
});
