// One workflow (master plan §3.5; people only). GET → { workflow, draft, versions, problems, frozen? }. PATCH
// { action, … }:
//   save    { draft }          edit the draft (or start the next version's draft) → { workflow, draft, problems }
//   preview                    → { trigger, resources, excluded, steps, limits, approvals, destination, payer, mode,
//                                  hash, previewHash } — what activation would do; 400 { error, problems } when invalid
//   publish { previewHash }    activate the draft exactly as previewed → { workflow, preview } (409 preview_changed)
//   disable                    every version off; schedules stop, runs end at their next step → { workflow }
//   review  { runId, decision: "continue" | "cancel" }  answer a run paused for review → { runId, decision }
//   run     { inputs?, resourceKey? }   start the published version by hand, with your rights → { runId }
import { HttpError, errorBody } from "@/lib/server/errors";
import { handle, json, readJson } from "@/lib/server/http";
import { disableWorkflow, getWorkflow, previewWorkflow, publishWorkflow, reviewRun, saveDraft, startManualRun } from "@/lib/server/agents/workflows";
import { personOf } from "@/lib/server/ops/caller";

export const GET = handle<RouteContext<"/api/agents/workflows/[id]">>(async (req, ctx) => {
  personOf(req);
  return json(await getWorkflow((await ctx.params).id));
});

export const PATCH = handle<RouteContext<"/api/agents/workflows/[id]">>(async (req, ctx) => {
  const c = personOf(req);
  const id = (await ctx.params).id;
  const b = (await readJson(req, 200_000)) as Record<string, unknown>;
  if (!b || typeof b !== "object" || Array.isArray(b)) throw new HttpError(400, "body must be a JSON object");
  const own = (k: string) => (Object.hasOwn(b, k) ? b[k] : undefined);
  try {
    switch (own("action")) {
      case "save":
        return json(await saveDraft(c.user, id, own("draft"), c.ip));
      case "preview":
        return json(await previewWorkflow(c.user, id));
      case "publish":
        return json(await publishWorkflow(c.user, id, own("previewHash"), c.ip));
      case "disable":
        return json({ workflow: await disableWorkflow(c.user, id, c.ip) });
      case "review":
        return json(await reviewRun(c.user, id, own("runId"), own("decision"), c.ip));
      case "run": {
        const key = own("resourceKey");
        if (key !== undefined && (typeof key !== "string" || key.length > 2048)) throw new HttpError(400, "resourceKey must be a resource key");
        return json({ runId: await startManualRun(c.user, id, own("inputs"), key as string | undefined) }, 201);
      }
      default:
        throw new HttpError(400, 'action must be "save", "preview", "publish", "disable", "review" or "run"');
    }
  } catch (e) {
    // A workflow that can't be activated answers with its list of problems, so the editor can show each one.
    const problems = (e as { problems?: unknown }).problems;
    if (e instanceof HttpError && Array.isArray(problems)) return json({ ...errorBody(e), problems }, e.status);
    throw e;
  }
});
