import { test } from "node:test";
import assert from "node:assert/strict";
import {
  arnName, assumesLink, attributesProblem, awsTime, describeSchedule, ebTargetLinks, editEnv, encryptsLink, enrichmentOf, envMentions, eventSourceKey, field, hostOf,
  jsonProblem, kmsKeyRef, lambdaBase, lambdaEnvNameProblem, lambdaRef, lbNameFromListener, logGroupRef, logsLink, maskEmail, maskPhone, parseArn, patternSummary,
  pickFields, queueArnFromUrl, queueUrlFromArn, runtimeDeprecation, snsSubscription, tagsOf, unread,
} from "./serverless-common.ts";

const FN = "arn:aws:lambda:us-east-1:123456789012:function:orders";

test("ARNs: parse, name, Lambda qualifiers, references", () => {
  assert.deepEqual(parseArn("arn:aws:sqs:eu-west-1:123456789012:jobs"), { partition: "aws", service: "sqs", region: "eu-west-1", account: "123456789012", resource: "jobs" });
  assert.equal(parseArn("not-an-arn"), undefined);
  assert.equal(arnName("arn:aws:dynamodb:us-east-1:1:table/carts"), "carts");
  assert.equal(lambdaBase(`${FN}:live`), FN);
  assert.equal(lambdaBase(`${FN}:$LATEST`), FN);
  assert.equal(lambdaBase(FN), FN);
  assert.equal(lambdaRef("orders", "us-east-1", "123456789012"), FN);
  assert.equal(lambdaRef("orders:live", "us-east-1", "123456789012"), FN);
  assert.equal(lambdaRef("123456789012:function:orders", "us-east-1", "999999999999"), FN);
  assert.equal(lambdaRef(`${FN}:7`, "x", "y"), FN);
});

test("event sources: DynamoDB streams → table, Kinesis consumers → stream", () => {
  assert.equal(eventSourceKey("arn:aws:dynamodb:us-east-1:1:table/carts/stream/2025-11-02T09:14:07.311"), "arn:aws:dynamodb:us-east-1:1:table/carts");
  assert.equal(eventSourceKey("arn:aws:kinesis:us-east-1:1:stream/clicks/consumer/rec:1719000000"), "arn:aws:kinesis:us-east-1:1:stream/clicks");
  assert.equal(eventSourceKey("arn:aws:sqs:us-east-1:1:q"), "arn:aws:sqs:us-east-1:1:q");
});

test("queue URLs ↔ ARNs, listener → load balancer, hosts", () => {
  assert.equal(queueArnFromUrl("https://sqs.eu-west-1.amazonaws.com/123456789012/jobs.fifo"), "arn:aws:sqs:eu-west-1:123456789012:jobs.fifo");
  assert.equal(queueArnFromUrl("https://queue.amazonaws.com/123456789012/legacy"), "arn:aws:sqs:us-east-1:123456789012:legacy");
  assert.equal(queueArnFromUrl("https://example.com/123456789012/x"), undefined);
  assert.equal(queueUrlFromArn("arn:aws:sqs:eu-west-1:123456789012:jobs"), "https://sqs.eu-west-1.amazonaws.com/123456789012/jobs");
  assert.equal(lbNameFromListener("arn:aws:elasticloadbalancing:us-east-1:1:listener/app/shop-prod/5f2c/9b8a"), "shop-prod");
  assert.equal(hostOf("https://Hooks.Example.net/a/b?token=x"), "hooks.example.net");
  assert.equal(hostOf("wss://abc.execute-api.us-east-1.amazonaws.com"), "abc.execute-api.us-east-1.amazonaws.com");
  assert.equal(hostOf("api.example.com"), "api.example.com");
  assert.equal(hostOf(undefined), undefined);
});

test("timestamps AWS writes", () => {
  assert.equal(awsTime("2024-05-01T10:00:00.000+0000"), Date.UTC(2024, 4, 1, 10));
  assert.equal(awsTime("1714557600"), 1714557600_000); // SQS epoch seconds
  assert.equal(awsTime(new Date(5)), 5);
  assert.equal(awsTime("garbage"), undefined);
});

