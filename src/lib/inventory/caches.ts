// In-memory data stores beyond ElastiCache clusters, pure: ElastiCache Serverless caches (DescribeServerlessCaches)
// and MemoryDB clusters (DescribeClusters), each with its tags (ListTagsForResource / ListTags), SDK-shaped answers in,
// resources and links out (audit §6 A.2 #13 and P2 memorydb). The providers (../server/providers/elasticache-serverless.ts,
// memorydb.ts) and their simulations feed the same functions. No AWS calls and no `server-only`, so node:test runs it
// (caches.test.ts).
// - Keys: the ARNs AWS returns (= arnOf.elasticacheServerless / arnOf.memorydbCluster).
// - Endpoints: the serverless cache's endpoint and reader endpoint (one host: a serverless endpoint never matches by
//   its shared "serverless.<region>.cache" tail); the MemoryDB cluster endpoint.
// - Links: KMS → store (encrypts); MemoryDB → its SNS notification topic (event).
// - Health: serverless available ok, creating / modifying warning, create-failed error, deleting stopped; MemoryDB
//   available ok, creating / updating / snapshotting warning, deleting stopped.
// - No activity for either (no verified dimension set; A.2, CC-19). Unread tags: tagsUnread (R01).
import { arnOf } from "./arn.ts";
import { kmsRef, prop, props } from "./compute-common.ts";
import { awsTime, encryptsLink, enrichmentOf, fmtTime, plural, tagsOf, unread } from "./serverless-common.ts";
import type { EnrichState, Health, Link, ProviderResult, Resource, ResourceDetail } from "./types.ts";

type When = Date | string | number;
type Tags = { Key?: string; Value?: string }[];

export interface RawServerlessCache {
  ServerlessCacheName?: string;
  ARN?: string;
  Description?: string;
  CreateTime?: When;
  Status?: string; // creating | available | deleting | create-failed | modifying
  Engine?: string; // redis | valkey | memcached
  MajorEngineVersion?: string;
  FullEngineVersion?: string;
  CacheUsageLimits?: { DataStorage?: { Maximum?: number; Minimum?: number; Unit?: string }; ECPUPerSecond?: { Maximum?: number; Minimum?: number } };
  KmsKeyId?: string;
  SecurityGroupIds?: string[];
  SubnetIds?: string[];
  Endpoint?: { Address?: string; Port?: number };
  ReaderEndpoint?: { Address?: string; Port?: number };
  UserGroupId?: string;
  SnapshotRetentionLimit?: number;
  DailySnapshotTime?: string;
  NetworkType?: string;
  tags?: Tags; // ListTagsForResource; undefined = not read (see enrichment.tags)
  enrichment?: Record<string, EnrichState>;
}

export interface RawMemoryDbCluster {
  Name?: string;
  ARN?: string;
  Description?: string;
  Status?: string; // creating | available | updating | snapshotting | deleting
  NumberOfShards?: number;
  Shards?: { Name?: string; Status?: string; NumberOfNodes?: number }[];
  AvailabilityMode?: string; // singleaz | multiaz
  ClusterEndpoint?: { Address?: string; Port?: number };
  NodeType?: string;
  Engine?: string;
  EngineVersion?: string;
  ParameterGroupName?: string;
  SecurityGroups?: { SecurityGroupId?: string; Status?: string }[];
  SubnetGroupName?: string;
  TLSEnabled?: boolean;
  KmsKeyId?: string;
  SnsTopicArn?: string;
  SnsTopicStatus?: string;
  SnapshotRetentionLimit?: number;
  SnapshotWindow?: string;
  MaintenanceWindow?: string;
  ACLName?: string;
  DataTiering?: string;
  MultiRegionClusterName?: string;
  tags?: Tags; // ListTags; undefined = not read (see enrichment.tags)
  enrichment?: Record<string, EnrichState>;
}

export interface CacheOptions { region: string; account?: string; now?: number }

const ms = (t: When | undefined) => awsTime(t instanceof Date || typeof t === "number" || typeof t === "string" ? t : undefined);
const lower = (s: string | undefined) => String(s ?? "").toLowerCase();
const uniq = (a: (string | undefined)[]) => [...new Set(a.filter((x): x is string => !!x))];
const shortKms = (k: string) => k.replace(/^arn:aws[\w-]*:kms:[^:]+:\d+:/, "");
const engineOf = (engine: string | undefined, version: string | undefined) => (engine ? `${engine}${version ? ` ${version}` : ""}` : undefined);

