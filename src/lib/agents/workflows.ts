// Versioned workflows (master plan §6 C7 item 1, AGENT_ARCHITECTURE §7): a typed sequence of steps with conditional
// gates, typed inputs, triggers, an explicit target selector, a policy, limits and a billing source. Pure: the server
// (src/lib/server/agents/workflows.ts) stores versions, previews and publishes them, and steps.ts runs them.
//
// A workflow runs its steps in order, one at a time, as durable agent steps of one run (kind "workflow"):
//   tool       an operation with fixed or templated input — a read becomes a `tool` step, a change an `execute` step
//              (always through invoke() as the run's agent principal, so the policy decides: run, ask a person, refuse);
//   model      a goal for a model, run by the agent runner as a child run (needs a connection; it pays);
//   approval   a person's go-ahead before what follows (PATCH /api/agents/workflows/[id] { action: "review" });
//   wait       a pause; condition  a named yes/no over earlier results; verify  a read polled until `expect` holds;
//   notify     a report to the run's result, or to the integrations that subscribe to finished agent runs.
// Any step can carry `when` (it is skipped when false) and `forEach: "targets"` (once per resolved target).
//
// Expressions (`when`, `condition`, `verify.expect`) are a small safe language, never eval: literals ('text', 12,
// true, false, null), paths over earlier results (steps.<id>.result.desired, steps.<id>.state, inputs.<name>,
// target.service, trigger.resourceKey, result.<field> inside verify), == != < <= > >=, and / or / not (&& || !),
// parentheses and len(). Paths read own properties only. Templates in inputs are "{{ path }}": a string that is only
// a template takes the value as is (a number stays a number), anything else is interpolated.
//
// Natural language may draft a workflow, but activation (publishing) needs the preview: trigger, resolved targets,
// steps, limits, approvals, destination and the billing source, bound by a preview hash. Published versions are
// immutable (`workflowHash`).
import { createHash } from "node:crypto";
import { canonicalJson } from "../plan-hash.ts";
import type { Perm } from "../rbac.ts";
import type { Risk } from "../server/ops/types.ts";
import { cronProblems, nextFires } from "./cron.ts";
import { hardDenyReason, listed, policyProblems } from "./policy.ts";
import type { AgentPolicy } from "./types.ts";

export const WORKFLOW_FORMAT = 1;
export const MAX_STEPS = 40;
export const MAX_TRIGGERS = 8;
export const MAX_TARGETS = 50;

// ---------- types ----------

export type InputType = "string" | "number" | "boolean" | "list";
export type InputValue = string | number | boolean | string[];
export interface WorkflowInput {
  name: string;
  type: InputType;
  title?: string;
  description?: string;
  required?: boolean;
  default?: InputValue;
  enum?: string[];
}

// A state event: a resource the sampler watches (service, host, database, …) enters one of `states` (default DOWN or
// DEGRADED). An alarm event: a CloudWatch alarm on the cloud map goes into ALARM. Selectors narrow by environment,
// kind and key; an event trigger must name environments or keys.
export interface EventSelector {
  envs?: string[];
  kinds?: string[];
  keys?: string[];
  states?: string[];
}
export type WorkflowTrigger =
  | { type: "manual"; inputs?: Record<string, InputValue> }
  | { type: "schedule"; cron: string; tz: string; inputs?: Record<string, InputValue> }
  | { type: "event"; source: "state" | "alarm"; selector: EventSelector; inputs?: Record<string, InputValue> };

// The ECS services a workflow acts on, chosen explicitly: environments (required), optionally service names and tags.
// Resolved and previewed when it is published (the keys are frozen into the version, and its bounded-act scope) and
// again at every run: a service that matches now but wasn't previewed pauses the run for a person's review.
export interface TargetSelector {
  envs: string[];
  services?: string[];
  tags?: Record<string, string>;
}
export interface Target {
  key: string; // canonical coordinator key: ecs-service:<region>/<cluster>/<service>
  env: string;
  service: string;
  region?: string;
}

export const REPORT_KINDS = ["text", "digest", "cost-review", "config-drift", "remediation"] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];

interface NodeBase {
  id: string;
  title?: string;
  when?: string;
  forEach?: "targets";
}
export interface ToolNode extends NodeBase {
  kind: "tool";
  op: string;
  input: Record<string, unknown>;
  optional?: boolean; // a failure is recorded and the workflow goes on (a digest without costs is still a digest)
}
export interface ModelNode extends NodeBase {
  kind: "model";
  goal: string;
  resource?: string; // templated resource key the model investigates (trigger.resourceKey)
}
export interface ApprovalNode extends NodeBase {
  kind: "approval";
  message: string;
}
export interface WaitNode extends NodeBase {
  kind: "wait";
  seconds: number;
}
export interface ConditionNode extends NodeBase {
  kind: "condition";
  expr: string;
}
export interface VerifyNode extends NodeBase {
  kind: "verify";
  op: string;
  input: Record<string, unknown>;
  expect: string;
  timeoutSeconds: number;
  intervalSeconds?: number;
  optional?: boolean; // a check that doesn't hold is recorded (ok: false) and the workflow goes on — the run still fails at its end
}
export interface NotifyNode extends NodeBase {
  kind: "notify";
  to: "run" | "integrations";
  report?: ReportKind;
  message?: string;
}
export type WorkflowNode = ToolNode | ModelNode | ApprovalNode | WaitNode | ConditionNode | VerifyNode | NotifyNode;
export const NODE_KINDS = ["tool", "model", "approval", "wait", "condition", "verify", "notify"] as const;

export interface WorkflowLimits {
  maxConcurrentRuns: number; // runs of this workflow going on at once (a trigger beyond it is skipped)
  cooldownSeconds: number; // per resource: no new run for the same resource this soon after the last one
  maxAttempts: number; // per resource within attemptWindowSeconds; then the trigger escalates instead of running
  attemptWindowSeconds: number;
}
export const DEFAULT_LIMITS: WorkflowLimits = { maxConcurrentRuns: 1, cooldownSeconds: 0, maxAttempts: 24, attemptWindowSeconds: 86_400 };

