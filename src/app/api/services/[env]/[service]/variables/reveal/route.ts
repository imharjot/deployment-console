import { revealVars } from "@/lib/server/envvars";
import { envOf, handle, ipOf, json, userOf } from "@/lib/server/http";

// Values, including secrets — POST so it's CSRF-checked and never cached or prefetched; audited by name.
export const POST = handle<RouteContext<"/api/services/[env]/[service]/variables/reveal">>(async (req, ctx) => {
  const user = userOf(req);
  const { env, service } = await ctx.params;
  return json(await revealVars(envOf(env), service, user, ipOf(req)));
});
