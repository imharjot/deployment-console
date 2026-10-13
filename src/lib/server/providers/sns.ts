// SNS provider: topics and their subscriptions — Lambda / SQS / Firehose subscribers become edges, HTTP(S) webhooks an
// edge to the endpoint's host (never its path: webhook URLs often carry tokens), email and SMS subscribers are masked
// ("o…@acme.example"). Filter policies are summarised in the edge evidence; the topic's KMS key is an encrypts edge.
// Discovery lists, hands the list to ctx.checkpoint, then reads attributes, subscriptions and tags per topic through
// enrich() (R18); a topic whose tags weren't read is tagsUnread (R01). Action: publish a test message (sent once — F31).
import "server-only";
import {
  GetSubscriptionAttributesCommand, GetTopicAttributesCommand, ListSubscriptionsByTopicCommand, ListTagsForResourceCommand, ListTopicsCommand, PublishCommand,
  SNSClient,
} from "@aws-sdk/client-sns";
import { arnName, attributesProblem, byteLength, field, fmtBytes, hostOf, maskEmail, maskPhone, parseArn, patternSummary, plural, tagMap, type SnsSub } from "../../inventory/serverless-common.ts";
import { SNS_P, snsResult, subscriberSummary, type RawTopic } from "../../inventory/serverless-messaging.ts";
import type { Resource, ResourceDetail } from "../../inventory/types.ts";
import { simPublish, simSns, simTopic } from "./mock/sns.ts";
import { budget, enrich, invalid, own, paged, perRegion, sdkConfig, simDelay, softly, t } from "./serverless-util.ts";
import type { ActionContext, Provider, ProviderAction, ProviderContext } from "./types.ts";

const sns = perRegion((region) => new SNSClient(sdkConfig(region)), "sns");
// F31: a publish goes out once — a retry after a lost answer would deliver to every subscriber twice.
const snsOnce = perRegion((region) => new SNSClient(sdkConfig(region, { maxAttempts: 1 })), "sns");
const SUBS_PER_TOPIC = 200; // subscriptions listed per topic
const SUB_ATTRS_PER_TOPIC = 25; // subscriptions whose filter policy / redrive are read
const TAGS_MAX = 1000;
const MAX_MESSAGE = 16 * 1024;
const AUTHORITATIVE_MS = 5_000; // the live tag read before a change (R01)

const regionOf = (r: Resource, fallback: string) => parseArn(r.key)?.region || r.region || fallback;
const WITH_ATTRS = new Set(["lambda", "sqs", "firehose", "http", "https"]);

async function subscriptionsOf(c: SNSClient, TopicArn: string, ctx: { signal?: AbortSignal }): Promise<SnsSub[]> {
  const out: SnsSub[] = [];
  let NextToken: string | undefined;
  do {
    const r = await c.send(new ListSubscriptionsByTopicCommand({ TopicArn, NextToken }), t(ctx));
    out.push(...(r.Subscriptions ?? []).map((s) => ({ SubscriptionArn: s.SubscriptionArn, Protocol: s.Protocol, Endpoint: s.Endpoint })));
    NextToken = r.NextToken;
  } while (NextToken && out.length < SUBS_PER_TOPIC);
  return out;
}

// Filter policy, raw delivery and dead-letter queue of the subscriptions that have them (not email / SMS).
async function subscriptionDetails(c: SNSClient, subs: SnsSub[], ctx: { signal?: AbortSignal }, soft: ReturnType<typeof softly>) {
  const detailed = subs.filter((s) => s.SubscriptionArn?.startsWith("arn:") && WITH_ATTRS.has((s.Protocol ?? "").toLowerCase())).slice(0, SUB_ATTRS_PER_TOPIC);
  await Promise.all(detailed.map(async (s) => {
    const x = (await soft(() => c.send(new GetSubscriptionAttributesCommand({ SubscriptionArn: s.SubscriptionArn }), t(ctx))))?.Attributes;
    if (!x) return;
    s.filterPolicy = x.FilterPolicy || undefined;
    s.filterPolicyScope = x.FilterPolicyScope || undefined;
    s.rawDelivery = x.RawMessageDelivery === "true";
    try {
      s.redriveTo = x.RedrivePolicy ? (JSON.parse(x.RedrivePolicy) as { deadLetterTargetArn?: string }).deadLetterTargetArn : undefined;
    } catch {
      s.redriveTo = undefined;
    }
  }));
}

