// RDS clusters and proxies as the cloud map sees them, pure: SDK-shaped DescribeDBClusters, DescribeDBSubnetGroups,
// DescribeDBProxies (+ DescribeDBProxyTargets per proxy) and DescribeGlobalClusters answers in, resources and links out
// (audit §6 A.2 #12, CC-14). The provider (../server/providers/rds-cluster.ts) and its simulation feed the same
// functions. No AWS calls and no `server-only`, so node:test runs it (rds-cluster.test.ts).
// - Kinds by engine: docdb → docdb-cluster, neptune → neptune-cluster, anything else (Aurora, Multi-AZ DB clusters) →
//   rds-cluster. Proxies are rds-proxy. Keys are the ARNs AWS returns (= arnOf.rdsCluster / arnOf.rdsProxy).
// - Network: DBCluster.DBSubnetGroup is only a NAME, so the subnet group listing gives vpcId and subnets (CC-14).
// - Endpoints: writer, reader and custom endpoints; the proxy's endpoint. Custom endpoint ARNs (built from the host's
//   first label) and, on the writer, the global database's ARN are aliases, so Resource Explorer's rds:cluster-endpoint
//   and rds:global-cluster rows fold into the cluster instead of being flagged as unmatched.
// - Links: KMS → cluster (encrypts); cluster / proxy → IAM roles (assumes); cluster / proxy → the Secrets Manager secret
//   holding credentials (reads); proxy → its targets (sql: a tracked cluster, or a DB instance's console key); global
//   database: primary cluster → each secondary (route) — there is no global-cluster node. Clusters are never linked to
//   their instances: the rds provider sets the instances' parent (RawDb.aurora).
// - Health from what RDS reports (A.2 #12); facts.public only where AWS reports PubliclyAccessible (Multi-AZ DB clusters).
// Usernames, secret values and connection credentials are never copied (rds-cluster.test.ts sentinel).
import { arnOf, parseArn, partitionOf } from "./arn.ts";
import { kmsRef, prop, props } from "./compute-common.ts";
import { assumesLink, awsTime, encryptsLink, enrichmentOf, fmtTime, plural, tagMap, unread } from "./serverless-common.ts";
import { keys, type EnrichState, type Health, type Link, type ProviderResult, type Resource, type ResourceDetail, type ResourceKind } from "./types.ts";

type When = Date | string | number;
type Tag = { Key?: string; Value?: string };

// DescribeDBClusters' DBCluster, the parts the map uses (DocumentDB and Neptune clusters come from the same API).
export interface RawDbCluster {
  DBClusterIdentifier?: string;
  DBClusterArn?: string;
  DbClusterResourceId?: string; // "cluster-ABCDEF…" (CloudWatch / Performance Insights name it so)
  Engine?: string; // aurora-postgresql | aurora-mysql | postgres | mysql (Multi-AZ DB cluster) | docdb | neptune
  EngineVersion?: string;
  EngineMode?: string; // provisioned | serverless | parallelquery | global | multimaster
  Status?: string;
  PercentProgress?: string;
  Endpoint?: string;
  ReaderEndpoint?: string;
  CustomEndpoints?: string[];
  Port?: number;
  MultiAZ?: boolean;
  DatabaseName?: string;
  DBSubnetGroup?: string; // a name
  DBClusterParameterGroup?: string;
  VpcSecurityGroups?: { VpcSecurityGroupId?: string; Status?: string }[];
  DBClusterMembers?: { DBInstanceIdentifier?: string; IsClusterWriter?: boolean; PromotionTier?: number }[];
  StorageEncrypted?: boolean;
  KmsKeyId?: string;
  PubliclyAccessible?: boolean; // Multi-AZ DB clusters only (Aurora reports it per instance)
  DeletionProtection?: boolean;
  BackupRetentionPeriod?: number;
  PreferredBackupWindow?: string;
  PreferredMaintenanceWindow?: string;
  ClusterCreateTime?: When;
  TagList?: Tag[];
  GlobalClusterIdentifier?: string;
  ReplicationSourceIdentifier?: string; // a cross-region read replica's source cluster ARN
  AssociatedRoles?: { RoleArn?: string; Status?: string; FeatureName?: string }[];
  MonitoringRoleArn?: string;
  IAMDatabaseAuthenticationEnabled?: boolean;
  HttpEndpointEnabled?: boolean; // the Data API
  EnabledCloudwatchLogsExports?: string[];
  DBClusterInstanceClass?: string; // Multi-AZ DB clusters
  StorageType?: string;
  AllocatedStorage?: number;
  ServerlessV2ScalingConfiguration?: { MinCapacity?: number; MaxCapacity?: number };
  MasterUserSecret?: { SecretArn?: string; SecretStatus?: string };
  CertificateDetails?: { CAIdentifier?: string; ValidTill?: When };
}

