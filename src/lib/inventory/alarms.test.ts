import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  actionClass, alarmHealth, alarmResults, compositeChildren, conditionOf, dimensionTargets, historyRows, isScalingAlarm, scalingTarget,
  type MapContext, type RawCompositeAlarm, type RawMetricAlarm,
} from "./alarms.ts";
import { infer } from "./infer.ts";
import { propagate } from "./propagate.ts";
import { keys, type ProviderResult, type Resource } from "./types.ts";

const ACCT = "123456789012";
const R = "us-east-1";
const EU = "eu-west-1";
const NOW = Date.UTC(2026, 9, 5, 12);
const MIN = 60_000;
const DAY = 86_400_000;
const SENTINEL = "SECRET_SENTINEL_a1a7";
const alarmArn = (name: string, region = R) => `arn:aws:cloudwatch:${region}:${ACCT}:alarm:${name}`;
const topic = `arn:aws:sns:${R}:${ACCT}:acme-alarms`;
const apiPolicy = `arn:aws:autoscaling:${R}:${ACCT}:scalingPolicy:0acme0sp-2222-4333-8444-000000000001:resource/ecs/service/acme-production/api:policyName/acme-api-cpu-target`;
const m: MapContext = { region: R, account: ACCT, home: R };

// Fields a real answer carries that must never reach the map: the raw datapoints (StateReasonData), contributor
// attributes, evaluation details.
const noise = { StateReasonData: `{"recentDatapoints":[91.4],"secret":"${SENTINEL}"}`, AlarmContributorAttributes: { k: SENTINEL }, EvaluationState: SENTINEL } as object;

const dbCpu: RawMetricAlarm = {
  AlarmName: "acme-production-pg-cpu-high", AlarmArn: alarmArn("acme-production-pg-cpu-high"), AlarmDescription: "page the on-call",
  ActionsEnabled: true, AlarmActions: [topic], OKActions: [topic], InsufficientDataActions: [],
  StateValue: "ALARM", StateReason: "Threshold Crossed: 3 out of the last 3 datapoints [91.4, 88.0, 86.7] were greater than the threshold (80.0).",
  StateUpdatedTimestamp: new Date(NOW - 38 * MIN), StateTransitionedTimestamp: new Date(NOW - 38 * MIN), AlarmConfigurationUpdatedTimestamp: new Date(NOW - 120 * DAY),
  Namespace: "AWS/RDS", MetricName: "CPUUtilization", Dimensions: [{ Name: "DBInstanceIdentifier", Value: "acme-production-pg" }],
  Statistic: "Average", Period: 300, EvaluationPeriods: 3, DatapointsToAlarm: 3, Threshold: 80, ComparisonOperator: "GreaterThanThreshold", TreatMissingData: "missing",
  ...noise,
};
const tracking = (suffix: "High" | "Low", state: string, region = R): RawMetricAlarm => ({
  AlarmName: `TargetTracking-service/acme-production/api-Alarm${suffix}-0acme`, AlarmArn: alarmArn(`TargetTracking-service/acme-production/api-Alarm${suffix}-0acme`, region),
  ActionsEnabled: true, AlarmActions: [apiPolicy.replace(`:${R}:`, `:${region}:`)], OKActions: [], InsufficientDataActions: [], StateValue: state,
  StateTransitionedTimestamp: new Date(NOW - 95 * MIN),
  Namespace: "AWS/ECS", MetricName: "CPUUtilization", Dimensions: [{ Name: "ClusterName", Value: "acme-production" }, { Name: "ServiceName", Value: "api" }],
  Statistic: "Average", Period: 60, EvaluationPeriods: suffix === "Low" ? 15 : 3, Threshold: suffix === "Low" ? 54 : 60,
  ComparisonOperator: suffix === "Low" ? "LessThanThreshold" : "GreaterThanThreshold",
});

test("golden: a database CPU alarm in ALARM — error, facts, a monitors link to the instance's ARN, SNS on ALARM and OK", () => {
  const out = alarmResults({ region: R, accountId: ACCT, home: R, now: NOW, metric: [dbCpu], tags: { [dbCpu.AlarmArn!]: { Environment: "production" } }, tagState: { [dbCpu.AlarmArn!]: "ok" } });
  assert.deepEqual(out.resources, [{
    key: dbCpu.AlarmArn, kind: "cloudwatch-alarm", provider: "alarms", name: "acme-production-pg-cpu-high", region: R, tags: { Environment: "production" },
    health: "error",
    healthReason: "in ALARM since 2026-10-05 11:22 UTC: Threshold Crossed: 3 out of the last 3 datapoints [91.4, 88.0, 86.7] were greater than the threshold (80.0).",
    props: [
      { label: "State", value: "ALARM since 2026-10-05 11:22 UTC" },
      { label: "Type", value: "metric" },
      { label: "Metric", value: "AWS/RDS CPUUtilization" },
      { label: "Condition", value: "CPUUtilization > 80 · 3 of 3 datapoints × 5 min (Average)" },
      { label: "Dimensions", value: "DBInstanceIdentifier=acme-production-pg" },
      { label: "Watches", value: "database instance acme-production-pg" },
      { label: "Actions", value: "ALARM → notify acme-alarms (SNS); OK → notify acme-alarms (SNS)" },
      { label: "Missing data", value: "missing" },
      { label: "Reason", value: "Threshold Crossed: 3 out of the last 3 datapoints [91.4, 88.0, 86.7] were greater than the threshold (80.0)." },
      { label: "Description", value: "page the on-call" },
    ],
    aliases: ["acme-production-pg-cpu-high"],
    consoleUrl: `https://${R}.console.aws.amazon.com/cloudwatch/home?region=${R}#alarmsV2:alarm/acme-production-pg-cpu-high`,
    lastModified: NOW - 120 * DAY,
    facts: { alarmState: "ALARM" },
    observedAt: NOW,
    enrichment: { tags: "ok" },
  }]);
  assert.deepEqual(out.links, [
    {
      from: dbCpu.AlarmArn, to: `arn:aws:rds:${R}:${ACCT}:db:acme-production-pg`, kind: "monitors", label: "CPUUtilization > 80",
      evidence: "alarm metric AWS/RDS CPUUtilization {DBInstanceIdentifier=acme-production-pg} → database instance acme-production-pg",
    },
    { from: dbCpu.AlarmArn, to: topic, kind: "event", label: "on ALARM, OK", evidence: "alarm actions (ALARM, OK)" },
  ]);
  assert.ok(!JSON.stringify(out).includes(SENTINEL), "raw datapoints and contributor attributes never reach the map");
});

