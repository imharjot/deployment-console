// CloudWatch alarms as the cloud map sees them, pure (audit §6 A.2 #10, CC-11, CC-22): SDK-shaped DescribeAlarms
// answers (metric and composite alarms) in; one node per alarm with its state as health and facts, and what it watches
// out. The provider (../server/providers/alarms.ts) and its simulation feed the same functions. No AWS calls.
//
// What an alarm watches comes from its metric's dimensions (the dimension mapper below, one rule per namespace), the
// inputs of a metric-math alarm, the alarms a composite rule names, and the scaling policies among its actions. Every
// target is a reference the inventory resolves region-aware: an ARN built in the alarm's own region and account (the
// load balancer of `app/<name>/<id>` is its ARN, never a guess by name; an ElastiCache node id is its member-cluster
// ARN, which the elasticache provider lists as an alias — CC-22), or the console's ECS key with its "@<region>".
//
// Scaling alarms (CC-11): target tracking creates TargetTracking-…-AlarmHigh / -AlarmLow pairs, and AlarmLow sits in
// ALARM whenever load is low. An alarm whose name starts with "TargetTracking-", or whose every action is a scaling
// policy, gets facts.scaling, health ok and "scales" links: it never warns what it scales (propagate.ts R1).
//
// Health: ALARM → error; INSUFFICIENT_DATA → unknown, or a warning once it has lasted a day on an alarm with actions;
// OK → ok; actions disabled or an evaluation error → at least a warning. Facts: alarmState, scaling.
import { arnOf, partitionOf, parseArn } from "./arn.ts";
import { arnName, clip, enrichmentOf, fmtTime, props, tagsOf } from "./serverless-common.ts";
import { keys, type EnrichState, type Facts, type Health, type Link, type ProviderResult, type Resource } from "./types.ts";

// ---------- raw shapes (the SDK's field names; dates as Date or ISO strings) ----------

type When = Date | string | number;
export interface RawDimension { Name?: string; Value?: string }
export interface RawMetric { Namespace?: string; MetricName?: string; Dimensions?: RawDimension[] }
export interface RawMetricQuery {
  Id?: string;
  MetricStat?: { Metric?: RawMetric; Period?: number; Stat?: string; Unit?: string };
  Expression?: string;
  Label?: string;
  ReturnData?: boolean;
  Period?: number;
  AccountId?: string; // cross-account observability: the metric lives in another account
}
interface RawAlarmBase {
  AlarmName?: string;
  AlarmArn?: string;
  AlarmDescription?: string;
  AlarmConfigurationUpdatedTimestamp?: When;
  ActionsEnabled?: boolean;
  OKActions?: string[];
  AlarmActions?: string[];
  InsufficientDataActions?: string[];
  StateValue?: string; // OK | ALARM | INSUFFICIENT_DATA
  StateReason?: string;
  StateUpdatedTimestamp?: When;
  StateTransitionedTimestamp?: When;
  EvaluationState?: string; // EVALUATION_ERROR (its configuration needs fixing) | EVALUATION_FAILURE | PARTIAL_DATA
}
export interface RawMetricAlarm extends RawAlarmBase {
  MetricName?: string;
  Namespace?: string;
  Statistic?: string;
  ExtendedStatistic?: string;
  Dimensions?: RawDimension[];
  Period?: number;
  EvaluationPeriods?: number;
  DatapointsToAlarm?: number;
  Threshold?: number;
  ComparisonOperator?: string;
  TreatMissingData?: string;
  Metrics?: RawMetricQuery[];
  ThresholdMetricId?: string;
}
export interface RawCompositeAlarm extends RawAlarmBase {
  AlarmRule?: string;
}

// ---------- small helpers ----------

const DAY = 86_400_000;
const ms = (v: When | undefined): number | undefined => {
  if (v === undefined || v === null || v === "") return undefined;
  const t = v instanceof Date ? v.getTime() : typeof v === "number" ? v : Date.parse(v);
  return Number.isFinite(t) ? t : undefined;
};
const num = (n: number | undefined) => (n === undefined || !Number.isFinite(n) ? "?" : n.toLocaleString("en-US", { maximumFractionDigits: 4 }));
const period = (s: number | undefined) => (!s ? undefined : s < 60 ? `${s} s` : s % 3600 === 0 ? `${s / 3600} h` : `${+(s / 60).toFixed(1)} min`);
const dimsOf = (d: RawDimension[] | undefined): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const x of d ?? []) if (x.Name && x.Value !== undefined) out[x.Name] = x.Value;
  return out;
};
const dimsText = (d: RawDimension[] | undefined) => (d ?? []).filter((x) => x.Name).map((x) => `${x.Name}=${x.Value ?? ""}`).join(", ");

