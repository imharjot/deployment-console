// Workflows end to end (master plan §6 C7 item 8; AGENT_ARCHITECTURE §9.3 recovery, phase 3 exit criteria), against the
// simulated Acme account in a child process (server modules import "server-only", which resolves only under the
// react-server condition) on in-memory SQLite: the templates validate and resolve on Acme; the non-production schedule
// stops listed services (remembering their counts) and starts them again with those counts, verified; a service that
// matches but wasn't previewed pauses the run for review and is never touched; cooldown, maximum attempts and
// concurrency; schedule dedupe (one run per slot, across consoles and retries), missed slots, revocation (disable,
// superseded versions, a disabled publisher, runs in flight); event triggers with dedupe; the agent operations
// (operations.get hides params, visibility, variables.compare never shows values or digests); agent definitions.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";

const SRC = new URL("../../../", import.meta.url).href; // …/src/
const hooks = `
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
const SRC = ${JSON.stringify(SRC)};
export async function resolve(spec, ctx, next) {
  if (spec === "next/server") return next("next/server.js", ctx);
  if (spec.startsWith("@/")) {
    for (const ext of [".ts", ".tsx", "/index.ts"]) {
      const url = new URL(spec.slice(2) + ext, SRC);
      if (existsSync(fileURLToPath(url))) return next(url.href, ctx);
    }
  }
  return next(spec, ctx);
}`;
const register = `import { register } from "node:module"; register(${JSON.stringify(`data:text/javascript,${encodeURIComponent(hooks)}`)});`;

function run(scenario: string) {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    CONSOLE_SOURCE: "mock",
    CONSOLE_SQLITE_PATH: ":memory:",
    CONSOLE_SECRET_KEY: randomBytes(36).toString("base64"),
    CONSOLE_TRUSTED_PROXIES: "0",
    NODE_ENV: "test",
  };
  const raw = execFileSync(process.execPath, ["--conditions=react-server", "--no-warnings", "--import", `data:text/javascript,${encodeURIComponent(register)}`, "--input-type=module", "-e", prelude + scenario + "\nconsole.log(JSON.stringify(out));\nprocess.exit(0);"], {
    encoding: "utf8",
    timeout: 240_000,
    env,
  });
  return JSON.parse(raw.trim().split("\n").filter((l) => l.startsWith("{")).pop()!);
}

const prelude = `
const src = (p) => new URL(p, ${JSON.stringify(SRC)}).href;
const { getDb } = await import(src("lib/server/db.ts"));
const { createUser } = await import(src("lib/server/auth/users.ts"));
const store = await import(src("lib/server/agents/store.ts"));
const worker = await import(src("lib/server/agents/worker.ts"));
const steps = await import(src("lib/server/agents/steps.ts"));
const sched = await import(src("lib/server/agents/scheduler.ts"));
const wf = await import(src("lib/server/agents/workflows.ts"));
const defs = await import(src("lib/server/agents/definitions.ts"));
const agentOps = (await import(src("lib/server/ops/agents.ts"))).ops;
const W = await import(src("lib/agents/workflows.ts"));
const T = await import(src("lib/agents/templates.ts"));
const { DEFAULT_POLICIES } = await import(src("lib/agents/policy.ts"));
const db = await getDb();
const mk = async (email, role) => { const r = await createUser({ email, role }); return { id: r.id, email, role }; };
const alice = await mk("alice@acme.test", "operator");
const settle = (p) => p.then((v) => ({ ok: v }), (e) => ({ status: e.status, code: e.code, error: String(e.message) }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const steps_ = async (runId) => (await store.getSteps(runId)).map((s) => [s.name, s.kind, s.state]);
const runOf = (id) => store.getRun(id);
// Ticks the worker (waking waiting steps early) until the run ends.
async function drive(runId, max = 90) {
  for (let i = 0; i < max; i++) {
    await worker.tick({ wait: true, now: Date.now() + 120_000 });
    const r = await runOf(runId);
    if (["succeeded", "failed", "cancelled", "outcome_unknown"].includes(r.state)) return r;
    await sleep(500);
  }
  return runOf(runId);
}
async function publish(user, body) {
  const c = await wf.createWorkflow(user, body);
  const p = await wf.previewWorkflow(user, c.workflow.id);
  const r = await wf.publishWorkflow(user, c.workflow.id, p.previewHash);
  return { id: c.workflow.id, preview: p, published: r };
}
const desired = async (service) => Number((await db.get("SELECT value FROM settings WHERE key = ?", ["desired:staging/" + service]))?.value ?? NaN);
const opRun = (name) => agentOps.find((o) => o.name === name).run;
await steps.registerHandlers();
const out = {};
`;

