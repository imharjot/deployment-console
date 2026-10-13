// EBS volumes as the cloud map sees them, pure: SDK-shaped DescribeVolumes answers in, resources and their KMS links
// out. A volume belongs to the instance it is attached to (parent = the instance's region-aware key, so it folds into
// it on the map); an unattached one is a warning — it is billed per GB whether anything uses it or not. The provider
// (../server/providers/ebs.ts) and its simulation feed the same function. No AWS calls. (Audit §6 A.2 P2 ebs.)
import { arnOf } from "./arn.ts";
import { kmsRef, prop, props } from "./compute-common.ts";
import { tagMap } from "./serverless-common.ts";
import { keys, type Health, type Link, type ProviderResult, type Resource } from "./types.ts";

type When = Date | string | number;
export interface RawVolume {
  VolumeId?: string;
  Size?: number; // GiB
  VolumeType?: string;
  Iops?: number;
  Throughput?: number; // MiB/s
  AvailabilityZone?: string;
  State?: string; // creating | available | in-use | deleting | deleted | error
  CreateTime?: When;
  Encrypted?: boolean;
  KmsKeyId?: string;
  SnapshotId?: string;
  MultiAttachEnabled?: boolean;
  Attachments?: { InstanceId?: string; Device?: string; State?: string; DeleteOnTermination?: boolean }[];
  Operator?: { Managed?: boolean; Principal?: string; HiddenByDefault?: boolean };
  Tags?: { Key?: string; Value?: string }[];
}
export interface EbsOptions { region: string; accountId?: string; home?: string; now?: number }

const ms = (t: When | undefined) => (t === undefined ? undefined : typeof t === "number" ? t : Number.isFinite(new Date(t).getTime()) ? new Date(t).getTime() : undefined);

export function volumeHealth(v: Pick<RawVolume, "State" | "Attachments">): { health: Health; healthReason?: string } {
  const s = String(v.State ?? "").toLowerCase();
  if (s === "in-use") {
    const moving = (v.Attachments ?? []).find((a) => ["attaching", "detaching", "busy"].includes(String(a.State ?? "").toLowerCase()));
    return moving ? { health: "warning", healthReason: `${String(moving.State).toLowerCase()} ${moving.InstanceId ?? ""}`.trim() } : { health: "ok" };
  }
  if (s === "available") return { health: "warning", healthReason: "unattached — billed per GB" };
  if (s === "creating") return { health: "warning", healthReason: "creating" };
  if (s === "deleting") return { health: "stopped", healthReason: "deleting" };
  if (s === "error") return { health: "error", healthReason: "the volume is in an error state" };
  return { health: "unknown", ...(s ? { healthReason: s } : {}) };
}

export function volumeResource(v: RawVolume, o: EbsOptions): { resource: Resource; links: Link[] } {
  const { region } = o;
  const id = v.VolumeId!;
  const key = arnOf.ebsVolume(region, o.accountId ?? "", id);
  const tags = tagMap(v.Tags ?? []);
  const attached = (v.Attachments ?? []).filter((a) => a.InstanceId && String(a.State ?? "").toLowerCase() !== "detached");
  const kms = v.Encrypted ? kmsRef(v.KmsKeyId, region, o.accountId) : undefined;
  const resource: Resource = {
    key, kind: "ebs-volume", provider: "ebs", name: tags.Name?.trim() || id, region, tags, ...volumeHealth(v),
    props: props(
      prop("Volume id", id, true), prop("Type", v.VolumeType), prop("Size", typeof v.Size === "number" ? `${v.Size.toLocaleString("en-US")} GiB` : undefined),
      prop("IOPS", v.Iops), prop("Throughput", typeof v.Throughput === "number" ? `${v.Throughput} MiB/s` : undefined), prop("Availability zone", v.AvailabilityZone),
      prop("Attached to", attached.map((a) => `${a.InstanceId}${a.Device ? ` as ${a.Device}` : ""}${a.DeleteOnTermination ? " (deleted with it)" : ""}`).join(", ") || "nothing"),
      prop("Encryption", v.Encrypted ? `KMS ${v.KmsKeyId ?? "(default key)"}` : "not encrypted", !!v.Encrypted),
      prop("From snapshot", v.SnapshotId, true), v.MultiAttachEnabled ? prop("Multi-attach", "on") : undefined,
      v.Operator?.Managed ? prop("Managed by", v.Operator.Principal ?? "an AWS service") : undefined,
    ),
    aliases: [id], ...(attached[0]?.InstanceId ? { parent: keys.ec2(attached[0].InstanceId, region, o.home ?? region) } : {}),
    ...(v.Operator?.Managed && v.Operator.HiddenByDefault ? { hidden: true } : {}),
    consoleUrl: `https://${region}.console.aws.amazon.com/ec2/home?region=${region}#VolumeDetails:volumeId=${encodeURIComponent(id)}`,
    ...(ms(v.CreateTime) ? { createdAt: ms(v.CreateTime) } : {}), ...(o.now ? { observedAt: o.now } : {}),
  };
  const links: Link[] = kms ? [{ from: kms, to: key, kind: "encrypts", label: "at rest", evidence: "EBS volume encryption key (KmsKeyId)" }] : [];
  return { resource, links };
}

export function ebsResults(volumes: RawVolume[], o: EbsOptions): ProviderResult {
  const out = volumes.filter((v) => v.VolumeId && String(v.State ?? "").toLowerCase() !== "deleted").map((v) => volumeResource(v, o));
  return { resources: out.map((x) => x.resource), links: out.flatMap((x) => x.links), mentions: [] };
}
