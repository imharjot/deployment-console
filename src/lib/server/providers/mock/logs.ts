// Simulated CloudWatch Logs groups, per region (the provider sets multiRegionMock), in DescribeLogGroups' shapes so the
// real mapping runs. us-east-1: one group per ECS service (../../mock.ts logGroup(): /ecs/acme-<env>/<service>; the
// production ones encrypted with the application key), one per Lambda function (the AWS convention), the production
// database's PostgreSQL log, the billing build's CodeBuild log, the API Gateway access log and the checkout state
// machine's vended group (other simulated providers point at both), CloudTrail's group, Glue's crawler group, Container
// Insights (hidden) and the VPC flow logs — which never expire and hold 14 GB (a warning). The retired legacy cron
// function's group holds nothing. eu-west-1: the eu estate's two ECS groups. Other regions: none.
import type { RawLogGroup, RawLogStream, RawSubscriptionFilter } from "../../../inventory/logs.ts";
import { getCloud } from "../../sources.ts";
import { EU, EU_REGION, EXISTING, KMS_KEYS, LAMBDA, LOG_GROUPS, NETWORK, REGION } from "../mock-names.ts";
import { PUBLIC_API_ACCESS_LOG } from "./apigateway.ts";
import { CHECKOUT_LOG_GROUP } from "./stepfunctions.ts";

const DAY = 86_400_000;
const MB = 1024 ** 2;
const GLUE_CRAWLER_LOG_GROUP = "/aws-glue/crawlers"; // where every Glue crawler writes (AWS's fixed name)

// Stable pseudo-random sizes from a name.
function size(name: string, maxMb: number): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) h = Math.imul(h ^ name.charCodeAt(i), 0x01000193) >>> 0;
  return Math.round((0.2 + (h % 1000) / 1000) * maxMb * MB);
}

interface Spec { name: string; retention?: number; bytes: number; kms?: string; tags: Record<string, string>; age: number; cls?: string; filters?: number }

function specs(region: string): Spec[] {
  if (region === REGION) {
    const ecs = (env: "staging" | "production") =>
      EXISTING.ecsServices[env].map((s): Spec => ({
        name: LOG_GROUPS.ecs(env, s), retention: env === "production" ? 30 : 7, bytes: size(`${env}/${s}`, env === "production" ? 900 : 120),
        ...(env === "production" ? { kms: KMS_KEYS.app.arn } : {}), tags: { Environment: env }, age: env === "production" ? 400 : 300,
      }));
    const lambdas = Object.values(LAMBDA).map((f): Spec => ({
      name: LOG_GROUPS.lambda(f.name), retention: 14, bytes: f.name === LAMBDA.legacyCleanup.name ? 0 : size(f.name, 60),
      tags: f.env ? { Environment: f.env } : {}, age: f.name === LAMBDA.legacyCleanup.name ? 900 : 200,
    }));
    return [
      ...ecs("staging"), ...ecs("production"), ...lambdas,
      { name: LOG_GROUPS.rds, retention: 7, bytes: size("rds", 400), tags: { Environment: "production" }, age: 500, filters: 1 },
      { name: LOG_GROUPS.codebuild, retention: 30, bytes: size("codebuild", 40), tags: {}, age: 300 },
      { name: PUBLIC_API_ACCESS_LOG, retention: 30, bytes: size("apigw", 80), tags: { Environment: "production" }, age: 250 },
      { name: CHECKOUT_LOG_GROUP, retention: 30, bytes: size("sfn", 30), tags: {}, age: 240, cls: "DELIVERY" },
      { name: LOG_GROUPS.containerInsights, retention: 1, bytes: size("ci", 200), tags: {}, age: 380 },
      { name: LOG_GROUPS.cloudtrail, retention: 365, bytes: size("trail", 3000), kms: KMS_KEYS.app.arn, tags: {}, age: 700 },
      { name: GLUE_CRAWLER_LOG_GROUP, retention: 14, bytes: size("glue", 5), tags: {}, age: 150 },
      { name: NETWORK.flowLogGroup, bytes: 14.2 * 1024 * MB, tags: { Team: "platform" }, age: 800, cls: "INFREQUENT_ACCESS" }, // never expires
    ];
  }
  if (region === EU_REGION) {
    return EU.services.map((s): Spec => ({ name: EU.logGroup(s.name), retention: 30, bytes: size(`eu/${s.name}`, 300), kms: KMS_KEYS.appReplica.arn, tags: { Environment: "production" }, age: 300 }));
  }
  return [];
}

export function simLogGroups(region: string): { groups: RawLogGroup[]; tags: Record<string, Record<string, string>>; subscriptions: Record<string, RawSubscriptionFilter[]> } {
  const now = Math.floor(Date.now() / DAY) * DAY; // stable within a day
  const list = specs(region);
  const groups = list.map((s): RawLogGroup => {
    const arn = LOG_GROUPS.arn(s.name, region);
    return {
      logGroupName: s.name, logGroupArn: arn, arn: `${arn}:*`, creationTime: now - s.age * DAY, storedBytes: s.bytes, metricFilterCount: s.filters ?? 0,
      logGroupClass: s.cls ?? "STANDARD", ...(s.retention !== undefined ? { retentionInDays: s.retention } : {}), ...(s.kms ? { kmsKeyId: s.kms } : {}),
    };
  });
  return {
    groups,
    tags: Object.fromEntries(list.map((s) => [s.name, s.tags])),
    subscriptions: Object.fromEntries(list.map((s) => [s.name, [] as RawSubscriptionFilter[]])),
  };
}

// The newest streams of a simulated group: the ECS ones from the simulated account's tasks; the others, none.
export async function simLogStreams(region: string, group: string): Promise<RawLogStream[]> {
  try {
    const streams = await (await getCloud(region)).logStreams(group);
    return streams.slice(0, 10).map((s) => ({ logStreamName: s.name, lastEventTimestamp: s.lastEventAt }));
  } catch {
    return [];
  }
}
