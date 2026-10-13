import { assertRepo, jobLog } from "@/lib/server/ci";
import { handle, json, userOf } from "@/lib/server/http";

export const GET = handle<RouteContext<"/api/ci/jobs/[id]/log">>(async (req, ctx) => {
  userOf(req);
  const { id } = await ctx.params;
  return json(await jobLog(await assertRepo(req.nextUrl.searchParams.get("repo")), Number(id)));
});
