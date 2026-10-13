import { test } from "node:test";
import assert from "node:assert/strict";
import { capacityState, deriveState, deriveWorkloadState, parseImage, targetGroupsHealth, tgHealthToResource, touchesMigrations } from "./status.ts";
import type { RawBox, RawDeployment, RawService, RawTask, Signals } from "./types.ts";
import { LIMITS } from "./config.ts";

const NOW = 1_800_000_000_000;
const task = (o: Partial<RawTask> = {}): RawTask => ({
  id: "t1", taskDefinition: "td:1", lastStatus: "RUNNING", desiredStatus: "RUNNING",
  health: "HEALTHY", hasHealthcheck: true, ...o,
});
const dep = (o: Partial<RawDeployment> = {}): RawDeployment => ({
  id: "d1", status: "PRIMARY", rolloutState: "COMPLETED", taskDefinition: "td:1",
  desired: 1, running: 1, pending: 0, failedTasks: 0, createdAt: NOW - 3600_000, updatedAt: NOW - 3600_000, ...o,
});
const svc = (o: Partial<RawService> = {}): RawService => ({
  name: "api", cluster: "acme-staging", status: "ACTIVE", desired: 1, running: 1, pending: 0,
  launchType: "EC2", deployments: [dep()], tasks: [task()], taskDef: null, targetGroupArns: [], circuitBreaker: true, tags: {}, securityGroups: [], subnets: [], ...o,
});
const sig = (o: Partial<Signals> = {}, s: Partial<RawService> = {}): Signals => ({
  runtime: { ok: true, value: svc(s) },
  probe: { url: "https://x/ready", pass: true, consecutiveFailures: 0, status: 200, ms: 40 },
  fetchedAt: NOW,
  ...o,
});
const state = (s: Signals) => deriveState(s, NOW).state;

test("all green → UP", () => assert.equal(state(sig()), "UP"));

test("desired 0 wins over failing probe → STOPPED", () => {
  assert.equal(state(sig({ probe: { url: "u", pass: false, consecutiveFailures: 5 } }, { desired: 0, running: 0, tasks: [] })), "STOPPED");
});

test("EC2 host not running → BOX_STOPPED (not DOWN)", () => {
  const s = sig({ box: { ok: true, value: { id: "i", name: "acme-staging", state: "stopped", type: "t3a.small", securityGroups: [], tags: {} } } }, { running: 0, tasks: [] });
  assert.equal(state(s), "BOX_STOPPED");
  assert.equal(state(sig({ box: { ok: true, value: null } })), "BOX_STOPPED");
});

test("runtime error → UNKNOWN with reason", () => {
  const d = deriveState(sig({ runtime: { ok: false, error: "AccessDeniedException" } }), NOW);
  assert.equal(d.state, "UNKNOWN");
  assert.match(d.reasons[0], /AccessDenied/);
  assert.equal(state(sig({ box: { ok: false, error: "timeout" } })), "UNKNOWN");
});

test("data older than 30s → UNKNOWN", () => {
  assert.equal(state(sig({ fetchedAt: NOW - 31_000 })), "UNKNOWN");
  assert.equal(state(sig({ fetchedAt: NOW - 29_000 })), "UP");
});

test("unhealthy task → DEGRADED", () => {
  assert.equal(state(sig({}, { tasks: [task({ health: "UNHEALTHY" })] })), "DEGRADED");
});

test("one probe failure is a flap; two consecutive → DEGRADED", () => {
  assert.equal(state(sig({ probe: { url: "u", pass: false, consecutiveFailures: 1, error: "timeout" } })), "UP");
  assert.equal(state(sig({ probe: { url: "u", pass: false, consecutiveFailures: 2, error: "timeout" } })), "DEGRADED");
});

