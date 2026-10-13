// The agent runner (master plan §3.4 / §6 C6; AGENT_ARCHITECTURE §4 "durable run coordinator", §6, §9, §10).
//
// startRun() builds a run from the server's own facts — the person, their connection, a template's (or a stored
// definition's) policy narrowed to the resource and its neighbourhood, a child's budget reserved from its parent —
// never from anything a model says. The worker (./worker.ts) then runs its durable steps through the handlers
// registered here:
//
//   model    one turn: context.ts builds the prompt, the conversation and the tool specs (whose hash must match the
//            run's), the connection is resolved by the broker for this run (no fallback), the model answers inside the
//            agent context. Its calls are buffered until the turn completed and every argument validated, then the
//            reads become `tool` steps and the changes `propose` steps, with the next turn waiting on all of them.
//            Turns, tool calls, wall time and (where measurable, labelled estimated) cost are budgeted → paused_budget.
//            A runtime:* connection runs the person's CLI once, with a run token, instead of this loop.
//   tool     a read through invoke() as the agent → evidence E1… (tools.ts); a refusal is a result too.
//   propose  a dry run, fresh evidence when what the run has is older than the policy allows, then the call itself:
//            the registry turns it into an exact-plan grant and approval request (grants.ts) — or, for a bounded-act
//            change, an execute step.
//   execute  (queued by decideGrant when a person approves) re-plans and compares with the grant, then invoke() with
//            the grant and the idempotency key run:<run>:step:<step>; a drifted plan withdraws the grant and asks again.
//   verify   reads the operation and the service until the change is verified healthy, unhealthy (escalated) or the
//            window passes: "AWS accepted" is never reported as healthy.
//
// Calls that don't come from a step — an embedded CLI's or an external agent's MCP calls — reach the run through
// onAgentInvoke and are recorded as tool / propose steps (evidence, grants). A run ends when nothing is left to run and
// no request waits for a person (settleRun), with a three-part outcome: AI response, AWS acceptance, verified health.
//
// Handler registrations, subscriptions, timers and in-flight captures live on globalThis.__consoleRunner: the worker
// runs in the instrumentation bundle, routes start and cancel runs from theirs.
import "server-only";
import { addUsage, available, budgetOf, budgetView, checkCalls, checkTurn, parseReservations, parseUsage, releaseChild, reserveChild, type Reservations, type RunUsage } from "../../agents/budget.ts";
import { DEMO_CONNECTION_ID, payerOf, type Provider } from "../../agents/connection-rules.ts";
import { checkChange, citedIds, finalState, isFresh, runOutcome, serviceFacts, type ChangeFacts, type EvidenceView, type RunOutcome } from "../../agents/evidence.ts";
import { parsePrincipal, principalSummary } from "../../agents/identity.ts";
import { CAPABILITY_MAP_VERSION } from "../../agents/inference/capabilities.ts";
import type { GenerateResult } from "../../agents/inference/types.ts";
import { DEFAULT_POLICIES, PolicyError, isTemplateName, listed, narrow, parsePolicy, policyHash, type TemplateName } from "../../agents/policy.ts";
import { DEFAULT_QUESTION, runtimePrompt } from "../../agents/prompts.ts";
import { TEMPLATES } from "../../agents/templates.ts";
import type { AgentRunRow, AgentStepRow, ApprovalGrantRow, RunState } from "../../agents/records.ts";
import { redact, redactDeep } from "../../agents/redact.ts";
import { ACTIVE_RUN_STATES, canTransitionRun, isFinalRun, isPendingStep } from "../../agents/run-state.ts";
import { runStateForRuntimeError } from "../../agents/runtime/types.ts";
import type { AgentPolicy, AgentPrincipal, ResourceSelector } from "../../agents/types.ts";
import { resourceRegion } from "../../inventory/schedule.ts";
import { keysForInventory } from "../../mutation-keys.ts";
import { toolName } from "../../ops-schema.ts";
import { VERIFIED_ACTION, VERIFY_WINDOW_MS } from "../../overview-rules.ts";
import { can, type User } from "../../rbac.ts";
import type { OperationView } from "../../types.ts";
import { writeAudit } from "../audit.ts";
import { mintRunToken, revokeRunTokens } from "../auth/agent-tokens.ts";
import { getDb, newId } from "../db.ts";
import { HttpError, errText } from "../errors.ts";
import { findResource, resourceEdges } from "../inventory.ts";
import { getOperation, listOperations, markVerified } from "../operations.ts";
import { findOp, invoke, onAgentInvoke, type AgentInvokeEvent } from "../ops/index.ts";
import { getApproval, planOf } from "../ops/approvals.ts";
import { homeRegion } from "../sources.ts";
import { buildTurn, parseJson, sealAssistant, transcriptOf, type CallStepInput, type ModelStepInput, type ModelStepResult, type TurnCall } from "./context.ts";
import { getConnection, isCredentialError, markConnectionStatus, onConnectionChange, resolveConnection } from "./credentials.ts";
import { onEvent } from "./events.ts";
import { grantExecution, grantStatus, getGrant, invalidateGrant } from "./grants.ts";
import { generateWith, inferenceRecovery } from "./inference/registry.ts";
import { agentCaller, outsideAgentContext, policyForRun, principalForRun, withAgentContext } from "./principals.ts";
import { operationsOfStep } from "./reconcile.ts";
import { consoleMcpUrl, runtimeForProvider } from "./runtime/registry.ts";
import { AGENTS_OFF, agentsEnabled } from "./stop.ts";
import { appendStep, coded, createRun, getRun, getSteps, listRuns, recordModelCall, updateRun, type StepInput } from "./store.ts";
import { asEvidence, classifyCall, ensureToolsUnchanged, evidenceView, readAsEvidence, refusalText, TOOLS_CHANGED, toolSpecsFor, toolsHash, type ToolOutcome } from "./tools.ts";
import { cancelInflight, enqueueStep, registerStepHandler, registerTickTask, type StepContext, type StepOutcome } from "./worker.ts";

// ---------- shared state (globalThis: the worker and the routes are separate bundles) ----------

interface RunnerState {
  unsubscribe: (() => void)[];
  captures: Map<string, AgentInvokeEvent[]>; // a step's own registry calls, as onAgentInvoke reported them
  recording: Map<string, Promise<unknown>>; // per run: external / runtime calls are recorded one after another
  settling: Map<string, ReturnType<typeof setTimeout>>;
}
const g = globalThis as { __consoleRunner?: RunnerState };
const st: RunnerState = (g.__consoleRunner ??= { unsubscribe: [], captures: new Map(), recording: new Map(), settling: new Map() });

const log = (level: number, msg: string, extra: Record<string, unknown> = {}) => console[level >= 50 ? "error" : "warn"](JSON.stringify({ level, msg, ...extra }));

const MAX_GOAL = 4_000;
const RETRY_INCOMPLETE = 2;
const VERIFY_POLL_MS = 10_000;
const PAUSE_RECHECK_MS = 60_000;
const READ_FOR_TARGET = ["services.get", "cloud.get"] as const;

// ---------- usage and citation ids (compare-and-set on agent_runs.usage) ----------

async function bumpUsage(runId: string, d: Partial<RunUsage>): Promise<RunUsage> {
  const db = await getDb();
  for (let i = 0; i < 25; i++) {
    const row = await db.get<{ usage: string | null }>("SELECT usage FROM agent_runs WHERE id = ?", [runId]);
    if (!row) throw new HttpError(404, "no such run");
    const next = addUsage(parseUsage(row.usage), d);
    if ((await db.run("UPDATE agent_runs SET usage = ? WHERE id = ? AND COALESCE(usage, '') = ?", [JSON.stringify(next), runId, row.usage ?? ""])) === 1) return next;
  }
  throw new HttpError(409, "the run's usage changed too often at once — try again");
}

// Citation ids for n new pieces of evidence: E<k>, numbered per run in the order they were handed out.
export async function allocateEvidence(runId: string, n: number): Promise<string[]> {
  if (n <= 0) return [];
  const u = await bumpUsage(runId, { evidence: n });
  return Array.from({ length: n }, (_, i) => `E${u.evidence - n + i + 1}`);
}

// ---------- start ----------