export interface RawSubnetGroup {
  DBSubnetGroupName?: string;
  VpcId?: string;
  Subnets?: { SubnetIdentifier?: string; SubnetStatus?: string }[];
}

// DescribeDBProxyTargets' DBProxyTarget.
export interface RawProxyTarget {
  TargetArn?: string;
  Endpoint?: string;
  TrackedClusterId?: string;
  RdsResourceId?: string; // the DB instance or cluster identifier
  Port?: number;
  Type?: string; // RDS_INSTANCE | RDS_SERVERLESS_ENDPOINT | TRACKED_CLUSTER
  Role?: string; // READ_WRITE | READ_ONLY | UNKNOWN
  TargetHealth?: { State?: string; Reason?: string; Description?: string }; // AVAILABLE | REGISTERING | UNAVAILABLE | UNUSED
}

// DescribeDBProxies' DBProxy, plus its targets (undefined = not read; see enrichment.targets).
export interface RawProxy {
  DBProxyName?: string;
  DBProxyArn?: string;
  Status?: string;
  EngineFamily?: string; // MYSQL | POSTGRESQL | SQLSERVER
  VpcId?: string;
  VpcSecurityGroupIds?: string[];
  VpcSubnetIds?: string[];
  DefaultAuthScheme?: string; // NONE (credentials from Auth's secrets) | IAM_AUTH (end-to-end IAM, no secret)
  Auth?: { AuthScheme?: string; SecretArn?: string; IAMAuth?: string; ClientPasswordAuthType?: string; UserName?: string; Description?: string }[];
  RoleArn?: string;
  Endpoint?: string;
  RequireTLS?: boolean;
  IdleClientTimeout?: number;
  DebugLogging?: boolean;
  CreatedDate?: When;
  targets?: RawProxyTarget[];
  enrichment?: Record<string, EnrichState>;
}

export interface RawGlobalCluster {
  GlobalClusterIdentifier?: string;
  GlobalClusterArn?: string;
  Status?: string;
  Engine?: string;
  GlobalClusterMembers?: { DBClusterArn?: string; IsWriter?: boolean; SynchronizationStatus?: string; Readers?: string[] }[];
}

export interface RdsClusterInput {
  clusters: RawDbCluster[];
  subnetGroups?: RawSubnetGroup[]; // undefined = not read (see subnetGroupsState)
  subnetGroupsState?: EnrichState;
  proxies: RawProxy[];
  globals?: RawGlobalCluster[]; // undefined = not read
}

export interface RdsClusterOptions {
  region: string;
  account?: string;
  home?: string;
  regions?: string[]; // the console's regions: decides which run draws a global database's links
  now?: number;
}

const ms = (t: When | undefined) => awsTime(t instanceof Date || typeof t === "number" || typeof t === "string" ? t : undefined);
const lower = (s: string | undefined) => String(s ?? "").toLowerCase();

export function clusterKind(engine: string | undefined): ResourceKind {
  const e = lower(engine);
  if (e === "docdb" || e.startsWith("docdb")) return "docdb-cluster";
  if (e === "neptune" || e.startsWith("neptune")) return "neptune-cluster";
  return "rds-cluster";
}

