// Secrets Manager, pure part: ListSecrets entries (real or simulated) → Resources and links (audit §6 A.2 #7).
// Metadata only: the provider never calls GetSecretValue or BatchGetSecretValue, and this mapper copies named metadata
// fields only, so even a value that slipped into the raw entry could not reach the map (secrets.test.ts sentinel).
// - Key: the ARN with its random suffix. Aliases: the name, and the partial ARN computed from the name — never by
//   stripping "-xxxxxx" with a regex, because names may legally end like that ("api-key123").
// - Links: secret → its rotation Lambda (invoke); KMS → secret (encrypts), via the key ARN / alias or the default
//   AWS-managed "alias/aws/secretsmanager" of the secret's region.
// - Health: scheduled for deletion error (facts.state PendingDeletion: propagate R5 warns what reads it); rotation
//   overdue by more than a day warning. lastActivityAt = LastAccessedDate (day precision).
// No AWS calls and no `server-only`, so node:test runs it (secrets.test.ts).
import { arnOf } from "./arn.ts";
import { awsTime, clip, encryptsLink, fmtCount, fmtTime, kmsKeyRef, parseArn, plural, props, tagsOf } from "./serverless-common.ts";
import type { Facts, Health, Link, ProviderResult, Resource, ResourceDetail } from "./types.ts";

const DAY = 86_400_000;

// ListSecrets' SecretListEntry, the metadata the map uses (no value field exists in it).
export interface RawSecret {
  ARN?: string;
  Name?: string;
  Description?: string;
  KmsKeyId?: string;
  RotationEnabled?: boolean;
  RotationLambdaARN?: string;
  RotationRules?: { AutomaticallyAfterDays?: number; ScheduleExpression?: string; Duration?: string };
  LastRotatedDate?: Date | string;
  LastChangedDate?: Date | string;
  LastAccessedDate?: Date | string;
  DeletedDate?: Date | string; // when deletion was requested (the secret is gone 7–30 days later)
  NextRotationDate?: Date | string;
  CreatedDate?: Date | string;
  OwningService?: string;
  PrimaryRegion?: string;
  Tags?: { Key?: string; Value?: string }[];
  SecretVersionsToStages?: Record<string, string[]>;
}

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

// When rotation is due: NextRotationDate, else the last rotation plus the schedule's days.
function rotationDue(s: RawSecret): number | undefined {
  const next = awsTime(s.NextRotationDate);
  if (next !== undefined) return next;
  const last = awsTime(s.LastRotatedDate);
  const every = s.RotationRules?.AutomaticallyAfterDays;
  return last !== undefined && every ? last + every * DAY : undefined;
}

function healthOf(s: RawSecret, now: number): { health: Health; reason?: string } {
  const deleted = awsTime(s.DeletedDate);
  if (deleted !== undefined) return { health: "error", reason: `scheduled for deletion (requested ${day(deleted)}; restore it before the recovery window ends)` };
  if (s.RotationEnabled) {
    const due = rotationDue(s);
    if (due !== undefined && due < now - DAY) return { health: "warning", reason: `rotation overdue since ${day(due)}` };
  }
  return { health: "ok" };
}

function rotationText(s: RawSecret): string {
  if (!s.RotationEnabled) return "off";
  const every = s.RotationRules?.ScheduleExpression ?? (s.RotationRules?.AutomaticallyAfterDays ? `every ${plural(s.RotationRules.AutomaticallyAfterDays, "day")}` : "on");
  const next = awsTime(s.NextRotationDate);
  return `${every}${next !== undefined ? ` (next ${day(next)})` : ""}`;
}

export function secretsConsoleUrl(region: string, name: string) {
  return `https://${region}.console.aws.amazon.com/secretsmanager/secret?name=${encodeURIComponent(name)}&region=${region}`;
}

