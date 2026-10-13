// The agent policy engine (master plan §6 C1, AGENT_ARCHITECTURE §6 "Authority"). Pure: the operations registry
// (src/lib/server/ops/index.ts) resolves an operation call's targets and the run's counters, then asks evaluate()
// whether an agent may run it now, must ask a person (an exact-plan approval grant), or is refused. Nothing a model
// says reaches this file: the policy comes from the run's stored record, the principal from the server.
//
// evaluate() decides, in this order — the first refusal wins:
//   1. HARD_DENY: what no policy can allow (variable writes, admin operations, IAM or the console itself);
//   2. the tool lists: `deny` beats everything; a read must be in `read`, a change in `propose` or `act`;
//   3. scope: every target must match the selector; a change whose targets couldn't be resolved is refused;
//   4. evidence (R01): a change on a target whose tags weren't read is refused — its protection, and whether it is the
//      console's own, are unknown; with requireCompleteSecurityMetadata, so is a change on a target whose other
//      security metadata (a resource policy, its configuration) couldn't be read completely;
//   5. mode: observe → reads only; propose → every change becomes an approval request; bounded-act → a listed change
//      on explicitly listed, unprotected targets runs, everything else asks a person (if proposable) or is refused;
//      danger always asks a person; protected environments always ask a person (production autonomy is off); a scale
//      or start of an autoscaled service and a rollback across changed (or unchecked) migrations always ask a person;
//   6. limits: tool calls, model turns, run time, concurrent and per-resource hourly mutations.
import { createHash } from "node:crypto";
import { canonicalJson } from "../plan-hash.ts";
import type { Perm } from "../rbac.ts";
import type { Risk } from "../server/ops/types.ts";
import { AGENT_MODES, type AgentMode, type AgentPolicy, type PolicyDecision, type ResourceSelector } from "./types.ts";

// ---------- request ----------

// One resource (or environment) an operation call touches, as the registry resolved it (targetsFor()).
export interface PolicyTarget {
  key: string; // canonical coordinator key ("ecs-service:us-east-1/acme-staging/api"), an ARN, or "env:<id>"
  aliases?: string[]; // other names of the same thing (the inventory's own key: "ecs:service/acme-staging/api")
  level?: "env" | "resource"; // an environment as a whole (envs.status, hosts.add) or one resource (default)
  env?: string;
  region?: string;
  account?: string;
  kind?: string; // inventory kind ("ecs-service", "iam-role", "rds", …)
  tags?: Record<string, string>;
  protected: boolean; // a protected environment, a console:protected tag or a protection hint (fails closed)
  tagsUnread?: boolean; // the resource's tags couldn't be read: protection, self and scope by tag are unknown
  unreadMetadata?: string[]; // other optional reads of the resource that didn't complete ("policy", "config", …)
  self?: boolean; // the console's own service or resource (console:self, or the task's own service)
  autoscaled?: boolean; // an ECS service with an Application Auto Scaling target (a scale or start would fight it)
  migrations?: boolean | "unknown"; // services.switch: database migrations changed (or couldn't be checked)
}

export interface PolicyCounters {
  mutationsLastHourByKey: Record<string, number>; // this run's changes per target key over the last hour
  activeMutations: number; // this run's changes still in flight
  toolCalls: number; // operation calls the run made so far
  turns: number; // model turns so far
  elapsedMs: number; // since the run started
}

export interface PolicyRequest {
  op: string;
  risk: Risk;
  perm: Perm;
  targets: PolicyTarget[];
  protectedEnv: boolean;
  migrations?: boolean | "unknown"; // a rollback whose plan says migrations changed (or couldn't be checked)
  counters: PolicyCounters;
}

export const NO_COUNTERS: PolicyCounters = { mutationsLastHourByKey: {}, activeMutations: 0, toolCalls: 0, turns: 0, elapsedMs: 0 };

// ---------- the hard denials ----------

// Whatever a policy says. Approving or rejecting requests is not an operation at all (decide() refuses agents), and
// token, user and integration administration are admin operations or people-only routes today; `areas` also refuses
// any change operation a later version adds there — an agent never administers the console, its people, its agents
// (definitions, workflows, connections, other runs) or its own policy.
export const HARD_DENY = {
  ops: ["variables.update"] as readonly string[],
  perms: ["admin"] as readonly Perm[],
  areas: ["users", "tokens", "integrations", "settings", "approvals", "agents", "workflows", "definitions", "connections", "runs", "policies"] as readonly string[],
  reasons: {
    op: "agents can never change environment variables — a person edits them in the Variables editor",
    admin: "agents can never use admin operations (users, tokens, integrations, settings)",
    area: "agents can never administer the console, its people, its agents or their own policy",
    self: "agents can never act on the console itself",
    iam: "agents can never change IAM or the console's own authorisation",
  },
} as const;