// A.2 #12: available ok; stopped stopped; backing-up / maintenance ok with a reason; failing-over, upgrading, modifying,
// migrating warning (and the other transitions); KMS key unusable, failed or incompatible-* error.
const CLUSTER_BUSY = new Set([
  "failing-over", "upgrading", "modifying", "migrating", "creating", "starting", "stopping", "rebooting", "renaming", "promoting", "backtracking",
  "resetting-master-credentials", "preparing-data-migration", "storage-optimization", "update-iam-db-auth", "scaling-compute", "scaling-storage",
  "configuring-activity-stream", "configuring-iam-database-auth", "cloning",
]);
export function clusterHealth(c: Pick<RawDbCluster, "Status" | "PercentProgress">): { health: Health; healthReason?: string } {
  const s = lower(c.Status);
  if (s === "available") return { health: "ok" };
  if (s === "stopped") return { health: "stopped", healthReason: "stopped (AWS starts a stopped cluster again after 7 days)" };
  if (s === "backing-up") return { health: "ok", healthReason: "backing up" };
  if (s === "maintenance") return { health: "ok", healthReason: "maintenance in progress" };
  if (s.startsWith("inaccessible-encryption-credentials")) return { health: "error", healthReason: "its KMS key can't be used — the cluster can't read its data" };
  if (s === "failed" || s.endsWith("-failed") || s.startsWith("incompatible-")) return { health: "error", healthReason: s };
  if (s === "deleting") return { health: "stopped", healthReason: "deleting" };
  if (CLUSTER_BUSY.has(s)) return { health: "warning", healthReason: c.PercentProgress ? `${s} (${c.PercentProgress} %)` : s };
  return { health: "unknown", healthReason: s ? `status ${s}` : "status not reported" };
}

// Proxy: available ok; creating, modifying (and suspending, reactivating) warning; incompatible-network,
// insufficient-resource-limits or suspended error; deleting stopped. Then its targets: one UNAVAILABLE is a warning;
// none registered is a warning; UNUSED says nothing (the proxy simply doesn't route to that reader now).
export function proxyHealth(p: Pick<RawProxy, "Status" | "targets">): { health: Health; healthReason?: string } {
  const s = lower(p.Status);
  if (s === "deleting") return { health: "stopped", healthReason: "deleting" };
  if (s === "incompatible-network" || s === "insufficient-resource-limits" || s === "suspended") return { health: "error", healthReason: s };
  if (s === "creating" || s === "modifying" || s === "suspending" || s === "reactivating") return { health: "warning", healthReason: s };
  if (s !== "available") return { health: "unknown", healthReason: s ? `status ${s}` : "status not reported" };
  const targets = p.targets;
  if (!targets) return { health: "ok" };
  if (!targets.length) return { health: "warning", healthReason: "no target registered — the proxy has nothing to connect to" };
  const down = targets.filter((t) => t.TargetHealth?.State === "UNAVAILABLE");
  if (down.length) {
    const t = down[0];
    const why = t.TargetHealth?.Description || t.TargetHealth?.Reason;
    return { health: "warning", healthReason: `${plural(down.length, "target")} unavailable: ${targetName(t)}${why ? ` (${why})` : ""}` };
  }
  return { health: "ok" };
}

const targetName = (t: RawProxyTarget) => t.RdsResourceId ?? t.TrackedClusterId ?? t.Endpoint ?? "target";
const FAMILY: Record<string, string> = { POSTGRESQL: "postgres", MYSQL: "mysql", SQLSERVER: "sqlserver" };
const family = (f: string | undefined) => (f && Object.hasOwn(FAMILY, f.toUpperCase()) ? FAMILY[f.toUpperCase()] : lower(f) || "sql");

// A custom endpoint host ("<name>.cluster-custom-<id>.<region>.rds.amazonaws.com") → its rds:cluster-endpoint ARN.
export function customEndpointArn(host: string, region: string, account: string | undefined): string | undefined {
  const m = /^([a-z][a-z0-9-]*)\.cluster-custom-[a-z0-9]+\./i.exec(host.trim());
  return m && account ? `arn:${partitionOf(region)}:rds:${region}:${account}:cluster-endpoint:${m[1].toLowerCase()}` : undefined;
}

// The global database a cluster belongs to, and which run draws its links: the writer's region, or — when the console
// doesn't cover the writer's region — the first covered member region (so exactly one run draws them).
function writerOf(g: RawGlobalCluster) {
  return g.GlobalClusterMembers?.find((m) => m.IsWriter && m.DBClusterArn);
}
function drawsGlobal(g: RawGlobalCluster, o: RdsClusterOptions): boolean {
  const regionOf = (arn: string | undefined) => parseArn(arn ?? "")?.region;
  const writer = regionOf(writerOf(g)?.DBClusterArn);
  if (writer === o.region) return true;
  if (!o.regions?.length || (writer && o.regions.includes(writer))) return false;
  const first = (g.GlobalClusterMembers ?? []).map((m) => regionOf(m.DBClusterArn)).find((r) => r && o.regions!.includes(r));
  return first === o.region;
}