export function secretsResult(secrets: RawSecret[], o: { now: number }): ProviderResult {
  const resources: Resource[] = [];
  const links: Link[] = [];
  for (const s of secrets) {
    if (!s.ARN || !s.Name) continue;
    const a = parseArn(s.ARN);
    const region = a?.region ?? "";
    const account = a?.account ?? "";
    const { health, reason } = healthOf(s, o.now);
    const deleted = awsTime(s.DeletedDate);
    const accessed = awsTime(s.LastAccessedDate);
    const facts: Facts = {};
    if (deleted !== undefined) facts.state = "PendingDeletion";
    const versions = Object.keys(s.SecretVersionsToStages ?? {}).length;
    resources.push({
      key: s.ARN,
      kind: "secret",
      provider: "secrets",
      name: s.Name,
      region,
      ...tagsOf(s.Tags ?? []), // ListSecrets returns every secret's tags
      health,
      ...(reason ? { healthReason: reason } : {}),
      ...(Object.keys(facts).length ? { facts } : {}),
      props: props([
        { label: "Description", value: s.Description ? clip(s.Description, 200) : undefined },
        { label: "Encryption", value: s.KmsKeyId ? s.KmsKeyId.replace(/^arn:aws[\w-]*:kms:[^:]+:\d+:/, "") : "aws/secretsmanager (default)" },
        { label: "Rotation", value: rotationText(s) },
        { label: "Last rotated", value: s.LastRotatedDate ? fmtTime(awsTime(s.LastRotatedDate)) : undefined },
        { label: "Last changed", value: s.LastChangedDate ? fmtTime(awsTime(s.LastChangedDate)) : undefined },
        { label: "Last accessed", value: accessed !== undefined ? day(accessed) : "never (or more than 90 days ago)" },
        { label: "Managed by", value: s.OwningService },
        { label: "Primary region", value: s.PrimaryRegion && s.PrimaryRegion !== region ? s.PrimaryRegion : undefined },
        { label: "Versions", value: versions ? fmtCount(versions) : undefined },
        { label: "Scheduled for deletion", value: deleted !== undefined ? `requested ${fmtTime(deleted)}` : undefined },
      ]),
      aliases: [...new Set([s.Name, ...(region && account ? [arnOf.secretPartial(region, account, s.Name)] : [])])],
      ...(accessed !== undefined ? { lastActivityAt: accessed } : {}),
      consoleUrl: secretsConsoleUrl(region, s.Name),
      ...(s.CreatedDate ? { createdAt: awsTime(s.CreatedDate) } : {}),
      ...(s.LastChangedDate ? { lastModified: awsTime(s.LastChangedDate) } : {}),
    });
    if (s.RotationEnabled && s.RotationLambdaARN) links.push({ from: s.ARN, to: s.RotationLambdaARN, kind: "invoke", label: "rotation", evidence: "RotationLambdaARN" });
    const kms = s.KmsKeyId ? kmsKeyRef(s.KmsKeyId, region, account) : region && account ? arnOf.kmsAlias(region, account, "aws/secretsmanager") : undefined;
    links.push(...encryptsLink(kms, s.ARN, "secret", s.KmsKeyId ? "KmsKeyId" : "default key (no KmsKeyId)"));
  }
  return { resources, links, mentions: [] };
}

// The panel, from DescribeSecret (metadata only): versions and their stages, rotation, replication, tags.
export interface RawSecretDetail extends RawSecret {
  ReplicationStatus?: { Region?: string; KmsKeyId?: string; Status?: string; StatusMessage?: string; LastAccessedDate?: Date | string }[];
}

export function secretsDetail(key: string, s: RawSecretDetail | undefined): ResourceDetail {
  if (!s) return { key, sections: [{ title: "Secret", note: "This secret no longer exists." }] };
  const versions = Object.entries(s.SecretVersionsToStages ?? {});
  const tags = (s.Tags ?? []).filter((x) => x.Key);
  return {
    key,
    sections: [
      {
        title: "Secret",
        rows: props([
          { label: "Name", value: s.Name, mono: true },
          { label: "Description", value: s.Description },
          { label: "KMS key", value: s.KmsKeyId ?? "aws/secretsmanager (default)", mono: !!s.KmsKeyId },
          { label: "Rotation", value: rotationText(s) },
          { label: "Rotation function", value: s.RotationLambdaARN, mono: true },
          { label: "Last rotated", value: s.LastRotatedDate ? fmtTime(awsTime(s.LastRotatedDate)) : undefined },
          { label: "Last accessed", value: s.LastAccessedDate ? day(awsTime(s.LastAccessedDate)!) : undefined },
          { label: "Managed by", value: s.OwningService },
          { label: "Scheduled for deletion", value: s.DeletedDate ? fmtTime(awsTime(s.DeletedDate)) : undefined },
        ]),
        note: "Values are never read by the cloud map; reveal one through the service's Variables tab (audited).",
      },
      ...(versions.length ? [{ title: "Versions", table: { columns: ["Version id", "Stages"], rows: versions.map(([id, stages]) => [id, stages.join(", ") || "—"]) } }] : []),
      ...(s.ReplicationStatus?.length ? [{ title: "Replicas", table: { columns: ["Region", "Status", "KMS key"], rows: s.ReplicationStatus.map((r) => [r.Region ?? "?", `${r.Status ?? "?"}${r.StatusMessage ? ` — ${r.StatusMessage}` : ""}`, r.KmsKeyId ?? "default"]) } }] : []),
      ...(tags.length ? [{ title: "Tags", table: { columns: ["Key", "Value"], rows: tags.map((x) => [x.Key!, x.Value ?? ""]) } }] : []),
    ],
  };
}
