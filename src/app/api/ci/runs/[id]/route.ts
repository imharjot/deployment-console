import { assertRepo, runDetail } from "@/lib/server/ci";
import { handle, json, userOf } from "@/lib/server/http";

export const GET = handle<RouteContext<"/api/ci/runs/[id]">>(async (req, ctx) => {
  userOf(req);
  const { id } = await ctx.params;
  return json(await runDetail(await assertRepo(req.nextUrl.searchParams.get("repo")), Number(id)));
});
