import { test } from "node:test";
import assert from "node:assert/strict";
import { eventsResult, ruleRoles, snsResult, sqsResult, sqsSendDeduplicated, subscriberSummary } from "./serverless-messaging.ts";

const Q = (name: string) => ({ arn: `arn:aws:sqs:us-east-1:123456789012:${name}`, url: `https://sqs.us-east-1.amazonaws.com/123456789012/${name}` });

test("SQS: redrive edge, DLQ detected from the source's policy, warning only when it holds messages", () => {
  const orders = Q("orders");
  const dlq = Q("failed-orders"); // no "dlq" in the name: found through the redrive policy
  const r = sqsResult([
    { url: orders.url, attributes: { QueueArn: orders.arn, ApproximateNumberOfMessages: "12", RedrivePolicy: JSON.stringify({ deadLetterTargetArn: dlq.arn, maxReceiveCount: 5 }) } },
    { url: dlq.url, attributes: { QueueArn: dlq.arn, ApproximateNumberOfMessages: "3", ApproximateNumberOfMessagesNotVisible: "1", KmsMasterKeyId: "alias/app" } },
  ]);
  assert.deepEqual(r.links, [
    { from: orders.arn, to: dlq.arn, kind: "event", label: "redrive after 5 receives", evidence: "redrive policy (maxReceiveCount 5)" },
    // A bare alias becomes an alias ARN in the queue's own region and account (CC-19).
    { from: "arn:aws:kms:us-east-1:123456789012:alias/app", to: dlq.arn, kind: "encrypts", label: "messages", evidence: "queue attribute KmsMasterKeyId (SSE-KMS)" },
  ]);
  const [o, d] = r.resources;
  assert.equal(o.health, "ok");
  assert.equal(o.props.find((p) => p.label === "Dead-letter queue")?.value, "failed-orders after 5 receives");
  assert.equal(d.health, "warning");
  assert.equal(d.healthReason, "dead-letter queue holds 4 messages");
  assert.equal(d.props.find((p) => p.label === "Dead-letter queue for")?.value, "orders");
  assert.equal(d.props.find((p) => p.label === "Encryption")?.value, "KMS alias/app");
  assert.deepEqual(o.aliases, [orders.url, "orders"]);
  const empty = sqsResult([{ url: Q("x-dlq").url, attributes: { QueueArn: Q("x-dlq").arn, ApproximateNumberOfMessages: "0" } }]).resources[0];
  assert.equal(empty.health, "ok");
  assert.ok(empty.props.some((p) => p.label === "Dead-letter queue for")); // named like a DLQ
});

test("SQS: attributes not read → unknown (never a healthy-looking DLQ); tags not read → tagsUnread; KMS alias in the queue's region", () => {
  const eu = { arn: "arn:aws:sqs:eu-west-1:123456789012:jobs-dlq", url: "https://sqs.eu-west-1.amazonaws.com/123456789012/jobs-dlq" };
  const [q] = sqsResult([{ url: eu.url, attributes: { QueueArn: eu.arn }, enrichment: { attributes: "denied", tags: "skipped" } }]).resources;
  assert.deepEqual([q.health, q.healthReason, q.tagsUnread, q.enrichment], ["unknown", "queue attributes not read (denied)", true, { attributes: "denied", tags: "skipped" }]);
  assert.equal(q.props.find((p) => p.label === "Messages available")?.value, "not read (denied)");
  const enc = sqsResult([{ url: eu.url, attributes: { QueueArn: eu.arn, KmsMasterKeyId: "alias/aws/sqs" }, tags: {} }]);
  assert.equal(enc.links[0].from, "arn:aws:kms:eu-west-1:123456789012:alias/aws/sqs");
  assert.equal(enc.resources[0].tagsUnread, undefined);
  // F31: only a FIFO send with an explicit deduplication id may be retried by the SDK.
  assert.equal(sqsSendDeduplicated({ FifoQueue: "true" }, "d-1"), true);
  assert.equal(sqsSendDeduplicated({ FifoQueue: "true", ContentBasedDeduplication: "true" }, undefined), false);
  assert.equal(sqsSendDeduplicated({}, "d-1"), false);
});