test("masking: enough to recognise, not to harvest", () => {
  assert.equal(maskEmail("ops-team@acme.example"), "o…@acme.example");
  assert.equal(maskEmail("nope"), "…");
  assert.equal(maskPhone("+15555550142"), "+…42");
});

test("filter policies and event patterns in one line", () => {
  assert.equal(patternSummary(JSON.stringify({ source: ["acme.shop"], "detail-type": ["OrderPlaced"], detail: { total: [{ numeric: [">", 0, "<=", 100] }] } })), "source: acme.shop; detail-type: OrderPlaced; detail.total: > 0 ≤ 100");
  assert.equal(patternSummary(JSON.stringify({ event: [{ prefix: "order." }, { "anything-but": ["test"] }], id: [{ exists: false }] })), "event: starts with order. | not test; id: missing");
  assert.equal(patternSummary(JSON.stringify({ $or: [{ a: ["1"] }, { b: ["2"] }] })), "(a: 1) or (b: 2)");
  assert.equal(patternSummary("{oops"), "(unreadable pattern)");
  assert.equal(patternSummary(undefined), undefined);
  assert.ok(patternSummary(JSON.stringify({ k: Array.from({ length: 100 }, (_, i) => `value-${i}`) }), 50)!.length <= 50);
});

test("schedules", () => {
  assert.equal(describeSchedule("rate(5 minutes)"), "every 5 minutes");
  assert.equal(describeSchedule("rate(1 hour)"), "every hour");
  assert.equal(describeSchedule("cron(0 2 * * ? *)"), "daily at 02:00 UTC");
  assert.equal(describeSchedule("cron(30 9 ? * MON-FRI *)"), "MON-FRI at 09:30 UTC");
  assert.equal(describeSchedule("cron(15 * * * ? *)"), "hourly at :15");
  assert.equal(describeSchedule("cron(0 4 1 * ? *)"), "monthly on day 1 at 04:00 UTC");
  assert.equal(describeSchedule("cron(0/5 8-17 ? * MON-FRI *)"), undefined);
});

test("EventBridge targets → links (qualifiers stripped, API destinations by host, ECS tasks, DLQs)", () => {
  const rule = "arn:aws:events:us-east-1:1:rule/r";
  const [fn] = ebTargetLinks(rule, { Id: "a", Arn: `${FN}:live`, InputPath: "$.detail" });
  assert.deepEqual(fn, { from: rule, to: FN, kind: "event", label: "target", evidence: "EventBridge target a (input path $.detail)" });
  const dest = "arn:aws:events:us-east-1:1:api-destination/crm/1234";
  const [api] = ebTargetLinks(rule, { Id: "b", Arn: dest }, { [dest]: "https://crm.example.com/hooks/abc?key=secret" });
  assert.equal(api.to, "crm.example.com");
  assert.ok(!JSON.stringify(api).includes("secret"));
  const [ecs] = ebTargetLinks(rule, { Id: "c", Arn: "arn:aws:ecs:us-east-1:1:cluster/prod", EcsParameters: { TaskDefinitionArn: "arn:aws:ecs:us-east-1:1:task-definition/report:12", LaunchType: "FARGATE" } });
  assert.equal(ecs.kind, "invoke");
  assert.equal(ecs.label, "run task report:12");
  const withDlq = ebTargetLinks(rule, { Id: "d", Arn: "arn:aws:sqs:us-east-1:1:q", DeadLetterConfig: { Arn: "arn:aws:sqs:us-east-1:1:dlq" } });
  assert.equal(withDlq.length, 2);
  assert.equal(withDlq[1].to, "arn:aws:sqs:us-east-1:1:dlq");
  assert.deepEqual(ebTargetLinks(rule, { Id: "e" }), []);
});