const clusterConsole = (kind: ResourceKind, region: string, id: string) => {
  const q = `region=${region}`;
  if (kind === "docdb-cluster") return `https://${region}.console.aws.amazon.com/docdb/home?${q}#cluster-details/${encodeURIComponent(id)}`;
  if (kind === "neptune-cluster") return `https://${region}.console.aws.amazon.com/neptune/home?${q}#database:id=${encodeURIComponent(id)};is-cluster=true`;
  return `https://${region}.console.aws.amazon.com/rds/home?${q}#database:id=${encodeURIComponent(id)};is-cluster=true`;
};

function engineText(c: RawDbCluster): string | undefined {
  if (!c.Engine) return undefined;
  return `${c.Engine}${c.EngineVersion ? ` ${c.EngineVersion}` : ""}`;
}
function capacityText(c: RawDbCluster): string | undefined {
  const v2 = c.ServerlessV2ScalingConfiguration;
  if (v2 && (v2.MinCapacity !== undefined || v2.MaxCapacity !== undefined)) return `Serverless v2 · ${v2.MinCapacity ?? "?"}–${v2.MaxCapacity ?? "?"} ACU`;
  if (c.EngineMode === "serverless") return "Serverless v1";
  return c.DBClusterInstanceClass;
}
function membersText(c: RawDbCluster): string | undefined {
  const m = c.DBClusterMembers;
  if (!m) return undefined;
  if (!m.length) return "no instances";
  const writer = m.find((x) => x.IsClusterWriter)?.DBInstanceIdentifier;
  const readers = m.filter((x) => !x.IsClusterWriter).length;
  return `${writer ? `writer ${writer}` : "no writer"}${readers ? ` · ${plural(readers, "reader")}` : ""}`;
}
const encryptionText = (encrypted: boolean | undefined, kms: string | undefined) =>
  encrypted === undefined ? undefined : encrypted ? `KMS ${kms ? kms.replace(/^arn:aws[\w-]*:kms:[^:]+:\d+:/, "") : "(default key)"}` : "not encrypted";

function globalRole(c: RawDbCluster, key: string, globals: RawGlobalCluster[] | undefined): string | undefined {
  if (!c.GlobalClusterIdentifier) return undefined;
  const g = globals?.find((x) => x.GlobalClusterIdentifier === c.GlobalClusterIdentifier);
  const me = g?.GlobalClusterMembers?.find((m) => m.DBClusterArn === key);
  if (!me) return c.GlobalClusterIdentifier;
  const others = (g?.GlobalClusterMembers ?? []).filter((m) => m !== me).length;
  return `${c.GlobalClusterIdentifier} · ${me.IsWriter ? `primary (${plural(others, "secondary", "secondaries")})` : "secondary"}`;
}

