import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { infer } from "./infer.ts";
import { inputRefs, oneTimeAt, pipesDetail, pipesResult, schedulerDetail, schedulerResult, taskFamily, taskFamilyArn, universalTarget, type RawPipe, type RawSchedule } from "./scheduling.ts";
import type { Resource } from "./types.ts";
import { simPipes } from "../server/providers/mock/pipes.ts";
import { simSchedules } from "../server/providers/mock/scheduler.ts";

const R = "us-east-1";
const A = "123456789012";
const NOW = Date.parse("2026-10-05T12:00:00Z");
const DAY = 86_400_000;
const SENTINEL = "SENTINEL-scheduling-0f3a6c";
const fn = (n: string) => `arn:aws:lambda:${R}:${A}:function:${n}`;
const role = (n: string) => `arn:aws:iam::${A}:role/${n}`;
const queue = (n: string) => `arn:aws:sqs:${R}:${A}:${n}`;

// ---------- Scheduler ----------

const schArn = (name: string, group = "default") => `arn:aws:scheduler:${R}:${A}:schedule/${group}/${name}`;
const schedule = (name: string, o: Partial<RawSchedule> = {}): RawSchedule => ({
  Arn: schArn(name), Name: name, GroupName: "default", State: "ENABLED", ScheduleExpression: "rate(5 minutes)", Target: { Arn: fn("worker"), RoleArn: role("scheduler") }, enrichment: { schedule: "ok" }, ...o,
});

// Golden: GetSchedule shapes. The input of every target carries the sentinel (it may hold secrets): mentions only.
const SCHEDULES: RawSchedule[] = [
  schedule("digest", {
    ScheduleExpression: "cron(0 7 * * ? *)", ScheduleExpressionTimezone: "UTC", KmsKeyArn: `arn:aws:kms:${R}:${A}:key/k-1`, FlexibleTimeWindow: { Mode: "FLEXIBLE", MaximumWindowInMinutes: 15 },
    Target: { Arn: `${fn("email-sender")}:live`, RoleArn: role("scheduler"), DeadLetterConfig: { Arn: queue("digest-dlq") }, RetryPolicy: { MaximumRetryAttempts: 2, MaximumEventAgeInSeconds: 3600 }, Input: JSON.stringify({ topic: `arn:aws:sns:${R}:${A}:notifications`, apiKey: SENTINEL, n: 3, on: "true" }) },
  }),
  schedule("cleanup", { State: "DISABLED", ScheduleExpression: "rate(1 day)", Target: { Arn: `arn:aws:ecs:${R}:${A}:cluster/staging`, RoleArn: role("scheduler"), EcsParameters: { TaskDefinitionArn: `arn:aws:ecs:${R}:${A}:task-definition/worker-staging:7` }, Input: `{"token":"${SENTINEL}"}` } }),
  schedule("universal", { Target: { Arn: "arn:aws:scheduler:::aws-sdk:sqs:sendMessage", RoleArn: role("scheduler"), Input: JSON.stringify({ QueueUrl: `https://sqs.${R}.amazonaws.com/${A}/orders`, MessageBody: SENTINEL }) } }),
  schedule("once-past", { ScheduleExpression: "at(2026-10-01T09:00:00)" }),
  schedule("once-future", { ScheduleExpression: "at(2026-12-24T18:00:00)", ScheduleExpressionTimezone: "Europe/Berlin" }),
  schedule("ended", { EndDate: new Date(NOW - 2 * DAY) }),
  { Arn: schArn("listed", "ops"), Name: "listed", GroupName: "ops", State: "ENABLED", Target: { Arn: queue("jobs") }, enrichment: { schedule: "denied" } },
];
const sch = () => schedulerResult(SCHEDULES, { region: R, account: A, now: NOW });
const schBy = (n: string, g = "default") => sch().resources.find((r) => r.key === schArn(n, g))!;