test("tags not read: tagsUnread, and the enrichment state says why", () => {
  const out = alarmResults({ region: R, accountId: ACCT, now: NOW, metric: [dbCpu], tagState: { [dbCpu.AlarmArn!]: "capped" } });
  assert.deepEqual([out.resources[0].tags, out.resources[0].tagsUnread, out.resources[0].enrichment], [{}, true, { tags: "capped" }]);
  const listed = alarmResults({ region: R, accountId: ACCT, now: NOW, metric: [dbCpu] }).resources[0];
  assert.deepEqual([listed.tagsUnread, listed.enrichment], [true, undefined]);
});

test("CC-11: target tracking's AlarmLow in ALARM is a scaling alarm — ok, facts.scaling, a 'scales' link to the region-aware ECS key", () => {
  const out = alarmResults({ region: R, accountId: ACCT, home: R, now: NOW, metric: [tracking("High", "OK"), tracking("Low", "ALARM")] });
  const low = out.resources.find((r) => r.name.endsWith("AlarmLow-0acme"))!;
  assert.deepEqual([low.health, low.facts, low.healthReason], ["ok", { alarmState: "ALARM", scaling: true }, "scaling alarm — ALARM starts a scaling action, not an incident"]);
  assert.deepEqual(out.links.filter((l) => l.from === low.key).map((l) => [l.to, l.kind, l.label]), [[keys.ecsService("acme-production", "api"), "monitors", "scales"]]);
  // In another region the same pair points at that region's service (CC-6), never the home one.
  const eu = alarmResults({ region: EU, accountId: ACCT, home: R, now: NOW, metric: [tracking("Low", "ALARM", EU)] });
  assert.deepEqual(eu.links.map((l) => l.to), ["ecs:service/acme-production/api@eu-west-1"]);
  assert.equal(eu.resources[0].region, EU);
});

test("scaling: every action a scaling policy (step scaling) is a scaling alarm; a policy plus a notification is not", () => {
  const step: RawMetricAlarm = { ...dbCpu, AlarmName: "orders-backlog-high", AlarmArn: alarmArn("orders-backlog-high"), AlarmActions: [apiPolicy], OKActions: [], Namespace: "AWS/SQS", MetricName: "ApproximateNumberOfMessagesVisible", Dimensions: [{ Name: "QueueName", Value: "acme-production-orders" }] };
  assert.equal(isScalingAlarm(step), true);
  assert.equal(isScalingAlarm({ ...step, AlarmActions: [apiPolicy, topic] }), false);
  assert.equal(isScalingAlarm({ AlarmName: "anything", AlarmActions: [] }), false, "no actions at all is not scaling");
  const out = alarmResults({ region: R, accountId: ACCT, home: R, now: NOW, metric: [step, { ...step, AlarmName: "orders-backlog-page", AlarmArn: alarmArn("orders-backlog-page"), AlarmActions: [apiPolicy, topic] }] });
  const by = (name: string) => out.links.filter((l) => l.from === alarmArn(name) && l.kind === "monitors").map((l) => [l.to, l.label]);
  assert.deepEqual(by("orders-backlog-high"), [[`arn:aws:sqs:${R}:${ACCT}:acme-production-orders`, "scales"], [keys.ecsService("acme-production", "api"), "scales"]]);
  assert.deepEqual(by("orders-backlog-page"), [[`arn:aws:sqs:${R}:${ACCT}:acme-production-orders`, "ApproximateNumberOfMessagesVisible > 80"], [keys.ecsService("acme-production", "api"), "scales"]]);
  assert.equal(out.resources.find((r) => r.name === "orders-backlog-page")!.health, "error", "a non-scaling alarm in ALARM is an error");
});

