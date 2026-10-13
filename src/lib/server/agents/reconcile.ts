// Agent run reconciliation (master plan §6 C2 items 3 and 7; AGENT_ARCHITECTURE §4): what to do with work a worker
// stopped doing. At boot (after the mutation coordinator's own reconcileOnBoot) and every 30 s from the worker loop:
//
// - A step whose lease expired:
//   - an execute step is settled through `operations` (settleExecute, run-state.ts), never retried blindly: no
//     operation recorded → nothing reached AWS, it is requeued; succeeded → the step succeeded; failed → failed; still
//     running or outcome unknown → the step becomes outcome_unknown and the run waits on the world (waiting_external).
//     Whenever the operation records (not the handler) settle an execute step, a verify step is queued: the handler
//     that would have said what comes next never returned, and an accepted change is not yet a healthy one;
//   - any other retry-safe step is requeued; the rest fail ("the worker stopped while this step ran");
//   - a step whose worker stopped MAX_ATTEMPTS times is not requeued again (it fails): a step that takes its worker
//     down with it must not do so forever.
//   Every change bumps the fence, so the stalled worker's late write is rejected.
// - A run whose deadline passed fails ("deadline exceeded"); an external agent's run is cancelled when its token's
//   time is up. Its queued steps are cancelled (verify steps keep going: an accepted change keeps being checked).
// - Queued steps of a run that ended some other way (cancelled by a person, failed by the runner) are cancelled too.
import "server-only";
import { MAX_ATTEMPTS, canTransitionRun, isFinalRun, settleExecute, type ExecuteSettlement } from "../../agents/run-state.ts";
import type { AgentRunRow, AgentStepRow, RunState } from "../../agents/records.ts";
import { getDb, type Db } from "../db.ts";
import { errText } from "../errors.ts";
import { publishSafe } from "./events.ts";
import { appendStep, normStep, stepEvent, updateRun } from "./store.ts";

export interface ReconcileReport {
  requeued: number;
  settled: number;
  unknown: number;
  failed: number;
  expiredRuns: number;
  orphaned: number; // queued steps of runs that had ended
}

const log = (msg: string, extra: Record<string, unknown>) => console.error(JSON.stringify({ level: 50, msg, ...extra }));

export async function reconcileAgents(now = Date.now()): Promise<ReconcileReport> {
  const out: ReconcileReport = { requeued: 0, settled: 0, unknown: 0, failed: 0, expiredRuns: 0, orphaned: 0 };
  const db = await getDb();
  const stale = (await db.all<AgentStepRow>("SELECT * FROM agent_steps WHERE state = 'leased' AND lease_until < ? ORDER BY lease_until LIMIT 200", [now])).map(normStep);
  for (const s of stale) {
    try {
      await settleExpired(s, now, out);
    } catch (e) {
      log("agent step reconciliation failed", { step: s.id, err: errText(e) });
    }
  }
  const overdue = await db.all<Pick<AgentRunRow, "id" | "kind" | "state">>(
    `SELECT id, kind, state FROM agent_runs WHERE deadline_at IS NOT NULL AND deadline_at < ?
       AND state NOT IN ('succeeded', 'failed', 'cancelled', 'outcome_unknown') LIMIT 200`,
    [now],
  );
  for (const r of overdue) {
    const to: RunState = r.kind === "external" ? "cancelled" : "failed";
    if (!canTransitionRun(r.state, to)) continue;
    try {
      // updateRun ends the run and its unstarted steps together (verify steps go on).
      await updateRun(r.id, { state: to, error: r.kind === "external" ? "the agent token's time is up" : "deadline exceeded" }, { from: [r.state] });
      out.expiredRuns++;
    } catch {
      // changed meanwhile: the next pass looks again
    }
  }
  out.orphaned = await cancelOrphans(now);
  return out;
}

// Steps still waiting to start in runs that ended (verify steps excepted) — appended after the end, or left by an
// older version. The worker never claims them anyway; this makes the timeline say so.
async function cancelOrphans(now: number): Promise<number> {
  const db = await getDb();
  const rows = (
    await db.all<AgentStepRow>(
      `SELECT s.* FROM agent_steps s JOIN agent_runs r ON r.id = s.run_id
        WHERE s.state IN ('queued', 'waiting') AND s.kind <> 'verify' AND r.state IN ('succeeded', 'failed', 'cancelled', 'outcome_unknown') LIMIT 200`,
    )
  ).map(normStep);
  let n = 0;
  for (const s of rows) {
    if ((await db.run("UPDATE agent_steps SET state = 'cancelled', error = ?, updated_at = ? WHERE id = ? AND state IN ('queued', 'waiting')", ["the run ended", now, s.id])) !== 1) continue;
    n++;
    publishSafe("step", stepEvent({ ...s, state: "cancelled", updated_at: now }), { runId: s.run_id });
  }
  return n;
}

// ---------- execute steps and their operations ----------

