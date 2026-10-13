import { test } from "node:test";
import assert from "node:assert/strict";
import { ownTrails, statusRows, trailHealth, trailResults, type RawTrail, type RawTrailStatus } from "./cloudtrail.ts";

const ACCT = "123456789012";
const R = "us-east-1";
const EU = "eu-west-1";
const NOW = Date.UTC(2026, 9, 5, 12);
const MIN = 60_000;
const DAY = 86_400_000;
const SENTINEL = "SECRET_SENTINEL_c7a1";
const arn = (name: string, region = R, acct = ACCT) => `arn:aws:cloudtrail:${region}:${acct}:trail/${name}`;

const trail = (o: Partial<RawTrail> = {}): RawTrail => ({
  Name: "acme-trail", TrailARN: arn("acme-trail"), HomeRegion: R, S3BucketName: "acme-logs", S3KeyPrefix: "cloudtrail", SnsTopicARN: `arn:aws:sns:${R}:${ACCT}:trail-files`,
  IsMultiRegionTrail: true, IncludeGlobalServiceEvents: true, LogFileValidationEnabled: true, IsOrganizationTrail: false,
  CloudWatchLogsLogGroupArn: `arn:aws:logs:${R}:${ACCT}:log-group:/acme/cloudtrail:*`, CloudWatchLogsRoleArn: `arn:aws:iam::${ACCT}:role/cloudtrail-to-cwl`,
  KmsKeyId: `arn:aws:kms:${R}:${ACCT}:key/mrk-0acme`, HasCustomEventSelectors: false, HasInsightSelectors: true,
  ...o, ...({ AdvancedEventSelectors: [{ Name: SENTINEL }] } as object),
});
const logging: RawTrailStatus = { IsLogging: true, StartLoggingTime: new Date(NOW - 700 * DAY), LatestDeliveryTime: new Date(NOW - 3 * MIN), ...({ LatestDeliveryAttemptSucceeded: SENTINEL } as object) };

test("golden: a logging multi-region trail — ok, links to its bucket, log group (no ':*'), role, topic and key", () => {
  const out = trailResults({ region: R, accountId: ACCT, now: NOW, trails: [trail()], status: { [arn("acme-trail")]: logging }, tags: { [arn("acme-trail")]: { Team: "platform" } } });
  assert.deepEqual(out.resources, [{
    key: arn("acme-trail"), kind: "cloudtrail-trail", provider: "cloudtrail", name: "acme-trail", region: R, tags: { Team: "platform" }, health: "ok",
    props: [
      { label: "Logging", value: "yes (since 2024-11-04 12:00 UTC)" },
      { label: "Latest delivery", value: "2026-10-05 11:57 UTC" },
      { label: "Multi-region", value: "yes" },
      { label: "Global service events", value: "yes" },
      { label: "Log file validation", value: "yes" },
      { label: "Bucket", value: "s3://acme-logs/cloudtrail/", mono: true },
      { label: "Log group", value: "/acme/cloudtrail", mono: true },
      { label: "Event selectors", value: "management events + Insights" },
    ],
    aliases: ["acme-trail"],
    consoleUrl: `https://${R}.console.aws.amazon.com/cloudtrailv2/home?region=${R}#/trails/${encodeURIComponent(arn("acme-trail"))}`,
    observedAt: NOW, enrichment: { status: "ok", tags: "ok" },
  }]);
  const k = arn("acme-trail");
  assert.deepEqual(out.links, [
    { from: k, to: "arn:aws:s3:::acme-logs", kind: "writes", label: "trail logs (cloudtrail/)", evidence: "trail S3BucketName" },
    { from: k, to: `arn:aws:logs:${R}:${ACCT}:log-group:/acme/cloudtrail`, kind: "logs", label: "trail events", evidence: "trail CloudWatchLogsLogGroupArn" },
    { from: k, to: `arn:aws:iam::${ACCT}:role/cloudtrail-to-cwl`, kind: "assumes", label: "delivers to CloudWatch Logs", evidence: "trail CloudWatchLogsRoleArn" },
    { from: k, to: `arn:aws:sns:${R}:${ACCT}:trail-files`, kind: "event", label: "new log file", evidence: "trail SnsTopicARN" },
    { from: `arn:aws:kms:${R}:${ACCT}:key/mrk-0acme`, to: k, kind: "encrypts", label: "trail logs", evidence: "trail KmsKeyId" },
  ]);
  assert.ok(!JSON.stringify(out).includes(SENTINEL));
});

