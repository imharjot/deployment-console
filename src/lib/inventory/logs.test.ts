import { test } from "node:test";
import assert from "node:assert/strict";
import { conventionWriter, isHiddenGroup, logGroupResults, NEVER_EXPIRE_WARN_BYTES, streamRows, subscriptionRows, type RawLogGroup } from "./logs.ts";
import { infer } from "./infer.ts";
import { keys, type ProviderResult } from "./types.ts";

const ACCT = "123456789012";
const R = "us-east-1";
const EU = "eu-west-1";
const NOW = Date.UTC(2026, 9, 5, 12);
const DAY = 86_400_000;
const SENTINEL = "SECRET_SENTINEL_10c5";
const arn = (name: string, region = R) => `arn:aws:logs:${region}:${ACCT}:log-group:${name}`;
const kms = `arn:aws:kms:${R}:${ACCT}:key/mrk-0acme1234567890abcdef12345678`;
const group = (name: string, o: Partial<RawLogGroup> = {}, region = R): RawLogGroup => ({
  logGroupName: name, logGroupArn: arn(name, region), arn: `${arn(name, region)}:*`, creationTime: NOW - 400 * DAY, storedBytes: 478_939_718,
  retentionInDays: 30, metricFilterCount: 0, logGroupClass: "STANDARD", ...o, ...({ inheritedProperties: [SENTINEL], bearerTokenAuthenticationEnabled: SENTINEL } as object),
});

test("golden: an ECS service's group — retention, size, KMS key, a subscription to Firehose with its role, tags", () => {
  const name = "/ecs/acme-production/api";
  const out = logGroupResults({
    region: R, accountId: ACCT, now: NOW,
    groups: [group(name, { kmsKeyId: kms, metricFilterCount: 2 })],
    subscriptions: { [name]: [{ filterName: "to-lake", logGroupName: name, destinationArn: `arn:aws:firehose:${R}:${ACCT}:deliverystream/logs-to-s3`, roleArn: `arn:aws:iam::${ACCT}:role/cwl-to-firehose`, filterPattern: "ERROR", ...({ fieldSelectionCriteria: SENTINEL } as object) }] },
    subState: { [name]: "ok" },
    tags: { [name]: { Environment: "production" } },
    tagState: { [name]: "ok" },
  });
  assert.deepEqual(out.resources, [{
    key: arn(name), kind: "log-group", provider: "logs", name, region: R, tags: { Environment: "production" }, health: "ok",
    props: [
      { label: "Retention", value: "30 days" },
      { label: "Stored", value: "456.8 MB" },
      { label: "KMS key", value: "mrk-0acme1234567890abcdef12345678" },
      { label: "Metric filters", value: "2" },
      { label: "Subscriptions", value: "to-lake → logs-to-s3" },
      { label: "Created", value: "2025-08-31 12:00 UTC" },
    ],
    aliases: [name, `${arn(name)}:*`],
    consoleUrl: `https://${R}.console.aws.amazon.com/cloudwatch/home?region=${R}#logsV2:log-groups/log-group/$252Fecs$252Facme-production$252Fapi`,
    createdAt: NOW - 400 * DAY, observedAt: NOW, enrichment: { subscriptions: "ok", tags: "ok" },
  }]);
  assert.deepEqual(out.links, [
    { from: arn(name), to: `arn:aws:firehose:${R}:${ACCT}:deliverystream/logs-to-s3`, kind: "event", label: "subscription to-lake", evidence: "log group subscription filter to-lake (pattern ERROR)" },
    { from: arn(name), to: `arn:aws:iam::${ACCT}:role/cwl-to-firehose`, kind: "assumes", label: "delivers subscription to-lake", evidence: "subscription filter to-lake roleArn" },
    { from: kms, to: arn(name), kind: "encrypts", label: "log data", evidence: "log group kmsKeyId" },
  ]);
  assert.deepEqual(out.mentions, []);
  assert.ok(!JSON.stringify(out).includes(SENTINEL), "only the fields the map shows are read");
});

test("never expires with more than 10 GiB is a warning; a retention period or a small group is fine", () => {
  const out = logGroupResults({
    region: R, accountId: ACCT, now: NOW,
    groups: [
      group("/acme/vpc/flow-logs", { retentionInDays: undefined, storedBytes: 14.2 * 1024 ** 3, logGroupClass: "INFREQUENT_ACCESS" }),
      group("/acme/small", { retentionInDays: undefined, storedBytes: NEVER_EXPIRE_WARN_BYTES }),
      group("/acme/kept", { retentionInDays: 3653, storedBytes: 50 * 1024 ** 3 }),
    ],
  });
  const [flow, small, kept] = out.resources;
  assert.deepEqual([flow.health, flow.healthReason], ["warning", "never expires and holds 14.2 GB — set a retention period (storage is billed per GB-month)"]);
  assert.equal(flow.props.find((p) => p.label === "Class")?.value, "infrequent access");
  assert.equal(flow.props.find((p) => p.label === "Retention")?.value, "never expires");
  assert.deepEqual([small.health, kept.health], ["ok", "ok"]);
});

