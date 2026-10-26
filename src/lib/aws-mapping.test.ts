// The real Cloud source's pure rules (aws-mapping.ts), fed AWS-shaped fixtures for the fictional Acme account, and the
// simulated account (server/mock.ts, no server-only import) that mirrors them: task paging (R13), events (F11), task
// addresses (F18) and digests (F68), posture fields (F16), target health with initial/draining (F01/F58), Application
// Auto Scaling (CC-20), image checks (R24), tagged hosts (R23), ETags and secret versions (R05), client tokens (F31)
// and GitHub compare completeness (R25).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  allPages, appendMetrics, cachesOf, clientToken, clusterTasks, dbOf, decisionsOf, ecrTarget, healthOf, isPreconditionFailed, lbConfigOf, mainContainer, mainHint, mapLimit,
  policyLabel, revisionOf, scalableTargetsOf, securityGroupOf, serviceOf, taggedHostFilters, taggedHostOf, targetHealthOf, taskDefOf, taskOf, versionWithStage,
  type ClusterTasks, type SdkContainerDef, type SdkService, type SdkTask, type TaskReader,
} from "./aws-mapping.ts";
import { periodFor } from "./metric-specs.ts";
import { HttpError } from "./server/errors.ts";
import { mockCi, mockCloud } from "./server/mock.ts";
import type { RawService, RawTaskDef } from "./types.ts";

const ACCT = "123456789012";
const R = "us-east-1";
const CLUSTER = "acme-production";
const tdArn = (family: string, rev: number) => `arn:aws:ecs:${R}:${ACCT}:task-definition/${family}:${rev}`;
const taskArn = (id: string) => `arn:aws:ecs:${R}:${ACCT}:task/${CLUSTER}/${id}`;
const td = (family: string, o: Partial<RawTaskDef> = {}): RawTaskDef => ({
  arn: tdArn(family, 1), family, revision: 1, image: `${ACCT}.dkr.ecr.${R}.amazonaws.com/acme/${family}:v1`, launchTypes: ["FARGATE"], ports: [3000],
  containers: [], main: family, healthcheck: "CMD true", ...o,
});

// ---------- R13: every RUNNING page, one STOPPED page, uneven services ----------

// A cluster with `counts` running tasks per service, listed interleaved the way ListTasks pages them (no order by
// service) except the last service's, which come at the very end; plus `stopped` stopped tasks. Records every call.
function fakeCluster(counts: Record<string, number>, stopped = 0) {
  const running: SdkTask[] = [];
  const left = { ...counts };
  const last = Object.keys(counts).at(-1)!;
  const task = (svc: string, i: number): SdkTask => ({
    taskArn: taskArn(`${svc}-${i}`), group: `service:${svc}`, taskDefinitionArn: tdArn(svc, 1), lastStatus: "RUNNING", desiredStatus: "RUNNING", healthStatus: "HEALTHY",
  });
  for (let i = 0; Object.entries(left).some(([k, n]) => k !== last && n > 0); i++) {
    for (const svc of Object.keys(left)) {
      if (svc === last || left[svc] <= 0) continue;
      left[svc]--;
      running.push(task(svc, i));
    }
  }
  for (let i = 0; i < counts[last]; i++) running.push(task(last, i));
  const stoppedTasks: SdkTask[] = Array.from({ length: stopped }, (_, i) => ({
    taskArn: taskArn(`stopped-${i}`), group: `service:${Object.keys(counts)[i % Object.keys(counts).length]}`, taskDefinitionArn: tdArn("old", 1),
    lastStatus: "STOPPED", desiredStatus: "STOPPED", stoppedAt: new Date(1_000_000 + i), stoppedReason: `stop ${i}`,
  }));
  const calls = { list: [] as string[], describe: [] as number[], taskDef: [] as string[], inFlight: 0, maxInFlight: 0 };
  const byArn = new Map([...running, ...stoppedTasks].map((t) => [t.taskArn!, t]));
  const page = (all: SdkTask[], token?: string) => {
    const at = token ? Number(token) : 0;
    return { taskArns: all.slice(at, at + 100).map((t) => t.taskArn!), nextToken: at + 100 < all.length ? String(at + 100) : undefined };
  };
  const reader: TaskReader = {
    async list(status, token) {
      calls.list.push(`${status}:${token ?? ""}`);
      return page(status === "RUNNING" ? running : stoppedTasks, token);
    },
    async describe(arns) {
      assert.ok(arns.length <= 100, "DescribeTasks takes at most 100 tasks");
      calls.describe.push(arns.length);
      calls.inFlight++;
      calls.maxInFlight = Math.max(calls.maxInFlight, calls.inFlight);
      await new Promise((r) => setTimeout(r, 2));
      calls.inFlight--;
      return arns.map((a) => byArn.get(a)!);
    },
    async taskDef(arn) {
      calls.taskDef.push(arn);
      if (arn.includes("/old:")) throw new Error("ClientException: deleted");
      return td(arn.split("/").pop()!.replace(/:\d+$/, ""), { arn });
    },
  };
  return { reader, calls, running };
}

const svc = (name: string, runningCount: number, o: Partial<SdkService> = {}): SdkService => ({
  serviceName: name, status: "ACTIVE", desiredCount: runningCount, runningCount, pendingCount: 0, launchType: "FARGATE", ...o,
});

test("clusterTasks pages every RUNNING task, keeps one STOPPED page and finds tasks of services on the last page (R13)", async () => {
  // 260 running tasks: "big" fills most pages, "small" has a single task, listed on the third page.
  const { reader, calls } = fakeCluster({ big: 200, mid: 59, small: 1 }, 150);
  const out = await clusterTasks(reader, { concurrency: 4 });
  assert.deepEqual(calls.list.filter((c) => c.startsWith("RUNNING")), ["RUNNING:", "RUNNING:100", "RUNNING:200"]);
  assert.deepEqual(calls.list.filter((c) => c.startsWith("STOPPED")), ["STOPPED:"], "stopped tasks: one page on purpose");
  assert.equal(out.byService.get("big")!.filter((t) => t.desiredStatus === "RUNNING").length, 200);
  assert.equal(out.byService.get("mid")!.filter((t) => t.desiredStatus === "RUNNING").length, 59);
  assert.equal(out.byService.get("small")!.filter((t) => t.desiredStatus === "RUNNING").length, 1);
  assert.equal(out.runningComplete, true);
  assert.equal(out.stoppedComplete, false, "150 stopped tasks: the one page held 100");
  // Newest three stopped per service, after the running ones.
  const small = out.byService.get("small")!;
  assert.equal(small.filter((t) => t.desiredStatus === "STOPPED").length, 3);
  assert.ok(small.slice(1).every((t, i, a) => i === 0 || (a[i - 1].stoppedAt ?? 0) >= (t.stoppedAt ?? 0)));
  // Each task definition once; a stopped task's deleted definition doesn't fail the cluster.
  assert.equal(new Set(calls.taskDef).size, calls.taskDef.length);
  assert.ok(calls.maxInFlight <= 4 && calls.maxInFlight > 1, `describes in parallel, at most 4 (saw ${calls.maxInFlight})`);
  // A service whose tasks were all on later pages is not short of tasks.
  const s = serviceOf(CLUSTER, svc("small", 1), out, null);
  assert.equal(s.tasks.filter((t) => t.lastStatus === "RUNNING").length, 1);
  assert.equal(s.tasksComplete, true);
  assert.equal(s.stoppedComplete, false);
});

test("a deliberate page cap marks only the services it cut short as incomplete", async () => {
  const { reader } = fakeCluster({ big: 200, mid: 59, small: 1 });
  const out = await clusterTasks(reader, { maxRunningPages: 2 });
  assert.equal(out.runningComplete, false);
  const small = serviceOf(CLUSTER, svc("small", 1), out, null);
  assert.equal(small.tasks.length, 0, "small's only task was on the third page");
  assert.equal(small.tasksComplete, false, "it says so instead of looking down");
  const mid = serviceOf(CLUSTER, svc("mid", 59), out, null);
  assert.equal(mid.tasksComplete, mid.tasks.length >= 59);
  assert.equal(serviceOf(CLUSTER, svc("big", 5), out, null).tasksComplete, true, "listed at least as many as DescribeServices counts");
});

test("running and stopped describes share one concurrency budget", async () => {
  // 450 running (5 DescribeTasks) and 100 stopped (1 more): never more than 4 in flight for the cluster.
  const { reader, calls } = fakeCluster({ big: 300, mid: 149, small: 1 }, 100);
  const out = await clusterTasks(reader, { concurrency: 4 });
  assert.deepEqual(calls.describe.sort((a, b) => a - b), [50, 100, 100, 100, 100, 100]);
  assert.equal(calls.maxInFlight, 4, `at most 4 describes at once (saw ${calls.maxInFlight})`);
  assert.equal(out.byService.get("big")!.filter((t) => t.desiredStatus === "RUNNING").length, 300);
  assert.equal(out.byService.get("small")!.filter((t) => t.desiredStatus === "STOPPED").length, 3);
});

