import { test } from "node:test";
import assert from "node:assert/strict";
import { CONFIG_SELECT, catchallResult, consoleLink, fromCloudControl, fromConfig, fromExplorer, fromTagging, genericResource, typeFromCfn, type RawExplorerResource } from "./catchall.ts";
import { infer } from "./infer.ts";
import type { Resource } from "./types.ts";

const ACCT = "123456789012";
const NOW = Date.UTC(2026, 9, 5, 12);
const SENTINEL = "SECRET_SENTINEL_9f3c";

test("golden: a Resource Explorer row becomes a generic resource — tags only, never other properties", () => {
  const rows = fromExplorer([
    {
      Arn: `arn:aws:sagemaker:us-east-1:${ACCT}:model/acme-recs-model`, ResourceType: "sagemaker:model", Region: "us-east-1", OwningAccountId: ACCT, Service: "sagemaker",
      LastReportedAt: new Date(NOW - 3_600_000),
      Properties: [
        { Name: "tags", Data: [{ Key: "team", Value: "data" }, { Key: "Name", Value: "Recommendations model" }, { Value: "no key" }] },
        { Name: "configuration", Data: { password: SENTINEL } },
      ],
    },
    { Arn: "not-an-arn", ResourceType: "x:y" },
  ] as RawExplorerResource[]);
  assert.equal(rows.length, 1);
  const r = genericResource(rows[0], { accountId: ACCT, now: NOW });
  assert.deepEqual(r, {
    key: `arn:aws:sagemaker:us-east-1:${ACCT}:model/acme-recs-model`, kind: "aws-resource", provider: "catchall", name: "Recommendations model", region: "us-east-1",
    tags: { team: "data", Name: "Recommendations model" }, health: "unknown", healthReason: "No dedicated reader for this type yet",
    props: [
      { label: "Service", value: "SageMaker" }, { label: "Type", value: "SageMaker model (sagemaker:model)" },
      { label: "ARN", value: `arn:aws:sagemaker:us-east-1:${ACCT}:model/acme-recs-model`, mono: true }, { label: "Region", value: "us-east-1" },
      { label: "Found by", value: "Resource Explorer" }, { label: "Last reported", value: "2026-10-05 11:00 UTC" },
    ],
    service: "SageMaker", resourceType: "sagemaker:model", category: "compute", source: "resource-explorer",
    consoleUrl: `https://console.aws.amazon.com/go/view?arn=${encodeURIComponent(`arn:aws:sagemaker:us-east-1:${ACCT}:model/acme-recs-model`)}`, observedAt: NOW, hidden: true,
  });
  assert.ok(!JSON.stringify(r).includes(SENTINEL));
});

test("ARNs without a type segment (S3 bucket, CodePipeline pipeline) from the Tagging API; global vs regional", () => {
  const rows = fromTagging([
    { ResourceARN: "arn:aws:s3:::acme-production-assets", Tags: [{ Key: "Environment", Value: "production" }] },
    { ResourceARN: `arn:aws:codepipeline:us-east-1:${ACCT}:acme-billing-release`, Tags: [] },
    { ResourceARN: `arn:aws:iam::${ACCT}:role/acme-ci`, Tags: [{ Key: "team", Value: "platform" }] },
    { ResourceARN: "garbage" },
  ], "us-east-1");
  const res = catchallResult(rows, { accountId: ACCT, now: NOW }).resources;
  const by = (k: string) => res.find((r) => r.key.endsWith(k))!;
  assert.deepEqual([by("acme-production-assets").resourceType, by("acme-production-assets").region, by("acme-production-assets").name], ["s3:bucket", "us-east-1", "acme-production-assets"]);
  assert.deepEqual([by("acme-billing-release").resourceType, by("acme-billing-release").name, by("acme-billing-release").hidden], ["codepipeline:pipeline", "acme-billing-release", undefined]);
  assert.deepEqual([by("role/acme-ci").region, by("role/acme-ci").source], ["global", "tagging"]);
  assert.equal(res.length, 3);
});