export interface WorkflowDraft {
  format: 1;
  name: string;
  description?: string;
  template?: string;
  inputs: WorkflowInput[];
  triggers: WorkflowTrigger[];
  targets?: TargetSelector;
  steps: WorkflowNode[];
  policy: AgentPolicy;
  limits: WorkflowLimits;
  connectionId?: string; // pays for model steps; "" or absent = a deterministic workflow
}

// What the operation registry says about an operation (the server passes its catalog in).
export type OpCatalog = (op: string) => { risk: Risk; perm: Perm } | undefined;

// ---------- expressions ----------

export class ExprError extends Error {
  status = 400;
  constructor(message: string) {
    super(message);
    this.name = "ExprError";
  }
}

export type Expr =
  | { t: "lit"; v: string | number | boolean | null }
  | { t: "path"; p: (string | number)[] }
  | { t: "not"; e: Expr }
  | { t: "and" | "or"; a: Expr; b: Expr }
  | { t: "cmp"; op: "==" | "!=" | "<" | "<=" | ">" | ">="; a: Expr; b: Expr }
  | { t: "len"; e: Expr };

type Tok = { k: "num"; v: number } | { k: "str"; v: string } | { k: "id"; v: string } | { k: "op"; v: string };

const FORBIDDEN_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);
const MAX_EXPR = 500;

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (["==", "!=", "<=", ">=", "&&", "||"].includes(two)) {
      out.push({ k: "op", v: two });
      i += 2;
      continue;
    }
    if ("<>()!,.[]".includes(c)) {
      out.push({ k: "op", v: c });
      i++;
      continue;
    }
    if (c === "'" || c === '"') {
      let j = i + 1;
      let s = "";
      while (j < src.length && src[j] !== c) {
        if (src[j] === "\\" && j + 1 < src.length) j++;
        s += src[j++];
      }
      if (j >= src.length) throw new ExprError("unterminated string");
      out.push({ k: "str", v: s });
      i = j + 1;
      continue;
    }
    const num = /^-?\d+(\.\d+)?/.exec(src.slice(i));
    if (num && (c !== "-" || !out.length || out[out.length - 1].k === "op")) {
      out.push({ k: "num", v: Number(num[0]) });
      i += num[0].length;
      continue;
    }
    const id = /^[A-Za-z_][A-Za-z0-9_-]*/.exec(src.slice(i));
    if (id) {
      out.push({ k: "id", v: id[0] });
      i += id[0].length;
      continue;
    }
    throw new ExprError(`unexpected "${c}"`);
  }
  return out;
}

export function parseExpr(src: unknown): Expr {
  if (typeof src !== "string" || !src.trim()) throw new ExprError("an expression is required");
  if (src.length > MAX_EXPR) throw new ExprError(`an expression is at most ${MAX_EXPR} characters`);
  const toks = tokenize(src);
  let pos = 0;
  let depth = 0;
  const peek = () => toks[pos];
  const isOp = (v: string) => peek()?.k === "op" && peek()!.v === v;
  const isWord = (v: string) => peek()?.k === "id" && peek()!.v === v;
  const expect = (v: string) => {
    if (!isOp(v)) throw new ExprError(`expected "${v}"`);
    pos++;
  };
  const deeper = <T>(f: () => T): T => {
    if (++depth > 20) throw new ExprError("the expression is nested too deeply");
    try {
      return f();
    } finally {
      depth--;
    }
  };
  const or = (): Expr =>
    deeper(() => {
      let a = and();
      while (isOp("||") || isWord("or")) {
        pos++;
        a = { t: "or", a, b: and() };
      }
      return a;
    });
  const and = (): Expr => {
    let a = not();
    while (isOp("&&") || isWord("and")) {
      pos++;
      a = { t: "and", a, b: not() };
    }
    return a;
  };
  const not = (): Expr => {
    if (isOp("!") || isWord("not")) {
      pos++;
      return deeper(() => ({ t: "not", e: not() }));
    }
    return cmp();
  };
  const cmp = (): Expr => {
    const a = primary();
    const t = peek();
    if (t?.k === "op" && ["==", "!=", "<", "<=", ">", ">="].includes(t.v)) {
      pos++;
      return { t: "cmp", op: t.v as "==", a, b: primary() };
    }
    return a;
  };
  const primary = (): Expr => {
    const t = peek();
    if (!t) throw new ExprError("the expression ends too early");
    if (t.k === "num" || t.k === "str") {
      pos++;
      return { t: "lit", v: t.v };
    }
    if (isOp("(")) {
      pos++;
      const e = or();
      expect(")");
      return e;
    }
    if (t.k === "id") {
      if (t.v === "true" || t.v === "false") {
        pos++;
        return { t: "lit", v: t.v === "true" };
      }
      if (t.v === "null") {
        pos++;
        return { t: "lit", v: null };
      }
      if (t.v === "len" && toks[pos + 1]?.k === "op" && toks[pos + 1].v === "(") {
        pos += 2;
        const e = or();
        expect(")");
        return { t: "len", e };
      }
      return path();
    }
    throw new ExprError(`unexpected "${t.v}"`);
  };
  const path = (): Expr => {
    const p: (string | number)[] = [];
    const seg = (v: string) => {
      if (FORBIDDEN_SEGMENTS.has(v)) throw new ExprError(`"${v}" can't be read`);
      p.push(v);
    };
    seg((toks[pos++] as { v: string }).v);
    for (;;) {
      if (isOp(".")) {
        pos++;
        const t = peek();
        if (t?.k !== "id" && t?.k !== "num") throw new ExprError("a name is expected after \".\"");
        pos++;
        if (t.k === "num") {
          if (!Number.isInteger(t.v) || t.v < 0) throw new ExprError("an index is a whole number");
          p.push(t.v);
        } else seg(t.v);
      } else if (isOp("[")) {
        pos++;
        const t = peek();
        if (t?.k !== "num" || !Number.isInteger(t.v) || t.v < 0) throw new ExprError("an index is a whole number");
        pos++;
        p.push(t.v);
        expect("]");
      } else break;
    }
    if (p.length > 12) throw new ExprError("the path is too long");
    return { t: "path", p };
  };
  const e = or();
  if (pos < toks.length) throw new ExprError(`unexpected "${String((toks[pos] as { v: unknown }).v)}"`);
  return e;
}

