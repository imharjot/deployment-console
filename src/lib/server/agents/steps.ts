// The deterministic workflow steps (master plan §3.4 / §6 C7 item 5): the worker (./worker.ts) imports this module at
// start and calls registerHandlers(). A workflow run (./workflows.ts) is one step at a time: each step, once done,
// works out the next from the version's step list — conditions (`when`) are evaluated, skipped steps recorded as
// skipped, forEach steps repeated per target — and the last one ends the run. Every operation call goes through
// invoke() as the run's agent principal (agentCaller), so the run's policy decides each one: a read runs, a listed
// change on a listed target runs within bounded-act, anything else becomes an exact-plan approval request (the step
// waits for it), or is refused.
//
//   condition @start  inputs, trigger facts and the targets: resolved again and compared with the published ones —
//                     an addition pauses the run for review (it is never acted on); removed ones are left alone
//   tool / execute    a read (retry-safe) / a change (an execute step: settled by its operation records, never retried)
//   model             a child run of the agent runner with the step's goal; waits for it and records its outcome
//   approval / wait / condition / verify / notify   as in src/lib/agents/workflows.ts
//
// Kinds the agent runner also handles (tool, execute, verify, model) are shared: a step whose input carries `wf` is a
// workflow step and runs here, any other goes to the handler registered before this one (the runner's).
// registerHandlers() also puts the workflow scheduler on the worker loop and subscribes the event triggers.
import "server-only";
import { isFinalRun } from "../../agents/run-state.ts";
import type { AgentRunRow, AgentStepRow, RunState } from "../../agents/records.ts";
import { redactDeep } from "../../agents/redact.ts";
import { buildReport, renderMessage } from "../../agents/templates.ts";
import {
  advance, compareTargets, contextFor, defaultTitle, holds, progressOf, render, resolveInputs, stepKindOf, type Cursor, type Progress, type ReportKind, type RunFacts, type Target,
  type WorkflowNode,
} from "../../agents/workflows.ts";
import type { User } from "../../rbac.ts";
import { listEnvs } from "../discovery.ts";
import { homeRegion } from "../sources.ts";
import { HttpError, errText } from "../errors.ts";
import { getOperation, listOperations } from "../operations.ts";
import { countPending, getApproval } from "../ops/approvals.ts";
import { invoke } from "../ops/index.ts";
import { getGrant, grantStatus } from "./grants.ts";
import { agentCaller, delegatorOf, principalForRun } from "./principals.ts";
import { settlementOf } from "./reconcile.ts";
import { startEventTriggers, tick as schedulerTick } from "./scheduler.ts";
import { getRun, getSteps, updateRun, type StepInput } from "./store.ts";
import { registerStepHandler, registerTickTask, stepHandlerOf, type StepContext, type StepHandler, type StepOutcome } from "./worker.ts";
import { endRun, getVersion, opCatalog, resolveTargets, reviewDeadline, startManualRun, type Version } from "./workflows.ts";

const MAX_RESULT = 200_000;
const READ_RETRIES = 3;
const APPROVAL_RECHECK_MS = 15_000;
const REVIEW_RECHECK_MS = 60_000;
const CHILD_RECHECK_MS = 10_000;

interface WfRef {
  id: string;
  version: number;
  hash: string | null;
  node: number; // -1: the built-in first step
  nodeId: string;
  item?: number;
}

const parse = <T>(s: string | null, fallback: T): T => {
  try {
    return s ? (JSON.parse(s) as T) : fallback;
  } catch {
    return fallback;
  }
};

export function wfOf(step: Pick<AgentStepRow, "input">): { ref: WfRef; input: Record<string, unknown> } | undefined {
  const input = parse<Record<string, unknown> | null>(step.input, null);
  const wf = input && Object.hasOwn(input, "wf") ? (input.wf as Record<string, unknown>) : undefined;
  if (!wf || typeof wf !== "object" || typeof wf.id !== "string" || typeof wf.version !== "number" || typeof wf.node !== "number" || typeof wf.nodeId !== "string") return undefined;
  return { ref: wf as unknown as WfRef, input: input! };
}