test("SNS subscriptions: resources linked, webhooks by host only, people masked", () => {
  const topic = "arn:aws:sns:us-east-1:1:t";
  const l = snsSubscription(topic, { SubscriptionArn: `${topic}:1`, Protocol: "lambda", Endpoint: `${FN}:live`, filterPolicy: JSON.stringify({ channel: ["email"] }) });
  assert.equal(l.links[0].to, FN);
  assert.match(l.links[0].evidence, /filter: channel: email/);
  const h = snsSubscription(topic, { SubscriptionArn: "PendingConfirmation", Protocol: "https", Endpoint: "https://hooks.example.net/acme/notify?token=abc" });
  assert.equal(h.links[0].to, "hooks.example.net");
  assert.equal(h.links[0].label, "webhook https (pending)");
  assert.ok(!JSON.stringify(h).includes("token") && !JSON.stringify(h).includes("/acme/notify"));
  const e = snsSubscription(topic, { SubscriptionArn: `${topic}:2`, Protocol: "email", Endpoint: "dev@acme.example" });
  assert.deepEqual(e, { links: [], masked: { protocol: "email", value: "d…@acme.example" } });
  const q = snsSubscription(topic, { SubscriptionArn: `${topic}:3`, Protocol: "sqs", Endpoint: "arn:aws:sqs:us-east-1:1:q", rawDelivery: true, redriveTo: "arn:aws:sqs:us-east-1:1:dlq" });
  assert.equal(q.links.length, 2);
  assert.match(q.links[0].evidence, /raw delivery/);
});

test("env mentions: one per variable, names in `via`, flags and numbers skipped", () => {
  const m = envMentions(FN, { QUEUE_URL: "https://sqs.us-east-1.amazonaws.com/1/q", DEBUG: "true", PORT: "8080", TABLES: "carts,sessions", X: "ab" });
  assert.deepEqual(m.map((x) => x.via), ["env QUEUE_URL", "env TABLES"]);
  assert.deepEqual(m[1].refs, ["carts,sessions", "carts", "sessions"]);
  assert.equal(envMentions(FN, undefined).length, 0);
});

test("input checks", () => {
  assert.equal(jsonProblem(undefined, 10), undefined);
  assert.equal(jsonProblem('{"a":1}', 100), undefined);
  assert.match(jsonProblem("{a:1}", 100)!, /isn't valid JSON/);
  assert.match(jsonProblem('{"a":"' + "x".repeat(100) + '"}', 64, "the test event")!, /at most 64 B/);
  assert.equal(attributesProblem({ source: "check" }), undefined);
  assert.match(attributesProblem({ "aws.x": "1" })!, /isn't a valid attribute name/);
  assert.match(attributesProblem({ a: 1 as unknown as string })!, /non-empty string/);
  assert.match(attributesProblem(Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`a${i}`, "v"])))!, /at most 10/);
});

