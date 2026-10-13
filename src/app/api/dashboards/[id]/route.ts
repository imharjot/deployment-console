// One dashboard. GET → { dashboard } (404 when it doesn't exist or isn't shared with the caller). PATCH { version, name?,
// description?, visibility?, minRole?, widgets? } → { dashboard }; a stale version → 409 { error, code:
// "version_conflict", version, dashboard } with the current one. DELETE → { ok, id }. Changing or deleting needs the
// owner, or an admin for a team dashboard; sharing changes are audited. People only.
import { deleteDashboard, getDashboard, updateDashboard, workspaceErrors } from "@/lib/server/dashboards";
import { handle, json, readJson } from "@/lib/server/http";
import { personOf } from "@/lib/server/ops/caller";

const BODY_MAX = 72_000;

export const GET = handle<RouteContext<"/api/dashboards/[id]">>(async (req, ctx) => {
  const c = personOf(req);
  const { id } = await ctx.params;
  return json({ dashboard: await getDashboard(c.user, id) });
});

export const PATCH = handle<RouteContext<"/api/dashboards/[id]">>(async (req, ctx) =>
  workspaceErrors(async () => {
    const c = personOf(req);
    const { id } = await ctx.params;
    return json({ dashboard: await updateDashboard(c.user, id, await readJson(req, BODY_MAX), { ip: c.ip }) });
  }),
);

export const DELETE = handle<RouteContext<"/api/dashboards/[id]">>(async (req, ctx) => {
  const c = personOf(req);
  const { id } = await ctx.params;
  return json({ ok: true, ...(await deleteDashboard(c.user, id, { ip: c.ip })) });
});