export interface StartRunInput {
  kind: "assistant" | "workflow" | "external";
  initiator: User;
  connectionId: string;
  goal?: string;
  resourceKey?: string;
  title?: string;
  template?: TemplateName; // default incident-investigator
  policy?: AgentPolicy; // a stored definition's or workflow's (server-side only — never a model's or a request body's)
  agentId?: string;
  agentVersion?: number;
  workflowId?: string;
  workflowVersion?: number;
  parentRunId?: string;
  steps?: StepInput[]; // the first steps (a workflow's graph); default: one model turn
  trigger?: Record<string, unknown>;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

// The resource a question is about, and everything connected to it on the cloud map: the keys a scoped run may read
// (and propose changes to), and its environment.
export async function neighbourhood(resourceKey: string): Promise<ResourceSelector> {
  const f = await findResource(resourceKey);
  if (!f) throw coded(404, `no resource ${resourceKey.slice(0, 200)} on the cloud map`, "resource_missing");
  const home = homeRegion();
  const names = new Set<string>();
  const add = (r: { key: string; aliases?: string[]; region?: string } & Record<string, unknown>) => {
    names.add(r.key);
    for (const a of r.aliases ?? []) names.add(a);
    for (const k of keysForInventory(r.key, resourceRegion(r as never, home), home)) names.add(k);
  };
  add(f.resource as never);
  for (const e of (await resourceEdges(f.resource.key).catch(() => [])).slice(0, 50)) {
    const other = await findResource(e.from === f.resource.key ? e.to : e.from).catch(() => undefined);
    if (other) add(other.resource as never);
  }
  return { ...(f.resource.env ? { envs: [f.resource.env] } : {}), keys: [...names].slice(0, 200) };
}

const deadlineFor = (p: AgentPolicy, now: number) =>
  // The agent's own work is bounded by runtimeSeconds; on top: a person's decision and the execution window after it
  // (the grant's expiry, twice) and the verification window — so a run waiting on a person isn't failed by the clock.
  now + (p.limits.runtimeSeconds + 2 * p.approval.expireAfterSeconds) * 1000 + VERIFY_WINDOW_MS + 60_000;

export async function startRun(i: StartRunInput): Promise<string> {
  if (!(await agentsEnabled()).on) throw coded(503, AGENTS_OFF, "agents_off");
  if (i.kind === "external") throw new HttpError(400, "external runs start with their agent token (Automation → Connect)");
  // A workflow's own run starts from its published version (c-workflows); here only its model steps' child runs.
  if (i.kind === "workflow" && !i.policy && !i.steps) throw coded(400, "a workflow run starts from its published workflow", "workflow_policy");
  const goalRaw = typeof i.goal === "string" ? i.goal : "";
  if (goalRaw.length > MAX_GOAL) throw new HttpError(400, `the question is too long (at most ${MAX_GOAL} characters)`);
  const goal = redact(goalRaw.trim() || DEFAULT_QUESTION).text; // a secret pasted into a question is never stored or sent
  if (i.resourceKey !== undefined && (typeof i.resourceKey !== "string" || !i.resourceKey || i.resourceKey.length > 2048)) throw new HttpError(400, "resourceKey must be a resource key");
  const template = i.template ?? "incident-investigator";
  if (!isTemplateName(template)) throw new HttpError(400, "unknown agent template");
  // The connection: usable by this person now (the broker checks it again on every model call).
  const conn = await getConnection(i.connectionId, i.initiator).catch((e) => {
    throw e instanceof HttpError && e.status === 404 ? coded(404, "no such connection", "connection_missing") : e;
  });
  if (!conn.usable) throw coded(403, `this connection can't be used: ${conn.why ?? "not usable"}`, "connection_unusable");
  // The policy: the given one (validated) or the template's, narrowed to the resource's neighbourhood.
  let policy: AgentPolicy;
  try {
    policy = i.policy ? parsePolicy(JSON.parse(JSON.stringify(i.policy))) : structuredClone(DEFAULT_POLICIES[template]);
    if (i.resourceKey) {
      // Only ever narrower: the resource's environment, and its neighbourhood's keys within the policy's own keys.
      const near = await neighbourhood(i.resourceKey);
      const keys = policy.scope.keys?.length ? (near.keys ?? []).filter((k) => policy.scope.keys!.includes(k)) : near.keys;
      if (policy.scope.keys?.length && !keys?.length) throw new PolicyError(`${i.resourceKey} isn't one of the agent's resources`);
      policy = narrow(policy, { ...policy, scope: { ...policy.scope, ...(near.envs ? { envs: near.envs } : {}), ...(keys?.length ? { keys } : {}) } });
    }
  } catch (e) {
    if (e instanceof PolicyError) throw coded(403, `the resource is outside what this agent may look at: ${e.message}`, "scope");
    throw e;
  }
  policy = { ...policy, billing: { connection: i.connectionId, fallback: "none" } };
  const runId = newId();
  const now = Date.now();
  const db = await getDb();
  let parentPolicy: AgentPolicy | undefined;
  let parent: AgentRunRow | undefined;
  if (i.parentRunId) {
    parent = await getRun(i.parentRunId);
    if (!parent || isFinalRun(parent.state)) throw coded(409, "the parent run has ended", "run_finished");
    if ((parsePrincipal(parent.principal)?.delegatorId ?? parent.initiator_id) !== i.initiator.id) throw coded(403, "a child run acts for the same person as its parent", "principal_mismatch");
    parentPolicy = parsePolicy(JSON.parse(parent.policy ?? "null"));
    try {
      policy = narrow(parentPolicy, policy);
    } catch (e) {
      throw coded(403, (e as Error).message, "policy_broader");
    }
  }
  return db.tx(async (tx) => {
    if (parent && parentPolicy) {
      // The child's budget comes out of what the parent has left; its policy's limits become that reservation.
      const cur = (await tx.get<AgentRunRow>("SELECT * FROM agent_runs WHERE id = ?", [parent.id]))!;
      const r = reserveChild(
        { budget: budgetOf(parentPolicy), usage: parseUsage(cur.usage), reserved: parseReservations(cur.reserved), elapsedMs: now - Number(cur.created_at) },
        runId,
        budgetOf(policy),
      );
      if (!r.ok) throw coded(409, r.why, "budget");
      if ((await tx.run("UPDATE agent_runs SET reserved = ? WHERE id = ? AND COALESCE(reserved, '') = ?", [JSON.stringify(r.reserved), parent.id, cur.reserved ?? ""])) !== 1)
        throw coded(409, "the parent run's budget changed at the same time — try again", "budget");
      policy = {
        ...policy,
        limits: { ...policy.limits, modelTurns: r.budget.turns, toolCalls: r.budget.toolCalls, runtimeSeconds: r.budget.runtimeSeconds, ...(r.budget.costUsd !== undefined ? { costUsd: r.budget.costUsd } : {}) },
      };
    }
    const hash = policyHash(policy);
    const principal: AgentPrincipal = {
      id: `agent:${runId}`, kind: "agent", runId, delegatorId: i.initiator.id, delegatorEmail: i.initiator.email, policyHash: hash, mode: policy.mode,
      ...(i.agentId ? { agentId: i.agentId, agentVersion: i.agentVersion } : {}), ...(i.workflowId ? { workflowId: i.workflowId, workflowVersion: i.workflowVersion } : {}),
      ...(i.parentRunId ? { parentRunId: i.parentRunId } : {}),
    };
    // The tools this run may see, hashed once: names, descriptions and schemas from the registry (policy-filtered).
    const specs = toolSpecsFor({ user: i.initiator, via: "agent", principal, policy, runId });
    await createRun(
      {
        id: runId, kind: i.kind, title: (i.title ?? goal.split("\n")[0]).slice(0, 200), initiatorId: i.initiator.id, principal, agentId: i.agentId, agentVersion: i.agentVersion,
        workflowId: i.workflowId, workflowVersion: i.workflowVersion, connectionId: i.connectionId, scope: policy.scope, policy, policyHash: hash, toolsHash: toolsHash(specs),
        budget: budgetOf(policy), trigger: { source: i.kind, goal, ...(i.resourceKey ? { resourceKey: i.resourceKey } : {}), template, ...(i.trigger ?? {}) },
        parentRunId: i.parentRunId, resourceKey: i.resourceKey, deadlineAt: deadlineFor(policy, now),
      },
      tx,
    );
    const first: StepInput[] = i.steps?.length ? i.steps : [{ kind: "model", name: "turn 1", input: { goal, ...(i.resourceKey ? { resourceKey: i.resourceKey } : {}) } satisfies ModelStepInput, retrySafe: true }];
    for (const s of first) await enqueueStep(runId, s, tx);
    return runId;
  });
}

// ---------- run-state helpers ----------

const PAUSABLE: RunState[] = [...ACTIVE_RUN_STATES];

async function pauseRun(runId: string, state: "paused_auth" | "paused_budget", why: string) {
  await updateRun(runId, { state, error: why }, { from: PAUSABLE }).catch(() => {});
}

async function failRun(runId: string, why: string) {
  const run = await getRun(runId);
  if (run && !isFinalRun(run.state) && canTransitionRun(run.state, "failed")) await updateRun(runId, { state: "failed", error: why }, { from: [run.state] }).catch(() => {});
}

// The run's goal and resource, from its trigger (what startRun stored).
function goalOf(run: AgentRunRow): { goal: string; resourceKey?: string } {
  const t = parseJson<{ goal?: unknown; resourceKey?: unknown }>(run.trigger) ?? {};
  return { goal: typeof t.goal === "string" ? t.goal : DEFAULT_QUESTION, ...(typeof t.resourceKey === "string" ? { resourceKey: t.resourceKey } : {}) };
}

class LeaseGone extends Error {
  constructor() {
    super("this step's lease was taken over before its follow-up steps were written");
    this.name = "LeaseGone";
  }
}

// Steps that follow a model turn are written in one transaction, only while this worker still holds the turn's lease.
async function appendFollowUps(step: AgentStepRow, build: (append: (s: StepInput) => Promise<string>) => Promise<void>) {
  const db = await getDb();
  await db.tx(async (tx) => {
    const cur = await tx.get<{ fence: number | string; state: string }>("SELECT fence, state FROM agent_steps WHERE id = ?", [step.id]);
    if (!cur || Number(cur.fence) !== step.fence || cur.state !== "leased") throw new LeaseGone();
    await build(async (s) => (await enqueueStep(step.run_id, s, tx)).id);
  });
}

// ---------- model ----------

async function modelStep(step: AgentStepRow, ctx: StepContext): Promise<StepOutcome> {
  const run = ctx.run;
  if (run.state === "queued") await updateRun(run.id, { state: "running" }, { from: ["queued"] }).catch(() => {});
  const principal = principalForRun(run);
  const { policy } = await policyForRun(run.id, principal);
  const { goal, resourceKey } = goalOf(run);
  let conn: Awaited<ReturnType<typeof resolveConnection>>;
  try {
    conn = await resolveConnection(run.connection_id ?? "", { kind: "run", runId: run.id, principal });
  } catch (e) {
    if (!isCredentialError(e)) throw e;
    await pauseRun(run.id, "paused_auth", e.message);
    return { state: "waiting", wakeAt: Date.now() + PAUSE_RECHECK_MS, error: e.message };
  }
  const budget = budgetOf(policy);
  // Read now, not at claim time: a child run may just have reserved part of this run's budget.
  const fresh = (await getRun(run.id)) ?? run;
  const usage = parseUsage(fresh.usage);
  const reserved = parseReservations(fresh.reserved);
  const turnCheck = checkTurn(budget, usage, Date.now() - Number(run.created_at), reserved);
  if (!turnCheck.ok) {
    await pauseRun(run.id, "paused_budget", turnCheck.message);
    return { state: "waiting", wakeAt: Date.now() + PAUSE_RECHECK_MS, error: turnCheck.message };
  }
  if (conn.provider === "runtime:claude-code" || conn.provider === "runtime:gemini-cli")
    return runtimeTurn(step, ctx, run, principal, policy, conn.provider, conn.model, conn.id, goal, resourceKey, available(budget, usage, reserved, 0).costUsd);

  const caller = await agentCaller(principal, { stepId: step.id });
  const turn = buildTurn({ goal, resourceKey, steps: await getSteps(run.id), caller, principal, policy });
  if (!(await ensureToolsUnchanged(run.id, turn.tools))) return { state: "failed", retry: false, error: TOOLS_CHANGED };
  const startedAt = Date.now();
  let result: GenerateResult;
  try {
    result = await withAgentContext(principal, () =>
      generateWith(conn as Parameters<typeof generateWith>[0], {
        system: turn.system, messages: turn.messages, tools: turn.tools, signal: ctx.signal,
        ...(policy.limits.maxOutputTokens ? { maxOutputTokens: policy.limits.maxOutputTokens } : {}),
      }),
    );
  } catch (e) {
    const scrubbed = await conn.scrub(errText(e)).catch(() => redact(errText(e)).text);
    await recordModelCall({ runId: run.id, stepId: step.id, connectionId: conn.id, provider: conn.provider, model: conn.model, state: "failed", startedAt, error: scrubbed, transcript: transcriptOf(turn) }).catch(() => {});
    if (isCredentialError(e)) {
      await pauseRun(run.id, "paused_auth", e.message);
      return { state: "waiting", wakeAt: Date.now() + PAUSE_RECHECK_MS, error: e.message };
    }
    const rec = inferenceRecovery(e, Math.max(0, step.attempt - 1), Math.random());
    if ((e as { kind?: string })?.kind === "auth") await markConnectionStatus(conn.id, "needs_auth").catch(() => {});
    switch (rec.action) {
      case "pause":
        await pauseRun(run.id, rec.state, rec.cause);
        return { state: "waiting", wakeAt: rec.resetAt ?? Date.now() + PAUSE_RECHECK_MS, error: rec.cause };
      case "retry":
        return { state: "waiting", wakeAt: Date.now() + rec.afterMs, error: `retrying: ${rec.cause}` };
      case "cancelled": {
        // Revoked under the turn (the run is paused now): the turn waits for the run to resume. Cancelled: it ends.
        const now = await getRun(run.id);
        if (now && (now.state === "paused_auth" || now.state === "paused_budget")) return { state: "waiting", wakeAt: Date.now() + PAUSE_RECHECK_MS, error: rec.cause };
        return { state: "cancelled", error: rec.cause };
      }
      case "fail":
        await failRun(run.id, `the model call failed: ${rec.cause}`);
        return { state: "failed", retry: false, error: rec.cause };
    }
  }
  const measured = conn.provider === "scripted";
  await recordModelCall({
    runId: run.id, stepId: step.id, connectionId: conn.id, provider: conn.provider, model: result.model, requestId: result.requestId,
    state: result.stop === "incomplete" ? "incomplete" : "completed", usage: { ...result.usage, capabilityMapVersion: CAPABILITY_MAP_VERSION, estimated: measured },
    ...(measured ? { costEstimate: 0 } : {}), transcript: transcriptOf(turn, result.message), startedAt,
  });
  const used = await bumpUsage(run.id, { turns: 1, inputTokens: result.usage.inputTokens ?? 0, outputTokens: result.usage.outputTokens ?? 0, ...(measured ? {} : { costUnmeasured: 1 }) });
  const base: ModelStepResult = {
    turn: turn.number, stop: result.stop, text: redact(result.text).text, message: sealAssistant(result.message), model: result.model,
    ...(result.requestId ? { requestId: result.requestId } : {}), usage: { inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens },
  };
  if (result.stop === "incomplete" && step.attempt <= RETRY_INCOMPLETE) return { state: "waiting", wakeAt: Date.now() + 2_000, error: `the provider ended the turn early (${result.incompleteReason ?? "incomplete"}) — asking again` };
  if (result.stop !== "tool_calls" || !result.toolCalls.length) {
    const text = result.stop === "refusal" && !base.text ? `The model declined to answer${result.refusal ? `: ${redact(result.refusal).text}` : "."}` : base.text;
    return { state: "succeeded", result: { ...base, text, final: true, ...(result.stop === "max_tokens" || result.stop === "incomplete" ? { incomplete: true } : {}), ...(result.stop === "refusal" ? { refused: true } : {}) } };
  }
  return callsOf(step, run, turn.tools, result, base, budget, used, reserved);
}

// A completed tool_calls turn: every call validated first; then all of them run (reads as tool steps, changes as
// propose steps) or none does. The next turn waits for every one of them.
async function callsOf(
  step: AgentStepRow, run: AgentRunRow, offered: Parameters<typeof classifyCall>[1], result: GenerateResult, base: ModelStepResult, budget: ReturnType<typeof budgetOf>, used: RunUsage, reserved: Reservations,
): Promise<StepOutcome> {
  const plans = result.toolCalls.map((c) => classifyCall(c, offered));
  const nextTurn = (depends?: string[]): StepInput => ({ kind: "model", name: `turn ${base.turn + 1}`, retrySafe: true, input: {}, ...(depends?.length ? { depends } : {}) });
  const inline = (why: (p: (typeof plans)[number]) => string): TurnCall[] =>
    plans.map((p) => ({ id: p.call.id, name: p.call.name, ...(p.kind !== "invalid" ? { op: p.op.name } : {}), kind: p.kind, content: JSON.stringify({ error: why(p) }), isError: true }));
  if (plans.some((p) => p.kind === "invalid")) {
    const calls = inline((p) => (p.kind === "invalid" ? p.error : "not run: another call in this turn had invalid arguments — nothing in a turn runs until every call is valid; send the valid ones again"));
    await appendFollowUps(step, async (append) => void (await append(nextTurn())));
    return { state: "succeeded", result: { ...base, calls } };
  }
  const fit = checkCalls(budget, used, plans.length, reserved);
  if (!fit.ok) {
    // Over budget: nothing runs; the run pauses, and the model reads why when it resumes.
    const calls = inline(() => `not run: ${fit.message}`);
    await appendFollowUps(step, async (append) => void (await append(nextTurn())));
    await pauseRun(run.id, "paused_budget", fit.message);
    return { state: "succeeded", result: { ...base, calls, paused: fit.message } };
  }
  await bumpUsage(run.id, { toolCalls: plans.length });
  const ids = await allocateEvidence(run.id, plans.filter((p) => p.kind === "read").length);
  const calls: TurnCall[] = [];
  await appendFollowUps(step, async (append) => {
    let e = 0;
    for (const p of plans) {
      if (p.kind === "invalid") continue;
      // What the model sent, redacted: a model never holds a real secret, so anything secret-looking in a call (an
      // injected instruction's "set DB_PASSWORD to …") is never stored — or run.
      const input: CallStepInput = { call: { id: p.call.id, name: p.call.name, op: p.op.name, input: redactDeep(p.input).value }, turn: step.id, source: "model", ...(p.kind === "read" ? { evidenceId: ids[e++] } : {}) };
      const id = await append({ kind: p.kind === "read" ? "tool" : "propose", name: p.op.name, input, retrySafe: true });
      calls.push({ id: p.call.id, name: p.call.name, op: p.op.name, kind: p.kind, step: id });
    }
    await append(nextTurn(calls.map((c) => c.step!)));
  });
  return { state: "succeeded", result: { ...base, calls } };
}

// The console's tool names in a CLI's init list (Claude Code: mcp__deployment-console__<tool>; Gemini CLI:
// mcp_deployment-console_<tool>); its own helpers (ListMcpResourcesTool, …) are not the console's.
const consoleToolNames = (tools: readonly string[]) =>
  new Set(tools.map((t) => /^mcp__deployment-console__(.+)$/.exec(t)?.[1] ?? /^mcp_deployment-console_(.+)$/.exec(t)?.[1] ?? /^deployment-console__(.+)$/.exec(t)?.[1]).filter((x): x is string => !!x));

// A runtime:* connection: one step runs the person's CLI as an MCP client of the console with a run token. Its calls are
// recorded as they arrive (onAgentInvoke); when it exits, the run waits for any request it made, else it is done.
async function runtimeTurn(
  step: AgentStepRow, ctx: StepContext, run: AgentRunRow, principal: AgentPrincipal, policy: AgentPolicy, provider: string, model: string | undefined, connectionId: string, goal: string, resourceKey: string | undefined,
  budgetUsd: number | undefined, // the estimated cost this run may still spend (its children's reservations excluded)
): Promise<StepOutcome> {
  const rt = runtimeForProvider(provider);
  if (!rt) {
    await failRun(run.id, `no local runtime for ${provider}`);
    return { state: "failed", retry: false, error: `no local runtime for ${provider}` };
  }
  const caller = await agentCaller(principal, { stepId: step.id });
  const specs = toolSpecsFor(caller);
  if (!(await ensureToolsUnchanged(run.id, specs))) return { state: "failed", retry: false, error: TOOLS_CHANGED };
  const expected = new Set(specs.map((s) => s.name));
  const ac = new AbortController();
  const onAbort = () => ac.abort(ctx.signal.reason);
  if (ctx.signal.aborted) onAbort();
  else ctx.signal.addEventListener("abort", onAbort, { once: true });
  let changed: string | undefined;
  const now = Date.now();
  const deadline = Math.min(Number(run.deadline_at ?? now + policy.limits.runtimeSeconds * 1000), Number(run.created_at) + policy.limits.runtimeSeconds * 1000);
  const token = await mintRunToken(run.id, principal, Math.max(60_000, deadline - now));
  const startedAt = Date.now();
  let r: Awaited<ReturnType<typeof rt.run>>;
  try {
    r = await rt.run({
      prompt: runtimePrompt({ mode: policy.mode, scope: policy.scope, delegator: principal.delegatorEmail, resourceKey, now }, goal),
      mcpUrl: consoleMcpUrl(), token, ...(model ? { model } : {}), ...(budgetUsd !== undefined ? { budgetUsd } : {}),
      deadlineMs: deadline, signal: ac.signal,
      onEvent: (e) => {
        if (e.type !== "init") return;
        const got = consoleToolNames(e.tools);
        const extra = [...got].filter((t) => !expected.has(t));
        const missing = [...expected].filter((t) => !got.has(t));
        if (extra.length || missing.length) {
          changed = `${TOOLS_CHANGED} (the CLI saw ${extra.length ? `extra: ${extra.slice(0, 5).join(", ")}` : ""}${extra.length && missing.length ? "; " : ""}${missing.length ? `missing: ${missing.slice(0, 5).join(", ")}` : ""})`;
          ac.abort(new Error(changed));
        }
      },
    });
  } finally {
    ctx.signal.removeEventListener("abort", onAbort);
    await revokeRunTokens(run.id).catch(() => 0); // the CLI is gone; its token goes with it
  }
  const cost = r.usage?.costUsd;
  await recordModelCall({
    runId: run.id, stepId: step.id, connectionId, provider, model: model ?? rt.label, state: r.state === "completed" ? "completed" : r.state === "cancelled" ? "incomplete" : "failed",
    usage: { ...(r.usage ?? {}), runtimeVersion: r.version, tools: r.tools, estimated: true }, ...(cost !== undefined ? { costEstimate: cost } : {}),
    transcript: { runtime: rt.kind, version: r.version, tools: r.tools, answer: r.text, error: r.error }, startedAt, ...(r.error ? { error: r.error } : {}),
  });
  await bumpUsage(run.id, {
    turns: Math.max(1, r.usage?.turns ?? 1), inputTokens: r.usage?.inputTokens ?? 0, outputTokens: r.usage?.outputTokens ?? 0, ...(cost !== undefined ? { costUsd: cost } : { costUnmeasured: 1 }),
  });
  if (changed) {
    await failRun(run.id, changed);
    return { state: "failed", retry: false, error: changed };
  }
  const runtime = { version: r.version, tools: r.tools };
  if (r.state === "completed") return { state: "succeeded", result: { turn: 1, stop: "end", text: redact(r.text ?? "").text, final: true, runtime } satisfies ModelStepResult };
  if (r.state === "cancelled") return { state: "cancelled", error: r.error ?? "the CLI was stopped" };
  const to = runStateForRuntimeError(r.errorKind);
  const why = r.error ?? "the CLI failed";
  if (to === "failed") {
    await failRun(run.id, why);
    return { state: "failed", retry: false, error: why };
  }
  await pauseRun(run.id, to, why);
  return { state: "waiting", wakeAt: Date.now() + PAUSE_RECHECK_MS, error: why };
}

// ---------- tool ----------

async function toolStep(step: AgentStepRow, ctx: StepContext): Promise<StepOutcome> {
  const run = ctx.run;
  const input = parseJson<Partial<CallStepInput> & { op?: unknown; input?: unknown }>(step.input) ?? {};
  // A model's call, or a deterministic one ({ op, input }, as a workflow writes it).
  const call =
    input.call ?? (typeof input.op === "string" ? { id: step.id, name: toolName(input.op), op: input.op, input: isObj(input.input) ? input.input : {} } : undefined);
  if (!call) return { state: "failed", retry: false, error: "a tool step needs an operation" };
  const op = findOp(call.op);
  if (op && (op.riskOf?.(call.input) ?? op.risk) !== "read") return { state: "failed", retry: false, error: `${call.op} changes something: tool steps only read — changes are proposed` };
  const principal = principalForRun(run);
  const evidenceId = input.evidenceId ?? (await allocateEvidence(run.id, 1))[0];
  const out = await readAsEvidence(() => agentCaller(principal, { stepId: step.id }), principal, call.op, call.input, evidenceId);
  return { state: "succeeded", result: out };
}

// ---------- propose ----------

// The calls a step made through the registry, as onAgentInvoke reported them (dry runs say whether a person decides).
async function capturing<T>(stepId: string, fn: () => Promise<T>): Promise<{ value?: T; error?: unknown; events: AgentInvokeEvent[] }> {
  const events: AgentInvokeEvent[] = [];
  st.captures.set(stepId, events);
  try {
    return { value: await fn(), events };
  } catch (error) {
    return { error, events };
  } finally {
    st.captures.delete(stepId);
  }
}

interface Freshness {
  ids: string[]; // the evidence about the target
  newestAgeSeconds?: number;
  refreshed?: string; // a fresh read made for this proposal
  stale?: boolean; // nothing fresh could be read
}

// The evidence a proposal stands on: what the run read about the same resource. When the newest is older than the
// policy allows (evidence.maximumAgeSeconds), it is read again now (services.get / cloud.get) and recorded.
async function freshen(run: AgentRunRow, step: AgentStepRow, call: CallStepInput["call"], policy: AgentPolicy, principal: AgentPrincipal): Promise<Freshness> {
  const i = call.input;
  const same = (x: Record<string, unknown>) => (typeof i.key === "string" ? x.key === i.key : typeof i.service === "string" && x.env === i.env && (x.service === i.service || (Array.isArray(x.services) && x.services.includes(i.service))));
  const related: { id: string; at: number }[] = [];
  for (const s of await getSteps(run.id)) {
    if (s.kind !== "tool" || s.state !== "succeeded") continue;
    const inp = parseJson<CallStepInput>(s.input);
    const out = parseJson<ToolOutcome>(s.result);
    if (inp?.call && out?.evidenceId && !out.isError && same(inp.call.input)) related.push({ id: out.evidenceId, at: out.observedAt });
  }
  const newest = related.reduce((m, r) => Math.max(m, r.at), 0);
  const now = Date.now();
  const age = newest ? Math.round((now - newest) / 1000) : undefined;
  if (newest && isFresh(newest, policy.evidence.maximumAgeSeconds, now)) return { ids: related.map((r) => r.id), newestAgeSeconds: age };
  const read = typeof i.key === "string" ? { op: READ_FOR_TARGET[1], input: { key: i.key } } : typeof i.env === "string" && typeof i.service === "string" ? { op: READ_FOR_TARGET[0], input: { env: i.env, service: i.service } } : undefined;
  if (!read || !(listed(policy.tools.read, read.op) || listed(policy.tools.propose, read.op))) return { ids: related.map((r) => r.id), newestAgeSeconds: age, stale: true };
  const [id] = await allocateEvidence(run.id, 1);
  const out = await readAsEvidence(() => agentCaller(principal, { stepId: step.id }), principal, read.op, read.input, id);
  await appendStep(run.id, {
    kind: "tool", name: `${read.op} (fresh evidence for ${call.op})`, state: "succeeded", retrySafe: true,
    input: { call: { id: `refresh-${step.id}`, name: toolName(read.op), op: read.op, input: read.input }, source: "refresh", evidenceId: id } satisfies CallStepInput, result: out,
  });
  return out.isError ? { ids: related.map((r) => r.id), newestAgeSeconds: age, stale: true } : { ids: [...related.map((r) => r.id), id], newestAgeSeconds: 0, refreshed: id };
}

const APPROVAL_NOTE =
  "This change needs a person's approval in the console (Automation → Approvals). It has not run yet. Don't send it again: once someone approves it, the console runs exactly this plan as this run and verifies the result.";

async function proposeStep(step: AgentStepRow, ctx: StepContext): Promise<StepOutcome> {
  const run = ctx.run;
  const input = parseJson<CallStepInput>(step.input);
  if (!input?.call) return { state: "failed", retry: false, error: "a propose step needs the model's call" };
  const call = input.call;
  const principal = principalForRun(run);
  const { policy } = await policyForRun(run.id, principal);
  const caller = () => agentCaller(principal, { stepId: step.id });
  const refused = (e: unknown) => {
    const f = refusalText(e);
    return { state: "succeeded" as const, result: { outcome: f.outcome, op: call.op, error: f.error, ...(f.status ? { status: f.status } : {}), ...(f.code ? { code: f.code } : {}), content: f.content, isError: true } };
  };
  // 1. The dry run: the plan, and whether the policy sends it to a person (its reason) or lets the run do it.
  const dry = await capturing(step.id, () => withAgentContext(principal, async () => invoke(call.op, call.input, await caller(), { dryRun: true })));
  if (dry.error) return refused(dry.error);
  const ev = dry.events.find((e) => e.outcome === "result");
  const needsPerson = !ev || !!ev.reason; // nothing captured: a person decides (fail safe)
  // 2. Evidence the approver can trust: fresh enough, by the policy.
  const fresh = await freshen(run, step, call, policy, principal);
  // 3. A person decides (an exact-plan grant and an approval request), or — bounded-act — an execute step runs it.
  if (!needsPerson)
    return {
      state: "succeeded",
      result: {
        outcome: "allowed", op: call.op, evidence: fresh,
        content: JSON.stringify({ status: "queued", note: "The run's policy lets it make this change on its own. The console runs it once, as this run, and then verifies it — don't send it again." }),
      },
      next: [{ kind: "execute", name: call.op, retrySafe: false, input: { op: call.op, input: call.input, bounded: true, proposeStep: step.id } }],
    };
  const real = await capturing(step.id, () => withAgentContext(principal, async () => invoke(call.op, call.input, await caller())));
  if (real.error) return refused(real.error);
  const r = real.value!;
  if (r.kind === "approval") {
    const a = r.approval;
    const grantId = a.run?.grantId ?? real.events.find((e) => e.outcome === "approval")?.grantId;
    const g = grantId ? await getGrant(grantId) : undefined;
    return {
      state: "succeeded",
      result: {
        outcome: "approval", op: call.op, approvalId: a.id, grantId, planHash: g?.plan_hash ?? undefined, plan: a.plan, expiresAt: a.expiresAt, evidence: fresh,
        content: JSON.stringify({ approval: { id: a.id, status: a.status, plan: a.plan, expiresAt: new Date(a.expiresAt).toISOString() }, note: APPROVAL_NOTE }),
      },
    };
  }
  // The policy changed between the dry run and the call and let it run: it ran — record it and verify it.
  const res = r.kind === "result" ? r.result : undefined;
  const operationId = isObj(res) && typeof res.operationId === "string" ? res.operationId : undefined;
  return {
    state: "succeeded",
    result: { outcome: "result", op: call.op, operationId, evidence: fresh, content: JSON.stringify({ result: res, note: "AWS accepted the request; the console now verifies it." }) },
    next: [{ kind: "verify", name: `verify ${call.op}`, retrySafe: true, input: { operationId: operationId ?? null, stepId: step.id, ...targetOf(call.input) } }],
  };
}

const targetOf = (i: Record<string, unknown>) => ({
  ...(typeof i.env === "string" ? { env: i.env } : {}), ...(typeof i.service === "string" ? { service: i.service } : {}), ...(typeof i.key === "string" ? { key: i.key } : {}),
});

// ---------- execute ----------

interface ExecuteInput {
  op?: string;
  grantId?: string;
  approvalId?: string;
  human?: { confirm?: string; migrationAck?: boolean; reason?: string };
  input?: Record<string, unknown>; // bounded-act: the call as proposed
  bounded?: boolean;
  proposeStep?: string;
}

const unexpected = (why: string): StepOutcome => ({ state: "failed", retry: false, error: `unexpected step: ${why} — nothing was run` });

async function executeStep(step: AgentStepRow, ctx: StepContext): Promise<StepOutcome> {
  const run = ctx.run;
  const x = parseJson<ExecuteInput>(step.input) ?? {};
  const principal = principalForRun(run);
  let op: string;
  let input: Record<string, unknown>;
  if (x.grantId) {
    // Only the grant this step was queued for, for this run and this operation, unused (§9.2 "unexpected step", "reuse").
    const gr = await getGrant(x.grantId);
    if (!gr || step.grant_id !== x.grantId) return unexpected("this step doesn't carry that approval");
    if (gr.run_id !== run.id) return unexpected("the approval belongs to another run");
    if (x.op !== undefined && x.op !== gr.operation) return unexpected(`the approval is for ${gr.operation}, not ${String(x.op).slice(0, 80)}`);
    const status = grantStatus(gr);
    if (status === "consumed") return unexpected(`the approval was already used${gr.consumed_operation_id ? ` (operation ${gr.consumed_operation_id})` : ""}; an approval runs once`);
    if (status !== "approved") return { state: "failed", retry: false, error: `the approval is ${status}${gr.invalidation_reason ? `: ${gr.invalidation_reason}` : ""}` };
    const ex = await grantExecution(x.grantId, x.human ?? {});
    op = ex.op;
    input = ex.input;
    if (!findOp(op)) return unexpected(`the operation ${op} no longer exists`);
  } else if (x.bounded && typeof x.op === "string" && isObj(x.input)) {
    // Bounded-act: only the change a propose step of this run cleared to run on its own, exactly as proposed.
    const from = x.proposeStep ? (await getSteps(run.id)).find((s) => s.id === x.proposeStep && s.kind === "propose") : undefined;
    const pr = parseJson<{ outcome?: string; op?: string }>(from?.result);
    const pin = parseJson<CallStepInput>(from?.input);
    if (!from || pr?.outcome !== "allowed" || pr.op !== x.op || JSON.stringify(pin?.call.input) !== JSON.stringify(x.input)) return unexpected("no proposal of this run cleared this change to run on its own");
    op = x.op;
    input = x.input;
  } else return unexpected("an execute step needs an approval (or a bounded proposal)");

  // The change itself. With a grant, the registry re-plans as the agent and compares the plan's hash with the one the
  // person approved before it consumes the grant (once, atomically); a drift withdraws the grant and the agent asks
  // again here. Then the coordinator takes the locks, re-reads the tags (R01) and writes the intent; the step's
  // idempotency key is run:<run>:step:<step>. Any other throw is settled by the worker through the operation records
  // (outcome unknown → verify, never a retry).
  let r: Awaited<ReturnType<typeof invoke>>;
  try {
    r = await withAgentContext(principal, async () => invoke(op, input, await agentCaller(principal, { stepId: step.id, ...(x.grantId ? { grantId: x.grantId } : {}) })));
  } catch (e) {
    if (!x.grantId || (e as { code?: string })?.code !== "grant_invalid") throw e;
    const after = await getGrant(x.grantId);
    if (!after?.invalidated_at || !/plan changed|input changed/.test(after.invalidation_reason ?? "")) return { state: "failed", retry: false, error: errText(e) };
    // The agent's own call again — not what the approver added to it (their reason; a migration acknowledgement only
    // a person gives): the new request is the agent's, and a person decides it afresh.
    const again = { ...(await grantExecution(x.grantId).then((g) => g.input).catch(() => input)) };
    delete again.migrationAck;
    return {
      state: "skipped",
      error: `the plan changed since a person approved it (${after.invalidation_reason}): the approval was withdrawn and the change was proposed again`,
      next: [{ kind: "propose", name: op, retrySafe: true, input: { call: { id: `again-${step.id}`, name: toolName(op), op, input: again }, source: "model" } satisfies CallStepInput }],
    };
  }
  if (r.kind === "approval")
    return { state: "succeeded", result: { outcome: "approval", op, approvalId: r.approval.id, grantId: r.approval.run?.grantId, note: "the policy now wants a person to decide — a new approval request was made" } };
  const res = r.kind === "result" ? r.result : undefined;
  const operationId = isObj(res) && typeof res.operationId === "string" ? res.operationId : undefined;
  return {
    state: "succeeded",
    operationId,
    result: { outcome: "result", op, operationId, aws: "accepted", verification: isObj(res) && typeof res.verification === "string" ? res.verification : "accepted", ...(x.grantId ? { grantId: x.grantId } : {}) },
    next: [{ kind: "verify", name: `verify ${op}`, retrySafe: true, input: { operationId: operationId ?? null, stepId: step.id, ...targetOf(input) } }],
  };
}

// ---------- verify ----------

interface VerifyResult {
  operationId?: string;
  op?: string;
  aws: "accepted" | "failed" | "unknown" | "none";
  health: "verified" | "unhealthy" | "pending" | "n/a";
  detail?: string;
  evidence?: ToolOutcome;
}

const pick = (ops: OperationView[]) =>
  ops.find((o) => o.state === "queued" || o.state === "running" || o.state === "outcome_unknown") ?? ops.find((o) => o.state !== "succeeded") ?? ops[ops.length - 1];

// The resource a change was made to: from the verify step's input, else from the execute step it follows.
async function targetOfStep(run: AgentRunRow, stepId: string | undefined): Promise<Record<string, string>> {
  if (!stepId) return {};
  const s = (await getSteps(run.id)).find((x) => x.id === stepId);
  const x = parseJson<ExecuteInput & CallStepInput>(s?.input);
  if (!x) return {};
  if (x.grantId) return targetOf((await grantExecution(x.grantId).catch(() => ({ input: {} }))).input) as Record<string, string>;
  return targetOf(x.input ?? x.call?.input ?? {}) as Record<string, string>;
}

async function verifyStep(step: AgentStepRow, ctx: StepContext): Promise<StepOutcome> {
  const run = ctx.run;
  const v = parseJson<{ operationId?: string | null; stepId?: string; env?: string; service?: string; key?: string }>(step.input) ?? {};
  const now = Date.now();
  let ops: OperationView[] = [];
  if (v.operationId) {
    const o = await getOperation(v.operationId);
    if (o) ops = [o];
  }
  if (!ops.length && v.stepId) {
    const ids = (await operationsOfStep({ id: v.stepId, run_id: run.id })).map((o) => o.id);
    ops = (await Promise.all(ids.map((id) => getOperation(id)))).filter((o): o is OperationView => !!o);
  }
  // The service as last read becomes evidence (with a citation id) only once the check is over: polls in between aren't.
  const done = async (r: VerifyResult): Promise<StepOutcome> => {
    if (r.evidence) {
      const [id] = await allocateEvidence(run.id, 1);
      r = { ...r, evidence: asEvidence({ op: r.evidence.op, input: r.evidence.input, data: parseJson<{ data?: unknown }>(r.evidence.content)?.data, observedAt: r.evidence.observedAt, evidenceId: id, outcome: r.evidence.outcome }) };
    }
    return { state: "succeeded", result: r, ...(r.operationId ? { operationId: r.operationId } : {}) };
  };
  const op = pick(ops);
  if (!op) return done({ aws: "none", health: "n/a", detail: "no change reached AWS" });
  const late = now - op.createdAt > VERIFY_WINDOW_MS;
  const base = { operationId: op.id, op: op.action };
  if (op.state === "failed" || op.state === "cancelled") return done({ ...base, aws: "failed", health: "n/a", detail: op.detail ?? `the change ${op.state}` });
  if (op.state === "queued" || op.state === "running") {
    if (late) return done({ ...base, aws: "unknown", health: "pending", detail: "still in flight after 15 minutes — check the resource" });
    return { state: "waiting", wakeAt: now + 5_000 };
  }
  // Accepted (or possibly accepted): what does the resource say? Read as the agent while the run may still read;
  // otherwise only the operation's own verification (the sampler's) counts.
  const target = v.env || v.key ? targetOf(v as Record<string, unknown>) : await targetOfStep(run, v.stepId);
  let evidence: ToolOutcome | undefined;
  let facts: ReturnType<typeof serviceFacts> | null = null;
  if (VERIFIED_ACTION.test(op.action) && target.env && target.service && !isFinalRun(run.state)) {
    const principal = principalForRun(run);
    evidence = await readAsEvidence(() => agentCaller(principal, { stepId: step.id }), principal, "services.get", { env: target.env, service: target.service });
    if (!evidence.isError) {
      const data = parseJson<{ data?: unknown }>(evidence.content)?.data;
      facts = serviceFacts(data) ?? null;
    }
  }
  if (op.state === "outcome_unknown") {
    const seen = facts ? checkChange({ action: op.action, createdAt: op.createdAt }, facts, now) : undefined;
    return done({
      ...base, aws: "unknown", health: "pending", ...(evidence ? { evidence } : {}),
      detail: `AWS may or may not have acted (the answer was lost)${seen?.health === "verified" ? "; the service looks steady on the new state, but the console can't prove the change ran" : ""} — check the resource before trying again`,
    });
  }
  if (!VERIFIED_ACTION.test(op.action)) return done({ ...base, aws: "accepted", health: "n/a", detail: "the console can't verify this kind of change — check the resource" });
  const c = checkChange({ action: op.action, createdAt: op.createdAt, verify: op.verify ?? null, detail: op.detail }, facts, now);
  if (c.health === "pending") {
    if (!late) return { state: "waiting", wakeAt: now + VERIFY_POLL_MS };
    // Honest about why: a read this run wasn't allowed to make (its policy's limits) is not an unhealthy service — but
    // with no proof either way after the window, a person decides (escalated).
    const why = `${c.detail ?? "it didn't become healthy within 15 minutes"}${evidence?.isError ? ` (this run's own read: ${evidence.summary})` : ""}`;
    if (op.verify == null) await markVerified(op.id, false, `did not become healthy in 15 min (${why})`.slice(0, 300)).catch(() => {});
    return done({ ...base, aws: "accepted", health: "unhealthy", detail: `not verified within 15 minutes: ${why}`, ...(evidence ? { evidence } : {}) });
  }
  if (op.verify == null) await markVerified(op.id, c.health === "verified", c.detail).catch(() => {});
  return done({ ...base, aws: "accepted", health: c.health, ...(c.detail ? { detail: c.detail } : {}), ...(evidence ? { evidence } : {}) });
}

// ---------- calls made outside the runner's steps (a runtime CLI's or an external agent's MCP calls) ----------

function recordInvoke(e: AgentInvokeEvent) {
  if (e.stepId) {
    st.captures.get(e.stepId)?.push(e); // the runner's own step: it records the call itself
    return;
  }
  const runId = e.principal.runId;
  if (!runId) return;
  const prev = st.recording.get(runId) ?? Promise.resolve();
  const next = prev.then(() => recordCall(runId, e)).catch((err) => log(40, "agent call not recorded on its run", { run: runId, op: e.op, err: errText(err) }));
  st.recording.set(runId, next);
  void next.finally(() => {
    if (st.recording.get(runId) === next) st.recording.delete(runId);
  });
}

export async function recordCall(runId: string, e: AgentInvokeEvent): Promise<void> {
  const run = await getRun(runId);
  if (!run || isFinalRun(run.state)) return; // a call refused because the run ended: nothing to add to it
  // A runtime run's tool list must stay what it started with (its CLI's calls arrive here).
  if (run.tools_hash && e.outcome !== "denied") {
    const caller = await agentCaller(e.principal).catch(() => undefined);
    if (caller && !(await ensureToolsUnchanged(runId, toolSpecsFor(caller)))) return;
  }
  const source = run.kind === "external" ? "external" : "runtime";
  const call = { id: `${source}-${newId()}`, name: toolName(e.op), op: e.op, input: e.input };
  const change = e.risk !== "read";
  await bumpUsage(runId, { toolCalls: 1 }).catch(() => undefined);
  if (e.outcome === "approval") {
    const g = e.grantId ? await getGrant(e.grantId) : undefined;
    const a = e.approvalId ? await getApproval(e.approvalId) : undefined;
    await appendStep(runId, {
      kind: "propose", name: e.op, state: "succeeded", grantId: e.grantId, retrySafe: true, input: { call, source } satisfies CallStepInput,
      result: { outcome: "approval", op: e.op, approvalId: e.approvalId, grantId: e.grantId, planHash: g?.plan_hash ?? undefined, plan: a ? planOf(a) : undefined, expiresAt: g?.expires_at ?? undefined, reason: e.reason },
    });
    return;
  }
  if (e.outcome === "result" && change && !(isObj(e.result) && "plan" in e.result && Object.keys(e.result).length === 1)) {
    // A change the policy let run (bounded-act) — recorded as done, and verified like any other.
    const operationId = isObj(e.result) && typeof e.result.operationId === "string" ? e.result.operationId : undefined;
    const s = await appendStep(runId, { kind: "execute", name: e.op, state: "succeeded", retrySafe: false, operationId, input: { op: e.op, input: e.input, source }, result: { outcome: "result", op: e.op, operationId, aws: "accepted" } });
    await enqueueStep(runId, { kind: "verify", name: `verify ${e.op}`, retrySafe: true, input: { operationId: operationId ?? null, stepId: s.id, ...targetOf(e.input) } });
    return;
  }
  const [evidenceId] = e.outcome === "result" ? await allocateEvidence(runId, 1) : [undefined];
  const out =
    e.outcome === "result"
      ? asEvidence({ op: e.op, input: e.input, data: e.result, observedAt: e.at, evidenceId })
      : asEvidence({ op: e.op, input: e.input, data: { error: e.reason ?? e.outcome }, observedAt: e.at, outcome: e.outcome === "denied" ? "denied" : "error" });
  await appendStep(runId, {
    kind: change ? "propose" : "tool", name: e.op, state: e.outcome === "result" ? "succeeded" : "failed", retrySafe: true,
    input: { call, source, ...(evidenceId ? { evidenceId } : {}) } satisfies CallStepInput, result: out, ...(e.outcome === "result" ? {} : { error: (e.reason ?? e.outcome).slice(0, 500) }),
  });
}

// ---------- the end of a run ----------

interface Pieces {
  run: AgentRunRow;
  steps: AgentStepRow[];
  grants: ApprovalGrantRow[];
}

async function piecesOf(runId: string): Promise<Pieces | undefined> {
  const run = await getRun(runId);
  if (!run) return undefined;
  const grants = (await (await getDb()).all<ApprovalGrantRow>("SELECT * FROM approval_grants WHERE run_id = ? ORDER BY requested_at", [runId])).map((x) => ({
    ...x, requested_at: Number(x.requested_at), expires_at: x.expires_at === null ? null : Number(x.expires_at),
  }));
  return { run, steps: await getSteps(runId), grants };
}

// The facts the three-part outcome is made of.
function outcomeOf(p: Pieces): { outcome: RunOutcome; changes: ChangeFacts[]; answer?: { text: string; citations: string[]; incomplete?: boolean } } {
  const models = p.steps.filter((s) => s.kind === "model");
  const turns = models.map((s) => ({ s, r: parseJson<ModelStepResult>(s.result) })).filter((x) => x.s.state === "succeeded" && x.r);
  const finals = turns.filter((x) => x.r!.final);
  const last = finals[finals.length - 1]?.r;
  // The answer a person reads: the final turn, after the turns where the model laid out its analysis and proposed a change.
  const answerText = turns
    .filter((x) => x.r!.final || x.r!.calls?.some((c) => c.kind === "change"))
    .map((x) => x.r!.text.trim())
    .filter(Boolean)
    .join("\n\n");
  const pending = p.steps.some((s) => isPendingStep(s.state));
  const without = p.run.kind === "external" ? ("external" as const) : !models.length ? ("deterministic" as const) : undefined;
  const modelFailed = !last && !without && !pending && (models.some((s) => s.state === "failed" || s.state === "cancelled" || s.state === "skipped") || isFinalRun(p.run.state));
  const verifies = p.steps.filter((s) => s.kind === "verify");
  const verifyFor = (id: string) => verifies.filter((v) => parseJson<{ stepId?: string }>(v.input)?.stepId === id).pop();
  const changes: ChangeFacts[] = [];
  for (const s of p.steps) {
    const r = parseJson<{ outcome?: string; op?: string; operationId?: string }>(s.result);
    const ran = s.kind === "execute" || (s.kind === "propose" && r?.outcome === "result");
    if (!ran) continue;
    if (s.kind === "execute" && (s.state === "skipped" || s.state === "cancelled" || (s.state === "succeeded" && r?.outcome === "approval"))) continue;
    const op = s.name ?? r?.op ?? "change";
    const v = verifyFor(s.id);
    const vr = parseJson<VerifyResult>(v?.result);
    if (isPendingStep(s.state)) changes.push({ op, aws: "pending", health: "n/a" });
    // Failed: refused before AWS (the policy, the grant, an unexpected step) or failed at AWS — either way the change
    // didn't go through, and the run doesn't call that a success.
    else if (s.state === "failed") changes.push({ op, aws: "failed", health: "n/a", detail: s.error ?? undefined, ...(s.operation_id ? { operationId: s.operation_id } : {}) });
    else if (vr) changes.push({ op, aws: vr.aws === "none" ? "none" : vr.aws, health: vr.aws === "accepted" ? vr.health : "n/a", detail: vr.detail, ...(vr.operationId ? { operationId: vr.operationId } : {}) });
    else if (s.state === "outcome_unknown") changes.push({ op, aws: "unknown", health: "n/a", ...(s.operation_id ? { operationId: s.operation_id } : {}) });
    else changes.push({ op, aws: "accepted", health: v && isPendingStep(v.state) ? "pending" : v ? "n/a" : "pending", ...(s.operation_id ? { operationId: s.operation_id } : {}) });
  }
  const outcome = runOutcome({ ai: { answered: !!last || without === "deterministic", incomplete: !!last?.incomplete, failed: modelFailed, ...(without ? { without } : {}) }, changes });
  return { outcome, changes, ...(last ? { answer: { text: answerText, citations: citedIds(answerText), ...(last.incomplete ? { incomplete: true } : {}) } } : {}) };
}

const livePending = (gr: ApprovalGrantRow, now: number) => gr.decision === null && !gr.invalidated_at && !gr.consumed_at && Number(gr.expires_at ?? 0) > now;
const liveApproved = (gr: ApprovalGrantRow, now: number) => gr.decision === "approved" && !gr.invalidated_at && !gr.consumed_at && Number(gr.expires_at ?? 0) > now;

// When nothing is left to run and nobody is being asked, the run ends with its outcome. While a request waits for a
// person, the run waits for approval. External runs live as long as their token: they only move between running and
// waiting. Safe to call any time, from anywhere (a step or run event, the periodic sweep).
export async function settleRun(runId: string): Promise<void> {
  const p = await piecesOf(runId);
  if (!p) return;
  const { run } = p;
  if (isFinalRun(run.state)) return releaseReservation(run);
  if (run.state === "paused_auth" || run.state === "paused_budget") return;
  const now = Date.now();
  const pending = p.steps.some((s) => isPendingStep(s.state));
  const asking = p.grants.filter((gr) => livePending(gr, now));
  // An approved grant is still to run while its execute step (queued with the decision) hasn't ended; once that step
  // ended without using it (refused, failed before AWS), nothing will — the run doesn't wait for its window to pass.
  const ended = new Set(p.steps.filter((s) => s.kind === "execute" && s.grant_id && !isPendingStep(s.state)).map((s) => s.grant_id!));
  const approved = p.grants.filter((gr) => liveApproved(gr, now) && !ended.has(gr.id));
  const move = async (to: RunState, patch: { error?: string } = {}) => {
    const cur = (await getRun(runId))!;
    if (cur.state === to || isFinalRun(cur.state)) return;
    // outcome_unknown is reached from running / waiting_external only.
    if (!canTransitionRun(cur.state, to) && canTransitionRun(cur.state, "running")) await updateRun(runId, { state: "running" }, { from: [cur.state] });
    const now2 = (await getRun(runId))!;
    if (canTransitionRun(now2.state, to)) await updateRun(runId, { state: to, ...patch }, { from: [now2.state] });
  };
  if (run.kind === "external") {
    if (run.state === "waiting_approval" && !asking.length) await move("running").catch(() => {});
    if (run.state === "waiting_external" && !pending) await move("running").catch(() => {});
    return;
  }
  if (asking.length) {
    if (run.state === "running" || run.state === "queued") await move("waiting_approval").catch(() => {});
    return;
  }
  if (pending || approved.length) {
    if (run.state === "waiting_approval") await move("running").catch(() => {});
    return;
  }
  const { outcome, changes } = outcomeOf(p);
  const end = run.cancel_requested_at ? { state: "cancelled" as const, error: run.error ?? "cancelled" } : finalState(outcome, changes);
  await move(end.state, end.error ? { error: end.error } : {}).catch((e) => log(40, "run not settled", { run: runId, err: errText(e) }));
  const after = await getRun(runId);
  if (after && isFinalRun(after.state)) await releaseReservation(after);
}

// A child that ended gives back what it didn't use.
async function releaseReservation(child: AgentRunRow) {
  if (!child.parent_run_id) return;
  const db = await getDb();
  for (let i = 0; i < 10; i++) {
    const parent = await db.get<{ reserved: string | null }>("SELECT reserved FROM agent_runs WHERE id = ?", [child.parent_run_id]);
    if (!parent) return;
    const cur = parseReservations(parent.reserved);
    if (!cur[child.id] || cur[child.id].released) return;
    const next = releaseChild(cur, child.id, parseUsage(child.usage));
    if ((await db.run("UPDATE agent_runs SET reserved = ? WHERE id = ? AND COALESCE(reserved, '') = ?", [JSON.stringify(next), child.parent_run_id, parent.reserved ?? ""])) === 1) return;
  }
}

function scheduleSettle(runId: string) {
  const prev = st.settling.get(runId);
  if (prev) clearTimeout(prev);
  const t = outsideAgentContext(() =>
    setTimeout(() => {
      st.settling.delete(runId);
      void settleRun(runId).catch((e) => log(40, "run settle failed", { run: runId, err: errText(e) }));
    }, 300),
  );
  t.unref?.();
  st.settling.set(runId, t);
}

// Every 15 s (the worker's tick task): runs that may have nothing left to do (an expired request, a step settled by
// reconciliation, an event this instance didn't see), and children that ended with their reservation still held.
async function sweep(now: number) {
  const db = await getDb();
  const rows = await db.all<{ id: string }>(
    `SELECT id FROM agent_runs WHERE state IN (${ACTIVE_RUN_STATES.map(() => "?").join(", ")}) AND updated_at < ? ORDER BY updated_at LIMIT 100`,
    [...ACTIVE_RUN_STATES, now - 10_000],
  );
  for (const r of rows) await settleRun(r.id).catch((e) => log(40, "run settle failed", { run: r.id, err: errText(e) }));
  const kids = await db.all<AgentRunRow>(
    `SELECT c.* FROM agent_runs c JOIN agent_runs p ON p.id = c.parent_run_id WHERE c.state IN ('succeeded', 'failed', 'cancelled', 'outcome_unknown') AND p.state IN (${ACTIVE_RUN_STATES.map(() => "?").join(", ")}) LIMIT 100`,
    [...ACTIVE_RUN_STATES],
  );
  for (const k of kids) await releaseReservation(k).catch(() => {});
}

// ---------- registration ----------

export function registerHandlers(): void {
  registerStepHandler("model", modelStep);
  registerStepHandler("tool", toolStep);
  registerStepHandler("propose", proposeStep);
  registerStepHandler("execute", executeStep);
  registerStepHandler("verify", verifyStep);
  registerTickTask("runner:settle", 15_000, sweep);
  // Subscriptions are replaced, not added to, when this runs again (a dev reload).
  for (const u of st.unsubscribe.splice(0)) u();
  st.unsubscribe.push(
    onAgentInvoke(recordInvoke),
    onEvent((e) => {
      if ((e.type === "step" || e.type === "run") && e.runId) scheduleSettle(e.runId);
    }),
    // A revoked connection pauses its runs (credentials.ts); a model call or CLI in flight for them stops now.
    onConnectionChange((e) => {
      if (e.type === "revoked") for (const id of e.pausedRuns) cancelInflight(id, "the run's model connection was revoked");
    }),
  );
}

// ---------- cancel ----------

export async function cancelRun(id: string, by: User, o: { ip?: string } = {}): Promise<{ run: RunListItem; verifying: number; note?: string }> {
  const run = await getRun(id);
  if (!run) throw new HttpError(404, "no such run");
  if (isFinalRun(run.state)) throw coded(409, `this run has already ended (${run.state.replace(/_/g, " ")})`, "run_finished");
  const db = await getDb();
  // Changes AWS already accepted (or may have) keep being reconciled and verified after the run stops.
  // Counted once per change: an operation in flight, the operation a pending check is about, or a change being sent
  // right now (a leased execute step). Execute steps that haven't started are dropped with the run.
  const changes = new Set((await db.all<{ id: string }>("SELECT id FROM operations WHERE run_id = ? AND state IN ('queued', 'running', 'outcome_unknown')", [id])).map((r) => r.id));
  let unnamed = 0;
  for (const s of await getSteps(id)) {
    if (!(s.kind === "verify" ? isPendingStep(s.state) : s.kind === "execute" && s.state === "leased")) continue;
    const opId = s.operation_id ?? parseJson<{ operationId?: string | null }>(s.input)?.operationId;
    if (opId) changes.add(opId);
    else unnamed++;
  }
  const verifying = changes.size + unnamed;
  const note = verifying ? `${verifying} change${verifying === 1 ? "" : "s"} AWS already accepted (or may have) keep being verified; the run's record shows the result` : undefined;
  const audit = { env: "", target: `run ${id.slice(0, 8)}`, action: "agents.run.cancel", user: by.email, ip: o.ip, params: { run: id } };
  try {
    await writeAudit({ ...audit, at: Date.now(), phase: "intent" });
  } catch (e) {
    throw new HttpError(503, `audit log unavailable, nothing was changed: ${errText(e)}`);
  }
  await updateRun(id, { state: "cancelled", cancelRequestedAt: Date.now(), error: `cancelled by ${by.email}${note ? `; ${note}` : ""}` }, { from: [run.state] });
  for (const gr of await db.all<{ id: string }>("SELECT id FROM approval_grants WHERE run_id = ? AND consumed_at IS NULL AND invalidated_at IS NULL", [id]))
    await invalidateGrant(gr.id, `the run was cancelled by ${by.email}`).catch(() => false);
  cancelInflight(id, "the run was cancelled");
  await writeAudit({ ...audit, at: Date.now(), phase: "result", result: "ok", ...(note ? { detail: note } : {}) }).catch(() => {});
  const after = (await getRun(id))!;
  await releaseReservation(after).catch(() => {});
  return { run: await runListItem(after), verifying, ...(note ? { note } : {}) };
}

// ---------- views (§3.5) ----------

export interface RunListItem {
  id: string;
  kind: AgentRunRow["kind"];
  title: string | null;
  state: RunState;
  initiator: string | null;
  connection: { id: string; label: string; payer: string } | null;
  createdAt: number;
  updatedAt: number;
  waitingFor?: string;
  resourceKey?: string;
  parentRunId?: string;
  error?: string;
}

async function connectionSummary(id: string | null): Promise<RunListItem["connection"]> {
  if (!id) return null;
  if (id === DEMO_CONNECTION_ID) return { id, label: "Demo model (scripted)", payer: payerOf({ provider: "scripted", scope: "org" }) };
  const r = await (await getDb()).get<{ label: string; provider: string; scope: string; region: string | null; egress: string; email: string | null }>(
    "SELECT c.label, c.provider, c.scope, c.region, c.egress, u.email FROM agent_connections c LEFT JOIN users u ON u.id = c.owner_id WHERE c.id = ?",
    [id],
  );
  if (!r) return { id, label: "a deleted connection", payer: "unknown (the connection was deleted)" };
  return { id, label: r.label, payer: payerOf({ provider: r.provider as Provider, scope: r.scope === "org" ? "org" : "personal", ownerEmail: r.email ?? undefined, region: r.region, egress: r.egress === "local" ? "local" : "cloud" }) };
}

async function waitingFor(run: AgentRunRow): Promise<string | undefined> {
  switch (run.state) {
    case "queued":
      return "a worker to start it";
    case "waiting_approval": {
      const n = await (await getDb()).get<{ n: number | string }>("SELECT COUNT(*) AS n FROM approval_grants WHERE run_id = ? AND decision IS NULL AND invalidated_at IS NULL AND expires_at > ?", [run.id, Date.now()]);
      return `a person's decision on ${Number(n?.n ?? 0) === 1 ? "an approval request" : `${n?.n ?? 0} approval requests`}`;
    }
    case "waiting_external":
      return "the console to verify a change AWS may have accepted";
    case "paused_auth":
      return `the model connection to be fixed${run.error ? `: ${run.error}` : ""}`;
    case "paused_budget":
      return `more budget${run.error ? `: ${run.error}` : ""}`;
    case "running": {
      const held = await (await getDb()).get<{ n: number | string }>("SELECT COUNT(*) AS n FROM agent_steps WHERE run_id = ? AND kind = 'execute' AND state = 'waiting' AND error = 'emergency stop'", [run.id]);
      return Number(held?.n ?? 0) ? "the emergency stop to be lifted" : undefined;
    }
    default:
      return undefined;
  }
}

const emailCache = async (ids: (string | null)[]) => {
  const out = new Map<string, string>();
  const list = [...new Set(ids.filter((x): x is string => !!x))];
  if (!list.length) return out;
  for (const r of await (await getDb()).all<{ id: string; email: string }>(`SELECT id, email FROM users WHERE id IN (${list.map(() => "?").join(", ")})`, list)) out.set(r.id, r.email);
  return out;
};

export async function runListItem(run: AgentRunRow, emails?: Map<string, string>): Promise<RunListItem> {
  const who = emails ?? (await emailCache([run.initiator_id]));
  const w = await waitingFor(run);
  return {
    id: run.id, kind: run.kind, title: run.title, state: run.state, initiator: run.initiator_id ? (who.get(run.initiator_id) ?? null) : null, connection: await connectionSummary(run.connection_id),
    createdAt: Number(run.created_at), updatedAt: Number(run.updated_at), ...(w ? { waitingFor: w } : {}), ...(run.resource_key ? { resourceKey: run.resource_key } : {}),
    ...(run.parent_run_id ? { parentRunId: run.parent_run_id } : {}), ...(run.error ? { error: run.error } : {}),
  };
}

export async function listRunsFor(viewer: User, f: { all?: boolean; state?: RunState; kind?: AgentRunRow["kind"]; before?: number; limit?: number } = {}): Promise<RunListItem[]> {
  const all = !!f.all && viewer.role === "admin";
  const rows = await listRuns({ ...(all ? {} : { initiator: viewer.id }), state: f.state, kind: f.kind, before: f.before, limit: f.limit ?? 50 });
  const emails = await emailCache(rows.map((r) => r.initiator_id));
  return Promise.all(rows.map((r) => runListItem(r, emails)));
}

// Who may open a run: the person it acts for, admins, and people who could decide its requests.
export function mayView(run: AgentRunRow, viewer: User): boolean {
  return run.initiator_id === viewer.id || viewer.role === "admin" || can(viewer, "act");
}

interface StepView {
  id: string;
  seq: number;
  kind: string;
  name: string | null;
  state: string;
  attempt: number;
  createdAt: number;
  updatedAt: number;
  error?: string;
  summary?: string;
  evidenceId?: string;
  operationId?: string;
  grantId?: string;
  source?: string;
  review?: StepReview;
}

export interface StepReview {
  message?: string;
  additions?: string[]; // services that match now but weren't in the published preview
  removals?: string[];
  expiresAt?: number; // after this the run is cancelled and nothing is done
}

function stepView(s: AgentStepRow): StepView {
  const r = parseJson<Record<string, unknown>>(s.result) ?? {};
  const inp = parseJson<Partial<CallStepInput>>(s.input) ?? {};
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  const summary =
    s.kind === "model" ? (r.final ? `answer${r.incomplete ? " (cut off)" : ""}` : Array.isArray(r.calls) ? `${r.calls.length} tool call${r.calls.length === 1 ? "" : "s"}${r.paused ? ` — ${String(r.paused)}` : ""}` : undefined)
    : s.kind === "tool" ? str(r.summary)
    : s.kind === "propose" ? (r.outcome === "approval" ? `approval request ${str(r.approvalId) ?? ""}`.trim() : r.outcome === "allowed" ? "cleared to run on its own" : r.outcome ? `${String(r.outcome)}${r.error ? `: ${String(r.error).slice(0, 120)}` : ""}` : undefined)
    : s.kind === "execute" ? (r.operationId ? `AWS accepted (operation ${String(r.operationId)})` : undefined)
    : s.kind === "verify" ? (r.aws ? `AWS ${String(r.aws)}, health ${String(r.health)}${r.detail ? ` — ${String(r.detail).slice(0, 160)}` : ""}` : undefined)
    : undefined;
  // A workflow's pause for a person (target review or approval step): what to review, and until when.
  const rv = s.state === "waiting" && r.review && typeof r.review === "object" ? (r.review as Record<string, unknown>) : undefined;
  const keys = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, 100) : undefined);
  const review = rv
    ? { ...(str(rv.message) || str(rv.reason) ? { message: str(rv.message) || str(rv.reason) } : {}), ...(keys(rv.additions) ? { additions: keys(rv.additions) } : {}),
        ...(keys(rv.removals) ? { removals: keys(rv.removals) } : {}), ...(typeof rv.expiresAt === "number" ? { expiresAt: rv.expiresAt } : {}) }
    : undefined;
  return {
    ...(review ? { review } : {}),
    id: s.id, seq: s.seq, kind: s.kind, name: s.name, state: s.state, attempt: s.attempt, createdAt: s.created_at, updatedAt: s.updated_at,
    ...(s.error ? { error: s.error } : {}), ...(summary ? { summary } : {}), ...(str(r.evidenceId) ?? inp.evidenceId ? { evidenceId: str(r.evidenceId) ?? inp.evidenceId } : {}),
    ...(s.operation_id ? { operationId: s.operation_id } : {}), ...(s.grant_id ? { grantId: s.grant_id } : {}), ...(inp.source ? { source: inp.source } : {}),
  };
}

