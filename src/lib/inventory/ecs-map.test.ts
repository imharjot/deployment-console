// The ECS-side cloud-map rules (ecs-map.ts): load balancer health from control plane + target groups (R17, F01),
// route edges and rule hostnames (F72), ECS service wiring (A.3, F18, CC-20), RDS/ElastiCache posture (F16, CC-22),
// env-file mentions (F17) — and, in a child process against the simulated account, the providers themselves (R16:
// load balancers listed while ECS discovery fails; regional RDS; externals from the declared provider; a secret
// sentinel that must never reach a resource or a link).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { elasticacheSpecs, rdsSpecs } from "../metric-specs.ts";
import type { RawCache, RawDb, RawService } from "../types.ts";
import {
  cacheResource, elbAction, elbLoadBalancer, elbRule, elbTargetGroup, envFileMentions, envFilesToRead, groupsOf, inboundLine, kmsRef, lbHealth, lbLinks, lbResource, lbSections,
  hostLinks, metricQueries, metricSeries, rdsResource, ruleHosts, scalingText, serviceWires, targetType, tgInput, type EcsJoin, type ElbLoadBalancer, type ElbTargetGroup,
} from "./ecs-map.ts";
import type { Resource } from "./types.ts";

const ACCT = "123456789012";
const R = "us-east-1";
const LB_ARN = `arn:aws:elasticloadbalancing:${R}:${ACCT}:loadbalancer/app/acme-production/5f2c1a9d3e7b4c60`;
const TG = (name: string, id = "0123456789abcdef") => `arn:aws:elasticloadbalancing:${R}:${ACCT}:targetgroup/${name}/${id}`;
const tg = (name: string, x: Partial<ElbTargetGroup> = {}): ElbTargetGroup => ({ arn: TG(name), name, lbArns: [LB_ARN], ...x });
const healthy = (id: string, port = 3000) => ({ id, port, state: "healthy" });
const lb = (x: Partial<ElbLoadBalancer> = {}): ElbLoadBalancer => ({
  arn: LB_ARN, name: "acme-production", dns: "acme-production-1.us-east-1.elb.amazonaws.com", type: "application", scheme: "internet-facing", state: "active", tags: {}, ...x,
});
const join = (byTg: [string, { key: string; env: string; desired: number; hidden?: boolean }[]][], byIp: [string, string][] = []): EcsJoin => ({
  byTg: new Map(byTg.map(([k, v]) => [k, v.map((s) => ({ hidden: false, ...s }))])), byIp: new Map(byIp),
});

// ---------- R17: health = control plane + backend evidence ----------

test("R17: a standalone ALB whose instance targets are all unhealthy is an error, not a default ok", () => {
  const g = tg("legacy-admin", { type: "instance", targets: [{ id: "i-0acmelegacy00002", port: 80, state: "unhealthy", reason: "Target.FailedHealthChecks" }] });
  const h = lbHealth("active", [{ g }]);
  assert.equal(h.health, "error");
  assert.match(h.healthReason ?? "", /0\/1 active target group healthy/);
  assert.equal(h.control.health, "ok");
  assert.equal(h.backend.health, "error");
});

test("R17: no target groups → unknown 'no backend evidence'; health not read → unknown too", () => {
  assert.deepEqual([lbHealth("active", []).health, lbHealth("active", []).healthReason], ["unknown", "no backend evidence (no target groups)"]);
  const unread = lbHealth("active", [{ g: tg("a") }]);
  assert.deepEqual([unread.health, unread.healthReason], ["unknown", "no backend evidence (target health not read)"]);
  // Every target "unavailable" (not because checks are off) proves nothing either.
  assert.equal(lbHealth("active", [{ g: tg("a", { targets: [{ id: "10.0.0.1", state: "unavailable", reason: "Elb.InternalError" }] }) }]).health, "unknown");
});

test("R17: control plane and backend combine — failed wins, provisioning/impaired warn, healthy needs both", () => {
  const ok = { g: tg("a", { targets: [healthy("10.0.0.1")] }) };
  assert.deepEqual([lbHealth("failed", [ok]).health, lbHealth("failed", [ok]).healthReason], ["error", "load balancer failed"]);
  assert.deepEqual([lbHealth("active_impaired", [ok]).health, lbHealth("active_impaired", [ok]).healthReason], ["warning", "active impaired"]);
  assert.equal(lbHealth("provisioning", []).health, "warning");
  assert.deepEqual([lbHealth("active", [ok]).health, lbHealth("active", [ok]).healthReason], ["ok", undefined]);
  // Lambda targets with health checks off serve traffic.
  assert.equal(lbHealth("active", [{ g: tg("fn", { type: "lambda", targets: [{ id: "arn:aws:lambda:us-east-1:123456789012:function:f", state: "unavailable", reason: "Target.HealthCheckDisabled" }] }) }]).health, "ok");
  // One unhealthy of two groups: degraded.
  const bad = { g: tg("b", { targets: [healthy("10.0.0.2"), { id: "10.0.0.3", state: "unhealthy" }] }) };
  assert.equal(lbHealth("active", [ok, bad]).health, "warning");
});

// ---------- F01: a parked service's empty group ----------

test("F01: the parked service's empty target group is idle (ok, with the reason) — a common shape", () => {
  const web = tg("prod-web", { targets: [healthy("10.20.0.28")] });
  const worker = tg("prod-worker", { targets: [healthy("10.20.0.52", 8080)] });
  const admin = tg("prod-admin", { targets: [] });
  const h = lbHealth("active", [{ g: web, desired: 1 }, { g: worker, desired: 1 }, { g: admin, desired: 0 }]);
  assert.equal(h.health, "ok");
  assert.equal(h.healthReason, "2/2 active target groups healthy · prod-admin idle (service scaled to 0)");
  // The same empty group behind a service that wants a task is an error.
  assert.equal(lbHealth("active", [{ g: web, desired: 1 }, { g: admin, desired: 1 }]).health, "warning");
  assert.equal(lbHealth("active", [{ g: admin, desired: 1 }]).health, "error");
  // Without ECS (R16: discovery failed) an empty group can't be told apart: bad, and the reason says why.
  const noEcs = lbHealth("active", [{ g: admin }], { ecsRead: false });
  assert.equal(noEcs.health, "error");
  assert.match(noEcs.healthReason ?? "", /ECS services not read/);
  // Counts (the simulated Cloud) work the same way.
  assert.equal(lbHealth("active", [{ g: tg("c", { counts: { healthy: 0, unhealthy: 0 } }), desired: 0 }]).health, "ok");
});

