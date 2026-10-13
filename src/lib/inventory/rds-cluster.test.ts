// RDS clusters and proxies (rds-cluster.ts): golden SDK shapes in, keys / links / health / facts out, with a secret
// sentinel that must never reach the map — and, in a child process against the simulated account, the six data
// providers of b-prov-data themselves (rds-cluster, efs, opensearch, redshift, elasticache-serverless, memorydb):
// per-region mocks, checkpoints, detail sections and IAM declarations.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  clusterDetail, clusterHealth, clusterKind, clusterResource, customEndpointArn, globalLinks, proxyDetail, proxyHealth, proxyResource, rdsClusterResult,
  type RawDbCluster, type RawGlobalCluster, type RawProxy,
} from "./rds-cluster.ts";
import { infer } from "./infer.ts";
import type { Resource } from "./types.ts";

const ACCT = "123456789012";
const R = "us-east-1";
const EU = "eu-west-1";
const NOW = Date.UTC(2026, 9, 5, 12);
const SENTINEL = "SECRET_SENTINEL_rdsc";
const o = { region: R, account: ACCT, home: R, regions: [R, EU], now: NOW };
const arn = (id: string, region = R) => `arn:aws:rds:${region}:${ACCT}:cluster:${id}`;

const aurora: RawDbCluster = {
  DBClusterIdentifier: "orders-db", DBClusterArn: arn("orders-db"), DbClusterResourceId: "cluster-ABC123", Engine: "aurora-postgresql", EngineVersion: "16.4", EngineMode: "provisioned",
  Status: "available", Endpoint: "orders-db.cluster-c1.us-east-1.rds.amazonaws.com", ReaderEndpoint: "orders-db.cluster-ro-c1.us-east-1.rds.amazonaws.com",
  CustomEndpoints: ["reporting.cluster-custom-c1.us-east-1.rds.amazonaws.com"], Port: 5432, MultiAZ: true, DBSubnetGroup: "prod-db",
  VpcSecurityGroups: [{ VpcSecurityGroupId: "sg-db", Status: "active" }],
  DBClusterMembers: [{ DBInstanceIdentifier: "orders-db-1", IsClusterWriter: true, PromotionTier: 1 }, { DBInstanceIdentifier: "orders-db-2", IsClusterWriter: false, PromotionTier: 2 }],
  StorageEncrypted: true, KmsKeyId: `arn:aws:kms:${R}:${ACCT}:key/k1`, DeletionProtection: true, BackupRetentionPeriod: 7, PreferredBackupWindow: "03:00-03:30",
  ClusterCreateTime: "2025-01-02T03:04:05.000Z", TagList: [{ Key: "Environment", Value: "production" }],
  AssociatedRoles: [{ RoleArn: `arn:aws:iam::${ACCT}:role/s3-import`, FeatureName: "s3Import", Status: "ACTIVE" }],
  MasterUserSecret: { SecretArn: `arn:aws:secretsmanager:${R}:${ACCT}:secret:rds!cluster-abc-XyZ123`, SecretStatus: "active" },
  ...({ MasterUsername: SENTINEL, ActivityStreamKinesisStreamName: SENTINEL, DomainMemberships: [{ Domain: SENTINEL }] } as object),
};
const subnetGroups = [{ DBSubnetGroupName: "prod-db", VpcId: "vpc-prod", Subnets: [{ SubnetIdentifier: "subnet-a" }, { SubnetIdentifier: "subnet-b" }] }];

test("golden: an Aurora cluster — key, network from its subnet group, endpoints, links; nothing secret leaks", () => {
  const { resource, links } = clusterResource(aurora, { subnetGroups, subnetGroupsState: "ok" }, o);
  assert.deepEqual(resource, {
    key: arn("orders-db"), kind: "rds-cluster", provider: "rds-cluster", name: "orders-db", region: R, tags: { Environment: "production" }, health: "ok",
    props: [
      { label: "Engine", value: "aurora-postgresql 16.4" }, { label: "Members", value: "writer orders-db-1 · 1 reader" },
      { label: "Endpoint", value: "orders-db.cluster-c1.us-east-1.rds.amazonaws.com", mono: true }, { label: "Reader endpoint", value: "orders-db.cluster-ro-c1.us-east-1.rds.amazonaws.com", mono: true },
      { label: "Port", value: "5432" }, { label: "Multi-AZ", value: "yes" }, { label: "Encryption", value: "KMS key/k1" }, { label: "Backups", value: "7 days · window 03:00-03:30" },
      { label: "Deletion protection", value: "on" }, { label: "Subnet group", value: "prod-db" }, { label: "Created", value: "2025-01-02 03:04 UTC" },
    ],
    endpoints: ["orders-db.cluster-c1.us-east-1.rds.amazonaws.com", "orders-db.cluster-ro-c1.us-east-1.rds.amazonaws.com", "reporting.cluster-custom-c1.us-east-1.rds.amazonaws.com"],
    aliases: ["orders-db", "cluster-ABC123", `arn:aws:rds:${R}:${ACCT}:cluster-endpoint:reporting`],
    vpcId: "vpc-prod", subnetIds: ["subnet-a", "subnet-b"], securityGroups: ["sg-db"],
    consoleUrl: `https://${R}.console.aws.amazon.com/rds/home?region=${R}#database:id=orders-db;is-cluster=true`, createdAt: Date.parse("2025-01-02T03:04:05.000Z"), observedAt: NOW,
  });
  assert.deepEqual(links.map((l) => [l.from, l.to, l.kind, l.label]), [
    [`arn:aws:kms:${R}:${ACCT}:key/k1`, arn("orders-db"), "encrypts", "at rest"],
    [arn("orders-db"), `arn:aws:iam::${ACCT}:role/s3-import`, "assumes", "associated role (s3Import)"],
    [arn("orders-db"), `arn:aws:secretsmanager:${R}:${ACCT}:secret:rds!cluster-abc-XyZ123`, "reads", "master user password (managed by RDS)"],
  ]);
  const detail = clusterDetail(arn("orders-db"), aurora, { subnetGroup: subnetGroups[0] });
  assert.ok(!JSON.stringify({ resource, links, detail }).includes(SENTINEL));
  assert.deepEqual(detail.sections.map((s) => s.title), ["Cluster", "Members", "Endpoints", "Network", "Backups and maintenance"]);
  assert.deepEqual(detail.sections[1].table?.rows, [["orders-db-1", "writer", "1"], ["orders-db-2", "reader", "2"]]);
  assert.deepEqual(detail.sections[2].table?.rows.map((r) => r[0]), ["writer", "reader", "custom"]);
});

