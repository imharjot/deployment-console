// SQS, SNS and EventBridge, pure part: raw API shapes (real or simulated) → Resources and Links — queue → dead-letter
// queue redrive, topic → subscriber (Lambda / SQS / Firehose / webhook host), bus → rule → target — plus the support
// links (the KMS key of a queue or topic, the roles a rule and its targets run as) and health (a dead-letter queue
// holding messages, a disabled rule; unknown when the queue's attributes weren't read). Email and SMS subscribers are
// masked; webhook URLs keep only their host (paths often carry tokens). Tags that weren't read mark the resource
// tagsUnread (R01). Tested in serverless-messaging.test.ts.
import {
  arnName, assumesLink, awsTime, clip, describeSchedule, ebTargetLinks, encryptsLink, enrichmentOf, fmtCount, fmtSeconds, fmtTime, kmsKeyRef, parseArn,
  patternSummary, plural, props, snsSubscription, tagsOf, unread, type EbTarget, type SnsSub,
} from "./serverless-common.ts";
import type { EnrichState, Health, Link, ProviderResult, Resource } from "./types.ts";

const json = <T>(s: string | undefined): T | undefined => {
  if (!s) return undefined;
  try {
    return JSON.parse(s) as T;
  } catch {
    return undefined;
  }
};

// ---------- SQS ----------

export interface RawQueue {
  url: string;
  attributes: Record<string, string>; // GetQueueAttributes(All); only QueueArn when they weren't read
  tags?: Record<string, string>; // undefined = not read (tagsUnread)
  enrichment?: Record<string, EnrichState>; // attributes, tags: "ok" or why not
  lastActivityAt?: number; // simulation only
}

export const SQS_P = {
  type: "Type",
  visible: "Messages available",
  inFlight: "In flight",
  delayed: "Delayed",
  dlq: "Dead-letter queue",
  dlqFor: "Dead-letter queue for",
} as const;

export interface Redrive {
  deadLetterTargetArn?: string;
  maxReceiveCount?: number | string;
}
export const redriveOf = (attrs: Record<string, string>) => json<Redrive>(attrs.RedrivePolicy);

export const queueDepth = (a: Record<string, string>) => ({
  visible: Number(a.ApproximateNumberOfMessages ?? 0) || 0,
  inFlight: Number(a.ApproximateNumberOfMessagesNotVisible ?? 0) || 0,
  delayed: Number(a.ApproximateNumberOfMessagesDelayed ?? 0) || 0,
});

export function sqsConsoleUrl(url: string, region: string) {
  return `https://${region}.console.aws.amazon.com/sqs/v3/home?region=${region}#/queues/${encodeURIComponent(url)}`;
}

function encryption(a: Record<string, string>): string {
  if (a.KmsMasterKeyId) return `KMS ${a.KmsMasterKeyId.replace(/^arn:aws[\w-]*:kms:[^:]+:\d+:/, "")}`;
  return a.SqsManagedSseEnabled === "true" ? "SSE-SQS" : "none";
}

// F31: a send SQS deduplicates by itself — a FIFO queue with an explicit deduplication id — may be retried by the SDK;
// any other send (standard queues, FIFO without an id) is sent once: a retry after a lost answer would deliver twice.
export const sqsSendDeduplicated = (attrs: Record<string, string>, deduplicationId: string | undefined) => attrs.FifoQueue === "true" && !!deduplicationId;

