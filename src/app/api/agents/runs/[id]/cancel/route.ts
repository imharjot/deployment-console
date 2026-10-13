// Stop an agent run (master plan §3.5; the person it acts for, or an admin). No new step starts, its model call or CLI
// stops, its waiting approval requests are withdrawn and its run token dies. A change AWS already accepted (or may
// have) keeps being reconciled and verified — the answer and the run say so (`verifying`, `note`).
import { HttpError } from "@/lib/server/errors";
import { handle, json } from "@/lib/server/http";
import { cancelRun } from "@/lib/server/agents/runner";
import { getRun } from "@/lib/server/agents/store";
import { personOf } from "@/lib/server/ops/caller";

export const POST = handle<RouteContext<"/api/agents/runs/[id]/cancel">>(async (req, ctx) => {
  const c = personOf(req);
  const id = (await ctx.params).id;
  if (!/^[0-9a-fA-F-]{36}$/.test(id)) throw new HttpError(404, "no such run");
  const run = await getRun(id);
  if (!run) throw new HttpError(404, "no such run");
  if (run.initiator_id !== c.user.id && c.user.role !== "admin") throw new HttpError(403, "only the person a run acts for, or an admin, can stop it");
  return json(await cancelRun(id, c.user, { ip: c.ip }));
});