test("kind by engine; Multi-AZ DB clusters carry facts.public; an unread subnet group is said so (CC-14)", () => {
  assert.deepEqual(["aurora-mysql", "postgres", "docdb", "neptune", undefined].map(clusterKind), ["rds-cluster", "rds-cluster", "docdb-cluster", "neptune-cluster", "rds-cluster"]);
  const out = rdsClusterResult({
    clusters: [
      { DBClusterIdentifier: "maz", Engine: "postgres", Status: "available", PubliclyAccessible: true, DBSubnetGroup: "pub", StorageEncrypted: true, KmsKeyId: "alias/aws/rds" },
      { DBClusterIdentifier: "docs", Engine: "docdb", Status: "stopped" },
      { DBClusterIdentifier: "graph", Engine: "neptune", Status: "available" },
    ],
    subnetGroupsState: "denied", proxies: [],
  }, { region: EU, account: ACCT, home: R });
  const [maz, docs, graph] = out.resources;
  assert.equal(maz.key, arn("maz", EU));
  assert.deepEqual(maz.facts, { public: true });
  assert.deepEqual(maz.enrichment, { "subnet group": "denied" });
  assert.equal(maz.props.find((p) => p.label === "Subnet group")?.value, "pub (subnets not read (denied))");
  assert.equal(maz.vpcId, undefined);
  assert.deepEqual(out.links.map((l) => l.from), [`arn:aws:kms:${EU}:${ACCT}:alias/aws/rds`]);
  assert.deepEqual([docs.kind, docs.health, graph.kind, docs.facts], ["docdb-cluster", "stopped", "neptune-cluster", undefined]);
  assert.match(docs.consoleUrl ?? "", /\/docdb\/home/);
  assert.equal(customEndpointArn("x.cluster-ro-abc.us-east-1.rds.amazonaws.com", R, ACCT), undefined);
});

test("cluster health per A.2 #12", () => {
  const h = (Status: string) => clusterHealth({ Status });
  assert.deepEqual(h("available"), { health: "ok" });
  assert.deepEqual(h("backing-up"), { health: "ok", healthReason: "backing up" });
  assert.equal(h("maintenance").health, "ok");
  assert.equal(h("stopped").health, "stopped");
  for (const s of ["failing-over", "upgrading", "modifying", "migrating", "creating"]) assert.equal(h(s).health, "warning", s);
  for (const s of ["inaccessible-encryption-credentials", "inaccessible-encryption-credentials-recoverable", "failed", "incompatible-parameters", "migration-failed"]) assert.equal(h(s).health, "error", s);
  assert.deepEqual(clusterHealth({ Status: "modifying", PercentProgress: "40" }), { health: "warning", healthReason: "modifying (40 %)" });
  assert.deepEqual(h("deleting"), { health: "stopped", healthReason: "deleting" });
  assert.deepEqual(clusterHealth({}), { health: "unknown", healthReason: "status not reported" });
});

const proxy = (over: Partial<RawProxy> = {}): RawProxy => ({
  DBProxyName: "pg-proxy", DBProxyArn: `arn:aws:rds:${R}:${ACCT}:db-proxy:prx-0abc`, Status: "available", EngineFamily: "POSTGRESQL", VpcId: "vpc-prod",
  VpcSecurityGroupIds: ["sg-db"], VpcSubnetIds: ["subnet-a"], Endpoint: "pg-proxy.proxy-c1.us-east-1.rds.amazonaws.com", RequireTLS: true, IdleClientTimeout: 1800,
  RoleArn: `arn:aws:iam::${ACCT}:role/proxy-secrets`,
  Auth: [{ AuthScheme: "SECRETS", SecretArn: `arn:aws:secretsmanager:${R}:${ACCT}:secret:db-creds-AbCdEf`, IAMAuth: "DISABLED", UserName: SENTINEL, Description: SENTINEL }],
  targets: [
    { Type: "TRACKED_CLUSTER", TrackedClusterId: "orders-db", RdsResourceId: "orders-db", Port: 5432, TargetHealth: { State: "AVAILABLE" } },
    { Type: "RDS_INSTANCE", TrackedClusterId: "orders-db", RdsResourceId: "orders-db-1", Port: 5432, Role: "READ_WRITE", TargetHealth: { State: "AVAILABLE" } },
    { Type: "RDS_INSTANCE", RdsResourceId: "legacy-pg", Port: 5432, Role: "READ_WRITE", TargetHealth: { State: "AVAILABLE" } },
  ],
  enrichment: { targets: "ok" },
  ...over,
});

test("proxy: sql links to a tracked cluster (once) and a standalone instance's console key, its role and credentials", () => {
  const { resource, links } = proxyResource(proxy(), o);
  assert.deepEqual([resource.key, resource.kind, resource.health, resource.tagsUnread, resource.endpoints, resource.aliases], [
    `arn:aws:rds:${R}:${ACCT}:db-proxy:prx-0abc`, "rds-proxy", "ok", true, ["pg-proxy.proxy-c1.us-east-1.rds.amazonaws.com"], ["pg-proxy"],
  ]);
  assert.deepEqual(links.map((l) => [l.to, l.kind, l.label]), [
    [arn("orders-db"), "sql", "postgres:5432"],
    ["rds:legacy-pg", "sql", "postgres:5432"],
    [`arn:aws:iam::${ACCT}:role/proxy-secrets`, "assumes", "proxy role"],
    [`arn:aws:secretsmanager:${R}:${ACCT}:secret:db-creds-AbCdEf`, "reads", "database credentials"],
  ]);
  assert.equal(resource.props.find((p) => p.label === "Authentication")?.value, "secret");
  // Outside the home region the instance key carries the region (CC-6).
  assert.equal(proxyResource(proxy(), { ...o, region: EU }).links[1].to, "rds:legacy-pg@eu-west-1");
  const detail = proxyDetail(resource.key, proxy());
  assert.deepEqual(detail.sections.map((s) => s.title), ["Proxy", "Targets", "Authentication", "Network"]);
  assert.ok(!JSON.stringify({ resource, links, detail }).includes(SENTINEL));
});