const isIamTarget = (t: PolicyTarget) => /^iam[-:]/.test(t.kind ?? "") || /^arn:[^:]+:iam::/.test(t.key) || /^iam:/.test(t.key);

export function hardDenyReason(req: Pick<PolicyRequest, "op" | "perm" | "risk" | "targets">): string | undefined {
  if (HARD_DENY.ops.includes(req.op)) return HARD_DENY.reasons.op;
  if (HARD_DENY.perms.includes(req.perm)) return HARD_DENY.reasons.admin;
  if (req.risk !== "read") {
    if (HARD_DENY.areas.includes(req.op.split(".")[0])) return HARD_DENY.reasons.area;
    if (req.targets.some((t) => t.self)) return HARD_DENY.reasons.self;
    if (req.targets.some(isIamTarget)) return HARD_DENY.reasons.iam;
  }
  return undefined;
}

// ---------- tool lists ----------

// "services.restart", "services.*" or "*".
export function toolMatches(pattern: string, op: string): boolean {
  if (pattern === "*" || pattern === op) return true;
  return pattern.endsWith(".*") && op.startsWith(pattern.slice(0, -1));
}
export const listed = (list: readonly string[] | undefined, op: string) => (list ?? []).some((p) => toolMatches(p, op));

// ---------- scope ----------

const nonEmpty = <T>(a: readonly T[] | undefined): a is readonly T[] => !!a && a.length > 0;
const namesOf = (t: PolicyTarget) => [t.key, ...(t.aliases ?? [])];

// Whether one target lies inside the selector. Every field narrows; an absent or empty one doesn't. `keys` applies to
// resources, and to environment-level targets only for changes (a bounded or proposed change names what it touches).
export function targetInScope(sel: ResourceSelector, t: PolicyTarget, change: boolean): { ok: true } | { ok: false; why: string } {
  const name = t.env ? `${t.key} (${t.env})` : t.key;
  if (sel.account && t.account && t.account !== sel.account) return { ok: false, why: `${name} is in another AWS account` };
  if (sel.account && !t.account && change) return { ok: false, why: `${name}: its AWS account couldn't be worked out, so the agent's account scope can't be checked` };
  if (nonEmpty(sel.regions) && t.region && !sel.regions.includes(t.region)) return { ok: false, why: `${name} is outside the agent's regions` };
  if (nonEmpty(sel.regions) && !t.region && change) return { ok: false, why: `${name}: its region couldn't be worked out, so the agent's region scope can't be checked` };
  if (nonEmpty(sel.envs) && !(t.env && sel.envs.includes(t.env))) return { ok: false, why: `${name} is outside the agent's environments` };
  if (nonEmpty(sel.kinds) && t.level !== "env" && !(t.kind && sel.kinds.includes(t.kind))) return { ok: false, why: `${name} is not a kind of resource the agent may use` };
  if (nonEmpty(sel.keys) && (t.level !== "env" || change) && !namesOf(t).some((k) => sel.keys!.includes(k))) return { ok: false, why: `${name} is not one of the agent's resources` };
  if (sel.tags && Object.keys(sel.tags).length && t.level !== "env") {
    if (t.tagsUnread || !t.tags) return { ok: false, why: `${name}: its tags couldn't be read, so the agent's tag scope can't be checked` };
    for (const [k, v] of Object.entries(sel.tags)) if (t.tags[k] !== v) return { ok: false, why: `${name} doesn't carry the tag ${k}=${v}` };
  }
  if (sel.excludeProtected && t.protected) return { ok: false, why: `${name} is protected` };
  return { ok: true };
}

// Every target listed by name — what bounded-act needs before it runs anything without a person.
const explicitlyListed = (sel: ResourceSelector, t: PolicyTarget) => nonEmpty(sel.keys) && namesOf(t).some((k) => sel.keys!.includes(k));

// ---------- evaluate ----------

const deny = (reason: string): PolicyDecision => ({ effect: "deny", reason });
const approve = (reason: string): PolicyDecision => ({ effect: "approve", reason });