test("the dimension mapper: one rule per namespace, region-aware references, never a bare name", () => {
  const t = (ns: string, dims: Record<string, string>, ctx: MapContext = m) => dimensionTargets(ns, Object.entries(dims).map(([Name, Value]) => ({ Name, Value })), ctx).map((w) => w.ref);
  const eu: MapContext = { region: EU, account: ACCT, home: R };
  assert.deepEqual(t("AWS/ECS", { ClusterName: "c", ServiceName: "s" }), ["ecs:service/c/s"]);
  assert.deepEqual(t("ECS/ContainerInsights", { ClusterName: "c", ServiceName: "s" }, eu), ["ecs:service/c/s@eu-west-1"]);
  assert.deepEqual(t("ECS/ContainerInsights", { ClusterName: "c" }), [], "a cluster isn't a node");
  assert.deepEqual(t("AWS/ECS", { ClusterName: "c", ServiceName: "s" }, { region: EU, account: ACCT }), [`arn:aws:ecs:${EU}:${ACCT}:service/c/s`], "home unknown: the service's ARN");
  // ELB: the ARN from the alarm's own region and account — never "elb:<name>".
  assert.deepEqual(t("AWS/ApplicationELB", { LoadBalancer: "app/acme-production/5f2c1a9d3e7b4c60" }, eu), [`arn:aws:elasticloadbalancing:${EU}:${ACCT}:loadbalancer/app/acme-production/5f2c1a9d3e7b4c60`]);
  assert.deepEqual(t("AWS/NetworkELB", { LoadBalancer: "net/nlb/0123abcd" }), [`arn:aws:elasticloadbalancing:${R}:${ACCT}:loadbalancer/net/nlb/0123abcd`]);
  assert.deepEqual(t("AWS/ApplicationELB", { LoadBalancer: "acme-production" }), [], "not a load balancer dimension value");
  const tg = `arn:aws:elasticloadbalancing:${R}:${ACCT}:targetgroup/api-prod/0011aabb`;
  const both = { LoadBalancer: "app/acme-production/5f2c1a9d3e7b4c60", TargetGroup: "targetgroup/api-prod/0011aabb" };
  assert.deepEqual(t("AWS/ApplicationELB", both, { ...m, targetGroups: { [tg]: "ecs:service/acme-production/api" } }), ["ecs:service/acme-production/api"]);
  assert.deepEqual(t("AWS/ApplicationELB", both), [`arn:aws:elasticloadbalancing:${R}:${ACCT}:loadbalancer/app/acme-production/5f2c1a9d3e7b4c60`], "unknown target group: its load balancer");
  assert.deepEqual(t("AWS/ELB", { LoadBalancerName: "legacy" }), [`arn:aws:elasticloadbalancing:${R}:${ACCT}:loadbalancer/legacy`]);
  assert.deepEqual(t("AWS/RDS", { DBInstanceIdentifier: "db1" }, eu), [`arn:aws:rds:${EU}:${ACCT}:db:db1`]);
  assert.deepEqual(t("AWS/RDS", { DBClusterIdentifier: "aur", Role: "WRITER" }), [`arn:aws:rds:${R}:${ACCT}:cluster:aur`]);
  assert.deepEqual(t("AWS/DocDB", { DBClusterIdentifier: "docs" }), [`arn:aws:rds:${R}:${ACCT}:cluster:docs`]);
  // CC-22: node ids, cluster mode included, are member-cluster ARNs (aliases of the replication group) — no stripping.
  assert.deepEqual(t("AWS/ElastiCache", { CacheClusterId: "acme-valkey-0001-001", CacheNodeId: "0001" }), [`arn:aws:elasticache:${R}:${ACCT}:cluster:acme-valkey-0001-001`]);
  assert.deepEqual(t("AWS/ElastiCache", { ReplicationGroupId: "acme-valkey" }), [`arn:aws:elasticache:${R}:${ACCT}:replicationgroup:acme-valkey`]);
  assert.deepEqual(t("AWS/EC2", { InstanceId: "i-0abc" }), [`arn:aws:ec2:${R}:${ACCT}:instance/i-0abc`]);
  assert.deepEqual(t("AWS/EC2", { AutoScalingGroupName: "ecs-hosts" }), [`arn:aws:autoscaling:${R}:${ACCT}:autoScalingGroup:*:autoScalingGroupName/ecs-hosts`]);
  assert.deepEqual(t("AWS/AutoScaling", { AutoScalingGroupName: "ecs-hosts" }), [`arn:aws:autoscaling:${R}:${ACCT}:autoScalingGroup:*:autoScalingGroupName/ecs-hosts`]);
  assert.deepEqual(t("AWS/EBS", { VolumeId: "vol-1" }), [`arn:aws:ec2:${R}:${ACCT}:volume/vol-1`]);
  assert.deepEqual(t("AWS/Lambda", { FunctionName: "orders", Resource: "orders:live" }), [`arn:aws:lambda:${R}:${ACCT}:function:orders`]);
  assert.deepEqual(t("AWS/Lambda", { FunctionName: "orders:live" }), [`arn:aws:lambda:${R}:${ACCT}:function:orders`]);
  assert.deepEqual(t("AWS/SQS", { QueueName: "q.fifo" }), [`arn:aws:sqs:${R}:${ACCT}:q.fifo`]);
  assert.deepEqual(t("AWS/SNS", { TopicName: "alerts" }), [`arn:aws:sns:${R}:${ACCT}:alerts`]);
  assert.deepEqual(t("AWS/DynamoDB", { TableName: "carts", GlobalSecondaryIndexName: "by-user" }), [`arn:aws:dynamodb:${R}:${ACCT}:table/carts`]);
  assert.deepEqual(t("AWS/ApiGateway", { ApiId: "a1b2c3d4e5", Stage: "$default" }), [`arn:aws:apigateway:${R}::/apis/a1b2c3d4e5`]);
  assert.deepEqual(t("AWS/ApiGateway", { ApiName: "partners", Stage: "prod" }, { ...m, restApis: { partners: ["p9q8r7s6t5"] } }), [`arn:aws:apigateway:${R}::/restapis/p9q8r7s6t5`]);
  assert.deepEqual(t("AWS/ApiGateway", { ApiName: "partners" }, { ...m, restApis: { partners: ["a", "b"] } }), [], "two REST APIs share the name: no guess");
  assert.deepEqual(t("AWS/ApiGateway", { ApiName: "partners" }), [], "names not looked up: no guess");
  assert.deepEqual(t("AWS/ApiGateway", { ApiName: "constructor" }, { ...m, restApis: {} }), [], "own properties only");
  assert.deepEqual(t("AWS/NATGateway", { NatGatewayId: "nat-1" }), [`arn:aws:ec2:${R}:${ACCT}:natgateway/nat-1`]);
  assert.deepEqual(t("AWS/CloudFront", { DistributionId: "E2ACME1SHOP", Region: "Global" }), [`arn:aws:cloudfront::${ACCT}:distribution/E2ACME1SHOP`]);
  assert.deepEqual(t("AWS/States", { StateMachineArn: `arn:aws:states:${R}:${ACCT}:stateMachine:checkout` }), [`arn:aws:states:${R}:${ACCT}:stateMachine:checkout`]);
  assert.deepEqual(t("AWS/Kinesis", { StreamName: "clicks" }), [`arn:aws:kinesis:${R}:${ACCT}:stream/clicks`]);
  assert.deepEqual(t("AWS/Firehose", { DeliveryStreamName: "to-s3" }), [`arn:aws:firehose:${R}:${ACCT}:deliverystream/to-s3`]);
  assert.deepEqual(t("AWS/EFS", { FileSystemId: "fs-1" }), [`arn:aws:elasticfilesystem:${R}:${ACCT}:file-system/fs-1`]);
  assert.deepEqual(t("AWS/ES", { DomainName: "search", ClientId: "210987654321" }), [`arn:aws:es:${R}:210987654321:domain/search`]);
  assert.deepEqual(t("AWS/Logs", { LogGroupName: "/ecs/acme-production/api" }), [`arn:aws:logs:${R}:${ACCT}:log-group:/ecs/acme-production/api`]);
  assert.deepEqual(t("AWS/Events", { RuleName: "nightly" }), [`arn:aws:events:${R}:${ACCT}:rule/nightly`]);
  assert.deepEqual(t("AWS/Events", { RuleName: "placed", EventBusName: "shop" }), [`arn:aws:events:${R}:${ACCT}:rule/shop/placed`]);
  assert.deepEqual(t("AWS/S3", { BucketName: "acme-logs", StorageType: "StandardStorage" }), ["arn:aws:s3:::acme-logs"]);
  assert.deepEqual(t("AWS/Route53", { HealthCheckId: "hc-1" }), ["arn:aws:route53:::healthcheck/hc-1"]);
  assert.deepEqual(t("AWS/Redshift", { ClusterIdentifier: "dw" }), [`arn:aws:redshift:${R}:${ACCT}:cluster:dw`]);
  assert.deepEqual(t("CloudWatchSynthetics", { CanaryName: "checkout" }), [`arn:aws:synthetics:${R}:${ACCT}:canary:checkout`]);
  assert.deepEqual(t("AWS/MemoryDB", { ClusterName: "limits" }), [`arn:aws:memorydb:${R}:${ACCT}:cluster/limits`]);
  assert.deepEqual(t("Glue", { JobName: "etl", JobRunId: "ALL", Type: "count" }), [`arn:aws:glue:${R}:${ACCT}:job/etl`]);
  assert.deepEqual(t("Glue", { JobName: "ALL" }), []);
  assert.deepEqual(t("Acme/Custom", { Service: "checkout" }), [], "custom namespaces watch nothing on the map");
  assert.deepEqual(t("AWS/Lambda", { FunctionName: "x" }, { region: "cn-north-1", account: ACCT }), [`arn:aws-cn:lambda:cn-north-1:${ACCT}:function:x`], "partition from the region");
});

