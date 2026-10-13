import { parseRerunBody, rerunCiRun } from "@/lib/server/ci";
import { handle, ipOf, json, readJson, userOf } from "@/lib/server/http";

// Body { mode?: "tests" | "redeploy", confirm?, reason? }. Without confirm: the plan (where it deploys, what to type).
// With it: the re-run, through the mutation coordinator (202).
export const POST = handle<RouteContext<"/api/ci/runs/[id]/rerun">>(async (req, ctx) => {
  const user = userOf(req);
  const { id } = await ctx.params;
  const body = parseRerunBody(await readJson(req));
  const r = await rerunCiRun(Number(id), { repo: req.nextUrl.searchParams.get("repo") ?? "", ...body }, user, ipOf(req));
  return "result" in r ? json(r.result, 202) : json(r);
});
