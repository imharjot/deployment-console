// Simulated EventBridge Scheduler of the Acme account (names from ../mock-names.ts), as ListSchedules + GetSchedule
// return it, per region. us-east-1: acme-daily-digest runs the email-sender Lambda every morning (its input names the
// notifications topic: a mention), and acme-staging-cleanup — disabled — would run the staging worker's task
// definition on the staging cluster (an ECS target: linked by task family). Other regions: none. Read-only.
import type { RawSchedule } from "../../../inventory/scheduling.ts";
import { ACCT, EXISTING, LAMBDA, REGION, SCHEDULES, SNS } from "../mock-names.ts";
import { DAY } from "./serverless-sim.ts";

export function simSchedules(region: string, now: number = Date.now()): RawSchedule[] {
  if (region !== REGION) return [];
  const d = SCHEDULES.dailyDigest;
  const c = SCHEDULES.stagingCleanup;
  return [
    {
      Arn: d.arn, Name: d.name, GroupName: d.group, State: "ENABLED", CreationDate: new Date(now - 120 * DAY), LastModificationDate: new Date(now - 14 * DAY),
      ScheduleExpression: d.expression, ScheduleExpressionTimezone: "UTC", FlexibleTimeWindow: { Mode: "FLEXIBLE", MaximumWindowInMinutes: 15 },
      Description: "Morning digest e-mail to customers who opted in",
      Target: {
        Arn: LAMBDA.emailSender.arn, RetryPolicy: { MaximumRetryAttempts: 2, MaximumEventAgeInSeconds: 3600 },
        Input: JSON.stringify({ template: "daily-digest", notify: SNS.notifications.arn }),
      },
      enrichment: { schedule: "ok" },
    },
    {
      Arn: c.arn, Name: c.name, GroupName: c.group, State: c.state, CreationDate: new Date(now - 400 * DAY), LastModificationDate: new Date(now - 60 * DAY),
      ScheduleExpression: c.expression, FlexibleTimeWindow: { Mode: "OFF" }, Description: "Prunes old staging uploads (paused)",
      Target: {
        Arn: `arn:aws:ecs:${REGION}:${ACCT}:cluster/${EXISTING.clusters.staging}`,
        EcsParameters: { TaskDefinitionArn: `arn:aws:ecs:${REGION}:${ACCT}:task-definition/worker-staging`, TaskCount: 1, LaunchType: "EC2" },
        Input: JSON.stringify({ containerOverrides: [{ command: ["node", "jobs/cleanup.js", "--older-than=30d"] }] }),
      },
      enrichment: { schedule: "ok" },
    },
  ];
}