// ---------- the dimension mapper ----------

// Where the alarm lives and what the map knows that dimensions alone don't.
export interface MapContext {
  region: string; // the alarm's region
  account?: string; // the account the metric belongs to (the alarm's, unless a cross-account query names another)
  foreign?: boolean; // the metric belongs to another account (cross-account metric math): ARNs only, never console keys
  home?: string; // the console's home region: ECS keys outside it get "@<region>"
  targetGroups?: Record<string, string>; // target group ARN → key of the ECS service it serves
  restApis?: Record<string, string[]>; // REST API name → its ids in the alarm's region (AWS/ApiGateway ApiName)
}

// One thing an alarm watches: a reference the inventory resolves (key or ARN), and what it is, for the evidence.
export interface Watched { ref: string; what: string }

const regionalArn = (m: MapContext, service: string, resource: string) => (m.account ? `arn:${partitionOf(m.region)}:${service}:${m.region}:${m.account}:${resource}` : undefined);
const one = (ref: string | undefined, what: string): Watched[] => (ref ? [{ ref, what }] : []);

// The console's key of an ECS service in the alarm's region ("ecs:service/c/s@eu-west-1" outside home); its ARN when the
// home region isn't known (ECS services list their ARN as an alias) or the metric is another account's (a foreign
// reference, R14 — never the console's own service of the same name).
function ecsService(cluster: string, service: string, m: MapContext): string {
  if (m.foreign && m.account) return arnOf.ecsService(m.region, m.account, cluster, service);
  if (m.home) return keys.ecsService(cluster, service, m.region, m.home);
  return m.account ? arnOf.ecsService(m.region, m.account, cluster, service) : keys.ecsService(cluster, service);
}

// An Auto Scaling group by name. Its ARN carries a UUID no alarm or scaling policy names, so this is the IAM-style
// pattern "autoScalingGroup:*:autoScalingGroupName/<name>", resolved by name within the alarm's region and account.
export const asgRef = (m: MapContext, name: string) => regionalArn(m, "autoscaling", `autoScalingGroup:*:autoScalingGroupName/${name}`);

