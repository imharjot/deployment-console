// Workflows (master plan §6 C7 items 1 and 8): the safe expression language, templates in inputs, validation against
// the policy and the operation catalog, target selection and its exclusions, the run's position (forEach included),
// progress and context, and the preview hash that binds activation.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_POLICIES } from "./policy.ts";
import {
  DEFAULT_LIMITS, ExprError, advance, buildPreview, compareTargets, contextFor, evalExpr, holds, parseExpr, progressOf, publishedPolicy, render, resolveInputs, selectTargets, stepKindOf,
  validateWorkflow, workflowHash, type OpCatalog, type TargetCandidate, type WorkflowDraft,
} from "./workflows.ts";

// The registry's view of the operations these tests use (risk and permission as in src/lib/server/ops/*.ts).
export const CATALOG: Record<string, { risk: "read" | "change" | "danger"; perm: "view" | "act" | "env" | "costs" | "provision" | "admin" }> = {
  "envs.list": { risk: "read", perm: "view" }, "envs.status": { risk: "read", perm: "view" }, "services.get": { risk: "read", perm: "view" },
  "services.stop": { risk: "change", perm: "act" }, "services.start": { risk: "change", perm: "act" }, "services.restart": { risk: "change", perm: "act" },
  "services.delete": { risk: "danger", perm: "provision" }, "variables.update": { risk: "change", perm: "env" }, "variables.compare": { risk: "read", perm: "env" },
  "audit.recent": { risk: "read", perm: "view" }, "issues.list": { risk: "read", perm: "view" }, "ci.runs": { risk: "read", perm: "view" }, "approvals.list": { risk: "read", perm: "view" },
  "costs.summary": { risk: "read", perm: "costs" }, "costs.estimate": { risk: "read", perm: "costs" }, "cloud.map": { risk: "read", perm: "view" }, "runs.start": { risk: "change", perm: "act" },
};
export const catalog: OpCatalog = (op) => CATALOG[op];

const P = (name: keyof typeof DEFAULT_POLICIES) => structuredClone(DEFAULT_POLICIES[name]);
const svc = { env: "{{target.env}}", service: "{{target.service}}" };

function schedule(over: Partial<WorkflowDraft> = {}): WorkflowDraft {
  return {
    format: 1, name: "Nights off", inputs: [{ name: "action", type: "string", enum: ["stop", "start"], required: true }],
    triggers: [{ type: "schedule", cron: "0 19 * * 1-5", tz: "UTC", inputs: { action: "stop" } }, { type: "manual" }],
    targets: { envs: ["staging"] },
    steps: [
      { id: "before", kind: "tool", op: "services.get", forEach: "targets", input: { ...svc } },
      { id: "stop", kind: "tool", op: "services.stop", forEach: "targets", when: "inputs.action == 'stop' and steps.before.result.desired > 0", input: { ...svc, confirm: "yes" } },
      { id: "stopped", kind: "verify", op: "services.get", forEach: "targets", when: "steps.stop.state == 'succeeded'", input: { ...svc }, expect: "result.desired == 0", timeoutSeconds: 600 },
      { id: "report", kind: "notify", to: "run", report: "text", message: "done {{targets.length}}" },
    ],
    policy: P("nonproduction-schedule"), limits: { ...DEFAULT_LIMITS }, connectionId: "",
    ...over,
  };
}

