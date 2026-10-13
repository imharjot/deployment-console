import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { infer } from "./infer.ts";
import { brokerHosts, mskDetail, mskHosts, mskResult, type RawMskCluster } from "./msk.ts";
import { envMentions } from "./serverless-common.ts";
import { mqResult } from "./streaming.ts";
import type { Resource } from "./types.ts";
import { simMq } from "../server/providers/mock/mq.ts";
import { simMsk } from "../server/providers/mock/msk.ts";

const R = "us-east-1";
const A = "123456789012";
const SENTINEL = "SENTINEL-msk-4c1d7e";
const arn = (name: string) => `arn:aws:kafka:${R}:${A}:cluster/${name}/0acme000-1111-4222-8333-000000000001-1`;
const host = (n: number, name = "orders") => `b-${n}.${name}.abc123.c2.kafka.${R}.amazonaws.com`;
const provisioned = (name: string, o: Partial<RawMskCluster> = {}, p: Partial<NonNullable<RawMskCluster["Provisioned"]>> = {}): RawMskCluster => ({
  ClusterArn: arn(name), ClusterName: name, ClusterType: "PROVISIONED", State: "ACTIVE", Tags: {},
  Provisioned: {
    BrokerNodeGroupInfo: { ClientSubnets: ["subnet-a", "subnet-b"], SecurityGroups: ["sg-kafka"], InstanceType: "kafka.m5.large", StorageInfo: { EbsStorageInfo: { VolumeSize: 100 } } },
    NumberOfBrokerNodes: 2, ZookeeperConnectString: `z-1.${name}.abc123.c2.kafka.${R}.amazonaws.com:2181,z-2.${name}.abc123.c2.kafka.${R}.amazonaws.com:2181`,
    ...p,
  },
  enrichment: { bootstrap: "ok" },
  ...o,
});

// Golden: ListClustersV2 + GetBootstrapBrokers. Neither returns SCRAM secrets; the sentinel sits in fields the mapper
// must never copy (an unknown field and a future one) to prove nothing is passed through wholesale.
const GOLDEN: RawMskCluster[] = [
  provisioned("orders", {
    Tags: { Environment: "production" },
    bootstrap: { BootstrapBrokerStringSaslIam: `${host(1)}:9098,${host(2)}:9098`, BootstrapBrokerStringTls: `${host(1)}:9094,${host(2)}:9094`, BootstrapBrokerStringPublicSaslIam: `b-1-public.orders.abc123.c2.kafka.${R}.amazonaws.com:9198`, Unknown: SENTINEL },
    Secret: SENTINEL,
  } as never, {
    EncryptionInfo: { EncryptionAtRest: { DataVolumeKMSKeyId: `arn:aws:kms:${R}:${A}:key/k-1` } },
    BrokerNodeGroupInfo: { ClientSubnets: ["subnet-a"], SecurityGroups: ["sg-kafka"], ConnectivityInfo: { PublicAccess: { Type: "SERVICE_PROVIDED_EIPS" } } },
    LoggingInfo: { BrokerLogs: { CloudWatchLogs: { Enabled: true, LogGroup: "/msk/orders" }, Firehose: { Enabled: true, DeliveryStream: "msk-logs" }, S3: { Enabled: false, Bucket: "ignored" } } },
    ClientAuthentication: { Sasl: { Iam: { Enabled: true } }, Unauthenticated: { Enabled: false } },
  } as never),
  {
    ClusterArn: arn("events-serverless"), ClusterName: "events-serverless", ClusterType: "SERVERLESS", State: "ACTIVE", Tags: {},
    Serverless: { VpcConfigs: [{ SubnetIds: ["subnet-c"], SecurityGroupIds: ["sg-sl"] }, { SubnetIds: ["subnet-d", "subnet-c"] }], ClientAuthentication: { Sasl: { Iam: { Enabled: true } } } },
    bootstrap: { BootstrapBrokerStringSaslIam: `boot-abc.c2.kafka-serverless.${R}.amazonaws.com:9098` }, enrichment: { bootstrap: "ok" },
  },
  provisioned("creating", { State: "CREATING", StateInfo: { Message: "provisioning brokers" }, bootstrap: undefined, enrichment: { bootstrap: "skipped" }, Tags: undefined }),
  provisioned("broken", { State: "FAILED", StateInfo: { Code: "InsufficientCapacity", Message: "not enough capacity in us-east-1a" } }),
  provisioned("patching", {}, { CustomerActionStatus: "CRITICAL_ACTION_REQUIRED" }),
  provisioned("rebooting", { State: "REBOOTING_BROKER" }),
  provisioned("going", { State: "DELETING" }),
];
const result = () => mskResult(GOLDEN);
const byName = (n: string) => result().resources.find((r) => r.key === arn(n))!;

