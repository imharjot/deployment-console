import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseConfig, type ConsoleConfig } from "./console-config.ts";
import { clusterSkip, configWarnings, healthcheckProblem, nearest, unassignedOf, type WarningInput } from "./discovery-rules.ts";
import type { RawCluster } from "./types.ts";

const cluster = (name: string, o: Partial<RawCluster> = {}): RawCluster => ({
  name, arn: `arn:aws:ecs:us-east-1:123456789012:cluster/${name}`, status: "ACTIVE", tags: {}, activeServices: 1, runningTasks: 1, containerInstances: 0, capacityProviders: ["FARGATE"], ...o,
});

test("clusters discovery leaves out: inactive, ignored (list or tag), AWS Batch's own unless pinned, unpinned with discoverClusters false", () => {
  const none: ConsoleConfig = {};
  assert.equal(clusterSkip(cluster("acme-staging"), none, false), undefined);
  assert.equal(clusterSkip(cluster("acme-old", { status: "INACTIVE" }), none, true), "inactive");
  assert.equal(clusterSkip(cluster("legacy"), { ignoreClusters: ["legacy"] }, true), "ignored", "ignoring wins over pinning");
  assert.equal(clusterSkip(cluster("scratch", { tags: { "console:ignore": "true" } }), none, false), "ignored");
  assert.equal(clusterSkip(cluster("AWSBatch-nightly-exports-3f2a9c1e-5b7d-4e8f-a1b2-c3d4e5f6a7b8"), none, false), "batch");
  assert.equal(clusterSkip(cluster("AWSBatch-nightly-exports-3f2a9c1e"), none, true), undefined, "a config entry may still name one");
  assert.equal(clusterSkip(cluster("acme-staging"), { discoverClusters: false }, false), "undiscovered");
  assert.equal(clusterSkip(cluster("acme-staging"), { discoverClusters: false }, true), undefined);
});

test("nearest: the name a typo most likely meant, or nothing", () => {
  assert.equal(nearest("acme-stagng", ["acme-production", "acme-staging"]), "acme-staging");
  assert.equal(nearest("Acme-Staging", ["acme-staging"]), "acme-staging");
  assert.equal(nearest("staging", ["acme-production", "acme-staging"]), "acme-staging", "a part of a longer name");
  assert.equal(nearest("acme-prd-pg", ["acme-staging-pg", "acme-prod-pg"]), "acme-prod-pg", "closest by edits");
  assert.equal(nearest("acme-pg", ["acme-staging-pg", "acme-prod-pg"]), undefined, "too far from either");
  assert.equal(nearest("billing-db", ["acme-staging-pg", "acme-prod-pg"]), undefined);
  assert.equal(nearest("acme-production-valkey", ["acme-production", "acme-production-001"]), "acme-production", "the group, not its member");
  assert.equal(nearest("acme-stagng", ["acme", "acme-staging"]), "acme-staging", "a close typo beats a short prefix");
  assert.equal(nearest("x", []), undefined);
});

