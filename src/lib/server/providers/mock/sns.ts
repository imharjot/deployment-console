// Simulated SNS topics of the Acme account (names from ../mock-names.ts): production notifications fan out to the
// email-sender Lambda (filtered to email events), the emails queue and a partner webhook on hooks.example.net, plus an
// email subscriber, encrypted with the application KMS key; the staging topic has a webhook still awaiting
// confirmation; alarms mail the on-call address and receive the email sender's failed invocations. Only us-east-1 has
// topics. Publishing a test message delivers to the simulated queue too.
import type { SnsSub } from "../../../inventory/serverless-common.ts";
import type { RawTopic } from "../../../inventory/serverless-messaging.ts";
import { ACCT, KMS_KEYS, LAMBDA, REGION, SNS, SQS } from "../mock-names.ts";
import { DAY, HOUR, MIN, simState } from "./serverless-sim.ts";
import { simQueueByArn, simSend } from "./sqs.ts";

interface SimTopic {
  arn: string;
  attrs: Record<string, string>;
  subs: SnsSub[];
  tags: Record<string, string>;
  activeAgo: number;
  published: number;
}

const sub = (topic: string, n: number, s: Omit<SnsSub, "SubscriptionArn"> & { pending?: boolean }): SnsSub => {
  const { pending, ...rest } = s;
  return { SubscriptionArn: pending ? "PendingConfirmation" : `${topic}:0000${n}aaaa-bbbb-cccc-dddd-${String(n).padStart(12, "0")}`, ...rest };
};

function build(): Record<string, SimTopic> {
  const n = SNS.notifications.arn;
  const stg = SNS.notificationsStaging.arn;
  const alarms = SNS.alarms.arn;
  const attrs = (displayName: string, extra: Record<string, string> = {}) => ({ DisplayName: displayName, Owner: ACCT, ...extra });
  return {
    [SNS.notifications.name]: {
      arn: n,
      attrs: attrs("Acme notifications", { KmsMasterKeyId: KMS_KEYS.app.alias }),
      subs: [
        sub(n, 1, { Protocol: "lambda", Endpoint: LAMBDA.emailSender.arn, filterPolicy: JSON.stringify({ channel: ["email"] }) }),
        sub(n, 2, { Protocol: "sqs", Endpoint: SQS.emails.arn, rawDelivery: true }),
        sub(n, 3, { Protocol: "https", Endpoint: "https://hooks.example.net/acme/notify?token=sim-only-token", filterPolicy: JSON.stringify({ event_type: ["order.shipped", "order.refunded"] }) }),
        sub(n, 4, { Protocol: "email", Endpoint: "ops-team@acme.example" }),
      ],
      tags: { Environment: "production", Team: "shop" },
      activeAgo: 90_000,
      published: 0,
    },
    [SNS.notificationsStaging.name]: {
      arn: stg,
      attrs: attrs("Acme notifications (staging)"),
      subs: [
        sub(stg, 1, { Protocol: "email", Endpoint: "dev@acme.example" }),
        sub(stg, 2, { Protocol: "https", Endpoint: "https://hooks.example.net/acme-staging/notify", pending: true }),
      ],
      tags: { Environment: "staging", Team: "shop" },
      activeAgo: 2 * HOUR,
      published: 0,
    },
    [SNS.alarms.name]: {
      arn: alarms,
      attrs: attrs("Acme alarms"),
      subs: [sub(alarms, 1, { Protocol: "email", Endpoint: "oncall@acme.example" }), sub(alarms, 2, { Protocol: "sms", Endpoint: "+15555550142" })],
      tags: {},
      activeAgo: 3 * DAY + 20 * MIN,
      published: 0,
    },
  };
}

const state = () => simState("__dcSimSns", build);

export const simTopic = (name: string): SimTopic | undefined => state()[name];

export function simSns(region: string = REGION): RawTopic[] {
  if (region !== REGION) return [];
  const now = Date.now();
  return Object.values(state()).map((t) => {
    const pending = t.subs.filter((s) => s.SubscriptionArn === "PendingConfirmation").length;
    return {
      arn: t.arn,
      attributes: { ...t.attrs, TopicArn: t.arn, SubscriptionsConfirmed: String(t.subs.length - pending), SubscriptionsPending: String(pending), SubscriptionsDeleted: "0" },
      subscriptions: t.subs.map((s) => ({ ...s })),
      tags: { ...t.tags },
      lastActivityAt: now - t.activeAgo,
    };
  });
}

// Like Publish: returns a message id; confirmed SQS subscribers receive it in the simulated queue.
export function simPublish(name: string): { messageId: string; delivered: string[] } {
  const t = state()[name];
  if (!t) throw Object.assign(new Error("Topic does not exist"), { name: "NotFoundException" });
  t.activeAgo = 0;
  t.published += 1;
  const delivered: string[] = [];
  for (const s of t.subs) {
    if (s.SubscriptionArn === "PendingConfirmation") continue;
    const q = s.Protocol === "sqs" && s.Endpoint ? simQueueByArn(s.Endpoint) : undefined;
    if (q) simSend(q.url.split("/").pop()!);
    delivered.push(s.Protocol ?? "?");
  }
  return { messageId: crypto.randomUUID(), delivered };
}