export interface RunDetail extends RunListItem {
  principal: ReturnType<typeof principalSummary> | null;
  scope: ResourceSelector;
  policyHash: string | null;
  mode?: string;
  budget: (ReturnType<typeof budgetView> & { note?: string }) | null;
  usage: RunUsage;
  steps: StepView[];
  evidence: EvidenceView[];
  proposals: { grantId: string; approvalId: string | null; op: string; targets: string[]; planHash: string | null; plan: unknown; expiresAt: number | null; state: string; reason?: string; evidence?: unknown }[];
  operations: { id: string; action: string; state: string; verify: string | null; createdAt: number; finishedAt?: number; detail?: string }[];
  modelCalls: { id: string; stepId: string | null; provider: string | null; model: string | null; state: string; usage: unknown; costEstimate: number | null; startedAt: number; finishedAt: number | null }[];
  answer?: { text: string; citations: string[]; incomplete?: boolean };
  outcome: RunOutcome;
  deadlineAt: number | null;
  children: { id: string; state: RunState }[];
  agent: { id: string; version?: number; name: string } | null; // the stored definition, or the template the run uses
  workflow: { id: string; version?: number; name: string } | null;
  evidenceMaxAgeSeconds?: number; // the policy's evidence age limit (older evidence is marked in the run view)
}

