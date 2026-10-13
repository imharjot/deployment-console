// The operations registry and executor: the one door an agent (or any API client) uses to do anything. invoke() runs
// the same checks in the same order for every caller — unknown → 404, input against the schema → 400 with problems,
// the role check (with the protected variant when the operation touches a protected environment), then a dry run or
// the token-mode gate (run | approval request | refuse), then run() with ctx.actor as the audit user. Deciding approvals
// is human-only: decide() refuses tokens and agents, re-checks the approver's role, re-plans as the requester (the
// plan must hash the same as when it was requested) and runs the operation as the approver — except for an agent's
// request, which only records the decision: the agent's run executes it as the agent, under the exact-plan grant.
//
// Agents (`via: "agent"`, master plan §6 C1): the caller is a server-built principal — never a person's session — with
// its delegator's *current* role and its run's stored policy. For every agent call invoke() checks that agents are on
// (503), the emergency stop for changes (423), the role, then asks the policy engine (src/lib/agents/policy.ts) with
// the call's resolved targets and the run's counters: allow → run inside the mutation context of the run (and step);
// approve → an exact-plan grant (src/lib/server/agents/grants.ts); deny → 403 with the reason. With a grant id it
// re-plans, verifies and consumes the grant first. Every agent call fires onAgentInvoke (the runner records it on the
// run). While an agent context is active (withAgentContext), a non-agent caller is refused: the session bypass.
import "server-only";
import { AGENT_FORBIDDEN_FIELDS, HUMAN_FIELDS, agentActor, parsePrincipal } from "../../agents/identity.ts";
import { isFinalRun } from "../../agents/run-state.ts";
import { evaluate, hardDenyReason, listed, type PolicyCounters, type PolicyTarget } from "../../agents/policy.ts";
import type { AgentPolicy, AgentPrincipal } from "../../agents/types.ts";
import { gate, gateRefusal, minRole, type ApprovalDecision, type ApprovalStatus, type TokenMode, type Via } from "../../automation.ts";
import { isSelfTagged, protectionOf } from "../../inventory/action-rules.ts";
import { resourceRegion } from "../../inventory/schedule.ts";
import { canonicalKey, keysForInventory, parseArn } from "../../mutation-keys.ts";
import { toTools, toolName, validate, type ToolFormat, type ToolSource } from "../../ops-schema.ts";
import { can, roleFor, type Perm, type Role, type User } from "../../rbac.ts";
import { grantHashes, grantStatus, decideGrant, finishGrant, getGrant, invalidateGrant, requestGrant, verifyAndConsumeGrant } from "../agents/grants.ts";
import { currentAgentContext, delegatorOf, policyForRun, principalForToken, withAgentContext } from "../agents/principals.ts";
import { AGENTS_OFF, STOPPED, agentsEnabled, isEmergencyStopped } from "../agents/stop.ts";
import { getRun, modelCallCount } from "../agents/store.ts";
import { noteAgentTokenUse } from "../auth/agent-tokens.ts";
import { noteUse, tokenById, tokenStillValid } from "../auth/api-tokens.ts";
import { userById, toUser } from "../auth/users.ts";
import { writeAudit } from "../audit.ts";
import { autoscalingOf, liveService, revisions } from "../console.ts";
import { getDb } from "../db.ts";
import { catalog, envInfo, listEnvs, metaOf } from "../discovery.ts";
import { HttpError, errText, errorBody } from "../errors.ts";
import { cachedInventoryEnvs, findResource, resourceProtected } from "../inventory.ts";
import { runWithMutationContext } from "../mutations.ts";
import { homeRegion } from "../sources.ts";
import * as store from "./approvals.ts";
import { ops as agentOps } from "./agents.ts";
import { ops as cloudOps } from "./cloud.ts";
import { ops as coreOps } from "./core.ts";
import { ops as costOps } from "./costs.ts";
import { ops as noteOps } from "./notes.ts";
import { ops as provisionOps } from "./provision.ts";
import type { AnyOperation, JsonSchema, OpContext, Plan, Risk } from "./types.ts";

// 400 with the list of problems, so a model can fix its call.
export class OpInputError extends HttpError {
  problems: string[];
  constructor(problems: string[]) {
    super(400, `invalid input: ${problems.join("; ")}`);
    this.problems = problems;
  }
}

// ---------- approvals as read operations (so MCP clients, which can only call tools, can follow their requests) ----------

const APPROVAL_STATUS: JsonSchema = { type: "string", enum: ["pending", "approved", "rejected", "expired", "done", "failed", "all"], description: "Only requests in this state (default all)." };

const approvalOps: AnyOperation[] = [
  {
    name: "approvals.list",
    title: "List approval requests",
    description:
      "Approval requests: changes an agent asked for that wait for (or got) a person's decision — operation, plan, status (pending, approved, rejected, expired, done, failed), who decided and the result. With an API token, only that token's own requests.",
    risk: "read",
    perm: "view",
    input: { type: "object", additionalProperties: false, properties: { status: APPROVAL_STATUS, limit: { type: "integer", minimum: 1, maximum: 100, default: 20, description: "How many (default 20)." } } },
    run: async (i: { status?: ApprovalStatus | "all"; limit?: number }, ctx) => listApprovalViews(ctx, { status: i.status, limit: i.limit ?? 20 }),
  },
  {
    name: "approvals.get",
    title: "Check an approval request",
    description:
      "One approval request by id: its status and, once a person approved it and it ran, the operation's result (status \"done\") or error (\"failed\"); a rejection carries the person's reason in `detail`. Pending requests expire at `expiresAt` (24 hours for an API token's; an agent's when its approval window closes, or when its run ends). Poll this after a change came back as an approval request — don't send the change again.",
    risk: "read",
    perm: "view",
    input: { type: "object", additionalProperties: false, required: ["id"], properties: { id: { type: "string", pattern: "^[0-9a-fA-F-]{36}$", description: "The approval id." } } },
    run: async (i: { id: string }, ctx) => getApprovalView(i.id, ctx),
  },
];

// ---------- the registry ----------

function build(list: AnyOperation[]): Map<string, AnyOperation> {
  const m = new Map<string, AnyOperation>();
  for (const op of list) {
    if (!/^[a-z][a-z0-9]*\.[a-z][a-zA-Z0-9]*$/.test(op.name)) console.error(JSON.stringify({ level: 40, msg: "operation name should be <area>.<verb>", op: op.name }));
    if (m.has(op.name) || [...m.keys()].some((k) => toolName(k) === toolName(op.name))) {
      console.error(JSON.stringify({ level: 50, msg: "duplicate operation ignored", op: op.name }));
      continue;
    }
    m.set(op.name, op);
  }
  return m;
}

const REGISTRY = build([...coreOps, ...approvalOps, ...costOps, ...provisionOps, ...noteOps, ...cloudOps, ...agentOps]);
export const OPERATIONS: AnyOperation[] = [...REGISTRY.values()];