// Own properties only: no prototype, no getters of built-ins.
export function lookup(ctx: unknown, p: readonly (string | number)[]): unknown {
  let cur: unknown = ctx;
  for (const seg of p) {
    if (cur === null || cur === undefined) return undefined;
    if (Array.isArray(cur)) {
      if (typeof seg === "number") cur = cur[seg];
      else if (seg === "length") cur = cur.length;
      else return undefined;
    } else if (typeof cur === "object") {
      const k = String(seg);
      if (FORBIDDEN_SEGMENTS.has(k) || !Object.hasOwn(cur, k)) return undefined;
      cur = (cur as Record<string, unknown>)[k];
    } else return undefined;
  }
  return cur;
}

export const truthy = (v: unknown) => !(v === undefined || v === null || v === false || v === 0 || v === "" || (typeof v === "number" && Number.isNaN(v)));

function compare(op: string, a: unknown, b: unknown): boolean {
  if (op === "==") return a === b || (a == null && b == null);
  if (op === "!=") return !(a === b || (a == null && b == null));
  const same = (typeof a === "number" && typeof b === "number") || (typeof a === "string" && typeof b === "string");
  if (!same) return false;
  const x = a as number;
  const y = b as number;
  return op === "<" ? x < y : op === "<=" ? x <= y : op === ">" ? x > y : x >= y;
}

export function evalExpr(e: Expr, ctx: unknown): unknown {
  switch (e.t) {
    case "lit":
      return e.v;
    case "path":
      return lookup(ctx, e.p);
    case "not":
      return !truthy(evalExpr(e.e, ctx));
    case "and":
      return truthy(evalExpr(e.a, ctx)) && truthy(evalExpr(e.b, ctx));
    case "or":
      return truthy(evalExpr(e.a, ctx)) || truthy(evalExpr(e.b, ctx));
    case "cmp":
      return compare(e.op, evalExpr(e.a, ctx), evalExpr(e.b, ctx));
    case "len": {
      const v = evalExpr(e.e, ctx);
      if (Array.isArray(v) || typeof v === "string") return v.length;
      if (v && typeof v === "object") return Object.keys(v).length;
      return 0;
    }
  }
}

export const holds = (src: string, ctx: unknown) => truthy(evalExpr(parseExpr(src), ctx));

export function pathsOf(e: Expr, out: (string | number)[][] = []): (string | number)[][] {
  if (e.t === "path") out.push(e.p);
  else if (e.t === "not" || e.t === "len") pathsOf(e.e, out);
  else if (e.t === "and" || e.t === "or" || e.t === "cmp") {
    pathsOf(e.a, out);
    pathsOf(e.b, out);
  }
  return out;
}

// ---------- templates ----------

const TEMPLATE = /\{\{\s*([^{}]+?)\s*\}\}/g;
const WHOLE = /^\{\{\s*([^{}]+?)\s*\}\}$/;

function templatePath(src: string): (string | number)[] {
  const e = parseExpr(src);
  if (e.t !== "path") throw new ExprError(`"{{ ${src} }}" must name a value (a path), not compute one`);
  return e.p;
}

export class TemplateError extends Error {
  status = 400;
}

// Renders "{{ path }}" templates inside a value. A missing value is an error (a call with a hole in it never runs).
export function render(v: unknown, ctx: unknown, depth = 0): unknown {
  if (depth > 10) throw new TemplateError("the input is nested too deeply");
  if (typeof v === "string") {
    const whole = WHOLE.exec(v);
    if (whole) {
      const out = lookup(ctx, templatePath(whole[1]));
      if (out === undefined) throw new TemplateError(`"${v}" has no value here`);
      return out;
    }
    return v.replace(TEMPLATE, (_, src: string) => {
      const out = lookup(ctx, templatePath(src));
      if (out === undefined) throw new TemplateError(`"{{${src}}}" has no value here`);
      return typeof out === "string" ? out : JSON.stringify(out);
    });
  }
  if (Array.isArray(v)) return v.map((x) => render(x, ctx, depth + 1));
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = render(x, ctx, depth + 1);
    return out;
  }
  return v;
}

export function templatePaths(v: unknown, out: (string | number)[][] = [], depth = 0): (string | number)[][] {
  if (depth > 10) throw new TemplateError("the input is nested too deeply");
  if (typeof v === "string") for (const m of v.matchAll(TEMPLATE)) out.push(templatePath(m[1]));
  else if (Array.isArray(v)) for (const x of v) templatePaths(x, out, depth + 1);
  else if (v && typeof v === "object") for (const x of Object.values(v)) templatePaths(x, out, depth + 1);
  return out;
}

// ---------- inputs ----------

const NAME = /^[a-z][a-zA-Z0-9_]{0,40}$/;

export function resolveInputs(defs: WorkflowInput[], given: unknown): { values: Record<string, InputValue>; problems: string[] } {
  const problems: string[] = [];
  const values: Record<string, InputValue> = {};
  const g = given === undefined || given === null ? {} : given;
  if (typeof g !== "object" || Array.isArray(g)) return { values, problems: ["inputs must be an object"] };
  for (const k of Object.keys(g)) if (!defs.some((d) => d.name === k)) problems.push(`unknown input ${k}`);
  for (const d of defs) {
    const v = Object.hasOwn(g, d.name) ? (g as Record<string, unknown>)[d.name] : d.default;
    if (v === undefined) {
      if (d.required) problems.push(`input ${d.name} is required`);
      continue;
    }
    const p = inputProblem(d, v);
    if (p) problems.push(p);
    else values[d.name] = v as InputValue;
  }
  return { values, problems };
}