// What one metric (namespace + dimensions) is about. Unknown namespaces and dimension sets watch nothing on the map.
export function dimensionTargets(namespace: string | undefined, dimensions: RawDimension[] | undefined, m: MapContext): Watched[] {
  const d = dimsOf(dimensions);
  const has = (k: string) => Object.hasOwn(d, k) && !!d[k] && d[k] !== "ALL";
  switch (namespace) {
    case "AWS/ECS":
    case "ECS/ContainerInsights":
      return has("ClusterName") && has("ServiceName") ? one(ecsService(d.ClusterName, d.ServiceName, m), `ECS service ${d.ClusterName}/${d.ServiceName}`) : [];
    case "AWS/ApplicationELB":
    case "AWS/NetworkELB":
    case "AWS/GatewayELB": {
      if (has("TargetGroup") && /^targetgroup\/[^/]+\/[0-9a-f]+$/.test(d.TargetGroup)) {
        const tg = regionalArn(m, "elasticloadbalancing", d.TargetGroup);
        const svc = tg ? m.targetGroups?.[tg] : undefined;
        if (svc) return [{ ref: svc, what: `target group ${d.TargetGroup.split("/")[1]} (its ECS service)` }];
      }
      if (has("LoadBalancer") && /^(app|net|gwy)\/[^/]+\/[0-9a-f]+$/.test(d.LoadBalancer))
        return one(regionalArn(m, "elasticloadbalancing", `loadbalancer/${d.LoadBalancer}`), `load balancer ${d.LoadBalancer.split("/")[1]}`);
      return [];
    }
    case "AWS/ELB":
      return has("LoadBalancerName") && m.account ? one(arnOf.classicElb(m.region, m.account, d.LoadBalancerName), `classic load balancer ${d.LoadBalancerName}`) : [];
    case "AWS/RDS":
    case "AWS/DocDB":
    case "AWS/Neptune":
      if (!m.account) return [];
      if (has("DBInstanceIdentifier")) return one(arnOf.rdsDb(m.region, m.account, d.DBInstanceIdentifier), `database instance ${d.DBInstanceIdentifier}`);
      if (has("DBClusterIdentifier")) return one(arnOf.rdsCluster(m.region, m.account, d.DBClusterIdentifier), `database cluster ${d.DBClusterIdentifier}`);
      return [];
    case "AWS/ElastiCache":
      // A node id ("<rg>-001", "<rg>-0001-001" in cluster mode) resolves through the member-cluster ARNs the elasticache
      // provider lists as aliases — never by stripping suffixes (CC-22).
      if (!m.account) return [];
      if (has("CacheClusterId")) return one(arnOf.elasticacheCluster(m.region, m.account, d.CacheClusterId), `ElastiCache node group ${d.CacheClusterId}`);
      if (has("ReplicationGroupId")) return one(arnOf.elasticacheRg(m.region, m.account, d.ReplicationGroupId), `ElastiCache replication group ${d.ReplicationGroupId}`);
      return [];
    case "AWS/EC2":
      if (has("InstanceId") && m.account) return one(arnOf.ec2Instance(m.region, m.account, d.InstanceId), `EC2 instance ${d.InstanceId}`);
      if (has("AutoScalingGroupName")) return one(asgRef(m, d.AutoScalingGroupName), `Auto Scaling group ${d.AutoScalingGroupName}`);
      return [];
    case "AWS/AutoScaling":
      return has("AutoScalingGroupName") ? one(asgRef(m, d.AutoScalingGroupName), `Auto Scaling group ${d.AutoScalingGroupName}`) : [];
    case "AWS/EBS":
      return has("VolumeId") && m.account ? one(arnOf.ebsVolume(m.region, m.account, d.VolumeId), `EBS volume ${d.VolumeId}`) : [];
    case "AWS/Lambda":
      return has("FunctionName") ? one(regionalArn(m, "lambda", `function:${d.FunctionName.split(":")[0]}`), `Lambda function ${d.FunctionName}`) : [];
    case "AWS/SQS":
      return has("QueueName") ? one(regionalArn(m, "sqs", d.QueueName), `SQS queue ${d.QueueName}`) : [];
    case "AWS/SNS":
      return has("TopicName") ? one(regionalArn(m, "sns", d.TopicName), `SNS topic ${d.TopicName}`) : [];
    case "AWS/DynamoDB":
      return has("TableName") ? one(regionalArn(m, "dynamodb", `table/${d.TableName}`), `DynamoDB table ${d.TableName}`) : [];
    case "AWS/ApiGateway": {
      const p = partitionOf(m.region);
      if (has("ApiId")) return [{ ref: `arn:${p}:apigateway:${m.region}::/apis/${d.ApiId}`, what: `API ${d.ApiId}` }];
      // REST APIs are named in metrics; only a name that is unique in the alarm's region becomes a link.
      const ids = has("ApiName") ? (m.restApis && Object.hasOwn(m.restApis, d.ApiName) ? m.restApis[d.ApiName] : []) : [];
      return ids.length === 1 ? [{ ref: `arn:${p}:apigateway:${m.region}::/restapis/${ids[0]}`, what: `API ${d.ApiName}` }] : [];
    }
    case "AWS/NATGateway":
      return has("NatGatewayId") && m.account ? one(arnOf.natGateway(m.region, m.account, d.NatGatewayId), `NAT gateway ${d.NatGatewayId}`) : [];
    case "AWS/CloudFront":
      return has("DistributionId") && m.account ? [{ ref: `arn:${partitionOf(m.region)}:cloudfront::${m.account}:distribution/${d.DistributionId}`, what: `CloudFront distribution ${d.DistributionId}` }] : [];
    case "AWS/States":
      return has("StateMachineArn") && d.StateMachineArn.startsWith("arn:") ? [{ ref: d.StateMachineArn, what: `state machine ${arnName(d.StateMachineArn)}` }] : [];
    case "AWS/Kinesis":
      return has("StreamName") ? one(regionalArn(m, "kinesis", `stream/${d.StreamName}`), `Kinesis stream ${d.StreamName}`) : [];
    case "AWS/Firehose":
      return has("DeliveryStreamName") && m.account ? one(arnOf.firehose(m.region, m.account, d.DeliveryStreamName), `Firehose stream ${d.DeliveryStreamName}`) : [];
    case "AWS/EFS":
      return has("FileSystemId") && m.account ? one(arnOf.efs(m.region, m.account, d.FileSystemId), `file system ${d.FileSystemId}`) : [];
    case "AWS/ES": {
      const acct = has("ClientId") && /^\d{12}$/.test(d.ClientId) ? d.ClientId : m.account;
      return has("DomainName") && acct ? one(arnOf.opensearchDomain(m.region, acct, d.DomainName), `OpenSearch domain ${d.DomainName}`) : [];
    }
    case "AWS/Logs":
      return has("LogGroupName") && m.account ? one(arnOf.logGroup(m.region, m.account, d.LogGroupName), `log group ${d.LogGroupName}`) : [];
    case "AWS/Events": {
      if (!has("RuleName")) return [];
      const bus = has("EventBusName") && d.EventBusName !== "default" ? `${d.EventBusName}/` : "";
      return one(regionalArn(m, "events", `rule/${bus}${d.RuleName}`), `EventBridge rule ${d.RuleName}`);
    }
    case "AWS/S3":
      return has("BucketName") ? [{ ref: `arn:${partitionOf(m.region)}:s3:::${d.BucketName}`, what: `S3 bucket ${d.BucketName}` }] : [];
    case "AWS/Route53":
      return has("HealthCheckId") ? [{ ref: arnOf.healthCheck(d.HealthCheckId, partitionOf(m.region)), what: `health check ${d.HealthCheckId}` }] : [];
    case "AWS/Redshift":
      return has("ClusterIdentifier") && m.account ? one(arnOf.redshiftCluster(m.region, m.account, d.ClusterIdentifier), `Redshift cluster ${d.ClusterIdentifier}`) : [];
    case "CloudWatchSynthetics":
      return has("CanaryName") && m.account ? one(arnOf.syntheticsCanary(m.region, m.account, d.CanaryName), `canary ${d.CanaryName}`) : [];
    case "AWS/MemoryDB":
      return has("ClusterName") && m.account ? one(arnOf.memorydbCluster(m.region, m.account, d.ClusterName), `MemoryDB cluster ${d.ClusterName}`) : [];
    case "Glue":
      return has("JobName") && m.account ? one(arnOf.glueJob(m.region, m.account, d.JobName), `Glue job ${d.JobName}`) : [];
    default:
      return [];
  }
}

