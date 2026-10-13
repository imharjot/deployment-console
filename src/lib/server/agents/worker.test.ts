// The agent worker, run store, reconciliation, persisted events and outbox (master plan §6 C2 item 8; AGENT_ARCHITECTURE
// §9.3 recovery), end to end in a child process (server modules import "server-only", which resolves only under the
// react-server condition) on in-memory SQLite — and, when PG_TEST_URL is set (node scripts/pg-test.mjs), on a fresh
// Postgres database too: the claim, lease and fence SQL is where the two differ.
//
// Covered: a crash before submission (no intent → requeue, no duplicate); remote acceptance followed by a lost response
// (outcome_unknown → verify, no blind retry); duplicate triggers (dedupe key); concurrent workers (one lease wins); lease
// expiry with a late completion rejected by the fence; an inference outage (paused run, while the verify of an accepted
// change proceeds); a lost SSE connection (replay by cursor); a notification failure (outbox retry, the change is not
// repeated); plus the emergency stop, the agents switch, handlers that aren't there yet, retries and deadlines; execute
// steps settled by their operations whatever the handler says; no starvation by steps the worker can't start;
// cancellation and draining of steps in flight; periodic tasks; the stop and switch routes (admin, audited); and the
// stream's live delivery, audiences for agent tokens, `?run=`, a cursor from another database and late commits.
import { after, test } from "node:test";
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

const PG = process.env.PG_TEST_URL;
const cleanup: (() => Promise<void>)[] = [];
after(async () => {
  for (const c of cleanup.reverse()) await c().catch(() => {});
});

