// MSK clusters, pure part: ListClustersV2 entries (provisioned and serverless) + GetBootstrapBrokers, real or
// simulated, → Resources and their support links (audit §6 A.2 #16, master plan B7).
// - Key: the cluster ARN ("arn:…:kafka:<r>:<a>:cluster/<name>/<uuid>"). Aliases: the cluster name.
// - Endpoints: every broker host of every bootstrap string (plaintext, TLS, SASL/SCRAM, SASL/IAM, public and
//   multi-VPC), plus the ZooKeeper hosts, without ports — so a KAFKA_BROKERS="b-1…:9098,b-2…:9098" variable resolves.
// - Network: client subnets and security groups (provisioned broker group, or each serverless VPC config).
// - Facts: public (provisioned clusters with service-provided EIPs; serverless clusters are private).
// - Links: KMS key → cluster (encrypts, data volumes); broker logs → log group / Firehose stream / bucket (logs).
// - Health: ACTIVE ok (a critical customer action pending: warning); CREATING, UPDATING, REBOOTING_BROKER, HEALING or
//   MAINTENANCE warning; FAILED error; DELETING stopped. No activity series (none documented per cluster).
// No AWS calls and no `server-only`, so node:test runs it (msk.test.ts).
import { parseArn } from "./arn.ts";
import { awsTime, enrichmentOf, fmtTime, hostOf, kmsKeyRef, logGroupRef, plural, props, tagsOf, unread } from "./serverless-common.ts";
import type { EnrichState, Facts, Health, Link, ProviderResult, Resource, ResourceDetail } from "./types.ts";

interface VpcConfig {
  SubnetIds?: string[];
  SecurityGroupIds?: string[];
}

interface Sasl {
  Iam?: { Enabled?: boolean };
  Scram?: { Enabled?: boolean };
}

// GetBootstrapBrokers' response: every field is one comma-separated "host:port,host:port" string.
export type BootstrapBrokers = Record<string, string | undefined>;

// ListClustersV2's Cluster, the parts the map uses, plus what the provider read for it.
export interface RawMskCluster {
  ClusterArn?: string;
  ClusterName?: string;
  ClusterType?: string; // PROVISIONED | SERVERLESS
  State?: string;
  StateInfo?: { Code?: string; Message?: string };
  CreationTime?: Date | string;
  CurrentVersion?: string;
  Tags?: Record<string, string>;
  Provisioned?: {
    BrokerNodeGroupInfo?: {
      ClientSubnets?: string[];
      InstanceType?: string;
      SecurityGroups?: string[];
      StorageInfo?: { EbsStorageInfo?: { VolumeSize?: number } };
      ConnectivityInfo?: { PublicAccess?: { Type?: string } };
    };
    CurrentBrokerSoftwareInfo?: { KafkaVersion?: string };
    ClientAuthentication?: { Sasl?: Sasl; Tls?: { Enabled?: boolean }; Unauthenticated?: { Enabled?: boolean } };
    EncryptionInfo?: { EncryptionAtRest?: { DataVolumeKMSKeyId?: string }; EncryptionInTransit?: { ClientBroker?: string; InCluster?: boolean } };
    LoggingInfo?: {
      BrokerLogs?: {
        CloudWatchLogs?: { Enabled?: boolean; LogGroup?: string };
        Firehose?: { Enabled?: boolean; DeliveryStream?: string };
        S3?: { Enabled?: boolean; Bucket?: string };
      };
    };
    NumberOfBrokerNodes?: number;
    ZookeeperConnectString?: string;
    ZookeeperConnectStringTls?: string;
    StorageMode?: string;
    CustomerActionStatus?: string;
  };
  Serverless?: { VpcConfigs?: VpcConfig[]; ClientAuthentication?: { Sasl?: Sasl } };
  bootstrap?: BootstrapBrokers; // undefined = not read (enrichment.bootstrap says why)
  enrichment?: Record<string, EnrichState>; // bootstrap
}

// "b-1.x:9098,b-2.x:9098" (or a ZooKeeper "z-1.x:2181,z-2.x:2181/chroot") → ["b-1.x", "b-2.x"].
export function brokerHosts(s: string | undefined): string[] {
  const out: string[] = [];
  for (const part of (s ?? "").split(",")) {
    const h = hostOf(part.trim());
    if (h && !out.includes(h)) out.push(h);
  }
  return out;
}

// GetBootstrapBrokers' fields, by access method (only these are read: nothing else in the response is copied).
export const BOOTSTRAP_FIELDS: Record<string, string> = {
  BootstrapBrokerString: "Plaintext", BootstrapBrokerStringTls: "TLS", BootstrapBrokerStringSaslScram: "SASL/SCRAM", BootstrapBrokerStringSaslIam: "SASL/IAM",
  BootstrapBrokerStringPublicTls: "Public TLS", BootstrapBrokerStringPublicSaslScram: "Public SASL/SCRAM", BootstrapBrokerStringPublicSaslIam: "Public SASL/IAM",
  BootstrapBrokerStringVpcConnectivityTls: "Multi-VPC TLS", BootstrapBrokerStringVpcConnectivitySaslScram: "Multi-VPC SASL/SCRAM", BootstrapBrokerStringVpcConnectivitySaslIam: "Multi-VPC SASL/IAM",
};

