// One agent run (master plan §3.5; people only): who it acts for and who pays, its scope, policy hash and budget, every
// step, the evidence it gathered (E1… with source and age), its proposals and grants, the operations they became with
// their verification, model-call usage (never transcripts) and the three-part outcome — AI response, AWS acceptance,
// verified health. Visible to the person it acts for, admins and people who could decide its requests (else 404).
// ?evidence=E3 → that piece of evidence with its (redacted, bounded) data.
import { isEvidenceId } from "@/lib/agents/evidence";
import { HttpError } from "@/lib/server/errors";
import { handle, json } from "@/lib/server/http";
import { evidenceData, runDetail } from "@/lib/server/agents/runner";
import { personOf } from "@/lib/server/ops/caller";

export const GET = handle<RouteContext<"/api/agents/runs/[id]">>(async (req, ctx) => {
  const c = personOf(req);
  const id = (await ctx.params).id;
  if (!/^[0-9a-fA-F-]{36}$/.test(id)) throw new HttpError(404, "no such run");
  const e = req.nextUrl.searchParams.get("evidence");
  if (e !== null) {
    if (!isEvidenceId(e)) throw new HttpError(400, "evidence must be a citation id like E3");
    return json({ evidence: await evidenceData(id, e, c.user) });
  }
  return json({ run: await runDetail(id, c.user) });
});