test("Container Insights and vended groups are hidden (listed and resolvable, never drawn); others aren't", () => {
  assert.equal(isHiddenGroup("/aws/ecs/containerinsights/acme-production/performance"), true);
  assert.equal(isHiddenGroup("/aws/vendedlogs/states/acme-production-checkout"), true);
  assert.equal(isHiddenGroup("/aws/lambda/x"), false);
  assert.equal(isHiddenGroup("/ecs/acme-production/api"), false);
  const out = logGroupResults({ region: R, accountId: ACCT, now: NOW, groups: [group("/aws/ecs/containerinsights/acme-production/performance"), group("/ecs/acme-production/api")] });
  assert.deepEqual(out.resources.map((r) => r.hidden), [true, undefined]);
});

test("not read: subscriptions and tags say why, and the group's tags are unread (R01)", () => {
  const name = "/ecs/acme-production/worker";
  const out = logGroupResults({ region: R, accountId: ACCT, now: NOW, groups: [group(name)], subState: { [name]: "capped" }, tagState: { [name]: "denied" } });
  const r = out.resources[0];
  assert.equal(r.props.find((p) => p.label === "Subscriptions")?.value, "subscription filters not read (capped)");
  assert.deepEqual([r.tags, r.tagsUnread, r.enrichment], [{}, true, { subscriptions: "capped", tags: "denied" }]);
  const listed = logGroupResults({ region: R, accountId: ACCT, now: NOW, groups: [group(name)] }).resources[0];
  assert.equal(listed.props.find((p) => p.label === "Subscriptions")?.value, "subscription filters not read (skipped)");
});

test("the key is logGroupArn; without it the ARN loses its ':*'", () => {
  const out = logGroupResults({ region: R, accountId: ACCT, now: NOW, groups: [{ logGroupName: "/x", arn: `${arn("/x")}:*` }, { logGroupName: "/y" }, { arn: "nameless" }] });
  assert.deepEqual(out.resources.map((r) => r.key), [arn("/x"), arn("/y")]);
});

test("naming conventions: who writes to a group, in the group's own region (mentioned links)", () => {
  const w = (name: string, region = R) => conventionWriter(name, region, ACCT)?.ref;
  assert.equal(w("/aws/lambda/acme-production-order-events"), `arn:aws:lambda:${R}:${ACCT}:function:acme-production-order-events`);
  assert.equal(w("/aws/lambda/us-east-1.edge-auth", EU), `arn:aws:lambda:${R}:${ACCT}:function:edge-auth`, "Lambda@Edge replica: the function lives in us-east-1");
  assert.equal(w("/aws/rds/instance/acme-production-pg/postgresql"), `arn:aws:rds:${R}:${ACCT}:db:acme-production-pg`);
  assert.equal(w("/aws/rds/instance/acme-production-eu-pg/postgresql", EU), `arn:aws:rds:${EU}:${ACCT}:db:acme-production-eu-pg`, "region-aware: resolves to rds:<id>@eu-west-1");
  assert.equal(w("/aws/rds/cluster/acme-analytics/postgresql"), `arn:aws:rds:${R}:${ACCT}:cluster:acme-analytics`);
  assert.equal(w("/aws/codebuild/acme-billing-build"), `arn:aws:codebuild:${R}:${ACCT}:project/acme-billing-build`);
  assert.equal(w("/aws/eks/acme-data-platform/cluster"), `arn:aws:eks:${R}:${ACCT}:cluster/acme-data-platform`);
  assert.equal(w("API-Gateway-Execution-Logs_p9q8r7s6t5/prod"), `arn:aws:apigateway:${R}::/restapis/p9q8r7s6t5`);
  assert.equal(w("/aws/rds/instance/x"), undefined, "no log name: not the convention");
  assert.equal(w("/ecs/acme-production/api"), undefined);
  assert.equal(conventionWriter("/aws/lambda/x", R, undefined), undefined, "no account: no ARN to build");
  const out = logGroupResults({ region: R, accountId: ACCT, now: NOW, groups: [group("/aws/lambda/orders")] });
  assert.deepEqual(out.links, [{
    from: `arn:aws:lambda:${R}:${ACCT}:function:orders`, to: arn("/aws/lambda/orders"), kind: "logs", label: "logs (naming convention)",
    evidence: "log group name /aws/lambda/orders (AWS naming convention for Lambda function orders)", confidence: "mentioned",
  }]);
});