export function clusterResource(c: RawDbCluster, input: Pick<RdsClusterInput, "subnetGroups" | "subnetGroupsState" | "globals">, o: RdsClusterOptions): { resource: Resource; links: Link[] } {
  const { region } = o;
  const id = c.DBClusterIdentifier!;
  const key = c.DBClusterArn || arnOf.rdsCluster(region, o.account ?? "", id);
  const kind = clusterKind(c.Engine);
  const sg = c.DBSubnetGroup ? input.subnetGroups?.find((g) => g.DBSubnetGroupName === c.DBSubnetGroup) : undefined;
  const subnetIds = (sg?.Subnets ?? []).map((s) => s.SubnetIdentifier).filter((s): s is string => !!s);
  const groups = (c.VpcSecurityGroups ?? []).map((g) => g.VpcSecurityGroupId).filter((g): g is string => !!g);
  const global = c.GlobalClusterIdentifier ? input.globals?.find((g) => g.GlobalClusterIdentifier === c.GlobalClusterIdentifier) : undefined;
  const isWriter = !!global && writerOf(global)?.DBClusterArn === key;
  const custom = (c.CustomEndpoints ?? []).map((h) => customEndpointArn(h, region, o.account)).filter((a): a is string => !!a);
  const kms = c.StorageEncrypted ? kmsRef(c.KmsKeyId, region, o.account) : undefined;
  const enrichment = enrichmentOf({ "subnet group": c.DBSubnetGroup && !sg ? (input.subnetGroupsState ?? "error") : undefined });
  const resource: Resource = {
    key, kind, provider: "rds-cluster", name: id, region, tags: tagMap(c.TagList ?? []), ...clusterHealth(c),
    props: props(
      prop("Engine", engineText(c)), prop("Capacity", capacityText(c)), prop("Members", membersText(c)),
      prop("Endpoint", c.Endpoint, true), prop("Reader endpoint", c.ReaderEndpoint, true), prop("Port", c.Port),
      prop("Global database", globalRole(c, key, input.globals)), prop("Replicates from", c.ReplicationSourceIdentifier, true),
      prop("Multi-AZ", c.MultiAZ === undefined ? undefined : c.MultiAZ ? "yes" : "no"),
      prop("Publicly accessible", c.PubliclyAccessible === undefined ? undefined : c.PubliclyAccessible ? "yes" : "no"),
      prop("Encryption", encryptionText(c.StorageEncrypted, c.KmsKeyId)),
      prop("Backups", c.BackupRetentionPeriod === undefined ? undefined : c.BackupRetentionPeriod ? `${plural(c.BackupRetentionPeriod, "day")}${c.PreferredBackupWindow ? ` · window ${c.PreferredBackupWindow}` : ""}` : "off"),
      prop("Deletion protection", c.DeletionProtection === undefined ? undefined : c.DeletionProtection ? "on" : "off"),
      prop("Subnet group", c.DBSubnetGroup ? (sg || !input.subnetGroupsState || input.subnetGroupsState === "ok" ? c.DBSubnetGroup : `${c.DBSubnetGroup} (${unread("subnets", input.subnetGroupsState)})`) : undefined),
      prop("Log exports", c.EnabledCloudwatchLogsExports?.length ? c.EnabledCloudwatchLogsExports.join(", ") : undefined),
      prop("Created", ms(c.ClusterCreateTime) ? fmtTime(ms(c.ClusterCreateTime)) : undefined),
    ),
    endpoints: [c.Endpoint, c.ReaderEndpoint, ...(c.CustomEndpoints ?? [])].filter((e): e is string => !!e),
    aliases: [...new Set([id, ...(c.DbClusterResourceId ? [c.DbClusterResourceId] : []), ...custom, ...(isWriter && global?.GlobalClusterArn ? [global.GlobalClusterArn] : [])])],
    ...(sg?.VpcId ? { vpcId: sg.VpcId } : {}), ...(subnetIds.length ? { subnetIds } : {}), ...(groups.length ? { securityGroups: groups } : {}),
    ...(c.PubliclyAccessible !== undefined ? { facts: { public: c.PubliclyAccessible } } : {}),
    ...(enrichment ? { enrichment } : {}),
    consoleUrl: clusterConsole(kind, region, id),
    ...(ms(c.ClusterCreateTime) ? { createdAt: ms(c.ClusterCreateTime) } : {}), ...(o.now ? { observedAt: o.now } : {}),
  };
  const links: Link[] = [
    ...encryptsLink(kms, key, "at rest", "cluster storage encryption key (KmsKeyId)"),
    ...(c.AssociatedRoles ?? []).flatMap((r) => assumesLink(key, r.RoleArn, r.FeatureName ? `associated role (${r.FeatureName})` : "associated role", "DBCluster.AssociatedRoles")),
    ...assumesLink(key, c.MonitoringRoleArn, "enhanced monitoring", "DBCluster.MonitoringRoleArn"),
    ...(c.MasterUserSecret?.SecretArn ? [{ from: key, to: c.MasterUserSecret.SecretArn, kind: "reads" as const, label: "master user password (managed by RDS)", evidence: "DBCluster.MasterUserSecret" }] : []),
  ];
  return { resource, links };
}