export function evaluate(policy: AgentPolicy, req: PolicyRequest): PolicyDecision {
  const change = req.risk !== "read";
  // 1. Hard denials.
  const hard = hardDenyReason(req);
  if (hard) return deny(hard);
  // 2. Tool lists.
  if (listed(policy.tools.deny, req.op)) return deny(`${req.op} is denied by the agent's policy`);
  const canRead = listed(policy.tools.read, req.op) || listed(policy.tools.propose, req.op) || listed(policy.tools.act, req.op);
  const canPropose = listed(policy.tools.propose, req.op);
  const canAct = listed(policy.tools.act, req.op);
  if (!change && !canRead) return deny(`${req.op} is not one of the agent's tools`);
  if (change && !canPropose && !canAct) return deny(`${req.op} is not one of the agent's tools`);
  // 3. Scope.
  if (change && !req.targets.length) return deny(`the resources ${req.op} would change couldn't be worked out, so the agent may not change them`);
  for (const t of req.targets) {
    const s = targetInScope(policy.scope, t, change);
    if (!s.ok) return deny(s.why);
  }
  // 4. Evidence (R01): unread protection metadata is a denial for changes, never an invitation to guess from a name.
  if (change) {
    const unread = req.targets.filter((t) => t.tagsUnread && t.level !== "env");
    if (unread.length)
      return deny(`the security metadata (tags) of ${unread.map((t) => t.key).join(", ")} couldn't be read, so whether it is protected or the console's own is unknown — agents never change it`);
    const partial = req.targets.filter((t) => t.unreadMetadata?.length && t.level !== "env");
    if (partial.length && policy.evidence.requireCompleteSecurityMetadata)
      return deny(`some security metadata of ${partial.map((t) => `${t.key} (${t.unreadMetadata!.join(", ")})`).join(", ")} couldn't be read, and the agent's policy requires it complete`);
  }
  // 5. Mode.
  let decision: PolicyDecision = { effect: "allow" };
  if (change) {
    if (policy.mode === "observe") return deny("the agent is in observe mode: it reads and explains, every change is refused");
    if (req.risk === "danger") decision = approve(`${req.op} is a dangerous operation: a person always approves it`);
    else if (policy.mode === "propose") decision = approve("the agent proposes changes; a person approves each one");
    else decision = boundedAct(policy, req, canAct, canPropose);
    if (decision.effect === "deny") return decision;
  }
  // 6. Limits.
  const limit = limitReason(policy, req);
  if (limit) return deny(limit);
  return decision;
}

// bounded-act: runs without a person only when every rule holds; otherwise a person decides (or, for an operation
// that isn't proposable, it's refused).
function boundedAct(policy: AgentPolicy, req: PolicyRequest, canAct: boolean, canPropose: boolean): PolicyDecision {
  const why = actRefusal(policy, req, canAct);
  if (!why) return { effect: "allow" };
  return canPropose ? approve(why) : deny(`${why}, and ${req.op} isn't one the agent may propose`);
}

function actRefusal(policy: AgentPolicy, req: PolicyRequest, canAct: boolean): string | undefined {
  if (!canAct) return `${req.op} isn't one of the changes the agent may make on its own`;
  if (req.risk !== "change") return `${req.op} is not a routine change`;
  if (req.protectedEnv || req.targets.some((t) => t.protected)) return "changes on protected resources always need a person";
  const unlisted = req.targets.filter((t) => !explicitlyListed(policy.scope, t));
  if (unlisted.length) return `${unlisted.map((t) => t.key).join(", ")} ${unlisted.length > 1 ? "aren't" : "isn't"} listed by name in the agent's scope`;
  if (req.targets.some((t) => t.tagsUnread)) return "a target's tags couldn't be read";
  // §9.7 "autoscaler conflicts": the count an agent sets would be fought (or silently undone) by the scaling policy.
  if (req.targets.some((t) => t.autoscaled) && AUTOSCALER_OPS.includes(req.op))
    return "Application Auto Scaling manages this service and would set the count back — a person decides";
  // §9.7 "rollback incompatibility": rolling code back doesn't roll a database back; only a person acknowledges it.
  const migrations = [req.migrations, ...req.targets.map((t) => t.migrations)];
  if (migrations.some((m) => m === true || m === "unknown"))
    return "database migrations changed (or couldn't be checked) between these revisions — a person decides";
  return undefined;
}

// Operations that set an ECS service's desired count, which Application Auto Scaling also sets.
export const AUTOSCALER_OPS: readonly string[] = ["services.scale", "services.start"];

