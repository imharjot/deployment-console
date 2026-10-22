import { test } from "node:test";
import assert from "node:assert/strict";
import { parseConfig } from "./console-config.ts";
import { MAX_ALLOWED_PER_TARGET, attribute, envsFromClusters, hostsFromEnv, inferConnections, inferEdges, parseImageRef, placement, ruleReaches, shaFromTag, stageWordsOf, workloadGraph, type NodeRef } from "./discover.ts";

test("clusters become environments: stage words, uniqueness, tags win", () => {
  const e = envsFromClusters([
    { name: "acme-prod", tags: {} },
    { name: "acme-staging", tags: {} },
    { name: "payments-sandbox", tags: {} },
    { name: "data-pipeline", tags: { "console:env": "Data", "console:protected": "true", "console:branch": "main" } },
  ]);
  assert.deepEqual(e.map((x) => x.id), ["sandbox", "data", "staging", "production"]);
  const prod = e.find((x) => x.id === "production")!;
  assert.equal(prod.protected, true);
  assert.equal(prod.label, "Production");
  const data = e.find((x) => x.id === "data")!;
  assert.equal(data.protected, true);
  assert.equal(data.branch, "main");
  // two prod clusters → neither can claim "production"
  const two = envsFromClusters([{ name: "eu-prod", tags: {} }, { name: "us-prod", tags: {} }]);
  assert.deepEqual(two.map((x) => x.id), ["eu-prod", "us-prod"]);
  assert.ok(two.every((x) => x.protected));
});

test("environment ids never repeat: one would replace the other's catalog", () => {
  const ids = (cs: [string, Record<string, string>?][]) => envsFromClusters(cs.map(([name, tags = {}]) => ({ name, tags }))).map((x) => [x.cluster, x.id]);
  // Two clusters tagged alike: neither takes the id.
  assert.deepEqual(ids([["blue", { "console:env": "production" }], ["green", { "console:env": "production" }]]), [["blue", "blue"], ["green", "green"]]);
  // A tag beats another cluster's stage word; a name a kept id already has gets a suffix.
  assert.deepEqual(ids([["main", { "console:env": "staging" }], ["acme-stg"], ["eu", { "console:env": "payments" }], ["payments"]]).sort(), [
    ["acme-stg", "acme-stg"], ["eu", "payments"], ["main", "staging"], ["payments", "payments-2"],
  ]);
  assert.deepEqual(ids([["x", { "console:env": "production" }], ["production"]]).sort(), [["production", "production-2"], ["x", "production"]]);
});

test("localhost reaches a host-network service unless placement rules a shared instance out", () => {
  // `all`: the instances cover every live task (placement().unplaced === 0).
  type P = { on?: string[]; all?: boolean };
  const node = (id: string, port: number, p: P): NodeRef => ({ id: `service:${id}`, kind: "service", securityGroups: [], ports: [port], hostNetwork: true, instances: p.on, placedAll: p.all });
  const env = { "service:api": [{ host: "localhost", port: 6379, via: "REDIS_URL" }] };
  const sources = (api: P, redis: P) => inferEdges([node("api", 3000, api), node("redis", 6379, redis)], {}, env).map((e) => e.source);
  const sure = "task definition env REDIS_URL";
  const unsure = "task definition env REDIS_URL (localhost; same host not confirmed)";
  assert.deepEqual(sources({ on: ["i-a"], all: true }, { on: ["i-b"], all: true }), [], "both complete and disjoint: localhost can't be it");
  assert.deepEqual(sources({ on: ["i-a", "i-b"], all: true }, { on: ["i-b"], all: true }), [sure]);
  assert.deepEqual(sources({ on: ["i-a"], all: false }, { on: ["i-b"], all: true }), [unsure], "an api task whose host wasn't read may be on i-b");
  assert.deepEqual(sources({ on: ["i-a"], all: true }, { on: ["i-b"], all: false }), [unsure]);
  assert.deepEqual(sources({ on: ["i-b"], all: false }, { on: ["i-b"], all: false }), [sure], "a shared instance is confirmed, whatever else is unread");
  assert.deepEqual(sources({ on: ["i-a"], all: true }, { on: [], all: true }), [unsure], "redis has no live task: nothing to compare");
  assert.deepEqual(sources({}, { on: ["i-b"], all: true }), [unsure]);
});

