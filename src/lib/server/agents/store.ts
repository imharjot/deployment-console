// Durable agent runs, their steps and model calls (master plan §3.4, §6 C2 item 2): typed CRUD over the migration-7
// tables. Every run state change is checked against the state machine (src/lib/agents/run-state.ts) inside the
// transaction that makes it, so two writers can't both move a run; the change is published as a `run` event that
// commits with it. A run that ends loses its run tokens and the steps it had not started (verify steps excepted) in the
// same transaction, and its outcome is queued for integrations (the outbox) — never sent from inside the change.
import "server-only";
import { assertRunTransition, isFinalRun, type TransitionOptions } from "../../agents/run-state.ts";
import type { AgentModelCallRow, AgentRunRow, AgentStepRow, RunState, StepKind, StepState } from "../../agents/records.ts";
import { redact, redactDeep } from "../../agents/redact.ts";
import type { AgentPolicy, AgentPrincipal } from "../../agents/types.ts";
import { getDb, newId, type Db } from "../db.ts";
import { HttpError } from "../errors.ts";
import { seal } from "../secrets.ts";
import { publish, publishSafe } from "./events.ts";
import { queueOutbox } from "./outbox.ts";

export type { AgentModelCallRow, AgentRunRow, AgentStepRow, RunState, StepKind, StepState } from "../../agents/records.ts";

const MAX_JSON = 256 * 1024;
export const coded = (status: number, message: string, code: string) => Object.assign(new HttpError(status, message), { code });
const json = (v: unknown): string | null => {
  if (v === undefined) return null;
  const s = JSON.stringify(v) ?? null;
  if (s && s.length > MAX_JSON) throw new HttpError(413, `agent record too large (${s.length} bytes)`);
  return s;
};
// A step's result as stored: an oversized one is replaced by a marker instead of refusing the write (a handler's
// outcome must always be recordable, or the step would sit leased until reconciliation).
export const resultJson = (v: unknown): string | null => {
  if (v === undefined) return null;
  const s = JSON.stringify(v) ?? null;
  return s && s.length > MAX_JSON ? JSON.stringify({ truncated: true, bytes: s.length }) : s;
};

// ---------- runs ----------

export interface NewRun {
  id?: string;
  kind: AgentRunRow["kind"];
  title?: string;
  initiatorId: string | null;
  principal?: AgentPrincipal;
  agentId?: string;
  agentVersion?: number;
  workflowId?: string;
  workflowVersion?: number;
  connectionId?: string | null;
  scope?: unknown;
  policy?: AgentPolicy;
  policyHash?: string;
  toolsHash?: string;
  state?: RunState; // default queued
  budget?: unknown;
  trigger?: unknown;
  parentRunId?: string;
  resourceKey?: string;
  deadlineAt?: number | null;
}

export async function createRun(r: NewRun, db?: Db): Promise<AgentRunRow> {
  const id = r.id ?? newId();
  const now = Date.now();
  const d = db ?? (await getDb());
  await d.run(
    `INSERT INTO agent_runs (id, kind, title, initiator_id, principal, agent_id, agent_version, workflow_id, workflow_version, connection_id, scope,
       policy, policy_hash, tools_hash, state, budget, usage, reserved, trigger, parent_run_id, resource_key, deadline_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?)`,
    [
      id, r.kind, r.title?.slice(0, 300) ?? null, r.initiatorId, json(r.principal), r.agentId ?? null, r.agentVersion ?? null, r.workflowId ?? null,
      r.workflowVersion ?? null, r.connectionId ?? null, json(r.scope ?? r.policy?.scope), json(r.policy), r.policyHash ?? r.principal?.policyHash ?? null,
      r.toolsHash ?? null, r.state ?? "queued", json(r.budget), json(r.trigger), r.parentRunId ?? null, r.resourceKey ?? null, r.deadlineAt ?? null, now, now,
    ],
  );
  const row = (await d.get<AgentRunRow>("SELECT * FROM agent_runs WHERE id = ?", [id]))!;
  await publishIn(db, "run", runEvent(row), { runId: id });
  return norm(row);
}

