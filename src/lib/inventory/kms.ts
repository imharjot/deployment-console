// KMS keys, pure part: ListKeys + ListAliases + DescribeKey (+ rotation and tags for customer keys), real or simulated,
// → Resources (audit §6 A.2 #5). KMS stores no relationship of its own worth drawing: what a key encrypts comes from the
// providers that use it (their `encrypts` links name a key ARN, an alias ARN or the default "alias/aws/<service>"), so
// every key carries its id, alias names and alias ARNs as aliases (CC-19).
// - AWS-managed keys (KeyManager AWS, or an "alias/aws/…" alias when DescribeKey wasn't read) are hidden, resolvable.
// - Health from KeyState: Enabled ok; Disabled warning; PendingDeletion error "scheduled for deletion on D";
//   PendingReplicaDeletion warning; Unavailable / PendingImport error. Facts: state, deletionDate (propagate R2 warns
//   what a disabled or dying key encrypts).
// - Tags are KMS-style ({TagKey, TagValue}); a key whose tags weren't read is tagsUnread (R01).
// No AWS calls and no `server-only`, so node:test runs it (kms.test.ts).
import { arnOf } from "./arn.ts";
import { awsTime, clip, enrichmentOf, fmtTime, props, tagsOf, unread } from "./serverless-common.ts";
import type { EnrichState, Facts, Health, ProviderResult, Resource, ResourceDetail } from "./types.ts";

// DescribeKey's KeyMetadata, the parts the map uses.
export interface KmsKeyMetadata {
  KeyId?: string;
  Arn?: string;
  KeyManager?: string; // "AWS" | "CUSTOMER"
  KeyState?: string; // "Enabled" | "Disabled" | "PendingDeletion" | "PendingImport" | "PendingReplicaDeletion" | "Unavailable" | "Creating" | "Updating"
  KeySpec?: string;
  KeyUsage?: string;
  Origin?: string;
  MultiRegion?: boolean;
  MultiRegionConfiguration?: { MultiRegionKeyType?: string; PrimaryKey?: { Arn?: string; Region?: string }; ReplicaKeys?: { Arn?: string; Region?: string }[] };
  DeletionDate?: Date | string;
  PendingDeletionWindowInDays?: number;
  Description?: string;
  CreationDate?: Date | string;
  ValidTo?: Date | string;
}

export interface RawKmsKey {
  KeyId?: string;
  KeyArn?: string;
  aliases?: string[]; // alias names from ListAliases ("alias/acme-production")
  metadata?: KmsKeyMetadata; // DescribeKey; undefined = not read (see enrichment.describe)
  rotation?: { KeyRotationEnabled?: boolean; RotationPeriodInDays?: number; NextRotationDate?: Date | string };
  tags?: { TagKey?: string; TagValue?: string }[]; // ListResourceTags; undefined = not read (tagsUnread)
  enrichment?: Record<string, EnrichState>; // describe, rotation, tags
}

// ListAliases entries → alias names per key id. Aliases without a TargetKeyId (AWS-managed keys not created yet) are
// skipped.
export function aliasesByKey(aliases: { AliasName?: string; TargetKeyId?: string }[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const a of aliases) {
    if (!a.AliasName || !a.TargetKeyId) continue;
    const l = out.get(a.TargetKeyId) ?? [];
    l.push(a.AliasName);
    out.set(a.TargetKeyId, l);
  }
  return out;
}

export const isAwsManaged = (k: Pick<RawKmsKey, "metadata" | "aliases">) =>
  k.metadata?.KeyManager ? k.metadata.KeyManager === "AWS" : (k.aliases ?? []).some((a) => a.startsWith("alias/aws/"));

// Rotation is only offered for customer-managed symmetric keys with key material from KMS.
export const rotationApplies = (k: Pick<RawKmsKey, "metadata">) =>
  k.metadata?.KeyManager === "CUSTOMER" && k.metadata.KeySpec === "SYMMETRIC_DEFAULT" && (k.metadata.Origin ?? "AWS_KMS") === "AWS_KMS" && /^(Enabled|Disabled)$/.test(k.metadata.KeyState ?? "");

const kmsTags = (tags: RawKmsKey["tags"]) => (tags ? Object.fromEntries(tags.filter((x) => x.TagKey).map((x) => [x.TagKey!, x.TagValue ?? ""])) : undefined);
const iso = (ms: number | undefined) => (ms === undefined ? undefined : new Date(ms).toISOString());
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

function healthOf(k: RawKmsKey): { health: Health; reason?: string } {
  const state = k.metadata?.KeyState;
  if (!state) return { health: "unknown", reason: unread("key state", k.enrichment?.describe) };
  const deletion = awsTime(k.metadata?.DeletionDate);
  switch (state) {
    case "Enabled":
      return { health: "ok" };
    case "Disabled":
      return { health: "warning", reason: "disabled — anything it encrypts can't be decrypted" };
    case "PendingDeletion":
      return { health: "error", reason: `scheduled for deletion${deletion !== undefined ? ` on ${day(deletion)}` : ""}` };
    case "PendingReplicaDeletion":
      return { health: "warning", reason: "replica scheduled for deletion" };
    case "Unavailable":
      return { health: "error", reason: "unavailable (its custom key store is disconnected)" };
    case "PendingImport":
      return { health: "error", reason: "waiting for imported key material" };
    case "Creating":
    case "Updating":
      return { health: "ok" };
    default:
      return { health: "unknown", reason: `state ${state}` };
  }
}

export function kmsConsoleUrl(region: string, keyId: string, awsManaged: boolean) {
  return `https://${region}.console.aws.amazon.com/kms/home?region=${region}#/kms/${awsManaged ? "defaultKeys" : "keys"}/${encodeURIComponent(keyId)}`;
}

