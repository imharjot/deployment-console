// Users admin: change role / enable / disable / rename, or delete. Admin role only; never leaves zero active admins.
import { cleanName } from "@/lib/authn";
import { deleteUser, updateUser } from "@/lib/server/auth/admin";
import { handle, ipOf, json, readJson, requirePerm, userOf } from "@/lib/server/http";

export const PATCH = handle<RouteContext<"/api/users/[id]">>(async (req, ctx) => {
  const actor = userOf(req);
  requirePerm(actor, "admin");
  const { id } = await ctx.params;
  const b = await readJson(req);
  return json(await updateUser(actor, id, { role: b.role, disabled: b.disabled, name: b.name === undefined ? undefined : cleanName(b.name) }, ipOf(req)));
});

export const DELETE = handle<RouteContext<"/api/users/[id]">>(async (req, ctx) => {
  const actor = userOf(req);
  requirePerm(actor, "admin");
  const { id } = await ctx.params;
  await deleteUser(actor, id, ipOf(req));
  return json({ ok: true });
});