test("scaling policies: Application Auto Scaling resources, and only autoScalingGroupName is an Auto Scaling group", () => {
  const p = (res: string, region = R) => `arn:aws:autoscaling:${region}:${ACCT}:scalingPolicy:0abc-123:${res}:policyName/p1`;
  const s = (arn: string, ctx: MapContext = m) => scalingTarget(arn, ctx)?.ref;
  assert.equal(s(p("resource/ecs/service/acme-production/api")), keys.ecsService("acme-production", "api"));
  assert.equal(s(p("resource/ecs/service/acme-production/api", EU)), "ecs:service/acme-production/api@eu-west-1", "the policy's own region");
  assert.equal(s(p("resource/dynamodb/table/carts")), `arn:aws:dynamodb:${R}:${ACCT}:table/carts`);
  assert.equal(s(p("resource/dynamodb/table/carts/index/by-user")), `arn:aws:dynamodb:${R}:${ACCT}:table/carts`);
  assert.equal(s(p("resource/lambda/function:orders:live")), `arn:aws:lambda:${R}:${ACCT}:function:orders`);
  assert.equal(s(p("resource/rds/cluster:analytics")), `arn:aws:rds:${R}:${ACCT}:cluster:analytics`);
  assert.equal(s(p("resource/elasticache/replication-group/valkey")), `arn:aws:elasticache:${R}:${ACCT}:replicationgroup:valkey`);
  assert.equal(s(p("autoScalingGroupName/ecs-hosts")), `arn:aws:autoscaling:${R}:${ACCT}:autoScalingGroup:*:autoScalingGroupName/ecs-hosts`);
  assert.equal(s(p("resource/sagemaker/endpoint/recs/variant/AllTraffic")), undefined);
  assert.equal(s(topic), undefined);
  assert.deepEqual([actionClass(apiPolicy), actionClass(topic), actionClass(`arn:aws:lambda:${R}:${ACCT}:function:f:live`), actionClass(`arn:aws:automate:${R}:ec2:stop`), actionClass(`arn:aws:ssm:${R}:${ACCT}:opsitem:3`)], ["scaling", "sns", "lambda", "ec2", "ssm"]);
});

test("health: insufficient data warns after a day on an alarm with actions; disabled actions warn; ALARM stays an error", () => {
  const base: RawMetricAlarm = { AlarmName: "a", StateValue: "INSUFFICIENT_DATA", ActionsEnabled: true, AlarmActions: [topic] };
  assert.deepEqual(alarmHealth({ ...base, StateTransitionedTimestamp: new Date(NOW - 3 * 3_600_000) }, false, NOW), { health: "unknown", reason: "insufficient data" });
  assert.deepEqual(alarmHealth({ ...base, StateTransitionedTimestamp: new Date(NOW - 41 * DAY) }, false, NOW), { health: "warning", reason: "no data for 41 days — its actions can't fire" });
  assert.deepEqual(alarmHealth({ ...base, AlarmActions: [], StateTransitionedTimestamp: new Date(NOW - 41 * DAY) }, false, NOW), { health: "unknown", reason: "insufficient data" });
  assert.deepEqual(alarmHealth({ ...base, StateValue: "OK", ActionsEnabled: false }, false, NOW), { health: "warning", reason: "actions disabled — it notifies no one" });
  assert.equal(alarmHealth({ ...base, StateValue: "ALARM", ActionsEnabled: false }, false, NOW).health, "error");
  assert.deepEqual(alarmHealth({ ...base, StateValue: "OK" }, false, NOW), { health: "ok" });
  assert.deepEqual(alarmHealth({ ...base, StateValue: "INSUFFICIENT_DATA", StateTransitionedTimestamp: new Date(NOW - 41 * DAY) }, true, NOW), { health: "ok" }, "scaling alarms are always ok");
  // EvaluationState: EVALUATION_ERROR means the alarm can't be evaluated as configured (it can never fire).
  assert.deepEqual(alarmHealth({ ...base, StateValue: "INSUFFICIENT_DATA", EvaluationState: "EVALUATION_ERROR" }, false, NOW), { health: "warning", reason: "insufficient data · evaluation error — CloudWatch can't evaluate it as configured" });
  assert.deepEqual(alarmHealth({ ...base, StateValue: "OK", EvaluationState: "PARTIAL_DATA" }, false, NOW), { health: "ok" }, "partial data is not an error");
});

