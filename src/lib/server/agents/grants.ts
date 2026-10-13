// Exact-plan approval grants for agents (master plan §3.4 / §6 C1 items 4–5, AGENT_ARCHITECTURE §6 "Approval").
//
// When the policy says a person must decide, the registry calls requestGrant(): an `approval_grants` row binds the run,
// step, principal, operation, resolved targets, input hash and plan hash (secrets HMAC'd, src/lib/plan-hash.ts), the
// policy hash and an expiry; an `approvals` row (with run_id, grant_id, plan_hash) puts it in front of people. A person
// decides with decideGrant() — the change does NOT run as the approver: an approval enqueues the run's `execute` step,
// and the worker runs it as the agent principal, which must present the grant. verifyAndConsumeGrant() is a single
// conditional UPDATE (single use), and refuses — invalidating the grant — when anything bound changed: the plan
// (targets, digest, consumers, preconditions), the input, the principal or the policy. Expired grants are refused too.
import "server-only";
import { withoutHumanFields } from "../../agents/identity.ts";
import { isFinalRun } from "../../agents/run-state.ts";
import type { ApprovalGrantRow } from "../../agents/records.ts";
import type { AgentPolicy, AgentPrincipal } from "../../agents/types.ts";
import { APPROVAL_TTL_MS } from "../../automation.ts";
import { inputHash, planHash } from "../../plan-hash.ts";
import type { User } from "../../rbac.ts";
import { writeAudit } from "../audit.ts";
import { getDb, newId, type Db } from "../db.ts";
import { HttpError, errText } from "../errors.ts";
import type { Plan } from "../ops/types.ts";
import { getApproval, publishApproval, type ApprovalRow } from "../ops/approvals.ts";
import { derivedKey, seal, unseal } from "../secrets.ts";
import { publish } from "./events.ts";
import { policyForRun } from "./principals.ts";
import { queueOutbox } from "./outbox.ts";
import { getRun, updateRun } from "./store.ts";
import { enqueueStep } from "./worker.ts";

export const MAX_PENDING_GRANTS_PER_RUN = 20;
const coded = (status: number, message: string, code: string) => Object.assign(new HttpError(status, message), { code });
const hmacKey = () => derivedKey("plan-hash").toString("hex");

// ---------- hashes ----------

export interface GrantSubject {
  op: string;
  secretFields?: string[];
  input: Record<string, unknown>;
  plan: Plan;
  targets: string[]; // resolved target keys
}

// What a grant binds. Human-only fields (confirm, migrationAck, reason) are left out: the approver's replace them.
export function grantHashes(s: GrantSubject): { inputHash: string; planHash: string } {
  const input = withoutHumanFields(s.input);
  const key = hmacKey();
  return {
    inputHash: inputHash(input, s.secretFields ?? [], key),
    planHash: planHash({ op: s.op, targets: s.targets, input, secretFields: s.secretFields ?? [], changes: s.plan.changes, preconditions: { confirm: s.plan.confirm ?? null, echo: s.plan.echo ?? null } }, key),
  };
}

// ---------- request ----------

export interface GrantRequest {
  principal: AgentPrincipal;
  op: string;
  input: Record<string, unknown>;
  plan: Plan;
  targets: string[];
  env?: string;
  runId: string;
  stepId?: string;
  policy?: AgentPolicy; // the run's (read from the run, hash-checked, when not given)
  secretFields?: string[];
  protected?: boolean;
}

export interface GrantTicket {
  approvalId: string;
  grantId: string;
  planHash: string;
  expiresAt: number;
  duplicate?: boolean;
}