test("clusterTasks places each running task on its EC2 instance, reading each container instance once; a failed read only loses placement", async () => {
  const run = (id: string, svc: string, ci?: string): SdkTask => ({
    taskArn: taskArn(id), group: `service:${svc}`, taskDefinitionArn: tdArn(svc, 1), lastStatus: "RUNNING", desiredStatus: "RUNNING", ...(ci ? { containerInstanceArn: ci } : {}),
  });
  const tasks = [run("a1", "api", "ci/one"), run("a2", "api", "ci/two"), run("r1", "redis", "ci/one"), run("w1", "web")]; // web: Fargate
  const reader = (instances: TaskReader["instances"]): TaskReader => ({
    list: async (status) => ({ taskArns: status === "RUNNING" ? tasks.map((t) => t.taskArn!) : [] }),
    describe: async (arns) => tasks.filter((t) => arns.includes(t.taskArn!)),
    taskDef: async (arn) => td(arn.split("/").pop()!.replace(/:\d+$/, ""), { arn }),
    instances,
  });
  const asked: string[][] = [];
  const out = await clusterTasks(reader(async (arns) => (asked.push(arns), new Map([["ci/one", "i-1"], ["ci/two", "i-2"]]))));
  const hosts = (c: ClusterTasks, svc: string) => c.byService.get(svc)!.map((t) => t.host);
  assert.deepEqual(hosts(out, "api"), ["i-1", "i-2"]);
  assert.deepEqual(hosts(out, "redis"), ["i-1"]);
  assert.deepEqual(hosts(out, "web"), [undefined]);
  assert.deepEqual(asked, [["ci/one", "ci/two"]]);
  const denied = await clusterTasks(reader(async () => { throw new Error("AccessDeniedException"); }));
  assert.equal(denied.byService.get("api")!.length, 2, "placement is evidence, never a reason to fail the cluster");
  assert.ok([...denied.byService.values()].flat().every((t) => !t.host));
});

test("mainContainer: an app container before known sidecars, whatever the order or their ports", () => {
  const c = (name: string, image: string, o: Partial<SdkContainerDef> = {}): SdkContainerDef => ({ name, image, essential: true, ...o });
  const port = (p: number) => ({ portMappings: [{ containerPort: p }] });
  const main = (...defs: SdkContainerDef[]) => mainContainer(defs)?.name;
  assert.equal(main(c("datadog-agent", "public.ecr.aws/datadog/agent:7", port(8126)), c("api", "acme/api:v1", port(3000))), "api");
  assert.equal(main(c("envoy", "840364872350.dkr.ecr.us-west-2.amazonaws.com/aws-appmesh-envoy:v1.27", port(9901)), c("web", "acme/web:v1", port(8080))), "web");
  assert.equal(main(c("log_router", "acme/custom-router:v1", { firelensConfiguration: { type: "fluentbit" }, ...port(24224) }), c("worker", "acme/jobs:v1")), "worker", "an app without ports still beats a sidecar");
  assert.equal(main(c("xray", "amazon/aws-xray-daemon", port(2000))), "xray", "a sidecar alone is still the main container");
  assert.equal(main(c("proxy", "envoyproxy/envoy:v1.30", port(443)), c("dd", "gcr.io/datadoghq/agent:7")), "proxy", "plain envoy may be the service itself");
  assert.equal(main(c("migrate", "acme/api:v1", { essential: false }), c("api", "acme/api:v1", port(3000))), "api");
  assert.equal(main(c("otel", "otel/opentelemetry-collector-contrib:0.98.0", port(4317)), c("api", "acme/api:v1", port(3000))), "api");
  // An image in ECR (yours) before an unknown public one, whatever their order and ports.
  const ecr = `${ACCT}.dkr.ecr.${R}.amazonaws.com/acme/api:v1`;
  assert.equal(main(c("vendor-agent", "vendor/some-agent:3", port(9000)), c("api", ecr, port(3000))), "api");
  assert.equal(main(c("vendor-agent", "vendor/some-agent:3", port(9000)), c("worker", ecr)), "worker");
  // The container the service names wins over every rank — even one a rule would call a sidecar.
  const defs = [c("api", ecr, port(3000)), c("proxy", "envoyproxy/envoy:v1.30", port(8080))];
  assert.equal(mainContainer(defs, "proxy")?.name, "proxy");
  assert.equal(mainContainer(defs, "missing")?.name, "api", "a name the definition doesn't have is ignored");
});

test("mainHint: tag console:main, else the load balancer's container, else the service registry's", () => {
  const lb = [{ targetGroupArn: "arn:tg", containerName: "web" }];
  const sr = [{ registryArn: "arn:sr", containerName: "grpc" }];
  assert.equal(mainHint({ tags: [{ key: "console:main", value: " api " }], loadBalancers: lb, serviceRegistries: sr }), "api");
  assert.equal(mainHint({ loadBalancers: lb, serviceRegistries: sr }), "web");
  assert.equal(mainHint({ loadBalancers: [{ targetGroupArn: "arn:tg" }], serviceRegistries: sr }), "grpc");
  assert.equal(mainHint({}), undefined);
  // Only containers the task definition has: a stale tag falls through to the load balancer's.
  const has = (n: string) => n === "web" || n === "grpc";
  assert.equal(mainHint({ tags: [{ key: "console:main", value: "gone" }], loadBalancers: lb, serviceRegistries: sr }, has), "web");
  assert.equal(mainHint({ tags: [{ key: "console:main", value: "gone" }] }, has), undefined);
});

test("taskDefOf takes the service's named container; a task's health check counts any essential container's", () => {
  const sdk = {
    taskDefinitionArn: tdArn("api", 3), family: "api", revision: 3,
    containerDefinitions: [
      { name: "api", image: `${ACCT}.dkr.ecr.${R}.amazonaws.com/acme/api:v3`, essential: true, portMappings: [{ containerPort: 3000 }] },
      { name: "edge", image: "envoyproxy/envoy:v1.30", essential: true, portMappings: [{ containerPort: 8080 }], healthCheck: { command: ["CMD", "true"] } },
    ],
  };
  assert.equal(taskDefOf(sdk).main, "api");
  const named = taskDefOf(sdk, "edge");
  assert.deepEqual([named.main, named.image, named.ports, named.healthcheck], ["edge", "envoyproxy/envoy:v1.30", [8080], "CMD true"]);
  const t: SdkTask = { taskArn: taskArn("h1"), group: "service:api", lastStatus: "RUNNING", desiredStatus: "RUNNING", healthStatus: "UNHEALTHY" };
  assert.equal(taskOf(t, taskDefOf(sdk)).hasHealthcheck, true, "the api has no check of its own, but ECS judges the task by edge's");
});

test("taskOf: the address of running tasks only, digests per container, health and the main container's exit", () => {
  const t: SdkTask = {
    taskArn: taskArn("0a1b"), group: "service:api", taskDefinitionArn: tdArn("api", 1), lastStatus: "RUNNING", desiredStatus: "RUNNING", healthStatus: "HEALTHY",
    startedAt: new Date(5000), cpu: "1024", memory: "2048",
    attachments: [{ type: "ElasticNetworkInterface", details: [{ name: "subnetId", value: "subnet-prod-a" }, { name: "privateIPv4Address", value: "10.20.10.31" }] }],
    containers: [
      { name: "log-router", imageDigest: "sha256:aaa", exitCode: 0 },
      { name: "api", imageDigest: "sha256:bbb", networkInterfaces: [{ privateIpv4Address: "10.20.10.31" }] },
    ],
  };
  const raw = taskOf(t, td("api"));
  assert.equal(raw.id, "0a1b");
  assert.equal(raw.privateIp, "10.20.10.31");
  assert.deepEqual(raw.imageDigests, { "log-router": "sha256:aaa", api: "sha256:bbb" });
  assert.equal(raw.health, "HEALTHY");
  assert.equal(raw.hasHealthcheck, true);
  assert.equal(raw.exitCode, undefined, "the main container (api), not the first one");
  const stopped = taskOf({ ...t, lastStatus: "STOPPED", desiredStatus: "STOPPED", healthStatus: "UNKNOWN" }, td("api"));
  assert.equal(stopped.privateIp, undefined, "a stopped task's ENI names no live endpoint");
  // No ENI attachment: the container's interface; host networking: nothing.
  assert.equal(taskOf({ ...t, attachments: [] }, undefined).privateIp, "10.20.10.31");
  assert.equal(taskOf({ ...t, attachments: [], containers: [{ name: "api" }] }, undefined).privateIp, undefined);
});

