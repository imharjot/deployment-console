// Kinesis and DynamoDB, pure part: raw API shapes (real or simulated) → Resources, plus the one relationship either
// stores: the KMS key that encrypts it. Their value on the map is mostly being found — a DynamoDB table carries its
// stream ARN as an alias so Lambda event source mappings (which name the stream) resolve to the table, and both carry
// their names for env-var mentions. Tags that weren't read mark the resource tagsUnread (R01); a table whose details
// weren't read has unknown health (its status is in DescribeTable only).
import { arnName, clip, encryptsLink, enrichmentOf, fmtBytes, fmtCount, fmtTime, kmsKeyRef, parseArn, plural, props, tagsOf, unread } from "./serverless-common.ts";
import type { EnrichState, Health, Link, ProviderResult, Resource } from "./types.ts";

// ---------- Kinesis ----------

export interface RawStream {
  StreamName?: string;
  StreamARN?: string;
  StreamStatus?: string;
  StreamModeDetails?: { StreamMode?: string };
  RetentionPeriodHours?: number;
  StreamCreationTimestamp?: Date;
  EncryptionType?: string;
  KeyId?: string;
  OpenShardCount?: number;
  ConsumerCount?: number;
  consumers?: { ConsumerName?: string; ConsumerARN?: string; ConsumerStatus?: string }[];
  tags?: Record<string, string>; // undefined = not read (tagsUnread)
  enrichment?: Record<string, EnrichState>; // summary, consumers, tags
  lastActivityAt?: number;
}

export function kinesisConsoleUrl(name: string, region: string) {
  return `https://${region}.console.aws.amazon.com/kinesis/home?region=${region}#/streams/details/${encodeURIComponent(name)}/monitoring`;
}

export function kinesisResult(streams: RawStream[]): ProviderResult {
  const resources: Resource[] = [];
  const links: Link[] = [];
  for (const s of streams) {
    if (!s.StreamARN) continue;
    const name = s.StreamName ?? arnName(s.StreamARN);
    const arn = parseArn(s.StreamARN);
    const region = arn?.region ?? "";
    const status = s.StreamStatus;
    const health: Health = !status ? "unknown" : status === "ACTIVE" ? "ok" : "warning";
    const consumers = s.consumers ?? [];
    const enrichment = enrichmentOf(s.enrichment);
    const summaryRead = (s.enrichment?.summary ?? "ok") === "ok";
    resources.push({
      key: s.StreamARN,
      kind: "kinesis",
      provider: "kinesis",
      name,
      region,
      ...tagsOf(s.tags),
      health,
      healthReason: !status ? "stream status not reported" : health === "ok" ? undefined : `stream is ${status.toLowerCase()}`,
      ...(enrichment ? { enrichment } : {}),
      props: props([
        { label: "Mode", value: s.StreamModeDetails?.StreamMode === "ON_DEMAND" ? "On-demand" : s.StreamModeDetails?.StreamMode === "PROVISIONED" ? "Provisioned" : s.StreamModeDetails?.StreamMode },
        { label: "Open shards", value: s.OpenShardCount !== undefined ? fmtCount(s.OpenShardCount) : undefined },
        { label: "Retention", value: s.RetentionPeriodHours !== undefined ? (s.RetentionPeriodHours % 24 === 0 && s.RetentionPeriodHours >= 48 ? `${s.RetentionPeriodHours / 24} days` : `${s.RetentionPeriodHours} h`) : undefined },
        { label: "Enhanced fan-out consumers", value: consumers.length ? clip(consumers.map((c) => c.ConsumerName ?? "?").join(", "), 120) : s.ConsumerCount ? String(s.ConsumerCount) : undefined },
        { label: "Encryption", value: !summaryRead ? unread("", s.enrichment?.summary).trim() : s.EncryptionType === "KMS" ? `KMS ${s.KeyId?.replace(/^arn:aws[\w-]*:kms:[^:]+:\d+:/, "") ?? ""}`.trim() : "none" },
        { label: "Status", value: status && status !== "ACTIVE" ? status : undefined },
        { label: "Created", value: s.StreamCreationTimestamp ? fmtTime(s.StreamCreationTimestamp.getTime()) : undefined },
      ]),
      aliases: [name],
      lastActivityAt: s.lastActivityAt,
      consoleUrl: kinesisConsoleUrl(name, region),
      createdAt: s.StreamCreationTimestamp?.getTime(),
    });
    if (s.EncryptionType === "KMS") links.push(...encryptsLink(kmsKeyRef(s.KeyId, region, arn?.account), s.StreamARN, "records", "stream encryption (KeyId)"));
  }
  return { resources, links, mentions: [] };
}

// ---------- DynamoDB ----------

export interface RawTable {
  TableName?: string;
  TableArn?: string;
  TableStatus?: string;
  BillingModeSummary?: { BillingMode?: string };
  ProvisionedThroughput?: { ReadCapacityUnits?: number; WriteCapacityUnits?: number };
  ItemCount?: number;
  TableSizeBytes?: number;
  LatestStreamArn?: string;
  StreamSpecification?: { StreamEnabled?: boolean; StreamViewType?: string };
  GlobalSecondaryIndexes?: { IndexName?: string; IndexStatus?: string; ItemCount?: number }[];
  LocalSecondaryIndexes?: { IndexName?: string }[];
  KeySchema?: { AttributeName?: string; KeyType?: string }[];
  TableClassSummary?: { TableClass?: string };
  SSEDescription?: { Status?: string; SSEType?: string; KMSMasterKeyArn?: string };
  DeletionProtectionEnabled?: boolean;
  CreationDateTime?: Date;
  Replicas?: { RegionName?: string; ReplicaStatus?: string }[];
  tags?: Record<string, string>; // undefined = not read (tagsUnread)
  enrichment?: Record<string, EnrichState>; // details (DescribeTable), tags
  lastActivityAt?: number;
}