export async function requestGrant(r: GrantRequest): Promise<GrantTicket> {
  if (r.principal.runId !== r.runId) throw coded(409, "the principal doesn't belong to this run", "principal_mismatch");
  const run = await getRun(r.runId);
  if (!run || isFinalRun(run.state)) throw coded(409, "this agent's run has ended", "run_finished");
  const policy = r.policy ?? (await policyForRun(r.runId, r.principal)).policy;
  const { inputHash: ih, planHash: ph } = grantHashes({ op: r.op, secretFields: r.secretFields, input: r.input, plan: r.plan, targets: r.targets });
  const now = Date.now();
  const db = await getDb();
  // An agent retrying the same request gets the pending one back instead of a second card to click through.
  const dup = await db.get<{ id: string; approval_id: string; expires_at: number | string }>(
    "SELECT id, approval_id, expires_at FROM approval_grants WHERE run_id = ? AND operation = ? AND plan_hash = ? AND decision IS NULL AND invalidated_at IS NULL AND expires_at > ?",
    [r.runId, r.op, ph, now],
  );
  if (dup) return { approvalId: dup.approval_id, grantId: dup.id, planHash: ph, expiresAt: Number(dup.expires_at), duplicate: true };
  const pending = await db.get<{ n: number | string }>("SELECT COUNT(*) AS n FROM approval_grants WHERE run_id = ? AND decision IS NULL AND invalidated_at IS NULL AND expires_at > ?", [r.runId, now]);
  if (Number(pending?.n ?? 0) >= MAX_PENDING_GRANTS_PER_RUN)
    throw Object.assign(new HttpError(429, `this agent already has ${MAX_PENDING_GRANTS_PER_RUN} requests waiting for a person — wait for decisions first`, 60_000), { code: "too_many_pending" });
  const grantId = newId();
  const approvalId = newId();
  const expiresAt = now + Math.min(policy.approval.expireAfterSeconds * 1000, APPROVAL_TTL_MS);
  await db.tx(async (tx) => {
    await tx.run(
      `INSERT INTO approval_grants (id, run_id, step_id, principal, operation, op_version, targets, input_hash, plan_hash, artifact_hashes, preconditions,
         policy_hash, limits, approval_id, requested_at, expires_at) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)`,
      [
        grantId, r.runId, r.stepId ?? null, JSON.stringify(r.principal), r.op, JSON.stringify([...new Set(r.targets)].sort()), ih, ph,
        JSON.stringify({ confirm: r.plan.confirm ?? null, echo: r.plan.echo ?? null }), r.principal.policyHash, JSON.stringify(policy.limits), approvalId, now, expiresAt,
      ],
    );
    await tx.run(
      `INSERT INTO approvals (id, op, input, plan, env, token_id, requested_by, status, created_at, run_id, grant_id, plan_hash)
       VALUES (?, ?, ?, ?, ?, NULL, ?, 'pending', ?, ?, ?, ?)`,
      [approvalId, r.op, seal(JSON.stringify(r.input)), JSON.stringify(r.plan), r.env ?? null, r.principal.delegatorId, now, r.runId, grantId, ph],
    );
    const seq = await publish("approval", approvalEvent({ id: approvalId, op: r.op, env: r.env ?? null, runId: r.runId }, "created", "pending", r.protected), approvalOpts(r.runId, tx));
    await queueOutbox(tx, seq);
  });
  // The run now waits for a person (an external agent's run too: it keeps reading meanwhile).
  if (run.state === "running") await updateRun(r.runId, { state: "waiting_approval" }, { from: ["running"] }).catch(() => {});
  return { approvalId, grantId, planHash: ph, expiresAt };
}

const approvalEvent = (a: { id: string; op: string; env: string | null; runId: string }, event: "created" | "decided" | "done", status: string, prot?: boolean) => ({
  event, id: a.id, op: a.op, status, env: a.env, tokenId: null, runId: a.runId, ...(prot ? { protected: true } : {}), at: Date.now(),
});
const approvalOpts = (runId: string, db?: Db) => ({ runId, audience: { people: true }, db });

// ---------- read ----------

export async function getGrant(id: string, db?: Db): Promise<ApprovalGrantRow | undefined> {
  const r = await (db ?? (await getDb())).get<ApprovalGrantRow>("SELECT * FROM approval_grants WHERE id = ?", [id]);
  return r ? { ...r, requested_at: Number(r.requested_at), expires_at: r.expires_at === null ? null : Number(r.expires_at) } : undefined;
}

export type GrantStatus = "pending" | "approved" | "rejected" | "expired" | "invalidated" | "consumed";
export function grantStatus(g: ApprovalGrantRow, now = Date.now()): GrantStatus {
  if (g.consumed_at) return "consumed";
  if (g.decision === "rejected") return "rejected"; // a person's rejection stays one, whatever invalidated the grant later
  if (g.invalidated_at) return "invalidated";
  if (g.expires_at !== null && Number(g.expires_at) <= now) return "expired";
  return g.decision === "approved" ? "approved" : "pending";
}

// ---------- decide (people only; ops/index.ts decide() checks the role and re-plans first) ----------

export interface GrantDecision {
  decision: "approve" | "reject";
  by: User;
  reason?: string;
  confirm?: string; // the person's typed confirmation (already checked against the plan by decide())
  migrationAck?: boolean; // the person acknowledges changed or unknown migrations (services.switch)
  ip?: string;
}

const twoPerson = () => /^(true|1|yes|on)$/i.test(process.env.CONSOLE_APPROVALS_TWO_PERSON?.trim() ?? "");

