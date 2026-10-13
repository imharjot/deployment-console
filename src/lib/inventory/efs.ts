// EFS file systems as the cloud map sees them, pure: SDK-shaped DescribeFileSystems, DescribeMountTargets (+ their
// security groups) and DescribeAccessPoints answers in, resources and their KMS links out (audit §6 A.2 #14). The
// provider (../server/providers/efs.ts) and its simulation feed the same functions. No AWS calls and no `server-only`,
// so node:test runs it (efs.test.ts).
// - Key: the file system's ARN (= arnOf.efs, which the ECS side's "mounts" links name). Access points are not nodes:
//   their ARNs and ids are aliases of their file system, so references to an access point land on it.
// - Endpoints: "<fs>.efs.<region>.amazonaws.com", the per-AZ names "<az>.<fs>.efs…" and the mount targets' addresses.
// - Network: the mount targets' VPC, subnets and security groups.
// - Health: 0 mount targets is a warning (nothing can mount it); creating / updating or a mount target that isn't
//   available is a warning; deleting is stopped; error is an error.
import { arnOf, partitionOf } from "./arn.ts";
import { kmsRef, prop, props } from "./compute-common.ts";
import { awsTime, encryptsLink, enrichmentOf, fmtBytes, fmtTime, plural, tagMap, unread } from "./serverless-common.ts";
import type { EnrichState, Health, Link, ProviderResult, Resource, ResourceDetail } from "./types.ts";

type When = Date | string | number;

export interface RawMountTarget {
  MountTargetId?: string;
  FileSystemId?: string;
  SubnetId?: string;
  VpcId?: string;
  LifeCycleState?: string; // creating | available | updating | deleting | deleted | error
  IpAddress?: string;
  Ipv6Address?: string;
  AvailabilityZoneName?: string;
  NetworkInterfaceId?: string;
  securityGroups?: string[]; // DescribeMountTargetSecurityGroups; undefined = not read
}

export interface RawAccessPoint {
  AccessPointId?: string;
  AccessPointArn?: string;
  FileSystemId?: string;
  Name?: string;
  LifeCycleState?: string;
  RootDirectory?: { Path?: string };
  PosixUser?: { Uid?: number; Gid?: number };
  Tags?: { Key?: string; Value?: string }[];
}

// DescribeFileSystems' FileSystemDescription, plus its mount targets (undefined = not read; see enrichment).
export interface RawFileSystem {
  FileSystemId?: string;
  FileSystemArn?: string;
  Name?: string;
  CreationTime?: When;
  LifeCycleState?: string;
  NumberOfMountTargets?: number;
  SizeInBytes?: { Value?: number; ValueInIA?: number; ValueInStandard?: number; ValueInArchive?: number };
  PerformanceMode?: string; // generalPurpose | maxIO
  ThroughputMode?: string; // bursting | provisioned | elastic
  ProvisionedThroughputInMibps?: number;
  Encrypted?: boolean;
  KmsKeyId?: string;
  AvailabilityZoneName?: string; // One Zone file systems only
  Tags?: { Key?: string; Value?: string }[];
  FileSystemProtection?: { ReplicationOverwriteProtection?: string };
  mountTargets?: RawMountTarget[];
  enrichment?: Record<string, EnrichState>;
}

export interface EfsOptions { region: string; account?: string; now?: number }

const ms = (t: When | undefined) => awsTime(t instanceof Date || typeof t === "number" || typeof t === "string" ? t : undefined);
const lower = (s: string | undefined) => String(s ?? "").toLowerCase();
const dnsSuffix = (region: string) => (partitionOf(region) === "aws-cn" ? "amazonaws.com.cn" : "amazonaws.com");

// "fs-0123.efs.us-east-1.amazonaws.com" — what mount commands and NFS clients name.
export const efsHost = (id: string, region: string) => `${id}.efs.${region}.${dnsSuffix(region)}`;

