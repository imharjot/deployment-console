import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseConfig } from "./console-config.ts";

test("no file or an empty object is a valid, empty config", () => {
  assert.deepEqual(parseConfig(undefined), { config: {}, errors: [] });
  assert.deepEqual(parseConfig(null), { config: {}, errors: [] });
  assert.deepEqual(parseConfig({}), { config: {}, errors: [] });
  assert.deepEqual(parseConfig({ $schema: "./console.config.schema.json" }), { config: {}, errors: [] });
});

test("a non-object config is one error, never a throw", () => {
  for (const raw of [[], "staging", 42, true]) assert.deepEqual(parseConfig(raw), { config: {}, errors: ["config must be a JSON object"] });
});

test("unknown top-level keys are reported, the rest still applies", () => {
  const r = parseConfig({ enviroments: {}, ignoreClusters: ["legacy"] });
  assert.deepEqual(r.errors, ['unknown key "enviroments"']);
  assert.deepEqual(r.config.ignoreClusters, ["legacy"]);
});

test("environments: id shape and cluster are required; valid entries survive invalid siblings", () => {
  const r = parseConfig({
    environments: {
      staging: { cluster: "acme-staging", branch: "main", protected: false, order: 1, databases: ["acme-pg"], caches: ["acme-redis"], routes: [{ host: "api.staging.acme.dev", service: "api", port: 3000 }] },
      Prod: { cluster: "acme-prod" },
      qa: { label: "QA" },
      uat: "acme-uat",
    },
  });
  assert.deepEqual(r.config.environments, {
    staging: { cluster: "acme-staging", branch: "main", protected: false, order: 1, databases: ["acme-pg"], caches: ["acme-redis"], routes: [{ host: "api.staging.acme.dev", service: "api", port: 3000 }] },
  });
  assert.deepEqual(r.errors, [
    "environments.Prod: id must be lowercase letters, digits and dashes",
    'environments.qa: one of "cluster" (ECS cluster name) or "host" (EC2 instance id of a docker compose box) is required',
    'environments.uat: one of "cluster" (ECS cluster name) or "host" (EC2 instance id of a docker compose box) is required',
  ]);
});

test("environments: a docker compose box is pinned by its EC2 instance id instead of a cluster", () => {
  assert.deepEqual(parseConfig({ environments: { staging: { host: "i-0123456789abcdef0", databases: ["pg"] } } }), { config: { environments: { staging: { host: "i-0123456789abcdef0", databases: ["pg"] } } }, errors: [] });
  const one = 'environments.qa: one of "cluster" (ECS cluster name) or "host" (EC2 instance id of a docker compose box) is required';
  assert.deepEqual(parseConfig({ environments: { qa: { cluster: "c", host: "i-0123456789abcdef0" } } }).errors, [one], "never both");
  assert.deepEqual(parseConfig({ environments: { qa: { host: "box-1" } } }).errors, ["environments.qa.host must be an EC2 instance id (i-…)"]);
});

test("environments: wrongly typed fields are never applied, and every one is reported (F05)", () => {
  const r = parseConfig({ environments: { dev: { cluster: "c", label: 3, protected: "yes", branch: "", order: "1", databases: "pg", caches: [1], routes: [{ host: "h" }], prod: true } } });
  assert.deepEqual(r.config.environments, { dev: { cluster: "c" } }, "nothing of the wrong type is applied");
  assert.deepEqual(r.errors, [
    'unknown key "environments.dev.prod"',
    "environments.dev.label must be a non-empty string",
    "environments.dev.protected must be true or false",
    "environments.dev.branch must be a branch name",
    "environments.dev.order must be a number",
    "environments.dev.databases must be a list of ids",
    "environments.dev.caches must be a list of ids",
    "environments.dev.routes must be [{ host, service, port? }]",
  ]);
  assert.deepEqual(parseConfig({ environments: { dev: { cluster: "c", order: Number.NaN } } }).errors, ["environments.dev.order must be a number"]);
  assert.deepEqual(parseConfig({ environments: { dev: { cluster: " " } } }).errors, ['environments.dev: one of "cluster" (ECS cluster name) or "host" (EC2 instance id of a docker compose box) is required']);
});