test("Scheduler: key is the ARN; target (event, labelled with the schedule in words), DLQ, role, KMS; no tags to read", () => {
  const r = schBy("digest");
  assert.equal(r.kind, "schedule");
  assert.equal(r.name, "digest");
  assert.deepEqual([r.tags, r.tagsUnread], [{}, undefined]);
  assert.equal(r.props.find((p) => p.label === "Schedule")?.value, "daily at 07:00 UTC · cron(0 7 * * ? *)");
  assert.equal(r.props.find((p) => p.label === "Target")?.value, "Lambda email-sender");
  assert.deepEqual(sch().links.filter((l) => l.from === schArn("digest") || l.to === schArn("digest")).map((l) => [l.from, l.to, l.kind, l.label]), [
    [schArn("digest"), fn("email-sender"), "event", "daily at 07:00 UTC"],
    [schArn("digest"), queue("digest-dlq"), "event", "dead-letter queue"],
    [schArn("digest"), role("scheduler"), "assumes", "scheduler role"],
    [`arn:aws:kms:${R}:${A}:key/k-1`, schArn("digest"), "encrypts", "schedule input"],
  ]);
});

const family = (f: string) => `arn:aws:ecs:${R}:${A}:task-definition/${f}`;

test("Scheduler: an ECS target links to its task family's ARN (clusters aren't nodes; 'mentioned'); a universal target is described, not linked", () => {
  assert.ok(!sch().links.some((l) => l.to.includes(":cluster/")));
  assert.deepEqual(sch().links.filter((l) => l.from === schArn("cleanup") && l.kind === "invoke").map((l) => [l.to, l.label, l.confidence]), [[family("worker-staging"), "run task worker-staging", "mentioned"]]);
  assert.equal(schBy("cleanup").props.find((p) => p.label === "Target")?.value, "ECS staging · task worker-staging");
  assert.equal(schBy("universal").props.find((p) => p.label === "Target")?.value, "sqs:sendMessage (universal target)");
  assert.ok(!sch().links.some((l) => l.from === schArn("universal") && l.kind === "event"));
  assert.deepEqual(sch().mentions.find((m) => m.from === schArn("universal"))?.refs, [`https://sqs.${R}.amazonaws.com/${A}/orders`, SENTINEL]);
});

// Regression: the link used to end at the bare family name, which the map resolves against every resource's name — a
// scheduled task family "cleanup" with no ECS service drew "run task cleanup" into an unrelated Lambda called cleanup.
test("Scheduler: an ECS target resolves only to the ECS service running that family, never to a same-named resource", () => {
  const res = (o: Partial<Resource> & Pick<Resource, "key" | "kind" | "name">): Resource => ({ provider: "test", region: R, tags: {}, health: "ok", props: [], ...o });
  const lambda = res({ key: fn("cleanup"), kind: "lambda", name: "cleanup" });
  const result = schedulerResult([schedule("nightly", { Target: { Arn: `arn:aws:ecs:${R}:${A}:cluster/prod`, EcsParameters: { TaskDefinitionArn: `${family("cleanup")}:4` } } })], { region: R, account: A, now: NOW });
  const edges = (...more: Resource[]) => infer({ results: [{ resources: [lambda, ...more], links: [], mentions: [] }, result], home: R, accountId: A, regions: [R] }).edges
    .filter((e) => e.from === schArn("nightly") && e.kind === "invoke").map((e) => [e.to, e.confidence]);
  assert.deepEqual(edges(), []);
  const svc = res({ key: "ecs:service/prod/jobs", kind: "ecs-service", name: "jobs", aliases: [`arn:aws:ecs:${R}:${A}:service/prod/jobs`, family("cleanup")] });
  assert.deepEqual(edges(svc), [["ecs:service/prod/jobs", "mentioned"]]);
  assert.equal(taskFamilyArn("worker", `arn:aws-cn:ecs:cn-north-1:${A}:cluster/x`), `arn:aws-cn:ecs:cn-north-1:${A}:task-definition/worker`);
  assert.equal(taskFamilyArn(undefined, `arn:aws:ecs:${R}:${A}:cluster/x`), undefined);
});

