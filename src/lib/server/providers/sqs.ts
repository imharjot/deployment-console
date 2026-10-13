// SQS provider: queues with their depth (available / in flight / delayed), dead-letter redrive (queue → DLQ edge,
// "redrive after N receives"), redrive-allow policy, encryption (its KMS key: an encrypts edge) and FIFO settings; a
// dead-letter queue holding messages is a warning. Discovery lists, hands the list to ctx.checkpoint, then reads
// attributes and tags per queue through enrich() (R18); a queue whose tags weren't read is tagsUnread (R01). Actions:
// send a test message (sent once unless SQS deduplicates it — F31), redrive a DLQ back to its source queue(s), purge
// (danger: deletes every message; needs the provision permission).
import "server-only";
import {
  GetQueueAttributesCommand, ListMessageMoveTasksCommand, ListQueueTagsCommand, ListQueuesCommand, PurgeQueueCommand, SQSClient, SendMessageCommand,
  StartMessageMoveTaskCommand,
} from "@aws-sdk/client-sqs";
import {
  arnName, attributesProblem, byteLength, field, fmtBytes, fmtCount, fmtSeconds, fmtTime, parseArn, plural, propOf, queueArnFromUrl, queueUrlFromArn,
} from "../../inventory/serverless-common.ts";
import { SQS_P, queueDepth, redriveOf, sqsResult, sqsSendDeduplicated, type RawQueue } from "../../inventory/serverless-messaging.ts";
import type { Resource, ResourceDetail } from "../../inventory/types.ts";
import { simMoveTasks, simPurge, simQueueByArn, simQueueRate, simRedrive, simSend, simSqs } from "./mock/sqs.ts";
import { series } from "./mock/serverless-sim.ts";
import { budget, conflict, enrich, invalid, own, paged, perRegion, sdkConfig, simDelay, softly, t } from "./serverless-util.ts";
import type { ActionContext, Provider, ProviderAction, ProviderContext } from "./types.ts";

const sqs = perRegion((region) => new SQSClient(sdkConfig(region)), "sqs");
// F31: a send SQS doesn't deduplicate goes out once — a retry after a lost answer would deliver the message twice.
const sqsOnce = perRegion((region) => new SQSClient(sdkConfig(region, { maxAttempts: 1 })), "sqs");
const TAGS_MAX = 1000;
const MAX_BODY = 16 * 1024;
const AUTHORITATIVE_MS = 5_000; // the live tag read before a change (R01)

const regionOf = (r: Resource, fallback: string) => parseArn(r.key)?.region || r.region || fallback;
// The queue URL ListQueues gave (an alias), else built from the ARN. SQS sends each call to its queue URL's host.
const urlOf = (r: Resource) => r.aliases?.find((a) => /^https?:\/\/[^/]+\/\d{12}\/[\w.-]+$/.test(a)) ?? queueUrlFromArn(r.key) ?? "";

async function fetchSqs(ctx: ProviderContext): Promise<RawQueue[]> {
  const c = sqs(ctx.region);
  const urls = await paged(ctx, "sqs", async (NextToken) => {
    const r = await c.send(new ListQueuesCommand({ NextToken, MaxResults: 1000 }), t(ctx));
    return { items: r.QueueUrls, next: r.NextToken };
  }, { service: "sqs" });
  const base = (url: string): RawQueue => ({ url, attributes: { QueueArn: queueArnFromUrl(url) ?? "" }, enrichment: { attributes: "skipped", tags: "skipped" } });
  ctx.checkpoint?.(sqsResult(urls.map(base)));
  const until = budget();
  const [attrs, tags] = await Promise.all([
    enrich(ctx, urls, { label: "sqs queue attributes", max: ctx.cap, until }, async (url) => (await c.send(new GetQueueAttributesCommand({ QueueUrl: url, AttributeNames: ["All"] }), t(ctx))).Attributes ?? {}),
    enrich(ctx, urls, { label: "sqs tags", max: TAGS_MAX, until }, async (url) => (await c.send(new ListQueueTagsCommand({ QueueUrl: url }), t(ctx))).Tags ?? {}),
  ]);
  return urls.map((url, i): RawQueue => {
    const attributes = { ...(attrs.results[i] ?? {}) };
    delete attributes.Policy; // the access policy is never shown and never needed
    attributes.QueueArn ||= queueArnFromUrl(url) ?? "";
    return { url, attributes, tags: tags.state[i] === "ok" ? (tags.results[i] ?? {}) : undefined, enrichment: { attributes: attrs.state[i], tags: tags.state[i] } };
  });
}

