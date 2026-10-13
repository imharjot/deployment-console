import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  JOBS_QUEUES_MAX, batchEnvironmentDetail, batchQueueDetail, batchResult, containersOf, definitionPlatform, envPlatform, newestJobAt, oldestRunnable, queueActivityAt,
  type BatchInput, type RawComputeEnvironment, type RawJob, type RawJobDefinition, type RawJobQueue,
} from "./batch.ts";
import { simBatch, simBatchDefinitions, simBatchJobs } from "../server/providers/mock/batch.ts";

const R = "us-east-1";
const A = "123456789012";
const NOW = Date.parse("2026-10-05T12:00:00Z");
const MIN = 60_000;
const SENTINEL = "SENTINEL-batch-3c71d0";
const SPLUNK = "SENTINEL-splunk-token-9f2e";

const ceArn = (n: string) => `arn:aws:batch:${R}:${A}:compute-environment/${n}`;
const qArn = (n: string) => `arn:aws:batch:${R}:${A}:job-queue/${n}`;
const defArn = (n: string, rev: number) => `arn:aws:batch:${R}:${A}:job-definition/${n}:${rev}`;
const role = (n: string) => `arn:aws:iam::${A}:role/${n}`;

const ce = (name: string, o: Partial<RawComputeEnvironment> = {}): RawComputeEnvironment => ({
  computeEnvironmentName: name, computeEnvironmentArn: ceArn(name), type: "MANAGED", state: "ENABLED", status: "VALID", tags: {}, ...o,
});
const queue = (name: string, envs: string[], o: Partial<RawJobQueue> = {}): RawJobQueue => ({
  jobQueueName: name, jobQueueArn: qArn(name), state: "ENABLED", status: "VALID", priority: 1, tags: {},
  computeEnvironmentOrder: envs.map((e, i) => ({ order: i + 1, computeEnvironment: e })), enrichment: { jobs: "ok" }, jobs: { runnable: [], failed: [] }, ...o,
});
const job = (name: string, o: Partial<RawJob> = {}): RawJob => ({ jobName: name, jobId: `id-${name}`, jobDefinition: defArn("report", 3), createdAt: NOW - 5 * MIN, ...o });

// Golden: DescribeComputeEnvironments + DescribeJobQueues + ListJobs + DescribeJobDefinitions. The sentinel sits in a job
// definition's environment value (mentions only), in a Splunk log option (never read) and in an EKS pod env value.
const DEFS: RawJobDefinition[] = [
  {
    jobDefinitionName: "report", jobDefinitionArn: defArn("report", 3), revision: 3, status: "ACTIVE", type: "container", platformCapabilities: ["EC2"],
    containerProperties: {
      image: `${A}.dkr.ecr.${R}.amazonaws.com/acme/jobs:2026.10.01`, jobRoleArn: role("report-job"), executionRoleArn: role("ecs-exec"),
      environment: [{ name: "DB_URL", value: `postgres://app:${SENTINEL}@db.internal:5432/app` }, { name: "ORDERS_QUEUE", value: "acme-orders" }, { name: "DEBUG", value: "true" }],
      secrets: [{ name: "API_KEY", valueFrom: `arn:aws:secretsmanager:${R}:${A}:secret:acme/report-Ab12Cd:api_key::` }, { name: "TOKEN", valueFrom: "/acme/report/token" }],
      logConfiguration: { logDriver: "awslogs", options: { "awslogs-group": "/batch/report" } },
    },
  },
  { jobDefinitionName: "report", jobDefinitionArn: defArn("report", 2), revision: 2, status: "ACTIVE", type: "container", platformCapabilities: ["EC2"], containerProperties: { image: "busybox" } },
  {
    jobDefinitionName: "fargate-export", jobDefinitionArn: defArn("fargate-export", 1), revision: 1, status: "ACTIVE", type: "container", platformCapabilities: ["FARGATE"],
    containerProperties: { image: "public.ecr.aws/acme/export:1", executionRoleArn: role("ecs-exec"), logConfiguration: { logDriver: "splunk", options: { "splunk-token": SPLUNK, "splunk-url": "https://splunk.example" } } },
  },
  { jobDefinitionName: "pod", jobDefinitionArn: defArn("pod", 1), revision: 1, status: "ACTIVE", type: "container", eksProperties: { podProperties: { containers: [{ name: "c", image: "nginx", env: [{ name: "PW", value: SENTINEL }] }] } } },
  { jobDefinitionName: "gone", jobDefinitionArn: defArn("gone", 1), revision: 1, status: "INACTIVE", containerProperties: { image: `${A}.dkr.ecr.${R}.amazonaws.com/acme/gone:1` } },
];