test("environments: a correctly typed entry has no errors", () => {
  const r = parseConfig({ environments: { production: { cluster: "acme-production", label: "Production", protected: true, branch: "release", order: 2 } } });
  assert.deepEqual(r, { config: { environments: { production: { cluster: "acme-production", label: "Production", protected: true, branch: "release", order: 2 } } }, errors: [] });
});

test("discoverClusters and ignoreClusters are type-checked", () => {
  assert.deepEqual(parseConfig({ discoverClusters: false }).config, { discoverClusters: false });
  assert.deepEqual(parseConfig({ discoverClusters: "no" }).errors, ["discoverClusters must be true or false"]);
  assert.deepEqual(parseConfig({ ignoreClusters: "legacy" }).errors, ["ignoreClusters must be a list of cluster names"]);
});

test("services: repo must be owner/name, healthcheck a URL or per-env map", () => {
  const r = parseConfig({
    services: {
      api: { name: "Storefront API", repo: "acme/storefront-api", healthcheck: { staging: "https://api.staging.acme.dev/ready" }, migrations: ["db/migrate/"], infra: false, hidden: false },
      worker: { repo: "https://github.com/acme/jobs", healthcheck: 5, migrations: "db/" },
      redis: "infra",
    },
  });
  assert.deepEqual(r.config.services, {
    api: { name: "Storefront API", repo: "acme/storefront-api", healthcheck: { staging: "https://api.staging.acme.dev/ready" }, migrations: ["db/migrate/"], infra: false, hidden: false },
    worker: {},
  });
  assert.deepEqual(r.errors, [
    'services.worker.repo must look like "owner/name"',
    "services.worker.healthcheck must be an http(s) URL or { envId: URL }",
    "services.worker.migrations must be a list of paths",
    "services.redis must be an object",
  ]);
  assert.deepEqual(parseConfig({ services: { api: { healthcheck: "https://x/health" } } }).config.services, { api: { healthcheck: "https://x/health" } });
});

test("services: health checks are http(s) URLs of at most 2,048 characters (F33); flags are booleans", () => {
  const bad = parseConfig({
    services: {
      a: { healthcheck: "ftp://files.acme.dev/ready" },
      b: { healthcheck: { staging: "https://ok.acme.dev/ready", production: "file:///etc/passwd" } },
      c: { healthcheck: `https://acme.dev/${"x".repeat(2048)}` },
      d: { name: 5, infra: "yes", hidden: 1 },
    },
  });
  assert.deepEqual(bad.config.services, { a: {}, b: {}, c: {}, d: {} });
  assert.deepEqual(bad.errors, [
    "services.a.healthcheck must be an http(s) URL or { envId: URL }",
    "services.b.healthcheck must be an http(s) URL or { envId: URL }",
    "services.c.healthcheck must be an http(s) URL or { envId: URL }",
    "services.d.name must be a string",
    "services.d.infra must be true or false",
    "services.d.hidden must be true or false",
  ]);
});

test("externals need a label; side is source, destination or unset", () => {
  const r = parseConfig({ externals: { stripe: { label: "Stripe", sub: "payments", side: "destination", note: "charges" }, crm: { label: "CRM", side: "left" }, nolabel: { sub: "x" } } });
  assert.deepEqual(r.config.externals, {
    stripe: { label: "Stripe", sub: "payments", note: "charges", side: "destination" },
    crm: { label: "CRM", sub: undefined, note: undefined, side: undefined },
  });
  assert.deepEqual(r.errors, ['externals.crm.side must be "source" or "destination"', 'externals.nolabel: "label" is required']);
});

test("connections: from/to required, kind from the known list, envs optional but a list", () => {
  const r = parseConfig({
    connections: [
      { from: "service:api", to: "ext:stripe", label: "charges", kind: "api", envs: ["production"] },
      { from: "service:api" },
      { from: "ingress", to: "service:api", kind: "grpc" },
      { from: "service:worker", to: "db", envs: "staging" },
    ],
  });
  assert.deepEqual(r.config.connections, [{ from: "service:api", to: "ext:stripe", label: "charges", kind: "api", envs: ["production"] }]);
  assert.deepEqual(r.errors, ['connections[1]: "from" and "to" are required', "connections[2].kind must be one of http, sql, cache, stream, api", "connections[3].envs must be a list of environment ids"]);
  assert.deepEqual(parseConfig({ connections: [{ from: "a", to: "b" }] }).config.connections, [{ from: "a", to: "b", label: undefined, kind: undefined, envs: undefined }]);
  assert.deepEqual(parseConfig({ connections: {} }).errors, ["connections must be a list"]);
});

