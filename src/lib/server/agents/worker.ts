// The agent worker (master plan §3.4, §6 C2 item 3; AGENT_ARCHITECTURE §4 "execution semantics"): claims due steps
// of durable runs from the database, runs them through registered handlers under a fenced lease, and records the
// outcome only if it still holds the lease. Any number of consoles may run it against one database: a step is claimed
// by one conditional UPDATE, a stalled worker's late write is rejected by the fence, and a lease that expires is
// reconciled (./reconcile.ts) — an execute step whose change may already have reached AWS is never retried blindly.
//
//   registerStepHandler("model", async (step, { fence, heartbeat, signal, run }) => ({ state: "succeeded", result, next: [...] }));
//   await enqueueStep(runId, { kind: "tool", input: {...}, retrySafe: true });
//
// Retries happen only for steps marked retry-safe, with backoff (run-state.ts). A step whose kind has no handler stays
// queued (logged once per kind): handlers land with the runner and workflows; grants can enqueue execute steps first.
// While agents are off the worker claims nothing (queued notifications still go out and reconciliation still runs);
// while the emergency stop is on, execute steps wait.
//
// Execute steps: what their operations say wins over what their handler says (settleExecute in run-state.ts). A
// handler that threw, or reported a failure or a retry, while an operation of the step is running or unknown leaves the
// step outcome_unknown, the run waiting_external and a verify step queued; one whose operation succeeded is recorded as
// succeeded; only a step with no operation at all (nothing reached AWS) may fail — or wait, when the emergency stop or
// the switch refused it before it started. A step settled by the records (not by its handler) always gets a verify
// step, since the handler never said what comes next.
//
// Cancellation: a step in flight is told to stop (its signal) when its run ends or someone asks to cancel it —
// execute and verify steps excepted (a change AWS is processing is recorded, and checks go on). Draining (SIGTERM)
// stops claiming, interrupts every other step at once and gives execute steps time to record their change; a step it
// had to leave behind keeps its lease until it lapses, and reconciliation settles it.
//
// The handler registry, the loop, leases in flight, periodic tasks and the nudge live on globalThis.__consoleAgentWorker:
// the worker runs in the instrumentation bundle, while routes enqueue (and register) from theirs.
import "server-only";
import { ACTIVE_RUN_STATES, MAX_ATTEMPTS, assertStepTransition, backoffMs, claimableIn, interruptible, isFinalRun, isFinalStep } from "../../agents/run-state.ts";
import type { AgentRunRow, AgentStepRow, RunState, StepKind, StepState } from "../../agents/records.ts";
import { redact } from "../../agents/redact.ts";
import { getDb, type Db } from "../db.ts";
import { errText } from "../errors.ts";
import { pruneEvents, publishSafe } from "./events.ts";
import { deliverOutbox } from "./outbox.ts";
import { outsideAgentContext } from "./principals.ts";
import { followUpExecute, reconcileAgents, settlementOf } from "./reconcile.ts";
import { agentsEnabled, isEmergencyStopped } from "./stop.ts";
import { appendStep, getRun, normStep, resultJson, stepEvent, type StepInput } from "./store.ts";

export type { StepInput } from "./store.ts";

export interface StepContext {
  fence: number;
  heartbeat(): Promise<void>; // extends the lease; throws when it was lost (another worker took the step over)
  signal: AbortSignal; // aborted when the lease is lost, the run ends or is being cancelled, or the worker drains
  run: AgentRunRow;
}

export interface StepOutcome {
  state: Exclude<StepState, "leased">;
  result?: unknown;
  error?: string;
  wakeAt?: number; // for "waiting" / "queued": when to look again
  next?: StepInput[]; // steps to append to the run when this one is recorded
  retry?: boolean; // a "failed" outcome worth retrying (only honoured for retry-safe steps); default true for throws
  operationId?: string;
}

export type StepHandler = (step: AgentStepRow, ctx: StepContext) => Promise<StepOutcome>;

export const LEASE_MS = 60_000;
const TICK_MS = 1_000;
const MAX_INFLIGHT = 4;
const CANDIDATES = 100;
const WAIT_RECHECK_MS = 30_000;
const STOP_RECHECK_MS = 5_000;
const RECONCILE_EVERY_MS = 30_000;
const OUTBOX_EVERY_MS = 5_000;
const RUN_CHECK_MS = 5_000;