test("tgInput: unused targets don't count as healthy; no evidence → undefined", () => {
  assert.equal(tgInput(tg("a")), undefined);
  assert.deepEqual(tgInput(tg("a", { targets: [{ id: "i-1", state: "unused", reason: "Target.InvalidState" }] }), 1), { arn: TG("a"), name: "a", healthy: 0, unhealthy: 0, initial: 0, draining: 0, desired: 1 });
  assert.deepEqual(tgInput(tg("a", { targets: [{ id: "i-1", state: "initial" }, { id: "i-2", state: "draining" }] }))?.initial, 1);
  assert.equal(targetType([{ id: "i-0abc", state: "healthy" }]), "instance");
  assert.equal(targetType([{ id: "10.0.0.1", state: "healthy" }]), "ip");
  assert.equal(targetType([{ id: "arn:aws:lambda:us-east-1:1:function:f", state: "healthy" }]), "lambda");
  assert.equal(targetType([]), undefined);
});

// ---------- F72 + R17: route edges ----------

const LISTENERS = [
  {
    protocol: "HTTPS", port: 443,
    rules: [
      { priority: "10", hosts: ["api.acme.dev"], paths: [], action: "forward", targetGroupArns: [TG("prod-api")] },
      { priority: "20", hosts: ["*.acme.dev", "billing.acme.dev"], paths: ["/billing/*"], action: "forward", targetGroupArns: [TG("prod-billing")] },
      { priority: "30", hosts: ["old.acme.dev"], paths: [], action: "redirect", targetGroupArns: [] },
      { priority: "default", hosts: [], paths: [], action: "fixed-response", targetGroupArns: [] },
    ],
  },
];

test("F72: rule hostnames per target group (forward rules only, no wildcards)", () => {
  const m = ruleHosts(LISTENERS);
  assert.deepEqual(m.get(TG("prod-api")), ["api.acme.dev"]);
  assert.deepEqual(m.get(TG("prod-billing")), ["billing.acme.dev"]);
  assert.equal(m.size, 2);
  assert.equal(ruleHosts(undefined).size, 0);
});

test("F72 + R17: route edges — to services (' · no targets' on an empty group), to instance, ip, lambda targets", () => {
  const groups = [
    tg("prod-api", { targets: [healthy("10.0.3.20")] }),
    tg("prod-billing", { targets: [] }),
    tg("legacy", { type: "instance", targets: [{ id: "i-0abc", port: 80, state: "unhealthy" }] }),
    tg("partner", { type: "ip", targets: [healthy("10.0.9.9", 8443), healthy("10.0.3.21", 3000)] }),
    tg("thumbs", { type: "lambda", targets: [{ id: "arn:aws:lambda:us-east-1:123456789012:function:thumb", state: "unavailable", reason: "Target.HealthCheckDisabled" }] }),
  ];
  const j = join(
    [[TG("prod-api"), [{ key: "ecs:service/acme-production/api", env: "production", desired: 2 }]], [TG("prod-billing"), [{ key: "ecs:service/acme-production/billing", env: "production", desired: 0 }]]],
    [["10.0.3.21", "ecs:service/acme-production/worker"]],
  );
  const links = lbLinks("elb:acme-production", lb({ listeners: LISTENERS }), groups, j);
  const by = (to: string) => links.filter((l) => l.to === to);
  assert.deepEqual(by("ecs:service/acme-production/api").map((l) => [l.kind, l.label, l.evidence]), [["route", "api.acme.dev", "listener HTTPS:443 rule 10 → prod-api"]]);
  assert.deepEqual(by("ecs:service/acme-production/billing").map((l) => l.label), ["*.acme.dev billing.acme.dev /billing/* · no targets"]);
  assert.deepEqual(by("ec2:i-0abc").map((l) => [l.kind, l.label, l.evidence]), [["route", "legacy → :80", "target group legacy: unhealthy"]]);
  assert.deepEqual(by("10.0.9.9").map((l) => l.label), ["partner → :8443"], "an IP no task holds stays an address (infer makes public ones external hosts)");
  assert.deepEqual(by("ecs:service/acme-production/worker").map((l) => l.label), ["partner → :3000"], "an IP target held by a RUNNING ECS task → that service");
  assert.deepEqual(by("arn:aws:lambda:us-east-1:123456789012:function:thumb").map((l) => l.kind), ["invoke"]);
  // Hidden services are never targets of an edge.
  const hidden = lbLinks("elb:x", lb({ listeners: LISTENERS }), groups, join([[TG("prod-api"), [{ key: "ecs:service/c/hidden", env: "p", desired: 1, hidden: true }]]]));
  assert.ok(!hidden.some((l) => l.to === "ecs:service/c/hidden"));
  // Outside home, instance targets name the regional key the compute provider gives them.
  const eu = lbLinks("elb:x@eu-west-1", lb({ listeners: LISTENERS }), groups, j, { region: "eu-west-1", home: R });
  assert.ok(eu.some((l) => l.to === "ec2:i-0abc@eu-west-1") && !eu.some((l) => l.to === "ec2:i-0abc"));
  assert.ok(lbLinks("elb:x", lb({ listeners: LISTENERS }), groups, j, { region: R, home: R }).some((l) => l.to === "ec2:i-0abc"));
});