// ---------- detail ----------

const ATTR_ROWS: [string, string, (v: string) => string][] = [
  ["ApproximateNumberOfMessages", "Messages available", (v) => fmtCount(Number(v))],
  ["ApproximateNumberOfMessagesNotVisible", "In flight", (v) => fmtCount(Number(v))],
  ["ApproximateNumberOfMessagesDelayed", "Delayed", (v) => fmtCount(Number(v))],
  ["VisibilityTimeout", "Visibility timeout", (v) => fmtSeconds(Number(v))],
  ["MessageRetentionPeriod", "Retention", (v) => fmtSeconds(Number(v))],
  ["DelaySeconds", "Delivery delay", (v) => fmtSeconds(Number(v))],
  ["ReceiveMessageWaitTimeSeconds", "Receive wait (long polling)", (v) => fmtSeconds(Number(v))],
  ["MaximumMessageSize", "Max message size", (v) => fmtBytes(Number(v))],
  ["FifoQueue", "FIFO", (v) => v],
  ["ContentBasedDeduplication", "Content-based deduplication", (v) => v],
  ["DeduplicationScope", "Deduplication scope", (v) => v],
  ["FifoThroughputLimit", "FIFO throughput limit", (v) => v],
  ["KmsMasterKeyId", "KMS key", (v) => v],
  ["KmsDataKeyReusePeriodSeconds", "KMS data key reuse", (v) => fmtSeconds(Number(v))],
  ["SqsManagedSseEnabled", "SSE-SQS", (v) => v],
  ["CreatedTimestamp", "Created", (v) => fmtTime(Number(v) * 1000)],
  ["LastModifiedTimestamp", "Last modified", (v) => fmtTime(Number(v) * 1000)],
];

function buildDetail(r: Resource, attrs: Record<string, string>, tasks: { status: string; moved?: number; toMove?: number; started?: number }[], rate?: number): ResourceDetail {
  const redrive = redriveOf(attrs);
  const sections: ResourceDetail["sections"] = [
    { title: "Queue", rows: ATTR_ROWS.filter(([k]) => attrs[k] !== undefined && attrs[k] !== "").map(([k, label, f]) => ({ label, value: f(attrs[k]), mono: k === "KmsMasterKeyId" })) },
  ];
  if (redrive?.deadLetterTargetArn) sections.push({ title: "Dead-letter queue", rows: [{ label: "Queue", value: arnName(redrive.deadLetterTargetArn), mono: true }, { label: "After", value: `${redrive.maxReceiveCount ?? "?"} receives` }] });
  if (propOf(r, SQS_P.dlqFor)) {
    sections.push({
      title: "Redrive (message move tasks)",
      table: tasks.length ? { columns: ["Status", "Moved", "Started"], rows: tasks.map((x) => [x.status, `${fmtCount(x.moved ?? 0)} of ${x.toMove === undefined ? "?" : fmtCount(x.toMove)}`, fmtTime(x.started)]) } : undefined,
      note: `Dead-letter queue for ${propOf(r, SQS_P.dlqFor)}.${tasks.length ? "" : " No redrive has run recently."} Use “Redrive to source” to move messages back.`,
    });
  }
  const now = Date.now();
  return { key: r.key, sections, metrics: rate !== undefined ? [{ id: "sent", label: "Messages sent (hourly)", points: series(`${r.key}:sent`, now, 24, 3_600_000, rate) }] : undefined };
}

async function realDetail(r: Resource, ctx: ProviderContext): Promise<ResourceDetail> {
  const c = sqs(regionOf(r, ctx.region));
  const [a, tasks] = await Promise.all([
    softly(ctx, "sqs queue attributes")(() => c.send(new GetQueueAttributesCommand({ QueueUrl: urlOf(r), AttributeNames: ["All"] }), t(ctx))),
    propOf(r, SQS_P.dlqFor) ? softly(ctx, "sqs message move tasks")(() => c.send(new ListMessageMoveTasksCommand({ SourceArn: r.key, MaxResults: 5 }), t(ctx))) : undefined,
  ]);
  const attrs = { ...(a?.Attributes ?? {}) };
  delete attrs.Policy;
  return buildDetail(r, attrs, (tasks?.Results ?? []).map((x) => ({ status: x.Status ?? "?", moved: x.ApproximateNumberOfMessagesMoved, toMove: x.ApproximateNumberOfMessagesToMove, started: x.StartedTimestamp })));
}