interface Inflight {
  ac: AbortController;
  done: Promise<void>;
  runId: string;
  kind: string;
}
interface TickTask {
  every: number;
  at: number;
  running: boolean;
  fn: (now: number) => Promise<unknown>;
}
interface WorkerState {
  handlers: Map<string, StepHandler>;
  warned: Set<string>;
  inflight: Map<string, Inflight>;
  tasks: Map<string, TickTask>;
  owner: string;
  started: boolean;
  draining: boolean;
  timer?: ReturnType<typeof setTimeout>;
  ticking: boolean;
  nudged: boolean;
  reconciledAt: number;
  outboxAt: number;
  outboxBusy?: boolean;
}
const g = globalThis as { __consoleAgentWorker?: WorkerState };
const st: WorkerState = (g.__consoleAgentWorker ??= {
  handlers: new Map(),
  warned: new Set(),
  inflight: new Map(),
  tasks: new Map(),
  owner: `worker:${crypto.randomUUID()}`,
  started: false,
  draining: false,
  ticking: false,
  nudged: false,
  reconciledAt: 0,
  outboxAt: 0,
});
st.tasks ??= new Map(); // a state object made by an older version of this module (dev hot reload)

const log = (level: number, msg: string, extra: Record<string, unknown> = {}) => console[level >= 50 ? "error" : "warn"](JSON.stringify({ level, msg, ...extra }));

export function registerStepHandler(kind: StepKind, handler: StepHandler): void {
  st.handlers.set(kind, handler);
  st.warned.delete(kind);
}

export const hasStepHandler = (kind: string) => st.handlers.has(kind);
// The handler registered for a kind now (steps.ts composes the workflow handler over the runner's).
export const stepHandlerOf = (kind: string): StepHandler | undefined => st.handlers.get(kind);

// Periodic work that rides on the worker loop, only while agents are on — the workflow scheduler's tick (c-workflows
// registers it from steps.ts registerHandlers()). A task never overlaps itself, and its failures are logged, never
// thrown into the loop. Registering a name again replaces it.
export function registerTickTask(name: string, everyMs: number, fn: (now: number) => Promise<unknown>): void {
  st.tasks.set(name, { every: Math.max(1_000, everyMs), at: 0, running: false, fn });
}

// Appends a step to a run and wakes the loop on this instance (other instances find it on their next tick). With `db`
// (a caller's transaction) the step commits with it; the loop is woken on the next tick, after the commit.
export async function enqueueStep(runId: string, step: StepInput, db?: Db): Promise<AgentStepRow> {
  const row = await appendStep(runId, step, db);
  if (db) outsideAgentContext(() => setTimeout(nudge, 0)).unref?.();
  else nudge();
  return row;
}

export function nudge(): void {
  if (!st.started || st.draining) return;
  st.nudged = true;
  if (!st.ticking) schedule(0);
}

function schedule(ms: number) {
  if (st.timer) clearTimeout(st.timer);
  // Outside any agent's context: an agent's call can nudge the loop (the runner enqueues from inside one), and a timer
  // armed there would otherwise run every later tick as that agent (principals.ts).
  st.timer = outsideAgentContext(() => setTimeout(() => void loop(), ms));
  st.timer.unref?.();
}

async function loop() {
  if (st.draining) return;
  st.ticking = true;
  st.nudged = false;
  try {
    await tick();
  } catch (e) {
    log(50, "agent worker tick failed", { err: errText(e) });
  } finally {
    st.ticking = false;
    if (!st.draining) schedule(st.nudged ? 0 : TICK_MS);
  }
}

// Starts the loop once per process (instrumentation.ts, in both modes; it claims only while agents are on). Loads the
// runner's and the workflows' handlers.
export async function startWorker(): Promise<void> {
  if (st.started) return;
  st.started = true;
  st.draining = false;
  for (const [name, load] of [["runner", () => import("./runner.ts")], ["steps", () => import("./steps.ts")]] as const) {
    try {
      const m = (await load()) as { registerHandlers?: () => void | Promise<void> };
      await m.registerHandlers?.();
    } catch (e) {
      log(40, `agent worker: the ${name} module didn't load — its steps stay queued`, { err: errText(e) });
    }
  }
  schedule(0);
}