test("expressions: comparisons, and / or / not, parentheses, len(), own properties only, no eval", () => {
  const ctx = { steps: { a: { result: { desired: 2, state: "UP", list: [1, 2, 3] } } }, inputs: { action: "stop", on: true }, target: { service: "api" } };
  assert.equal(holds("steps.a.result.desired > 0 and inputs.action == 'stop'", ctx), true);
  assert.equal(holds("steps.a.result.desired == 0 or not inputs.on", ctx), false);
  assert.equal(holds("(inputs.action != \"start\") && !(steps.a.result.state == 'DOWN')", ctx), true);
  assert.equal(holds("len(steps.a.result.list) >= 3", ctx), true);
  assert.equal(holds("steps.a.result.list[1] == 2 and steps.a.result.list.length == 3", ctx), true);
  assert.equal(holds("steps.missing.result.x == null", ctx), true, "a missing value is null-like");
  assert.equal(holds("steps.a.result.desired > 'x'", ctx), false, "mixed types never order");
  assert.equal(evalExpr(parseExpr("-1 < steps.a.result.desired"), ctx), true);
  // The prototype is unreachable, and nothing can be called.
  for (const bad of ["inputs.__proto__", "inputs.constructor", "steps.a.prototype", "process.exit()", "inputs.action = 'x'", "inputs.action ==", "'open", "a.b.c.d.e.f.g.h.i.j.k.l.m", "x".repeat(501)])
    assert.throws(() => parseExpr(bad), ExprError, bad);
  assert.equal(holds("toString", {}), false);
  assert.equal(holds("hasOwnProperty", { a: 1 }), false);
});

