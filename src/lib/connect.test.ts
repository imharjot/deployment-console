import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { addressOf, admits, connectPlan, disconnectPlan, isConsoleRule, openable, ruleNote, ruleState, scNameFor, sourceGroup, varNameFor, type ConnectFacts } from "./connect.ts";
import type { RawSecurityGroup } from "./types.ts";

test("addresses: Service Connect names, loopback on one host, database and cache endpoints without credentials", () => {
  assert.equal(addressOf({ kind: "service", name: "Checkout_API", port: 8080, sameHost: false }), "http://checkout_api:8080");
  assert.equal(addressOf({ kind: "service", name: "api", port: 3000, sameHost: false, dnsName: "storefront" }), "http://storefront:3000", "an existing Service Connect name wins");
  assert.equal(addressOf({ kind: "service", name: "worker", port: 8080, sameHost: true }), "http://127.0.0.1:8080");
  assert.equal(addressOf({ kind: "database", name: "pg", engine: "postgres", endpoint: "pg.example.com", port: 5432 }), "postgres://pg.example.com:5432");
  assert.equal(addressOf({ kind: "database", name: "a", engine: "aurora-mysql", endpoint: "a.example.com", port: 3306 }), "mysql://a.example.com:3306");
  assert.equal(addressOf({ kind: "database", name: "o", engine: "oracle-se2", endpoint: "o.example.com", port: 1521 }), "o.example.com:1521", "no scheme it can't name");
  assert.equal(addressOf({ kind: "cache", name: "c", engine: "valkey", endpoint: "c.example.com", port: 6379, tls: true }), "rediss://c.example.com:6379");
  assert.equal(addressOf({ kind: "cache", name: "c", engine: "redis", endpoint: "c.example.com", port: 6379 }), "redis://c.example.com:6379");
  assert.equal(addressOf({ kind: "cache", name: "m", engine: "memcached", endpoint: "m.example.com", port: 11211 }), "m.example.com:11211");
});

test("names: variables in capitals with _URL, Service Connect names a DNS label can hold, rule notes without the arrow AWS refuses", () => {
  assert.equal(varNameFor("acme-production-pg"), "ACME_PRODUCTION_PG_URL");
  assert.equal(varNameFor("2fa.service"), "_2FA_SERVICE_URL");
  assert.equal(varNameFor("--"), "TARGET_URL");
  assert.equal(scNameFor("Checkout_API"), "checkout_api");
  assert.equal(scNameFor("9lives.svc"), "lives-svc", "starts with a letter");
  assert.equal(scNameFor("x".repeat(80)).length, 63);
  assert.equal(ruleNote("checkout", "acme-production-pg"), "deployment-console: checkout to acme-production-pg");
  assert.equal(ruleNote("a→b", "c"), "deployment-console: a-b to c", "only the characters AWS allows in a description");
  assert.ok(isConsoleRule(ruleNote("a", "b")) && !isConsoleRule("allow the api") && !isConsoleRule(undefined));
});

const sg = (id: string, inbound: RawSecurityGroup["inbound"], tags?: Record<string, string>): RawSecurityGroup => ({ id, name: id, vpcId: "vpc-prod", inbound, ...(tags ? { tags } : {}) });

test("rules: admits a group on a port, the console's own rule first, all-traffic rules count", () => {
  const team = { fromPort: 5432, toPort: 5432, groups: ["sg-a", "sg-b"], notes: { "sg-a": "apps" } };
  const mine = { fromPort: 5432, toPort: 5432, groups: ["sg-own"], description: ruleNote("checkout", "pg") };
  assert.ok(admits(team, "sg-a", 5432) && !admits(team, "sg-a", 5433) && !admits(team, "sg-x", 5432));
  assert.ok(admits({ fromPort: -1, toPort: -1, groups: ["sg-a"] }, "sg-a", 1234), "all traffic");
  assert.ok(admits({ fromPort: 5000, toPort: 6000, groups: ["sg-a"] }, "sg-a", 5432), "a range");
  const both = ruleState([sg("sg-db", [team, mine])], ["sg-a", "sg-own"], 5432);
  assert.deepEqual([both.allowed?.source, both.allowed?.mine], ["sg-own", true], "disconnect finds the console's rule beside a team's");
  const theirs = ruleState([sg("sg-db", [team])], ["sg-a"], 5432);
  assert.deepEqual([theirs.allowed?.mine, theirs.allowed?.rule], [false, 'sg-db allows sg-a on 5432 — "apps"']);
  assert.deepEqual(ruleState([sg("sg-db", [team])], ["sg-z"], 5432), {});
  assert.ok(openable({ tags: { "console:created": "true" } }) && openable({ tags: { "console:connect": "allow" } }) && !openable({ tags: { "console:connect": "yes" } }) && !openable({}));
});