const INPUT: BatchInput = {
  environments: [
    ce("spot", {
      ecsClusterArn: `arn:aws:ecs:${R}:${A}:cluster/AWSBatch-spot-0a1b`, serviceRole: "service-role/AWSBatchServiceRole", tags: { Environment: "production" },
      computeResources: { type: "SPOT", minvCpus: 0, maxvCpus: 64, desiredvCpus: 4, instanceTypes: ["optimal"], instanceRole: "ecsInstanceRole", spotIamFleetRole: role("spot-fleet"), subnets: ["subnet-a"], securityGroupIds: ["sg-batch"], bidPercentage: 60 },
    }),
    ce("fargate", { computeResources: { type: "FARGATE", maxvCpus: 16, subnets: ["subnet-b"], securityGroupIds: ["sg-f"] } }),
    ce("broken", { status: "INVALID", statusReason: "CLIENT_ERROR - the instance role does not exist" }),
    ce("off", { state: "DISABLED" }),
    ce("making", { status: "CREATING" }),
    ce("eks", { containerOrchestrationType: "EKS", eksConfiguration: { eksClusterArn: `arn:aws:eks:${R}:${A}:cluster/acme`, kubernetesNamespace: "batch" }, computeResources: { type: "EC2" } }),
  ],
  queues: [
    queue("reports", [ceArn("spot")], {
      tags: { Team: "data" },
      jobs: {
        runnable: [job("waiting-long", { createdAt: NOW - 95 * MIN }), job("waiting-short", { createdAt: NOW - 10 * MIN })],
        failed: [job("failed-one", { createdAt: NOW - 3 * 60 * MIN, startedAt: NOW - 3 * 60 * MIN + MIN, stoppedAt: NOW - 2 * 60 * MIN, statusReason: "Essential container in task exited" })],
      },
    }),
    queue("exports", ["fargate"]), // a compute environment by name
    queue("quiet", [ceArn("spot"), ceArn("fargate")], { jobs: { runnable: [], failed: [] } }),
    queue("unread", [ceArn("spot")], { jobs: undefined, enrichment: { jobs: "capped" } }),
    queue("disabled", [ceArn("off")], { state: "DISABLED" }),
    queue("pods", [ceArn("eks")]),
  ],
  definitions: DEFS,
};

const result = () => batchResult(INPUT, { region: R, account: A, now: NOW });
const by = (key: string) => result().resources.find((r) => r.key === key)!;
const propVal = (key: string, label: string) => by(key).props.find((p) => p.label === label)?.value;

test("Batch: keys are ARNs; tags come from the describe calls; the ECS cluster is a prop, never a link", () => {
  const r = result();
  assert.deepEqual(r.resources.filter((x) => x.kind === "batch-environment").map((x) => x.name), ["spot", "fargate", "broken", "off", "making", "eks"]);
  assert.deepEqual(r.resources.filter((x) => x.kind === "batch-queue").map((x) => x.name), ["reports", "exports", "quiet", "unread", "disabled", "pods"]);
  const spot = by(ceArn("spot"));
  assert.deepEqual([spot.tags, spot.tagsUnread, spot.subnetIds, spot.securityGroups, spot.region], [{ Environment: "production" }, undefined, ["subnet-a"], ["sg-batch"], R]);
  assert.equal(propVal(ceArn("spot"), "ECS cluster"), "AWSBatch-spot-0a1b");
  assert.equal(propVal(ceArn("spot"), "Type"), "managed · Spot EC2");
  assert.equal(propVal(ceArn("spot"), "Spot bid"), "60 % of On-Demand");
  assert.ok(!r.links.some((l) => l.to.includes(":cluster/AWSBatch")), "Batch's own ECS cluster is not a node");
  assert.deepEqual(by(qArn("reports")).aliases, ["reports"]);
  assert.deepEqual(by(qArn("reports")).tags, { Team: "data" });
});