test("Scheduler: health — ENABLED ok, DISABLED stopped, past one-time and past EndDate stopped, future one-time ok", () => {
  const h = (n: string, g?: string) => [schBy(n, g).health, schBy(n, g).healthReason];
  assert.deepEqual(h("digest"), ["ok", undefined]);
  assert.deepEqual(h("cleanup"), ["stopped", "disabled"]);
  assert.deepEqual(h("once-past"), ["stopped", "one-time schedule — ran at 2026-10-01 09:00 UTC"]);
  assert.deepEqual(h("once-future"), ["ok", undefined]);
  assert.deepEqual(h("ended"), ["stopped", `ended ${new Date(NOW - 2 * DAY).toISOString().slice(0, 16).replace("T", " ")} UTC`]);
  // A schedule GetSchedule didn't answer for: health from ListSchedules' state; the expression is "not read".
  assert.deepEqual(h("listed", "ops"), ["ok", undefined]);
  assert.equal(schBy("listed", "ops").props.find((p) => p.label === "Schedule")?.value, "expression not read (denied)");
  assert.deepEqual(schBy("listed", "ops").enrichment, { schedule: "denied" });
});

test("Scheduler: one-time times honour the schedule's time zone", () => {
  assert.equal(oneTimeAt("at(2026-12-24T18:00:00)", "Europe/Berlin"), Date.parse("2026-12-24T17:00:00Z"));
  assert.equal(oneTimeAt("at(2026-07-01T09:00:00)", "America/New_York"), Date.parse("2026-07-01T13:00:00Z"));
  assert.equal(oneTimeAt("at(2026-07-01T09:00:00)"), Date.parse("2026-07-01T09:00:00Z"));
  assert.equal(oneTimeAt("rate(1 day)"), undefined);
});

test("Scheduler: input values only in mention refs — never in resources, links or detail", () => {
  const r = sch();
  assert.ok(!JSON.stringify({ resources: r.resources, links: r.links }).includes(SENTINEL));
  assert.ok(r.mentions.every((m) => !m.via.includes(SENTINEL)));
  assert.deepEqual(r.mentions.find((m) => m.from === schArn("digest"))?.refs, [`arn:aws:sns:${R}:${A}:notifications`, SENTINEL], "flags and numbers can't name anything");
  const d = schedulerDetail(schArn("digest"), SCHEDULES[0], NOW);
  assert.ok(!JSON.stringify(d).includes(SENTINEL));
  assert.equal(d.sections[1].rows?.find((p) => p.label === "Input")?.value, "set (not shown)");
});

test("inputRefs / taskFamily / universalTarget", () => {
  assert.deepEqual(inputRefs('{"orderId": <$.body.id>, "queue": "acme-orders", "x": "ok"}'), ["acme-orders"]);
  assert.deepEqual(inputRefs("acme-production-orders"), ["acme-production-orders"]);
  assert.deepEqual(inputRefs('"arn:aws:sns:us-east-1:1:t"'), ["arn:aws:sns:us-east-1:1:t"]);
  assert.deepEqual(inputRefs(undefined), []);
  assert.equal(taskFamily(`arn:aws:ecs:${R}:${A}:task-definition/api-production:12`), "api-production");
  assert.equal(taskFamily("api-production:3"), "api-production");
  assert.equal(universalTarget("arn:aws:scheduler:::aws-sdk:ecs:runTask"), "ecs:runTask");
  assert.equal(universalTarget(fn("x")), undefined);
});

// ---------- Pipes ----------

const pipeArn = (n: string) => `arn:aws:pipes:${R}:${A}:pipe/${n}`;
const pipe = (name: string, o: Partial<RawPipe> = {}): RawPipe => ({
  Arn: pipeArn(name), Name: name, DesiredState: "RUNNING", CurrentState: "RUNNING", Source: queue("in"), Target: fn("out"), described: true, Tags: {}, enrichment: { describe: "ok" }, ...o,
});