test("the source group: one only A uses, else the first with who shares it", () => {
  const users: Record<string, string[]> = { "sg-shared": ["worker", "billing"], "sg-own": [] };
  assert.deepEqual(sourceGroup(["sg-shared", "sg-own"], (g) => users[g] ?? []), { group: "sg-own", sharedWith: [] });
  assert.deepEqual(sourceGroup(["sg-shared"], (g) => users[g] ?? []), { group: "sg-shared", sharedWith: ["worker", "billing"] });
  assert.equal(sourceGroup([], () => []), undefined);
});

const facts = (o: Partial<ConnectFacts> = {}): ConnectFacts => ({
  env: "production",
  a: { name: "checkout", container: "checkout", groups: ["sg-own"] },
  b: { kind: "service", name: "api", port: 3000, sameHost: false, group: { id: "sg-prod-api", openable: true } },
  source: { group: "sg-own", sharedWith: [] },
  rule: {},
  variable: { name: "API_URL" },
  serviceConnect: { namespace: { name: "acme-production", exists: false }, b: { exposes: false, portName: "port-3000", rename: true }, aClient: false },
  ...o,
});

test("connect plan: a rule, Service Connect for B (namespace, port name), A as a client and its variable — all named before anything runs", () => {
  const p = connectPlan(facts());
  assert.equal(p.summary, "Connect checkout → api in production");
  assert.deepEqual(p.changes, [
    'Add an inbound rule to api\'s security group sg-prod-api: 3000/tcp from checkout\'s sg-own ("deployment-console: checkout to api")',
    "Create Cloud Map namespace acme-production (API calls only, the kind Service Connect uses) for production",
    'Register a revision of api\'s task definition that names its port 3000 "port-3000" (Service Connect refers to the port by name); nothing else changes',
    "Turn on Service Connect for api in acme-production: it answers at http://api:3000 — a new deployment of api",
    "checkout joins acme-production as a Service Connect client (with the deployment below)",
    "Set API_URL=http://api:3000 on checkout's container checkout: a new task definition revision, then a rolling deployment",
  ]);
  assert.deepEqual(p.steps, { rule: true, variable: true, serviceConnect: true });
  assert.ok(p.warnings.some((w) => /proxy container/.test(w)));
});

test("connect plan: what's already true is said, not done; a shared group and an unopenable one warn", () => {
  const done = connectPlan(facts({
    rule: { allowed: { group: "sg-prod-api", source: "sg-own", rule: "sg-prod-api allows sg-own on 3000", mine: true } },
    serviceConnect: { namespace: { name: "acme-production", exists: true }, b: { exposes: true, portName: "port-3000" }, aClient: true },
    b: { kind: "service", name: "api", port: 3000, sameHost: false, dnsName: "api", group: { id: "sg-prod-api", openable: true } },
    variable: { name: "API_URL", current: "http://api:3000" },
  }));
  assert.deepEqual(done.steps, { rule: false, variable: false, serviceConnect: false });
  assert.match(done.changes.join("\n"), /already admits checkout.*no security group change[\s\S]*already has API_URL=http:\/\/api:3000/);
  const db = connectPlan(facts({
    b: { kind: "database", name: "acme-production-pg", engine: "postgres", endpoint: "pg.example.com", port: 5432, group: { id: "sg-prod-db", openable: false } },
    source: { group: "sg-prod-api", sharedWith: ["worker"] }, serviceConnect: undefined, variable: { name: "ACME_PRODUCTION_PG_URL" },
  }));
  assert.match(db.warnings.join("\n"), /sg-prod-api is also used by worker: it can reach acme-production-pg on port 5432 too/);
  assert.match(db.warnings.join("\n"), /tag sg-prod-db first, or AWS refuses this rule/);
  assert.match(db.warnings.join("\n"), /no user or password/);
  const host = connectPlan(facts({ b: { kind: "service", name: "worker", port: 8080, sameHost: true }, serviceConnect: undefined, variable: { name: "WORKER_URL" } }));
  assert.equal(host.changes[0], "Same EC2 host: checkout reaches worker on 127.0.0.1 — no security group change");
  assert.deepEqual(host.steps, { rule: false, variable: true, serviceConnect: false });
});