test("metric math, anomaly detection and composite alarms", () => {
  const math: RawMetricAlarm = {
    AlarmName: "error-rate", AlarmArn: alarmArn("error-rate"), StateValue: "OK", ComparisonOperator: "GreaterThanThreshold", Threshold: 5, EvaluationPeriods: 2,
    Metrics: [
      { Id: "e", Expression: "100 * errors / requests", Label: "Error rate %", ReturnData: true },
      { Id: "errors", ReturnData: false, MetricStat: { Metric: { Namespace: "AWS/Lambda", MetricName: "Errors", Dimensions: [{ Name: "FunctionName", Value: "orders" }] }, Period: 60, Stat: "Sum" } },
      { Id: "requests", ReturnData: false, MetricStat: { Metric: { Namespace: "AWS/Lambda", MetricName: "Invocations", Dimensions: [{ Name: "FunctionName", Value: "orders" }] }, Period: 60, Stat: "Sum" } },
      { Id: "remote", ReturnData: false, AccountId: "210987654321", MetricStat: { Metric: { Namespace: "AWS/SQS", MetricName: "NumberOfMessagesSent", Dimensions: [{ Name: "QueueName", Value: "partner" }] }, Period: 60, Stat: "Sum" } },
    ],
  };
  assert.equal(conditionOf(math), "Error rate % > 5");
  const anomaly: RawMetricAlarm = { AlarmName: "latency", ComparisonOperator: "LessThanLowerOrGreaterThanUpperThreshold", ThresholdMetricId: "ad", Metrics: [{ Id: "m", ReturnData: true, MetricStat: { Metric: { MetricName: "Latency" } } }, { Id: "ad", Expression: "ANOMALY_DETECTION_BAND(m, 2)" }] };
  assert.equal(conditionOf(anomaly), "Latency outside the expected band");
  const composite: RawCompositeAlarm = {
    AlarmName: "checkout-health", AlarmArn: alarmArn("checkout-health"), StateValue: "ALARM", ActionsEnabled: true, AlarmActions: [topic],
    AlarmRule: `ALARM("acme-production-pg-cpu-high") OR (ALARM(error-rate) AND NOT OK('x y')) OR INSUFFICIENT_DATA(${alarmArn("other", EU)})`,
  };
  assert.deepEqual(compositeChildren(composite.AlarmRule, m).map((w) => w.ref), [alarmArn("acme-production-pg-cpu-high"), alarmArn("error-rate"), alarmArn("x y"), alarmArn("other", EU)]);
  const out = alarmResults({ region: R, accountId: ACCT, home: R, now: NOW, metric: [math], composite: [composite] });
  const from = (k: string) => out.links.filter((l) => l.from === k && l.kind === "monitors").map((l) => [l.to, l.label]);
  assert.deepEqual(from(math.AlarmArn!), [[`arn:aws:lambda:${R}:${ACCT}:function:orders`, "Error rate % > 5"], ["arn:aws:sqs:us-east-1:210987654321:partner", "Error rate % > 5"]], "inputs deduplicated; a cross-account input keeps its account");
  // A cross-account ECS input is that account's service (its ARN, a foreign reference) — never the console's own
  // ecs:service key of the same cluster and service names.
  const remoteEcs: RawMetricAlarm = { ...math, AlarmName: "remote-cpu", AlarmArn: alarmArn("remote-cpu"), Metrics: [
    { Id: "own", ReturnData: false, AccountId: ACCT, MetricStat: { Metric: { Namespace: "AWS/ECS", MetricName: "CPUUtilization", Dimensions: [{ Name: "ClusterName", Value: "acme-production" }, { Name: "ServiceName", Value: "api" }] } } },
    { Id: "theirs", ReturnData: false, AccountId: "210987654321", MetricStat: { Metric: { Namespace: "AWS/ECS", MetricName: "CPUUtilization", Dimensions: [{ Name: "ClusterName", Value: "acme-production" }, { Name: "ServiceName", Value: "api" }] } } },
  ] };
  assert.deepEqual(alarmResults({ region: R, accountId: ACCT, home: R, now: NOW, metric: [remoteEcs] }).links.map((l) => l.to), [keys.ecsService("acme-production", "api"), `arn:aws:ecs:${R}:210987654321:service/acme-production/api`]);
  assert.equal(from(composite.AlarmArn!).length, 4);
  assert.ok(from(composite.AlarmArn!).every(([, l]) => l === "composite rule"));
  const c = out.resources.find((r) => r.key === composite.AlarmArn)!;
  assert.deepEqual([c.health, c.props.find((p) => p.label === "Type")?.value, c.props.some((p) => p.label === "Condition")], ["error", "composite", false]);
});

test("history rows: newest first, never the raw datapoints", () => {
  const rows = historyRows([
    { Timestamp: new Date(NOW - DAY), HistoryItemType: "StateUpdate", HistorySummary: "Alarm updated from OK to ALARM", ...({ HistoryData: SENTINEL } as object) },
    { Timestamp: new Date(NOW - MIN), HistoryItemType: "Action", HistorySummary: "Successfully executed action" },
    { Timestamp: new Date(NOW - 2 * DAY), HistoryItemType: "ConfigurationUpdate", HistorySummary: "Alarm created" },
  ]);
  assert.deepEqual(rows.map((r) => r[1]), ["action", "state", "configuration"]);
  assert.ok(!JSON.stringify(rows).includes(SENTINEL));
});