test("AWS Config: selected columns only; VPC, subnets and groups become network fields, attachments become links", () => {
  assert.ok(!/configuration[,\s]|configuration$/.test(CONFIG_SELECT.replace("configurationItemCaptureTime", "")), "never the configuration column");
  const { rows, links } = fromConfig([
    JSON.stringify({
      arn: `arn:aws:ec2:us-east-1:${ACCT}:volume/vol-1`, resourceType: "AWS::EC2::Volume", resourceId: "vol-1", resourceName: "build-cache", awsRegion: "us-east-1", accountId: ACCT,
      tags: [{ key: "team", value: "ci" }], configurationItemCaptureTime: "2026-10-05T10:00:00.000Z", configuration: { secret: SENTINEL },
      relationships: [
        { resourceType: "AWS::EC2::Instance", resourceId: "i-0abc", relationshipName: "Is attached to Instance" },
        { resourceType: "AWS::EC2::VPC", resourceId: "vpc-1", relationshipName: "Is contained in Vpc" },
      ],
    }),
    JSON.stringify({
      arn: `arn:aws:glue:us-east-1:${ACCT}:database/acme_lake`, resourceType: "AWS::Glue::Database", resourceId: "acme_lake", awsRegion: "us-east-1",
      relationships: [
        { resourceType: "AWS::EC2::SecurityGroup", resourceId: "sg-1", relationshipName: "Is associated with SecurityGroup" },
        { resourceType: "AWS::EC2::Subnet", resourceId: "subnet-1", relationshipName: "Is contained in Subnet" },
        { resourceType: "AWS::EC2::NetworkInterface", resourceId: "eni-1", relationshipName: "Contains NetworkInterface" },
      ],
    }),
    "{not json",
  ], { region: "us-east-1", account: ACCT });
  assert.deepEqual(rows.map((r) => [r.type, r.name, r.vpcId, r.subnetIds, r.securityGroups, r.tags]), [
    ["ec2:volume", "build-cache", "vpc-1", undefined, undefined, { team: "ci" }],
    ["glue:database", undefined, undefined, ["subnet-1"], ["sg-1"], undefined],
  ]);
  assert.deepEqual(links, [{ from: `arn:aws:ec2:us-east-1:${ACCT}:volume/vol-1`, to: `arn:aws:ec2:us-east-1:${ACCT}:instance/i-0abc`, kind: "uses", evidence: "AWS Config: Is attached to Instance" }]);
  const res = catchallResult(rows, { accountId: ACCT, now: NOW, links });
  assert.ok(!JSON.stringify(res).includes(SENTINEL));
  assert.deepEqual(res.resources.find((r) => r.resourceType === "glue:database")!.securityGroups, ["sg-1"]);
});

