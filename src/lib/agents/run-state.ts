// The run and step state machines (AGENT_ARCHITECTURE §4 "execution semantics"), plus the agents on/off switch. Pure:
// src/lib/server/agents/store.ts checks every run transition inside the transaction that makes it, and the worker
// (src/lib/server/agents/worker.ts) every step transition.
//
// Rules:
// - succeeded, failed, cancelled (and skipped, for steps) are final.
// - outcome_unknown is final too, except through reconciliation: once someone has checked the resource (a verify step,
//   a person), it may become succeeded or failed — never anything else, and never by an ordinary update.
// - Same state → same state is not a transition (a field update), and is always allowed.
import type { RunState, StepState } from "./records.ts";

export const RUN_STATES: readonly RunState[] = [
  "queued", "running", "waiting_approval", "waiting_external", "paused_auth", "paused_budget", "succeeded", "failed", "cancelled", "outcome_unknown",
];
export const STEP_STATES: readonly StepState[] = ["queued", "leased", "waiting", "succeeded", "failed", "cancelled", "outcome_unknown", "skipped"];

const FINAL_RUN: readonly RunState[] = ["succeeded", "failed", "cancelled"];
const FINAL_STEP: readonly StepState[] = ["succeeded", "failed", "cancelled", "skipped"];

export const RUN_TRANSITIONS: Readonly<Record<RunState, readonly RunState[]>> = {
  queued: ["running", "waiting_approval", "paused_auth", "paused_budget", "succeeded", "failed", "cancelled"],
  running: ["waiting_approval", "waiting_external", "paused_auth", "paused_budget", "succeeded", "failed", "cancelled", "outcome_unknown"],
  // An approval decided: the run resumes (execute step), ends (rejected / expired), or waits on AWS.
  waiting_approval: ["running", "waiting_external", "paused_auth", "paused_budget", "succeeded", "failed", "cancelled"],
  // Waiting on the world (an operation's outcome being verified, an external client's next call).
  waiting_external: ["running", "waiting_approval", "paused_auth", "paused_budget", "succeeded", "failed", "cancelled", "outcome_unknown"],
  // A paused run resumes or ends (a run paused over budget stays paused_budget when its connection is revoked too: its
  // next model call is refused anyway — src/lib/server/agents/credentials.ts relies on this).
  paused_auth: ["queued", "running", "waiting_approval", "waiting_external", "failed", "cancelled"],
  paused_budget: ["queued", "running", "waiting_approval", "waiting_external", "failed", "cancelled"],
  succeeded: [],
  failed: [],
  cancelled: [],
  outcome_unknown: [], // see RECONCILED
};

export const STEP_TRANSITIONS: Readonly<Record<StepState, readonly StepState[]>> = {
  queued: ["leased", "waiting", "succeeded", "failed", "cancelled", "skipped"],
  // A claimed step finishes, waits (until wake_at, or the emergency stop lifts), goes back to the queue (retry, or a
  // lease that expired before anything happened) or ends up with an unknown outcome (an execute step).
  leased: ["queued", "waiting", "succeeded", "failed", "cancelled", "skipped", "outcome_unknown"],
  waiting: ["queued", "leased", "succeeded", "failed", "cancelled", "skipped"],
  succeeded: [],
  failed: [],
  cancelled: [],
  skipped: [],
  outcome_unknown: [], // see RECONCILED
};

// Where a reconciliation (somebody checked what really happened) may take an unknown outcome.
const RECONCILED: readonly string[] = ["succeeded", "failed"];

export const isRunState = (v: unknown): v is RunState => typeof v === "string" && (RUN_STATES as readonly string[]).includes(v);
export const isStepState = (v: unknown): v is StepState => typeof v === "string" && (STEP_STATES as readonly string[]).includes(v);

// Final: nothing moves it again (outcome_unknown only through reconciliation).
export const isFinalRun = (s: RunState) => FINAL_RUN.includes(s) || s === "outcome_unknown";
export const isFinalStep = (s: StepState) => FINAL_STEP.includes(s) || s === "outcome_unknown";
// Still has work ahead (a step that may yet run).
export const isPendingStep = (s: StepState) => s === "queued" || s === "leased" || s === "waiting";

export interface TransitionOptions {
  reconcile?: boolean; // the caller checked the resource: outcome_unknown may become succeeded or failed
}

export function canTransitionRun(from: RunState, to: RunState, o: TransitionOptions = {}): boolean {
  if (from === to) return true;
  if (from === "outcome_unknown") return !!o.reconcile && RECONCILED.includes(to);
  return RUN_TRANSITIONS[from]?.includes(to) ?? false;
}