// The cloud map's pipeline over the alarms' output (infer → propagate): the references resolve to the console's
// resources, the database alarm warns its database, and the scaling AlarmLow never warns the service it scales.
test("R1 through the pipeline: the database is warned, the scaled ECS service is not; ELB and ElastiCache references resolve", () => {
  const res = (key: string, kind: Resource["kind"], name: string, o: Partial<Resource> = {}): Resource => ({ key, kind, provider: "test", name, region: R, tags: {}, health: "ok", props: [], ...o });
  const ecs: ProviderResult = {
    resources: [
      res(keys.ecsService("acme-production", "api"), "ecs-service", "api", { aliases: [`arn:aws:ecs:${R}:${ACCT}:service/acme-production/api`] }),
      res(keys.rds("acme-production-pg"), "rds", "acme-production-pg", { aliases: [`arn:aws:rds:${R}:${ACCT}:db:acme-production-pg`] }),
      res(keys.loadBalancer("acme-production"), "loadbalancer", "acme-production", { aliases: [`arn:aws:elasticloadbalancing:${R}:${ACCT}:loadbalancer/app/acme-production/5f2c1a9d3e7b4c60`] }),
      res(keys.elasticache("acme-valkey"), "elasticache", "acme-valkey", { aliases: [`arn:aws:elasticache:${R}:${ACCT}:replicationgroup:acme-valkey`, "acme-valkey-0001-001", `arn:aws:elasticache:${R}:${ACCT}:cluster:acme-valkey-0001-001`] }),
    ],
    links: [], mentions: [],
  };
  const lb5xx: RawMetricAlarm = { AlarmName: "alb-5xx", AlarmArn: alarmArn("alb-5xx"), StateValue: "ALARM", Namespace: "AWS/ApplicationELB", MetricName: "HTTPCode_ELB_5XX_Count", Dimensions: [{ Name: "LoadBalancer", Value: "app/acme-production/5f2c1a9d3e7b4c60" }], ComparisonOperator: "GreaterThanThreshold", Threshold: 1 };
  const cache: RawMetricAlarm = { AlarmName: "valkey-memory", AlarmArn: alarmArn("valkey-memory"), StateValue: "OK", Namespace: "AWS/ElastiCache", MetricName: "DatabaseMemoryUsagePercentage", Dimensions: [{ Name: "CacheClusterId", Value: "acme-valkey-0001-001" }], ComparisonOperator: "GreaterThanThreshold", Threshold: 90 };
  const alarms = alarmResults({ region: R, accountId: ACCT, home: R, now: NOW, metric: [dbCpu, tracking("High", "OK"), tracking("Low", "ALARM"), lb5xx, cache] });
  const inferred = infer({ results: [ecs, alarms], home: R, accountId: ACCT, regions: [R] });
  const edge = (from: string, to: string) => inferred.edges.some((e) => e.from === from && e.to === to && e.kind === "monitors");
  assert.ok(edge(dbCpu.AlarmArn!, keys.rds("acme-production-pg")), "the RDS ARN resolves to the console's rds: key");
  assert.ok(edge(lb5xx.AlarmArn!, keys.loadBalancer("acme-production")), "the ELB ARN resolves to the elb: key");
  assert.ok(edge(cache.AlarmArn!, keys.elasticache("acme-valkey")), "a cluster-mode node resolves through the member alias (CC-22)");
  assert.ok(edge(alarmArn("TargetTracking-service/acme-production/api-AlarmLow-0acme"), keys.ecsService("acme-production", "api")));
  const out = propagate({ resources: inferred.resources, edges: inferred.edges, home: R, now: NOW, accountId: ACCT });
  const get = (k: string) => out.resources.find((r) => r.key === k)!;
  assert.equal(get(keys.ecsService("acme-production", "api")).health, "ok", "AlarmLow in ALARM must not warn api");
  assert.deepEqual([get(keys.rds("acme-production-pg")).health, get(keys.rds("acme-production-pg")).healthReason], ["warning", "alarm acme-production-pg-cpu-high is in ALARM"]);
  assert.equal(get(keys.loadBalancer("acme-production")).health, "warning");
  assert.equal(get(keys.elasticache("acme-valkey")).health, "ok", "an OK alarm warns nothing");
});

