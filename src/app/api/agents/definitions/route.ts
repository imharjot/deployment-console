// Agent definitions (master plan §3.5; people only). GET → { definitions }: the newest version of each
// ({ id, version, name, mode, tools, policyHash, configHash, createdAt, owner }; ?archived=1 includes archived ones),
// then the six built-in templates (builtIn: true, version 0) — every id is a valid definitionId for an agent token.
// POST { name, instructions?, template?, policy?, modelReq? } → 201 { definition } (developers and up; audited).
import { createDefinition, listDefinitions } from "@/lib/server/agents/definitions";
import { handle, json, readJson } from "@/lib/server/http";
import { personOf } from "@/lib/server/ops/caller";

export const GET = handle(async (req) => {
  personOf(req);
  return json({ definitions: await listDefinitions({ archived: req.nextUrl.searchParams.get("archived") === "1" }) });
});

export const POST = handle(async (req) => {
  const c = personOf(req);
  return json({ definition: await createDefinition(c.user, await readJson(req, 100_000), c.ip) }, 201);
});