export function proxyResource(p: RawProxy, o: RdsClusterOptions): { resource: Resource; links: Link[] } {
  const { region } = o;
  const name = p.DBProxyName!;
  const key = p.DBProxyArn!;
  const targets = p.targets;
  const enrichment = enrichmentOf(p.enrichment);
  const auth = [
    ...(p.DefaultAuthScheme === "IAM_AUTH" ? ["end-to-end IAM"] : []),
    ...(p.Auth ?? []).map((a) => [a.AuthScheme === "SECRETS" ? "secret" : lower(a.AuthScheme), a.IAMAuth === "REQUIRED" ? "IAM required" : a.IAMAuth === "ENABLED" ? "IAM enabled" : ""].filter(Boolean).join(" + ")),
  ];
  const resource: Resource = {
    key, kind: "rds-proxy", provider: "rds-cluster", name, region, tags: {}, tagsUnread: true, ...proxyHealth(p),
    props: props(
      prop("Engine", p.EngineFamily ? `${family(p.EngineFamily)} (proxy)` : undefined), prop("Endpoint", p.Endpoint, true),
      prop("Targets", targets ? (targets.length ? [...new Set(targets.map(targetName))].join(", ") : "none") : unread("targets", p.enrichment?.targets)),
      prop("TLS required", p.RequireTLS === undefined ? undefined : p.RequireTLS ? "yes" : "no"),
      prop("Authentication", auth.length ? [...new Set(auth)].join(", ") : undefined),
      prop("Idle client timeout", p.IdleClientTimeout === undefined ? undefined : `${p.IdleClientTimeout} s`),
      prop("Debug logging", p.DebugLogging ? "on" : undefined),
      prop("Created", ms(p.CreatedDate) ? fmtTime(ms(p.CreatedDate)) : undefined),
    ),
    endpoints: p.Endpoint ? [p.Endpoint] : [], aliases: [name],
    ...(p.VpcId ? { vpcId: p.VpcId } : {}), ...(p.VpcSubnetIds?.length ? { subnetIds: [...p.VpcSubnetIds] } : {}),
    ...(p.VpcSecurityGroupIds?.length ? { securityGroups: [...p.VpcSecurityGroupIds] } : {}),
    ...(enrichment ? { enrichment } : {}),
    consoleUrl: `https://${region}.console.aws.amazon.com/rds/home?region=${region}#proxy:id=${encodeURIComponent(name)}`,
    ...(ms(p.CreatedDate) ? { createdAt: ms(p.CreatedDate) } : {}), ...(o.now ? { observedAt: o.now } : {}),
  };
  // Targets: a tracked cluster stands for its members; an instance outside a cluster is the rds provider's console key.
  const seen = new Set<string>();
  const links: Link[] = [];
  for (const t of targets ?? []) {
    const cluster = t.Type === "TRACKED_CLUSTER" ? t.TrackedClusterId ?? t.RdsResourceId : t.TrackedClusterId;
    const to = cluster ? arnOf.rdsCluster(region, o.account ?? parseArn(key)?.account ?? "", cluster) : t.RdsResourceId ? keys.rds(t.RdsResourceId, region, o.home ?? region) : undefined;
    if (!to || seen.has(to)) continue;
    seen.add(to);
    const port = t.Port ?? targets?.find((x) => x.Port)?.Port;
    links.push({ from: key, to, kind: "sql", label: `${family(p.EngineFamily)}${port ? `:${port}` : ""}`, evidence: `RDS proxy target (${cluster ? "tracked cluster" : "DB instance"})` });
  }
  links.push(...assumesLink(key, p.RoleArn, "proxy role", "DBProxy.RoleArn"));
  for (const s of new Set((p.Auth ?? []).map((a) => a.SecretArn).filter((a): a is string => !!a)))
    links.push({ from: key, to: s, kind: "reads", label: "database credentials", evidence: "DBProxy.Auth SecretArn" });
  return { resource, links };
}

// Global databases: the primary routes to each secondary, drawn by exactly one run (see drawsGlobal).
export function globalLinks(globals: RawGlobalCluster[], o: RdsClusterOptions): Link[] {
  const links: Link[] = [];
  for (const g of globals) {
    const writer = writerOf(g);
    if (!writer?.DBClusterArn || !drawsGlobal(g, o)) continue;
    for (const m of g.GlobalClusterMembers ?? []) {
      if (m === writer || !m.DBClusterArn) continue;
      links.push({
        from: writer.DBClusterArn, to: m.DBClusterArn, kind: "route", label: "global database",
        evidence: `Aurora global database${g.GlobalClusterIdentifier ? ` ${g.GlobalClusterIdentifier}` : ""} (storage-level replication${m.SynchronizationStatus ? `, ${lower(m.SynchronizationStatus)}` : ""})`,
      });
    }
  }
  return links;
}