// ---------- the simulated account (all five b-prov-observe providers, end to end) ----------
// The providers import "server-only", which resolves only under the react-server condition, so this scenario runs in a
// child process (the pattern of src/lib/server/providers/edge-mock.test.ts): the ECS, serverless and edge providers
// and logs, alarms, synthetics, CloudTrail and Glue run against the simulated Acme account in us-east-1 and eu-west-1,
// then the map's pipeline (infer → propagate) runs over all of it.
const scenario = `
const at = (p) => new URL(p, ${JSON.stringify(new URL("../server/providers/", import.meta.url).href)}).href;
const groups = await Promise.all(["ecs.ts", "compute.ts", "serverless.ts", "edge.ts", "observability.ts"].map((f) => import(at(f))));
const { glueProvider } = await import(at("glue.ts"));
const { infer } = await import(${JSON.stringify(new URL("./infer.ts", import.meta.url).href)});
const { propagate } = await import(${JSON.stringify(new URL("./propagate.ts", import.meta.url).href)});
const mine = ["logs", "alarms", "synthetics", "cloudtrail", "glue"];
const all = [...groups.flatMap((g) => g.providers), glueProvider].filter((p) => !p.enabled || p.enabled().ok);
const notes = [];
const checkpoints = {};
const ctxFor = (region, id) => ({
  region, home: "us-east-1", regions: ["us-east-1", "eu-west-1"], accountId: "123456789012", mock: true, cap: 2000, signal: new AbortController().signal,
  limit: (fn) => fn(), note: (m) => notes.push(id + ": " + m), checkpoint: (r) => { checkpoints[id] = r.resources.length; },
});
const results = [], ids = [], perRegion = {};
for (const p of all) {
  const regions = p.multiRegionMock ? ["us-east-1", "eu-west-1"] : ["us-east-1"];
  for (const region of regions) {
    const r = await p.discover(ctxFor(region, p.id));
    results.push(r); ids.push(p.id);
    if (mine.includes(p.id)) (perRegion[p.id] ??= {})[region] = r.resources.length;
  }
}
const inferred = infer({ results, providerOf: (i) => ids[i], home: "us-east-1", accountId: "123456789012", regions: ["us-east-1", "eu-west-1"] });
const out = propagate({ resources: inferred.resources, edges: inferred.edges, home: "us-east-1", accountId: "123456789012" });
const ours = out.resources.filter((r) => mine.includes(r.provider));
const oursKeys = new Set(ours.map((r) => r.key));
const pick = (r) => ({ key: r.key, name: r.name, kind: r.kind, provider: r.provider, region: r.region, health: r.health, healthReason: r.healthReason, hidden: r.hidden, facts: r.facts, tagsUnread: r.tagsUnread, tags: r.tags, lastActivityAt: r.lastActivityAt });
const byKey = Object.fromEntries(out.resources.map((r) => [r.key, r]));
const watched = ["ecs:service/acme-production/api", "rds:acme-production-pg", "ecs:service/acme-production/worker"].map((k) => byKey[k] && pick(byKey[k]));
const edges = out.edges.filter((e) => oursKeys.has(e.from) || oursKeys.has(e.to)).map((e) => ({ from: e.from, to: e.to, kind: e.kind, label: e.label, confidence: e.confidence }));
const providers = Object.fromEntries(all.filter((p) => mine.includes(p.id)).map((p) => [p.id, p]));
const details = {};
for (const id of mine) {
  for (const r of ours.filter((x) => x.provider === id).slice(0, 2)) {
    const d = await providers[id].detail(r, ctxFor(r.region === "global" ? "us-east-1" : r.region, id));
    details[r.key] = d.sections.map((s) => [s.title, s.rows?.length ?? s.table?.rows.length ?? 0, s.note ?? ""]);
  }
}
const decls = mine.map((id) => { const p = providers[id]; return { id, scope: p.scope, multiRegionMock: p.multiRegionMock, kinds: p.kinds, covers: p.covers, read: p.read, actions: (p.actions ?? []).length, activity: p.activity ? p.activity(ours.find((r) => r.provider === id && !r.hidden) ?? ours[0]) : [] }; });
console.log(JSON.stringify({ resources: ours.map(pick), watched, edges, perRegion, details, decls, notes: notes.filter((n) => mine.some((m) => n.startsWith(m + ":"))), checkpoints }));
`;

interface SimR { key: string; name: string; kind: string; provider: string; region: string; health: string; healthReason?: string; hidden?: boolean; facts?: Record<string, unknown>; tagsUnread?: boolean; tags: Record<string, string>; lastActivityAt?: number }
interface SimOut {
  resources: SimR[]; watched: (SimR | undefined)[]; edges: { from: string; to: string; kind: string; label?: string; confidence: string }[];
  perRegion: Record<string, Record<string, number>>; details: Record<string, [string, number, string][]>;
  decls: { id: string; scope: string; multiRegionMock: boolean; kinds: string[]; covers: string[]; read: string[]; actions: number; activity: { namespace: string; metric: string; required?: boolean }[] }[];
  notes: string[]; checkpoints: Record<string, number>;
}