const log = (level: number, msg: string, extra: Record<string, unknown> = {}) => console[level >= 50 ? "error" : "warn"](JSON.stringify({ level, msg, ...extra }));
const why = (e: unknown) => (e instanceof HttpError ? e.message : errText(e));
const statusOf = (e: unknown) => (e instanceof HttpError ? e.status : 500);

// Stored results are redacted and bounded (a step's result is shown to people and read by later steps).
function stored(v: unknown): unknown {
  const r = redactDeep(v).value;
  const text = JSON.stringify(r) ?? "null";
  return text.length > MAX_RESULT ? { truncated: true, bytes: text.length } : r;
}

// Moves the run between its waiting and running states (only from the states given; never a run that ended).
async function moveRun(runId: string, to: RunState, from: RunState[]) {
  const run = await getRun(runId);
  if (!run || run.state === to || !from.includes(run.state)) return;
  await updateRun(runId, { state: to }, { from }).catch(() => {});
}
const resume = (runId: string) => moveRun(runId, "running", ["waiting_approval", "waiting_external", "queued"]);

// ---------- the run's facts and progress ----------

interface StartResult {
  inputs?: RunFacts["inputs"];
  facts?: Record<string, unknown>;
  targets?: Target[];
  review?: unknown;
  decision?: string;
  removals?: string[];
}

interface Loaded {
  v: Version;
  run: AgentRunRow;
  facts: RunFacts;
  rows: AgentStepRow[];
}

function factsOf(run: AgentRunRow, start: StartResult | undefined): RunFacts {
  return {
    inputs: start?.inputs ?? {},
    trigger: { ...parse<Record<string, unknown>>(run.trigger, {}), ...(start?.facts ?? {}) },
    targets: start?.targets ?? [],
  };
}

function progressFrom(rows: AgentStepRow[], override?: { id: string; state: string; result?: unknown; error?: string }): Progress {
  return progressOf(
    rows.flatMap((r) => {
      const w = wfOf(r);
      if (!w || w.ref.node < 0) return [];
      const o = override && override.id === r.id ? override : undefined;
      return [{ nodeId: w.ref.nodeId, item: w.ref.item, state: o?.state ?? r.state, result: o ? o.result : parse<unknown>(r.result, undefined), error: o ? o.error : r.error }];
    }),
  );
}

// A run's verdict at its end: a step that failed, a check that didn't hold, or a child run that didn't succeed fails it.
// An optional read that failed doesn't (its report says what couldn't be read).
function verdict(p: Progress): { failed: boolean; error?: string } {
  const bad: string[] = [];
  for (const [id, e] of Object.entries(p)) {
    const views = e.items ? e.items.filter(Boolean) : [e];
    for (const x of views) {
      const r = (x.result && typeof x.result === "object" ? x.result : {}) as Record<string, unknown>;
      if (x.state === "failed" || x.state === "outcome_unknown" || (r.failed === true && r.optional !== true) || r.ok === false) {
        bad.push(`${id}${typeof r.error === "string" ? `: ${r.error}` : x.error ? `: ${x.error}` : ""}`);
        break;
      }
    }
  }
  return bad.length ? { failed: true, error: `not everything succeeded — ${bad.join("; ")}`.slice(0, 1_000) } : { failed: false };
}

// The step a position of the run becomes (its input rendered now, from what the run knows).
function stepFor(v: Version, node: WorkflowNode, cur: Cursor, ctx: Record<string, unknown>, facts: RunFacts): StepInput {
  const kind = stepKindOf(node, opCatalog);
  const wf: WfRef = { id: v.row.id, version: v.row.version, hash: v.row.hash, node: cur.node, nodeId: node.id, ...(cur.item !== undefined ? { item: cur.item } : {}) };
  const t = cur.item !== undefined ? facts.targets[cur.item] : undefined;
  const name = `${node.title ?? defaultTitle(node)}${t ? ` — ${t.env}/${t.service}` : ""}`.slice(0, 200);
  let input: Record<string, unknown>;
  switch (node.kind) {
    case "tool":
    case "verify":
      input = { wf, op: node.op, input: render(node.input, ctx) };
      break;
    case "model": {
      let resourceKey: unknown;
      try {
        resourceKey = node.resource ? render(node.resource, ctx) : undefined;
      } catch {
        resourceKey = undefined;
      }
      input = { wf, goal: renderMessage(node.goal, ctx), ...(typeof resourceKey === "string" ? { resourceKey } : {}) };
      break;
    }
    case "approval":
      input = { wf, message: renderMessage(node.message, ctx) };
      break;
    case "wait":
      input = { wf, seconds: node.seconds };
      break;
    case "condition":
      input = { wf, expr: node.expr };
      break;
    case "notify":
      input = { wf, to: node.to, report: node.report ?? "text", ...(node.message ? { message: renderMessage(node.message, ctx) } : {}) };
      break;
  }
  return { kind, name, input, retrySafe: kind === "tool" || kind === "verify" || kind === "condition" || kind === "wait" || kind === "notify" };
}

