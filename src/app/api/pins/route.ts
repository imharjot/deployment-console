// The caller's pinned resources (the stars on panels and the map; the dashboards' "Pinned" widget).
// GET → { pins: { rkey, name, kind, env?, region?, createdAt }[] } newest first; POST { rkey, name, kind, env?, region? }
// → 201 { pin } (pinning again updates it); DELETE ?rkey= → { ok, rkey, removed }. At most 200 per person; never
// audited. People only.
import { workspaceErrors } from "@/lib/server/dashboards";
import { handle, json, readJson } from "@/lib/server/http";
import { personOf } from "@/lib/server/ops/caller";
import { addPin, listPins, removePin } from "@/lib/server/workspace";

export const GET = handle(async (req) => json({ pins: await listPins(personOf(req).user) }));

export const POST = handle(async (req) =>
  workspaceErrors(async () => {
    const c = personOf(req);
    return json({ pin: await addPin(c.user, await readJson(req, 4_000)) }, 201);
  }),
);

export const DELETE = handle(async (req) => {
  const c = personOf(req);
  return json({ ok: true, ...(await removePin(c.user, req.nextUrl.searchParams.get("rkey"))) });
});
