// Redshift as the cloud map sees it, pure: provisioned clusters (DescribeClusters) and Redshift Serverless workgroups
// (ListWorkgroups) joined with their namespaces (ListNamespaces), SDK-shaped answers in, resources and links out
// (audit §6 A.2 P2 redshift). The provider (../server/providers/redshift.ts) and its simulation feed the same
// functions. No AWS calls and no `server-only`, so node:test runs it (redshift.test.ts).
// - Keys: the cluster's ARN (arnOf.redshiftCluster) and the workgroup's ARN (arnOf.redshiftWorkgroup, by id).
//   Namespaces are not nodes: their encryption key, roles and log exports belong to the workgroup that serves them.
// - facts.public from PubliclyAccessible / publiclyAccessible.
// - Links: KMS → cluster or workgroup (encrypts); → IAM roles (assumes); → the managed admin password secret (reads);
//   certificate → custom domain (tls).
// - Health: available ok; paused stopped; resizing, modifying and other transitions warning; hardware-failure,
//   incompatible-* and storage-full error. Workgroups: AVAILABLE ok, CREATING / MODIFYING warning, DELETING stopped.
// Usernames are never copied (redshift.test.ts sentinel); workgroups' tags aren't read (tagsUnread, R01).
import { arnOf } from "./arn.ts";
import { kmsRef, prop, props } from "./compute-common.ts";
import { assumesLink, awsTime, encryptsLink, enrichmentOf, fmtTime, plural, tagMap, unread } from "./serverless-common.ts";
import type { EnrichState, Health, Link, ProviderResult, Resource, ResourceDetail } from "./types.ts";

type When = Date | string | number;

export interface RawRedshiftCluster {
  ClusterIdentifier?: string;
  ClusterNamespaceArn?: string;
  NodeType?: string;
  NumberOfNodes?: number;
  ClusterStatus?: string;
  ClusterAvailabilityStatus?: string; // Available | Unavailable | Maintenance | Modifying | Failed
  ModifyStatus?: string;
  DBName?: string;
  Endpoint?: { Address?: string; Port?: number; VpcEndpoints?: { VpcEndpointId?: string; VpcId?: string }[] };
  ClusterCreateTime?: When;
  AutomatedSnapshotRetentionPeriod?: number;
  VpcSecurityGroups?: { VpcSecurityGroupId?: string; Status?: string }[];
  ClusterSubnetGroupName?: string;
  VpcId?: string;
  AvailabilityZone?: string;
  PreferredMaintenanceWindow?: string;
  ClusterVersion?: string;
  PubliclyAccessible?: boolean;
  Encrypted?: boolean;
  KmsKeyId?: string;
  EnhancedVpcRouting?: boolean;
  MultiAZ?: string; // "Enabled" | "Disabled"
  Tags?: { Key?: string; Value?: string }[];
  IamRoles?: { IamRoleArn?: string; ApplyStatus?: string }[];
  DefaultIamRoleArn?: string;
  CustomDomainName?: string;
  CustomDomainCertificateArn?: string;
  MasterPasswordSecretArn?: string;
  TotalStorageCapacityInMegaBytes?: number;
  PendingActions?: string[];
}

export interface RawWorkgroup {
  workgroupId?: string;
  workgroupArn?: string;
  workgroupName?: string;
  namespaceName?: string;
  baseCapacity?: number; // RPUs
  maxCapacity?: number;
  enhancedVpcRouting?: boolean;
  securityGroupIds?: string[];
  subnetIds?: string[];
  status?: string; // CREATING | AVAILABLE | MODIFYING | DELETING
  endpoint?: { address?: string; port?: number; vpcEndpoints?: { vpcEndpointId?: string; vpcId?: string }[] };
  publiclyAccessible?: boolean;
  creationDate?: When;
  customDomainName?: string;
  customDomainCertificateArn?: string;
  workgroupVersion?: string;
}