test("desired 1, running 0, no rollout → DOWN", () => {
  const d = deriveState(sig({}, { running: 0, tasks: [task({ lastStatus: "STOPPED", stoppedReason: "Essential container exited" })] }), NOW);
  assert.equal(d.state, "DOWN");
  assert.ok(d.reasons.some((r) => r.includes("Essential container exited")));
});

test("rollout 5 min → DEPLOYING; 16 min → DEGRADED stuck", () => {
  const five = [dep({ rolloutState: "IN_PROGRESS", createdAt: NOW - 5 * 60_000 })];
  const sixteen = [dep({ rolloutState: "IN_PROGRESS", createdAt: NOW - 16 * 60_000 })];
  assert.equal(state(sig({}, { deployments: five })), "DEPLOYING");
  const d = deriveState(sig({}, { deployments: sixteen }), NOW);
  assert.equal(d.state, "DEGRADED");
  assert.match(d.reasons.join(), /stuck/);
});

test("stop-then-start rollout with 0 running shows DEPLOYING, not DOWN", () => {
  const s = sig({}, { running: 0, tasks: [], deployments: [dep({ rolloutState: "IN_PROGRESS", createdAt: NOW - 20_000 })] });
  assert.equal(state(s), "DEPLOYING");
});

test("failed rollout within 60 min → DEGRADED; after → UP", () => {
  const recent = [dep(), dep({ id: "d2", status: "INACTIVE", rolloutState: "FAILED", updatedAt: NOW - 20 * 60_000, rolloutReason: "circuit breaker" })];
  const old = [dep(), dep({ id: "d2", status: "INACTIVE", rolloutState: "FAILED", updatedAt: NOW - 61 * 60_000 })];
  const d = deriveState(sig({}, { deployments: recent }), NOW);
  assert.equal(d.state, "DEGRADED");
  assert.match(d.reasons.join(), /rolled back/);
  assert.equal(state(sig({}, { deployments: old })), "UP");
});

test("no healthcheck (caddy) + running → UP", () => {
  assert.equal(state(sig({ probe: undefined }, { name: "caddy", tasks: [task({ health: "UNKNOWN", hasHealthcheck: false })] })), "UP");
});

test("task healthy but ALB target unhealthy → DEGRADED", () => {
  const s = sig({ targets: [{ targetGroupArn: "tg", healthy: 0, unhealthy: 1, reasons: ["Target.FailedHealthChecks"] }] });
  assert.equal(state(s), "DEGRADED");
});

test("probe failing and no healthy task → DOWN", () => {
  const s = sig({ probe: { url: "u", pass: false, consecutiveFailures: 3, status: 502 } }, { tasks: [task({ health: "UNHEALTHY" })] });
  assert.equal(state(s), "DOWN");
});

test("healthcheck pending (UNKNOWN) outside a rollout → DEGRADED, never UP", () => {
  assert.equal(state(sig({}, { tasks: [task({ health: "UNKNOWN" })] })), "DEGRADED");
});

test("image tag parsing never guesses a sha", () => {
  const sha = "f85f3cce8fdefe637149bdea8abea73bd13cf289";
  assert.deepEqual(parseImage(`1.dkr.ecr.us-east-1.amazonaws.com/api:staging-${sha}`), { tag: `staging-${sha}`, sha });
  assert.deepEqual(parseImage(`repo:production-${sha}`), { tag: `production-${sha}`, sha });
  assert.equal(parseImage("host:5000/repo:staging").sha, undefined);
  assert.equal(parseImage("repo:staging-abc").sha, undefined);
  assert.equal(parseImage("repo@sha256:abcd").sha, undefined);
  assert.equal(parseImage("host:5000/repo").tag, "latest");
  assert.equal(parseImage("repo:main-1a2b3c4").sha, "1a2b3c4");
});

test("migration detection", () => {
  assert.equal(touchesMigrations(["prisma/migrations/2026_x/migration.sql", "src/a.ts"], ["prisma/migrations/"]), true);
  assert.equal(touchesMigrations(["src/a.ts"], ["prisma/migrations/"]), false);
  assert.equal(touchesMigrations(["prisma/migrations/x.sql"], []), false);
});