test("templates validate and resolve on Acme; the non-production schedule stops (remembering counts) and starts again, verified", () => {
  const o = run(`
// Each template against the real registry (plus this package's operations, registered at the wave gate).
const cat = (n) => wf.opCatalog(n) ?? (agentOps.find((x) => x.name === n) ? { risk: agentOps.find((x) => x.name === n).risk, perm: agentOps.find((x) => x.name === n).perm } : undefined);
out.valid = Object.fromEntries(T.TEMPLATES.map((t) => [t.name, W.validateWorkflow(T.templateDraft(t.name, { envs: ["staging"], connectionId: t.model === "none" ? undefined : "scripted:demo" }), cat)]));
const all = await wf.resolveTargets({ envs: ["staging", "production"] });
out.resolvedAll = all.targets.map((t) => t.env + "/" + t.service);
out.excludedProd = [...new Set(all.excluded.filter((x) => x.env === "production").map((x) => x.why))];
// Publish the schedule for two staging services; the preview lists exactly them.
const p = await publish(alice, { template: "nonproduction-schedule", options: { envs: ["staging"], services: ["api", "worker"], tz: "Europe/Berlin" } });
out.previewResources = p.preview.resources;
out.previewPayer = p.preview.payer;
out.schedules = (await db.all("SELECT cron, tz, enabled FROM schedules WHERE workflow_id = ? ORDER BY id", [p.id])).map((s) => [s.cron, s.tz, Number(s.enabled)]);
const v = await wf.activeVersion(p.id);
out.scopeKeys = v.draft.policy.scope.keys;
out.publisher = v.publisher.email;
// Publishing needs the exact preview.
await wf.saveDraft(alice, p.id, { ...v.draft, name: "Nights off v2" });
out.stalePublish = await settle(wf.publishWorkflow(alice, p.id, p.preview.previewHash));
out.noHash = await settle(wf.publishWorkflow(alice, p.id, undefined));
// Stop.
const stopRun = await wf.startManualRun(alice, p.id, { action: "stop" });
const r1 = await drive(stopRun);
out.stop = { state: r1.state, error: r1.error, steps: await steps_(stopRun) };
out.remembered = { api: await desired("api"), worker: await desired("worker") };
out.ops = (await db.all("SELECT action, actor_kind, state FROM operations WHERE run_id = ? ORDER BY created_at", [stopRun])).map((x) => [x.action, x.actor_kind, x.state]);
// Start: back to the remembered counts.
const startRun = await wf.startManualRun(alice, p.id, { action: "start" });
const r2 = await drive(startRun);
out.start = { state: r2.state, error: r2.error, steps: (await steps_(startRun)).filter((s) => s[2] !== "skipped").map((s) => s[0]) };
const { invoke } = await import(src("lib/server/ops/index.ts"));
const person = { user: alice, via: "session" };
out.after = { api: (await invoke("services.get", { env: "staging", service: "api" }, person)).result.desired, worker: (await invoke("services.get", { env: "staging", service: "worker" }, person)).result.desired };
out.report = JSON.parse((await store.getSteps(startRun)).find((s) => s.kind === "notify").result).report.headline;
`);
  for (const [name, problems] of Object.entries(o.valid)) assert.deepEqual(problems, [], name);
  assert.ok(o.resolvedAll.includes("staging/api") && o.resolvedAll.includes("staging/worker"), JSON.stringify(o.resolvedAll));
  assert.ok(o.resolvedAll.every((x: string) => x.startsWith("staging/")), "production is protected: never a target");
  assert.deepEqual(o.excludedProd, ["its environment is protected"]);
  assert.deepEqual(o.previewResources, ["ecs-service:us-east-1/acme-staging/api", "ecs-service:us-east-1/acme-staging/worker"]);
  assert.match(o.previewPayer, /nobody/);
  assert.deepEqual(o.schedules, [["0 19 * * 1-5", "Europe/Berlin", 1], ["0 8 * * 1-5", "Europe/Berlin", 1]]);
  assert.deepEqual(o.scopeKeys, o.previewResources, "bounded-act only for the previewed keys");
  assert.equal(o.publisher, "alice@acme.test");
  assert.equal(o.stalePublish.code, "preview_changed");
  assert.equal(o.noHash.code, "preview_required");
  assert.equal(o.stop.state, "succeeded", JSON.stringify(o.stop));
  assert.deepEqual(o.remembered, { api: 1, worker: 1 }, "stop remembers the desired count");
  assert.deepEqual(o.ops, [["services.stop", "agent", "succeeded"], ["services.stop", "agent", "succeeded"]]);
  assert.deepEqual(o.stop.steps.filter((s: string[]) => s[1] === "execute").map((s: string[]) => s[2]), ["succeeded", "succeeded", "skipped", "skipped"]);
  assert.equal(o.start.state, "succeeded", JSON.stringify(o.start));
  assert.deepEqual(o.after, { api: 1, worker: 1 }, "start restores the remembered count");
  assert.match(o.report, /Non-production schedule \(start\) finished for 2 service/);
});