test("R16: a load balancer without any ECS join is still a full resource (health from its own target groups)", () => {
  const groups = [tg("legacy", { type: "instance", targets: [{ id: "i-0abc", port: 80, state: "unhealthy" }] })];
  const r = lbResource(lb({ listeners: LISTENERS }), groups, { region: R, home: R });
  assert.equal(r.key, "elb:acme-production");
  assert.equal(r.health, "error");
  assert.equal(r.facts?.public, true);
  assert.equal(r.envHint, undefined);
  assert.ok(r.props.some((p) => p.label === "Targets" && p.value === "1 unhealthy"));
  assert.ok(r.props.some((p) => p.label === "Backend" && /0\/1 active target group healthy/.test(p.value)));
  // Region-aware key outside home; internal → not public; tags not read → protection fails closed.
  const eu = lbResource(lb({ scheme: "internal", tags: undefined }), [], { region: "eu-west-1", home: R });
  assert.equal(eu.key, "elb:acme-production@eu-west-1");
  assert.equal(eu.facts?.public, false);
  assert.equal(eu.tagsUnread, true);
  assert.equal(eu.health, "unknown");
  // One environment behind it → its hint.
  const j = join([[TG("legacy"), [{ key: "ecs:service/acme-production/api", env: "production", desired: 1 }]]]);
  assert.equal(lbResource(lb(), groups, { region: R, home: R, join: j }).envHint, "production");
  // groupsOf: named by the group or by a rule.
  const other = { ...tg("x"), lbArns: [] };
  assert.deepEqual(groupsOf(lb({ listeners: [{ protocol: "HTTP", port: 80, rules: [{ priority: "default", hosts: [], paths: [], action: "forward", targetGroupArns: [other.arn] }] }] }), [other, tg("y", { lbArns: ["other"] })]).map((g) => g.name), ["x"]);
});

test("lbSections: listener rules, target groups with their services, every target", () => {
  const groups = [tg("prod-api", { type: "ip", port: 3000, protocol: "HTTP", healthPath: "/ready", targets: [healthy("10.0.3.20")] })];
  const s = lbSections(lb({ listeners: LISTENERS }), groups, join([[TG("prod-api"), [{ key: "ecs:service/acme-production/api", env: "production", desired: 1 }]]]));
  assert.deepEqual(s.map((x) => x.title), ["Listener rules", "Target groups", "Targets"]);
  assert.deepEqual(s[1].table?.rows[0], ["prod-api", "ip", "HTTP:3000", "/ready", "1 healthy", "api"]);
  assert.match(lbSections(lb({ listeners: undefined }), [], undefined)[0].note ?? "", /Not read/);
  // A hidden service stays off the panel's tables too.
  const hid = lbSections(lb({ listeners: LISTENERS }), groups, join([[TG("prod-api"), [{ key: "ecs:service/acme-production/api", env: "production", desired: 1 }, { key: "ecs:service/acme-production/sidecar", env: "production", desired: 1, hidden: true }]]]));
  assert.equal(hid[1].table?.rows[0][5], "api");
});

// Real-account parity: the ELB API's answers (shapes from the read-only CLI on a real account, names anonymised to Acme)
// through the mappers, then the rules. Three ip target groups behind one ALB; the third belongs to a service scaled to 0.
test("parity: DescribeLoadBalancers / DescribeTargetGroups / DescribeRules shapes → the map (F01 on the real shape)", () => {
  const lbx = elbLoadBalancer({
    LoadBalancerArn: LB_ARN, LoadBalancerName: "acme-production", DNSName: "acme-production-1.us-east-1.elb.amazonaws.com", Type: "application", Scheme: "internet-facing",
    State: { Code: "active" }, VpcId: "vpc-prod", SecurityGroups: ["sg-prod-alb"], AvailabilityZones: [{ ZoneName: "us-east-1a" }, { ZoneName: "us-east-1b" }], CreatedTime: new Date(Date.UTC(2026, 8, 27)),
  });
  assert.deepEqual([lbx.name, lbx.state, lbx.azs, lbx.createdAt], ["acme-production", "active", ["us-east-1a", "us-east-1b"], Date.UTC(2026, 8, 27)]);
  const groups = ([["prod-api", 3000], ["prod-jobs", 8080], ["prod-billing", 3010]] as const).map(([n, port]) =>
    elbTargetGroup({ TargetGroupArn: TG(n), TargetGroupName: n, TargetType: "ip", Protocol: "HTTP", Port: port, HealthCheckPath: "/ready", LoadBalancerArns: [LB_ARN] }),
  );
  groups[0].targets = [{ id: "10.20.0.28", port: 3000, az: "us-east-1a", state: "healthy" }];
  groups[1].targets = [{ id: "10.20.0.52", port: 8080, az: "us-east-1a", state: "healthy" }];
  groups[2].targets = [];
  const rules = [
    { Priority: "10", IsDefault: false, Conditions: [{ Field: "host-header", HostHeaderConfig: { Values: ["api.acme.dev"] }, Values: ["api.acme.dev"] }], Actions: [{ Type: "forward", TargetGroupArn: TG("prod-api"), Order: 1, ForwardConfig: { TargetGroups: [{ TargetGroupArn: TG("prod-api"), Weight: 1 }] } }] },
    { Priority: "20", IsDefault: false, Conditions: [{ Field: "host-header", HostHeaderConfig: { Values: ["jobs.acme.dev"] } }], Actions: [{ Type: "forward", TargetGroupArn: TG("prod-jobs"), Order: 1 }] },
    { Priority: "30", IsDefault: false, Conditions: [{ Field: "host-header", Values: ["billing.acme.dev"] }], Actions: [{ Type: "forward", TargetGroupArn: TG("prod-billing"), Order: 1 }] },
    { Priority: "default", IsDefault: true, Conditions: [], Actions: [{ Type: "fixed-response", Order: 1, FixedResponseConfig: { StatusCode: "404" } }] },
  ].map(elbRule);
  assert.deepEqual(rules.map((r) => [r.priority, r.hosts, r.action, r.targetGroupArns.length]), [["10", ["api.acme.dev"], "forward", 1], ["20", ["jobs.acme.dev"], "forward", 1], ["30", ["billing.acme.dev"], "forward", 1], ["default", [], "fixed-response", 0]]);
  lbx.listeners = [{ protocol: "HTTPS", port: 443, rules }, { protocol: "HTTP", port: 80, rules: [{ priority: "default", hosts: [], paths: [], ...elbAction([{ Type: "redirect", Order: 1 }]) }] }];
  const j = join([
    [TG("prod-api"), [{ key: "ecs:service/acme-production/api", env: "production", desired: 1 }]],
    [TG("prod-jobs"), [{ key: "ecs:service/acme-production/worker", env: "production", desired: 1 }]],
    [TG("prod-billing"), [{ key: "ecs:service/acme-production/billing", env: "production", desired: 0 }]],
  ]);
  const r = lbResource(lbx, groupsOf(lbx, groups), { region: R, home: R, join: j });
  assert.equal(r.health, "ok");
  assert.equal(r.healthReason, "2/2 active target groups healthy · prod-billing idle (service scaled to 0)");
  const links = lbLinks(r.key, lbx, groupsOf(lbx, groups), j);
  assert.deepEqual(links.map((l) => [l.to, l.label]), [
    ["ecs:service/acme-production/api", "api.acme.dev"], ["ecs:service/acme-production/worker", "jobs.acme.dev"], ["ecs:service/acme-production/billing", "billing.acme.dev · no targets"],
  ]);
  // A weighted forward splits over two groups; authenticate + forward keep their order.
  assert.deepEqual(elbAction([{ Type: "forward", Order: 2, ForwardConfig: { TargetGroups: [{ TargetGroupArn: TG("a") }, { TargetGroupArn: TG("b") }] } }, { Type: "authenticate-oidc", Order: 1 }]), {
    action: "authenticate-oidc+forward", targetGroupArns: [TG("a"), TG("b")],
  });
});