export interface RawNamespace {
  namespaceArn?: string;
  namespaceId?: string;
  namespaceName?: string;
  dbName?: string;
  kmsKeyId?: string; // a key ARN / id, or "AWS_OWNED_KMS_KEY"
  defaultIamRoleArn?: string;
  iamRoles?: string[]; // "IamRole(applyStatus=in-sync, iamRoleArn=arn:…)" or a bare ARN
  logExports?: string[];
  status?: string;
  creationDate?: When;
  adminPasswordSecretArn?: string;
}

export interface RedshiftInput {
  clusters: RawRedshiftCluster[];
  workgroups?: RawWorkgroup[]; // undefined = not read (Serverless denied or not offered here)
  namespaces?: RawNamespace[]; // undefined = not read (see namespacesState)
  namespacesState?: EnrichState;
}

export interface RedshiftOptions { region: string; account?: string; now?: number }

const ms = (t: When | undefined) => awsTime(t instanceof Date || typeof t === "number" || typeof t === "string" ? t : undefined);
const lower = (s: string | undefined) => String(s ?? "").toLowerCase();
const uniq = (a: (string | undefined)[]) => [...new Set(a.filter((x): x is string => !!x))];
const shortKms = (k: string) => k.replace(/^arn:aws[\w-]*:kms:[^:]+:\d+:/, "");

const BUSY = new Set(["resizing", "modifying", "creating", "rebooting", "renaming", "resuming", "pausing", "cancelling-resize", "final-snapshot", "updating-hsm", "rotating-keys", "prep-for-resize", "available, prep-for-resize", "available, resize-cleanup"]);
export function clusterHealth(c: Pick<RawRedshiftCluster, "ClusterStatus" | "ClusterAvailabilityStatus">): { health: Health; healthReason?: string } {
  const s = lower(c.ClusterStatus);
  const a = lower(c.ClusterAvailabilityStatus);
  if (s === "paused") return { health: "stopped", healthReason: "paused — compute isn't billed, storage is" };
  if (s === "deleting") return { health: "stopped", healthReason: "deleting" };
  if (s === "hardware-failure" || s === "storage-full" || s.startsWith("incompatible-")) return { health: "error", healthReason: s };
  if (a === "failed") return { health: "error", healthReason: "the cluster failed" };
  if (BUSY.has(s)) return { health: "warning", healthReason: s };
  if (s === "available") return a === "unavailable" ? { health: "warning", healthReason: "not accepting connections (unavailable)" } : a === "maintenance" ? { health: "ok", healthReason: "maintenance" } : { health: "ok" };
  return { health: "unknown", healthReason: s ? `status ${s}` : "status not reported" };
}

export function workgroupHealth(w: Pick<RawWorkgroup, "status">): { health: Health; healthReason?: string } {
  const s = String(w.status ?? "").toUpperCase();
  if (s === "AVAILABLE") return { health: "ok" };
  if (s === "CREATING" || s === "MODIFYING") return { health: "warning", healthReason: s.toLowerCase() };
  if (s === "DELETING") return { health: "stopped", healthReason: "deleting" };
  return { health: "unknown", healthReason: s ? `status ${s.toLowerCase()}` : "status not reported" };
}

// ListNamespaces writes roles as "IamRole(applyStatus=in-sync, iamRoleArn=arn:aws:iam::…:role/x)".
export const namespaceRoles = (n: RawNamespace | undefined) =>
  uniq([...(n?.iamRoles ?? []).map((r) => /arn:aws[\w-]*:iam::\d{12}:role\/[^\s,)]+/.exec(r)?.[0]), n?.defaultIamRoleArn]);
const customerKey = (k: string | undefined) => (k && k !== "AWS_OWNED_KMS_KEY" ? k : undefined);

const tlsLink = (cert: string | undefined, host: string | undefined, to: string): Link[] => (cert && host ? [{ from: cert, to, kind: "tls", label: host, evidence: "custom domain certificate" }] : []);
const secretLink = (from: string, secret: string | undefined): Link[] => (secret ? [{ from, to: secret, kind: "reads", label: "admin password (managed by Redshift)", evidence: "managed admin password secret" }] : []);