function inputProblem(d: WorkflowInput, v: unknown): string | undefined {
  if (d.type === "string") {
    if (typeof v !== "string" || v.length > 500) return `input ${d.name} must be text (≤ 500 characters)`;
    if (d.enum && !d.enum.includes(v)) return `input ${d.name} must be one of ${d.enum.join(", ")}`;
  } else if (d.type === "number") {
    if (typeof v !== "number" || !Number.isFinite(v)) return `input ${d.name} must be a number`;
  } else if (d.type === "boolean") {
    if (typeof v !== "boolean") return `input ${d.name} must be true or false`;
  } else if (!Array.isArray(v) || v.length > 50 || !v.every((x) => typeof x === "string" && x.length > 0 && x.length <= 200)) return `input ${d.name} must be a list of names`;
  else if (d.enum && !v.every((x) => d.enum!.includes(x))) return `input ${d.name} may only hold ${d.enum.join(", ")}`;
  return undefined;
}

// ---------- targets ----------

// A service the server found in one of the selector's environments, with what the exclusions need.
export interface TargetCandidate extends Target {
  envProtected: boolean;
  protected: boolean; // the environment, or a console:protected tag
  self: boolean | "unknown"; // the console's own service (unknown → excluded: never act on what may be the console)
  tags: Record<string, string> | null; // null: unread
  autoscaled?: boolean; // Application Auto Scaling manages its count (a stop would be fought)
}

export const isSharedTagged = (tags: Record<string, string> | null) => /^(true|1|yes)$/i.test(tags?.["console:shared"] ?? "");

// Which candidates the selector picks, and why the others it named were left out. Never protected, shared (tagged
// console:shared), autoscaled or console resources.
export function selectTargets(sel: TargetSelector, cands: TargetCandidate[]): { targets: Target[]; excluded: { key: string; env: string; service: string; why: string }[] } {
  const targets: Target[] = [];
  const excluded: { key: string; env: string; service: string; why: string }[] = [];
  for (const c of [...cands].sort((a, b) => a.key.localeCompare(b.key))) {
    if (!sel.envs.includes(c.env)) continue;
    if (sel.services?.length && !sel.services.includes(c.service)) continue;
    const out = (why: string) => excluded.push({ key: c.key, env: c.env, service: c.service, why });
    if (sel.tags && Object.keys(sel.tags).length) {
      if (!c.tags) {
        out("its tags couldn't be read, so the tag selector can't be checked");
        continue;
      }
      if (Object.entries(sel.tags).some(([k, v]) => c.tags![k] !== v)) continue;
    }
    if (c.envProtected) out("its environment is protected");
    else if (c.protected) out("it is tagged console:protected");
    else if (c.self === true) out("it is the console's own service");
    else if (c.self === "unknown") out("whether it is the console's own service couldn't be read");
    else if (isSharedTagged(c.tags)) out("it is tagged console:shared");
    else if (c.autoscaled) out("Application Auto Scaling manages its task count");
    else if (c.tags === null) out("its tags couldn't be read");
    else targets.push({ key: c.key, env: c.env, service: c.service, ...(c.region ? { region: c.region } : {}) });
  }
  if (targets.length > MAX_TARGETS) {
    for (const t of targets.splice(MAX_TARGETS)) excluded.push({ ...t, why: `more than ${MAX_TARGETS} targets` });
  }
  return { targets, excluded };
}

// What changed since the targets were previewed: additions pause a run for review; removals are just left alone.
export function compareTargets(published: readonly string[], now: readonly Target[]): { additions: Target[]; removals: string[] } {
  const keys = new Set(now.map((t) => t.key));
  return { additions: now.filter((t) => !published.includes(t.key)), removals: published.filter((k) => !keys.has(k)) };
}

// ---------- validation ----------

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const own = (o: Record<string, unknown>, k: string) => (Object.hasOwn(o, k) ? o[k] : undefined);
const strList = (v: unknown, max: number, len = 200): v is string[] => Array.isArray(v) && v.length <= max && v.every((x) => typeof x === "string" && x.length > 0 && x.length <= len);
const str = (v: unknown, max: number): v is string => typeof v === "string" && v.trim().length > 0 && v.length <= max;
const unknownKeys = (o: Record<string, unknown>, allowed: string[], where: string) => Object.keys(o).filter((k) => !allowed.includes(k)).map((k) => `${where}: unknown field ${k}`);
const STEP_ID = /^[a-z][a-z0-9-]{0,40}$/;
const ROOTS = ["inputs", "trigger", "targets", "target", "steps"];

const NODE_FIELDS: Record<WorkflowNode["kind"], string[]> = {
  tool: ["op", "input", "optional"],
  model: ["goal", "resource"],
  approval: ["message"],
  wait: ["seconds"],
  condition: ["expr"],
  verify: ["op", "input", "expect", "timeoutSeconds", "intervalSeconds", "optional"],
  notify: ["to", "report", "message"],
};

function checkPaths(paths: (string | number)[][], earlier: Set<string>, where: string, extraRoots: string[] = []): string[] {
  const p: string[] = [];
  for (const path of paths) {
    const root = String(path[0]);
    if (![...ROOTS, ...extraRoots].includes(root)) p.push(`${where}: "${path.join(".")}" — values come from ${[...ROOTS, ...extraRoots].join(", ")}`);
    else if (root === "steps" && !earlier.has(String(path[1] ?? ""))) p.push(`${where}: "${path.join(".")}" doesn't name an earlier step`);
  }
  return p;
}

function exprProblems(src: unknown, earlier: Set<string>, where: string, extraRoots: string[] = []): string[] {
  try {
    return checkPaths(pathsOf(parseExpr(src)), earlier, where, extraRoots);
  } catch (e) {
    return [`${where}: ${(e as Error).message}`];
  }
}