test("serviceOf keeps every event, Cloud Map registries, capacity providers, public IPs and Service Connect names", () => {
  const events = Array.from({ length: 100 }, (_, i) => ({ id: `e${i}`, createdAt: new Date(10_000_000 - i * 1000), message: `(service api) event ${i}` }));
  const empty: ClusterTasks = { byService: new Map(), runningComplete: true, stoppedComplete: true };
  const s = serviceOf(CLUSTER, svc("api", 2, {
    launchType: undefined,
    capacityProviderStrategy: [{ capacityProvider: "FARGATE_SPOT", weight: 3 }, { capacityProvider: "FARGATE", base: 1, weight: 1 }],
    networkConfiguration: { awsvpcConfiguration: { subnets: ["subnet-prod-a"], securityGroups: ["sg-prod-api"], assignPublicIp: "ENABLED" } },
    serviceRegistries: [{ registryArn: `arn:aws:servicediscovery:${R}:${ACCT}:service/srv-acme0api000001`, containerName: "api", containerPort: 3000 }],
    deployments: [
      { id: "ecs-svc/1", status: "PRIMARY", taskDefinition: tdArn("api", 2), serviceConnectConfiguration: { enabled: true, services: [{ portName: "http", discoveryName: "api", clientAliases: [{ port: 80, dnsName: "api.acme.internal" }, { port: 81 }] }] } },
      { id: "ecs-svc/0", status: "ACTIVE", taskDefinition: tdArn("api", 1) },
    ],
    loadBalancers: [{ targetGroupArn: `arn:aws:elasticloadbalancing:${R}:${ACCT}:targetgroup/api-prod/1` }],
    deploymentConfiguration: { deploymentCircuitBreaker: { enable: true } },
    tags: [{ key: "console:repo", value: "acme/storefront-api" }],
    events,
  }), empty, td("api"));
  assert.equal(s.events!.length, 100, "no slice (F11)");
  assert.equal(s.events![0].id, "e0");
  assert.equal(s.launchType, "FARGATE", "capacity provider FARGATE_SPOT counts as Fargate");
  assert.deepEqual(s.capacityProviderStrategy, [{ provider: "FARGATE_SPOT", weight: 3 }, { provider: "FARGATE", weight: 1, base: 1 }]);
  assert.equal(s.assignPublicIp, true);
  assert.deepEqual(s.serviceRegistries, [{ registryArn: `arn:aws:servicediscovery:${R}:${ACCT}:service/srv-acme0api000001`, containerName: "api", containerPort: 3000 }]);
  assert.deepEqual(s.serviceConnect, [{ discoveryName: "api", clientAliases: [{ dnsName: "api.acme.internal", port: 80 }] }]);
  assert.equal(s.deploymentController, "ECS", "unset in the API means the ECS controller");
  assert.equal(serviceOf(CLUSTER, svc("legacy", 1, { deploymentController: { type: "CODE_DEPLOY" } }), empty, null).deploymentController, "CODE_DEPLOY");
  assert.deepEqual(s.tags, { "console:repo": "acme/storefront-api" });
  assert.equal(s.circuitBreaker, true);
  const ec2 = serviceOf(CLUSTER, svc("caddy", 1, { launchType: "EC2" }), empty, null);
  assert.equal(ec2.assignPublicIp, undefined, "not an awsvpc service");
  assert.equal(ec2.serviceConnect, undefined);
});

test("taskDefOf maps roles and EFS volumes; revisionOf keeps every container's image (R24)", () => {
  const d = taskDefOf({
    taskDefinitionArn: tdArn("worker", 7), family: "worker", revision: 7, requiresCompatibilities: ["FARGATE"], networkMode: "awsvpc", registeredAt: new Date(42_000),
    taskRoleArn: `arn:aws:iam::${ACCT}:role/acme-production-worker-task`, executionRoleArn: `arn:aws:iam::${ACCT}:role/acme-ecs-task-execution`,
    volumes: [{ name: "media", efsVolumeConfiguration: { fileSystemId: "fs-0acme0media000001", authorizationConfig: { accessPointId: "fsap-0acme0media00001" } } }, { name: "scratch" }],
    containerDefinitions: [
      { name: "worker", image: `${ACCT}.dkr.ecr.${R}.amazonaws.com/acme/jobs:v7`, essential: true, portMappings: [{ containerPort: 8080 }], environment: [{ name: "DATABASE_URL", value: "postgres://app:SENTINEL-pass@db.internal:5432/x" }] },
      { name: "xray", image: "public.ecr.aws/xray/aws-xray-daemon:3", essential: false },
    ],
  });
  assert.equal(d.taskRoleArn, `arn:aws:iam::${ACCT}:role/acme-production-worker-task`);
  assert.equal(d.executionRoleArn, `arn:aws:iam::${ACCT}:role/acme-ecs-task-execution`);
  assert.deepEqual(d.volumes, [{ name: "media", efs: { fileSystemId: "fs-0acme0media000001", accessPointId: "fsap-0acme0media00001" } }, { name: "scratch" }]);
  assert.equal(d.main, "worker");
  assert.equal(d.registeredAt, 42_000);
  assert.ok(!JSON.stringify(d).includes("SENTINEL"), "environment values never leave the mapper");
  assert.deepEqual(revisionOf(d).containers, [
    { name: "worker", image: `${ACCT}.dkr.ecr.${R}.amazonaws.com/acme/jobs:v7`, essential: true },
    { name: "xray", image: "public.ecr.aws/xray/aws-xray-daemon:3", essential: false },
  ]);
});

// ---------- F16: posture ----------

test("dbOf maps the posture DescribeDBInstances reports", () => {
  const db = dbOf({
    DBInstanceIdentifier: "acme-production-pg", DBInstanceStatus: "available", Engine: "postgres", EngineVersion: "17.6", DBInstanceClass: "db.r6g.large",
    AllocatedStorage: 100, MultiAZ: false, Endpoint: { Address: `acme-production-pg.c0example.${R}.rds.amazonaws.com`, Port: 5432 },
    DBSubnetGroup: { DBSubnetGroupName: "acme-production-db", VpcId: "vpc-prod", Subnets: [{ SubnetIdentifier: "subnet-prod-a" }, { SubnetIdentifier: "subnet-prod-b" }] },
    VpcSecurityGroups: [{ VpcSecurityGroupId: "sg-prod-db" }], TagList: [{ Key: "team", Value: "shop" }],
    KmsKeyId: `arn:aws:kms:${R}:${ACCT}:key/mrk-0acme`, PubliclyAccessible: false, StorageEncrypted: true, BackupRetentionPeriod: 7, DeletionProtection: true,
    PreferredBackupWindow: "03:00-03:30", DBParameterGroups: [{ DBParameterGroupName: "acme-postgres17" }], InstanceCreateTime: new Date(1_000),
    CACertificateIdentifier: "rds-ca-rsa2048-g1", CertificateDetails: { CAIdentifier: "rds-ca-rsa2048-g1", ValidTill: new Date(9_000) },
    PreferredMaintenanceWindow: "sun:04:00-sun:04:30", OptionGroupMemberships: [{ OptionGroupName: "default:postgres-17" }],
  });
  assert.deepEqual([db.maintenanceWindow, db.optionGroup, db.subnetGroup], ["sun:04:00-sun:04:30", "default:postgres-17", "acme-production-db"]);
  assert.deepEqual(
    { k: db.kmsKeyId, p: db.publiclyAccessible, s: db.subnetIds, e: db.storageEncrypted, b: db.backupRetentionDays, d: db.deletionProtection, w: db.backupWindow, g: db.parameterGroup, c: db.createdAt, ca: db.caCertificate, till: db.caValidTill },
    { k: `arn:aws:kms:${R}:${ACCT}:key/mrk-0acme`, p: false, s: ["subnet-prod-a", "subnet-prod-b"], e: true, b: 7, d: true, w: "03:00-03:30", g: "acme-postgres17", c: 1_000, ca: "rds-ca-rsa2048-g1", till: 9_000 },
  );
  assert.deepEqual(db.tags, { team: "shop" });
  assert.equal(db.vpcId, "vpc-prod");
  // Absent facts stay absent (no "publiclyAccessible: undefined" in the JSON).
  assert.ok(!("kmsKeyId" in dbOf({ DBInstanceIdentifier: "x" })));
});