test("proxy health: status first, then its targets; unread targets say so", () => {
  assert.deepEqual(proxyHealth({ Status: "available", targets: [] }), { health: "warning", healthReason: "no target registered — the proxy has nothing to connect to" });
  assert.deepEqual(
    proxyHealth({ Status: "available", targets: [{ RdsResourceId: "db1", TargetHealth: { State: "UNAVAILABLE", Reason: "CONNECTION_FAILED", Description: "auth failed" } }, { RdsResourceId: "db2", TargetHealth: { State: "UNUSED" } }] }),
    { health: "warning", healthReason: "1 target unavailable: db1 (auth failed)" },
  );
  assert.deepEqual(proxyHealth({ Status: "available", targets: [{ RdsResourceId: "db2", TargetHealth: { State: "UNUSED" } }] }), { health: "ok" });
  assert.deepEqual(proxyHealth({ Status: "available" }), { health: "ok" });
  for (const s of ["incompatible-network", "insufficient-resource-limits", "suspended"]) assert.equal(proxyHealth({ Status: s }).health, "error", s);
  for (const s of ["creating", "modifying"]) assert.equal(proxyHealth({ Status: s }).health, "warning", s);
  const unread = proxyResource(proxy({ targets: undefined, enrichment: { targets: "skipped" } }), o);
  assert.deepEqual([unread.links.filter((l) => l.kind === "sql").length, unread.resource.props.find((p) => p.label === "Targets")?.value, unread.resource.enrichment], [0, "targets not read (skipped)", { targets: "skipped" }]);
  assert.equal(proxyDetail("k", proxy({ targets: undefined, enrichment: { targets: "denied" } })).sections[1].note, "Targets not read (denied)");
});

test("global database: the primary routes to each secondary, drawn by exactly one run; no global-cluster node", () => {
  const g: RawGlobalCluster = {
    GlobalClusterIdentifier: "orders-global", GlobalClusterArn: `arn:aws:rds::${ACCT}:global-cluster:orders-global`,
    GlobalClusterMembers: [
      { DBClusterArn: arn("orders-db"), IsWriter: true, Readers: [arn("orders-db-eu", EU)] },
      { DBClusterArn: arn("orders-db-eu", EU), IsWriter: false, SynchronizationStatus: "connected" },
    ],
  };
  const us = rdsClusterResult({ clusters: [{ ...aurora, GlobalClusterIdentifier: "orders-global" }], subnetGroups, proxies: [], globals: [g] }, o);
  const eu = rdsClusterResult({ clusters: [{ DBClusterIdentifier: "orders-db-eu", DBClusterArn: arn("orders-db-eu", EU), Engine: "aurora-postgresql", Status: "available", GlobalClusterIdentifier: "orders-global" }], proxies: [], globals: [g] }, { ...o, region: EU });
  assert.deepEqual(us.links.filter((l) => l.kind === "route").map((l) => [l.from, l.to, l.label]), [[arn("orders-db"), arn("orders-db-eu", EU), "global database"]]);
  assert.equal(eu.links.filter((l) => l.kind === "route").length, 0);
  assert.ok(us.resources[0].aliases?.includes(g.GlobalClusterArn!));
  assert.ok(!eu.resources[0].aliases?.includes(g.GlobalClusterArn!));
  assert.equal(us.resources[0].props.find((p) => p.label === "Global database")?.value, "orders-global · primary (1 secondary)");
  assert.equal(eu.resources[0].props.find((p) => p.label === "Global database")?.value, "orders-global · secondary");
  assert.equal(us.resources.length + eu.resources.length, 2);
  // The writer's region isn't covered: the first covered member region draws the links instead.
  assert.equal(globalLinks([g], { region: EU, account: ACCT, regions: [EU, "ap-south-1"] }).length, 1);
  assert.equal(globalLinks([g], { region: "ap-south-1", account: ACCT, regions: [EU, "ap-south-1"] }).length, 0);
  const d = clusterDetail(arn("orders-db"), aurora, { global: g });
  assert.deepEqual(d.sections.at(-1)?.table?.rows, [["orders-db", R, "primary", "—"], ["orders-db-eu", EU, "secondary", "connected"]]);
  // A secondary has only readers: its cluster endpoint takes no writes until it is promoted.
  const secondary = clusterDetail(arn("orders-db-eu", EU), {
    DBClusterIdentifier: "orders-db-eu", Endpoint: "orders-db-eu.cluster-c2.eu-west-1.rds.amazonaws.com", ReaderEndpoint: "orders-db-eu.cluster-ro-c2.eu-west-1.rds.amazonaws.com",
    DBClusterMembers: [{ DBInstanceIdentifier: "orders-db-eu-1", IsClusterWriter: false }],
  }, { global: g });
  assert.deepEqual(secondary.sections.find((s) => s.title === "Endpoints")?.table?.rows.map((r) => r[0]), ["writer (inactive: no writer instance)", "reader"]);
});