// Operation name ("services.restart") or tool name ("services_restart").
export const findOp = (name: string) => REGISTRY.get(name) ?? OPERATIONS.find((o) => toolName(o.name) === name);

// Who is calling, as the registry needs it. Built by the routes from the proxy's headers (resolveCaller() completes an
// agent's), or by the agent runner (agentCaller() in src/lib/server/agents/principals.ts).
export interface Caller {
  user: User;
  via: Via;
  ip?: string;
  tokenId?: string; // an API token's id, or an agent token's
  tokenName?: string;
  tokenMode?: TokenMode;
  // Agents only:
  principal?: AgentPrincipal;
  policy?: AgentPolicy;
  runId?: string;
  stepId?: string;
  grantId?: string;
}

export const opContext = (c: Caller): OpContext => ({
  user: c.user,
  actor: c.via === "token" ? `${c.user.email} via token "${c.tokenName ?? "?"}"` : c.via === "agent" && c.principal ? agentActor(c.principal, c.tokenName) : c.user.email,
  ip: c.ip,
  via: c.via,
  tokenId: c.tokenId,
  tokenName: c.tokenName,
  tokenMode: c.tokenMode,
  ...(c.via === "agent" ? { principal: c.principal, grantId: c.grantId, runId: c.principal?.runId ?? c.runId, stepId: c.stepId } : {}),
});

// An agent's caller, completed — and re-checked on every call, even when the runner hands in one it built earlier:
// its principal (the runner's, or the token record's), the run still live with the policy the principal was issued
// for (checked against its hash), and the delegator as they are *now* (a demotion or a disabled account takes effect
// on the next call). Anything stale or unreadable → 401/409, never a guess.
export async function resolveCaller(c: Caller): Promise<Caller> {
  if (c.via !== "agent") return c;
  if (!c.principal && !c.tokenId) throw new HttpError(401, "not authenticated");
  const principal = c.principal ?? (await principalForToken(c.tokenId!));
  if (!principal.runId || (c.runId && c.runId !== principal.runId)) throw new HttpError(401, "this agent token doesn't belong to that run");
  const [{ policy }, user] = await Promise.all([policyForRun(principal.runId, principal), delegatorOf(principal)]);
  return { ...c, user, principal, policy, runId: principal.runId };
}

// ---------- catalog ----------

export type ApprovalNeed = "never" | "protected" | "always";

export interface OpInfo {
  name: string;
  tool: string;
  area: string;
  title: string;
  description: string;
  risk: Risk;
  perm: Perm;
  role: Role; // least role on a non-protected environment
  roleProtected: Role; // least role on a protected one
  input: JsonSchema;
  allowed: boolean; // this caller may call it (role and token mode)
  approval: ApprovalNeed; // for this caller: when a call becomes an approval request instead of running
}

function approvalNeed(op: AnyOperation, c: Caller): ApprovalNeed {
  if (c.via === "agent") {
    if (op.risk === "read" || !c.policy) return "never";
    // bounded-act runs a listed change on explicitly listed, unprotected targets; everything else asks a person.
    return c.policy.mode === "bounded-act" && op.risk === "change" && listed(c.policy.tools.act, op.name) ? "protected" : "always";
  }
  if (gate(c.tokenMode, op.risk, false, c.via) === "approve") return "always";
  if (gate(c.tokenMode, op.risk, true, c.via) === "approve") return "protected";
  return "never";
}

// What an agent's policy lets it call at all (targets and limits are checked per call). Hard denials and admin
// operations are never listed.
function agentMayCall(op: AnyOperation, c: Caller): boolean {
  const p = c.policy;
  if (!p || hardDenyReason({ op: op.name, perm: op.perm, risk: op.risk, targets: [] }) || listed(p.tools.deny, op.name)) return false;
  if (op.risk === "read") return listed(p.tools.read, op.name) || listed(p.tools.propose, op.name) || listed(p.tools.act, op.name);
  return p.mode !== "observe" && (listed(p.tools.propose, op.name) || listed(p.tools.act, op.name));
}

const allowedFor = (op: AnyOperation, c: Caller) =>
  can(c.user, op.perm) &&
  (c.via === "agent" ? agentMayCall(op, c) : gate(c.tokenMode, op.risk, false, c.via) !== "deny" && !(c.via === "token" && op.perm === "admin"));

export function listOps(c: Caller): OpInfo[] {
  return OPERATIONS.map((op) => ({
    name: op.name,
    tool: toolName(op.name),
    area: op.name.split(".")[0],
    title: op.title,
    description: op.description,
    risk: op.risk,
    perm: op.perm,
    role: roleFor(op.perm),
    roleProtected: roleFor(op.perm, true),
    input: op.input,
    allowed: allowedFor(op, c),
    approval: approvalNeed(op, c),
  }));
}

// Ready-to-use tool definitions for the operations this caller may call. Descriptions name other operations by
// their tool names and say when a call will come back as an approval request.
export function toolSourcesFor(c: Caller): ToolSource[] {
  const names = OPERATIONS.map((o) => o.name).sort((a, b) => b.length - a.length);
  return OPERATIONS.filter((op) => allowedFor(op, c)).map((op) => {
    let d = op.description;
    for (const n of names) d = d.split(n).join(toolName(n));
    const need = approvalNeed(op, c);
    if (c.via === "agent") {
      if (need !== "never") d += " Changes may become approval requests a person decides; never resend one — follow it with approvals_get.";
    } else if (need === "always") d += " With this token every call becomes an approval request a person must accept; follow it with approvals_get.";
    else if (need === "protected") d += " On protected environments the call becomes an approval request a person must accept; follow it with approvals_get.";
    return { name: op.name, description: d, input: op.input };
  });
}

export const toolsFor = (c: Caller, format: ToolFormat) => toTools(toolSourcesFor(c), format);

// ---------- invoke ----------

export type InvokeResult = { kind: "result"; result: unknown } | { kind: "plan"; plan: Plan } | { kind: "approval"; approval: ApprovalView };

const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

export function maskInput(op: AnyOperation | undefined, input: Record<string, unknown>): Record<string, unknown> {
  const out = { ...input };
  for (const f of op?.secretFields ?? []) if (f in out) out[f] = "(hidden)";
  return op?.maskInput ? op.maskInput(out) : out;
}

// The permission a call needs: the operation's own, or — for generic operations like cloud.action — the one its
// input names (the provider action's). Listings use the base `perm`.
const permFor = async (op: AnyOperation, input: Record<string, unknown>): Promise<Perm> => (op.permOf ? await op.permOf(input) : op.perm);