test("cachesOf takes a replication group's version, groups and subnet group from its members; standalone clusters too", () => {
  const out = cachesOf(
    [{
      ReplicationGroupId: "acme-production-valkey", ARN: `arn:aws:elasticache:${R}:${ACCT}:replicationgroup:acme-production-valkey`, Status: "available", Engine: "valkey",
      CacheNodeType: "cache.t4g.small", MemberClusters: ["acme-production-valkey-001", "acme-production-valkey-002"], NodeGroups: [{ PrimaryEndpoint: { Address: "master.acme", Port: 6379 } }],
      KmsKeyId: "key-1", TransitEncryptionEnabled: true, AtRestEncryptionEnabled: true, AuthTokenEnabled: false, ReplicationGroupCreateTime: new Date(2_000),
      SnapshotRetentionLimit: 3, SnapshotWindow: "06:00-07:00", AutomaticFailover: "enabled", MultiAZ: "enabled",
    }],
    [
      {
        CacheClusterId: "acme-production-valkey-001", ReplicationGroupId: "acme-production-valkey", EngineVersion: "8.0.1", SecurityGroups: [{ SecurityGroupId: "sg-prod-valkey" }],
        CacheSubnetGroupName: "acme-production-cache", PreferredMaintenanceWindow: "sun:07:00-sun:08:00", CacheParameterGroup: { CacheParameterGroupName: "default.valkey8" },
      },
      { CacheClusterId: "acme-production-valkey-002", ReplicationGroupId: "acme-production-valkey", EngineVersion: "8.0.1", SecurityGroups: [{ SecurityGroupId: "sg-prod-valkey" }] },
      { CacheClusterId: "acme-sessions", Engine: "memcached", EngineVersion: "1.6.22", NumCacheNodes: 2, CacheClusterStatus: "available", ConfigurationEndpoint: { Address: "acme-sessions.cfg", Port: 11211 }, ARN: "arn:mc", CacheClusterCreateTime: new Date(3_000) },
    ],
  );
  assert.equal(out.length, 2);
  const [g, mc] = out;
  assert.deepEqual(
    { v: g.engineVersion, sg: g.securityGroups, m: g.memberClusters, n: g.nodes, sub: g.subnetGroup, t: g.transitEncryption, a: g.atRestEncryption, auth: g.authToken, c: g.createdAt, arn: g.arn, ep: g.endpoint },
    { v: "8.0.1", sg: ["sg-prod-valkey"], m: ["acme-production-valkey-001", "acme-production-valkey-002"], n: 2, sub: "acme-production-cache", t: true, a: true, auth: false, c: 2_000, arn: `arn:aws:elasticache:${R}:${ACCT}:replicationgroup:acme-production-valkey`, ep: "master.acme" },
  );
  assert.deepEqual(
    { s: g.snapshotRetentionDays, w: g.snapshotWindow, m: g.maintenanceWindow, p: g.parameterGroup, f: g.automaticFailover, az: g.multiAz },
    { s: 3, w: "06:00-07:00", m: "sun:07:00-sun:08:00", p: "default.valkey8", f: "enabled", az: true },
  );
  assert.deepEqual({ id: mc.id, e: mc.engine, v: mc.engineVersion, n: mc.nodes, ep: mc.endpoint, c: mc.createdAt }, { id: "acme-sessions", e: "memcached", v: "1.6.22", n: 2, ep: "acme-sessions.cfg", c: 3_000 });
});

test("securityGroupOf keeps CIDRs (v4 and v6), prefix lists and a description", () => {
  const g = securityGroupOf({
    GroupId: "sg-stg-db", GroupName: "staging-db", VpcId: "vpc-stg",
    IpPermissions: [
      { FromPort: 5432, ToPort: 5432, UserIdGroupPairs: [{ GroupId: "sg-stg-box" }], IpRanges: [{ CidrIp: "0.0.0.0/0", Description: "temporary" }], Ipv6Ranges: [{ CidrIpv6: "::/0" }] },
      { FromPort: 443, ToPort: 443, PrefixListIds: [{ PrefixListId: "pl-0acme" }] },
    ],
  });
  assert.deepEqual(g.inbound, [
    { fromPort: 5432, toPort: 5432, groups: ["sg-stg-box"], cidrs: ["0.0.0.0/0", "::/0"], description: "temporary" },
    { fromPort: 443, toPort: 443, groups: [], prefixLists: ["pl-0acme"] },
  ]);
});

// ---------- F01/F58: target health and the load balancer split ----------

test("target health counts registering and draining targets apart; unused targets are unhealthy", () => {
  const h = targetHealthOf("arn:tg/api", [
    { Target: { Id: "10.20.10.1", Port: 3000 }, TargetHealth: { State: "healthy" } },
    { Target: { Id: "10.20.10.2", Port: 3000 }, TargetHealth: { State: "initial", Reason: "Elb.RegistrationInProgress" } },
    { Target: { Id: "10.20.10.3", Port: 3000 }, TargetHealth: { State: "draining", Reason: "Target.DeregistrationInProgress" } },
    { Target: { Id: "10.20.10.4", Port: 3000 }, TargetHealth: { State: "unhealthy", Reason: "Target.FailedHealthChecks", Description: "Health checks failed" } },
    { Target: { Id: "10.20.10.5", Port: 3000 }, TargetHealth: { State: "unused", Reason: "Target.NotInUse" } },
    { Target: { Id: "10.20.10.6", Port: 3000 }, TargetHealth: { State: "unhealthy", Reason: "Target.FailedHealthChecks" } },
  ]);
  assert.deepEqual({ h: h.healthy, u: h.unhealthy, i: h.initial, d: h.draining }, { h: 1, u: 3, i: 1, d: 1 });
  assert.deepEqual(h.reasons, ["Target.FailedHealthChecks", "Target.NotInUse"], "the unhealthy ones' reasons, once each");
  assert.equal(h.targets.length, 6);
  assert.deepEqual(healthOf("arn:tg/empty", []), { targetGroupArn: "arn:tg/empty", healthy: 0, unhealthy: 0, initial: 0, draining: 0, reasons: [], targets: [] });
});

test("lbConfigOf has no health: listeners, rules and target groups only (F58)", () => {
  const cfg = lbConfigOf(
    { LoadBalancerArn: "arn:lb", LoadBalancerName: "acme-production", DNSName: "acme.elb", Scheme: "internet-facing", Type: "application", State: { Code: "active" }, AvailabilityZones: [{ ZoneName: `${R}a` }] },
    [
      { port: 80, protocol: "HTTP", rules: [{ Priority: "default", Actions: [{ Type: "redirect" }] }] },
      { port: 443, protocol: "HTTPS", rules: [
        { Priority: "10", Conditions: [{ Field: "host-header", HostHeaderConfig: { Values: ["api.acme.dev"] } }], Actions: [{ Type: "forward", ForwardConfig: { TargetGroups: [{ TargetGroupArn: "arn:tg/api" }] } }] },
        { Priority: "20", Conditions: [{ Field: "path-pattern", Values: ["/admin/*"] }], Actions: [{ Type: "authenticate-oidc" }, { Type: "forward", TargetGroupArn: "arn:tg/console" }] },
      ] },
    ],
    [{ TargetGroupArn: "arn:tg/api", TargetGroupName: "api-prod", Port: 3000, Protocol: "HTTP", HealthCheckPath: "/ready", Matcher: { HttpCode: "200" } }, { TargetGroupArn: "arn:tg/console", TargetGroupName: "console" }],
  );
  assert.deepEqual(cfg.listeners.map((l) => l.port), [443, 80]);
  assert.deepEqual(cfg.listeners[0].rules.map((r) => [r.priority, r.hosts, r.paths, r.action, r.targetGroupArn]), [
    ["10", ["api.acme.dev"], [], "forward", "arn:tg/api"],
    ["20", [], ["/admin/*"], "authenticate-oidc+forward", "arn:tg/console"],
  ]);
  assert.ok(cfg.targetGroups.every((g) => !("targets" in g)));
  assert.deepEqual(cfg.targetGroups.map((g) => g.name), ["api-prod", "console"]);
  assert.equal(cfg.targetGroups[0].healthPath, "/ready");
});

// ---------- CC-20 ----------

test("scalable targets: this cluster's desired-count targets with policy labels", () => {
  const targets = [
    { ResourceId: "service/acme-production/api", ScalableDimension: "ecs:service:DesiredCount", MinCapacity: 2, MaxCapacity: 6 },
    { ResourceId: "service/acme-production-eu/api", ScalableDimension: "ecs:service:DesiredCount", MinCapacity: 1, MaxCapacity: 2 },
    { ResourceId: "service/acme-production/worker", ScalableDimension: "ecs:service:DesiredCount", MinCapacity: 1, MaxCapacity: 3 },
  ];
  const policies = [
    { PolicyName: "acme-api-cpu-target", PolicyType: "TargetTrackingScaling", ResourceId: "service/acme-production/api", TargetTrackingScalingPolicyConfiguration: { TargetValue: 60, PredefinedMetricSpecification: { PredefinedMetricType: "ECSServiceAverageCPUUtilization" } } },
    { PolicyName: "acme-api-burst", PolicyType: "StepScaling", ResourceId: "service/acme-production/api" },
    { PolicyName: "acme-worker-queue", PolicyType: "TargetTrackingScaling", ResourceId: "service/acme-production/worker", TargetTrackingScalingPolicyConfiguration: { TargetValue: 100, CustomizedMetricSpecification: { MetricName: "ApproximateNumberOfMessagesVisible" } } },
  ];
  assert.deepEqual(scalableTargetsOf("acme-production", targets, policies), [
    { service: "api", min: 2, max: 6, policies: ["step scaling (acme-api-burst)", "target tracking (CPU 60 %)"] },
    { service: "worker", min: 1, max: 3, policies: ["target tracking (ApproximateNumberOfMessagesVisible 100)"] },
  ]);
  assert.equal(policyLabel({ PolicyType: "TargetTrackingScaling", TargetTrackingScalingPolicyConfiguration: { TargetValue: 1000, PredefinedMetricSpecification: { PredefinedMetricType: "ALBRequestCountPerTarget" } } }), "target tracking (requests per target 1000)");
  assert.equal(policyLabel({ PolicyType: "PredictiveScaling", PolicyName: "p" }), "predictive scaling (p)");
});

// ---------- small rules ----------