test("Resource Explorer's global-cluster and cluster-endpoint rows fold into the cluster, never flagged as unmatched", () => {
  const g: RawGlobalCluster = { GlobalClusterIdentifier: "orders-global", GlobalClusterArn: `arn:aws:rds::${ACCT}:global-cluster:orders-global`, GlobalClusterMembers: [{ DBClusterArn: arn("orders-db"), IsWriter: true }] };
  const own = rdsClusterResult({ clusters: [{ ...aurora, GlobalClusterIdentifier: "orders-global" }], subnetGroups, proxies: [proxy()], globals: [g] }, o);
  const generic = (key: string, resourceType: string, region: string): Resource => ({
    key, kind: "aws-resource", provider: "catchall", name: key.split(":").pop()!, region, tags: { team: "data" }, health: "unknown", props: [], resourceType, source: "resource-explorer",
  });
  const rows = [
    generic(g.GlobalClusterArn!, "rds:global-cluster", "global"), generic(`arn:aws:rds:${R}:${ACCT}:cluster-endpoint:reporting`, "rds:cluster-endpoint", R),
    generic(arn("orders-db"), "rds:cluster", R), generic(`arn:aws:rds:${R}:${ACCT}:db-proxy:prx-0abc`, "rds:db-proxy", R),
  ];
  const covered = new Set(["rds:cluster", "rds:db-proxy", "rds:global-cluster", "rds:cluster-endpoint"].map((t) => `${t}@${R}`));
  const out = infer({ results: [own, { resources: rows, links: [], mentions: [] }], providerOf: (i) => (i ? "catchall" : "rds-cluster"), home: R, covered, accountId: ACCT, regions: [R] });
  assert.deepEqual(out.resources.filter((r) => r.kind === "aws-resource").map((r) => r.key), []);
  assert.deepEqual(out.notes.filter((n) => /key-format/.test(n)), []);
  assert.equal(out.resources.find((r) => r.key === arn("orders-db"))?.tags.team, "data"); // tags the cluster lacked come from the row
});

// ---------- the six data providers, against the simulated account ----------