// ---------- ElastiCache Serverless ----------

export function serverlessCacheHealth(c: Pick<RawServerlessCache, "Status">): { health: Health; healthReason?: string } {
  const s = lower(c.Status);
  if (s === "available") return { health: "ok" };
  if (s === "creating" || s === "modifying") return { health: "warning", healthReason: s };
  if (s === "create-failed") return { health: "error", healthReason: "creation failed" };
  if (s === "deleting") return { health: "stopped", healthReason: "deleting" };
  return { health: "unknown", healthReason: s ? `status ${s}` : "status not reported" };
}

function limitsText(c: RawServerlessCache): string | undefined {
  const d = c.CacheUsageLimits?.DataStorage;
  const e = c.CacheUsageLimits?.ECPUPerSecond;
  const parts = [d?.Maximum ? `up to ${d.Maximum} ${d.Unit ?? "GB"}` : undefined, e?.Maximum ? `up to ${e.Maximum.toLocaleString("en-US")} ECPU/s` : undefined].filter(Boolean);
  return parts.length ? parts.join(" · ") : "no limits";
}

export function serverlessCacheResource(c: RawServerlessCache, o: CacheOptions): { resource: Resource; links: Link[] } {
  const { region } = o;
  const name = c.ServerlessCacheName!;
  const key = c.ARN || arnOf.elasticacheServerless(region, o.account ?? "", name);
  const enrichment = enrichmentOf(c.enrichment);
  const resource: Resource = {
    key, kind: "elasticache-serverless", provider: "elasticache-serverless", name, region, ...tagsOf(c.tags), ...serverlessCacheHealth(c),
    props: props(
      prop("Engine", engineOf(c.Engine, c.FullEngineVersion ?? c.MajorEngineVersion)), prop("Endpoint", c.Endpoint?.Address ? `${c.Endpoint.Address}:${c.Endpoint.Port ?? ""}` : undefined, true),
      prop("Reader port", c.ReaderEndpoint?.Port), prop("Usage limits", limitsText(c)),
      prop("Encryption", c.KmsKeyId ? `KMS ${shortKms(c.KmsKeyId)}` : "AWS-owned key"), prop("User group", c.UserGroupId),
      prop("Snapshots", c.SnapshotRetentionLimit === undefined ? undefined : c.SnapshotRetentionLimit ? `${plural(c.SnapshotRetentionLimit, "day")}${c.DailySnapshotTime ? ` · at ${c.DailySnapshotTime}` : ""}` : "off"),
      prop("Description", c.Description), prop("Created", ms(c.CreateTime) ? fmtTime(ms(c.CreateTime)) : undefined),
    ),
    endpoints: uniq([c.Endpoint?.Address, c.ReaderEndpoint?.Address]), aliases: [name],
    ...(c.SubnetIds?.length ? { subnetIds: [...c.SubnetIds] } : {}), ...(c.SecurityGroupIds?.length ? { securityGroups: [...c.SecurityGroupIds] } : {}),
    ...(enrichment ? { enrichment } : {}),
    consoleUrl: `https://${region}.console.aws.amazon.com/elasticache/home?region=${region}#/serverless`,
    ...(ms(c.CreateTime) ? { createdAt: ms(c.CreateTime) } : {}), ...(o.now ? { observedAt: o.now } : {}),
  };
  return { resource, links: encryptsLink(kmsRef(c.KmsKeyId, region, o.account), key, "at rest", "serverless cache encryption key (KmsKeyId)") };
}

export function serverlessCacheResult(caches: RawServerlessCache[], o: CacheOptions): ProviderResult {
  const out = caches.filter((c) => c.ServerlessCacheName).map((c) => serverlessCacheResource(c, o));
  return { resources: out.map((x) => x.resource), links: out.flatMap((x) => x.links), mentions: [] };
}

