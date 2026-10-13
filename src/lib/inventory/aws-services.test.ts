import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { SERVICES, TYPES, infoOf } from "./aws-services.ts";
import { CATEGORY_ORDER, KIND_INFO, categoryOf, kindLabelOf, serviceOf } from "./types.ts";

const snapshot = JSON.parse(readFileSync(new URL("./aws-resource-types.json", import.meta.url), "utf8")) as { source: string; count: number; types: string[] };
const SNAPSHOT = new Set(snapshot.types);

test("the Resource Explorer snapshot is sorted, unique and complete", () => {
  assert.ok(snapshot.types.length > 500, "list-supported-resource-types returns 600+ types");
  assert.equal(snapshot.count, snapshot.types.length);
  assert.equal(SNAPSHOT.size, snapshot.types.length, "no duplicates");
  assert.deepEqual(snapshot.types, [...snapshot.types].sort(), "sorted (code-unit order)");
  for (const t of snapshot.types) assert.match(t, /^[a-z0-9-]+:[A-Za-z0-9/_:-]+$/, t);
});

test("every TYPES key is spelled exactly as Resource Explorer spells it", () => {
  const unknown = Object.keys(TYPES).filter((t) => !SNAPSHOT.has(t));
  assert.deepEqual(unknown, [], "not in aws-resource-types.json (sub-types included: elasticloadbalancing:loadbalancer/app)");
});

test("every service in the snapshot has a label, a category and an icon", () => {
  const prefixes = [...new Set(snapshot.types.map((t) => t.split(":")[0]))];
  assert.deepEqual(prefixes.filter((p) => !Object.hasOwn(SERVICES, p)), []);
  for (const [prefix, s] of Object.entries(SERVICES)) {
    assert.ok(s.label.trim(), prefix);
    assert.ok(CATEGORY_ORDER.includes(s.category), `${prefix}: ${s.category}`);
    assert.ok(s.icon, prefix);
  }
  for (const [type, info] of Object.entries(TYPES)) if (info.category) assert.ok(CATEGORY_ORDER.includes(info.category), type);
});

test("the map is an allow-list: the long tail of B.3 is on it, sub-objects are dropped, the rest is a table row (CC-8)", () => {
  const allow = ["sagemaker:endpoint", "sagemaker:notebook-instance", "bedrock:agent", "bedrock:knowledge-base", "kendra:index", "dms:rep", "fsx:file-system", "storagegateway:gateway",
    "network-firewall:firewall", "route53resolver:resolver-endpoint", "vpc-lattice:servicenetwork", "dax:cache", "emr-serverless:applications", "elasticmapreduce:cluster",
    "airflow:environment", "kinesisanalytics:application", "codecommit:repository", "codeartifact:repository", "imagebuilder:image-pipeline", "ecr-public:repository",
    "workspaces:workspace", "aoss:collection"];
  for (const t of allow) assert.equal(infoOf(t).visibility, "map", t);
  const dropped = ["ec2:security-group-rule", "ec2:network-interface", "ec2:snapshot", "ec2:image", "ecs:task-definition", "ecs:container-instance", "ecs:task-set",
    "elasticloadbalancing:listener/app", "elasticloadbalancing:listener/net", "elasticloadbalancing:listener-rule/app", "rds:snapshot", "rds:cluster-snapshot", "rds:auto-backup",
    "elasticache:snapshot", "elasticache:user", "elasticache:usergroup", "memorydb:user", "memorydb:acl", "ssm:session", "lambda:function/version", "lambda:layer/version",
    "lambda:event-source-mapping", "apigateway:restapis/stages", "apigateway:apis/routes", "apigateway:apis/integrations", "apigateway:restapis/deployments", "iam:mfa",
    "resource-explorer-2:index", "resource-explorer-2:view"];
  for (const t of dropped) assert.equal(infoOf(t).visibility, "drop", t);
  for (const t of ["iam:user", "cloudfront:origin-access-control", "budgets:budget", "ec2:key-pair", "glue:database", "sagemaker:model"]) assert.equal(infoOf(t).visibility, "table", t);
});

test("infoOf: exact type, then base type; a base type's drop is inherited, its map is not", () => {
  assert.equal(infoOf("kendra:index").visibility, "map");
  assert.equal(infoOf("kendra:index/data-source").visibility, "table", "a sub-type of a primary type is a table row");
  assert.equal(infoOf("kendra:index/data-source").label, "Kendra index data source");
  // a made-up sub-type under a dropped base type stays dropped
  assert.equal(infoOf("ec2:network-interface/permission").visibility, "drop");
  assert.equal(infoOf("ec2:volume").category, "storage", "a type's own category beats its service's (EC2 is compute)");
  assert.equal(infoOf("ec2:vpc").category, "network");
  assert.equal(infoOf("ec2:instance").category, "compute");
  assert.equal(infoOf("vpc-lattice:service").category, "edge");
  assert.equal(infoOf("cloudfront:origin-request-policy").label, "CloudFront origin request policy");
  assert.equal(infoOf("autoscaling:autoScalingGroup").label, "Auto Scaling group");
  assert.equal(infoOf("iotwireless:WirelessGateway").label, "IoT Wireless wireless gateway");
});

test("infoOf never trusts inherited properties and survives unknown services", () => {
  const u = infoOf("newservice:widget");
  assert.deepEqual(u.service, { label: "newservice", category: "other", icon: "Puzzle" });
  assert.equal(u.visibility, "table");
  assert.equal(u.label, "newservice widget");
  assert.equal(infoOf("constructor:x").service.label, "constructor", "no prototype lookups");
  assert.equal(infoOf("toString").visibility, "table");
});

test("resource helpers: a generic aws-resource carries its own category, service and type label", () => {
  const generic = { kind: "aws-resource" as const, resourceType: "sagemaker:model", service: "SageMaker", category: "compute" as const };
  assert.equal(categoryOf(generic), "compute");
  assert.equal(kindLabelOf(generic), "SageMaker model");
  assert.equal(serviceOf(generic), "SageMaker");
  assert.equal(categoryOf({ kind: "aws-resource" }), "other");
  assert.equal(kindLabelOf({ kind: "aws-resource" }), "AWS resource");
  assert.equal(categoryOf({ kind: "lambda" }), "compute");
  assert.equal(kindLabelOf({ kind: "lambda" }), "Lambda function");
  assert.equal(serviceOf({ kind: "lambda" }), "Lambda");
  assert.equal(categoryOf({ kind: "kms-key" }), "security");
  // a kind a newer server sends doesn't crash an older UI
  const future = { kind: "quantum-annealer" as unknown as "lambda" };
  assert.equal(categoryOf(future), "other");
  assert.equal(kindLabelOf(future), "quantum-annealer");
  assert.equal(serviceOf(future), "AWS");
  for (const [k, info] of Object.entries(KIND_INFO)) assert.ok(CATEGORY_ORDER.includes(info.category), k);
});