export function sqsResult(queues: RawQueue[]): ProviderResult {
  // Which queues redrive into which: a queue named in someone's redrive policy is a dead-letter queue.
  const sources = new Map<string, string[]>();
  for (const q of queues) {
    const target = redriveOf(q.attributes)?.deadLetterTargetArn;
    if (target) sources.set(target, [...(sources.get(target) ?? []), arnName(q.attributes.QueueArn) || q.url.split("/").pop()!]);
  }
  const resources: Resource[] = [];
  const links: Link[] = [];
  for (const q of queues) {
    const a = q.attributes;
    const key = a.QueueArn;
    if (!key) continue;
    const name = arnName(key);
    const arn = parseArn(key);
    const region = arn?.region ?? "";
    const read = (q.enrichment?.attributes ?? "ok") === "ok";
    const depth = queueDepth(a);
    const redrive = redriveOf(a);
    const allow = json<{ redrivePermission?: string; sourceQueueArns?: string[] }>(a.RedriveAllowPolicy);
    const from = sources.get(key) ?? [];
    const isDlq = from.length > 0 || allow?.redrivePermission === "byQueue" || /[-_.](dlq|dead-?letter)(\.fifo)?$/i.test(name);
    let health: Health = "ok";
    let reason: string | undefined;
    if (!read) {
      // The depth is what tells a dead-letter queue's trouble: without it, nothing is known.
      health = "unknown";
      reason = unread("queue attributes", q.enrichment?.attributes);
    } else if (isDlq && depth.visible + depth.inFlight > 0) {
      health = "warning";
      reason = `dead-letter queue holds ${plural(depth.visible + depth.inFlight, "message")}`;
    }
    const fifo = a.FifoQueue === "true";
    const enrichment = enrichmentOf(q.enrichment);
    resources.push({
      key,
      kind: "sqs",
      provider: "sqs",
      name,
      region,
      ...tagsOf(q.tags),
      health,
      healthReason: reason,
      ...(enrichment ? { enrichment } : {}),
      props: props([
        { label: SQS_P.type, value: !read ? (name.endsWith(".fifo") ? "FIFO" : undefined) : fifo ? `FIFO${a.ContentBasedDeduplication === "true" ? " (content-based dedup)" : ""}` : "Standard" },
        { label: SQS_P.visible, value: read ? fmtCount(depth.visible) : unread("", q.enrichment?.attributes).trim() },
        { label: SQS_P.inFlight, value: read ? fmtCount(depth.inFlight) : undefined },
        { label: SQS_P.delayed, value: depth.delayed ? fmtCount(depth.delayed) : undefined },
        { label: SQS_P.dlq, value: redrive?.deadLetterTargetArn ? `${arnName(redrive.deadLetterTargetArn)} after ${redrive.maxReceiveCount ?? "?"} receives` : undefined },
        { label: SQS_P.dlqFor, value: from.length ? from.join(", ") : isDlq ? "(no source queue found)" : undefined },
        { label: "Redrive allowed from", value: allow?.redrivePermission === "byQueue" ? (allow.sourceQueueArns ?? []).map(arnName).join(", ") : allow?.redrivePermission === "denyAll" ? "no queue" : undefined },
        { label: "Retention", value: a.MessageRetentionPeriod ? fmtSeconds(Number(a.MessageRetentionPeriod)) : undefined },
        { label: "Visibility timeout", value: a.VisibilityTimeout ? fmtSeconds(Number(a.VisibilityTimeout)) : undefined },
        { label: "Delivery delay", value: Number(a.DelaySeconds) ? fmtSeconds(Number(a.DelaySeconds)) : undefined },
        { label: "Encryption", value: read ? encryption(a) : undefined },
        { label: "URL", value: q.url, mono: true },
      ]),
      aliases: [q.url, name],
      lastActivityAt: q.lastActivityAt,
      consoleUrl: sqsConsoleUrl(q.url, region),
      createdAt: awsTime(a.CreatedTimestamp),
      lastModified: awsTime(a.LastModifiedTimestamp),
    });
    if (redrive?.deadLetterTargetArn) {
      links.push({ from: key, to: redrive.deadLetterTargetArn, kind: "event", label: `redrive after ${redrive.maxReceiveCount ?? "?"} receives`, evidence: `redrive policy (maxReceiveCount ${redrive.maxReceiveCount ?? "?"})` });
    }
    links.push(...encryptsLink(kmsKeyRef(a.KmsMasterKeyId, region, arn?.account), key, "messages", "queue attribute KmsMasterKeyId (SSE-KMS)"));
  }
  return { resources, links, mentions: [] };
}

// ---------- SNS ----------

export interface RawTopic {
  arn: string;
  attributes: Record<string, string>; // GetTopicAttributes ({} when not read)
  subscriptions: SnsSub[];
  tags?: Record<string, string>; // undefined = not read (tagsUnread)
  enrichment?: Record<string, EnrichState>; // attributes, subscriptions, tags
  lastActivityAt?: number;
}

export const SNS_P = { subscribers: "Subscribers", type: "Type" } as const;

export function snsConsoleUrl(arn: string, region: string) {
  return `https://${region}.console.aws.amazon.com/sns/v3/home?region=${region}#/topic/${arn}`;
}

// "lambda 1 · sqs 1 · https 1 · email 2" (for props and the publish plan).
export function subscriberSummary(subs: SnsSub[]): string {
  const n = new Map<string, number>();
  for (const s of subs) n.set((s.Protocol ?? "?").toLowerCase(), (n.get((s.Protocol ?? "?").toLowerCase()) ?? 0) + 1);
  return [...n].map(([p, c]) => `${p} ${c}`).join(" · ");
}