// ---------- ECS service wiring (A.3, F18, CC-20) ----------

const svc = (x: Partial<RawService> = {}): RawService => ({
  name: "api", cluster: "acme-production", status: "ACTIVE", desired: 2, running: 2, pending: 0, launchType: "FARGATE", deployments: [], targetGroupArns: [], circuitBreaker: true,
  tags: {}, securityGroups: [], subnets: [],
  tasks: [
    { id: "t1", taskDefinition: "td", lastStatus: "RUNNING", desiredStatus: "RUNNING", health: "HEALTHY", hasHealthcheck: true, privateIp: "10.0.3.20" },
    { id: "t2", taskDefinition: "td", lastStatus: "STOPPED", desiredStatus: "STOPPED", health: "UNKNOWN", hasHealthcheck: true, privateIp: "10.0.3.99" },
  ],
  taskDef: {
    arn: "arn:aws:ecs:us-east-1:123456789012:task-definition/api-production:7", family: "api-production", revision: 7, image: "x", launchTypes: ["FARGATE"], ports: [3000], containers: [], main: "api",
    taskRoleArn: "arn:aws:iam::123456789012:role/acme-production-api-task", executionRoleArn: "arn:aws:iam::123456789012:role/acme-ecs-task-execution",
    volumes: [{ name: "media", efs: { fileSystemId: "fs-0acme0media000001", accessPointId: "fsap-0acme0media00001" } }, { name: "scratch" }],
  },
  serviceRegistries: [{ registryArn: "arn:aws:servicediscovery:us-east-1:123456789012:service/srv-acme0api000001", containerName: "api", containerPort: 3000 }],
  deploymentController: "CODE_DEPLOY",
  assignPublicIp: true,
  serviceConnect: [{ discoveryName: "storefront", clientAliases: [{ dnsName: "storefront.internal", port: 8080 }] }],
  ...x,
});

test("A.3 wiring: roles, Cloud Map, EFS, Service Connect aliases, task IPs, CodeDeploy, autoscaling, public IP", () => {
  const key = "ecs:service/acme-production/api";
  const w = serviceWires(svc(), { key, region: R, account: ACCT, scaling: { min: 2, max: 6, policies: ["target tracking (CPU 60 %)"] }, ruleHosts: ["api.acme.dev"] });
  assert.deepEqual(w.links.map((l) => [l.from, l.to, l.kind, l.label]), [
    [key, "arn:aws:iam::123456789012:role/acme-production-api-task", "assumes", "task role"],
    [key, "arn:aws:iam::123456789012:role/acme-ecs-task-execution", "assumes", "execution role"],
    ["arn:aws:servicediscovery:us-east-1:123456789012:service/srv-acme0api000001", key, "route", "ECS service registry"],
    [key, "arn:aws:elasticfilesystem:us-east-1:123456789012:file-system/fs-0acme0media000001", "mounts", "media (access point fsap-0acme0media00001)"],
  ]);
  assert.deepEqual(w.aliases, ["storefront", "storefront.internal"]);
  assert.deepEqual(w.endpoints, ["api.acme.dev", "10.0.3.20"], "rule hosts and RUNNING task IPs only");
  assert.deepEqual(w.facts, { desired: 2, public: true });
  const props = Object.fromEntries(w.props.map((p) => [p.label, p.value]));
  assert.equal(props["Deploys with"], "CodeDeploy");
  assert.equal(props.Autoscaling, "min 2 · max 6 · target tracking (CPU 60 %)");
  assert.equal(props["Public IP"], "assigned to every task");
  assert.equal(scalingText({ min: 1, max: 1, policies: [] }), "min 1 · max 1");
  // A plain service adds nothing; assignPublicIp DISABLED is an explicit "not public".
  const plain = serviceWires(svc({ taskDef: null, serviceRegistries: undefined, deploymentController: "ECS", assignPublicIp: false, serviceConnect: undefined, tasks: [] }), { key, region: R });
  assert.deepEqual([plain.links, plain.aliases, plain.endpoints, plain.props, plain.facts], [[], [], [], [], { desired: 2, public: false }]);
});

test("hostLinks: the instances a service's live tasks are on; candidates only while placement is unread; nothing when nothing runs", () => {
  const key = "ecs:service/acme-staging/api";
  const o = { key, region: R, home: R, cluster: "acme-staging", hosts: ["i-a", "i-b"] };
  const task = (id: string, lastStatus: string, host?: string) => ({ id, taskDefinition: "td", lastStatus, desiredStatus: "RUNNING", health: "HEALTHY" as const, hasHealthcheck: false, ...(host ? { host } : {}) });
  const ec2 = (x: Partial<RawService>) => svc({ launchType: "EC2", ...x });
  const of = (l: ReturnType<typeof hostLinks>) => l.map((x) => `${x.to} ${x.label}`).sort();
  // Placed: exactly where ECS put them, starting tasks told apart.
  assert.deepEqual(of(hostLinks(ec2({ tasks: [task("t1", "RUNNING", "i-a"), task("t2", "PENDING", "i-b")] }), o)), ["ec2:i-a runs on", "ec2:i-b starting on"]);
  // Scaled to zero, or every task stopped: it runs nowhere, even on a one-host cluster.
  assert.deepEqual(hostLinks(ec2({ desired: 0, running: 0, pending: 0, tasks: [] }), { ...o, hosts: ["i-a"] }), []);
  // One task placed, one whose host wasn't read: the other instance is a candidate.
  assert.deepEqual(of(hostLinks(ec2({ tasks: [task("t1", "RUNNING", "i-a"), task("t2", "RUNNING")] }), o)), ["ec2:i-a runs on", "ec2:i-b may run on"]);
  // The listing stopped short (no records at all): candidates, "runs on" when the cluster has one host.
  const cut = ec2({ running: 1, tasks: [], tasksComplete: false });
  assert.deepEqual(of(hostLinks(cut, o)), ["ec2:i-a may run on", "ec2:i-b may run on"]);
  assert.deepEqual(of(hostLinks(cut, { ...o, hosts: ["i-a"] })), ["ec2:i-a runs on"]);
  assert.match(hostLinks(cut, o)[0].evidence, /1 task not placed in what was read/);
  assert.deepEqual(hostLinks(cut, { ...o, hosts: Array.from({ length: 11 }, (_, i) => `i-${i}`) }), [], "past 10 hosts, candidates aren't drawn");
  assert.deepEqual(hostLinks(svc({ running: 1, tasks: [], tasksComplete: false }), o), [], "Fargate tasks have no host to guess");
});

