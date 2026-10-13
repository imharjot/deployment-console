import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  DEFAULT_LIMITS, JOIN_TIMEOUT_MS, LAUNCH_GRACE_MS, addHostCheck, addHostPlan, autoscalingWarning, capabilityGate, capabilityWarning, capacityProblem, checkConfirm,
  clonePlan, cloneCheck, commandProblem, confirmFor, countHosts, createdTags, deleteServiceCheck, deleteServicePlan, fargateMemoryFor, fargateSizeProblem,
  hostCountDetail, hostEstimate, imageProblem, instanceTypeProblem, isConsoleCreated, limitsOf, newNameProblem, parseAddHost, parseClone, parseRunTask,
  parseScale, parseTerminateHost, pickNetwork, provisionIam, reservationVerdict, runTaskCheck, runTaskPlan, scaleCheck, scalePlan, serviceEstimate,
  splitCommand, terminateHostCheck, terminateHostPlan, type CloneFacts, type HostReservation, type ServiceFacts,
} from "./provision.ts";

const svc = (o: Partial<ServiceFacts> = {}): ServiceFacts => ({ desired: 2, inProgress: false, isSelf: false, created: false, hasTaskDef: true, ...o });
const L = DEFAULT_LIMITS;

test("limits: defaults, overrides, and an empty instance-type list means no restriction", () => {
  assert.deepEqual(limitsOf(), { enabled: true, maxTasks: 10, maxHosts: 3 });
  assert.deepEqual(limitsOf({ maxTasks: 4, enabled: false }), { enabled: false, maxTasks: 4, maxHosts: 3 });
  assert.deepEqual(limitsOf({ allowedInstanceTypes: [] }), { enabled: true, maxTasks: 10, maxHosts: 3 });
  assert.deepEqual(limitsOf({ allowedInstanceTypes: ["t3a.small"] }).allowedInstanceTypes, ["t3a.small"]);
});

test("new service names follow ECS rules and must be unique in the cluster", () => {
  assert.equal(newNameProblem("api-canary_2", ["api"]), undefined);
  assert.match(newNameProblem("api", ["api"]) ?? "", /already exists/);
  for (const bad of ["", "-api", "api canary", "api/x", "a".repeat(256), "ápi"]) assert.ok(newNameProblem(bad, []), bad);
});

test("image overrides need a full reference with a tag or digest", () => {
  for (const ok of [
    "123456789012.dkr.ecr.us-east-1.amazonaws.com/storefront-api:staging-096a5bb",
    "ghcr.io/acme/jobs:1.4.2",
    "localhost:5000/acme/api:dev",
    "nginx:1.27-alpine",
    `public.ecr.aws/acme/api@sha256:${"a".repeat(64)}`,
    `acme/api:1.0@sha256:${"b".repeat(64)}`,
  ]) assert.equal(imageProblem(ok), undefined, ok);
  for (const bad of ["acme/api", "acme/api:", "Acme/API:1", "api:1 ; rm -rf /", "acme/api@sha256:short", `${"a".repeat(260)}:1`]) assert.ok(imageProblem(bad), bad);
  const ecr = ["123456789012.dkr.ecr.us-east-1.amazonaws.com", "ghcr.io/acme/"];
  assert.equal(imageProblem("123456789012.dkr.ecr.us-east-1.amazonaws.com/api:1.4.2", ecr), undefined);
  assert.equal(imageProblem("ghcr.io/acme/api:1", ecr), undefined);
  assert.match(imageProblem("ghcr.io/acme-evil/api:1", ecr)!, /allowedImageRegistries/, "prefixes match whole path segments");
  assert.match(imageProblem("docker.io/library/nginx:1", ecr)!, /allowedImageRegistries/);
});

