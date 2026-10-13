// One agent definition (master plan §3.5; people only). GET → { definition, versions } (the newest in full: its
// instructions, policy and model requirements). PATCH { action: "save", name?, instructions?, template?, policy?,
// modelReq? } → { definition } — a new immutable version (tokens already bound keep theirs); PATCH { action: "archive" }
// → { definition }: no new tokens from it. Only its owner or an admin changes it; built-in templates can't be changed.
import { archiveDefinition, getDefinition, saveDefinition } from "@/lib/server/agents/definitions";
import { HttpError } from "@/lib/server/errors";
import { handle, json, readJson } from "@/lib/server/http";
import { personOf } from "@/lib/server/ops/caller";

export const GET = handle<RouteContext<"/api/agents/definitions/[id]">>(async (req, ctx) => {
  personOf(req);
  return json(await getDefinition((await ctx.params).id));
});

export const PATCH = handle<RouteContext<"/api/agents/definitions/[id]">>(async (req, ctx) => {
  const c = personOf(req);
  const id = (await ctx.params).id;
  const b = (await readJson(req, 100_000)) as Record<string, unknown>;
  if (!b || typeof b !== "object" || Array.isArray(b)) throw new HttpError(400, "body must be a JSON object");
  const action = Object.hasOwn(b, "action") ? b.action : undefined;
  if (action === "archive") return json({ definition: await archiveDefinition(c.user, id, c.ip) });
  if (action !== "save") throw new HttpError(400, 'action must be "save" or "archive"');
  return json({ definition: await saveDefinition(c.user, id, b, c.ip) });
});