async function fetchSns(ctx: ProviderContext): Promise<RawTopic[]> {
  const c = sns(ctx.region);
  const arns = await paged(ctx, "sns", async (NextToken) => {
    const r = await c.send(new ListTopicsCommand({ NextToken }), t(ctx));
    return { items: (r.Topics ?? []).map((x) => x.TopicArn!).filter(Boolean), next: r.NextToken };
  }, { service: "sns" });
  const skipped = { attributes: "skipped", subscriptions: "skipped", tags: "skipped" } as const;
  ctx.checkpoint?.(snsResult(arns.map((arn) => ({ arn, attributes: {}, subscriptions: [], enrichment: { ...skipped } }))));
  const until = budget();
  const subAttrs = softly(ctx, "sns subscription filter policies", { until, service: "sns" });
  const [attrs, subs, tags] = await Promise.all([
    enrich(ctx, arns, { label: "sns topic attributes", max: ctx.cap, until }, async (arn) => (await c.send(new GetTopicAttributesCommand({ TopicArn: arn }), t(ctx))).Attributes ?? {}),
    enrich(ctx, arns, { label: "sns subscriptions", max: ctx.cap, until }, async (arn) => {
      const list = await subscriptionsOf(c, arn, ctx);
      await subscriptionDetails(c, list, ctx, subAttrs);
      return list;
    }),
    enrich(ctx, arns, { label: "sns tags", max: TAGS_MAX, until }, async (arn) => tagMap((await c.send(new ListTagsForResourceCommand({ ResourceArn: arn }), t(ctx))).Tags)),
  ]);
  return arns.map((arn, i): RawTopic => {
    const attributes = { ...(attrs.results[i] ?? {}) };
    for (const k of ["Policy", "DeliveryPolicy", "EffectiveDeliveryPolicy", "DataProtectionPolicy"]) delete attributes[k];
    return {
      arn, attributes, subscriptions: subs.results[i] ?? [], tags: tags.state[i] === "ok" ? (tags.results[i] ?? {}) : undefined,
      enrichment: { attributes: attrs.state[i], subscriptions: subs.state[i], tags: tags.state[i] },
    };
  });
}

// ---------- detail ----------

// A subscriber as the panel shows it: resources by name, webhooks by host, people masked.
function endpointLabel(s: SnsSub): string {
  const p = (s.Protocol ?? "").toLowerCase();
  const e = s.Endpoint ?? "";
  if (p === "email" || p === "email-json") return maskEmail(e);
  if (p === "sms") return maskPhone(e);
  if (p === "http" || p === "https") return `${p}://${hostOf(e) ?? "?"}/…`;
  if (e.startsWith("arn:")) return arnName(e);
  return "…";
}

function buildDetail(r: Resource, subs: SnsSub[]): ResourceDetail {
  return {
    key: r.key,
    sections: [
      {
        title: "Subscriptions",
        table: subs.length ? {
          columns: ["Protocol", "Endpoint", "Status", "Filter", "Options"],
          rows: subs.map((s) => [
            s.Protocol ?? "?", endpointLabel(s), s.SubscriptionArn === "PendingConfirmation" ? "pending confirmation" : "confirmed",
            patternSummary(s.filterPolicy, 100) ?? "", [s.rawDelivery && "raw delivery", s.redriveTo && `DLQ ${arnName(s.redriveTo)}`].filter(Boolean).join(", "),
          ]),
        } : undefined,
        note: subs.length ? "Email and SMS subscribers are masked; webhook paths are hidden (they often hold tokens)." : "No subscriptions.",
      },
    ],
  };
}

async function liveSubs(r: Resource, ctx: ActionContext): Promise<SnsSub[]> {
  if (ctx.mock) return simSns(regionOf(r, ctx.region)).find((x) => x.arn === r.key)?.subscriptions ?? [];
  return subscriptionsOf(sns(regionOf(r, ctx.region)), r.key, {});
}

async function detailSubs(r: Resource, ctx: ProviderContext): Promise<SnsSub[]> {
  if (ctx.mock) return simSns(regionOf(r, ctx.region)).find((x) => x.arn === r.key)?.subscriptions ?? [];
  const c = sns(regionOf(r, ctx.region));
  const subs = (await softly(ctx, "sns subscriptions")(() => subscriptionsOf(c, r.key, ctx))) ?? [];
  await subscriptionDetails(c, subs, ctx, softly(ctx, "sns subscription filter policies"));
  return subs;
}

// ---------- actions ----------

type PublishInput = { message: string; subject?: string; attributes?: Record<string, unknown>; groupId?: string; deduplicationId?: string };

function publishProblem(r: Resource, i: PublishInput): string | undefined {
  if (typeof i.message !== "string" || !i.message.length) return "message is required";
  if (byteLength(i.message) > MAX_MESSAGE) return `message is ${fmtBytes(byteLength(i.message))} — at most ${fmtBytes(MAX_MESSAGE)}`;
  if (i.subject !== undefined && (/[\r\n]/.test(i.subject) || !i.subject.trim())) return "subject must be one non-empty line";
  const a = attributesProblem(own<Record<string, unknown>>(i, "attributes"));
  if (a) return a;
  const fifo = r.props.find((p) => p.label === SNS_P.type)?.value === "FIFO";
  if (fifo && !i.groupId) return "a FIFO topic needs groupId (MessageGroupId)";
  if (!fifo && (i.groupId || i.deduplicationId)) return "groupId / deduplicationId only apply to FIFO topics";
  return undefined;
}

