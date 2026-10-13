import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { brokerHostsOf, firehoseDetail, firehoseResult, mqDetail, mqResult, type RawBroker, type RawDeliveryStream } from "./streaming.ts";
import { simFirehose } from "../server/providers/mock/firehose.ts";
import { simMq } from "../server/providers/mock/mq.ts";

const R = "us-east-1";
const A = "123456789012";
const SENTINEL = "SENTINEL-streaming-5e2b90";
const HEC = "SENTINEL-hec-token-77a1";

// ---------- Amazon MQ ----------

const brokerArn = (name: string) => `arn:aws:mq:${R}:${A}:broker:${name}:b-${name}-0001`;
const mqHost = (name: string) => `b-${name}-0001-1.mq.${R}.amazonaws.com`;
const broker = (name: string, o: Partial<RawBroker> = {}): RawBroker => ({
  BrokerArn: brokerArn(name), BrokerId: `b-${name}-0001`, BrokerName: name, BrokerState: "RUNNING", DeploymentMode: "SINGLE_INSTANCE", EngineType: "ACTIVEMQ",
  HostInstanceType: "mq.m5.large", described: true, Tags: {}, enrichment: { describe: "ok" }, ...o,
});

// Golden: ListBrokers + DescribeBroker. DescribeBroker never returns passwords; the sentinel sits in a user name (names
// are counted, not listed), in user info on an endpoint URL, and in an LDAP field the mapper must not copy.
const BROKERS: RawBroker[] = [
  broker("orders", {
    EngineVersion: "5.18", PubliclyAccessible: true, SubnetIds: ["subnet-a"], SecurityGroups: ["sg-mq"], AuthenticationStrategy: "SIMPLE", Tags: { Environment: "production" },
    BrokerInstances: [{ ConsoleURL: `https://${mqHost("orders")}:8162`, IpAddress: "10.0.1.5", Endpoints: [`ssl://${mqHost("orders")}:61617`, `amqp+ssl://admin:${SENTINEL}@${mqHost("orders")}:5671`] }],
    EncryptionOptions: { UseAwsOwnedKey: false, KmsKeyId: "0abc-key" },
    Logs: { General: true, GeneralLogGroup: "/aws/amazonmq/broker/b-orders-0001/general", Audit: true, AuditLogGroup: `arn:aws:logs:${R}:${A}:log-group:/aws/amazonmq/broker/b-orders-0001/audit:*` },
    Users: [{ Username: SENTINEL }, { Username: "app" }],
    LdapServerMetadata: { ServiceAccountPassword: SENTINEL },
  } as never),
  broker("rabbit", { EngineType: "RABBITMQ", BrokerInstances: [{ ConsoleURL: `https://${mqHost("rabbit")}`, Endpoints: [`amqps://${mqHost("rabbit")}:5671`] }], EncryptionOptions: { UseAwsOwnedKey: true } }),
  broker("unread", { described: false, Tags: undefined, enrichment: { describe: "denied" } }),
  broker("action", { ActionsRequired: [{ ActionRequiredCode: "INVALID_KMS_KEY", ActionRequiredInfo: "The KMS key is disabled." }] }),
  broker("replica", { BrokerState: "REPLICA" }),
  broker("rebooting", { BrokerState: "REBOOT_IN_PROGRESS" }),
  broker("creating", { BrokerState: "CREATION_IN_PROGRESS" }),
  broker("failed", { BrokerState: "CREATION_FAILED" }),
  broker("critical", { BrokerState: "CRITICAL_ACTION_REQUIRED", ActionsRequired: [{ ActionRequiredCode: "STORAGE_FULL" }] }),
];
const mq = () => mqResult(BROKERS);
const mqBy = (n: string) => mq().resources.find((r) => r.key === brokerArn(n))!;

test("MQ: key is the ARN; endpoints are broker hostnames only (no scheme, port or user info); the id is an alias", () => {
  const r = mqBy("orders");
  assert.equal(r.kind, "mq-broker");
  assert.equal(r.name, "orders");
  assert.deepEqual(r.endpoints, [mqHost("orders")]);
  assert.deepEqual(brokerHostsOf(BROKERS[1]), [mqHost("rabbit")]);
  assert.deepEqual(r.aliases, ["b-orders-0001"]);
  assert.deepEqual([r.subnetIds, r.securityGroups], [["subnet-a"], ["sg-mq"]]);
  assert.deepEqual(r.facts, { public: true, state: "RUNNING" });
  assert.equal(r.props.find((p) => p.label === "Users")?.value, "2 users");
  assert.equal(r.props.find((p) => p.label === "Engine")?.value, "ActiveMQ 5.18");
});

