// CloudTrail trails as the cloud map sees them, pure (audit §6 A.2, the cloudtrail row): SDK-shaped DescribeTrails
// (includeShadowTrails false: each trail once, in its home region), GetTrailStatus and ListTags answers in; one node per
// trail out. The provider (../server/providers/cloudtrail.ts) and its simulation feed the same functions. No AWS calls.
//
// Key: the trail ARN, in its home region. Links: the bucket it delivers to (writes), the log group it streams to (logs)
// and the role CloudTrail assumes for that, the SNS topic told about each new log file (event), its KMS key (encrypts).
// Health: not logging → error; a delivery error (S3, CloudWatch Logs, digest, SNS) → warning; status not read → unknown.
import { arnBase } from "./arn.ts";
import { assumesLink, awsTime, clip, encryptsLink, enrichmentOf, fmtTime, kmsKeyRef, props, tagsOf, unread } from "./serverless-common.ts";
import type { EnrichState, Health, Link, ProviderResult, Resource } from "./types.ts";

// ---------- raw shapes (the SDK's field names; dates as Date or ISO strings) ----------

type When = Date | string | number;
export interface RawTrail {
  Name?: string;
  S3BucketName?: string;
  S3KeyPrefix?: string;
  SnsTopicName?: string;
  SnsTopicARN?: string;
  IncludeGlobalServiceEvents?: boolean;
  IsMultiRegionTrail?: boolean;
  HomeRegion?: string;
  TrailARN?: string;
  LogFileValidationEnabled?: boolean;
  CloudWatchLogsLogGroupArn?: string;
  CloudWatchLogsRoleArn?: string;
  KmsKeyId?: string;
  HasCustomEventSelectors?: boolean;
  HasInsightSelectors?: boolean;
  IsOrganizationTrail?: boolean;
}
export interface RawTrailStatus {
  IsLogging?: boolean;
  LatestDeliveryError?: string;
  LatestNotificationError?: string;
  LatestDeliveryTime?: When;
  LatestNotificationTime?: When;
  StartLoggingTime?: When;
  StopLoggingTime?: When;
  LatestCloudWatchLogsDeliveryError?: string;
  LatestCloudWatchLogsDeliveryTime?: When;
  LatestDigestDeliveryTime?: When;
  LatestDigestDeliveryError?: string;
}

export function trailHealth(s: RawTrailStatus | undefined, state: EnrichState | undefined): { health: Health; reason?: string } {
  if (!s) return { health: "unknown", reason: unread("logging status", state) };
  if (s.IsLogging === false) {
    const stopped = awsTime(s.StopLoggingTime);
    return { health: "error", reason: `not logging${stopped ? ` since ${fmtTime(stopped)}` : ""} — API activity isn't being recorded` };
  }
  const errors = [
    s.LatestDeliveryError && `S3 delivery failing: ${clip(s.LatestDeliveryError, 100)}`,
    s.LatestCloudWatchLogsDeliveryError && `CloudWatch Logs delivery failing: ${clip(s.LatestCloudWatchLogsDeliveryError, 100)}`,
    s.LatestDigestDeliveryError && `digest delivery failing: ${clip(s.LatestDigestDeliveryError, 100)}`,
    s.LatestNotificationError && `SNS notification failing: ${clip(s.LatestNotificationError, 100)}`,
  ].filter((x): x is string => !!x);
  return errors.length ? { health: "warning", reason: errors.join(" · ") } : { health: "ok" };
}

export interface TrailsInput {
  region: string;
  accountId?: string;
  now: number;
  trails: RawTrail[];
  status?: Record<string, RawTrailStatus | undefined>; // by trail ARN; missing = not read
  statusState?: Record<string, EnrichState>;
  tags?: Record<string, Record<string, string> | undefined>; // by trail ARN; missing = not read
  tagState?: Record<string, EnrichState>;
}

// The trails this region owns: a trail whose home is elsewhere (a shadow of a multi-region trail) is listed there.
export const ownTrails = (trails: RawTrail[], region: string) => trails.filter((t) => t.TrailARN && (!t.HomeRegion || t.HomeRegion === region));

const own = <T>(o: Record<string, T> | undefined, k: string): T | undefined => (o && Object.hasOwn(o, k) ? o[k] : undefined);
const consoleUrl = (region: string, arn: string) => `https://${region}.console.aws.amazon.com/cloudtrailv2/home?region=${region}#/trails/${encodeURIComponent(arn)}`;
const yes = (b: boolean | undefined) => (b === undefined ? undefined : b ? "yes" : "no");