// A position recorded without running it (skipped, or refused before it could start).
function bare(v: Version, node: WorkflowNode, cur: Cursor, facts: RunFacts): StepInput {
  const t = cur.item !== undefined ? facts.targets[cur.item] : undefined;
  const wf: WfRef = { id: v.row.id, version: v.row.version, hash: v.row.hash, node: cur.node, nodeId: node.id, ...(cur.item !== undefined ? { item: cur.item } : {}) };
  return { kind: stepKindOf(node, opCatalog), name: `${node.title ?? defaultTitle(node)}${t ? ` — ${t.env}/${t.service}` : ""}`.slice(0, 200), input: { wf }, retrySafe: false };
}

const record = (p: Progress, id: string, item: number | undefined, view: { state: string; result?: unknown; error?: string }) => {
  if (item === undefined) p[id] = view;
  else {
    const e = (p[id] ??= { state: view.state, items: [] });
    (e.items ??= [])[item] = view;
  }
};

// After a step succeeded: the steps whose `when` is false are recorded as skipped, the next runnable one is queued,
// and when nothing is left the run ends (failed when anything in it failed).
async function continueAfter(l: Loaded, step: AgentStepRow, ref: WfRef, outcome: StepOutcome, facts: RunFacts): Promise<StepOutcome> {
  const progress = progressFrom(l.rows, { id: step.id, state: outcome.state, result: outcome.result, error: outcome.error });
  const next: StepInput[] = [];
  let cur: Cursor | null = ref.node < 0 ? null : { node: ref.node, item: ref.item };
  for (;;) {
    cur = advance(l.v.draft, cur, facts.targets.length);
    if (!cur) {
      const end = verdict(progress);
      await endRun(l.run.id, end.failed ? "failed" : "succeeded", end.error);
      return { ...outcome, next };
    }
    const node = l.v.draft.steps[cur.node];
    const ctx = contextFor(facts, progress, cur.item);
    let skip: string | undefined;
    try {
      if (node.when && !holds(node.when, ctx)) skip = "its condition is false";
    } catch (e) {
      skip = `its condition couldn't be evaluated (${why(e)})`;
    }
    if (skip) {
      next.push({ ...bare(l.v, node, cur, facts), state: "skipped", error: skip });
      record(progress, node.id, cur.item, { state: "skipped" });
      continue;
    }
    try {
      next.push(stepFor(l.v, node, cur, ctx, facts));
    } catch (e) {
      // A template with a hole in it never runs: the step is recorded failed and the run ends.
      next.push({ ...bare(l.v, node, cur, facts), state: "failed", error: `its input couldn't be filled in: ${why(e)}` });
      await endRun(l.run.id, "failed", `step ${node.id}: its input couldn't be filled in (${why(e)})`);
    }
    return { ...outcome, next };
  }
}

// A step that can't go on: the run ends with it (unless the failure is worth a retry).
async function failRun(l: Loaded, error: string, o: Partial<StepOutcome> = {}): Promise<StepOutcome> {
  await endRun(l.run.id, "failed", error);
  return { state: "failed", error, retry: false, ...o };
}

// ---------- the handlers ----------

type Body = (l: Loaded, step: AgentStepRow, ref: WfRef, input: Record<string, unknown>, ctx: StepContext) => Promise<StepOutcome>;

