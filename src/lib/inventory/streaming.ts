// Amazon MQ brokers and Data Firehose streams, pure part: what the mq and firehose providers read, real or simulated,
// → Resources, Links and Mentions (audit §6 A.2 #17 and the P2 mq row, master plan B7).
//
// Amazon MQ (ListBrokers + DescribeBroker):
// - Key: the broker ARN ("arn:…:mq:<r>:<a>:broker:<name>:<id>"). Aliases: the broker id.
// - Endpoints: the host of every broker instance endpoint (amqps://, ssl://, stomp+ssl://, wss://, mqtt+ssl://) and
//   of the web console — hostnames only, never a URL (no user info, ports or paths). User names are counted, not listed.
// - Network: subnets and security groups; facts.public = PubliclyAccessible.
// - Links: KMS key → broker (encrypts, unless AWS-owned); broker → general / audit log groups (logs).
// - Health: RUNNING ok (actions required: warning); REPLICA ok; REBOOT_IN_PROGRESS or *_IN_PROGRESS warning;
//   CREATION_FAILED or CRITICAL_ACTION_REQUIRED error. No activity series.
//
// Data Firehose (ListDeliveryStreams + DescribeDeliveryStream + ListTagsForDeliveryStream):
// - Key: the stream ARN. Every destination type is mapped; links are relationships the stream's configuration states:
//   source Kinesis stream or MSK cluster (poll), database source host (reads); S3 / backup buckets, OpenSearch domains
//   (writes), Redshift, OpenSearch Serverless, Splunk, Snowflake and HTTP endpoints as their host (writes — never the URL
//   path or query, which may carry tokens); processor Lambdas (invoke); CloudWatch logging (logs); KMS keys (encrypts);
//   every role (assumes); Secrets Manager secrets it reads credentials from (reads).
// - Secrets: HTTP endpoint CommonAttributes become Mention refs only (values stay on the server); Splunk HEC tokens,
//   access keys and passwords are never read into anything.
// - Health: ACTIVE ok (server-side encryption failing: warning); CREATING, UPDATING or DELETING warning; *_FAILED error.
// - Activity: AWS/Firehose IncomingRecords {DeliveryStreamName} (required, R20).
// No AWS calls and no `server-only`, so node:test runs it (streaming.test.ts).
import { arnBase, arnOf, parseArn } from "./arn.ts";
import {
  assumesLink, awsTime, clip, encryptsLink, enrichmentOf, fmtTime, hostOf, kmsKeyRef, logGroupRef, plural, props, tagsOf, targetKey, unread,
} from "./serverless-common.ts";
import type { EnrichState, Facts, Health, Link, Mention, ProviderResult, Resource, ResourceDetail } from "./types.ts";

// ---------- Amazon MQ ----------

// ListBrokers' BrokerSummary, plus DescribeBroker's fields when it was read (enrichment.describe says how it went).
export interface RawBroker {
  BrokerArn?: string;
  BrokerId?: string;
  BrokerName?: string;
  BrokerState?: string;
  Created?: Date | string;
  DeploymentMode?: string; // SINGLE_INSTANCE | ACTIVE_STANDBY_MULTI_AZ | CLUSTER_MULTI_AZ
  EngineType?: string; // ACTIVEMQ | RABBITMQ
  HostInstanceType?: string;
  // DescribeBroker
  EngineVersion?: string;
  BrokerInstances?: { ConsoleURL?: string; Endpoints?: string[]; IpAddress?: string }[];
  PubliclyAccessible?: boolean;
  SecurityGroups?: string[];
  SubnetIds?: string[];
  EncryptionOptions?: { KmsKeyId?: string; UseAwsOwnedKey?: boolean };
  Logs?: { General?: boolean; GeneralLogGroup?: string; Audit?: boolean; AuditLogGroup?: string };
  ActionsRequired?: { ActionRequiredCode?: string; ActionRequiredInfo?: string }[];
  AuthenticationStrategy?: string;
  StorageType?: string;
  Users?: { Username?: string }[];
  Tags?: Record<string, string>;
  described?: boolean; // DescribeBroker answered
  enrichment?: Record<string, EnrichState>; // describe
}

