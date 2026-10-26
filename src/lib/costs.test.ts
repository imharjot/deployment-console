import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_RATES, cacheHourly, ec2Hourly, estimateRunRate, fargateHourly, leftovers, monthly, ratesFrom, rdsHourly, usd } from "./costs.ts";
import { LIST_PRICES } from "./list-prices.ts";

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
  assert.equal(cacheHourly("cache.t4g.small")?.toFixed(4), "0.0325"); // scaled from the medium's 0.065
  assert.equal(cacheHourly("cache.t4g.small", "valkey")?.toFixed(4), "0.0260");
  assert.equal(cacheHourly("cache.x9.large"), undefined);
});

test("ratesFrom keeps defaults for missing or non-positive overrides", () => {
  assert.deepEqual(ratesFrom(undefined), DEFAULT_RATES);
  assert.deepEqual(ratesFrom({ multiplier: 1.1, fargateVcpuHour: -1 }), { ...DEFAULT_RATES, multiplier: 1.1 });
  assert.equal(ec2Hourly("t3.micro", ratesFrom({ multiplier: 2 })), 0.0208);
});

test("list prices are the resource's region's; a region the table lacks is priced as us-east-1", () => {
  const r = ratesFrom(undefined, "ap-south-1");
  const table = LIST_PRICES["ap-south-1"];
  assert.deepEqual([r.region, r.fargateVcpuHour, r.fargateGbHour], ["ap-south-1", ...table.fargate!]);
  assert.equal(rdsHourly("db.m7g.large", false, r), table.rds["db.m7g"]);
  assert.ok(rdsHourly("db.m7g.large", false, r)! > 1.3 * rdsHourly("db.m7g.large")!, "RDS in ap-south-1 lists well above us-east-1");
  assert.equal(ec2Hourly("t3a.small", r), table.ec2.t3a / 4);
  assert.equal(cacheHourly("cache.t4g.micro", "valkey", r), (table.cache["cache.t4g"] / 8) * 0.8);
  assert.equal(ratesFrom({ fargateVcpuHour: 0.05 }, "ap-south-1").fargateVcpuHour, 0.05, "console.config.json still wins");
  assert.deepEqual(ratesFrom(undefined, "xx-nowhere-1"), DEFAULT_RATES);
  for (const [region, p] of Object.entries(LIST_PRICES)) assert.ok(p.fargate && Object.keys(p.ec2).length && Object.keys(p.rds).length, region);
});

test("leftovers: the inventory's tag-only environments and loose resources, minus what was already priced", () => {
  const props = (o: Record<string, string>) => Object.entries(o).map(([label, value]) => ({ label, value }));
  const got = leftovers(
    [
      { id: "i-0123456789abcdef0", kind: "ec2-instance", name: "acme-staging-box", region: "eu-west-1", env: "staging", props: props({ Type: "t3a.small", State: "running" }) },
      { id: "acme-staging-pg", kind: "rds", name: "acme-staging-pg", region: "eu-west-1", env: "staging", props: props({ Engine: "postgres 16.4", Class: "db.t4g.small", "Multi-AZ": "no", Status: "available" }) },
      { id: "acme-production-pg", kind: "rds", name: "acme-production-pg", region: "eu-west-1", env: "production", props: props({ Engine: "postgres 16.4", Class: "db.m7g.large", "Multi-AZ": "no", Status: "available" }) },
      { id: "acme-sessions", kind: "elasticache", name: "acme-sessions", region: "us-east-1", props: props({ Engine: "valkey 8.1.0", "Node type": "cache.t4g.micro", Nodes: "2", Status: "available" }) },
      { id: "acme-assets", kind: "s3", name: "acme-assets", region: "eu-west-1", env: "staging", props: [] },
    ],
    new Set(["database:acme-production-pg"]),
  );
  assert.deepEqual(got.map((g) => [g.env, g.region, g.hosts.length, g.databases.length, g.caches.length]), [["staging", "eu-west-1", 1, 1, 0], ["", "us-east-1", 0, 0, 1]]);
  assert.deepEqual(got[0].databases[0], { id: "acme-staging-pg", instanceClass: "db.t4g.small", multiAz: false, status: "available", engine: "postgres" });
  assert.deepEqual(got[1].caches[0], { id: "acme-sessions", nodeType: "cache.t4g.micro", nodes: 2, engine: "valkey", status: "available" });
  const staging = estimateRunRate({ services: [], ...got[0] }, ratesFrom(undefined, got[0].region));
  const p = LIST_PRICES["eu-west-1"];
  assert.equal(staging.monthly.toFixed(6), monthly(p.ec2.t3a / 4 + p.rds["db.t4g"] / 4).toFixed(6));
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