export function serverlessCacheDetail(key: string, c: RawServerlessCache | undefined): ResourceDetail {
  if (!c?.ServerlessCacheName) return { key, sections: [{ title: "Serverless cache", note: "This cache no longer exists." }] };
  return {
    key,
    sections: [
      {
        title: "Serverless cache",
        rows: props(
          prop("Status", c.Status), prop("Engine", engineOf(c.Engine, c.FullEngineVersion ?? c.MajorEngineVersion)), prop("Usage limits", limitsText(c)),
          prop("Data storage", c.CacheUsageLimits?.DataStorage ? `${c.CacheUsageLimits.DataStorage.Minimum ?? 0}–${c.CacheUsageLimits.DataStorage.Maximum ?? "∞"} ${c.CacheUsageLimits.DataStorage.Unit ?? "GB"}` : undefined),
          prop("ECPU per second", c.CacheUsageLimits?.ECPUPerSecond ? `${c.CacheUsageLimits.ECPUPerSecond.Minimum ?? 0}–${c.CacheUsageLimits.ECPUPerSecond.Maximum ?? "∞"}` : undefined),
          prop("User group", c.UserGroupId), prop("Description", c.Description), prop("Created", ms(c.CreateTime) ? fmtTime(ms(c.CreateTime)) : undefined),
          prop("Tags", c.tags ? undefined : unread("tags", c.enrichment?.tags)),
        ),
      },
      {
        title: "Endpoints",
        table: {
          columns: ["Endpoint", "Host", "Port"],
          rows: [
            ...(c.Endpoint?.Address ? [["primary", c.Endpoint.Address, String(c.Endpoint.Port ?? "")]] : []),
            ...(c.ReaderEndpoint?.Address ? [["reader", c.ReaderEndpoint.Address, String(c.ReaderEndpoint.Port ?? "")]] : []),
          ],
        },
      },
      {
        title: "Network and security",
        rows: props(
          prop("Subnets", c.SubnetIds?.join(", "), true), prop("Security groups", c.SecurityGroupIds?.join(", "), true), prop("Network type", c.NetworkType),
          prop("Encryption", c.KmsKeyId ? `KMS ${c.KmsKeyId}` : "AWS-owned key", !!c.KmsKeyId),
          prop("Snapshots", c.SnapshotRetentionLimit === undefined ? undefined : c.SnapshotRetentionLimit ? `${plural(c.SnapshotRetentionLimit, "day")}${c.DailySnapshotTime ? ` · at ${c.DailySnapshotTime}` : ""}` : "off"),
        ),
      },
    ],
  };
}

// ---------- MemoryDB ----------

export function memorydbHealth(c: Pick<RawMemoryDbCluster, "Status">): { health: Health; healthReason?: string } {
  const s = lower(c.Status);
  if (s === "available") return { health: "ok" };
  if (s === "creating" || s === "updating" || s === "snapshotting") return { health: "warning", healthReason: s };
  if (s === "deleting") return { health: "stopped", healthReason: "deleting" };
  return { health: "unknown", healthReason: s ? `status ${s}` : "status not reported" };
}

const shardsText = (c: RawMemoryDbCluster) => {
  if (c.NumberOfShards === undefined) return undefined;
  const nodes = c.Shards?.reduce((n, s) => n + (s.NumberOfNodes ?? 0), 0);
  return `${plural(c.NumberOfShards, "shard")}${nodes ? ` · ${plural(nodes, "node")}` : ""}${c.NodeType ? ` · ${c.NodeType}` : ""}`;
};