function templateProblems(v: unknown, earlier: Set<string>, where: string): string[] {
  try {
    return checkPaths(templatePaths(v), earlier, where);
  } catch (e) {
    return [`${where}: ${(e as Error).message}`];
  }
}

function triggerProblems(t: unknown, i: number, inputs: WorkflowInput[], now: number): string[] {
  const where = `triggers[${i}]`;
  if (!isObj(t)) return [`${where} must be an object`];
  const type = own(t, "type");
  const p: string[] = [];
  const inputsOf = own(t, "inputs");
  if (inputsOf !== undefined) p.push(...resolveInputs(inputs, inputsOf).problems.map((x) => `${where}: ${x}`));
  if (type === "manual") return [...p, ...unknownKeys(t, ["type", "inputs"], where)];
  if (type === "schedule") {
    p.push(...unknownKeys(t, ["type", "cron", "tz", "inputs"], where));
    p.push(...cronProblems(own(t, "cron"), own(t, "tz"), now).map((x) => `${where}: ${x}`));
    return p;
  }
  if (type === "event") {
    p.push(...unknownKeys(t, ["type", "source", "selector", "inputs"], where));
    if (own(t, "source") !== "state" && own(t, "source") !== "alarm") p.push(`${where}: source must be "state" or "alarm"`);
    const sel = own(t, "selector");
    if (!isObj(sel)) return [...p, `${where}: selector must be an object`];
    p.push(...unknownKeys(sel, ["envs", "kinds", "keys", "states"], `${where}.selector`));
    for (const f of ["envs", "kinds", "keys", "states"]) if (own(sel, f) !== undefined && !strList(own(sel, f), 50, 2048)) p.push(`${where}.selector.${f} must be a list of names`);
    if (!(strList(own(sel, "envs"), 50) && (own(sel, "envs") as string[]).length) && !(strList(own(sel, "keys"), 50, 2048) && (own(sel, "keys") as string[]).length))
      p.push(`${where}: an event trigger must name environments or resource keys`);
    return p;
  }
  return [`${where}: type must be manual, schedule or event`];
}

function nodeProblems(n: unknown, i: number, d: { policy: AgentPolicy; catalog: OpCatalog; earlier: Set<string>; targets: boolean; connection: boolean }): string[] {
  const where = `steps[${i}]`;
  if (!isObj(n)) return [`${where} must be an object`];
  const kind = own(n, "kind") as WorkflowNode["kind"];
  if (!NODE_KINDS.includes(kind)) return [`${where}: kind must be ${NODE_KINDS.join(", ")}`];
  const id = own(n, "id");
  const at = typeof id === "string" ? `step ${id}` : where;
  const p = unknownKeys(n, ["id", "kind", "title", "when", "forEach", ...NODE_FIELDS[kind]], at);
  if (typeof id !== "string" || !STEP_ID.test(id)) p.push(`${where}: id must be lowercase letters, digits and dashes`);
  else if (d.earlier.has(id)) p.push(`${at}: the id is used twice`);
  if (own(n, "title") !== undefined && !str(own(n, "title"), 120)) p.push(`${at}: title must be text (≤ 120 characters)`);
  if (own(n, "when") !== undefined) p.push(...exprProblems(own(n, "when"), d.earlier, `${at}.when`));
  const fe = own(n, "forEach");
  if (fe !== undefined && fe !== "targets") p.push(`${at}: forEach can only be "targets"`);
  if (fe === "targets" && !d.targets) p.push(`${at}: forEach "targets" needs the workflow's targets`);
  const pol = d.policy;
  const opCheck = (readOnly: boolean) => {
    const op = own(n, "op");
    if (typeof op !== "string") return p.push(`${at}: op is required`);
    const meta = d.catalog(op);
    if (!meta) return p.push(`${at}: unknown operation ${op}`);
    const hard = hardDenyReason({ op, perm: meta.perm, risk: meta.risk, targets: [] });
    if (hard) return p.push(`${at}: ${op} — ${hard}`);
    if (listed(pol.tools.deny, op)) return p.push(`${at}: ${op} is denied by the workflow's policy`);
    if (meta.risk === "read") {
      if (!listed(pol.tools.read, op) && !listed(pol.tools.propose, op) && !listed(pol.tools.act, op)) p.push(`${at}: ${op} isn't one of the policy's tools`);
    } else if (readOnly) p.push(`${at}: verify steps only read (${op} changes something)`);
    else if (pol.mode === "observe") p.push(`${at}: ${op} changes something, and the policy only observes`);
    else if (!listed(pol.tools.propose, op) && !listed(pol.tools.act, op)) p.push(`${at}: ${op} isn't one of the changes the policy allows`);
    if (!isObj(own(n, "input"))) p.push(`${at}: input must be an object`);
    else p.push(...templateProblems(own(n, "input"), d.earlier, `${at}.input`));
  };
  switch (kind) {
    case "tool":
      opCheck(false);
      if (own(n, "optional") !== undefined && typeof own(n, "optional") !== "boolean") p.push(`${at}: optional must be true or false`);
      break;
    case "verify": {
      opCheck(true);
      if (own(n, "optional") !== undefined && typeof own(n, "optional") !== "boolean") p.push(`${at}: optional must be true or false`);
      p.push(...exprProblems(own(n, "expect"), d.earlier, `${at}.expect`, ["result"]));
      const to = own(n, "timeoutSeconds");
      if (typeof to !== "number" || !Number.isInteger(to) || to < 10 || to > 3_600) p.push(`${at}: timeoutSeconds must be 10–3600`);
      const iv = own(n, "intervalSeconds");
      if (iv !== undefined && (typeof iv !== "number" || !Number.isInteger(iv) || iv < 5 || iv > 600)) p.push(`${at}: intervalSeconds must be 5–600`);
      break;
    }
    case "model":
      if (!str(own(n, "goal"), 2_000)) p.push(`${at}: goal must be text (≤ 2000 characters)`);
      else p.push(...templateProblems(own(n, "goal"), d.earlier, `${at}.goal`));
      if (own(n, "resource") !== undefined) {
        if (typeof own(n, "resource") !== "string") p.push(`${at}: resource must be a templated resource key`);
        else p.push(...templateProblems(own(n, "resource"), d.earlier, `${at}.resource`));
      }
      if (!d.connection) p.push(`${at}: a model step needs a connection to pay for it`);
      if (pol.limits.modelTurns < 1) p.push(`${at}: the policy allows no model turns`);
      break;
    case "approval":
      if (!str(own(n, "message"), 500)) p.push(`${at}: message must be text (≤ 500 characters)`);
      break;
    case "wait": {
      const s = own(n, "seconds");
      if (typeof s !== "number" || !Number.isInteger(s) || s < 1 || s > 86_400) p.push(`${at}: seconds must be 1–86400`);
      break;
    }
    case "condition":
      p.push(...exprProblems(own(n, "expr"), d.earlier, `${at}.expr`));
      break;
    case "notify":
      if (own(n, "to") !== "run" && own(n, "to") !== "integrations") p.push(`${at}: to must be "run" or "integrations"`);
      if (own(n, "report") !== undefined && !REPORT_KINDS.includes(own(n, "report") as ReportKind)) p.push(`${at}: report must be ${REPORT_KINDS.join(", ")}`);
      if (own(n, "message") !== undefined) {
        if (!str(own(n, "message"), 2_000)) p.push(`${at}: message must be text (≤ 2000 characters)`);
        else p.push(...templateProblems(own(n, "message"), d.earlier, `${at}.message`));
      }
      if (own(n, "report") === undefined && own(n, "message") === undefined) p.push(`${at}: a notify step needs a report or a message`);
      break;
  }
  return p;
}