// Who the run is: its stored agent definition (or the template it was started from), and its workflow.
async function identityOf(run: AgentRunRow): Promise<Pick<RunDetail, "agent" | "workflow">> {
  const db = await getDb();
  let agent: RunDetail["agent"] = null;
  if (run.agent_id) {
    const d = await db.get<{ name: string }>("SELECT name FROM agent_definitions WHERE id = ? AND version = ?", [run.agent_id, run.agent_version ?? 0]).catch(() => undefined);
    agent = { id: run.agent_id, ...(run.agent_version !== null ? { version: Number(run.agent_version) } : {}), name: d?.name ?? run.agent_id };
  } else {
    const t = parseJson<{ template?: string }>(run.trigger)?.template;
    const tpl = t && isTemplateName(t) ? TEMPLATES.find((x) => x.name === t) : undefined;
    if (tpl) agent = { id: tpl.name, name: tpl.title };
  }
  let workflow: RunDetail["workflow"] = null;
  if (run.workflow_id) {
    const w = await db.get<{ name: string }>("SELECT name FROM workflows WHERE id = ? AND version = ?", [run.workflow_id, run.workflow_version ?? 0]).catch(() => undefined);
    workflow = { id: run.workflow_id, ...(run.workflow_version !== null ? { version: Number(run.workflow_version) } : {}), name: w?.name ?? run.workflow_id };
  }
  return { agent, workflow };
}

