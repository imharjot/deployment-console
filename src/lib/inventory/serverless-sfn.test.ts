import { test } from "node:test";
import assert from "node:assert/strict";
import { NAME_WINDOW_MS, aslRefs, aslStates, defaultExecutionName, sfnResult } from "./serverless-sfn.ts";

const SM = "arn:aws:states:eu-west-1:123456789012:stateMachine:checkout";
const fn = (n: string) => `arn:aws:lambda:eu-west-1:123456789012:function:${n}`;

const DEF = JSON.stringify({
  StartAt: "A",
  States: {
    A: { Type: "Task", Resource: "arn:aws:states:::lambda:invoke", Parameters: { FunctionName: `${fn("reserve")}:$LATEST`, "Payload.$": "$" }, Next: "B" },
    B: { Type: "Task", Resource: fn("direct"), Next: "C" },
    C: { Type: "Task", Resource: "arn:aws:states:::lambda:invoke.waitForTaskToken", Parameters: { FunctionName: "approve:live" }, Next: "D" },
    D: { Type: "Task", Resource: "arn:aws:states:::sns:publish", Parameters: { TopicArn: "arn:aws:sns:eu-west-1:123456789012:notify", "Message.$": "$" }, Next: "E" },
    E: { Type: "Task", Resource: "arn:aws:states:::sqs:sendMessage", Parameters: { QueueUrl: "https://sqs.eu-west-1.amazonaws.com/123456789012/jobs", MessageBody: "x" }, Next: "F" },
    F: {
      Type: "Parallel",
      Branches: [
        { StartAt: "G", States: { G: { Type: "Task", Resource: "arn:aws:states:::dynamodb:getItem", Parameters: { TableName: "carts", Key: {} }, End: true } } },
        { StartAt: "H", States: { H: { Type: "Task", Resource: "arn:aws:states:::dynamodb:putItem", Parameters: { TableName: "carts", Item: {} }, End: true } } },
      ],
      Next: "I",
    },
    I: {
      Type: "Map",
      ItemProcessor: { StartAt: "J", States: { J: { Type: "Task", Resource: "arn:aws:states:::aws-sdk:s3:putObject", Parameters: { Bucket: "exports", Key: "k", Body: "b" }, End: true } } },
      Next: "K",
    },
    K: { Type: "Task", Resource: "arn:aws:states:::ecs:runTask.sync", Parameters: { Cluster: "prod", TaskDefinition: "report:3" }, Next: "L" },
    L: { Type: "Task", Resource: "arn:aws:states:::states:startExecution.sync:2", Parameters: { StateMachineArn: "arn:aws:states:eu-west-1:123456789012:stateMachine:child" }, Next: "M" },
    M: { Type: "Task", Resource: "arn:aws:states:::lambda:invoke", Parameters: { "FunctionName.$": "$.fn" }, Next: "N" },
    N: { Type: "Task", Resource: "arn:aws:states:::http:invoke", Parameters: { ApiEndpoint: "https://api.partner.example/v1/orders", Method: "POST" }, Next: "O" },
    O: { Type: "Task", Resource: "arn:aws:states:::lambda:invoke", Arguments: { FunctionName: "{% $states.input.fn %}" }, Next: "P" },
    P: { Type: "Task", Resource: "arn:aws:states:::lambda:invoke", Parameters: { FunctionName: fn("reserve") }, Next: "Done" },
    Done: { Type: "Succeed" },
  },
});

test("aslRefs: every integration form, deduplicated, dynamic paths skipped", () => {
  const refs = aslRefs(DEF, SM);
  const by = (to: string, kind: string) => refs.find((r) => r.to === to && r.kind === kind);
  assert.deepEqual(by(fn("reserve"), "invoke")?.states, ["A", "P"]); // one edge for two states
  assert.ok(by(fn("direct"), "invoke"));
  assert.ok(by(fn("approve"), "invoke")); // name:alias → unqualified ARN in the machine's account/region
  assert.ok(by("arn:aws:sns:eu-west-1:123456789012:notify", "writes"));
  assert.ok(by("arn:aws:sqs:eu-west-1:123456789012:jobs", "writes")); // queue URL → ARN
  assert.ok(by("arn:aws:dynamodb:eu-west-1:123456789012:table/carts", "reads"));
  assert.ok(by("arn:aws:dynamodb:eu-west-1:123456789012:table/carts", "writes"));
  assert.ok(by("arn:aws:s3:::exports", "writes")); // inside a Map
  assert.ok(by("arn:aws:ecs:eu-west-1:123456789012:cluster/prod", "invoke"));
  assert.ok(by("arn:aws:states:eu-west-1:123456789012:stateMachine:child", "invoke"));
  assert.ok(by("api.partner.example", "invoke"));
  assert.equal(refs.length, 11); // M and O (run-time paths) add nothing
});