test("Batch: compute environment links — instance profile, service role and Spot fleet role (assumes), EKS cluster (uses)", () => {
  const from = (k: string) => result().links.filter((l) => l.from === k).map((l) => [l.to, l.kind, l.label]);
  assert.deepEqual(from(ceArn("spot")), [
    [`arn:aws:iam::${A}:instance-profile/ecsInstanceRole`, "assumes", "instance role"],
    [`arn:aws:iam::${A}:role/service-role/AWSBatchServiceRole`, "assumes", "service role"],
    [role("spot-fleet"), "assumes", "Spot fleet role"],
  ]);
  assert.deepEqual(from(ceArn("eks")), [[`arn:aws:eks:${R}:${A}:cluster/acme`, "uses", "runs on EKS (batch)"]]);
});

test("Batch: queue → compute environments in order (uses), by ARN or by name", () => {
  const uses = (q: string) => result().links.filter((l) => l.from === qArn(q) && l.kind === "uses").map((l) => [l.to, l.label]);
  assert.deepEqual(uses("quiet"), [[ceArn("spot"), "compute environment 1"], [ceArn("fargate"), "compute environment 2"]]);
  assert.deepEqual(uses("exports"), [[ceArn("fargate"), "compute environment 1"]]);
});

test("Batch: the definition a listed job ran is drawn from its queue — image (pulls), roles, secret references, awslogs group", () => {
  const links = result().links.filter((l) => l.from === qArn("reports") && l.kind !== "uses");
  assert.deepEqual(links.map((l) => [l.to, l.kind, l.confidence]), [
    [`arn:aws:ecr:${R}:${A}:repository/acme/jobs`, "pulls", undefined],
    [role("report-job"), "assumes", undefined],
    [role("ecs-exec"), "assumes", undefined],
    [`arn:aws:secretsmanager:${R}:${A}:secret:acme/report-Ab12Cd`, "reads", undefined],
    [`arn:aws:ssm:${R}:${A}:parameter/acme/report/token`, "reads", undefined],
    [`arn:aws:logs:${R}:${A}:log-group:/batch/report`, "logs", undefined],
  ]);
  assert.ok(links.every((l) => l.evidence.includes("report:3")), "evidence names the revision");
});

test("Batch: a definition no job used is drawn only from the one queue whose platform runs it (allowed); ambiguous or inactive: nothing", () => {
  const r = result();
  // fargate-export: the only Fargate-capable queues are exports and quiet → ambiguous, so nothing.
  assert.ok(!r.links.some((l) => l.evidence.includes("fargate-export")));
  // pod: only "pods" runs on EKS. Its image isn't ECR, so no pulls link; its env becomes a mention.
  assert.ok(r.mentions.some((m) => m.from === qArn("pods") && m.via === "job definition pod env PW"));
  // INACTIVE definitions are ignored.
  assert.ok(!r.links.some((l) => l.to.includes("acme/gone")));
  const lone = batchResult({ ...INPUT, queues: [queue("exports", ["fargate"])] }, { region: R, account: A, now: NOW });
  assert.deepEqual(lone.links.filter((l) => l.from === qArn("exports") && l.kind === "assumes").map((l) => [l.to, l.confidence]), [[role("ecs-exec"), "allowed"]]);
});