async function runWorkflowStep(step: AgentStepRow, ctx: StepContext, ref: WfRef, input: Record<string, unknown>, body: Body): Promise<StepOutcome> {
  const run = (await getRun(step.run_id)) ?? ctx.run;
  if (run.kind !== "workflow" || run.workflow_id !== ref.id || Number(run.workflow_version) !== ref.version) return { state: "failed", error: "this step doesn't belong to its run's workflow", retry: false };
  if (isFinalRun(run.state)) return { state: "cancelled", error: `the run ${run.state.replace(/_/g, " ")}` };
  const v = await getVersion(ref.id, ref.version);
  const rows = await getSteps(run.id);
  const startRow = rows.find((r) => wfOf(r)?.ref.node === -1);
  const start = startRow && startRow.id !== step.id ? parse<StartResult>(startRow.result, {}) : undefined;
  const l: Loaded = { v: v!, run, facts: factsOf(run, start), rows };
  if (!v || v.row.hash !== ref.hash) return failRun(l, "the workflow version this run started from is gone or changed");
  // Disabling a workflow ends its runs at their next step.
  if (v.row.state === "disabled") {
    await endRun(run.id, "cancelled", "the workflow was disabled");
    return { state: "cancelled", error: "the workflow was disabled" };
  }
  const out = await body(l, step, ref, input, ctx);
  if (out.state !== "succeeded") return out;
  const facts = ref.node < 0 ? factsOf(run, out.result as StartResult) : l.facts;
  return continueAfter(l, step, ref, out, facts);
}

const callerOf = async (run: AgentRunRow, stepId: string) => agentCaller(principalForRun(run), { stepId });

// @start: inputs, what the trigger names, and the targets (a review when there are new ones).
const startStep: Body = async (l, step) => {
  const run = l.run;
  const trig = parse<Record<string, unknown>>(run.trigger, {});
  const { values, problems } = resolveInputs(l.v.draft.inputs ?? [], trig.inputs);
  if (problems.length) return failRun(l, `invalid inputs: ${problems.join("; ")}`);
  const prev = parse<StartResult & { decidedBy?: string }>(step.result, {});
  const facts = await triggerFacts(trig, run.resource_key);
  let targets: Target[] = [];
  let removals: string[] = [];
  let excluded: unknown[] = [];
  if (l.v.draft.targets) {
    const published = l.v.frozen?.targets ?? [];
    const now = await resolveTargets(l.v.draft.targets);
    const keys = published.map((t) => t.key);
    const diff = compareTargets(keys, now.targets);
    // Only ever the published ones (as they are now); an addition is never acted on.
    targets = now.targets.filter((t) => keys.includes(t.key));
    removals = diff.removals;
    excluded = now.excluded.slice(0, 50);
    // A person's "cancel" stands even when the additions went away meanwhile.
    if (prev.decision === "cancel") {
      await endRun(run.id, "cancelled", `cancelled by ${prev.decidedBy ?? "a person"} after reviewing new targets`);
      return { state: "cancelled", error: "cancelled after review" };
    }
    if (diff.additions.length && prev.decision !== "continue") {
      const until = reviewDeadline(run);
      if (Date.now() >= until) return reviewExpired(l, "its new targets");
      await moveRun(run.id, "waiting_external", ["running"]);
      return {
        state: "waiting",
        wakeAt: Math.min(Date.now() + REVIEW_RECHECK_MS, until),
        result: {
          review: {
            reason: `${diff.additions.length} service(s) match the selector now but weren't in the published preview: nothing runs until a person reviews (they are never acted on — publish a new version to include them)`,
            additions: diff.additions.map((t) => t.key),
            removals,
            expiresAt: until,
          },
          inputs: stored(values), facts, targets,
        },
      };
    }
  }
  await resume(run.id);
  // Only the inputs (what a person typed) go through the redactor: the facts and targets are the console's own resource
  // keys, which it would take for secrets ("resourceKey" with a long value) — and later steps read them.
  return {
    state: "succeeded",
    result: { inputs: stored(values), facts, targets, removals, excluded, ...(prev.decision ? { review: prev.review, decision: prev.decision, decidedBy: prev.decidedBy } : {}) },
  };
};