test("MQ: links — customer KMS key (bare id → ARN), general and audit log groups; AWS-owned key draws nothing", () => {
  assert.deepEqual(mq().links.map((l) => [l.from, l.to, l.kind, l.label]), [
    [`arn:aws:kms:${R}:${A}:key/0abc-key`, brokerArn("orders"), "encrypts", "broker storage"],
    [brokerArn("orders"), `arn:aws:logs:${R}:${A}:log-group:/aws/amazonmq/broker/b-orders-0001/general`, "logs", "general logs"],
    [brokerArn("orders"), `arn:aws:logs:${R}:${A}:log-group:/aws/amazonmq/broker/b-orders-0001/audit`, "logs", "audit logs"],
  ]);
});

test("MQ: a broker DescribeBroker didn't answer for is tagsUnread, with no public fact and its endpoints 'not read'", () => {
  const r = mqBy("unread");
  assert.equal(r.tagsUnread, true);
  assert.equal(r.facts?.public, undefined);
  assert.equal(r.endpoints, undefined);
  assert.equal(r.props.find((p) => p.label === "Endpoints")?.value, "endpoints not read (denied)");
  assert.deepEqual(r.enrichment, { describe: "denied" });
});

test("MQ: health — RUNNING ok, actions required warn, REPLICA ok, in progress warn, creation failed / critical action error", () => {
  const h = (n: string) => [mqBy(n).health, mqBy(n).healthReason];
  assert.deepEqual(h("orders"), ["ok", undefined]);
  assert.deepEqual(h("action"), ["warning", "action required — INVALID_KMS_KEY: The KMS key is disabled."]);
  assert.deepEqual(h("replica"), ["ok", "replica (cross-Region data replication standby)"]);
  assert.deepEqual(h("rebooting"), ["warning", "reboot in progress"]);
  assert.deepEqual(h("creating"), ["warning", "creation in progress"]);
  assert.deepEqual(h("failed"), ["error", "creation failed"]);
  assert.deepEqual(h("critical"), ["error", "critical action required — STORAGE_FULL"]);
});

test("MQ: no sentinel (user names, endpoint user info, LDAP fields) in resources or detail", () => {
  assert.ok(!JSON.stringify(mq()).includes(SENTINEL));
  const d = mqDetail(brokerArn("orders"), BROKERS[0]);
  assert.ok(!JSON.stringify(d).includes(SENTINEL));
  assert.deepEqual(d.sections[1].table?.rows, [["10.0.1.5", `ssl://${mqHost("orders")}:61617, amqp+ssl://${mqHost("orders")}:5671`]]);
});

// ---------- Data Firehose ----------

const streamArn = (name: string) => `arn:aws:firehose:${R}:${A}:deliverystream/${name}`;
const role = (n: string) => `arn:aws:iam::${A}:role/${n}`;
const stream = (name: string, o: Partial<RawDeliveryStream> = {}): RawDeliveryStream => ({
  DeliveryStreamName: name, DeliveryStreamARN: streamArn(name), DeliveryStreamStatus: "ACTIVE", DeliveryStreamType: "DirectPut", Destinations: [], tags: [], enrichment: { describe: "ok", tags: "ok" }, ...o,
});

