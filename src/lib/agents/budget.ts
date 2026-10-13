// Run budgets (master plan §6 C6 items 1–2, AGENT_ARCHITECTURE §6 "their combined budget is bounded by the parent").
// Pure: the runner (src/lib/server/agents/runner.ts) keeps a run's usage in agent_runs.usage and its children's
// reservations in agent_runs.reserved, and asks these functions before every model turn and every batch of tool calls.
//
// - A run's budget is its policy's limits: model turns, tool calls, wall time and — only where it can be measured — an
//   estimated cost (a runtime CLI reports one; the scripted model costs nothing; an API model's price isn't guessed).
//   Exceeding one pauses the run (paused_budget), it never silently continues.
// - A child run reserves its budget from what the parent has left (its own use plus every live child's reservation),
//   so children started in parallel can never spend more than the parent may. When a child ends, its reservation
//   shrinks to what it actually used and the rest returns to the parent.
import type { AgentPolicy } from "./types.ts";

export interface RunUsage {
  turns: number; // model turns made
  toolCalls: number; // tool calls and proposals the model asked for (or a runtime / external client made)
  inputTokens: number;
  outputTokens: number;
  costUsd: number; // estimated, summed over the calls whose cost could be measured
  costUnmeasured: number; // model calls whose cost couldn't be measured (an API model: no price is guessed)
  evidence: number; // citation ids handed out (E1, E2, …)
}

export const EMPTY_USAGE: RunUsage = { turns: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, costUnmeasured: 0, evidence: 0 };

export interface RunBudget {
  turns: number;
  toolCalls: number;
  runtimeSeconds: number;
  costUsd?: number; // a ceiling on the *estimated* cost, checked against what could be measured (never a guessed price)
}

export const budgetOf = (p: AgentPolicy): RunBudget => ({
  turns: p.limits.modelTurns,
  toolCalls: p.limits.toolCalls,
  runtimeSeconds: p.limits.runtimeSeconds,
  ...(p.limits.costUsd !== undefined ? { costUsd: p.limits.costUsd } : {}),
});

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const nonNeg = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);

// The stored usage (agent_runs.usage, JSON), own properties only; anything unreadable counts as nothing used yet.
export function parseUsage(raw: unknown): RunUsage {
  let v: unknown = raw;
  if (typeof raw === "string") {
    try {
      v = JSON.parse(raw);
    } catch {
      v = undefined;
    }
  }
  if (!isObj(v)) return { ...EMPTY_USAGE };
  const out = { ...EMPTY_USAGE };
  for (const k of Object.keys(EMPTY_USAGE) as (keyof RunUsage)[]) if (Object.hasOwn(v, k)) out[k] = nonNeg(v[k]);
  return out;
}

export function addUsage(u: RunUsage, d: Partial<RunUsage>): RunUsage {
  const out = { ...u };
  for (const k of Object.keys(EMPTY_USAGE) as (keyof RunUsage)[]) if (d[k] !== undefined) out[k] = nonNeg(out[k] + nonNeg(d[k]));
  out.costUsd = Math.round(out.costUsd * 1e6) / 1e6;
  return out;
}

export type BudgetLimit = "turns" | "toolCalls" | "runtime" | "cost";
export type BudgetCheck = { ok: true } | { ok: false; limit: BudgetLimit; message: string };

const over = (limit: BudgetLimit, message: string): BudgetCheck => ({ ok: false, limit, message });

// What a run's children hold of its budget (live: what they reserved; ended: what they used). The run itself may
// spend only the rest, so the parent and its children together stay within the parent's limits.
function held(r: Reservations = {}) {
  return { turns: sum(r, (x) => x.turns), toolCalls: sum(r, (x) => x.toolCalls), costUsd: sum(r, (x) => x.costUsd ?? 0) };
}
const byChildren = (n: number) => (n > 0 ? ` (${Math.round(n * 1e6) / 1e6} of it held by its child runs)` : "");

// Before a model turn: one more turn, the run's wall time, and the estimated cost so far — out of what its children
// (`r`, agent_runs.reserved) don't hold.
export function checkTurn(b: RunBudget, u: RunUsage, elapsedMs: number, r?: Reservations): BudgetCheck {
  const h = held(r);
  if (u.turns >= b.turns - h.turns) return over("turns", `the run's model turn limit (${b.turns}) is reached${byChildren(h.turns)}`);
  if (elapsedMs > b.runtimeSeconds * 1000) return over("runtime", `the run's time limit (${b.runtimeSeconds} s) is reached`);
  if (b.costUsd !== undefined && u.costUsd >= b.costUsd - h.costUsd)
    return over("cost", `the run's estimated cost ($${u.costUsd.toFixed(4)}) reached its limit ($${b.costUsd})${byChildren(h.costUsd)}`);
  return { ok: true };
}

// Before the tool calls of a turn run: all of them fit, or none runs (a turn's side effects are all or nothing).
export function checkCalls(b: RunBudget, u: RunUsage, n: number, r?: Reservations): BudgetCheck {
  const h = held(r);
  const left = Math.max(0, b.toolCalls - h.toolCalls - u.toolCalls);
  if (n > left) return over("toolCalls", `the turn asked for ${n} tool call${n === 1 ? "" : "s"}, but the run has ${left} of its ${b.toolCalls} left${byChildren(h.toolCalls)}`);
  return { ok: true };
}

// ---------- children ----------

export interface Reservation {
  turns: number;
  toolCalls: number;
  costUsd?: number;
  released?: boolean; // the child ended: the amounts are what it actually used
}
export type Reservations = Record<string, Reservation>;