export function fileSystemHealth(f: Pick<RawFileSystem, "LifeCycleState" | "NumberOfMountTargets" | "mountTargets">): { health: Health; healthReason?: string } {
  const s = lower(f.LifeCycleState);
  if (s === "deleting") return { health: "stopped", healthReason: "deleting" };
  if (s === "error") return { health: "error", healthReason: "the file system is in an error state" };
  if (s === "creating" || s === "updating") return { health: "warning", healthReason: s };
  if (s !== "available") return { health: "unknown", healthReason: s ? `state ${s}` : "state not reported" };
  const n = f.mountTargets ? f.mountTargets.length : f.NumberOfMountTargets;
  if (n === 0) return { health: "warning", healthReason: "no mount targets — nothing can mount it" };
  const bad = (f.mountTargets ?? []).filter((m) => lower(m.LifeCycleState) !== "available");
  if (bad.length) return { health: "warning", healthReason: `${plural(bad.length, "mount target")} ${lower(bad[0].LifeCycleState) || "in an unknown state"} (${bad[0].AvailabilityZoneName ?? bad[0].SubnetId ?? bad[0].MountTargetId})` };
  return { health: "ok" };
}

function throughputText(f: RawFileSystem): string | undefined {
  if (!f.ThroughputMode) return undefined;
  return f.ThroughputMode === "provisioned" && f.ProvisionedThroughputInMibps ? `provisioned · ${f.ProvisionedThroughputInMibps} MiB/s` : f.ThroughputMode;
}
const encryptionText = (f: RawFileSystem) => (f.Encrypted === undefined ? undefined : f.Encrypted ? `KMS ${f.KmsKeyId ? f.KmsKeyId.replace(/^arn:aws[\w-]*:kms:[^:]+:\d+:/, "") : "(default key)"}` : "not encrypted");
const uniq = (a: (string | undefined)[]) => [...new Set(a.filter((x): x is string => !!x))];

export function fileSystemResource(f: RawFileSystem, aps: RawAccessPoint[], o: EfsOptions): { resource: Resource; links: Link[] } {
  const { region } = o;
  const id = f.FileSystemId!;
  const key = f.FileSystemArn || arnOf.efs(region, o.account ?? "", id);
  const tags = tagMap(f.Tags ?? []);
  const mts = f.mountTargets;
  const mine = aps.filter((a) => a.FileSystemId === id && lower(a.LifeCycleState) !== "deleted");
  const kms = f.Encrypted ? kmsRef(f.KmsKeyId, region, o.account) : undefined;
  const sgs = uniq((mts ?? []).flatMap((m) => m.securityGroups ?? []));
  const enrichment = enrichmentOf(f.enrichment);
  const n = mts ? mts.length : f.NumberOfMountTargets;
  const vpcId = mts?.find((m) => m.VpcId)?.VpcId;
  const resource: Resource = {
    key, kind: "efs-filesystem", provider: "efs", name: f.Name?.trim() || tags.Name?.trim() || id, region, tags, ...fileSystemHealth(f),
    props: props(
      prop("File system id", id, true), prop("Size", f.SizeInBytes?.Value === undefined ? undefined : fmtBytes(f.SizeInBytes.Value)),
      prop("Storage", f.AvailabilityZoneName ? `One Zone (${f.AvailabilityZoneName})` : "Regional"), prop("Performance mode", f.PerformanceMode), prop("Throughput", throughputText(f)),
      prop("Encryption", encryptionText(f)),
      prop("Mount targets", n === undefined ? undefined : mts?.length ? `${n} · ${uniq(mts.map((m) => m.AvailabilityZoneName)).join(", ")}` : String(n)),
      prop("Access points", mine.length ? mine.map((a) => a.Name || a.AccessPointId).join(", ") : undefined),
      prop("Mount with", efsHost(id, region), true),
      prop("Created", ms(f.CreationTime) ? fmtTime(ms(f.CreationTime)) : undefined),
    ),
    endpoints: uniq([efsHost(id, region), ...(mts ?? []).flatMap((m) => [m.AvailabilityZoneName ? `${m.AvailabilityZoneName}.${efsHost(id, region)}` : undefined, m.IpAddress, m.Ipv6Address])]),
    aliases: uniq([id, ...mine.flatMap((a) => [a.AccessPointArn, a.AccessPointId])]),
    ...(vpcId ? { vpcId } : {}),
    ...(mts?.length ? { subnetIds: uniq(mts.map((m) => m.SubnetId)) } : {}),
    ...(sgs.length ? { securityGroups: sgs } : {}),
    ...(enrichment ? { enrichment } : {}),
    consoleUrl: `https://${region}.console.aws.amazon.com/efs/home?region=${region}#/file-systems/${encodeURIComponent(id)}`,
    ...(ms(f.CreationTime) ? { createdAt: ms(f.CreationTime) } : {}), ...(o.now ? { observedAt: o.now } : {}),
  };
  return { resource, links: encryptsLink(kms, key, "at rest", "EFS file system encryption key (KmsKeyId)") };
}