// A pause for a person's review ends at reviewDeadline() (./workflows.ts): the run is cancelled.
async function reviewExpired(l: Loaded, what: string): Promise<StepOutcome> {
  const error = `nobody reviewed ${what} within the run's time limit — nothing was done; the next trigger starts afresh`;
  await endRun(l.run.id, "cancelled", error);
  return { state: "cancelled", error };
}

// What the trigger names: its resource key, and the environment and ECS service when the key is one.
async function triggerFacts(trig: Record<string, unknown>, resourceKey: string | null): Promise<Record<string, unknown>> {
  const key = resourceKey ?? (typeof trig.resourceKey === "string" ? trig.resourceKey : undefined);
  const event = (trig.event && typeof trig.event === "object" ? trig.event : {}) as Record<string, unknown>;
  let env = typeof trig.env === "string" ? trig.env : typeof event.env === "string" ? event.env : undefined;
  let service: string | undefined;
  if (key) {
    const local = /^service:([^/]+)$/.exec(key);
    const inv = /^ecs:service\/([^/]+)\/([^/@]+)(?:@(.+))?$/.exec(key);
    const canon = /^ecs-service:([^/]+)\/([^/]+)\/(.+)$/.exec(key);
    if (local && env) service = local[1];
    else if (inv || canon) {
      const [cluster, svc, region] = inv ? [inv[1], inv[2], inv[3]] : [canon![2], canon![3], canon![1]];
      // A cloud-map key names its region only outside the home region.
      const e = (await listEnvs().catch(() => [])).find((x) => x.cluster === cluster && x.region === (region || homeRegion()));
      if (e) {
        env = e.id;
        service = svc;
      }
    }
  }
  return { ...(key ? { resourceKey: key } : {}), ...(env ? { env } : {}), ...(service ? { service } : {}) };
}

const readStep: Body = async (l, step, ref, input) => {
  const node = l.v.draft.steps[ref.node];
  const optional = node?.kind === "tool" && node.optional === true;
  try {
    const r = await invoke(String(input.op), input.input, await callerOf(l.run, step.id));
    if (r.kind !== "result") return failRun(l, `${String(input.op)} didn't return a result`);
    return { state: "succeeded", result: stored(r.result) };
  } catch (e) {
    if (optional) return { state: "succeeded", result: { failed: true, optional: true, error: why(e).slice(0, 500) } };
    const s = statusOf(e);
    if ((s >= 500 || s === 429) && step.attempt < READ_RETRIES) return { state: "failed", error: why(e), retry: true };
    return failRun(l, `${String(input.op)}: ${why(e)}`);
  }
};

// A change: runs within the policy, or waits for the person who decides its approval request.
const changeStep: Body = async (l, step, _ref, input) => {
  const prev = parse<{ approval?: { id: string; grantId: string | null } }>(step.result, {});
  if (prev.approval) return awaitApproval(l, prev.approval);
  try {
    const r = await invoke(String(input.op), input.input, await callerOf(l.run, step.id));
    if (r.kind === "approval") {
      const a = { id: r.approval.id, grantId: r.approval.run?.grantId ?? null };
      return { state: "waiting", wakeAt: Date.now() + APPROVAL_RECHECK_MS, result: { approval: a, summary: r.approval.plan?.summary } };
    }
    if (r.kind !== "result") return failRun(l, `${String(input.op)} didn't return a result`);
    const operationId = (r.result as { operationId?: unknown } | null)?.operationId;
    return { state: "succeeded", result: stored(r.result), ...(typeof operationId === "string" ? { operationId } : {}) };
  } catch (e) {
    const s = statusOf(e);
    // The emergency stop and the agents switch: the worker keeps the step waiting (or queued) — the run goes on later.
    if (s === 423 || s === 503) return { state: "failed", error: why(e) };
    // Did anything reach AWS? Then the outcome is unknown: the worker verifies, nothing is retried, the run waits.
    const settled = await settlementOf(step).catch(() => ({ settle: "unknown" as const, operationId: undefined }));
    if (settled.settle === "unknown") return { state: "outcome_unknown", error: why(e), ...(settled.operationId ? { operationId: settled.operationId } : {}) };
    return failRun(l, `${String(input.op)}: ${why(e)}`);
  }
};

