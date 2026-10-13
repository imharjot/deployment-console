// Dashboards (docs/dashboards.md). GET → { dashboards, templates }: the caller's own and the team's they have the role
// for (summaries, newest change first) plus the built-in templates. POST { name, description?, visibility?, minRole?,
// template?, widgets? } → 201 { dashboard }. People only: API tokens never reach this route (tokenRoute), and
// personOf() checks again. Problems answer 400 { error, problems }.
import { createDashboard, listDashboards, workspaceErrors } from "@/lib/server/dashboards";
import { handle, json, readJson } from "@/lib/server/http";
import { personOf } from "@/lib/server/ops/caller";

// A dashboard is at most 64 KB as JSON; the cap leaves room for the envelope so the validator can say what's too big.
const BODY_MAX = 72_000;

export const GET = handle(async (req) => json(await listDashboards(personOf(req).user)));

export const POST = handle(async (req) =>
  workspaceErrors(async () => {
    const c = personOf(req);
    return json({ dashboard: await createDashboard(c.user, await readJson(req, BODY_MAX), { ip: c.ip }) }, 201);
  }),
);