export function dynamoConsoleUrl(name: string, region: string) {
  return `https://${region}.console.aws.amazon.com/dynamodbv2/home?region=${region}#table?name=${encodeURIComponent(name)}`;
}

export function billingLabel(t: RawTable): string {
  if (t.BillingModeSummary?.BillingMode === "PAY_PER_REQUEST") return "On-demand";
  const p = t.ProvisionedThroughput;
  return p ? `Provisioned · ${p.ReadCapacityUnits ?? 0} RCU · ${p.WriteCapacityUnits ?? 0} WCU` : "Provisioned";
}

function tableHealth(t: RawTable): { health: Health; reason?: string } {
  if (!t.TableStatus) return { health: "unknown", reason: unread("table details", t.enrichment?.details) };
  const s = t.TableStatus;
  if (s === "INACCESSIBLE_ENCRYPTION_CREDENTIALS") return { health: "error", reason: "the table's KMS key is inaccessible" };
  if (s === "ARCHIVED" || s === "ARCHIVING") return { health: "stopped", reason: `table ${s.toLowerCase()} (KMS key unavailable for 7 days)` };
  if (s !== "ACTIVE") return { health: "warning", reason: `table is ${s.toLowerCase()}` };
  const building = (t.GlobalSecondaryIndexes ?? []).filter((g) => g.IndexStatus && g.IndexStatus !== "ACTIVE");
  if (building.length) return { health: "warning", reason: `index ${building.map((g) => g.IndexName).join(", ")} ${building[0].IndexStatus?.toLowerCase()}` };
  return { health: "ok" };
}

export function dynamoResult(tables: RawTable[]): ProviderResult {
  const resources: Resource[] = [];
  const links: Link[] = [];
  for (const t of tables) {
    if (!t.TableArn || !t.TableName) continue;
    const arn = parseArn(t.TableArn);
    const region = arn?.region ?? "";
    const { health, reason } = tableHealth(t);
    const read = !!t.TableStatus;
    const key = (t.KeySchema ?? []).map((k) => `${k.AttributeName} (${k.KeyType === "HASH" ? "partition" : "sort"})`).join(", ");
    const gsis = t.GlobalSecondaryIndexes ?? [];
    const enrichment = enrichmentOf(t.enrichment);
    resources.push({
      key: t.TableArn,
      kind: "dynamodb",
      provider: "dynamodb",
      name: t.TableName,
      region,
      ...tagsOf(t.tags),
      health,
      healthReason: reason,
      ...(enrichment ? { enrichment } : {}),
      props: props([
        { label: "Billing", value: read ? billingLabel(t) : undefined },
        { label: "Items", value: t.ItemCount !== undefined ? `~${fmtCount(t.ItemCount)}` : undefined },
        { label: "Size", value: t.TableSizeBytes !== undefined ? fmtBytes(t.TableSizeBytes) : undefined },
        { label: "Key", value: key || undefined, mono: true },
        { label: "Indexes", value: gsis.length || t.LocalSecondaryIndexes?.length ? clip([...gsis.map((g) => g.IndexName), ...(t.LocalSecondaryIndexes ?? []).map((l) => `${l.IndexName} (local)`)].join(", "), 120) : undefined },
        { label: "Stream", value: t.StreamSpecification?.StreamEnabled ? t.StreamSpecification.StreamViewType ?? "enabled" : undefined },
        { label: "Table class", value: t.TableClassSummary?.TableClass === "STANDARD_INFREQUENT_ACCESS" ? "Standard-IA" : undefined },
        { label: "Global table", value: t.Replicas?.length ? plural(t.Replicas.length, "replica") + `: ${t.Replicas.map((r) => r.RegionName).join(", ")}` : undefined },
        { label: "Deletion protection", value: read ? (t.DeletionProtectionEnabled ? "on" : "off") : undefined },
        { label: "Encryption", value: !read ? undefined : t.SSEDescription?.SSEType === "KMS" ? `KMS${t.SSEDescription.KMSMasterKeyArn ? ` ${arnName(t.SSEDescription.KMSMasterKeyArn)}` : ""}` : "AWS owned key" },
        { label: "Created", value: t.CreationDateTime ? fmtTime(t.CreationDateTime.getTime()) : undefined },
      ]),
      aliases: [t.TableName, ...(t.LatestStreamArn ? [t.LatestStreamArn] : [])],
      lastActivityAt: t.lastActivityAt,
      consoleUrl: dynamoConsoleUrl(t.TableName, region),
      createdAt: t.CreationDateTime?.getTime(),
    });
    if (t.SSEDescription?.SSEType === "KMS") links.push(...encryptsLink(kmsKeyRef(t.SSEDescription.KMSMasterKeyArn, region, arn?.account), t.TableArn, "items", "table encryption (SSEDescription.KMSMasterKeyArn)"));
  }
  return { resources, links, mentions: [] };
}