test("fresh box start: no task yet → DEPLOYING for 5 min, then DOWN", () => {
  const box = (ageMin: number) => ({ ok: true as const, value: { id: "i", name: "acme-staging", state: "running", type: "t3a.small", launchedAt: NOW - ageMin * 60_000, securityGroups: [], tags: {} } });
  assert.equal(state(sig({ box: box(1) }, { running: 0, tasks: [] })), "DEPLOYING");
  assert.equal(state(sig({ box: box(6) }, { running: 0, tasks: [] })), "DOWN");
  assert.equal(state(sig({ box: box(1) })), "UP", "running tasks are judged normally");
});

test("fetchedAt ≤ 0 → UNKNOWN 'data freshness unknown' (never a reassuring state from undated data)", () => {
  for (const fetchedAt of [0, -1, Number.NaN]) {
    const d = deriveState(sig({ fetchedAt }), NOW);
    assert.equal(d.state, "UNKNOWN");
    assert.deepEqual(d.reasons, ["data freshness unknown"]);
  }
  // A runtime error still wins with its own reason.
  assert.match(deriveState(sig({ fetchedAt: 0, runtime: { ok: false, error: "AccessDenied" } }), NOW).reasons[0], /AccessDenied/);
});

// F01 — target groups, anonymised from the real account: two serving groups and one group of a scaled-to-0 service.
const TG = "arn:aws:elasticloadbalancing:eu-west-1:123456789012:targetgroup";
test("target groups: two healthy + one idle (desired 0) → UP with the idle note", () => {
  const r = targetGroupsHealth([
    { arn: `${TG}/acme-api/1`, healthy: 1, unhealthy: 0, desired: 1 },
    { arn: `${TG}/acme-web/2`, healthy: 1, unhealthy: 0 },
    { arn: `${TG}/acme-worker/3`, healthy: 0, unhealthy: 0, desired: 0 },
  ]);
  assert.equal(r.state, "UP");
  assert.equal(r.active, 2);
  assert.equal(r.bad, 0);
  assert.deepEqual(r.idle, [{ arn: `${TG}/acme-worker/3` }]);
  assert.equal(r.reason, "2/2 active target groups healthy · acme-worker idle (service scaled to 0)");
  assert.deepEqual(tgHealthToResource(r), { health: "ok", reason: r.reason });
});

test("target groups: all idle → STOPPED (ok)", () => {
  const r = targetGroupsHealth([
    { arn: `${TG}/a/1`, name: "alpha", healthy: 0, unhealthy: 0, desired: 0 },
    { arn: `${TG}/b/2`, healthy: 0, unhealthy: 0, initial: 0, draining: 0, desired: 0 },
  ]);
  assert.equal(r.state, "STOPPED");
  assert.equal(r.active, 0);
  assert.equal(r.reason, "alpha, b idle (service scaled to 0)");
  assert.equal(tgHealthToResource(r).health, "ok");
  assert.equal(targetGroupsHealth([]).state, "STOPPED");
});

test("target groups: 0/0 with desired 1 is bad", () => {
  const r = targetGroupsHealth([{ arn: `${TG}/a/1`, healthy: 0, unhealthy: 0, desired: 1 }]);
  assert.equal(r.state, "DOWN");
  assert.equal(r.bad, 1);
  assert.deepEqual(tgHealthToResource(r), { health: "error", reason: "0/1 active target group healthy" });
});

test("target groups: unhealthy > 0 is bad; one bad of two → DEGRADED (warning)", () => {
  const r = targetGroupsHealth([
    { arn: `${TG}/a/1`, healthy: 2, unhealthy: 1, desired: 3 },
    { arn: `${TG}/b/2`, healthy: 1, unhealthy: 0, desired: 1 },
  ]);
  assert.equal(r.state, "DEGRADED");
  assert.equal(r.bad, 1);
  assert.equal(r.reason, "1/2 active target groups healthy");
  assert.equal(tgHealthToResource(r).health, "warning");
});