test("Batch: health — ENABLED+VALID ok, INVALID error, DISABLED stopped, CREATING warning; RUNNABLE over 1 h warns the queue", () => {
  const h = (k: string) => [by(k).health, by(k).healthReason];
  assert.deepEqual(h(ceArn("spot")), ["ok", undefined]);
  assert.deepEqual(h(ceArn("broken")), ["error", "invalid: CLIENT_ERROR - the instance role does not exist"]);
  assert.deepEqual(h(ceArn("off")), ["stopped", "disabled"]);
  assert.deepEqual(h(ceArn("making")), ["warning", "creating"]);
  assert.deepEqual(h(qArn("reports")), ["warning", "1 job waiting for capacity over 1 h (oldest 1.6 h)"]);
  assert.deepEqual(h(qArn("quiet")), ["ok", undefined]);
  assert.deepEqual(h(qArn("disabled")), ["stopped", "disabled"]);
  const more = batchResult({ environments: [], queues: [queue("busy", [], { jobs: { runnable: [job("a", { createdAt: NOW - 2 * 60 * MIN })], more: { runnable: true } } })] }, { region: R, account: A, now: NOW });
  assert.equal(more.resources[0].healthReason, "1+ jobs waiting for capacity over 1 h (oldest 2 h)");
});

test("Batch: lastActivityAt is now while jobs wait or run, else the newest listed job of any status; jobs not read say so and stay unknown", () => {
  assert.equal(by(qArn("reports")).lastActivityAt, NOW, "a job is waiting: in use now");
  assert.equal(propVal(qArn("reports"), "Last job"), new Date(NOW - 10 * MIN).toISOString().slice(0, 16).replace("T", " ") + " UTC");
  assert.equal(by(qArn("quiet")).lastActivityAt, undefined);
  // Regression: a queue whose jobs succeed every day but failed once nine days ago was dated by that failure (RUNNABLE
  // and FAILED only), so a short idle window marked a busy queue idle.
  const busy = batchResult({ environments: [], queues: [queue("nightly", [], {
    jobs: { runnable: [], running: [], failed: [job("old-failure", { createdAt: NOW - 9 * 1440 * MIN, stoppedAt: NOW - 9 * 1440 * MIN + MIN })], succeeded: [job("last-night", { createdAt: NOW - 12 * 60 * MIN, stoppedAt: NOW - 11 * 60 * MIN })] },
  })] }, { region: R, account: A, now: NOW });
  assert.equal(busy.resources[0].lastActivityAt, NOW - 11 * 60 * MIN);
  assert.equal(queueActivityAt({ running: [job("long", { createdAt: NOW - 30 * 1440 * MIN })] }, NOW), NOW, "a job running for weeks: in use now");
  assert.equal(propVal(qArn("reports"), "Running jobs"), undefined);
  assert.equal(propVal(qArn("reports"), "Waiting jobs"), "2 runnable · oldest 1.6 h");
  assert.equal(propVal(qArn("reports"), "Failed jobs"), "1 recently");
  assert.equal(propVal(qArn("quiet"), "Waiting jobs"), "none");
  assert.equal(propVal(qArn("unread"), "Waiting jobs"), "jobs not read (capped)");
  assert.deepEqual(by(qArn("unread")).enrichment, { jobs: "capped" });
  assert.equal(by(qArn("unread")).health, "ok");
  assert.equal(newestJobAt({ failed: [job("x", { createdAt: 1, startedAt: 5, stoppedAt: 9 })] }), 9);
  assert.equal(oldestRunnable([job("a", { createdAt: 20 }), job("b", { createdAt: 10 })], 30)?.waitedMs, 20);
});

test("Batch: platforms — EC2, Fargate and EKS from compute resources and definitions; every container shape is read", () => {
  assert.deepEqual(INPUT.environments.map(envPlatform), ["EC2", "FARGATE", "EC2", "EC2", "EC2", "EKS"]);
  assert.deepEqual(DEFS.map(definitionPlatform), ["EC2", "EC2", "FARGATE", "EKS", "EC2"]);
  const multi: RawJobDefinition = {
    jobDefinitionArn: defArn("multi", 1),
    nodeProperties: { nodeRangeProperties: [{ container: { image: "a" } }, { container: { image: "b" } }] },
    ecsProperties: { taskProperties: [{ taskRoleArn: role("task"), containers: [{ image: "c" }] }] },
  };
  assert.deepEqual(containersOf(multi).map((c) => [c.image, c.roles]), [["a", []], ["b", []], ["c", [role("task")]]]);
  // A non-awslogs driver's options are never read (they may be credentials).
  assert.equal(containersOf(DEFS[2])[0].logGroup, undefined);
});