test("ECS services → the groups their containers log to (home run): one link per group, other regions by ARN", () => {
  const out = logGroupResults({
    region: R, accountId: ACCT, now: NOW,
    groups: [group("/ecs/acme-production/api")],
    ecs: [
      { service: keys.ecsService("acme-production", "api"), label: "acme-production/api", region: R, taskDef: "api-production:120", containers: [{ name: "api", logGroup: "/ecs/acme-production/api" }, { name: "envoy", logGroup: "/ecs/acme-production/api" }, { name: "init" }] },
      { service: "ecs:service/acme-production/api@eu-west-1", label: "acme-production/api", region: EU, taskDef: "api-production-eu:7", containers: [{ name: "api", logGroup: "/ecs/acme-production-eu/api" }] },
      // awslogs-region names another region than the service's: the link goes there.
      { service: "ecs:service/acme-production/worker@eu-west-1", label: "acme-production/worker", region: EU, taskDef: "worker-eu:3", containers: [{ name: "worker", logGroup: "/ecs/central/worker", logRegion: R }] },
    ],
  });
  assert.deepEqual(out.links, [
    { from: keys.ecsService("acme-production", "api"), to: arn("/ecs/acme-production/api"), kind: "logs", label: "containers api, envoy", evidence: "task definition api-production:120 (awslogs log group)" },
    { from: "ecs:service/acme-production/api@eu-west-1", to: arn("/ecs/acme-production-eu/api", EU), kind: "logs", label: "container api", evidence: "task definition api-production-eu:7 (awslogs log group)" },
    { from: "ecs:service/acme-production/worker@eu-west-1", to: arn("/ecs/central/worker"), kind: "logs", label: "container worker", evidence: "task definition worker-eu:3 (awslogs log group)" },
  ]);
});

test("through infer: the Lambda provider's own logs link and the naming convention merge into one edge (config wins)", () => {
  const fn = `arn:aws:lambda:${R}:${ACCT}:function:orders`;
  const lambda: ProviderResult = {
    resources: [{ key: fn, kind: "lambda", provider: "lambda", name: "orders", region: R, tags: {}, health: "ok", props: [] }],
    links: [{ from: fn, to: arn("/aws/lambda/orders"), kind: "logs", label: "/aws/lambda/orders", evidence: "Lambda's default log group" }],
    mentions: [],
  };
  const groups = logGroupResults({ region: R, accountId: ACCT, now: NOW, groups: [group("/aws/lambda/orders"), group("/aws/vendedlogs/states/checkout")] });
  const out = infer({ results: [lambda, groups], home: R, accountId: ACCT, regions: [R] });
  const edges = out.edges.filter((e) => e.kind === "logs");
  assert.equal(edges.length, 1);
  assert.deepEqual([edges[0].from, edges[0].to, edges[0].confidence], [fn, arn("/aws/lambda/orders"), "config"]);
  // A ":*" reference (how ECS and Step Functions name a group) resolves to the group too.
  const sfn: ProviderResult = { resources: [], links: [{ from: fn, to: `${arn("/aws/vendedlogs/states/checkout")}:*`, kind: "logs", evidence: "x" }], mentions: [] };
  const out2 = infer({ results: [lambda, groups, sfn], home: R, accountId: ACCT, regions: [R] });
  assert.ok(out2.edges.some((e) => e.to === arn("/aws/vendedlogs/states/checkout")));
});

test("detail rows: newest streams first; subscription patterns shortened", () => {
  assert.deepEqual(streamRows([
    { logStreamName: "ecs/api/old", lastEventTimestamp: NOW - DAY, firstEventTimestamp: NOW - 2 * DAY },
    { logStreamName: "ecs/api/new", lastEventTimestamp: NOW, creationTime: NOW - 3_600_000 },
  ]), [["ecs/api/new", "2026-10-05 12:00 UTC", "2026-10-05 11:00 UTC"], ["ecs/api/old", "2026-10-04 12:00 UTC", "2026-10-03 12:00 UTC"]]);
  assert.deepEqual(subscriptionRows([{ filterName: "f", destinationArn: "arn:x", filterPattern: "x".repeat(100) }, { filterName: "all" }]).map((r) => r[2].length), [80, 13]);
});