test("github.owner is read when it is a user or organisation name; anything else is reported", () => {
  assert.deepEqual(parseConfig({ github: { owner: "acme" } }), { config: { github: { owner: "acme" } }, errors: [] });
  assert.deepEqual(parseConfig({ github: {} }), { config: {}, errors: [] });
  for (const github of [{ owner: 7 }, { owner: "acme/api" }, "acme"]) assert.deepEqual(parseConfig({ github }), { config: {}, errors: ['github must be { owner: "<GitHub user or organisation>" }'] });
});

test("the bundled demo config parses without errors", async () => {
  const { readFile } = await import("node:fs/promises");
  const raw = JSON.parse(await readFile(new URL("../../examples/demo.console.config.json", import.meta.url), "utf8"));
  const r = parseConfig(raw);
  assert.deepEqual(r.errors, []);
  assert.ok(r.config.environments?.staging?.routes?.length, "staging routes (Caddy has no load balancer to read them from)");
});

test("pricing and costs: positive numbers and bounded knobs survive, the rest is reported", () => {
  const ok = parseConfig({ pricing: { fargateVcpuHour: 0.05, multiplier: 1.1 }, costs: { tagKey: " env ", spikePercent: 50, cacheHours: 12 } });
  assert.deepEqual(ok, { config: { pricing: { fargateVcpuHour: 0.05, multiplier: 1.1 }, costs: { tagKey: "env", spikePercent: 50, cacheHours: 12 } }, errors: [] });
  const bad = parseConfig({ pricing: { fargateGbHour: 0, multiplier: "2" }, costs: { tagKey: "", spikePercent: 0, cacheHours: 0.1 } });
  assert.deepEqual(bad.config, { pricing: {}, costs: {} });
  assert.deepEqual(bad.errors, [
    "pricing.fargateGbHour must be a positive number",
    "pricing.multiplier must be a positive number",
    "costs.tagKey must be a cost allocation tag key",
    "costs.spikePercent must be a number from 1 to 1000",
    "costs.cacheHours must be a number of hours from 1 to 168",
  ]);
  assert.deepEqual(parseConfig({ pricing: 1, costs: [] }).errors, ["pricing must be an object", "costs must be an object"]);
});

test("provisioning: switch, bounded counts and instance types survive, the rest is reported", () => {
  const ok = parseConfig({ provisioning: { enabled: false, maxTasks: 20, maxHosts: 0, allowedInstanceTypes: ["t3a.medium", "m7g.large"] } });
  assert.deepEqual(ok, { config: { provisioning: { enabled: false, maxTasks: 20, maxHosts: 0, allowedInstanceTypes: ["t3a.medium", "m7g.large"] } }, errors: [] });
  assert.deepEqual(parseConfig({ provisioning: { allowedImageRegistries: ["123456789012.dkr.ecr.us-east-1.amazonaws.com", "ghcr.io/acme"] } }).errors, []);
  assert.equal(parseConfig({ provisioning: { allowedImageRegistries: ["https://x"] } }).errors.length, 1);
  const bad = parseConfig({ provisioning: { enabled: "no", maxTasks: 0, maxHosts: 2.5, allowedInstanceTypes: ["huge"] } });
  assert.deepEqual(bad.config, { provisioning: {} });
  assert.deepEqual(bad.errors, [
    "provisioning.enabled must be true or false",
    "provisioning.maxTasks must be a whole number from 1 to 1000",
    "provisioning.maxHosts must be a whole number from 0 to 100",
    "provisioning.allowedInstanceTypes must be a list of instance types (e.g. t3a.medium)",
  ]);
  assert.deepEqual(parseConfig({ provisioning: [] }).errors, ["provisioning must be an object"]);
});