function limitReason(policy: AgentPolicy, req: PolicyRequest): string | undefined {
  const l = policy.limits;
  const c = req.counters;
  if (c.toolCalls >= l.toolCalls) return `the run's tool call limit (${l.toolCalls}) is reached`;
  if (c.turns > l.modelTurns) return `the run's model turn limit (${l.modelTurns}) is reached`;
  if (c.elapsedMs > l.runtimeSeconds * 1000) return `the run's time limit (${l.runtimeSeconds} s) is reached`;
  if (req.risk === "read") return undefined;
  if (c.activeMutations >= l.concurrentMutations) return `the run already has ${c.activeMutations} change(s) in flight (limit ${l.concurrentMutations})`;
  for (const t of req.targets)
    for (const k of namesOf(t))
      if ((c.mutationsLastHourByKey[k] ?? 0) >= l.mutationsPerResourcePerHour) return `hourly mutation limit for ${t.key} reached (${l.mutationsPerResourcePerHour} per hour)`;
  return undefined;
}

// ---------- hash, narrowing, validation ----------

// planHash-style: sha256 over canonical JSON, so key order never changes it.
export const policyHash = (p: AgentPolicy): string => `sha256:${createHash("sha256").update(canonicalJson({ v: 1, policy: p })).digest("hex")}`;

const RANK: Record<AgentMode, number> = { observe: 0, propose: 1, "bounded-act": 2 };

// Every pattern the child may use must be covered by one of the parent's ("*" covers all, "area.*" covers its area).
const covers = (p: string, c: string) => p === "*" || p === c || (c !== "*" && !c.endsWith(".*") && toolMatches(p, c));
const coveredBy = (parent: readonly string[], child: readonly string[]) => child.every((c) => parent.some((p) => covers(p, c)));

const subset = <T>(parent: readonly T[] | undefined, child: readonly T[] | undefined): boolean =>
  !nonEmpty(parent) || (nonEmpty(child) && child.every((x) => parent.includes(x)));

export class PolicyError extends Error {
  status = 400;
  constructor(message: string) {
    super(message);
    this.name = "PolicyError";
  }
}