test("metric pages append to the same series; IAM decisions keep only known values", () => {
  const out: Record<string, [number, number][]> = {};
  const status = new Map<string, string>();
  appendMetrics(out, status, [{ Id: "rps", Timestamps: [new Date(0), new Date(60_000)], Values: [1, 2], StatusCode: "PartialData" }]);
  appendMetrics(out, status, [{ Id: "rps", Timestamps: [new Date(120_000)], Values: [3], StatusCode: "Complete" }]);
  assert.deepEqual(out.rps, [[0, 1], [60_000, 2], [120_000, 3]]);
  assert.equal(status.get("rps"), "Complete");
  assert.deepEqual(decisionsOf([{ EvalActionName: "ecs:UpdateService", EvalDecision: "allowed" }, { EvalActionName: "ec2:RunInstances", EvalDecision: "explicitDeny" }, { EvalActionName: "x:Y", EvalDecision: "maybe" }]), {
    "ecs:UpdateService": "allowed", "ec2:RunInstances": "explicitDeny",
  });
  // Against a real resource an implicit deny that needed no context is final; one that missed context stays implicit.
  const onResource = [
    { EvalActionName: "ecs:UpdateService", EvalDecision: "implicitDeny" },
    { EvalActionName: "ecs:RunTask", EvalDecision: "implicitDeny", MissingContextValues: ["aws:RequestTag/console:created"] },
    { EvalActionName: "ecs:DeleteService", EvalDecision: "allowed" },
  ];
  assert.deepEqual(decisionsOf(onResource, true), { "ecs:UpdateService": "resourceDeny", "ecs:RunTask": "implicitDeny", "ecs:DeleteService": "allowed" });
  assert.deepEqual(decisionsOf(onResource), { "ecs:UpdateService": "implicitDeny", "ecs:RunTask": "implicitDeny", "ecs:DeleteService": "allowed" }, "against * it stays a probably");
  // A function, queue or topic can carry a policy of its own that grants what the console's policy doesn't.
  const policied = [{ EvalActionName: "lambda:InvokeFunction", EvalDecision: "implicitDeny" }, { EvalActionName: "ec2:StopInstances", EvalDecision: "implicitDeny" }];
  assert.deepEqual(decisionsOf(policied, true), { "lambda:InvokeFunction": "implicitDeny", "ec2:StopInstances": "resourceDeny" });
});

test("ecrTarget: a bare name is this account's ECR; a registry says which account and region; anything else is null", () => {
  assert.deepEqual(ecrTarget("acme/storefront-api", R), { repositoryName: "acme/storefront-api", region: R });
  assert.deepEqual(ecrTarget(`${ACCT}.dkr.ecr.eu-west-1.amazonaws.com/acme/storefront-api:production-1a2b3c4`, R), {
    repositoryName: "acme/storefront-api", registryId: ACCT, region: "eu-west-1", tag: "production-1a2b3c4",
  });
  assert.deepEqual(ecrTarget(`210987654321.dkr.ecr.${R}.amazonaws.com/base@sha256:abc`, R), { repositoryName: "base", registryId: "210987654321", region: R, digest: "sha256:abc" });
  assert.equal(ecrTarget("docker.io/library/redis:7-alpine", R), null);
  assert.equal(ecrTarget("ghcr.io/acme/tool:1", R), null);
  assert.equal(ecrTarget("localhost:5000/x", R), null);
});

test("client tokens fit the 64-character limit and stay distinct and stable", () => {
  assert.equal(clientToken("op_0123456789abcdef"), "op_0123456789abcdef");
  const long = `op_${"x".repeat(80)}`;
  const t = clientToken(long);
  assert.equal(t.length, 64);
  assert.equal(clientToken(long), t);
  assert.notEqual(clientToken(`${long}y`), t);
  assert.equal(clientToken("a b"), "a-b");
});

test("precondition failures, secret versions, tagged-host filters", () => {
  assert.ok(isPreconditionFailed({ name: "PreconditionFailed" }));
  assert.ok(isPreconditionFailed({ name: "Unknown", $metadata: { httpStatusCode: 412 } }));
  assert.ok(isPreconditionFailed({ name: "ConditionalRequestConflict" }));
  assert.ok(!isPreconditionFailed({ name: "AccessDenied", $metadata: { httpStatusCode: 403 } }));
  assert.equal(versionWithStage({ "v-old": ["AWSPREVIOUS"], "v-new": ["AWSCURRENT", "AWSPENDING"] }), "v-new");
  assert.equal(versionWithStage({ "v-old": ["AWSPREVIOUS"] }, "AWSCURRENT"), undefined);
  assert.deepEqual(taggedHostFilters("acme-staging").map((f) => f.Name), ["tag:console:created", "tag:console:cluster", "instance-state-name"]);
  assert.deepEqual(taggedHostOf({ InstanceId: "i-1", State: { Name: "pending" }, LaunchTime: new Date(7) }), { id: "i-1", state: "pending", launchedAt: 7 });
});

test("mapLimit keeps order, bounds concurrency and starts nothing after a failure; allPages honours a cap", async () => {
  let inFlight = 0;
  let peak = 0;
  const out = await mapLimit([5, 1, 4, 2, 3], 2, async (n) => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, n));
    inFlight--;
    return n * 10;
  });
  assert.deepEqual(out, [50, 10, 40, 20, 30]);
  assert.equal(peak, 2);
  const started: number[] = [];
  await assert.rejects(mapLimit([1, 2, 3, 4, 5, 6], 1, async (n) => {
    started.push(n);
    if (n === 2) throw new Error("boom");
  }), /boom/);
  assert.deepEqual(started, [1, 2]);
  const pages = await allPages(async (t) => ({ items: [Number(t ?? 0)], next: String(Number(t ?? 0) + 1) }), 3);
  assert.deepEqual(pages, { items: [0, 1, 2], complete: false });
});

// ---------- the simulated account mirrors all of it ----------