test("workloads: apps AWS can't see as services, validated strictly", () => {
  const ok = parseConfig({ workloads: { "live-core": { name: "Live Core", env: "staging", host: "i-0123456789abcdef0", platform: "docker compose", healthcheck: "https://api.example.com/ready", url: "https://api.example.com", repo: "acme/api", uses: ["rds:db", "redis"] } } });
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.config.workloads?.["live-core"].host, "i-0123456789abcdef0");
  const bad = parseConfig({ workloads: { "Bad Id": { name: "x" }, a: {}, b: { name: "B", host: "box-1", healthcheck: "ftp://x", uses: "db" } } });
  assert.equal(bad.errors.length, 5);
  // A workload's health check is probed too (F33): the 2,048-character cap applies; a plain url isn't probed.
  const long = `https://acme.example/${"a".repeat(2048)}`;
  const capped = parseConfig({ workloads: { c: { name: "C", healthcheck: long, url: long } } });
  assert.deepEqual(capped.errors, ["workloads.c.healthcheck must be an http(s) URL of at most 2,048 characters"]);
  assert.deepEqual(capped.config.workloads?.c, { name: "C", url: long });
});

test("a \"__proto__\" key never replaces a map's prototype", () => {
  const r = parseConfig(JSON.parse('{"services":{"__proto__":{"repo":"acme/evil"},"api":{"repo":"acme/api"}},"externals":{"__proto__":{"label":"x"}}}'));
  assert.deepEqual(r.errors, ["services.__proto__: not a service name", "externals.__proto__: not an id"]);
  assert.equal(Object.getPrototypeOf(r.config.services), Object.prototype);
  assert.equal(Object.getPrototypeOf(r.config.externals), Object.prototype);
  assert.equal((r.config.services as Record<string, { repo?: string }>).web?.repo, undefined);
});

test("inventory.regions: a list of region codes or \"all-enabled\"; bad entries are reported, good ones kept", () => {
  assert.deepEqual(parseConfig({ inventory: { regions: "all-enabled" } }), { config: { inventory: { regions: "all-enabled" } }, errors: [] });
  assert.deepEqual(parseConfig({ inventory: { regions: ["us-east-1", "eu-west-1", "us-gov-west-1", "eu-west-1"] } }).config.inventory, {
    regions: ["us-east-1", "eu-west-1", "us-gov-west-1"],
  });
  const bad = parseConfig({ inventory: { regions: ["us-east-1", "Europe", 7] } });
  assert.deepEqual(bad.config.inventory, { regions: ["us-east-1"] });
  assert.deepEqual(bad.errors, ['inventory.regions: "Europe", 7 are not AWS region codes (e.g. eu-west-1)']);
  assert.deepEqual(parseConfig({ inventory: { regions: [] } }).errors, ['inventory.regions must list at least one region, or be "all-enabled"']);
  assert.deepEqual(parseConfig({ inventory: { regions: "all" } }).errors, ['inventory.regions must be a list of region codes or "all-enabled"']);
  const many = Array.from({ length: 32 }, (_, i) => `eu-test${String.fromCharCode(97 + (i % 26))}${i >= 26 ? "x" : ""}-${i % 10}`);
  const capped = parseConfig({ inventory: { regions: many } });
  assert.equal((capped.config.inventory?.regions as string[]).length, 30);
  assert.deepEqual(capped.errors, ["inventory.regions: at most 30 regions — the first 30 are used"]);
});