// Golden: DescribeDeliveryStream shapes. Secrets: HTTP common attributes (mentions only), a token in the HTTP URL query
// (host only), a Splunk HEC token (never read), and an access key on the HTTP endpoint configuration (never declared).
const STREAMS: RawDeliveryStream[] = [
  stream("clicks", {
    DeliveryStreamType: "KinesisStreamAsSource",
    Source: { KinesisStreamSourceDescription: { KinesisStreamARN: `arn:aws:kinesis:${R}:${A}:stream/clicks`, RoleARN: role("firehose-source") } },
    Destinations: [{
      DestinationId: "d-1",
      ExtendedS3DestinationDescription: {
        RoleARN: role("firehose-delivery"), BucketARN: "arn:aws:s3:::lake", Prefix: "clicks/",
        EncryptionConfiguration: { KMSEncryptionConfig: { AWSKMSKeyARN: `arn:aws:kms:${R}:${A}:key/lake-key` } },
        CloudWatchLoggingOptions: { Enabled: true, LogGroupName: "/aws/kinesisfirehose/clicks", LogStreamName: "DestinationDelivery" },
        ProcessingConfiguration: { Enabled: true, Processors: [{ Type: "Lambda", Parameters: [{ ParameterName: "LambdaArn", ParameterValue: `arn:aws:lambda:${R}:${A}:function:enrich:$LATEST` }] }] },
        S3BackupMode: "Enabled", S3BackupDescription: { RoleARN: role("firehose-delivery"), BucketARN: "arn:aws:s3:::lake-raw" },
      },
    }],
    tags: [{ Key: "Environment", Value: "production" }],
  }),
  stream("to-vendor", {
    DeliveryStreamEncryptionConfiguration: { Status: "ENABLED", KeyType: "CUSTOMER_MANAGED_CMK", KeyARN: `arn:aws:kms:${R}:${A}:key/sse-key` },
    Destinations: [
      {
        DestinationId: "d-1",
        HttpEndpointDestinationDescription: {
          EndpointConfiguration: { Url: `https://intake.vendor.example/v1/logs?api_key=${SENTINEL}`, Name: "Vendor", AccessKey: SENTINEL },
          RequestConfiguration: { ContentEncoding: "GZIP", CommonAttributes: [{ AttributeName: "dd-api-key", AttributeValue: SENTINEL }, { AttributeName: "x", AttributeValue: "1" }] },
          RoleARN: role("firehose-delivery"),
          S3DestinationDescription: { RoleARN: role("firehose-delivery"), BucketARN: "arn:aws:s3:::failed-records" },
          SecretsManagerConfiguration: { Enabled: true, SecretARN: `arn:aws:secretsmanager:${R}:${A}:secret:vendor-key-Ab12Cd` },
        },
      } as never,
      { DestinationId: "d-2", SplunkDestinationDescription: { HECEndpoint: "https://splunk.acme.example:8088", HECToken: HEC, HECEndpointType: "Raw" } } as never,
    ],
  }),
  stream("to-search", {
    DeliveryStreamType: "MSKAsSource",
    Source: { MSKSourceDescription: { MSKClusterARN: `arn:aws:kafka:${R}:${A}:cluster/events/uuid-1`, TopicName: "orders", AuthenticationConfiguration: { RoleARN: role("firehose-msk"), Connectivity: "PRIVATE" } } },
    Destinations: [
      { DestinationId: "d-1", AmazonopensearchserviceDestinationDescription: { DomainARN: `arn:aws:es:${R}:${A}:domain/search`, IndexName: "orders", RoleARN: role("firehose-delivery") } },
      { DestinationId: "d-2", RedshiftDestinationDescription: { ClusterJDBCURL: `jdbc:redshift://dw.abc.${R}.redshift.amazonaws.com:5439/analytics`, CopyCommand: { DataTableName: "events" }, RoleARN: role("firehose-delivery"), Password: SENTINEL, S3DestinationDescription: { BucketARN: "arn:aws:s3:::dw-staging", RoleARN: role("firehose-delivery") } } as never },
    ],
  }),
  { DeliveryStreamName: "listed-only", enrichment: { describe: "skipped", tags: "skipped" } },
  stream("broken", { DeliveryStreamStatus: "CREATING_FAILED", FailureDescription: { Type: "INVALID_KMS_KEY", Details: "The key is disabled." } }),
  stream("updating", { DeliveryStreamStatus: "UPDATING" }),
  stream("sse-failing", { DeliveryStreamEncryptionConfiguration: { Status: "ENABLING_FAILED", KeyType: "CUSTOMER_MANAGED_CMK", FailureDescription: { Type: "KMS_ACCESS_DENIED", Details: "denied" } } }),
];
const fh = () => firehoseResult(STREAMS, { region: R, account: A });
const fhBy = (n: string) => fh().resources.find((r) => r.key === streamArn(n))!;
const linksOf = (n: string) => fh().links.filter((l) => l.from === streamArn(n) || l.to === streamArn(n)).map((l) => [l.from === streamArn(n) ? "→" : "←", l.from === streamArn(n) ? l.to : l.from, l.kind]);