test("mock: tasks carry addresses and digests, services their events, roles, registry and scaling (us-east-1)", async () => {
  const c = mockCloud(R);
  const svcs = (await c.services("acme-production")) as RawService[];
  const api = svcs.find((s) => s.name === "api")!;
  assert.equal(api.desired, 2, "Application Auto Scaling keeps it at 2 or more");
  const running = api.tasks.filter((t) => t.lastStatus === "RUNNING");
  assert.ok(running.length >= 1 && running.every((t) => /^10\.20\.\d+\.\d+$/.test(t.privateIp ?? "")));
  assert.ok(api.tasks.filter((t) => t.lastStatus === "STOPPED").every((t) => t.privateIp === undefined));
  assert.ok(running.every((t) => t.imageDigests?.api?.startsWith("sha256:")));
  assert.deepEqual(api.events, await c.events("acme-production", "api"), "services() carries what events() returns");
  assert.ok(api.taskDef?.taskRoleArn?.endsWith(":role/acme-production-api-task") && api.taskDef.executionRoleArn);
  assert.ok(api.serviceRegistries?.[0]?.registryArn.includes(":servicediscovery:"));
  assert.equal(api.assignPublicIp, false);
  assert.equal(api.tasksComplete, true);
  const worker = svcs.find((s) => s.name === "worker")!;
  assert.deepEqual(worker.taskDef?.volumes, [{ name: "media", efs: { fileSystemId: "fs-0acme0media000001", accessPointId: "fsap-0acme0media00001" } }]);
  assert.deepEqual(await c.scalableTargets("acme-production"), [{ service: "api", min: 2, max: 6, policies: ["target tracking (CPU 60 %)"] }]);
  assert.deepEqual(await c.scalableTargets("acme-staging"), []);
  // The load balancer in front of the services lists their target groups; targets sit at the tasks' addresses.
  const tgs = svcs.flatMap((s) => s.targetGroupArns);
  const health = await c.targetHealth(tgs);
  const lbArn = (await c.targetGroupLbs(api.targetGroupArns))[api.targetGroupArns[0]];
  const cfg = await c.lbConfig(lbArn);
  assert.ok(tgs.every((a) => cfg.targetGroups.some((g) => g.arn === a)));
  const apiHealth = health.find((h) => h.targetGroupArn === api.targetGroupArns[0])!;
  assert.equal(apiHealth.healthy + apiHealth.unhealthy + (apiHealth.initial ?? 0) + (apiHealth.draining ?? 0), apiHealth.targets.length);
  assert.deepEqual(apiHealth.targets.map((t) => t.id).sort(), running.map((t) => t.privateIp).sort());
  await assert.rejects(c.lbConfig("arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/nope/1"), /LoadBalancerNotFound/);
  await assert.rejects(c.targetHealth(["arn:nope"]), /TargetGroupNotFound/);
  // Posture: the exposed staging database.
  const dbs = await c.databases();
  assert.deepEqual(dbs.map((d) => [d.id, d.publiclyAccessible, d.aurora]), [
    ["acme-staging-pg", true, undefined], ["acme-production-pg", false, undefined], ["acme-analytics-1", false, "acme-analytics"], ["acme-analytics-2", false, "acme-analytics"],
  ]);
  assert.equal(dbs[1].storageEncrypted, true);
  assert.equal((await c.securityGroups(["sg-stg-db"]))[0].inbound.some((r) => r.cidrs?.includes("0.0.0.0/0")), true);
  const [valkey] = await c.caches();
  assert.deepEqual([valkey.memberClusters, valkey.transitEncryption], [["acme-production-valkey-001"], true]);
  const sim = await c.simulate!(["ecs:UpdateService", "ec2:RunInstances"]);
  assert.deepEqual(sim, { "ecs:UpdateService": "allowed", "ec2:RunInstances": "allowed" });
  assert.match((await c.principal!()) ?? "", /^arn:aws:iam::123456789012:role\//);
});

test("mock: revisions list containers; imageExists finds live images, misses expired ones, and can't check Docker Hub (R24/F68)", async () => {
  const c = mockCloud(R);
  const api = (await c.services("acme-production")).find((s) => s.name === "api")!;
  const revs = await c.revisions(api.taskDef!.family);
  assert.ok(revs.every((r) => r.containers?.length === 1 && r.containers[0].image === r.image));
  const live = revs.find((r) => r.arn === api.taskDef!.arn)!;
  const [repo, tag] = [live.image.slice(0, live.image.lastIndexOf(":")), live.image.slice(live.image.lastIndexOf(":") + 1)];
  const found = await c.imageExists(repo, { tag });
  assert.equal(found?.exists, true);
  assert.equal(found?.digest, api.tasks[0].imageDigests?.api, "the tag points where the running task's digest says");
  assert.deepEqual(await c.imageExists(repo, { digest: found!.digest }), found);
  assert.equal((await c.imageExists("acme/storefront-api", { tag }))?.exists, true, "a bare name is this account's ECR");
  // One staging api revision's image has expired (the demo's disabled rollback).
  const stg = (await c.services("acme-staging")).find((s) => s.name === "api")!;
  const stgRevs = await c.revisions(stg.taskDef!.family);
  const results = await Promise.all(stgRevs.map((r) => c.imageExists(r.image.slice(0, r.image.lastIndexOf(":")), { tag: r.image.slice(r.image.lastIndexOf(":") + 1) })));
  assert.equal(results.filter((x) => x?.exists === false).length, 1);
  assert.equal(await c.imageExists("docker.io/library/caddy", { tag: "2-alpine" }), null);
  assert.deepEqual(await c.imageExists("acme/nope", { tag: "v1" }), { exists: false });
});

test("mock: eu-west-1 answers every method for its own estate", async () => {
  const c = mockCloud("eu-west-1");
  const svcs = await c.services("acme-production");
  assert.deepEqual(svcs.map((s) => [s.name, s.desired]), [["api", 2], ["worker", 1]]);
  assert.ok(svcs.flatMap((s) => s.tasks).filter((t) => t.lastStatus === "RUNNING").every((t) => t.privateIp?.startsWith("10.40.")));
  assert.ok(svcs.every((s) => s.taskDef?.image.includes(".dkr.ecr.eu-west-1.amazonaws.com/") && !s.taskDef.taskRoleArn));
  const revs = await c.revisions(svcs[0].taskDef!.family);
  assert.equal((await c.imageExists(revs[0].image.slice(0, revs[0].image.lastIndexOf(":")), { tag: revs[0].image.split(":").pop() }))?.exists, true);
  const [db] = await c.databases();
  assert.deepEqual([db.id, db.publiclyAccessible, db.kmsKeyId?.includes(":eu-west-1:")], ["acme-production-eu-pg", false, true]);
  assert.deepEqual(await c.caches(), []);
  assert.deepEqual(await c.scalableTargets("acme-production"), []);
  assert.deepEqual(await c.taggedHosts("acme-production"), []);
  assert.deepEqual(await c.hosts("acme-production"), []);
  await assert.rejects(c.lbConfig("arn:aws:elasticloadbalancing:eu-west-1:123456789012:loadbalancer/app/acme-production/1"), /LoadBalancerNotFound/);
  assert.ok((await c.events("acme-production", "api")).length > 0);
  const env = await c.containerEnv(svcs[0].taskDef!.arn);
  const ref = env[0].secrets[0].valueFrom;
  assert.equal(await c.secretVersion(ref), "1");
});

test("mock: launched hosts are tagged for their cluster and join it 90 s later; a client token launches once (R23, F31)", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const c = mockCloud(R);
  const box = (await c.hosts("acme-staging"))[0];
  const before = (await c.hosts("acme-staging")).length;
  const first = await c.launchHosts(box.id, { count: 2, tags: { "console:created": "true", Name: "acme-staging-extra" }, cluster: "acme-staging", clientToken: "op-host-1" });
  const again = await c.launchHosts(box.id, { count: 2, tags: { "console:created": "true", Name: "acme-staging-extra" }, cluster: "acme-staging", clientToken: "op-host-1" });
  assert.deepEqual(again.instanceIds, first.instanceIds, "same token, same instances");
  // As on AWS, a launch that doesn't name its cluster isn't tagged for it, so taggedHosts can't see it while it boots.
  const untagged = await c.launchHosts(box.id, { count: 1, tags: { "console:created": "true", Name: "acme-staging-extra" } });
  const tagged = await c.taggedHosts("acme-staging");
  assert.deepEqual(tagged.map((h) => h.id).sort(), [...first.instanceIds].sort());
  assert.ok(!tagged.some((h) => untagged.instanceIds.includes(h.id)));
  await c.terminateHost(untagged.instanceIds[0]);
  assert.ok(tagged.every((h) => h.state === "pending"));
  assert.equal((await c.hosts("acme-staging")).length, before, "not registered with ECS yet");
  t.mock.timers.tick(30_000);
  assert.ok((await c.taggedHosts("acme-staging")).every((h) => h.state === "running"));
  assert.equal((await c.hosts("acme-staging")).length, before, "running, still booting the ECS agent");
  t.mock.timers.tick(61_000);
  const joined = await c.hosts("acme-staging");
  assert.equal(joined.length, before + 2);
  assert.ok(joined.filter((h) => first.instanceIds.includes(h.id)).every((h) => h.tags["console:cluster"] === "acme-staging"));
  for (const id of first.instanceIds) await c.terminateHost(id);
  assert.deepEqual(await c.taggedHosts("acme-staging"), [], "shutting down is neither pending nor running");
  // A one-off task with a client token runs once.
  const stg = (await c.services("acme-staging")).find((s) => s.name === "worker")!;
  const spec = { cluster: "acme-staging", service: "worker", taskDefinition: stg.taskDef!.arn, capacityProviderStrategy: [], placementConstraints: [], placementStrategy: [], tags: {}, clientToken: "op-task-1" };
  const r1 = await c.runTask(spec);
  const r2 = await c.runTask(spec);
  assert.equal(r2.taskArn, r1.taskArn);
});

test("mock: env files carry ETags and refuse a stale write; secrets carry versions and refuse a stale write (R05)", async () => {
  const c = mockCloud(R);
  const stg = (await c.services("acme-staging")).find((s) => s.name === "api")!;
  const [env] = await c.containerEnv(stg.taskDef!.arn);
  const file = env.files[0];
  const a = await c.readEnvFile(file);
  assert.match(a.etag ?? "", /^"[0-9a-f]{32}"$/);
  const w = await c.writeEnvFile(file, `${a.text}A=1\n`, { ifMatch: a.etag });
  assert.notEqual(w.etag, a.etag);
  // A second editor who read before that write loses, with a 409, and the file keeps the first change.
  await assert.rejects(c.writeEnvFile(file, `${a.text}B=2\n`, { ifMatch: a.etag }), (e: unknown) => e instanceof HttpError && e.status === 409 && /env file changed since it was read/.test(e.message));
  const b = await c.readEnvFile(file);
  assert.ok(b.text.includes("A=1") && !b.text.includes("B=2"));
  assert.equal(b.etag, w.etag);

  const prod = (await c.services("acme-production")).find((s) => s.name === "billing")!;
  const [penv] = await c.containerEnv(prod.taskDef!.arn);
  const ssm = penv.secrets.find((x) => x.valueFrom.includes(":ssm:"))!.valueFrom;
  const sm = penv.secrets.find((x) => x.valueFrom.includes(":secretsmanager:"))!.valueFrom;
  const v1 = await c.secretVersion(ssm);
  assert.equal(v1, "1");
  assert.deepEqual(await c.writeSecret(ssm, "jwt-new", { ifVersion: v1 }), { version: "2" });
  await assert.rejects(c.writeSecret(ssm, "jwt-other", { ifVersion: v1 }), (e: unknown) => e instanceof HttpError && e.status === 409 && /secret changed since it was read/.test(e.message));
  // A JSON key: the version is the whole document's, so editing one key moves it for every key.
  const s1 = await c.secretVersion(sm);
  assert.match(s1 ?? "", /^[0-9a-f-]{36}$/);
  const after = await c.writeSecret(sm, "sk_new", { ifVersion: s1 });
  assert.equal(await c.secretVersion(sm), after.version);
  assert.notEqual(after.version, s1);
  await assert.rejects(c.writeSecret(sm.replace(/stripe_key::$/, "webhook_secret::"), "whsec_new", { ifVersion: s1 }), /secret changed since it was read/);
  assert.equal(await c.readSecret(sm), "sk_new");
  await assert.rejects(c.writeSecret(`${sm.replace(/::$/, "")}:AWSPREVIOUS:`, "x"), /pins a secret version/);
});