// Golden: DescribePipe shapes. Templates and HTTP header / query values carry the sentinel: mentions only.
const PIPES: RawPipe[] = [
  pipe("ddb-to-sfn", {
    Source: `arn:aws:dynamodb:${R}:${A}:table/orders/stream/2026-01-01T00:00:00.000`, Enrichment: `${fn("enrich")}:3`, Target: `arn:aws:states:${R}:${A}:stateMachine:checkout`,
    RoleArn: role("pipe"), KmsKeyIdentifier: "mrk-1", Tags: { Environment: "production" },
    LogConfiguration: { Level: "ERROR", CloudwatchLogsLogDestination: { LogGroupArn: `arn:aws:logs:${R}:${A}:log-group:/aws/vendedlogs/pipes/ddb:*` }, S3LogDestination: { BucketName: "pipe-logs" } },
    SourceParameters: { FilterCriteria: { Filters: [{ Pattern: '{"eventName":["INSERT"]}' }] } },
    EnrichmentParameters: { InputTemplate: `{"key": "${SENTINEL}"}`, HttpParameters: { HeaderParameters: { Authorization: `Bearer ${SENTINEL}` }, QueryStringParameters: { token: SENTINEL } } },
    TargetParameters: { InputTemplate: `{"id": <$.dynamodb.Keys.id.S>, "secret": "${SENTINEL}"}` },
  }),
  pipe("mq-to-ecs", {
    Source: `arn:aws:mq:${R}:${A}:broker:legacy:b-1`, Target: `arn:aws:ecs:${R}:${A}:cluster/production`,
    SourceParameters: { ActiveMQBrokerParameters: { QueueName: "orders", Credentials: { BasicAuth: `arn:aws:secretsmanager:${R}:${A}:secret:mq-creds-Ab12Cd` } } },
    TargetParameters: { EcsTaskParameters: { TaskDefinitionArn: `arn:aws:ecs:${R}:${A}:task-definition/worker-production:9` } },
  }),
  pipe("smk", { Source: "smk://broker1.kafka.acme.example:9092,broker2.kafka.acme.example:9092", SourceParameters: { SelfManagedKafkaParameters: { TopicName: "events" } } }),
  pipe("stopped", { CurrentState: "STOPPED", DesiredState: "STOPPED" }),
  pipe("should-run", { CurrentState: "STOPPED", StateReason: "source queue deleted" }),
  pipe("failed", { CurrentState: "START_FAILED", StateReason: "role can't read the queue" }),
  pipe("starting", { CurrentState: "STARTING" }),
  pipe("listed", { described: false, Tags: undefined, enrichment: { describe: "skipped" } }),
];
const pp = () => pipesResult(PIPES);
const ppBy = (n: string) => pp().resources.find((r) => r.key === pipeArn(n))!;
const pipeLinks = (n: string) => pp().links.filter((l) => l.from === pipeArn(n) || l.to === pipeArn(n)).map((l) => [l.from === pipeArn(n) ? "→" : "←", l.from === pipeArn(n) ? l.to : l.from, l.kind]);

test("Pipes: source (poll; DynamoDB stream → table), enrichment (invoke, unqualified), target (event), role, logs, KMS", () => {
  const r = ppBy("ddb-to-sfn");
  assert.equal(r.kind, "pipe");
  assert.deepEqual(r.tags, { Environment: "production" });
  assert.deepEqual(pipeLinks("ddb-to-sfn"), [
    ["→", `arn:aws:dynamodb:${R}:${A}:table/orders`, "poll"],
    ["→", fn("enrich"), "invoke"],
    ["→", `arn:aws:states:${R}:${A}:stateMachine:checkout`, "event"],
    ["→", role("pipe"), "assumes"],
    ["→", `arn:aws:logs:${R}:${A}:log-group:/aws/vendedlogs/pipes/ddb`, "logs"],
    ["→", "arn:aws:s3:::pipe-logs", "logs"],
    ["←", `arn:aws:kms:${R}:${A}:key/mrk-1`, "encrypts"],
  ]);
  assert.equal(r.props.find((p) => p.label === "Filter")?.value, "eventName: INSERT");
});