test("inventory.providers and inventory.catchAll: shapes are checked, unknown keys reported", () => {
  const ok = parseConfig({ inventory: { providers: { include: ["ecs", "lambda", "ecs"], exclude: ["catchall"] }, catchAll: { config: true, cloudControlTypes: ["AWS::Glue::Database"] } } });
  assert.deepEqual(ok, { config: { inventory: { providers: { include: ["ecs", "lambda"], exclude: ["catchall"] }, catchAll: { config: true, cloudControlTypes: ["AWS::Glue::Database"] } } }, errors: [] });
  const bad = parseConfig({ inventory: { providers: { include: "ecs", only: [] }, catchAll: { config: "yes", cloudControlTypes: ["glue database"] }, extra: 1 } });
  assert.deepEqual(bad.config.inventory, { providers: {}, catchAll: {} });
  assert.deepEqual(bad.errors, [
    'unknown key "inventory.extra"',
    'unknown key "inventory.providers.only"',
    'inventory.providers.include must be a list of provider ids (e.g. "lambda")',
    "inventory.catchAll.config must be true or false",
    "inventory.catchAll.cloudControlTypes must be a list of CloudFormation type names (e.g. AWS::Glue::Database)",
  ]);
  assert.deepEqual(parseConfig({ inventory: { providers: ["ecs"], catchAll: true } }).errors, ["inventory.providers must be { include?, exclude? }", "inventory.catchAll must be { config?, cloudControlTypes? }"]);
  // The keys that existed before keep working next to the new ones.
  assert.deepEqual(parseConfig({ inventory: { idleDays: 7, unassignedProtected: false, regions: ["us-east-1"] } }), { config: { inventory: { idleDays: 7, unassignedProtected: false, regions: ["us-east-1"] } }, errors: [] });
});

test("environments.<id>.region pins an id to a region", () => {
  const r = parseConfig({ environments: { "production-eu": { cluster: "acme-production", region: "eu-west-1" }, dev: { cluster: "acme-dev", region: "Ireland" } } });
  assert.deepEqual(r.config.environments, { "production-eu": { cluster: "acme-production", region: "eu-west-1" }, dev: { cluster: "acme-dev" } });
  assert.deepEqual(r.errors, ["environments.dev.region must be an AWS region code (e.g. eu-west-1)"]);
});

test("ci.deployments binds a workflow file (not its name) to the environment it deploys (R03)", () => {
  const ok = parseConfig({ ci: { deployments: [
    { repo: "acme/storefront-api", workflow: ".github/workflows/ci.yml", env: "production" },
    { repo: "acme/jobs", workflow: ".github/workflows/deploy.yaml", env: "staging", inputs: { target: "staging" } },
  ] } });
  assert.deepEqual(ok.errors, []);
  assert.deepEqual(ok.config.ci?.deployments, [
    { repo: "acme/storefront-api", workflow: ".github/workflows/ci.yml", env: "production" },
    { repo: "acme/jobs", workflow: ".github/workflows/deploy.yaml", env: "staging", inputs: { target: "staging" } },
  ]);
  const bad = parseConfig({ ci: { deployments: [
    { repo: "https://github.com/acme/api", workflow: ".github/workflows/ci.yml", env: "production" },
    { repo: "acme/api", workflow: "Deploy", env: "production" },
    { repo: "acme/api", workflow: ".github/workflows/x.yml", env: "Production" },
    { repo: "acme/api", workflow: ".github/workflows/x.yml", env: "staging", inputs: { target: 1 } },
    { repo: "acme/api", workflow: ".github/workflows/x.yml", env: "staging", branch: "main" },
    "deploy",
  ], other: true } });
  assert.deepEqual(bad.config.ci?.deployments, [{ repo: "acme/api", workflow: ".github/workflows/x.yml", env: "staging" }]);
  assert.deepEqual(bad.errors, [
    'unknown key "ci.other"',
    'ci.deployments[0].repo must look like "owner/name"',
    'ci.deployments[1].workflow must be the workflow file\'s path, e.g. ".github/workflows/deploy.yml"',
    "ci.deployments[2].env must be an environment id",
    "ci.deployments[3].inputs must map input names to strings",
    'unknown key "ci.deployments[4].branch"',
    "ci.deployments[5] must be { repo, workflow, env, inputs? }",
  ]);
  assert.deepEqual(parseConfig({ ci: [] }).errors, ["ci must be an object"]);
  assert.deepEqual(parseConfig({ ci: { deployments: {} } }).errors, ["ci.deployments must be a list of { repo, workflow, env, inputs? }"]);
});