async function awaitApproval(l: Loaded, a: { id: string; grantId: string | null }): Promise<StepOutcome> {
  const waiting = (): StepOutcome => ({ state: "waiting", wakeAt: Date.now() + APPROVAL_RECHECK_MS, result: { approval: a } });
  const g = a.grantId ? await getGrant(a.grantId) : undefined;
  if (!g) return failRun(l, "the approval request is gone");
  const st = grantStatus(g);
  if (st === "rejected" || st === "invalidated" || st === "expired") return failRun(l, `the change was ${st}${g.reason ? `: ${g.reason}` : g.invalidation_reason ? `: ${g.invalidation_reason}` : ""}`, { result: { approval: a, status: st } });
  const row = await getApproval(g.approval_id ?? a.id);
  if (row?.status === "done") {
    await resume(l.run.id);
    return { state: "succeeded", result: { approval: a, status: "done", approvedBy: row.decided_by, operationId: g.consumed_operation_id }, ...(g.consumed_operation_id ? { operationId: g.consumed_operation_id } : {}) };
  }
  if (row?.status === "failed") return failRun(l, `the approved change failed: ${row.detail ?? "see the approval"}`, { result: { approval: a, status: "failed" } });
  if (g.consumed_operation_id) {
    const op = await getOperation(g.consumed_operation_id).catch(() => undefined);
    if (op?.state === "outcome_unknown") return failRun(l, `the approved change's outcome is unknown (operation ${op.id}) — it is being verified`, { result: { approval: a, status: "outcome_unknown" } });
  }
  return waiting();
}

// Polls a read until `expect` holds, or the step's time is up.
const verifyStep: Body = async (l, step, ref, input) => {
  const node = l.v.draft.steps[ref.node];
  if (node?.kind !== "verify") return failRun(l, "this verify step's definition is gone");
  const prev = parse<{ startedAt?: number; polls?: number }>(step.result, {});
  const startedAt = prev.startedAt ?? Date.now();
  const polls = (prev.polls ?? 0) + 1;
  let last: unknown;
  let error: string | undefined;
  let ok = false;
  try {
    const r = await invoke(String(input.op), input.input, await callerOf(l.run, step.id));
    last = r.kind === "result" ? r.result : undefined;
    ok = holds(node.expect, contextFor(l.facts, progressFrom(l.rows), ref.item, { result: last }));
  } catch (e) {
    error = why(e);
  }
  const brief = briefOf(last);
  if (ok) return { state: "succeeded", result: { ok: true, polls, startedAt, last: brief } };
  if (Date.now() - startedAt < node.timeoutSeconds * 1000)
    return { state: "waiting", wakeAt: Date.now() + (node.intervalSeconds ?? 15) * 1000, result: { startedAt, polls, last: brief, ...(error ? { lastError: error } : {}) } };
  const msg = `"${node.expect}" didn't hold within ${node.timeoutSeconds} s${error ? ` (${error})` : ""}`;
  if (node.optional) return { state: "succeeded", result: { ok: false, failed: true, error: msg, polls, startedAt, last: brief } };
  return failRun(l, msg, { result: { ok: false, polls, startedAt, last: brief } });
};

// What a check saw, in brief: the top-level numbers, flags and short strings.
function briefOf(v: unknown): Record<string, unknown> | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) {
    if (Object.keys(out).length >= 12) break;
    if (typeof x === "number" || typeof x === "boolean" || (typeof x === "string" && x.length <= 120)) out[k] = x;
  }
  return out;
}

const waitStep: Body = async (_l, step, _ref, input) => {
  const prev = parse<{ until?: number }>(step.result, {});
  const until = prev.until ?? Date.now() + Number(input.seconds ?? 0) * 1000;
  if (Date.now() >= until) return { state: "succeeded", result: { until } };
  return { state: "waiting", wakeAt: until, result: { until } };
};

