import { handle, json, userOf } from "@/lib/server/http";
import { insightsResults } from "@/lib/server/logs";

// Only a query this console started, to the person who started it or an admin.
export const GET = handle<RouteContext<"/api/logs/insights/[id]">>(async (req, ctx) => {
  return json(await insightsResults((await ctx.params).id, userOf(req)));
});