test("target groups: initial-only with desired 1 is bad (registering is not healthy yet)", () => {
  const r = targetGroupsHealth([{ arn: `${TG}/a/1`, healthy: 0, unhealthy: 0, initial: 1, desired: 1 }]);
  assert.equal(r.state, "DOWN");
});

test("target groups: desired undefined is treated as > 0 (an empty group is bad, not idle)", () => {
  const r = targetGroupsHealth([{ arn: `${TG}/a/1`, healthy: 0, unhealthy: 0 }]);
  assert.equal(r.state, "DOWN");
  assert.deepEqual(r.idle, []);
  // A draining-only group of a scaled-to-0 service is still active (and bad) until the targets are gone.
  assert.equal(targetGroupsHealth([{ arn: `${TG}/a/1`, healthy: 0, unhealthy: 0, draining: 1, desired: 0 }]).state, "DOWN");
});

// R11 — the REVIEW reproduction: desired 5, running 1, pending 4, one healthy task, no rollout returned UP "1/5 running, healthy".
test("capacity: 1/5 running with 4 pending and no rollout → starting within the 5-minute grace, short after", () => {
  const svc = { desired: 5, running: 1, pending: 4, rollout: false };
  const grace = 5 * 60_000;
  assert.deepEqual(capacityState(svc, NOW - 2 * 60_000, NOW, grace), { state: "starting", reason: "starting (1/5 running)" });
  assert.deepEqual(capacityState(svc, undefined, NOW, grace), { state: "starting", reason: "starting (1/5 running)" }, "first sight of a shortfall");
  assert.deepEqual(capacityState(svc, NOW - 7 * 60_000, NOW, grace), { state: "short", reason: "1/5 running · 4 pending for 7 min" });
  assert.equal(capacityState(svc, NOW - grace, NOW, grace).state, "short", "the grace boundary itself is short");
});

test("capacity: full, scaled to 0, over-provisioned and mid-rollout are not short", () => {
  const grace = 5 * 60_000;
  assert.deepEqual(capacityState({ desired: 2, running: 2, pending: 0, rollout: false }, NOW - 3600_000, NOW, grace), { state: "ok" });
  assert.deepEqual(capacityState({ desired: 0, running: 0, pending: 0, rollout: false }, NOW - 3600_000, NOW, grace), { state: "ok" });
  assert.deepEqual(capacityState({ desired: 2, running: 3, pending: 0, rollout: false }, undefined, NOW, grace), { state: "ok" });
  assert.equal(capacityState({ desired: 3, running: 1, pending: 2, rollout: true }, NOW - 3600_000, NOW, grace).state, "starting");
  // No pending tasks: the reason says only what runs.
  assert.equal(capacityState({ desired: 3, running: 1, pending: 0, rollout: false }, NOW - 10 * 60_000, NOW, grace).reason, "1/3 running for 10 min");
});

// R11 wired into deriveState: the REVIEW shape (desired 5, running 1, pending 4, one healthy task, no rollout).
test("deriveState: a capacity shortfall keeps UP with 'starting' inside the grace period, then degrades", () => {
  const short = { desired: 5, running: 1, pending: 4, deployments: [dep({ desired: 5, running: 1, pending: 4 })] };
  const first = deriveState(sig({ probe: undefined }, short), NOW);
  assert.equal(first.state, "UP", "first sight of a shortfall is still within the grace period");
  assert.deepEqual(first.reasons, ["starting (1/5 running)"], "never '1/5 running, healthy'");
  const within = deriveState(sig({ probe: undefined }, short), NOW, { shortfallSince: NOW - 4 * 60_000 });
  assert.deepEqual([within.state, within.reasons[0]], ["UP", "starting (1/5 running)"]);
  const after = deriveState(sig({ probe: undefined }, short), NOW, { shortfallSince: NOW - 7 * 60_000 });
  assert.equal(after.state, "DEGRADED");
  assert.deepEqual(after.reasons, ["1/5 running · 4 pending for 7 min"]);
  // A custom grace period is honoured.
  assert.equal(deriveState(sig({ probe: undefined }, short), NOW, { shortfallSince: NOW - 61_000, graceMs: 60_000 }).state, "DEGRADED");
});