test("templates: a whole template keeps the value's type; holes are errors; prototype paths are refused", () => {
  const ctx = { target: { env: "staging", service: "api", index: 0 }, inputs: { envs: ["staging", "production"], n: 3 } };
  assert.deepEqual(render({ ...svc, confirm: "yes", note: "{{target.env}}/{{target.service}} #{{target.index}}" }, ctx), { env: "staging", service: "api", confirm: "yes", note: "staging/api #0" });
  assert.deepEqual(render({ envs: "{{inputs.envs}}", n: "{{ inputs.n }}" }, ctx), { envs: ["staging", "production"], n: 3 });
  assert.throws(() => render({ x: "{{inputs.nope}}" }, ctx), /has no value/);
  assert.throws(() => render({ x: "{{inputs.__proto__}}" }, ctx), /can't be read/);
  assert.throws(() => render({ x: "{{inputs.n > 1}}" }, ctx), /must name a value/);
});

test("inputs: types, enums, required, defaults and unknown names", () => {
  const defs = schedule().inputs;
  assert.deepEqual(resolveInputs(defs, { action: "stop" }), { values: { action: "stop" }, problems: [] });
  assert.match(resolveInputs(defs, {}).problems[0], /required/);
  assert.match(resolveInputs(defs, { action: "reboot" }).problems[0], /one of stop, start/);
  assert.match(resolveInputs(defs, { action: "stop", extra: 1 }).problems[0], /unknown input extra/);
  assert.deepEqual(resolveInputs([{ name: "envs", type: "list", default: ["a"] }], undefined).values, { envs: ["a"] });
  assert.match(resolveInputs([{ name: "envs", type: "list" }], { envs: "a,b" }).problems[0], /list of names/);
});

test("validation: a valid workflow has no problems; tools are checked against the policy and the hard denials", () => {
  assert.deepEqual(validateWorkflow(schedule(), catalog, Date.parse("2026-10-05T00:00:00Z")), []);
  const bad = (over: Partial<WorkflowDraft>) => validateWorkflow(schedule(over), catalog).join("\n");
  const steps = schedule().steps;
  assert.match(bad({ steps: [...steps, { id: "vars", kind: "tool", op: "variables.update", input: {} }] }), /never change environment variables/);
  assert.match(bad({ steps: [...steps, { id: "rs", kind: "tool", op: "services.restart", input: {} }] }), /isn't one of the changes the policy allows/);
  assert.match(bad({ steps: [...steps, { id: "go", kind: "tool", op: "runs.start", input: {} }] }), /administer the console/);
  assert.match(bad({ steps: [...steps, { id: "x", kind: "tool", op: "nope.nope", input: {} }] }), /unknown operation/);
  assert.match(bad({ policy: { ...P("daily-digest") } }), /only observes/);
  assert.match(bad({ steps: [{ id: "a", kind: "condition", expr: "steps.later.result.x == 1" }, ...steps] }), /doesn't name an earlier step/);
  assert.match(bad({ steps: [...steps, { id: "a", kind: "verify", op: "services.stop", input: {}, expect: "true", timeoutSeconds: 60 }] }), /verify steps only read/);
  assert.match(bad({ steps: [...steps, { id: "m", kind: "model", goal: "think" }] }), /needs a connection[\s\S]*no model turns/);
  assert.match(bad({ targets: undefined }), /forEach "targets" needs the workflow's targets/);
  assert.match(bad({ triggers: [{ type: "schedule", cron: "0 0 30 2 *", tz: "UTC" }] }), /never fires/);
  assert.match(bad({ triggers: [{ type: "event", source: "state", selector: {} }] }), /must name environments or resource keys/);
  assert.match(bad({ steps: [...steps, { id: "report", kind: "wait", seconds: 5 }] }), /used twice/);
  assert.match(validateWorkflow({ ...schedule(), extra: true }, catalog).join("\n"), /unknown field extra/);
  assert.match(bad({ steps: [{ id: "before", kind: "tool", op: "services.get", input: { env: "{{nowhere.x}}" } }] }), /values come from/);
  assert.match(bad({ limits: { ...DEFAULT_LIMITS, maxAttempts: 0 } }), /maxAttempts/);
});

test("target selection excludes protected, shared, autoscaled, unreadable and console services", () => {
  const c = (service: string, o: Partial<TargetCandidate> = {}): TargetCandidate => ({
    key: `ecs-service:us-east-1/acme-staging/${service}`, env: "staging", service, region: "us-east-1", envProtected: false, protected: false, self: false, tags: {}, ...o,
  });
  const { targets, excluded } = selectTargets({ envs: ["staging"] }, [
    c("api"), c("worker"), c("console", { self: true }), c("maybe", { self: "unknown" }), c("db-proxy", { tags: { "console:shared": "true" } }), c("web", { autoscaled: true }),
    c("pay", { protected: true }), c("blind", { tags: null }), c("prod-api", { env: "production", envProtected: true }),
  ]);
  assert.deepEqual(targets.map((t) => t.service), ["api", "worker"]);
  assert.deepEqual(Object.fromEntries(excluded.map((x) => [x.service, x.why])), {
    console: "it is the console's own service", maybe: "whether it is the console's own service couldn't be read", "db-proxy": "it is tagged console:shared",
    web: "Application Auto Scaling manages its task count", pay: "it is tagged console:protected", blind: "its tags couldn't be read",
  });
  assert.deepEqual(selectTargets({ envs: ["staging"], services: ["worker"] }, [c("api"), c("worker")]).targets.map((t) => t.service), ["worker"]);
  assert.deepEqual(selectTargets({ envs: ["staging"], tags: { team: "shop" } }, [c("api", { tags: { team: "shop" } }), c("worker", { tags: { team: "ops" } })]).targets.map((t) => t.service), ["api"]);
  const now = selectTargets({ envs: ["staging"] }, [c("api"), c("worker"), c("new")]).targets;
  const d = compareTargets([c("api").key, c("worker").key, c("gone").key], now);
  assert.deepEqual(d.additions.map((t) => t.service), ["new"]);
  assert.deepEqual(d.removals, [c("gone").key]);
});

test("running: positions walk the steps, forEach once per target, empty forEach passed over", () => {
  const d = schedule();
  const seq: string[] = [];
  for (let c = advance(d, null, 2); c; c = advance(d, c, 2)) seq.push(`${d.steps[c.node].id}${c.item !== undefined ? `#${c.item}` : ""}`);
  assert.deepEqual(seq, ["before#0", "before#1", "stop#0", "stop#1", "stopped#0", "stopped#1", "report"]);
  const none: string[] = [];
  for (let c = advance(d, null, 0); c; c = advance(d, c, 0)) none.push(d.steps[c.node].id);
  assert.deepEqual(none, ["report"]);
  assert.equal(stepKindOf(d.steps[0], catalog), "tool");
  assert.equal(stepKindOf(d.steps[1], catalog), "execute", "a change is an execute step");
  assert.equal(stepKindOf(d.steps[2], catalog), "verify");
});

test("progress and context: a forEach step reads its own target's entry of an earlier forEach step", () => {
  const p = progressOf([
    { nodeId: "before", item: 0, state: "succeeded", result: { desired: 2 } },
    { nodeId: "before", item: 1, state: "succeeded", result: { desired: 0 } },
    { nodeId: "stop", item: 0, state: "succeeded", result: { operationId: "o1" } },
    { nodeId: "stop", item: 1, state: "skipped" },
  ]);
  assert.equal(p.before.state, "succeeded");
  assert.equal(p.stop.state, "succeeded");
  const facts = { inputs: { action: "stop" }, trigger: {}, targets: [{ key: "k0", env: "staging", service: "api" }, { key: "k1", env: "staging", service: "worker" }] };
  assert.equal(holds("steps.before.result.desired > 0", contextFor(facts, p, 0)), true);
  assert.equal(holds("steps.before.result.desired > 0", contextFor(facts, p, 1)), false);
  assert.equal(holds("steps.stop.state == 'succeeded'", contextFor(facts, p, 1)), false);
  assert.equal(holds("target.service == 'worker' and target.index == 1", contextFor(facts, p, 1)), true);
  assert.equal(progressOf([{ nodeId: "v", item: 0, state: "failed" }, { nodeId: "v", item: 1, state: "succeeded" }]).v.state, "failed");
});

test("preview: trigger times, resources, approvals and payer; its hash changes with what it shows", () => {
  const d = schedule();
  const t = (service: string) => ({ key: `ecs-service:us-east-1/acme-staging/${service}`, env: "staging", service });
  const now = Date.parse("2026-10-05T12:00:00Z"); // a Monday
  const a = buildPreview(d, { now, catalog, payer: "nobody", resolved: { targets: [t("api"), t("worker")], excluded: [{ key: "x", why: "protected" }] } });
  assert.deepEqual(a.trigger[0].next, ["2026-10-05T19:00:00.000Z", "2026-10-06T19:00:00.000Z", "2026-10-07T19:00:00.000Z"]);
  assert.deepEqual(a.resources, [t("api").key, t("worker").key]);
  assert.match(a.approvals.join("\n"), /runs on its own for the listed targets only/);
  assert.deepEqual(a.destination, ["the run's result in the console"]);
  assert.equal(a.mode, "bounded-act");
  const same = buildPreview(structuredClone(d), { now, catalog, payer: "nobody", resolved: { targets: [t("api"), t("worker")], excluded: [{ key: "x", why: "protected" }] } });
  assert.equal(same.previewHash, a.previewHash);
  const more = buildPreview(d, { now, catalog, payer: "nobody", resolved: { targets: [t("api"), t("worker"), t("web")], excluded: [] } });
  assert.notEqual(more.previewHash, a.previewHash, "another resource set is another preview");
  assert.notEqual(buildPreview(d, { now, catalog, payer: "someone else", resolved: { targets: [t("api"), t("worker")], excluded: [{ key: "x", why: "protected" }] } }).previewHash, a.previewHash);
  // The version hash ignores key order and follows content.
  const reordered = JSON.parse(JSON.stringify({ steps: d.steps, name: d.name, format: 1, inputs: d.inputs, triggers: d.triggers, targets: d.targets, policy: d.policy, limits: d.limits, connectionId: "" }));
  assert.equal(workflowHash(reordered), workflowHash(d));
  assert.notEqual(workflowHash({ ...d, name: "Other" }), workflowHash(d));
  // Publishing lists the previewed targets by key — the only ones bounded-act may touch.
  const pol = publishedPolicy(d, [t("api"), t("worker")]);
  assert.deepEqual(pol.scope.keys, [t("api").key, t("worker").key]);
  assert.equal(pol.scope.excludeProtected, true);
  assert.deepEqual(pol.billing, { connection: "", fallback: "none" });
  // Without a selector, the keys the policy lists are the resource set a person accepts.
  const listed = { ...structuredClone(d), targets: undefined, steps: d.steps.filter((n) => !n.forEach), policy: { ...d.policy, scope: { ...d.policy.scope, keys: ["ecs-service:us-east-1/acme-staging/api"] } } };
  assert.deepEqual(buildPreview(listed, { now, catalog, payer: "nobody" }).resources, ["ecs-service:us-east-1/acme-staging/api"]);
});