export async function decideGrant(grantId: string, d: GrantDecision): Promise<{ grant: ApprovalGrantRow; executeStepId?: string }> {
  const g = await getGrant(grantId);
  if (!g || !g.approval_id || !g.run_id) throw coded(404, "no such approval request", "grant_missing");
  const status = grantStatus(g);
  if (status === "expired") {
    await invalidateGrant(grantId, "the request expired before anyone decided");
    throw coded(409, "this request expired — the agent has to ask again", "grant_expired");
  }
  if (status !== "pending") throw coded(409, `this request is already ${status}`, "grant_decided");
  // A run that ended (cancelled, failed, its token revoked) takes its requests with it: nothing would execute them.
  const run = await getRun(g.run_id);
  if (!run || isFinalRun(run.state)) {
    const why = `the agent's run ended (${run ? run.state.replace(/_/g, " ") : "deleted"}) before anyone decided`;
    await invalidateGrant(grantId, why);
    throw coded(409, `${why} — the request was withdrawn`, "run_finished");
  }
  // The policy the request was made under is the one in force — an edited policy invalidates what was asked under it.
  if (run.policy_hash !== g.policy_hash) {
    await invalidateGrant(grantId, "the agent's policy changed since it asked");
    throw coded(409, "the agent's policy changed since it asked — the request was withdrawn", "policy_changed");
  }
  const stored = JSON.parse(g.principal ?? "{}") as Partial<AgentPrincipal>;
  // Two-person mode: the person the agent acts for counts as the requester.
  if (d.decision === "approve" && twoPerson() && stored.delegatorId === d.by.id)
    throw coded(403, "this console requires a second person to approve what an agent asks for on your behalf (CONSOLE_APPROVALS_TWO_PERSON)", "two_person");
  const reason = d.reason?.trim().slice(0, 500) || undefined;
  const now = Date.now();
  const action = d.decision === "approve" ? "approval.approve" : "approval.reject";
  // The decision is on the record before it is made (intent), and its result commits with it.
  const audit = { env: "", target: g.operation, action, user: d.by.email, ip: d.ip, reason, params: { approval: g.approval_id, grant: grantId, run: g.run_id, agentFor: stored.delegatorEmail } };
  try {
    await writeAudit({ ...audit, at: now, phase: "intent" });
  } catch (e) {
    throw new HttpError(503, `audit log unavailable, decision refused: ${errText(e)}`);
  }
  const db = await getDb();
  let executeStepId: string | undefined;
  await db.tx(async (tx) => {
    // The approval opens a short execution window (the policy's expiry, from now): the change runs soon or not at all.
    const execUntil = d.decision === "approve" ? now + Math.max(60_000, Math.min(Number(g.expires_at ?? 0) - Number(g.requested_at), APPROVAL_TTL_MS)) : g.expires_at;
    const n = await tx.run(
      "UPDATE approval_grants SET decision = ?, decided_by = ?, decided_at = ?, reason = ?, expires_at = ? WHERE id = ? AND decision IS NULL AND invalidated_at IS NULL AND consumed_at IS NULL AND expires_at > ?",
      [d.decision === "approve" ? "approved" : "rejected", d.by.email.slice(0, 254), now, reason ?? null, execUntil, grantId, now],
    );
    if (n !== 1) throw coded(409, "someone else decided first, or the request expired", "grant_decided");
    await tx.run("UPDATE approvals SET status = ?, decided_at = ?, decided_by = ?, detail = ? WHERE id = ? AND status = 'pending'", [
      d.decision === "approve" ? "approved" : "rejected", now, d.by.email.slice(0, 254), d.decision === "reject" ? (reason ?? null) : null, g.approval_id,
    ]);
    if (d.decision === "approve") {
      const step = await enqueueStep(
        g.run_id!,
        {
          kind: "execute", name: g.operation, grantId, idempotencyKey: `grant:${grantId}`, retrySafe: false,
          input: { op: g.operation, grantId, approvalId: g.approval_id, human: { confirm: d.confirm, migrationAck: d.migrationAck === true ? true : undefined, reason } },
        },
        tx,
      );
      executeStepId = step.id;
    }
    await writeAudit({ ...audit, at: Date.now(), phase: "result", result: "ok", detail: d.decision === "approve" ? "queued on the agent's run; it runs as the agent under this grant" : undefined }, tx);
  }).catch(async (e: unknown) => {
    await writeAudit({ ...audit, at: Date.now(), phase: "result", result: "error", detail: (e instanceof HttpError ? e.message : errText(e)).slice(0, 300) }).catch(() => {});
    throw e;
  });
  const after = await getRun(g.run_id);
  if (after?.state === "waiting_approval") await updateRun(g.run_id, { state: "running" }, { from: ["waiting_approval"] }).catch(() => {});
  const a = await getApproval(g.approval_id);
  if (a) publishApproval(a, "decided");
  return { grant: (await getGrant(grantId))!, executeStepId };
}

// ---------- use ----------

export interface GrantUse {
  op: string;
  inputHash: string;
  planHash: string;
  principal: AgentPrincipal;
}