function genericPlan(op: AnyOperation, input: Record<string, unknown>, env?: string): Plan {
  const shown = maskInput(op, input);
  return {
    summary: `${op.title}${env ? ` in ${env}` : ""}`,
    changes: Object.entries(shown).filter(([k]) => k !== "confirm" && k !== "env").map(([k, v]) => `${k}: ${cut(JSON.stringify(v), 200)}`),
  };
}

async function planFor(op: AnyOperation, input: Record<string, unknown>, ctx: OpContext, env?: string): Promise<Plan> {
  const p = op.plan ? await op.plan(input, ctx) : genericPlan(op, input, env);
  return { ...p, summary: cut(String(p.summary ?? op.title), 300) };
}

// ECS environments first; then the cloud map's environments (ids found in tags and names), from its last build — an
// operation that names one (cloud.action) has just built it. Unknown ids → 404, as before.
const envProtected = async (env: string | undefined) => {
  if (!env) return false;
  const ecs = (await listEnvs()).find((e) => e.id === env);
  if (ecs) return ecs.protected;
  const inv = cachedInventoryEnvs()?.find((e) => e.id === env);
  if (inv) return inv.protected;
  return (await envInfo(env)).protected;
};

export async function invoke(name: string, rawInput: unknown, c: Caller, opts: { dryRun?: boolean } = {}): Promise<InvokeResult> {
  const op = findOp(name);
  if (!op) throw new HttpError(404, `unknown operation "${name}" — GET /api/ops lists them`);
  // The session bypass (AGENT_ARCHITECTURE §3): inside an agent run, only the agent identity may call the registry.
  if (currentAgentContext() && c.via !== "agent") throw new HttpError(500, "agent runs must use the agent identity");
  if (c.via === "agent") return invokeAsAgent(op, rawInput, c, opts);
  const input = (rawInput ?? {}) as Record<string, unknown>;
  const problems = validate(op.input, input);
  if (problems.length) throw new OpInputError(problems);
  if (c.via === "token" && op.perm === "admin") throw new HttpError(403, "API tokens can't use admin operations");
  const ctx = opContext(c);
  requireRole(c.user, op.perm, false); // cheap check before looking anything up
  const perm = await permFor(op, input);
  if (c.via === "token" && perm === "admin") throw new HttpError(403, "API tokens can't use admin operations");
  const env = await op.env?.(input);
  const prot = (await envProtected(env)) || !!(await op.protectedOf?.(input));
  requireRole(c.user, perm, prot);
  // The mode gate applies to dry runs too: a read-only token gets no plans of changes (a plan can say more than it
  // should about the current state — e.g. whether a value it guesses is already set).
  const g = gate(c.tokenMode, op.riskOf?.(input) ?? op.risk, prot, c.via);
  if (g === "deny") throw new HttpError(403, gateRefusal(c.tokenMode));
  if (opts.dryRun) return { kind: "plan", plan: await planFor(op, input, ctx, env) };
  if (c.via === "token" && c.tokenId) noteUse(c.tokenId);
  if (g === "approve") return { kind: "approval", approval: await requestApproval(op, input, ctx, env) };
  return { kind: "result", result: await op.run(input, ctx) };
}

function requireRole(user: User, perm: Perm, protectedEnv: boolean) {
  if (!can(user, perm, protectedEnv)) throw new HttpError(403, `your role (${user.role}) can't do this${protectedEnv ? " on a protected environment" : ""} — needs ${roleFor(perm, protectedEnv)}`);
}

async function requestApproval(op: AnyOperation, input: Record<string, unknown>, ctx: OpContext, env?: string): Promise<ApprovalView> {
  if (!ctx.tokenId) throw new HttpError(500, "an approval can only be requested with an API token");
  const dup = await store.findPendingDuplicate(ctx.tokenId, op.name, input);
  if (dup) return view(dup, ctx);
  if ((await store.countPending(ctx.tokenId)) >= store.MAX_PENDING_PER_TOKEN)
    throw new HttpError(429, `this token already has ${store.MAX_PENDING_PER_TOKEN} requests waiting for approval — wait for decisions first`, 60_000);
  const plan = await planFor(op, input, ctx, env);
  // The exact plan as requested: approving re-plans as this token and refuses when it hashes differently.
  const { planHash } = grantHashes({ op: op.name, secretFields: op.secretFields, input, plan, targets: (await targetsFor(op, input, env, false)).map((t) => t.key) });
  const row = await store.createApproval({ op: op.name, input, plan, env, tokenId: ctx.tokenId, requestedBy: ctx.user.id, planHash });
  store.publishApproval(row, "created");
  return view(row, ctx);
}

// ---------- agents ----------

export interface AgentInvokeEvent {
  principal: AgentPrincipal;
  op: string;
  risk: Risk;
  input: Record<string, unknown>; // masked (secret fields hidden); the runner redacts and minimises before storing
  outcome: "result" | "approval" | "denied" | "error";
  result?: unknown; // the operation's result (redacted later, by the listener)
  approvalId?: string;
  grantId?: string;
  reason?: string;
  stepId?: string;
  at: number;
}

// Listeners on globalThis (the runner subscribes from the instrumentation bundle; calls arrive in route bundles).
const ag = globalThis as { __consoleAgentInvoke?: Set<(e: AgentInvokeEvent) => void> };
const invokeListeners = (ag.__consoleAgentInvoke ??= new Set());

// Every agent-caller invoke() — results, approval requests, denials and errors. Listeners never throw (a throwing one
// is ignored); the return value unsubscribes.
export function onAgentInvoke(f: (e: AgentInvokeEvent) => void): () => void {
  invokeListeners.add(f);
  return () => void invokeListeners.delete(f);
}

function fireAgentInvoke(e: AgentInvokeEvent) {
  for (const f of [...invokeListeners]) {
    try {
      f(e);
    } catch {
      /* a listener's failure is its own */
    }
  }
}

const coded = (status: number, message: string, code: string) => Object.assign(new HttpError(status, message), { code });