test("placement: running and starting per instance; live tasks without a host, or without a record, are unplaced", () => {
  const t = (lastStatus: string, host?: string, desiredStatus = "RUNNING") => ({ lastStatus, desiredStatus, ...(host ? { host } : {}) });
  const p = placement({ tasks: [t("RUNNING", "i-a"), t("PENDING", "i-a"), t("RUNNING", "i-b"), t("PROVISIONING"), t("STOPPED", "i-a", "STOPPED"), t("RUNNING", "i-b", "STOPPED")] });
  assert.deepEqual(Object.fromEntries(p.on), { "i-a": { running: 1, starting: 1 }, "i-b": { running: 1, starting: 0 } });
  assert.equal(p.unplaced, 1);
  // The listing stopped short (R13): ECS counts 3 running + 1 pending, 1 record was read — 3 are unplaced.
  assert.equal(placement({ tasks: [t("RUNNING", "i-a")], running: 3, pending: 1, tasksComplete: false }).unplaced, 3);
  assert.equal(placement({ tasks: [], running: 1, tasksComplete: false }).unplaced, 1);
  // A complete listing is the whole picture, whatever the (eventually consistent) counts say; scaled to zero is nothing.
  assert.equal(placement({ tasks: [t("RUNNING", "i-a")], running: 2, tasksComplete: true }).unplaced, 0);
  assert.deepEqual([placement({ tasks: [], running: 0, pending: 0 }).on.size, placement({ tasks: [], running: 0, pending: 0 }).unplaced], [0, 0]);
});

test("image refs: ECR, Docker Hub, digests; shas inside tags", () => {
  const r = parseImageRef("123456789012.dkr.ecr.us-east-1.amazonaws.com/team/api:staging-1a2b3c4");
  assert.deepEqual([r.ecr, r.repository, r.tag, r.region], [true, "team/api", "staging-1a2b3c4", "us-east-1"]);
  assert.deepEqual([parseImageRef("redis:7-alpine").ecr, parseImageRef("redis:7-alpine").repository], [false, "redis"]);
  assert.equal(parseImageRef("caddy").tag, "latest");
  assert.equal(parseImageRef("ghcr.io/org/app@sha256:abc").digest, "sha256:abc");
  assert.equal(shaFromTag("staging-1a2b3c4"), "1a2b3c4");
  assert.equal(shaFromTag("1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b"), "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b");
  assert.equal(shaFromTag("latest"), undefined);
  assert.equal(shaFromTag("v1.2.3"), undefined);
  assert.equal(shaFromTag("2-alpine"), undefined);
});

test("hosts from env values: URLs with credentials, host:port, AWS endpoints — names only", () => {
  const h = hostsFromEnv([
    { name: "DATABASE_URL", value: "postgres://app:s3cret@acme-prod.abc.us-east-1.rds.amazonaws.com:5432/app" },
    { name: "REDIS_URL", value: "redis://127.0.0.1:6379/1" },
    { name: "UPSTREAM", value: "billing:8080" },
    { name: "GREETING", value: "hello world" },
  ]);
  assert.deepEqual(h.map((x) => `${x.host}:${x.port ?? ""}:${x.via}`).sort(), [
    "127.0.0.1:6379:REDIS_URL",
    "acme-prod.abc.us-east-1.rds.amazonaws.com:5432:DATABASE_URL",
    "acme-prod.abc.us-east-1.rds.amazonaws.com::DATABASE_URL",
    "billing:8080:UPSTREAM",
  ]);
  assert.ok(!JSON.stringify(h).includes("s3cret"));
});

test("edges from security groups and from env references (incl. localhost on a shared host network)", () => {
  const nodes = [
    { id: "service:api", kind: "service" as const, securityGroups: ["sg-api"], ports: [3000] },
    { id: "service:worker", kind: "service" as const, securityGroups: ["sg-worker"], ports: [8080] },
    { id: "database:main", kind: "database" as const, securityGroups: ["sg-db"], ports: [5432], engine: "postgres", hosts: ["main.abc.rds.amazonaws.com"] },
    { id: "service:web", kind: "service" as const, securityGroups: [], ports: [3010], hostNetwork: true },
    { id: "service:redis", kind: "service" as const, securityGroups: [], ports: [6379], hostNetwork: true, hosts: ["redis"] },
  ];
  const edges = inferEdges(
    nodes,
    { "sg-db": [{ fromPort: 5432, toPort: 5432, groups: ["sg-api", "sg-worker"] }], "sg-worker": [{ fromPort: 8080, toPort: 8080, groups: ["sg-api"] }] },
    { "service:web": [{ host: "127.0.0.1", port: 6379, via: "REDIS_URL" }], "service:worker": [{ host: "main.abc.rds.amazonaws.com", port: 5432, via: "DATABASE_URL" }] },
  );
  const ids = edges.map((e) => `${e.from}>${e.to}:${e.kind}`).sort();
  assert.deepEqual(ids, ["service:api>database:main:sql", "service:api>service:worker:http", "service:web>service:redis:cache", "service:worker>database:main:sql"]);
  assert.match(edges.find((e) => e.from === "service:api" && e.to === "database:main")!.label, /postgres:5432/);
});

