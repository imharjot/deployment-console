import { events } from "@/lib/server/console";
import { envOf, handle, json, userOf } from "@/lib/server/http";

// Newest first, at most 100 (F11: ECS keeps more, the panel needs the recent ones).
export const GET = handle<RouteContext<"/api/services/[env]/[service]/events">>(async (req, ctx) => {
  userOf(req);
  const { env, service } = await ctx.params;
  return json((await events(envOf(env), service)).slice(0, 100));
});