function mockDetail(r: Resource): ResourceDetail {
  const raw = simSqs(regionOf(r, "")).find((q) => q.attributes.QueueArn === r.key);
  if (!raw) return { key: r.key, sections: [{ title: "Not found", note: "This queue no longer exists in the simulated account." }] };
  const tasks = propOf(r, SQS_P.dlqFor) ? simMoveTasks(r.name).map((x) => ({ status: x.status, moved: x.moved, toMove: x.toMove, started: x.startedAt })) : [];
  return buildDetail(r, raw.attributes, tasks, simQueueRate(r.name));
}

// ---------- actions ----------

async function liveAttrs(r: Resource, ctx: ActionContext): Promise<Record<string, string>> {
  if (ctx.mock) {
    const q = simSqs(regionOf(r, ctx.region)).find((x) => x.attributes.QueueArn === r.key);
    if (!q) throw invalid(`queue ${r.name} not found`);
    return q.attributes;
  }
  const a = await sqs(regionOf(r, ctx.region)).send(new GetQueueAttributesCommand({ QueueUrl: urlOf(r), AttributeNames: ["All"] }), t());
  return a.Attributes ?? {};
}

type SendInput = { body: string; attributes?: Record<string, unknown>; groupId?: string; deduplicationId?: string; delaySeconds?: number };

function sendProblem(i: SendInput, attrs: Record<string, string>): string | undefined {
  if (typeof i.body !== "string" || !i.body.length) return "body is required";
  if (byteLength(i.body) > MAX_BODY) return `body is ${fmtBytes(byteLength(i.body))} — at most ${fmtBytes(MAX_BODY)}`;
  const a = attributesProblem(own<Record<string, unknown>>(i, "attributes"));
  if (a) return a;
  const fifo = attrs.FifoQueue === "true";
  if (fifo && !i.groupId) return "a FIFO queue needs groupId (MessageGroupId)";
  if (fifo && !i.deduplicationId && attrs.ContentBasedDeduplication !== "true") return "this FIFO queue has no content-based deduplication — give deduplicationId";
  if (!fifo && (i.groupId || i.deduplicationId)) return "groupId / deduplicationId only apply to FIFO queues";
  if (fifo && i.delaySeconds) return "FIFO queues don't support per-message delays";
  return undefined;
}