async function invokeAsAgent(op: AnyOperation, rawInput: unknown, c0: Caller, opts: { dryRun?: boolean }): Promise<InvokeResult> {
  const raw = { ...((rawInput ?? {}) as Record<string, unknown>) };
  let masked: Record<string, unknown> = {};
  try {
    masked = maskInput(op, raw);
  } catch {
    masked = {};
  }
  const refuse = (p: AgentPrincipal | undefined, e: unknown) => {
    // Refused before the agent's identity checked out: still on the record when the runner handed in a principal.
    if (p) fireAgentInvoke({ principal: p, op: op.name, risk: op.risk, input: masked, outcome: "denied", reason: e instanceof HttpError ? e.message : errText(e), stepId: c0.stepId, grantId: c0.grantId, at: Date.now() });
    return e;
  };
  let c: Caller;
  try {
    c = await resolveCaller(c0);
  } catch (e) {
    throw refuse(c0.principal, e);
  }
  const p = c.principal!;
  const policy = c.policy!;
  const active = currentAgentContext();
  if (active && active.runId !== p.runId) throw refuse(p, new HttpError(500, "agent runs must use their own agent identity"));
  const base = { principal: p, op: op.name, risk: op.risk, stepId: c.stepId, grantId: c.grantId };
  let fired = false;
  const fire = (o: Pick<AgentInvokeEvent, "outcome"> & Partial<AgentInvokeEvent>) => {
    fired = true;
    fireAgentInvoke({ ...base, input: masked, at: Date.now(), ...o });
  };
  try {
    if (!(await agentsEnabled()).on) throw coded(503, AGENTS_OFF, "agents_off");
    // What no policy can allow is refused before anything else is looked at (the input doesn't matter).
    const hard = hardDenyReason({ op: op.name, perm: op.perm, risk: op.risk, targets: [] });
    if (hard) {
      fire({ outcome: "denied", reason: hard });
      throw coded(403, `the agent's policy refuses this: ${hard}`, "policy_denied");
    }
    if (c.grantId) {
      // Executing an approved change: the approver's human-only fields the operation doesn't declare are dropped.
      for (const f of HUMAN_FIELDS) if (Object.hasOwn(raw, f) && !op.input.properties?.[f]) delete raw[f];
    } else for (const f of AGENT_FORBIDDEN_FIELDS) if (Object.hasOwn(raw, f)) throw new OpInputError([`${f}: only a person approving the request can set this`]);
    const problems = validate(op.input, raw);
    if (problems.length) throw new OpInputError(problems);
    const input = raw;
    const risk = op.riskOf?.(input) ?? op.risk;
    base.risk = risk;
    requireRole(c.user, op.perm, false);
    const perm = await permFor(op, input);
    const env = await op.env?.(input);
    const prot = (await envProtected(env)) || !!(await op.protectedOf?.(input));
    requireRole(c.user, perm, prot);
    if (risk !== "read") {
      const stop = await isEmergencyStopped();
      if (stop.on) throw coded(423, STOPPED, "emergency_stop");
    }
    const targets = await targetsFor(op, input, env, prot, { detail: risk !== "read" });
    const decision = evaluate(policy, { op: op.name, risk, perm, targets, protectedEnv: prot, counters: await countersFor(p, c.stepId, c.grantId) });
    if (decision.effect === "deny") {
      fire({ outcome: "denied", reason: decision.reason });
      throw coded(403, `the agent's policy refuses this: ${decision.reason}`, "policy_denied");
    }
    const ctx = opContext(c);
    if (opts.dryRun) {
      // A dry run is a tool call too (the runner records its plan as evidence): it fires like a result.
      const plan = await planFor(op, input, ctx, env);
      fire({ outcome: "result", result: { plan }, reason: decision.effect === "approve" ? decision.reason : undefined });
      return { kind: "plan", plan };
    }
    if (c.tokenId) noteAgentTokenUse(c.tokenId);
    const keys = targets.map((t) => t.key);
    let planHash: string | undefined;
    if (c.grantId) {
      // Re-plan now, as the agent: the grant binds this exact plan, input, principal and policy (single use).
      const plan = await planFor(op, input, ctx, env);
      const h = grantHashes({ op: op.name, secretFields: op.secretFields, input, plan, targets: keys });
      if (!(await verifyAndConsumeGrant(c.grantId, { op: op.name, ...h, principal: p })))
        throw coded(409, "the approval doesn't cover this change any more (it was used, it expired, or the plan changed since a person approved it) — ask again", "grant_invalid");
      planHash = h.planHash;
    } else if (decision.effect === "approve") {
      const plan = await planFor(op, input, ctx, env);
      const ticket = await requestGrant({ principal: p, op: op.name, input, plan, targets: keys, env, runId: p.runId!, stepId: c.stepId, policy, secretFields: op.secretFields, protected: prot });
      const row = await store.getApproval(ticket.approvalId);
      if (!row) throw new HttpError(500, "the approval request was not recorded");
      fire({ outcome: "approval", approvalId: ticket.approvalId, grantId: ticket.grantId, reason: decision.reason });
      return { kind: "approval", approval: await view(row, ctx) };
    }
    // Allowed (bounded-act), or approved: run as the agent, inside the run's mutation context.
    let result: unknown;
    try {
      result = await runWithMutationContext(
        {
          kind: "agent", runId: p.runId, stepId: c.stepId, grantId: c.grantId, userId: c.user.id, tokenId: c.tokenId, via: "agent",
          idempotencyKey: c.stepId ? `run:${p.runId}:step:${c.stepId}` : undefined, planHash,
        },
        () => withAgentContext(p, () => op.run(input, ctx)),
      );
    } catch (e) {
      if (c.grantId) await finishGrant(c.grantId, { ok: false, error: e instanceof HttpError ? e.message : errText(e) }).catch(() => {});
      throw e;
    }
    if (c.grantId) {
      const operationId = result && typeof result === "object" && typeof (result as { operationId?: unknown }).operationId === "string" ? (result as { operationId: string }).operationId : undefined;
      await finishGrant(c.grantId, { ok: true, result, operationId }).catch((e) => console.error(JSON.stringify({ level: 50, msg: "grant bookkeeping failed", grant: c.grantId, err: errText(e) })));
    }
    fire({ outcome: "result", result });
    return { kind: "result", result };
  } catch (e) {
    if (!fired) fire({ outcome: e instanceof HttpError && (e.status === 403 || e.status === 423 || e.status === 503) ? "denied" : "error", reason: e instanceof HttpError ? e.message : errText(e) });
    throw e;
  }
}

// The run's counters for the policy's limits. An external agent's run lives as long as its token, so its tool calls
// are counted per hour and neither its run time nor model turns apply. The step making this call (a durable `tool`
// or `execute` step already exists while it runs) isn't counted against itself. Executing a change a person approved
// (a grant) and the run's `execute` / `verify` steps don't count run time or model turns either: an approval stays
// open longer than a run's time limit, and the grant's own expiry and the verification window bound those calls.
// Tool-call and mutation limits still apply.
async function countersFor(p: AgentPrincipal, stepId?: string, grantId?: string): Promise<PolicyCounters> {
  const runId = p.runId!;
  const now = Date.now();
  const db = await getDb();
  const run = await getRun(runId);
  const external = run?.kind === "external";
  const step = stepId ? await db.get<{ kind: string }>("SELECT kind FROM agent_steps WHERE id = ? AND run_id = ?", [stepId, runId]) : undefined;
  const afterApproval = !!grantId || step?.kind === "execute" || step?.kind === "verify";
  const [ops, calls, turns] = await Promise.all([
    db.all<{ targets: string | null; state: string }>("SELECT targets, state FROM operations WHERE run_id = ? AND created_at > ?", [runId, now - 3_600_000]),
    db.get<{ n: number | string }>("SELECT COUNT(*) AS n FROM agent_steps WHERE run_id = ? AND kind IN ('tool', 'propose', 'execute') AND created_at > ? AND id <> ?", [
      runId, external ? now - 3_600_000 : 0, stepId ?? "",
    ]),
    external ? Promise.resolve(0) : modelCallCount(runId),
  ]);
  const byKey: Record<string, number> = {};
  let active = 0;
  for (const o of ops) {
    if (o.state === "queued" || o.state === "running") active++;
    try {
      const t = JSON.parse(o.targets ?? "{}") as { keys?: string[] };
      for (const k of t.keys ?? []) byKey[k] = (byKey[k] ?? 0) + 1;
    } catch {
      // unreadable targets: not counted
    }
  }
  return {
    mutationsLastHourByKey: byKey,
    activeMutations: active,
    toolCalls: Number(calls?.n ?? 0),
    turns: external || afterApproval ? 0 : turns,
    elapsedMs: external || afterApproval || !run ? 0 : now - Number(run.created_at),
  };
}

