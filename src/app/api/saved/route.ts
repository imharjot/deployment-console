// Saved views and log queries. GET ?kind=view|log-query → { items } (the caller's own and those shared with the team,
// newest change first; each says `mine` and `canEdit`). POST { kind, name, payload, visibility? } → 201 { item }:
// a view's payload is { path, search, title? }, a log query's { env?, services?, query, minutes }. At most 200 per
// person; sharing with the team is audited. People only.
import { workspaceErrors } from "@/lib/server/dashboards";
import { handle, json, readJson } from "@/lib/server/http";
import { personOf } from "@/lib/server/ops/caller";
import { createSaved, listSaved } from "@/lib/server/workspace";

export const GET = handle(async (req) => json({ items: await listSaved(personOf(req).user, req.nextUrl.searchParams.get("kind")) }));

export const POST = handle(async (req) =>
  workspaceErrors(async () => {
    const c = personOf(req);
    return json({ item: await createSaved(c.user, await readJson(req, 12_000), { ip: c.ip }) }, 201);
  }),
);