class LeaseLost extends Error {
  constructor() {
    super("this step's lease was taken over by another worker");
    this.name = "LeaseLost";
  }
}
class Stopping extends Error {
  constructor() {
    super("the worker is stopping");
    this.name = "Stopping";
  }
}
class RunEnded extends Error {
  constructor(why: string) {
    super(why);
    this.name = "RunEnded";
  }
}

// SIGTERM: stop claiming; interrupt at once every step but execute steps (model, tool, verify, …: a retry-safe one
// goes back to the queue), wait up to timeoutMs for the execute steps to record what their change did, then abort them
// too. A step whose handler didn't return keeps its lease until it lapses and reconciliation settles it — through
// `operations` for a change.
export async function drainWorker(timeoutMs = 10_000): Promise<void> {
  st.draining = true;
  if (st.timer) clearTimeout(st.timer);
  for (const p of st.inflight.values()) if (p.kind !== "execute") p.ac.abort(new Stopping());
  const pending = [...st.inflight.values()];
  await Promise.race([Promise.allSettled(pending.map((p) => p.done)), new Promise((r) => setTimeout(r, timeoutMs).unref?.())]);
  for (const p of st.inflight.values()) p.ac.abort(new Stopping());
}

// Tells this instance's steps in flight for a run to stop (a person cancelled it). Other instances notice within
// RUN_CHECK_MS through the run's state or cancel_requested_at. Execute and verify steps are left to finish.
export function cancelInflight(runId: string, why = "the run was cancelled"): number {
  let n = 0;
  for (const p of st.inflight.values())
    if (p.runId === runId && interruptible(p) && !p.ac.signal.aborted) {
      p.ac.abort(new RunEnded(why));
      n++;
    }
  return n;
}

export const workerStatus = () => ({
  started: st.started, draining: st.draining, inflight: st.inflight.size, handlers: [...st.handlers.keys()].sort(), tasks: [...st.tasks.keys()].sort(), owner: st.owner,
});

// One pass: housekeeping, then claim and start due steps. `wait` makes it await the steps it started (tests); a given
// `now` (tests) also forces reconciliation.
export async function tick(o: { now?: number; wait?: boolean; owner?: string } = {}): Promise<number> {
  const now = o.now ?? Date.now();
  const owner = o.owner ?? st.owner;
  // Retention runs whether or not agents are on: the stream also carries the sampler's and the actions' events.
  await pruneEvents(now).catch(() => {});
  // Notifications already queued go out whatever the switch says: they report what happened and change nothing. In
  // the background: an integration that times out must not hold up the steps.
  if (now - st.outboxAt >= OUTBOX_EVERY_MS && !st.outboxBusy) {
    st.outboxAt = now;
    st.outboxBusy = true;
    void deliverOutbox({ now })
      .catch((e) => log(40, "agent outbox delivery failed", { err: errText(e) }))
      .finally(() => (st.outboxBusy = false));
  }
  // Settling lapsed leases and overdue runs is bookkeeping too (it never starts a step).
  if (now - st.reconciledAt >= RECONCILE_EVERY_MS || o.now !== undefined) {
    st.reconciledAt = now;
    await reconcileAgents(now).catch((e) => log(50, "agent reconciliation failed", { err: errText(e) }));
    await warnUnhandled().catch(() => {});
  }
  if (!(await agentsEnabled()).on) return 0;
  await runTasks(now);
  const claimed = await claimDue(now, owner);
  if (o.wait) await Promise.allSettled(claimed.map((c) => c.done));
  return claimed.length;
}

async function runTasks(now: number) {
  for (const [name, t] of st.tasks) {
    if (t.running || now - t.at < t.every) continue;
    t.at = now;
    t.running = true;
    try {
      await t.fn(now);
    } catch (e) {
      log(50, `agent worker task ${name} failed`, { err: errText(e) });
    } finally {
      t.running = false;
    }
  }
}

// One warning per kind that has queued steps and no handler (they stay queued until one is registered).
async function warnUnhandled() {
  const rows = await (await getDb()).all<{ kind: string }>("SELECT DISTINCT kind FROM agent_steps WHERE state IN ('queued', 'waiting')");
  for (const { kind } of rows) {
    if (st.handlers.has(kind) || st.warned.has(kind)) continue;
    st.warned.add(kind);
    log(40, `agent worker: no handler for ${kind} steps yet — they stay queued`, { kind });
  }
}