test("Fargate sizes: only valid cpu/memory pairs", () => {
  assert.equal(fargateSizeProblem(256, 512), undefined);
  assert.equal(fargateSizeProblem(1024, 8192), undefined);
  assert.equal(fargateSizeProblem(8192, 61440), undefined);
  assert.equal(fargateSizeProblem(16384, 122880), undefined);
  assert.match(fargateSizeProblem(256, 4096) ?? "", /512–2048/);
  assert.match(fargateSizeProblem(1024, 1024) ?? "", /2048–8192/);
  assert.match(fargateSizeProblem(8192, 18432) ?? "", /steps of 4096/);
  assert.match(fargateSizeProblem(300, 512) ?? "", /isn't a Fargate CPU size/);
  assert.deepEqual(fargateMemoryFor(512), [1024, 2048, 3072, 4096]);
  assert.deepEqual(fargateMemoryFor(3), []);
});

test("instance types: shape, and the allow-list when configured", () => {
  assert.equal(instanceTypeProblem("t3a.medium"), undefined);
  assert.equal(instanceTypeProblem("m7g.2xlarge", ["m7g.2xlarge"]), undefined);
  assert.match(instanceTypeProblem("t3a.large", ["t3a.medium"]) ?? "", /isn't allowed/);
  assert.ok(instanceTypeProblem("T3A.medium"));
  assert.ok(instanceTypeProblem("medium"));
});

test("commands split like a shell line, without expansion", () => {
  assert.deepEqual(splitCommand("npm run migrate -- --force"), { ok: true, args: ["npm", "run", "migrate", "--", "--force"] });
  assert.deepEqual(splitCommand(`sh -c 'echo "$HOME" && ls'`), { ok: true, args: ["sh", "-c", 'echo "$HOME" && ls'] });
  assert.deepEqual(splitCommand(`node -e "console.log(\\"hi\\")"`), { ok: true, args: ["node", "-e", 'console.log("hi")'] });
  assert.deepEqual(splitCommand(`a "" b\\ c`), { ok: true, args: ["a", "", "b c"] });
  assert.deepEqual(splitCommand("  ls   -la  "), { ok: true, args: ["ls", "-la"] });
  assert.equal(splitCommand("echo 'open").ok, false);
  assert.equal(splitCommand("echo a\nrm -rf /").ok, false);
  assert.equal(commandProblem([]), "the command is empty");
  assert.equal(commandProblem([""]), "the command is empty");
  assert.match(commandProblem(Array(65).fill("x")) ?? "", /more than 64/);
  assert.match(commandProblem(["x".repeat(4001)]) ?? "", /longer than/);
  assert.equal(commandProblem(["npm", "test"]), undefined);
});

test("inputs are parsed strictly: unknown fields, wrong types and bad ids are refused", () => {
  const c = parseClone({ env: "staging", sourceEnv: "staging", source: "api", name: "api-canary", desired: 1, dryRun: true });
  assert.ok(c.ok);
  assert.deepEqual(c.ok && c.value, { env: "staging", sourceEnv: "staging", source: "api", name: "api-canary", desired: 1 });
  assert.match((parseClone({ env: "staging", sourceEnv: "staging", source: "api", name: "x", desired: 1, taskRoleArn: "arn:…" }) as { error: string }).error, /unknown field.*taskRoleArn/);
  assert.equal(parseClone({ env: "staging", sourceEnv: "staging", source: "api", name: "x", desired: "1" }).ok, false);
  assert.equal(parseClone({ env: "Staging", sourceEnv: "staging", source: "api", name: "x", desired: 1 }).ok, false);
  assert.equal(parseScale({ env: "staging", service: "api", desired: 1.5 }).ok, false);
  assert.equal(parseScale({ env: "staging", service: "../api", desired: 2 }).ok, false);
  assert.equal(parseRunTask({ env: "staging", service: "api", command: "npm test" }).ok, false, "commands arrive as argument lists");
  assert.ok(parseRunTask({ env: "staging", service: "api", container: "api", command: ["npm", "test"] }).ok);
  assert.equal(parseAddHost({ env: "staging", from: "not-an-instance", count: 1 }).ok, false);
  assert.ok(parseAddHost({ env: "staging", from: "i-0a1b2c3d4e5f67890", count: 1, instanceType: "t3a.medium" }).ok);
  assert.equal(parseTerminateHost({ env: "staging", id: "i-0a1b2c3d4e5f67890", reason: "x".repeat(501) }).ok, false);
  assert.equal(parseScale([]).ok, false);
  const r = parseScale({ env: "staging", service: "api", desired: 2, reason: "   " });
  assert.ok(r.ok && r.value.reason === undefined, "a blank reason is no reason");
});

test("confirmations: one click on unprotected envs, typed + reason on protected ones, deletes always typed + reason", () => {
  assert.deepEqual(confirmFor("scale", false, "api"), { expected: "yes", needReason: false });
  assert.deepEqual(confirmFor("scale", true, "api"), { expected: "api", needReason: true });
  assert.deepEqual(confirmFor("clone", true, "api-canary"), { expected: "api-canary", needReason: true });
  assert.deepEqual(confirmFor("delete-service", false, "api-canary"), { expected: "api-canary", needReason: true });
  assert.deepEqual(confirmFor("terminate-host", false, "i-0abc"), { expected: "i-0abc", needReason: true });
  assert.deepEqual(checkConfirm({ expected: "yes", needReason: false }, { confirm: "yes" }), { ok: true });
  assert.equal(checkConfirm({ expected: "yes", needReason: false }, {}).ok, false);
  assert.match((checkConfirm({ expected: "api", needReason: true }, { confirm: "api" }) as { error: string }).error, /reason/);
  assert.match((checkConfirm({ expected: "api", needReason: true }, { confirm: "API", reason: "canary test" }) as { error: string }).error, /expected "api"/);
  assert.deepEqual(checkConfirm({ expected: "api", needReason: true }, { confirm: "api", reason: "canary test" }), { ok: true });
});

test("scale: never the console itself, not while stopped or rolling out, 1..maxTasks, and a real change", () => {
  assert.deepEqual(scaleCheck(svc(), L, 4), { ok: true });
  assert.equal(scaleCheck(svc({ isSelf: true }), L, 4).ok, false);
  assert.match((scaleCheck(svc({ desired: 0 }), L, 2) as { error: string }).error, /stopped — use Start/);
  assert.match((scaleCheck(svc({ inProgress: true }), L, 3) as { error: string }).error, /rollout/);
  assert.match((scaleCheck(svc(), L, 0) as { error: string }).error, /1–10/);
  assert.match((scaleCheck(svc(), L, 11) as { error: string }).error, /1–10/);
  assert.match((scaleCheck(svc(), limitsOf({ maxTasks: 3 }), 4) as { error: string }).error, /1–3/);
  assert.match((scaleCheck(svc(), L, 2) as { error: string }).error, /already running with 2 tasks/);
  assert.equal((scaleCheck(svc(), limitsOf({ enabled: false }), 3) as { status: number }).status, 403);
  assert.deepEqual(scaleCheck(svc(), L), { ok: true }, "without a target: may the button be offered at all?");
});

test("run task and delete: self is refused; delete only for console-created services", () => {
  assert.deepEqual(runTaskCheck(svc(), L), { ok: true });
  assert.equal(runTaskCheck(svc({ isSelf: true }), L).ok, false);
  assert.equal(runTaskCheck(svc({ hasTaskDef: false }), L).ok, false);
  assert.equal(runTaskCheck(svc(), limitsOf({ enabled: false })).ok, false);
  assert.match((deleteServiceCheck(svc()) as { error: string }).error, /only services the console created/);
  assert.deepEqual(deleteServiceCheck(svc({ created: true })), { ok: true });
  assert.equal(deleteServiceCheck(svc({ created: true, isSelf: true })).ok, false, "a created tag never makes the console delete itself");
  assert.equal(isConsoleCreated({ "console:created": "true" }), true);
  assert.equal(isConsoleCreated({ "console:created": "yes" }), false);
  assert.equal(isConsoleCreated(undefined), false);
});

test("clone source: never the console, never out of a protected env into an unprotected one", () => {
  const base = { isSelf: false, hasTaskDef: true, sourceProtected: false, targetProtected: false, launchType: "FARGATE" };
  assert.deepEqual(cloneCheck(base, L), { ok: true });
  assert.deepEqual(cloneCheck({ ...base, targetProtected: true }, L), { ok: true }, "staging → production is fine");
  assert.match((cloneCheck({ ...base, sourceProtected: true }, L) as { error: string }).error, /protected environment can't be copied into an unprotected/);
  assert.deepEqual(cloneCheck({ ...base, sourceProtected: true, targetProtected: true }, L), { ok: true });
  assert.equal(cloneCheck({ ...base, isSelf: true }, L).ok, false);
  assert.equal(cloneCheck({ ...base, launchType: "EXTERNAL" }, L).ok, false);
  assert.equal(cloneCheck(base, limitsOf({ enabled: false })).ok, false);
});

test("hosts: Auto Scaling members point to their group, a per-env cap, terminate only console-created", () => {
  const h = { state: "running", created: false };
  assert.deepEqual(addHostCheck(h, L, 0, 2), { ok: true });
  assert.equal((addHostCheck({ ...h, asg: "acme-ecs-asg" }, L, 0, 1) as { error: string }).error, "this host belongs to Auto Scaling group acme-ecs-asg — scale the Auto Scaling group acme-ecs-asg instead");
  assert.match((addHostCheck(h, L, 2, 2) as { error: string }).error, /count must be 1–1/);
  assert.match((addHostCheck(h, L, 3) as { error: string }).error, /limit 3/);
  assert.equal(addHostCheck({ ...h, state: "terminated" }, L, 0, 1).ok, false);
  assert.deepEqual(addHostCheck({ ...h, state: "stopped" }, L, 0, 1), { ok: true }, "a stopped host can still be copied");
  assert.equal(addHostCheck(h, limitsOf({ maxHosts: 0 }), 0, 1).ok, false);
  assert.match((terminateHostCheck(h) as { error: string }).error, /only EC2 hosts the console created/);
  assert.deepEqual(terminateHostCheck({ ...h, created: true }), { ok: true });
  assert.equal(terminateHostCheck({ state: "shutting-down", created: true }).ok, false);
});

test("networking for a copy: source's in the same env; elsewhere a same-named, then same-launch-type donor; never the console", () => {
  const donors = [
    { service: "deployment-console", subnets: ["s-1"], launchType: "FARGATE", isSelf: true },
    { service: "worker", subnets: ["s-1"], launchType: "EC2", isSelf: false },
    { service: "billing", subnets: ["s-2"], launchType: "FARGATE", isSelf: false },
    { service: "api", subnets: ["s-3"], launchType: "FARGATE", isSelf: false },
    { service: "caddy", subnets: [], launchType: "EC2", isSelf: false },
  ];
  const src = { service: "api", networkMode: "awsvpc", launchType: "FARGATE", sameEnv: false };
  assert.deepEqual(pickNetwork({ ...src, sameEnv: true }, "staging", []), { ok: true, mode: "awsvpc", from: "api", sameAsSource: true, why: "same subnets and security groups as api" });
  const same = pickNetwork(src, "production", donors);
  assert.ok(same.ok && same.mode === "awsvpc" && same.from === "api" && /same name/.test(same.why));
  const byType = pickNetwork({ ...src, service: "search" }, "production", donors.filter((d) => d.service !== "api"));
  assert.ok(byType.ok && byType.mode === "awsvpc" && byType.from === "billing", "alphabetical among the same launch type");
  const any = pickNetwork({ ...src, service: "search" }, "production", donors.filter((d) => d.launchType === "EC2"));
  assert.ok(any.ok && any.mode === "awsvpc" && any.from === "worker");
  const none = pickNetwork(src, "production", [donors[0], donors[4]]);
  assert.ok(!none.ok && /no service in production uses awsvpc/.test(none.error), "the console's own network is never borrowed");
  const host = pickNetwork({ ...src, networkMode: "host" }, "production", []);
  assert.ok(host.ok && host.mode === "host");
});

test("capacity for a copy into another env", () => {
  assert.equal(capacityProblem({ launchType: "FARGATE", capacityProviders: [] }, { env: "staging", capacityProviders: [], containerInstances: 1 }), undefined);
  assert.match(capacityProblem({ launchType: "EC2", capacityProviders: [] }, { env: "production", capacityProviders: ["FARGATE"], containerInstances: 0 }) ?? "", /no EC2 container instances/);
  assert.match(capacityProblem({ capacityProviders: ["FARGATE_SPOT", "acme-asg-cp"] }, { env: "qa", capacityProviders: ["FARGATE_SPOT"], containerInstances: 0 }) ?? "", /acme-asg-cp isn't available in qa/);
});

test("estimates use list prices: Fargate per task, EC2 capacity is free until it needs a host", () => {
  const f = serviceEstimate("FARGATE", 1024, 2048, 2);
  assert.ok(Math.abs(f.monthlyUsd - 2 * (0.04048 + 2 * 0.004445) * 730) < 1e-9);
  assert.match(f.note, /^2 × \$36\.04\/month per task \(1 vCPU · 2 GB, Fargate x86/);
  assert.ok(serviceEstimate("FARGATE", 1024, 2048, 1, true).monthlyUsd < serviceEstimate("FARGATE", 1024, 2048, 1).monthlyUsd, "ARM is cheaper");
  assert.equal(serviceEstimate("EC2", 256, 512, 3).monthlyUsd, 0);
  assert.equal(hostEstimate("t3a.medium", 2)?.monthlyUsd, 0.0376 * 730 * 2);
  assert.equal(hostEstimate("x9z.large", 1), undefined);
});

const cloneFacts = (o: Partial<CloneFacts> = {}): CloneFacts => ({
  env: { id: "staging", protected: false },
  source: { env: "staging", service: "api", family: "api-staging", revision: 123, image: "acme/api:staging-abc", launchType: "FARGATE", networkMode: "awsvpc", cpu: 512, memory: 1024, execEnabled: false, loadBalancers: 1, registries: 0, serviceConnect: false },
  name: "api-canary",
  desired: 1,
  network: { ok: true, mode: "awsvpc", from: "api", sameAsSource: true, why: "same subnets and security groups as api" },
  familyExists: false,
  ...o,
});

test("clone plan: says what is copied, what isn't, and what it costs", () => {
  const p = clonePlan(cloneFacts());
  assert.equal(p.summary, "Create api-canary in staging as a copy of staging/api (1 task)");
  assert.equal(p.risk, "danger", "a copy starts new paying tasks: tokens always need approval");
  assert.deepEqual(p.confirm, { expected: "yes", needReason: false });
  assert.ok(p.changes.some((c) => c.includes("copied from api-staging:123")));
  assert.ok(p.changes.some((c) => c.startsWith("Image: acme/api:staging-abc (same as the source)")));
  assert.ok(p.changes.some((c) => c.includes("stream prefix api-canary/")));
  assert.ok(p.changes.some((c) => c.includes("console:created=true, console:created-from=staging/api")));
  assert.ok(p.warnings[0].startsWith("Not copied: load balancer (1 target group), auto scaling policies."));
  assert.ok(p.estimate && p.estimate.monthlyUsd > 0);

  const x = clonePlan(cloneFacts({ env: { id: "production", protected: true }, image: "acme/api:1.2.3", cpu: 1024, memory: 2048, network: { ok: true, mode: "awsvpc", from: "api", sameAsSource: false, why: "subnets and security groups of production/api (it has the same name as the source)" } }));
  assert.deepEqual(x.confirm, { expected: "api-canary", needReason: true });
  assert.ok(x.changes.some((c) => c === "Image: acme/api:1.2.3 (instead of acme/api:staging-abc)"));
  assert.ok(x.changes.some((c) => c === "Size: 1 vCPU · 2 GB (changed)"));
  assert.ok(x.warnings.some((w) => w.includes("copied from staging — the copy talks to whatever api talks to")));
  assert.ok(x.warnings.some((w) => w.startsWith("Tip: create it with 0 tasks")));

  const h = clonePlan(cloneFacts({ source: { ...cloneFacts().source, launchType: "EC2", networkMode: "host" }, network: { ok: true, mode: "host", why: "host networking" }, runningHosts: 1 }));
  assert.ok(h.warnings.some((w) => w.includes("each EC2 host fits one such task (1 running host)")));
  assert.equal(h.estimate?.monthlyUsd, 0);
});

test("scale, run-task, add-host, delete and terminate plans", () => {
  const s = scalePlan({ env: { id: "production", protected: true }, service: "api", from: 2, to: 4, launchType: "FARGATE", cpu: 256, memory: 512 });
  assert.equal(s.summary, "Scale api in production from 2 to 4 tasks");
  assert.deepEqual(s.confirm, { expected: "api", needReason: true });
  assert.ok(s.estimate && s.estimate.monthlyUsd > 0 && s.estimate.note.startsWith("+$"));
  const down = scalePlan({ env: { id: "staging", protected: false }, service: "worker", from: 3, to: 1, launchType: "EC2", networkMode: "host", runningHosts: 1 });
  assert.equal(down.estimate, undefined);
  assert.ok(down.changes[0].includes("ECS stops 2 tasks"));
  assert.ok(scalePlan({ env: { id: "staging", protected: false }, service: "worker", from: 1, to: 3, launchType: "EC2", networkMode: "host", runningHosts: 1 }).warnings.some((w) => w.includes("3 tasks need 3 hosts")));

  const r = runTaskPlan({ env: { id: "staging", protected: false }, service: "api", taskDefinition: "api-staging:123", launchType: "FARGATE", container: "api", command: ["npm", "run", "db:migrate", "--", "--name=init x"], logs: { group: "/ecs/acme-staging/api", prefix: "ecs" }, network: "same as api", cpu: 512, memory: 1024 });
  assert.equal(r.summary, "Run a one-off task of api in staging (npm …)");
  assert.ok(r.changes.includes('Command for container api: npm run db:migrate -- "--name=init x"'));
  assert.ok(r.changes.includes("Logs: /ecs/acme-staging/api, stream ecs/api/<task id>"));
  assert.ok(r.warnings.some((w) => w.includes("recorded in the audit log")));
  assert.equal(r.risk, "danger", "a command override is dangerous: tokens always need approval");
  assert.equal(runTaskPlan({ env: { id: "staging", protected: false }, service: "api", taskDefinition: "api-staging:123", launchType: "FARGATE", container: "api", logs: undefined, network: "same as api", cpu: 512, memory: 1024 }).risk, "change");

  const a = addHostPlan({
    env: { id: "staging", protected: false }, cluster: "acme-staging", count: 2, instanceType: "t3a.medium", name: "acme-staging-7f3a",
    source: { id: "i-0a1b2c3d4e5f67890", name: "acme-staging", instanceType: "t3a.small", imageId: "ami-0c1d2e3f4a5b6c7d8", subnetId: "subnet-1", securityGroups: ["sg-1"], hasUserData: true, hasPublicIp: false },
  });
  assert.equal(a.summary, "Add 2 EC2 hosts (t3a.medium) to staging like acme-staging");
  assert.ok(a.changes.includes("Instance type: t3a.medium (instead of t3a.small)"));
  assert.ok(a.changes.some((c) => c.includes("user data: copied (not shown)")));
  assert.equal(a.estimate?.monthlyUsd, 0.0376 * 730 * 2);
  const lt = addHostPlan({
    env: { id: "production", protected: true }, cluster: "acme-production", count: 1, instanceType: "t3a.small", name: "n",
    source: { id: "i-0a1b2c3d4e5f67890", name: "h", instanceType: "t3a.small", imageId: "ami-1", securityGroups: [], hasUserData: true, hasPublicIp: false, launchTemplate: { id: "lt-0abc", version: "3" } },
  });
  assert.ok(lt.changes[0].includes("launch template lt-0abc version 3"));
  assert.deepEqual(lt.confirm, { expected: "production", needReason: true });

  const d = deleteServicePlan({ env: { id: "staging", protected: false }, service: "api-canary", desired: 1, family: "api-canary" });
  assert.equal(d.risk, "danger");
  assert.deepEqual(d.confirm, { expected: "api-canary", needReason: true });
  assert.ok(d.changes[1].includes("Keep its task definitions (family api-canary)"));

  const t = terminateHostPlan({ env: { id: "staging", protected: false }, id: "i-0123456789abcdef0", name: "acme-staging-7f3a", instanceType: "t3a.small", otherRunningHosts: 0, ec2Services: 5 });
  assert.deepEqual(t.confirm, { expected: "i-0123456789abcdef0", needReason: true });
  assert.ok(t.warnings.some((w) => w.includes("No other host is running — 5 EC2 services")));
  assert.ok(!terminateHostPlan({ env: { id: "staging", protected: false }, id: "i-0123456789abcdef0", name: "h", instanceType: "t3a.small", otherRunningHosts: 1, ec2Services: 5 }).warnings.some((w) => w.includes("No other host")));
});

test("created tags keep a source's own tags but never AWS-reserved ones or stale console bookkeeping", () => {
  assert.deepEqual(createdTags("i-0abc", { Name: "acme-staging", "aws:ec2launchtemplate:id": "lt-1", "console:created": "true", "console:created-from": "i-old", team: "shop" }), {
    Name: "acme-staging", team: "shop", "console:created": "true", "console:created-from": "i-0abc",
  });
});

test("inherited names are unknown fields for provisioning input too", () => {
  const c = parseScale(JSON.parse('{"env":"staging","service":"api","desired":2,"constructor":"x","__proto__":1}'));
  assert.equal(c.ok, false);
  assert.match(!c.ok ? c.error : "", /unknown field\(s\): constructor, __proto__/);
});

// ---------- the host cap while hosts boot (R23) ----------

const T = 1_700_000_000_000;
const created = { "console:created": "true" };
const res = (o: Partial<HostReservation> = {}): HostReservation => ({ id: "r1", count: 3, instanceIds: [], state: "pending", createdAt: T, expiresAt: T + JOIN_TIMEOUT_MS, ...o });

test("host cap: registered, still joining and reserved hosts all count, each instance once", () => {
  const registered = [
    { id: "i-01", state: "running", tags: created },
    { id: "i-02", state: "terminated", tags: created }, // gone: not counted
    { id: "i-03", state: "running", tags: {} }, // not the console's
  ];
  const tagged = [{ id: "i-01", state: "running" }, { id: "i-04", state: "pending" }];
  // r1: ids known, one joined (i-01), one joining (i-04), one not visible yet (i-05); r2: RunInstances hasn't answered.
  const reservations = [res({ instanceIds: ["i-01", "i-04", "i-05"] }), res({ id: "r2", count: 2 })];
  assert.deepEqual(countHosts({ registered, tagged, reservations, now: T + 60_000 }), { total: 5, registered: 1, joining: 1, reserved: 3 });
  // Expired or settled reservations stop counting; their instances still count through the lists.
  assert.deepEqual(countHosts({ registered, tagged, reservations: reservations.map((r) => ({ ...r, state: "failed" as const })), now: T }), { total: 2, registered: 1, joining: 1, reserved: 0 });
  assert.equal(countHosts({ registered, tagged, reservations, now: T + JOIN_TIMEOUT_MS }).total, 2);
  assert.equal(hostCountDetail({ total: 5, registered: 1, joining: 1, reserved: 3 }), "1 in the cluster, 1 launched and not joined yet, 3 reserved by a recent launch");
  assert.equal(hostCountDetail({ total: 2, registered: 2, joining: 0, reserved: 0 }), undefined);
});

test("host cap: REVIEW R23 — a second three-host launch is refused while the first is still booting (cap 3)", () => {
  const L3 = { ...L, maxHosts: 3 };
  const before = countHosts({ registered: [], tagged: [], reservations: [], now: T });
  assert.ok(addHostCheck({ state: "running", created: false }, L3, before.total, 3).ok);
  // The first launch is reserved, its instances not registered with ECS yet: the old count (registered only) was 0.
  const after = countHosts({ registered: [], tagged: [{ id: "i-0a", state: "pending" }], reservations: [res({ instanceIds: ["i-0a", "i-0b", "i-0c"] })], now: T + 5_000 });
  assert.equal(after.total, 3);
  const second = addHostCheck({ state: "running", created: false }, L3, after.total, 3, hostCountDetail(after));
  assert.equal(second.ok, false);
  assert.match(!second.ok ? second.error : "", /already has 3 console-created hosts \(1 launched and not joined yet, 2 reserved by a recent launch\) \(limit 3\)/);
  const one = addHostCheck({ state: "running", created: false }, { ...L, maxHosts: 4 }, after.total, 2, hostCountDetail(after));
  assert.match(!one.ok ? one.error : "", /count must be 1–1 .*3 exist \(1 launched/);
});

test("host reservations: joined → registered, not joined in 15 min → failed with the waiting ids, refused → released", () => {
  const seen = (registered: string[], tagged: string[]) => ({ registered: new Set(registered), tagged: new Set(tagged) });
  const r = res({ instanceIds: ["i-0a", "i-0b"] });
  assert.deepEqual(reservationVerdict(r, seen([], ["i-0a", "i-0b"]), T + 60_000, "acme-staging"), { state: "pending" });
  assert.deepEqual(reservationVerdict(r, seen(["i-0a", "i-0b"], ["i-0a", "i-0b"]), T + 60_000, "acme-staging"), { state: "registered" });
  // One joined, one still booting at the deadline: the booting one fails (the issue names it alone).
  assert.deepEqual(reservationVerdict(r, seen(["i-0a"], ["i-0a", "i-0b"]), T + JOIN_TIMEOUT_MS, "acme-staging"), { state: "failed", instanceIds: ["i-0b"] });
  assert.deepEqual(reservationVerdict(r, seen(["i-0a"], ["i-0a", "i-0b"]), T + JOIN_TIMEOUT_MS - 1, "acme-staging"), { state: "pending" });
  // Not visible anywhere: EC2 may not list them yet; after the grace period they ended before joining.
  assert.deepEqual(reservationVerdict(r, seen([], []), T + LAUNCH_GRACE_MS - 1, "acme-staging"), { state: "pending" });
  const ended = reservationVerdict(r, seen([], []), T + LAUNCH_GRACE_MS, "acme-staging");
  assert.equal(ended.state, "failed");
  assert.match(ended.state === "failed" ? ended.detail ?? "" : "", /hosts i-0a, i-0b ended before joining acme-staging/);
  // One joined, the other ended before joining: not "registered" — the one that ended is reported (after the grace).
  assert.deepEqual(reservationVerdict(r, seen(["i-0a"], []), T + LAUNCH_GRACE_MS - 1, "acme-staging"), { state: "pending" });
  assert.deepEqual(reservationVerdict(r, seen(["i-0a"], []), T + LAUNCH_GRACE_MS, "acme-staging"), {
    state: "failed", instanceIds: ["i-0b"], detail: "host i-0b ended before joining acme-staging",
  });
  // RunInstances never answered with ids.
  const blind = res();
  assert.deepEqual(reservationVerdict(blind, seen([], []), T + 60_000, "acme-staging", "running"), { state: "pending" });
  assert.equal(reservationVerdict(blind, seen([], []), T + 60_000, "acme-staging", "failed").state, "released");
  assert.equal(reservationVerdict(blind, seen([], []), T + 60_000, "acme-staging", "succeeded").state, "released");
  const unknown = reservationVerdict({ ...blind, operationId: "op-1" }, seen([], []), T + JOIN_TIMEOUT_MS, "acme-staging", "outcome_unknown");
  assert.equal(unknown.state, "failed");
  assert.match(unknown.state === "failed" ? unknown.detail ?? "" : "", /launch of 3 hosts for acme-staging has an unknown outcome \(operation op-1\) — look for EC2 instances tagged console:cluster=acme-staging/);
  assert.deepEqual(reservationVerdict(res({ state: "registered" }), seen([], []), T + JOIN_TIMEOUT_MS, "c"), { state: "pending" }, "only pending rows move");
});

// ---------- scale vs. Application Auto Scaling (CC-20) ----------

test("scale plans warn when Application Auto Scaling will override the count", () => {
  const a = { min: 2, max: 6, policies: ["target tracking (CPU 60%)"] };
  const plan = (to: number, autoscaling?: typeof a | null) =>
    scalePlan({ env: { id: "production", protected: true }, service: "api", from: 3, to, launchType: "FARGATE", cpu: 256, memory: 512, autoscaling });
  assert.match(plan(8, a).warnings[0], /^Application Auto Scaling manages this service \(min 2, max 6; target tracking \(CPU 60%\)\): a desired count of 8 is outside that range, so the autoscaler will override it — its next scaling activity sets the maximum, 6\. Change the scalable target's minimum\/maximum instead\.$/);
  assert.match(plan(1, a).warnings[0], /count of 1 is outside that range, so the autoscaler will override it — its next scaling activity sets the minimum, 2\./);
  assert.match(plan(4, a).warnings[0], /its scaling policies may change the count again/);
  assert.ok(!plan(4, null).warnings.some((w) => /Auto Scaling/.test(w)), "no scalable target: no warning");
  assert.match(plan(4).warnings[0], /If Application Auto Scaling manages this service, it may change the count back/, "unknown: the generic caveat");
  assert.equal(autoscalingWarning({ min: 1, max: 1, policies: [] }, 1), "Application Auto Scaling manages this service (min 1, max 1): its scaling policies may change the count again.");
});

// ---------- what the console's AWS identity may do (F06) ----------

test("provisioning capability: IAM actions per action, denied disables, probably denied warns, unknown says nothing", () => {
  assert.deepEqual(provisionIam("clone"), ["ecs:CreateService", "ecs:RegisterTaskDefinition", "iam:PassRole"]);
  assert.deepEqual(provisionIam("scale"), ["ecs:UpdateService"]);
  assert.deepEqual(provisionIam("run-task"), ["ecs:RunTask", "iam:PassRole"]);
  assert.deepEqual(provisionIam("add-host"), ["ec2:RunInstances", "ec2:CreateTags", "iam:PassRole"]);
  assert.deepEqual(provisionIam("delete-service"), ["ecs:DeleteService"]);
  assert.deepEqual(provisionIam("terminate-host"), ["ec2:TerminateInstances"]);
  const iam = provisionIam("add-host");
  const denied = capabilityGate({ state: "denied", missing: ["ec2:RunInstances"] }, iam);
  assert.deepEqual(denied, { enabled: false, why: "the console's AWS identity can't call ec2:RunInstances" });
  assert.equal(capabilityWarning(denied), "the console's AWS identity can't call ec2:RunInstances — AWS will refuse this (Settings → AWS permissions)");
  const likely = capabilityGate({ state: "probably-denied", missing: [] }, iam);
  assert.deepEqual(likely, { enabled: true, warning: "AWS permission not verified — likely denied (ec2:RunInstances, ec2:CreateTags, iam:PassRole)" });
  assert.equal(capabilityWarning(likely), likely.warning);
  for (const state of ["allowed", "unknown"] as const) {
    assert.deepEqual(capabilityGate({ state, missing: [] }, iam), { enabled: true });
    assert.equal(capabilityWarning(capabilityGate({ state, missing: [] }, iam)), undefined);
  }
});

// ---------- the real runner (server/provision.ts) on the simulated account ----------
// server/provision.ts imports "server-only", which only resolves under the react-server condition, so this runs in a
// child process against the simulated account and an in-memory console DB. The staging cluster's container instances
// are frozen (like REVIEW's host-cap evidence: launched hosts never register unless the scenario says so), launches
// are counted, and ECS writes can be slowed down to make two requests overlap.
const scenario = String.raw`
const at = (f) => new URL(f, ${JSON.stringify(new URL("./server/", import.meta.url).href)}).href;
const { mockCloud, mockCi } = await import(at("mock.ts"));
const base = mockCloud();
const stable = await base.hosts("acme-staging");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const st = { launched: [], joined: new Set(), tagged: false, launchDelay: 0, ecsDelay: 0, launches: [], runTokens: [] };
const box = (id) => ({ ...stable[0], id, name: id, tags: { "console:created": "true", Name: id } });
globalThis.__consoleCloud = Promise.resolve({
  ...base,
  hosts: async (cluster) => (cluster === "acme-staging" ? [...stable, ...st.launched.filter((id) => st.joined.has(id)).map(box)] : base.hosts(cluster)),
  taggedHosts: async (cluster) => {
    if (st.onTagged) await st.onTagged(); // runs between the reconciler's read of the reservations and its update
    return cluster === "acme-staging" && st.tagged ? st.launched.map((id) => ({ id, state: "running", launchedAt: Date.now() })) : [];
  },
  launchHosts: async (from, o) => {
    await sleep(st.launchDelay);
    const ids = Array.from({ length: o.count }, () => "i-" + String(st.launched.length + 1).padStart(17, "0")).map((x, k) => x.slice(0, -1) + String(st.launched.length + 1 + k).slice(-1));
    st.launched.push(...ids);
    st.launches.push({ count: o.count, cluster: o.cluster, clientToken: o.clientToken });
    return { instanceIds: ids, requestId: "mock-launch-" + st.launches.length };
  },
  updateService: async (...a) => {
    await sleep(st.ecsDelay);
    return base.updateService(...a);
  },
  runTask: async (spec) => {
    st.runTokens.push(spec.clientToken);
    return base.runTask(spec);
  },
  terminateHost: async (id) => {
    st.launched = st.launched.filter((x) => x !== id);
    return "mock-terminate";
  },
});
globalThis.__consoleCi = Promise.resolve(mockCi());
const P = await import(at("provision.ts"));
const { getDb } = await import(at("db.ts"));
const { act, hostIssues } = await import(at("console.ts"));
const { listEnvs } = await import(at("discovery.ts"));
const who = { user: { id: "u-ops", email: "ops@acme.example", role: "admin" }, actor: "ops@acme.example" };
const out = {};
const tryIt = async (f) => {
  try {
    return { ok: true, ...(await f()) };
  } catch (e) {
    return { ok: false, status: e.status, code: e.code, error: e.message };
  }
};
const db = await getDb();
const opRow = (id) => db.get("SELECT action, state, verify, error, params FROM operations WHERE id = ?", [id]);

// R23, REVIEW's reproduction: two sequential three-host requests with a cap of 3 → the second is refused.
const hostIn = { env: "staging", from: stable[0].id, count: 3, reason: "host cap check" };
const hostPlan = await P.planAddHost(hostIn, who);
hostIn.confirm = hostPlan.confirm.expected;
out.cap1 = await tryIt(() => P.runAddHost(hostIn, who));
out.cap2 = await tryIt(() => P.runAddHost(hostIn, who));
out.capLaunched = st.launched.length;
out.capLaunch = st.launches[0];
out.capOp = out.cap1.operationId ? await opRow(out.cap1.operationId) : null;
out.capPlanAfter = await tryIt(() => P.planAddHost({ env: "staging", from: stable[0].id, count: 1 }, who).then((p) => ({ summary: p.summary })));
// They join: the reservation is registered and the launch verified; they still count (now as cluster members).
st.joined = new Set(st.launched);
const envs = await listEnvs();
await P.reconcileHostReservations(envs);
out.regRow = await db.get("SELECT state, instance_ids FROM host_reservations WHERE operation_id = ?", [out.cap1.operationId]);
out.regOp = await opRow(out.cap1.operationId);
(await import(at("cache.ts"))).invalidate("hosts:"); // the views' 5 s host cache predates the join
out.info = await P.provisionInfo("staging", who.user, false).then((i) => ({ hostCount: i.hostCount, detail: i.hostCountDetail, capability: i.capability }));

// Two hosts.add at once on a fresh account: one launches, the other gets 409 from the coordinator.
await db.run("DELETE FROM host_reservations");
Object.assign(st, { launched: [], joined: new Set(), tagged: true, launchDelay: 300, launches: [] });
const one = { env: "staging", from: stable[0].id, count: 1, confirm: "yes", reason: "concurrency" };
out.race = (await Promise.all([tryIt(() => P.runAddHost(one, who)), tryIt(() => P.runAddHost(one, who))])).map((r) => ({ ok: r.ok, status: r.status, code: r.code, error: r.error, operationId: r.operationId }));
out.raceLaunches = [...st.launches];
// That host never joins: 15 minutes later the reservation fails, with an audit row and an issue.
const raced = out.race.find((r) => r.ok);
await P.reconcileHostReservations(envs, { now: Date.now() + 5 * 60_000 });
out.stillPending = (await db.get("SELECT state FROM host_reservations WHERE operation_id = ?", [raced.operationId])).state;
await P.reconcileHostReservations(envs, { now: Date.now() + 16 * 60_000 });
out.failRow = await db.get("SELECT state, instance_ids, detail FROM host_reservations WHERE operation_id = ?", [raced.operationId]);
out.failAudit = await db.all("SELECT action, result, detail, operation_id FROM audit WHERE operation_id = ? AND phase = 'result' ORDER BY at", [raced.operationId]);
out.failOp = await opRow(raced.operationId);
out.issues = (await hostIssues()).filter((i) => i.env === "staging");
out.reconcileNoEnvs = await tryIt(async () => ({ value: await P.reconcileHostReservations([]) }));
// A launched host joins and is terminated through the console before the reconciler saw it join: its reservation is
// settled as registered (never "ended before joining").
const solo = await tryIt(() => P.runAddHost({ env: "staging", from: stable[0].id, count: 1, confirm: "yes" }, who));
st.joined.add(solo.instanceIds?.[0]);
out.term = await tryIt(() => P.runTerminateHost({ env: "staging", id: solo.instanceIds?.[0], confirm: solo.instanceIds?.[0], reason: "done with it" }, who));
await P.reconcileHostReservations(envs, { now: Date.now() + 16 * 60_000 });
out.termRow = await db.get("SELECT state, instance_ids FROM host_reservations WHERE operation_id = ?", [solo.operationId]);
// The reconciler read a launch's reservation before the instance ids were recorded (it looks "succeeded without ids"):
// settling it must not release the reservation or erase the ids written in between.
const late = await tryIt(() => P.runAddHost({ env: "staging", from: stable[0].id, count: 1, confirm: "yes" }, who));
const lateRow = await db.get("SELECT id, instance_ids FROM host_reservations WHERE operation_id = ?", [late.operationId]);
await db.run("UPDATE host_reservations SET instance_ids = '[]' WHERE id = ?", [lateRow.id]);
st.onTagged = () => db.run("UPDATE host_reservations SET instance_ids = ? WHERE id = ?", [lateRow.instance_ids, lateRow.id]);
await P.reconcileHostReservations(envs);
st.onTagged = undefined;
out.late = { ok: late.ok, error: late.error, ids: lateRow.instance_ids, row: await db.get("SELECT state, instance_ids FROM host_reservations WHERE id = ?", [lateRow.id]) };

// CC-20: production api is autoscaled between 2 and 6 in the simulated account.
const scalePlanOut = await tryIt(() => P.planScale({ env: "production", service: "api", desired: 8 }, who));
out.scaleWarnings = scalePlanOut.warnings ?? scalePlanOut.error;

// Scale and clone on staging: dry run, then run — through the coordinator, with the operation recorded.
const live = (await base.services("acme-staging")).find((s) => s.name === "api");
const to = live.desired === 3 ? 4 : 3;
out.scalePlan = await tryIt(() => P.planScale({ env: "staging", service: "api", desired: to }, who));
out.scale = await tryIt(() => P.runScale({ env: "staging", service: "api", desired: to, confirm: "yes" }, who));
out.scaleOp = out.scale.operationId ? await opRow(out.scale.operationId) : null;
out.scaleAfter = (await base.services("acme-staging")).find((s) => s.name === "api").desired;
out.scaleTo = to;
out.clonePlan = await tryIt(() => P.planClone({ env: "staging", sourceEnv: "staging", source: "api", name: "api-canary", desired: 0 }, who));
out.clone = await tryIt(() => P.runClone({ env: "staging", sourceEnv: "staging", source: "api", name: "api-canary", desired: 0, confirm: "yes" }, who));
out.cloneOp = out.clone.operationId ? await opRow(out.clone.operationId) : null;
out.cloneAgain = await tryIt(() => P.runClone({ env: "staging", sourceEnv: "staging", source: "api", name: "api-canary", desired: 0, confirm: "yes" }, who));
out.wrongConfirm = await tryIt(() => P.runScale({ env: "staging", service: "api", desired: to === 3 ? 4 : 3, confirm: "nope" }, who));

// R04 across paths: a scale and a console restart of the same service at once — one of them gets 409.
st.ecsDelay = 300;
const now2 = (await base.services("acme-staging")).find((s) => s.name === "worker");
out.crossRace = (await Promise.all([
  tryIt(() => P.runScale({ env: "staging", service: "worker", desired: now2.desired + 1, confirm: "yes" }, who)),
  tryIt(() => act("staging", "worker", { action: "restart", confirm: "yes" }, "ops@acme.example")),
])).map((r) => ({ ok: r.ok, status: r.status, code: r.code, error: r.error }));
st.ecsDelay = 0;

// A one-off task carries a client token derived from its operation id.
out.task = await tryIt(() => P.runRunTask({ env: "staging", service: "api", confirm: "yes" }, who));
out.taskToken = st.runTokens[0];

// F67: a person approves an agent's services.scale; the scale goes out, then recording "done" fails (a trigger stands
// in for a full disk). The request must not be recorded as failed — the agent would ask for the same change again.
const ops = await import(at("ops/index.ts"));
const store = await import(at("ops/approvals.ts"));
await db.run("INSERT INTO users (id, email, role, disabled, created_at) VALUES ('u-ops', 'ops@acme.example', 'admin', 0, ?)", [Date.now()]);
await db.run("INSERT INTO api_tokens (id, name, user_id, role, mode, hash, prefix, created_at, uses) VALUES ('t-bot', 'release-bot', 'u-ops', 'operator', 'propose', 'h', 'dc_x', ?, 0)", [Date.now()]);
const cur = (await base.services("acme-staging")).find((s) => s.name === "api").desired;
const apInput = { env: "staging", service: "api", desired: cur === 5 ? 4 : 5, confirm: "yes" };
const ap = await store.createApproval({ op: "services.scale", input: apInput, plan: { summary: "scale api", confirm: "yes" }, env: "staging", tokenId: "t-bot", requestedBy: "u-ops" });
await db.run("CREATE TRIGGER approvals_no_done BEFORE UPDATE ON approvals WHEN NEW.status = 'done' BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END");
const origError = console.error;
const logged = [];
console.error = (line) => logged.push(String(line));
let dec;
try {
  dec = await ops.decide(ap.id, { decision: "approve" }, { user: who.user, via: "session" });
} catch (e) {
  dec = { thrown: e.message };
} finally {
  console.error = origError;
}
out.f67 = {
  thrown: dec.thrown, error: dec.error, operationId: dec.result?.operationId, status: (await store.getApproval(ap.id)).status,
  desired: (await base.services("acme-staging")).find((s) => s.name === "api").desired, want: apInput.desired,
  logged: logged.some((l) => l.includes("approval bookkeeping failed") && l.includes("disk I/O error")),
};
console.log(JSON.stringify(out));
`;

interface R { ok: boolean; status?: number; code?: string; error?: string; operationId?: string; [k: string]: unknown }
const runScenario = () => {
  const stdout = execFileSync(process.execPath, ["--conditions=react-server", "--no-warnings", "--input-type=module", "-e", scenario], {
    encoding: "utf8",
    cwd: new URL("../../", import.meta.url),
    env: {
      ...process.env, CONSOLE_SOURCE: "mock", CONSOLE_SQLITE_PATH: ":memory:", DATABASE_URL: "", CONSOLE_CONFIG: "examples/demo.console.config.json",
      CONSOLE_SECRET_KEY: "test-secret-key-0123456789abcdef0123456789", CONSOLE_REGIONS: "", CONSOLE_SELF: "", ECS_CONTAINER_METADATA_URI_V4: "",
    },
    timeout: 120_000,
  });
  return JSON.parse(stdout.trim().split("\n").pop()!) as Record<string, unknown>;
};
const o = runScenario();
const r = (k: string) => o[k] as R;

test("R23 through the runner: REVIEW's host-cap reproduction — the second three-host launch is refused", () => {
  assert.equal(r("cap1").ok, true, String(r("cap1").error));
  assert.deepEqual([r("cap2").ok, r("cap2").status], [false, 409]);
  assert.match(String(r("cap2").error), /already has 3 console-created hosts \(3 reserved by a recent launch\) \(limit 3\)/);
  assert.equal(o.capLaunched, 3, "only the first request launched anything");
  const launch = o.capLaunch as { count: number; cluster: string; clientToken: string };
  assert.deepEqual([launch.count, launch.cluster, launch.clientToken], [3, "acme-staging", `dc-${r("cap1").operationId}`], "tagged for its cluster, idempotent per operation");
  assert.deepEqual(o.capOp && [(o.capOp as R).action, (o.capOp as R).state], ["provision.add-host", "succeeded"]);
  assert.equal(r("capPlanAfter").status, 409, "a dry run counts the reservation too");
});

test("R23: hosts that joined settle the reservation as registered and verify the launch", () => {
  assert.deepEqual(o.regRow, { state: "registered", instance_ids: JSON.stringify(["i-00000000000000001", "i-00000000000000002", "i-00000000000000003"]) });
  assert.equal((o.regOp as R).verify, "verified");
  const info = o.info as { hostCount: { total: number; registered: number }; detail?: string; capability: Record<string, { enabled: boolean }> };
  assert.deepEqual([info.hostCount.total, info.hostCount.registered, info.detail], [3, 3, undefined]);
  assert.ok(Object.values(info.capability).every((c) => c.enabled), "the simulated account allows every provisioning write");
});

test("R04/R23: two hosts.add at once — one launches, the other gets 409 (busy)", () => {
  const race = o.race as R[];
  assert.equal(race.filter((x) => x.ok).length, 1, JSON.stringify(race));
  const refused = race.find((x) => !x.ok)!;
  assert.deepEqual([refused.status, refused.code], [409, "busy"]);
  assert.match(String(refused.error), /another change to i-\w+ is in progress \(provision\.add-host by ops@acme\.example\)/);
  assert.equal((o.raceLaunches as unknown[]).length, 1);
});

test("R23: a host that never joins fails its reservation after 15 minutes — audit row, failed verification, an issue", () => {
  assert.equal(o.stillPending, "pending");
  const row = o.failRow as { state: string; instance_ids: string; detail: string | null };
  assert.equal(row.state, "failed");
  const ids = JSON.parse(row.instance_ids) as string[];
  assert.equal(ids.length, 1);
  assert.equal(row.detail, null, "the standard per-host issue text");
  const audit = o.failAudit as { action: string; result: string; detail: string }[];
  const last = audit[audit.length - 1];
  assert.deepEqual([last.action, last.result], ["provision.add-host", "error"]);
  assert.equal(last.detail, `host ${ids[0]} launched but never joined acme-staging`);
  assert.deepEqual([(o.failOp as R).state, (o.failOp as R).verify], ["succeeded", "failed"]);
  const issues = o.issues as { id: string; reason: string }[];
  assert.ok(issues.some((i) => i.id === ids[0] && i.reason === `host ${ids[0]} launched but never joined acme-staging`), JSON.stringify(issues));
  assert.equal(r("reconcileNoEnvs").ok, true, "never throws");
});

test("R23: a host the console terminates had joined — its reservation is registered, not failed", () => {
  assert.equal(r("term").ok, true, String(r("term").error));
  const row = o.termRow as { state: string; instance_ids: string };
  assert.equal(row.state, "registered");
  assert.equal(JSON.parse(row.instance_ids).length, 1, "the record keeps the id it launched");
});

test("R23: the reconciler never settles a reservation whose instance ids were recorded after it read the row", () => {
  const late = o.late as { ok: boolean; error?: string; ids: string; row: { state: string; instance_ids: string } };
  assert.equal(late.ok, true, String(late.error));
  assert.deepEqual(late.row, { state: "pending", instance_ids: late.ids }, "still pending, with the ids the launch recorded");
});

test("CC-20 through the runner: scaling production api past its autoscaler's max warns that it will be overridden", () => {
  assert.ok(Array.isArray(o.scaleWarnings), String(o.scaleWarnings));
  assert.ok((o.scaleWarnings as string[]).some((w) => /Application Auto Scaling manages this service \(min 2, max 6.*\): a desired count of 8 is outside that range, so the autoscaler will override it — its next scaling activity sets the maximum, 6\./.test(w)), JSON.stringify(o.scaleWarnings));
});

test("R04 through the runner: scale and clone on staging run on the coordinator, recorded as operations", () => {
  assert.equal(r("scalePlan").ok, true, String(r("scalePlan").error));
  assert.equal(r("scale").ok, true, String(r("scale").error));
  assert.equal(r("scale").desired, o.scaleTo);
  assert.equal(o.scaleAfter, o.scaleTo);
  const op = o.scaleOp as R & { params: string };
  assert.deepEqual([op.action, op.state], ["provision.scale", "succeeded"]);
  assert.equal(JSON.parse(op.params).desiredAfter, o.scaleTo, "the live values go to the audit intent");
  assert.equal(r("clonePlan").ok, true, String(r("clonePlan").error));
  assert.equal(r("clone").ok, true, String(r("clone").error));
  assert.equal(r("clone").service, "api-canary");
  assert.deepEqual([(o.cloneOp as R).action, (o.cloneOp as R).state], ["provision.clone", "succeeded"]);
  assert.deepEqual([r("cloneAgain").ok, r("cloneAgain").status], [false, 409], "re-checked under the lock: the name is taken now");
  assert.deepEqual([r("wrongConfirm").ok, r("wrongConfirm").status], [false, 400]);
});

test("R04 across paths: provisioning and console actions lock the same canonical service key", () => {
  const race = o.crossRace as R[];
  assert.equal(race.filter((x) => x.ok).length, 1, JSON.stringify(race));
  assert.deepEqual([race.find((x) => !x.ok)!.status, race.find((x) => !x.ok)!.code], [409, "busy"]);
});

test("F31: a one-off task carries a client token derived from its operation id", () => {
  assert.equal(r("task").ok, true, String(r("task").error));
  assert.equal(o.taskToken, `dc-${r("task").operationId}`);
});

test("F67: a change that went out is never recorded as failed because its approval bookkeeping failed", () => {
  const f = o.f67 as { thrown?: string; error?: string; operationId?: string; status: string; desired: number; want: number; logged: boolean };
  assert.equal(f.thrown, undefined);
  assert.equal(f.desired, f.want, "the approved scale ran");
  assert.equal(f.error, undefined, "the person approving sees the result, not the bookkeeping error");
  assert.ok(f.operationId, "with the operation id to follow");
  assert.notEqual(f.status, "failed", "before F67 the catch-all recorded the approval as failed");
  assert.ok(f.logged, "the bookkeeping failure is logged");
});