export async function runDetail(id: string, viewer: User): Promise<RunDetail> {
  const p = await piecesOf(id);
  if (!p || !mayView(p.run, viewer)) throw new HttpError(404, "no such run");
  const { run, steps } = p;
  const now = Date.now();
  const policy = parseJson<AgentPolicy>(run.policy);
  const usage = parseUsage(run.usage);
  const principal = parseJson<AgentPrincipal>(run.principal);
  const evidence: EvidenceView[] = [];
  for (const s of steps) {
    const r = parseJson<ToolOutcome & { evidence?: ToolOutcome }>(s.result);
    const t = s.kind === "verify" ? r?.evidence : r;
    const v = t ? evidenceView(s.id, t, now) : undefined;
    if (v) evidence.push(v);
  }
  const approvals = new Map<string, { plan: unknown }>();
  for (const gr of p.grants) {
    if (!gr.approval_id) continue;
    const a = await getApproval(gr.approval_id).catch(() => undefined);
    if (a) approvals.set(gr.approval_id, { plan: planOf(a) });
  }
  const proposalEvidence = new Map<string, unknown>();
  for (const s of steps) {
    const r = parseJson<{ grantId?: string; evidence?: unknown }>(s.result);
    if (s.kind === "propose" && r?.grantId && r.evidence) proposalEvidence.set(r.grantId, r.evidence);
  }
  const db = await getDb();
  const calls = await db.all<{ id: string; step_id: string | null; provider: string | null; model: string | null; state: string; usage: string | null; cost_estimate: number | null; started_at: number | string; finished_at: number | string | null }>(
    "SELECT id, step_id, provider, model, state, usage, cost_estimate, started_at, finished_at FROM agent_model_calls WHERE run_id = ? ORDER BY started_at LIMIT 200",
    [id],
  );
  const children = await db.all<{ id: string; state: RunState }>("SELECT id, state FROM agent_runs WHERE parent_run_id = ? ORDER BY created_at LIMIT 100", [id]);
  const { outcome, answer } = outcomeOf(p);
  return {
    ...(await runListItem(run)),
    principal: principal ? principalSummary(principal) : null,
    scope: policy?.scope ?? {},
    policyHash: run.policy_hash,
    ...(policy ? { mode: policy.mode } : {}),
    budget: !policy
      ? null
      : run.kind === "external"
        ? { ...budgetView(budgetOf(policy), usage, parseReservations(run.reserved), 0), note: "an external agent's tool calls count per hour; run time and model turns don't apply — it lives as long as its token" }
        : budgetView(budgetOf(policy), usage, parseReservations(run.reserved), (isFinalRun(run.state) ? Number(run.finished_at ?? now) : now) - Number(run.created_at)),
    usage,
    steps: steps.map(stepView),
    evidence,
    proposals: p.grants.map((gr) => ({
      grantId: gr.id, approvalId: gr.approval_id, op: gr.operation, targets: parseJson<string[]>(gr.targets) ?? [], planHash: gr.plan_hash, plan: gr.approval_id ? (approvals.get(gr.approval_id)?.plan ?? null) : null,
      expiresAt: gr.expires_at, state: grantStatus(gr, now), ...(gr.invalidation_reason ? { reason: gr.invalidation_reason } : gr.reason ? { reason: gr.reason } : {}),
      ...(proposalEvidence.has(gr.id) ? { evidence: proposalEvidence.get(gr.id) } : {}),
    })),
    operations: (await listOperations({ runId: id, limit: 100 })).map((o) => ({
      id: o.id, action: o.action, state: o.state, verify: o.verify ?? null, createdAt: o.createdAt, ...(o.finishedAt ? { finishedAt: o.finishedAt } : {}), ...(o.detail ? { detail: o.detail } : {}),
    })),
    modelCalls: calls.map((c) => ({
      id: c.id, stepId: c.step_id, provider: c.provider, model: c.model, state: c.state, usage: parseJson(c.usage) ?? null, costEstimate: c.cost_estimate === null ? null : Number(c.cost_estimate),
      startedAt: Number(c.started_at), finishedAt: c.finished_at === null ? null : Number(c.finished_at),
    })),
    ...(answer ? { answer } : {}),
    outcome,
    deadlineAt: run.deadline_at,
    children,
    ...(await identityOf(run)),
    ...(policy?.evidence?.maximumAgeSeconds ? { evidenceMaxAgeSeconds: policy.evidence.maximumAgeSeconds } : {}),
  };
}