// ---------- scaling policies (CC-11) ----------

const SCALING_POLICY = /^arn:aws[\w-]*:autoscaling:[^:]*:\d*:scalingPolicy:/;
export const isScalingPolicy = (arn: string) => SCALING_POLICY.test(arn);

// What a scaling policy scales. Application Auto Scaling policies name "resource/<namespace>/<resource id>"; only EC2
// Auto Scaling's "autoScalingGroupName/<name>" is an Auto Scaling group.
export function scalingTarget(policyArn: string, m: MapContext): Watched | undefined {
  const p = /^arn:aws[\w-]*:autoscaling:([^:]*):(\d*):scalingPolicy:[^:]+:(.+?):policyName\/.+$/.exec(policyArn);
  if (!p) return undefined;
  const at: MapContext = { ...m, region: p[1] || m.region, account: p[2] || m.account };
  const res = p[3];
  let x: RegExpExecArray | null;
  if ((x = /^resource\/ecs\/service\/([^/]+)\/([^/]+)$/.exec(res))) return { ref: ecsService(x[1], x[2], at), what: `ECS service ${x[1]}/${x[2]}` };
  if ((x = /^resource\/dynamodb\/table\/([^/]+)(?:\/index\/.+)?$/.exec(res))) return one(regionalArn(at, "dynamodb", `table/${x[1]}`), `DynamoDB table ${x[1]}`)[0];
  if ((x = /^resource\/lambda\/function:([^:]+)(?::.+)?$/.exec(res))) return one(regionalArn(at, "lambda", `function:${x[1]}`), `Lambda function ${x[1]}`)[0];
  if ((x = /^resource\/rds\/cluster:(.+)$/.exec(res)) && at.account) return { ref: arnOf.rdsCluster(at.region, at.account, x[1]), what: `database cluster ${x[1]}` };
  if ((x = /^resource\/elasticache\/replication-group\/(.+)$/.exec(res)) && at.account) return { ref: arnOf.elasticacheRg(at.region, at.account, x[1]), what: `ElastiCache replication group ${x[1]}` };
  if ((x = /^autoScalingGroupName\/(.+)$/.exec(res))) return one(asgRef(at, x[1]), `Auto Scaling group ${x[1]}`)[0];
  return undefined;
}