const conditionStep: Body = async (l, _step, ref, input) => {
  try {
    return { state: "succeeded", result: { value: holds(String(input.expr), contextFor(l.facts, progressFrom(l.rows), ref.item)) } };
  } catch (e) {
    return failRun(l, `the condition couldn't be evaluated: ${why(e)}`);
  }
};

// A person's go-ahead (PATCH /api/agents/workflows/[id] { action: "review", runId, decision }).
const approvalStep: Body = async (l, step, _ref, input) => {
  const prev = parse<{ decision?: string; decidedBy?: string; review?: unknown }>(step.result, {});
  if (prev.decision === "continue") {
    await resume(l.run.id);
    return { state: "succeeded", result: { decision: "continue", decidedBy: prev.decidedBy } };
  }
  if (prev.decision === "cancel") {
    await endRun(l.run.id, "cancelled", `stopped by ${prev.decidedBy ?? "a person"}`);
    return { state: "cancelled", error: "stopped by a person" };
  }
  const until = reviewDeadline(l.run);
  if (Date.now() >= until) return reviewExpired(l, "the go-ahead it asked for");
  await moveRun(l.run.id, "waiting_external", ["running"]);
  return { state: "waiting", wakeAt: Math.min(Date.now() + REVIEW_RECHECK_MS, until), result: { review: { message: String(input.message ?? ""), expiresAt: until } } };
};

const notifyStep: Body = async (l, _step, _ref, input) => {
  const kind = (input.report as ReportKind) ?? "text";
  const pendingApprovals = kind === "digest" ? await countPending().catch(() => undefined) : undefined;
  const report = buildReport(kind, progressFrom(l.rows), { now: Date.now(), message: typeof input.message === "string" ? input.message : undefined, pendingApprovals });
  // To integrations: the run's title carries the headline, so the agent.run_finished (or _failed) notification the
  // outbox sends when the run ends says it.
  if (input.to === "integrations") await updateRun(l.run.id, { title: report.headline }).catch((e) => log(40, "workflow report title not set", { run: l.run.id, err: why(e) }));
  return { state: "succeeded", result: stored({ to: input.to, report }) };
};

// A model step: a child run of the agent runner with this goal (it reads, proposes, waits for people, executes and
// verifies on its own); this step waits for it to end and records what happened.
const modelStep: Body = async (l, step, _ref, input, ctx) => {
  const prev = parse<{ childRunId?: string; startedAt?: number }>(step.result, {});
  if (!prev.childRunId) {
    const start = await runnerStart();
    if (!start) return failRun(l, "the agent runner isn't available on this console, so a model step can't run");
    let child: string;
    try {
      const delegator: User = await delegatorOf(principalForRun(l.run));
      const r = await start({
        kind: "workflow", initiator: delegator, connectionId: l.run.connection_id, goal: String(input.goal ?? ""), resourceKey: typeof input.resourceKey === "string" ? input.resourceKey : undefined,
        workflowId: l.run.workflow_id ?? undefined, workflowVersion: l.run.workflow_version ?? undefined, policy: parse(l.run.policy, undefined), parentRunId: l.run.id,
        title: `${l.run.title ?? "workflow"}: ${step.name ?? "model"}`.slice(0, 200), trigger: { source: "workflow", parentRunId: l.run.id, step: step.id },
      });
      child = typeof r === "string" ? r : String((r as { runId?: unknown })?.runId ?? "");
      if (!child) throw new Error("the runner returned no run id");
    } catch (e) {
      return failRun(l, `the model step couldn't start: ${why(e)}`);
    }
    await moveRun(l.run.id, "waiting_external", ["running"]);
    return { state: "waiting", wakeAt: Date.now() + CHILD_RECHECK_MS / 2, result: { childRunId: child, startedAt: Date.now() } };
  }
  const child = await getRun(prev.childRunId);
  if (!child) return failRun(l, "the model step's child run is gone");
  if (!isFinalRun(child.state)) {
    if (ctx.signal.aborted) return { state: "cancelled", error: "the run ended" };
    return { state: "waiting", wakeAt: Date.now() + CHILD_RECHECK_MS, result: prev };
  }
  const ops = await listOperations({ runId: child.id, limit: 50 }).catch(() => []);
  const changed = ops.some((o) => o.state === "succeeded");
  const health = !ops.length ? "n/a" : ops.some((o) => o.verify === "failed" || o.state === "failed" || o.state === "outcome_unknown") ? "unhealthy" : ops.every((o) => o.verify === "verified") ? "verified" : "pending";
  await resume(l.run.id);
  return {
    state: "succeeded",
    result: stored({
      childRunId: child.id, runId: child.id, state: child.state, changed, health, summary: await childSummary(child.id),
      operations: ops.map((o) => ({ id: o.id, action: o.action, target: o.target, state: o.state, verify: o.verify ?? null })),
      ...(child.state !== "succeeded" ? { failed: true, error: child.error ?? `the model run ${child.state.replace(/_/g, " ")}` } : {}),
    }),
  };
};