test("MSK: every broker host of every bootstrap string (and ZooKeeper) is an endpoint, without ports", () => {
  assert.deepEqual(brokerHosts(`${host(1)}:9098, ${host(2)}:9098,${host(1)}:9094`), [host(1), host(2)]);
  const r = byName("orders");
  assert.equal(r.kind, "msk-cluster");
  assert.equal(r.name, "orders");
  assert.deepEqual(r.endpoints, [host(1), host(2), `b-1-public.orders.abc123.c2.kafka.${R}.amazonaws.com`, `z-1.orders.abc123.c2.kafka.${R}.amazonaws.com`, `z-2.orders.abc123.c2.kafka.${R}.amazonaws.com`]);
  assert.ok(!(r.endpoints ?? []).some((e) => e.includes(":")));
  assert.deepEqual(byName("events-serverless").endpoints, [`boot-abc.c2.kafka-serverless.${R}.amazonaws.com`]);
  assert.deepEqual(mskHosts({ bootstrap: undefined }), []);
});

test("MSK: network, facts.public, tags and unread bootstrap brokers", () => {
  const r = byName("orders");
  assert.deepEqual([r.subnetIds, r.securityGroups], [["subnet-a"], ["sg-kafka"]]);
  assert.equal(r.facts?.public, true);
  assert.deepEqual(r.tags, { Environment: "production" });
  const s = byName("events-serverless");
  assert.deepEqual([s.subnetIds, s.securityGroups, s.facts?.public], [["subnet-c", "subnet-d"], ["sg-sl"], false]);
  assert.equal(s.props.find((p) => p.label === "Type")?.value, "Serverless");
  const c = byName("creating");
  assert.equal(c.endpoints?.length, 2, "ZooKeeper hosts only");
  assert.equal(c.props.find((p) => p.label === "Bootstrap brokers")?.value, "brokers not read (skipped)");
  assert.deepEqual(c.enrichment, { bootstrap: "skipped" });
  assert.equal(c.tagsUnread, true);
  assert.equal(r.props.find((p) => p.label === "Authentication")?.value, "IAM");
});

test("MSK: health — ACTIVE ok, transitions warn, FAILED error, critical customer action warns, DELETING stopped", () => {
  const h = (n: string) => [byName(n).health, byName(n).healthReason];
  assert.deepEqual(h("orders"), ["ok", undefined]);
  assert.deepEqual(h("creating"), ["warning", "creating: provisioning brokers"]);
  assert.deepEqual(h("rebooting"), ["warning", "rebooting broker"]);
  assert.deepEqual(h("broken"), ["error", "failed: not enough capacity in us-east-1a"]);
  assert.deepEqual(h("patching"), ["warning", "critical action required (pending patching)"]);
  assert.deepEqual(h("going"), ["stopped", "deleting"]);
});

test("MSK: KMS → cluster (encrypts) and broker logs (log group by name, Firehose by name; disabled S3 ignored)", () => {
  const l = result().links.filter((x) => x.from === arn("orders") || x.to === arn("orders"));
  assert.deepEqual(l.map((x) => [x.from, x.to, x.kind]), [
    [`arn:aws:kms:${R}:${A}:key/k-1`, arn("orders"), "encrypts"],
    [arn("orders"), `arn:aws:logs:${R}:${A}:log-group:/msk/orders`, "logs"],
    [arn("orders"), `arn:aws:firehose:${R}:${A}:deliverystream/msk-logs`, "logs"],
  ]);
  assert.deepEqual(result().mentions, []);
});

test("MSK: no secret sentinel in resources or detail; detail lists brokers per access method", () => {
  assert.ok(!JSON.stringify(result()).includes(SENTINEL));
  const d = mskDetail(arn("orders"), GOLDEN[0]);
  assert.ok(!JSON.stringify(d).includes(SENTINEL));
  assert.deepEqual(d.sections[1].table?.rows.map((r) => r[0]), ["TLS", "SASL/IAM", "Public SASL/IAM"]);
  assert.equal(mskDetail(arn("x"), undefined).sections[0].note, "This cluster no longer exists.");
});

test("MSK: Acme mock — acme-events in us-east-1 only, its IAM brokers resolvable by host", () => {
  const home = mskResult(simMsk("us-east-1"));
  assert.equal(home.resources.length, 1);
  const r = home.resources[0];
  assert.equal(r.name, "acme-events");
  assert.equal(r.health, "ok");
  assert.ok(r.endpoints?.includes("b-1.acme-events.x1y2z3.c2.kafka.us-east-1.amazonaws.com"));
  assert.ok(home.links.some((l) => l.kind === "encrypts" && l.to === r.key));
  assert.deepEqual(mskResult(simMsk("eu-west-1")).resources, []);
  assert.deepEqual(simMsk("ap-south-1"), []);
});

