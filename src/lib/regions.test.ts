import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_REGIONS, parseRegions, regionalIds, resolveAllEnabled } from "./regions.ts";

test("precedence: CONSOLE_REGIONS, then config inventory.regions, then the home region", () => {
  assert.deepEqual(parseRegions("eu-west-1", ["ap-south-1"], "us-east-1"), { regions: ["us-east-1", "eu-west-1"], allEnabled: false, problems: [] });
  assert.deepEqual(parseRegions(undefined, ["ap-south-1"], "us-east-1").regions, ["us-east-1", "ap-south-1"]);
  assert.deepEqual(parseRegions("", ["ap-south-1"], "us-east-1").regions, ["us-east-1", "ap-south-1"], "an empty variable counts as unset");
  assert.deepEqual(parseRegions("  ", undefined, "us-east-1"), { regions: ["us-east-1"], allEnabled: false, problems: [] });
  assert.deepEqual(parseRegions(undefined, [], "ap-south-1").regions, ["ap-south-1"]);
});

test("home first, de-duplicated, trimmed and lower-cased", () => {
  assert.deepEqual(parseRegions(" eu-west-1 , US-EAST-1,eu-west-1,, ap-south-1 ", undefined, "us-east-1").regions, ["us-east-1", "eu-west-1", "ap-south-1"]);
  assert.deepEqual(parseRegions(undefined, ["eu-west-1", "us-east-1"], "us-east-1").regions, ["us-east-1", "eu-west-1"]);
  assert.deepEqual(parseRegions("us-gov-west-1", undefined, "us-gov-east-1").regions, ["us-gov-east-1", "us-gov-west-1"]);
});

test("invalid codes are dropped and reported; at most 30 regions", () => {
  const r = parseRegions("eu-west-1,europe,us-east-1a,eu_west_2", undefined, "us-east-1");
  assert.deepEqual(r.regions, ["us-east-1", "eu-west-1"]);
  assert.equal(r.problems.length, 1);
  assert.match(r.problems[0], /CONSOLE_REGIONS: "europe", "us-east-1a", "eu_west_2" are not region codes/);
  const many = Array.from({ length: 40 }, (_, i) => `xx-r${String.fromCharCode(97 + Math.floor(i / 10))}-${i % 10}`); // 40 distinct codes
  const capped = parseRegions(undefined, many, "us-east-1");
  assert.equal(capped.regions.length, MAX_REGIONS);
  assert.equal(capped.regions[0], "us-east-1");
  assert.match(capped.problems.join(" "), /at most 30/);
  assert.match(parseRegions(undefined, undefined, "nowhere").problems[0], /home region "nowhere"/);
});

test("all-enabled: from the variable or the config, resolved by the account", () => {
  assert.deepEqual(parseRegions("all-enabled", ["eu-west-1"], "us-east-1"), { regions: ["us-east-1"], allEnabled: true, problems: [] });
  assert.deepEqual(parseRegions(" ALL-ENABLED ", undefined, "us-east-1").allEnabled, true);
  assert.deepEqual(parseRegions(undefined, "all-enabled", "ap-south-1"), { regions: ["ap-south-1"], allEnabled: true, problems: [] });
  assert.deepEqual(parseRegions("eu-west-1", "all-enabled", "us-east-1"), { regions: ["us-east-1", "eu-west-1"], allEnabled: false, problems: [] }, "the variable wins");
  assert.deepEqual(resolveAllEnabled("us-east-1", ["us-west-2", "eu-west-1", "us-east-1"]).regions, ["us-east-1", "eu-west-1", "us-west-2"]);
});

test("env ids stay unique across regions: the non-home copy gets -<region>", () => {
  const env = (id: string, region: string, source: "discovered" | "config" = "discovered") => ({ id, label: id[0].toUpperCase() + id.slice(1), region, source });
  const out = regionalIds([env("staging", "us-east-1", "config"), env("production", "us-east-1"), env("production", "eu-west-1"), env("qa", "eu-west-1"), env("production", "ap-south-1")], "us-east-1");
  assert.deepEqual(out.map((e) => [e.id, e.label, e.region]), [
    ["staging", "Staging", "us-east-1"],
    ["production", "Production", "us-east-1"],
    ["production-eu-west-1", "Production (eu-west-1)", "eu-west-1"],
    ["qa", "Qa", "eu-west-1"],
    ["production-ap-south-1", "Production (ap-south-1)", "ap-south-1"],
  ]);
  // A config pin wins over a discovered env elsewhere, and a pinned env in another region keeps its id.
  const pinned = regionalIds([env("production", "us-east-1"), env("eu", "eu-west-1", "config"), env("eu", "ap-south-1")], "us-east-1");
  assert.deepEqual(pinned.map((e) => e.id), ["production", "eu", "eu-ap-south-1"]);
  // A config entry pinning "production" to eu-west-1's cluster: the home cluster discovered as "production" steps aside
  // (two envs with one id would make one of them unreachable).
  const away = regionalIds([env("production", "us-east-1"), env("production", "eu-west-1", "config")], "us-east-1");
  assert.deepEqual(away.map((e) => [e.id, e.label]), [["production-us-east-1", "Production (us-east-1)"], ["production", "Production"]]);
  // Even a generated id can't collide.
  const twice = regionalIds([env("production", "us-east-1"), env("production-eu-west-1", "us-east-1"), env("production", "eu-west-1")], "us-east-1");
  assert.deepEqual(twice.map((e) => e.id), ["production", "production-eu-west-1", "production-eu-west-1-2"]);
  // One region: nothing changes, not even duplicates (today's behaviour).
  const one = [env("production", "us-east-1"), env("production", "us-east-1")];
  assert.deepEqual(regionalIds(one, "us-east-1"), one);
});