// The runner's answer of a finished run: its last model step's text (whatever field the runner keeps it in).
async function childSummary(runId: string): Promise<string> {
  const steps = await getSteps(runId).catch(() => []);
  for (const s of [...steps].reverse()) {
    if (s.kind !== "model" || s.state !== "succeeded") continue;
    const r = parse<Record<string, unknown>>(s.result, {});
    for (const k of ["answer", "text", "summary", "content", "final"]) if (typeof r[k] === "string" && r[k]) return (r[k] as string).slice(0, 4_000);
  }
  return "";
}

type StartRun = (input: Record<string, unknown>) => Promise<string | { runId: string }>;
// The runner's startRun (master plan §6 C6), loaded when needed: this module must load without it.
async function runnerStart(): Promise<StartRun | undefined> {
  try {
    const m = (await import("./runner.ts")) as unknown as { startRun?: StartRun };
    return typeof m.startRun === "function" ? m.startRun : undefined;
  } catch (e) {
    log(40, "the agent runner didn't load", { err: why(e) });
    return undefined;
  }
}

// ---------- registration ----------

const BODIES: Record<string, Body> = {
  tool: readStep, execute: changeStep, verify: verifyStep, model: modelStep, wait: waitStep, condition: conditionStep, approval: approvalStep, notify: notifyStep,
};

const MINE = Symbol.for("console.workflowStepHandler");
type Composed = StepHandler & { [MINE]?: { prev?: StepHandler } };

// The handler registered for a kind before this one (the runner's), from the worker's registry.
function previous(kind: string): StepHandler | undefined {
  const h = stepHandlerOf(kind) as Composed | undefined;
  return h && h[MINE] ? h[MINE].prev : h;
}

export function workflowHandler(kind: string, prev?: StepHandler): StepHandler {
  const h: Composed = async (step, ctx) => {
    const w = wfOf(step);
    if (w) {
      const body = w.ref.node < 0 ? startStep : BODIES[step.kind];
      if (!body) return { state: "failed", error: `a workflow step can't be of kind ${step.kind}`, retry: false };
      return runWorkflowStep(step, ctx, w.ref, w.input, body);
    }
    if (prev) return prev(step, ctx);
    return { state: "queued", wakeAt: Date.now() + 60_000, error: `no handler for ${kind} steps outside workflows yet` };
  };
  h[MINE] = { prev };
  return h;
}

export async function registerHandlers(): Promise<void> {
  for (const kind of ["tool", "execute", "verify", "model", "wait", "condition", "approval", "notify"] as const) registerStepHandler(kind, workflowHandler(kind, previous(kind)));
  registerTickTask("workflow-scheduler", 15_000, (now) => schedulerTick(now));
  startEventTriggers();
  // POST /api/agents/runs { kind: "workflow", workflowId } (the runner's route) starts the published version by hand.
  try {
    const m = (await import("./runner.ts")) as unknown as { setWorkflowStarter?: (fn: (i: { initiator: User; workflowId?: string; resourceKey?: string; trigger?: Record<string, unknown> }) => Promise<string>) => void };
    m.setWorkflowStarter?.((i) => {
      if (!i.workflowId) throw new HttpError(400, "workflowId is required");
      return startManualRun(i.initiator, i.workflowId, i.trigger?.inputs, i.resourceKey);
    });
  } catch (e) {
    log(40, "the runner didn't take the workflow starter", { err: why(e) });
  }
}