test("Pipes: MQ source with its credentials secret (reads); ECS target via its task family; self-managed Kafka hosts", () => {
  assert.deepEqual(pipeLinks("mq-to-ecs"), [
    ["→", `arn:aws:mq:${R}:${A}:broker:legacy:b-1`, "poll"],
    ["→", `arn:aws:secretsmanager:${R}:${A}:secret:mq-creds-Ab12Cd`, "reads"],
    ["→", family("worker-production"), "invoke"],
  ]);
  assert.equal(ppBy("mq-to-ecs").props.find((p) => p.label === "Source")?.value, "Amazon MQ legacy · queue orders");
  assert.deepEqual(pipeLinks("smk").filter((l) => l[2] === "poll").map((l) => l[1]), ["broker1.kafka.acme.example", "broker2.kafka.acme.example"]);
});

test("Pipes: health — RUNNING ok, STOPPED stopped (says when it should run), *_FAILED error, transitions warn", () => {
  const h = (n: string) => [ppBy(n).health, ppBy(n).healthReason];
  assert.deepEqual(h("ddb-to-sfn"), ["ok", undefined]);
  assert.deepEqual(h("stopped"), ["stopped", "stopped"]);
  assert.deepEqual(h("should-run"), ["stopped", "stopped (should be running): source queue deleted"]);
  assert.deepEqual(h("failed"), ["error", "start failed: role can't read the queue"]);
  assert.deepEqual(h("starting"), ["warning", "starting"]);
  assert.equal(ppBy("listed").tagsUnread, true);
  assert.equal(ppBy("listed").props.find((p) => p.label === "Details")?.value, "role and parameters not read (skipped)");
});

test("Pipes: templates and HTTP parameters only in mention refs — never in resources, links or detail", () => {
  const r = pp();
  assert.ok(!JSON.stringify({ resources: r.resources, links: r.links }).includes(SENTINEL));
  assert.ok(r.mentions.every((m) => !m.via.includes(SENTINEL)));
  assert.deepEqual(r.mentions.filter((m) => m.from === pipeArn("ddb-to-sfn")).map((m) => m.via), [
    "pipe target input template", "pipe enrichment input template", "pipe enrichment header Authorization", "pipe enrichment query token",
  ]);
  const d = pipesDetail(pipeArn("ddb-to-sfn"), PIPES[0]);
  assert.ok(!JSON.stringify(d).includes(SENTINEL));
});