test("mock: metrics use CloudWatch's period for the window (F03)", async () => {
  const c = mockCloud(R);
  for (const minutes of [60, 360, 7 * 1440]) {
    const out = await c.metrics([{ id: "cpu", namespace: "AWS/ECS", metric: "CPUUtilization", dims: { ClusterName: "acme-production", ServiceName: "api" }, stat: "Average" }], minutes);
    const pts = out.cpu;
    assert.equal(pts[1][0] - pts[0][0], periodFor(minutes) * 1000);
    assert.ok(pts.length <= minutes / (periodFor(minutes) / 60) + 2, `${minutes} min → ${pts.length} points`);
  }
});

test("mock CI: a compare across the bulk change is truncated at 300 files and listDir finds the migration it hides (R25)", async () => {
  const ci = mockCi();
  const repo = "acme/storefront-api";
  const runs = await ci.runs(repo, "main", 200);
  const shas = [...new Set(runs.map((r) => r.sha))];
  // Oldest and newest pushes on main: the range spans the bulk change.
  const newest = shas[0];
  const oldest = shas[shas.length - 1];
  const cmp = (await ci.compare(repo, oldest, newest))!;
  assert.equal(cmp.complete, false);
  assert.equal(cmp.files.length, 300);
  const [base, head] = await Promise.all([ci.listDir!(repo, "prisma/migrations/", oldest), ci.listDir!(repo, "prisma/migrations", newest)]);
  assert.ok(base && head);
  const added = head.filter((e) => !base.some((x) => x.name === e.name)).map((e) => e.name);
  assert.ok(added.length >= 1, "the migration in the bulk change shows up in the directory listing");
  assert.ok(added.some((name) => !cmp.files.includes(`prisma/migrations/${name}/migration.sql`)), "…though the truncated file list doesn't name it");
  // A short range is complete.
  const short = (await ci.compare(repo, shas[1], shas[0]))!;
  assert.equal(short.complete, true);
  assert.ok(short.files.length < 300);
  assert.equal(await ci.listDir!(repo, "src/", newest), null);
  assert.equal(await ci.listDir!("acme/jobs", "prisma/migrations/", "main"), null, "no migrations in that repo");
  assert.equal(await ci.listDir!(repo, "prisma/migrations/", "0".repeat(40)), null);
});

// ---------- aws.ts itself, through the real SDK, against a fake AWS on loopback ----------