const MQ_ENGINE: Record<string, string> = { ACTIVEMQ: "ActiveMQ", RABBITMQ: "RabbitMQ" };
const MQ_MODE: Record<string, string> = { SINGLE_INSTANCE: "single instance", ACTIVE_STANDBY_MULTI_AZ: "active/standby (multi-AZ)", CLUSTER_MULTI_AZ: "cluster (multi-AZ)" };

// Every host the broker answers on: protocol endpoints and the web console, hostnames only.
export function brokerHostsOf(b: RawBroker): string[] {
  const out: string[] = [];
  for (const i of b.BrokerInstances ?? []) for (const u of [...(i.Endpoints ?? []), i.ConsoleURL]) {
    const h = hostOf(u);
    if (h && !out.includes(h)) out.push(h);
  }
  return out;
}

function mqHealth(b: RawBroker): { health: Health; reason?: string } {
  const action = b.ActionsRequired?.find((a) => a.ActionRequiredCode);
  const actionText = action ? `${action.ActionRequiredCode}${action.ActionRequiredInfo ? `: ${clip(action.ActionRequiredInfo, 160)}` : ""}` : undefined;
  const s = b.BrokerState ?? "";
  if (s === "RUNNING") return actionText ? { health: "warning", reason: `action required — ${actionText}` } : { health: "ok" };
  if (s === "REPLICA") return { health: "ok", reason: "replica (cross-Region data replication standby)" };
  if (s === "CREATION_FAILED") return { health: "error", reason: "creation failed" };
  if (s === "CRITICAL_ACTION_REQUIRED") return { health: "error", reason: `critical action required${actionText ? ` — ${actionText}` : ""}` };
  if (s === "REBOOT_IN_PROGRESS" || s.endsWith("_IN_PROGRESS")) return { health: "warning", reason: s.toLowerCase().replace(/_/g, " ") };
  return { health: "unknown", reason: s ? `state ${s}` : "state not reported" };
}

export function mqConsoleUrl(region: string, id: string) {
  return `https://${region}.console.aws.amazon.com/amazon-mq/home?region=${region}#/brokers/details?id=${encodeURIComponent(id)}`;
}

const logTarget = (v: string | undefined, region: string, account: string) => (v?.startsWith("arn:") ? arnBase(v) : logGroupRef(v, region, account));

