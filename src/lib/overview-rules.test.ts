import { test } from "node:test";
import assert from "node:assert/strict";
import {
  autoscalingNote, ecsServicesOf, imageVerdict, lbRollup, migrationsWhy, mutableTag, outsideRange, rateStat, samplerStaleness, sig3,
  targetGroupItem, tgInputs, trafficPlan, trafficRates, VERIFIED_ACTION, verificationOf, verifyOutcome, withCapability, type ImageRefInfo,
} from "./overview-rules.ts";
import type { ActionSpec, RawDeployment, RawService, RawTargetHealth } from "./types.ts";

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const TG = "arn:aws:elasticloadbalancing:eu-west-1:123456789012:targetgroup";
const LB = "arn:aws:elasticloadbalancing:eu-west-1:123456789012:loadbalancer/app";
const th = (name: string, healthy: number, unhealthy = 0, o: Partial<RawTargetHealth> = {}): RawTargetHealth => ({ targetGroupArn: `${TG}/${name}/1`, healthy, unhealthy, reasons: [], ...o });

// F01 — the anonymised real shape: three target groups, one of them belonging to a service scaled to 0.
test("F01: three target groups with one parked → UP; all parked → STOPPED; desired 1 with 0 healthy → bad", () => {
  const services = [
    { desired: 1, targetGroupArns: [`${TG}/acme-api/1`] },
    { desired: 1, targetGroupArns: [`${TG}/acme-web/1`] },
    { desired: 0, targetGroupArns: [`${TG}/acme-admin/1`] },
  ];
  const health = [th("acme-api", 1), th("acme-web", 1), th("acme-admin", 0)];
  const up = lbRollup(services, health);
  assert.equal(up.state, "UP");
  assert.equal(up.reason, "2/2 active target groups healthy · acme-admin idle (service scaled to 0)");
  const parked = lbRollup(services.map((s) => ({ ...s, desired: 0 })), health.map((h) => ({ ...h, healthy: 0 })));
  assert.equal(parked.state, "STOPPED");
  const bad = lbRollup([{ desired: 1, targetGroupArns: [`${TG}/acme-api/1`] }], [th("acme-api", 0)]);
  assert.equal(bad.state, "DOWN");
  assert.equal(bad.bad, 1);
});

test("F01: desired sums every service attached to a target group; an unreferenced group stays unknown (active)", () => {
  const inputs = tgInputs(
    [{ desired: 0, targetGroupArns: [`${TG}/shared/1`] }, { desired: 2, targetGroupArns: [`${TG}/shared/1`, `${TG}/shared/1`] }],
    [th("shared", 2), th("orphan", 0)],
  );
  assert.equal(inputs[0].desired, 2, "a group shared with a running service is active");
  assert.equal(inputs[1].desired, undefined);
});

// The A2 review note: a group whose service was just stopped drains its targets for the deregistration delay.
test("F01: targets draining from a stopped service's group don't make the load balancer DOWN", () => {
  const services = [{ desired: 0, targetGroupArns: [`${TG}/acme-admin/1`] }, { desired: 1, targetGroupArns: [`${TG}/acme-api/1`] }];
  const r = lbRollup(services, [th("acme-admin", 0, 0, { draining: 1 }), th("acme-api", 1)]);
  assert.equal(r.state, "UP");
  assert.match(r.reason, /acme-admin idle/);
  // A running service's draining-only group still counts (nothing healthy serves it).
  assert.equal(lbRollup([{ desired: 1, targetGroupArns: [`${TG}/acme-api/1`] }], [th("acme-api", 0, 0, { draining: 1 })]).state, "DOWN");
  assert.deepEqual(targetGroupItem(th("acme-admin", 0, 0, { draining: 2 }), 0), { label: "Target group acme-admin", value: "2 draining (service stopped)", tone: "muted" });
});

test("F01: the service panel shows a stopped service's empty target group muted", () => {
  assert.deepEqual(targetGroupItem(th("acme-admin", 0), 0), { label: "Target group acme-admin", value: "no targets (service stopped)", tone: "muted" });
  assert.equal(targetGroupItem(th("acme-api", 0), 1).tone, "bad");
  assert.equal(targetGroupItem(th("acme-api", 2, 0, { initial: 1 }), 3).value, "2 healthy · 0 unhealthy · 1 registering");
  assert.equal(targetGroupItem(th("acme-api", 2), 2).tone, "ok");
});

test("F09: significant digits instead of 0.1 steps; req/min below one request per second", () => {
  assert.equal(sig3(0.0123456), 0.0123);
  assert.equal(sig3(1234.5), 1230);
  assert.equal(sig3(0), 0);
  assert.deepEqual(rateStat(12), { label: "req/min", value: "12" });
  assert.deepEqual(rateStat(0.5), { label: "req/min", value: "0.5" });
  assert.deepEqual(rateStat(1518), { label: "rps", value: "25.3" });
});