// Everything wrong with a workflow (empty: it can be previewed and published). Own properties only; unknown fields are
// refused. `catalog` is the operation registry's view of each operation.
export function validateWorkflow(v: unknown, catalog: OpCatalog, now = Date.now()): string[] {
  if (!isObj(v)) return ["a workflow must be an object"];
  const p = unknownKeys(v, ["format", "name", "description", "template", "inputs", "triggers", "targets", "steps", "policy", "limits", "connectionId"], "workflow");
  if (own(v, "format") !== WORKFLOW_FORMAT) p.push(`format must be ${WORKFLOW_FORMAT}`);
  if (!str(own(v, "name"), 100)) p.push("name must be text (≤ 100 characters)");
  if (own(v, "description") !== undefined && (typeof own(v, "description") !== "string" || String(own(v, "description")).length > 2_000)) p.push("description must be text (≤ 2000 characters)");
  if (own(v, "template") !== undefined && !str(own(v, "template"), 60)) p.push("template must be a template name");
  const conn = own(v, "connectionId");
  if (conn !== undefined && (typeof conn !== "string" || conn.length > 200)) p.push("connectionId must be a connection id");
  // Inputs.
  const inputs = own(v, "inputs");
  const defs: WorkflowInput[] = [];
  if (!Array.isArray(inputs) || inputs.length > 20) p.push("inputs must be a list (≤ 20)");
  else
    inputs.forEach((d, i) => {
      if (!isObj(d)) return void p.push(`inputs[${i}] must be an object`);
      p.push(...unknownKeys(d, ["name", "type", "title", "description", "required", "default", "enum"], `inputs[${i}]`));
      const name = own(d, "name");
      if (typeof name !== "string" || !NAME.test(name)) p.push(`inputs[${i}]: name must start with a letter (letters, digits, _)`);
      else if (defs.some((x) => x.name === name)) p.push(`inputs[${i}]: ${name} is declared twice`);
      if (!["string", "number", "boolean", "list"].includes(own(d, "type") as string)) p.push(`inputs[${i}]: type must be string, number, boolean or list`);
      if (own(d, "enum") !== undefined && !strList(own(d, "enum"), 50)) p.push(`inputs[${i}]: enum must be a list of values`);
      if (own(d, "required") !== undefined && typeof own(d, "required") !== "boolean") p.push(`inputs[${i}]: required must be true or false`);
      for (const f of ["title", "description"]) if (own(d, f) !== undefined && !str(own(d, f), 300)) p.push(`inputs[${i}]: ${f} must be text`);
      const def = d as unknown as WorkflowInput;
      if (own(d, "default") !== undefined && typeof name === "string") {
        const bad = inputProblem(def, own(d, "default"));
        if (bad) p.push(`inputs[${i}] default: ${bad}`);
      }
      defs.push(def);
    });
  // Policy.
  const policy = own(v, "policy");
  const pp = policyProblems(policy);
  p.push(...pp.map((x) => `policy: ${x}`));
  // Limits.
  const limits = own(v, "limits");
  if (!isObj(limits)) p.push("limits must be an object");
  else {
    p.push(...unknownKeys(limits, Object.keys(DEFAULT_LIMITS), "limits"));
    const range = (k: keyof WorkflowLimits, lo: number, hi: number) => {
      const x = own(limits, k);
      if (typeof x !== "number" || !Number.isInteger(x) || x < lo || x > hi) p.push(`limits.${k} must be ${lo}–${hi}`);
    };
    range("maxConcurrentRuns", 1, 20);
    range("cooldownSeconds", 0, 7 * 86_400);
    range("maxAttempts", 1, 1_000);
    range("attemptWindowSeconds", 60, 30 * 86_400);
  }
  // Targets.
  const targets = own(v, "targets");
  if (targets !== undefined) {
    if (!isObj(targets)) p.push("targets must be an object");
    else {
      p.push(...unknownKeys(targets, ["envs", "services", "tags"], "targets"));
      if (!strList(own(targets, "envs"), 20, 63) || !(own(targets, "envs") as string[]).length) p.push("targets.envs must name 1–20 environments");
      if (own(targets, "services") !== undefined && !strList(own(targets, "services"), MAX_TARGETS, 255)) p.push("targets.services must be a list of service names");
      const tags = own(targets, "tags");
      if (tags !== undefined && !(isObj(tags) && Object.keys(tags).length <= 10 && Object.values(tags).every((x) => typeof x === "string" && x.length <= 256))) p.push("targets.tags must map tag names to values");
    }
  }
  // Triggers.
  const triggers = own(v, "triggers");
  if (!Array.isArray(triggers) || !triggers.length || triggers.length > MAX_TRIGGERS) p.push(`triggers must be a list of 1–${MAX_TRIGGERS}`);
  else triggers.forEach((t, i) => p.push(...triggerProblems(t, i, defs, now)));
  // Steps (only once the policy is readable: they are checked against it).
  const steps = own(v, "steps");
  if (!Array.isArray(steps) || !steps.length || steps.length > MAX_STEPS) p.push(`steps must be a list of 1–${MAX_STEPS}`);
  else if (!pp.length) {
    const earlier = new Set<string>();
    steps.forEach((n, i) => {
      p.push(...nodeProblems(n, i, { policy: policy as AgentPolicy, catalog, earlier, targets: isObj(targets), connection: typeof conn === "string" && conn.length > 0 }));
      if (isObj(n) && typeof own(n, "id") === "string") earlier.add(own(n, "id") as string);
    });
  }
  return p;
}