test("disconnect plan: only the console's rule and the variable while it holds B's address; nothing of ours → nothing", () => {
  const b = { kind: "cache" as const, name: "valkey", engine: "valkey", endpoint: "v.example.com", port: 6379, tls: true };
  const ours = disconnectPlan({ env: "production", a: { name: "checkout" }, b, rule: { allowed: { group: "sg-v", source: "sg-own", rule: "sg-v allows sg-own on 6379", mine: true } }, variable: { name: "VALKEY_URL", current: "rediss://v.example.com:6379" } });
  assert.deepEqual([ours.nothing, ours.steps.rule, ours.steps.variable], [false, true, true]);
  const theirs = disconnectPlan({ env: "production", a: { name: "checkout" }, b, rule: { allowed: { group: "sg-v", source: "sg-a", rule: "sg-v allows sg-a on 6379", mine: false } }, variable: { name: "VALKEY_URL", current: "rediss://elsewhere:6379" } });
  assert.equal(theirs.nothing, true);
  assert.match(theirs.warnings.join("\n"), /the console didn't make that rule, so it stays[\s\S]*holds another value now, so it stays/);
});

// ---------- the actions on the simulated account ----------
// providers/ecs-connect.ts imports "server-only" (react-server condition): a child process, like provision.test.ts.
// A new service in production (its own group) connects to the API (Service Connect), to the cache (an opted-in
// group) and to the database (a group nobody opened: AWS refuses), then disconnects; staging (one host, host
// networking) connects over loopback.
const scenario = String.raw`
const at = (f) => new URL(f, ${JSON.stringify(new URL("./server/", import.meta.url).href)}).href;
const { mockCloud } = await import(at("mock.ts"));
const base = mockCloud();
const P = await import(at("provision.ts"));
const { ecsConnectProvider } = await import(at("providers/ecs-connect.ts"));
const { invalidate } = await import(at("cache.ts"));
const connect = ecsConnectProvider.actions.find((a) => a.id === "connect");
const disconnect = ecsConnectProvider.actions.find((a) => a.id === "disconnect");
const who = { user: { id: "u-ops", email: "ops@acme.example", role: "admin" }, actor: "ops@acme.example" };
const ctx = { region: "us-east-1", mock: true, actor: "ops@acme.example" };
const out = {};
const tryIt = async (f) => {
  try {
    return { ok: true, value: await f() };
  } catch (e) {
    return { ok: false, status: e.status, error: e.message };
  }
};
const svc = async (cluster, name) => (await base.services(cluster)).find((s) => s.name === name);
const envOf = async (cluster, name) => {
  const s = await svc(cluster, name);
  return (await base.containerEnv(s.taskDef.arn))[0].environment;
};
const apiImage = (await svc("acme-production", "api")).taskDef.image;
const made = await P.runCreate({ env: "production", name: "checkout", image: apiImage, port: 8080, desired: 1, confirm: "checkout", reason: "a new service" }, who);
const A = { key: "ecs:service/acme-production/checkout", kind: "ecs-service", name: "checkout", tags: {} };
const fresh = () => invalidate("discovery:");
// A rollout takes 24 s in the simulation: age a service's deployments instead of waiting for them.
const settle = (name) => {
  for (const s of globalThis.__consoleMockEstates.get("us-east-1").svcs.values()) if (s.name === name) for (const d of s.deployments) d.createdAt -= 60_000;
};
settle("checkout");

fresh();
out.apiPlan = await tryIt(() => connect.plan(A, { to: "ecs:service/acme-production/api" }, ctx));
out.api = await tryIt(() => connect.run(A, { to: "ecs:service/acme-production/api" }, ctx));
const rolling = (await svc("acme-production", "api")).deployments.some((d) => d.rolloutState === "IN_PROGRESS");
out.again = await tryIt(() => connect.run(A, { to: "ecs:service/acme-production/api" }, ctx)); // checkout is rolling out now
// The simulation switches revisions when a rollout completes.
settle("api");
settle("checkout");
const api = await svc("acme-production", "api");
out.apiAfter = { sc: api.serviceConnect, ports: api.taskDef.containers[0].portNames, rollout: rolling };
out.ns = await base.findNamespace("acme-production");
out.checkoutSc = await base.serviceConnectOf("acme-production", "checkout");
out.apiRule = (await base.securityGroups(["sg-prod-api"]))[0].inbound.find((r) => r.groups.includes(made.securityGroup));
out.checkoutEnv = await envOf("acme-production", "checkout");
// The cache: its group is opted in (console:connect=allow).
settle("checkout");
fresh();
out.cachePlan = await tryIt(() => connect.plan(A, { to: "elasticache:acme-production-valkey" }, ctx));
out.cache = await tryIt(() => connect.run(A, { to: "elasticache:acme-production-valkey" }, ctx));
settle("checkout");
fresh();
out.dbPlan = await tryIt(() => connect.plan(A, { to: "rds:acme-production-pg" }, ctx));
out.db = await tryIt(() => connect.run(A, { to: "rds:acme-production-pg" }, ctx));
out.dbEnv = (await envOf("acme-production", "checkout")).some((e) => e.name === "ACME_PRODUCTION_PG_URL");
out.otherEnv = await tryIt(() => connect.plan(A, { to: "ecs:service/acme-staging/api" }, ctx));
out.badVar = await tryIt(() => connect.plan(A, { to: "rds:acme-production-pg", variable: "1BAD" }, ctx));
out.taken = await tryIt(() => connect.plan({ ...A, key: "ecs:service/acme-production/worker", name: "worker" }, { to: "rds:acme-production-pg", variable: "DATABASE_URL" }, ctx));
settle("checkout");
fresh();
out.disPlan = await tryIt(() => disconnect.plan(A, { to: "elasticache:acme-production-valkey" }, ctx));
out.dis = await tryIt(() => disconnect.run(A, { to: "elasticache:acme-production-valkey" }, ctx));
out.valkeyRule = (await base.securityGroups(["sg-prod-valkey"]))[0].inbound.some((r) => r.groups.includes(made.securityGroup));
settle("checkout");
fresh();
out.disAgain = await tryIt(() => disconnect.plan(A, { to: "elasticache:acme-production-valkey" }, ctx));
out.envAfter = (await envOf("acme-production", "checkout")).map((e) => e.name);
// Deleting the new service takes the console's connection rules that name its group (here: in the API's group).
settle("checkout");
out.delPlan = await tryIt(() => P.planDeleteService({ env: "production", service: "checkout" }, who));
out.del = await tryIt(() => P.runDeleteService({ env: "production", service: "checkout", confirm: "checkout", reason: "done with it" }, who));
out.apiRuleAfterDelete = (await base.securityGroups(["sg-prod-api"]))[0].inbound.some((r) => r.groups.includes(made.securityGroup));
// Staging: api and worker share the one host (host networking) — loopback, no rule, no Service Connect.
const S = { key: "ecs:service/acme-staging/api", kind: "ecs-service", name: "api", tags: {} };
fresh();
out.hostPlan = await tryIt(() => connect.plan(S, { to: "ecs:service/acme-staging/worker" }, ctx));
console.log(JSON.stringify(out));
`;

const o = JSON.parse(
  execFileSync(process.execPath, ["--conditions=react-server", "--no-warnings", "--input-type=module", "-e", scenario], {
    encoding: "utf8",
    cwd: new URL("../../", import.meta.url),
    env: {
      ...process.env, CONSOLE_SOURCE: "mock", CONSOLE_SQLITE_PATH: ":memory:", DATABASE_URL: "", CONSOLE_CONFIG: "examples/demo.console.config.json",
      CONSOLE_SECRET_KEY: "test-secret-key-0123456789abcdef0123456789", CONSOLE_REGIONS: "", CONSOLE_SELF: "", ECS_CONTAINER_METADATA_URI_V4: "",
    },
    timeout: 240_000,
  }).trim().split("\n").pop()!,
) as Record<string, unknown>;
interface R { ok: boolean; status?: number; error?: string; value?: { summary?: string; changes?: string[]; warnings?: string[] } & Record<string, unknown> }
const r = (k: string) => o[k] as R;

test("connect a service to a service: Service Connect for B (its namespace and port name), A as a client, the rule and the variable", () => {
  assert.equal(r("apiPlan").ok, true, r("apiPlan").error);
  assert.equal(r("api").ok, true, r("api").error);
  const after = o.apiAfter as unknown as { sc: { discoveryName: string; clientAliases: { dnsName: string; port: number }[] }[]; ports: Record<string, string>; rollout: boolean };
  assert.deepEqual(after.sc, [{ discoveryName: "api", clientAliases: [{ dnsName: "api", port: 3000 }] }]);
  assert.deepEqual(after.ports, { 3000: "port-3000" }, "the port was named first");
  assert.equal(after.rollout, true, "api redeploys");
  assert.match(String(o.ns), /^arn:aws:servicediscovery:us-east-1:123456789012:namespace\//, "one namespace per environment, made on first use");
  assert.equal((o.checkoutSc as { namespace: string }).namespace, "acme-production", "checkout is a client in it");
  assert.deepEqual(o.apiRule, { fromPort: 3000, toPort: 3000, groups: [(o.apiRule as { groups: string[] }).groups[0]], description: "deployment-console: checkout to api" });
  assert.ok((o.checkoutEnv as { name: string; value: string }[]).some((e) => e.name === "API_URL" && e.value === "http://api:3000"));
  assert.deepEqual([r("again").ok, r("again").status], [false, 409], "checkout is rolling out: refused");
});

test("connect to a cache and a database: an opted-in group gets the rule; one nobody opened warns and AWS refuses", () => {
  assert.equal(r("cache").ok, true, r("cache").error);
  assert.ok(r("cachePlan").value?.changes?.some((c) => /Add an inbound rule to acme-production-valkey's security group sg-prod-valkey: 6379\/tcp/.test(c)));
  assert.ok(r("cachePlan").value?.changes?.some((c) => /ACME_PRODUCTION_VALKEY_URL=rediss:\/\/master\.acme-production-valkey\..*:6379/.test(c)));
  assert.equal(r("dbPlan").ok, true, r("dbPlan").error);
  assert.ok(r("dbPlan").value?.warnings?.some((w) => /tag sg-prod-db first, or AWS refuses this rule/.test(w)));
  assert.equal(r("db").ok, false);
  assert.match(String(r("db").error), /UnauthorizedOperation/);
  assert.equal(o.dbEnv, false, "the rule failed first: no variable");
  assert.deepEqual([r("otherEnv").status, r("badVar").status, r("taken").status], [400, 400, 409]);
});

test("disconnect: the console's rule and the variable go, Service Connect stays; a second disconnect has nothing to do", () => {
  assert.equal(r("dis").ok, true, r("dis").error);
  assert.equal(o.valkeyRule, false);
  assert.ok(!(o.envAfter as string[]).includes("ACME_PRODUCTION_VALKEY_URL"));
  assert.ok((o.envAfter as string[]).includes("API_URL"), "other connections stay");
  assert.deepEqual([r("disAgain").ok, r("disAgain").status], [false, 409]);
  assert.match(String(r("disAgain").error), /nothing the console made connects checkout to acme-production-valkey/);
});

test("deleting a connected new service removes the console's connection rules that name its group", () => {
  assert.equal(r("delPlan").ok, true, r("delPlan").error);
  assert.ok(((r("delPlan").value as { changes?: string[] } | undefined)?.changes ?? []).some((c) => /^Remove the console's connection rule sg-prod-api allows sg-0\w+ on 3000$/.test(c)), JSON.stringify(r("delPlan").value));
  assert.equal(r("del").ok, true, r("del").error);
  assert.equal(o.apiRuleAfterDelete, false);
});

test("services on one EC2 host with host networking connect over loopback: no rule, no Service Connect", () => {
  assert.equal(r("hostPlan").ok, true, r("hostPlan").error);
  assert.deepEqual(r("hostPlan").value?.changes, [
    "Same EC2 host: api reaches worker on 127.0.0.1 — no security group change",
    "Set WORKER_URL=http://127.0.0.1:8080 on api's container api: a new task definition revision, then a rolling deployment",
  ]);
});