function simulate(): SimOut {
  const dir = mkdtempSync(path.join(tmpdir(), "observe-mock-"));
  try {
    const out = execFileSync(process.execPath, ["--conditions=react-server", "--no-warnings", "--input-type=module", "-e", scenario], {
      encoding: "utf8",
      env: { ...process.env, CONSOLE_SOURCE: "mock", CLOUDFLARE_API_TOKEN: "", CONSOLE_DATA_DIR: dir, CONSOLE_SQLITE_PATH: ":memory:", CONSOLE_CONFIG: "", AUTH_MODE: "dev", NODE_ENV: "test" },
      timeout: 120_000,
      maxBuffer: 32 * 1024 * 1024,
    });
    return JSON.parse(out.trim().split("\n").pop()!) as SimOut;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("the simulated account: logs, alarms, synthetics, CloudTrail and Glue on the map, linked to the rest of Acme", () => {
  const o = simulate();
  const res = (name: string) => o.resources.find((r) => r.name === name)!;
  const edge = (from: string, to: string, kind: string) => o.edges.find((e) => e.from === from && e.to === to && e.kind === kind);
  const A = `arn:aws:cloudwatch:${R}:${ACCT}:alarm:`;
  const LG = (name: string, region = R) => `arn:aws:logs:${region}:${ACCT}:log-group:${name}`;

  // Declarations (master plan §5.0): regional, per-region mocks, read-only, IAM lists, activity only on log groups.
  for (const d of o.decls) assert.deepEqual([d.scope, d.multiRegionMock, d.actions], ["regional", true, 0], d.id);
  assert.deepEqual(Object.fromEntries(o.decls.map((d) => [d.id, d.read])), {
    logs: ["logs:DescribeLogGroups", "logs:DescribeSubscriptionFilters", "logs:ListTagsForResource", "logs:DescribeLogStreams"],
    alarms: ["cloudwatch:DescribeAlarms", "cloudwatch:ListTagsForResource", "cloudwatch:DescribeAlarmHistory", "apigateway:GET"],
    synthetics: ["synthetics:DescribeCanaries", "synthetics:DescribeCanariesLastRun"],
    cloudtrail: ["cloudtrail:DescribeTrails", "cloudtrail:GetTrailStatus", "cloudtrail:ListTags"],
    glue: ["glue:GetJobs", "glue:GetJobRuns", "glue:GetCrawlers", "glue:GetTags"],
  });
  assert.deepEqual(o.decls.find((d) => d.id === "logs")!.activity, [{ namespace: "AWS/Logs", metric: "IncomingBytes", dims: { LogGroupName: "/ecs/acme-staging/api" }, stat: "Sum", label: "Bytes written", region: R, required: true }]);
  assert.ok(o.decls.filter((d) => d.id !== "logs").every((d) => !d.activity.length));

  // Per region: us-east-1 is Acme, eu-west-1 has the eu estate's two ECS log groups, nothing else.
  assert.deepEqual(o.perRegion, {
    logs: { [R]: 26, [EU]: 2 }, alarms: { [R]: 6, [EU]: 0 }, synthetics: { [R]: 1, [EU]: 0 }, cloudtrail: { [R]: 1, [EU]: 0 }, glue: { [R]: 2, [EU]: 0 },
  });

  // Alarms: the scaling AlarmLow in ALARM doesn't warn api; the database alarm warns acme-production-pg.
  const low = o.resources.find((r) => r.name.endsWith("AlarmLow-0acme0a1-0000-4000-8000-000000000002"))!;
  assert.deepEqual([low.health, low.facts], ["ok", { alarmState: "ALARM", scaling: true }]);
  assert.equal(edge(low.key, "ecs:service/acme-production/api", "monitors")?.label, "scales");
  const [api, pg] = o.watched;
  assert.ok(!(api!.healthReason ?? "").includes("in ALARM"), `api must not be warned by its scaling alarm (${api!.healthReason})`);
  assert.deepEqual([pg!.health, pg!.healthReason?.includes("alarm acme-production-pg-cpu-high is in ALARM")], ["warning", true]);
  assert.equal(res("acme-production-pg-cpu-high").health, "error");
  assert.ok(edge(`${A}acme-production-pg-cpu-high`, "rds:acme-production-pg", "monitors"));
  assert.ok(edge(`${A}acme-production-pg-cpu-high`, `arn:aws:sns:${R}:${ACCT}:acme-alarms`, "event"), "SNS action → the acme-alarms topic");
  assert.ok(edge(`${A}acme-production-orders-dlq-not-empty`, `arn:aws:sqs:${R}:${ACCT}:acme-production-orders-dlq`, "monitors"));
  assert.ok(edge(`${A}acme-production-api-5xx`, "ecs:service/acme-production/api", "monitors"), "the target group alarm lands on the ECS service behind it");
  assert.deepEqual([res("acme-legacy-cron-cpu").health, res("acme-legacy-cron-cpu").healthReason], ["warning", "no data for 41 days — its actions can't fire"]);
  assert.ok(edge(`${A}acme-legacy-cron-cpu`, "ec2:i-0acmelegacy00002", "monitors"), "the instance's ARN resolves to the console's ec2: key");

  // Logs: ECS services (both regions) and Lambda functions write to their groups; hidden and warned groups.
  assert.ok(edge("ecs:service/acme-production/api", LG("/ecs/acme-production/api"), "logs"));
  assert.ok(edge("ecs:service/acme-staging/redis", LG("/ecs/acme-staging/redis"), "logs"));
  assert.ok(edge("ecs:service/acme-production/api@eu-west-1", LG("/ecs/acme-production-eu/api", EU), "logs"), "the home run links the eu services too (CC-19)");
  assert.equal(edge(`arn:aws:lambda:${R}:${ACCT}:function:acme-production-order-events`, LG("/aws/lambda/acme-production-order-events"), "logs")?.confidence, "config");
  assert.equal(edge("rds:acme-production-pg", LG("/aws/rds/instance/acme-production-pg/postgresql"), "logs")?.confidence, "mentioned");
  assert.ok(edge(`arn:aws:states:${R}:${ACCT}:stateMachine:acme-production-checkout`, LG("/aws/vendedlogs/states/acme-production-checkout"), "logs"), "a vended group is hidden yet resolves");
  assert.equal(res("/aws/vendedlogs/states/acme-production-checkout").hidden, true);
  assert.equal(res("/aws/ecs/containerinsights/acme-production/performance").hidden, true);
  assert.deepEqual([res("/acme/vpc/flow-logs").health, res("/acme/vpc/flow-logs").healthReason], ["warning", "never expires and holds 14.2 GB — set a retention period (storage is billed per GB-month)"]);

  // Synthetics, CloudTrail, Glue.
  const canary = res("acme-checkout-canary");
  assert.equal(canary.health, "error");
  assert.ok(canary.healthReason!.startsWith("canary failing — last run failed at "));
  assert.ok(edge(canary.key, "arn:aws:s3:::acme-logs", "writes"));
  const trail = res("acme-trail");
  assert.deepEqual([trail.health, trail.tags], ["ok", { Team: "platform" }]);
  assert.ok(edge(trail.key, LG("/acme/cloudtrail"), "logs"));
  assert.ok(edge(trail.key, "arn:aws:s3:::acme-logs", "writes"));
  const etl = res("acme-nightly-etl");
  assert.deepEqual([etl.kind, etl.health, typeof etl.lastActivityAt], ["glue-job", "ok", "number"]);
  assert.equal(edge(etl.key, "rds:acme-production-pg", "sql")?.confidence, "mentioned", "the job's database argument resolves; its value is never shown");
  assert.ok(edge(res("acme-orders-crawler").key, LG("/aws-glue/crawlers"), "logs"));

  // Every resource has its tags read (mock) and detail() answers for one of each provider.
  assert.ok(o.resources.every((r) => !r.tagsUnread), "tags read in the simulation");
  for (const [key, sections] of Object.entries(o.details)) assert.ok(sections.length > 0, `detail of ${key}`);
  assert.deepEqual(o.details[`${A}${low.name}`]?.[0]?.[0], "History");
  assert.deepEqual(o.notes, []);
});
