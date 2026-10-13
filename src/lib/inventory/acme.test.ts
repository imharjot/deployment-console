// End-to-end: the simulated Acme account (CONSOLE_SOURCE=mock) through every registered provider, infer, assign and
// idle — the same build GET /api/inventory serves. Server modules import "server-only", so the build runs in a child
// process with the react-server condition; this test only reads its JSON. Checks for provider groups that aren't
// registered yet are skipped, not failed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NOT_IMPLEMENTED } from "../permissions.ts";
import type { InventoryView } from "./types.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));

// Runs `body` (an async function body with `mod(path)` to import a server module) in a child process against the
// simulated account and a throw-away console DB; returns what it returns, as JSON. `env` adds variables (CONSOLE_REGIONS).
function inChild<T>(body: string, env: Record<string, string> = {}): T {
  const dir = mkdtempSync(path.join(tmpdir(), "dc-inventory-"));
  try {
    const base = new URL("../server/", import.meta.url).href;
    const code = `const mod = (p) => import(new URL(p, ${JSON.stringify(base)}).href); const out = await (async () => { ${body} })(); process.stdout.write(JSON.stringify(out), () => process.exit(0));`;
    const r = spawnSync(process.execPath, ["--conditions=react-server", "--no-warnings", "--input-type=module", "-e", code], {
      cwd: root, encoding: "utf8", timeout: 90_000, maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, CONSOLE_SOURCE: "mock", CONSOLE_DATA_DIR: dir, CONSOLE_CONFIG: "", AUTH_MODE: "dev", NODE_ENV: "test", ...env },
    });
    assert.equal(r.status, 0, `child failed:\n${r.stderr?.slice(-3000)}`);
    return JSON.parse(r.stdout) as T;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const build = () => inChild<InventoryView>(`return (await mod("inventory.ts")).getInventory();`);

test("the simulated Acme account becomes one connected cloud map, without a secret in it", () => {
  const v = build();
  const byKey = new Map(v.resources.map((r) => [r.key, r]));
  const has = (from: string, to: string, kind?: string) => v.edges.find((e) => e.from === from && e.to === to && (!kind || e.kind === kind));
  const ok = (id: string) => v.providers.find((p) => p.id === id)?.state === "ok";

  // ECS core (always present)
  for (const id of ["ecs", "elb", "rds", "elasticache"]) assert.ok(ok(id), `${id}: ${JSON.stringify(v.providers.find((p) => p.id === id))}`);
  assert.equal(v.accountId, "123456789012");
  assert.deepEqual(v.envs.slice(0, 2).map((e) => [e.id, e.protected]), [["staging", false], ["production", true]]);
  const api = "ecs:service/acme-production/api";
  assert.equal(byKey.get(api)?.env, "production");
  const db = has(api, "rds:acme-production-pg", "sql");
  assert.ok(db && db.confidence === "allowed" && db.evidence.includes("env DATABASE_URL") && db.evidence.some((x) => x.startsWith("security group")), JSON.stringify(db));
  assert.ok(has("elb:acme-production", api, "route"), "listener rule → service");
  assert.ok(has("ecs:service/acme-staging/api", "ecs:service/acme-staging/worker", "http"), "localhost peer on the shared host network");
  assert.ok(!has("ecs:service/acme-staging/api", "rds:acme-production-pg"), "staging never talks to production");

  // Integrity: every edge joins two resources; no self edges; no secret values anywhere.
  for (const e of v.edges) assert.ok(byKey.has(e.from) && byKey.has(e.to) && e.from !== e.to, `dangling edge ${e.id}`);
  const json = JSON.stringify(v);
  for (const secret of ["-pass@", "pg-api-production-pass", "sk_live_fake", "whsec_fake", "jwt-fake", "smtp-fake"]) assert.ok(!json.includes(secret), `leaked ${secret}`);

  // Edge group (DNS, CDN, S3), when registered.
  if (ok("route53")) assert.ok(v.edges.some((e) => byKey.get(e.from)?.kind === "route53-zone" && e.to === "elb:acme-production"), "api.acme.example → the ALB");
  if (ok("s3")) {
    assert.ok(has(api, "arn:aws:s3:::acme-production-uploads", "uses"), "UPLOADS_BUCKET");
    assert.ok(byKey.get("arn:aws:s3:::acme-old-backups")?.idle, "the old backups bucket is idle");
  }
  // Serverless group, when registered.
  const table = v.resources.find((r) => r.kind === "dynamodb" && r.name === "acme-production-sessions");
  if (table) assert.ok(has(api, table.key, "uses"), "SESSIONS_TABLE");
  const topic = v.resources.find((r) => r.kind === "sns" && r.name === "acme-production-notifications");
  if (topic) assert.ok(has("ecs:service/acme-production/worker", topic.key, "writes"), "NOTIFICATIONS_TOPIC_ARN");
  const queue = v.resources.find((r) => r.kind === "sqs" && r.name === "acme-production-orders");
  if (queue) assert.ok(has("ecs:service/acme-production/billing", queue.key, "writes"), "ORDERS_QUEUE_URL");
  // Compute group, when registered: the staging services run on the staging host.
  const box = byKey.get("ec2:i-0a1b2c3d4e5f67890");
  if (box) assert.ok(has("ecs:service/acme-staging/api", box.key, "uses"), "EC2 launch type → its host");
});

test("two regions: the eu-west-1 estate joins as production-eu-west-1, and the home-region map is unchanged", () => {
  // Phase 2 (regions other than home) merges after phase 1 is served: read until nothing is pending.
  const read = `const { getInventory } = await mod("inventory.ts");
    let v = await getInventory();
    for (let i = 0; i < 40 && v.partial?.pendingRegions?.length; i++) { await new Promise((r) => setTimeout(r, 250)); v = await getInventory(); }
    return { v, envs: await (await mod("discovery.ts")).listEnvs() };`;
  // The demo config lists both regions; CONSOLE_REGIONS (which wins over it) narrows the first build to home only.
  const one = inChild<{ v: InventoryView }>(read, { CONSOLE_REGIONS: "us-east-1" }).v;
  const { v, envs } = inChild<{ v: InventoryView; envs: { id: string; label: string; region: string; protected: boolean }[] }>(read, { CONSOLE_REGIONS: "us-east-1,eu-west-1" });
  assert.deepEqual(one.regions, ["us-east-1"]);
  assert.deepEqual(v.regions, ["us-east-1", "eu-west-1"]);
  assert.equal(v.homeRegion, "us-east-1");
  assert.equal(v.partial, undefined, "every region merged");

  // Discovery: the colliding production cluster in eu-west-1 gets a region-suffixed id; home ids are unchanged.
  assert.deepEqual(envs.map((e) => [e.id, e.region, e.protected]), [["staging", "us-east-1", false], ["production", "us-east-1", true], ["production-eu-west-1", "eu-west-1", true]]);
  assert.equal(envs[2].label, "Production (eu-west-1)");

  // The map: the eu services under @eu-west-1 keys in their own env; nothing in the home region changed.
  const eu = v.resources.filter((r) => r.region === "eu-west-1");
  for (const s of ["api", "worker"]) {
    const r = eu.find((x) => x.key === `ecs:service/acme-production/${s}@eu-west-1`);
    assert.ok(r && r.env === "production-eu-west-1", `${s}@eu-west-1: ${JSON.stringify(r && { env: r.env, region: r.region })}`);
  }
  const home = (view: InventoryView) => view.resources.filter((r) => r.region !== "eu-west-1").map((r) => `${r.key} ${r.env ?? "-"}`).sort();
  assert.deepEqual(home(v), home(one), "home-region resources and their envs are the same with a second region");
  assert.equal(v.resources.find((r) => r.key === "ecs:service/acme-production/api")?.env, "production", "the home api stays in production");
  const keys = new Set(v.resources.map((r) => r.key));
  for (const e of v.edges) assert.ok(keys.has(e.from) && keys.has(e.to), `dangling edge ${e.id}`);
  assert.ok(!v.edges.some((e) => e.from.endsWith("@eu-west-1") !== e.to.endsWith("@eu-west-1") && [e.from, e.to].every((k) => k.startsWith("ecs:service/"))), "no service edge crosses regions");
});

// Audit §6 G.2: the coverage providers end to end, both regions merged. The demo config gains one workload whose
// `uses` names a foreign account's queue (a remote reference, R14), the eu-west-1 api by ARN (it must land on the
// @eu-west-1 key, never on the home api's region-less one) and the home database by ARN (its short key).
test("coverage (audit §6 G.2): every built provider ok, the key cross-resource links and rules, both regions, no key collisions", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "dc-acme-config-"));
  try {
    const config = JSON.parse(readFileSync(path.join(root, "examples/demo.console.config.json"), "utf8")) as { workloads?: Record<string, unknown> };
    const FOREIGN = "arn:aws:sqs:eu-central-1:999999999999:partner-orders";
    config.workloads = {
      ...config.workloads,
      "partner-sync": { name: "Partner sync", env: "production", uses: [FOREIGN, "arn:aws:ecs:eu-west-1:123456789012:service/acme-production/api", "arn:aws:rds:us-east-1:123456789012:db:acme-production-pg"] },
    };
    const file = path.join(dir, "console.config.json");
    writeFileSync(file, JSON.stringify(config));
    const { v, covers } = inChild<{ v: InventoryView; covers: Record<string, string[]> }>(`const { getInventory } = await mod("inventory.ts");
      let v = await getInventory();
      for (let i = 0; i < 40 && v.partial?.pendingRegions?.length; i++) { await new Promise((r) => setTimeout(r, 250)); v = await getInventory(); }
      const { PROVIDERS } = await mod("providers/index.ts");
      return { v, covers: Object.fromEntries(PROVIDERS.map((p) => [p.id, p.covers ?? []])) };`, { CONSOLE_REGIONS: "us-east-1,eu-west-1", CONSOLE_CONFIG: file });

    const byKey = new Map(v.resources.map((r) => [r.key, r]));
    const kindOf = (k: string) => byKey.get(k)?.kind;
    const edge = (from: (k: string) => boolean, to: (k: string) => boolean, kind?: string) => v.edges.find((e) => from(e.from) && to(e.to) && (!kind || e.kind === kind));
    const is = (key: string) => (k: string) => k === key;
    const ofKind = (kind: string) => (k: string) => kindOf(k) === kind;
    const named = (name: string) => v.resources.find((r) => r.name === name);

    // Every registered provider that is built runs ok in every region; the rest are the planned ones (not implemented
    // yet: no permissions, outside the counts). Nothing was denied, failed or cut short.
    const planned = v.providers.filter((p) => p.state === "disabled" && p.error === NOT_IMPLEMENTED);
    const built = v.providers.filter((p) => !planned.includes(p));
    assert.deepEqual(built.filter((p) => p.state !== "ok").map((p) => `${p.id}: ${p.state} ${p.error ?? ""}`), []);
    assert.ok(built.length >= 48, `${built.length} built providers`);
    assert.equal(built.at(-1)?.id, "catchall");
    for (const p of built) assert.ok(p.regions?.every((r) => r.state === "ok" || r.state === "skipped"), `${p.id}: ${JSON.stringify(p.regions)}`);
    assert.deepEqual([v.completeness?.providers.denied, v.completeness?.providers.error, v.completeness?.providers.partial], [0, 0, 0]);

    // Key edges.
    assert.ok(edge(ofKind("cloudmap-service"), is("ecs:service/acme-production/api"), "route"), "Cloud Map service → the ECS service registered in it");
    assert.ok(edge(ofKind("acm-certificate"), is("elb:acme-production"), "tls"), "certificate → the ALB serving it");
    const pg = byKey.get("rds:acme-production-pg");
    assert.ok(edge(ofKind("cloudwatch-alarm"), is("rds:acme-production-pg"), "monitors"), "alarm → the database its metric names");
    assert.equal(pg?.health, "warning");
    assert.match(pg?.healthReason ?? "", /alarm .* is in ALARM/);
    // The target-tracking pair watches api, and its AlarmLow is in ALARM: a scaling action, never a warning.
    const scaling = v.resources.filter((r) => r.kind === "cloudwatch-alarm" && r.facts?.scaling === true);
    assert.ok(scaling.some((a) => a.facts?.alarmState === "ALARM"), "a scaling alarm in ALARM");
    for (const a of scaling) assert.ok(edge(is(a.key), is("ecs:service/acme-production/api"), "monitors"), `${a.name} monitors api`);
    const api = byKey.get("ecs:service/acme-production/api");
    assert.ok(api?.health === "ok" && !/alarm/i.test(api.healthReason ?? ""), `api: ${api?.health} ${api?.healthReason ?? ""}`);
    // R4: the staging database is reachable from the internet.
    const stg = byKey.get("rds:acme-staging-pg");
    assert.equal(stg?.health, "error");
    assert.match(stg?.healthReason ?? "", /reachable from the internet on 5432\/tcp/);
    assert.ok(edge(is("external:internet"), is("rds:acme-staging-pg")), "external:internet → acme-staging-pg");
    // R2: the legacy key dies in 5 days (inside 7: an error) and takes the old backups bucket's encryption with it.
    const backups = byKey.get("arn:aws:s3:::acme-old-backups");
    assert.ok(edge(ofKind("kms-key"), is("arn:aws:s3:::acme-old-backups"), "encrypts"));
    assert.equal(backups?.health, "error");
    assert.match(backups?.healthReason ?? "", /^KMS key acme-legacy-backups is pending deletion/);
    // A stack → what it manages.
    const stack = named("acme-production-data");
    assert.equal(stack?.kind, "cfn-stack");
    for (const to of ["rds:acme-production-pg", "elasticache:acme-production-valkey"]) assert.ok(edge(is(stack!.key), is(to), "manages"), `stack → ${to}`);
    // A standalone ALB (no ECS behind it) reports its own backend: its one instance target is unhealthy.
    const ops = byKey.get("elb:acme-ops-internal");
    assert.ok(ops && ops.health === "error" && ops.healthReason === "0/1 active target group healthy", `${ops?.health} ${ops?.healthReason}`);
    assert.ok(ops.props.some((p) => p.label === "Targets" && p.value === "1 unhealthy"));
    assert.ok(edge(is("elb:acme-ops-internal"), ofKind("ec2-instance"), "route"), "the ALB → its instance target");

    // Both regions, and no key collisions.
    assert.deepEqual(v.regions, ["us-east-1", "eu-west-1"]);
    const euProviders = new Set(v.resources.filter((r) => r.region === "eu-west-1").map((r) => r.provider));
    for (const id of ["ecs", "rds", "rds-cluster", "kms", "acm", "logs", "ecr", "vpc"]) assert.ok(euProviders.has(id), `${id} has eu-west-1 resources`);
    assert.equal(byKey.size, v.resources.length, "no duplicate keys");
    const arnAliases = new Map<string, string>();
    for (const r of v.resources)
      for (const a of (r.aliases ?? []).filter((x) => x.startsWith("arn:"))) {
        assert.ok(!byKey.has(a) || a === r.key, `${r.key}: alias ${a} is another resource's key`);
        assert.equal(arnAliases.get(a) ?? r.key, r.key, `ARN ${a} names both ${arnAliases.get(a)} and ${r.key}`);
        arnAliases.set(a, r.key);
      }
    // No eu-west-1 ARN resolves to a home region-less console key (CC-6): those keys belong to the home region only,
    // and everything in eu-west-1 carries its region in its key (S3 bucket ARNs have none by design).
    const SHORT = /^(rds:|elb:|elasticache:|ecs:service\/|ec2:)/;
    for (const r of v.resources) {
      if (SHORT.test(r.key) && !r.key.includes("@")) {
        assert.equal(r.region, "us-east-1", r.key);
        assert.ok(![r.key, ...(r.aliases ?? [])].some((a) => a.startsWith("arn:") && a.split(":")[3] === "eu-west-1"), `${r.key} holds an eu-west-1 ARN`);
      }
      if (r.region === "eu-west-1") assert.ok(r.key.endsWith("@eu-west-1") || r.key.split(":")[3] === "eu-west-1" || r.key.startsWith("arn:aws:s3:::"), r.key);
    }
    assert.ok(edge(is("workload:partner-sync"), is("ecs:service/acme-production/api@eu-west-1"), "uses"), "the eu api's ARN → its @eu-west-1 key");
    assert.ok(!edge(is("workload:partner-sync"), is("ecs:service/acme-production/api")), "… never the home api");
    assert.ok(edge(is("workload:partner-sync"), is("rds:acme-production-pg"), "uses"), "a home ARN → the short key");

    // A foreign account's ARN becomes a remote reference node (R14), never a guess at a local resource.
    const ref = byKey.get(FOREIGN);
    assert.deepEqual([ref?.kind, ref?.source, ref?.facts?.remote, ref?.account, ref?.region, ref?.health], ["aws-resource", "reference", true, "999999999999", "eu-central-1", "unknown"]);
    assert.ok(edge(is("workload:partner-sync"), is(FOREIGN), "uses"));
    assert.ok(!v.resources.some((r) => r.key !== FOREIGN && r.name === "partner-orders"), "no local stand-in");

    // The long tail: the wave-C app providers, and catch-all rows (on the map when the type is allow-listed, folded
    // into the table otherwise).
    for (const kind of ["batch-environment", "batch-queue", "transfer-server", "appsync-api", "amplify-app", "lightsail-instance", "lightsail-container", "lightsail-database"])
      assert.ok(v.resources.some((r) => r.kind === kind), `${kind} present`);
    const generic = v.resources.filter((r) => r.kind === "aws-resource" && r.source !== "reference");
    assert.ok(generic.some((r) => r.key === "arn:aws:sagemaker:us-east-1:123456789012:endpoint/acme-recs" && !r.hidden), "a long-tail type on the map (SageMaker endpoint)");
    assert.ok(generic.some((r) => r.hidden), "table-only rows stay off the map");
    for (const r of generic) assert.ok(r.service && r.resourceType && r.category, `${r.key}: labelled`);
    // B.4: a type a built provider covers never comes back as a generic row (it would be on the map twice).
    const covered = new Set(built.flatMap((p) => covers[p.id] ?? []));
    assert.deepEqual(generic.filter((r) => covered.has(r.resourceType ?? "")).map((r) => `${r.key} (${r.resourceType})`), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the action runner: roles, protected confirmation, human-only actions, audit before the run, fresh map after", () => {
  const out = inChild<Record<string, unknown>>(`
    const { runAction, listActions } = await mod("inventory-actions.ts");
    const { getInventory } = await mod("inventory.ts");
    const { readAudit } = await mod("audit.ts");
    const op = { id: "u1", email: "op@example.com", role: "operator" };
    const viewer = { id: "u2", email: "viewer@example.com", role: "viewer" };
    const admin = { id: "u3", email: "admin@example.com", role: "admin" };
    const who = (user, token) => ({ user, actor: user.email, token });
    const status = (p) => p.then(() => 200, (e) => e.status ?? 500);
    const v = await getInventory();
    const bastion = v.resources.find((r) => r.kind === "ec2-instance" && r.name === "acme-bastion");
    const bucket = v.resources.find((r) => r.kind === "s3" && r.env === "production");
    const queue = v.resources.find((r) => r.kind === "sqs" && r.env === "production" && !r.name.endsWith("-dlq"));
    const res = {};
    if (bucket) {
      res.humanForPeople = (await listActions(bucket.key, op)).some((a) => a.id === "download-object");
      res.humanForTokens = (await listActions(bucket.key, op, { token: true })).some((a) => a.id === "download-object");
      res.humanRun = await status(runAction({ key: bucket.key, provider: "s3", action: "download-object", input: { key: "x" }, dryRun: true }, who(op, true)));
    }
    if (bastion) {
      const stop = { key: bastion.key, provider: "ec2", action: "stop", input: {} };
      res.viewer = await status(runAction({ ...stop, dryRun: true }, who(viewer)));
      res.plan = (await runAction({ ...stop, dryRun: true }, who(op))).plan;
      res.wrongConfirm = await status(runAction({ ...stop, dryRun: false, confirm: "nope" }, who(op)));
      res.run = await runAction({ ...stop, dryRun: false, confirm: bastion.name, reason: "acme test" }, who(op));
      res.audit = (await readAudit(10)).map((a) => [a.phase, a.action, a.target, a.env, a.result ?? null]);
      res.after = (await getInventory()).resources.find((r) => r.key === bastion.key)?.health;
    }
    if (queue) {
      const purge = { key: queue.key, provider: "sqs", action: "purge", input: {} };
      res.operatorOnProtected = await status(runAction({ ...purge, dryRun: true }, who(op)));
      res.dangerPlan = (await runAction({ ...purge, dryRun: true }, who(admin))).plan;
      res.dangerYes = await status(runAction({ ...purge, dryRun: false, confirm: "yes", reason: "cleanup" }, who(admin)));
      res.dangerNoReason = await status(runAction({ ...purge, dryRun: false, confirm: queue.name }, who(admin)));
      res.queueName = queue.name;
    }
    res.unknown = await status(runAction({ key: "nope:x", provider: "ec2", action: "stop", input: {}, dryRun: true }, who(op)));
    res.wrongKind = bastion ? await status(runAction({ key: bastion.key, provider: "sqs", action: "purge", input: {}, dryRun: true }, who(op))) : 400;
    return res;
  `);
  assert.equal(out.unknown, 404);
  assert.equal(out.wrongKind, 400);
  if ("humanRun" in out) {
    assert.deepEqual([out.humanForPeople, out.humanForTokens, out.humanRun], [true, false, 403], "human-only actions: people yes, tokens never");
  }
  if ("plan" in out) {
    assert.equal(out.viewer, 403);
    assert.equal((out.plan as { confirm: string }).confirm, "acme-bastion", "in no environment: the careful rules (name + reason) by default");
    assert.equal(out.wrongConfirm, 400);
    assert.ok((out.run as { result: unknown }).result !== undefined);
    const audit = out.audit as [string, string, string, string, string | null][];
    assert.deepEqual(audit.slice(0, 2).map((a) => a.slice(0, 2)), [["result", "ec2.stop"], ["intent", "ec2.stop"]], "intent before, result after");
    assert.equal(audit[0][4], "ok");
    assert.ok(["stopped", "warning"].includes(out.after as string), `the map re-read EC2 after the action (health ${out.after})`);
  }
  if ("dangerPlan" in out) {
    const p = out.dangerPlan as { confirm: string; warnings?: string[] };
    assert.equal(p.confirm, out.queueName, "danger: type the resource name");
    assert.ok(p.warnings?.some((w) => w.includes("reason")));
    assert.deepEqual([out.operatorOnProtected, out.dangerYes, out.dangerNoReason], [403, 400, 400], "provision on production needs admin; name + reason");
  }
});