// One piece of evidence with its (redacted, bounded) data: the run view's drill-down.
export async function evidenceData(runId: string, evidenceId: string, viewer: User): Promise<EvidenceView & { data: unknown }> {
  const run = await getRun(runId);
  if (!run || !mayView(run, viewer)) throw new HttpError(404, "no such run");
  for (const s of await getSteps(runId)) {
    const r = parseJson<ToolOutcome & { evidence?: ToolOutcome }>(s.result);
    const t = s.kind === "verify" ? r?.evidence : r;
    if (t?.evidenceId !== evidenceId) continue;
    const v = evidenceView(s.id, t)!;
    return { ...v, data: parseJson<{ data?: unknown }>(t.content)?.data ?? null };
  }
  throw new HttpError(404, "no such evidence in this run");
}

// ---------- metrics (AGENT_ARCHITECTURE §9 release metrics) ----------

export interface RunMetrics {
  since: number;
  runs: number;
  verifiedCompletion: number | null; // of runs whose change AWS accepted: the share verified healthy (null: none yet)
  escalations: number; // runs whose change ended unhealthy (or unverifiable in time): sent to a person
  outcomeUnknown: number; // agent operations whose outcome is unknown
  preventedViolations: number; // calls the policy refused (recorded on their runs)
  duplicateEffects: number; // changes that reached AWS twice for one step or one approval — expected 0
  approvalsInvalidated: number;
  estimatedCostUsd: number; // measured model cost only (a runtime CLI's own estimate; API prices are never guessed)
  changes: number;
  verifiedChanges: number;
  unmeasuredModelCalls: number;
  byState: Record<string, number>;
}