test("deriveState: full capacity ignores a stale shortfallSince; other faults keep the starting note", () => {
  assert.equal(deriveState(sig(), NOW, { shortfallSince: NOW - 3600_000 }).state, "UP");
  const d = deriveState(sig({}, { desired: 2, running: 1, tasks: [task({ health: "UNHEALTHY" })] }), NOW, { shortfallSince: NOW - 60_000 });
  assert.equal(d.state, "DEGRADED");
  assert.deepEqual(d.reasons, ["container health check UNHEALTHY", "starting (1/2 running)"]);
});

// F29 hardening: ECS says a task runs but DescribeTasks returned no task details.
test("deriveState: running > 0 without task details is never DOWN 'no running task'", () => {
  const d = deriveState(sig({ probe: undefined }, { running: 1, tasks: [] }), NOW);
  assert.equal(d.state, "UP");
  assert.deepEqual(d.reasons, ["1/1 running (task details unavailable)"]);
  // A failing probe without task details degrades (it can't prove that no task is healthy).
  const p = deriveState(sig({ probe: { url: "u", pass: false, consecutiveFailures: 3, status: 502 } }, { running: 1, tasks: [] }), NOW);
  assert.equal(p.state, "DEGRADED");
  assert.match(p.reasons.join(), /probe failing/);
  // Nothing running at all is still DOWN.
  assert.equal(deriveState(sig({}, { running: 0, tasks: [] }), NOW).state, "DOWN");
});

// R13: a partial task listing (the RUNNING listing hit its page cap) can't prove that no task is healthy.
test("deriveState: a failing probe with an incomplete task list degrades instead of DOWN", () => {
  const probe = { url: "u", pass: false, consecutiveFailures: 3, status: 502 };
  assert.equal(state(sig({ probe }, { running: 3, tasks: [task({ health: "UNHEALTHY" })], tasksComplete: false })), "DEGRADED");
  assert.equal(state(sig({ probe }, { running: 3, tasks: [task({ health: "UNHEALTHY" })], tasksComplete: true })), "DOWN");
});

test("compose workloads: the box decides first, then the health check; never UP on a failing probe", () => {
  const box = (state: string): { ok: true; value: RawBox } => ({ ok: true, value: { id: "i-0123456789abcdef0", name: "stg", state, type: "t3a.small", securityGroups: [], tags: {} } });
  const probe = (pass: boolean, consecutiveFailures = 0) => ({ url: "https://api.example.com/ready", pass, consecutiveFailures, status: pass ? 200 : 502, ms: 40 });
  assert.equal(deriveWorkloadState({ ok: false, error: "AccessDenied" }, probe(true)).state, "UNKNOWN");
  assert.deepEqual(deriveWorkloadState({ ok: true, value: null }), { state: "BOX_STOPPED", reasons: ["box is missing"] });
  assert.equal(deriveWorkloadState(box("stopped"), probe(false, 9)).state, "BOX_STOPPED", "a parked box isn't an outage");
  assert.equal(deriveWorkloadState(box("running"), probe(true)).state, "UP");
  assert.equal(deriveWorkloadState(box("running"), probe(false, 1)).state, "DEGRADED");
  assert.equal(deriveWorkloadState(box("running"), probe(false, LIMITS.probeFailuresToFail)).state, "DOWN");
  assert.match(deriveWorkloadState(box("running")).reasons[0], /no health check/);
});