export function mqResult(brokers: RawBroker[]): ProviderResult {
  const resources: Resource[] = [];
  const links: Link[] = [];
  for (const b of brokers) {
    const arn = b.BrokerArn;
    const p = arn ? parseArn(arn) : undefined;
    if (!arn || !p) continue;
    const region = p.region;
    const hosts = brokerHostsOf(b);
    const { health, reason } = mqHealth(b);
    const facts: Facts = {};
    if (b.PubliclyAccessible !== undefined) facts.public = b.PubliclyAccessible;
    if (b.BrokerState) facts.state = b.BrokerState;
    const enrichment = enrichmentOf(b.enrichment);
    resources.push({
      key: arn,
      kind: "mq-broker",
      provider: "mq",
      name: b.BrokerName ?? p.id.split(":")[0],
      region,
      ...tagsOf(b.described ? (b.Tags ?? {}) : undefined),
      health,
      ...(reason ? { healthReason: reason } : {}),
      facts,
      ...(enrichment ? { enrichment } : {}),
      ...(b.SubnetIds?.length ? { subnetIds: [...b.SubnetIds] } : {}),
      ...(b.SecurityGroups?.length ? { securityGroups: [...b.SecurityGroups] } : {}),
      ...(hosts.length ? { endpoints: hosts } : {}),
      ...(b.BrokerId ? { aliases: [b.BrokerId] } : {}),
      props: props([
        { label: "Engine", value: b.EngineType ? `${MQ_ENGINE[b.EngineType] ?? b.EngineType}${b.EngineVersion ? ` ${b.EngineVersion}` : ""}` : undefined },
        { label: "Deployment", value: b.DeploymentMode ? (MQ_MODE[b.DeploymentMode] ?? b.DeploymentMode) : undefined },
        { label: "Instance", value: b.HostInstanceType },
        { label: "State", value: b.BrokerState },
        { label: "Public", value: b.PubliclyAccessible === undefined ? undefined : b.PubliclyAccessible ? "yes" : "no" },
        { label: "Authentication", value: b.AuthenticationStrategy?.toLowerCase().replace(/_/g, " ") },
        { label: "Users", value: b.Users ? plural(b.Users.length, "user") : undefined },
        { label: "Storage", value: b.StorageType },
        { label: "Endpoints", value: b.described ? (hosts.length ? plural(hosts.length, "host") : "none reported") : unread("endpoints", b.enrichment?.describe) },
        { label: "Broker id", value: b.BrokerId, mono: true },
      ]),
      consoleUrl: b.BrokerId ? mqConsoleUrl(region, b.BrokerId) : undefined,
      ...(b.Created ? { createdAt: awsTime(b.Created) } : {}),
    });
    if (b.EncryptionOptions && b.EncryptionOptions.UseAwsOwnedKey === false) links.push(...encryptsLink(kmsKeyRef(b.EncryptionOptions.KmsKeyId, region, p.account), arn, "broker storage", "Amazon MQ EncryptionOptions"));
    if (b.Logs?.General) {
      const to = logTarget(b.Logs.GeneralLogGroup, region, p.account);
      if (to) links.push({ from: arn, to, kind: "logs", label: "general logs", evidence: "Amazon MQ Logs.GeneralLogGroup" });
    }
    if (b.Logs?.Audit) {
      const to = logTarget(b.Logs.AuditLogGroup, region, p.account);
      if (to) links.push({ from: arn, to, kind: "logs", label: "audit logs", evidence: "Amazon MQ Logs.AuditLogGroup" });
    }
  }
  return { resources, links, mentions: [] };
}

