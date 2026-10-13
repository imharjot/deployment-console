// Simulated CloudTrail (mock-names TRAIL), in DescribeTrails / GetTrailStatus / ListTags shapes so the real mapping runs.
// One multi-region trail whose home is us-east-1: it delivers to the shared logs bucket (encrypted with the application
// key) and streams to its CloudWatch Logs group, and it is logging. DescribeTrails with includeShadowTrails false lists
// a trail only in its home region, so eu-west-1 (and every other region) has none.
import type { RawTrail, RawTrailStatus } from "../../../inventory/cloudtrail.ts";
import { KMS_KEYS, LOG_GROUPS, REGION, TRAIL } from "../mock-names.ts";

const MIN = 60_000;
const DAY = 86_400_000;

export function simTrails(region: string): { trails: RawTrail[]; status: Record<string, RawTrailStatus>; tags: Record<string, Record<string, string>> } {
  if (region !== REGION) return { trails: [], status: {}, tags: {} };
  const t = Math.floor(Date.now() / MIN) * MIN;
  const trail: RawTrail = {
    Name: TRAIL.name, TrailARN: TRAIL.arn, HomeRegion: REGION, S3BucketName: TRAIL.bucket, S3KeyPrefix: "cloudtrail",
    IsMultiRegionTrail: true, IncludeGlobalServiceEvents: true, LogFileValidationEnabled: true, IsOrganizationTrail: false,
    CloudWatchLogsLogGroupArn: `${LOG_GROUPS.arn(TRAIL.logGroup)}:*`, KmsKeyId: KMS_KEYS.app.arn, HasCustomEventSelectors: false, HasInsightSelectors: false,
  };
  const status: RawTrailStatus = {
    IsLogging: true, StartLoggingTime: new Date(t - 700 * DAY), LatestDeliveryTime: new Date(t - 3 * MIN),
    LatestCloudWatchLogsDeliveryTime: new Date(t - 2 * MIN), LatestDigestDeliveryTime: new Date(t - 40 * MIN),
  };
  return { trails: [trail], status: { [TRAIL.arn]: status }, tags: { [TRAIL.arn]: { Team: "platform" } } };
}