test("Firehose: Kinesis source (poll), S3 and backup bucket (writes), processor Lambda (invoke, unqualified), logs, KMS, roles", () => {
  const r = fhBy("clicks");
  assert.equal(r.kind, "firehose-stream");
  assert.deepEqual(r.tags, { Environment: "production" });
  assert.equal(r.props.find((p) => p.label === "Destination")?.value, "S3 lake");
  assert.deepEqual(linksOf("clicks"), [
    ["→", `arn:aws:kinesis:${R}:${A}:stream/clicks`, "poll"],
    ["→", role("firehose-source"), "assumes"],
    ["→", "arn:aws:s3:::lake", "writes"],
    ["→", role("firehose-delivery"), "assumes"],
    ["←", `arn:aws:kms:${R}:${A}:key/lake-key`, "encrypts"],
    ["→", `arn:aws:logs:${R}:${A}:log-group:/aws/kinesisfirehose/clicks`, "logs"],
    ["→", `arn:aws:lambda:${R}:${A}:function:enrich`, "invoke"],
    ["→", "arn:aws:s3:::lake-raw", "writes"],
  ]);
});

test("Firehose: HTTP endpoint → its host only; common attributes become mentions; Splunk host without its token; SSE key", () => {
  assert.deepEqual(linksOf("to-vendor"), [
    ["←", `arn:aws:kms:${R}:${A}:key/sse-key`, "encrypts"],
    ["→", "intake.vendor.example", "writes"],
    ["→", role("firehose-delivery"), "assumes"],
    ["→", "arn:aws:s3:::failed-records", "writes"],
    ["→", `arn:aws:secretsmanager:${R}:${A}:secret:vendor-key-Ab12Cd`, "reads"],
    ["→", "splunk.acme.example", "writes"],
  ]);
  assert.deepEqual(fh().mentions, [{ from: streamArn("to-vendor"), refs: [SENTINEL], via: "HTTP endpoint attribute dd-api-key" }]);
});

test("Firehose: MSK source (poll, topic label), OpenSearch domain and Redshift host (writes)", () => {
  assert.deepEqual(linksOf("to-search"), [
    ["→", `arn:aws:kafka:${R}:${A}:cluster/events/uuid-1`, "poll"],
    ["→", role("firehose-msk"), "assumes"],
    ["→", `arn:aws:es:${R}:${A}:domain/search`, "writes"],
    ["→", role("firehose-delivery"), "assumes"],
    ["→", `dw.abc.${R}.redshift.amazonaws.com`, "writes"],
    ["→", "arn:aws:s3:::dw-staging", "writes"],
  ]);
  assert.equal(fh().links.find((l) => l.to === `arn:aws:kafka:${R}:${A}:cluster/events/uuid-1`)?.label, "topic orders");
  assert.equal(fh().links.find((l) => l.to === "arn:aws:s3:::dw-staging")?.label, "staging for Redshift COPY", "Redshift COPYs from its S3 bucket: it isn't a backup");
  assert.equal(fhBy("to-search").props.find((p) => p.label === "Source")?.value, "MSK topic · topic orders");
});

test("Firehose: a listed-only stream is keyed from the account, unknown and tagsUnread; without an account it's left out", () => {
  const r = fhBy("listed-only");
  assert.deepEqual([r.health, r.healthReason, r.tagsUnread], ["unknown", "status not read (skipped)", true]);
  assert.equal(r.props.find((p) => p.label === "Destination")?.value, "destinations not read (skipped)");
  assert.deepEqual(firehoseResult([{ DeliveryStreamName: "x" }], { region: R }).resources, []);
});

test("Firehose: health — ACTIVE ok, *_FAILED error with the failure, UPDATING warning, failing encryption warning", () => {
  const h = (n: string) => [fhBy(n).health, fhBy(n).healthReason];
  assert.deepEqual(h("clicks"), ["ok", undefined]);
  assert.deepEqual(h("broken"), ["error", "creating failed: The key is disabled."]);
  assert.deepEqual(h("updating"), ["warning", "updating"]);
  assert.deepEqual(h("sse-failing"), ["warning", "server-side encryption enabling failed: denied"]);
});

test("Firehose: secrets — common attribute values only in mention refs, never in resources or links; HEC token nowhere", () => {
  const r = fh();
  assert.ok(!JSON.stringify({ resources: r.resources, links: r.links }).includes(SENTINEL));
  assert.ok(!JSON.stringify(r).includes(HEC));
  assert.ok(r.mentions.every((m) => !m.via.includes(SENTINEL)));
  const d = firehoseDetail(streamArn("to-vendor"), STREAMS[1]);
  assert.ok(!JSON.stringify(d).includes(SENTINEL) && !JSON.stringify(d).includes(HEC));
  assert.deepEqual(d.sections[1].table?.rows, [["d-1", "HTTP endpoint Vendor"], ["d-2", "Splunk splunk.acme.example"]]);
});