const publishTest: ProviderAction<PublishInput> = {
  id: "publish-test",
  kind: "sns",
  title: "Publish a test message",
  description:
    "Publishes one message to the topic: message (text, at most 16 KB), optional subject (one line, email subscribers see it), string attributes (at most 10, matched by filter policies) and, for FIFO topics, groupId / deduplicationId. Every matching subscriber receives it — functions run, queues get it, webhooks are called, and emails / SMS really go out (the plan counts them). Sent once, never retried (a retry could deliver it twice). Returns the message id.",
  risk: "danger", // reaches real consumers (functions, queues, people): treated like invoking them
  perm: "act",
  summary: "Publishes one message to the topic; every matching subscriber receives it.",
  iam: ["sns:Publish"],
  undo: "Irreversible — emails, SMS and webhook calls can't be recalled",
  verifies: "SNS returns a message id",
  retrySafe: false,
  input: {
    type: "object",
    additionalProperties: false,
    required: ["message"],
    properties: {
      message: field("Message", { type: "string", minLength: 1, maxLength: MAX_MESSAGE, description: "Message text (at most 16 KB)." }),
      subject: field("Subject (optional)", { type: "string", maxLength: 100, description: "Subject line (email subscribers)." }),
      attributes: field("Message attributes (optional)", { type: "object", description: "Message attributes: name → string value (at most 10)." }),
      groupId: field("Message group id (FIFO)", { type: "string", pattern: "^[\\x21-\\x7E]{1,128}$", description: "FIFO only: MessageGroupId." }),
      deduplicationId: field("Deduplication id (FIFO)", { type: "string", pattern: "^[\\x21-\\x7E]{1,128}$", description: "FIFO only: MessageDeduplicationId." }),
    },
  },
  async plan(r, i, ctx) {
    const problem = publishProblem(r, i);
    if (problem) throw invalid(problem);
    const subs = (await liveSubs(r, ctx)).filter((s) => s.SubscriptionArn !== "PendingConfirmation");
    const people = subs.filter((s) => /^(email|email-json|sms)$/i.test(s.Protocol ?? "")).length;
    const hooks = subs.filter((s) => /^https?$/i.test(s.Protocol ?? "")).length;
    return {
      summary: `Publish a ${fmtBytes(byteLength(i.message))} test message to ${r.name}`,
      changes: [`delivers to ${subs.length ? subscriberSummary(subs) : "no confirmed subscriber"} (before filter policies)`],
      warnings: [
        ...(people ? [`${plural(people, "email / SMS subscriber")} will really receive it`] : []),
        ...(hooks ? [`${plural(hooks, "webhook")} will be called`] : []),
        ...(subs.some((s) => /^(lambda|sqs|firehose)$/i.test(s.Protocol ?? "")) ? ["subscribed functions and queues process it like any other message"] : []),
      ],
    };
  },
  async run(r, i, ctx) {
    const problem = publishProblem(r, i);
    if (problem) throw invalid(problem);
    if (ctx.mock) {
      await simDelay(300);
      return { topic: r.name, ...simPublish(r.name) };
    }
    const MessageAttributes = Object.fromEntries(Object.entries(own<Record<string, string>>(i, "attributes") ?? {}).map(([k, v]) => [k, { DataType: "String", StringValue: v }]));
    const out = await snsOnce(regionOf(r, ctx.region)).send(new PublishCommand({
      TopicArn: r.key, Message: i.message, Subject: i.subject, MessageAttributes: Object.keys(MessageAttributes).length ? MessageAttributes : undefined,
      MessageGroupId: i.groupId, MessageDeduplicationId: i.deduplicationId,
    }), t());
    return { topic: r.name, messageId: out.MessageId };
  },
};

export const snsProvider: Provider = {
  id: "sns",
  label: "SNS",
  scope: "regional",
  kinds: ["sns"],
  covers: ["sns:topic"],
  multiRegionMock: true,
  read: ["sns:ListTopics", "sns:GetTopicAttributes", "sns:ListSubscriptionsByTopic", "sns:GetSubscriptionAttributes", "sns:ListTagsForResource"],
  write: ["sns:Publish"],
  implicit: ["kms:GenerateDataKey", "kms:Decrypt"], // publishing to a topic encrypted with a customer-managed key
  async discover(ctx) {
    return snsResult(ctx.mock ? simSns(ctx.region) : await fetchSns(ctx));
  },
  activity: (r) => [{ namespace: "AWS/SNS", metric: "NumberOfMessagesPublished", dims: { TopicName: r.name }, stat: "Sum", label: "Messages published", region: regionOf(r, r.region), required: true }],
  async detail(r, ctx) {
    return buildDetail(r, await detailSubs(r, ctx));
  },
  // R01: the topic's tags, read live right before a change (5 s; throws when they can't be read).
  async authoritative(r, ctx) {
    if (ctx.mock) {
      const topic = simTopic(arnName(r.key));
      if (!topic || topic.arn !== r.key) throw invalid(`topic ${r.name} not found`);
      return { tags: { ...topic.tags } };
    }
    const out = await sns(regionOf(r, ctx.region)).send(new ListTagsForResourceCommand({ ResourceArn: r.key }), t(undefined, AUTHORITATIVE_MS));
    return { tags: tagMap(out.Tags) };
  },
  actions: [publishTest] as ProviderAction[],
};
