// One saved view or log query. GET → { item }; PATCH { name?, payload?, visibility? } → { item }; DELETE → { ok, id }.
// Changing or deleting needs the owner, or an admin for an item shared with the team; visibility changes are audited.
// People only.
import { workspaceErrors } from "@/lib/server/dashboards";
import { handle, json, readJson } from "@/lib/server/http";
import { personOf } from "@/lib/server/ops/caller";
import { deleteSaved, getSaved, updateSaved } from "@/lib/server/workspace";

export const GET = handle<RouteContext<"/api/saved/[id]">>(async (req, ctx) => {
  const c = personOf(req);
  const { id } = await ctx.params;
  return json({ item: await getSaved(c.user, id) });
});

export const PATCH = handle<RouteContext<"/api/saved/[id]">>(async (req, ctx) =>
  workspaceErrors(async () => {
    const c = personOf(req);
    const { id } = await ctx.params;
    return json({ item: await updateSaved(c.user, id, await readJson(req, 12_000), { ip: c.ip }) });
  }),
);

export const DELETE = handle<RouteContext<"/api/saved/[id]">>(async (req, ctx) => {
  const c = personOf(req);
  const { id } = await ctx.params;
  return json({ ok: true, ...(await deleteSaved(c.user, id, { ip: c.ip })) });
});