test("Acme mocks: daily digest → email sender, disabled staging cleanup → the staging worker's family; orders pipe; us-east-1 only", () => {
  const s = schedulerResult(simSchedules(R, NOW), { region: R, account: A, now: NOW });
  assert.deepEqual(s.resources.map((r) => [r.name, r.health]), [["acme-daily-digest", "ok"], ["acme-staging-cleanup", "stopped"]]);
  assert.ok(s.links.some((l) => l.kind === "event" && l.to === fn("acme-production-email-sender")));
  assert.ok(s.links.some((l) => l.kind === "invoke" && l.to === family("worker-staging") && l.confidence === "mentioned"));
  const p = pipesResult(simPipes(R, NOW));
  assert.equal(p.resources[0].name, "acme-orders-to-checkout");
  assert.ok(p.links.some((l) => l.kind === "poll" && l.to === queue("acme-production-orders")));
  assert.ok(p.links.some((l) => l.kind === "event" && l.to === `arn:aws:states:${R}:${A}:stateMachine:acme-production-checkout`));
  for (const region of ["eu-west-1", "ap-south-1"]) assert.deepEqual([simSchedules(region), simPipes(region)], [[], []]);
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

interface Run { resources: { key: string; name: string; health: string; tags: Record<string, string>; tagsUnread?: boolean; enrichment?: Record<string, string>; props: { label: string; value: string }[] }[]; links: { from: string; to: string; kind: string }[]; mentions: { refs: string[] }[]; calls: [string, Record<string, unknown>][]; notes: string[]; checkpoints: unknown[] }

test("Scheduler provider (faked AWS): ListSchedules of every group, checkpoint, GetSchedule by group and name; Input only in mentions", () => {
  const out = withFakeAws<Run>(
    { "client-scheduler": "SchedulerClient" },
    `{
      ListSchedulesCommand: async () => ({ Schedules: [
        { Arn: "arn:aws:scheduler:ap-south-1:123456789012:schedule/ops/nightly", Name: "nightly", GroupName: "ops", State: "ENABLED", Target: { Arn: "arn:aws:lambda:ap-south-1:123456789012:function:report" } },
        { Arn: "arn:aws:scheduler:ap-south-1:123456789012:schedule/default/hidden", Name: "hidden", GroupName: "default", State: "DISABLED", Target: { Arn: "arn:aws:sqs:ap-south-1:123456789012:q" } },
      ] }),
      GetScheduleCommand: async (input) => {
        if (input.Name === "hidden") throw denied("scheduler:GetSchedule");
        return { $metadata: {}, Arn: "arn:aws:scheduler:ap-south-1:123456789012:schedule/ops/nightly", Name: "nightly", GroupName: "ops", State: "ENABLED", ScheduleExpression: "cron(30 1 * * ? *)",
          Target: { Arn: "arn:aws:lambda:ap-south-1:123456789012:function:report", RoleArn: "arn:aws:iam::123456789012:role/sched", Input: JSON.stringify({ token: "${SENTINEL}" }) } };
      },
    }`,
    `const { schedulerProvider } = await provider("scheduler.ts"); const r = await schedulerProvider.discover(ctx());
     const before = calls.length; const detail = await schedulerProvider.detail(r.resources[0], ctx()); return { ...r, detail, detailCalls: calls.splice(before) };`,
  );
  const d = out as unknown as { detail: { sections: { title: string; rows?: { label: string; value: string }[] }[] }; detailCalls: [string, Record<string, unknown>][] };
  assert.deepEqual(d.detailCalls.map((c) => [c[0], c[1].GroupName, c[1].Name]), [["GetScheduleCommand", "ops", "nightly"]], "the panel reads the schedule by its group and name");
  assert.equal(d.detail.sections[1].rows?.find((x) => x.label === "Input")?.value, "set (not shown)");
  assert.ok(!JSON.stringify(d.detail).includes(SENTINEL));
  assert.deepEqual(out.calls.map((c) => c[0]), ["ListSchedulesCommand", "GetScheduleCommand", "GetScheduleCommand"]);
  assert.deepEqual([out.calls[0][1].MaxResults, out.calls[0][1].GroupName], [100, undefined], "every group: no GroupName filter");
  assert.deepEqual(out.calls.slice(1).map((c) => [c[1].GroupName, c[1].Name]), [["ops", "nightly"], ["default", "hidden"]]);
  assert.equal(out.checkpoints.length, 1);
  assert.deepEqual(out.resources.map((r) => [r.name, r.health, r.enrichment]), [["nightly", "ok", { schedule: "ok" }], ["hidden", "stopped", { schedule: "denied" }]]);
  assert.ok(out.links.some((l) => l.kind === "event" && l.to.endsWith(":function:report")));
  assert.ok(out.links.some((l) => l.kind === "assumes" && l.to.endsWith(":role/sched")));
  assert.ok(!JSON.stringify({ r: out.resources, l: out.links }).includes(SENTINEL));
  assert.deepEqual(out.mentions.map((m) => m.refs), [[SENTINEL]]);
});

test("Pipes provider (faked AWS): ListPipes, checkpoint, DescribePipe per pipe (tags, role); unread details are tagsUnread", () => {
  const out = withFakeAws<Run>(
    { "client-pipes": "PipesClient" },
    `{
      ListPipesCommand: async (input, n) => n === 0
        ? { Pipes: [{ Arn: "arn:aws:pipes:ap-south-1:123456789012:pipe/p1", Name: "p1", CurrentState: "RUNNING", DesiredState: "RUNNING", Source: "arn:aws:sqs:ap-south-1:123456789012:in", Target: "arn:aws:lambda:ap-south-1:123456789012:function:out" }], NextToken: "t" }
        : { Pipes: [{ Arn: "arn:aws:pipes:ap-south-1:123456789012:pipe/p2", Name: "p2", CurrentState: "STOPPED", DesiredState: "STOPPED", Source: "arn:aws:sqs:ap-south-1:123456789012:in2", Target: "arn:aws:sqs:ap-south-1:123456789012:out2" }] },
      DescribePipeCommand: async (input) => {
        if (input.Name === "p2") throw denied("pipes:DescribePipe");
        return { $metadata: {}, Arn: "arn:aws:pipes:ap-south-1:123456789012:pipe/p1", Name: "p1", CurrentState: "RUNNING", DesiredState: "RUNNING", Source: "arn:aws:sqs:ap-south-1:123456789012:in",
          Target: "arn:aws:lambda:ap-south-1:123456789012:function:out", RoleArn: "arn:aws:iam::123456789012:role/pipe", Tags: { Team: "orders" }, TargetParameters: { InputTemplate: "{\\"k\\": \\"${SENTINEL}\\"}" } };
      },
    }`,
    `const { pipesProvider } = await provider("pipes.ts"); return await pipesProvider.discover(ctx());`,
  );
  assert.deepEqual(out.calls.map((c) => c[0]), ["ListPipesCommand", "ListPipesCommand", "DescribePipeCommand", "DescribePipeCommand"]);
  assert.deepEqual([out.calls[0][1].Limit, out.calls[1][1].NextToken], [100, "t"]);
  assert.equal(out.checkpoints.length, 1);
  assert.deepEqual(out.resources.map((r) => [r.name, r.health, r.tags, r.tagsUnread, r.enrichment]), [
    ["p1", "ok", { Team: "orders" }, undefined, { describe: "ok" }],
    ["p2", "stopped", {}, true, { describe: "denied" }],
  ]);
  assert.ok(out.links.some((l) => l.from.endsWith("pipe/p2") && l.kind === "poll"), "list fields still link an undescribed pipe");
  assert.ok(!JSON.stringify({ r: out.resources, l: out.links }).includes(SENTINEL));
});

test("Scheduler and Pipes providers (faked AWS): a panel opened on a schedule or pipe deleted since discovery says so instead of failing", () => {
  const out = withFakeAws<{ schedule: { sections: { note?: string }[] }; pipe: { sections: { note?: string }[] } }>(
    { "client-scheduler": "SchedulerClient", "client-pipes": "PipesClient" },
    `{
      GetScheduleCommand: async () => { throw Object.assign(new Error("Schedule nightly does not exist."), { name: "ResourceNotFoundException" }); },
      DescribePipeCommand: async () => { throw Object.assign(new Error("Pipe p1 does not exist."), { name: "NotFoundException" }); },
    }`,
    `const { schedulerProvider } = await provider("scheduler.ts"); const { pipesProvider } = await provider("pipes.ts");
     const base = { region: "ap-south-1", tags: {}, health: "ok", props: [] };
     const schedule = await schedulerProvider.detail({ ...base, key: "arn:aws:scheduler:ap-south-1:123456789012:schedule/ops/nightly", kind: "schedule", provider: "scheduler", name: "nightly" }, ctx());
     const pipe = await pipesProvider.detail({ ...base, key: "arn:aws:pipes:ap-south-1:123456789012:pipe/p1", kind: "pipe", provider: "pipes", name: "p1" }, ctx());
     return { schedule, pipe };`,
  );
  assert.equal(out.schedule.sections[0].note, "This schedule no longer exists.");
  assert.equal(out.pipe.sections[0].note, "This pipe no longer exists.");
});