test("F14: a self-referencing group draws no service ↔ service mesh, but still service → database / cache", () => {
  const svc = (n: string): NodeRef => ({ id: `service:${n}`, kind: "service", securityGroups: ["sg-tasks"], ports: [3000], hosts: [n] });
  const nodes: NodeRef[] = [
    svc("api"), svc("worker"), svc("billing"),
    { id: "database:main", kind: "database", securityGroups: ["sg-tasks"], ports: [5432], engine: "postgres" },
    { id: "cache:main", kind: "cache", securityGroups: ["sg-cache"], ports: [6379], engine: "valkey" },
  ];
  const rules = { "sg-tasks": [{ fromPort: 0, toPort: 65535, groups: ["sg-tasks"] }], "sg-cache": [{ fromPort: 6379, toPort: 6379, groups: ["sg-tasks"] }] };
  const c = inferConnections(nodes, rules, {});
  const ids = c.edges.map((e) => `${e.from}>${e.to}:${e.kind}`).sort();
  assert.deepEqual(ids, [
    "database:main>cache:main:cache", // sg-cache admits sg-tasks, and the database is a member like any other
    "service:api>cache:main:cache", "service:api>database:main:sql", "service:billing>cache:main:cache", "service:billing>database:main:sql",
    "service:worker>cache:main:cache", "service:worker>database:main:sql",
  ]);
  assert.ok(!c.edges.some((e) => e.from.startsWith("database:") && e.to !== "cache:main"), "a peer rule never points from the database");
  assert.deepEqual(c.peerGroups, [{ group: "sg-tasks", members: ["service:api", "service:worker", "service:billing", "database:main"] }]);
  assert.equal(c.edges.find((e) => e.to === "cache:main")!.source, "security group sg-cache allows sg-tasks", "the evidence names only the group that matched");
  assert.deepEqual(inferEdges(nodes, rules, {}), c.edges, "the ECS views get the same edges");
  // A connection string still outranks the security group for the same pair, and still links two peers.
  const withEnv = inferConnections(nodes, rules, { "service:api": [{ host: "worker", port: 3000, via: "WORKER_URL" }] });
  assert.equal(withEnv.edges.find((e) => e.from === "service:api" && e.to === "service:worker")?.source, "task definition env WORKER_URL");
});

test("F14: a member that is in several groups is visited once per matching group, not per node", () => {
  const nodes: NodeRef[] = [
    { id: "service:a", kind: "service", securityGroups: ["sg-a", "sg-shared"], ports: [] },
    { id: "service:b", kind: "service", securityGroups: ["sg-b", "sg-shared"], ports: [] },
  ];
  const edges = inferEdges(nodes, { "sg-b": [{ fromPort: 8080, toPort: 8080, groups: ["sg-a"] }], "sg-shared": [{ groups: ["sg-shared"] }] }, {});
  assert.deepEqual(edges.map((e) => [e.from, e.to, e.source]), [["service:a", "service:b", "security group sg-b allows sg-a"]], "a cross-group rule is not a peer rule");
  // A self-referencing group with a single member (a database alone in its VPC's "default" group) is no peer group.
  const lone = inferConnections([...nodes, { id: "database:main", kind: "database", securityGroups: ["sg-default"], ports: [5432] }], { "sg-default": [{ groups: ["sg-default"] }] }, {});
  assert.deepEqual([lone.edges, lone.peerGroups], [[], []]);
});

test("F14: 500 services in one self-referencing group — linear and fast; edges into one target are capped at 50", () => {
  const nodes: NodeRef[] = Array.from({ length: 500 }, (_, i) => ({ id: `service:s${String(i).padStart(3, "0")}`, kind: "service" as const, securityGroups: ["sg-tasks"], ports: [8080] }));
  const rules = { "sg-tasks": [{ fromPort: 0, toPort: 65535, groups: ["sg-tasks"] }] };
  let best = Infinity;
  for (let i = 0; i < 5; i++) {
    const t0 = performance.now();
    const c = inferConnections(nodes, rules, {});
    best = Math.min(best, performance.now() - t0);
    assert.equal(c.edges.length, 0);
    assert.equal(c.peerGroups[0].members.length, 500);
  }
  assert.ok(best < 50, `took ${best.toFixed(1)} ms`);
  const db: NodeRef = { id: "database:main", kind: "database", securityGroups: ["sg-db"], ports: [5432] };
  const capped = inferConnections([...nodes, db], { ...rules, "sg-db": [{ fromPort: 5432, toPort: 5432, groups: ["sg-tasks"] }] }, {});
  assert.equal(capped.edges.length, MAX_ALLOWED_PER_TARGET);
  assert.deepEqual(capped.truncated, [{ to: "database:main", kept: 50, dropped: 450 }]);
  assert.equal(capped.edges[0].from, "service:s000", "deterministic: the first sources by id are kept");
  const env = inferConnections([...nodes, { ...db, hosts: ["main.db"] }], { ...rules, "sg-db": [{ fromPort: 5432, toPort: 5432, groups: ["sg-tasks"] }] }, { "service:s499": [{ host: "main.db", port: 5432, via: "DATABASE_URL" }] });
  assert.ok(env.edges.some((e) => e.from === "service:s499" && e.source === "task definition env DATABASE_URL"), "a connection string is never capped");
});

