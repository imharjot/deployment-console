// Simulated CloudWatch alarms (us-east-1; other regions have none), in DescribeAlarms' shapes so the real mapping runs.
// The story (mock-names ALARMS): target tracking on the production api service created an AlarmHigh/AlarmLow pair, and
// AlarmLow sits in ALARM because load is low — a scaling alarm, which must not warn api. The database CPU alarm is in
// ALARM and warns acme-production-pg. The orders DLQ alarm and the api's 5XX alarm (on its target group: the map
// draws it on the ECS service) are OK and notify the acme-alarms topic. The legacy cron box is stopped, so its CPU
// alarm has had no data for weeks while its notification can't fire (a warning on the alarm itself).
import type { RawHistoryItem, RawMetricAlarm } from "../../../inventory/alarms.ts";
import { getCloud } from "../../sources.ts";
import { ALARMS, EC2, EXISTING, REGION, SNS } from "../mock-names.ts";

const MIN = 60_000;
const DAY = 86_400_000;

// Base time stamps relative to now, rounded to the minute so repeated reads agree.
const now = () => Math.floor(Date.now() / MIN) * MIN;
const iso = (t: number) => new Date(t);

const API_5XX = "acme-production-api-5xx";
const LEGACY_CPU = "acme-legacy-cron-cpu";
export const SIM_ALARM_NAMES = [ALARMS.apiHigh.name, ALARMS.apiLow.name, ALARMS.dbCpu.name, ALARMS.ordersDlq.name, API_5XX, LEGACY_CPU];

const ecsDims = [{ Name: "ClusterName", Value: EXISTING.clusters.production }, { Name: "ServiceName", Value: "api" }];
const scalingDescription = `DO NOT EDIT OR DELETE. For TargetTrackingScaling policy ${ALARMS.scalingPolicyArn}.`;

// The api service's target group, as the simulated account reports it (undefined if it has none).
async function apiTargetGroup(): Promise<string | undefined> {
  try {
    const services = await (await getCloud(REGION)).services(EXISTING.clusters.production);
    return services.find((s) => s.name === "api")?.targetGroupArns[0];
  } catch {
    return undefined;
  }
}