// Inside a caller's transaction the event commits with it, in a savepoint so a failed insert can't abort the caller's
// transaction (Postgres); outside one it is published after the fact and never throws.
async function publishIn(db: Db | undefined, type: "run" | "step", payload: unknown, o: { runId: string }) {
  if (!db) return publishSafe(type, payload, o);
  await db.tx((t) => publish(type, payload, { ...o, db: t })).catch((e) => console.error(JSON.stringify({ level: 40, msg: "event publish failed", type, err: String((e as Error)?.message ?? e) })));
}

const norm = <T extends object>(r: T): T => {
  const out = { ...r } as Record<string, unknown>;
  for (const k of ["created_at", "updated_at", "finished_at", "deadline_at", "cancel_requested_at", "agent_version", "workflow_version"]) if (out[k] !== null && out[k] !== undefined) out[k] = Number(out[k]);
  return out as T;
};

export async function getRun(id: string, db?: Db): Promise<AgentRunRow | undefined> {
  const r = await (db ?? (await getDb())).get<AgentRunRow>("SELECT * FROM agent_runs WHERE id = ?", [id]);
  return r ? norm(r) : undefined;
}

export interface RunFilter {
  initiator?: string;
  state?: RunState | RunState[];
  kind?: AgentRunRow["kind"];
  parentRunId?: string;
  before?: number; // created_at < before (paging)
  limit?: number;
}

export async function listRuns(f: RunFilter = {}): Promise<AgentRunRow[]> {
  const where: string[] = [];
  const args: unknown[] = [];
  const add = (sql: string, ...v: unknown[]) => {
    where.push(sql);
    args.push(...v);
  };
  if (f.initiator) add("initiator_id = ?", f.initiator);
  if (f.kind) add("kind = ?", f.kind);
  if (f.parentRunId) add("parent_run_id = ?", f.parentRunId);
  if (f.before) add("created_at < ?", f.before);
  const states = f.state === undefined ? [] : Array.isArray(f.state) ? f.state : [f.state];
  if (states.length) add(`state IN (${states.map(() => "?").join(", ")})`, ...states);
  args.push(Math.min(Math.max(f.limit ?? 50, 1), 500));
  const rows = await (await getDb()).all<AgentRunRow>(`SELECT * FROM agent_runs${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC LIMIT ?`, args);
  return rows.map(norm);
}

export interface RunPatch {
  state?: RunState;
  error?: string | null;
  title?: string;
  usage?: unknown;
  budget?: unknown;
  reserved?: unknown;
  principal?: AgentPrincipal;
  cancelRequestedAt?: number;
  deadlineAt?: number | null;
}