// ---------- F16: RDS and ElastiCache posture ----------

const db = (x: Partial<RawDb> = {}): RawDb => ({
  id: "acme-production-pg", status: "available", engine: "postgres", engineVersion: "17.6", instanceClass: "db.r6g.large", storageGb: 100, multiAz: false,
  endpoint: "acme-production-pg.c0example.us-east-1.rds.amazonaws.com", port: 5432, vpcId: "vpc-prod", securityGroups: ["sg-prod-db"], tags: { Environment: "production" },
  kmsKeyId: "arn:aws:kms:us-east-1:123456789012:key/mrk-0acme1234567890abcdef12345678", publiclyAccessible: false, subnetIds: ["subnet-prod-a", "subnet-prod-b"],
  createdAt: Date.UTC(2026, 8, 27), storageEncrypted: true, backupRetentionDays: 14, deletionProtection: true, backupWindow: "17:52-18:22", parameterGroup: "acme-pg17", ...x,
});

test("F16 golden: an RDS instance's posture, links and keys", () => {
  const { resource: r, links } = rdsResource(db(), { region: R, home: R, account: ACCT, envHint: "production" });
  assert.deepEqual(
    { key: r.key, aliases: r.aliases, parent: r.parent, vpcId: r.vpcId, subnetIds: r.subnetIds, facts: r.facts, tags: r.tags, createdAt: r.createdAt, health: r.health, envHint: r.envHint },
    {
      key: "rds:acme-production-pg", aliases: ["arn:aws:rds:us-east-1:123456789012:db:acme-production-pg"], parent: undefined, vpcId: "vpc-prod",
      subnetIds: ["subnet-prod-a", "subnet-prod-b"], facts: { public: false }, tags: { Environment: "production" }, createdAt: Date.UTC(2026, 8, 27), health: "ok", envHint: "production",
    },
  );
  assert.deepEqual(r.props.map((p) => [p.label, p.value]), [
    ["Engine", "postgres 17.6"], ["Class", "db.r6g.large"], ["Storage", "100 GiB"], ["Multi-AZ", "no"], ["Endpoint", "acme-production-pg.c0example.us-east-1.rds.amazonaws.com:5432"],
    ["Status", "available"], ["Publicly accessible", "no"], ["Encryption", "KMS key/mrk-0acme1234567890abcdef12345678"], ["Backups", "14 days · window 17:52-18:22 UTC"],
    ["Deletion protection", "on"], ["Created", "2026-09-27"],
  ]);
  assert.deepEqual(links, [{ from: "arn:aws:kms:us-east-1:123456789012:key/mrk-0acme1234567890abcdef12345678", to: "rds:acme-production-pg", kind: "encrypts", label: "storage", evidence: "RDS storage encryption key (KmsKeyId)" }]);
  // eu-west-1: region-aware key; an Aurora member's parent is its cluster's ARN; public; backups off; no KMS when unencrypted.
  const eu = rdsResource(db({ id: "acme-analytics-eu-1", aurora: "acme-analytics-eu", publiclyAccessible: true, backupRetentionDays: 0, storageEncrypted: false }), { region: "eu-west-1", home: R, account: ACCT });
  assert.equal(eu.resource.key, "rds:acme-analytics-eu-1@eu-west-1");
  assert.equal(eu.resource.parent, "arn:aws:rds:eu-west-1:123456789012:cluster:acme-analytics-eu");
  assert.deepEqual(eu.resource.facts, { public: true });
  assert.ok(eu.resource.aliases?.includes("aurora:acme-analytics-eu"));
  assert.equal(eu.resource.props.find((p) => p.label === "Backups")?.value, "off");
  assert.equal(eu.resource.props.find((p) => p.label === "Encryption")?.value, "not encrypted");
  assert.deepEqual(eu.links, []);
});

test("kmsRef: ARNs stand; bare key ids and aliases get the resource's region (CC-19)", () => {
  assert.equal(kmsRef("alias/aws/rds", "eu-west-1", ACCT), "arn:aws:kms:eu-west-1:123456789012:alias/aws/rds");
  assert.equal(kmsRef("0acme0ab-1111", R, ACCT), "arn:aws:kms:us-east-1:123456789012:key/0acme0ab-1111");
  assert.equal(kmsRef("arn:aws:kms:us-east-1:1:key/x", "eu-west-1", ACCT), "arn:aws:kms:us-east-1:1:key/x");
  assert.equal(kmsRef("alias/x", R), undefined);
  assert.equal(kmsRef(undefined, R, ACCT), undefined);
});

const cache = (x: Partial<RawCache> = {}): RawCache => ({
  id: "acme-sessions", status: "available", engine: "valkey", engineVersion: "8.1.0", nodeType: "cache.t4g.micro", nodes: 1, endpoint: "master.acme-sessions.x1y2z3.aps1.cache.amazonaws.com", port: 6379,
  securityGroups: ["sg-cache"], arn: "arn:aws:elasticache:us-east-1:123456789012:replicationgroup:acme-sessions", memberClusters: ["acme-sessions-001", "acme-sessions-002"],
  atRestEncryption: true, transitEncryption: false, authToken: false, subnetGroup: "acme-sessions", createdAt: Date.UTC(2026, 8, 27), ...x,
});