export function clusterResource(c: RawRedshiftCluster, o: RedshiftOptions): { resource: Resource; links: Link[] } {
  const { region } = o;
  const id = c.ClusterIdentifier!;
  const key = arnOf.redshiftCluster(region, o.account ?? "", id);
  const sgs = uniq((c.VpcSecurityGroups ?? []).map((g) => g.VpcSecurityGroupId));
  const resource: Resource = {
    key, kind: "redshift-cluster", provider: "redshift", name: id, region, tags: tagMap(c.Tags ?? []), ...clusterHealth(c),
    props: props(
      prop("Engine", `redshift${c.ClusterVersion ? ` ${c.ClusterVersion}` : ""}`), prop("Nodes", c.NodeType ? `${c.NumberOfNodes ?? 1} × ${c.NodeType}` : undefined), prop("Database", c.DBName),
      prop("Endpoint", c.Endpoint?.Address, true), prop("Port", c.Endpoint?.Port), prop("Custom domain", c.CustomDomainName, true),
      prop("Publicly accessible", c.PubliclyAccessible === undefined ? undefined : c.PubliclyAccessible ? "yes" : "no"),
      prop("Encryption", c.Encrypted === undefined ? undefined : c.Encrypted ? `KMS ${c.KmsKeyId ? shortKms(c.KmsKeyId) : "(default key)"}` : "not encrypted"),
      prop("Snapshots", c.AutomatedSnapshotRetentionPeriod === undefined ? undefined : c.AutomatedSnapshotRetentionPeriod ? `automated, ${plural(c.AutomatedSnapshotRetentionPeriod, "day")}` : "no automated snapshots"),
      prop("Multi-AZ", c.MultiAZ ? lower(c.MultiAZ) : undefined), prop("Subnet group", c.ClusterSubnetGroupName),
      prop("Created", ms(c.ClusterCreateTime) ? fmtTime(ms(c.ClusterCreateTime)) : undefined),
    ),
    endpoints: uniq([c.Endpoint?.Address, c.CustomDomainName]), aliases: [id],
    ...(c.VpcId ? { vpcId: c.VpcId } : {}), ...(sgs.length ? { securityGroups: sgs } : {}),
    ...(c.PubliclyAccessible !== undefined ? { facts: { public: c.PubliclyAccessible } } : {}),
    consoleUrl: `https://${region}.console.aws.amazon.com/redshiftv2/home?region=${region}#cluster-details?cluster=${encodeURIComponent(id)}`,
    ...(ms(c.ClusterCreateTime) ? { createdAt: ms(c.ClusterCreateTime) } : {}), ...(o.now ? { observedAt: o.now } : {}),
  };
  const kms = c.Encrypted ? kmsRef(customerKey(c.KmsKeyId), region, o.account) : undefined;
  const links: Link[] = [
    ...encryptsLink(kms, key, "at rest", "cluster encryption key (KmsKeyId)"),
    ...uniq([...(c.IamRoles ?? []).map((r) => r.IamRoleArn), c.DefaultIamRoleArn]).flatMap((r) => assumesLink(key, r, "COPY / UNLOAD / Spectrum", "Cluster.IamRoles")),
    ...secretLink(key, c.MasterPasswordSecretArn), ...tlsLink(c.CustomDomainCertificateArn, c.CustomDomainName, key),
  ];
  return { resource, links };
}