// The bootstrap strings that were read, as [field, value] in BOOTSTRAP_FIELDS order.
const bootstrapOf = (c: RawMskCluster): [string, string][] =>
  Object.keys(BOOTSTRAP_FIELDS).flatMap((k) => {
    const v = c.bootstrap && Object.hasOwn(c.bootstrap, k) ? c.bootstrap[k] : undefined;
    return typeof v === "string" && v ? [[k, v] as [string, string]] : [];
  });

// Every host the cluster answers on: all bootstrap strings, then ZooKeeper.
export function mskHosts(c: RawMskCluster): string[] {
  const all = [...bootstrapOf(c).map(([, v]) => v), c.Provisioned?.ZookeeperConnectString, c.Provisioned?.ZookeeperConnectStringTls].flatMap((s) => brokerHosts(s));
  return [...new Set(all)];
}

const WARN = new Set(["CREATING", "UPDATING", "REBOOTING_BROKER", "HEALING", "MAINTENANCE"]);

function healthOf(c: RawMskCluster): { health: Health; reason?: string } {
  const why = c.StateInfo?.Message ?? c.StateInfo?.Code;
  const state = c.State ?? "";
  if (state === "ACTIVE") {
    return c.Provisioned?.CustomerActionStatus === "CRITICAL_ACTION_REQUIRED" ? { health: "warning", reason: "critical action required (pending patching)" } : { health: "ok" };
  }
  if (WARN.has(state)) return { health: "warning", reason: `${state.toLowerCase().replace(/_/g, " ")}${why ? `: ${why}` : ""}` };
  if (state === "FAILED") return { health: "error", reason: `failed${why ? `: ${why}` : ""}` };
  if (state === "DELETING") return { health: "stopped", reason: "deleting" };
  return { health: "unknown", reason: state ? `state ${state}` : "state not reported" };
}

function authOf(c: RawMskCluster): string | undefined {
  const a: { Sasl?: Sasl; Tls?: { Enabled?: boolean }; Unauthenticated?: { Enabled?: boolean } } | undefined = c.Provisioned?.ClientAuthentication ?? c.Serverless?.ClientAuthentication;
  if (!a) return undefined;
  const on = [a.Sasl?.Iam?.Enabled && "IAM", a.Sasl?.Scram?.Enabled && "SASL/SCRAM", a.Tls?.Enabled && "mutual TLS", a.Unauthenticated?.Enabled && "unauthenticated"].filter(Boolean);
  return on.length ? on.join(", ") : undefined;
}

const nameOf = (c: RawMskCluster) => c.ClusterName ?? (c.ClusterArn ? (parseArn(c.ClusterArn)?.id.split("/")[0] ?? c.ClusterArn) : "cluster");

export function mskConsoleUrl(region: string, arn: string) {
  return `https://${region}.console.aws.amazon.com/msk/home?region=${region}#/cluster/${encodeURIComponent(arn)}/view`;
}