// ---------- loading the file: keep the last good version, fail closed at boot (F05) ----------
// The loader lives in server/config-check.ts ("server-only"), so it runs in a child process under react-server.
test("a broken config file keeps the last good version; one broken at boot fails closed; healthz degrades in aws mode", async () => {
  const { execFileSync } = await import("node:child_process");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const dir = mkdtempSync(path.join(tmpdir(), "console-config-"));
  try {
    const scenario = String.raw`
const at = (f) => new URL(f, ${JSON.stringify(new URL("./server/", import.meta.url).href)}).href;
const { writeFileSync, utimesSync } = await import("node:fs");
const file = process.env.CONSOLE_CONFIG;
let tick = 1;
const write = (text) => { writeFileSync(file, text); const t = new Date(Date.now() + 1000 * tick++); utimesSync(file, t, t); };
const { consoleConfig, degradedConfigProblem, FAIL_CLOSED_CONFIG } = await import(at("config-check.ts"));
const { listEnvs } = await import(at("discovery.ts"));
const { limitsOf } = await import(at("../provision.ts"));
const out = {};
const view = (c) => ({ config: c.config, errors: c.errors, failClosed: !!c.failClosed, stale: !!c.stale });

write(JSON.stringify({ environments: { staging: { cluster: "acme-staging", protected: false } }, provisioning: { enabled: true } }));
out.good = view(consoleConfig());
write("{ not json");
out.broken = view(consoleConfig());
out.brokenEnvs = (await listEnvs()).map((e) => [e.id, e.protected]);
out.degradedMock = degradedConfigProblem() ?? null;
process.env.CONSOLE_SOURCE = "aws"; out.degradedAws = degradedConfigProblem() ?? null; process.env.CONSOLE_SOURCE = "mock";

const fresh = () => { for (const k of Object.keys(globalThis.__consoleConfigFile)) delete globalThis.__consoleConfigFile[k]; };
fresh(); // a console starting now, with the file still broken
out.boot = view(consoleConfig());
out.bootEnvs = (await listEnvs()).map((e) => [e.id, e.protected]);
out.bootProvisioning = limitsOf(consoleConfig().config.provisioning).enabled;
out.failClosed = FAIL_CLOSED_CONFIG;

write(JSON.stringify({ environments: { staging: { cluster: "acme-staging", protected: "yes" } } }));
out.fixed = view(consoleConfig());
process.env.CONSOLE_SOURCE = "aws"; out.typeError = degradedConfigProblem() ?? null; process.env.CONSOLE_SOURCE = "mock";

fresh();
process.env.CONSOLE_CONFIG = file + ".missing";
out.missing = view(consoleConfig());
console.log(JSON.stringify(out));
`;
    const stdout = execFileSync(process.execPath, ["--conditions=react-server", "--no-warnings", "--input-type=module", "-e", scenario], {
      encoding: "utf8",
      env: { ...process.env, CONSOLE_SOURCE: "mock", CONSOLE_SQLITE_PATH: ":memory:", DATABASE_URL: "", CONSOLE_CONFIG: path.join(dir, "console.config.json"), CONSOLE_REGIONS: "" },
      timeout: 60_000,
    });
    const o = JSON.parse(stdout.trim().split("\n").pop()!);
    assert.deepEqual(o.good, { config: { environments: { staging: { cluster: "acme-staging", protected: false } }, provisioning: { enabled: true } }, errors: [], failClosed: false, stale: false });

    assert.deepEqual([o.broken.config, o.broken.stale, o.broken.failClosed], [o.good.config, true, false], "the last good version stays in force");
    assert.match(o.broken.errors[0], /^console\.config\.json: .*JSON.* — still using the version read \d{4}-/);
    assert.deepEqual(o.brokenEnvs, [["staging", false], ["production", true]]);
    assert.equal(o.degradedMock, null, "the demo never degrades for this");
    assert.match(o.degradedAws, /^config file broken, last good version in use: console\.config\.json: /);

    assert.deepEqual([o.boot.config, o.boot.failClosed, o.boot.stale], [o.failClosed, true, false]);
    assert.match(o.boot.errors[0], /failing closed: every environment is protected and provisioning is off until it is fixed$/);
    assert.deepEqual(o.bootEnvs, [["staging", true], ["production", true]], "staging too");
    assert.equal(o.bootProvisioning, false);
    assert.deepEqual(o.failClosed, { provisioning: { enabled: false }, inventory: { unassignedProtected: true } });

    assert.deepEqual([o.fixed.failClosed, o.fixed.stale, o.fixed.errors], [false, false, ["environments.staging.protected must be true or false"]]);
    assert.match(o.typeError, /^config file has errors: environments\.staging\.protected must be true or false$/);
    assert.deepEqual([o.missing.failClosed, o.missing.config], [true, o.failClosed], "a CONSOLE_CONFIG that points nowhere fails closed too");
    assert.match(o.missing.errors[0], /ENOENT/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// console.config.schema.json (editors) and parseConfig (the console) must agree on every key: a key the schema offers
// that the parser drops would be silently ignored, and a section the schema closes (additionalProperties: false) must
// report anything else instead of falling back to a default without a word.
test("the schema and the parser know the same keys, section by section", () => {
  type Node = { type?: string; properties?: Record<string, Node>; additionalProperties?: boolean | Node; items?: Node; required?: string[]; oneOf?: Node[]; const?: unknown };
  const schema = JSON.parse(readFileSync(new URL("../../console.config.schema.json", import.meta.url), "utf8")) as Node;
  const GOOD: Record<string, unknown> = {
    cluster: "acme-staging", name: "API", repo: "acme/api", workflow: ".github/workflows/deploy.yml", env: "staging", host: "i-0123456789abcdef0",
    healthcheck: "https://api.example.com/health", url: "https://api.example.com", label: "Label", from: "service:api", to: "db", regions: ["us-east-1"],
  };
  const dummy = (k: string, n: Node): unknown =>
    Object.hasOwn(GOOD, k) ? GOOD[k] : n.const ?? (n.type === "boolean" ? true : n.type === "number" || n.type === "integer" ? 1 : n.type === "array" ? [] : n.type === "object" ? {} : n.oneOf ? dummy(k, n.oneOf[0]) : "x");
  const minimal = (n: Node) => Object.fromEntries((n.required ?? n.oneOf?.[0]?.required ?? []).map((k) => [k, dummy(k, n.properties?.[k] ?? {})]));
  const unknownOf = (raw: unknown, key: string) => parseConfig(raw).errors.filter((e) => e.startsWith("unknown key") && e.endsWith(`${key}"`));
  let closed = 0;
  const walk = (n: Node, wrap: (o: Record<string, unknown>) => unknown, at: string) => {
    if (!n.properties) return;
    const base = minimal(n);
    if (n.additionalProperties === false) {
      closed++;
      for (const [k, p] of Object.entries(n.properties)) assert.deepEqual(unknownOf(wrap({ ...base, [k]: dummy(k, p) }), k), [], `${at}.${k}: in the schema, refused by the parser`);
      assert.equal(unknownOf(wrap({ ...base, notAKey: 1 }), "notAKey").length, 1, `${at}: the schema closes it, the parser must report an unknown key`);
    }
    for (const [k, p] of Object.entries(n.properties)) {
      const into = (v: unknown) => wrap({ ...base, [k]: v });
      if (p.properties) walk(p, (o) => into(o), `${at}.${k}`);
      if (p.additionalProperties && typeof p.additionalProperties === "object") walk(p.additionalProperties, (o) => into({ x: o }), `${at}.${k}.<id>`);
      if (p.items?.properties) walk(p.items, (o) => into([o]), `${at}.${k}[]`);
    }
  };
  walk(schema, (o) => o, "config");
  assert.ok(closed >= 10, `${closed} closed sections checked`);
});

test("unknown keys in services, workloads, pricing, costs and provisioning are reported; the known ones still apply", () => {
  const r = parseConfig({
    services: { api: { name: "API", hiden: true } },
    workloads: { cron: { name: "Cron", env: "staging", healthchek: "https://x.example" } },
    pricing: { multiplier: 1.1, fargateCpuHour: 0.04 },
    costs: { cacheHours: 12, tagkey: "env" },
    provisioning: { maxTasks: 4, maxTask: 40 },
  });
  assert.deepEqual(r.errors.sort(), ['unknown key "costs.tagkey"', 'unknown key "pricing.fargateCpuHour"', 'unknown key "provisioning.maxTask"', 'unknown key "services.api.hiden"', 'unknown key "workloads.cron.healthchek"']);
  assert.deepEqual([r.config.services?.api.name, r.config.workloads?.cron.env, r.config.pricing?.multiplier, r.config.costs?.cacheHours, r.config.provisioning?.maxTasks], ["API", "staging", 1.1, 12, 4]);
});