const actionsOf = (a: RawAlarmBase) => [...(a.AlarmActions ?? []), ...(a.OKActions ?? []), ...(a.InsufficientDataActions ?? [])].filter(Boolean);

// A scaling alarm: target tracking's own (by name), or one whose every action is a scaling policy.
export function isScalingAlarm(a: RawAlarmBase): boolean {
  if ((a.AlarmName ?? "").startsWith("TargetTracking-")) return true;
  const acts = actionsOf(a);
  return acts.length > 0 && acts.every(isScalingPolicy);
}

// ---------- conditions ----------

const OPS: Record<string, string> = {
  GreaterThanOrEqualToThreshold: "≥", GreaterThanThreshold: ">", LessThanThreshold: "<", LessThanOrEqualToThreshold: "≤",
  LessThanLowerOrGreaterThanUpperThreshold: "outside the expected band", LessThanLowerThreshold: "below the expected band", GreaterThanUpperThreshold: "above the expected band",
};

// The metric an alarm evaluates, as people read it: "CPUUtilization", or a math expression's label.
function metricLabel(a: RawMetricAlarm): string {
  if (a.MetricName) return a.MetricName;
  const q = (a.Metrics ?? []).filter((x) => x.Id !== a.ThresholdMetricId);
  const shown = q.find((x) => x.ReturnData !== false) ?? q[0];
  return clip(shown?.Label || shown?.MetricStat?.Metric?.MetricName || shown?.Expression || "metric math", 60);
}

// "CPUUtilization > 80" — the threshold sentence (link labels, props).
export function conditionOf(a: RawMetricAlarm): string {
  const op = OPS[a.ComparisonOperator ?? ""] ?? a.ComparisonOperator ?? "?";
  return a.ThresholdMetricId ? `${metricLabel(a)} ${op}` : `${metricLabel(a)} ${op} ${num(a.Threshold)}`;
}

// "3 of 3 datapoints × 5 min (Average)".
function windowOf(a: RawMetricAlarm): string | undefined {
  if (!a.EvaluationPeriods) return undefined;
  const p = period(a.Period ?? a.Metrics?.find((x) => x.ReturnData !== false)?.MetricStat?.Period ?? a.Metrics?.find((x) => x.ReturnData !== false)?.Period);
  const stat = a.ExtendedStatistic ?? a.Statistic;
  return `${a.DatapointsToAlarm ?? a.EvaluationPeriods} of ${a.EvaluationPeriods} datapoints${p ? ` × ${p}` : ""}${stat ? ` (${stat})` : ""}`;
}