// The targets an operation call would touch, as the policy sees them (the runner's previews, the Automation UI, tests).
export async function resolveTargets(name: string, input: Record<string, unknown>): Promise<PolicyTarget[]> {
  const op = findOp(name);
  if (!op) throw new HttpError(404, `unknown operation "${name}"`);
  const env = await op.env?.(input);
  const prot = (await envProtected(env)) || !!(await op.protectedOf?.(input));
  return targetsFor(op, input, env, prot, { detail: true });
}

// What an operation call touches, for the policy and the plan hash: an inventory resource (`key`), an ECS service,
// host or database of an environment, or the environment itself. Best effort — unresolvable → [] (the policy refuses
// a change it can't place). Tags and the account come along, so a tag- or account-scoped policy can be checked.
// `detail` also reads what the policy needs for changes: the console's own service or host, an autoscaler, changed
// migrations — and when that can't be read, the target says so (`tagsUnread`): unknown never counts as "not ours".
async function targetsFor(op: AnyOperation, input: Record<string, unknown>, env: string | undefined, prot: boolean, o: { detail?: boolean } = {}): Promise<PolicyTarget[]> {
  try {
    const home = homeRegion();
    if (typeof input.key === "string") {
      const f = await findResource(input.key);
      if (!f) return [];
      const r = f.resource;
      const region = resourceRegion(r, home);
      const keys = keysForInventory(r.key, region, home);
      // Optional reads that didn't complete (R18 enrichment): tags are tagsUnread, the rest is other security metadata.
      const unread = Object.entries(r.enrichment ?? {}).filter(([label, s]) => s !== "ok" && label !== "tags").map(([label, s]) => `${label}: ${s}`);
      // The account: the resource's own, its ARN's, else its environment's cluster's (console keys carry none).
      const envArn = r.env ? (await listEnvs().catch(() => [])).find((e) => e.id === r.env)?.clusterArn : undefined;
      const account = r.account || [r.key, ...(r.aliases ?? [])].map((k) => parseArn(k)?.account).find((a) => !!a) || parseArn(envArn ?? "")?.account || undefined;
      return [{
        key: keys[0], aliases: [...new Set([r.key, ...(r.aliases ?? []), ...keys.slice(1)])], env: r.env, region, account, kind: r.kind, tags: r.tags,
        protected: prot || resourceProtected(r, f.envs), tagsUnread: r.tagsUnread || (r.enrichment?.tags !== undefined && r.enrichment.tags !== "ok") || undefined,
        ...(unread.length ? { unreadMetadata: unread } : {}), self: isSelfTagged(r.tags),
      }];
    }
    if (!env) return [];
    const info = await envInfo(env);
    const at = info.region && info.region !== home ? `@${info.region}` : "";
    const account = parseArn(info.clusterArn ?? "")?.account || undefined;
    const base = { env, region: info.region, account, protected: prot };
    // A service, host or database tagged console:protected is protected on any environment (as on the cloud map).
    const tagProtected = (tags: Record<string, string>) => protectionOf({ env, tags }, [{ id: env, protected: prot }]).protected;
    if (typeof input.service === "string") {
      const service = input.service;
      const t: PolicyTarget = { key: canonicalKey({ ecsService: { region: info.region, cluster: info.cluster, service } }), aliases: [`ecs:service/${info.cluster}/${service}${at}`], kind: "ecs-service", ...base };
      let live: Awaited<ReturnType<typeof liveService>> | undefined;
      try {
        live = await liveService(info, service);
        t.tags = { ...live.tags };
        t.protected = tagProtected(t.tags);
      } catch (e) {
        // A change on a service that doesn't exist can't be placed; a read still carries the target (scope applies).
        if (o.detail && e instanceof HttpError && e.status === 404) return [];
      }
      if (o.detail) {
        const meta = live ? await metaOf(info, live).catch(() => undefined) : undefined;
        if (meta) t.self = meta.self || isSelfTagged(live?.tags);
        else t.tagsUnread = true; // whether it is the console's own service is unknown
        if (/^services\.(scale|start|stop)$/.test(op.name)) t.autoscaled = !!(live?.scalable ?? (await autoscalingOf(info, service).catch(() => undefined)));
        if (op.name === "services.switch" && typeof input.revision === "number")
          t.migrations = (await revisions(env, service).catch(() => [])).find((r) => r.revision === input.revision)?.migrations ?? "unknown";
      }
      return [t];
    }
    // hosts.terminate names its instance `id`.
    const hostId = typeof input.host === "string" ? input.host : op.name === "hosts.terminate" && typeof input.id === "string" ? input.id : undefined;
    if (hostId !== undefined || typeof input.database === "string") {
      const host = hostId !== undefined;
      const id = String(host ? hostId : input.database);
      const t: PolicyTarget = host
        ? { key: canonicalKey({ ec2: { region: info.region, id } }), aliases: [`ec2:${id}${at}`], kind: "ec2", ...base }
        : { key: canonicalKey({ rds: { region: info.region, id } }), aliases: [`rds:${id}${at}`], kind: "rds", ...base };
      const cat = await catalog(env).catch(() => undefined);
      const found = host ? cat?.hosts.find((h) => h.id === id) : cat?.databases.find((d) => d.id === id);
      if (found) {
        t.tags = { ...found.tags };
        t.protected = tagProtected(t.tags);
        t.self = isSelfTagged(found.tags);
      } else if (o.detail) t.tagsUnread = true;
      return [t];
    }
    return [{ key: `env:${env}`, level: "env", env, region: info.region, account, protected: prot }];
  } catch {
    return [];
  }
}

// ---------- approval views ----------

