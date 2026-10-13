// POST { name? } → 201 { dashboard }: a private copy, owned by the caller, of any dashboard they may see (default name
// "Copy of <name>"). Counts toward the caller's 50 dashboards. People only.
import { duplicateDashboard, workspaceErrors } from "@/lib/server/dashboards";
import { handle, json, readJson } from "@/lib/server/http";
import { personOf } from "@/lib/server/ops/caller";

export const POST = handle<RouteContext<"/api/dashboards/[id]/duplicate">>(async (req, ctx) =>
  workspaceErrors(async () => {
    const c = personOf(req);
    const { id } = await ctx.params;
    return json({ dashboard: await duplicateDashboard(c.user, id, await readJson(req, 2_000)) }, 201);
  }),
);