export function workgroupResource(w: RawWorkgroup, ns: RawNamespace | undefined, nsState: EnrichState | undefined, o: RedshiftOptions): { resource: Resource; links: Link[] } {
  const { region } = o;
  const name = w.workgroupName!;
  const key = w.workgroupArn || arnOf.redshiftWorkgroup(region, o.account ?? "", w.workgroupId ?? name);
  const vpcId = w.endpoint?.vpcEndpoints?.find((e) => e.vpcId)?.vpcId;
  const kmsKey = customerKey(ns?.kmsKeyId);
  const state = ns ? undefined : w.namespaceName ? (nsState && nsState !== "ok" ? nsState : "error") : undefined;
  const enrichment = enrichmentOf({ namespace: state });
  const resource: Resource = {
    key, kind: "redshift-workgroup", provider: "redshift", name, region, tags: {}, tagsUnread: true, ...workgroupHealth(w),
    props: props(
      prop("Engine", "redshift serverless"), prop("Namespace", w.namespaceName ? `${w.namespaceName}${ns?.dbName ? ` · database ${ns.dbName}` : state ? ` (${unread("details", state)})` : ""}` : undefined),
      prop("Capacity", w.baseCapacity === undefined ? undefined : `${w.baseCapacity} RPU base${w.maxCapacity ? ` · up to ${w.maxCapacity} RPU` : ""}`),
      prop("Endpoint", w.endpoint?.address, true), prop("Port", w.endpoint?.port ?? undefined), prop("Custom domain", w.customDomainName, true),
      prop("Publicly accessible", w.publiclyAccessible === undefined ? undefined : w.publiclyAccessible ? "yes" : "no"),
      prop("Enhanced VPC routing", w.enhancedVpcRouting === undefined ? undefined : w.enhancedVpcRouting ? "on" : "off"),
      prop("Encryption", ns ? (kmsKey ? `KMS ${shortKms(kmsKey)}` : "AWS-owned key") : undefined), prop("Log exports", ns?.logExports?.length ? ns.logExports.join(", ") : undefined),
      prop("Created", ms(w.creationDate) ? fmtTime(ms(w.creationDate)) : undefined),
    ),
    endpoints: uniq([w.endpoint?.address, w.customDomainName]), aliases: uniq([name, w.workgroupId]),
    ...(vpcId ? { vpcId } : {}), ...(w.subnetIds?.length ? { subnetIds: [...w.subnetIds] } : {}), ...(w.securityGroupIds?.length ? { securityGroups: [...w.securityGroupIds] } : {}),
    ...(w.publiclyAccessible !== undefined ? { facts: { public: w.publiclyAccessible } } : {}),
    ...(enrichment ? { enrichment } : {}),
    consoleUrl: `https://${region}.console.aws.amazon.com/redshiftv2/home?region=${region}#serverless-workgroup?workgroup=${encodeURIComponent(name)}`,
    ...(ms(w.creationDate) ? { createdAt: ms(w.creationDate) } : {}), ...(o.now ? { observedAt: o.now } : {}),
  };
  const links: Link[] = [
    ...encryptsLink(kmsRef(kmsKey, region, o.account), key, "namespace data", "namespace encryption key (kmsKeyId)"),
    ...namespaceRoles(ns).flatMap((r) => assumesLink(key, r, "COPY / UNLOAD / Spectrum", "Namespace.iamRoles")),
    ...secretLink(key, ns?.adminPasswordSecretArn), ...tlsLink(w.customDomainCertificateArn, w.customDomainName, key),
  ];
  return { resource, links };
}

export function redshiftResult(input: RedshiftInput, o: RedshiftOptions): ProviderResult {
  const nsOf = (name: string | undefined) => input.namespaces?.find((n) => n.namespaceName === name);
  const out = [
    ...input.clusters.filter((c) => c.ClusterIdentifier).map((c) => clusterResource(c, o)),
    ...(input.workgroups ?? []).filter((w) => w.workgroupName).map((w) => workgroupResource(w, nsOf(w.namespaceName), input.namespacesState, o)),
  ];
  return { resources: out.map((x) => x.resource), links: out.flatMap((x) => x.links), mentions: [] };
}

// ---------- the panel ----------