const root = fileURLToPath(new URL("../../../", import.meta.url));
function inChild<T>(body: string): T {
  const dir = mkdtempSync(path.join(tmpdir(), "dc-prov-data-"));
  try {
    const base = new URL("../server/", import.meta.url).href;
    const code = `const mod = (p) => import(new URL(p, ${JSON.stringify(base)}).href); const out = await (async () => { ${body} })(); process.stdout.write(JSON.stringify(out), () => process.exit(0));`;
    const r = spawnSync(process.execPath, ["--conditions=react-server", "--no-warnings", "--input-type=module", "-e", code], {
      cwd: root, encoding: "utf8", timeout: 90_000, maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, CONSOLE_SOURCE: "mock", CONSOLE_DATA_DIR: dir, CONSOLE_SQLITE_PATH: ":memory:", CONSOLE_CONFIG: "", AUTH_MODE: "dev", NODE_ENV: "test" },
    });
    assert.equal(r.status, 0, `child failed:\n${r.stderr?.slice(-3000)}`);
    return JSON.parse(r.stdout) as T;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

interface Out {
  decl: Record<string, { scope?: string; multiRegionMock?: boolean; ttlMs?: number; covers?: string[]; read: string[]; implicit?: string[]; enabled: boolean; kinds?: string[] }>;
  us: Record<string, { resources: Resource[]; links: { from: string; to: string; kind: string; label?: string }[] }>;
  eu: Record<string, { keys: string[]; links: { from: string; to: string; kind: string }[] }>;
  other: Record<string, number>;
  details: Record<string, string[]>;
  activity: Record<string, { namespace: string; metric: string; dims: Record<string, string>; required?: boolean }[]>;
}

test("the data providers on the simulated account: per-region mocks, links, detail sections, activity", () => {
  const out = inChild<Out>(`
    const files = { "rds-cluster": "rdsClusterProvider", efs: "efsProvider", opensearch: "opensearchProvider", redshift: "redshiftProvider", "elasticache-serverless": "elasticacheServerlessProvider", memorydb: "memorydbProvider" };
    const ps = {};
    for (const [f, name] of Object.entries(files)) ps[f] = (await mod("providers/" + f + ".ts"))[name];
    const ctx = (region) => ({ region, home: "us-east-1", regions: ["us-east-1", "eu-west-1"], accountId: "123456789012", mock: true, cap: 2000, signal: new AbortController().signal, limit: (fn) => fn(), note: () => {} });
    const decl = {}, us = {}, eu = {}, other = {}, details = {}, activity = {};
    for (const [id, p] of Object.entries(ps)) {
      decl[id] = { scope: p.scope, multiRegionMock: p.multiRegionMock, ttlMs: p.ttlMs, covers: p.covers, read: p.read, implicit: p.implicit, enabled: (p.enabled?.() ?? { ok: true }).ok, kinds: p.kinds };
      const a = await p.discover(ctx("us-east-1"));
      us[id] = { resources: a.resources, links: a.links };
      const b = await p.discover(ctx("eu-west-1"));
      eu[id] = { keys: b.resources.map((r) => r.key), links: b.links };
      other[id] = (await p.discover(ctx("ap-south-1"))).resources.length;
      for (const r of a.resources) {
        const d = await p.detail(r, ctx("us-east-1"));
        details[r.key] = d.sections.map((s) => s.title);
        activity[r.key] = p.activity?.(r) ?? [];
      }
    }
    return { decl, us, eu, other, details, activity };
  `);
  for (const [id, d] of Object.entries(out.decl)) {
    assert.deepEqual([d.scope, d.multiRegionMock, d.enabled], ["regional", true, true], id);
    assert.ok(d.read.length && d.kinds?.length, id);
    assert.equal(out.other[id], 0, `${id}: regions outside the simulation are empty`);
    for (const r of out.us[id].resources) assert.ok(out.details[r.key]?.length, `${id}: ${r.key} has detail sections`);
  }
  // rds-cluster: Aurora acme-analytics (primary of the global database) and the proxy in front of acme-production-pg.
  const rds = out.us["rds-cluster"];
  const analytics = rds.resources.find((r) => r.name === "acme-analytics")!;
  assert.equal(analytics.key, "arn:aws:rds:us-east-1:123456789012:cluster:acme-analytics");
  assert.deepEqual([analytics.kind, analytics.health, analytics.vpcId, analytics.subnetIds, analytics.securityGroups], ["rds-cluster", "ok", "vpc-prod", ["subnet-prod-a", "subnet-prod-b"], ["sg-prod-db"]]);
  assert.ok(analytics.aliases?.includes("arn:aws:rds::123456789012:global-cluster:acme-analytics-global"));
  assert.equal(analytics.props.find((p) => p.label === "Members")?.value, "writer acme-analytics-1 · 1 reader");
  const proxy = rds.resources.find((r) => r.kind === "rds-proxy")!;
  assert.equal(proxy.name, "acme-production-pg-proxy");
  assert.deepEqual(rds.links.filter((l) => l.kind === "sql").map((l) => [l.from, l.to]), [[proxy.key, "rds:acme-production-pg"]]);
  assert.deepEqual(rds.links.filter((l) => l.kind === "route").map((l) => [l.from, l.to]), [[analytics.key, "arn:aws:rds:eu-west-1:123456789012:cluster:acme-analytics-eu"]]);
  assert.deepEqual(out.eu["rds-cluster"].keys, ["arn:aws:rds:eu-west-1:123456789012:cluster:acme-analytics-eu"]);
  assert.equal(out.eu["rds-cluster"].links.filter((l) => l.kind === "route").length, 0);
  assert.deepEqual(out.details[analytics.key], ["Cluster", "Members", "Endpoints", "Network", "Backups and maintenance", "Global database acme-analytics-global"]);
  assert.deepEqual(out.activity[analytics.key].map((a) => [a.namespace, a.metric, a.dims, a.required]), [["AWS/RDS", "DatabaseConnections", { DBClusterIdentifier: "acme-analytics" }, true]]);
  assert.deepEqual(out.activity[proxy.key].map((a) => [a.metric, a.dims]), [["ClientConnections", { ProxyName: "acme-production-pg-proxy" }]]);
  // Nothing links a cluster to its instances (the rds provider sets their parent).
  assert.ok(!rds.links.some((l) => /:db:acme-analytics-/.test(l.to) || /^rds:acme-analytics/.test(l.to)));

  // efs: the key the ECS side's "mounts" link names (arnOf.efs), its access point as an alias, two mount targets.
  const [media] = out.us.efs.resources;
  assert.deepEqual([media.key, media.health, media.vpcId, media.subnetIds, media.securityGroups], [
    "arn:aws:elasticfilesystem:us-east-1:123456789012:file-system/fs-0acme0media000001", "ok", "vpc-prod", ["subnet-prod-a", "subnet-prod-b"], ["sg-prod-default"],
  ]);
  assert.ok(media.aliases?.includes("arn:aws:elasticfilesystem:us-east-1:123456789012:access-point/fsap-0acme0media00001"));
  assert.equal(media.endpoints?.[0], "fs-0acme0media000001.efs.us-east-1.amazonaws.com");
  assert.deepEqual(out.decl.efs.implicit, ["ec2:DescribeNetworkInterfaceAttribute"]);
  assert.deepEqual(out.activity[media.key].map((a) => [a.namespace, a.metric, a.dims, a.required]), [["AWS/EFS", "ClientConnections", { FileSystemId: "fs-0acme0media000001" }, true]]);
  assert.deepEqual(out.details[media.key], ["File system", "Mount targets", "Access points"]);

  // opensearch: a VPC domain (not public), SearchRate / IndexingRate with the account as ClientId.
  const [search] = out.us.opensearch.resources;
  assert.deepEqual([search.key, search.facts, search.endpoints], ["arn:aws:es:us-east-1:123456789012:domain/acme-search", { public: false }, ["vpc-acme-search-x1y2z3a4b5.us-east-1.es.amazonaws.com"]]);
  assert.deepEqual(out.activity[search.key].map((a) => [a.metric, a.dims]), [["SearchRate", { DomainName: "acme-search", ClientId: "123456789012" }], ["IndexingRate", { DomainName: "acme-search", ClientId: "123456789012" }]]);

  // redshift: the paused warehouse is stopped; the Serverless workgroup is ok and carries its namespace's key.
  const rs = out.us.redshift;
  const dw = rs.resources.find((r) => r.kind === "redshift-cluster")!;
  const wg = rs.resources.find((r) => r.kind === "redshift-workgroup")!;
  assert.deepEqual([dw.key, dw.health, dw.facts], ["arn:aws:redshift:us-east-1:123456789012:cluster:acme-analytics-dw", "stopped", { public: false }]);
  assert.deepEqual([wg.key, wg.health, wg.tagsUnread], ["arn:aws:redshift-serverless:us-east-1:123456789012:workgroup/0acme0b2-4444-4555-8666-000000000001", "ok", true]);
  assert.ok(rs.links.some((l) => l.to === wg.key && l.kind === "encrypts"));
  assert.deepEqual(out.activity[wg.key], []);

  // elasticache-serverless and memorydb: no activity declared.
  const [cache] = out.us["elasticache-serverless"].resources;
  assert.deepEqual([cache.key, cache.securityGroups, out.activity[cache.key]], ["arn:aws:elasticache:us-east-1:123456789012:serverlesscache:acme-sessions-cache", ["sg-prod-valkey"], []]);
  assert.deepEqual(out.decl["elasticache-serverless"].covers, []);
  const [mdb] = out.us.memorydb.resources;
  assert.deepEqual([mdb.key, mdb.health, out.activity[mdb.key]], ["arn:aws:memorydb:us-east-1:123456789012:cluster/acme-ratelimits", "ok", []]);
  for (const id of ["efs", "opensearch", "redshift", "elasticache-serverless", "memorydb"]) assert.deepEqual(out.eu[id].keys, [], `${id}: nothing in eu-west-1`);
});

// ---------- the six providers' real-account paths, with the SDK faked (server modules: child process, react-server) ----------

// Runs `body` in a child process after replacing `send` on the named SDK clients' prototypes with `fakes` (a JS object
// literal: command name → async (input, n) => output, n = the call's index for that command). `provider(file, name)`
// imports a provider; `ctx()` is a real-account ProviderContext in ap-south-1 that records notes and checkpoints;
// `denied(action)` and `offline(host)` build the errors AWS and the network raise.
interface Faked { calls: [string, Record<string, unknown>][]; notes: string[]; checkpoints: { resources: Resource[] }[] }
function withFakeAws<T>(clients: Record<string, string>, fakes: string, body: string): T & Faked {
  const base = new URL("../server/providers/", import.meta.url).href;
  const patch = Object.entries(clients).map(([pkg, cls]) => `(await import("@aws-sdk/${pkg}")).${cls}.prototype.send = send;`).join("\n");
  const code = `
    const calls = []; const counts = {};
    const denied = (action) => Object.assign(new Error("User: u is not authorized to perform: " + action + " on resource: x"), { name: "AccessDeniedException" });
    const offline = (host) => Object.assign(new Error("getaddrinfo ENOTFOUND " + host), { code: "ENOTFOUND" });
    const fakes = ${fakes};
    const send = async function (cmd) { const n = cmd.constructor.name; counts[n] = (counts[n] ?? 0) + 1; calls.push([n, cmd.input]);
      if (!Object.hasOwn(fakes, n)) throw new Error("unexpected " + n); return fakes[n](cmd.input, counts[n] - 1); };
    ${patch}
    const provider = async (f, name) => (await import(new URL(f + ".ts", ${JSON.stringify(base)}).href))[name];
    const notes = [], checkpoints = [];
    const ctx = () => ({ region: "ap-south-1", home: "ap-south-1", regions: ["ap-south-1"], accountId: "${ACCT}", mock: false, cap: 2000, signal: AbortSignal.timeout(20000), limit: (fn) => fn(), note: (m) => notes.push(m), checkpoint: (r) => checkpoints.push(r) });
    const out = await (async () => { ${body} })();
    process.stdout.write(JSON.stringify({ ...out, calls, notes, checkpoints }), () => process.exit(0));`;
  const r = spawnSync(process.execPath, ["--conditions=react-server", "--no-warnings", "--input-type=module", "-e", code], {
    cwd: root, encoding: "utf8", timeout: 90_000, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, CONSOLE_SOURCE: "mock", CONSOLE_SQLITE_PATH: ":memory:", CONSOLE_CONFIG: "" },
  });
  assert.equal(r.status, 0, `child failed:\n${r.stderr?.slice(-3000)}`);
  return JSON.parse(r.stdout) as T & Faked;
}
const AP = "ap-south-1";
const names = (o: Faked) => o.calls.map((c) => c[0].replace(/Command$/, ""));

