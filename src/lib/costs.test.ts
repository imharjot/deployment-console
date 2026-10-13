import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_RATES, cacheHourly, ec2Hourly, estimateRunRate, fargateHourly, monthly, ratesFrom, rdsHourly, usd } from "./costs.ts";

test("list-price estimates: Fargate, EC2 sizes, RDS, unknown types", () => {
  assert.equal(fargateHourly(1024, 2048).toFixed(5), (0.04048 + 2 * 0.004445).toFixed(5));
  assert.ok(fargateHourly(1024, 2048, true) < fargateHourly(1024, 2048));
  assert.equal(ec2Hourly("t3.micro"), 0.0104);
  assert.equal(ec2Hourly("m5.2xlarge"), 0.384);
  assert.equal(ec2Hourly("x9.large"), undefined);
  assert.equal(rdsHourly("db.t4g.micro")?.toFixed(4), "0.0161");
  assert.equal(rdsHourly("db.t4g.micro", true)! / rdsHourly("db.t4g.micro")!, 2);
  assert.equal(Math.round(monthly(0.1)), 73);
  assert.equal(usd(12.345), "$12.35");
  assert.equal(usd(1234.5), "$1,235");
});

test("cache prices: node size scaling, Valkey discount, unknown node types", () => {
  assert.equal(cacheHourly("cache.t4g.small")?.toFixed(3), "0.032");
  assert.equal(cacheHourly("cache.t4g.small", "valkey")?.toFixed(4), "0.0256");
  assert.equal(cacheHourly("cache.x9.large"), undefined);
});

test("ratesFrom keeps defaults for missing or non-positive overrides", () => {
  assert.deepEqual(ratesFrom(undefined), DEFAULT_RATES);
  assert.deepEqual(ratesFrom({ multiplier: 1.1, fargateVcpuHour: -1 }), { ...DEFAULT_RATES, multiplier: 1.1 });
  assert.equal(ec2Hourly("t3.micro", ratesFrom({ multiplier: 2 })), 0.0208);
});

test("run-rate estimate: Fargate by size × running, EC2 services ride on their host, stopped things cost nothing", () => {
  const est = estimateRunRate({
    services: [
      { name: "api", label: "Storefront API", launchType: "FARGATE", running: 2, cpu: "1024", memory: "2048" },
      { name: "arm", launchType: "UNKNOWN", launchTypes: ["FARGATE"], running: 1, cpu: "1 vCPU", memory: "2 GB", arch: "arm64" },
      { name: "caddy", launchType: "EC2", running: 1, cpu: "128", memory: "64" },
      { name: "nosize", launchType: "FARGATE", running: 1 },
      { name: "idle", launchType: "FARGATE", running: 0, cpu: "256", memory: "512" },
    ],
    hosts: [{ id: "i-1", name: "box", type: "t3a.small", state: "running" }, { id: "i-2", name: "off", type: "t3a.small", state: "stopped" }],
    databases: [{ id: "pg", instanceClass: "db.t4g.micro", multiAz: true, status: "available", engine: "postgres" }, { id: "old", instanceClass: "db.m5.large", multiAz: false, status: "stopped", engine: "mysql" }],
    caches: [{ id: "kv", nodeType: "cache.t4g.small", nodes: 2, engine: "redis", status: "available" }, { id: "odd", nodeType: "cache.x1.large", nodes: 1, engine: "redis", status: "available" }],
  });
  const by = (id: string) => est.items.find((x) => x.id === id)!;
  assert.equal(by("api").monthly!.toFixed(2), monthly(2 * fargateHourly(1024, 2048)).toFixed(2));
  assert.equal(by("api").name, "Storefront API");
  assert.match(by("api").detail, /^2 × 1 vCPU · 2 GB · Fargate$/);
  assert.equal(by("arm").monthly!.toFixed(4), monthly(fargateHourly(1024, 2048, true)).toFixed(4), "ARM and '1 vCPU'/'2 GB' spellings");
  assert.equal(by("caddy").monthly, null);
  assert.equal(by("caddy").note, "counted with its EC2 host");
  assert.equal(by("nosize").monthly, null);
  assert.equal(by("idle").monthly, 0);
  assert.equal(by("i-1").monthly, monthly(ec2Hourly("t3a.small")!));
  assert.equal(by("i-2").monthly, 0);
  assert.equal(by("pg").monthly, monthly(rdsHourly("db.t4g.micro", true)!));
  assert.equal(by("old").monthly, 0);
  assert.equal(by("kv").monthly, monthly(cacheHourly("cache.t4g.small")! * 2));
  assert.deepEqual(est.unpriced, ["nosize", "odd"], "EC2-hosted services are not 'unpriced'");
  assert.equal(est.monthly.toFixed(6), est.items.reduce((a, x) => a + (x.monthly ?? 0), 0).toFixed(6));
});
