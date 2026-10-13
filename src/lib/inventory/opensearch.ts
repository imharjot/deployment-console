// OpenSearch Service domains as the cloud map sees them, pure: SDK-shaped DescribeDomains answers (+ ListTags) in,
// resources and links out (audit §6 A.2 #15). The provider (../server/providers/opensearch.ts) and its simulation feed
// the same functions. No AWS calls and no `server-only`, so node:test runs it (opensearch.test.ts).
// - Key: the domain's ARN (= arnOf.opensearchDomain, "arn:…:es:<r>:<a>:domain/<name>").
// - Endpoints: Endpoint (public), EndpointV2 (dual stack), Endpoints.vpc / vpcv2 (VPC domains) and the custom endpoint.
// - Network: VPCOptions; facts.public when the domain has no VPC (its endpoint is on the internet, access policy aside).
// - Links: KMS → domain (encrypts); domain → its log groups (logs); certificate → domain (tls, custom endpoint).
// - Health from DomainProcessingStatus: Isolated error; Creating, Modifying, UpgradingEngineVersion and
//   UpdatingServiceSoftware warning; Deleting stopped; Active ok. Without it: the Processing / UpgradeProcessing flags.
// The access policy, advanced options and identity settings are never copied (opensearch.test.ts sentinel).
import { kmsRef, prop, props } from "./compute-common.ts";
import { encryptsLink, enrichmentOf, logsLink, tagsOf, unread } from "./serverless-common.ts";
import type { EnrichState, Health, Link, ProviderResult, Resource, ResourceDetail } from "./types.ts";

export interface RawDomain {
  DomainId?: string; // "<account>/<name>"
  DomainName?: string;
  ARN?: string;
  Created?: boolean;
  Deleted?: boolean;
  Endpoint?: string;
  EndpointV2?: string;
  Endpoints?: Record<string, string>; // { vpc: "vpc-<name>-<id>.<r>.es.amazonaws.com", vpcv2?: … }
  Processing?: boolean;
  UpgradeProcessing?: boolean;
  DomainProcessingStatus?: string; // Active | Creating | Modifying | UpgradingEngineVersion | UpdatingServiceSoftware | Isolated | Deleting
  EngineVersion?: string; // "OpenSearch_2.17" | "Elasticsearch_7.10"
  ClusterConfig?: {
    InstanceType?: string; InstanceCount?: number; DedicatedMasterEnabled?: boolean; DedicatedMasterType?: string; DedicatedMasterCount?: number;
    ZoneAwarenessEnabled?: boolean; WarmEnabled?: boolean; WarmType?: string; WarmCount?: number; MultiAZWithStandbyEnabled?: boolean;
  };
  EBSOptions?: { EBSEnabled?: boolean; VolumeType?: string; VolumeSize?: number; Iops?: number; Throughput?: number };
  VPCOptions?: { VPCId?: string; SubnetIds?: string[]; AvailabilityZones?: string[]; SecurityGroupIds?: string[] };
  EncryptionAtRestOptions?: { Enabled?: boolean; KmsKeyId?: string };
  NodeToNodeEncryptionOptions?: { Enabled?: boolean };
  DomainEndpointOptions?: { EnforceHTTPS?: boolean; TLSSecurityPolicy?: string; CustomEndpointEnabled?: boolean; CustomEndpoint?: string; CustomEndpointCertificateArn?: string };
  AdvancedSecurityOptions?: { Enabled?: boolean; InternalUserDatabaseEnabled?: boolean; AnonymousAuthEnabled?: boolean };
  LogPublishingOptions?: Record<string, { CloudWatchLogsLogGroupArn?: string; Enabled?: boolean }>;
  ServiceSoftwareOptions?: { CurrentVersion?: string; NewVersion?: string; UpdateAvailable?: boolean; UpdateStatus?: string };
  tags?: { Key?: string; Value?: string }[]; // ListTags; undefined = not read (see enrichment.tags)
  enrichment?: Record<string, EnrichState>;
}