test("rds-cluster (faked AWS): pages clusters, one subnet-group and one global read, checkpoint, then proxy targets; denied targets are soft", () => {
  const c = (id: string, extra: string) => `{ DBClusterIdentifier: "${id}", DBClusterArn: "arn:aws:rds:${AP}:${ACCT}:cluster:${id}", Status: "available", ${extra} }`;
  const out = withFakeAws<{ resources: Resource[]; links: { from: string; to: string; kind: string }[]; detail: string[][]; deniedList: string }>(
    { "client-rds": "RDSClient" },
    `{
      DescribeDBClustersCommand: async (i, n) => i.DBClusterIdentifier ? { DBClusters: [${c("a", `Engine: "aurora-postgresql", DBSubnetGroup: "g1", GlobalClusterIdentifier: "glob", DBClusterMembers: [{ DBInstanceIdentifier: "a-1", IsClusterWriter: true }]`)}] }
        : n === 0 ? { DBClusters: [${c("a", `Engine: "aurora-postgresql", DBSubnetGroup: "g1", GlobalClusterIdentifier: "glob", MasterUsername: "${SENTINEL}"`)}], Marker: "m2" }
        : { DBClusters: [${c("d", `Engine: "docdb", Status: "stopped"`)}] },
      DescribeDBProxiesCommand: async (i, n) => { if (n === 1) throw denied("rds:DescribeDBProxies");
        return { DBProxies: [{ DBProxyName: "p1", DBProxyArn: "arn:aws:rds:${AP}:${ACCT}:db-proxy:prx-1", Status: "available", EngineFamily: "POSTGRESQL" },
          { DBProxyName: "p2", DBProxyArn: "arn:aws:rds:${AP}:${ACCT}:db-proxy:prx-2", Status: "available", EngineFamily: "MYSQL" }].filter((p) => !i.DBProxyName || p.DBProxyName === i.DBProxyName) }; },
      DescribeDBSubnetGroupsCommand: async () => ({ DBSubnetGroups: [{ DBSubnetGroupName: "g1", VpcId: "vpc-1", Subnets: [{ SubnetIdentifier: "subnet-1" }] }] }),
      DescribeGlobalClustersCommand: async () => ({ GlobalClusters: [{ GlobalClusterIdentifier: "glob", GlobalClusterArn: "arn:aws:rds::${ACCT}:global-cluster:glob",
        GlobalClusterMembers: [{ DBClusterArn: "arn:aws:rds:${AP}:${ACCT}:cluster:a", IsWriter: true }, { DBClusterArn: "arn:aws:rds:eu-west-1:${ACCT}:cluster:b", IsWriter: false }] }] }),
      DescribeDBProxyTargetsCommand: async (i) => { if (i.DBProxyName === "p2") throw denied("rds:DescribeDBProxyTargets");
        return { Targets: [{ Type: "TRACKED_CLUSTER", TrackedClusterId: "a", RdsResourceId: "a" }, { Type: "RDS_INSTANCE", TrackedClusterId: "a", RdsResourceId: "a-1", Port: 5432, TargetHealth: { State: "AVAILABLE" } }] }; },
    }`,
    `const p = await provider("rds-cluster", "rdsClusterProvider");
     const r = await p.discover(ctx());
     const detail = (await p.detail(r.resources[0], ctx())).sections.map((s) => [s.title, ...(s.table?.rows ?? []).map((row) => row[0])]);
     const deniedList = await p.discover(ctx()).then(() => "listed", (e) => e.name);
     return { resources: r.resources, links: r.links, detail, deniedList };`,
  );
  assert.deepEqual(names(out).slice(0, 7), ["DescribeDBClusters", "DescribeDBProxies", "DescribeDBClusters", "DescribeDBSubnetGroups", "DescribeGlobalClusters", "DescribeDBProxyTargets", "DescribeDBProxyTargets"]);
  assert.deepEqual([out.calls[0][1].MaxRecords, out.calls[2][1].Marker, out.calls[3][1].MaxRecords], [100, "m2", 100]);
  assert.equal(out.checkpoints.length, 1, "after the lists, before the proxy targets");
  assert.deepEqual(out.checkpoints[0].resources.filter((r) => r.kind === "rds-proxy").map((r) => r.enrichment), [{ targets: "skipped" }, { targets: "skipped" }]);
  const [a, d, p1, p2] = out.resources;
  assert.deepEqual([a.vpcId, a.subnetIds, a.aliases], ["vpc-1", ["subnet-1"], ["a", `arn:aws:rds::${ACCT}:global-cluster:glob`]]);
  assert.deepEqual([d.kind, d.health], ["docdb-cluster", "stopped"]);
  assert.deepEqual([p1.enrichment, p2.enrichment, p2.health], [{ targets: "ok" }, { targets: "denied" }, "ok"]);
  assert.deepEqual(out.links.map((l) => [l.from, l.to, l.kind]), [
    [p1.key, a.key, "sql"], // the tracked cluster once, not once per member
    [a.key, `arn:aws:rds:eu-west-1:${ACCT}:cluster:b`, "route"],
  ]);
  assert.deepEqual(out.notes, ["rds proxy targets skipped: rds:DescribeDBProxyTargets denied"]);
  // detail(): one cluster re-read by its ARN, its subnet group and global database by name.
  const detailCalls = out.calls.slice(7, 10).map((c) => [c[0].replace(/Command$/, ""), c[1].DBClusterIdentifier ?? c[1].DBSubnetGroupName ?? c[1].GlobalClusterIdentifier]);
  assert.deepEqual(detailCalls, [["DescribeDBClusters", a.key], ["DescribeDBSubnetGroups", "g1"], ["DescribeGlobalClusters", "glob"]]);
  assert.deepEqual(out.detail.find((s) => s[0] === "Global database glob"), ["Global database glob", "a", "b"]);
  // A denied list call is the provider's denial (its status names the action).
  assert.equal(out.deniedList, "AccessDeniedException");
  assert.ok(!JSON.stringify(out.resources).includes(SENTINEL));
});