// State changes are checked against the state machine inside the transaction; a same-state patch is a field update.
// `from` restricts the states the change may start from (a compare-and-set: "only if it is still waiting").
export async function updateRun(id: string, patch: RunPatch, o: TransitionOptions & { from?: RunState[] } = {}): Promise<AgentRunRow> {
  const db = await getDb();
  let before: AgentRunRow | undefined;
  const row = await db.tx(async (tx) => {
    const cur = await tx.get<AgentRunRow>("SELECT * FROM agent_runs WHERE id = ?", [id]);
    if (!cur) throw new HttpError(404, "no such run");
    before = cur;
    const to = patch.state ?? cur.state;
    if (o.from && !o.from.includes(cur.state)) throw coded(409, `the run is ${cur.state.replace(/_/g, " ")}, not ${o.from.join(" or ").replace(/_/g, " ")}`, "run_state");
    assertRunTransition(cur.state, to, o);
    const now = Date.now();
    const sets: string[] = ["state = ?", "updated_at = ?"];
    const args: unknown[] = [to, now];
    const set = (col: string, v: unknown) => (sets.push(`${col} = ?`), args.push(v));
    if (patch.error !== undefined) set("error", patch.error === null ? null : redact(String(patch.error)).text.slice(0, 2_000));
    if (patch.title !== undefined) set("title", patch.title.slice(0, 300));
    if (patch.usage !== undefined) set("usage", json(patch.usage));
    if (patch.budget !== undefined) set("budget", json(patch.budget));
    if (patch.reserved !== undefined) set("reserved", json(patch.reserved));
    if (patch.principal !== undefined) set("principal", json(patch.principal));
    if (patch.cancelRequestedAt !== undefined) set("cancel_requested_at", patch.cancelRequestedAt);
    if (patch.deadlineAt !== undefined) set("deadline_at", patch.deadlineAt);
    const ending = to !== cur.state && isFinalRun(to);
    if (ending) set("finished_at", now);
    const n = await tx.run(`UPDATE agent_runs SET ${sets.join(", ")} WHERE id = ? AND state = ?`, [...args, id, cur.state]);
    if (n !== 1) throw coded(409, "the run changed at the same time — try again", "run_state");
    // A run that ends takes its run tokens with it (an embedded CLI's token stops working at once), and the steps it
    // had not started yet — except verify steps: a change AWS accepted keeps being checked after the run ends.
    let dropped: AgentStepRow[] = [];
    if (ending) {
      await tx.run("UPDATE agent_tokens SET revoked_at = ? WHERE run_id = ? AND kind = 'run' AND revoked_at IS NULL", [now, id]);
      dropped = await tx.all<AgentStepRow>("SELECT * FROM agent_steps WHERE run_id = ? AND state IN ('queued', 'waiting') AND kind <> 'verify' ORDER BY seq LIMIT 500", [id]);
      for (const s of dropped) await tx.run("UPDATE agent_steps SET state = 'cancelled', error = ?, updated_at = ? WHERE id = ? AND state IN ('queued', 'waiting')", ["the run ended", now, s.id]);
    }
    const after = (await tx.get<AgentRunRow>("SELECT * FROM agent_runs WHERE id = ?", [id]))!;
    // The events commit with the change; a finished or failed run is queued for integrations in the same transaction.
    if (to !== cur.state) {
      const seq = await publish("run", { ...runEvent(after), previous: cur.state }, { runId: id, db: tx });
      for (const s of dropped) await publish("step", stepEvent({ ...s, state: "cancelled", updated_at: now }), { runId: id, db: tx });
      if (ending && (to === "succeeded" || to === "failed")) await queueOutbox(tx, seq);
    }
    return after;
  });
  if (before && before.state !== row.state && isFinalRun(row.state)) forgetAgentTokenCache();
  return norm(row);
}

const runEvent = (r: AgentRunRow) => ({ id: r.id, kind: r.kind, state: r.state, error: r.error ? r.error.slice(0, 300) : undefined, at: Number(r.updated_at) });

// The agent-token cache (src/lib/server/auth/agent-tokens.ts) on globalThis: a run that ends must stop its tokens on
// this instance at once, not after the cache's 5 s.
const forgetAgentTokenCache = () => (globalThis as { __consoleAgentTokens?: Map<string, unknown> }).__consoleAgentTokens?.clear();

// ---------- steps ----------

export interface StepInput {
  kind: StepKind;
  name?: string;
  depends?: string[];
  input?: unknown;
  retrySafe?: boolean;
  idempotencyKey?: string;
  wakeAt?: number;
  grantId?: string;
  state?: Extract<StepState, "queued" | "waiting" | "succeeded" | "failed" | "skipped">; // default queued
  result?: unknown; // for steps recorded already done (a tool call an external agent made)
  error?: string;
  operationId?: string;
}