export function mskResult(clusters: RawMskCluster[]): ProviderResult {
  const resources: Resource[] = [];
  const links: Link[] = [];
  for (const c of clusters) {
    const arn = c.ClusterArn;
    const p = arn ? parseArn(arn) : undefined;
    if (!arn || !p) continue;
    const region = p.region;
    const name = nameOf(c);
    const serverless = c.ClusterType === "SERVERLESS" || (!!c.Serverless && !c.Provisioned);
    const g = c.Provisioned?.BrokerNodeGroupInfo;
    const vpcs = c.Serverless?.VpcConfigs ?? [];
    const subnets = [...new Set([...(g?.ClientSubnets ?? []), ...vpcs.flatMap((v) => v.SubnetIds ?? [])])];
    const groups = [...new Set([...(g?.SecurityGroups ?? []), ...vpcs.flatMap((v) => v.SecurityGroupIds ?? [])])];
    const hosts = mskHosts(c);
    const { health, reason } = healthOf(c);
    const publicType = g?.ConnectivityInfo?.PublicAccess?.Type;
    const facts: Facts = { public: !serverless && publicType === "SERVICE_PROVIDED_EIPS" };
    if (c.State) facts.state = c.State;
    const enc = c.Provisioned?.EncryptionInfo;
    const logs = c.Provisioned?.LoggingInfo?.BrokerLogs;
    const enrichment = enrichmentOf(c.enrichment);
    resources.push({
      key: arn,
      kind: "msk-cluster",
      provider: "msk",
      name,
      region,
      ...tagsOf(c.Tags),
      health,
      ...(reason ? { healthReason: reason } : {}),
      facts,
      ...(enrichment ? { enrichment } : {}),
      ...(subnets.length ? { subnetIds: subnets } : {}),
      ...(groups.length ? { securityGroups: groups } : {}),
      ...(hosts.length ? { endpoints: hosts } : {}),
      props: props([
        { label: "Type", value: serverless ? "Serverless" : "Provisioned" },
        { label: "State", value: c.State },
        { label: "Kafka version", value: c.Provisioned?.CurrentBrokerSoftwareInfo?.KafkaVersion },
        { label: "Brokers", value: g ? `${plural(c.Provisioned?.NumberOfBrokerNodes ?? 0, "broker")}${g.InstanceType ? ` × ${g.InstanceType}` : ""}` : undefined },
        { label: "Storage", value: g?.StorageInfo?.EbsStorageInfo?.VolumeSize ? `${g.StorageInfo.EbsStorageInfo.VolumeSize} GiB per broker${c.Provisioned?.StorageMode === "TIERED" ? " + tiered" : ""}` : undefined },
        { label: "Authentication", value: authOf(c) },
        { label: "In transit", value: enc?.EncryptionInTransit?.ClientBroker ? `client ${enc.EncryptionInTransit.ClientBroker.replace(/_/g, " ")}` : undefined },
        { label: "Public access", value: serverless ? undefined : publicType === "SERVICE_PROVIDED_EIPS" ? "on" : "off" },
        { label: "Bootstrap brokers", value: c.bootstrap ? plural(hosts.length, "host") : unread("brokers", c.enrichment?.bootstrap) },
      ]),
      consoleUrl: mskConsoleUrl(region, arn),
      ...(c.CreationTime ? { createdAt: awsTime(c.CreationTime) } : {}),
    });
    const kms = kmsKeyRef(enc?.EncryptionAtRest?.DataVolumeKMSKeyId, region, p.account);
    if (kms) links.push({ from: kms, to: arn, kind: "encrypts", label: "broker storage", evidence: "MSK EncryptionAtRest" });
    if (logs?.CloudWatchLogs?.Enabled) {
      const lg = logs.CloudWatchLogs.LogGroup?.startsWith("arn:") ? logs.CloudWatchLogs.LogGroup : logGroupRef(logs.CloudWatchLogs.LogGroup, region, p.account);
      if (lg) links.push({ from: arn, to: lg, kind: "logs", label: "broker logs", evidence: "MSK LoggingInfo.BrokerLogs.CloudWatchLogs" });
    }
    if (logs?.Firehose?.Enabled && logs.Firehose.DeliveryStream) {
      const to = logs.Firehose.DeliveryStream.startsWith("arn:") ? logs.Firehose.DeliveryStream : `arn:${p.partition}:firehose:${region}:${p.account}:deliverystream/${logs.Firehose.DeliveryStream}`;
      links.push({ from: arn, to, kind: "logs", label: "broker logs", evidence: "MSK LoggingInfo.BrokerLogs.Firehose" });
    }
    if (logs?.S3?.Enabled && logs.S3.Bucket) links.push({ from: arn, to: `arn:${p.partition}:s3:::${logs.S3.Bucket}`, kind: "logs", label: "broker logs", evidence: "MSK LoggingInfo.BrokerLogs.S3" });
  }
  return { resources, links, mentions: [] };
}

// The panel: brokers by authentication method, network and encryption.
export function mskDetail(key: string, c: RawMskCluster | undefined): ResourceDetail {
  if (!c) return { key, sections: [{ title: "Cluster", note: "This cluster no longer exists." }] };
  const rows = bootstrapOf(c).map(([k, v]) => [BOOTSTRAP_FIELDS[k], v.split(",").map((x) => x.trim()).join(", ")]);
  const subnets = [...(c.Provisioned?.BrokerNodeGroupInfo?.ClientSubnets ?? []), ...(c.Serverless?.VpcConfigs ?? []).flatMap((v) => v.SubnetIds ?? [])];
  return {
    key,
    sections: [
      {
        title: "Cluster",
        rows: props([
          { label: "Name", value: nameOf(c) },
          { label: "Type", value: c.ClusterType === "SERVERLESS" ? "Serverless" : "Provisioned" },
          { label: "State", value: c.State },
          { label: "State detail", value: c.StateInfo?.Message },
          { label: "Kafka version", value: c.Provisioned?.CurrentBrokerSoftwareInfo?.KafkaVersion },
          { label: "Authentication", value: authOf(c) },
          { label: "KMS key", value: c.Provisioned?.EncryptionInfo?.EncryptionAtRest?.DataVolumeKMSKeyId, mono: true },
          { label: "Subnets", value: subnets.length ? subnets.join(", ") : undefined, mono: true },
          { label: "Created", value: c.CreationTime ? fmtTime(awsTime(c.CreationTime)) : undefined },
        ]),
      },
      { title: "Bootstrap brokers", ...(rows.length ? { table: { columns: ["Access", "Brokers"], rows } } : { note: c.bootstrap ? "No bootstrap brokers reported (the cluster may still be creating)." : "Not read." }) },
    ],
  };
}