const sendTest: ProviderAction<SendInput> = {
  id: "send-test-message",
  kind: "sqs",
  title: "Send a test message",
  description:
    "Sends one message to the queue: body (text, at most 16 KB), optional string attributes (at most 10), and for FIFO queues groupId and — without content-based deduplication — deduplicationId; delaySeconds (0–900) on standard queues. Whatever consumes the queue will process it like any other message. Sent once (never retried) unless a FIFO deduplication id lets SQS drop a duplicate. Returns the message id.",
  risk: "danger", // reaches real consumers (functions, queues, people): treated like invoking them
  perm: "act",
  summary: "Sends one message to the queue; its consumers process it like any other.",
  iam: ["sqs:SendMessage"],
  undo: "Irreversible — its consumers may already have processed the message",
  verifies: "SQS returns a message id; the queue's message count shows it until it is consumed",
  retrySafe: false,
  input: {
    type: "object",
    additionalProperties: false,
    required: ["body"],
    properties: {
      body: field("Message body", { type: "string", minLength: 1, maxLength: MAX_BODY, description: "Message body (at most 16 KB)." }),
      attributes: field("Message attributes (optional)", { type: "object", description: "Message attributes: name → string value (at most 10)." }),
      groupId: field("Message group id (FIFO)", { type: "string", pattern: "^[\\x21-\\x7E]{1,128}$", description: "FIFO only: MessageGroupId." }),
      deduplicationId: field("Deduplication id (FIFO)", { type: "string", pattern: "^[\\x21-\\x7E]{1,128}$", description: "FIFO only: MessageDeduplicationId." }),
      delaySeconds: field("Delay in seconds (standard queues)", { type: "integer", minimum: 0, maximum: 900, description: "Standard queues only: delay delivery." }),
    },
  },
  async plan(r, i, ctx) {
    const attrs = await liveAttrs(r, ctx);
    const problem = sendProblem(i, attrs);
    if (problem) throw invalid(problem);
    const n = Object.keys(own<Record<string, unknown>>(i, "attributes") ?? {}).length;
    return {
      summary: `Send a ${fmtBytes(byteLength(i.body))} test message to ${r.name}`,
      changes: [`message: ${fmtBytes(byteLength(i.body))}${n ? `, ${plural(n, "attribute")}` : ""}${i.groupId ? `, group ${i.groupId}` : ""}${i.delaySeconds ? `, delayed ${fmtSeconds(i.delaySeconds)}` : ""}`],
      warnings: ["whatever consumes this queue will process the message like any other"],
    };
  },
  async run(r, i, ctx) {
    const attrs = await liveAttrs(r, ctx);
    const problem = sendProblem(i, attrs);
    if (problem) throw invalid(problem);
    if (ctx.mock) {
      await simDelay(250);
      return { queue: r.name, ...simSend(r.name) };
    }
    const MessageAttributes = Object.fromEntries(Object.entries(own<Record<string, string>>(i, "attributes") ?? {}).map(([k, v]) => [k, { DataType: "String", StringValue: v }]));
    const client = sqsSendDeduplicated(attrs, i.deduplicationId) ? sqs : sqsOnce;
    const out = await client(regionOf(r, ctx.region)).send(new SendMessageCommand({
      QueueUrl: urlOf(r), MessageBody: i.body, MessageAttributes: Object.keys(MessageAttributes).length ? MessageAttributes : undefined,
      MessageGroupId: i.groupId, MessageDeduplicationId: i.deduplicationId, DelaySeconds: i.delaySeconds,
    }), t());
    return { queue: r.name, messageId: out.MessageId, sequenceNumber: out.SequenceNumber };
  },
};

const redrive: ProviderAction<{ maxPerSecond?: number }> = {
  id: "redrive",
  kind: "sqs",
  title: "Redrive to source",
  description:
    "For a dead-letter queue: moves its messages back to the queue(s) they came from (SQS message move task), optionally at most maxPerSecond (1–500) messages per second. Refused on queues that aren't a dead-letter queue, when it's empty, or while another move task runs. Returns the task handle; progress shows in the queue's panel.",
  risk: "change",
  perm: "act",
  summary: "Moves the dead-letter queue's messages back to the queue(s) they came from.",
  iam: ["sqs:StartMessageMoveTask"],
  undo: "Not undoable — messages that fail again come back to this dead-letter queue",
  verifies: "The move task in the queue's panel reaches COMPLETED and the dead-letter queue empties",
  retrySafe: false, // a second task moves whatever arrived since
  input: { type: "object", additionalProperties: false, properties: { maxPerSecond: field("Messages per second (optional)", { type: "integer", minimum: 1, maximum: 500, description: "Rate limit (default: as fast as SQS allows)." }) } },
  when: (r) => {
    if (!propOf(r, SQS_P.dlqFor)) return "not a dead-letter queue — no queue redrives into it";
    if (propOf(r, SQS_P.visible) === "0") return "the queue is empty";
    return undefined;
  },
  async plan(r, i, ctx) {
    const attrs = await liveAttrs(r, ctx);
    const { visible } = queueDepth(attrs);
    if (!visible) throw conflict(`${r.name} holds no messages to move`);
    const sources = propOf(r, SQS_P.dlqFor) ?? "their source queue";
    return {
      summary: `Move ${plural(visible, "message")} from ${r.name} back to ${sources}`,
      changes: [`messages return to the queue each came from (${sources})${i.maxPerSecond ? `, at most ${i.maxPerSecond}/s` : ""}`],
      warnings: ["the consumers of the source queue will process them again — if the failure's cause isn't fixed they land back here"],
    };
  },
  async run(r, i, ctx) {
    if (!propOf(r, SQS_P.dlqFor)) throw invalid("not a dead-letter queue — no queue redrives into it");
    if (ctx.mock) {
      await simDelay(400);
      return { queue: r.name, ...simRedrive(r.name) };
    }
    const out = await sqs(regionOf(r, ctx.region)).send(new StartMessageMoveTaskCommand({ SourceArn: r.key, MaxNumberOfMessagesPerSecond: i.maxPerSecond }), t());
    return { queue: r.name, taskHandle: out.TaskHandle };
  },
};