type Candidate = AgentStepRow & { run_state: AgentRunRow["state"]; run_cancel: number | string | null };

async function claimDue(now: number, owner: string): Promise<{ done: Promise<void> }[]> {
  const free = MAX_INFLIGHT - st.inflight.size;
  const kinds = [...st.handlers.keys()];
  if (st.draining || free <= 0 || !kinds.length) return [];
  const db = await getDb();
  // Only steps this worker can start: a kind it has a handler for, in a run that is going on (a verify step in any
  // run). Steps it can't start never fill the window, so they can't starve the ones it can.
  const rows = await db.all<Candidate>(
    `SELECT s.*, r.state AS run_state, r.cancel_requested_at AS run_cancel FROM agent_steps s JOIN agent_runs r ON r.id = s.run_id
      WHERE s.state IN ('queued', 'waiting') AND (s.wake_at IS NULL OR s.wake_at <= ?) AND (s.lease_until IS NULL OR s.lease_until < ?)
        AND s.kind IN (${kinds.map(() => "?").join(", ")})
        AND (s.kind = 'verify' OR (r.state IN (${ACTIVE_RUN_STATES.map(() => "?").join(", ")}) AND r.cancel_requested_at IS NULL))
      ORDER BY s.created_at, s.seq LIMIT ?`,
    [now, now, ...kinds, ...ACTIVE_RUN_STATES, CANDIDATES],
  );
  const stop = rows.some((r) => r.kind === "execute") ? await isEmergencyStopped() : { on: false };
  const started: { done: Promise<void> }[] = [];
  for (const raw of rows) {
    // A drain that began while this pass awaited the database: start nothing it wouldn't know to wait for.
    if (started.length >= free || st.draining) break;
    const s = normStep(raw);
    if (st.inflight.has(s.id) || !claimableIn(raw.run_state, s, { cancelRequested: raw.run_cancel !== null })) continue;
    const handler = st.handlers.get(s.kind);
    if (!handler) continue;
    const deps = await dependencies(s);
    if (deps === "blocked") continue;
    if (deps === "dead") {
      if ((await db.run("UPDATE agent_steps SET state = 'skipped', error = ?, updated_at = ? WHERE id = ? AND state IN ('queued', 'waiting')", ["a step it depends on did not succeed", now, s.id])) === 1)
        publishSafe("step", stepEvent({ ...s, state: "skipped", updated_at: now }), { runId: s.run_id });
      continue;
    }
    if (s.kind === "execute" && stop.on) {
      const n = await db.run("UPDATE agent_steps SET state = 'waiting', wake_at = ?, error = ?, updated_at = ? WHERE id = ? AND state IN ('queued', 'waiting')", [
        now + STOP_RECHECK_MS, "emergency stop", now, s.id,
      ]);
      // Said once, when it starts waiting (not every 5 s while it waits).
      if (n === 1 && s.error !== "emergency stop") publishSafe("step", { ...stepEvent({ ...s, state: "waiting", updated_at: now }), error: "emergency stop" }, { runId: s.run_id });
      continue;
    }
    const step = await claimStep(s.id, owner, now);
    if (!step) continue;
    publishSafe("step", stepEvent(step), { runId: step.run_id });
    const ac = new AbortController();
    const done = runStep(step, handler, ac).finally(() => st.inflight.delete(step.id));
    st.inflight.set(step.id, { ac, done, runId: step.run_id, kind: step.kind });
    started.push({ done });
  }
  return started;
}

// The claim (master plan §6 C2): one conditional UPDATE — of any number of workers, exactly one wins. The fence goes
// up by one, so whoever held the step before can no longer record anything for it.
export async function claimStep(id: string, owner: string, now = Date.now()): Promise<AgentStepRow | undefined> {
  const db = await getDb();
  const n = await db.run(
    `UPDATE agent_steps SET state = 'leased', lease_owner = ?, lease_until = ?, fence = fence + 1, attempt = attempt + 1, updated_at = ?
      WHERE id = ? AND state IN ('queued', 'waiting') AND (wake_at IS NULL OR wake_at <= ?) AND (lease_until IS NULL OR lease_until < ?)`,
    [owner, now + LEASE_MS, now, id, now, now],
  );
  if (n !== 1) return undefined;
  const leased = await db.get<AgentStepRow>("SELECT * FROM agent_steps WHERE id = ?", [id]);
  return leased && leased.lease_owner === owner ? normStep(leased) : undefined;
}