test("SNS: subscriber links, masked people, pending counts", () => {
  const topic = "arn:aws:sns:us-east-1:1:notify";
  const r = snsResult([{
    arn: topic,
    attributes: { SubscriptionsConfirmed: "3", SubscriptionsPending: "1", DisplayName: "Notify" },
    subscriptions: [
      { SubscriptionArn: `${topic}:a`, Protocol: "lambda", Endpoint: "arn:aws:lambda:us-east-1:1:function:send" },
      { SubscriptionArn: `${topic}:b`, Protocol: "sqs", Endpoint: "arn:aws:sqs:us-east-1:1:emails" },
      { SubscriptionArn: "PendingConfirmation", Protocol: "https", Endpoint: "https://hooks.example.net/x?t=1" },
      { SubscriptionArn: `${topic}:c`, Protocol: "email", Endpoint: "alice@example.com" },
      { SubscriptionArn: `${topic}:d`, Protocol: "email", Endpoint: "bob@example.com" },
    ],
  }]);
  assert.deepEqual(r.links.map((l) => l.to), ["arn:aws:lambda:us-east-1:1:function:send", "arn:aws:sqs:us-east-1:1:emails", "hooks.example.net"]);
  const t = r.resources[0];
  assert.equal(t.props.find((p) => p.label === "Email subscribers")?.value, "a…@example.com, b…@example.com");
  assert.equal(t.props.find((p) => p.label === "Subscriptions")?.value, "3 confirmed · 1 pending");
  assert.match(t.healthReason!, /1 subscription awaiting confirmation/);
  assert.ok(!JSON.stringify(r).includes("alice@") && !JSON.stringify(r).includes("t=1"));
  assert.equal(subscriberSummary([{ Protocol: "email" }, { Protocol: "EMAIL" }, { Protocol: "sqs" }]), "email 2 · sqs 1");
  assert.equal(t.tagsUnread, true, "tags weren't read");
  const kms = snsResult([{ arn: topic, attributes: { KmsMasterKeyId: "arn:aws:kms:us-east-1:1:key/k-1" }, subscriptions: [], tags: {}, enrichment: { attributes: "ok", subscriptions: "capped", tags: "ok" } }]);
  assert.deepEqual(kms.links.map((l) => [l.kind, l.from, l.to]), [["encrypts", "arn:aws:kms:us-east-1:1:key/k-1", topic]]);
  assert.equal(kms.resources[0].props.find((p) => p.label === "Subscribers")?.value, "not read (capped)");
});

test("EventBridge: the default bus listed but hidden, bus → rule → targets, disabled rules stopped", () => {
  const shop = "arn:aws:events:us-east-1:1:event-bus/shop";
  const r = eventsResult({
    buses: [{ Name: "default", Arn: "arn:aws:events:us-east-1:1:event-bus/default" }, { Name: "shop", Arn: shop }],
    rules: [
      { Name: "nightly", Arn: "arn:aws:events:us-east-1:1:rule/nightly", EventBusName: "default", State: "ENABLED", ScheduleExpression: "cron(0 2 * * ? *)", targets: [{ Id: "1", Arn: "arn:aws:lambda:us-east-1:1:function:report" }] },
      { Name: "placed", Arn: "arn:aws:events:us-east-1:1:rule/shop/placed", EventBusName: "shop", State: "DISABLED", EventPattern: JSON.stringify({ source: ["shop"] }), targets: [{ Id: "q", Arn: "arn:aws:sqs:us-east-1:1:orders" }] },
    ],
    apiDestinations: {},
  });
  // Resource Explorer lists the default bus in every region: listed (so it isn't a key-format bug), never drawn.
  assert.deepEqual(r.resources.map((x) => [x.kind, x.name, !!x.hidden]), [["eventbridge-bus", "default", true], ["eventbridge-bus", "shop", false], ["eventbridge-rule", "nightly", false], ["eventbridge-rule", "placed", false]]);
  assert.equal(r.resources[2].props.find((p) => p.label === "Schedule")?.value, "cron(0 2 * * ? *) — daily at 02:00 UTC");
  assert.equal(r.resources[3].health, "stopped");
  assert.equal(r.resources[1].props.find((p) => p.label === "Rules")?.value, "1");
  assert.ok(r.resources.every((x) => x.tagsUnread), "no tags were read");
  assert.deepEqual(r.links.map((l) => [l.from.split(":").pop(), l.to.split(":").pop(), l.kind]), [
    ["rule/nightly", "report", "event"],
    ["event-bus/shop", "rule/shop/placed", "event"],
    ["rule/shop/placed", "orders", "event"],
  ]);
});

test("EventBridge: the roles a rule and its targets run as, one link per role; targets not read say so", () => {
  const rule = "arn:aws:events:us-east-1:123456789012:rule/shop/placed";
  const role = "arn:aws:iam::123456789012:role/events-start-checkout";
  assert.deepEqual(ruleRoles(rule, { RoleArn: role, targets: [{ Id: "checkout", Arn: "arn:aws:states:us-east-1:123456789012:stateMachine:checkout", RoleArn: role }, { Id: "q", Arn: "arn:aws:sqs:us-east-1:123456789012:q" }] }), [
    { from: rule, to: role, kind: "assumes", label: "rule role, target checkout", evidence: "EventBridge rule configuration (rule role, target checkout RoleArn)" },
  ]);
  const r = eventsResult({ buses: [], rules: [{ Name: "placed", Arn: rule, EventBusName: "shop", State: "ENABLED", targets: [], tags: {}, enrichment: { targets: "skipped", tags: "ok" } }], apiDestinations: {} });
  assert.equal(r.resources[0].props.find((p) => p.label === "Targets")?.value, "not read (skipped)");
  assert.equal(r.resources[0].tagsUnread, undefined);
});