// A child run (or a workflow inside an agent's scope) may only narrow: its tools, scope and limits must fit inside the
// parent's, its mode can't be more autonomous, and the parent's denials carry over. A broader child throws.
export function narrow(parent: AgentPolicy, child: AgentPolicy): AgentPolicy {
  const problems: string[] = [];
  if (RANK[child.mode] > RANK[parent.mode]) problems.push(`mode ${child.mode} is broader than the parent's ${parent.mode}`);
  for (const list of ["read", "propose", "act"] as const)
    if (!coveredBy(parent.tools[list], child.tools[list])) problems.push(`tools.${list} reaches beyond the parent's`);
  const ps = parent.scope, cs = child.scope;
  if (ps.account && cs.account !== ps.account) problems.push("scope.account differs from the parent's");
  for (const f of ["regions", "envs", "keys", "kinds"] as const) if (!subset(ps[f], cs[f])) problems.push(`scope.${f} reaches beyond the parent's`);
  for (const [k, v] of Object.entries(ps.tags ?? {})) if (cs.tags?.[k] !== v) problems.push(`scope.tags must keep ${k}=${v}`);
  if (ps.excludeProtected && !cs.excludeProtected) problems.push("scope.excludeProtected must stay on");
  for (const f of ["runtimeSeconds", "modelTurns", "toolCalls", "concurrentMutations", "mutationsPerResourcePerHour"] as const)
    if (child.limits[f] > parent.limits[f]) problems.push(`limits.${f} is above the parent's`);
  for (const f of ["maxOutputTokens", "costUsd"] as const)
    if (parent.limits[f] !== undefined && (child.limits[f] === undefined || child.limits[f]! > parent.limits[f]!)) problems.push(`limits.${f} is above the parent's`);
  if (child.evidence.maximumAgeSeconds > parent.evidence.maximumAgeSeconds) problems.push("evidence.maximumAgeSeconds is above the parent's");
  if (parent.evidence.requireCompleteSecurityMetadata && !child.evidence.requireCompleteSecurityMetadata) problems.push("evidence.requireCompleteSecurityMetadata must stay on");
  if (child.approval.expireAfterSeconds > parent.approval.expireAfterSeconds) problems.push("approval.expireAfterSeconds is above the parent's");
  if (parent.approval.invalidateOnResourceChange && !child.approval.invalidateOnResourceChange) problems.push("approval.invalidateOnResourceChange must stay on");
  if (parent.data.logs === "none" && child.data.logs !== "none") problems.push("data.logs is broader than the parent's");
  if (problems.length) throw new PolicyError(`the child policy is broader than its parent: ${problems.join("; ")}`);
  return { ...child, tools: { ...child.tools, deny: [...new Set([...parent.tools.deny, ...child.tools.deny])] } };
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const strList = (v: unknown, max = 200): v is string[] => Array.isArray(v) && v.length <= max && v.every((x) => typeof x === "string" && x.length > 0 && x.length <= 2048);
const own = (o: Record<string, unknown>, k: string) => (Object.hasOwn(o, k) ? o[k] : undefined);
const num = (v: unknown, min: number, max: number) => typeof v === "number" && Number.isFinite(v) && v >= min && v <= max;
const TOOL = /^(\*|[a-z][a-z0-9]*\.(\*|[a-z][a-zA-Z0-9]*))$/;

// Validates a stored or submitted policy (own properties only, unknown fields refused). Returns the problems.
export function policyProblems(v: unknown): string[] {
  const p: string[] = [];
  if (!isObj(v)) return ["policy must be an object"];
  const allowed = ["version", "mode", "scope", "tools", "limits", "evidence", "approval", "data", "billing"];
  for (const k of Object.keys(v)) if (!allowed.includes(k)) p.push(`unknown field ${k}`);
  if (!num(own(v, "version"), 1, 1_000_000) || !Number.isInteger(own(v, "version"))) p.push("version must be a positive integer");
  if (!AGENT_MODES.includes(own(v, "mode") as AgentMode)) p.push(`mode must be ${AGENT_MODES.join(", ")}`);
  const scope = own(v, "scope");
  if (!isObj(scope)) p.push("scope must be an object");
  else {
    for (const k of Object.keys(scope)) if (!["account", "regions", "envs", "keys", "kinds", "tags", "excludeProtected"].includes(k)) p.push(`unknown field scope.${k}`);
    const account = own(scope, "account");
    if (account !== undefined && !(typeof account === "string" && /^\d{12}$/.test(account))) p.push("scope.account must be a 12-digit account id");
    for (const f of ["regions", "envs", "keys", "kinds"]) if (own(scope, f) !== undefined && !strList(own(scope, f))) p.push(`scope.${f} must be a list of names`);
    const tags = own(scope, "tags");
    if (tags !== undefined && !(isObj(tags) && Object.values(tags).every((x) => typeof x === "string"))) p.push("scope.tags must map tag names to values");
    const ex = own(scope, "excludeProtected");
    if (ex !== undefined && typeof ex !== "boolean") p.push("scope.excludeProtected must be a boolean");
  }
  const tools = own(v, "tools");
  if (!isObj(tools)) p.push("tools must be an object");
  else
    for (const f of ["read", "propose", "act", "deny"]) {
      const l = own(tools, f);
      if (!strList(l) || !l.every((t) => TOOL.test(t))) p.push(`tools.${f} must be a list of operation names, "<area>.*" or "*"`);
    }
  const limits = own(v, "limits");
  if (!isObj(limits)) p.push("limits must be an object");
  else {
    // A limit is a ceiling, never "unlimited": 0 model turns is a workflow without a model, 0 hourly mutations an agent
    // that never changes anything; run time, tool calls and concurrency need at least 1.
    for (const f of ["runtimeSeconds", "toolCalls", "concurrentMutations"]) if (!num(own(limits, f), 1, 1_000_000)) p.push(`limits.${f} must be a number ≥ 1`);
    for (const f of ["modelTurns", "mutationsPerResourcePerHour"]) if (!num(own(limits, f), 0, 1_000_000)) p.push(`limits.${f} must be a number ≥ 0`);
    for (const f of ["maxOutputTokens", "costUsd"]) if (own(limits, f) !== undefined && !num(own(limits, f), 0, 10_000_000)) p.push(`limits.${f} must be a number ≥ 0`);
  }
  const ev = own(v, "evidence");
  if (!isObj(ev) || !num(own(ev, "maximumAgeSeconds"), 0, 86_400 * 30) || typeof own(ev, "requireCompleteSecurityMetadata") !== "boolean")
    p.push("evidence must be { maximumAgeSeconds, requireCompleteSecurityMetadata }");
  const ap = own(v, "approval");
  if (!isObj(ap) || own(ap, "bindPlanHash") !== true || !num(own(ap, "expireAfterSeconds"), 60, 86_400) || typeof own(ap, "invalidateOnResourceChange") !== "boolean")
    p.push("approval must be { bindPlanHash: true, expireAfterSeconds (60–86400), invalidateOnResourceChange }");
  const data = own(v, "data");
  if (!isObj(data) || !["redacted-and-bounded", "none"].includes(own(data, "logs") as string) || own(data, "secretValues") !== "forbidden")
    p.push('data must be { logs: "redacted-and-bounded" | "none", secretValues: "forbidden" }');
  const billing = own(v, "billing");
  if (!isObj(billing) || typeof own(billing, "connection") !== "string" || own(billing, "fallback") !== "none") p.push('billing must be { connection, fallback: "none" }');
  return p;
}

export function parsePolicy(v: unknown): AgentPolicy {
  const p = policyProblems(v);
  if (p.length) throw new PolicyError(`invalid policy: ${p.join("; ")}`);
  return v as AgentPolicy;
}

// ---------- the six templates' policies (C7's templates and C8's forms reference them by name) ----------

const READS = [
  "envs.list", "envs.status", "services.get", "services.events", "services.revisions", "logs.recent", "logs.search", "metrics.get", "ci.runs",
  "audit.recent", "issues.list", "releases.compare", "cloud.map", "cloud.get", "cloud.actions", "notes.list", "notes.search", "approvals.list", "approvals.get",
  "operations.get", "operations.list", "runs.get",
];
const base = (o: Partial<AgentPolicy> & Pick<AgentPolicy, "mode" | "tools">): AgentPolicy => ({
  version: 1,
  scope: {},
  limits: { runtimeSeconds: 600, modelTurns: 12, toolCalls: 40, concurrentMutations: 1, mutationsPerResourcePerHour: 1, maxOutputTokens: 8_192 },
  evidence: { maximumAgeSeconds: 300, requireCompleteSecurityMetadata: true },
  approval: { bindPlanHash: true, expireAfterSeconds: 900, invalidateOnResourceChange: true },
  data: { logs: "redacted-and-bounded", secretValues: "forbidden" },
  billing: { connection: "", fallback: "none" },
  ...o,
});
const NEVER = ["variables.update", "tasks.run", "hosts.terminate", "services.delete", "services.clone", "hosts.add"];

export type TemplateName = "incident-investigator" | "approved-remediation" | "nonproduction-schedule" | "daily-digest" | "cost-review" | "config-drift";

export const DEFAULT_POLICIES: Readonly<Record<TemplateName, AgentPolicy>> = {
  // Investigate a degraded service and propose one typed action; nothing runs without a person.
  "incident-investigator": base({ mode: "propose", tools: { read: READS, propose: ["services.restart", "services.switch", "services.scale"], act: [], deny: NEVER } }),
  // Investigate, propose one restart / scale / rollback, run it under an exact grant, verify, escalate.
  "approved-remediation": base({
    mode: "propose",
    tools: { read: READS, propose: ["services.restart", "services.scale", "services.switch"], act: [], deny: NEVER },
    limits: { runtimeSeconds: 1_800, modelTurns: 16, toolCalls: 60, concurrentMutations: 1, mutationsPerResourcePerHour: 1, maxOutputTokens: 8_192 },
  }),
  // Deterministic stop/start of explicitly listed non-production services (bounded-act only for those keys).
  "nonproduction-schedule": base({
    mode: "bounded-act",
    scope: { excludeProtected: true },
    tools: { read: ["envs.list", "envs.status", "services.get"], propose: [], act: ["services.stop", "services.start"], deny: NEVER },
    limits: { runtimeSeconds: 900, modelTurns: 0, toolCalls: 200, concurrentMutations: 1, mutationsPerResourcePerHour: 2 },
  }),
  // Gather changes, failures, costs and pending approvals; report. Reads only.
  "daily-digest": base({ mode: "observe", tools: { read: [...READS, "costs.summary"], propose: [], act: [], deny: NEVER } }),
  // Spend and idle resources with evidence completeness; explanations, never deletion.
  "cost-review": base({ mode: "observe", tools: { read: [...READS, "costs.summary", "costs.estimate"], propose: [], act: [], deny: [...NEVER, "cloud.action"] } }),
  // Compare variable names, references and fingerprint equality across environments; fixes are human tasks.
  "config-drift": base({ mode: "observe", tools: { read: [...READS, "variables.list", "variables.compare"], propose: [], act: [], deny: NEVER } }),
};

export const isTemplateName = (v: unknown): v is TemplateName => typeof v === "string" && Object.hasOwn(DEFAULT_POLICIES, v);