async function dependencies(s: AgentStepRow): Promise<"ready" | "blocked" | "dead"> {
  let ids: unknown = [];
  try {
    ids = s.depends ? JSON.parse(s.depends) : [];
  } catch {
    return "dead";
  }
  if (!Array.isArray(ids) || !ids.length) return "ready";
  if (!ids.every((x): x is string => typeof x === "string")) return "dead";
  const rows = await (await getDb()).all<{ id: string; state: StepState }>(`SELECT id, state FROM agent_steps WHERE run_id = ? AND id IN (${ids.map(() => "?").join(", ")})`, [s.run_id, ...ids]);
  if (rows.length < new Set(ids).size) return "dead";
  if (rows.every((r) => r.state === "succeeded")) return "ready";
  return rows.some((r) => isFinalStep(r.state) && r.state !== "succeeded") ? "dead" : "blocked";
}

// Outcomes made up by the worker for a handler that threw (it said nothing about what comes next).
const fromThrow = new WeakSet<StepOutcome>();

async function runStep(step: AgentStepRow, handler: StepHandler, ac: AbortController): Promise<void> {
  const db = await getDb();
  const heartbeat = async () => {
    const n = await db.run("UPDATE agent_steps SET lease_until = ? WHERE id = ? AND fence = ? AND state = 'leased'", [Date.now() + LEASE_MS, step.id, step.fence]);
    if (n !== 1) {
      ac.abort(new LeaseLost());
      throw new LeaseLost();
    }
  };
  const beat = setInterval(() => void heartbeat().catch(() => {}), LEASE_MS / 3);
  beat.unref?.();
  // A run that ended, or that someone asked to cancel, stops its interruptible steps (within RUN_CHECK_MS).
  const watch = interruptible(step)
    ? setInterval(() => {
        void db
          .get<{ state: RunState; cancel_requested_at: number | string | null }>("SELECT state, cancel_requested_at FROM agent_runs WHERE id = ?", [step.run_id])
          .then((r) => {
            if (ac.signal.aborted) return;
            if (!r) ac.abort(new RunEnded("the run no longer exists"));
            else if (isFinalRun(r.state)) ac.abort(new RunEnded(`the run ${r.state.replace(/_/g, " ")}`));
            else if (r.cancel_requested_at !== null) ac.abort(new RunEnded("the run is being cancelled"));
          })
          .catch(() => {});
      }, RUN_CHECK_MS)
    : undefined;
  watch?.unref?.();
  let outcome: StepOutcome | undefined;
  let thrown: unknown;
  try {
    const run = await getRun(step.run_id);
    if (!run) throw new RunEnded("the run no longer exists");
    outcome = await handler(step, { fence: step.fence, heartbeat, signal: ac.signal, run });
  } catch (e) {
    thrown = e;
  } finally {
    clearInterval(beat);
    if (watch) clearInterval(watch);
  }
  const reason: unknown = ac.signal.aborted ? ac.signal.reason : undefined;
  if (reason instanceof LeaseLost || thrown instanceof LeaseLost) return log(40, "agent step lost its lease; its result is discarded", { step: step.id });
  if (!outcome) {
    if (reason instanceof Stopping && (step.kind === "execute" || !step.retry_safe))
      return log(40, "agent step interrupted by shutdown; its lease lapses and reconciliation settles it", { step: step.id, kind: step.kind });
    outcome =
      reason instanceof RunEnded || thrown instanceof RunEnded ? { state: "cancelled", error: (reason ?? thrown) instanceof Error ? ((reason ?? thrown) as Error).message : "the run ended" }
      : reason instanceof Stopping ? { state: "queued", error: "requeued: the worker stopped while it ran" }
      : { state: "failed", error: errText(thrown) };
    fromThrow.add(outcome);
  }
  await finishStep(step, outcome).catch((e) => log(50, "agent step result not recorded", { step: step.id, err: errText(e) }));
}

