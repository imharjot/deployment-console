// EventBridge Scheduler schedules and EventBridge Pipes, pure part: what the scheduler and pipes providers read, real
// or simulated, → Resources, Links and Mentions (audit §6 A.2 #18 and the P2 pipes row, master plan B7).
//
// Scheduler (ListSchedules + GetSchedule; Resource Explorer doesn't index schedules, so the provider covers nothing):
// - Key: the schedule ARN ("arn:…:scheduler:<r>:<a>:schedule/<group>/<name>"). Schedules carry no tags.
// - Links: schedule → Target.Arn (event, labelled with the schedule in words or its expression); → the dead-letter
//   queue (event); → the role (assumes); KMS key → schedule (encrypts). An ECS target names a cluster (not a node on the
//   map): the link goes to the task definition family's ARN instead ("…:task-definition/<family>", no revision), which
//   resolves only to an ECS service running that family (invoke, "mentioned") — never to some other resource that
//   happens to share the family's name. Universal targets (arn:aws:scheduler:::aws-sdk:<service>:<action>) are
//   described, not linked — their real target sits in the input.
// - Secrets: Input becomes Mention refs only (values stay on the server).
// - Health: ENABLED ok; DISABLED stopped; a one-time schedule whose time has passed, or a past EndDate, stopped.
//
// Pipes (ListPipes + DescribePipe):
// - Key: the pipe ARN. Links: pipe → source (poll; DynamoDB streams fold to their table, self-managed Kafka to its
//   broker hosts); → enrichment (invoke); → target (event; ECS targets via their task family's ARN, like schedules); → role
//   (assumes); → log destinations (logs); KMS key → pipe (encrypts); → broker credentials secrets (reads).
// - Secrets: input templates and HTTP header / query / path values become Mention refs only.
// - Health: RUNNING ok; STOPPED stopped; *_FAILED error; CREATING, UPDATING, STARTING, STOPPING, DELETING warning.
// No AWS calls and no `server-only`, so node:test runs it (scheduling.test.ts).
import { arnBase, arnName, arnOf, parseArn } from "./arn.ts";
import {
  assumesLink, awsTime, clip, describeSchedule, enrichmentOf, fmtTime, hostOf, kmsKeyRef, patternSummary, plural, props, tagsOf, targetKey, unread,
} from "./serverless-common.ts";
import type { EnrichState, Facts, Health, Link, Mention, ProviderResult, Resource, ResourceDetail } from "./types.ts";

// ---------- input → mention refs ----------

const TRIVIAL = /^(true|false|yes|no|on|off|null|-?\d+(\.\d+)?)$/i;

// The strings an input (JSON, a template with <$.placeholders>, or plain text) names: JSON string leaves, quoted
// strings in a template, or the text itself. Values only ever become Mention refs, never props.
export function inputRefs(text: string | undefined, max = 50): string[] {
  const t = (text ?? "").trim();
  if (!t) return [];
  const out: string[] = [];
  const add = (v: unknown) => {
    if (typeof v !== "string") return;
    const s = v.trim();
    if (s.length >= 3 && s.length <= 4096 && !TRIVIAL.test(s) && !out.includes(s) && out.length < max) out.push(s);
  };
  const walk = (v: unknown, depth: number) => {
    if (depth > 8) return;
    if (Array.isArray(v)) v.forEach((x) => walk(x, depth + 1));
    else if (v && typeof v === "object") Object.values(v).forEach((x) => walk(x, depth + 1));
    else add(v);
  };
  try {
    walk(JSON.parse(t), 0);
    return out;
  } catch {
    // not JSON: a template ("{"id": <$.body.id>, "queue": "https://…"}") or plain text
  }
  // Quoted strings that are values, not keys (a key is followed by ":").
  const quoted = [...t.matchAll(/"((?:[^"\\]|\\.)*)"/g)].filter((m) => !/^\s*:/.test(t.slice(m.index + m[0].length))).map((m) => m[1]);
  if (quoted.length) quoted.forEach(add);
  else add(t);
  return out;
}

const mention = (from: string, text: string | undefined, via: string): Mention[] => {
  const refs = inputRefs(text);
  return refs.length ? [{ from, refs, via }] : [];
};