export interface ApprovalView {
  id: string;
  op: string;
  title: string;
  risk: Risk | "unknown";
  env: string | null;
  protected: boolean;
  status: ApprovalStatus;
  plan: Plan | null;
  input: Record<string, unknown>; // secret fields hidden
  confirm: string; // what an approver types; "yes" = one click
  needsReason: boolean; // protected environment or a danger operation, and no reason yet: the approver must give one
  token: { id: string | null; name: string | null };
  owner: { id: string; email: string | null }; // an agent's request: the person it acts for
  run: { id: string; grantId: string | null } | null; // an agent's request: decided here, executed by the run as the agent
  createdAt: number;
  expiresAt: number;
  decidedAt: number | null;
  decidedBy: string | null;
  result?: unknown;
  detail?: string;
  canDecide: boolean; // this viewer (a person with the operation's permission) may approve or reject it now
}

type Viewer = Pick<OpContext, "user" | "via" | "tokenId" | "runId">;

// CONSOLE_APPROVALS_TWO_PERSON=true: nobody approves requests made with their own tokens (four-eyes). Off by default
// so a one-person team can still use agents; rejecting your own requests is always allowed.
const twoPerson = () => /^(true|1|yes|on)$/i.test(process.env.CONSOLE_APPROVALS_TWO_PERSON?.trim() ?? "");

async function view(r: store.ApprovalRow, viewer: Viewer, protectedEnvs?: Set<string>): Promise<ApprovalView> {
  const op = REGISTRY.get(r.op);
  const envProt = r.env ? (protectedEnvs ? protectedEnvs.has(r.env) : await envProtected(r.env).catch(() => true)) : false;
  const prot = envProt || (!!op?.protectedOf && (await Promise.resolve().then(() => op.protectedOf!(store.openInput(r))).catch(() => true)));
  let status = store.statusOf(r);
  let expiresAt = Number(r.created_at) + 24 * 3_600_000;
  let detail = r.detail ?? undefined;
  // An agent's request also ends when its grant expires (its own, shorter expiry — after approval, the window for the
  // run to execute it) or is invalidated, and when its run ended before anyone decided.
  if (r.grant_id) {
    const g = await getGrant(r.grant_id).catch(() => undefined);
    if (g?.expires_at) expiresAt = Number(g.expires_at);
    if (status === "pending" || status === "approved") {
      const gs = g ? grantStatus(g) : "expired";
      if (gs === "expired") status = "expired";
      else if (gs === "invalidated" || gs === "rejected") status = "rejected";
      else if (status === "pending" && r.run_id) {
        const run = await getRun(r.run_id).catch(() => undefined);
        if (!run || isFinalRun(run.state)) {
          status = "expired";
          detail ??= `the agent's run ended (${run ? run.state.replace(/_/g, " ") : "deleted"}) before anyone decided`;
        }
      }
    }
  }
  const plan = store.planOf(r);
  let input: Record<string, unknown> = {};
  let risk: Risk | "unknown" = op?.risk ?? "unknown";
  let perm: Perm = op?.perm ?? "admin";
  try {
    const raw = store.openInput(r);
    if (op?.riskOf) risk = op.riskOf(raw); // e.g. a one-off task with a command is danger, without one change
    input = maskInput(op, raw);
    // Fail closed: when the permission can't be worked out (the resource is gone), only admins see details.
    if (op?.permOf) perm = await permFor(op, raw).catch((): Perm => "admin");
  } catch {
    input = { error: "input can't be decrypted (CONSOLE_SECRET_KEY changed?)" };
  }
  const reasonField = !!op?.input.properties?.reason;
  // Details (the plan's changes, the input — e.g. a one-off task's command — and the result) are for the token that
  // asked and for people who could decide; everyone else sees that a request exists and its one-line summary.
  const mayRead = viewer.via === "token" || viewer.via === "agent" || (!!op && can(viewer.user, perm, prot));
  const shown = mayRead ? { plan, input, result: store.resultOf(r) } : { plan: plan ? { summary: plan.summary } : plan, input: {}, result: undefined };
  return {
    id: r.id,
    op: r.op,
    title: op?.title ?? r.op,
    risk,
    env: r.env,
    protected: prot,
    status,
    plan: shown.plan,
    input: shown.input,
    confirm: plan?.confirm || "yes",
    needsReason: (prot || risk === "danger") && reasonField && !(typeof input.reason === "string" && input.reason.trim().length >= 3),
    token: { id: r.token_id, name: r.token_name ?? null },
    owner: { id: r.requested_by, email: r.owner_email ?? null },
    run: r.run_id ? { id: r.run_id, grantId: r.grant_id ?? null } : null,
    createdAt: Number(r.created_at),
    expiresAt,
    decidedAt: r.decided_at ? Number(r.decided_at) : null,
    decidedBy: r.decided_by,
    result: shown.result,
    detail: detail ?? (store.interrupted(r) ? "interrupted while running — check the audit log for whether the action went out" : undefined),
    canDecide: viewer.via !== "token" && viewer.via !== "agent" && status === "pending" && !!op && can(viewer.user, perm, prot) && !(twoPerson() && r.requested_by === viewer.user.id),
  };
}

// Tokens see only their own requests, agents their own run's; people see all of them (like the audit log).
export async function listApprovalViews(viewer: Viewer, f: { status?: ApprovalStatus | "all"; limit?: number }): Promise<ApprovalView[]> {
  if (viewer.via === "token" && !viewer.tokenId) return [];
  if (viewer.via === "agent" && !viewer.runId) return [];
  const rows = await store.listApprovals({
    status: f.status, tokenId: viewer.via === "token" ? viewer.tokenId : undefined, runId: viewer.via === "agent" ? viewer.runId : undefined, limit: f.limit,
  });
  const protectedEnvs = new Set([...(await listEnvs().catch(() => [])), ...(cachedInventoryEnvs() ?? [])].filter((e) => e.protected).map((e) => e.id));
  return Promise.all(rows.map((r) => view(r, viewer, protectedEnvs)));
}

export async function getApprovalView(id: string, viewer: Viewer): Promise<ApprovalView> {
  const r = await store.getApproval(id);
  if (!r || (viewer.via === "token" && r.token_id !== viewer.tokenId) || (viewer.via === "agent" && (!viewer.runId || r.run_id !== viewer.runId))) throw new HttpError(404, "no such approval request");
  return view(r, viewer);
}

export async function pendingCount(viewer: Viewer): Promise<number> {
  if (viewer.via === "agent") return viewer.runId ? store.countPending(undefined, viewer.runId) : 0;
  return store.countPending(viewer.via === "token" ? viewer.tokenId : undefined);
}

// ---------- decide (people only) ----------