export function trailResults(i: TrailsInput): ProviderResult {
  const resources: Resource[] = [];
  const links: Link[] = [];
  for (const t of ownTrails(i.trails, i.region)) {
    const key = t.TrailARN!;
    const name = t.Name ?? key.split("/").pop() ?? key;
    const region = t.HomeRegion || i.region;
    const account = key.split(":")[4] || i.accountId;
    const s = own(i.status, key);
    const sState = own(i.statusState, key) ?? (s ? "ok" : undefined);
    const tags = own(i.tags, key);
    const tState = own(i.tagState, key) ?? (tags ? "ok" : undefined);
    const h = trailHealth(s, sState);
    if (t.S3BucketName) links.push({ from: key, to: `arn:aws:s3:::${t.S3BucketName}`, kind: "writes", label: `trail logs${t.S3KeyPrefix ? ` (${t.S3KeyPrefix}/)` : ""}`, evidence: "trail S3BucketName" });
    if (t.CloudWatchLogsLogGroupArn?.startsWith("arn:")) links.push({ from: key, to: arnBase(t.CloudWatchLogsLogGroupArn), kind: "logs", label: "trail events", evidence: "trail CloudWatchLogsLogGroupArn" });
    links.push(...assumesLink(key, t.CloudWatchLogsRoleArn, "delivers to CloudWatch Logs", "trail CloudWatchLogsRoleArn"));
    if (t.SnsTopicARN) links.push({ from: key, to: t.SnsTopicARN, kind: "event", label: "new log file", evidence: "trail SnsTopicARN" });
    links.push(...encryptsLink(kmsKeyRef(t.KmsKeyId, region, account), key, "trail logs", "trail KmsKeyId"));
    const delivered = awsTime(s?.LatestDeliveryTime);
    const started = awsTime(s?.StartLoggingTime);
    const enrichment = enrichmentOf({ status: sState, tags: tState });
    resources.push({
      key, kind: "cloudtrail-trail", provider: "cloudtrail", name, region, ...tagsOf(tags),
      ...(account && i.accountId && account !== i.accountId ? { account } : {}),
      health: h.health, ...(h.reason ? { healthReason: h.reason } : {}),
      props: props([
        { label: "Logging", value: s ? (s.IsLogging === false ? "stopped" : `yes${started ? ` (since ${fmtTime(started)})` : ""}`) : unread("status", sState) },
        { label: "Latest delivery", value: delivered ? fmtTime(delivered) : undefined },
        { label: "Multi-region", value: yes(t.IsMultiRegionTrail) },
        { label: "Organization trail", value: t.IsOrganizationTrail ? "yes" : undefined },
        { label: "Global service events", value: yes(t.IncludeGlobalServiceEvents) },
        { label: "Log file validation", value: yes(t.LogFileValidationEnabled) },
        { label: "Bucket", value: t.S3BucketName ? `s3://${t.S3BucketName}/${t.S3KeyPrefix ? `${t.S3KeyPrefix}/` : ""}` : undefined, mono: true },
        { label: "Log group", value: t.CloudWatchLogsLogGroupArn ? arnBase(t.CloudWatchLogsLogGroupArn).split(":log-group:")[1] : undefined, mono: true },
        { label: "Event selectors", value: [t.HasCustomEventSelectors ? "custom" : "management events", t.HasInsightSelectors ? "Insights" : ""].filter(Boolean).join(" + ") },
      ]),
      aliases: [name],
      consoleUrl: consoleUrl(region, key),
      observedAt: i.now,
      ...(enrichment ? { enrichment } : {}),
    });
  }
  return { resources, links, mentions: [] };
}

// GetTrailStatus as panel rows.
export function statusRows(s: RawTrailStatus): { label: string; value: string }[] {
  const at = (label: string, v: When | undefined) => (awsTime(v) ? [{ label, value: fmtTime(awsTime(v)) }] : []);
  const err = (label: string, v: string | undefined) => (v ? [{ label, value: clip(v, 200) }] : []);
  return [
    { label: "Logging", value: s.IsLogging === false ? "stopped" : s.IsLogging ? "yes" : "unknown" },
    ...at("Started logging", s.StartLoggingTime), ...at("Stopped logging", s.StopLoggingTime),
    ...at("Latest S3 delivery", s.LatestDeliveryTime), ...err("S3 delivery error", s.LatestDeliveryError),
    ...at("Latest CloudWatch Logs delivery", s.LatestCloudWatchLogsDeliveryTime), ...err("CloudWatch Logs delivery error", s.LatestCloudWatchLogsDeliveryError),
    ...at("Latest digest", s.LatestDigestDeliveryTime), ...err("Digest delivery error", s.LatestDigestDeliveryError),
    ...at("Latest SNS notification", s.LatestNotificationTime), ...err("SNS notification error", s.LatestNotificationError),
  ];
}
