// Workflows (master plan §3.5; people only — the proxy never lets a token reach this). GET → { workflows, templates }:
// each workflow's newest version ({ id, version, name, state, trigger, triggers, scope, hash, publishedAt?, … }) and
// the six templates. POST { template?, name?, draft?, options? } → 201 { workflow, draft, problems }: a new draft from
// a template (options: envs, services, tz, connectionId, notify) or from a given draft. Errors are { error, code? }.
import { HttpError } from "@/lib/server/errors";
import { handle, json, readJson } from "@/lib/server/http";
import { createWorkflow, listWorkflows, templateList } from "@/lib/server/agents/workflows";
import { personOf } from "@/lib/server/ops/caller";

export const GET = handle(async (req) => {
  personOf(req);
  return json({ workflows: await listWorkflows(), templates: templateList() });
});

export const POST = handle(async (req) => {
  const c = personOf(req);
  const b = await readJson(req, 200_000);
  if (!b || typeof b !== "object" || Array.isArray(b)) throw new HttpError(400, "body must be a JSON object");
  return json(await createWorkflow(c.user, b as Record<string, unknown>, c.ip), 201);
});