export async function decide(id: string, body: unknown, c: Caller): Promise<{ approval: ApprovalView; result?: unknown; error?: string }> {
  if (c.via === "token") throw new HttpError(403, "API tokens can't approve or reject requests");
  if (c.via === "agent" || currentAgentContext()) throw new HttpError(403, "agents can't approve or reject requests");
  const b = (body ?? {}) as { decision?: unknown; reason?: unknown; confirm?: unknown; migrationAck?: unknown };
  const decision = b.decision as ApprovalDecision;
  if (decision !== "approve" && decision !== "reject") throw new HttpError(400, 'decision must be "approve" or "reject"');
  if (b.reason !== undefined && (typeof b.reason !== "string" || b.reason.length > 500)) throw new HttpError(400, "reason must be a string ≤ 500 chars");
  if (b.confirm !== undefined && (typeof b.confirm !== "string" || b.confirm.length > 200)) throw new HttpError(400, "confirm must be a string");
  if (b.migrationAck !== undefined && typeof b.migrationAck !== "boolean") throw new HttpError(400, "migrationAck must be a boolean");
  const reason = typeof b.reason === "string" ? b.reason.trim() || undefined : undefined;

  const row = await store.getApproval(id);
  if (!row) throw new HttpError(404, "no such approval request");
  const op = REGISTRY.get(row.op);
  if (!op) throw new HttpError(409, `operation "${row.op}" no longer exists — reject the request`);
  // The input's permission (cloud.action: the provider action's) is looked up first — it also rebuilds the cloud map
  // after a restart, which envProtected() reads. Rejecting needs only the base permission; approving fails closed.
  const perm = op.permOf ? await Promise.resolve().then(() => permFor(op, store.openInput(row))).catch((): Perm => (decision === "reject" ? op.perm : "admin")) : op.perm;
  const prot = (await envProtected(row.env ?? undefined)) || (op.protectedOf ? await Promise.resolve().then(() => op.protectedOf!(store.openInput(row))).catch(() => true) : false);
  requireRole(c.user, perm, prot);
  const status = store.statusOf(row);
  if (status !== "pending") throw new HttpError(409, `this request is already ${status}`);
  if (decision === "approve" && twoPerson() && row.requested_by === c.user.id)
    throw new HttpError(403, "this console requires a second person to approve requests from your own tokens (CONSOLE_APPROVALS_TWO_PERSON)");
  if (row.grant_id) return decideAgentRequest(row, op, { decision, reason, confirm: typeof b.confirm === "string" ? b.confirm : undefined, migrationAck: b.migrationAck === true }, c, prot);
  // A request outlives neither its token nor its owner's account: revoked, expired, disabled or deleted → rejected.
  if (row.token_id && !(await tokenStillValid(row.token_id))) {
    if (await store.rejectApproval(id, "system", "the token was revoked or expired, or its owner was disabled or deleted")) {
      const fresh = await store.getApproval(id);
      if (fresh) store.publishApproval(fresh, "decided");
    }
    throw new HttpError(409, "the token that asked was revoked or expired, or its owner was disabled or deleted — the request was rejected");
  }

  if (decision === "reject") {
    if (!(await store.rejectApproval(id, c.user.email, reason))) throw new HttpError(409, "someone else decided first");
    await writeAudit({
      at: Date.now(), phase: "result", env: row.env ?? "", target: row.op, action: "approval.reject", user: c.user.email, ip: c.ip, reason,
      params: { approval: id, token: row.token_name ?? row.token_id }, result: "ok",
    }).catch((e) => console.error(JSON.stringify({ level: 50, msg: "audit write failed", action: "approval.reject", err: errText(e) })));
    const fresh = (await store.getApproval(id))!;
    store.publishApproval(fresh, "decided");
    return { approval: await view(fresh, c) };
  }

  // Approve: everything that can be checked is checked before the request is consumed.
  const plan = store.planOf(row);
  const expected = plan?.confirm && plan.confirm !== "yes" ? plan.confirm : undefined;
  const typed = typeof b.confirm === "string" ? b.confirm : undefined;
  if (expected && typed !== expected) throw new HttpError(400, `confirmation text does not match (expected "${expected}")`);
  const input = store.openInput(row);
  const props = op.input.properties ?? {};
  // The person's confirmation, never the agent's. A one-click ("yes") plan ignores whatever else was typed, so a stray
  // value can't use the request up with a doomed run.
  if (props.confirm) input.confirm = expected ?? "yes";
  if (props.reason && reason && !(typeof input.reason === "string" && input.reason.trim())) input.reason = reason;
  // A reason is required on protected environments and for every danger operation (the runners demand it too).
  const danger = (op.riskOf?.(input) ?? op.risk) === "danger";
  if ((prot || danger) && props.reason && !(typeof input.reason === "string" && input.reason.trim().length >= 3))
    throw new HttpError(400, `a reason is required ${prot ? "on a protected environment" : "for a dangerous operation"} — add one when approving`);
  const problems = validate(op.input, input);
  if (problems.length) throw new OpInputError(problems);
  // The exact plan (master plan §6 C1 item 5): re-plan now as the token that asked, and refuse when anything it would
  // change differs from what was requested — the person approves what they see, not what it has become.
  if (row.plan_hash) {
    const now = await replanHash(op, store.openInput(row), row.env ?? undefined, async () => {
      const t = row.token_id ? await tokenById(row.token_id) : undefined;
      const owner = await userById(row.requested_by);
      if (!t || !owner) throw new HttpError(409, "the token that asked no longer exists");
      const u = toUser(owner);
      // The token's role, never above its owner's current one (verifyToken's rule).
      return { user: { ...u, role: minRole(t.role, u.role) }, actor: `${owner.email} via token "${t.name}"`, via: "token", tokenId: t.id, tokenName: t.name, tokenMode: t.mode };
    });
    if (now !== row.plan_hash) {
      if (await store.rejectApproval(id, "system", "invalidated: the plan changed since it was requested")) {
        const fresh = await store.getApproval(id);
        if (fresh) store.publishApproval(fresh, "decided");
      }
      throw Object.assign(new HttpError(409, "the plan changed since it was requested — ask for a new request"), { code: "plan_changed" });
    }
  }
  // The decision itself is on the record before anything runs (the operation writes its own intent/result rows too).
  try {
    await writeAudit({ at: Date.now(), phase: "intent", env: row.env ?? "", target: row.op, action: "approval.approve", user: c.user.email, ip: c.ip, reason, params: { approval: id, token: row.token_name ?? row.token_id } });
  } catch (e) {
    throw new HttpError(503, `audit log unavailable, approval refused: ${errText(e)}`);
  }
  if (!(await store.claimApproval(id, c.user.email))) throw new HttpError(409, "someone else decided first, or the request expired");
  store.publishApproval(row, "decided", "approved");

  const ctx: OpContext = {
    user: c.user,
    actor: `${c.user.email} approving token "${row.token_name ?? "deleted token"}" (requested by ${row.owner_email ?? "a deleted user"})`,
    ip: c.ip,
    via: c.via,
    tokenId: row.token_id ?? undefined,
    tokenName: row.token_name ?? undefined,
    approval: id,
  };
  let result: unknown;
  let error: string | undefined;
  let ran = false;
  try {
    result = await op.run(input, ctx);
    ran = true;
  } catch (e) {
    error = e instanceof HttpError ? e.message : errText(e);
  }
  // Bookkeeping outside the run's try (F67): a change that went out must never be recorded as failed because this
  // write failed — the token would ask again and repeat it. A failed write is logged; the operation's own audit rows
  // stand.
  try {
    if (ran) await store.finishApproval(id, "done", result);
    else await store.finishApproval(id, "failed", undefined, error);
  } catch (e) {
    console.error(JSON.stringify({ level: 50, msg: "approval bookkeeping failed", approval: id, op: row.op, outcome: ran ? "done" : "failed", err: errText(e) }));
  }
  const fresh = (await store.getApproval(id))!;
  store.publishApproval(fresh, "done");
  return { approval: await view(fresh, c), result, error };
}