export async function simAlarms(region: string): Promise<{ metric: RawMetricAlarm[]; tags: Record<string, Record<string, string>> }> {
  if (region !== REGION) return { metric: [], tags: {} };
  const t = now();
  const tg = await apiTargetGroup();
  const lb = EXISTING.alb.arn.split(":loadbalancer/")[1]; // "app/acme-production/5f2c1a9d3e7b4c60"
  const base = (name: string, state: string, since: number, o: Partial<RawMetricAlarm>): RawMetricAlarm => ({
    AlarmName: name, AlarmArn: ALARMS.arn(name), ActionsEnabled: true, OKActions: [], AlarmActions: [], InsufficientDataActions: [],
    StateValue: state, StateUpdatedTimestamp: iso(since), StateTransitionedTimestamp: iso(since), AlarmConfigurationUpdatedTimestamp: iso(t - 120 * DAY),
    Period: 60, EvaluationPeriods: 3, DatapointsToAlarm: 3, TreatMissingData: "missing", ...o,
  });
  const metric: RawMetricAlarm[] = [
    base(ALARMS.apiHigh.name, ALARMS.apiHigh.state, t - 2 * DAY, {
      AlarmDescription: scalingDescription, AlarmActions: [ALARMS.scalingPolicyArn],
      StateReason: "Threshold Crossed: 3 datapoints [31.2, 29.8, 33.0] were not greater than the threshold (60.0).",
      Namespace: "AWS/ECS", MetricName: "CPUUtilization", Dimensions: ecsDims, Statistic: "Average", Threshold: 60, ComparisonOperator: "GreaterThanThreshold",
    }),
    base(ALARMS.apiLow.name, ALARMS.apiLow.state, t - 95 * MIN, {
      AlarmDescription: scalingDescription, AlarmActions: [ALARMS.scalingPolicyArn],
      StateReason: "Threshold Crossed: 15 datapoints were less than the threshold (54.0). The most recent datapoints which crossed the threshold: [31.2, 29.8, 33.0].",
      Namespace: "AWS/ECS", MetricName: "CPUUtilization", Dimensions: ecsDims, Statistic: "Average", Threshold: 54, ComparisonOperator: "LessThanThreshold",
      EvaluationPeriods: 15, DatapointsToAlarm: 15,
    }),
    base(ALARMS.dbCpu.name, ALARMS.dbCpu.state, t - 38 * MIN, {
      AlarmDescription: "Production database CPU above 80 % for 15 minutes — page the on-call.",
      AlarmActions: [SNS.alarms.arn], OKActions: [SNS.alarms.arn],
      StateReason: "Threshold Crossed: 3 out of the last 3 datapoints [91.4, 88.0, 86.7] were greater than the threshold (80.0) (minimum 3 datapoints for OK -> ALARM transition).",
      Namespace: "AWS/RDS", MetricName: "CPUUtilization", Dimensions: [{ Name: "DBInstanceIdentifier", Value: ALARMS.dbCpu.dbInstance }],
      Statistic: "Average", Period: 300, Threshold: 80, ComparisonOperator: "GreaterThanThreshold",
    }),
    base(ALARMS.ordersDlq.name, ALARMS.ordersDlq.state, t - 6 * DAY, {
      AlarmDescription: "Orders are failing into the dead-letter queue.", AlarmActions: [SNS.alarms.arn],
      StateReason: "Threshold Crossed: 1 datapoint [0.0] was not greater than the threshold (0.0).",
      Namespace: "AWS/SQS", MetricName: "ApproximateNumberOfMessagesVisible", Dimensions: [{ Name: "QueueName", Value: ALARMS.ordersDlq.queue }],
      Statistic: "Maximum", Period: 300, EvaluationPeriods: 1, DatapointsToAlarm: 1, Threshold: 0, ComparisonOperator: "GreaterThanThreshold", TreatMissingData: "notBreaching",
    }),
    base(API_5XX, "OK", t - 9 * DAY, {
      AlarmDescription: "Storefront API answering 5XX.", AlarmActions: [SNS.alarms.arn],
      StateReason: "Threshold Crossed: 2 datapoints [0.0, 1.0] were not greater than the threshold (10.0).",
      Namespace: "AWS/ApplicationELB", MetricName: "HTTPCode_Target_5XX_Count",
      Dimensions: [{ Name: "LoadBalancer", Value: lb }, ...(tg ? [{ Name: "TargetGroup", Value: tg.split(":").pop()! }] : [])],
      Statistic: "Sum", Period: 300, EvaluationPeriods: 2, DatapointsToAlarm: 2, Threshold: 10, ComparisonOperator: "GreaterThanThreshold", TreatMissingData: "notBreaching",
    }),
    base(LEGACY_CPU, "INSUFFICIENT_DATA", t - 41 * DAY, {
      AlarmDescription: "Legacy cron box CPU.", AlarmActions: [SNS.alarms.arn],
      StateReason: "Insufficient Data: 3 datapoints were unknown.",
      Namespace: "AWS/EC2", MetricName: "CPUUtilization", Dimensions: [{ Name: "InstanceId", Value: EC2.legacyCron.id }],
      Statistic: "Average", Period: 300, Threshold: 90, ComparisonOperator: "GreaterThanOrEqualToThreshold",
    }),
  ];
  const tags: Record<string, Record<string, string>> = {
    [ALARMS.arn(ALARMS.dbCpu.name)]: { Environment: "production", Team: "platform" },
    [ALARMS.arn(ALARMS.ordersDlq.name)]: { Environment: "production" },
    [ALARMS.arn(API_5XX)]: { Environment: "production" },
    [ALARMS.arn(LEGACY_CPU)]: {},
    [ALARMS.arn(ALARMS.apiHigh.name)]: {},
    [ALARMS.arn(ALARMS.apiLow.name)]: {},
  };
  return { metric, tags };
}

// The last state changes of one simulated alarm (DescribeAlarmHistory's shape), newest first.
export function simAlarmHistory(name: string): RawHistoryItem[] {
  const t = now();
  const flip = (ago: number, from: string, to: string): RawHistoryItem => ({ Timestamp: new Date(t - ago), HistoryItemType: "StateUpdate", HistorySummary: `Alarm updated from ${from} to ${to}` });
  switch (name) {
    case ALARMS.apiLow.name: return [flip(95 * MIN, "OK", "ALARM"), flip(14 * 60 * MIN, "ALARM", "OK"), flip(26 * 60 * MIN, "OK", "ALARM")];
    case ALARMS.apiHigh.name: return [flip(2 * DAY, "ALARM", "OK"), flip(2 * DAY + 25 * MIN, "OK", "ALARM")];
    case ALARMS.dbCpu.name: return [
      { Timestamp: new Date(t - 38 * MIN + 2_000), HistoryItemType: "Action", HistorySummary: `Successfully executed action ${SNS.alarms.arn}` },
      flip(38 * MIN, "OK", "ALARM"), flip(3 * DAY, "ALARM", "OK"), flip(3 * DAY + 50 * MIN, "OK", "ALARM"),
    ];
    case ALARMS.ordersDlq.name: return [flip(6 * DAY, "ALARM", "OK"), flip(6 * DAY + 3 * 60 * MIN, "OK", "ALARM")];
    case API_5XX: return [flip(9 * DAY, "ALARM", "OK"), flip(9 * DAY + 10 * MIN, "OK", "ALARM")];
    case LEGACY_CPU: return [flip(41 * DAY, "OK", "INSUFFICIENT_DATA")];
    default: return [];
  }
}
