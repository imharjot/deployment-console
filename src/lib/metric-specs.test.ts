import { test } from "node:test";
import assert from "node:assert/strict";
import { albSpecs, elasticacheSpecs, perMinuteScale, periodFor, rdsSpecs } from "./metric-specs.ts";

test("rdsSpecs: CPU, connections, latency in ms, IOPS, memory in MiB and storage in GiB (F70)", () => {
  const s = rdsSpecs("acme-db");
  assert.deepEqual(s.map((x) => [x.chart, x.label, x.metric, x.stat, x.unit]), [
    ["dbcpu", "CPU", "CPUUtilization", "Average", "%"],
    ["dbconn", "Connections", "DatabaseConnections", "Average", ""],
    ["dblat", "Read", "ReadLatency", "Average", "ms"],
    ["dblat", "Write", "WriteLatency", "Average", "ms"],
    ["dbiops", "Read", "ReadIOPS", "Average", "IOPS"],
    ["dbiops", "Write", "WriteIOPS", "Average", "IOPS"],
    ["dbmem", "Freeable memory", "FreeableMemory", "Minimum", "MiB"],
    ["dbdisk", "Free storage", "FreeStorageSpace", "Minimum", "GiB"],
  ]);
  assert.ok(s.every((x) => x.namespace === "AWS/RDS" && x.dims.DBInstanceIdentifier === "acme-db"));
  const by = (m: string) => s.find((x) => x.metric === m)!;
  assert.equal(by("ReadLatency").scale, 1000);
  // 20 GiB free reads as 20, not 21.47 (the old 1/1e9 "GB").
  assert.equal(20 * 1024 ** 3 * by("FreeStorageSpace").scale!, 20);
  assert.equal(512 * 1024 ** 2 * by("FreeableMemory").scale!, 512);
  assert.equal(by("CPUUtilization").scale, undefined);
  assert.equal(rdsSpecs("acme-db", "orders")[0].label, "orders CPU");
});

test("elasticacheSpecs: per node, with the five metrics that matter", () => {
  const s = elasticacheSpecs("acme-redis-001");
  assert.deepEqual(s.map((x) => [x.metric, x.stat, x.unit]), [
    ["CPUUtilization", "Average", "%"],
    ["EngineCPUUtilization", "Average", "%"],
    ["DatabaseMemoryUsagePercentage", "Average", "%"],
    ["CurrConnections", "Average", ""],
    ["Evictions", "Sum", ""],
  ]);
  assert.ok(s.every((x) => x.namespace === "AWS/ElastiCache" && x.dims.CacheClusterId === "acme-redis-001" && Object.keys(x.dims).length === 1));
  assert.equal(new Set(s.map((x) => x.chart)).size, 5);
});

test("albSpecs: RequestCount on the target group's own load balancer, ELB 503 per load balancer, p95 in ms (R22)", () => {
  const s = albSpecs("targetgroup/acme-api/abc", "app/acme-public/def");
  const by = (m: string) => s.find((x) => x.metric === m)!;
  assert.deepEqual(by("RequestCount").dims, { TargetGroup: "targetgroup/acme-api/abc", LoadBalancer: "app/acme-public/def" });
  assert.equal(by("RequestCount").stat, "Sum");
  assert.ok(!s.some((x) => x.metric === "RequestCountPerTarget"), "never the per-target average as service traffic");
  assert.deepEqual(by("HTTPCode_Target_5XX_Count").dims, { TargetGroup: "targetgroup/acme-api/abc", LoadBalancer: "app/acme-public/def" });
  assert.deepEqual(by("HTTPCode_ELB_503_Count").dims, { LoadBalancer: "app/acme-public/def" });
  assert.equal(by("TargetResponseTime").stat, "p95");
  assert.equal(by("TargetResponseTime").scale, 1000);
  assert.equal(by("TargetResponseTime").unit, "ms");
  // Whole load balancer, and nothing without one (no TargetGroup-only dimension set is published).
  assert.deepEqual(albSpecs(undefined, "app/acme-public/def").find((x) => x.metric === "RequestCount")!.dims, { LoadBalancer: "app/acme-public/def" });
  assert.deepEqual(albSpecs("targetgroup/acme-api/abc"), []);
  assert.ok(albSpecs("tg", "lb", "Storefront API").every((x) => x.label === "Storefront API"));
});

test("perMinuteScale normalises Sum buckets; periodFor matches Cloud.metrics()", () => {
  assert.equal(perMinuteScale(60), 1);
  assert.equal(perMinuteScale(300), 0.2);
  assert.equal(perMinuteScale(3600), 1 / 60);
  // 600 requests in a 5-minute bucket = 120 /min.
  assert.equal(600 * perMinuteScale(periodFor(360)), 120);
  assert.deepEqual([periodFor(60), periodFor(180), periodFor(181), periodFor(1440), periodFor(1441)], [60, 60, 300, 300, 3600]);
});