test("attribution: config, tags, connections, names, vpc", () => {
  const envs = [
    { id: "staging", stageWords: stageWordsOf("staging", "acme-staging"), vpcIds: ["vpc-1"] },
    { id: "production", stageWords: stageWordsOf("production", "acme-prod"), vpcIds: ["vpc-2"] },
  ];
  const none = new Set<string>();
  assert.equal(attribute({ id: "x", tags: {} }, envs, none, { x: "staging" }), "staging");
  assert.equal(attribute({ id: "x", tags: { Environment: "prod" } }, envs, none, {}), "production");
  assert.equal(attribute({ id: "x", tags: {} }, envs, new Set(["staging"]), {}), "staging");
  assert.equal(attribute({ id: "acme-prod-pg", tags: {} }, envs, none, {}), "production");
  assert.equal(attribute({ id: "shared", tags: {}, vpcId: "vpc-1" }, envs, none, {}), "staging");
  assert.equal(attribute({ id: "shared", tags: {} }, envs, none, {}), undefined);
});

test("config parser keeps valid parts and names every problem", () => {
  const { config, errors } = parseConfig({
    environments: { staging: { cluster: "acme-staging", routes: [{ host: "api.x", service: "api" }] }, "Bad Id": { cluster: "x" }, prod: {} },
    services: { api: { name: "API", repo: "acme/api" }, web: { repo: "not a repo" } },
    connections: [{ from: "service:api", to: "ext:stripe", kind: "api" }, { from: "a" }],
    typo: true,
  });
  assert.equal(config.environments?.staging.cluster, "acme-staging");
  assert.equal(config.services?.api.repo, "acme/api");
  assert.equal(config.connections?.length, 1);
  assert.equal(errors.length, 5, errors.join("\n"));
  assert.deepEqual(parseConfig(undefined), { config: {}, errors: [] });
});

test("ruleReaches: a data store's rule must admit one of its ports; all-traffic rules, unknown ports and services pass", () => {
  const pg = { kind: "database" as const, ports: [5432] };
  assert.equal(ruleReaches({ fromPort: 5432, toPort: 5432 }, pg), true);
  assert.equal(ruleReaches({ fromPort: 443, toPort: 443 }, pg), false);
  assert.equal(ruleReaches({ fromPort: 5000, toPort: 6000 }, pg), true);
  assert.equal(ruleReaches({}, pg), true);
  assert.equal(ruleReaches({ fromPort: -1, toPort: -1 }, pg), true);
  assert.equal(ruleReaches({ fromPort: 443, toPort: 443 }, { kind: "database", ports: [] }), true, "unknown port");
  assert.equal(ruleReaches({ fromPort: 32768, toPort: 65535 }, { kind: "service", ports: [3000] }), true, "bridge networking: host ports");
  const nodes: NodeRef[] = [
    { id: "service:api", kind: "service", securityGroups: ["sg-api"], ports: [3000] },
    { id: "database:search", kind: "database", securityGroups: ["sg-db"], ports: [443], engine: "opensearch" },
  ];
  assert.deepEqual(inferConnections(nodes, { "sg-db": [{ fromPort: 5432, toPort: 5432, groups: ["sg-api"] }] }, {}).edges, []);
});

test("compose workloads become topology: uses → edges (own data stores only), the proxy is the ingress", () => {
  const g = workloadGraph(
    {
      api: { name: "API", uses: ["rds:stg-pg", "rds:prod-pg", "redis", "external:zoho", "external:kafka", "external:nope", "api.example.com"] },
      redis: { name: "Redis" },
      "caddy-stg": { name: "Caddy", uses: ["api", "api"] },
    },
    { databases: ["stg-pg"], caches: [], externals: ["zoho", "kafka"], sources: ["kafka"] },
  );
  assert.deepEqual(g.nodes, ["service:api", "service:redis", "service:caddy-stg"]);
  assert.deepEqual(g.edges, [
    { from: "service:api", to: "database:stg-pg", kind: "sql", label: "SQL" },
    { from: "service:api", to: "service:redis", kind: "cache", label: "cache" },
    { from: "service:api", to: "ext:zoho", kind: "api", label: "API" },
    { from: "ext:kafka", to: "service:api", kind: "api", label: "API" },
    { from: "service:caddy-stg", to: "service:api", kind: "http", label: "HTTP" },
  ]);
  assert.equal(g.ingress, "service:caddy-stg");
});
