// One note. PATCH { body?, tags?, pinned? } → { note }; DELETE → { ok, id }. Only the author or an admin, and both
// need the `notes` permission; every change is audited without the body.
import { handle, json, readJson } from "@/lib/server/http";
import { deleteNote, updateNote } from "@/lib/server/notes";
import { personOf } from "@/lib/server/ops/caller";

export const PATCH = handle<RouteContext<"/api/notes/[id]">>(async (req, ctx) => {
  const c = personOf(req);
  const { id } = await ctx.params;
  return json({ note: await updateNote(c.user, id, await readJson(req, 64_000), { ip: c.ip }) });
});

export const DELETE = handle<RouteContext<"/api/notes/[id]">>(async (req, ctx) => {
  const c = personOf(req);
  const { id } = await ctx.params;
  return json({ ok: true, ...(await deleteNote(c.user, id, { ip: c.ip })) });
});