// R22 — each target group on its own load balancer; the env total over distinct load balancers.
test("R22: traffic per target group on its own ALB, totals per distinct ALB", () => {
  const services = [
    { name: "api", targetGroupArns: [`${TG}/api/1`, `${TG}/api-grpc/2`] },
    { name: "web", targetGroupArns: [`${TG}/web/3`] },
    { name: "admin", targetGroupArns: [`${TG}/admin/4`] },
    { name: "orphan", targetGroupArns: [`${TG}/orphan/5`] },
  ];
  const tglb = { [`${TG}/api/1`]: `${LB}/public/aaa`, [`${TG}/api-grpc/2`]: `${LB}/public/aaa`, [`${TG}/web/3`]: `${LB}/public/aaa`, [`${TG}/admin/4`]: `${LB}/internal/bbb` };
  const plan = trafficPlan(services, tglb);
  const dims = Object.fromEntries(plan.specs.map((s) => [s.id, s.dims]));
  assert.deepEqual(dims[plan.services.admin[0]], { TargetGroup: "targetgroup/admin/4", LoadBalancer: "app/internal/bbb" }, "admin is measured on its own ALB");
  assert.deepEqual(dims[plan.services.web[0]], { TargetGroup: "targetgroup/web/3", LoadBalancer: "app/public/aaa" });
  assert.ok(plan.specs.every((s) => s.metric === "RequestCount" && s.stat === "Sum"), "never RequestCountPerTarget");
  assert.equal(Object.keys(plan.lbs).length, 2);
  assert.equal(plan.services.orphan, undefined, "a target group without a load balancer has no metric");
  const pts = (v: number) => [[1, v], [2, v]] as [number, number][];
  const data = {
    [plan.services.api[0]]: pts(100), [plan.services.api[1]]: pts(20), [plan.services.web[0]]: pts(30), [plan.services.admin[0]]: pts(5),
    [plan.lbs[`${LB}/public/aaa`]]: pts(160), [plan.lbs[`${LB}/internal/bbb`]]: pts(5),
  };
  const r = trafficRates(plan, data);
  assert.deepEqual(r.services, { api: 120, web: 30, admin: 5 });
  assert.equal(r.total, 165, "each ALB once, including requests that reach no service (redirects, fixed responses)");
  assert.equal(trafficRates(plan, {}).total, undefined);
});