function rotationText(k: RawKmsKey): string | undefined {
  if (!rotationApplies(k)) return undefined;
  if (!k.rotation) return unread("rotation", k.enrichment?.rotation);
  if (!k.rotation.KeyRotationEnabled) return "off";
  const next = awsTime(k.rotation.NextRotationDate);
  return `every ${k.rotation.RotationPeriodInDays ?? 365} days${next !== undefined ? ` (next ${day(next)})` : ""}`;
}

function multiRegionText(m: KmsKeyMetadata | undefined): string | undefined {
  if (!m?.MultiRegion) return undefined;
  const c = m.MultiRegionConfiguration;
  if (c?.MultiRegionKeyType === "REPLICA") return `replica of the primary in ${c.PrimaryKey?.Region ?? "another region"}`;
  const replicas = (c?.ReplicaKeys ?? []).map((r) => r.Region).filter(Boolean);
  return `primary${replicas.length ? `, replicas in ${replicas.join(", ")}` : ""}`;
}

export function kmsResult(keys: RawKmsKey[], o: { region: string; account?: string }): ProviderResult {
  const resources: Resource[] = [];
  for (const k of keys) {
    const id = k.KeyId ?? k.metadata?.KeyId;
    if (!id) continue;
    const key = k.KeyArn ?? k.metadata?.Arn ?? (o.account ? arnOf.kmsKey(o.region, o.account, id) : undefined);
    if (!key) continue;
    const region = key.split(":")[3] || o.region;
    const account = key.split(":")[4] || o.account;
    const aliases = [...(k.aliases ?? [])].sort((a, b) => Number(a.startsWith("alias/aws/")) - Number(b.startsWith("alias/aws/")) || a.localeCompare(b));
    const managed = isAwsManaged(k);
    const { health, reason } = healthOf(k);
    const m = k.metadata;
    const deletion = awsTime(m?.DeletionDate);
    const facts: Facts = {};
    if (m?.KeyState) facts.state = m.KeyState;
    if (deletion !== undefined) facts.deletionDate = iso(deletion)!;
    const enrichment = enrichmentOf(k.enrichment);
    resources.push({
      key,
      kind: "kms-key",
      provider: "kms",
      name: aliases[0]?.replace(/^alias\//, "") ?? id,
      region,
      ...tagsOf(kmsTags(k.tags)),
      health,
      ...(reason ? { healthReason: reason } : {}),
      ...(managed ? { hidden: true } : {}),
      ...(Object.keys(facts).length ? { facts } : {}),
      ...(enrichment ? { enrichment } : {}),
      props: props([
        { label: "Aliases", value: aliases.length ? clip(aliases.join(", "), 160) : undefined },
        { label: "Managed by", value: managed ? "AWS" : m?.KeyManager === "CUSTOMER" ? "Customer" : undefined },
        { label: "Key spec", value: m?.KeySpec ? `${m.KeySpec}${m.KeyUsage ? ` · ${m.KeyUsage}` : ""}` : undefined },
        { label: "Origin", value: m?.Origin && m.Origin !== "AWS_KMS" ? m.Origin : undefined },
        { label: "Multi-Region", value: multiRegionText(m) },
        { label: "Rotation", value: rotationText(k) },
        { label: "State", value: m?.KeyState && m.KeyState !== "Enabled" ? m.KeyState : undefined },
        { label: "Deletion date", value: deletion !== undefined ? fmtTime(deletion) : undefined },
        { label: "Description", value: m?.Description ? clip(m.Description, 200) : undefined },
        { label: "Key id", value: id, mono: true },
        { label: "Created", value: m?.CreationDate ? fmtTime(awsTime(m.CreationDate)) : undefined },
      ]),
      aliases: [...new Set([id, ...aliases, ...(account ? aliases.map((a) => arnOf.kmsAlias(region, account, a)) : [])])],
      consoleUrl: kmsConsoleUrl(region, id, managed),
      ...(m?.CreationDate ? { createdAt: awsTime(m.CreationDate) } : {}),
    });
  }
  return { resources, links: [], mentions: [] };
}

// The panel: the key's metadata, rotation and tags as read for it (live, or simulated).
export function kmsDetail(key: string, k: RawKmsKey | undefined): ResourceDetail {
  if (!k?.metadata) return { key, sections: [{ title: "Key", note: "The key's details couldn't be read (its key policy may not allow the console's role)." }] };
  const m = k.metadata;
  const tags = Object.entries(kmsTags(k.tags) ?? {});
  return {
    key,
    sections: [
      {
        title: "Key",
        rows: props([
          { label: "State", value: m.KeyState },
          { label: "Managed by", value: m.KeyManager === "AWS" ? "AWS" : "Customer" },
          { label: "Key spec", value: m.KeySpec },
          { label: "Usage", value: m.KeyUsage },
          { label: "Origin", value: m.Origin },
          { label: "Multi-Region", value: multiRegionText(m) ?? "no" },
          { label: "Rotation", value: rotationText(k) },
          { label: "Deletion date", value: m.DeletionDate ? fmtTime(awsTime(m.DeletionDate)) : undefined },
          { label: "Key material expires", value: m.ValidTo ? fmtTime(awsTime(m.ValidTo)) : undefined },
          { label: "Aliases", value: (k.aliases ?? []).join(", ") || "none" },
          { label: "Description", value: m.Description },
          { label: "Created", value: m.CreationDate ? fmtTime(awsTime(m.CreationDate)) : undefined },
        ]),
        note: "What the key encrypts is drawn from the resources that name it.",
      },
      ...(tags.length ? [{ title: "Tags", table: { columns: ["Key", "Value"], rows: tags.map(([a, b]) => [a, b]) } }] : []),
    ],
  };
}