async function freshPg(base: string): Promise<string> {
  const pg = (await import("pg")).default;
  const name = `dc_worker_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const admin = new pg.Client({ connectionString: base });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  cleanup.push(async () => {
    const a = new pg.Client({ connectionString: base });
    await a.connect();
    await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await a.end();
  });
  const u = new URL(base);
  u.pathname = `/${name}`;
  return u.toString();
}

function run(scenario: string, databaseUrl?: string) {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    CONSOLE_SOURCE: "mock",
    CONSOLE_SQLITE_PATH: ":memory:",
    CONSOLE_SECRET_KEY: randomBytes(36).toString("base64"),
    CONSOLE_TRUSTED_PROXIES: "0",
    NODE_ENV: "test",
  };
  if (databaseUrl) env.DATABASE_URL = databaseUrl;
  const raw = execFileSync(process.execPath, ["--conditions=react-server", "--no-warnings", "--import", `data:text/javascript,${encodeURIComponent(register)}`, "--input-type=module", "-e", prelude + scenario + "\nawait (await getDb()).close?.();\nprocess.exit(0);"], {
    encoding: "utf8",
    timeout: 180_000,
    env,
  });
  return JSON.parse(raw.trim().split("\n").filter((l) => l.startsWith("{")).pop()!);
}

const prelude = `
const src = (p) => new URL(p, ${JSON.stringify(SRC)}).href;
const { getDb } = await import(src("lib/server/db.ts"));
const store = await import(src("lib/server/agents/store.ts"));
const worker = await import(src("lib/server/agents/worker.ts"));
const { reconcileAgents } = await import(src("lib/server/agents/reconcile.ts"));
const events = await import(src("lib/server/agents/events.ts"));
const stop = await import(src("lib/server/agents/stop.ts"));
const { DEFAULT_POLICIES, policyHash } = await import(src("lib/agents/policy.ts"));
const db = await getDb();
const pol = DEFAULT_POLICIES["incident-investigator"];
const mkRun = async (state = "running", o = {}) => {
  const id = crypto.randomUUID();
  const principal = { id: "agent:" + id, kind: "agent", runId: id, delegatorId: "u1", delegatorEmail: "alice@acme.test", policyHash: policyHash(pol), mode: pol.mode };
  await store.createRun({ id, kind: "assistant", title: "t", initiatorId: "u1", principal, policy: pol, state, deadlineAt: Date.now() + 3_600_000, ...o });
  return id;
};
const step = (id) => db.get("SELECT * FROM agent_steps WHERE id = ?", [id]);
// An operations row as the coordinator writes it before anything reaches AWS (running = sent, no answer yet).
const opRow = (id, run, stepId, state, idem = null) =>
  db.run("INSERT INTO operations (id, idempotency_key, action, actor, actor_kind, run_id, step_id, targets, state, created_at) VALUES (?, ?, 'services.restart', 'agent', 'agent', ?, ?, '{}', ?, ?)", [id, idem, run, stepId, state, Date.now()]);
const ticks = async (n, at = () => Date.now()) => { for (let i = 0; i < n; i++) await worker.tick({ wait: true, now: at() }); };
const count = async (sql, args = []) => Number((await db.get(sql, args)).n);
const out = {};
`;

const core = `
// 1. Claim, run, record, append what comes next.
const calls = { tool: 0, execute: 0, verify: 0, model: 0, slow: 0 };
worker.registerStepHandler("tool", async (s) => (calls.tool++, { state: "succeeded", result: { n: calls.tool }, next: s.name === "first" ? [{ kind: "tool", name: "second", retrySafe: true }] : [] }));
const r1 = await mkRun();
const s1 = await worker.enqueueStep(r1, { kind: "tool", name: "first", retrySafe: true });
await worker.tick({ wait: true, now: Date.now() });
await worker.tick({ wait: true, now: Date.now() });
out.chain = (await store.getSteps(r1)).map((s) => [s.seq, s.name, s.state, s.fence, s.attempt]);

// 2. Concurrent workers: of five claims on one due step, exactly one wins.
const r2 = await mkRun();
const s2 = await store.appendStep(r2, { kind: "model" });
const claims = await Promise.all(["A", "B", "C", "D", "E"].map((o) => worker.claimStep(s2.id, "worker:" + o)));
out.claims = claims.filter(Boolean).length;
out.claimFence = Number((await step(s2.id)).fence);

// 3. Lease expiry: a stalled worker's late completion is rejected by the fence; the new owner's result stands.
let release;
const stalled = new Promise((r) => (release = r));
worker.registerStepHandler("slow", async () => {
  calls.slow++;
  if (calls.slow === 1) {
    await stalled;
    return { state: "succeeded", result: "A (late)" };
  }
  return { state: "succeeded", result: "B" };
});
const r3 = await mkRun();
const s3 = await worker.enqueueStep(r3, { kind: "slow", retrySafe: true });
await worker.tick({ now: Date.now(), owner: "worker:A" }); // A claims and stalls
await db.run("UPDATE agent_steps SET lease_until = 1 WHERE id = ?", [s3.id]); // its lease lapses
out.reconciled = await reconcileAgents(Date.now());
// Another worker (another console: this process still has A's handler in flight) claims it and finishes first.
const b = await worker.claimStep(s3.id, "worker:B");
out.bFinished = await worker.finishStep(b, { state: "succeeded", result: "B" });
release();
await new Promise((r) => setTimeout(r, 50));
const s3a = await step(s3.id);
out.fence = { state: s3a.state, result: JSON.parse(s3a.result), slowCalls: calls.slow, fence: Number(s3a.fence) };

// 4. A crash before submission: the execute step's worker died before any operation existed → requeued, no duplicate.
const r4 = await mkRun();
const s4 = await store.appendStep(r4, { kind: "execute", name: "services.restart", idempotencyKey: "grant:x" });
await db.run("UPDATE agent_steps SET state = 'leased', lease_owner = 'dead', lease_until = 1, fence = 1 WHERE id = ?", [s4.id]);
out.beforeSubmit = await reconcileAgents(Date.now());
const s4a = await step(s4.id);
out.requeued = { state: s4a.state, fence: Number(s4a.fence), ops: await count("SELECT COUNT(*) AS n FROM operations") };
// A step that took its worker down six times (claimed six times, never finished) is not requeued again.
const r4b = await mkRun();
const p4 = await store.appendStep(r4b, { kind: "execute", name: "services.restart" });
const q4 = await store.appendStep(r4b, { kind: "tool", retrySafe: true });
await db.run("UPDATE agent_steps SET state = 'leased', lease_owner = 'dead', lease_until = 1, fence = 6, attempt = 6 WHERE run_id = ?", [r4b]);
out.poison = await reconcileAgents(Date.now());
out.poisonSteps = [(await step(p4.id)).state, (await step(q4.id)).state, /6 times/.test((await step(p4.id)).error)];

// 5. Remote acceptance, then the response was lost: the operation is running → outcome_unknown + verify, never re-run.
const executed = [];
worker.registerStepHandler("execute", async (s) => (calls.execute++, executed.push(s.id), { state: "succeeded" }));
worker.registerStepHandler("verify", async (s) => (calls.verify++, { state: "succeeded", result: { checked: JSON.parse(s.input).operationId } }));
const r5 = await mkRun();
const s5 = await store.appendStep(r5, { kind: "execute", name: "services.restart" });
await db.run("UPDATE agent_steps SET state = 'leased', lease_owner = 'dead', lease_until = 1, fence = 3 WHERE id = ?", [s5.id]);
await db.run("INSERT INTO operations (id, action, actor, actor_kind, run_id, step_id, targets, state, created_at) VALUES ('op-lost', 'services.restart', 'agent', 'agent', ?, ?, '{}', 'running', ?)", [r5, s5.id, Date.now()]);
out.lost = await reconcileAgents(Date.now());
out.lostRun = (await store.getRun(r5)).state;
await worker.tick({ wait: true, now: Date.now() });
out.lostSteps = (await store.getSteps(r5)).map((s) => [s.kind, s.state, s.operation_id]);
out.executed = { lost: executed.includes(s5.id), requeued: executed.includes(s4.id) };
out.verifyCalls = calls.verify;

// 6. An inference outage: the run is paused — no model call — while the verify of an accepted change proceeds.
worker.registerStepHandler("model", async () => (calls.model++, { state: "succeeded" }));
const r6 = await mkRun();
const m6 = await store.appendStep(r6, { kind: "model", retrySafe: true });
const v6 = await store.appendStep(r6, { kind: "verify", input: { operationId: "op-x" }, retrySafe: true });
await store.updateRun(r6, { state: "paused_auth", error: "the model connection needs signing in again" });
const before = calls.model;
await worker.tick({ wait: true, now: Date.now() });
out.outage = { model: (await step(m6.id)).state, verify: (await step(v6.id)).state, modelCalls: calls.model - before };

// 7. Duplicate triggers: one run per dedupe key.
out.triggers = [await store.claimTriggerFire({ dedupeKey: "wf:w1:1:2026-10-05T03:00:00.000Z", workflowId: "w1" }), await store.claimTriggerFire({ dedupeKey: "wf:w1:1:2026-10-05T03:00:00.000Z", workflowId: "w1" })];

// 8. Emergency stop: execute steps wait (not claimed); lifted, they run.
const r8 = await mkRun();
const s8 = await store.appendStep(r8, { kind: "execute", name: "services.restart" });
await stop.setEmergencyStop(true, "admin@acme.test", "drill");
const ex0 = calls.execute;
await worker.tick({ wait: true, now: Date.now() });
const s8a = await step(s8.id);
out.stopped = { state: s8a.state, error: s8a.error, ran: calls.execute - ex0 };
await stop.setEmergencyStop(false, "admin@acme.test", "over");
await worker.tick({ wait: true, now: Date.now() + 6_000 });
out.afterStop = { state: (await step(s8.id)).state, ran: calls.execute - ex0 };

// 9. Agents off: nothing is claimed.
await stop.setAgentsEnabled(false, "admin@acme.test");
const r9 = await mkRun();
const s9 = await store.appendStep(r9, { kind: "tool", name: "x" });
out.offClaimed = await worker.tick({ wait: true, now: Date.now() });
await stop.setAgentsEnabled(true, "admin@acme.test");
out.offState = (await step(s9.id)).state;

// 10. A kind without a handler stays queued; retries only for retry-safe steps; execute steps never retry.
const r10 = await mkRun();
const s10 = await store.appendStep(r10, { kind: "notify" });
worker.registerStepHandler("condition", async () => { throw new Error("flaky"); });
const safe = await store.appendStep(r10, { kind: "condition", retrySafe: true });
const unsafe = await store.appendStep(r10, { kind: "condition" });
const now10 = Date.now();
await worker.tick({ wait: true, now: now10 });
const sa = await step(safe.id), un = await step(unsafe.id);
out.retry = { noHandler: (await step(s10.id)).state, safe: [sa.state, Number(sa.attempt), Number(sa.wake_at) > now10, sa.error], unsafe: [un.state, un.error] };
worker.registerStepHandler("wait", async () => ({ state: "failed", error: "boom" }));
const ex = await store.appendStep(r10, { kind: "wait", retrySafe: true });
await worker.tick({ wait: true, now: Date.now() });
out.failedOutcome = (await step(ex.id)).state;

// 11. A run past its deadline fails; its queued steps are cancelled, its verify steps keep going.
const r11 = await mkRun("running", { deadlineAt: Date.now() - 1 });
const q11 = await store.appendStep(r11, { kind: "notify" });
const v11 = await store.appendStep(r11, { kind: "verify", input: { operationId: "op-y" } });
await reconcileAgents(Date.now());
out.deadline = { run: (await store.getRun(r11)).state, error: (await store.getRun(r11)).error, queued: (await step(q11.id)).state, verify: (await step(v11.id)).state };
const ext = await mkRun("running", { kind: "external", deadlineAt: Date.now() - 1 });
await reconcileAgents(Date.now());
out.externalExpired = (await store.getRun(ext)).state;

// 12. Run state machine: an ended run can't be revived; outcome_unknown settles only by reconciliation.
out.revive = await store.updateRun(r11, { state: "running" }).then(() => "moved", (e) => e.status);
const r12 = await mkRun();
await store.updateRun(r12, { state: "outcome_unknown" });
out.unknownPlain = await store.updateRun(r12, { state: "succeeded" }).then(() => "moved", (e) => e.status);
out.unknownReconciled = (await store.updateRun(r12, { state: "succeeded" }, { reconcile: true })).state;
// A run that ends drops the steps it hadn't started, at once — but keeps checking what it changed.
const r13 = await mkRun();
const q13 = await store.appendStep(r13, { kind: "model" });
const v13 = await store.appendStep(r13, { kind: "verify", input: { operationId: "op-q" } });
await store.updateRun(r13, { state: "cancelled", error: "a person cancelled it" });
out.endedSteps = [(await step(q13.id)).state, (await step(v13.id)).state];
out.endedEvents = (await events.readSince(0, { runId: r13 })).filter((e) => e.type === "step").map((e) => JSON.parse(e.payload).state);

// 13. Run events were persisted in order with their run ids.
const runEvents = await events.readSince(0, { runId: r12 });
out.runEvents = runEvents.filter((e) => e.type === "run").map((e) => JSON.parse(e.payload).state);
out.monotonic = runEvents.every((e, i) => i === 0 || e.seq > runEvents[i - 1].seq);

// 14. Model calls are stored redacted and sealed.
const id = await store.recordModelCall({ runId: r12, provider: "anthropic", model: "m", state: "completed", transcript: { messages: [{ role: "user", content: "key AKIAIOSFODNN7EXAMPLE password=hunter2hunter2" }] }, startedAt: Date.now() });
const mc = await db.get("SELECT transcript FROM agent_model_calls WHERE id = ?", [id]);
const { unseal } = await import(src("lib/server/secrets.ts"));
const opened = unseal(mc.transcript);
out.transcript = { sealed: mc.transcript.startsWith("v1:"), redacted: !/AKIAIOSFODNN7EXAMPLE|hunter2hunter2/.test(opened) };
console.log(JSON.stringify(out));
`;

function checkCore(o: Record<string, unknown> & { [k: string]: never }) {
  const x = o as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  assert.deepEqual(x.chain, [[1, "first", "succeeded", 1, 1], [2, "second", "succeeded", 1, 1]]);
  assert.equal(x.claims, 1, "one lease wins");
  assert.equal(x.claimFence, 1);
  assert.equal(x.reconciled.requeued, 1);
  assert.equal(x.bFinished, true);
  assert.deepEqual(x.fence, { state: "succeeded", result: "B", slowCalls: 1, fence: 3 }, "the stalled worker's late result is rejected by the fence");
  assert.equal(x.beforeSubmit.requeued, 1);
  assert.deepEqual(x.requeued, { state: "queued", fence: 2, ops: 0 });
  assert.equal(x.poison.failed, 2);
  assert.deepEqual(x.poisonSteps, ["failed", "failed", true], "a step that keeps taking its worker down isn't requeued forever");
  assert.equal(x.lost.unknown, 1);
  assert.equal(x.lostRun, "waiting_external");
  assert.deepEqual(x.lostSteps, [["execute", "outcome_unknown", "op-lost"], ["verify", "succeeded", null]]);
  assert.deepEqual(x.executed, { lost: false, requeued: true }, "the lost one is never retried blindly; the one that never reached AWS runs again");
  assert.equal(x.verifyCalls, 1);
  assert.deepEqual(x.outage, { model: "queued", verify: "succeeded", modelCalls: 0 });
  assert.deepEqual(x.triggers, [true, false]);
  assert.deepEqual(x.stopped, { state: "waiting", error: "emergency stop", ran: 0 });
  assert.deepEqual(x.afterStop, { state: "succeeded", ran: 1 });
  assert.equal(x.offClaimed, 0);
  assert.equal(x.offState, "queued");
  assert.equal(x.retry.noHandler, "queued");
  assert.equal(x.retry.safe[0], "queued");
  assert.equal(x.retry.safe[1], 1);
  assert.equal(x.retry.safe[2], true, "with backoff");
  assert.match(x.retry.safe[3], /flaky/);
  assert.deepEqual(x.retry.unsafe, ["failed", "flaky"]);
  assert.equal(x.failedOutcome, "queued", "a retry-safe step that reports a failure is retried too");
  assert.deepEqual(x.deadline, { run: "failed", error: "deadline exceeded", queued: "cancelled", verify: "queued" });
  assert.equal(x.externalExpired, "cancelled");
  assert.equal(x.revive, 409);
  assert.equal(x.unknownPlain, 409);
  assert.equal(x.unknownReconciled, "succeeded");
  assert.deepEqual(x.endedSteps, ["cancelled", "queued"]);
  assert.deepEqual(x.endedEvents, ["queued", "queued", "cancelled"], "the timeline hears about the dropped step");
  assert.deepEqual(x.runEvents, ["running", "outcome_unknown", "succeeded"]);
  assert.equal(x.monotonic, true);
  assert.deepEqual(x.transcript, { sealed: true, redacted: true });
}

const outbox = `
// A notification failure: the outbox retries only the integration that failed; nothing the agent did is repeated.
const r = await mkRun();
await store.updateRun(r, { state: "failed", error: "the model refused" });
const rows = await db.all("SELECT * FROM outbox");
out.queued = rows.map((x) => [x.target, x.state]);
const { deliverOutbox } = await import(src("lib/server/agents/outbox.ts"));
const sent = [];
const failing = async (e, only) => (sent.push([e.type, only ?? "all"]), only ? { delivered: [], failed: [only] } : { delivered: ["webhook"], failed: ["slack"] });
out.first = await deliverOutbox({ now: Date.now(), deliver: failing });
out.afterFirst = (await db.all("SELECT target, state, attempts FROM outbox ORDER BY created_at")).map((x) => [x.target, x.state, Number(x.attempts)]);
out.tooSoon = await deliverOutbox({ now: Date.now(), deliver: failing });
out.second = await deliverOutbox({ now: Date.now() + 120_000, deliver: failing });
const ok = async (e, only) => (sent.push([e.type, only ?? "all"]), { delivered: [only], failed: [] });
out.third = await deliverOutbox({ now: Date.now() + 3_600_000, deliver: ok });
out.final = (await db.all("SELECT target, state, attempts FROM outbox ORDER BY created_at")).map((x) => [x.target, x.state, Number(x.attempts)]);
out.sent = sent;
out.ops = await count("SELECT COUNT(*) AS n FROM operations");
// An approval that was decided before delivery is not announced.
await db.run("INSERT INTO approvals (id, op, input, plan, requested_by, status, created_at, run_id) VALUES ('a1', 'services.restart', 'x', '{\\"summary\\":\\"Restart api\\"}', 'u1', 'approved', 1, ?)", [r]);
const seq = await events.publish("approval", { id: "a1", event: "created" }, { runId: r });
const { queueOutbox } = await import(src("lib/server/agents/outbox.ts"));
await queueOutbox(db, seq);
const before = sent.length;
await deliverOutbox({ now: Date.now() + 7_200_000, deliver: ok });
out.decidedSkipped = sent.length === before;
// Agents turned off: notifications already queued still go out from the worker loop (they change nothing).
await stop.setAgentsEnabled(false, "admin@acme.test");
const r2 = await mkRun();
await store.updateRun(r2, { state: "failed", error: "deadline exceeded" });
const pendingOf = async () => (await db.all("SELECT o.state FROM outbox o JOIN events e ON e.seq = o.event_seq WHERE e.run_id = ?", [r2])).map((x) => x.state);
out.offBefore = await pendingOf();
out.offClaimed = await worker.tick({ now: Date.now() + 10_000_000 });
for (let i = 0; i < 40 && (await pendingOf())[0] === "pending"; i++) await new Promise((res) => setTimeout(res, 50));
out.offAfter = await pendingOf();
console.log(JSON.stringify(out));
`;

function checkOutbox(x: Record<string, any>) { // eslint-disable-line @typescript-eslint/no-explicit-any
  assert.deepEqual(x.queued, [["integrations", "pending"]]);
  assert.deepEqual(x.first, { delivered: 0, failed: 1 });
  assert.deepEqual(x.afterFirst, [["integrations", "delivered", 1], ["integration:slack", "pending", 1]]);
  assert.deepEqual(x.tooSoon, { delivered: 0, failed: 0 }, "backoff");
  assert.deepEqual(x.second, { delivered: 0, failed: 1 });
  assert.deepEqual(x.third, { delivered: 1, failed: 0 });
  assert.deepEqual(x.final, [["integrations", "delivered", 1], ["integration:slack", "delivered", 3]]);
  assert.deepEqual(x.sent, [["agent.run_failed", "all"], ["agent.run_failed", "slack"], ["agent.run_failed", "slack"]]);
  assert.equal(x.ops, 0, "a delivery never repeats an operation");
  assert.equal(x.decidedSkipped, true);
  assert.deepEqual(x.offBefore, ["pending"]);
  assert.equal(x.offClaimed, 0);
  assert.deepEqual(x.offAfter, ["delivered"], "the switch stops agents, not the news about them");
}

const execute = `
// Execute steps: the operation records win over what the handler says, and an unknown outcome is verified, never retried.
const plan = {};
const ran = [];
worker.registerStepHandler("execute", async (s) => {
  ran.push(s.id);
  const p = plan[s.id] ?? {};
  if (p.op) await opRow(p.op[0], s.run_id, p.byKey ? null : s.id, p.op[1], p.byKey ? "run:" + s.run_id + ":step:" + s.id + "|services.restart|ecs:service/staging/api" : null);
  if (p.stopFirst) await stop.setEmergencyStop(true, "admin@acme.test", "drill");
  if (p.throw) throw new Error(p.throw);
  return p.ret ?? { state: "succeeded" };
});
worker.registerStepHandler("verify", async (s) => ({ state: "succeeded", result: { checked: JSON.parse(s.input).operationId } }));
const exec = async (p) => {
  const r = await mkRun();
  const s = await store.appendStep(r, { kind: "execute", name: "services.restart", idempotencyKey: "grant:" + r });
  plan[s.id] = p;
  return { r, s };
};
const cases = {
  thrownAccepted: await exec({ op: ["op-a", "running"], throw: "socket hang up" }),
  thrownSucceeded: await exec({ op: ["op-b", "succeeded"], throw: "bookkeeping failed" }),
  thrownNothing: await exec({ throw: "the plan changed" }),
  retryAsked: await exec({ op: ["op-c", "outcome_unknown"], ret: { state: "failed", error: "timeout", retry: true } }),
  handlerUnknown: await exec({ op: ["op-d", "running"], ret: { state: "outcome_unknown", error: "no answer" } }),
  byKey: await exec({ op: ["op-e", "running"], byKey: true, throw: "lost" }),
  bothFailed: await exec({ op: ["op-f", "failed"], ret: { state: "failed", error: "AccessDenied" } }),
  ownVerify: await exec({ op: ["op-g", "running"], ret: { state: "outcome_unknown", next: [{ kind: "verify", name: "mine", input: { operationId: "op-g" }, retrySafe: true }] } }),
};
await ticks(6);
out.exec = {};
for (const [k, { r, s }] of Object.entries(cases))
  out.exec[k] = { run: (await store.getRun(r)).state, steps: (await store.getSteps(r)).map((x) => [x.kind, x.state, x.operation_id]), ran: ran.filter((id) => id === s.id).length };
out.verifyInput = JSON.parse((await store.getSteps(cases.thrownAccepted.r))[1].input);

// Refused by the emergency stop after it was claimed (nothing reached AWS): it waits, then runs once lifted.
const held = await exec({ stopFirst: true, throw: "emergency stop is on" });
await worker.tick({ wait: true, now: Date.now() });
const h = await step(held.s.id);
out.held = [h.state, h.error];
await stop.setEmergencyStop(false, "admin@acme.test", "over");
plan[held.s.id] = {};
await worker.tick({ wait: true, now: Date.now() + 6_000 });
out.heldAfter = (await step(held.s.id)).state;

// No starvation: more queued steps than the claim window, of a kind nobody handles and in a paused run, don't keep a
// startable step waiting.
const crowd = await mkRun();
for (let i = 0; i < 101; i++) await store.appendStep(crowd, { kind: "approval" });
const paused = await mkRun();
for (let i = 0; i < 101; i++) await store.appendStep(paused, { kind: "tool" });
await store.updateRun(paused, { state: "paused_budget" });
const rl = await mkRun();
const late = await store.appendStep(rl, { kind: "tool", name: "late" });
worker.registerStepHandler("tool", async () => ({ state: "succeeded" }));
await worker.tick({ wait: true, now: Date.now() });
out.starve = (await step(late.id)).state;

// Cancellation: a step in flight is told to stop; the run's verify step goes on; a run being cancelled starts nothing new.
worker.registerStepHandler("model", (s, ctx) => new Promise((_, reject) => ctx.signal.addEventListener("abort", () => reject(ctx.signal.reason))));
const rc = await mkRun();
const mc = await store.appendStep(rc, { kind: "model", retrySafe: true });
const vc = await store.appendStep(rc, { kind: "verify", input: { operationId: "op-z" }, retrySafe: true });
const running = worker.tick({ wait: true, now: Date.now() });
await new Promise((r) => setTimeout(r, 50));
out.cancelledN = worker.cancelInflight(rc, "a person cancelled it");
await running;
const m = await step(mc.id);
out.cancel = { model: [m.state, m.error], verify: (await step(vc.id)).state };
const rq = await mkRun();
const mq = await store.appendStep(rq, { kind: "tool" });
await store.updateRun(rq, { cancelRequestedAt: Date.now() });
await worker.tick({ wait: true, now: Date.now() });
out.cancelRequested = (await step(mq.id)).state;

// Periodic tasks ride on the loop while agents are on, and never overlap or run early.
const fired = [];
worker.registerTickTask("scheduler", 60_000, async (now) => { fired.push(now); });
const t0 = Date.now() + 1_000_000;
await worker.tick({ now: t0 });
await worker.tick({ now: t0 + 1_000 });
await worker.tick({ now: t0 + 61_000 });
await stop.setAgentsEnabled(false, "admin@acme.test");
await worker.tick({ now: t0 + 200_000 });
await stop.setAgentsEnabled(true, "admin@acme.test");
out.tasks = fired.map((n) => n - t0);
out.status = worker.workerStatus().tasks;
console.log(JSON.stringify(out));
`;

function checkExecute(x: Record<string, any>) { // eslint-disable-line @typescript-eslint/no-explicit-any
  const verified = (op: string) => [["execute", "outcome_unknown", op], ["verify", "succeeded", null]];
  assert.deepEqual(x.exec.thrownAccepted, { run: "waiting_external", steps: verified("op-a"), ran: 1 }, "AWS may have acted: verify, never retry");
  assert.deepEqual(x.exec.thrownSucceeded, { run: "running", steps: [["execute", "succeeded", "op-b"], ["verify", "succeeded", null]], ran: 1 }, "the record says it succeeded");
  assert.deepEqual(x.exec.thrownNothing, { run: "running", steps: [["execute", "failed", null]], ran: 1 }, "nothing reached AWS");
  assert.deepEqual(x.exec.retryAsked, { run: "waiting_external", steps: verified("op-c"), ran: 1 }, "a retry asked for while the outcome is unknown is refused");
  assert.deepEqual(x.exec.handlerUnknown, { run: "waiting_external", steps: verified("op-d"), ran: 1 });
  assert.deepEqual(x.exec.byKey, { run: "waiting_external", steps: verified("op-e"), ran: 1 }, "found by its idempotency key");
  assert.deepEqual(x.exec.bothFailed, { run: "running", steps: [["execute", "failed", "op-f"]], ran: 1 }, "a known failure the handler reported needs no verify");
  assert.deepEqual(x.exec.ownVerify.steps, verified("op-g"), "the handler's own verify step is the only one");
  assert.deepEqual(x.verifyInput, { operationId: "op-a", stepId: x.verifyInput.stepId });
  assert.deepEqual(x.held, ["waiting", "emergency stop"]);
  assert.equal(x.heldAfter, "succeeded");
  assert.equal(x.starve, "succeeded");
  assert.equal(x.cancelledN, 1);
  assert.deepEqual(x.cancel, { model: ["cancelled", "a person cancelled it"], verify: "succeeded" });
  assert.equal(x.cancelRequested, "queued");
  assert.deepEqual(x.tasks, [0, 61_000]);
  assert.deepEqual(x.status, ["scheduler"]);
}

const drain = `
// SIGTERM: other steps are interrupted at once (a retry-safe one requeued); an execute step whose change is in flight is
// left holding its lease — after the process is gone, reconciliation settles it through its operation.
let releaseExec;
const gate = new Promise((r) => (releaseExec = r));
const alive = setInterval(() => {}, 1_000); // a server keeps the process alive while it drains; this script must too
worker.registerStepHandler("execute", async (s) => { await opRow("op-drain", s.run_id, s.id, "running"); await gate; return { state: "succeeded" }; });
const hang = (s, ctx) => new Promise((_, reject) => ctx.signal.addEventListener("abort", () => reject(ctx.signal.reason)));
worker.registerStepHandler("tool", hang);
worker.registerStepHandler("model", hang);
const r = await mkRun();
const ex = await store.appendStep(r, { kind: "execute", name: "services.restart" });
const tl = await store.appendStep(r, { kind: "tool", retrySafe: true });
const md = await store.appendStep(r, { kind: "model" });
const ticking = worker.tick({ wait: true, now: Date.now() });
await new Promise((res) => setTimeout(res, 100));
const t0 = Date.now();
await worker.drainWorker(200);
out.waited = Date.now() - t0 >= 150;
await new Promise((res) => setTimeout(res, 20));
out.drained = { execute: (await step(ex.id)).state, tool: (await step(tl.id)).state, model: (await step(md.id)).state };
out.claimedWhileDraining = await worker.tick({ now: Date.now() });
// The process is gone: the leases lapse and another console reconciles.
await db.run("UPDATE agent_steps SET lease_until = 1 WHERE id IN (?, ?)", [ex.id, md.id]);
out.reconciled = await reconcileAgents(Date.now());
out.after = (await store.getSteps(r)).map((s) => [s.kind, s.state, s.operation_id]);
out.run = (await store.getRun(r)).state;
// The stalled handler returns at last: its fence is stale, nothing is recorded.
releaseExec();
await ticking;
out.late = (await step(ex.id)).state;
clearInterval(alive);
console.log(JSON.stringify(out));
`;

function checkDrain(x: Record<string, any>) { // eslint-disable-line @typescript-eslint/no-explicit-any
  assert.equal(x.waited, true, "execute steps get their time");
  assert.deepEqual(x.drained, { execute: "leased", tool: "queued", model: "leased" });
  assert.equal(x.claimedWhileDraining, 0);
  assert.equal(x.reconciled.unknown, 1);
  assert.equal(x.reconciled.failed, 1);
  assert.deepEqual(x.after, [["execute", "outcome_unknown", "op-drain"], ["tool", "queued", null], ["model", "failed", null], ["verify", "queued", null]]);
  assert.equal(x.run, "waiting_external");
  assert.equal(x.late, "outcome_unknown", "the stalled handler's late success is rejected by the fence");
}

const routes = `
// The stop and switch routes: people only, admins to change, audited (the intent first; the result commits with the change).
const { NextRequest } = await import("next/server.js");
const stopRoute = await import(src("app/api/agents/emergency-stop/route.ts"));
const settingsRoute = await import(src("app/api/agents/settings/route.ts"));
const { createUser } = await import(src("lib/server/auth/users.ts"));
const mk = async (email, role) => ({ id: (await createUser({ email, role })).id, email, role });
const admin = await mk("root@acme.test", "admin");
const dev = await mk("dev@acme.test", "developer");
const hdr = (u, via) => ({ "x-console-user-id": u.id, "x-console-user-email": u.email, "x-console-user-role": u.role, "x-console-auth-via": via ?? "session", "x-console-token-id": "t1", "content-type": "application/json" });
const call = async (route, method, u, body, via) => {
  const r = await route[method](new NextRequest("http://127.0.0.1:3200/api/agents/x", { method, headers: hdr(u, via), ...(body ? { body: JSON.stringify(body) } : {}) }), {});
  return { status: r.status, json: await r.json() };
};
out.devPost = (await call(stopRoute, "POST", dev, { on: true, reason: "x" })).status;
out.tokenGet = (await call(stopRoute, "GET", admin, undefined, "token")).status;
out.noReason = [(await call(stopRoute, "POST", admin, { on: true })).status, (await call(stopRoute, "POST", admin, { on: true, reason: "  " })).status];
out.badOn = (await call(stopRoute, "POST", admin, { on: "yes", reason: "x" })).status;
const on = await call(stopRoute, "POST", admin, { on: true, reason: "drill" });
out.on = [on.status, on.json.on, on.json.by, on.json.reason, typeof on.json.at];
const got = (await call(stopRoute, "GET", dev)).json;
out.get = [got.on, got.by, got.reason];
out.audit = (await db.all("SELECT phase, action, result, reason FROM audit WHERE target = 'agents' ORDER BY at, phase")).map((a) => [a.phase, a.action, a.result, a.reason]);
const ev = (await events.readSince(0)).filter((e) => e.type === "action").pop();
out.event = [JSON.parse(ev.payload).action, JSON.parse(ev.audience)];
const s0 = await call(settingsRoute, "GET", dev);
out.settingsGet = [s0.status, s0.json.enabled, s0.json.stop.on];
out.settingsDev = (await call(settingsRoute, "POST", dev, { enabled: false })).status;
out.settingsBad = (await call(settingsRoute, "POST", admin, { enabled: "no" })).status;
const off = await call(settingsRoute, "POST", admin, { enabled: false });
out.off = [off.json.enabled, "overridden" in off.json];
process.env.CONSOLE_AGENTS = "on";
const over = await call(settingsRoute, "POST", admin, { enabled: false });
out.overridden = [over.json.enabled, over.json.overridden, typeof over.json.note];
delete process.env.CONSOLE_AGENTS;
out.afterOverride = (await stop.agentsEnabled());
// A damaged stop setting counts as on; an audit log that can't be written refuses the change and changes nothing.
await db.run("UPDATE settings SET value = '{' WHERE key = 'agents:stop'");
stop.forgetAgentSwitches();
out.damaged = (await stop.isEmergencyStopped()).on;
await db.run("UPDATE settings SET value = ? WHERE key = 'agents:stop'", [JSON.stringify({ on: true, by: "root@acme.test", at: 1, reason: "drill" })]);
await db.run("ALTER TABLE audit RENAME TO audit_gone");
const refused = await call(stopRoute, "POST", admin, { on: false });
stop.forgetAgentSwitches();
out.refused = [refused.status, (await stop.isEmergencyStopped()).on];
await db.run("ALTER TABLE audit_gone RENAME TO audit");
// The intent is on the record before the change: a change that then fails leaves its intent and an error result, and
// no "ok" (the setting and its event roll back together).
await db.run("ALTER TABLE events RENAME TO events_gone");
const failed = await call(stopRoute, "POST", admin, { on: false });
await db.run("ALTER TABLE events_gone RENAME TO events");
stop.forgetAgentSwitches();
out.failedChange = [failed.status >= 500, (await stop.isEmergencyStopped()).on];
out.failedAudit = (await db.all("SELECT phase, result FROM audit WHERE action = 'agents.emergency_stop_lifted' ORDER BY at, phase")).map((a) => [a.phase, a.result]);
console.log(JSON.stringify(out));
`;

function checkRoutes(x: Record<string, any>) { // eslint-disable-line @typescript-eslint/no-explicit-any
  assert.equal(x.devPost, 403);
  assert.equal(x.tokenGet, 403, "API tokens never reach the switches");
  assert.deepEqual(x.noReason, [400, 400], "turning the stop on needs a reason");
  assert.equal(x.badOn, 400);
  assert.deepEqual(x.on, [200, true, "root@acme.test", "drill", "number"]);
  assert.deepEqual(x.get, [true, "root@acme.test", "drill"]);
  assert.deepEqual(x.audit, [["intent", "agents.emergency_stop", null, "drill"], ["result", "agents.emergency_stop", "ok", "drill"]]);
  assert.deepEqual(x.event, ["agents.emergency_stop", { people: true }]);
  assert.deepEqual(x.settingsGet, [200, { on: true, source: "default" }, true]);
  assert.equal(x.settingsDev, 403);
  assert.equal(x.settingsBad, 400);
  assert.deepEqual(x.off, [{ on: false, source: "settings" }, false]);
  assert.deepEqual(x.overridden, [{ on: true, source: "env" }, true, "string"]);
  assert.deepEqual(x.afterOverride, { on: false, source: "settings" }, "the toggle applies once CONSOLE_AGENTS is unset");
  assert.equal(x.damaged, true, "a damaged setting never turns the stop off");
  assert.equal(x.refused[0], 503);
  assert.equal(x.refused[1], true, "no audit, no change");
  assert.deepEqual(x.failedChange, [true, true], "a failed change changes nothing");
  assert.deepEqual(x.failedAudit, [["intent", null], ["result", "error"]], "the intent comes first; the failure is on the record too");
}

const sse = `
// A lost SSE connection: reconnecting with Last-Event-ID replays what was missed, in order, then goes live.
const { NextRequest } = await import("next/server.js");
const route = await import(src("app/api/events/route.ts"));
const r = await mkRun();
const first = await events.publish("step", { n: 1 }, { runId: r });
await events.publish("step", { n: 2 }, { runId: r });
await events.publish("step", { n: 3 }, { runId: r });
await events.publish("approval", { id: "x", tokenId: "t-other" }, { audience: { people: true, tokens: ["t-other"] } });
const read = async (headers) => {
  const ac = new AbortController();
  const res = await route.GET(new NextRequest("http://127.0.0.1:3200/api/events", { headers, signal: ac.signal }), {});
  const reader = res.body.getReader();
  let text = "";
  const until = Date.now() + 3_000;
  while (Date.now() < until && !/event: replayed/.test(text)) {
    const { value, done } = await Promise.race([reader.read(), new Promise((r) => setTimeout(() => r({ value: undefined, done: false }), 200))]);
    if (done) break;
    if (value) text += new TextDecoder().decode(value);
  }
  ac.abort();
  return text;
};
const person = { "x-console-user-id": "u1", "x-console-user-email": "alice@acme.test", "x-console-user-role": "developer", "x-console-auth-via": "session", "last-event-id": String(first) };
const t = await read(person);
out.ids = [...t.matchAll(/^id: (\\d+)$/gm)].map((m) => Number(m[1]) - first);
out.payloads = [...t.matchAll(/^event: step\\ndata: (.+)$/gm)].map((m) => JSON.parse(m[1]).n);
out.replayed = /event: replayed\\ndata: \\{"count":3/.test(t);
const token = { "x-console-user-id": "u1", "x-console-user-email": "alice@acme.test", "x-console-user-role": "developer", "x-console-auth-via": "token", "x-console-token-id": "t-mine", "x-console-token-name": "bot", "x-console-token-mode": "read", "last-event-id": String(first - 1) };
const tt = await read(token);
out.tokenSees = [...tt.matchAll(/^event: (\\w+)$/gm)].map((m) => m[1]).filter((e) => e !== "ready" && e !== "replayed");
console.log(JSON.stringify(out));
`;

const sse2 = `
// The live stream: agent tokens see only their own run (whatever ?run= says); ?run= for people; live delivery after the
// replay; an event that commits after a later one is still sent, once; a cursor from another database; a long outage.
const { NextRequest } = await import("next/server.js");
const route = await import(src("app/api/events/route.ts"));
const tokens = await import(src("lib/server/auth/agent-tokens.ts"));
const { createUser } = await import(src("lib/server/auth/users.ts"));
const alice = { id: (await createUser({ email: "alice@acme.test", role: "operator" })).id, email: "alice@acme.test", role: "operator" };
const open = (headers, qs = "") => {
  const ac = new AbortController();
  const res = route.GET(new NextRequest("http://127.0.0.1:3200/api/events" + qs, { headers, signal: ac.signal }), {});
  let text = "";
  let reader;
  return {
    async pump(ms, until) {
      reader ??= (await res).body.getReader();
      const end = Date.now() + ms;
      while (Date.now() < end && !(until && until.test(text))) {
        const { value, done } = await Promise.race([reader.read(), new Promise((r) => setTimeout(() => r({}), 50))]);
        if (done) break;
        if (value) text += new TextDecoder().decode(value);
      }
      return text;
    },
    close: () => ac.abort(),
    get text() { return text; },
  };
};
const ns = (text) => [...text.matchAll(/^data: (\\{"n".*)$/gm)].map((m) => JSON.parse(m[1]).n);
const ids = (text) => [...text.matchAll(/^id: (\\d+)$/gm)].map((m) => Number(m[1]));
const person = { "x-console-user-id": alice.id, "x-console-user-email": alice.email, "x-console-user-role": alice.role, "x-console-auth-via": "session" };

// Agent tokens.
const t = await tokens.mintExternalToken(alice, "incident-investigator", 7, { name: "desk" });
const agent = { "x-console-user-id": alice.id, "x-console-user-email": alice.email, "x-console-user-role": alice.role, "x-console-auth-via": "agent", "x-console-agent-principal": t.id, "x-console-agent-run": t.runId, "x-console-agent-token-name": "desk" };
const other = await mkRun();
const first = await events.publish("step", { n: "mine-1" }, { runId: t.runId });
await events.publish("step", { n: "other" }, { runId: other });
await events.publish("state", { n: "state" });
await events.publish("approval", { n: "approval-other" }, { runId: other, audience: { people: true } });
await events.publish("step", { n: "mine-2" }, { runId: t.runId });
const ag = open({ ...agent, "last-event-id": String(first - 1) }, "?run=" + other);
await ag.pump(2_000, /event: replayed/);
out.agentReplay = ns(ag.text);
out.agentReadyRun = JSON.parse(/event: ready\\ndata: (.+)/.exec(ag.text)[1]).run === t.runId;
await events.publish("step", { n: "other-live" }, { runId: other });
await events.publish("step", { n: "mine-live" }, { runId: t.runId });
await ag.pump(3_000, /mine-live/);
out.agentAll = ns(ag.text);
ag.close();

// People: ?run= keeps one run; live events arrive after the replay; a late commit fills its gap, once.
const r = await mkRun();
const a = await events.publish("step", { n: "r-1" }, { runId: r });
const pp = open({ ...person, "last-event-id": String(a - 1) }, "?run=" + r);
await pp.pump(2_000, /event: replayed/);
await events.publish("step", { n: "elsewhere" }, { runId: other });
await events.publish("step", { n: "r-live" }, { runId: r });
await pp.pump(3_000, /r-live/);
const L = await events.latestSeq();
const raw = (seq, n) => db.run("INSERT INTO events (seq, at, type, topic, run_id, actor, audience, payload) VALUES (?, ?, 'step', NULL, ?, NULL, ?, ?)", [seq, Date.now(), r, JSON.stringify({ people: true }), JSON.stringify({ n })]);
await raw(L + 1_000, "r-hi");
await events.publish("step", { n: "nudge-1" }, { runId: other });
await pp.pump(3_000, /r-hi/);
await raw(L + 999, "r-lo");
await events.publish("step", { n: "nudge-2" }, { runId: other });
await pp.pump(3_000, /r-lo/);
await pp.pump(300);
out.people = ns(pp.text);
out.peopleIds = ids(pp.text).filter((i) => i >= L + 999).map((i) => i - L);
pp.close();

// A cursor this database never issued: live from the newest event, flagged.
const newest = await events.latestSeq();
const far = open({ ...person, "last-event-id": String(newest + 50_000) });
await far.pump(2_000, /event: replayed/);
out.reset = JSON.parse(/event: replayed\\ndata: (.+)/.exec(far.text)[1]);
await events.publish("state", { n: "after-reset" });
await far.pump(3_000, /after-reset/);
out.afterReset = ns(far.text);
far.close();

// Back after more than an hour: what is older than the hour isn't replayed, and the client is told it missed events.
const aged = await mkRun();
const g0 = await events.publish("step", { n: "g-0" }, { runId: aged });
await db.run("INSERT INTO events (at, type, topic, run_id, actor, audience, payload) VALUES (?, 'step', NULL, ?, NULL, ?, ?)", [Date.now() - 2 * 3_600_000, aged, JSON.stringify({ people: true }), JSON.stringify({ n: "g-old" })]);
await events.publish("step", { n: "g-new" }, { runId: aged });
const ga = open({ ...person, "last-event-id": String(g0) }, "?run=" + aged);
await ga.pump(3_000, /event: replayed/);
out.aged = { replayed: JSON.parse(/event: replayed\\ndata: (.+)/.exec(ga.text)[1]), sent: ns(ga.text) };
ga.close();
const oldSeq = Number((await db.get("SELECT MAX(seq) AS n FROM events WHERE run_id = ? AND at < ?", [aged, Date.now() - 3_600_000])).n);
const gb = open({ ...person, "last-event-id": String(oldSeq) }, "?run=" + aged);
await gb.pump(3_000, /event: replayed/);
out.recentOnly = { truncated: JSON.parse(/event: replayed\\ndata: (.+)/.exec(gb.text)[1]).truncated, sent: ns(gb.text) };
gb.close();

// A long outage: more than 500 missed — the replay sends 500, says truncated, and goes live.
const big = await mkRun();
const b0 = await events.publish("step", { n: "b-0" }, { runId: big });
for (let i = 1; i <= 520; i++) await events.publish("step", { n: "b-" + i }, { runId: big });
const lo = open({ ...person, "last-event-id": String(b0) }, "?run=" + big);
await lo.pump(3_000, /event: replayed/);
out.long = JSON.parse(/event: replayed\\ndata: (.+)/.exec(lo.text)[1]);
out.longCount = ns(lo.text).length;
await events.publish("step", { n: "b-live" }, { runId: big });
await lo.pump(3_000, /b-live/);
out.longLive = ns(lo.text).slice(-1)[0];
lo.close();
console.log(JSON.stringify(out));
`;

function checkSse2(x: Record<string, any>) { // eslint-disable-line @typescript-eslint/no-explicit-any
  assert.deepEqual(x.agentReplay, ["mine-1", "mine-2"], "an agent token sees only its own run, whatever ?run= asks");
  assert.equal(x.agentReadyRun, true);
  assert.deepEqual(x.agentAll, ["mine-1", "mine-2", "mine-live"]);
  assert.deepEqual(x.people, ["r-1", "r-live", "r-hi", "r-lo"], "?run= keeps one run; a late commit is sent once");
  assert.deepEqual(x.peopleIds, [1_000, 999]);
  assert.equal(x.reset.reset, true);
  assert.equal(x.reset.count, 0);
  assert.deepEqual(x.afterReset, ["after-reset"], "a client with a foreign cursor still gets live events");
  assert.equal(x.aged.replayed.truncated, true, "events older than the hour were skipped: the client is told");
  assert.equal(x.aged.replayed.count, 1);
  assert.deepEqual(x.aged.sent, ["g-new"]);
  assert.deepEqual(x.recentOnly, { truncated: false, sent: ["g-new"] }, "nothing older than the hour was missed");
  assert.equal(x.long.truncated, true);
  assert.equal(x.long.count, 500);
  assert.equal(x.longCount, 500);
  assert.equal(x.longLive, "b-live");
}

// The loop's timers are armed outside any agent's context: the runner enqueues steps from inside an agent's call, and a
// tick that started during that call would otherwise run every step as that agent (principals.ts).
const agentContext = `
const principals = await import(src("lib/server/agents/principals.ts"));
await worker.startWorker();
await new Promise((r) => setTimeout(r, 300)); // the first (empty) tick has finished
let seen = [];
let wake;
worker.registerStepHandler("tool", async (s) => (seen.push([s.name, principals.currentAgentContext()?.runId ?? null]), wake?.(), { state: "succeeded" }));
const during = async (name, enqueue) => {
  const r = await mkRun();
  const p = { id: "agent:" + r, kind: "agent", runId: r, delegatorId: "u1", delegatorEmail: "alice@acme.test", policyHash: policyHash(pol), mode: pol.mode };
  await principals.withAgentContext(p, async () => {
    const ran = new Promise((res) => (wake = res));
    await enqueue(r, name);
    await Promise.race([ran, new Promise((res) => setTimeout(res, 5_000))]); // still inside the agent's call
  });
};
await during("plain", (r, name) => worker.enqueueStep(r, { kind: "tool", name, retrySafe: true }));
await during("in-tx", (r, name) => db.tx((t) => worker.enqueueStep(r, { kind: "tool", name, retrySafe: true }, t)));
out.seen = seen;
await worker.drainWorker(200);
console.log(JSON.stringify(out));
`;

function checkSse(x: Record<string, any>) { // eslint-disable-line @typescript-eslint/no-explicit-any
  assert.deepEqual(x.ids, [1, 2, 3], "everything after the cursor, in order");
  assert.deepEqual(x.payloads, [2, 3]);
  assert.equal(x.replayed, true);
  assert.deepEqual(x.tokenSees, [], "an API token sees neither run steps nor another token's approvals");
}

test("worker on SQLite: claims, fences, reconciliation, outage, triggers, stop, switch, retries, deadlines, events", () => checkCore(run(core)));
test("outbox on SQLite: a failed notification is retried for that integration only, the change is never repeated", () => checkOutbox(run(outbox)));
test("event stream: replay by cursor after a lost connection; audiences apply to the replay", () => checkSse(run(sse)));
test("execute steps on SQLite: settled by their operations, never retried blindly; no starvation; cancellation; periodic tasks", () => checkExecute(run(execute)));
test("draining on SQLite: interrupt what can be, leave changes in flight to reconciliation, reject the late result", () => checkDrain(run(drain)));
test("emergency stop and agents switch routes: people only, admins to change, audited, fail closed", () => checkRoutes(run(routes)));
test("the worker loop never runs as the agent whose call woke it", () => {
  assert.deepEqual(run(agentContext).seen, [["plain", null], ["in-tx", null]]);
});
test("event stream live: agent tokens' own run only, ?run=, late commits sent once, foreign cursors, long outages", () => checkSse2(run(sse2)));

// (The live-stream scenario stays on SQLite: it plants events with explicit sequence numbers, which a Postgres sequence
// doesn't follow.)
test("worker on Postgres (PG_TEST_URL): the claim, lease and fence SQL, execute settlement, draining, the switch routes", { skip: !PG && "PG_TEST_URL not set (node scripts/pg-test.mjs)" }, async () => {
  checkCore(run(core, await freshPg(PG!)));
  checkOutbox(run(outbox, await freshPg(PG!)));
  checkExecute(run(execute, await freshPg(PG!)));
  checkDrain(run(drain, await freshPg(PG!)));
  checkRoutes(run(routes, await freshPg(PG!)));
});