export function memorydbResource(c: RawMemoryDbCluster, o: CacheOptions): { resource: Resource; links: Link[] } {
  const { region } = o;
  const name = c.Name!;
  const key = c.ARN || arnOf.memorydbCluster(region, o.account ?? "", name);
  const sgs = uniq((c.SecurityGroups ?? []).map((g) => g.SecurityGroupId));
  const enrichment = enrichmentOf(c.enrichment);
  const resource: Resource = {
    key, kind: "memorydb-cluster", provider: "memorydb", name, region, ...tagsOf(c.tags), ...memorydbHealth(c),
    props: props(
      prop("Engine", engineOf(c.Engine, c.EngineVersion)), prop("Shards", shardsText(c)), prop("Availability", c.AvailabilityMode === "multiaz" ? "Multi-AZ" : c.AvailabilityMode === "singleaz" ? "single AZ" : c.AvailabilityMode),
      prop("Endpoint", c.ClusterEndpoint?.Address ? `${c.ClusterEndpoint.Address}:${c.ClusterEndpoint.Port ?? ""}` : undefined, true),
      prop("TLS", c.TLSEnabled === undefined ? undefined : c.TLSEnabled ? "on" : "off"), prop("Encryption", c.KmsKeyId ? `KMS ${shortKms(c.KmsKeyId)}` : undefined),
      prop("Access control list", c.ACLName), prop("Data tiering", c.DataTiering === "true" ? "on" : undefined), prop("Multi-Region cluster", c.MultiRegionClusterName),
      prop("Subnet group", c.SubnetGroupName),
      prop("Snapshots", c.SnapshotRetentionLimit === undefined ? undefined : c.SnapshotRetentionLimit ? `${plural(c.SnapshotRetentionLimit, "day")}${c.SnapshotWindow ? ` · window ${c.SnapshotWindow}` : ""}` : "off"),
    ),
    endpoints: uniq([c.ClusterEndpoint?.Address]), aliases: [name],
    ...(sgs.length ? { securityGroups: sgs } : {}), ...(enrichment ? { enrichment } : {}),
    consoleUrl: `https://${region}.console.aws.amazon.com/memorydb/home?region=${region}#/clusters`,
    ...(o.now ? { observedAt: o.now } : {}),
  };
  const links: Link[] = [
    ...encryptsLink(kmsRef(c.KmsKeyId, region, o.account), key, "at rest", "MemoryDB encryption key (KmsKeyId)"),
    ...(c.SnsTopicArn && lower(c.SnsTopicStatus) !== "inactive" ? [{ from: key, to: c.SnsTopicArn, kind: "event" as const, label: "cluster events", evidence: "MemoryDB SnsTopicArn" }] : []),
  ];
  return { resource, links };
}

export function memorydbResult(clusters: RawMemoryDbCluster[], o: CacheOptions): ProviderResult {
  const out = clusters.filter((c) => c.Name).map((c) => memorydbResource(c, o));
  return { resources: out.map((x) => x.resource), links: out.flatMap((x) => x.links), mentions: [] };
}

export function memorydbDetail(key: string, c: RawMemoryDbCluster | undefined): ResourceDetail {
  if (!c?.Name) return { key, sections: [{ title: "Cluster", note: "This cluster no longer exists." }] };
  return {
    key,
    sections: [
      {
        title: "Cluster",
        rows: props(
          prop("Status", c.Status), prop("Engine", engineOf(c.Engine, c.EngineVersion)), prop("Node type", c.NodeType), prop("Shards", shardsText(c)),
          prop("Endpoint", c.ClusterEndpoint?.Address ? `${c.ClusterEndpoint.Address}:${c.ClusterEndpoint.Port ?? ""}` : undefined, true),
          prop("Parameter group", c.ParameterGroupName), prop("Access control list", c.ACLName), prop("Description", c.Description),
          prop("Tags", c.tags ? undefined : unread("tags", c.enrichment?.tags)),
        ),
      },
      c.Shards?.length
        ? { title: "Shards", table: { columns: ["Shard", "Status", "Nodes"], rows: c.Shards.map((s) => [s.Name ?? "—", s.Status ?? "—", String(s.NumberOfNodes ?? "—")]) } }
        : { title: "Shards", note: "Shard details not listed." },
      {
        title: "Network and security",
        rows: props(
          prop("Subnet group", c.SubnetGroupName), prop("Security groups", (c.SecurityGroups ?? []).map((g) => g.SecurityGroupId).filter(Boolean).join(", "), true),
          prop("TLS", c.TLSEnabled === undefined ? undefined : c.TLSEnabled ? "on" : "off"), prop("Encryption", c.KmsKeyId, true), prop("Notifications", c.SnsTopicArn, true),
          prop("Maintenance window", c.MaintenanceWindow), prop("Snapshot window", c.SnapshotWindow),
          prop("Snapshot retention", c.SnapshotRetentionLimit === undefined ? undefined : plural(c.SnapshotRetentionLimit, "day")),
        ),
      },
    ],
  };
}