test("health: not logging is an error, delivery errors warn, an unread status is unknown", () => {
  assert.deepEqual(trailHealth({ IsLogging: false, StopLoggingTime: new Date(NOW - 2 * DAY) }, "ok"), { health: "error", reason: "not logging since 2026-10-03 12:00 UTC — API activity isn't being recorded" });
  assert.deepEqual(trailHealth({ IsLogging: false, LatestDeliveryError: "AccessDenied" }, "ok").health, "error", "not logging outranks a delivery error");
  assert.deepEqual(trailHealth({ IsLogging: true, LatestDeliveryError: "NoSuchBucket", LatestNotificationError: "AuthorizationError" }, "ok"), { health: "warning", reason: "S3 delivery failing: NoSuchBucket · SNS notification failing: AuthorizationError" });
  assert.deepEqual(trailHealth({ IsLogging: true, LatestCloudWatchLogsDeliveryError: "Could not deliver" }, "ok").health, "warning");
  assert.deepEqual(trailHealth(undefined, "denied"), { health: "unknown", reason: "logging status not read (denied)" });
  const out = trailResults({ region: R, accountId: ACCT, now: NOW, trails: [trail()], statusState: { [arn("acme-trail")]: "denied" }, tagState: { [arn("acme-trail")]: "capped" } });
  const r = out.resources[0];
  assert.deepEqual([r.health, r.props[0], r.tagsUnread, r.enrichment], ["unknown", { label: "Logging", value: "status not read (denied)" }, true, { status: "denied", tags: "capped" }]);
});

test("each trail once, in its home region; an organization trail of another account keeps that account", () => {
  const shadow = trail({ HomeRegion: R });
  assert.deepEqual(ownTrails([shadow], EU), [], "a multi-region trail's shadow in eu-west-1 isn't listed there");
  assert.equal(ownTrails([trail({ TrailARN: undefined })], R).length, 0);
  const org = trail({ Name: "org-trail", TrailARN: arn("org-trail", R, "210987654321"), IsOrganizationTrail: true, KmsKeyId: undefined, CloudWatchLogsLogGroupArn: undefined, CloudWatchLogsRoleArn: undefined, SnsTopicARN: undefined });
  const out = trailResults({ region: R, accountId: ACCT, now: NOW, trails: [org], status: { [org.TrailARN!]: logging } });
  assert.deepEqual([out.resources[0].account, out.resources[0].props.find((p) => p.label === "Organization trail")?.value], ["210987654321", "yes"]);
  assert.deepEqual(out.links.map((l) => l.kind), ["writes"]);
});

test("a bare KMS key id becomes the key's ARN in the trail's region", () => {
  const out = trailResults({ region: R, accountId: ACCT, now: NOW, trails: [trail({ KmsKeyId: "0acme0ab-1111" })] });
  assert.equal(out.links.find((l) => l.kind === "encrypts")?.from, `arn:aws:kms:${R}:${ACCT}:key/0acme0ab-1111`);
});

test("status rows for the panel", () => {
  assert.deepEqual(statusRows({ IsLogging: true, LatestDeliveryTime: new Date(NOW - MIN), LatestDeliveryError: "x".repeat(300) }).map((r) => [r.label, r.value.length]), [["Logging", 3], ["Latest S3 delivery", 20], ["S3 delivery error", 200]]);
  assert.equal(statusRows({ IsLogging: false })[0].value, "stopped");
});