export function rdsClusterResult(input: RdsClusterInput, o: RdsClusterOptions): ProviderResult {
  const clusters = input.clusters.filter((c) => c.DBClusterIdentifier).map((c) => clusterResource(c, input, o));
  const proxies = input.proxies.filter((p) => p.DBProxyName && p.DBProxyArn).map((p) => proxyResource(p, o));
  return {
    resources: [...clusters, ...proxies].map((x) => x.resource),
    links: [...clusters, ...proxies].flatMap((x) => x.links).concat(globalLinks(input.globals ?? [], o)),
    mentions: [],
  };
}

// ---------- the panel ----------

export function clusterDetail(key: string, c: RawDbCluster | undefined, extra: { subnetGroup?: RawSubnetGroup; global?: RawGlobalCluster } = {}): ResourceDetail {
  if (!c) return { key, sections: [{ title: "Cluster", note: "This cluster no longer exists." }] };
  const members = c.DBClusterMembers ?? [];
  // A global database's secondary (or a cluster whose writer is gone) keeps its cluster endpoint, but nothing behind it
  // accepts writes until a writer instance exists again.
  const writer = !members.length || members.some((m) => m.IsClusterWriter) ? "writer" : "writer (inactive: no writer instance)";
  const sections: ResourceDetail["sections"] = [
    {
      title: "Cluster",
      rows: props(
        prop("Status", c.Status), prop("Engine", engineText(c)), prop("Engine mode", c.EngineMode), prop("Capacity", capacityText(c)), prop("Database", c.DatabaseName),
        prop("Port", c.Port), prop("Storage", c.StorageType ? `${c.StorageType}${c.AllocatedStorage ? ` · ${c.AllocatedStorage} GiB` : ""}` : undefined),
        prop("Parameter group", c.DBClusterParameterGroup), prop("IAM database auth", c.IAMDatabaseAuthenticationEnabled === undefined ? undefined : c.IAMDatabaseAuthenticationEnabled ? "on" : "off"),
        prop("Data API", c.HttpEndpointEnabled ? "on" : undefined),
        prop("CA certificate", c.CertificateDetails?.CAIdentifier ? `${c.CertificateDetails.CAIdentifier}${ms(c.CertificateDetails.ValidTill) ? ` · valid till ${fmtTime(ms(c.CertificateDetails.ValidTill))}` : ""}` : undefined),
        prop("Resource id", c.DbClusterResourceId, true), prop("Created", ms(c.ClusterCreateTime) ? fmtTime(ms(c.ClusterCreateTime)) : undefined),
      ),
    },
    members.length
      ? { title: "Members", table: { columns: ["Instance", "Role", "Failover priority"], rows: members.map((m) => [m.DBInstanceIdentifier ?? "—", m.IsClusterWriter ? "writer" : "reader", m.PromotionTier === undefined ? "—" : String(m.PromotionTier)]) } }
      : { title: "Members", note: "No DB instances: nothing serves this cluster's endpoints." },
    {
      title: "Endpoints",
      table: {
        columns: ["Endpoint", "Host"],
        rows: [
          ...(c.Endpoint ? [[writer, c.Endpoint]] : []), ...(c.ReaderEndpoint ? [["reader", c.ReaderEndpoint]] : []), ...(c.CustomEndpoints ?? []).map((h) => ["custom", h]),
        ],
      },
    },
    {
      title: "Network",
      rows: props(
        prop("VPC", extra.subnetGroup?.VpcId, true), prop("Subnet group", c.DBSubnetGroup),
        prop("Subnets", (extra.subnetGroup?.Subnets ?? []).map((s) => s.SubnetIdentifier).filter(Boolean).join(", ") || undefined, true),
        prop("Security groups", (c.VpcSecurityGroups ?? []).map((g) => `${g.VpcSecurityGroupId}${g.Status && g.Status !== "active" ? ` (${g.Status})` : ""}`).join(", ") || undefined, true),
        prop("Publicly accessible", c.PubliclyAccessible === undefined ? undefined : c.PubliclyAccessible ? "yes" : "no"),
      ),
    },
    {
      title: "Backups and maintenance",
      rows: props(
        prop("Backup retention", c.BackupRetentionPeriod === undefined ? undefined : plural(c.BackupRetentionPeriod, "day")), prop("Backup window", c.PreferredBackupWindow),
        prop("Maintenance window", c.PreferredMaintenanceWindow), prop("Deletion protection", c.DeletionProtection === undefined ? undefined : c.DeletionProtection ? "on" : "off"),
        prop("Encryption", encryptionText(c.StorageEncrypted, c.KmsKeyId)), prop("Log exports", c.EnabledCloudwatchLogsExports?.join(", ")),
        prop("Master password", c.MasterUserSecret?.SecretArn ? `managed in Secrets Manager (${lower(c.MasterUserSecret.SecretStatus) || "status unknown"})` : undefined),
      ),
    },
  ];
  const g = extra.global;
  if (g?.GlobalClusterMembers?.length)
    sections.push({
      title: `Global database ${g.GlobalClusterIdentifier ?? ""}`.trim(),
      table: {
        columns: ["Cluster", "Region", "Role", "Replication"],
        rows: g.GlobalClusterMembers.map((m) => {
          const p = parseArn(m.DBClusterArn ?? "");
          return [p?.id ?? m.DBClusterArn ?? "—", p?.region ?? "—", m.IsWriter ? "primary" : "secondary", m.IsWriter ? "—" : lower(m.SynchronizationStatus) || "—"];
        }),
      },
    });
  return { key, sections };
}

