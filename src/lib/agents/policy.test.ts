import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AUTOSCALER_OPS, DEFAULT_POLICIES, HARD_DENY, NO_COUNTERS, PolicyError, evaluate, isTemplateName, narrow, parsePolicy, policyHash, policyProblems, targetInScope, toolMatches,
  type PolicyRequest, type PolicyTarget,
} from "./policy.ts";
import type { AgentPolicy } from "./types.ts";

const SVC = "ecs-service:us-east-1/acme-staging/api";
const svc = (o: Partial<PolicyTarget> = {}): PolicyTarget => ({ key: SVC, aliases: ["ecs:service/acme-staging/api"], env: "staging", region: "us-east-1", kind: "ecs-service", protected: false, tags: { team: "web" }, ...o });
const req = (o: Partial<PolicyRequest> = {}): PolicyRequest => ({ op: "services.restart", risk: "change", perm: "act", targets: [svc()], protectedEnv: false, counters: { ...NO_COUNTERS, mutationsLastHourByKey: {} }, ...o });
const pol = (o: Partial<AgentPolicy> = {}): AgentPolicy => ({
  ...DEFAULT_POLICIES["incident-investigator"],
  ...o,
});
const bounded = (o: Partial<AgentPolicy> = {}) =>
  pol({ mode: "bounded-act", scope: { envs: ["staging"], keys: [SVC] }, tools: { read: ["services.get"], propose: ["services.restart", "services.scale"], act: ["services.restart", "services.scale", "services.start"], deny: [] }, ...o });

test("every default template policy is valid and distinct", () => {
  for (const [name, p] of Object.entries(DEFAULT_POLICIES)) {
    assert.deepEqual(policyProblems(p), [], name);
    assert.ok(isTemplateName(name));
  }
  assert.equal(Object.keys(DEFAULT_POLICIES).length, 6);
  assert.equal(new Set(Object.values(DEFAULT_POLICIES).map(policyHash)).size, 6);
  assert.equal(isTemplateName("toString"), false, "own properties only");
});

test("policyHash is canonical (key order never matters) and changes with any field", () => {
  const p = DEFAULT_POLICIES["incident-investigator"];
  const shuffled = JSON.parse(JSON.stringify({ tools: p.tools, mode: p.mode, version: p.version, scope: p.scope, limits: p.limits, evidence: p.evidence, approval: p.approval, data: p.data, billing: p.billing }));
  assert.equal(policyHash(shuffled), policyHash(p));
  assert.match(policyHash(p), /^sha256:[0-9a-f]{64}$/);
  assert.notEqual(policyHash({ ...p, limits: { ...p.limits, toolCalls: p.limits.toolCalls + 1 } }), policyHash(p));
});

test("hard denials win over any policy, even one that lists the operation everywhere", () => {
  const all = pol({ mode: "bounded-act", scope: {}, tools: { read: ["*"], propose: ["*"], act: ["*"], deny: [] } });
  assert.deepEqual(evaluate(all, req({ op: "variables.update", perm: "env" })), { effect: "deny", reason: HARD_DENY.reasons.op });
  assert.deepEqual(evaluate(all, req({ op: "costs.refresh", perm: "admin" })), { effect: "deny", reason: HARD_DENY.reasons.admin });
  assert.deepEqual(evaluate(all, req({ targets: [svc({ self: true })] })), { effect: "deny", reason: HARD_DENY.reasons.self });
  assert.deepEqual(evaluate(all, req({ op: "cloud.action", targets: [{ key: "arn:aws:iam::123456789012:role/x", kind: "iam-role", protected: false }] })), { effect: "deny", reason: HARD_DENY.reasons.iam });
  // Reading the console's own service or an IAM role is fine.
  assert.equal(evaluate(all, req({ op: "services.get", risk: "read", perm: "view", targets: [svc({ self: true })] })).effect, "allow");
  // Changes in the console's administrative areas (people, tokens, agents, workflows, their policies, other runs) are
  // refused whatever a later version names them; reading them is up to the policy.
  for (const op of ["users.invite", "tokens.create", "integrations.update", "settings.set", "approvals.decide", "agents.update", "workflows.publish", "definitions.save", "connections.create", "runs.start", "policies.update"])
    assert.deepEqual(evaluate(all, req({ op, perm: "act" })), { effect: "deny", reason: HARD_DENY.reasons.area }, op);
  assert.equal(evaluate(all, req({ op: "runs.get", risk: "read", perm: "view", targets: [] })).effect, "allow");
  assert.equal(evaluate(all, req({ op: "approvals.list", risk: "read", perm: "view", targets: [] })).effect, "allow");
});