// What an execute step's operations say about the handler's outcome (see the header). `settled`: the records decided
// (the handler threw, or what it said was overruled), so the step gets a verify step.
async function settleExecuteOutcome(step: AgentStepRow, o: StepOutcome, now: number): Promise<{ outcome: StepOutcome; settled: boolean }> {
  const thrown = fromThrow.has(o);
  if (o.state === "succeeded" || o.state === "outcome_unknown") {
    if (o.operationId) return { outcome: o, settled: thrown };
    const s = await settlementOf(step).catch(() => undefined);
    return { outcome: { ...o, operationId: s?.operationId }, settled: thrown };
  }
  let s: Awaited<ReturnType<typeof settlementOf>>;
  try {
    s = await settlementOf(step);
  } catch (e) {
    // The records can't be read: AWS may have acted — never claim that nothing happened, and never retry.
    return { outcome: { state: "outcome_unknown", error: `the change's records couldn't be read (${errText(e)}) — verifying` }, settled: true };
  }
  const why = o.error ? `: ${o.error.slice(0, 300)}` : "";
  switch (s.settle) {
    case "unknown":
      return { outcome: { state: "outcome_unknown", operationId: s.operationId, error: `the change may have reached AWS${why} — verifying, never retrying` }, settled: true };
    case "succeeded":
      return { outcome: { state: "succeeded", operationId: s.operationId, result: o.result ?? { operationId: s.operationId, reconciled: true }, next: o.next }, settled: true };
    case "failed":
      return {
        outcome: { ...o, state: "failed", retry: false, operationId: s.operationId, error: o.error ?? `the change failed (operation ${s.operationId})${s.error ? `: ${s.error.slice(0, 300)}` : ""}` },
        settled: thrown || o.state !== "failed",
      };
    case "none":
      // Nothing reached AWS. Refused by the emergency stop or the switch before it started: it waits for them.
      if (o.state === "failed") {
        if ((await isEmergencyStopped()).on) return { outcome: { state: "waiting", wakeAt: now + STOP_RECHECK_MS, error: "emergency stop" }, settled: false };
        if (!(await agentsEnabled()).on) return { outcome: { state: "queued", error: "agents are turned off on this console" }, settled: false };
      }
      return { outcome: o, settled: false };
  }
}

// Records a handler's outcome — only while this worker still holds the step's lease (fence). Returns false when a newer
// claim made it stale (the late write is rejected, nothing is appended).
export async function finishStep(step: AgentStepRow, outcome: StepOutcome, now = Date.now()): Promise<boolean> {
  let o = outcome;
  let settled = false;
  if (step.kind === "execute") ({ outcome: o, settled } = await settleExecuteOutcome(step, outcome, now));
  let state = o.state;
  let wakeAt: number | null = o.wakeAt ?? null;
  const retry = state === "failed" && o.retry !== false && step.retry_safe === 1 && step.attempt < MAX_ATTEMPTS && step.kind !== "execute";
  if (retry) {
    state = "queued";
    wakeAt = now + backoffMs(step.attempt, Math.random());
  }
  if (state === "waiting" && wakeAt === null) wakeAt = now + WAIT_RECHECK_MS;
  assertStepTransition("leased", state);
  const next = retry ? [] : (o.next ?? []);
  const unknown = step.kind === "execute" && state === "outcome_unknown";
  const verify = (settled || unknown) && !next.some((n) => n.kind === "verify");
  const error = o.error ? redact(o.error).text.slice(0, 2_000) : null;
  const db = await getDb();
  const ok = await db.tx(async (tx) => {
    const n = await tx.run(
      `UPDATE agent_steps SET state = ?, result = ?, error = ?, wake_at = ?, operation_id = COALESCE(?, operation_id), lease_owner = NULL, lease_until = NULL, updated_at = ?
        WHERE id = ? AND fence = ? AND state = 'leased'`,
      [state, resultJson(o.result), error, wakeAt, o.operationId ?? null, now, step.id, step.fence],
    );
    if (n !== 1) return false;
    for (const s of next) await appendStep(step.run_id, s, tx);
    // An execute step that may have changed something: the run waits on the world, and a verify step checks it.
    if (step.kind === "execute" && (unknown || verify)) await followUpExecute(tx, step, { operationId: o.operationId, unknown, verify });
    return true;
  });
  if (!ok) {
    log(40, "late step completion rejected by its fence", { step: step.id, fence: step.fence });
    return false;
  }
  publishSafe("step", { ...stepEvent({ ...step, state, updated_at: now }), ...(error ? { error: error.slice(0, 300) } : {}) }, { runId: step.run_id });
  if (next.length || verify) nudge();
  return true;
}