export function parseReservations(raw: unknown): Reservations {
  let v: unknown = raw;
  if (typeof raw === "string") {
    try {
      v = JSON.parse(raw);
    } catch {
      v = undefined;
    }
  }
  if (!isObj(v)) return {};
  const out: Reservations = {};
  for (const [id, r] of Object.entries(v)) {
    if (!isObj(r)) continue;
    out[id] = {
      turns: nonNeg(r.turns),
      toolCalls: nonNeg(r.toolCalls),
      ...(Object.hasOwn(r, "costUsd") && r.costUsd !== undefined ? { costUsd: nonNeg(r.costUsd) } : {}),
      ...(r.released === true ? { released: true } : {}),
    };
  }
  return out;
}

const sum = (r: Reservations, f: (x: Reservation) => number) => Object.values(r).reduce((n, x) => n + f(x), 0);

// What is left for the parent itself or a new child: the limit, minus the parent's own use, minus every child's
// reservation (live: what it reserved; ended: what it used). Wall time isn't shared out — children run in parallel —
// but no child outlives the parent's own time limit.
export function available(b: RunBudget, u: RunUsage, r: Reservations, elapsedMs: number): RunBudget {
  return {
    turns: Math.max(0, b.turns - u.turns - sum(r, (x) => x.turns)),
    toolCalls: Math.max(0, b.toolCalls - u.toolCalls - sum(r, (x) => x.toolCalls)),
    runtimeSeconds: Math.max(0, Math.floor(b.runtimeSeconds - elapsedMs / 1000)),
    ...(b.costUsd !== undefined ? { costUsd: Math.max(0, b.costUsd - u.costUsd - sum(r, (x) => x.costUsd ?? 0)) } : {}),
  };
}

export type ReserveResult = { ok: true; budget: RunBudget; reserved: Reservations } | { ok: false; why: string };

// A child asks for `want` (its own policy's limits, already no broader than the parent's — narrow()); it gets the
// smaller of that and what the parent has left, reserved under its id. Nothing left (no tool call, no time) → refused.
export function reserveChild(parent: { budget: RunBudget; usage: RunUsage; reserved: Reservations; elapsedMs: number }, childId: string, want: RunBudget): ReserveResult {
  if (Object.hasOwn(parent.reserved, childId)) return { ok: false, why: "this child already holds a reservation" };
  const left = available(parent.budget, parent.usage, parent.reserved, parent.elapsedMs);
  const budget: RunBudget = {
    turns: Math.min(want.turns, left.turns),
    toolCalls: Math.min(want.toolCalls, left.toolCalls),
    runtimeSeconds: Math.min(want.runtimeSeconds, left.runtimeSeconds),
    ...(left.costUsd !== undefined || want.costUsd !== undefined ? { costUsd: Math.min(want.costUsd ?? Infinity, left.costUsd ?? Infinity) } : {}),
  };
  if (budget.toolCalls < 1) return { ok: false, why: `the parent run has no tool calls left to give (${parent.budget.toolCalls} in all, the rest used or reserved by its other children)` };
  if (budget.runtimeSeconds < 1) return { ok: false, why: "the parent run's time is up" };
  if (budget.costUsd !== undefined && budget.costUsd <= 0) return { ok: false, why: "the parent run's estimated cost budget is used up" };
  const res: Reservation = { turns: budget.turns, toolCalls: budget.toolCalls, ...(budget.costUsd !== undefined ? { costUsd: budget.costUsd } : {}) };
  return { ok: true, budget, reserved: { ...parent.reserved, [childId]: res } };
}

// The child ended: its reservation becomes what it used (never more than it reserved), and the rest is the parent's again.
export function releaseChild(reserved: Reservations, childId: string, used: RunUsage): Reservations {
  const r = reserved[childId];
  if (!r || r.released) return reserved;
  return {
    ...reserved,
    [childId]: {
      turns: Math.min(r.turns, used.turns),
      toolCalls: Math.min(r.toolCalls, used.toolCalls),
      ...(r.costUsd !== undefined ? { costUsd: Math.min(r.costUsd, used.costUsd) } : {}),
      released: true,
    },
  };
}

// ---------- what a person sees (the run view's budget meter) ----------

export interface BudgetView {
  limits: RunBudget;
  used: { turns: number; toolCalls: number; seconds: number; inputTokens: number; outputTokens: number; costUsd?: number };
  remaining: RunBudget;
  reservedForChildren?: { turns: number; toolCalls: number; costUsd?: number };
  cost: "estimated" | "partly estimated" | "not measurable" | "none";
}

export function budgetView(b: RunBudget, u: RunUsage, r: Reservations, elapsedMs: number): BudgetView {
  const live = Object.values(r);
  const measured = u.costUsd > 0 || u.costUnmeasured === 0;
  return {
    limits: b,
    used: {
      turns: u.turns, toolCalls: u.toolCalls, seconds: Math.max(0, Math.round(elapsedMs / 1000)), inputTokens: u.inputTokens, outputTokens: u.outputTokens,
      ...(measured ? { costUsd: u.costUsd } : {}),
    },
    remaining: available(b, u, r, elapsedMs),
    ...(live.length ? { reservedForChildren: { turns: sum(r, (x) => x.turns), toolCalls: sum(r, (x) => x.toolCalls), ...(live.some((x) => x.costUsd !== undefined) ? { costUsd: sum(r, (x) => x.costUsd ?? 0) } : {}) } } : {}),
    cost: u.turns === 0 && u.costUnmeasured === 0 ? "none" : u.costUnmeasured === 0 ? "estimated" : u.costUsd > 0 ? "partly estimated" : "not measurable",
  };
}