export function clusterDetail(key: string, c: RawRedshiftCluster | undefined): ResourceDetail {
  if (!c?.ClusterIdentifier) return { key, sections: [{ title: "Cluster", note: "This cluster no longer exists." }] };
  const roles = c.IamRoles ?? [];
  return {
    key,
    sections: [
      {
        title: "Cluster",
        rows: props(
          prop("Status", c.ClusterStatus), prop("Availability", c.ClusterAvailabilityStatus), prop("Nodes", c.NodeType ? `${c.NumberOfNodes ?? 1} × ${c.NodeType}` : undefined),
          prop("Storage capacity", c.TotalStorageCapacityInMegaBytes ? `${Math.round(c.TotalStorageCapacityInMegaBytes / 1024).toLocaleString("en-US")} GiB` : undefined),
          prop("Version", c.ClusterVersion), prop("Database", c.DBName), prop("Endpoint", c.Endpoint?.Address ? `${c.Endpoint.Address}:${c.Endpoint.Port ?? ""}` : undefined, true),
          prop("Pending", c.PendingActions?.length ? c.PendingActions.join(", ") : undefined), prop("Created", ms(c.ClusterCreateTime) ? fmtTime(ms(c.ClusterCreateTime)) : undefined),
        ),
      },
      {
        title: "Network and security",
        rows: props(
          prop("VPC", c.VpcId, true), prop("Subnet group", c.ClusterSubnetGroupName), prop("Availability zone", c.AvailabilityZone),
          prop("Security groups", (c.VpcSecurityGroups ?? []).map((g) => g.VpcSecurityGroupId).filter(Boolean).join(", "), true),
          prop("Publicly accessible", c.PubliclyAccessible === undefined ? undefined : c.PubliclyAccessible ? "yes" : "no"),
          prop("Enhanced VPC routing", c.EnhancedVpcRouting === undefined ? undefined : c.EnhancedVpcRouting ? "on" : "off"),
          prop("Encryption", c.Encrypted === undefined ? undefined : c.Encrypted ? `KMS ${c.KmsKeyId ?? "(default key)"}` : "not encrypted", true),
          prop("Admin password", c.MasterPasswordSecretArn ? "managed in Secrets Manager" : undefined),
          prop("Maintenance window", c.PreferredMaintenanceWindow),
          prop("Automated snapshots", c.AutomatedSnapshotRetentionPeriod === undefined ? undefined : plural(c.AutomatedSnapshotRetentionPeriod, "day")),
        ),
      },
      roles.length
        ? { title: "IAM roles", table: { columns: ["Role", "Status", "Default"], rows: roles.map((r) => [r.IamRoleArn ?? "—", r.ApplyStatus ?? "—", r.IamRoleArn && r.IamRoleArn === c.DefaultIamRoleArn ? "yes" : ""]) } }
        : { title: "IAM roles", note: "No IAM roles: COPY, UNLOAD and Spectrum can't reach other AWS services." },
    ],
  };
}

export function workgroupDetail(key: string, w: RawWorkgroup | undefined, ns: RawNamespace | undefined): ResourceDetail {
  if (!w?.workgroupName) return { key, sections: [{ title: "Workgroup", note: "This workgroup no longer exists." }] };
  const roles = namespaceRoles(ns);
  return {
    key,
    sections: [
      {
        title: "Workgroup",
        rows: props(
          prop("Status", w.status), prop("Capacity", w.baseCapacity === undefined ? undefined : `${w.baseCapacity} RPU base${w.maxCapacity ? ` · up to ${w.maxCapacity} RPU` : ""}`),
          prop("Endpoint", w.endpoint?.address ? `${w.endpoint.address}:${w.endpoint.port ?? ""}` : undefined, true), prop("Version", w.workgroupVersion),
          prop("Subnets", w.subnetIds?.join(", "), true), prop("Security groups", w.securityGroupIds?.join(", "), true),
          prop("Publicly accessible", w.publiclyAccessible === undefined ? undefined : w.publiclyAccessible ? "yes" : "no"),
          prop("Created", ms(w.creationDate) ? fmtTime(ms(w.creationDate)) : undefined),
        ),
      },
      ns
        ? {
            title: `Namespace ${ns.namespaceName ?? ""}`.trim(),
            rows: props(
              prop("Status", ns.status), prop("Database", ns.dbName), prop("Encryption", customerKey(ns.kmsKeyId) ? `KMS ${ns.kmsKeyId}` : "AWS-owned key", !!customerKey(ns.kmsKeyId)),
              prop("IAM roles", roles.join(", "), true), prop("Log exports", ns.logExports?.join(", ")), prop("Admin password", ns.adminPasswordSecretArn ? "managed in Secrets Manager" : undefined),
              prop("Created", ms(ns.creationDate) ? fmtTime(ms(ns.creationDate)) : undefined),
            ),
          }
        : { title: "Namespace", note: w.namespaceName ? `Namespace ${w.namespaceName} not read.` : "No namespace." },
    ],
  };
}