// Published versions are immutable: this hash names one exactly (what runs, on what, under which policy).
export const workflowHash = (d: WorkflowDraft, frozen?: { targets: string[] }) =>
  `sha256:${createHash("sha256").update(canonicalJson({ v: 1, workflow: d, frozen: frozen ?? null })).digest("hex")}`;

// ---------- running ----------

// Which step a workflow run is at: the index into `steps`, and for a forEach step the target's index. -1 is the
// built-in first step (check inputs and targets).
export interface Cursor {
  node: number;
  item?: number;
}

// The next position after `cur` (null: the run is at its start), or null when nothing is left. forEach steps with no
// targets are passed over.
export function advance(d: Pick<WorkflowDraft, "steps">, cur: Cursor | null, targetCount: number): Cursor | null {
  let node = cur ? cur.node : -1;
  if (cur && cur.node >= 0 && d.steps[cur.node]?.forEach === "targets" && (cur.item ?? 0) + 1 < targetCount) return { node: cur.node, item: (cur.item ?? 0) + 1 };
  for (;;) {
    node++;
    const n = d.steps[node];
    if (!n) return null;
    if (n.forEach !== "targets") return { node };
    if (targetCount > 0) return { node, item: 0 };
  }
}

// The durable step kind a workflow step runs as: changes are `execute` steps (settled by their operation records,
// never retried blindly), reads `tool` steps.
export function stepKindOf(n: WorkflowNode, catalog: OpCatalog): "tool" | "execute" | "model" | "approval" | "wait" | "condition" | "verify" | "notify" {
  if (n.kind !== "tool") return n.kind;
  return (catalog(n.op)?.risk ?? "change") === "read" ? "tool" : "execute";
}

// What a workflow step of a run has produced so far, by step id. A forEach step has one entry per target in `items`;
// evaluated for target i, `steps.<id>` is that target's own entry.
export interface StepOutcomeView {
  state: string;
  result?: unknown;
  error?: string;
}
export interface Progress {
  [nodeId: string]: { state: string; result?: unknown; error?: string; items?: StepOutcomeView[] };
}

export function progressOf(rows: { nodeId: string; item?: number; state: string; result?: unknown; error?: string | null }[]): Progress {
  const out: Progress = {};
  for (const r of rows) {
    const v: StepOutcomeView = { state: r.state, ...(r.result !== undefined ? { result: r.result } : {}), ...(r.error ? { error: r.error } : {}) };
    if (r.item === undefined) out[r.nodeId] = v;
    else {
      const e = (out[r.nodeId] ??= { state: r.state, items: [] });
      e.items![r.item] = v;
    }
  }
  for (const e of Object.values(out))
    if (e.items) {
      const states = e.items.filter(Boolean).map((x) => x.state);
      e.state = states.some((s) => s === "failed" || s === "outcome_unknown") ? "failed" : states.every((s) => s === "skipped") ? "skipped" : states.every((s) => s === "succeeded" || s === "skipped") ? "succeeded" : "running";
      e.result = e.items.map((x) => x?.result);
    }
  return out;
}

export interface RunFacts {
  inputs: Record<string, InputValue>;
  trigger: Record<string, unknown>;
  targets: Target[];
}

// The values expressions and templates read, for one position of a run.
export function contextFor(facts: RunFacts, progress: Progress, item?: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const steps: Record<string, unknown> = {};
  for (const [id, e] of Object.entries(progress)) steps[id] = item !== undefined && e.items ? { ...(e.items[item] ?? { state: "skipped" }), items: e.items } : e;
  return {
    inputs: facts.inputs,
    trigger: facts.trigger,
    targets: facts.targets,
    ...(item !== undefined && facts.targets[item] ? { target: { ...facts.targets[item], index: item } } : {}),
    steps,
    ...extra,
  };
}

// ---------- preview ----------

export interface StepPreview {
  id: string;
  kind: WorkflowNode["kind"];
  title: string;
  op?: string;
  risk?: Risk;
  forEach?: "targets";
  when?: string;
  approval?: string; // who decides a change: "runs within the policy", "a person approves each one", …
}

export interface WorkflowPreview {
  name: string;
  trigger: { type: WorkflowTrigger["type"]; text: string; next?: string[] }[];
  resources: string[];
  excluded: { key: string; why: string }[];
  steps: StepPreview[];
  limits: WorkflowLimits & { runtimeSeconds: number; toolCalls: number; modelTurns: number; mutationsPerResourcePerHour: number; costUsd?: number };
  approvals: string[];
  destination: string[];
  payer: string;
  mode: AgentPolicy["mode"];
  hash: string;
  previewHash: string;
}