test("tool lists: deny beats everything; reads need a list, changes need propose or act", () => {
  const p = pol({ tools: { read: ["services.*"], propose: ["services.restart"], act: [], deny: ["services.events"] } });
  assert.equal(evaluate(p, req({ op: "services.events", risk: "read", perm: "view" })).effect, "deny");
  assert.equal(evaluate(p, req({ op: "services.get", risk: "read", perm: "view" })).effect, "allow");
  assert.equal(evaluate(p, req({ op: "logs.recent", risk: "read", perm: "view" })).effect, "deny");
  assert.equal(evaluate(p, req({ op: "services.stop" })).effect, "deny");
  assert.equal(evaluate(p, req()).effect, "approve");
  assert.ok(toolMatches("*", "a.b") && toolMatches("a.*", "a.b") && !toolMatches("a.*", "ab.c") && !toolMatches("a.b", "a.bc"));
});

test("scope: every target must match; a change with unresolved targets is refused", () => {
  const p = pol({ scope: { envs: ["staging"] } });
  assert.match((evaluate(p, req({ targets: [svc({ env: "production" })] })) as { reason: string }).reason, /outside the agent's environments/);
  assert.match((evaluate(p, req({ targets: [] })) as { reason: string }).reason, /couldn't be worked out/);
  assert.equal(evaluate(p, req({ op: "envs.list", risk: "read", perm: "view", targets: [] })).effect, "allow", "a read without targets is fine");
  const acct = pol({ scope: { account: "111111111111" } });
  assert.match((evaluate(acct, req({ targets: [svc({ account: "222222222222" })] })) as { reason: string }).reason, /another AWS account/);
  // An account nobody could work out: a change can't be placed in the agent's account (a read may go on).
  assert.match((evaluate(acct, req({ targets: [svc({ account: undefined })] })) as { reason: string }).reason, /account couldn't be worked out/);
  assert.equal(evaluate(acct, req({ op: "services.get", risk: "read", perm: "view", targets: [svc({ account: undefined })] })).effect, "allow");
  assert.equal(evaluate(acct, req({ targets: [svc({ account: "111111111111" })] })).effect, "approve");
  const region = pol({ scope: { regions: ["eu-west-1"] } });
  assert.equal(evaluate(region, req()).effect, "deny");
  // The same for a region nobody could work out: a change fails closed, a read goes on.
  assert.match((evaluate(region, req({ targets: [svc({ region: undefined })] })) as { reason: string }).reason, /region couldn't be worked out/);
  assert.equal(evaluate(region, req({ op: "services.get", risk: "read", perm: "view", targets: [svc({ region: undefined })] })).effect, "allow");
  assert.equal(evaluate(pol({ scope: { regions: ["us-east-1"] } }), req()).effect, "approve");
  const tags = pol({ scope: { tags: { team: "web" } } });
  assert.equal(evaluate(tags, req()).effect, "approve");
  assert.match((evaluate(tags, req({ targets: [svc({ tags: { team: "data" } })] })) as { reason: string }).reason, /team=web/);
  assert.match((evaluate(tags, req({ targets: [svc({ tagsUnread: true, tags: undefined })] })) as { reason: string }).reason, /tags couldn't be read/);
  // keys: resources always; an environment-level target only for changes.
  const keys = pol({ scope: { keys: [SVC] } });
  assert.equal(evaluate(keys, req({ op: "envs.status", risk: "read", perm: "view", targets: [{ key: "env:staging", level: "env", env: "staging", protected: false }] })).effect, "allow");
  assert.equal(evaluate(keys, req({ targets: [svc({ key: "ecs-service:us-east-1/acme-staging/worker", aliases: [] })] })).effect, "deny");
  assert.equal(evaluate(keys, req({ targets: [svc({ key: "x", aliases: [SVC] })] })).effect, "approve", "an alias counts");
  assert.equal(targetInScope({ excludeProtected: true }, svc({ protected: true }), false).ok, false);
});

test("evidence (R01): unread tags refuse every change, whatever the policy; other unread security metadata when it must be complete; never a read", () => {
  const strict = pol({ scope: {} });
  const lax = pol({ evidence: { maximumAgeSeconds: 60, requireCompleteSecurityMetadata: false } });
  const b = bounded({ evidence: { maximumAgeSeconds: 60, requireCompleteSecurityMetadata: false } });
  // Unread tags: protection (and whether it is the console's own) is unknown — a denial for agents, not an approval
  // request a person might click through on a resource nobody can classify.
  for (const p of [strict, lax, b]) {
    const d = evaluate(p, req({ targets: [svc({ tagsUnread: true })] }));
    assert.equal(d.effect, "deny", p.mode);
    assert.match((d as { reason: string }).reason, /security metadata \(tags\) of .* couldn't be read/);
  }
  assert.equal(evaluate(strict, req({ op: "services.get", risk: "read", perm: "view", targets: [svc({ tagsUnread: true })] })).effect, "allow");
  // Other security metadata (a resource policy, its configuration) that didn't complete: refused when the policy says so.
  const partial = svc({ unreadMetadata: ["policy: denied"] });
  assert.match((evaluate(strict, req({ targets: [partial] })) as { reason: string }).reason, /\(policy: denied\).*requires it complete/);
  assert.equal(evaluate(lax, req({ targets: [partial] })).effect, "approve");
  assert.equal(evaluate(strict, req({ op: "services.get", risk: "read", perm: "view", targets: [partial] })).effect, "allow");
  // An environment as a whole has no tags of its own.
  assert.equal(evaluate(strict, req({ op: "hosts.add", risk: "danger", targets: [{ key: "env:staging", level: "env", env: "staging", protected: false, tagsUnread: true }] })).effect, "deny", "the template denies hosts.add");
  const envTools = pol({ tools: { read: [], propose: ["hosts.add"], act: [], deny: [] } });
  assert.equal(evaluate(envTools, req({ op: "hosts.add", risk: "danger", targets: [{ key: "env:staging", level: "env", env: "staging", protected: false, tagsUnread: true }] })).effect, "approve");
});

test("modes: observe refuses changes, propose asks, danger always asks", () => {
  const obs = pol({ mode: "observe" });
  assert.match((evaluate(obs, req()) as { reason: string }).reason, /observe mode/);
  assert.equal(evaluate(obs, req({ op: "services.get", risk: "read", perm: "view" })).effect, "allow");
  assert.equal(evaluate(pol(), req()).effect, "approve");
  const b = bounded({ tools: { read: [], propose: ["tasks.run"], act: ["tasks.run"], deny: [] } });
  assert.match((evaluate(b, req({ op: "tasks.run", risk: "danger" })) as { reason: string }).reason, /dangerous operation/);
});

test("bounded-act: runs only a listed change on explicitly listed, unprotected targets", () => {
  const b = bounded();
  assert.deepEqual(evaluate(b, req()), { effect: "allow" });
  // Production autonomy is off: a protected environment or target goes to a person.
  assert.equal(evaluate(b, req({ protectedEnv: true })).effect, "approve");
  assert.equal(evaluate(b, req({ targets: [svc({ protected: true })] })).effect, "approve");
  // A target in scope by environment but not listed by name: a person.
  const wide = bounded({ scope: { envs: ["staging"] } });
  assert.match((evaluate(wide, req()) as { reason: string }).reason, /listed by name/);
  // Not in act (only in propose) → approve; in neither → deny.
  assert.equal(evaluate(b, req({ op: "services.stop" })).effect, "deny");
  const noPropose = bounded({ scope: { envs: ["staging"] }, tools: { read: [], propose: [], act: ["services.restart"], deny: [] } });
  assert.equal(evaluate(noPropose, req()).effect, "deny", "not listed by name and not proposable → refused");
});

test("§9.7: a scale or start on an autoscaled service is never bounded-act; a rollback with unknown migrations needs a person", () => {
  const b = bounded({ tools: { read: [], propose: ["services.scale", "services.start", "services.switch", "services.restart"], act: ["services.scale", "services.start", "services.switch", "services.restart"], deny: [] } });
  for (const op of ["services.scale", "services.start"]) {
    const d = evaluate(b, req({ op, targets: [svc({ autoscaled: true })] }));
    assert.equal(d.effect, "approve", op);
    assert.match((d as { reason: string }).reason, /Auto Scaling/);
  }
  assert.equal(evaluate(b, req({ op: "services.restart", targets: [svc({ autoscaled: true })] })).effect, "allow", "a restart doesn't fight the autoscaler");
  for (const m of [true, "unknown"] as const) assert.equal(evaluate(b, req({ op: "services.switch", targets: [svc({ migrations: m })] })).effect, "approve");
  assert.equal(evaluate(b, req({ op: "services.switch", targets: [svc({ migrations: false })] })).effect, "allow");
  // The request may say it too (a rollback whose plan says migrations changed), for any operation.
  for (const m of [true, "unknown"] as const) assert.match((evaluate(b, req({ op: "services.switch", migrations: m })) as { reason: string }).reason, /migrations changed/);
  assert.equal(evaluate(b, req({ op: "services.switch", migrations: false })).effect, "allow");
  assert.deepEqual([...AUTOSCALER_OPS], ["services.scale", "services.start"]);
  // Not proposable → refused outright rather than run.
  const actOnly = bounded({ tools: { read: [], propose: [], act: ["services.scale"], deny: [] } });
  assert.equal(evaluate(actOnly, req({ op: "services.scale", targets: [svc({ autoscaled: true })] })).effect, "deny");
});

test("limits deny with the reason, for approvals too", () => {
  const p = pol({ limits: { ...pol().limits, toolCalls: 3, modelTurns: 2, runtimeSeconds: 10, mutationsPerResourcePerHour: 1, concurrentMutations: 1 } });
  const c = (o: Partial<PolicyRequest["counters"]>) => ({ ...NO_COUNTERS, mutationsLastHourByKey: {}, ...o });
  assert.match((evaluate(p, req({ op: "services.get", risk: "read", perm: "view", counters: c({ toolCalls: 3 }) })) as { reason: string }).reason, /tool call limit \(3\)/);
  assert.match((evaluate(p, req({ counters: c({ turns: 3 }) })) as { reason: string }).reason, /model turn limit/);
  assert.equal(evaluate(p, req({ counters: c({ turns: 2 }) })).effect, "approve");
  assert.match((evaluate(p, req({ counters: c({ elapsedMs: 10_001 }) })) as { reason: string }).reason, /time limit/);
  assert.equal((evaluate(p, req({ counters: c({ mutationsLastHourByKey: { [SVC]: 1 } }) })) as { reason: string }).reason, `hourly mutation limit for ${SVC} reached (1 per hour)`);
  assert.match((evaluate(p, req({ counters: c({ activeMutations: 1 }) })) as { reason: string }).reason, /in flight/);
  assert.equal(evaluate(p, req({ op: "services.get", risk: "read", perm: "view", counters: c({ activeMutations: 5, mutationsLastHourByKey: { [SVC]: 9 } }) })).effect, "allow", "mutation limits don't apply to reads");
});

test("narrow: a child may only shrink its parent; a broader child throws", () => {
  const parent = bounded({ scope: { envs: ["staging"], keys: [SVC, "b"], excludeProtected: true } });
  const child = bounded({ mode: "propose", scope: { envs: ["staging"], keys: [SVC], excludeProtected: true }, tools: { read: ["services.get"], propose: ["services.restart"], act: [], deny: ["services.scale"] } });
  const n = narrow(parent, child);
  assert.equal(n.mode, "propose");
  assert.deepEqual(n.scope.keys, [SVC]);
  const broader: [string, Partial<AgentPolicy>][] = [
    ["mode", { mode: "bounded-act" as const, ...{} }],
    ["tools", { tools: { ...child.tools, act: ["services.delete"] } }],
    ["scope", { scope: { envs: ["staging", "production"], keys: [SVC], excludeProtected: true } }],
    ["unscoped", { scope: { keys: [SVC], excludeProtected: true } }],
    ["limits", { limits: { ...child.limits, toolCalls: child.limits.toolCalls + 1 } }],
    ["protected", { scope: { envs: ["staging"], keys: [SVC] } }],
  ];
  const strictParent = { ...parent, mode: "propose" as const };
  for (const [what, o] of broader) assert.throws(() => narrow(what === "mode" ? strictParent : parent, { ...child, ...o }), PolicyError, what);
  // The parent's denials always carry over.
  assert.deepEqual(narrow({ ...parent, tools: { ...parent.tools, deny: ["x.y"] } }, child).tools.deny.sort(), ["services.scale", "x.y"]);
  // "area.*" in the child needs "area.*" or "*" in the parent.
  assert.throws(() => narrow(parent, { ...child, tools: { ...child.tools, read: ["services.*"] } }), PolicyError);
});

test("parsePolicy validates own properties and refuses unknown or unlimited fields", () => {
  const p = DEFAULT_POLICIES["daily-digest"];
  assert.deepEqual(parsePolicy(JSON.parse(JSON.stringify(p))), p);
  assert.throws(() => parsePolicy({ ...p, extra: 1 }), /unknown field extra/);
  assert.throws(() => parsePolicy({ ...p, mode: "yolo" }), /mode must be/);
  assert.throws(() => parsePolicy({ ...p, limits: { ...p.limits, toolCalls: 0 } }), /toolCalls must be a number ≥ 1/);
  assert.throws(() => parsePolicy({ ...p, approval: { ...p.approval, bindPlanHash: false } }), /bindPlanHash/);
  assert.throws(() => parsePolicy({ ...p, billing: { connection: "c", fallback: "any" } }), /fallback/);
  assert.throws(() => parsePolicy({ ...p, tools: { ...p.tools, read: ["rm -rf"] } }), /tools.read/);
  const inherited = Object.create({ mode: "observe" });
  assert.ok(policyProblems(Object.assign(inherited, { ...p, mode: undefined })).some((x) => /mode/.test(x)), "an inherited field doesn't count");
});