export async function appendStep(runId: string, s: StepInput, db?: Db): Promise<AgentStepRow> {
  const d = db ?? (await getDb());
  let id = "";
  for (let attempt = 0; ; attempt++) {
    id = newId();
    const now = Date.now();
    try {
      await d.tx(async (tx) => {
        const run = await tx.get<{ id: string }>("SELECT id FROM agent_runs WHERE id = ?", [runId]);
        if (!run) throw new HttpError(404, "no such run");
        const max = await tx.get<{ n: number | string | null }>("SELECT MAX(seq) AS n FROM agent_steps WHERE run_id = ?", [runId]);
        await tx.run(
          `INSERT INTO agent_steps (id, run_id, seq, kind, name, depends, attempt, retry_safe, idempotency_key, state, wake_at, input, result, error,
             operation_id, grant_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            id, runId, Number(max?.n ?? 0) + 1, s.kind, s.name?.slice(0, 200) ?? null, json(s.depends), s.retrySafe ? 1 : 0, s.idempotencyKey ?? null,
            s.state ?? "queued", s.wakeAt ?? null, json(s.input), resultJson(s.result), s.error ? redact(s.error).text.slice(0, 2_000) : null, s.operationId ?? null,
            s.grantId ?? null, now, now,
          ],
        );
      });
      break;
    } catch (e) {
      // Two writers took the same seq (UNIQUE (run_id, seq)): take the next one.
      if (attempt < 4 && /unique|constraint/i.test(String((e as Error)?.message))) continue;
      throw e;
    }
  }
  const row = (await d.get<AgentStepRow>("SELECT * FROM agent_steps WHERE id = ?", [id]))!;
  await publishIn(db, "step", stepEvent(row), { runId });
  return normStep(row);
}

export const normStep = (r: AgentStepRow): AgentStepRow => ({
  ...r,
  seq: Number(r.seq), attempt: Number(r.attempt), retry_safe: Number(r.retry_safe), fence: Number(r.fence),
  lease_until: r.lease_until === null ? null : Number(r.lease_until), wake_at: r.wake_at === null ? null : Number(r.wake_at),
  created_at: Number(r.created_at), updated_at: Number(r.updated_at),
});

export const stepEvent = (r: AgentStepRow) => ({ id: r.id, runId: r.run_id, seq: Number(r.seq), kind: r.kind, name: r.name, state: r.state, at: Number(r.updated_at) });

export async function getSteps(runId: string): Promise<AgentStepRow[]> {
  return (await (await getDb()).all<AgentStepRow>("SELECT * FROM agent_steps WHERE run_id = ? ORDER BY seq", [runId])).map(normStep);
}

export async function getStep(id: string): Promise<AgentStepRow | undefined> {
  const r = await (await getDb()).get<AgentStepRow>("SELECT * FROM agent_steps WHERE id = ?", [id]);
  return r ? normStep(r) : undefined;
}

// ---------- model calls ----------

export interface ModelCallRecord {
  runId: string;
  stepId?: string;
  connectionId?: string;
  provider?: string;
  model?: string;
  requestId?: string;
  state: AgentModelCallRow["state"];
  usage?: unknown;
  costEstimate?: number;
  transcript?: unknown; // redacted (redactDeep) and sealed before it is stored
  startedAt: number;
  finishedAt?: number;
  error?: string;
}

export async function recordModelCall(c: ModelCallRecord): Promise<string> {
  const id = newId();
  const transcript = c.transcript === undefined ? null : seal(JSON.stringify(redactDeep(c.transcript).value) ?? "null");
  await (await getDb()).run(
    `INSERT INTO agent_model_calls (id, run_id, step_id, connection_id, provider, model, request_id, state, usage, cost_estimate, transcript, started_at,
       finished_at, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id, c.runId, c.stepId ?? null, c.connectionId ?? null, c.provider ?? null, c.model ?? null, c.requestId?.slice(0, 200) ?? null, c.state, json(c.usage),
      typeof c.costEstimate === "number" && Number.isFinite(c.costEstimate) ? c.costEstimate : null, transcript, c.startedAt, c.finishedAt ?? Date.now(),
      c.error ? redact(c.error).text.slice(0, 2_000) : null,
    ],
  );
  return id;
}

export async function modelCallCount(runId: string): Promise<number> {
  const r = await (await getDb()).get<{ n: number | string }>("SELECT COUNT(*) AS n FROM agent_model_calls WHERE run_id = ?", [runId]);
  return Number(r?.n ?? 0);
}

// ---------- triggers ----------

// One run per trigger firing, on every database and across consoles (master plan §6 C7 scheduler; §9.3 "duplicate
// triggers"): the dedupe key ("wf:<id>:<version>:<fireTimeIso>", a webhook's delivery id) is the primary key of
// trigger_fires. False when it already fired.
export async function claimTriggerFire(f: { dedupeKey: string; workflowId: string; workflowVersion?: number; runId?: string }, db?: Db): Promise<boolean> {
  const n = await (db ?? (await getDb())).run(
    "INSERT INTO trigger_fires (dedupe_key, workflow_id, workflow_version, run_id, at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (dedupe_key) DO NOTHING",
    [f.dedupeKey.slice(0, 500), f.workflowId, f.workflowVersion ?? null, f.runId ?? null, Date.now()],
  );
  return n === 1;
}
