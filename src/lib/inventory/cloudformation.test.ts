import { test } from "node:test";
import assert from "node:assert/strict";
import { cfnDetail, cfnResults, safeOutput, stackHealth, stackResourceRef, type CfnRaw, type RawStack } from "./cloudformation.ts";
import { simStackEvents, simStackResources, simStacks } from "../server/providers/mock/cloudformation.ts";
import type { Resource } from "./types.ts";

const R = "us-east-1";
const A = "123456789012";
const NOW = Date.parse("2026-10-05T12:00:00Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const SENTINEL = "SENTINEL-cfn-3e8f10";
const stackArn = (name: string, n: number) => `arn:aws:cloudformation:${R}:${A}:stack/${name}/0000000${n}-aaaa-4bbb-8ccc-000000000000`;

// Golden: DescribeStacks shapes. Parameter values, an output that is a password, a connection string with credentials
// and a webhook URL with a token carry the sentinel: none may reach the map.
const APP: RawStack = {
  StackId: stackArn("app", 1), StackName: "app", StackStatus: "UPDATE_COMPLETE", Description: "the app", CreationTime: new Date(NOW - 100 * DAY), LastUpdatedTime: new Date(NOW - 2 * DAY),
  Parameters: [{ ParameterKey: "DbPassword", ParameterValue: SENTINEL }, { ParameterKey: "Env", ParameterValue: "production" }],
  Outputs: [
    { OutputKey: "TopicArn", OutputValue: `arn:aws:sns:${R}:${A}:alerts` },
    { OutputKey: "AlbHost", OutputValue: "app-1234.us-east-1.elb.amazonaws.com" },
    { OutputKey: "VpcId", OutputValue: "vpc-0a1b2c3d4e5f60789" },
    { OutputKey: "Site", OutputValue: "https://app.example.com/login?next=/" },
    { OutputKey: "DbUrl", OutputValue: `postgres://app:${SENTINEL}@db.example.com:5432/app` },
    { OutputKey: "Hook", OutputValue: `https://hooks.slack.com/services/T0001/B0002/${SENTINEL}9x` },
    { OutputKey: "AdminPassword", OutputValue: SENTINEL },
  ],
  Tags: [{ Key: "Environment", Value: "production" }],
  RoleARN: `arn:aws:iam::${A}:role/cfn-deployer`,
  NotificationARNs: [`arn:aws:sns:${R}:${A}:stack-events`],
  EnableTerminationProtection: true,
  TemplateBody: SENTINEL,
} as RawStack;
const NESTED: RawStack = { StackId: stackArn("app-Cache-1ABC", 2), StackName: "app-Cache-1ABC", StackStatus: "CREATE_COMPLETE", ParentId: APP.StackId, RootId: APP.StackId, CreationTime: new Date(NOW - 100 * DAY) };
const GOLDEN: CfnRaw = {
  stacks: [
    APP, NESTED,
    { StackId: stackArn("failed", 3), StackName: "failed", StackStatus: "ROLLBACK_COMPLETE", StackStatusReason: "The following resource(s) failed to create: [Bucket].", CreationTime: new Date(NOW - DAY) },
    { StackId: stackArn("stuck", 4), StackName: "stuck", StackStatus: "UPDATE_IN_PROGRESS", CreationTime: new Date(NOW - 9 * DAY), LastUpdatedTime: new Date(NOW - 2 * HOUR) },
    { StackId: stackArn("gone", 5), StackName: "gone", StackStatus: "DELETE_COMPLETE" },
  ],
  resources: {
    [APP.StackId!]: {
      state: "ok",
      value: [
        { LogicalResourceId: "Service", ResourceType: "AWS::ECS::Service", PhysicalResourceId: `arn:aws:ecs:${R}:${A}:service/prod/api`, ResourceStatus: "UPDATE_COMPLETE" },
        { LogicalResourceId: "Queue", ResourceType: "AWS::SQS::Queue", PhysicalResourceId: `https://sqs.${R}.amazonaws.com/${A}/orders`, ResourceStatus: "CREATE_COMPLETE" },
        { LogicalResourceId: "Db", ResourceType: "AWS::RDS::DBInstance", PhysicalResourceId: "app-db", ResourceStatus: "CREATE_COMPLETE" },
        { LogicalResourceId: "Fn", ResourceType: "AWS::Lambda::Function", PhysicalResourceId: "app-fn", ResourceStatus: "CREATE_COMPLETE" },
        { LogicalResourceId: "Role", ResourceType: "AWS::IAM::Role", PhysicalResourceId: "app-task-role", ResourceStatus: "CREATE_COMPLETE" },
        { LogicalResourceId: "Cache", ResourceType: "AWS::CloudFormation::Stack", PhysicalResourceId: NESTED.StackId, ResourceStatus: "CREATE_COMPLETE" },
        { LogicalResourceId: "Policy", ResourceType: "AWS::IAM::Policy", PhysicalResourceId: "app-Polic-XYZ", ResourceStatus: "CREATE_COMPLETE" },
        { LogicalResourceId: "Key", ResourceType: "AWS::IAM::AccessKey", PhysicalResourceId: "AKIAEXAMPLE123", ResourceStatus: "CREATE_COMPLETE" },
        { LogicalResourceId: "Old", ResourceType: "AWS::S3::Bucket", PhysicalResourceId: "old-bucket", ResourceStatus: "DELETE_COMPLETE" },
      ],
    },
    [stackArn("failed", 3)]: { state: "skipped" },
  },
};
const result = () => cfnResults(GOLDEN, { region: R, accountId: A, home: R, now: NOW });
const byName = (n: string) => result().resources.find((r) => r.name === n)!;
const prop = (r: Resource, label: string) => r.props.find((p) => p.label === label)?.value;

test("CloudFormation: key is the StackId; deleted stacks are skipped; nested stacks fold into their parent", () => {
  assert.deepEqual(result().resources.map((r) => r.name), ["app", "app-Cache-1ABC", "failed", "stuck"]);
  const app = byName("app");
  assert.equal(app.key, APP.StackId);
  assert.deepEqual(app.tags, { Environment: "production" });
  assert.equal(app.tagsUnread, undefined, "DescribeStacks returns the tags");
  assert.equal(byName("app-Cache-1ABC").parent, APP.StackId);
  assert.equal(prop(byName("app-Cache-1ABC"), "Nested in"), "app");
  assert.deepEqual(byName("failed").enrichment, { resources: "skipped" });
});

test("CloudFormation: health per A.2 #22", () => {
  assert.equal(byName("app").health, "ok");
  assert.deepEqual([byName("failed").health, byName("failed").healthReason], ["error", "creation failed and was rolled back: The following resource(s) failed to create: [Bucket]. — it can only be deleted"]);
  assert.deepEqual([byName("stuck").health, byName("stuck").healthReason], ["warning", "update in progress for more than an hour"]);
  const h = (s: Partial<RawStack>) => stackHealth({ CreationTime: new Date(NOW - 10 * 60_000), ...s }, NOW);
  assert.deepEqual(h({ StackStatus: "UPDATE_IN_PROGRESS" }), { health: "ok", reason: "update in progress" });
  assert.equal(h({ StackStatus: "UPDATE_ROLLBACK_COMPLETE" }).health, "warning");
  assert.equal(h({ StackStatus: "UPDATE_ROLLBACK_FAILED" }).health, "error");
  assert.equal(h({ StackStatus: "DELETE_FAILED" }).health, "error");
  assert.equal(h({ StackStatus: "REVIEW_IN_PROGRESS" }).health, "stopped");
  assert.deepEqual(h({ StackStatus: "UPDATE_COMPLETE", DriftInformation: { StackDriftStatus: "DRIFTED" } }), { health: "warning", reason: "drifted — resources were changed outside CloudFormation" });
  assert.equal(h({ StackStatus: "IMPORT_ROLLBACK_COMPLETE" }).health, "warning");
  // A rollback under way means the change already failed: not "ok" for its first hour.
  assert.deepEqual(h({ StackStatus: "ROLLBACK_IN_PROGRESS", StackStatusReason: "The following resource(s) failed to create: [Db]." }), { health: "warning", reason: "rollback in progress: The following resource(s) failed to create: [Db]." });
  assert.deepEqual(h({ StackStatus: "UPDATE_ROLLBACK_IN_PROGRESS" }), { health: "warning", reason: "update rollback in progress — the last change failed" });
  assert.equal(h({ StackStatus: "UPDATE_ROLLBACK_COMPLETE_CLEANUP_IN_PROGRESS" }).health, "warning");
  assert.equal(h({ StackStatus: "UPDATE_COMPLETE_CLEANUP_IN_PROGRESS" }).health, "ok");
});

test("CloudFormation: manages edges through the type table; role, notifications; untyped sub-objects and deleted ones skipped", () => {
  const links = result().links.filter((l) => l.from === APP.StackId);
  assert.deepEqual(links.map((l) => [l.kind, l.to, l.label]), [
    ["assumes", `arn:aws:iam::${A}:role/cfn-deployer`, "service role"],
    ["event", `arn:aws:sns:${R}:${A}:stack-events`, "stack events"],
    ["manages", "ecs:service/prod/api", "Service"],
    ["manages", `arn:aws:sqs:${R}:${A}:orders`, "Queue"],
    ["manages", "rds:app-db", "Db"],
    ["manages", `arn:aws:lambda:${R}:${A}:function:app-fn`, "Fn"],
    ["manages", `arn:aws:iam::${A}:role/app-task-role`, "Role"],
    ["manages", NESTED.StackId, "Cache"],
  ]);
  const o = { region: "eu-west-1", accountId: A, home: R };
  assert.equal(stackResourceRef("AWS::RDS::DBInstance", "eu-db", o), "rds:eu-db@eu-west-1", "region-aware console keys outside home");
  assert.equal(stackResourceRef("AWS::ElasticLoadBalancingV2::LoadBalancer", `arn:aws:elasticloadbalancing:eu-west-1:${A}:loadbalancer/app/web/abc`, o), "elb:web@eu-west-1");
  assert.equal(stackResourceRef("AWS::Events::Rule", "shop-bus|order-placed", o), `arn:aws:events:eu-west-1:${A}:rule/shop-bus/order-placed`);
  assert.equal(stackResourceRef("AWS::Events::Rule", "nightly", o), `arn:aws:events:eu-west-1:${A}:rule/nightly`);
  assert.equal(stackResourceRef("AWS::S3::Bucket", "b", o), "arn:aws:s3:::b");
  assert.equal(stackResourceRef("AWS::EC2::SecurityGroup", "sg-0123", o), `arn:aws:ec2:eu-west-1:${A}:security-group/sg-0123`);
  assert.equal(stackResourceRef("AWS::IAM::Policy", "x", o), undefined);
});

test("CloudFormation: outputs only as ARN, scrubbed URL, host or AWS id; parameters by key only; no sentinel anywhere", () => {
  const app = byName("app");
  assert.equal(prop(app, "Parameters"), "DbPassword, Env");
  assert.equal(prop(app, "Output TopicArn"), `arn:aws:sns:${R}:${A}:alerts`);
  assert.equal(prop(app, "Output AlbHost"), "app-1234.us-east-1.elb.amazonaws.com");
  assert.equal(prop(app, "Output VpcId"), "vpc-0a1b2c3d4e5f60789");
  assert.equal(prop(app, "Output Site"), "https://app.example.com/login");
  assert.equal(prop(app, "Output DbUrl"), "postgres://db.example.com:5432/app");
  assert.equal(prop(app, "Output Hook"), "https://hooks.slack.com/services/T0001/B0002/…");
  assert.equal(prop(app, "Output AdminPassword"), "(hidden: not a resource reference)");
  assert.equal(safeOutput("hunter2"), undefined);
  assert.equal(safeOutput("i-love-cats"), undefined);
  assert.equal(safeOutput("two words"), undefined);
  // Mixed case and two labels reads like a password, not a host; real hosts are lower case or longer.
  assert.equal(safeOutput("Summer2026.Rocks"), undefined);
  assert.equal(safeOutput("example.com"), "example.com");
  assert.equal(safeOutput("internal-Api-1.us-east-1.elb.amazonaws.com"), "internal-api-1.us-east-1.elb.amazonaws.com");
  assert.ok(!JSON.stringify(result()).includes(SENTINEL));
  const d = cfnDetail(APP.StackId!, APP, GOLDEN.resources![APP.StackId!].value, [{ LogicalResourceId: "Db", ResourceStatus: "UPDATE_FAILED", ResourceStatusReason: "x", ResourceProperties: SENTINEL } as never]);
  assert.ok(!JSON.stringify(d).includes(SENTINEL));
  assert.ok(!JSON.stringify(d).includes("AKIAEXAMPLE123"), "access key ids are masked");
  assert.deepEqual(d.sections.map((s) => s.title), ["Stack", "Outputs", "Resources (9)", "Recent events"]);
});

test("CloudFormation: the Acme simulation — two stacks at home (the network one drifted), none elsewhere; secrets stay out", () => {
  const home = cfnResults({ stacks: simStacks("us-east-1", NOW), resources: Object.fromEntries(simStacks("us-east-1", NOW).map((s) => [s.StackId!, { value: simStackResources("us-east-1", s.StackId!), state: "ok" as const }])) }, { region: R, accountId: A, home: R, now: NOW });
  assert.deepEqual(home.resources.map((r) => [r.name, r.health]), [["acme-network", "warning"], ["acme-production-data", "ok"]]);
  const data = home.resources[1];
  assert.equal(prop(data, "Output DbConnection"), "postgres://acme-production-pg.c0example.us-east-1.rds.amazonaws.com:5432/shop", "credentials scrubbed");
  const json = JSON.stringify(home) + JSON.stringify(cfnDetail(data.key, simStacks("us-east-1", NOW)[1], simStackResources("us-east-1", data.key), simStackEvents("us-east-1", data.key, NOW)));
  assert.ok(!json.includes("pg-api-production-pass"));
  const manages = home.links.filter((l) => l.kind === "manages" && l.from === data.key).map((l) => l.to);
  assert.ok(manages.includes("rds:acme-production-pg") && manages.includes("elasticache:acme-production-valkey"));
  assert.ok(manages.includes(`arn:aws:sqs:${R}:${A}:acme-production-orders`));
  assert.ok(home.links.some((l) => l.to === `arn:aws:ec2:${R}:${A}:vpc/vpc-prod`));
  assert.deepEqual(simStacks("eu-west-1"), []);
});