export function efsResult(input: { fileSystems: RawFileSystem[]; accessPoints?: RawAccessPoint[] }, o: EfsOptions): ProviderResult {
  const out = input.fileSystems.filter((f) => f.FileSystemId && lower(f.LifeCycleState) !== "deleted").map((f) => fileSystemResource(f, input.accessPoints ?? [], o));
  return { resources: out.map((x) => x.resource), links: out.flatMap((x) => x.links), mentions: [] };
}

// The panel: the file system, its mount targets (one per AZ) and access points.
export function efsDetail(key: string, f: RawFileSystem | undefined, aps: RawAccessPoint[] | undefined, region: string): ResourceDetail {
  if (!f?.FileSystemId) return { key, sections: [{ title: "File system", note: "This file system no longer exists." }] };
  const id = f.FileSystemId;
  const size = f.SizeInBytes;
  const mts = f.mountTargets;
  const mine = (aps ?? []).filter((a) => a.FileSystemId === id);
  return {
    key,
    sections: [
      {
        title: "File system",
        rows: props(
          prop("State", f.LifeCycleState), prop("Mount with", efsHost(id, region), true), prop("Size", size?.Value === undefined ? undefined : fmtBytes(size.Value)),
          prop("Standard", size?.ValueInStandard === undefined ? undefined : fmtBytes(size.ValueInStandard)), prop("Infrequent Access", size?.ValueInIA ? fmtBytes(size.ValueInIA) : undefined),
          prop("Archive", size?.ValueInArchive ? fmtBytes(size.ValueInArchive) : undefined), prop("Performance mode", f.PerformanceMode), prop("Throughput", throughputText(f)),
          prop("Encryption", encryptionText(f)), prop("Replication overwrite protection", f.FileSystemProtection?.ReplicationOverwriteProtection?.toLowerCase()),
          prop("Created", ms(f.CreationTime) ? fmtTime(ms(f.CreationTime)) : undefined),
        ),
      },
      mts
        ? mts.length
          ? {
              title: "Mount targets",
              table: {
                columns: ["Mount target", "Availability zone", "Subnet", "Address", "State", "Security groups"],
                rows: mts.map((m) => [m.MountTargetId ?? "—", m.AvailabilityZoneName ?? "—", m.SubnetId ?? "—", m.IpAddress ?? m.Ipv6Address ?? "—", lower(m.LifeCycleState) || "—", m.securityGroups ? m.securityGroups.join(", ") || "none" : "not read"]),
              },
            }
          : { title: "Mount targets", note: "No mount targets: nothing in a VPC can mount this file system." }
        : { title: "Mount targets", note: unread("Mount targets", f.enrichment?.["mount targets"]) },
      aps
        ? mine.length
          ? {
              title: "Access points",
              table: {
                columns: ["Access point", "Name", "Root directory", "POSIX user", "State"],
                rows: mine.map((a) => [a.AccessPointId ?? "—", a.Name ?? "—", a.RootDirectory?.Path ?? "/", a.PosixUser ? `${a.PosixUser.Uid ?? "?"}:${a.PosixUser.Gid ?? "?"}` : "—", lower(a.LifeCycleState) || "—"]),
              },
            }
          : { title: "Access points", note: "No access points: clients mount the file system's root." }
        : { title: "Access points", note: "Access points not read." },
    ],
  };
}