// aws.ts imports "server-only" (through the SDK-call limiter), so it runs in a child process with the react-server
// condition, pointed at this process's fake endpoint (AWS_ENDPOINT_URL) with dummy credentials. The fake answers just
// enough of each protocol (JSON 1.1 for ECS, ECR, SSM and Application Auto Scaling; query/XML for STS, IAM and ELB).
test("aws.ts: a write is sent once and a reset after sending is outcome unknown; reads retry; new reads parse (F31, F06, F58, CC-20, R05, R24)", async () => {
  const { createServer } = await import("node:http");
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const seen: string[] = [];
  const bodies = new Map<string, string[]>();
  const xml = (op: string, inner: string, ns: string) => `<${op}Response xmlns="${ns}"><${op}Result>${inner}</${op}Result><ResponseMetadata><RequestId>r-1</RequestId></ResponseMetadata></${op}Response>`;
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const target = String(req.headers["x-amz-target"] ?? "");
      const op = target ? target.split(".").pop()! : (new URLSearchParams(body).get("Action") ?? "");
      seen.push(op);
      bodies.set(op, [...(bodies.get(op) ?? []), body]);
      const json = (status: number, o: unknown) => {
        res.writeHead(status, { "content-type": "application/x-amz-json-1.1" });
        res.end(JSON.stringify(o));
      };
      const send = (status: number, s: string) => {
        res.writeHead(status, { "content-type": "text/xml" });
        res.end(s);
      };
      switch (op) {
        case "UpdateService":
        case "DescribeServices":
          req.socket.destroy(); // the request arrived; the answer never does
          return;
        case "RunTask":
          return json(200, { tasks: [{ taskArn: `arn:aws:ecs:${R}:${ACCT}:task/acme-staging/0a1b2c` }], failures: [] });
        case "ListServices":
          return json(200, { serviceArns: [`arn:aws:ecs:${R}:${ACCT}:service/acme-production/api`, `arn:aws:ecs:${R}:${ACCT}:service/acme-production/worker`] });
        case "ListTaskDefinitions": {
          // DESC lists "api-worker" (a longer family with the same prefix) before "api": api's revisions are on page 2.
          const tdA = (fam: string, n: number) => `arn:aws:ecs:${R}:${ACCT}:task-definition/${fam}:${n}`;
          return JSON.parse(body).nextToken
            ? json(200, { taskDefinitionArns: [tdA("api-worker", 3), tdA("api-worker", 2), tdA("api", 7), tdA("api", 6)] })
            : json(200, { taskDefinitionArns: Array.from({ length: 100 }, (_, i) => tdA("api-worker", 200 - i)), nextToken: "page-2" });
        }
        case "DescribeTaskDefinition": {
          const arn = JSON.parse(body).taskDefinition as string;
          const [family, rev] = arn.split("/").pop()!.split(":");
          return json(200, { taskDefinition: { taskDefinitionArn: arn, family, revision: Number(rev), containerDefinitions: [{ name: family, image: `${ACCT}.dkr.ecr.${R}.amazonaws.com/acme/${family}:r${rev}`, essential: true }] } });
        }
        case "DescribeScalableTargets":
          return json(200, { ScalableTargets: [{ ServiceNamespace: "ecs", ResourceId: "service/acme-production/api", ScalableDimension: "ecs:service:DesiredCount", MinCapacity: 2, MaxCapacity: 6, RoleARN: "arn:role", CreationTime: 1_700_000_000 }] });
        case "DescribeScalingPolicies":
          return json(200, { ScalingPolicies: [{ PolicyARN: "arn:p", PolicyName: "acme-api-cpu-target", ServiceNamespace: "ecs", ResourceId: "service/acme-production/api", ScalableDimension: "ecs:service:DesiredCount", PolicyType: "TargetTrackingScaling", CreationTime: 1_700_000_000, TargetTrackingScalingPolicyConfiguration: { TargetValue: 60, PredefinedMetricSpecification: { PredefinedMetricType: "ECSServiceAverageCPUUtilization" } } }] });
        case "DescribeImages":
          return json(400, { __type: "ImageNotFoundException", message: "The image with imageId {imageTag:'gone'} does not exist" });
        case "DescribeParameters":
          return json(200, { Parameters: [{ Name: "/acme/production/api/JWT_SIGNING_KEY", Type: "SecureString", Version: 3, Tier: "Standard", KeyId: "alias/aws/ssm" }] });
        case "PutParameter":
          return json(200, { Version: 4, Tier: "Standard" });
        case "DescribeTargetHealth":
          return send(200, xml("DescribeTargetHealth", `<TargetHealthDescriptions>
            <member><Target><Id>10.20.10.1</Id><Port>3000</Port></Target><TargetHealth><State>healthy</State></TargetHealth></member>
            <member><Target><Id>10.20.10.2</Id><Port>3000</Port></Target><TargetHealth><State>draining</State><Reason>Target.DeregistrationInProgress</Reason></TargetHealth></member>
            <member><Target><Id>10.20.10.3</Id><Port>3000</Port></Target><TargetHealth><State>initial</State><Reason>Elb.RegistrationInProgress</Reason></TargetHealth></member>
          </TargetHealthDescriptions>`, "http://elasticloadbalancing.amazonaws.com/doc/2015-12-01/"));
        case "GetCallerIdentity":
          return send(200, xml("GetCallerIdentity", `<Arn>arn:aws:sts::${ACCT}:assumed-role/acme-deployment-console/0a1b</Arn><UserId>AROAEXAMPLE:0a1b</UserId><Account>${ACCT}</Account>`, "https://sts.amazonaws.com/doc/2011-06-15/"));
        case "SimulatePrincipalPolicy": {
          const q = new URLSearchParams(body);
          const resource = q.get("ResourceArns.member.1") ?? "";
          if (resource.startsWith("arn:")) {
            const acts = [...q.entries()].filter(([k]) => k.startsWith("ActionNames.member.")).map(([, v]) => v);
            // A policy scoped to the staging cluster; ecs:RunTask carries a request-tag condition the simulator can't see.
            const member = (a: string) => a === "ecs:RunTask"
              ? `<member><EvalActionName>${a}</EvalActionName><EvalResourceName>${resource}</EvalResourceName><EvalDecision>implicitDeny</EvalDecision><MissingContextValues><member>aws:RequestTag/console:created</member></MissingContextValues></member>`
              : `<member><EvalActionName>${a}</EvalActionName><EvalResourceName>${resource}</EvalResourceName><EvalDecision>${resource.includes("/acme-staging/") ? "allowed" : "implicitDeny"}</EvalDecision></member>`;
            return send(200, xml("SimulatePrincipalPolicy", `<IsTruncated>false</IsTruncated><EvaluationResults>${acts.map(member).join("")}</EvaluationResults>`, "https://iam.amazonaws.com/doc/2010-05-08/"));
          }
          if (seen.filter((x) => x === op).length > 1) {
            return send(403, `<ErrorResponse xmlns="https://iam.amazonaws.com/doc/2010-05-08/"><Error><Type>Sender</Type><Code>AccessDenied</Code><Message>User: arn:aws:sts::${ACCT}:assumed-role/acme-deployment-console/0a1b is not authorized to perform: iam:SimulatePrincipalPolicy on resource: arn:aws:iam::${ACCT}:role/acme-deployment-console</Message></Error><RequestId>r-2</RequestId></ErrorResponse>`);
          }
          return send(200, xml("SimulatePrincipalPolicy", `<IsTruncated>false</IsTruncated><EvaluationResults>
            <member><EvalActionName>ecs:UpdateService</EvalActionName><EvalResourceName>*</EvalResourceName><EvalDecision>allowed</EvalDecision></member>
            <member><EvalActionName>ec2:RunInstances</EvalActionName><EvalResourceName>*</EvalResourceName><EvalDecision>implicitDeny</EvalDecision></member>
          </EvaluationResults>`, "https://iam.amazonaws.com/doc/2010-05-08/"));
        }
        default:
          return json(400, { __type: "UnknownOperationException", message: op });
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  const aws = new URL("./server/aws.ts", import.meta.url).href;
  const errors = new URL("./server/errors.ts", import.meta.url).href;
  const code = `
    const { awsCloud } = await import(${JSON.stringify(aws)});
    const { OutcomeUnknownError, HttpError } = await import(${JSON.stringify(errors)});
    const c = awsCloud("${R}");
    const out = {};
    const tryIt = async (k, f) => { try { out[k] = { ok: await f() }; } catch (e) { out[k] = { name: e.name, unknown: e instanceof OutcomeUnknownError, status: e instanceof HttpError ? e.status : undefined, message: String(e.message).slice(0, 120) }; } };
    await tryIt("update", () => c.updateService("acme-staging", "api", { desired: 2 }));
    await tryIt("events", () => c.events("acme-staging", "api"));
    await tryIt("runTask", () => c.runTask({ cluster: "acme-staging", service: "worker", taskDefinition: "arn:td", capacityProviderStrategy: [], placementConstraints: [], placementStrategy: [], tags: { "console:created": "true" }, clientToken: "op_" + "x".repeat(80) }));
    await tryIt("health1", () => c.targetHealth(["arn:aws:elasticloadbalancing:${R}:${ACCT}:targetgroup/api-prod/1"]));
    await tryIt("health2", () => c.targetHealth(["arn:aws:elasticloadbalancing:${R}:${ACCT}:targetgroup/api-prod/1"]));
    await tryIt("scalable", () => c.scalableTargets("acme-production"));
    await tryIt("image", () => c.imageExists("acme/storefront-api", { tag: "gone" }));
    await tryIt("staleSecret", () => c.writeSecret("arn:aws:ssm:${R}:${ACCT}:parameter/acme/production/api/JWT_SIGNING_KEY", "v", { ifVersion: "2" }));
    await tryIt("secret", () => c.writeSecret("arn:aws:ssm:${R}:${ACCT}:parameter/acme/production/api/JWT_SIGNING_KEY", "v", { ifVersion: "3" }));
    await tryIt("version", () => c.secretVersion("/acme/production/api/JWT_SIGNING_KEY"));
    await tryIt("revisions", () => c.revisions("api"));
    await tryIt("principal", () => c.principal());
    await tryIt("simulate", () => c.simulate(["ecs:UpdateService", "ec2:RunInstances"]));
    await tryIt("simulateDenied", () => c.simulate(["ecs:UpdateService"]));
    await tryIt("simulateTargeted", () => c.simulate(["ecs:UpdateService", "ecs:DeleteService", "ecs:RunTask"], {
      "ecs:UpdateService": ["arn:aws:ecs:${R}:${ACCT}:service/acme-production/api", "arn:aws:ecs:${R}:${ACCT}:service/acme-staging/api"],
      "ecs:DeleteService": ["arn:aws:ecs:${R}:${ACCT}:service/acme-production/api"],
      "ecs:RunTask": ["arn:aws:ecs:${R}:${ACCT}:task-definition/acme-api:41"],
    }));
    process.stdout.write(JSON.stringify(out), () => process.exit(0));
  `;
  const env: NodeJS.ProcessEnv = {
    ...process.env, AWS_ENDPOINT_URL: `http://127.0.0.1:${port}`, AWS_REGION: R, AWS_ACCESS_KEY_ID: "AKIDFAKEFORTESTS", AWS_SECRET_ACCESS_KEY: "fake",
    AWS_CONFIG_FILE: "/nonexistent", AWS_SHARED_CREDENTIALS_FILE: "/nonexistent", AWS_EC2_METADATA_DISABLED: "true", CONSOLE_SOURCE: "aws",
  };
  delete env.AWS_PROFILE;
  delete env.AWS_SESSION_TOKEN;
  delete env.NODE_TEST_CONTEXT;
  try {
    const { stdout } = await promisify(execFile)(process.execPath, ["--conditions=react-server", "--no-warnings", "--input-type=module", "-e", code], { env, timeout: 90_000 });
    const r = JSON.parse(stdout);
    const count = (op: string) => seen.filter((x) => x === op).length;
    // F31: the write went out once, its answer was lost → outcome unknown; the read was retried and failed plainly.
    assert.equal(r.update.unknown, true, JSON.stringify(r.update));
    assert.equal(r.update.status, 502);
    assert.equal(count("UpdateService"), 1, "writes are never retried by the SDK");
    assert.equal(r.events.unknown, false);
    assert.equal(count("DescribeServices"), 3, "reads keep the SDK's retries");
    // Client token: hashed to 64 characters, sent.
    const sentToken = JSON.parse(bodies.get("RunTask")![0]).clientToken as string;
    assert.equal(sentToken.length, 64);
    assert.equal(sentToken, clientToken(`op_${"x".repeat(80)}`));
    // F58: one DescribeTargetHealth per group within 10 s; initial and draining counted apart.
    assert.equal(count("DescribeTargetHealth"), 1);
    assert.deepEqual(r.health2.ok, r.health1.ok);
    assert.deepEqual({ ...r.health1.ok[0], targets: r.health1.ok[0].targets.length }, {
      targetGroupArn: `arn:aws:elasticloadbalancing:${R}:${ACCT}:targetgroup/api-prod/1`, healthy: 1, unhealthy: 0, initial: 1, draining: 1, reasons: [], targets: 3,
    });
    // CC-20: the cluster's services as resource ids (≤50 per call), then the target's policies.
    assert.deepEqual(r.scalable.ok, [{ service: "api", min: 2, max: 6, policies: ["target tracking (CPU 60 %)"] }]);
    assert.deepEqual(JSON.parse(bodies.get("DescribeScalableTargets")![0]).ResourceIds, ["service/acme-production/api", "service/acme-production/worker"]);
    // R24: a missing image is "missing", not an error.
    assert.deepEqual(r.image.ok, { exists: false });
    // R05: a stale version is refused before anything is written; the current one writes and reports the new version.
    assert.equal(r.staleSecret.status, 409);
    assert.match(r.staleSecret.message, /secret changed since it was read/);
    assert.deepEqual(r.secret.ok, { version: "4" });
    assert.equal(count("PutParameter"), 1);
    assert.equal(r.version.ok, "3");
    // R24: a family whose name prefixes another's is paged past the longer one (DESC lists that one first).
    assert.deepEqual(r.revisions.ok.map((x: { revision: number; containers: unknown[] }) => [x.revision, x.containers.length]), [[7, 1], [6, 1]]);
    assert.equal(count("ListTaskDefinitions"), 2);
    // F06: the role (not the session) is simulated, for any resource; a refused simulation is {}.
    assert.equal(r.principal.ok, `arn:aws:iam::${ACCT}:role/acme-deployment-console`);
    const sim = new URLSearchParams(bodies.get("SimulatePrincipalPolicy")![0]);
    assert.equal(sim.get("PolicySourceArn"), `arn:aws:iam::${ACCT}:role/acme-deployment-console`);
    assert.equal(sim.get("ResourceArns.member.1"), "*");
    assert.deepEqual(r.simulate.ok, { "ecs:UpdateService": "allowed", "ec2:RunInstances": "implicitDeny" });
    assert.deepEqual(r.simulateDenied.ok, {});
    // Service-scoped actions are simulated against real services, one call per resource: denied everywhere with no
    // missing context is final; allowed in staging only stays a "probably"; RunTask's tag condition keeps it one too.
    assert.deepEqual(r.simulateTargeted.ok, { "ecs:UpdateService": "implicitDeny", "ecs:DeleteService": "resourceDeny", "ecs:RunTask": "implicitDeny" });
    const targeted = bodies.get("SimulatePrincipalPolicy")!.slice(2).map((b) => new URLSearchParams(b).get("ResourceArns.member.1")).sort();
    assert.deepEqual(targeted, [`arn:aws:ecs:${R}:${ACCT}:service/acme-production/api`, `arn:aws:ecs:${R}:${ACCT}:service/acme-staging/api`, `arn:aws:ecs:${R}:${ACCT}:task-definition/acme-api:41`]);
    assert.equal(count("GetCallerIdentity"), 1, "the principal is read once");
  } finally {
    server.close();
  }
});