export async function runMetrics(f: { since?: number; initiator?: string } = {}): Promise<RunMetrics> {
  const since = f.since ?? Date.now() - 30 * 86_400_000;
  const db = await getDb();
  const who = f.initiator ? " AND r.initiator_id = ?" : "";
  const args = (...a: unknown[]) => [...a, ...(f.initiator ? [f.initiator] : [])];
  const runs = await db.all<{ state: string }>(`SELECT r.state FROM agent_runs r WHERE r.created_at >= ?${who}`, args(since));
  const byState: Record<string, number> = {};
  for (const r of runs) byState[r.state] = (byState[r.state] ?? 0) + 1;
  const verifies = await db.all<{ run_id: string; result: string | null }>(
    `SELECT s.run_id, s.result FROM agent_steps s JOIN agent_runs r ON r.id = s.run_id WHERE s.kind = 'verify' AND s.state = 'succeeded' AND r.created_at >= ?${who}`,
    args(since),
  );
  const accepted = new Set<string>();
  const healthy = new Set<string>();
  const unhealthy = new Set<string>();
  let changes = 0;
  let verifiedChanges = 0;
  for (const v of verifies) {
    const r = parseJson<VerifyResult>(v.result);
    if (r?.aws !== "accepted") continue;
    changes++;
    accepted.add(v.run_id);
    if (r.health === "verified") {
      verifiedChanges++;
      healthy.add(v.run_id);
    }
    if (r.health === "unhealthy") unhealthy.add(v.run_id);
  }
  const verifiedRuns = [...accepted].filter((id) => healthy.has(id) && !unhealthy.has(id)).length;
  const one = async (sql: string, a: unknown[]) => Number((await db.get<{ n: number | string | null }>(sql, a))?.n ?? 0);
  const outcomeUnknown = await one(`SELECT COUNT(*) AS n FROM operations o JOIN agent_runs r ON r.id = o.run_id WHERE o.state = 'outcome_unknown' AND o.created_at >= ?${who}`, args(since));
  const preventedViolations = await one(
    `SELECT COUNT(*) AS n FROM agent_steps s JOIN agent_runs r ON r.id = s.run_id WHERE s.kind IN ('tool', 'propose', 'execute') AND s.created_at >= ? AND s.result LIKE ?${who}`,
    args(since, '%"outcome":"denied"%'),
  );
  // Two operations that reached AWS for one step, or for one approval, would be a repeated change.
  const perStep = await one(
    `SELECT COUNT(*) AS n FROM (SELECT o.run_id, o.step_id FROM operations o JOIN agent_runs r ON r.id = o.run_id WHERE o.step_id IS NOT NULL AND o.created_at >= ? AND o.state IN ('succeeded', 'running', 'outcome_unknown')${who}
       GROUP BY o.run_id, o.step_id, o.action HAVING COUNT(*) > 1) d`,
    args(since),
  );
  const perGrant = await one(
    `SELECT COUNT(*) AS n FROM (SELECT o.grant_id FROM operations o JOIN agent_runs r ON r.id = o.run_id WHERE o.grant_id IS NOT NULL AND o.created_at >= ? AND o.state IN ('succeeded', 'running', 'outcome_unknown')${who}
       GROUP BY o.grant_id HAVING COUNT(*) > 1) d`,
    args(since),
  );
  const approvalsInvalidated = await one(`SELECT COUNT(*) AS n FROM approval_grants g JOIN agent_runs r ON r.id = g.run_id WHERE g.invalidated_at >= ?${who}`, args(since));
  const cost = await db.get<{ c: number | string | null; u: number | string | null }>(
    `SELECT SUM(m.cost_estimate) AS c, SUM(CASE WHEN m.cost_estimate IS NULL THEN 1 ELSE 0 END) AS u FROM agent_model_calls m JOIN agent_runs r ON r.id = m.run_id WHERE m.started_at >= ?${who}`,
    args(since),
  );
  return {
    since,
    runs: runs.length,
    verifiedCompletion: accepted.size ? Math.round((verifiedRuns / accepted.size) * 1000) / 1000 : null,
    escalations: unhealthy.size,
    outcomeUnknown,
    preventedViolations,
    duplicateEffects: perStep + perGrant,
    approvalsInvalidated,
    estimatedCostUsd: Math.round(Number(cost?.c ?? 0) * 1e6) / 1e6,
    changes,
    verifiedChanges,
    unmeasuredModelCalls: Number(cost?.u ?? 0),
    byState,
  };
}