// "arn:aws:ecs:r:a:task-definition/worker-staging:12" → "worker-staging".
export const taskFamily = (td: string | undefined) => (td ? /task-definition\/([^:]+)/.exec(td)?.[1] ?? (td.startsWith("arn:") ? undefined : td.split(":")[0]) : undefined);

// The family's ARN without the revision: "…:task-definition/worker-staging:12" → "…:task-definition/worker-staging". A
// bare family takes the target cluster's partition, region and account.
export function taskFamilyArn(td: string | undefined, cluster: string): string | undefined {
  const family = taskFamily(td);
  const p = parseArn(td?.startsWith("arn:") ? td : cluster);
  return family && p ? `arn:${p.partition}:ecs:${p.region}:${p.account}:task-definition/${family}` : undefined;
}

// An ECS target names a cluster, which isn't a node on the map; the task definition family is what identifies the work.
// The link's end is the family's ARN (an ECS service lists the family it runs, as this ARN, among its aliases), never the
// bare family name: a name would also resolve to an unrelated Lambda, queue or bucket called the same. The service only
// runs the same family as the scheduled task, hence "mentioned".
const familyLink = (from: string, cluster: string, td: string | undefined, evidence: string): Link[] => {
  const family = taskFamily(td);
  const to = taskFamilyArn(td, cluster);
  return family && to ? [{ from, to, kind: "invoke", label: `run task ${family}`, evidence, confidence: "mentioned" }] : [];
};

const isEcsCluster = (arn: string) => /^arn:aws[\w-]*:ecs:[^:]*:\d*:cluster\//.test(arn);
// Universal targets: "arn:aws:scheduler:::aws-sdk:sqs:sendMessage" → "sqs:sendMessage".
export const universalTarget = (arn: string | undefined) => /^arn:aws[\w-]*:scheduler:::aws-sdk:([a-z0-9-]+:[A-Za-z0-9]+)$/.exec(arn ?? "")?.[1];

// ---------- Scheduler ----------

export interface ScheduleTarget {
  Arn?: string;
  RoleArn?: string;
  DeadLetterConfig?: { Arn?: string };
  RetryPolicy?: { MaximumEventAgeInSeconds?: number; MaximumRetryAttempts?: number };
  Input?: string;
  EcsParameters?: { TaskDefinitionArn?: string; TaskCount?: number; LaunchType?: string };
  EventBridgeParameters?: { DetailType?: string; Source?: string };
}

// ListSchedules' ScheduleSummary, plus GetSchedule's fields when it was read (enrichment.schedule says how it went).
export interface RawSchedule {
  Arn?: string;
  Name?: string;
  GroupName?: string;
  State?: string; // ENABLED | DISABLED
  CreationDate?: Date | string;
  LastModificationDate?: Date | string;
  Target?: ScheduleTarget; // ListSchedules: Arn only
  // GetSchedule
  ScheduleExpression?: string;
  ScheduleExpressionTimezone?: string;
  StartDate?: Date | string;
  EndDate?: Date | string;
  Description?: string;
  KmsKeyArn?: string;
  FlexibleTimeWindow?: { Mode?: string; MaximumWindowInMinutes?: number };
  ActionAfterCompletion?: string;
  enrichment?: Record<string, EnrichState>; // schedule
}

// The UTC offset (ms) of `zone` at instant `at`, from Intl (no time-zone database of our own).
function zoneOffset(at: number, zone: string): number | undefined {
  try {
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(at).map((p) => [p.type, p.value]));
    return Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second) - Math.floor(at / 1000) * 1000;
  } catch {
    return undefined;
  }
}

