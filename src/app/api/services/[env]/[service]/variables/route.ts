import { envInfo } from "@/lib/server/discovery";
import { listVars, saveVars } from "@/lib/server/envvars";
import { envOf, handle, ipOf, json, readJson, requirePerm, userOf } from "@/lib/server/http";

// Names, sources and where each variable lives — never values (see ./reveal).
export const GET = handle<RouteContext<"/api/services/[env]/[service]/variables">>(async (req, ctx) => {
  const user = userOf(req);
  const { env, service } = await ctx.params;
  return json(await listVars(envOf(env), service, user));
});

// Change variables: { revision, confirm, reason?, changes: { plain, secrets, files } } — deploys or restarts.
export const PUT = handle<RouteContext<"/api/services/[env]/[service]/variables">>(async (req, ctx) => {
  const user = userOf(req);
  const { env, service } = await ctx.params;
  requirePerm(user, "env", (await envInfo(envOf(env))).protected);
  return json(await saveVars(envOf(env), service, await readJson(req, 512_000), user, ipOf(req)), 202);
});