test("F16 + CC-22: ElastiCache — member clusters as aliases, tags unread fail closed, VPC from the subnet group", () => {
  const { resource: r, links } = cacheResource(cache(), { region: R, home: R, account: ACCT, tags: undefined, vpcId: "vpc-x", subnetIds: ["subnet-a"] });
  assert.equal(r.key, "elasticache:acme-sessions");
  assert.deepEqual(r.aliases, [
    "arn:aws:elasticache:us-east-1:123456789012:replicationgroup:acme-sessions", "acme-sessions-001", "acme-sessions-002",
    "arn:aws:elasticache:us-east-1:123456789012:cluster:acme-sessions-001", "arn:aws:elasticache:us-east-1:123456789012:cluster:acme-sessions-002",
  ]);
  assert.equal(r.tagsUnread, true);
  assert.deepEqual([r.vpcId, r.subnetIds], ["vpc-x", ["subnet-a"]]);
  const props = Object.fromEntries(r.props.map((p) => [p.label, p.value]));
  assert.deepEqual([props["Encryption at rest"], props["In-transit encryption"], props["AUTH token"], props.Members], ["on (AWS-owned key)", "off", "off", "acme-sessions-001, acme-sessions-002"]);
  assert.equal(cacheResource({ ...cache(), multiAz: true, automaticFailover: "enabled" }, { region: R, home: R }).resource.props.find((p) => p.label === "Multi-AZ")?.value, "yes");
  assert.deepEqual(links, []);
  // Tags read; a customer key → encrypts link; eu key; status mapping.
  const eu = cacheResource(cache({ kmsKeyId: "alias/acme", status: "create-failed" }), { region: "eu-west-1", home: R, account: ACCT, tags: { team: "data" } });
  assert.equal(eu.resource.key, "elasticache:acme-sessions@eu-west-1");
  assert.equal(eu.resource.tagsUnread, undefined);
  assert.deepEqual(eu.resource.tags, { team: "data" });
  assert.equal(eu.resource.health, "error");
  assert.deepEqual(eu.links.map((l) => [l.from, l.to, l.kind]), [["arn:aws:kms:eu-west-1:123456789012:alias/acme", "elasticache:acme-sessions@eu-west-1", "encrypts"]]);
});

test("detail helpers: inbound rules with CIDRs, metric charts scaled and labelled", () => {
  assert.equal(
    inboundLine([{ fromPort: 5432, toPort: 5432, groups: ["sg-api"], cidrs: ["0.0.0.0/0"], description: "temp" }, { groups: [], prefixLists: ["pl-1"] }, { fromPort: 8000, toPort: 8100, groups: ["sg-x"] }]),
    "port 5432 ← sg-api, 0.0.0.0/0 (temp); all traffic ← pl-1; ports 8000-8100 ← sg-x",
  );
  assert.equal(inboundLine([]), "no inbound rules");
  const specs = rdsSpecs("acme-production-pg");
  const q = metricQueries(specs);
  assert.deepEqual(q[0], { id: "m0", namespace: "AWS/RDS", metric: "CPUUtilization", dims: { DBInstanceIdentifier: "acme-production-pg" }, stat: "Average" });
  const series = metricSeries(specs, { m0: [[1, 12]], m2: [[1, 0.002]], m6: [[1, 2 * 1024 ** 2]] });
  assert.deepEqual(series.map((s) => s.label), ["CPU", "Connections", "Latency · Read", "Latency · Write", "IOPS · Read", "IOPS · Write", "Freeable memory", "Free storage"]);
  assert.deepEqual([series[0].points, series[2].points, series[2].unit, series[6].points, series[6].unit], [[[1, 12]], [[1, 2]], "ms", [[1, 2]], "MiB"]);
  assert.equal(metricSeries(elasticacheSpecs("acme-sessions-001"), {}).length, 5);
});

// ---------- F17: env files ----------

test("F17: env files of the console (or of a service that might be it) are never read, even when shared", () => {
  const read = envFilesToRead([
    { files: ["arn:aws:s3:::cfg/api.env", "arn:aws:s3:::cfg/shared.env"], self: false },
    { files: ["arn:aws:s3:::cfg/shared.env", "arn:aws:s3:::cfg/console.env"], self: true },
    { files: ["arn:aws:s3:::cfg/worker.env", "arn:aws:s3:::cfg/api.env"], self: false },
  ]);
  assert.deepEqual(read, ["arn:aws:s3:::cfg/api.env", "arn:aws:s3:::cfg/worker.env"]);
  assert.deepEqual(envFilesToRead([{ files: ["a"], self: true }]), []);
  // A service that may be the console but whose files aren't known (task definition or cluster unread): any file could
  // be its own, so none is read. A non-self service with unknown files changes nothing.
  assert.deepEqual(envFilesToRead([{ files: ["arn:aws:s3:::cfg/api.env"], self: false }, { self: true }]), []);
  assert.deepEqual(envFilesToRead([{ files: ["arn:aws:s3:::cfg/api.env"], self: false }, { self: false }]), ["arn:aws:s3:::cfg/api.env"]);
});

test("F17 sentinel: an env file's DATABASE_URL becomes a mention ref only — never a via, label, prop or evidence", () => {
  const SENTINEL = "postgres://app:S3NT1NEL-pa55@acme-production-pg.c0example.us-east-1.rds.amazonaws.com:5432/app";
  const text = `# comment\nDATABASE_URL=${SENTINEL}\nEMPTY=\nexport LONG=${"x".repeat(5000)}\nFEATURE_FLAGS=a,b\n`;
  const m = envFileMentions("ecs:service/acme-staging/api", text);
  assert.deepEqual(m.map((x) => x.via), ["env file DATABASE_URL", "env file FEATURE_FLAGS"]);
  assert.deepEqual(m[0].refs, [SENTINEL]);
  // Nothing a provider puts on the map carries it.
  const resources: Resource[] = [
    lbResource(lb(), [], { region: R, home: R }), rdsResource(db(), { region: R, home: R, account: ACCT }).resource, cacheResource(cache(), { region: R, home: R, account: ACCT, tags: {} }).resource,
  ];
  const wired = serviceWires(svc(), { key: "ecs:service/acme-staging/api", region: R, account: ACCT });
  assert.ok(!JSON.stringify({ resources, wired, via: m.map((x) => x.via) }).includes("S3NT1NEL"));
});

// ---------- the providers, against the simulated account ----------