test("health-check URLs: http(s) only, at most 2,048 characters, no credentials or spaces (F33)", () => {
  for (const ok of ["https://api.staging.acme.dev/ready", "http://10.0.0.5:8080/health", `https://acme.dev/${"x".repeat(2000)}`]) assert.equal(healthcheckProblem(ok), undefined, ok);
  assert.match(healthcheckProblem("ftp://files.acme.dev/ready")!, /only http and https/);
  assert.match(healthcheckProblem("file:///etc/passwd")!, /only http and https/);
  assert.match(healthcheckProblem("javascript:alert(1)")!, /only http and https/);
  assert.match(healthcheckProblem("/ready")!, /isn't a URL/);
  assert.match(healthcheckProblem("https://acme.dev/ready now")!, /spaces/);
  assert.match(healthcheckProblem("https://acme.dev/\nready")!, /line breaks/);
  assert.match(healthcheckProblem("https://user:pw@acme.dev/ready")!, /password/);
  assert.match(healthcheckProblem(`https://acme.dev/${"x".repeat(2048)}`)!, /2048/);
});

const base = (config: ConsoleConfig, o: Partial<WarningInput> = {}): WarningInput => ({
  home: "us-east-1",
  regions: ["us-east-1", "eu-west-1"],
  clusters: { "us-east-1": [cluster("acme-staging"), cluster("acme-production")], "eu-west-1": [cluster("acme-production"), cluster("acme-eu")] },
  config,
  envs: [{ id: "staging", region: "us-east-1", cluster: "acme-staging" }, { id: "production", region: "us-east-1", cluster: "acme-production" }],
  databases: { "us-east-1": ["acme-staging-pg", "acme-production-pg"], "eu-west-1": ["acme-eu-pg"] },
  caches: { "us-east-1": ["acme-production-valkey", "acme-production-valkey-001"] },
  ...o,
});

test("config against the account: a configured cluster that isn't there is named, with its region and a guess", () => {
  const w = configWarnings(base({ environments: { qa: { cluster: "acme-stagng" }, dev: { cluster: "acme-dev" } }, workloads: { cron: { name: "Cron", env: "dev" }, api: { name: "API", env: "dev" } } }));
  assert.deepEqual(w, [
    { kind: "environment", scope: "environment qa", env: "qa", region: "us-east-1", message: 'environment "qa": cluster "acme-stagng" not found in us-east-1', hint: 'did you mean "acme-staging"?' },
    {
      kind: "environment", scope: "environment dev", env: "dev", region: "us-east-1",
      message: 'environment "dev": cluster "acme-dev" not found in us-east-1 — its 2 declared workloads appear on the cloud map only', hint: "check the cluster name and the console's region",
    },
  ]);
});

test("config against the account: a cluster in another region, inactive, ignored, or named twice", () => {
  const cfg = parseConfig({
    environments: { eu: { cluster: "acme-eu" }, old: { cluster: "acme-old" }, legacy: { cluster: "acme-legacy" }, stage: { cluster: "acme-staging" }, staging: { cluster: "acme-staging" } },
    ignoreClusters: ["acme-legacy"],
  }).config;
  const clusters = { "us-east-1": [cluster("acme-staging"), cluster("acme-old", { status: "INACTIVE" }), cluster("acme-legacy")], "eu-west-1": [cluster("acme-eu")] };
  const w = configWarnings(base(cfg, { clusters }));
  assert.deepEqual(w.map((x) => [x.env, x.message, x.hint]), [
    ["eu", 'environment "eu": cluster "acme-eu" not found in us-east-1', 'it exists in eu-west-1 — set environments.eu.region to "eu-west-1"'],
    ["old", 'environment "old": cluster "acme-old" in us-east-1 is INACTIVE', "only ACTIVE clusters become environments"],
    ["legacy", 'environment "legacy": cluster "acme-legacy" in us-east-1 is ignored', "remove it from ignoreClusters"],
    ["stage", 'environment "stage": cluster "acme-staging" in us-east-1 is also named by environments.staging', 'only "staging" is used — remove one of the entries'],
  ]);
});

test("config against the account: a region the console doesn't read, or couldn't read, is said so (or left to the errors)", () => {
  const cfg: ConsoleConfig = { environments: { tokyo: { cluster: "acme-tokyo", region: "ap-northeast-1" }, eu: { cluster: "acme-gone", region: "eu-west-1" } } };
  const w = configWarnings(base(cfg, { clusters: { "us-east-1": [], "eu-west-1": undefined } }));
  assert.deepEqual(w, [
    { kind: "region", scope: "environment tokyo", env: "tokyo", region: "ap-northeast-1", message: 'environment "tokyo": region ap-northeast-1 isn\'t one the console reads', hint: "add ap-northeast-1 to CONSOLE_REGIONS or inventory.regions" },
  ], "eu-west-1 didn't answer: its error is reported elsewhere, and nothing is called missing");
});

test("config against the account: databases and caches that match nothing get a 'did you mean'", () => {
  const cfg: ConsoleConfig = {
    environments: {
      staging: { cluster: "acme-staging", databases: ["acme-staging-pg", "acme-stagin-pg"], caches: ["acme-production-valkey-001"] },
      production: { cluster: "acme-production", databases: ["acme-eu-pg"], caches: ["acme-prod-redis"] },
    },
  };
  const w = configWarnings(base(cfg));
  assert.deepEqual(w.map((x) => [x.kind, x.message, x.hint]), [
    ["database", 'environment "staging": database "acme-stagin-pg" not found in us-east-1 (did you mean "acme-staging-pg"?)', "environments.staging.databases lists RDS instance ids"],
    ["database", 'environment "production": database "acme-eu-pg" not found in us-east-1', "it is in eu-west-1; environments.production.databases only matches us-east-1"],
    ["cache", 'environment "production": cache "acme-prod-redis" not found in us-east-1', "environments.production.caches lists ElastiCache replication group or cluster ids"],
  ]);
  assert.deepEqual(configWarnings(base(cfg, { databases: {}, caches: {} })), [], "lists that couldn't be read are not checked");
});

test("the bundled demo config raises no warnings against the simulated account's clusters", () => {
  const { config } = parseConfig(JSON.parse(readFileSync(new URL("../../examples/demo.console.config.json", import.meta.url), "utf8")));
  assert.deepEqual(configWarnings(base(config)), []);
});

test("unassigned: no owner, or an owner without a catalog", () => {
  const items = [{ id: "a" }, { id: "b" }, { id: "c" }];
  const owner = new Map<string, string | undefined>([["a", "staging"], ["b", "gone"], ["c", undefined]]);
  assert.deepEqual(unassignedOf(items, owner, new Set(["staging"])).map((x) => x.id), ["b", "c"]);
});