// What the endpoints are for: a service whose variables name the brokers is drawn into the cluster / broker.
test("MSK and MQ: KAFKA_BROKERS and broker URLs in a service's variables resolve to the cluster and the broker", () => {
  const msk = mskResult(simMsk(R));
  const mq = mqResult(simMq(R));
  const svc: Resource = { key: "ecs:service/acme-production/orders", kind: "ecs-service", provider: "ecs", name: "orders", region: R, tags: {}, health: "ok", props: [] };
  const brokers = "b-1.acme-events.x1y2z3.c2.kafka.us-east-1.amazonaws.com:9098,b-2.acme-events.x1y2z3.c2.kafka.us-east-1.amazonaws.com:9098";
  const mqUrl = "failover:(ssl://b-0acme0d4-6666-4777-8888-000000000001-1.mq.us-east-1.amazonaws.com:61617)";
  const vars = { KAFKA_BROKERS: brokers, LEGACY_MQ_URL: mqUrl };
  const { edges } = infer({ results: [{ resources: [svc], links: [], mentions: envMentions(svc.key, vars) }, msk, mq], home: R, accountId: A, regions: [R] });
  const from = edges.filter((e) => e.from === svc.key).map((e) => [e.to, e.kind, e.confidence]);
  assert.deepEqual(from, [[msk.resources[0].key, "stream", "mentioned"], [mq.resources[0].key, "stream", "mentioned"]]);
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

test("MSK provider (faked AWS): pages ListClustersV2, checkpoints, reads brokers per cluster (not while creating), a denial is soft", () => {
  const ARN = (n: string) => `arn:aws:kafka:ap-south-1:123456789012:cluster/${n}/u-${n}`;
  const out = withFakeAws<{ resources: { name: string; endpoints?: string[]; enrichment?: Record<string, string>; tags: Record<string, string>; tagsUnread?: boolean }[]; calls: [string, Record<string, unknown>][]; notes: string[]; checkpoints: { resources: { enrichment?: Record<string, string> }[] }[] }>(
    { "client-kafka": "KafkaClient" },
    `{
      ListClustersV2Command: async (input, n) => n === 0
        ? { ClusterInfoList: [{ ClusterArn: "${ARN("a")}", ClusterName: "a", ClusterType: "SERVERLESS", State: "ACTIVE", Serverless: { VpcConfigs: [{ SubnetIds: ["subnet-1"] }] } }], NextToken: "p2" }
        : { ClusterInfoList: [{ ClusterArn: "${ARN("b")}", ClusterName: "b", ClusterType: "PROVISIONED", State: "CREATING", Tags: { Team: "data" } }, { ClusterArn: "${ARN("c")}", ClusterName: "c", ClusterType: "PROVISIONED", State: "ACTIVE" }] },
      GetBootstrapBrokersCommand: async (input) => { if (input.ClusterArn.includes("/c/")) throw denied("kafka:GetBootstrapBrokers"); return { $metadata: { attempts: 1 }, BootstrapBrokerStringSaslIam: "boot-1.c2.kafka-serverless.ap-south-1.amazonaws.com:9098", Secret: "${SENTINEL}" }; },
    }`,
    `const { mskProvider } = await provider("msk.ts"); return await mskProvider.discover(ctx());`,
  );
  assert.deepEqual(out.calls.map((c) => c[0]), ["ListClustersV2Command", "ListClustersV2Command", "GetBootstrapBrokersCommand", "GetBootstrapBrokersCommand"]);
  assert.deepEqual([out.calls[0][1].MaxResults, out.calls[1][1].NextToken], [100, "p2"]);
  assert.ok(!out.calls.some((c) => c[0] === "GetBootstrapBrokersCommand" && String(c[1].ClusterArn).includes("/b/")), "no brokers to ask for while creating");
  assert.equal(out.checkpoints.length, 1);
  assert.deepEqual(out.checkpoints[0].resources.map((r) => r.enrichment), [{ bootstrap: "skipped" }, undefined, { bootstrap: "skipped" }]);
  const [a, b, c] = out.resources;
  assert.deepEqual([a.endpoints, a.enrichment, a.tags, a.tagsUnread], [["boot-1.c2.kafka-serverless.ap-south-1.amazonaws.com"], { bootstrap: "ok" }, {}, undefined]);
  assert.deepEqual([b.tags, b.endpoints], [{ Team: "data" }, undefined]);
  assert.deepEqual(c.enrichment, { bootstrap: "denied" });
  assert.deepEqual(out.notes, ["msk bootstrap brokers skipped: kafka:GetBootstrapBrokers denied"]);
  assert.ok(!JSON.stringify(out.resources).includes(SENTINEL));
});