test("Batch: secrets — environment values only in mention refs; log driver options nowhere", () => {
  const r = result();
  const visible = JSON.stringify({ resources: r.resources, links: r.links, vias: r.mentions.map((m) => m.via) });
  assert.ok(!visible.includes(SENTINEL));
  assert.ok(!JSON.stringify(r).includes(SPLUNK));
  assert.ok(r.mentions.some((m) => m.from === qArn("reports") && m.via === "job definition report env DB_URL" && m.refs.some((x) => x.includes(SENTINEL))));
  assert.ok(r.mentions.some((m) => m.via === "job definition report env ORDERS_QUEUE" && m.refs.includes("acme-orders")));
  assert.ok(!r.mentions.some((m) => m.via.endsWith("env DEBUG")), "booleans are not references");
  const q = batchQueueDetail(qArn("reports"), INPUT.queues[0], { now: NOW, recent: [{ status: "FAILED", jobs: INPUT.queues[0].jobs!.failed! }], definitions: DEFS });
  const e = batchEnvironmentDetail(ceArn("spot"), INPUT.environments[0]);
  assert.ok(!JSON.stringify([q, e]).includes(SENTINEL));
  assert.ok(!JSON.stringify([q, e]).includes(SPLUNK));
});

test("Batch: detail — queue jobs and definitions (image and role only), environment rows; gone resources say so", () => {
  const q = batchQueueDetail(qArn("reports"), INPUT.queues[0], { now: NOW, recent: [{ status: "RUNNABLE", jobs: INPUT.queues[0].jobs!.runnable! }, { status: "FAILED", jobs: INPUT.queues[0].jobs!.failed! }], definitions: DEFS });
  assert.deepEqual(q.sections.map((s) => s.title), ["Job queue", "Compute environments", "Recent jobs", "Job definitions"]);
  assert.deepEqual(q.sections[2].table?.rows.map((r) => [r[0], r[1]]), [["waiting-short", "runnable"], ["waiting-long", "runnable"], ["failed-one", "failed"]]);
  assert.deepEqual(q.sections[3].table?.rows, [["report:3", `${A}.dkr.ecr.${R}.amazonaws.com/acme/jobs:2026.10.01`, "report-job"]]);
  assert.equal(batchQueueDetail(qArn("x"), undefined, { now: NOW }).sections[0].note, "This job queue no longer exists.");
  assert.equal(batchEnvironmentDetail(ceArn("x"), undefined).sections[0].note, "This compute environment no longer exists.");
  assert.ok(batchEnvironmentDetail(ceArn("spot"), INPUT.environments[0]).sections[0].rows?.some((r) => r.label === "ECS cluster" && r.value.includes("AWSBatch-spot")));
});

test("Batch: a listed-only resource without an ARN is keyed from the account; without one it's left out", () => {
  const r = batchResult({ environments: [{ computeEnvironmentName: "named" }], queues: [{ jobQueueName: "q", computeEnvironmentOrder: [{ order: 1, computeEnvironment: "named" }] }] }, { region: R, account: A, now: NOW });
  assert.deepEqual(r.resources.map((x) => x.key), [ceArn("named"), qArn("q")]);
  assert.deepEqual(r.links.map((l) => [l.from, l.to]), [[qArn("q"), ceArn("named")]]);
  assert.equal(batchResult({ environments: [{ computeEnvironmentName: "named" }], queues: [] }, { region: R, now: NOW }).resources.length, 0);
});