// R24 — every essential container; the semantic-version tag that used to pass as present.
const ref = (o: Partial<ImageRefInfo> = {}): ImageRefInfo => ({ container: "api", image: "x", ecr: true, repository: "acme/api", tag: "v1.2.3", ...o });
test("R24: missing beats unknown beats present; an empty ECR answer is missing, never present", () => {
  assert.deepEqual(imageVerdict([{ ref: ref(), found: { exists: false } }]), {
    imageCheck: "missing", present: false, why: "acme/api:v1.2.3 (api) is no longer in ECR — the revision can't start",
  });
  const sidecar = { ref: ref({ container: "envoy", repository: "acme/envoy", tag: "latest" }), found: { exists: true, digest: "sha256:1" } };
  assert.equal(imageVerdict([sidecar, { ref: ref(), found: { exists: false } }]).imageCheck, "missing", "every essential container counts");
  const unknown = imageVerdict([{ ref: ref(), found: { exists: true } }, { ref: ref({ container: "log", repository: "acme/log" }), error: "AccessDeniedException" }]);
  assert.equal(unknown.imageCheck, "unknown");
  assert.equal(unknown.present, true, "unverifiable is allowed (with a warning)");
  assert.match(unknown.why!, /couldn't check \(AccessDeniedException\)/);
  const caddy = { ref: ref({ container: "caddy", ecr: false, repository: "caddy", tag: "2-alpine" }), found: null };
  assert.deepEqual(imageVerdict([caddy]), { imageCheck: "unknown", present: true, why: "caddy:2-alpine: not an ECR image, its registry isn't checked" });
  // A public sidecar beside an ECR image: the ECR image decides, the sidecar is named.
  assert.deepEqual(imageVerdict([{ ref: ref(), found: { exists: true, digest: "sha256:abc" } }, caddy]), {
    imageCheck: "present", present: true, digest: "sha256:abc", why: "caddy:2-alpine: not an ECR image, its registry isn't checked",
  });
  assert.equal(imageVerdict([{ ref: ref(), found: { exists: false } }, caddy]).imageCheck, "missing");
  assert.equal(imageVerdict([{ ref: ref(), error: "ThrottlingException" }, caddy]).imageCheck, "unknown");
  assert.deepEqual(imageVerdict([{ ref: ref(), found: { exists: true, digest: "sha256:abc" } }]), { imageCheck: "present", present: true, digest: "sha256:abc" });
});

// F68 — revision 1 uses the mutable tag "production".
test("F68: a tag shared with the live revision, or one that moved, is flagged with the warning text", () => {
  const D1 = "sha256:1111111111111111aaaa";
  const D2 = "sha256:2222222222222222bbbb";
  const old = mutableTag({ tag: "production", digestPinned: false, current: D2, live: D1, isLive: false, sameRefAsLive: true });
  assert.deepEqual(old, { mutable: true, why: "tag production now points to sha256:222222222222; switching to this revision may not restore the image it originally ran" });
  assert.equal(mutableTag({ tag: "production", digestPinned: false, current: D1, live: D1, isLive: false, sameRefAsLive: true }).mutable, true);
  assert.match(mutableTag({ tag: "production", digestPinned: false, current: D2, live: D1, isLive: true, sameRefAsLive: true }).why!, /a restart would start the new image/);
  assert.equal(mutableTag({ tag: "production", digestPinned: false, current: D1, live: D1, isLive: true, sameRefAsLive: true }).mutable, false);
  assert.equal(mutableTag({ tag: "staging-abc1234", digestPinned: false, current: D2, live: D1, isLive: false, sameRefAsLive: false }).mutable, false, "a different tag is a different image");
  assert.equal(mutableTag({ tag: "x", digestPinned: true, current: D2, live: D1, isLive: false, sameRefAsLive: true }).mutable, false, "digest references can't move");
});

test("F07: why a migration check couldn't be made", () => {
  assert.equal(migrationsWhy(Object.assign(new Error("Bad credentials"), { status: 401 })), "GitHub not connected");
  assert.equal(migrationsWhy(new Error("GITHUB_TOKEN is not set")), "GitHub not connected");
  assert.equal(migrationsWhy(Object.assign(new Error("API rate limit exceeded"), { status: 403 })), "rate limited");
  assert.equal(migrationsWhy({ status: 429, message: "slow down" }), "rate limited");
  assert.equal(migrationsWhy(new Error("socket hang up")), "compare failed");
});

test("F06: denied disables with the reason, probably denied warns, unknown changes nothing", () => {
  const spec: ActionSpec = { name: "restart", label: "Restart", enabled: true };
  assert.deepEqual(withCapability(spec, { state: "denied", missing: ["ecs:UpdateService"] }, ["ecs:UpdateService"]), {
    ...spec, enabled: false, why: "the console's AWS identity can't call ecs:UpdateService",
  });
  assert.equal(withCapability(spec, { state: "probably-denied", missing: ["ecs:UpdateService"] }, ["ecs:UpdateService"]).warning, "AWS permission not verified — likely denied (ecs:UpdateService)");
  assert.deepEqual(withCapability(spec, { state: "unknown", missing: [] }, ["ecs:UpdateService"]), spec);
  const blocked = { ...spec, enabled: false, why: "service is stopped" };
  assert.equal(withCapability(blocked, { state: "denied", missing: ["ecs:UpdateService"] }, ["ecs:UpdateService"]).why, "service is stopped", "the guard's own reason stays");
});

test("CC-20: the autoscaling note and range", () => {
  const a = { min: 2, max: 6, policies: ["cpu-60"] };
  assert.equal(autoscalingNote(a), "Application Auto Scaling manages this service (min 2, max 6): a desired count outside that range is overridden");
  assert.equal(outsideRange(a, 0), true);
  assert.equal(outsideRange(a, 3), false);
  assert.equal(outsideRange(a, 7), true);
});

test("R21: an env is stale after three sampler intervals, and before its first sample once the sampler has run that long", () => {
  const o = { now: NOW, intervalMs: 30_000, intervals: 3 };
  assert.deepEqual(samplerStaleness({ ...o, sampledAt: NOW - 90_000 }), { stale: false });
  const s = samplerStaleness({ ...o, sampledAt: NOW - 4 * MIN });
  assert.equal(s.stale, true);
  assert.match(s.reason!, /^not sampled since \d\d:\d\d UTC \(4 min ago\)$/);
  assert.deepEqual(samplerStaleness({ ...o, startedAt: NOW - 30_000 }), { stale: false });
  assert.match(samplerStaleness({ ...o, startedAt: NOW - 5 * MIN }).reason!, /^not sampled yet/);
  assert.equal(samplerStaleness({ ...o }).reason, "the background sampler is not running");
});

// ---------- outcome verification ----------

const dep = (o: Partial<RawDeployment> = {}): RawDeployment => ({
  id: "d1", status: "PRIMARY", rolloutState: "COMPLETED", taskDefinition: "td:5", desired: 2, running: 2, pending: 0, failedTasks: 0, createdAt: NOW - 2 * MIN, updatedAt: NOW - MIN, ...o,
});
const svc = (o: Partial<RawService> = {}): RawService => ({
  name: "api", cluster: "acme-staging", status: "ACTIVE", desired: 2, running: 2, pending: 0, launchType: "FARGATE", deployments: [dep()], tasks: [],
  taskDef: null, targetGroupArns: [], circuitBreaker: true, tags: {}, securityGroups: [], subnets: [], ...o,
});
const op = (action: string, ageMin: number, params?: Record<string, unknown>) => ({ action, createdAt: NOW - ageMin * MIN, params });

test("verify: restart is verified once a deployment newer than the request has completed", () => {
  assert.deepEqual(verifyOutcome(op("services.restart", 3), svc(), NOW), { result: "verified" });
  const rolling = svc({ deployments: [dep({ rolloutState: "IN_PROGRESS", createdAt: NOW - MIN }), dep({ id: "d0", status: "ACTIVE", createdAt: NOW - 60 * MIN })] });
  assert.equal(verifyOutcome(op("services.restart", 2), rolling, NOW).result, "pending");
  assert.equal(verifyOutcome(op("services.restart", 1), svc({ deployments: [dep({ createdAt: NOW - 60 * MIN })] }), NOW).result, "pending", "no new deployment yet");
  assert.deepEqual(verifyOutcome(op("services.restart", 16), rolling, NOW), { result: "failed", detail: "did not stabilise in 15 min" });
});

test("verify: a rollout that failed after the request fails the operation at once", () => {
  const rolledBack = svc({ deployments: [dep({ createdAt: NOW - 30_000 }), dep({ id: "d2", status: "INACTIVE", rolloutState: "FAILED", rolloutReason: "circuit breaker", createdAt: NOW - 2 * MIN })] });
  assert.deepEqual(verifyOutcome(op("services.switch", 3, { to: "td:7" }), rolledBack, NOW), { result: "failed", detail: "rollout failed: circuit breaker" });
});

test("verify: stop, start, scale and switch check the change itself", () => {
  assert.equal(verifyOutcome(op("services.stop", 1, { desiredAfter: 0 }), svc({ desired: 0, running: 0 }), NOW).result, "verified");
  assert.equal(verifyOutcome(op("services.stop", 1), svc({ desired: 0, running: 1 }), NOW).result, "pending", "tasks still stopping");
  assert.equal(verifyOutcome(op("services.start", 1, { desiredAfter: 2 }), svc(), NOW).result, "verified");
  assert.equal(verifyOutcome(op("services.start", 1, { desiredAfter: 3 }), svc(), NOW).result, "pending", "the autoscaler or someone else set another count");
  assert.equal(verifyOutcome(op("services.scale", 1, { desiredAfter: 2 }), svc({ pending: 1, running: 1 }), NOW).result, "pending");
  assert.equal(verifyOutcome(op("services.switch", 3, { to: "td:5" }), svc(), NOW).result, "verified");
  assert.equal(verifyOutcome(op("services.switch", 3, { to: "td:9" }), svc(), NOW).result, "pending");
});

test("verify: deletes, missing services and unreadable services", () => {
  assert.equal(verifyOutcome(op("services.delete", 1), undefined, NOW).result, "verified");
  assert.equal(verifyOutcome(op("services.delete", 1), svc({ status: "DRAINING" }), NOW).result, "verified");
  assert.equal(verifyOutcome(op("services.restart", 1), undefined, NOW).result, "pending");
  assert.deepEqual(verifyOutcome(op("services.restart", 20), undefined, NOW), { result: "failed", detail: "the service is no longer in the cluster" });
  assert.equal(verifyOutcome(op("services.restart", 20), null, NOW).result, "pending", "never failed just because the read failed");
});

test("verify: helpers", () => {
  assert.deepEqual([verificationOf(null), verificationOf("verified"), verificationOf("failed")], ["accepted", "verified", "failed"]);
  assert.deepEqual(ecsServicesOf(["ecs-service:us-east-1/acme-staging/api", "ec2:us-east-1/i-1", 7]), [{ region: "us-east-1", cluster: "acme-staging", service: "api" }]);
  assert.deepEqual(ecsServicesOf("nope"), []);
  // The actions the sampler verifies: console, map and image-deploy changes, and provisioning's scale and delete.
  for (const a of ["services.restart", "ecs.scale", "ecs-image.deploy-image", "provision.scale", "provision.delete-service"]) assert.ok(VERIFIED_ACTION.test(a), a);
  for (const a of ["provision.run-task", "provision.clone", "vars.edit", "ci.rerun", "hosts.stop", "services"]) assert.ok(!VERIFIED_ACTION.test(a), a);
});

// ---------- the server side, end to end on the simulated account ----------
// src/lib/server/console.ts imports "server-only", which only resolves under the react-server condition, so this runs
// in a child process: console actions through the mutation coordinator (R04), outcome unknown (F31), the action
// listeners, the overview's load balancer, capacity and operations, revisions (R24), and one
// sampler tick (R21 freshness, persisted history and its restore, operation verification).
import { execFileSync } from "node:child_process";

const scenario = String.raw`
const at = (f) => new URL(f, ${JSON.stringify(new URL("./server/", import.meta.url).href)}).href;
const { mockCloud } = await import(at("mock.ts"));
const { OutcomeUnknownError } = await import(at("errors.ts"));
const base = mockCloud();
const S = { gate: undefined, calls: 0, unknown: false, services: {}, tgs: {} };
globalThis.__consoleCloud = Promise.resolve({
  ...base,
  services: async (cluster) => (await base.services(cluster)).map((s) => S.services[cluster + "/" + s.name] ? { ...s, ...S.services[cluster + "/" + s.name] } : s),
  targetHealth: async (arns) => (await base.targetHealth(arns)).map((h) => S.tgs[h.targetGroupArn] ? { ...h, ...S.tgs[h.targetGroupArn] } : h),
  // A revision re-tagged without a git sha (R25).
  revisions: async (family) => (await base.revisions(family)).map((r) => {
    if (r.arn !== S.untag) return r;
    const retag = (image) => image.replace(/:[^:@/]+$/, ":nightly");
    return { ...r, image: retag(r.image), containers: r.containers?.map((c) => ({ ...c, image: retag(c.image) })) };
  }),
  updateService: async (cluster, service, change) => {
    S.calls++;
    if (S.gate) await S.gate;
    if (S.unknown) throw new OutcomeUnknownError(undefined, { requestId: "req-lost" });
    return base.updateService(cluster, service, change);
  },
});
const C = await import(at("console.ts"));
const { mutate } = await import(at("mutations.ts"));
const { keysForInventory } = await import(at("../mutation-keys.ts"));
const { getDb } = await import(at("db.ts"));
const { readAudit } = await import(at("audit.ts"));
const { invalidate } = await import(at("cache.ts"));
const { envInfo } = await import(at("discovery.ts"));
const { uptime } = await import(at("../history.ts"));
const run = (p) => p.then((r) => ({ ok: true, ...r }), (e) => ({ ok: false, status: e.status, code: e.code, error: e.message, operationId: e.operationId }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const db = await getDb();
const out = {};
const events = [];
C.onAction((e) => events.push([e.action, e.target, e.result, e.env.id, !!e.operationId]));
C.onAction(() => { throw new Error("a broken listener"); });
const opCount = async () => Number((await db.get("SELECT COUNT(*) AS n FROM operations")).n);

// What a previous console process left behind: a database's state changes and the span the sampler observed.
const now = Date.now();
await db.run("INSERT INTO settings (key, value) VALUES (?, ?)", ["observed:production", JSON.stringify([[now - 100 * 60_000, now - 30 * 60_000]])]);
for (const [ago, state] of [[90, "UP"], [60, "DOWN"], [50, "UP"]]) await db.run("INSERT INTO state_changes (id, env, rkey, state, at) VALUES (?, ?, ?, ?, ?)", [crypto.randomUUID(), "production", "database:acme-production-pg", state, now - ago * 60_000]);

// R04: a console action is one operation under the service's canonical key.
out.restart = await run(C.act("staging", "api", { action: "restart", confirm: "yes" }, { display: "dev@acme.example", kind: "person", userId: "u-dev" }, "198.51.100.7"));
out.restartRow = await db.get("SELECT action, state, targets, actor, actor_kind, env, region, verify, params FROM operations WHERE id = ?", [out.restart.operationId]);
out.restartAudit = (await readAudit(20)).filter((a) => a.operationId === out.restart.operationId).map((a) => [a.phase, a.action, a.result ?? null, a.user, a.ip ?? null]).sort();

// While a restart of staging/worker is in flight, a map action on the same service (its inventory key) and a second
// console action are refused, and the tile shows the service as locked.
let release;
S.gate = new Promise((r) => (release = r));
const first = run(C.act("staging", "worker", { action: "restart", confirm: "yes" }, "dev@acme.example"));
for (let i = 0; i < 100 && S.calls < 2; i++) await sleep(10);
out.mapWhileBusy = await run(mutate({ action: "ecs.restart", actor: { display: "map@acme.example", kind: "person" }, target: "worker", keys: keysForInventory("ecs:service/acme-staging/worker", "us-east-1", "us-east-1"), params: {} }, async (h) => { await h.intent(); return "x"; }));
out.consoleWhileBusy = await run(C.act("staging", "worker", { action: "stop", confirm: "yes" }, "dev@acme.example"));
out.lockedTile = (await C.overview("staging", { light: true })).services.find((s) => s.id === "worker").actions.find((a) => a.name === "stop");
release();
S.gate = undefined;
out.first = await first;
// Any other mutate() caller reaches the action listeners too.
out.direct = await run(mutate({ action: "vars.edit", actor: { display: "dev@acme.example", kind: "person" }, target: "worker", keys: [], params: {} }, async (h) => { await h.intent(); return "r-1"; }));

// A refusal before the intent leaves nothing behind.
const before = await opCount();
out.refused = await run(C.act("staging", "api", { action: "start", confirm: "yes" }, "dev@acme.example"));
out.refusedRows = (await opCount()) - before;

// F31: AWS may have acted → outcome unknown, audited "unknown", 502.
S.unknown = true;
out.unknown = await run(C.act("staging", "billing", { action: "restart", confirm: "yes" }, "dev@acme.example"));
S.unknown = false;
out.unknownRow = await db.get("SELECT state, error FROM operations WHERE id = ?", [out.unknown.operationId]);
out.unknownAudit = (await readAudit(20)).filter((a) => a.operationId === out.unknown.operationId && a.phase === "result").map((a) => a.result);

// A variables reveal (keys of its own), integration and ticket changes (never posted as actions), and power through the
// coordinator.
const staging = await envInfo("staging");
out.reveal = await run(mutate({ action: "env.reveal", actor: { display: "dev@acme.example", kind: "person" }, env: { id: staging.id, label: staging.label, protected: staging.protected }, target: "worker", keys: [], params: { names: ["A"] } }, async (h) => { await h.intent(); return ""; }));
out.revealRow = await db.get("SELECT action, state, targets FROM operations WHERE id = ?", [out.reveal.operationId]);
out.integration = await run(mutate({ action: "integration.save", actor: { display: "dev@acme.example", kind: "person" }, target: "slack", keys: [], params: {} }, async (h) => { await h.intent(); return ""; }));
out.ticket = await run(mutate({ action: "ticket.create", actor: { display: "dev@acme.example", kind: "person" }, target: "jira", keys: [], params: {} }, async (h) => { await h.intent(); return ""; }));
const hostId = (await C.overview("staging", { light: true })).infra.find((r) => r.kind === "box").id;
out.power = await run(C.powerAct("staging", "host", hostId, "stop", "yes", "dev@acme.example"));
out.powerRow = await db.get("SELECT action, targets FROM operations WHERE id = ?", [out.power.operationId]);
out.powerProtected = await run(C.powerAct("production", "database", "acme-production-pg", "stop", "yes", "dev@acme.example"));

// R11 + F01 in the overview: a production service scaled to 0 with an empty target group, another short of capacity.
const prod = await envInfo("production");
const prodSvcs = await base.services(prod.cluster);
const billing = prodSvcs.find((s) => s.name === "billing");
S.services[prod.cluster + "/billing"] = { desired: 0, running: 0, pending: 0, tasks: [] };
S.tgs[billing.targetGroupArns[0]] = { healthy: 0, unhealthy: 0, initial: 0, draining: 0, targets: [], reasons: [] };
S.services[prod.cluster + "/worker"] = { desired: 5, running: 1, pending: 4 };
invalidate("svc:"); invalidate("tgh:");
const ov1 = await C.overview("production");
globalThis.__consoleShared.shortfall.set("production/worker", Date.now() - 7 * 60_000);
const ov2 = await C.overview("production", { light: true });
const tile = (o, id) => o.services.find((s) => s.id === id);
const lb = ov1.infra.find((r) => r.kind === "loadbalancer");
out.ov = {
  region: ov1.region, freshness: ov1.freshness, billing: [tile(ov1, "billing").state, tile(ov1, "billing").properties.find((g) => g.title === "Health").items.find((i) => i.label.startsWith("Target group"))],
  lb: [lb.state, lb.reasons, lb.stats.map((s) => s.label), lb.fetchedAt > 0],
  starting: [tile(ov1, "worker").state, tile(ov1, "worker").reasons, tile(ov1, "worker").capacity],
  short: [tile(ov2, "worker").state, tile(ov2, "worker").reasons],
  autoscaling: tile(ov1, "api").autoscaling ?? null,
  stopWarning: tile(ov1, "api").actions.find((a) => a.name === "stop").warning ?? null,
  rates: ov1.topology.edges.filter((e) => e.rate).map((e) => e.to),
  fetchedAt: ov1.services.every((s) => s.fetchedAt > 0) && ov1.infra.every((s) => s.fetchedAt > 0),
  uptimeBasis: tile(ov1, "api").uptime.basis,
};
S.services = {}; S.tgs = {};
invalidate("svc:"); invalidate("tgh:");
out.stagingOps = ((await C.overview("staging")).services.find((s) => s.id === "api").operations ?? []).map((o) => [o.action, o.verification, o.id === out.restart.operationId]);

// R24: every revision's image checked; the expired one is missing, the Docker Hub image unknown.
out.revs = (await C.revisions("production", "api")).map((r) => [r.live, r.imageCheck, r.imagePresent]);
// R25: a revision whose tag carries no git sha can't be compared — "unknown" (acknowledgement required), never false.
S.untag = (await C.revisions("production", "api")).find((r) => !r.live && r.migrations === false)?.arn;
invalidate("revs:");
out.untagged = (await C.revisions("production", "api")).filter((r) => r.arn === S.untag).map((r) => [r.sha ?? null, r.migrations ?? null, r.migrationsWhy ?? null]);
S.untag = undefined;
invalidate("revs:");
out.caddyRevs = (await C.revisions("staging", "caddy")).map((r) => [r.imageCheck, r.imageCheckWhy ?? null]);
out.hasEvents = (await C.events("staging", "api")).length > 0;
out.lbMetrics = (await C.metrics("production", "loadbalancer:alb", 60.4)).map((s) => s.id);
out.minutes = [C.metricMinutes(60.4), C.metricMinutes("x"), C.metricMinutes(5), C.metricMinutes(99999)];

// One sampler tick after a "previous process": state history restored from state_changes + observed spans,
// sampledAt per env, operations verified.
const op = (id, action, ageMin, service, params) => db.run(
  "INSERT INTO operations (id, action, actor, actor_kind, env, region, targets, params, state, fence, created_at, started_at, finished_at) VALUES (?, ?, 'x', 'person', 'production', 'us-east-1', ?, ?, 'succeeded', 1, ?, ?, ?)",
  [id, action, JSON.stringify({ target: service, keys: ["ecs-service:us-east-1/acme-production/" + service] }), JSON.stringify(params ?? {}), now - ageMin * 60_000, now - ageMin * 60_000, now - ageMin * 60_000],
);
// 150 other operations on the same service in the last hour must not crowd the ECS ones out of the bounded query.
for (let i = 0; i < 150; i++) await op("n-" + String(i).padStart(3, "0"), "vars.edit", 30, "api");
await op("v-scale", "provision.scale", 1, "worker", { desiredBefore: 5, desiredAfter: 1 });
await op("v-old", "services.restart", 20, "api");
await op("v-other", "env.update", 20, "api");
out.beforeTick = C.samplerStatus("production");
C.startSampler();
for (let i = 0; i < 600 && !C.samplerHealth().lastTickAt; i++) await sleep(50);
out.health = C.samplerHealth();
out.sampled = C.samplerStatus("production");
out.verify = await db.all("SELECT id, verify, error FROM operations WHERE id IN ('v-scale', 'v-old', 'v-other') ORDER BY id");
out.restartVerify = (await db.get("SELECT verify FROM operations WHERE id = ?", [out.restart.operationId])).verify;
// The audit log carries each verified-kind change's outcome; other changes carry none.
for (const [id, action] of [["v-old", "services.restart"], ["v-scale", "provision.scale"], ["v-other", "env.update"]])
  await db.run("INSERT INTO audit (id, at, phase, env, target, action, actor, ip, reason, params, result, detail, operation_id) VALUES (?, ?, 'result', 'production', 'api', ?, 'x', NULL, NULL, '{}', 'ok', NULL, ?)", ["a-" + id, now - 60_000, action, id]);
out.auditVerify = (await C.auditLog(500)).filter((r) => ["v-old", "v-scale", "v-other", out.restart.operationId].includes(r.operationId) && r.phase === "result")
  .map((r) => [r.operationId === out.restart.operationId ? "restart" : r.operationId, r.verify === undefined ? "absent" : r.verify, r.verifyDetail ?? null]).sort((a, b) => a[0].localeCompare(b[0]));
out.spans = JSON.parse((await db.get("SELECT value FROM settings WHERE key = 'observed:production'")).value).length;
out.persisted = Number((await db.get("SELECT COUNT(*) AS n FROM state_changes WHERE env = 'staging'")).n);
const u = uptime("production/database:acme-production-pg");
out.restored = { pct: u.pct, coveredMin: Math.round(u.coveredMs / 60_000), gap: u.gapMs > 0, down: u.bars.includes("DOWN"), since: u.since === now - 50 * 60_000 };
out.events = events;
console.log(JSON.stringify(out));
process.exit(0);
`;

const env = { ...process.env, CONSOLE_SOURCE: "mock", CONSOLE_SQLITE_PATH: ":memory:", DATABASE_URL: "", CONSOLE_REGIONS: "", CONSOLE_SELF: "", ECS_CONTAINER_METADATA_URI_V4: "", CONSOLE_CONFIG: "", NODE_NO_WARNINGS: "1" };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const o = JSON.parse(execFileSync(process.execPath, ["--conditions=react-server", "--no-warnings", "--input-type=module", "-e", scenario], { encoding: "utf8", env, timeout: 120_000 }).trim().split("\n").pop()!) as Record<string, any>;

test("R04: a console action is one operation under the service's canonical key, audited with its id", () => {
  assert.equal(o.restart.ok, true, o.restart.error);
  assert.equal(o.restart.verification, "accepted");
  assert.match(o.restart.operationId, /^[0-9a-f-]{36}$/);
  assert.equal(o.restartRow.action, "services.restart");
  assert.equal(o.restartRow.state, "succeeded");
  assert.deepEqual(JSON.parse(o.restartRow.targets).keys, ["ecs-service:us-east-1/acme-staging/api"]);
  assert.deepEqual([o.restartRow.actor, o.restartRow.actor_kind, o.restartRow.env, o.restartRow.region, o.restartRow.verify], ["dev@acme.example", "person", "staging", "us-east-1", null]);
  assert.ok(JSON.parse(o.restartRow.params).from, "the live revision read under the lock is in the intent");
  assert.deepEqual(o.restartAudit, [["intent", "services.restart", null, "dev@acme.example", "198.51.100.7"], ["result", "services.restart", "ok", "dev@acme.example", "198.51.100.7"]]);
});

test("R04: a map action and a second console action on the same service are refused while one is in flight", () => {
  assert.deepEqual([o.mapWhileBusy.ok, o.mapWhileBusy.status, o.mapWhileBusy.code], [false, 409, "busy"]);
  assert.match(o.mapWhileBusy.error, /services\.restart by dev@acme\.example/);
  assert.deepEqual([o.consoleWhileBusy.ok, o.consoleWhileBusy.status], [false, 409]);
  assert.equal(o.lockedTile.enabled, false);
  assert.match(o.lockedTile.why, /still being submitted/);
  assert.equal(o.first.ok, true, o.first.error);
});

test("a refusal before the intent records nothing; outcome unknown is audited 'unknown' (F31)", () => {
  assert.deepEqual([o.refused.ok, o.refused.status, o.refusedRows], [false, 409, 0]);
  assert.deepEqual([o.unknown.ok, o.unknown.status, o.unknown.code], [false, 502, "outcome_unknown"]);
  assert.match(o.unknown.error, /outcome unknown — check the resource before retrying/);
  assert.equal(o.unknownRow.state, "outcome_unknown");
  assert.deepEqual(o.unknownAudit, ["unknown"]);
});

test("reveals and power actions go through the coordinator; listeners hear every mutation but integration and ticket changes", () => {
  assert.equal(o.reveal.ok, true, o.reveal.error);
  assert.deepEqual([o.revealRow.action, o.revealRow.state, JSON.parse(o.revealRow.targets).keys], ["env.reveal", "succeeded", []]);
  assert.deepEqual([o.integration.ok, o.ticket.ok], [true, true]);
  assert.equal(o.power.ok, true, o.power.error);
  assert.equal(o.powerRow.action, "hosts.stop");
  assert.match(JSON.parse(o.powerRow.targets).keys[0], /^ec2:us-east-1\/i-/);
  assert.deepEqual([o.powerProtected.ok, o.powerProtected.status], [false, 403]);
  const seen = o.events.map((e: unknown[]) => `${e[0]}:${e[2]}`);
  for (const want of ["services.restart:ok", "vars.edit:ok", "services.restart:error", "env.reveal:ok", "hosts.stop:ok"]) assert.ok(seen.includes(want), `${want} in ${seen.join(" ")}`);
  // R10 put integration saves and tickets on mutate(); they are audited and recorded, never posted as actions.
  assert.ok(!seen.some((e: string) => /^(integration|ticket)\./.test(e)), seen.join(" "));
  assert.ok(o.events.every((e: unknown[]) => e[4] === true), "every event names its operation");
});

test("overview: parked target group is idle (F01), capacity starting then short (R11), autoscaling warning (CC-20), freshness (R21)", () => {
  assert.equal(o.ov.region, "us-east-1");
  assert.equal(o.ov.freshness.completeness, "complete");
  assert.ok(o.ov.freshness.observedAt > 0);
  assert.equal(o.ov.billing[0], "STOPPED");
  assert.deepEqual([o.ov.billing[1].value, o.ov.billing[1].tone], ["no targets (service stopped)", "muted"]);
  assert.equal(o.ov.lb[0], "UP");
  assert.match(o.ov.lb[1][0], /idle \(service scaled to 0\)/);
  assert.ok(o.ov.lb[2].includes("healthy targets"));
  assert.equal(o.ov.lb[3], true);
  assert.deepEqual(o.ov.starting[0], "UP");
  assert.equal(o.ov.starting[1][0], "starting (1/5 running)");
  assert.equal(o.ov.starting[2].desired, 5);
  assert.ok(o.ov.starting[2].shortfallSince > 0);
  assert.deepEqual(o.ov.short, ["DEGRADED", ["1/5 running · 4 pending for 7 min"]]);
  assert.deepEqual(o.ov.autoscaling && [o.ov.autoscaling.min, o.ov.autoscaling.max], [2, 6]);
  assert.match(o.ov.stopWarning, /Application Auto Scaling manages this service \(min 2, max 6\)/);
  assert.ok(o.ov.rates.length > 0 && o.ov.rates.includes("lb:alb"), "per-service rates and the env total");
  assert.equal(o.ov.fetchedAt, true);
  assert.equal(o.ov.uptimeBasis, "operational state (not customer availability)");
  assert.deepEqual(o.stagingOps[0], ["services.restart", "accepted", true]);
});

test("revisions: every image checked (R24), metrics minutes snapped (F28)", () => {
  assert.equal(o.revs.filter((r: unknown[]) => r[0]).length, 1);
  assert.ok(o.revs.some((r: unknown[]) => r[1] === "missing" && r[2] === false), "the expired image is missing and blocks the switch");
  assert.ok(o.revs.filter((r: unknown[]) => r[1] !== "missing").every((r: unknown[]) => r[1] === "present"));
  assert.deepEqual(o.untagged, [[null, "unknown", "the revision's image tag carries no git sha"]]);
  assert.ok(o.caddyRevs.every((r: unknown[]) => r[0] === "unknown" && /not an ECR image/.test(String(r[1]))));
  assert.deepEqual(o.lbMetrics, ["rps", "p50", "p90", "p99", "t5xx", "e5xx", "conn"]);
  assert.deepEqual(o.minutes, [60, 60, 15, 10080]);
});

test("sampler tick: sampledAt per env, history restored and persisted, operations verified or failed", () => {
  assert.ok(o.health.lastTickAt > 0 && o.health.running === false);
  assert.equal(o.sampled.stale, false);
  assert.ok(o.sampled.sampledAt > 0);
  assert.deepEqual(o.verify, [
    { id: "v-old", verify: "failed", error: "did not stabilise in 15 min" },
    { id: "v-other", verify: null, error: null },
    { id: "v-scale", verify: "verified", error: null },
  ]);
  assert.equal(o.restartVerify, null, "the staging restart is still rolling out");
  assert.deepEqual(o.auditVerify, [
    ["restart", null, null], ["v-old", "failed", "did not stabilise in 15 min"], ["v-other", "absent", null], ["v-scale", "verified", null],
  ], "audit rows: accepted (verifying), failed with why, none for other actions, verified");
  assert.equal(o.spans, 2, "the old span and a new one after the gap");
  assert.ok(o.persisted > 0, "states persisted to state_changes");
  // Observed 100 → 30 min ago, but the first known state starts 90 min ago: 60 min restored, 10 of them DOWN; the
  // first own sample (minutes ago) adds a little, and the console's downtime (30 min ago → its start) is a gap.
  assert.equal(o.restored.down, true);
  assert.equal(o.restored.gap, true);
  assert.ok(o.restored.coveredMin >= 60 && o.restored.coveredMin <= 62, String(o.restored.coveredMin));
  assert.ok(o.restored.pct > 83 && o.restored.pct < 85, String(o.restored.pct));
  assert.equal(o.restored.since, true, "UP since the persisted change 50 min ago, not since this process started");
  assert.equal(o.hasEvents, true);
});