// The alarms a composite rule names: ALARM("x"), OK(x), INSUFFICIENT_DATA(arn:…), in the composite's region.
export function compositeChildren(rule: string | undefined, m: MapContext): Watched[] {
  const out = new Map<string, Watched>();
  for (const x of (rule ?? "").matchAll(/\b(ALARM|OK|INSUFFICIENT_DATA)\s*\(\s*(?:"([^"]+)"|'([^']+)'|([^)\s]+))\s*\)/g)) {
    const name = (x[2] ?? x[3] ?? x[4] ?? "").trim();
    if (!name) continue;
    const ref = name.startsWith("arn:") ? name : m.account ? arnOf.cloudwatchAlarm(m.region, m.account, name) : undefined;
    if (ref && !out.has(ref)) out.set(ref, { ref, what: `alarm ${name.startsWith("arn:") ? arnName(name) : name} (${x[1]} in the rule)` });
  }
  return [...out.values()];
}

// ---------- actions ----------

type ActionClass = "sns" | "scaling" | "lambda" | "ec2" | "ssm" | "other";
export function actionClass(arn: string): ActionClass {
  if (isScalingPolicy(arn)) return "scaling";
  const svc = parseArn(arn)?.service;
  if (svc === "sns") return "sns";
  if (svc === "lambda") return "lambda";
  if (/^arn:aws[\w-]*:automate:/.test(arn) || /:swf:[^:]*:\d*:action\/actions\/AWS_EC2\./.test(arn)) return "ec2"; // "arn:aws:automate:<r>:ec2:stop"
  if (svc === "ssm" || svc === "ssm-incidents") return "ssm";
  return "other";
}

function actionText(arn: string): string {
  switch (actionClass(arn)) {
    case "sns": return `notify ${arnName(arn)} (SNS)`;
    case "scaling": return `scale (${/policyName\/(.+)$/.exec(arn)?.[1] ?? "policy"})`;
    case "lambda": return `invoke ${parseArn(arn)?.resource.split(":")[1] ?? arnName(arn)} (Lambda)`;
    case "ec2": return `EC2 ${arnName(arn).replace(/^AWS_EC2\.InstanceId\./i, "").replace(/\/.*$/, "").toLowerCase()}`;
    case "ssm": return parseArn(arn)?.service === "ssm-incidents" ? "start an incident (Incident Manager)" : "create an OpsItem (Systems Manager)";
    default: return arnName(arn) || arn;
  }
}

// Notification and invoke links: SNS topics get an event "on ALARM" (and "on OK" …), Lambda functions an invoke.
function actionLinks(key: string, a: RawAlarmBase): Link[] {
  const by = new Map<string, { kind: "event" | "invoke"; states: string[] }>();
  const add = (list: string[] | undefined, state: string) => {
    for (const arn of list ?? []) {
      const c = actionClass(arn);
      if (c !== "sns" && c !== "lambda") continue;
      const to = c === "lambda" ? arn.split(":").slice(0, 7).join(":") : arn;
      const x = by.get(to) ?? { kind: c === "sns" ? "event" as const : "invoke" as const, states: [] };
      if (!x.states.includes(state)) x.states.push(state);
      by.set(to, x);
    }
  };
  add(a.AlarmActions, "ALARM");
  add(a.OKActions, "OK");
  add(a.InsufficientDataActions, "INSUFFICIENT_DATA");
  return [...by].map(([to, x]) => ({ from: key, to, kind: x.kind, label: `on ${x.states.join(", ")}`, evidence: `alarm actions (${x.states.join(", ")})` }));
}

// ---------- health ----------

export function alarmHealth(a: RawAlarmBase, scaling: boolean, now: number): { health: Health; reason?: string } {
  const state = (a.StateValue ?? "").toUpperCase();
  const since = ms(a.StateTransitionedTimestamp) ?? ms(a.StateUpdatedTimestamp);
  if (scaling) return state === "ALARM" ? { health: "ok", reason: "scaling alarm — ALARM starts a scaling action, not an incident" } : { health: "ok" };
  let health: Health = "ok";
  const why: string[] = [];
  if (state === "ALARM") {
    health = "error";
    why.push(`in ALARM${since ? ` since ${fmtTime(since)}` : ""}${a.StateReason ? `: ${clip(a.StateReason, 140)}` : ""}`);
  } else if (state === "INSUFFICIENT_DATA") {
    const days = since !== undefined ? Math.floor((now - since) / DAY) : undefined;
    if (actionsOf(a).length && days !== undefined && days >= 1) {
      health = "warning";
      why.push(`no data for ${days === 1 ? "a day" : `${days} days`} — its actions can't fire`);
    } else {
      health = "unknown";
      why.push("insufficient data");
    }
  } else if (state !== "OK") {
    health = "unknown";
    why.push(state ? `state ${state}` : "state not reported");
  }
  // CloudWatch couldn't evaluate the alarm because of how it is set up (Metrics Insights queries): it can't fire.
  if ((a.EvaluationState ?? "").toUpperCase() === "EVALUATION_ERROR") {
    if (health !== "error") health = "warning";
    why.push("evaluation error — CloudWatch can't evaluate it as configured");
  }
  if (a.ActionsEnabled === false) {
    if (health !== "error") health = "warning";
    why.push("actions disabled — it notifies no one");
  }
  return { health, ...(why.length ? { reason: why.join(" · ") } : {}) };
}

// ---------- the alarms as map resources ----------

export interface AlarmsInput {
  region: string;
  accountId?: string;
  home?: string;
  now: number;
  metric: RawMetricAlarm[];
  composite?: RawCompositeAlarm[];
  // Tags by alarm ARN; a missing entry = not read (tagsUnread). tagState: how each read went (enrichment.tags).
  tags?: Record<string, Record<string, string> | undefined>;
  tagState?: Record<string, EnrichState>;
  targetGroups?: MapContext["targetGroups"];
  restApis?: MapContext["restApis"];
}

const consoleUrl = (region: string, name: string) =>
  `https://${region}.console.aws.amazon.com/cloudwatch/home?region=${region}#alarmsV2:alarm/${encodeURIComponent(name)}`;

const typeOf = (a: RawMetricAlarm): string => (a.ThresholdMetricId ? "anomaly detection" : a.Metrics?.length ? "metric math" : "metric");

export function alarmResults(i: AlarmsInput): ProviderResult {
  const resources: Resource[] = [];
  const links: Link[] = [];
  const composites = new Set<RawAlarmBase>(i.composite ?? []);
  for (const a of [...i.metric, ...(i.composite ?? [])] as (RawMetricAlarm | RawCompositeAlarm)[]) {
    const name = a.AlarmName;
    if (!name) continue;
    const parsed = a.AlarmArn ? parseArn(a.AlarmArn) : undefined;
    const region = parsed?.region || i.region;
    const account = parsed?.account || i.accountId;
    const key = a.AlarmArn || (account ? arnOf.cloudwatchAlarm(region, account, name) : undefined);
    if (!key) continue;
    const m: MapContext = { region, account, home: i.home, targetGroups: i.targetGroups, restApis: i.restApis };
    const scaling = isScalingAlarm(a);
    const metricAlarm = a as RawMetricAlarm;
    const composite = composites.has(a) ? (a as RawCompositeAlarm) : undefined;
    const condition = composite ? undefined : conditionOf(metricAlarm);

    // What it watches: its metric, or every input of its math, or the alarms its rule names; then the scaling targets.
    const watched = new Map<string, { what: string; scales: boolean; via: string }>();
    const watch = (w: Watched | undefined, scales: boolean, via: string) => {
      if (!w) return;
      const had = watched.get(w.ref);
      if (!had) watched.set(w.ref, { what: w.what, scales, via });
      else if (scales && !had.scales) had.scales = true;
    };
    if (composite) for (const w of compositeChildren(composite.AlarmRule, m)) watch(w, false, "composite alarm rule");
    else {
      for (const w of dimensionTargets(metricAlarm.Namespace, metricAlarm.Dimensions, m)) watch(w, scaling, `alarm metric ${metricAlarm.Namespace} ${metricAlarm.MetricName ?? ""} {${dimsText(metricAlarm.Dimensions)}}`.replace(/ +/g, " "));
      for (const q of metricAlarm.Metrics ?? []) {
        const met = q.MetricStat?.Metric;
        if (!met) continue;
        const mq = q.AccountId && /^\d{12}$/.test(q.AccountId) && q.AccountId !== account ? { ...m, account: q.AccountId, foreign: true } : m;
        for (const w of dimensionTargets(met.Namespace, met.Dimensions, mq)) watch(w, scaling, `alarm metric math input ${q.Id ?? ""}: ${met.Namespace} ${met.MetricName ?? ""} {${dimsText(met.Dimensions)}}`.replace(/ +/g, " "));
      }
    }
    for (const arn of actionsOf(a).filter(isScalingPolicy)) watch(scalingTarget(arn, m), true, `scaling policy ${/policyName\/(.+)$/.exec(arn)?.[1] ?? arnName(arn)} in the alarm's actions`);
    for (const [ref, w] of watched) {
      // A non-scaling alarm keeps its threshold label for what its metric names (R1 reads it); a scaling one says "scales".
      const scales = scaling || (w.scales && !w.via.startsWith("alarm metric"));
      links.push({ from: key, to: ref, kind: "monitors", label: scales ? "scales" : composite ? "composite rule" : condition, evidence: `${w.via} → ${w.what}` });
    }
    links.push(...actionLinks(key, a));

    const h = alarmHealth(a, scaling, i.now);
    const state = (a.StateValue ?? "").toUpperCase();
    const since = ms(a.StateTransitionedTimestamp) ?? ms(a.StateUpdatedTimestamp);
    const facts: Facts = { alarmState: state || "UNKNOWN", ...(scaling ? { scaling: true } : {}) };
    const tagsRead = i.tags && Object.hasOwn(i.tags, key) ? i.tags[key] : undefined;
    const enrichment = enrichmentOf({ tags: i.tagState?.[key] ?? (tagsRead ? "ok" : undefined) });
    const actionRows = ([["ALARM", a.AlarmActions], ["OK", a.OKActions], ["INSUFFICIENT_DATA", a.InsufficientDataActions]] as const)
      .filter(([, l]) => l?.length)
      .map(([s, l]) => `${s} → ${l!.map(actionText).join(", ")}`);
    const metricText = composite ? undefined
      : metricAlarm.MetricName ? `${metricAlarm.Namespace ?? "?"} ${metricAlarm.MetricName}`
        : `${metricAlarm.Metrics?.length ?? 0} metrics combined`;
    resources.push({
      key, kind: "cloudwatch-alarm", provider: "alarms", name, region, ...tagsOf(tagsRead),
      health: h.health, ...(h.reason ? { healthReason: h.reason } : {}),
      props: props([
        { label: "State", value: state ? `${state}${since ? ` since ${fmtTime(since)}` : ""}` : undefined },
        { label: "Type", value: composite ? "composite" : typeOf(metricAlarm) },
        scaling && { label: "Scaling", value: "yes — Auto Scaling owns it; ALARM means scale out or in, not an incident" },
        { label: "Metric", value: metricText },
        { label: "Condition", value: condition ? [condition, windowOf(metricAlarm)].filter(Boolean).join(" · ") : undefined },
        { label: "Dimensions", value: composite ? undefined : clip(dimsText(metricAlarm.Dimensions), 200) || undefined },
        { label: "Rule", value: composite?.AlarmRule ? clip(composite.AlarmRule, 200) : undefined },
        { label: "Watches", value: watched.size ? clip([...watched.values()].map((w) => w.what).join(", "), 200) : undefined },
        { label: "Actions", value: actionRows.length ? clip(actionRows.join("; "), 240) : "none" },
        a.ActionsEnabled === false && { label: "Actions enabled", value: "no" },
        { label: "Missing data", value: composite ? undefined : metricAlarm.TreatMissingData },
        { label: "Reason", value: a.StateReason ? clip(a.StateReason, 200) : undefined },
        { label: "Description", value: a.AlarmDescription ? clip(a.AlarmDescription, 160) : undefined },
      ]),
      aliases: [name],
      consoleUrl: consoleUrl(region, name),
      lastModified: ms(a.AlarmConfigurationUpdatedTimestamp),
      facts,
      observedAt: i.now,
      ...(enrichment ? { enrichment } : {}),
    });
  }
  return { resources, links, mentions: [] };
}

// ---------- detail: state history ----------

export interface RawHistoryItem { Timestamp?: When; HistoryItemType?: string; HistorySummary?: string }

// DescribeAlarmHistory items as table rows, newest first (never HistoryData: it carries the raw datapoints).
export function historyRows(items: RawHistoryItem[]): string[][] {
  return [...items]
    .sort((a, b) => (ms(b.Timestamp) ?? 0) - (ms(a.Timestamp) ?? 0))
    .map((x) => [fmtTime(ms(x.Timestamp)), x.HistoryItemType === "StateUpdate" ? "state" : x.HistoryItemType === "ConfigurationUpdate" ? "configuration" : x.HistoryItemType === "Action" ? "action" : (x.HistoryItemType ?? "?").toLowerCase(), clip(x.HistorySummary ?? "", 160)]);
}