const root = fileURLToPath(new URL("../../../", import.meta.url));
function inChild<T>(body: string): T {
  const dir = mkdtempSync(path.join(tmpdir(), "dc-ecs-map-"));
  try {
    const base = new URL("../server/", import.meta.url).href;
    const code = `const mod = (p) => import(new URL(p, ${JSON.stringify(base)}).href); const out = await (async () => { ${body} })(); process.stdout.write(JSON.stringify(out), () => process.exit(0));`;
    const r = spawnSync(process.execPath, ["--conditions=react-server", "--no-warnings", "--input-type=module", "-e", code], {
      cwd: root, encoding: "utf8", timeout: 90_000, maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, CONSOLE_SOURCE: "mock", CONSOLE_DATA_DIR: dir, CONSOLE_CONFIG: "", CONSOLE_SELF: "", ECS_CONTAINER_METADATA_URI_V4: "", AUTH_MODE: "dev", NODE_ENV: "test" },
    });
    assert.equal(r.status, 0, `child failed:\n${r.stderr?.slice(-3000)}`);
    return JSON.parse(r.stdout) as T;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

interface Out {
  ids: Record<string, { scope?: string; multiRegionMock?: boolean; covers?: string[]; sensitive?: string[] }>;
  ecs: { resources: Resource[]; links: { from: string; to: string; kind: string; label?: string }[]; vias: string[]; secretInMentions: boolean };
  sentinelLeak: boolean;
  elb: { us: Resource[]; usLinks: { from: string; to: string; kind: string; label?: string }[]; eu: number; notes: string[] };
  rds: { us: string[]; eu: string[] };
  declared: { key: string; provider: string }[];
  details: { external: unknown; rds: { titles: string[]; metrics: number }; cache: { titles: string[]; metrics: number }; lb: string[] };
  ecsDown: { keys: string[]; health: string; notes: string[] };
  parked: { health: string; reason?: string; labels: string[] };
  closed: { services: number; envFileVias: number; notes: string[] };
}

test("providers on the simulated account: ELB independent of ECS, eu RDS, externals declared, no secret on the map", () => {
  const out = inChild<Out>(`
    const { providers } = await mod("providers/ecs.ts");
    const { declaredProvider } = await mod("providers/declared.ts");
    const { getCloud } = await mod("sources.ts");
    const by = Object.fromEntries(providers.map((p) => [p.id, p]));
    const ctx = (region, notes = []) => ({ region, home: "us-east-1", regions: ["us-east-1", "eu-west-1"], accountId: "123456789012", mock: true, cap: 2000, signal: new AbortController().signal, limit: (fn) => fn(), note: (m) => notes.push(m) });
    const ids = Object.fromEntries([...providers, declaredProvider].map((p) => [p.id, { scope: p.scope, multiRegionMock: p.multiRegionMock, covers: p.covers, sensitive: p.sensitive }]));

    const e = await by.ecs.discover(ctx("us-east-1"));
    const home = await getCloud("us-east-1");
    const file = await home.readEnvFile("arn:aws:s3:::acme-config/staging/api.env");
    const text = typeof file === "string" ? file : file.text;
    const smtp = /SMTP_PASSWORD=(.*)/.exec(text)[1];
    const onMap = JSON.stringify({ r: e.resources, l: e.links });
    const sentinelLeak = [smtp, "pg-api-staging-pass", "pg-api-production-pass"].some((s) => onMap.includes(s));
    const vias = e.mentions.map((m) => m.via);
    const secretInMentions = e.mentions.some((m) => m.refs.includes(smtp));

    const notes = [];
    const us = await by.elb.discover(ctx("us-east-1", notes));
    const eu = await by.elb.discover(ctx("eu-west-1"));
    const rdsUs = await by.rds.discover(ctx("us-east-1"));
    const rdsEu = await by.rds.discover(ctx("eu-west-1"));
    const dec = await declaredProvider.discover(ctx("us-east-1"));

    const ext = dec.resources.find((r) => r.kind === "external");
    const pg = rdsUs.resources.find((r) => r.name === "acme-production-pg");
    const cacheR = (await by.elasticache.discover(ctx("us-east-1"))).resources[0];
    const detail = async (p, r) => { const d = await p.detail(r, ctx(r.region === "global" ? "us-east-1" : r.region)); return { titles: d.sections.map((s) => s.title), metrics: d.metrics?.length ?? 0 }; };
    const lbD = await by.elb.detail(us.resources[0], ctx("us-east-1"));

    // F01: park billing (desired 0). Once its task is gone, its empty group is idle: the ALB stays ok and the route
    // edge says "no targets" (while the task drains, the group is still active — the binding rule of status.ts).
    const { invalidate } = await mod("cache.ts");
    await home.updateService("acme-production", "billing", { desired: 0 });
    let parked;
    for (let i = 0; i < 40; i++) {
      invalidate("svc:"); invalidate("discovery:");
      const p = await by.elb.discover(ctx("us-east-1"));
      parked = { health: p.resources[0]?.health, reason: p.resources[0]?.healthReason, labels: p.links.filter((l) => l.to.endsWith("/billing")).map((l) => l.label) };
      if (/idle/.test(parked.reason ?? "")) break;
      await new Promise((r) => setTimeout(r, 500));
    }

    // F17 fail-closed: a cluster that can't be listed may hold the console — no env file is read at all.
    const realServices = home.services;
    home.services = async (c) => { if (c === "acme-production") throw Object.assign(new Error("User is not authorized to perform: ecs:DescribeServices"), { name: "AccessDeniedException" }); return realServices.call(home, c); };
    invalidate("svc:"); invalidate("map:envfile:");
    const closedNotes = [];
    const closed = await by.ecs.discover(ctx("us-east-1", closedNotes));
    const closedOut = { services: closed.resources.length, envFileVias: closed.mentions.filter((m) => m.via.startsWith("env file ")).length, notes: closedNotes };
    home.services = realServices;
    invalidate("svc:");

    // R16: ECS discovery fails (clusters can't be listed) — the load balancer is still there, with a note.
    home.clusters = async () => { throw Object.assign(new Error("User is not authorized to perform: ecs:ListClusters"), { name: "AccessDeniedException" }); };
    invalidate("discovery:");
    const downNotes = [];
    const down = await by.elb.discover(ctx("us-east-1", downNotes));
    return {
      ids, sentinelLeak,
      ecs: { resources: e.resources, links: e.links, vias, secretInMentions },
      elb: { us: us.resources, usLinks: us.links, eu: eu.resources.length, notes },
      rds: { us: rdsUs.resources.map((r) => r.key), eu: rdsEu.resources.map((r) => r.key) },
      declared: dec.resources.map((r) => ({ key: r.key, provider: r.provider })),
      details: { external: await by.ecs.detail(ext, ctx("us-east-1")), rds: await detail(by.rds, pg), cache: await detail(by.elasticache, cacheR), lb: lbD.sections.map((s) => s.title) },
      ecsDown: { keys: down.resources.map((r) => r.key), health: down.resources[0]?.health, notes: downNotes },
      parked, closed: closedOut,
    };
  `);
  // Scopes (delta 3) and declarations.
  assert.deepEqual(
    Object.fromEntries(Object.entries(out.ids).map(([k, v]) => [k, [v.scope, !!v.multiRegionMock]])),
    { ecs: ["home", false], elb: ["regional", true], rds: ["regional", true], elasticache: ["regional", true], declared: ["home", false] },
  );
  assert.deepEqual(out.ids.ecs.sensitive, ["s3:GetObject"]);
  // F17 + sentinel: env-file values were read (mentions) but never reached a resource or a link.
  assert.equal(out.sentinelLeak, false);
  assert.ok(out.ecs.secretInMentions, "the staging env file was read into mentions");
  assert.ok(out.ecs.vias.includes("env file SMTP_PASSWORD"));
  assert.ok(!out.ecs.vias.some((v) => /pass|smtp-fake/i.test(v.replace("SMTP_PASSWORD", ""))));
  // F15: externals come from the declared provider; the ECS one never answers for them.
  assert.ok(out.declared.some((d) => d.key === "external:stripe" && d.provider === "declared"));
  assert.ok(!out.ecs.resources.some((r) => r.kind === "external"));
  assert.deepEqual(out.details.external, { key: "external:users", sections: [] });
  // Regional RDS: eu-west-1 shows its own database; us-east-1 doesn't repeat it.
  // Aurora members are listed by DescribeDBInstances too (the secondary's reader in eu-west-1).
  assert.deepEqual(out.rds.eu, ["rds:acme-production-eu-pg@eu-west-1", "rds:acme-analytics-eu-1@eu-west-1"]);
  assert.ok(out.rds.us.includes("rds:acme-production-pg") && !out.rds.us.some((k) => k.includes("@")));
  // F16: RDS and ElastiCache detail with sections and metric charts.
  assert.ok(out.details.rds.titles.includes("Security groups") && out.details.rds.metrics >= 6, JSON.stringify(out.details.rds));
  assert.ok(out.details.cache.titles.includes("Security groups") && out.details.cache.metrics === 5, JSON.stringify(out.details.cache));
  // The ALB: one in us-east-1, none in eu-west-1; routes to the services behind it; health from its target groups.
  assert.equal(out.elb.eu, 0);
  const alb = out.elb.us.find((r) => r.key === "elb:acme-production");
  assert.ok(alb, JSON.stringify(out.elb.us.map((r) => r.key)));
  assert.equal(alb.health, "ok", `${alb.healthReason}`);
  assert.equal(alb.facts?.public, true);
  assert.ok(out.elb.usLinks.some((l) => l.to === "ecs:service/acme-production/api" && l.kind === "route" && l.label === "api.acme.dev"));
  assert.ok(out.elb.usLinks.some((l) => l.to === "arn:aws:s3:::acme-logs" && l.label === "access logs"));
  assert.deepEqual(out.details.lb.slice(0, 2), ["Listener rules", "Target groups"]);
  // R16: the internal ops ALB has no ECS service behind it; its health comes from its own target, which fails.
  const ops = out.elb.us.find((r) => r.key === "elb:acme-ops-internal");
  assert.ok(ops && ops.health !== "ok" && ops.facts?.public === false, JSON.stringify(ops && [ops.health, ops.healthReason, ops.facts]));
  assert.ok(out.elb.usLinks.some((l) => l.from === "elb:acme-ops-internal" && l.to === "ec2:i-0acmebastion0001" && l.kind === "route"), JSON.stringify(out.elb.usLinks.filter((l) => l.from === "elb:acme-ops-internal")));
  // F72: the rule's hostname is an endpoint of the service behind it.
  const api = out.ecs.resources.find((r) => r.key === "ecs:service/acme-production/api");
  assert.ok(api?.endpoints?.includes("api.acme.dev"));
  // CC-20 and A.3 on the simulated estate (mock-names: api autoscaled, task roles, Cloud Map, worker's EFS volume).
  assert.equal(api?.props.find((p) => p.label === "Autoscaling")?.value, "min 2 · max 6 · target tracking (CPU 60 %)");
  const has = (from: string, to: string, kind: string) => out.ecs.links.some((l) => l.from === from && l.to === to && l.kind === kind);
  assert.ok(has("ecs:service/acme-production/api", "arn:aws:iam::123456789012:role/acme-production-api-task", "assumes"));
  assert.ok(has("arn:aws:servicediscovery:us-east-1:123456789012:service/srv-acme0api000001", "ecs:service/acme-production/api", "route"));
  assert.ok(has("ecs:service/acme-production/worker", "arn:aws:elasticfilesystem:us-east-1:123456789012:file-system/fs-0acme0media000001", "mounts"));
  // F01: the parked service's empty target group keeps the ALB ok, with the reason; its route says "no targets".
  assert.deepEqual(out.parked, { health: "ok", reason: "3/3 active target groups healthy · billing-prod idle (service scaled to 0)", labels: ["billing.acme.dev · no targets"] });
  // F17: with one cluster unread, the others' services are still drawn, but no env file is read (fail closed).
  assert.ok(out.closed.services > 0 && out.closed.envFileVias === 0, JSON.stringify(out.closed));
  assert.ok(out.closed.notes.some((n) => /couldn't tell which are the console's own/.test(n)), JSON.stringify(out.closed.notes));
  // R16: with ECS discovery failing, the load balancer is still listed, and a note says what's missing.
  assert.deepEqual(out.ecsDown.keys, ["elb:acme-production", "elb:acme-ops-internal"]);
  assert.ok(out.ecsDown.notes.some((n) => /ECS services not read/.test(n)), JSON.stringify(out.ecsDown.notes));
});