// Discovery across regions, against AWS-shaped fake Clouds (CONSOLE_SOURCE=aws, nothing reaches AWS). discovery.ts
// imports "server-only", so the scenario runs in a child process under the react-server condition.
const discovery = new URL("./server/discovery.ts", import.meta.url).href;
const scenario = `
const svc = (name, cluster, sg) => ({ name, cluster, status: "ACTIVE", desired: 1, running: 1, pending: 0, launchType: "FARGATE", deployments: [], tasks: [],
  taskDef: { arn: "arn:td/" + name, family: name, revision: 1, image: "nginx:1", launchTypes: ["FARGATE"], ports: [80], main: name,
    containers: [{ name, image: "nginx:1", essential: true, ports: [80], envHosts: [] }] },
  targetGroupArns: [], circuitBreaker: true, tags: {}, securityGroups: [sg], subnets: [] });
const db = (id, sg) => ({ id, status: "available", engine: "postgres", engineVersion: "16", instanceClass: "db.t4g.small", storageGb: 20, multiAz: false, port: 5432, securityGroups: [sg], tags: {} });
const calls = [];
const fake = (region, o) => ({
  kind: "aws", region,
  clusters: async () => { calls.push("clusters@" + region); if (o.down) throw Object.assign(new Error("The security token included in the request is invalid"), { name: "UnrecognizedClientException" }); return o.clusters.map((name) => ({ name, arn: "arn:aws:ecs:" + region + ":123456789012:cluster/" + name, status: "ACTIVE", tags: {}, activeServices: 1, runningTasks: 1, containerInstances: 0, capacityProviders: ["FARGATE"] })); },
  services: async (cluster) => { calls.push("services@" + region); return o.services[cluster] ?? []; },
  hosts: async () => [], databases: async () => o.dbs ?? [], caches: async () => [],
  securityGroups: async (ids) => ids.map((id) => ({ id, name: id, inbound: id.endsWith("-db") ? [{ fromPort: 5432, toPort: 5432, groups: [id.replace("-db", "-app")] }] : [] })),
  subnetVpcs: async () => ({}),
});
globalThis.__consoleCloud = Promise.resolve(fake("ap-south-1", { clusters: ["acme-production", "acme-staging"], services: { "acme-production": [svc("api", "acme-production", "sg-home-app")], "acme-staging": [svc("api", "acme-staging", "sg-stg-app")] }, dbs: [db("acme-production-pg", "sg-home-db")] }));
globalThis.__consoleClouds = new Map([
  ["eu-west-1", Promise.resolve(fake("eu-west-1", { clusters: ["acme-production"], services: { "acme-production": [svc("api", "acme-production", "sg-eu-app"), svc("worker", "acme-production", "sg-eu-app")] }, dbs: [db("acme-production-pg", "sg-eu-db")] }))],
  ["us-west-2", Promise.resolve(fake("us-west-2", { down: true, clusters: [] }))],
]);
const d = await import(${JSON.stringify(discovery)});
const out = {};
out.envs = (await d.listEnvs()).map((e) => [e.id, e.label, e.region, e.cluster, e.source]);
const inv = await d.inventory();
out.catalogs = [...inv.catalogs].map(([id, c]) => [id, c.env.region, [...c.meta.keys()], c.databases.map((x) => x.id)]);
out.errors = inv.errors;
out.regionsAsked = [...new Set(calls.map((c) => c.split("@")[1]))].sort(); // by listEnvs and inventory
out.eu = (await d.servicesOf("acme-production", "eu-west-1")).map((s) => s.name);
out.home = (await d.servicesOf("acme-production")).map((s) => s.name);
out.keys = [d.inRegion("acme-production", "ap-south-1"), d.inRegion("acme-production", "eu-west-1"), d.inRegion("acme-production")];
const before = calls.filter((c) => c === "clusters@us-west-2").length;
await d.listEnvs();
out.downRetried = calls.filter((c) => c === "clusters@us-west-2").length - before;
// A region from an ARN or a client-held id that isn't a region code never gets a Cloud (nor its own SDK clients).
const { getCloud } = await import(${JSON.stringify(new URL("./server/sources.ts", import.meta.url).href)});
out.badRegion = await getCloud("evil.example.com/x").then(() => "built", (e) => e.status + " " + e.message);
out.global = (await getCloud("global")).region;
process.stdout.write(JSON.stringify(out));
`;