test("Cloud Control: the identifier and the model's ARN only; types in Resource Explorer spelling", () => {
  const rows = fromCloudControl("AWS::Glue::Database", [
    { Identifier: "acme_lake", Properties: JSON.stringify({ DatabaseName: "acme_lake", Password: SENTINEL }) },
    { Identifier: "with-arn", Properties: JSON.stringify({ Arn: `arn:aws:glue:us-east-1:${ACCT}:database/with-arn` }) },
    { Properties: "{}" },
  ], { region: "us-east-1", account: ACCT });
  const res = catchallResult(rows, { accountId: ACCT, now: NOW }).resources;
  assert.deepEqual(res.map((r) => [r.key, r.resourceType, r.tagsUnread, r.name]), [
    [`arn:aws:glue:us-east-1:${ACCT}:database/with-arn`, "glue:database", true, "with-arn"],
    ["cloudcontrol:us-east-1/AWS::Glue::Database/acme_lake", "glue:database", true, "acme_lake"],
  ]);
  assert.ok(!JSON.stringify(res).includes(SENTINEL));
  assert.match(res[1].consoleUrl!, /resource-explorer\/home#\/search\?query=acme_lake$/);
  assert.equal(typeFromCfn("AWS::EC2::NetworkInterface"), "ec2:network-interface");
  assert.equal(typeFromCfn("AWS::ElasticLoadBalancingV2::LoadBalancer"), "elasticloadbalancing:loadbalancer/app");
  assert.equal(typeFromCfn("AWS::RDS::DBInstance"), "rds:db");
  assert.equal(typeFromCfn("AWS::SageMaker::Model"), "sagemaker:model");
  assert.equal(consoleLink("arn:aws:s3:::b"), `https://console.aws.amazon.com/go/view?arn=${encodeURIComponent("arn:aws:s3:::b")}`);
});

test("one resource per key: Resource Explorer wins, tags are merged, other accounts are marked", () => {
  const arn = `arn:aws:sqs:us-east-1:${ACCT}:acme-orders`;
  const res = catchallResult([
    { arn, source: "resource-explorer", type: "sqs:queue", region: "us-east-1", tags: { a: "1" } },
    { arn, source: "tagging", region: "us-east-1", tags: { a: "2", b: "3" } },
    { arn: "arn:aws:sqs:us-east-1:999999999999:partner", source: "resource-explorer", type: "sqs:queue", region: "us-east-1", account: "999999999999" },
  ], { accountId: ACCT, now: NOW }).resources;
  assert.equal(res.length, 2);
  const q = res.find((r) => r.key === arn)!;
  assert.deepEqual([q.source, q.tags], ["resource-explorer", { a: "1", b: "3" }]);
  assert.equal(res.find((r) => r.key.includes("999999999999"))!.account, "999999999999");
  assert.equal(q.account, undefined, "the console's own account isn't repeated");
});

// The real account's Resource Explorer view, anonymised to a histogram of types: 159 rows across 48 types in its home
// region (the audit's snapshot had 50 types), plus the 43 global rows of the region:global pass (12 types).
const REGIONAL: [string, number][] = [
  ["ec2:security-group-rule", 29], ["rds:snapshot", 17], ["ecs:task-definition", 11], ["ec2:network-interface", 8], ["ec2:security-group", 8], ["ec2:subnet", 7],
  ["ec2:elastic-ip", 5], ["memorydb:parametergroup", 5], ["ec2:route-table", 4], ["ecr:repository", 4], ["ecs:service", 3], ["elasticloadbalancing:listener-rule/app", 3],
  ["elasticloadbalancing:targetgroup", 3], ["logs:log-group", 3], ["rds:pg", 3], ["s3:bucket", 3], ["servicediscovery:service", 3], ["acm:certificate", 2],
  ["ec2:internet-gateway", 2], ["ec2:network-acl", 2], ["ec2:vpc", 2], ["elasticache:user", 2], ["elasticloadbalancing:listener/app", 2], ["rds:auto-backup", 2],
  ["rds:db", 2], ["rds:subgrp", 2], ["apprunner:autoscalingconfiguration", 1], ["athena:datacatalog", 1], ["athena:workgroup", 1], ["ec2:dhcp-options", 1],
  ["ec2:instance", 1], ["ec2:volume", 1], ["ec2:vpc-endpoint", 1], ["ec2:vpc-peering-connection", 1], ["ecs:cluster", 1], ["elasticache:cluster", 1],
  ["elasticache:replicationgroup", 1], ["elasticache:snapshot", 1], ["elasticache:subnetgroup", 1], ["elasticloadbalancing:loadbalancer/app", 1], ["events:event-bus", 1],
  ["memorydb:acl", 1], ["memorydb:user", 1], ["rds:og", 1], ["resource-explorer-2:index", 1], ["resource-explorer-2:view", 1], ["ssm:managed-instance", 1],
  ["xray:sampling-rule", 1],
];
const GLOBAL: [string, number][] = [
  ["iam:role", 11], ["iam:user", 9], ["iam:group", 6], ["iam:policy", 6], ["cloudfront:distribution", 2], ["cloudfront:origin-access-control", 2], ["iam:mfa", 2],
  ["budgets:budget", 1], ["ce:anomalymonitor", 1], ["ce:anomalysubscription", 1], ["iam:instance-profile", 1], ["iam:oidc-provider", 1],
];
const fake = (type: string, i: number, region: string): RawExplorerResource => {
  const [svc, rest] = [type.slice(0, type.indexOf(":")), type.slice(type.indexOf(":") + 1)];
  const id = `acme-${rest.replace(/\W+/g, "-")}-${i}`;
  const arn = svc === "s3" ? `arn:aws:s3:::${id}` : region === "global" ? `arn:aws:${svc}::${ACCT}:${rest}/${id}` : `arn:aws:${svc}:${region}:${ACCT}:${rest}/${id}`;
  return { Arn: arn, ResourceType: type, Region: region, OwningAccountId: ACCT, Service: svc, Properties: [] };
};
const rowsOf = (h: [string, number][], region: string) => h.flatMap(([type, n]) => Array.from({ length: n }, (_, i) => fake(type, i, region)));

test("the real account's histogram: 202 rows → 65 map nodes, 56 table rows, 81 sub-objects counted", () => {
  const regional = rowsOf(REGIONAL, "ap-south-1"), global = rowsOf(GLOBAL, "global");
  assert.deepEqual([regional.length, REGIONAL.length, global.length, GLOBAL.length], [159, 48, 43, 12]);
  const result = catchallResult([...fromExplorer(regional), ...fromExplorer(global)], { accountId: ACCT, now: NOW });
  assert.equal(result.resources.length, 202);
  const { resources, hiddenTypes, notes } = infer({ results: [result], home: "ap-south-1", accountId: ACCT });
  const shown = resources.filter((r) => !r.hidden), table = resources.filter((r) => r.hidden);
  assert.deepEqual([shown.length, table.length, Object.values(hiddenTypes).reduce((a, b) => a + b, 0)], [65, 56, 81]);
  assert.deepEqual(Object.keys(hiddenTypes).sort(), [
    "ec2:network-interface", "ec2:security-group-rule", "ecs:task-definition", "elasticache:snapshot", "elasticache:user", "elasticloadbalancing:listener-rule/app",
    "elasticloadbalancing:listener/app", "iam:mfa", "memorydb:acl", "memorydb:user", "rds:auto-backup", "rds:snapshot", "resource-explorer-2:index", "resource-explorer-2:view",
  ]);
  assert.equal(shown.filter((r) => r.region === "global").length, 13, "IAM roles and CloudFront distributions from the global pass");
  assert.ok(shown.every((r) => r.kind === "aws-resource" && r.service && r.category && r.healthReason === "No dedicated reader for this type yet"));
  assert.deepEqual(notes, []);
  // With the first-class providers that run there, covered and listing the same ARNs, only the long tail stays.
  const firstClass: Resource[] = regional.filter((x) => ["ecs:service", "rds:db", "s3:bucket", "logs:log-group"].includes(x.ResourceType!)).map((x) => ({
    key: x.Arn!, kind: "lambda", provider: "first", name: "x", region: "ap-south-1", tags: {}, health: "ok", props: [],
  }));
  const folded = infer({ results: [{ resources: firstClass, links: [], mentions: [] }, result], home: "ap-south-1", accountId: ACCT, covered: new Set(["rds:db@ap-south-1"]) });
  assert.equal(folded.resources.filter((r) => r.kind === "aws-resource" && !r.hidden).length, 65 - firstClass.length);
  assert.deepEqual(folded.notes, []);
});