const purge: ProviderAction<Record<string, never>> = {
  id: "purge",
  kind: "sqs",
  title: "Purge queue",
  description: "Deletes every message in the queue (available, in flight and delayed). Cannot be undone; SQS allows one purge per queue every 60 seconds. The plan shows how many messages go, and asks for the queue name.",
  risk: "danger",
  perm: "provision",
  summary: "Deletes every message in the queue.",
  iam: ["sqs:PurgeQueue"],
  undo: "Irreversible — messages are deleted",
  verifies: "Messages available and in flight drop to 0 within about a minute",
  retrySafe: false, // a second purge would also delete the messages sent since the first: never repeated blindly
  input: { type: "object", additionalProperties: false, properties: {} },
  when: (r) => (propOf(r, SQS_P.visible) === "0" && propOf(r, SQS_P.inFlight) === "0" && !propOf(r, SQS_P.delayed) ? "the queue is already empty" : undefined),
  async plan(r, _i, ctx) {
    const d = queueDepth(await liveAttrs(r, ctx));
    return {
      summary: `Delete every message in ${r.name} (${fmtCount(d.visible)} available, ${fmtCount(d.inFlight)} in flight${d.delayed ? `, ${fmtCount(d.delayed)} delayed` : ""})`,
      changes: ["purge: all messages are deleted within about a minute"],
      warnings: ["cannot be undone — the messages are gone for good", ...(propOf(r, SQS_P.dlqFor) ? ["this is a dead-letter queue: purging discards the failed messages instead of redriving them"] : [])],
      confirm: r.name,
    };
  },
  async run(r, _i, ctx) {
    if (ctx.mock) {
      await simDelay(400);
      return { queue: r.name, ...simPurge(r.name) };
    }
    await sqs(regionOf(r, ctx.region)).send(new PurgeQueueCommand({ QueueUrl: urlOf(r) }), t());
    return { queue: r.name, purged: true };
  },
};

export const sqsProvider: Provider = {
  id: "sqs",
  label: "SQS",
  scope: "regional",
  kinds: ["sqs"],
  covers: ["sqs:queue"],
  multiRegionMock: true,
  read: ["sqs:ListQueues", "sqs:GetQueueAttributes", "sqs:ListQueueTags", "sqs:ListMessageMoveTasks"],
  write: ["sqs:SendMessage", "sqs:StartMessageMoveTask", "sqs:PurgeQueue"],
  // A move task receives from the DLQ and deletes there; encrypted queues need the KMS key for sends.
  implicit: ["sqs:ReceiveMessage", "sqs:DeleteMessage", "kms:GenerateDataKey", "kms:Decrypt"],
  async discover(ctx) {
    return sqsResult(ctx.mock ? simSqs(ctx.region) : await fetchSqs(ctx));
  },
  activity: (r) => [
    { namespace: "AWS/SQS", metric: "NumberOfMessagesSent", dims: { QueueName: r.name }, stat: "Sum", label: "Messages sent", region: regionOf(r, r.region), required: true },
    { namespace: "AWS/SQS", metric: "NumberOfMessagesReceived", dims: { QueueName: r.name }, stat: "Sum", label: "Messages received", region: regionOf(r, r.region) },
  ],
  detail: (r, ctx) => (ctx.mock ? Promise.resolve(mockDetail(r)) : realDetail(r, ctx)),
  // R01: the queue's tags, read live right before a change (5 s; throws when they can't be read).
  async authoritative(r, ctx) {
    if (ctx.mock) {
      const q = simQueueByArn(r.key);
      if (!q) throw invalid(`queue ${r.name} not found`);
      return { tags: { ...q.tags } };
    }
    const out = await sqs(regionOf(r, ctx.region)).send(new ListQueueTagsCommand({ QueueUrl: urlOf(r) }), t(undefined, AUTHORITATIVE_MS));
    return { tags: out.Tags ?? {} };
  },
  actions: [sendTest, redrive, purge] as ProviderAction[],
};