export function proxyDetail(key: string, p: RawProxy | undefined): ResourceDetail {
  if (!p) return { key, sections: [{ title: "Proxy", note: "This proxy no longer exists." }] };
  const targets = p.targets;
  return {
    key,
    sections: [
      {
        title: "Proxy",
        rows: props(
          prop("Status", p.Status), prop("Engine family", p.EngineFamily), prop("Endpoint", p.Endpoint, true), prop("Default authentication", p.DefaultAuthScheme === "IAM_AUTH" ? "end-to-end IAM" : p.DefaultAuthScheme ? "secrets" : undefined), prop("TLS required", p.RequireTLS === undefined ? undefined : p.RequireTLS ? "yes" : "no"),
          prop("Idle client timeout", p.IdleClientTimeout === undefined ? undefined : `${p.IdleClientTimeout} s`), prop("Debug logging", p.DebugLogging === undefined ? undefined : p.DebugLogging ? "on" : "off"),
          prop("Role", p.RoleArn, true), prop("Created", ms(p.CreatedDate) ? fmtTime(ms(p.CreatedDate)) : undefined),
        ),
      },
      targets
        ? targets.length
          ? {
              title: "Targets",
              table: {
                columns: ["Target", "Type", "Role", "Port", "Health", "Reason"],
                rows: targets.map((t) => [targetName(t), lower(t.Type).replace(/_/g, " ") || "—", lower(t.Role).replace(/_/g, " ") || "—", t.Port ? String(t.Port) : "—", lower(t.TargetHealth?.State) || "—", t.TargetHealth?.Description ?? t.TargetHealth?.Reason ?? ""]),
              },
            }
          : { title: "Targets", note: "No target registered: the proxy has nothing to connect to." }
        : { title: "Targets", note: unread("Targets", p.enrichment?.targets) },
      (p.Auth ?? []).length === 0
        ? { title: "Authentication", note: p.DefaultAuthScheme === "IAM_AUTH" ? "End-to-end IAM authentication: no database credentials are stored." : "No authentication configured." }
        : {
        title: "Authentication",
        table: {
          columns: ["Scheme", "IAM auth", "Client auth", "Secret"],
          rows: (p.Auth ?? []).map((a) => [a.AuthScheme ?? "—", lower(a.IAMAuth) || "—", lower(a.ClientPasswordAuthType).replace(/_/g, " ") || "—", a.SecretArn ?? "—"]),
        },
      },
      {
        title: "Network",
        rows: props(prop("VPC", p.VpcId, true), prop("Subnets", p.VpcSubnetIds?.join(", "), true), prop("Security groups", p.VpcSecurityGroupIds?.join(", "), true)),
      },
    ],
  };
}