test("Acme mock: the Spot environment behind acme-reports, one job waiting over an hour; us-east-1 only", () => {
  const sim = simBatch(R, NOW);
  const r = batchResult(sim, { region: R, account: A, now: NOW });
  assert.deepEqual(r.resources.map((x) => [x.name, x.health]), [["acme-batch-spot", "ok"], ["acme-reports", "warning"]]);
  assert.ok(r.links.some((l) => l.from.endsWith(":job-queue/acme-reports") && l.to.endsWith(":compute-environment/acme-batch-spot") && l.kind === "uses"));
  assert.ok(r.links.some((l) => l.kind === "pulls" && l.to.endsWith(":repository/acme/jobs")));
  assert.ok(r.mentions.some((m) => m.via === "job definition acme-nightly-report env ORDERS_QUEUE_URL"));
  assert.ok(!r.links.some((l) => l.to.includes("AWSBatch-")));
  assert.equal(simBatchDefinitions().length, 1);
  assert.equal(simBatchJobs(NOW).runnable.length, 1);
  for (const region of ["eu-west-1", "ap-south-1"]) assert.deepEqual(simBatch(region, NOW), { environments: [], queues: [], definitions: [] });
});

// ---------- the provider's real-account path, with the SDK faked (server module: child process, react-server) ----------

// Runs `body` in a child process after replacing `send` on the named SDK clients' prototypes with `fakes` (a JS
// object literal: command name → async (input, n) => output, n = the call's index for that command). `provider(path)`
// imports a provider module; `ctx()` is a real-account ProviderContext that records notes and checkpoints.
function withFakeAws<T>(clients: Record<string, string>, fakes: string, body: string): T {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const base = new URL("../server/providers/", import.meta.url).href;
  const patch = Object.entries(clients).map(([pkg, cls]) => `(await import("@aws-sdk/${pkg}")).${cls}.prototype.send = send;`).join("\n");
  const code = `
    const calls = []; const counts = {}; const fakes = ${fakes};
    const send = async function (cmd) { const n = cmd.constructor.name; counts[n] = (counts[n] ?? 0) + 1; calls.push([n, cmd.input]);
      if (!Object.hasOwn(fakes, n)) throw new Error("unexpected " + n); return fakes[n](cmd.input, counts[n] - 1); };
    const denied = (action) => Object.assign(new Error("User: u is not authorized to perform: " + action + " on resource: x"), { name: "AccessDeniedException" });
    ${patch}
    const provider = (p) => import(new URL(p, ${JSON.stringify(base)}).href);
    const notes = [], checkpoints = [];
    const ctx = () => ({ region: "ap-south-1", accountId: "123456789012", mock: false, cap: 2000, signal: AbortSignal.timeout(20000), limit: (fn) => fn(), note: (m) => notes.push(m), checkpoint: (r) => checkpoints.push(r) });
    const out = await (async () => { ${body} })();
    process.stdout.write(JSON.stringify({ ...out, calls, notes, checkpoints }), () => process.exit(0));`;
  const r = spawnSync(process.execPath, ["--conditions=react-server", "--no-warnings", "--input-type=module", "-e", code], {
    cwd: root, encoding: "utf8", timeout: 60_000, env: { ...process.env, CONSOLE_SOURCE: "mock", CONSOLE_SQLITE_PATH: ":memory:" },
  });
  assert.equal(r.status, 0, `child failed:\n${r.stderr?.slice(-3000)}`);
  return JSON.parse(r.stdout) as T;
}

interface Run {
  resources: { key: string; name: string; health: string; tags: Record<string, string>; enrichment?: Record<string, string>; props: { label: string; value: string }[] }[];
  links: { from: string; to: string; kind: string }[]; mentions: { via: string; refs: string[] }[]; calls: [string, Record<string, unknown>][]; notes: string[];
  checkpoints: { resources: { key: string }[] }[];
}