test("a service that matches but wasn't previewed pauses the run for review and is never acted on", () => {
  const o = run(`
const p = await publish(alice, { template: "nonproduction-schedule", options: { envs: ["staging"], services: ["api", "worker"] } });
// Pretend "worker" appeared after the preview: drop it from the version's frozen targets.
const row = await db.get("SELECT graph FROM workflows WHERE id = ? AND version = 1", [p.id]);
const g = JSON.parse(row.graph);
g.frozen.targets = g.frozen.targets.filter((t) => t.service !== "worker");
await db.run("UPDATE workflows SET graph = ? WHERE id = ? AND version = 1", [JSON.stringify(g), p.id]);
const runId = await wf.startManualRun(alice, p.id, { action: "stop" });
for (let i = 0; i < 3; i++) await worker.tick({ wait: true, now: Date.now() + 120_000 });
const r = await runOf(runId);
const start = (await store.getSteps(runId))[0];
out.paused = { run: r.state, step: start.state, review: JSON.parse(start.result).review, ops: Number((await db.get("SELECT COUNT(*) AS n FROM operations WHERE run_id = ?", [runId])).n) };
out.wrongDecision = await settle(wf.reviewRun(alice, p.id, runId, "maybe"));
out.reviewed = await wf.reviewRun(alice, p.id, runId, "continue");
const done = await drive(runId);
out.after = { state: done.state, ops: (await db.all("SELECT action, targets FROM operations WHERE run_id = ?", [runId])).map((x) => x.action + " " + JSON.parse(x.targets).target) };
// Nobody answers within the run's time limit: a late "continue" is refused and the run is cancelled, untouched.
const late = await wf.startManualRun(alice, p.id, { action: "stop" });
for (let i = 0; i < 2; i++) await worker.tick({ wait: true, now: Date.now() + 120_000 });
out.lateWaiting = { state: (await runOf(late)).state, expiresAt: typeof JSON.parse((await store.getSteps(late))[0].result).review.expiresAt };
await db.run("UPDATE agent_runs SET created_at = created_at - ? WHERE id = ?", [3_600_000, late]);
out.lateReview = await settle(wf.reviewRun(alice, p.id, late, "continue"));
const lateDone = await drive(late, 5);
out.late = { state: lateDone.state, error: lateDone.error, ops: Number((await db.get("SELECT COUNT(*) AS n FROM operations WHERE run_id = ?", [late])).n) };
// A second paused run, cancelled by the reviewer.
const r2 = await wf.startManualRun(alice, p.id, { action: "stop" });
for (let i = 0; i < 2; i++) await worker.tick({ wait: true, now: Date.now() + 120_000 });
await wf.reviewRun(alice, p.id, r2, "cancel");
for (let i = 0; i < 2; i++) await worker.tick({ wait: true, now: Date.now() + 120_000 });
out.cancelled = (await runOf(r2)).state;
out.noReview = await settle(wf.reviewRun(alice, p.id, r2, "continue"));
`);
  assert.equal(o.paused.run, "waiting_external", "waiting for a person's review (not an approval grant: the Approvals list stays for exact plans)");
  assert.equal(o.paused.step, "waiting");
  assert.deepEqual(o.paused.review.additions, ["ecs-service:us-east-1/acme-staging/worker"]);
  assert.equal(o.paused.ops, 0, "nothing ran while it waited");
  assert.equal(o.wrongDecision.status, 400);
  assert.deepEqual(o.reviewed.decision, "continue");
  assert.equal(o.after.state, "succeeded");
  assert.deepEqual(o.after.ops, ["services.stop api"], "the unexpected service was never touched");
  assert.deepEqual(o.lateWaiting, { state: "waiting_external", expiresAt: "number" });
  assert.equal(o.lateReview.code, "review_expired");
  assert.equal(o.late.state, "cancelled");
  assert.match(o.late.error, /nobody reviewed its new targets within the run's time limit/);
  assert.equal(o.late.ops, 0);
  assert.equal(o.cancelled, "cancelled");
  assert.equal(o.noReview.code, "not_waiting");
});

test("limits: cooldown and maximum attempts per resource, concurrent runs", () => {
  const o = run(`
const p = await publish(alice, { template: "approved-remediation", options: { envs: ["staging"], connectionId: "scripted:demo" } });
const v1 = await wf.activeVersion(p.id);
const start = (key) => settle(wf.startWorkflowRun({ version: v1, delegator: alice, trigger: { type: "event", at: Date.now(), resourceKey: key }, resourceKey: key }));
const a = await start("ecs-service:us-east-1/acme-staging/api");
out.second = await start("ecs-service:us-east-1/acme-staging/api");
await store.updateRun(a.ok, { state: "failed", error: "test" });
out.cooldown = await start("ecs-service:us-east-1/acme-staging/api");
// A model step's child run carries the workflow and the resource too: part of its parent's attempt, not another one.
await store.createRun({ kind: "workflow", title: "child", initiatorId: alice.id, workflowId: p.id, workflowVersion: 1, parentRunId: a.ok, resourceKey: "ecs-service:us-east-1/acme-staging/api", state: "running" });
// Version 2: no cooldown, 2 attempts per resource, 5 at once.
await wf.saveDraft(alice, p.id, { ...v1.draft, limits: { maxConcurrentRuns: 5, cooldownSeconds: 0, maxAttempts: 2, attemptWindowSeconds: 3600 } });
const pv = await wf.previewWorkflow(alice, p.id);
await wf.publishWorkflow(alice, p.id, pv.previewHash);
const v2 = await wf.activeVersion(p.id);
const start2 = (key) => settle(wf.startWorkflowRun({ version: v2, delegator: alice, trigger: { type: "event", at: Date.now(), resourceKey: key }, resourceKey: key }));
out.v2second = await start2("ecs-service:us-east-1/acme-staging/api");
out.v2third = await start2("ecs-service:us-east-1/acme-staging/api");
out.otherResource = await start2("ecs-service:us-east-1/acme-staging/worker");
`);
  assert.equal(o.second.code, "workflow_limit");
  assert.match(o.second.error, /still going \(limit 1\)/);
  assert.equal(o.cooldown.code, "workflow_limit");
  assert.match(o.cooldown.error, /^cooldown/);
  assert.ok(o.v2second.ok, `a child run is no attempt (nor a concurrent run): ${JSON.stringify(o.v2second)}`);
  assert.equal(o.v2third.code, "workflow_limit");
  assert.match(o.v2third.error, /^maximum attempts: 2 run/);
  assert.ok(o.otherResource.ok, "the limits are per resource");
});

test("daily digest as a developer: an optional read it can't make is reported, not fatal; conditions, waits and a person's go-ahead", () => {
  const o = run(`
const dev = await mk("dev@acme.test", "developer");
const p = await publish(dev, { draft: T.templateDraft("daily-digest") });
const r = await wf.startManualRun(dev, p.id, {});
const done = await drive(r);
const report = JSON.parse((await store.getSteps(r)).find((s) => s.kind === "notify").result).report;
out.digest = { state: done.state, error: done.error, headline: report.headline, text: report.text };
const gate = {
  format: 1, name: "Gate", inputs: [{ name: "n", type: "number", default: 2 }], connectionId: "", triggers: [{ type: "manual" }],
  steps: [
    { id: "envs", kind: "tool", op: "envs.list", input: {} },
    { id: "many", kind: "condition", expr: "len(steps.envs.result) > inputs.n" },
    { id: "pause", kind: "wait", seconds: 1 },
    { id: "ok", kind: "approval", message: "Go on with more than {{inputs.n}} environments?", when: "steps.many.result.value" },
    { id: "never", kind: "notify", to: "run", message: "not reached", when: "not steps.many.result.value" },
    { id: "done", kind: "notify", to: "run", report: "text", message: "{{inputs.n}}: {{steps.many.result.value}}" },
  ],
  policy: DEFAULT_POLICIES["daily-digest"], limits: { maxConcurrentRuns: 2, cooldownSeconds: 0, maxAttempts: 10, attemptWindowSeconds: 3600 },
};
const g = await publish(dev, { draft: gate });
const gr = await wf.startManualRun(dev, g.id, {});
let waitingStep;
for (let i = 0; i < 40 && waitingStep?.state !== "waiting"; i++) {
  await worker.tick({ wait: true, now: Date.now() + 120_000 });
  await sleep(250);
  waitingStep = (await store.getSteps(gr)).find((s) => s.kind === "approval");
}
out.gateWaiting = { run: (await runOf(gr)).state, step: waitingStep?.state, review: JSON.parse(waitingStep?.result ?? "{}").review };
out.reviewed = await settle(wf.reviewRun(dev, g.id, gr, "continue"));
const gd = await drive(gr, 20);
const gsteps = await store.getSteps(gr);
out.gate = { state: gd.state, error: gd.error, steps: gsteps.map((s) => s.name + ":" + s.state), report: JSON.parse(gsteps.filter((s) => s.kind === "notify" && s.result).pop()?.result ?? "{}").report?.headline };
out.debug2 = gsteps.map((s) => [s.name, s.kind, s.state, s.error, s.result, s.wake_at]);
`);
  assert.equal(o.digest.state, "succeeded", JSON.stringify(o.digest));
  assert.match(o.digest.headline, /^Daily digest: \d+ change\(s\), \d+ problem\(s\), \d+ CI failure\(s\), \d+ pending approval\(s\)$/);
  assert.match(o.digest.text, /Spend\n- couldn't be read: .*operator/, "a developer can't read spend: reported in the digest");
  assert.equal(o.gateWaiting.run, "waiting_external");
  assert.ok(o.reviewed.ok, JSON.stringify(o.reviewed));
  assert.equal(o.gateWaiting.step, "waiting");
  assert.equal(o.gateWaiting.review.message, "Go on with more than 2 environments?");
  assert.ok(o.gateWaiting.review.expiresAt > Date.now(), "a go-ahead is asked for until the run's time limit");
  assert.equal(o.gate.state, "succeeded", JSON.stringify(o.debug2));
  assert.ok(o.gate.steps.includes("not reached:skipped") || o.gate.steps.some((s: string) => s.endsWith(":skipped")), JSON.stringify(o.gate.steps));
  assert.equal(o.gate.report, "2: true");
});

test("schedules: one run per slot (retries and consoles), missed slots skipped, revocation before the next fire; event triggers deduped", () => {
  const o = run(`
const draft = {
  format: 1, name: "Status every five minutes", inputs: [], targets: undefined, connectionId: "",
  triggers: [{ type: "schedule", cron: "*/5 * * * *", tz: "UTC" }, { type: "manual" }, { type: "event", source: "state", selector: { envs: ["staging"] } }],
  steps: [{ id: "status", kind: "tool", op: "envs.list", input: {} }, { id: "report", kind: "notify", to: "run", report: "text", message: "ok" }],
  policy: DEFAULT_POLICIES["daily-digest"], limits: { maxConcurrentRuns: 10, cooldownSeconds: 0, maxAttempts: 100, attemptWindowSeconds: 3600 },
};
const p = await publish(alice, { draft });
const s = await db.get("SELECT * FROM schedules WHERE workflow_id = ?", [p.id]);
const slot = Number(s.next_at);
out.slotOnFive = new Date(slot).getUTCMinutes() % 5 === 0 && slot > Date.now();
const runs = async () => Number((await db.get("SELECT COUNT(*) AS n FROM agent_runs WHERE workflow_id = ? AND json_extract(trigger, '$.type') = 'schedule'", [p.id])).n);
const t1 = await sched.tick(slot + 1_000);
out.first = { fired: t1.fired.length, key: t1.fired[0]?.key, runs: await runs() };
out.keyShape = t1.fired[0]?.key === "wf:" + p.id + ":1:" + new Date(slot).toISOString();
out.again = (await sched.tick(slot + 2_000)).fired.length;
// Another console read the row before this one moved it: the same slot can't fire twice.
await db.run("UPDATE schedules SET next_at = ? WHERE id = ?", [slot, s.id]);
out.otherConsole = { fired: (await sched.tick(slot + 3_000)).fired.length, runs: await runs() };
// Two consoles at once on the next slot: one run.
const s2 = await db.get("SELECT next_at FROM schedules WHERE id = ?", [s.id]);
const both = await Promise.all([sched.tick(Number(s2.next_at) + 1_000), sched.tick(Number(s2.next_at) + 1_000)]);
out.concurrent = { fired: both[0].fired.length + both[1].fired.length, runs: await runs() };
// The run itself goes through to the end.
const firstRun = (await db.get("SELECT id FROM agent_runs WHERE workflow_id = ? ORDER BY created_at LIMIT 1", [p.id])).id;
out.firstRun = (await drive(firstRun)).state;
// A slot missed by more than 15 minutes is skipped, not replayed.
const s3 = await db.get("SELECT next_at FROM schedules WHERE id = ?", [s.id]);
const late = await sched.tick(Number(s3.next_at) + 20 * 60_000);
out.missed = { fired: late.fired.length, why: late.skipped[0]?.why, runs: await runs(), moved: Number((await db.get("SELECT next_at FROM schedules WHERE id = ?", [s.id])).next_at) > Number(s3.next_at) };
// Event triggers: entering DOWN fires once per resource and bucket; moving between DOWN and DEGRADED doesn't.
const ev = (state, previous) => ({ source: "state", env: "staging", key: "service:api", resourceKey: "ecs:service/acme-staging/api", aliases: ["ecs-service:us-east-1/acme-staging/api"], kind: "service", name: "api", state, previous, at: Date.now() });
sched.queueEvent(ev("DOWN", "UP"));
const e1 = await sched.tick(Date.now());
sched.queueEvent(ev("DOWN", "UP"));
const e2 = await sched.tick(Date.now());
sched.queueEvent(ev("DEGRADED", "DOWN"));
sched.queueEvent({ ...ev("DOWN", "UP"), env: "production", key: "service:api", resourceKey: "ecs:service/acme-production/api", aliases: [] });
const e3 = await sched.tick(Date.now());
// Queued while agents were off (no tick ran): too old to act on.
sched.queueEvent({ ...ev("DOWN", "UP"), resourceKey: "ecs:service/acme-staging/web", at: Date.now() - 20 * 60_000 });
const e4 = await sched.tick(Date.now());
out.events = { first: e1.fired.length, dup: e2.fired.length, other: e3.fired.length, stale: e4.fired.length, staleWhy: e4.skipped[0]?.why };
const home = "us-east-1";
out.eventKeys = [
  sched.eventResourceKey({ id: "staging", region: "us-east-1", cluster: "acme-staging" }, { kind: "service", key: "service:api", id: "api" }, home),
  sched.eventResourceKey({ id: "eu", region: "eu-west-1", cluster: "acme-eu" }, { kind: "service", key: "service:api", id: "api" }, home),
  sched.eventResourceKey({ id: "staging", region: "us-east-1", cluster: "acme-staging" }, { kind: "database", key: "database:orders-db", id: "orders-db" }, home),
  sched.eventResourceKey({ id: "staging", region: "us-east-1", cluster: "acme-staging" }, { kind: "box", key: "box:i-0abc", id: "i-0abc" }, home),
  sched.eventResourceKey({ id: "staging", region: "us-east-1", cluster: "acme-staging" }, { kind: "queue", key: "queue:jobs", id: "jobs" }, home),
];
const { findResource } = await import(src("lib/server/inventory.ts"));
out.onMap = !!(await findResource(out.eventKeys[0]));
const evRun = await runOf(e1.fired[0].runId);
out.eventRun = { key: evRun.resource_key, trigger: JSON.parse(evRun.trigger).event.state };
// The run knows the environment and service the event is about (the remediation template's verify step reads them).
await drive(evRun.id);
out.eventFacts = JSON.parse((await store.getSteps(evRun.id))[0].result).facts;
out.matches = [
  sched.matches({ envs: ["staging"] }, ev("DOWN", "UP")), sched.matches({ envs: ["staging"] }, ev("DOWN", "DEGRADED")), sched.matches({ envs: ["staging"], states: ["DOWN"] }, ev("DOWN", "DEGRADED")),
  sched.matches({ keys: ["service:web"] }, ev("DOWN", "UP")), sched.matches({ keys: ["ecs-service:us-east-1/acme-staging/api"], kinds: ["service"] }, ev("DOWN", "UP")),
];
// Superseded: publishing version 2 stops version 1's schedule.
await wf.saveDraft(alice, p.id, { ...draft, name: "Status v2" });
const pv = await wf.previewWorkflow(alice, p.id);
await wf.publishWorkflow(alice, p.id, pv.previewHash);
out.superseded = (await db.all("SELECT workflow_version, enabled FROM schedules WHERE workflow_id = ? ORDER BY workflow_version", [p.id])).map((x) => [Number(x.workflow_version), Number(x.enabled)]);
// A disabled publisher: the slot is recorded with no run.
await db.run("UPDATE users SET disabled = 1 WHERE id = ?", [alice.id]);
const s4 = await db.get("SELECT * FROM schedules WHERE workflow_id = ? AND enabled = 1", [p.id]);
const off = await sched.tick(Number(s4.next_at) + 1_000);
out.publisherGone = { fired: off.fired.length, why: off.skipped[0]?.why, fire: (await db.get("SELECT run_id FROM trigger_fires WHERE dedupe_key = ?", [off.skipped[0]?.key]))?.run_id ?? "none" };
await db.run("UPDATE users SET disabled = 0 WHERE id = ?", [alice.id]);
// Disable: nothing fires again, and a run in flight ends at its next step.
const inflight = await wf.startManualRun(alice, p.id, {});
await wf.disableWorkflow(alice, p.id);
const s5 = await db.get("SELECT * FROM schedules WHERE workflow_id = ? AND workflow_version = 2", [p.id]);
out.disabled = { enabled: Number(s5.enabled), fired: (await sched.tick(Number(s5.next_at) + 1_000)).fired.length };
const ended = await drive(inflight, 5);
out.inflight = { state: ended.state, error: ended.error };
out.manualAfter = await settle(wf.startManualRun(alice, p.id, {}));
`);
  assert.equal(o.slotOnFive, true);
  assert.deepEqual([o.first.fired, o.first.runs], [1, 1]);
  assert.equal(o.keyShape, true, "dedupe key wf:<id>:<version>:<fireTimeIso>");
  assert.equal(o.again, 0);
  assert.deepEqual(o.otherConsole, { fired: 0, runs: 1 });
  assert.deepEqual(o.concurrent, { fired: 1, runs: 2 });
  assert.equal(o.firstRun, "succeeded");
  assert.equal(o.missed.fired, 0);
  assert.match(o.missed.why, /missed by 20 min/);
  assert.equal(o.missed.runs, 2);
  assert.equal(o.missed.moved, true);
  assert.deepEqual({ ...o.events, staleWhy: undefined }, { first: 1, dup: 0, other: 0, stale: 0, staleWhy: undefined });
  assert.match(o.events.staleWhy, /20 min old — skipped/);
  assert.deepEqual(o.eventRun, { key: "ecs:service/acme-staging/api", trigger: "DOWN" });
  assert.deepEqual(o.eventFacts, { resourceKey: "ecs:service/acme-staging/api", env: "staging", service: "api" });
  assert.deepEqual(o.eventKeys, ["ecs:service/acme-staging/api", "ecs:service/acme-eu/api@eu-west-1", "rds:orders-db", "ec2:i-0abc", "staging/queue:jobs"]);
  assert.equal(o.onMap, true, "an event's resource key is one the cloud map (and so a model step's runner) knows");
  assert.deepEqual(o.matches, [true, false, true, false, true], "entering one of the states (not moving between them), by env, key and kind");
  assert.deepEqual(o.superseded, [[1, 0], [2, 1]]);
  assert.equal(o.publisherGone.fired, 0);
  assert.match(o.publisherGone.why, /disabled or no longer exists/);
  assert.equal(o.publisherGone.fire, "none");
  assert.deepEqual(o.disabled, { enabled: 0, fired: 0 });
  assert.equal(o.inflight.state, "cancelled");
  assert.match(o.inflight.error, /disabled/);
  assert.equal(o.manualAfter.code, "not_published");
});

test("agent operations: operations.get hides params and other runs' changes; runs are private; variables.compare shows no values or digests", () => {
  const o = run(`
const bob = await mk("bob@acme.test", "developer");
const mine = { user: alice, via: "session", actor: alice.email };
const agentRun = async (who) => {
  const id = crypto.randomUUID();
  const pol = DEFAULT_POLICIES["incident-investigator"];
  const { policyHash } = await import(src("lib/agents/policy.ts"));
  const principal = { id: "agent:" + id, kind: "agent", runId: id, delegatorId: who.id, delegatorEmail: who.email, policyHash: policyHash(pol), mode: pol.mode };
  await store.createRun({ id, kind: "external", title: "t", initiatorId: who.id, principal, policy: pol, state: "running", deadlineAt: Date.now() + 3_600_000 });
  return principal;
};
const pa = await agentRun(alice);
const pb = await agentRun(bob);
const agentCtx = (p) => ({ user: alice, via: "agent", actor: "agent", principal: p, runId: p.runId });
const opId = crypto.randomUUID();
await db.run("INSERT INTO operations (id, idempotency_key, action, actor, actor_kind, run_id, targets, input_hash, plan_hash, params, state, result, error, created_at) VALUES (?, ?, 'services.restart', 'agent run', 'agent', ?, '{}', 'sha256:in', 'sha256:plan', ?, 'outcome_unknown', ?, 'timed out after sending', ?)",
  [opId, "run:" + pa.runId + ":step:x", pa.runId, JSON.stringify({ env: "staging", secret: "hunter2-sentinel" }), JSON.stringify({ requestId: "r-sentinel" }), Date.now()]);
const got = await opRun("operations.get")({ id: opId }, agentCtx(pa));
out.view = got;
out.viewText = JSON.stringify(got);
out.otherAgent = await settle(opRun("operations.get")({ id: opId }, agentCtx(pb)));
out.person = (await opRun("operations.get")({ id: opId }, mine)).state;
out.listOwn = (await opRun("operations.list")({ state: "outcome_unknown" }, agentCtx(pa))).map((x) => x.id);
out.listOther = (await opRun("operations.list")({ runId: pa.runId }, agentCtx(pb))).length;
out.runOwn = (await opRun("runs.get")({ id: pa.runId }, agentCtx(pa))).id === pa.runId;
out.runOther = await settle(opRun("runs.get")({ id: pa.runId }, agentCtx(pb)));
out.runByBob = await settle(opRun("runs.get")({ id: pa.runId }, { user: bob, via: "session" }));
out.runsListAgent = (await opRun("runs.list")({}, agentCtx(pa))).map((r) => r.id);
out.agentStart = await settle(opRun("runs.start")({ workflowId: "x" }, agentCtx(pa)));
out.startBoth = await settle(opRun("runs.start")({ workflowId: "x", goal: "why" }, mine));
const cmp = await opRun("variables.compare")({ envs: ["staging", "production"], services: ["api", "nosuch"] }, mine);
out.cmp = cmp;
// Nothing that looks like a value or a fingerprint (HMAC digests are 43 base64url characters).
out.cmpText = JSON.stringify(cmp);
const { varFingerprints } = await import(src("lib/server/envvars.ts"));
const fps = (await varFingerprints("staging", "api")).map((f) => f.fingerprint).filter(Boolean);
out.leaks = fps.filter((f) => out.cmpText.includes(f)).length;
out.fpCount = fps.length;
out.workflows = await opRun("workflows.list")({}, mine);
`);
  for (const k of ["params", "inputHash", "planHash", "input_hash", "plan_hash", "result", "idempotencyKey", "runId"]) assert.ok(!(k in o.view), `operations.get leaks ${k}`);
  assert.ok(!/hunter2|r-sentinel|sha256:/.test(o.viewText), o.viewText);
  assert.equal(o.view.state, "outcome_unknown");
  assert.equal(o.view.action, "services.restart");
  assert.equal(o.otherAgent.status, 404, "an agent sees only its run's operations");
  assert.equal(o.person, "outcome_unknown");
  assert.equal(o.listOwn.length, 1);
  assert.equal(o.listOther, 0);
  assert.equal(o.runOwn, true);
  assert.equal(o.runOther.status, 404);
  assert.equal(o.runByBob.status, 404, "a person sees the runs they started");
  assert.equal(o.runsListAgent.length, 1);
  assert.equal(o.agentStart.status, 403);
  assert.equal(o.startBoth.status, 400);
  assert.deepEqual(o.cmp.envs, ["staging", "production"]);
  const api = o.cmp.services.find((s: { service: string }) => s.service === "api");
  assert.ok(api.variables.length > 0);
  for (const v of api.variables) {
    assert.ok(["same", "different", "missing"].includes(v.status), JSON.stringify(v));
    for (const s of Object.values(v.envs)) assert.ok(["same", "different", "missing", "unknown"].includes(s as string));
    assert.deepEqual(Object.keys(v).filter((k) => !["name", "status", "envs", "sourceDiffers"].includes(k)), []);
  }
  assert.ok(api.variables.some((v: { status: string }) => v.status === "different"), "staging and production differ somewhere (database URLs)");
  assert.deepEqual(o.cmp.services.find((s: { service: string }) => s.service === "nosuch").missingIn, ["staging", "production"]);
  assert.ok(o.fpCount > 0);
  assert.equal(o.leaks, 0, "no fingerprint reaches the output");
  assert.ok(!/pg-[a-z]+-staging-pass/.test(o.cmpText), "no value reaches the output");
  assert.deepEqual(o.workflows, []);
});

test("agent definitions: versions, config hash, archive, built-ins, validation and who may change them", () => {
  const o = run(`
const viewer = await mk("val@acme.test", "viewer");
const dev = await mk("dev@acme.test", "developer");
const { resolveDefinition } = await import(src("lib/server/auth/agent-tokens.ts"));
const d1 = await defs.createDefinition(alice, { name: "Release helper", template: "incident-investigator", instructions: "Read only, explain." });
const d2 = await defs.saveDefinition(alice, d1.id, { action: "save", instructions: "Read only, explain briefly." });
out.versions = [d1.version, d2.version, d1.configHash !== d2.configHash, d1.policyHash === d2.policyHash];
out.same = (await defs.saveDefinition(alice, d1.id, { action: "save", instructions: "Read only, explain briefly." })).version;
out.resolved = (await resolveDefinition(d1.id))?.version;
out.detail = Object.keys((await defs.getDefinition(d1.id)).definition).sort();
out.list = (await defs.listDefinitions()).map((d) => d.id === d1.id ? "mine" : d.builtIn ? d.id : "other");
out.viewer = await settle(defs.createDefinition(viewer, { name: "x", template: "daily-digest" }));
out.notOwner = await settle(defs.saveDefinition(dev, d1.id, { action: "save", name: "mine now" }));
const bad = JSON.parse(JSON.stringify(DEFAULT_POLICIES["incident-investigator"]));
bad.tools.act = ["variables.update"];
bad.mode = "bounded-act";
out.denied = await settle(defs.createDefinition(dev, { name: "x", policy: bad }));
out.unknown = await settle(defs.createDefinition(dev, { name: "x", template: "daily-digest", extra: 1 }));
out.builtIn = await settle(defs.saveDefinition(alice, "daily-digest", { action: "save", name: "x" }));
await defs.archiveDefinition(alice, d1.id);
out.archived = (await resolveDefinition(d1.id)) ?? "gone";
out.audit = (await db.all("SELECT action FROM audit WHERE action LIKE 'agent_definition.%' ORDER BY at")).map((r) => r.action);
`);
  assert.deepEqual(o.versions, [1, 2, true, true]);
  assert.equal(o.same, 2, "an unchanged save is no new version");
  assert.equal(o.resolved, 2, "tokens bind the newest version");
  assert.ok(o.detail.includes("instructions") && o.detail.includes("policy") && o.detail.includes("configHash"));
  assert.deepEqual(o.list, ["mine", "incident-investigator", "approved-remediation", "nonproduction-schedule", "daily-digest", "cost-review", "config-drift"]);
  assert.equal(o.viewer.status, 403);
  assert.equal(o.notOwner.status, 403);
  assert.equal(o.denied.status, 400);
  assert.match(o.denied.error, /agents can never use variables\.update/);
  assert.match(o.unknown.error, /unknown field extra/);
  assert.equal(o.builtIn.status, 409);
  assert.equal(o.archived, "gone");
  assert.deepEqual(o.audit, ["agent_definition.create", "agent_definition.save", "agent_definition.archive"]);
});

test("a model step runs the agent runner as a child run on the event's resource; disabling the workflow ends both", () => {
  const o = run(`
// The runner's handlers first, then the workflow's around them (as the worker loads them).
const runner = await import(src("lib/server/agents/runner.ts"));
runner.registerHandlers();
await steps.registerHandlers();
const p = await publish(alice, { template: "incident-investigator", options: { envs: ["staging"], connectionId: "scripted:demo" } });
sched.queueEvent({ source: "state", env: "staging", key: "service:api", resourceKey: "ecs:service/acme-staging/api", kind: "service", name: "api", state: "DEGRADED", previous: "UP", at: Date.now() });
const t = await sched.tick(Date.now());
const parent = t.fired[0]?.runId;
let child;
for (let i = 0; i < 80 && !(child && ["waiting_approval", "succeeded", "failed", "cancelled"].includes(child.state)); i++) {
  await worker.tick({ wait: true, now: Date.now() + 120_000 });
  await sleep(250);
  const row = await db.get("SELECT id FROM agent_runs WHERE parent_run_id = ?", [parent]);
  child = row ? await runOf(row.id) : undefined;
}
out.child = { state: child?.state, key: child?.resource_key, sameWorkflow: child?.workflow_id === p.id, error: child?.error };
out.parent = { state: (await runOf(parent)).state, model: (await store.getSteps(parent)).find((s) => s.kind === "model")?.state };
out.debug = (await store.getSteps(parent)).map((s) => [s.name, s.kind, s.state, s.error]);
// Another event for the same resource while it runs: the child run is no second concurrent run of its own.
out.limits = await settle(wf.startWorkflowRun({ version: await wf.activeVersion(p.id), delegator: alice, trigger: { type: "manual", at: Date.now() }, resourceKey: "ecs:service/acme-staging/worker" }));
await wf.disableWorkflow(alice, p.id);
const ended = await drive(parent, 10);
out.after = { parent: ended.state, parentError: ended.error, child: child ? (await runOf(child.id)).state : "none", childError: child ? (await runOf(child.id)).error : "" };
`);
  assert.equal(o.child.state, "waiting_approval", `the investigation proposes one action and waits for a person: ${JSON.stringify(o.child)} ${JSON.stringify(o.debug)}`);
  assert.equal(o.child.key, "ecs:service/acme-staging/api");
  assert.equal(o.child.sameWorkflow, true);
  assert.deepEqual(o.parent, { state: "waiting_external", model: "waiting" }, "the workflow run waits for its model step's child run");
  assert.ok(o.limits.ok, `concurrency counts the workflow's own runs (limit 2): ${JSON.stringify(o.limits)}`);
  assert.equal(o.after.parent, "cancelled");
  assert.match(o.after.parentError, /disabled/);
  assert.equal(o.after.child, "cancelled", "an agent run doesn't go on for a workflow that ended");
  assert.match(o.after.childError, /workflow run .* ended/);
});