// Single use. False (and the grant invalidated, with the reason) when anything it binds changed. Another run's grant
// is only refused, never touched: one agent can't use up — or spoil — a request a person is deciding for another.
export async function verifyAndConsumeGrant(grantId: string, u: GrantUse): Promise<boolean> {
  const g = await getGrant(grantId);
  if (!g) return false;
  const stored = JSON.parse(g.principal ?? "{}") as Partial<AgentPrincipal>;
  if (g.run_id !== u.principal.runId || stored.delegatorId !== u.principal.delegatorId) return false;
  const why =
    g.operation !== u.op ? "a different operation"
    : g.policy_hash !== u.principal.policyHash ? "the agent's policy changed"
    : g.input_hash !== u.inputHash ? "the input changed"
    : g.plan_hash !== u.planHash ? "the plan changed (its targets, image, consumers or preconditions)"
    : undefined;
  if (why) {
    await invalidateGrant(grantId, why);
    return false;
  }
  const now = Date.now();
  const n = await (await getDb()).run(
    `UPDATE approval_grants SET consumed_at = ? WHERE id = ? AND decision = 'approved' AND consumed_at IS NULL AND invalidated_at IS NULL AND expires_at > ?
       AND operation = ? AND plan_hash = ? AND input_hash = ?`,
    [now, grantId, now, u.op, u.planHash, u.inputHash],
  );
  if (n === 1) return true;
  const after = await getGrant(grantId);
  if (after && grantStatus(after) === "expired") await invalidateGrant(grantId, "the approval expired before the change ran");
  return false;
}

// After the change ran: the approval card shows done / failed, and the grant names the operation it became.
export async function finishGrant(grantId: string, outcome: { ok: boolean; result?: unknown; error?: string; operationId?: string }): Promise<void> {
  const g = await getGrant(grantId);
  if (!g?.approval_id) return;
  const db = await getDb();
  if (outcome.operationId) await db.run("UPDATE approval_grants SET consumed_operation_id = ? WHERE id = ?", [outcome.operationId, grantId]);
  let text: string | null = null;
  if (outcome.result !== undefined) {
    text = JSON.stringify(outcome.result) ?? null;
    if (text && text.length > 20_000) text = JSON.stringify({ truncated: true, preview: text.slice(0, 20_000) });
  }
  await db.run("UPDATE approvals SET status = ?, result = ?, detail = ? WHERE id = ? AND status = 'approved'", [outcome.ok ? "done" : "failed", text, outcome.error?.slice(0, 500) ?? null, g.approval_id]);
  const a = await getApproval(g.approval_id);
  if (a) publishApproval(a, "done");
}

// A rejected grant is left alone: revoking the token afterwards must not turn the person's "rejected" into "invalidated".
export async function invalidateGrant(id: string, why: string): Promise<boolean> {
  const now = Date.now();
  const db = await getDb();
  const g = await getGrant(id);
  if (!g) return false;
  const n = await db.run("UPDATE approval_grants SET invalidated_at = ?, invalidation_reason = ? WHERE id = ? AND invalidated_at IS NULL AND consumed_at IS NULL AND (decision IS NULL OR decision <> 'rejected')", [now, why.slice(0, 500), id]);
  if (n === 1 && g.approval_id) {
    await db.run("UPDATE approvals SET status = 'rejected', decided_at = COALESCE(decided_at, ?), decided_by = COALESCE(decided_by, 'system'), detail = ? WHERE id = ? AND status IN ('pending', 'approved')", [
      now, `invalidated: ${why}`.slice(0, 500), g.approval_id,
    ]);
    const a = await getApproval(g.approval_id);
    if (a) publishApproval(a, "decided");
  }
  return n === 1;
}

// The execute step (the runner's handler): the operation and the input the agent asked for, with the approver's
// human-only fields in place of the agent's own. The registry then re-plans and verifies the grant before running.
export async function grantExecution(grantId: string, human: { confirm?: string; migrationAck?: boolean; reason?: string } = {}): Promise<{ op: string; input: Record<string, unknown>; approvalId: string; runId: string }> {
  const g = await getGrant(grantId);
  if (!g?.approval_id || !g.run_id) throw coded(404, "no such grant", "grant_missing");
  const a: ApprovalRow | undefined = await getApproval(g.approval_id);
  if (!a) throw coded(404, "the approval request is gone", "grant_missing");
  const input = JSON.parse(unseal(a.input)) as Record<string, unknown>;
  delete input.confirm;
  delete input.migrationAck;
  const plan = a.plan ? (JSON.parse(a.plan) as Plan) : null;
  input.confirm = human.confirm ?? (plan?.confirm && plan.confirm !== "yes" ? plan.confirm : "yes");
  if (human.migrationAck === true) input.migrationAck = true;
  if (human.reason) input.reason = human.reason; // else the agent's own reason stays (the audit log shows both)
  return { op: g.operation, input, approvalId: g.approval_id, runId: g.run_id };
}