export interface OpenSearchOptions { region: string; account?: string; now?: number }

const LOG_NAMES: Record<string, string> = { ES_APPLICATION_LOGS: "application logs", INDEX_SLOW_LOGS: "index slow logs", SEARCH_SLOW_LOGS: "search slow logs", AUDIT_LOGS: "audit logs" };

export function domainHealth(d: Pick<RawDomain, "DomainProcessingStatus" | "Created" | "Deleted" | "Processing" | "UpgradeProcessing">): { health: Health; healthReason?: string } {
  const s = d.DomainProcessingStatus;
  if (d.Deleted || s === "Deleting") return { health: "stopped", healthReason: "deleting" };
  if (s === "Isolated") return { health: "error", healthReason: "isolated — AWS cut the domain off (check the account's notifications)" };
  if (s === "Creating" || d.Created === false) return { health: "warning", healthReason: "creating" };
  if (s === "UpgradingEngineVersion" || (!s && d.UpgradeProcessing)) return { health: "warning", healthReason: "engine upgrade in progress" };
  if (s === "UpdatingServiceSoftware") return { health: "warning", healthReason: "service software update in progress" };
  if (s === "Modifying" || (!s && d.Processing)) return { health: "warning", healthReason: "configuration change in progress" };
  if (s === "Active" || (!s && d.Created)) return { health: "ok" };
  return { health: "unknown", healthReason: s ? `status ${s}` : "status not reported" };
}

const isPublic = (d: RawDomain) => !d.VPCOptions?.VPCId;
// "OpenSearch_2.17" → "OpenSearch 2.17" (the map's edge labels take the engine's first word).
const engineText = (v: string | undefined) => v?.replace(/_/g, " ");
const uniq = (a: (string | undefined)[]) => [...new Set(a.filter((x): x is string => !!x))];

function nodesText(d: RawDomain): string | undefined {
  const c = d.ClusterConfig;
  if (!c?.InstanceType) return undefined;
  const parts = [`${c.InstanceCount ?? 1} × ${c.InstanceType}`];
  if (c.DedicatedMasterEnabled) parts.push(`${c.DedicatedMasterCount ?? "?"} dedicated masters`);
  if (c.WarmEnabled) parts.push(`${c.WarmCount ?? "?"} UltraWarm`);
  return parts.join(" · ");
}
const storageText = (d: RawDomain) =>
  d.EBSOptions?.EBSEnabled ? `EBS ${d.EBSOptions.VolumeType ?? ""} ${d.EBSOptions.VolumeSize ? `${d.EBSOptions.VolumeSize} GiB per node` : ""}`.replace(/\s+/g, " ").trim() : d.EBSOptions ? "instance storage" : undefined;