export function snsResult(topics: RawTopic[]): ProviderResult {
  const resources: Resource[] = [];
  const links: Link[] = [];
  for (const t of topics) {
    const a = t.attributes;
    const key = t.arn;
    const arn = parseArn(key);
    const region = arn?.region ?? "";
    const attrsRead = (t.enrichment?.attributes ?? "ok") === "ok";
    const subsRead = (t.enrichment?.subscriptions ?? "ok") === "ok";
    const enrichment = enrichmentOf(t.enrichment);
    const masked: Record<string, string[]> = {};
    for (const s of t.subscriptions) {
      const r = snsSubscription(key, s);
      links.push(...r.links);
      if (r.masked) (masked[r.masked.protocol] ??= []).push(r.masked.value);
    }
    const pending = Number(a.SubscriptionsPending ?? 0) || t.subscriptions.filter((s) => s.SubscriptionArn === "PendingConfirmation").length;
    const confirmed = Number(a.SubscriptionsConfirmed ?? t.subscriptions.length - pending) || 0;
    resources.push({
      key,
      kind: "sns",
      provider: "sns",
      name: arnName(key),
      region,
      ...tagsOf(t.tags),
      health: "ok", // a topic reports no state of its own
      healthReason: pending ? `${plural(pending, "subscription")} awaiting confirmation` : undefined,
      ...(enrichment ? { enrichment } : {}),
      props: props([
        { label: SNS_P.type, value: attrsRead ? (a.FifoTopic === "true" ? "FIFO" : "Standard") : key.endsWith(".fifo") ? "FIFO" : undefined },
        { label: "Display name", value: a.DisplayName || undefined },
        { label: "Subscriptions", value: attrsRead || subsRead ? `${fmtCount(confirmed)} confirmed${pending ? ` · ${fmtCount(pending)} pending` : ""}` : undefined },
        { label: SNS_P.subscribers, value: subsRead ? subscriberSummary(t.subscriptions) || "none" : unread("", t.enrichment?.subscriptions).trim() },
        ...Object.entries(masked).map(([p, vs]) => ({ label: p === "sms" ? "SMS subscribers" : p.startsWith("email") ? "Email subscribers" : `${p} subscribers`, value: clip(vs.join(", "), 160) })),
        { label: "Encryption", value: !attrsRead ? undefined : a.KmsMasterKeyId ? `KMS ${a.KmsMasterKeyId.replace(/^arn:aws[\w-]*:kms:[^:]+:\d+:/, "")}` : "none" },
      ]),
      aliases: [arnName(key)],
      lastActivityAt: t.lastActivityAt,
      consoleUrl: snsConsoleUrl(key, region),
    });
    links.push(...encryptsLink(kmsKeyRef(a.KmsMasterKeyId, region, arn?.account), key, "messages", "topic attribute KmsMasterKeyId (SSE)"));
  }
  return { resources, links, mentions: [] };
}

// ---------- EventBridge ----------

export interface RawBus {
  Name?: string;
  Arn?: string;
  Description?: string;
  CreationTime?: Date;
  tags?: Record<string, string>; // undefined = not read (tagsUnread)
  enrichment?: Record<string, EnrichState>;
  lastActivityAt?: number;
}

export interface RawRule {
  Name?: string;
  Arn?: string;
  EventBusName?: string;
  State?: string;
  ScheduleExpression?: string;
  EventPattern?: string;
  Description?: string;
  ManagedBy?: string;
  RoleArn?: string;
  targets: EbTarget[];
  tags?: Record<string, string>; // undefined = not read (tagsUnread)
  enrichment?: Record<string, EnrichState>; // targets, tags
  lastActivityAt?: number;
}

export interface RawEvents {
  buses: RawBus[];
  rules: RawRule[];
  apiDestinations: Record<string, string>; // API destination ARN → invocation endpoint
}

export const EB_P = { state: "State", bus: "Bus", managedBy: "Managed by", targets: "Targets", schedule: "Schedule" } as const;

export function ruleConsoleUrl(bus: string, rule: string, region: string) {
  return `https://${region}.console.aws.amazon.com/events/home?region=${region}#/eventbus/${encodeURIComponent(bus)}/rules/${encodeURIComponent(rule)}`;
}
export function busConsoleUrl(bus: string, region: string) {
  return `https://${region}.console.aws.amazon.com/events/home?region=${region}#/eventbus/${encodeURIComponent(bus)}`;
}

// What a rule's target is called on the panel: "lambda acme-report", "sqs orders".
export const targetName = (t: EbTarget) => {
  const a = parseArn(t.Arn);
  return a ? `${a.service} ${arnName(t.Arn)}` : t.Arn ?? "?";
};