export function canTransitionStep(from: StepState, to: StepState, o: TransitionOptions = {}): boolean {
  if (from === to) return true;
  if (from === "outcome_unknown") return !!o.reconcile && RECONCILED.includes(to);
  return STEP_TRANSITIONS[from]?.includes(to) ?? false;
}

export class TransitionError extends Error {
  status = 409;
  code = "invalid_transition";
  constructor(what: "run" | "step", from: string, to: string) {
    super(
      from === "outcome_unknown"
        ? `this ${what}'s outcome is unknown — only a reconciliation (a check of the resource) can settle it, as succeeded or failed`
        : `a ${what} that is ${from.replace(/_/g, " ")} can't become ${to.replace(/_/g, " ")}`,
    );
    this.name = "TransitionError";
  }
}

export function assertRunTransition(from: RunState, to: RunState, o?: TransitionOptions) {
  if (!canTransitionRun(from, to, o)) throw new TransitionError("run", from, to);
}

export function assertStepTransition(from: StepState, to: StepState, o?: TransitionOptions) {
  if (!canTransitionStep(from, to, o)) throw new TransitionError("step", from, to);
}

// Which steps of a run the worker may start, by the run's state. Runs that ended keep only their verify steps (an
// operation AWS accepted keeps being reconciled after a cancel); paused runs make no model or tool calls, but checks of
// changes already submitted go on (an inference outage must not stop the verification of an accepted change).
// A run someone asked to cancel starts nothing new either (the runner ends it; verify steps go on).
export const ACTIVE_RUN_STATES: readonly RunState[] = ["queued", "running", "waiting_approval", "waiting_external"];
export function claimableIn(run: RunState, step: { kind: string }, o: { cancelRequested?: boolean } = {}): boolean {
  if (step.kind === "verify") return true;
  return ACTIVE_RUN_STATES.includes(run) && !o.cancelRequested;
}

// Whether a step in flight should be told to stop (its signal aborted) because its run ended or is being cancelled.
// Execute and verify steps are never interrupted: an AWS call in flight finishes and is recorded, and checks go on.
export const interruptible = (step: { kind: string }) => step.kind !== "execute" && step.kind !== "verify";

// What the operations an execute step started say about it (AGENT_ARCHITECTURE §4: "reconcile unknown outcomes before
// retrying"). The coordinator commits an operation row with its audit intent before anything reaches AWS, so:
//   none      → nothing was submitted: running the step again can't duplicate anything;
//   unknown   → one is still queued/running or its outcome is unknown: AWS may have acted — never retry, verify;
//   failed    → one failed or was cancelled (and none is in doubt);
//   succeeded → every one succeeded.
// The step's handler can be wrong about this (it threw, timed out or lost its response): the operation records win.
export type ExecuteSettlement = "none" | "unknown" | "failed" | "succeeded";
export function settleExecute(operationStates: readonly string[]): ExecuteSettlement {
  if (!operationStates.length) return "none";
  if (operationStates.some((s) => s !== "succeeded" && s !== "failed" && s !== "cancelled")) return "unknown";
  return operationStates.every((s) => s === "succeeded") ? "succeeded" : "failed";
}

// Retry backoff for retry-safe steps: 2 s, 4 s, 8 s … capped at 5 min, with up to 20% jitter (rand ∈ [0, 1)).
export const MAX_ATTEMPTS = 6;
export function backoffMs(attempt: number, rand = 0): number {
  const base = Math.min(5 * 60_000, 1_000 * 2 ** Math.max(1, Math.min(attempt, 20)));
  return Math.round(base * (1 + 0.2 * Math.min(Math.max(rand, 0), 1)));
}

// ---------- the agents switch ----------

export type AgentsSource = "env" | "settings" | "default";

// CONSOLE_AGENTS: on/true/1/yes or off/false/0/no. Anything else that is set fails closed (off): a typo must not turn
// agents on in a real account.
export function parseAgentsEnv(v: string | undefined): boolean | undefined {
  const s = v?.trim().toLowerCase();
  if (!s) return undefined;
  return ["on", "true", "1", "yes", "enabled"].includes(s);
}

// CONSOLE_AGENTS wins when set; else the admin's toggle (settings agents:enabled); else on with the simulated account
// and off against a real one. Unset or "mock" CONSOLE_SOURCE is the simulated account; anything else counts as real.
export function resolveAgentsEnabled(o: { env?: string; setting?: string | null; source?: string }): { on: boolean; source: AgentsSource } {
  const env = parseAgentsEnv(o.env);
  if (env !== undefined) return { on: env, source: "env" };
  if (o.setting === "on" || o.setting === "off") return { on: o.setting === "on", source: "settings" };
  const src = o.source?.trim().toLowerCase();
  return { on: !src || src === "mock", source: "default" };
}