// When a one-time schedule ("at(2026-01-01T09:00:00)" in its time zone, UTC by default) fires; undefined otherwise.
export function oneTimeAt(expr: string | undefined, zone?: string): number | undefined {
  const m = /^at\((\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\)$/.exec((expr ?? "").trim());
  if (!m) return undefined;
  const local = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  if (!zone || zone === "UTC") return local;
  const off = zoneOffset(local, zone);
  return off === undefined ? local : local - off;
}

function scheduleHealth(s: RawSchedule, now: number): { health: Health; reason?: string } {
  if (s.State === "DISABLED") return { health: "stopped", reason: "disabled" };
  const end = awsTime(s.EndDate);
  if (end !== undefined && end < now) return { health: "stopped", reason: `ended ${fmtTime(end)}` };
  const at = oneTimeAt(s.ScheduleExpression, s.ScheduleExpressionTimezone);
  if (at !== undefined && at < now) return { health: "stopped", reason: `one-time schedule — ran at ${fmtTime(at)}` };
  if (s.State === "ENABLED") return { health: "ok" };
  return { health: "unknown", reason: s.State ? `state ${s.State}` : "state not reported" };
}

const SERVICE: Record<string, string> = {
  lambda: "Lambda", sqs: "SQS", sns: "SNS", states: "Step Functions", events: "EventBridge", kinesis: "Kinesis", firehose: "Firehose", ecs: "ECS", sagemaker: "SageMaker",
  logs: "CloudWatch Logs", batch: "Batch", "execute-api": "API Gateway", dynamodb: "DynamoDB", mq: "Amazon MQ", kafka: "MSK", redshift: "Redshift"
};

// What a target is, for people: "Lambda acme-email-sender", "SQS orders", "sqs:sendMessage (universal target)".
function targetLabel(arn: string | undefined, ecsFamily?: string): string | undefined {
  if (!arn) return undefined;
  const u = universalTarget(arn);
  if (u) return `${u} (universal target)`;
  const p = parseArn(targetKey(arn));
  if (!p) return clip(arn, 120);
  const name = p.service === "lambda" ? p.id.split(":")[0] : arnName(p);
  return `${SERVICE[p.service] ?? p.service} ${name}${p.service === "ecs" && ecsFamily ? ` · task ${ecsFamily}` : ""}`;
}

export function schedulerConsoleUrl(region: string, group: string, name: string) {
  return `https://${region}.console.aws.amazon.com/scheduler/home?region=${region}#schedules/${encodeURIComponent(group)}/${encodeURIComponent(name)}`;
}

export function scheduleKey(s: RawSchedule, region: string, account: string | undefined): string | undefined {
  return s.Arn ?? (s.Name && account ? arnOf.schedule(region, account, s.GroupName ?? "default", s.Name) : undefined);
}

export function schedulerResult(schedules: RawSchedule[], o: { region: string; account?: string; now: number }): ProviderResult {
  const resources: Resource[] = [];
  const links: Link[] = [];
  const mentions: Mention[] = [];
  for (const s of schedules) {
    const key = scheduleKey(s, o.region, o.account);
    const p = key ? parseArn(key) : undefined;
    if (!key || !p) continue;
    const region = p.region;
    const group = s.GroupName ?? "default";
    const name = s.Name ?? p.id.split("/").pop() ?? key;
    const { health, reason } = scheduleHealth(s, o.now);
    const tg = s.Target;
    const family = taskFamily(tg?.EcsParameters?.TaskDefinitionArn);
    const when = describeSchedule(s.ScheduleExpression) ?? s.ScheduleExpression;
    const read = s.enrichment?.schedule === undefined || s.enrichment.schedule === "ok";
    const facts: Facts = {};
    if (s.State) facts.state = s.State;
    const enrichment = enrichmentOf(s.enrichment);
    const start = awsTime(s.StartDate);
    const end = awsTime(s.EndDate);
    resources.push({
      key,
      kind: "schedule",
      provider: "scheduler",
      name,
      region,
      ...tagsOf({}), // schedules can't be tagged (their group can)
      health,
      ...(reason ? { healthReason: reason } : {}),
      facts,
      ...(enrichment ? { enrichment } : {}),
      props: props([
        { label: "Schedule", value: s.ScheduleExpression ? `${when}${when !== s.ScheduleExpression ? ` · ${s.ScheduleExpression}` : ""}` : read ? undefined : unread("expression", s.enrichment?.schedule) },
        { label: "Time zone", value: s.ScheduleExpressionTimezone },
        { label: "Group", value: group },
        { label: "State", value: s.State },
        { label: "Target", value: targetLabel(tg?.Arn, family) },
        { label: "Flexible window", value: s.FlexibleTimeWindow?.Mode === "FLEXIBLE" ? `${s.FlexibleTimeWindow.MaximumWindowInMinutes ?? "?"} min` : s.FlexibleTimeWindow?.Mode === "OFF" ? "off" : undefined },
        { label: "Retries", value: tg?.RetryPolicy ? `${tg.RetryPolicy.MaximumRetryAttempts ?? "?"} attempts, events up to ${Math.round((tg.RetryPolicy.MaximumEventAgeInSeconds ?? 0) / 60)} min old` : undefined },
        { label: "Dead-letter queue", value: tg?.DeadLetterConfig?.Arn?.split(":").pop() },
        { label: "Window", value: start !== undefined || end !== undefined ? `${start !== undefined ? `from ${fmtTime(start)}` : ""}${start !== undefined && end !== undefined ? " " : ""}${end !== undefined ? `until ${fmtTime(end)}` : ""}` : undefined },
        { label: "After completion", value: s.ActionAfterCompletion === "DELETE" ? "deleted" : undefined },
        { label: "Description", value: s.Description ? clip(s.Description, 200) : undefined },
      ]),
      consoleUrl: schedulerConsoleUrl(region, group, name),
      ...(s.CreationDate ? { createdAt: awsTime(s.CreationDate) } : {}),
      ...(s.LastModificationDate ? { lastModified: awsTime(s.LastModificationDate) } : {}),
    });
    const ev = `EventBridge Scheduler target${s.ScheduleExpression ? ` (${s.ScheduleExpression})` : ""}`;
    if (tg?.Arn && !universalTarget(tg.Arn)) {
      if (isEcsCluster(tg.Arn)) links.push(...familyLink(key, tg.Arn, tg.EcsParameters?.TaskDefinitionArn, `${ev}, ECS RunTask`));
      else links.push({ from: key, to: targetKey(tg.Arn), kind: "event", label: when ?? "target", evidence: ev });
    }
    if (tg?.DeadLetterConfig?.Arn) links.push({ from: key, to: tg.DeadLetterConfig.Arn, kind: "event", label: "dead-letter queue", evidence: "EventBridge Scheduler DeadLetterConfig" });
    links.push(...assumesLink(key, tg?.RoleArn, "scheduler role", "EventBridge Scheduler Target.RoleArn"));
    const kms = kmsKeyRef(s.KmsKeyArn, region, p.account);
    if (kms) links.push({ from: kms, to: key, kind: "encrypts", label: "schedule input", evidence: "EventBridge Scheduler KmsKeyArn" });
    mentions.push(...mention(key, tg?.Input, "schedule input"));
  }
  return { resources, links, mentions };
}

export function schedulerDetail(key: string, s: RawSchedule | undefined, now: number): ResourceDetail {
  if (!s) return { key, sections: [{ title: "Schedule", note: "This schedule no longer exists." }] };
  const tg = s.Target;
  const at = oneTimeAt(s.ScheduleExpression, s.ScheduleExpressionTimezone);
  return {
    key,
    sections: [
      {
        title: "Schedule",
        rows: props([
          { label: "Name", value: s.Name },
          { label: "Group", value: s.GroupName },
          { label: "State", value: s.State },
          { label: "Expression", value: s.ScheduleExpression, mono: true },
          { label: "In words", value: describeSchedule(s.ScheduleExpression) ?? (at !== undefined ? `once, at ${fmtTime(at)}${at < now ? " (past)" : ""}` : undefined) },
          { label: "Time zone", value: s.ScheduleExpressionTimezone },
          { label: "Starts", value: s.StartDate ? fmtTime(awsTime(s.StartDate)) : undefined },
          { label: "Ends", value: s.EndDate ? fmtTime(awsTime(s.EndDate)) : undefined },
          { label: "KMS key", value: s.KmsKeyArn, mono: true },
        ]),
      },
      {
        title: "Target",
        rows: props([
          { label: "Target", value: tg?.Arn, mono: true },
          { label: "Role", value: tg?.RoleArn, mono: true },
          { label: "Dead-letter queue", value: tg?.DeadLetterConfig?.Arn, mono: true },
          { label: "Task definition", value: tg?.EcsParameters?.TaskDefinitionArn, mono: true },
          { label: "Event", value: tg?.EventBridgeParameters ? `${tg.EventBridgeParameters.Source ?? "?"} · ${tg.EventBridgeParameters.DetailType ?? "?"}` : undefined },
          // The input may hold secrets: only whether there is one.
          { label: "Input", value: tg?.Input ? "set (not shown)" : undefined },
        ]),
      },
    ],
  };
}

// ---------- Pipes ----------

// DescribePipe's parameter blocks, the parts the map reads. Secret-bearing values (HTTP headers, query strings, path
// parameters, input templates) only become Mention refs.
interface HttpParams { HeaderParameters?: Record<string, string>; QueryStringParameters?: Record<string, string>; PathParameterValues?: string[] }
export interface PipeTargetParameters {
  InputTemplate?: string;
  HttpParameters?: HttpParams;
  EcsTaskParameters?: { TaskDefinitionArn?: string; LaunchType?: string; TaskCount?: number };
}
type Credentials = Record<string, unknown>;
export interface PipeSourceParameters {
  FilterCriteria?: { Filters?: { Pattern?: string }[] };
  ActiveMQBrokerParameters?: { Credentials?: Credentials; QueueName?: string };
  RabbitMQBrokerParameters?: { Credentials?: Credentials; QueueName?: string; VirtualHost?: string };
  ManagedStreamingKafkaParameters?: { Credentials?: Credentials; TopicName?: string };
  SelfManagedKafkaParameters?: { Credentials?: Credentials; TopicName?: string; AdditionalBootstrapServers?: string[] };
  SqsQueueParameters?: { BatchSize?: number };
  KinesisStreamParameters?: { StartingPosition?: string };
  DynamoDBStreamParameters?: { StartingPosition?: string };
}

// ListPipes' Pipe, plus DescribePipe's fields when it was read (enrichment.describe says how it went).
export interface RawPipe {
  Arn?: string;
  Name?: string;
  DesiredState?: string;
  CurrentState?: string;
  StateReason?: string;
  Source?: string;
  Target?: string;
  Enrichment?: string;
  CreationTime?: Date | string;
  LastModifiedTime?: Date | string;
  // DescribePipe
  Description?: string;
  RoleArn?: string;
  SourceParameters?: PipeSourceParameters;
  EnrichmentParameters?: { InputTemplate?: string; HttpParameters?: HttpParams };
  TargetParameters?: PipeTargetParameters;
  LogConfiguration?: { Level?: string; CloudwatchLogsLogDestination?: { LogGroupArn?: string }; FirehoseLogDestination?: { DeliveryStreamArn?: string }; S3LogDestination?: { BucketName?: string } };
  KmsKeyIdentifier?: string;
  Tags?: Record<string, string>;
  described?: boolean;
  enrichment?: Record<string, EnrichState>; // describe
}

function pipeHealth(p: RawPipe): { health: Health; reason?: string } {
  const s = p.CurrentState ?? "";
  const why = p.StateReason ? `: ${clip(p.StateReason, 160)}` : "";
  if (s === "RUNNING") return { health: "ok" };
  if (s === "STOPPED") return { health: "stopped", reason: `stopped${p.DesiredState === "RUNNING" ? ` (should be running)${why}` : ""}` };
  if (s.endsWith("_FAILED")) return { health: "error", reason: `${s.toLowerCase().replace(/_/g, " ")}${why}` };
  if (/^(CREATING|UPDATING|STARTING|STOPPING|DELETING)$/.test(s)) return { health: "warning", reason: s.toLowerCase() };
  return { health: "unknown", reason: s ? `state ${s}` : "state not reported" };
}

// Secrets Manager ARNs inside a source's Credentials block (BasicAuth, SaslScram512Auth, ClientCertificateTlsAuth…).
const credentialSecrets = (c: Credentials | undefined): string[] =>
  Object.values(c ?? {}).filter((v): v is string => typeof v === "string" && /^arn:aws[\w-]*:secretsmanager:/.test(v));

// Self-managed Kafka sources: "smk://b1:9092,b2:9092" → broker hosts.
const smkHosts = (source: string) => (source.startsWith("smk://") ? source.slice(6).split(",").map((h) => hostOf(h.trim())).filter((h): h is string => !!h) : []);

const httpMentions = (from: string, h: HttpParams | undefined, where: string): Mention[] => [
  ...Object.entries(h?.HeaderParameters ?? {}).flatMap(([k, v]) => mention(from, v, `${where} header ${k}`)),
  ...Object.entries(h?.QueryStringParameters ?? {}).flatMap(([k, v]) => mention(from, v, `${where} query ${k}`)),
  ...(h?.PathParameterValues?.length ? mention(from, JSON.stringify(h.PathParameterValues), `${where} path parameters`) : []),
];

export function pipesConsoleUrl(region: string, name: string) {
  return `https://${region}.console.aws.amazon.com/events/home?region=${region}#/pipes/${encodeURIComponent(name)}`;
}

export function pipesResult(pipes: RawPipe[]): ProviderResult {
  const resources: Resource[] = [];
  const links: Link[] = [];
  const mentions: Mention[] = [];
  for (const x of pipes) {
    const key = x.Arn;
    const p = key ? parseArn(key) : undefined;
    if (!key || !p) continue;
    const region = p.region;
    const { health, reason } = pipeHealth(x);
    const facts: Facts = {};
    if (x.CurrentState) facts.state = x.CurrentState;
    const enrichment = enrichmentOf(x.enrichment);
    const sp = x.SourceParameters;
    const filters = sp?.FilterCriteria?.Filters ?? [];
    const family = taskFamily(x.TargetParameters?.EcsTaskParameters?.TaskDefinitionArn);
    const topic = sp?.ManagedStreamingKafkaParameters?.TopicName ?? sp?.SelfManagedKafkaParameters?.TopicName;
    const queue = sp?.ActiveMQBrokerParameters?.QueueName ?? sp?.RabbitMQBrokerParameters?.QueueName;
    resources.push({
      key,
      kind: "pipe",
      provider: "pipes",
      name: x.Name ?? p.id,
      region,
      ...tagsOf(x.described ? (x.Tags ?? {}) : undefined),
      health,
      ...(reason ? { healthReason: reason } : {}),
      facts,
      ...(enrichment ? { enrichment } : {}),
      props: props([
        { label: "State", value: x.CurrentState ? `${x.CurrentState}${x.DesiredState && x.DesiredState !== x.CurrentState ? ` (desired ${x.DesiredState})` : ""}` : undefined },
        { label: "Source", value: x.Source ? `${targetLabel(x.Source.startsWith("smk://") ? undefined : x.Source) ?? "self-managed Kafka"}${topic ? ` · topic ${topic}` : queue ? ` · queue ${queue}` : ""}` : undefined },
        { label: "Filter", value: filters.length ? clip(filters.map((f) => patternSummary(f.Pattern, 120) ?? "pattern").join(" | "), 200) : undefined },
        { label: "Enrichment", value: targetLabel(x.Enrichment) },
        { label: "Target", value: targetLabel(x.Target, family) },
        { label: "Logging", value: x.LogConfiguration?.Level?.toLowerCase() },
        { label: "Details", value: x.described ? undefined : unread("role and parameters", x.enrichment?.describe) },
        { label: "Description", value: x.Description ? clip(x.Description, 200) : undefined },
      ]),
      consoleUrl: pipesConsoleUrl(region, x.Name ?? p.id),
      ...(x.CreationTime ? { createdAt: awsTime(x.CreationTime) } : {}),
      ...(x.LastModifiedTime ? { lastModified: awsTime(x.LastModifiedTime) } : {}),
    });
    // Source: polled by the pipe.
    if (x.Source?.startsWith("arn:")) links.push({ from: key, to: targetKey(x.Source), kind: "poll", label: topic ? `topic ${topic}` : queue ? `queue ${queue}` : "source", evidence: "EventBridge Pipes source" });
    else if (x.Source) for (const h of [...smkHosts(x.Source), ...(sp?.SelfManagedKafkaParameters?.AdditionalBootstrapServers ?? []).map((s) => hostOf(s)).filter((h): h is string => !!h)]) links.push({ from: key, to: h, kind: "poll", label: topic ? `topic ${topic}` : "Kafka", evidence: "EventBridge Pipes self-managed Kafka source" });
    for (const c of [sp?.ActiveMQBrokerParameters?.Credentials, sp?.RabbitMQBrokerParameters?.Credentials, sp?.ManagedStreamingKafkaParameters?.Credentials, sp?.SelfManagedKafkaParameters?.Credentials])
      for (const s of credentialSecrets(c)) links.push({ from: key, to: s, kind: "reads", label: "source credentials", evidence: "EventBridge Pipes source Credentials" });
    // Enrichment: called for each batch.
    if (x.Enrichment?.startsWith("arn:")) links.push({ from: key, to: targetKey(x.Enrichment), kind: "invoke", label: "enrichment", evidence: "EventBridge Pipes enrichment" });
    // Target: an ECS target names a cluster; the task family is what identifies the work.
    if (x.Target?.startsWith("arn:")) {
      if (isEcsCluster(x.Target)) links.push(...familyLink(key, x.Target, x.TargetParameters?.EcsTaskParameters?.TaskDefinitionArn, "EventBridge Pipes target, ECS RunTask"));
      else links.push({ from: key, to: targetKey(x.Target), kind: "event", label: "target", evidence: "EventBridge Pipes target" });
    }
    links.push(...assumesLink(key, x.RoleArn, "pipe role", "EventBridge Pipes RoleArn"));
    const lc = x.LogConfiguration;
    if (lc?.CloudwatchLogsLogDestination?.LogGroupArn) links.push({ from: key, to: arnBase(lc.CloudwatchLogsLogDestination.LogGroupArn), kind: "logs", label: "pipe logs", evidence: "EventBridge Pipes LogConfiguration" });
    if (lc?.FirehoseLogDestination?.DeliveryStreamArn) links.push({ from: key, to: lc.FirehoseLogDestination.DeliveryStreamArn, kind: "logs", label: "pipe logs", evidence: "EventBridge Pipes LogConfiguration" });
    if (lc?.S3LogDestination?.BucketName) links.push({ from: key, to: `arn:${p.partition}:s3:::${lc.S3LogDestination.BucketName}`, kind: "logs", label: "pipe logs", evidence: "EventBridge Pipes LogConfiguration" });
    const kms = kmsKeyRef(x.KmsKeyIdentifier, region, p.account);
    if (kms) links.push({ from: kms, to: key, kind: "encrypts", label: "pipe data", evidence: "EventBridge Pipes KmsKeyIdentifier" });
    mentions.push(
      ...mention(key, x.TargetParameters?.InputTemplate, "pipe target input template"),
      ...mention(key, x.EnrichmentParameters?.InputTemplate, "pipe enrichment input template"),
      ...httpMentions(key, x.TargetParameters?.HttpParameters, "pipe target"),
      ...httpMentions(key, x.EnrichmentParameters?.HttpParameters, "pipe enrichment"),
    );
  }
  return { resources, links, mentions };
}

export function pipesDetail(key: string, x: RawPipe | undefined): ResourceDetail {
  if (!x) return { key, sections: [{ title: "Pipe", note: "This pipe no longer exists." }] };
  const filters = x.SourceParameters?.FilterCriteria?.Filters ?? [];
  return {
    key,
    sections: [
      {
        title: "Pipe",
        rows: props([
          { label: "Name", value: x.Name },
          { label: "State", value: x.CurrentState },
          { label: "Desired state", value: x.DesiredState },
          { label: "Reason", value: x.StateReason },
          { label: "Source", value: x.Source?.startsWith("smk://") ? `self-managed Kafka (${plural(smkHosts(x.Source).length, "broker")})` : x.Source, mono: true },
          { label: "Enrichment", value: x.Enrichment, mono: true },
          { label: "Target", value: x.Target, mono: true },
          { label: "Role", value: x.RoleArn, mono: true },
          { label: "KMS key", value: x.KmsKeyIdentifier, mono: true },
          // Templates and HTTP parameters may hold secrets: only whether they are set.
          { label: "Target input", value: x.TargetParameters?.InputTemplate ? "template set (not shown)" : undefined },
          { label: "Created", value: x.CreationTime ? fmtTime(awsTime(x.CreationTime)) : undefined },
        ]),
      },
      ...(filters.length ? [{ title: "Filters", table: { columns: ["Pattern"], rows: filters.map((f) => [patternSummary(f.Pattern, 300) ?? "—"]) } }] : []),
    ],
  };
}