test("efs (faked AWS): pages file systems, checkpoint, mount targets per file system and their groups per mount target; partial denials are soft", () => {
  const fs = (id: string, n: number) => `{ FileSystemId: "${id}", FileSystemArn: "arn:aws:elasticfilesystem:${AP}:${ACCT}:file-system/${id}", LifeCycleState: "available", NumberOfMountTargets: ${n}, Tags: [{ Key: "Name", Value: "${id}-name" }] }`;
  const mt = (id: string, fsId: string, az: string) => `{ MountTargetId: "${id}", FileSystemId: "${fsId}", SubnetId: "subnet-${az}", VpcId: "vpc-1", LifeCycleState: "available", IpAddress: "10.0.0.${az === "a" ? 1 : 2}", AvailabilityZoneName: "${AP}${az}" }`;
  const out = withFakeAws<{ resources: Resource[] }>(
    { "client-efs": "EFSClient" },
    `{
      DescribeFileSystemsCommand: async (i, n) => n === 0 ? { FileSystems: [${fs("fs-1", 2)}], NextMarker: "x" } : { FileSystems: [${fs("fs-2", 0)}] },
      DescribeAccessPointsCommand: async () => { throw denied("elasticfilesystem:DescribeAccessPoints"); },
      DescribeMountTargetsCommand: async (i) => ({ MountTargets: i.FileSystemId === "fs-1" ? [${mt("fsmt-1", "fs-1", "a")}, ${mt("fsmt-2", "fs-1", "b")}] : [] }),
      DescribeMountTargetSecurityGroupsCommand: async (i) => { if (i.MountTargetId === "fsmt-2") throw denied("ec2:DescribeNetworkInterfaceAttribute"); return { SecurityGroups: ["sg-nfs"] }; },
    }`,
    `return { resources: (await (await provider("efs", "efsProvider")).discover(ctx())).resources };`,
  );
  assert.deepEqual(names(out), ["DescribeFileSystems", "DescribeAccessPoints", "DescribeFileSystems", "DescribeMountTargets", "DescribeMountTargets", "DescribeMountTargetSecurityGroups", "DescribeMountTargetSecurityGroups"]);
  assert.deepEqual([out.calls[0][1].MaxItems, out.calls[1][1].MaxResults, out.calls[2][1].Marker], [100, 100, "x"]);
  assert.equal(out.checkpoints.length, 1);
  assert.deepEqual(out.checkpoints[0].resources.map((r) => r.enrichment), [{ "mount targets": "skipped", "access points": "denied" }, { "mount targets": "skipped", "access points": "denied" }]);
  const [one, two] = out.resources;
  assert.deepEqual([one.name, one.health, one.vpcId, one.subnetIds, one.securityGroups], ["fs-1-name", "ok", "vpc-1", ["subnet-a", "subnet-b"], ["sg-nfs"]]);
  assert.deepEqual(one.endpoints, [`fs-1.efs.${AP}.amazonaws.com`, `${AP}a.fs-1.efs.${AP}.amazonaws.com`, "10.0.0.1", `${AP}b.fs-1.efs.${AP}.amazonaws.com`, "10.0.0.2"]);
  assert.deepEqual(one.enrichment, { "mount targets": "ok", "access points": "denied", "mount target security groups": "denied" });
  assert.deepEqual([two.health, two.healthReason], ["warning", "no mount targets — nothing can mount it"]);
  assert.deepEqual(out.notes, ["efs access points skipped: elasticfilesystem:DescribeAccessPoints denied", "efs mount target security groups skipped: ec2:DescribeNetworkInterfaceAttribute denied"]);
});

