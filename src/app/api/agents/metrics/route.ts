// Agent release metrics (master plan §3.5, AGENT_ARCHITECTURE §9): { since, runs, verifiedCompletion, escalations,
// outcomeUnknown, preventedViolations, duplicateEffects (expected 0), approvalsInvalidated, estimatedCostUsd } plus
// the counts behind them. Over your own runs; admins see every run with ?all=1. ?since=<ms or ISO time> (default 30
// days). People only. A high share of confident answers is not one of them: these count what was verified.
import { HttpError } from "@/lib/server/errors";
import { handle, json, requirePerm } from "@/lib/server/http";
import { runMetrics } from "@/lib/server/agents/runner";
import { personOf } from "@/lib/server/ops/caller";

export const GET = handle(async (req) => {
  const c = personOf(req);
  const q = req.nextUrl.searchParams;
  const all = q.get("all") === "1";
  if (all) requirePerm(c.user, "admin");
  const raw = q.get("since");
  let since: number | undefined;
  if (raw !== null) {
    since = /^\d{1,15}$/.test(raw) ? Number(raw) : Date.parse(raw);
    if (!Number.isFinite(since) || raw.length > 40) throw new HttpError(400, "since must be a time (ms or ISO 8601)");
  }
  return json(await runMetrics({ ...(since !== undefined ? { since } : {}), ...(all ? {} : { initiator: c.user.id }) }));
});