test("Lambda variables: names, reserved names, edits by name, the 4 KB limit", () => {
  assert.equal(lambdaEnvNameProblem("DB_HOST"), undefined);
  assert.match(lambdaEnvNameProblem("1BAD")!, /isn't a valid/);
  assert.match(lambdaEnvNameProblem("AWS_REGION")!, /reserved/);
  const e = editEnv({ A: "1", B: "2", C: "3" }, { A: "1", B: "two", D: "4" }, ["C"]);
  // Every name set is "changed" — even A with its old value: the plan never compares against current values.
  assert.deepEqual([e.added, e.changed, e.removed, e.problems], [["D"], ["A", "B"], ["C"], []]);
  assert.deepEqual(e.next, { A: "1", B: "two", D: "4" });
  assert.deepEqual(editEnv({}, {}, ["NOPE"]).problems, ['"NOPE" isn\'t set, nothing to remove']);
  assert.match(editEnv({}, { A: "x" }, ["A"]).problems.join(), /both set and removed/);
  assert.match(editEnv({}, { BIG: "x".repeat(5000) }).problems.join(), /exceed Lambda's 4 KB limit/);
  assert.doesNotMatch(editEnv({}, { BIG: "x".repeat(5000) }).problems.join(), /total|5 KB|4\.9/, "no exact size");
  assert.match(editEnv({}, { N: 5 as unknown as string }).problems.join(), /must be a string/);
});

test("runtime deprecation dates", () => {
  const now = Date.UTC(2026, 8, 27);
  assert.deepEqual(runtimeDeprecation("nodejs18.x", now), { date: "2025-09-01", deprecated: true, soon: false });
  assert.equal(runtimeDeprecation("nodejs22.x", now), undefined);
  assert.deepEqual(runtimeDeprecation("dotnet8", now), { date: "2026-11-10", deprecated: false, soon: true });
});

test("support links: KMS references in the resource's region, roles only as role ARNs, log groups without ':*'", () => {
  assert.equal(kmsKeyRef("alias/aws/sqs", "eu-west-1", "123456789012"), "arn:aws:kms:eu-west-1:123456789012:alias/aws/sqs");
  assert.equal(kmsKeyRef("mrk-0acme", "us-east-1", "123456789012"), "arn:aws:kms:us-east-1:123456789012:key/mrk-0acme");
  assert.equal(kmsKeyRef("arn:aws:kms:us-west-2:1:key/k", "us-east-1", "2"), "arn:aws:kms:us-west-2:1:key/k", "an ARN stands");
  assert.equal(kmsKeyRef("alias/x", "us-east-1", undefined), undefined, "no account: nothing to build");
  assert.equal(kmsKeyRef(" ", "us-east-1", "1"), undefined);
  assert.equal(kmsKeyRef("alias/aws/sqs", "cn-north-1", "123456789012"), "arn:aws-cn:kms:cn-north-1:123456789012:alias/aws/sqs");
  assert.deepEqual(encryptsLink("arn:k", FN, "x", "y"), [{ from: "arn:k", to: FN, kind: "encrypts", label: "x", evidence: "y" }]);
  assert.deepEqual(encryptsLink(undefined, FN, "x", "y"), []);
  assert.equal(assumesLink(FN, "arn:aws:iam::123456789012:role/service-role/x", "r", "e").length, 1);
  assert.deepEqual(assumesLink(FN, "arn:aws:iam::123456789012:user/x", "r", "e"), [], "not a role");
  assert.deepEqual(logsLink(FN, "arn:aws:logs:us-east-1:1:log-group:/a:*", "l", "e"), [{ from: FN, to: "arn:aws:logs:us-east-1:1:log-group:/a", kind: "logs", label: "l", evidence: "e" }]);
  assert.deepEqual(logsLink(FN, "not-an-arn", "l", "e"), []);
  assert.equal(logGroupRef("/aws/lambda/orders", "us-east-1", "1"), "arn:aws:logs:us-east-1:1:log-group:/aws/lambda/orders");
});

test("R01: tags read vs not read; enrichment states; why a read is missing", () => {
  assert.deepEqual(tagsOf(undefined), { tags: {}, tagsUnread: true });
  assert.deepEqual(tagsOf({}), { tags: {} }, "read, none: not unread");
  assert.deepEqual(tagsOf([{ Key: "a", Value: "1" }]), { tags: { a: "1" } });
  assert.deepEqual(enrichmentOf({ tags: "capped", state: undefined }), { tags: "capped" });
  assert.equal(enrichmentOf({ state: undefined }), undefined);
  assert.equal(unread("deployment state", "denied"), "deployment state not read (denied)");
  assert.equal(unread("deployment state", undefined), "deployment state not read (skipped)");
});

test("F42: input fields carry a title (and a group); audit summaries keep named own fields only", () => {
  assert.deepEqual(field("S3 bucket", { type: "string", description: "d" }, "s3"), { title: "S3 bucket", type: "string", description: "d", "x-group": "s3" });
  assert.deepEqual(field("Body", { type: "string" }), { title: "Body", type: "string" });
  assert.deepEqual(pickFields({ a: 1, b: "log tail", c: undefined }, ["a", "c", "d"]), { a: 1 });
  assert.deepEqual(pickFields(Object.create({ a: 1 }), ["a"]), {}, "own fields only");
  assert.deepEqual(pickFields(null, ["a"]), {});
});