const describeTrigger = (t: WorkflowTrigger): string => {
  const inputs = t.inputs && Object.keys(t.inputs).length ? ` with ${Object.entries(t.inputs).map(([k, v]) => `${k}=${Array.isArray(v) ? v.join(",") : String(v)}`).join(", ")}` : "";
  if (t.type === "manual") return `started by a person${inputs}`;
  if (t.type === "schedule") return `on the schedule "${t.cron}" (${t.tz})${inputs}`;
  const s = t.selector;
  const where = [s.envs?.length ? `in ${s.envs.join(", ")}` : "", s.kinds?.length ? `of kind ${s.kinds.join(", ")}` : "", s.keys?.length ? `named ${s.keys.join(", ")}` : ""].filter(Boolean).join(" ");
  return t.source === "alarm" ? `when a CloudWatch alarm ${where} goes into ALARM${inputs}` : `when a resource ${where} becomes ${(s.states?.length ? s.states : ["DOWN", "DEGRADED"]).join(" or ")}${inputs}`;
};

function approvalOf(d: WorkflowDraft, op: string, risk: Risk, forEach: boolean): string {
  if (risk === "read") return "reads only";
  if (risk === "danger") return "a person approves each one (dangerous operation)";
  if (d.policy.mode === "propose" || !listed(d.policy.tools.act, op)) return "a person approves each one (exact plan)";
  return forEach ? "runs on its own for the listed targets only; anything else, protected or autoscaled asks a person" : "runs on its own only on resources listed by key; anything else asks a person";
}

// The preview a person accepts before a workflow is activated (AGENT_ARCHITECTURE §7): its hash binds the workflow,
// the resolved targets and the payer, and publishing recomputes it.
export function buildPreview(d: WorkflowDraft, o: { now: number; catalog: OpCatalog; payer: string; resolved?: { targets: Target[]; excluded: { key: string; why: string }[] } }): WorkflowPreview {
  // The resource set: the selector's targets as resolved now — or, without a selector, the keys the policy itself
  // lists (what a bounded-act change may touch without a person), so a person sees them before activating it.
  const resources = d.targets ? (o.resolved?.targets ?? []).map((t) => t.key) : [...(d.policy.scope.keys ?? [])];
  const steps: StepPreview[] = d.steps.map((n) => {
    const base: StepPreview = { id: n.id, kind: n.kind, title: n.title ?? defaultTitle(n), ...(n.forEach ? { forEach: n.forEach } : {}), ...(n.when ? { when: n.when } : {}) };
    if (n.kind === "tool" || n.kind === "verify") {
      const risk = o.catalog(n.op)?.risk ?? "change";
      return { ...base, op: n.op, risk, approval: approvalOf(d, n.op, risk, !!n.forEach) };
    }
    if (n.kind === "model") return { ...base, approval: d.policy.mode === "observe" ? "reads and explains; changes are refused" : "its proposals wait for a person (exact plan)" };
    if (n.kind === "approval") return { ...base, approval: "a person continues or stops the run" };
    return base;
  });
  const approvals = [...new Set(steps.filter((s) => s.approval && s.risk !== "read" && (s.kind === "tool" || s.kind === "model" || s.kind === "approval")).map((s) => `${s.title}: ${s.approval}`))];
  if (d.policy.mode === "observe") approvals.unshift("observe mode: the workflow reads and reports; every change is refused");
  const destination = d.steps.filter((n): n is NotifyNode => n.kind === "notify").map((n) => (n.to === "run" ? "the run's result in the console" : "the run's result, announced to the integrations subscribed to finished agent runs"));
  const l = d.policy.limits;
  const preview: Omit<WorkflowPreview, "previewHash"> = {
    name: d.name,
    trigger: d.triggers.map((t) => ({
      type: t.type,
      text: describeTrigger(t),
      ...(t.type === "schedule" ? { next: (() => { try { return nextFires(t.cron, t.tz, o.now, 3).map((x) => new Date(x).toISOString()); } catch { return []; } })() } : {}),
    })),
    resources,
    excluded: (o.resolved?.excluded ?? []).map((x) => ({ key: x.key, why: x.why })),
    steps,
    limits: { ...d.limits, runtimeSeconds: l.runtimeSeconds, toolCalls: l.toolCalls, modelTurns: l.modelTurns, mutationsPerResourcePerHour: l.mutationsPerResourcePerHour, ...(l.costUsd !== undefined ? { costUsd: l.costUsd } : {}) },
    approvals,
    destination: destination.length ? [...new Set(destination)] : ["the run's result in the console"],
    payer: o.payer,
    mode: d.policy.mode,
    hash: workflowHash(d, { targets: resources }),
  };
  return { ...preview, previewHash: `sha256:${createHash("sha256").update(canonicalJson({ v: 1, preview })).digest("hex")}` };
}

export function defaultTitle(n: WorkflowNode): string {
  switch (n.kind) {
    case "tool":
      return n.op;
    case "verify":
      return `verify with ${n.op}`;
    case "model":
      return "model";
    case "approval":
      return "a person's go-ahead";
    case "wait":
      return `wait ${n.seconds} s`;
    case "condition":
      return `check ${n.expr}`.slice(0, 120);
    case "notify":
      return n.report ? `${n.report} report` : "notify";
  }
}

// The policy a published version runs under: its targets, listed by key, become the bounded-act scope (nothing else
// can run without a person), and the connection is the only one it may bill.
export function publishedPolicy(d: WorkflowDraft, targets: Target[]): AgentPolicy {
  const p = d.policy;
  const scope = { ...p.scope };
  if (d.targets) {
    scope.envs = [...d.targets.envs];
    scope.keys = targets.map((t) => t.key);
    scope.excludeProtected = true;
  }
  return { ...p, scope, billing: { connection: d.connectionId ?? "", fallback: "none" } };
}
