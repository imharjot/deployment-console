import { test } from "node:test";
import assert from "node:assert/strict";
import {
  memorydbDetail, memorydbHealth, memorydbResource, memorydbResult, serverlessCacheDetail, serverlessCacheHealth, serverlessCacheResource, serverlessCacheResult,
  type RawMemoryDbCluster, type RawServerlessCache,
} from "./caches.ts";

const ACCT = "123456789012";
const R = "us-east-1";
const NOW = Date.UTC(2026, 9, 5, 12);
const SENTINEL = "SECRET_SENTINEL_ca01";

const sessions: RawServerlessCache = {
  ServerlessCacheName: "sessions", ARN: `arn:aws:elasticache:${R}:${ACCT}:serverlesscache:sessions`, Description: "web sessions", CreateTime: "2026-02-03T04:05:06.000Z",
  Status: "available", Engine: "valkey", MajorEngineVersion: "8", FullEngineVersion: "8.0", CacheUsageLimits: { DataStorage: { Maximum: 10, Unit: "GB" }, ECPUPerSecond: { Maximum: 5000 } },
  KmsKeyId: `arn:aws:kms:${R}:${ACCT}:key/k1`, SecurityGroupIds: ["sg-cache"], SubnetIds: ["subnet-a", "subnet-b"],
  Endpoint: { Address: "sessions-abc.serverless.use1.cache.amazonaws.com", Port: 6379 }, ReaderEndpoint: { Address: "sessions-abc.serverless.use1.cache.amazonaws.com", Port: 6380 },
  SnapshotRetentionLimit: 0, tags: [{ Key: "Environment", Value: "production" }], enrichment: { tags: "ok" },
  ...({ UserGroupId: undefined, AuthToken: SENTINEL, Password: SENTINEL } as object),
};

test("golden: a serverless cache — one endpoint host, network, KMS; nothing secret leaks; no activity", () => {
  const { resource, links } = serverlessCacheResource(sessions, { region: R, account: ACCT, now: NOW });
  assert.deepEqual(resource, {
    key: `arn:aws:elasticache:${R}:${ACCT}:serverlesscache:sessions`, kind: "elasticache-serverless", provider: "elasticache-serverless", name: "sessions", region: R,
    tags: { Environment: "production" }, health: "ok",
    props: [
      { label: "Engine", value: "valkey 8.0" }, { label: "Endpoint", value: "sessions-abc.serverless.use1.cache.amazonaws.com:6379", mono: true }, { label: "Reader port", value: "6380" },
      { label: "Usage limits", value: "up to 10 GB · up to 5,000 ECPU/s" }, { label: "Encryption", value: "KMS key/k1" }, { label: "Snapshots", value: "off" },
      { label: "Description", value: "web sessions" }, { label: "Created", value: "2026-02-03 04:05 UTC" },
    ],
    endpoints: ["sessions-abc.serverless.use1.cache.amazonaws.com"], aliases: ["sessions"], subnetIds: ["subnet-a", "subnet-b"], securityGroups: ["sg-cache"],
    enrichment: { tags: "ok" }, consoleUrl: `https://${R}.console.aws.amazon.com/elasticache/home?region=${R}#/serverless`,
    createdAt: Date.parse("2026-02-03T04:05:06.000Z"), observedAt: NOW,
  });
  assert.deepEqual(links, [{ from: `arn:aws:kms:${R}:${ACCT}:key/k1`, to: resource.key, kind: "encrypts", label: "at rest", evidence: "serverless cache encryption key (KmsKeyId)" }]);
  const detail = serverlessCacheDetail(resource.key, sessions);
  assert.deepEqual(detail.sections.map((s) => s.title), ["Serverless cache", "Endpoints", "Network and security"]);
  assert.deepEqual(detail.sections[1].table?.rows, [["primary", "sessions-abc.serverless.use1.cache.amazonaws.com", "6379"], ["reader", "sessions-abc.serverless.use1.cache.amazonaws.com", "6380"]]);
  assert.ok(!JSON.stringify({ resource, links, detail }).includes(SENTINEL));
});