test("Batch provider (faked AWS): lists, checkpoints, ListJobs per queue (RUNNABLE, RUNNING, FAILED, SUCCEEDED; first 50 queues), ACTIVE definitions", () => {
  const out = withFakeAws<Run>(
    { "client-batch": "BatchClient" },
    `{
      DescribeComputeEnvironmentsCommand: async (input, n) => n === 0
        ? { computeEnvironments: [{ computeEnvironmentName: "ce", computeEnvironmentArn: "arn:aws:batch:ap-south-1:123456789012:compute-environment/ce", state: "ENABLED", status: "VALID", tags: { Team: "data" }, ecsClusterArn: "arn:aws:ecs:ap-south-1:123456789012:cluster/AWSBatch-ce-1" }], nextToken: "p2" }
        : { computeEnvironments: [] },
      DescribeJobQueuesCommand: async () => ({ jobQueues: Array.from({ length: 52 }, (_, i) => ({ jobQueueName: "q" + i, jobQueueArn: "arn:aws:batch:ap-south-1:123456789012:job-queue/q" + i, state: "ENABLED", status: "VALID",
        computeEnvironmentOrder: [{ order: 1, computeEnvironment: "arn:aws:batch:ap-south-1:123456789012:compute-environment/ce" }], tags: {} })) }),
      ListJobsCommand: async (input) => ({ jobSummaryList: input.jobQueue.endsWith("/q0") && input.jobStatus === "FAILED"
        ? [{ jobName: "j", jobId: "1", createdAt: 1700000000000, stoppedAt: 1700000100000, status: "FAILED", jobDefinition: "arn:aws:batch:ap-south-1:123456789012:job-definition/d:1" }] : [] }),
      DescribeJobDefinitionsCommand: async () => ({ jobDefinitions: [{ jobDefinitionName: "d", jobDefinitionArn: "arn:aws:batch:ap-south-1:123456789012:job-definition/d:1", revision: 1, status: "ACTIVE",
        containerProperties: { image: "busybox", environment: [{ name: "SECRET_URL", value: "https://u:${SENTINEL}@hooks.example.net" }] } }] }),
    }`,
    `const { batchProvider } = await provider("batch.ts"); return await batchProvider.discover(ctx());`,
  );
  const names = out.calls.map((c) => c[0]);
  assert.equal(names.filter((n) => n === "DescribeComputeEnvironmentsCommand").length, 2, "pages compute environments");
  assert.equal(out.calls.find((c) => c[0] === "DescribeJobQueuesCommand")![1].maxResults, 100);
  const jobs = out.calls.filter((c) => c[0] === "ListJobsCommand");
  assert.equal(jobs.length, JOBS_QUEUES_MAX * 4, "four statuses for each of the first 50 queues");
  assert.deepEqual([...new Set(jobs.map((c) => c[1].jobStatus))].sort(), ["FAILED", "RUNNABLE", "RUNNING", "SUCCEEDED"]);
  assert.equal(jobs[0][1].maxResults, 100);
  assert.deepEqual(out.calls.find((c) => c[0] === "DescribeJobDefinitionsCommand")![1], { status: "ACTIVE", maxResults: 100 });
  assert.equal(out.checkpoints.length, 1);
  assert.equal(out.checkpoints[0].resources.length, 53);
  const q0 = out.resources.find((r) => r.name === "q0")!;
  const q51 = out.resources.find((r) => r.name === "q51")!;
  assert.deepEqual([q0.enrichment, q51.enrichment], [{ jobs: "ok" }, { jobs: "capped" }]);
  assert.equal(out.resources.find((r) => r.name === "ce")!.props.find((p) => p.label === "ECS cluster")?.value, "AWSBatch-ce-1");
  assert.ok(out.mentions.some((m) => m.via === "job definition d env SECRET_URL"));
  assert.ok(!JSON.stringify(out.resources).includes(SENTINEL));
  assert.ok(out.notes.some((n) => /batch jobs read for the first 50 of 52/.test(n)));
});