test("Acme mocks: the clickstream Firehose lands in the data lake; the legacy broker is private; us-east-1 only", () => {
  const f = firehoseResult(simFirehose(R), { region: R, account: A });
  assert.equal(f.resources.length, 1);
  assert.equal(f.resources[0].name, "acme-clickstream-to-s3");
  assert.ok(f.links.some((l) => l.kind === "poll" && l.to.endsWith(":stream/acme-production-clickstream")));
  assert.ok(f.links.some((l) => l.kind === "writes" && l.to === "arn:aws:s3:::acme-data-lake"));
  const m = mqResult(simMq(R));
  assert.equal(m.resources[0].name, "acme-legacy-mq");
  assert.equal(m.resources[0].facts?.public, false);
  assert.deepEqual(m.resources[0].endpoints, ["b-0acme0d4-6666-4777-8888-000000000001-1.mq.us-east-1.amazonaws.com"]);
  for (const region of ["eu-west-1", "ap-south-1"]) assert.deepEqual([simFirehose(region), simMq(region)], [[], []]);
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

interface Run { resources: { key: string; name: string; health: string; healthReason?: string; tags: Record<string, string>; tagsUnread?: boolean; enrichment?: Record<string, string>; endpoints?: string[]; props: { label: string; value: string }[] }[]; mentions: unknown[]; calls: [string, Record<string, unknown>][]; notes: string[]; checkpoints: unknown[]; activity?: unknown; detail?: { sections: { title: string }[] } }

test("MQ provider (faked AWS): ListBrokers, checkpoint, DescribeBroker per broker; user names never leave the provider", () => {
  const out = withFakeAws<Run>(
    { "client-mq": "MqClient" },
    `{
      ListBrokersCommand: async () => ({ BrokerSummaries: [
        { BrokerArn: "arn:aws:mq:ap-south-1:123456789012:broker:a:b-1", BrokerId: "b-1", BrokerName: "a", BrokerState: "RUNNING", EngineType: "RABBITMQ", DeploymentMode: "SINGLE_INSTANCE" },
        { BrokerArn: "arn:aws:mq:ap-south-1:123456789012:broker:z:b-2", BrokerId: "b-2", BrokerName: "z", BrokerState: "RUNNING", EngineType: "ACTIVEMQ", DeploymentMode: "SINGLE_INSTANCE" },
      ] }),
      DescribeBrokerCommand: async (input) => {
        if (input.BrokerId === "b-2") throw denied("mq:DescribeBroker");
        return { BrokerArn: "arn:aws:mq:ap-south-1:123456789012:broker:a:b-1", BrokerId: "b-1", BrokerName: "a", BrokerState: "RUNNING", EngineType: "RABBITMQ", PubliclyAccessible: true,
          BrokerInstances: [{ ConsoleURL: "https://b-1.mq.ap-south-1.amazonaws.com", Endpoints: ["amqps://b-1.mq.ap-south-1.amazonaws.com:5671"] }], Users: [{ Username: "${SENTINEL}" }], Tags: { Team: "orders" } };
      },
    }`,
    `const { mqProvider } = await provider("mq.ts"); return await mqProvider.discover(ctx());`,
  );
  assert.deepEqual(out.calls.map((c) => c[0]), ["ListBrokersCommand", "DescribeBrokerCommand", "DescribeBrokerCommand"]);
  assert.equal(out.calls[0][1].MaxResults, 100);
  assert.equal(out.checkpoints.length, 1);
  const [a, z] = out.resources;
  assert.deepEqual([a.endpoints, a.tags, a.enrichment, a.props.find((p) => p.label === "Users")?.value], [["b-1.mq.ap-south-1.amazonaws.com"], { Team: "orders" }, { describe: "ok" }, "1 user"]);
  assert.deepEqual([z.tagsUnread, z.enrichment], [true, { describe: "denied" }]);
  assert.deepEqual(out.notes, ["mq broker details skipped: mq:DescribeBroker denied"]);
  assert.ok(!JSON.stringify(out.resources).includes(SENTINEL));
});

test("Firehose provider (faked AWS): pages by the last name, checkpoints, describes and tags per stream; IncomingRecords is required activity", () => {
  const out = withFakeAws<Run>(
    { "client-firehose": "FirehoseClient" },
    `{
      ListDeliveryStreamsCommand: async (input, n) => n === 0 ? { DeliveryStreamNames: ["a", "b"], HasMoreDeliveryStreams: true } : { DeliveryStreamNames: ["c"], HasMoreDeliveryStreams: false },
      DescribeDeliveryStreamCommand: async (input) => {
        if (input.DeliveryStreamName === "c") throw Object.assign(new Error("Rate exceeded"), { name: "LimitExceededException" });
        return { DeliveryStreamDescription: { DeliveryStreamName: input.DeliveryStreamName, DeliveryStreamARN: "arn:aws:firehose:ap-south-1:123456789012:deliverystream/" + input.DeliveryStreamName,
          DeliveryStreamStatus: "ACTIVE", DeliveryStreamType: "DirectPut", Destinations: [{ DestinationId: "d", SplunkDestinationDescription: { HECEndpoint: "https://splunk.example:8088", HECToken: "${SENTINEL}" } }] } };
      },
      ListTagsForDeliveryStreamCommand: async (input) => ({ Tags: input.DeliveryStreamName === "a" ? [{ Key: "Team", Value: "data" }] : [], HasMoreTags: false }),
    }`,
    `const { firehoseProvider } = await provider("firehose.ts"); const r = await firehoseProvider.discover(ctx()); return { ...r, activity: firehoseProvider.activity(r.resources[0]) };`,
  );
  const lists = out.calls.filter((c) => c[0] === "ListDeliveryStreamsCommand").map((c) => [c[1].Limit, c[1].ExclusiveStartDeliveryStreamName]);
  assert.deepEqual(lists, [[10000, undefined], [10000, "b"]]);
  assert.equal(out.checkpoints.length, 1);
  assert.deepEqual(out.resources.map((r) => [r.name, r.health, r.tags, r.tagsUnread, r.enrichment]), [
    ["a", "ok", { Team: "data" }, undefined, { describe: "ok", tags: "ok" }],
    ["b", "ok", {}, undefined, { describe: "ok", tags: "ok" }],
    ["c", "unknown", {}, undefined, { describe: "error", tags: "ok" }],
  ]);
  assert.equal(out.resources[2].key, "arn:aws:firehose:ap-south-1:123456789012:deliverystream/c", "keyed from the account when not described");
  assert.deepEqual(out.activity, [{ namespace: "AWS/Firehose", metric: "IncomingRecords", dims: { DeliveryStreamName: "a" }, stat: "Sum", label: "Incoming records", region: "ap-south-1", required: true }]);
  assert.ok(!JSON.stringify(out).includes(SENTINEL));
});

test("MQ and Firehose providers (faked AWS): a panel opened on a broker or stream deleted since discovery says so instead of failing", () => {
  const out = withFakeAws<{ broker: { sections: { note?: string }[] }; stream: { sections: { note?: string }[] } }>(
    { "client-mq": "MqClient", "client-firehose": "FirehoseClient" },
    `{
      DescribeBrokerCommand: async () => { throw Object.assign(new Error("Can't find requested broker"), { name: "NotFoundException" }); },
      DescribeDeliveryStreamCommand: async () => { throw Object.assign(new Error("Firehose clicks not found"), { name: "ResourceNotFoundException" }); },
      ListTagsForDeliveryStreamCommand: async () => { throw Object.assign(new Error("Firehose clicks not found"), { name: "ResourceNotFoundException" }); },
    }`,
    `const { mqProvider } = await provider("mq.ts"); const { firehoseProvider } = await provider("firehose.ts");
     const base = { region: "ap-south-1", tags: {}, health: "ok", props: [] };
     const broker = await mqProvider.detail({ ...base, key: "arn:aws:mq:ap-south-1:123456789012:broker:legacy:b-1", kind: "mq-broker", provider: "mq", name: "legacy", aliases: ["b-1"] }, ctx());
     const stream = await firehoseProvider.detail({ ...base, key: "arn:aws:firehose:ap-south-1:123456789012:deliverystream/clicks", kind: "firehose-stream", provider: "firehose", name: "clicks" }, ctx());
     return { broker, stream };`,
  );
  assert.equal(out.broker.sections[0].note, "This broker no longer exists.");
  assert.equal(out.stream.sections[0].note, "This stream no longer exists.");
});