test("serverless caches: health; unread tags fail closed; an AWS-owned key draws no link", () => {
  assert.deepEqual(["available", "creating", "modifying", "create-failed", "deleting", ""].map((Status) => serverlessCacheHealth({ Status }).health), ["ok", "warning", "warning", "error", "stopped", "unknown"]);
  const out = serverlessCacheResult([{ ServerlessCacheName: "x", Status: "available", enrichment: { tags: "capped" } }, { Status: "available" }], { region: "eu-west-1", account: ACCT });
  assert.equal(out.resources.length, 1);
  const [x] = out.resources;
  assert.deepEqual([x.key, x.tagsUnread, x.tags, x.enrichment, out.links.length], [`arn:aws:elasticache:eu-west-1:${ACCT}:serverlesscache:x`, true, {}, { tags: "capped" }, 0]);
  assert.equal(x.props.find((p) => p.label === "Encryption")?.value, "AWS-owned key");
  assert.equal(serverlessCacheDetail("k", { ServerlessCacheName: "x", enrichment: { tags: "denied" } }).sections[0].rows?.find((r) => r.label === "Tags")?.value, "tags not read (denied)");
});

const limits: RawMemoryDbCluster = {
  Name: "ratelimits", ARN: `arn:aws:memorydb:${R}:${ACCT}:cluster/ratelimits`, Description: "counters", Status: "available", NumberOfShards: 2,
  Shards: [{ Name: "0001", Status: "available", NumberOfNodes: 2 }, { Name: "0002", Status: "available", NumberOfNodes: 2 }], AvailabilityMode: "multiaz",
  ClusterEndpoint: { Address: "clustercfg.ratelimits.abc.memorydb.us-east-1.amazonaws.com", Port: 6379 }, NodeType: "db.r7g.large", Engine: "valkey", EngineVersion: "7.3",
  SecurityGroups: [{ SecurityGroupId: "sg-cache", Status: "active" }], SubnetGroupName: "prod", TLSEnabled: true, KmsKeyId: "alias/memorydb", ACLName: "app-acl",
  SnsTopicArn: `arn:aws:sns:${R}:${ACCT}:ops`, SnsTopicStatus: "active", SnapshotRetentionLimit: 7, SnapshotWindow: "05:00-06:00", tags: [], enrichment: { tags: "ok" },
  ...({ Users: SENTINEL } as object),
};

test("golden: a MemoryDB cluster — endpoint, SGs, KMS and its notification topic; nothing else leaks", () => {
  const { resource, links } = memorydbResource(limits, { region: R, account: ACCT, now: NOW });
  assert.deepEqual(resource, {
    key: `arn:aws:memorydb:${R}:${ACCT}:cluster/ratelimits`, kind: "memorydb-cluster", provider: "memorydb", name: "ratelimits", region: R, tags: {}, health: "ok",
    props: [
      { label: "Engine", value: "valkey 7.3" }, { label: "Shards", value: "2 shards · 4 nodes · db.r7g.large" }, { label: "Availability", value: "Multi-AZ" },
      { label: "Endpoint", value: "clustercfg.ratelimits.abc.memorydb.us-east-1.amazonaws.com:6379", mono: true }, { label: "TLS", value: "on" },
      { label: "Encryption", value: "KMS alias/memorydb" }, { label: "Access control list", value: "app-acl" }, { label: "Subnet group", value: "prod" },
      { label: "Snapshots", value: "7 days · window 05:00-06:00" },
    ],
    endpoints: ["clustercfg.ratelimits.abc.memorydb.us-east-1.amazonaws.com"], aliases: ["ratelimits"], securityGroups: ["sg-cache"], enrichment: { tags: "ok" },
    consoleUrl: `https://${R}.console.aws.amazon.com/memorydb/home?region=${R}#/clusters`, observedAt: NOW,
  });
  assert.deepEqual(links.map((l) => [l.from, l.to, l.kind]), [
    [`arn:aws:kms:${R}:${ACCT}:alias/memorydb`, resource.key, "encrypts"],
    [resource.key, `arn:aws:sns:${R}:${ACCT}:ops`, "event"],
  ]);
  const detail = memorydbDetail(resource.key, limits);
  assert.deepEqual(detail.sections.map((s) => s.title), ["Cluster", "Shards", "Network and security"]);
  assert.ok(!JSON.stringify({ resource, links, detail }).includes(SENTINEL));
});

test("MemoryDB health and unread tags", () => {
  assert.deepEqual(["available", "creating", "updating", "snapshotting", "deleting", undefined].map((Status) => memorydbHealth({ Status }).health), ["ok", "warning", "warning", "warning", "stopped", "unknown"]);
  const [c] = memorydbResult([{ Name: "c", Status: "available", enrichment: { tags: "denied" } }], { region: R, account: ACCT }).resources;
  assert.deepEqual([c.key, c.tagsUnread, c.enrichment], [`arn:aws:memorydb:${R}:${ACCT}:cluster/c`, true, { tags: "denied" }]);
  assert.equal(memorydbDetail("k", undefined).sections[0].note, "This cluster no longer exists.");
});