export function mqDetail(key: string, b: RawBroker | undefined): ResourceDetail {
  if (!b) return { key, sections: [{ title: "Broker", note: "This broker no longer exists." }] };
  // Endpoints as "scheme://host:port" — any user info a URL could carry is dropped.
  const safe = (u: string) => /^([a-z][a-z0-9+.-]*:\/\/)?(?:[^@/]*@)?([^/?#]+)/i.exec(u.trim())?.slice(1).join("") ?? "";
  const instances = (b.BrokerInstances ?? []).map((i) => [i.IpAddress ?? "—", (i.Endpoints ?? []).map(safe).filter(Boolean).join(", ") || "—"]);
  return {
    key,
    sections: [
      {
        title: "Broker",
        rows: props([
          { label: "Name", value: b.BrokerName },
          { label: "Engine", value: b.EngineType ? `${MQ_ENGINE[b.EngineType] ?? b.EngineType} ${b.EngineVersion ?? ""}`.trim() : undefined },
          { label: "Deployment", value: b.DeploymentMode ? (MQ_MODE[b.DeploymentMode] ?? b.DeploymentMode) : undefined },
          { label: "Instance", value: b.HostInstanceType },
          { label: "State", value: b.BrokerState },
          { label: "Public", value: b.PubliclyAccessible === undefined ? undefined : b.PubliclyAccessible ? "yes" : "no" },
          { label: "Users", value: b.Users ? plural(b.Users.length, "user") : undefined },
          { label: "KMS key", value: b.EncryptionOptions?.UseAwsOwnedKey ? "AWS-owned" : b.EncryptionOptions?.KmsKeyId, mono: true },
          { label: "Created", value: b.Created ? fmtTime(awsTime(b.Created)) : undefined },
        ]),
      },
      { title: "Instances", ...(instances.length ? { table: { columns: ["IP address", "Endpoints"], rows: instances } } : { note: b.described ? "No instances reported." : "Not read." }) },
      ...(b.ActionsRequired?.length ? [{ title: "Actions required", table: { columns: ["Code", "Details"], rows: b.ActionsRequired.map((a) => [a.ActionRequiredCode ?? "?", a.ActionRequiredInfo ?? ""]) } }] : []),
    ],
  };
}

// ---------- Data Firehose ----------

interface Processing {
  Enabled?: boolean;
  Processors?: { Type?: string; Parameters?: { ParameterName?: string; ParameterValue?: string }[] }[];
}
interface Logging { Enabled?: boolean; LogGroupName?: string; LogStreamName?: string }
interface S3Dest {
  RoleARN?: string;
  BucketARN?: string;
  Prefix?: string;
  EncryptionConfiguration?: { KMSEncryptionConfig?: { AWSKMSKeyARN?: string } };
  CloudWatchLoggingOptions?: Logging;
}
interface SecretConfig { SecretARN?: string; RoleARN?: string; Enabled?: boolean }
interface Common { RoleARN?: string; ProcessingConfiguration?: Processing; CloudWatchLoggingOptions?: Logging; S3DestinationDescription?: S3Dest; S3BackupDescription?: S3Dest; SecretsManagerConfiguration?: SecretConfig }

// DescribeDeliveryStream's DestinationDescription, the parts the map uses. Fields that may hold secrets (Splunk
// HECToken, Snowflake keys, HTTP access keys, Redshift passwords) are deliberately not declared and never read.
export interface FirehoseDestination {
  DestinationId?: string;
  S3DestinationDescription?: S3Dest;
  ExtendedS3DestinationDescription?: S3Dest & { ProcessingConfiguration?: Processing; S3BackupDescription?: S3Dest; S3BackupMode?: string };
  RedshiftDestinationDescription?: Common & { ClusterJDBCURL?: string; CopyCommand?: { DataTableName?: string } };
  ElasticsearchDestinationDescription?: Common & { DomainARN?: string; ClusterEndpoint?: string; IndexName?: string };
  AmazonopensearchserviceDestinationDescription?: Common & { DomainARN?: string; ClusterEndpoint?: string; IndexName?: string };
  AmazonOpenSearchServerlessDestinationDescription?: Common & { CollectionEndpoint?: string; IndexName?: string };
  SplunkDestinationDescription?: Common & { HECEndpoint?: string; HECEndpointType?: string };
  HttpEndpointDestinationDescription?: Common & {
    EndpointConfiguration?: { Url?: string; Name?: string };
    RequestConfiguration?: { ContentEncoding?: string; CommonAttributes?: { AttributeName?: string; AttributeValue?: string }[] };
  };
  SnowflakeDestinationDescription?: Common & { AccountUrl?: string; Database?: string; Schema?: string; Table?: string };
  IcebergDestinationDescription?: Common;
}

// ListDeliveryStreams' name, plus DescribeDeliveryStream and the tags when they were read.
export interface RawDeliveryStream {
  DeliveryStreamName?: string;
  DeliveryStreamARN?: string;
  DeliveryStreamStatus?: string;
  DeliveryStreamType?: string; // DirectPut | KinesisStreamAsSource | MSKAsSource | DatabaseAsSource
  FailureDescription?: { Type?: string; Details?: string };
  DeliveryStreamEncryptionConfiguration?: { KeyARN?: string; KeyType?: string; Status?: string; FailureDescription?: { Type?: string; Details?: string } };
  CreateTimestamp?: Date | string;
  LastUpdateTimestamp?: Date | string;
  Source?: {
    KinesisStreamSourceDescription?: { KinesisStreamARN?: string; RoleARN?: string };
    MSKSourceDescription?: { MSKClusterARN?: string; TopicName?: string; AuthenticationConfiguration?: { RoleARN?: string; Connectivity?: string } };
    DatabaseSourceDescription?: { Type?: string; Endpoint?: string; Port?: number; DatabaseSourceAuthenticationConfiguration?: { SecretsManagerConfiguration?: SecretConfig } };
  };
  Destinations?: FirehoseDestination[];
  HasMoreDestinations?: boolean;
  tags?: { Key?: string; Value?: string }[]; // undefined = not read (tagsUnread)
  enrichment?: Record<string, EnrichState>; // describe, tags
}

const SOURCE: Record<string, string> = { DirectPut: "Direct PUT", KinesisStreamAsSource: "Kinesis stream", MSKAsSource: "MSK topic", DatabaseAsSource: "database (CDC)" };

// What one destination is, for people ("S3 acme-data-lake", "HTTP endpoint Datadog").
function destinationLabel(d: FirehoseDestination): string {
  const bucket = (a?: string) => a?.split(":::").pop();
  if (d.ExtendedS3DestinationDescription) return `S3 ${bucket(d.ExtendedS3DestinationDescription.BucketARN) ?? ""}`.trim();
  if (d.S3DestinationDescription && !d.RedshiftDestinationDescription) return `S3 ${bucket(d.S3DestinationDescription.BucketARN) ?? ""}`.trim();
  if (d.RedshiftDestinationDescription) return `Redshift ${hostOf(d.RedshiftDestinationDescription.ClusterJDBCURL?.replace(/^jdbc:/, "")) ?? ""}`.trim();
  const os = d.AmazonopensearchserviceDestinationDescription ?? d.ElasticsearchDestinationDescription;
  if (os) return `OpenSearch ${os.DomainARN?.split("/").pop() ?? hostOf(os.ClusterEndpoint) ?? ""}`.trim();
  if (d.AmazonOpenSearchServerlessDestinationDescription) return "OpenSearch Serverless";
  if (d.SplunkDestinationDescription) return `Splunk ${hostOf(d.SplunkDestinationDescription.HECEndpoint) ?? ""}`.trim();
  if (d.HttpEndpointDestinationDescription) return `HTTP endpoint ${d.HttpEndpointDestinationDescription.EndpointConfiguration?.Name ?? hostOf(d.HttpEndpointDestinationDescription.EndpointConfiguration?.Url) ?? ""}`.trim();
  if (d.SnowflakeDestinationDescription) return "Snowflake";
  if (d.IcebergDestinationDescription) return "Apache Iceberg tables";
  return "unknown destination";
}

// Links (and mentions) one destination states.
function destinationLinks(from: string, d: FirehoseDestination, region: string, account: string): { links: Link[]; mentions: Mention[] } {
  const links: Link[] = [];
  const mentions: Mention[] = [];
  const ev = `Firehose destination${d.DestinationId ? ` ${d.DestinationId}` : ""}`;
  const writes = (to: string | undefined, label: string) => {
    if (to && !links.some((l) => l.to === to && l.kind === "writes")) links.push({ from, to, kind: "writes", label, evidence: ev });
  };
  const s3 = (s: S3Dest | undefined, label: string) => {
    if (!s) return;
    writes(s.BucketARN, label);
    links.push(...assumesLink(from, s.RoleARN, "delivery role", ev));
    links.push(...encryptsLink(kmsKeyRef(s.EncryptionConfiguration?.KMSEncryptionConfig?.AWSKMSKeyARN, region, account), from, "delivered objects", `${ev} (S3 encryption)`));
    logging(s.CloudWatchLoggingOptions);
  };
  const logging = (l: Logging | undefined) => {
    const to = l?.Enabled ? logGroupRef(l.LogGroupName, region, account) : undefined;
    if (to && !links.some((x) => x.to === to && x.kind === "logs")) links.push({ from, to, kind: "logs", label: "delivery errors", evidence: `${ev} CloudWatchLoggingOptions` });
  };
  // S3DestinationDescription is the backup / failed-records bucket, except for Redshift, which COPYs from it.
  const common = (c: Common | undefined, s3Label = "backup / failed records") => {
    if (!c) return;
    links.push(...assumesLink(from, c.RoleARN, "delivery role", ev));
    logging(c.CloudWatchLoggingOptions);
    processors(c.ProcessingConfiguration);
    s3(c.S3DestinationDescription, s3Label);
    s3(c.S3BackupDescription, "backup");
    if (c.SecretsManagerConfiguration?.Enabled !== false && c.SecretsManagerConfiguration?.SecretARN) links.push({ from, to: c.SecretsManagerConfiguration.SecretARN, kind: "reads", label: "destination credentials", evidence: `${ev} SecretsManagerConfiguration` });
  };
  const processors = (pc: Processing | undefined) => {
    if (pc?.Enabled === false) return;
    for (const p of pc?.Processors ?? []) {
      if (p.Type !== "Lambda") continue;
      const fn = p.Parameters?.find((x) => x.ParameterName === "LambdaArn")?.ParameterValue;
      if (fn?.startsWith("arn:")) links.push({ from, to: targetKey(fn), kind: "invoke", label: "record transformation", evidence: `${ev} processor` });
    }
  };
  if (d.ExtendedS3DestinationDescription) {
    const x = d.ExtendedS3DestinationDescription;
    s3(x, x.Prefix ? `prefix ${clip(x.Prefix, 60)}` : "delivery");
    processors(x.ProcessingConfiguration);
    if (x.S3BackupMode === "Enabled") s3(x.S3BackupDescription, "source backup");
  } else if (d.S3DestinationDescription && !d.RedshiftDestinationDescription) {
    s3(d.S3DestinationDescription, d.S3DestinationDescription.Prefix ? `prefix ${clip(d.S3DestinationDescription.Prefix, 60)}` : "delivery");
  }
  if (d.RedshiftDestinationDescription) {
    const r = d.RedshiftDestinationDescription;
    writes(hostOf(r.ClusterJDBCURL?.replace(/^jdbc:/, "")), `Redshift COPY${r.CopyCommand?.DataTableName ? ` into ${r.CopyCommand.DataTableName}` : ""}`);
    common(r, "staging for Redshift COPY");
  }
  for (const os of [d.AmazonopensearchserviceDestinationDescription, d.ElasticsearchDestinationDescription]) {
    if (!os) continue;
    writes(os.DomainARN ?? hostOf(os.ClusterEndpoint), `index ${os.IndexName ?? "?"}`);
    common(os);
  }
  if (d.AmazonOpenSearchServerlessDestinationDescription) {
    const x = d.AmazonOpenSearchServerlessDestinationDescription;
    writes(hostOf(x.CollectionEndpoint), `index ${x.IndexName ?? "?"}`);
    common(x);
  }
  if (d.SplunkDestinationDescription) {
    writes(hostOf(d.SplunkDestinationDescription.HECEndpoint), "Splunk HEC");
    common(d.SplunkDestinationDescription);
  }
  if (d.HttpEndpointDestinationDescription) {
    const h = d.HttpEndpointDestinationDescription;
    writes(hostOf(h.EndpointConfiguration?.Url), `HTTP endpoint${h.EndpointConfiguration?.Name ? ` ${h.EndpointConfiguration.Name}` : ""}`);
    common(h);
    // Common attributes are sent with every request and often carry API keys or tenant ids: mentions only.
    for (const a of h.RequestConfiguration?.CommonAttributes ?? []) {
      const v = (a.AttributeValue ?? "").trim();
      if (a.AttributeName && v.length >= 3) mentions.push({ from, refs: [v], via: `HTTP endpoint attribute ${a.AttributeName}` });
    }
  }
  if (d.SnowflakeDestinationDescription) {
    writes(hostOf(d.SnowflakeDestinationDescription.AccountUrl), "Snowflake");
    common(d.SnowflakeDestinationDescription);
  }
  if (d.IcebergDestinationDescription) common(d.IcebergDestinationDescription);
  return { links, mentions };
}

function firehoseHealth(s: RawDeliveryStream): { health: Health; reason?: string } {
  const st = s.DeliveryStreamStatus ?? "";
  const fail = s.FailureDescription?.Details ?? s.FailureDescription?.Type;
  if (!st) return { health: "unknown", reason: unread("status", s.enrichment?.describe) };
  if (st.endsWith("_FAILED")) return { health: "error", reason: `${st.toLowerCase().replace(/_/g, " ")}${fail ? `: ${clip(fail, 160)}` : ""}` };
  if (st === "CREATING" || st === "UPDATING" || st === "DELETING") return { health: "warning", reason: st.toLowerCase() };
  if (st === "ACTIVE") {
    const enc = s.DeliveryStreamEncryptionConfiguration;
    if (enc?.Status?.endsWith("_FAILED")) return { health: "warning", reason: `server-side encryption ${enc.Status.toLowerCase().replace(/_/g, " ")}${enc.FailureDescription?.Details ? `: ${clip(enc.FailureDescription.Details, 120)}` : ""}` };
    return { health: "ok" };
  }
  return { health: "unknown", reason: `status ${st}` };
}

export function firehoseConsoleUrl(region: string, name: string) {
  return `https://${region}.console.aws.amazon.com/firehose/home?region=${region}#/details/${encodeURIComponent(name)}/monitoring`;
}

// The stream's key: the ARN DescribeDeliveryStream returned, else built from the name (ListDeliveryStreams gives names only).
export const firehoseKey = (s: RawDeliveryStream, region: string, account: string | undefined) =>
  s.DeliveryStreamARN ?? (s.DeliveryStreamName && account ? arnOf.firehose(region, account, s.DeliveryStreamName) : undefined);

export function firehoseResult(streams: RawDeliveryStream[], o: { region: string; account?: string }): ProviderResult {
  const resources: Resource[] = [];
  const links: Link[] = [];
  const mentions: Mention[] = [];
  for (const s of streams) {
    const key = firehoseKey(s, o.region, o.account);
    const p = key ? parseArn(key) : undefined;
    if (!key || !p) continue;
    const region = p.region;
    const name = s.DeliveryStreamName ?? p.id;
    const { health, reason } = firehoseHealth(s);
    const facts: Facts = {};
    if (s.DeliveryStreamStatus) facts.state = s.DeliveryStreamStatus;
    const dests = s.Destinations ?? [];
    const src = s.Source;
    const enrichment = enrichmentOf(s.enrichment);
    resources.push({
      key,
      kind: "firehose-stream",
      provider: "firehose",
      name,
      region,
      ...tagsOf(s.tags),
      health,
      ...(reason ? { healthReason: reason } : {}),
      facts,
      ...(enrichment ? { enrichment } : {}),
      props: props([
        { label: "Status", value: s.DeliveryStreamStatus },
        { label: "Source", value: s.DeliveryStreamType ? (SOURCE[s.DeliveryStreamType] ?? s.DeliveryStreamType) + (src?.MSKSourceDescription?.TopicName ? ` · topic ${src.MSKSourceDescription.TopicName}` : "") : undefined },
        { label: "Destination", value: dests.length ? dests.map(destinationLabel).join(", ") + (s.HasMoreDestinations ? " …" : "") : s.DeliveryStreamStatus ? undefined : unread("destinations", s.enrichment?.describe) },
        { label: "Encryption", value: s.DeliveryStreamEncryptionConfiguration?.Status === "ENABLED" ? (s.DeliveryStreamEncryptionConfiguration.KeyType === "CUSTOMER_MANAGED_CMK" ? "customer managed key" : "AWS owned key") : s.DeliveryStreamEncryptionConfiguration?.Status?.toLowerCase() },
      ]),
      consoleUrl: firehoseConsoleUrl(region, name),
      ...(s.CreateTimestamp ? { createdAt: awsTime(s.CreateTimestamp) } : {}),
      ...(s.LastUpdateTimestamp ? { lastModified: awsTime(s.LastUpdateTimestamp) } : {}),
    });
    const ks = src?.KinesisStreamSourceDescription;
    if (ks?.KinesisStreamARN) links.push({ from: key, to: ks.KinesisStreamARN, kind: "poll", label: "source stream", evidence: "Firehose KinesisStreamSourceDescription" });
    links.push(...assumesLink(key, ks?.RoleARN, "source role", "Firehose KinesisStreamSourceDescription"));
    const msk = src?.MSKSourceDescription;
    if (msk?.MSKClusterARN) links.push({ from: key, to: msk.MSKClusterARN, kind: "poll", label: msk.TopicName ? `topic ${msk.TopicName}` : "source topic", evidence: "Firehose MSKSourceDescription" });
    links.push(...assumesLink(key, msk?.AuthenticationConfiguration?.RoleARN, "source role", "Firehose MSKSourceDescription"));
    const db = src?.DatabaseSourceDescription;
    const dbHost = hostOf(db?.Endpoint);
    if (dbHost) links.push({ from: key, to: dbHost, kind: "reads", label: `${db?.Type ?? "database"} change data capture`, evidence: "Firehose DatabaseSourceDescription" });
    const dbSecret = db?.DatabaseSourceAuthenticationConfiguration?.SecretsManagerConfiguration?.SecretARN;
    if (dbSecret) links.push({ from: key, to: dbSecret, kind: "reads", label: "source credentials", evidence: "Firehose DatabaseSourceAuthenticationConfiguration" });
    const sse = s.DeliveryStreamEncryptionConfiguration;
    if (sse?.KeyType === "CUSTOMER_MANAGED_CMK" && sse.Status !== "DISABLED") links.push(...encryptsLink(kmsKeyRef(sse.KeyARN, region, p.account), key, "server-side encryption", "Firehose DeliveryStreamEncryptionConfiguration"));
    for (const d of dests) {
      const r = destinationLinks(key, d, region, p.account);
      links.push(...r.links);
      mentions.push(...r.mentions);
    }
  }
  // One link per (from, to, kind): a role or key named by several parts of one stream is drawn once.
  const seen = new Set<string>();
  const unique = links.filter((l) => {
    const id = `${l.from}|${l.to}|${l.kind}`;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  return { resources, links: unique, mentions };
}

export function firehoseDetail(key: string, s: RawDeliveryStream | undefined): ResourceDetail {
  if (!s) return { key, sections: [{ title: "Stream", note: "This stream no longer exists." }] };
  const dests = s.Destinations ?? [];
  const tags = (s.tags ?? []).filter((x) => x.Key);
  return {
    key,
    sections: [
      {
        title: "Stream",
        rows: props([
          { label: "Name", value: s.DeliveryStreamName },
          { label: "Status", value: s.DeliveryStreamStatus },
          { label: "Failure", value: s.FailureDescription?.Details ?? s.FailureDescription?.Type },
          { label: "Source", value: s.DeliveryStreamType ? (SOURCE[s.DeliveryStreamType] ?? s.DeliveryStreamType) : undefined },
          { label: "Source stream", value: s.Source?.KinesisStreamSourceDescription?.KinesisStreamARN, mono: true },
          { label: "Source cluster", value: s.Source?.MSKSourceDescription?.MSKClusterARN, mono: true },
          { label: "Encryption", value: s.DeliveryStreamEncryptionConfiguration?.Status },
          { label: "Created", value: s.CreateTimestamp ? fmtTime(awsTime(s.CreateTimestamp)) : undefined },
          { label: "Updated", value: s.LastUpdateTimestamp ? fmtTime(awsTime(s.LastUpdateTimestamp)) : undefined },
        ]),
      },
      { title: "Destinations", ...(dests.length ? { table: { columns: ["Id", "Destination"], rows: dests.map((d) => [d.DestinationId ?? "?", destinationLabel(d)]) } } : { note: "Not read." }) },
      ...(tags.length ? [{ title: "Tags", table: { columns: ["Key", "Value"], rows: tags.map((x) => [x.Key!, x.Value ?? ""]) } }] : []),
    ],
  };
}