test("multi-region discovery (AWS-shaped): ids, per-region catalogs and attribution, a region that fails is skipped", async () => {
  const { execFileSync } = await import("node:child_process");
  const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const dir = mkdtempSync(path.join(tmpdir(), "dc-regions-"));
  try {
    const config = path.join(dir, "console.config.json");
    writeFileSync(config, JSON.stringify({ environments: { staging: { cluster: "acme-staging" } } }));
    const env = { ...process.env, CONSOLE_SOURCE: "aws", AWS_REGION: "ap-south-1", CONSOLE_REGIONS: "ap-south-1,eu-west-1,us-west-2", CONSOLE_CONFIG: config, GITHUB_OWNER: "", ECS_CONTAINER_METADATA_URI_V4: "", CONSOLE_SELF: "" };
    const out = JSON.parse(execFileSync(process.execPath, ["--conditions=react-server", "--no-warnings", "--input-type=module", "-e", scenario], { encoding: "utf8", timeout: 60_000, env }));
    assert.deepEqual(out.envs, [
      ["staging", "Staging", "ap-south-1", "acme-staging", "config"],
      ["production", "Production", "ap-south-1", "acme-production", "discovered"],
      ["production-eu-west-1", "Production (eu-west-1)", "eu-west-1", "acme-production", "discovered"],
    ]);
    // Same cluster and database names in two regions: each env sees its own region's services and database.
    assert.deepEqual(out.catalogs.sort(), [
      ["production", "ap-south-1", ["api"], ["acme-production-pg"]],
      ["production-eu-west-1", "eu-west-1", ["api", "worker"], ["acme-production-pg"]],
      ["staging", "ap-south-1", ["api"], []],
    ]);
    assert.deepEqual(out.eu, ["api", "worker"]);
    assert.deepEqual(out.home, ["api"]);
    assert.deepEqual(out.keys, ["acme-production", "acme-production@eu-west-1", "acme-production"]);
    assert.equal(out.errors.length, 1);
    assert.match(out.errors[0], /^us-west-2: ECS clusters: UnrecognizedClientException: The security token/);
    assert.equal(out.downRetried, 0, "a failed region isn't asked again for a minute");
    assert.match(out.badRegion, /^400 "evil\.example\.com\/x" is not an AWS region/);
    assert.equal(out.global, "ap-south-1");
    // Single region (no CONSOLE_REGIONS, nothing in the config): exactly the home region, as before multi-region.
    const one = JSON.parse(execFileSync(process.execPath, ["--conditions=react-server", "--no-warnings", "--input-type=module", "-e", scenario], { encoding: "utf8", timeout: 60_000, env: { ...env, CONSOLE_REGIONS: "" } }));
    assert.deepEqual(one.envs, out.envs.slice(0, 2));
    assert.deepEqual(one.catalogs.map((c: unknown[]) => c[0]).sort(), ["production", "staging"]);
    assert.deepEqual(one.errors, []);
    assert.deepEqual(one.regionsAsked, ["ap-south-1"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("all-enabled asks the account once (cached a day); a failure falls back to the home region and says so", async () => {
  const { execFileSync } = await import("node:child_process");
  const regions = new URL("./server/regions.ts", import.meta.url).href;
  const script = `
    let calls = 0, fail = false;
    globalThis.__consoleCloud = Promise.resolve({ kind: "aws", region: "ap-south-1", enabledRegions: async () => { calls++; if (fail) throw new Error("UnauthorizedOperation: not authorized to perform: ec2:DescribeRegions"); return ["us-east-1", "eu-west-1", "ap-south-1"]; } });
    const { consoleRegions } = await import(${JSON.stringify(regions)});
    const out = { first: await consoleRegions(), second: await consoleRegions(), calls };
    globalThis.__consoleEnabledRegions = undefined; fail = true;
    out.failed = await consoleRegions();
    out.failedAgain = await consoleRegions();
    out.callsAfter = calls;
    process.stdout.write(JSON.stringify(out));
  `;
  const env = { ...process.env, CONSOLE_SOURCE: "aws", AWS_REGION: "ap-south-1", CONSOLE_REGIONS: "all-enabled", CONSOLE_CONFIG: "" };
  const out = JSON.parse(execFileSync(process.execPath, ["--conditions=react-server", "--no-warnings", "--input-type=module", "-e", script], { encoding: "utf8", timeout: 60_000, env }));
  assert.deepEqual(out.first, { home: "ap-south-1", regions: ["ap-south-1", "eu-west-1", "us-east-1"], allEnabled: true, source: "env" });
  assert.deepEqual(out.second, out.first);
  assert.equal(out.calls, 1);
  assert.deepEqual(out.failed.regions, ["ap-south-1"]);
  assert.match(out.failed.problems[0], /all-enabled: couldn't list the account's regions .*DescribeRegions.* reading the home region only/);
  assert.equal(out.callsAfter, 2, "a failure is retried after 5 minutes, not on every call");
});