// The plan hash of a request as it would be planned now, by the requester (an API token, or an agent principal).
async function replanHash(op: AnyOperation, input: Record<string, unknown>, env: string | undefined, requester: () => Promise<OpContext>): Promise<string> {
  const ctx = await requester();
  const plan = await planFor(op, input, ctx, env).catch((e) => {
    throw Object.assign(new HttpError(409, `the change can't be planned any more: ${e instanceof HttpError ? e.message : errText(e)}`), { code: "plan_changed" });
  });
  return grantHashes({ op: op.name, secretFields: op.secretFields, input, plan, targets: (await targetsFor(op, input, env, false)).map((t) => t.key) }).planHash;
}

// An agent's request: the person's decision is recorded on its grant (decideGrant) and, when approved, the run's
// execute step is queued — the change then runs as the agent principal with the grant, never as the approver.
async function decideAgentRequest(
  row: store.ApprovalRow,
  op: AnyOperation,
  d: { decision: ApprovalDecision; reason?: string; confirm?: string; migrationAck: boolean },
  c: Caller,
  prot: boolean,
): Promise<{ approval: ApprovalView }> {
  const g = await getGrant(row.grant_id!);
  if (!g) throw new HttpError(409, "this request's grant is missing — reject it");
  if (d.decision === "reject") {
    await decideGrant(g.id, { decision: "reject", by: c.user, reason: d.reason, ip: c.ip });
    return { approval: await view((await store.getApproval(row.id))!, c) };
  }
  const plan = store.planOf(row);
  const expected = plan?.confirm && plan.confirm !== "yes" ? plan.confirm : undefined;
  if (expected && d.confirm !== expected) throw new HttpError(400, `confirmation text does not match (expected "${expected}")`);
  const input = store.openInput(row);
  const props = op.input.properties ?? {};
  const danger = (op.riskOf?.(input) ?? op.risk) === "danger";
  const reasonGiven = (typeof input.reason === "string" && input.reason.trim().length >= 3) || (d.reason?.length ?? 0) >= 3;
  if ((prot || danger) && props.reason && !reasonGiven)
    throw new HttpError(400, `a reason is required ${prot ? "on a protected environment" : "for a dangerous operation"} — add one when approving`);
  const stored = parsePrincipal(g.principal);
  if (!stored?.runId) throw new HttpError(409, "this request's agent identity is unreadable — reject it");
  // The change will run as the agent, with its delegator's role as it is now: a request its person can no longer make
  // (demoted, disabled) is over — approving it would only queue a change that must fail.
  const delegator = await delegatorOf(stored).catch(() => undefined);
  const perm = await permFor(op, input).catch((): Perm => "admin");
  if (!delegator || !can(delegator, perm, prot)) {
    const why = delegator ? `${stored.delegatorEmail} (now ${delegator.role}) can no longer make this change` : `${stored.delegatorEmail} is disabled or no longer exists`;
    await invalidateGrant(g.id, why);
    throw Object.assign(new HttpError(409, `the person this agent acts for can't make this change any more: ${why} — the request was rejected`), { code: "delegator_changed" });
  }
  // Rolling back across changed (or unchecked) migrations needs the person's acknowledgement, never the agent's.
  if (op.name === "services.switch") {
    const t = (await targetsFor(op, input, row.env ?? undefined, prot, { detail: true }))[0];
    if ((t?.migrations === true || t?.migrations === "unknown") && !d.migrationAck)
      throw new HttpError(400, "database migrations changed (or couldn't be checked) between these revisions — approve with migrationAck: true to acknowledge it");
  }
  // Re-plan as the agent that asked: anything different from what was requested invalidates the request.
  const hash = await replanHash(op, input, row.env ?? undefined, async () => opContext({ user: delegator, via: "agent", principal: stored, runId: stored.runId, tokenId: stored.tokenId }));
  if (hash !== g.plan_hash) {
    await invalidateGrant(g.id, "the plan changed since it was requested");
    throw Object.assign(new HttpError(409, "the plan changed since it was requested — the agent has to ask again"), { code: "plan_changed" });
  }
  await decideGrant(g.id, { decision: "approve", by: c.user, reason: d.reason, confirm: expected ?? "yes", migrationAck: d.migrationAck, ip: c.ip });
  return { approval: await view((await store.getApproval(row.id))!, c) };
}

// ---------- MCP ----------

// tools/call → invoke. Failures of a known tool are results with isError (the model should read them); an approval
// request is a normal result telling the model to wait. null = no such tool for this caller.
export async function callTool(tool: string, args: Record<string, unknown>, c: Caller): Promise<{ text: string; isError?: boolean } | null> {
  const op = OPERATIONS.find((o) => toolName(o.name) === tool);
  // An agent calling a tool its policy hides gets the refusal with its reason, and the attempt is on its run's record
  // (onAgentInvoke "denied" — a prevented violation); for API tokens a hidden tool stays unknown.
  if (!op || (!allowedFor(op, c) && c.via !== "agent")) return null;
  try {
    const r = await invoke(op.name, args, c);
    if (r.kind === "approval")
      return {
        text: JSON.stringify({
          approval: { id: r.approval.id, status: r.approval.status, plan: r.approval.plan, expiresAt: new Date(r.approval.expiresAt).toISOString() },
          note: `This change needs a person's approval in the console (Automation → Approvals). It has not run yet. Check it with approvals_get {"id":"${r.approval.id}"} (or GET /api/approvals/${r.approval.id}); do not send the same request again.`,
        }),
      };
    return { text: JSON.stringify(r.kind === "plan" ? { plan: r.plan } : r.result ?? null) };
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 502;
    const problems = e instanceof OpInputError ? e.problems : undefined;
    return { text: JSON.stringify({ ...(e instanceof HttpError ? errorBody(e) : { error: errText(e) }), status, ...(problems ? { problems } : {}) }), isError: true };
  }
}