function encryptionText(d: RawDomain): string | undefined {
  const rest = d.EncryptionAtRestOptions;
  const parts = [
    rest?.Enabled === undefined ? undefined : rest.Enabled ? `at rest (KMS ${rest.KmsKeyId ? rest.KmsKeyId.replace(/^arn:aws[\w-]*:kms:[^:]+:\d+:/, "") : "default key"})` : "not at rest",
    d.NodeToNodeEncryptionOptions?.Enabled ? "node to node" : undefined,
    d.DomainEndpointOptions?.EnforceHTTPS ? "HTTPS only" : undefined,
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : undefined;
}

export function domainResource(d: RawDomain, o: OpenSearchOptions): { resource: Resource; links: Link[] } {
  const { region } = o;
  const name = d.DomainName!;
  const key = d.ARN!;
  const vpc = d.VPCOptions;
  const custom = d.DomainEndpointOptions?.CustomEndpointEnabled ? d.DomainEndpointOptions.CustomEndpoint : undefined;
  const enrichment = enrichmentOf(d.enrichment);
  const resource: Resource = {
    key, kind: "opensearch-domain", provider: "opensearch", name, region, ...tagsOf(d.tags), ...domainHealth(d),
    props: props(
      prop("Engine", engineText(d.EngineVersion)), prop("Nodes", nodesText(d)), prop("Storage", storageText(d)),
      prop("Zone awareness", d.ClusterConfig?.MultiAZWithStandbyEnabled ? "Multi-AZ with standby" : d.ClusterConfig?.ZoneAwarenessEnabled === undefined ? undefined : d.ClusterConfig.ZoneAwarenessEnabled ? "on" : "off"),
      prop("Network", isPublic(d) ? "public endpoint (no VPC)" : `VPC ${vpc!.VPCId}`), prop("Endpoint", d.Endpoints?.vpc ?? d.Endpoint, true), prop("Custom endpoint", custom, true),
      prop("Encryption", encryptionText(d)),
      prop("Fine-grained access control", d.AdvancedSecurityOptions?.Enabled === undefined ? undefined : d.AdvancedSecurityOptions.Enabled ? "on" : "off"),
      prop("Service software", d.ServiceSoftwareOptions?.UpdateAvailable ? `${d.ServiceSoftwareOptions.CurrentVersion ?? "?"} (update to ${d.ServiceSoftwareOptions.NewVersion ?? "a newer version"} available)` : d.ServiceSoftwareOptions?.CurrentVersion),
    ),
    endpoints: uniq([d.Endpoint, d.EndpointV2, ...Object.values(d.Endpoints ?? {}), custom]),
    aliases: uniq([name, d.DomainId]),
    ...(vpc?.VPCId ? { vpcId: vpc.VPCId } : {}), ...(vpc?.SubnetIds?.length ? { subnetIds: [...vpc.SubnetIds] } : {}),
    ...(vpc?.SecurityGroupIds?.length ? { securityGroups: [...vpc.SecurityGroupIds] } : {}),
    facts: { public: isPublic(d) },
    ...(enrichment ? { enrichment } : {}),
    consoleUrl: `https://${region}.console.aws.amazon.com/aos/home?region=${region}#opensearch/domains/${encodeURIComponent(name)}`,
    ...(o.now ? { observedAt: o.now } : {}),
  };
  const kms = d.EncryptionAtRestOptions?.Enabled ? kmsRef(d.EncryptionAtRestOptions.KmsKeyId, region, o.account) : undefined;
  const links: Link[] = [
    ...encryptsLink(kms, key, "at rest", "domain encryption at rest (KmsKeyId)"),
    ...Object.entries(d.LogPublishingOptions ?? {}).filter(([, l]) => l.Enabled !== false).flatMap(([type, l]) => logsLink(key, l.CloudWatchLogsLogGroupArn, Object.hasOwn(LOG_NAMES, type) ? LOG_NAMES[type] : type.toLowerCase(), `LogPublishingOptions.${type}`)),
    ...(custom && d.DomainEndpointOptions?.CustomEndpointCertificateArn ? [{ from: d.DomainEndpointOptions.CustomEndpointCertificateArn, to: key, kind: "tls" as const, label: custom, evidence: "custom endpoint certificate" }] : []),
  ];
  return { resource, links };
}

export function opensearchResult(domains: RawDomain[], o: OpenSearchOptions): ProviderResult {
  const out = domains.filter((d) => d.DomainName && d.ARN).map((d) => domainResource(d, o));
  return { resources: out.map((x) => x.resource), links: out.flatMap((x) => x.links), mentions: [] };
}

// The panel: endpoints, nodes, security posture and log publishing.
export function opensearchDetail(key: string, d: RawDomain | undefined): ResourceDetail {
  if (!d?.DomainName) return { key, sections: [{ title: "Domain", note: "This domain no longer exists." }] };
  const c = d.ClusterConfig;
  const endpoints: string[][] = [
    ...(d.Endpoint ? [["public", d.Endpoint]] : []), ...(d.EndpointV2 ? [["dual stack", d.EndpointV2]] : []),
    ...Object.entries(d.Endpoints ?? {}).map(([k, v]) => [k, v]), ...(d.DomainEndpointOptions?.CustomEndpointEnabled && d.DomainEndpointOptions.CustomEndpoint ? [["custom", d.DomainEndpointOptions.CustomEndpoint]] : []),
  ];
  const logs = Object.entries(d.LogPublishingOptions ?? {});
  return {
    key,
    sections: [
      {
        title: "Domain",
        rows: props(
          prop("Status", d.DomainProcessingStatus ?? (d.Processing ? "Processing" : undefined)), prop("Engine", engineText(d.EngineVersion)), prop("Domain id", d.DomainId, true),
          prop("Service software", d.ServiceSoftwareOptions?.CurrentVersion), prop("Software update", d.ServiceSoftwareOptions?.UpdateAvailable ? `${d.ServiceSoftwareOptions.NewVersion ?? "available"} (${d.ServiceSoftwareOptions.UpdateStatus?.toLowerCase() ?? "not started"})` : undefined),
          prop("Tags", d.tags ? undefined : unread("tags", d.enrichment?.tags)),
        ),
      },
      endpoints.length ? { title: "Endpoints", table: { columns: ["Endpoint", "Host"], rows: endpoints } } : { title: "Endpoints", note: "No endpoint yet." },
      {
        title: "Nodes and storage",
        rows: props(
          prop("Data nodes", c?.InstanceType ? `${c.InstanceCount ?? 1} × ${c.InstanceType}` : undefined),
          prop("Dedicated masters", c?.DedicatedMasterEnabled ? `${c.DedicatedMasterCount ?? "?"} × ${c.DedicatedMasterType ?? "?"}` : "none"),
          prop("UltraWarm", c?.WarmEnabled ? `${c.WarmCount ?? "?"} × ${c.WarmType ?? "?"}` : undefined),
          prop("Zone awareness", c?.MultiAZWithStandbyEnabled ? "Multi-AZ with standby" : c?.ZoneAwarenessEnabled ? "on" : "off"), prop("Storage", storageText(d)),
          prop("IOPS", d.EBSOptions?.Iops), prop("Throughput", d.EBSOptions?.Throughput === undefined ? undefined : `${d.EBSOptions.Throughput} MiB/s`),
        ),
      },
      {
        title: "Network and security",
        rows: props(
          prop("Network", isPublic(d) ? "public endpoint (no VPC)" : "VPC"), prop("VPC", d.VPCOptions?.VPCId, true), prop("Subnets", d.VPCOptions?.SubnetIds?.join(", "), true),
          prop("Security groups", d.VPCOptions?.SecurityGroupIds?.join(", "), true), prop("Encryption", encryptionText(d)), prop("TLS policy", d.DomainEndpointOptions?.TLSSecurityPolicy),
          prop("Fine-grained access control", d.AdvancedSecurityOptions?.Enabled === undefined ? undefined : d.AdvancedSecurityOptions.Enabled ? "on" : "off"),
          prop("Internal user database", d.AdvancedSecurityOptions?.InternalUserDatabaseEnabled ? "on" : undefined),
          prop("Anonymous access", d.AdvancedSecurityOptions?.AnonymousAuthEnabled ? "on" : undefined),
        ),
      },
      logs.length
        ? { title: "Log publishing", table: { columns: ["Logs", "Log group", "Enabled"], rows: logs.map(([type, l]) => [Object.hasOwn(LOG_NAMES, type) ? LOG_NAMES[type] : type, l.CloudWatchLogsLogGroupArn ?? "—", l.Enabled === false ? "no" : "yes"]) } }
        : { title: "Log publishing", note: "No logs are published to CloudWatch." },
    ],
  };
}