test("Batch provider (faked AWS): an empty region makes no job or definition calls; denied definitions keep the map", () => {
  const empty = withFakeAws<Run>(
    { "client-batch": "BatchClient" },
    `{ DescribeComputeEnvironmentsCommand: async () => ({ computeEnvironments: [] }), DescribeJobQueuesCommand: async () => ({ jobQueues: [] }) }`,
    `const { batchProvider } = await provider("batch.ts"); return await batchProvider.discover(ctx());`,
  );
  assert.deepEqual(empty.calls.map((c) => c[0]), ["DescribeComputeEnvironmentsCommand", "DescribeJobQueuesCommand"]);
  assert.equal(empty.resources.length, 0);
  const denied = withFakeAws<Run>(
    { "client-batch": "BatchClient" },
    `{
      DescribeComputeEnvironmentsCommand: async () => ({ computeEnvironments: [] }),
      DescribeJobQueuesCommand: async () => ({ jobQueues: [{ jobQueueName: "q", jobQueueArn: "arn:aws:batch:ap-south-1:123456789012:job-queue/q", state: "ENABLED", status: "VALID", tags: {} }] }),
      ListJobsCommand: async () => { throw denied("batch:ListJobs"); },
      DescribeJobDefinitionsCommand: async () => { throw denied("batch:DescribeJobDefinitions"); },
    }`,
    `const { batchProvider } = await provider("batch.ts"); return await batchProvider.discover(ctx());`,
  );
  assert.deepEqual(denied.resources.map((r) => [r.name, r.health, r.enrichment]), [["q", "ok", { jobs: "denied" }]]);
  assert.deepEqual(denied.notes.sort(), ["batch job definitions skipped: batch:DescribeJobDefinitions denied", "batch jobs skipped: batch:ListJobs denied"]);
});

test("Batch provider (faked AWS): a queue panel reads recent jobs of four statuses and the definitions they used; a gone queue says so", () => {
  const out = withFakeAws<{ panel: { sections: { title: string; note?: string; table?: { rows: string[][] } }[] }; gone: { sections: { note?: string }[] }; calls: [string, Record<string, unknown>][] }>(
    { "client-batch": "BatchClient" },
    `{
      DescribeJobQueuesCommand: async (input) => ({ jobQueues: input.jobQueues[0].endsWith("/q") ? [{ jobQueueName: "q", jobQueueArn: input.jobQueues[0], state: "ENABLED", status: "VALID" }] : [] }),
      ListJobsCommand: async (input) => ({ jobSummaryList: input.jobStatus === "SUCCEEDED" ? [{ jobName: "ok-job", jobId: "1", createdAt: 1, status: "SUCCEEDED", jobDefinition: "arn:aws:batch:ap-south-1:123456789012:job-definition/d:4" }] : [] }),
      DescribeJobDefinitionsCommand: async (input) => ({ jobDefinitions: [{ jobDefinitionName: "d", jobDefinitionArn: input.jobDefinitions[0], containerProperties: { image: "img:1", jobRoleArn: "arn:aws:iam::123456789012:role/r", environment: [{ name: "X", value: "${SENTINEL}" }] } }] }),
    }`,
    `const { batchProvider } = await provider("batch.ts");
     const base = { region: "ap-south-1", tags: {}, health: "ok", props: [], kind: "batch-queue", provider: "batch" };
     const panel = await batchProvider.detail({ ...base, key: "arn:aws:batch:ap-south-1:123456789012:job-queue/q", name: "q" }, ctx());
     const gone = await batchProvider.detail({ ...base, key: "arn:aws:batch:ap-south-1:123456789012:job-queue/gone", name: "gone" }, ctx());
     return { panel, gone };`,
  );
  assert.deepEqual(out.calls.filter((c) => c[0] === "ListJobsCommand").slice(0, 4).map((c) => [c[1].jobStatus, c[1].maxResults]), [["RUNNABLE", 10], ["RUNNING", 10], ["FAILED", 10], ["SUCCEEDED", 10]]);
  assert.deepEqual(out.calls.find((c) => c[0] === "DescribeJobDefinitionsCommand")![1], { jobDefinitions: ["arn:aws:batch:ap-south-1:123456789012:job-definition/d:4"] });
  assert.deepEqual(out.panel.sections.find((s) => s.title === "Job definitions")?.table?.rows, [["d:4", "img:1", "r"]]);
  assert.equal(out.gone.sections[0].note, "This job queue no longer exists.");
  assert.ok(!JSON.stringify(out.panel).includes(SENTINEL));
});