test("aslStates and bad definitions", () => {
  const states = aslStates(DEF, SM);
  assert.equal(states.find((s) => s.name === "J")?.target, "arn:aws:s3:::exports");
  assert.equal(states.find((s) => s.name === "Done")?.type, "Succeed");
  assert.deepEqual(aslRefs("{not json", SM), []);
  assert.deepEqual(aslRefs(undefined, SM), []);
});

test("sfnResult: resource, links with state names, unreadable definition is a warning", () => {
  const r = sfnResult([
    { stateMachineArn: SM, name: "checkout", type: "STANDARD", status: "ACTIVE", definition: DEF, tags: { Environment: "production" } },
    { stateMachineArn: `${SM}-broken`, name: "broken", definition: "{nope" },
  ]);
  assert.equal(r.resources.length, 2);
  assert.equal(r.resources[0].kind, "stepfunctions");
  assert.equal(r.resources[0].health, "ok");
  assert.equal(r.resources[1].health, "warning");
  const l = r.links.find((x) => x.to === fn("reserve"))!;
  assert.equal(l.from, SM);
  assert.match(l.evidence, /"A", "P"/);
  assert.match(r.resources[0].consoleUrl!, /states\/home\?region=eu-west-1/);
});

test("sfnResult: role, log groups (logging on) and the customer-managed key; not described → unknown; tags not read → tagsUnread", () => {
  const role = "arn:aws:iam::123456789012:role/checkout-sfn";
  const group = "arn:aws:logs:eu-west-1:123456789012:log-group:/aws/vendedlogs/states/checkout";
  const r = sfnResult([{
    stateMachineArn: SM, name: "checkout", type: "STANDARD", status: "ACTIVE", definition: "{}", roleArn: role, tags: {},
    loggingConfiguration: { level: "ERROR", destinations: [{ cloudWatchLogsLogGroup: { logGroupArn: `${group}:*` } }] },
    encryptionConfiguration: { type: "CUSTOMER_MANAGED_KMS_KEY", kmsKeyId: "alias/app" },
  }]);
  assert.deepEqual(r.links.map((l) => [l.kind, l.from, l.to]), [
    ["assumes", SM, role],
    ["logs", SM, group], // without the ":*" the API appends
    ["encrypts", "arn:aws:kms:eu-west-1:123456789012:alias/app", SM],
  ]);
  assert.equal(r.resources[0].tagsUnread, undefined);
  const off = sfnResult([{ stateMachineArn: SM, status: "ACTIVE", definition: "{}", loggingConfiguration: { level: "OFF", destinations: [{ cloudWatchLogsLogGroup: { logGroupArn: group } }] } }]);
  assert.deepEqual(off.links, [], "logging off: no log edge");
  const [listed] = sfnResult([{ stateMachineArn: SM, name: "checkout", type: "EXPRESS", enrichment: { definition: "skipped", tags: "skipped" } }]).resources;
  assert.deepEqual([listed.health, listed.healthReason, listed.tagsUnread], ["unknown", "definition not read (skipped)", true]);
});

test("F31: the default execution name is stable within a quarter-hour for the same machine, input and caller", () => {
  const at = Date.UTC(2026, 9, 5, 14, 16);
  const name = defaultExecutionName(SM, "{}", "op@example.com", at);
  assert.match(name, /^console-202610051415-[0-9a-f]{16}$/);
  assert.ok(name.length <= 80);
  assert.equal(defaultExecutionName(SM, "{}", "op@example.com", at + 10 * 60_000), name, "plan and confirm minutes apart: the same name");
  assert.notEqual(defaultExecutionName(SM, "{}", "op@example.com", at + NAME_WINDOW_MS), name, "the next quarter-hour starts a new one");
  assert.notEqual(defaultExecutionName(SM, '{"a":1}', "op@example.com", at), name, "another input");
  assert.notEqual(defaultExecutionName(SM, "{}", "other@example.com", at), name, "another caller");
  assert.notEqual(defaultExecutionName(`${SM}-2`, "{}", "op@example.com", at), name, "another machine");
});