// The operations an execute step started: the registry runs a step's change with the step id in its mutation context
// and the idempotency key `run:<run>:step:<step>` (each mutate() adds `|<action>|<keys>`), so either finds them.
export async function operationsOfStep(s: Pick<AgentStepRow, "id" | "run_id">, db?: Db): Promise<{ id: string; state: string; error: string | null }[]> {
  const prefix = `run:${s.run_id}:step:${s.id}|`;
  return (db ?? (await getDb())).all<{ id: string; state: string; error: string | null }>(
    "SELECT id, state, error FROM operations WHERE run_id = ? AND (step_id = ? OR substr(idempotency_key, 1, ?) = ?) ORDER BY created_at",
    [s.run_id, s.id, prefix.length, prefix],
  );
}

export async function settlementOf(s: Pick<AgentStepRow, "id" | "run_id">, db?: Db): Promise<{ settle: ExecuteSettlement; operationId?: string; error?: string }> {
  const ops = await operationsOfStep(s, db);
  const settle = settleExecute(ops.map((o) => o.state));
  // The operation that decides it: the one in doubt, else the failed one, else the newest.
  const pick = ops.find((o) => o.state !== "succeeded" && o.state !== "failed" && o.state !== "cancelled") ?? ops.find((o) => o.state !== "succeeded") ?? ops[ops.length - 1];
  return { settle, operationId: pick?.id, error: pick?.error ?? undefined };
}

// After an execute step's outcome became unknown (or the operation records settled it): the run waits on the world,
// and a verify step will check the resource. Call inside the transaction that recorded the step.
export async function followUpExecute(tx: Db, s: Pick<AgentStepRow, "id" | "run_id" | "name">, o: { operationId?: string; unknown: boolean; verify?: boolean }): Promise<void> {
  if (o.unknown) {
    const run = await tx.get<{ state: RunState }>("SELECT state FROM agent_runs WHERE id = ?", [s.run_id]);
    if (run && !isFinalRun(run.state) && run.state !== "waiting_external" && canTransitionRun(run.state, "waiting_external"))
      await updateRun(s.run_id, { state: "waiting_external" }, { from: [run.state] }).catch(() => {});
  }
  if (o.verify !== false)
    await appendStep(s.run_id, { kind: "verify", name: `verify ${s.name ?? "change"}`.slice(0, 200), input: { operationId: o.operationId ?? null, stepId: s.id }, retrySafe: true }, tx);
}

const FENCED = (set: string) =>
  `UPDATE agent_steps SET ${set}, fence = fence + 1, lease_owner = NULL, lease_until = NULL, updated_at = ? WHERE id = ? AND fence = ? AND state = 'leased'`;

async function settleExpired(s: AgentStepRow, now: number, out: ReconcileReport) {
  const db = await getDb();
  const event = (state: string) => publishSafe("step", { ...stepEvent({ ...s, state: state as AgentStepRow["state"], updated_at: now }), reconciled: true }, { runId: s.run_id });
  // A step whose worker stopped MAX_ATTEMPTS times (one that takes its worker down with it, say) isn't tried again.
  const tooMany = s.attempt >= MAX_ATTEMPTS;
  if (s.kind !== "execute") {
    const requeue = !!s.retry_safe && !tooMany;
    const n = requeue
      ? await db.run(FENCED("state = 'queued', wake_at = NULL"), [now, s.id, s.fence])
      : await db.run(FENCED("state = 'failed', error = ?"), [`the worker stopped while this step ran${tooMany ? ` (${s.attempt} times)` : ""}`, now, s.id, s.fence]);
    if (n !== 1) return;
    if (requeue) out.requeued++;
    else out.failed++;
    return event(requeue ? "queued" : "failed");
  }
  // An execute step: what do the coordinator's records say about its change?
  const { settle, operationId, error } = await settlementOf(s, db);
  if (settle === "none") {
    // No operation row means no audit intent was committed, so nothing reached AWS: running it again is safe (and
    // can't run the change twice: a grant is single use, and the operation's idempotency key is unique).
    if (tooMany) {
      if ((await db.run(FENCED("state = 'failed', error = ?"), [`the worker stopped ${s.attempt} times before the change was submitted — not trying again`, now, s.id, s.fence])) !== 1) return;
      out.failed++;
      return event("failed");
    }
    if ((await db.run(FENCED("state = 'queued', wake_at = NULL, error = ?"), ["requeued: the worker stopped before the change was submitted", now, s.id, s.fence])) !== 1) return;
    out.requeued++;
    return event("queued");
  }
  const [state, set, args]: [string, string, unknown[]] =
    settle === "succeeded" ? ["succeeded", "state = 'succeeded', operation_id = ?, result = ?", [operationId, JSON.stringify({ operationId, reconciled: true })]]
    : settle === "failed" ? ["failed", "state = 'failed', operation_id = ?, error = ?", [operationId, `the change failed (operation ${operationId})${error ? `: ${error.slice(0, 300)}` : ""}`]]
    : ["outcome_unknown", "state = 'outcome_unknown', operation_id = ?, error = ?", [operationId, "the worker stopped after the change was submitted — verifying"]];
  // The step, the run and the verify step move together: a crash in between can't leave an unknown outcome unchecked.
  const moved = await db.tx(async (tx) => {
    if ((await tx.run(FENCED(set), [...args, now, s.id, s.fence])) !== 1) return false;
    await followUpExecute(tx, s, { operationId, unknown: settle === "unknown" });
    return true;
  });
  if (!moved) return;
  if (settle === "unknown") out.unknown++;
  else out.settled++;
  event(state);
}