export function eventsResult(raw: RawEvents): ProviderResult {
  const resources: Resource[] = [];
  const links: Link[] = [];
  const busArn = new Map<string, string>();
  for (const b of raw.buses) if (b.Name && b.Arn) busArn.set(b.Name, b.Arn);
  const rulesOn = (bus: string) => raw.rules.filter((r) => (r.EventBusName ?? "default") === bus).length;
  for (const b of raw.buses) {
    if (!b.Name || !b.Arn) continue;
    const region = parseArn(b.Arn)?.region ?? "";
    const enrichment = enrichmentOf(b.enrichment);
    resources.push({
      key: b.Arn,
      kind: "eventbridge-bus",
      provider: "eventbridge",
      name: b.Name,
      region,
      ...tagsOf(b.tags),
      health: "ok",
      // The default bus exists in every region and its rules carry its story: listed (Resource Explorer reports it,
      // and targets may forward to it), never drawn.
      ...(b.Name === "default" ? { hidden: true } : {}),
      ...(enrichment ? { enrichment } : {}),
      props: props([
        { label: "Rules", value: String(rulesOn(b.Name)) },
        { label: "Description", value: b.Description ? clip(b.Description, 120) : undefined },
        { label: "Created", value: b.CreationTime ? fmtTime(b.CreationTime.getTime()) : undefined },
      ]),
      aliases: [b.Name],
      lastActivityAt: b.lastActivityAt,
      consoleUrl: busConsoleUrl(b.Name, region),
      createdAt: b.CreationTime?.getTime(),
    });
  }
  for (const r of raw.rules) {
    if (!r.Name || !r.Arn) continue;
    const bus = r.EventBusName ?? "default";
    const region = parseArn(r.Arn)?.region ?? "";
    const disabled = r.State === "DISABLED";
    const human = describeSchedule(r.ScheduleExpression);
    const targetsRead = (r.enrichment?.targets ?? "ok") === "ok";
    const enrichment = enrichmentOf(r.enrichment);
    resources.push({
      key: r.Arn,
      kind: "eventbridge-rule",
      provider: "eventbridge",
      name: r.Name,
      region,
      ...tagsOf(r.tags),
      health: disabled ? "stopped" : "ok",
      healthReason: disabled ? "rule disabled — its targets receive nothing" : undefined,
      ...(enrichment ? { enrichment } : {}),
      props: props([
        { label: EB_P.state, value: r.State ?? "?" },
        { label: EB_P.bus, value: bus },
        { label: EB_P.schedule, value: r.ScheduleExpression ? `${r.ScheduleExpression}${human ? ` — ${human}` : ""}` : undefined, mono: !human },
        { label: "Event pattern", value: patternSummary(r.EventPattern) },
        { label: EB_P.targets, value: !targetsRead ? unread("", r.enrichment?.targets).trim() : r.targets.length ? clip(r.targets.map(targetName).join(", "), 160) : "none" },
        { label: EB_P.managedBy, value: r.ManagedBy },
        { label: "Description", value: r.Description ? clip(r.Description, 120) : undefined },
      ]),
      aliases: [r.Name],
      lastActivityAt: r.lastActivityAt,
      consoleUrl: ruleConsoleUrl(bus, r.Name, region),
    });
    const from = busArn.get(bus);
    if (from && bus !== "default") links.push({ from, to: r.Arn, kind: "event", label: r.EventPattern ? "matching events" : "rule", evidence: `rule on event bus ${bus}${r.EventPattern ? `: ${patternSummary(r.EventPattern, 100)}` : ""}` });
    for (const t of r.targets) links.push(...ebTargetLinks(r.Arn, t, raw.apiDestinations));
    links.push(...ruleRoles(r.Arn, r));
  }
  return { resources, links, mentions: [] };
}

// The roles a rule runs as: its own (schedule or cross-bus delivery) and the ones EventBridge assumes to reach each
// target (Step Functions, Kinesis, ECS RunTask, another bus…), one link per role.
export function ruleRoles(key: string, r: Pick<RawRule, "RoleArn" | "targets">): Link[] {
  const roles = new Map<string, string[]>();
  if (r.RoleArn) roles.set(r.RoleArn, ["rule role"]);
  for (const t of r.targets) if (t.RoleArn) roles.set(t.RoleArn, [...(roles.get(t.RoleArn) ?? []), `target ${t.Id ?? "?"}`]);
  return [...roles].flatMap(([role, what]) => assumesLink(key, role, clip(what.join(", "), 60), `EventBridge rule configuration (${what.join(", ")} RoleArn)`));
}