test("opensearch (faked AWS): DescribeDomains in batches of at most 5 names, checkpoint, then tags per domain", () => {
  const out = withFakeAws<{ resources: Resource[] }>(
    { "client-opensearch": "OpenSearchClient" },
    `{
      ListDomainNamesCommand: async () => ({ DomainNames: Array.from({ length: 7 }, (_, k) => ({ DomainName: "d" + k, EngineType: "OpenSearch" })) }),
      DescribeDomainsCommand: async (i) => ({ DomainStatusList: i.DomainNames.map((d) => ({ DomainName: d, ARN: "arn:aws:es:${AP}:${ACCT}:domain/" + d, DomainProcessingStatus: "Active", Endpoint: "search-" + d + ".${AP}.es.amazonaws.com", AccessPolicies: "${SENTINEL}" })) }),
      ListTagsCommand: async (i) => { if (i.ARN.endsWith("/d6")) throw denied("es:ListTags"); return { TagList: [{ Key: "Environment", Value: "production" }] }; },
    }`,
    `return { resources: (await (await provider("opensearch", "opensearchProvider")).discover(ctx())).resources };`,
  );
  assert.deepEqual(out.calls.filter((c) => c[0] === "DescribeDomainsCommand").map((c) => (c[1].DomainNames as string[]).length), [5, 2]);
  assert.equal(out.checkpoints.length, 1);
  assert.ok(out.checkpoints[0].resources.every((r) => r.tagsUnread));
  assert.deepEqual(out.resources.map((r) => [r.name, r.tags.Environment ?? null, !!r.tagsUnread, r.facts?.public]).slice(5), [["d5", "production", false, true], ["d6", null, true, true]]);
  assert.deepEqual(out.notes, ["opensearch domain tags skipped: es:ListTags denied"]);
  assert.ok(!JSON.stringify(out.resources).includes(SENTINEL));
});

test("redshift (faked AWS): Serverless denied or not offered keeps the clusters with a note; any other Serverless failure fails the run", () => {
  const out = withFakeAws<{ offline: Resource[]; denied: Resource[]; throttled: string; withServerless: Resource[] }>(
    { "client-redshift": "RedshiftClient", "client-redshift-serverless": "RedshiftServerlessClient" },
    `{
      DescribeClustersCommand: async () => ({ Clusters: [{ ClusterIdentifier: "dw", ClusterStatus: "paused", PubliclyAccessible: true, MasterUsername: "${SENTINEL}", Tags: [] }] }),
      ListWorkgroupsCommand: async (i, n) => {
        if (n === 0) throw offline("redshift-serverless.${AP}.amazonaws.com");
        if (n === 1) throw denied("redshift-serverless:ListWorkgroups");
        if (n === 2) throw Object.assign(new Error("Rate exceeded"), { name: "ThrottlingException" });
        return { workgroups: [{ workgroupName: "adhoc", workgroupId: "wg-1", workgroupArn: "arn:aws:redshift-serverless:${AP}:${ACCT}:workgroup/wg-1", namespaceName: "adhoc", status: "AVAILABLE" }] };
      },
      ListNamespacesCommand: async () => ({ namespaces: [{ namespaceName: "adhoc", kmsKeyId: "AWS_OWNED_KMS_KEY", adminUsername: "${SENTINEL}" }] }),
    }`,
    `const p = await provider("redshift", "redshiftProvider");
     const offline = (await p.discover(ctx())).resources;
     const denied = (await p.discover(ctx())).resources;
     const throttled = await p.discover(ctx()).then(() => "listed", (e) => e.name);
     const withServerless = (await p.discover(ctx())).resources;
     return { offline, denied, throttled, withServerless };`,
  );
  assert.deepEqual(out.offline.map((r) => [r.name, r.health, r.facts?.public]), [["dw", "stopped", true]]);
  assert.deepEqual(out.denied.map((r) => r.name), ["dw"]);
  assert.equal(out.throttled, "ThrottlingException", "a failed run keeps the last good list instead of dropping the workgroups");
  assert.deepEqual(out.withServerless.map((r) => [r.kind, r.name]), [["redshift-cluster", "dw"], ["redshift-workgroup", "adhoc"]]);
  assert.deepEqual(out.notes, ["redshift serverless: not offered in this region", "redshift serverless workgroups skipped: redshift-serverless:ListWorkgroups denied"]);
  assert.equal(names(out).filter((n) => n === "ListNamespaces").length, 1, "namespaces only when there are workgroups");
  assert.ok(!JSON.stringify(out.withServerless).includes(SENTINEL));
});

test("elasticache-serverless and memorydb (faked AWS): list, checkpoint, tags per item; denied tags fail closed; a denied list denies the provider", () => {
  const out = withFakeAws<{ caches: Resource[]; mdb: Resource[]; mdbDenied: string }>(
    { "client-elasticache": "ElastiCacheClient", "client-memorydb": "MemoryDBClient" },
    `{
      DescribeServerlessCachesCommand: async () => ({ ServerlessCaches: [{ ServerlessCacheName: "s", ARN: "arn:aws:elasticache:${AP}:${ACCT}:serverlesscache:s", Status: "available", Endpoint: { Address: "s-x.serverless.aps1.cache.amazonaws.com", Port: 6379 } }] }),
      ListTagsForResourceCommand: async () => { throw denied("elasticache:ListTagsForResource"); },
      DescribeClustersCommand: async (i, n) => { if (n === 1) throw denied("memorydb:DescribeClusters");
        return { Clusters: [{ Name: "m", ARN: "arn:aws:memorydb:${AP}:${ACCT}:cluster/m", Status: "available", ClusterEndpoint: { Address: "clustercfg.m.x.memorydb.${AP}.amazonaws.com", Port: 6379 } }] }; },
      ListTagsCommand: async () => ({ TagList: [{ Key: "Environment", Value: "production" }] }),
    }`,
    `const caches = (await (await provider("elasticache-serverless", "elasticacheServerlessProvider")).discover(ctx())).resources;
     const m = await provider("memorydb", "memorydbProvider");
     const mdb = (await m.discover(ctx())).resources;
     const mdbDenied = await m.discover(ctx()).then(() => "listed", (e) => e.name);
     return { caches, mdb, mdbDenied };`,
  );
  assert.deepEqual([out.calls[0][1].MaxResults, out.calls.find((c) => c[0] === "DescribeClustersCommand")?.[1].MaxResults], [100, 100]);
  assert.equal(out.checkpoints.length, 2);
  assert.deepEqual(out.caches.map((r) => [r.tagsUnread, r.enrichment]), [[true, { tags: "denied" }]]);
  assert.deepEqual(out.mdb.map((r) => [r.tags, r.tagsUnread ?? false, r.enrichment]), [[{ Environment: "production" }, false, { tags: "ok" }]]);
  assert.equal(out.mdbDenied, "AccessDeniedException");
  assert.deepEqual(out.notes, ["elasticache serverless tags skipped: elasticache:ListTagsForResource denied"]);
});
