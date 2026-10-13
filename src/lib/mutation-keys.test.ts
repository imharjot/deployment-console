import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalKey, canonicalRegion, keysForInventory, parseArn } from "./mutation-keys.ts";

const ACCT = "123456789012";

test("R04: the map key of an ECS service and its environment/service pair give the same key", () => {
  const pair = canonicalKey({ ecsService: { region: "us-east-1", cluster: "acme-staging", service: "api" } });
  assert.equal(pair, "ecs-service:us-east-1/acme-staging/api");
  assert.deepEqual(keysForInventory("ecs:service/acme-staging/api", "us-east-1", "us-east-1"), [pair]);
  // …and its ARN, and a cluster given as an ARN
  assert.equal(canonicalKey({ arn: `arn:aws:ecs:us-east-1:${ACCT}:service/acme-staging/api` }), pair);
  assert.equal(canonicalKey({ ecsService: { region: "us-east-1", cluster: `arn:aws:ecs:us-east-1:${ACCT}:cluster/acme-staging`, service: "api" } }), pair);
  assert.deepEqual(keysForInventory(`arn:aws:ecs:us-east-1:${ACCT}:service/acme-staging/api`, "us-east-1", "us-east-1"), [pair]);
});

test("region: an @region suffix wins, the resource region comes next, then home; same names in two regions stay apart", () => {
  const eu = keysForInventory("ecs:service/acme-prod/api@eu-west-1", "us-east-1", "us-east-1");
  assert.deepEqual(eu, ["ecs-service:eu-west-1/acme-prod/api"]);
  assert.notDeepEqual(eu, keysForInventory("ecs:service/acme-prod/api", "us-east-1", "us-east-1"));
  assert.deepEqual(keysForInventory("ecs:service/acme-prod/api", "eu-west-1", "us-east-1"), ["ecs-service:eu-west-1/acme-prod/api"]);
  assert.deepEqual(keysForInventory("ecs:service/acme-prod/api", "", "us-east-1"), ["ecs-service:us-east-1/acme-prod/api"]);
  assert.deepEqual(keysForInventory("ec2:i-0abc123@ap-southeast-2", "us-east-1", "us-east-1"), ["ec2:ap-southeast-2/i-0abc123"]);
  assert.deepEqual(keysForInventory("rds:orders-db", "us-east-1", "us-east-1"), ["rds:us-east-1/orders-db"]);
  assert.deepEqual(keysForInventory("elb:acme-alb", "us-east-1", "us-east-1"), ["elb:us-east-1/acme-alb"]);
  assert.deepEqual(keysForInventory("elasticache:sessions@eu-west-1", "us-east-1", "us-east-1"), ["elasticache:eu-west-1/sessions"]);
  assert.deepEqual(keysForInventory("workload:billing-cron", "us-east-1", "us-east-1"), ["inv:us-east-1/workload:billing-cron"]);
  assert.deepEqual(keysForInventory("eks:acme/default/deployment/web", "global", "us-east-1"), ["inv:us-east-1/eks:acme/default/deployment/web"]);
});

test("EC2 and RDS: ids, ARNs and inventory keys agree", () => {
  const ec2 = canonicalKey({ ec2: { region: "us-east-1", id: "i-0abc123" } });
  assert.equal(ec2, "ec2:us-east-1/i-0abc123");
  assert.equal(canonicalKey({ arn: `arn:aws:ec2:us-east-1:${ACCT}:instance/i-0abc123` }), ec2);
  assert.deepEqual(keysForInventory("ec2:i-0abc123", "us-east-1", "us-east-1"), [ec2]);
  const rds = canonicalKey({ rds: { region: "us-east-1", id: "orders-db" } });
  assert.equal(rds, "rds:us-east-1/orders-db");
  assert.equal(canonicalKey({ arn: `arn:aws:rds:us-east-1:${ACCT}:db:orders-db` }), rds);
  assert.equal(canonicalKey({ rds: { region: "ignored", id: `arn:aws:rds:us-east-1:${ACCT}:db:orders-db` } }), rds);
  assert.equal(canonicalKey({ ecsHosts: { region: "us-east-1", cluster: "acme-staging" } }), "ecs-hosts:us-east-1/acme-staging");
});

test("Lambda: a version or alias qualifier names the same function", () => {
  const base = `arn:aws:lambda:us-east-1:${ACCT}:function:thumbnailer`;
  assert.equal(canonicalKey({ arn: base }), base);
  assert.equal(canonicalKey({ arn: `${base}:live` }), base);
  assert.equal(canonicalKey({ arn: `${base}:42` }), base);
  assert.equal(canonicalKey({ arn: `${base}:$LATEST` }), base);
});

test("Secrets Manager: the random suffix, JSON key, stage and version are stripped; names and ARNs agree", () => {
  const key = "secret:us-east-1/prod/db";
  assert.equal(canonicalKey({ secret: { region: "us-east-1", id: "prod/db" } }), key);
  assert.equal(canonicalKey({ secret: { region: "us-east-1", id: `arn:aws:secretsmanager:us-east-1:${ACCT}:secret:prod/db-AbC123` } }), key);
  assert.equal(canonicalKey({ arn: `arn:aws:secretsmanager:us-east-1:${ACCT}:secret:prod/db-AbC123:password::` }), key);
  assert.equal(canonicalKey({ arn: `arn:aws:secretsmanager:us-east-1:${ACCT}:secret:prod/db-AbC123:password:AWSCURRENT:` }), key);
  assert.equal(canonicalKey({ arn: `arn:aws:secretsmanager:us-east-1:${ACCT}:secret:prod/db-AbC123::AWSPREVIOUS:6f1e2d3c-1111-2222-3333-444455556666` }), key);
  // A bare name that happens to end like a suffix is a different secret: never stripped.
  assert.equal(canonicalKey({ secret: { region: "us-east-1", id: "app-config" } }), "secret:us-east-1/app-config");
});

test("SSM: names with and without a leading slash, ARNs and version selectors agree", () => {
  const key = "ssm:us-east-1/acme/prod/DATABASE_URL";
  assert.equal(canonicalKey({ ssm: { region: "us-east-1", name: "/acme/prod/DATABASE_URL" } }), key);
  assert.equal(canonicalKey({ ssm: { region: "us-east-1", name: "acme/prod/DATABASE_URL" } }), key);
  assert.equal(canonicalKey({ ssm: { region: "us-east-1", name: "/acme/prod/DATABASE_URL:3" } }), key);
  assert.equal(canonicalKey({ ssm: { region: "x", name: `arn:aws:ssm:us-east-1:${ACCT}:parameter/acme/prod/DATABASE_URL` } }), key);
  assert.equal(canonicalKey({ arn: `arn:aws:ssm:us-east-1:${ACCT}:parameter/acme/prod/DATABASE_URL` }), key);
  assert.equal(canonicalKey({ ssm: { region: "us-east-1", name: "PLAIN" } }), "ssm:us-east-1/PLAIN");
});

test("CloudWatch Logs: the ':*' suffix is stripped", () => {
  const g = `arn:aws:logs:us-east-1:${ACCT}:log-group:/ecs/acme-api`;
  assert.equal(canonicalKey({ arn: `${g}:*` }), g);
  assert.equal(canonicalKey({ arn: g }), g);
});

test("S3 objects, console keys, CI workflows, other ARNs", () => {
  assert.equal(canonicalKey({ s3Object: { bucket: "acme-config", key: "prod/api.env" } }), "s3:acme-config/prod/api.env");
  assert.equal(canonicalKey({ arn: "arn:aws:s3:::acme-config/prod/api.env" }), "s3:acme-config/prod/api.env");
  assert.equal(canonicalKey({ arn: "arn:aws:s3:::acme-config" }), "arn:aws:s3:::acme-config");
  assert.equal(canonicalKey({ console: "integrations/slack" }), "console:integrations/slack");
  assert.equal(canonicalKey({ ci: { repo: "Acme/Storefront", workflow: "./.github/workflows/deploy.yml" } }), "ci:acme/storefront/.github/workflows/deploy.yml");
  assert.equal(canonicalKey({ ci: { repo: "acme/storefront", workflow: ".github/workflows/deploy.yml" } }), "ci:acme/storefront/.github/workflows/deploy.yml");
  const q = `arn:aws:sqs:us-east-1:${ACCT}:orders`;
  assert.equal(canonicalKey({ arn: q }), q);
  assert.equal(canonicalKey({ arn: `arn:aws-us-gov:sns:us-gov-west-1:${ACCT}:alerts` }), `arn:aws-us-gov:sns:us-gov-west-1:${ACCT}:alerts`);
  assert.deepEqual(keysForInventory(`arn:aws:lambda:eu-west-1:${ACCT}:function:resizer:prod`, "eu-west-1", "us-east-1"), [`arn:aws:lambda:eu-west-1:${ACCT}:function:resizer`]);
});

test("load balancers and caches: ARNs land on the map's elb / elasticache keys", () => {
  const alb = keysForInventory("elb:acme-alb", "us-east-1", "us-east-1")[0];
  assert.equal(canonicalKey({ arn: `arn:aws:elasticloadbalancing:us-east-1:${ACCT}:loadbalancer/app/acme-alb/50dc6c495c0c9188` }), alb);
  assert.equal(canonicalKey({ arn: `arn:aws:elasticloadbalancing:us-east-1:${ACCT}:loadbalancer/net/acme-alb/1a2b3c` }), alb);
  assert.equal(canonicalKey({ arn: `arn:aws:elasticloadbalancing:us-east-1:${ACCT}:loadbalancer/acme-alb` }), alb, "classic");
  const tg = `arn:aws:elasticloadbalancing:us-east-1:${ACCT}:targetgroup/api/6d0ecf831eec9f09`;
  assert.equal(canonicalKey({ arn: tg }), tg, "target groups keep their ARN");
  const cache = keysForInventory("elasticache:sessions@eu-west-1", "us-east-1", "us-east-1")[0];
  assert.equal(canonicalKey({ arn: `arn:aws:elasticache:eu-west-1:${ACCT}:replicationgroup:sessions` }), cache);
  assert.equal(canonicalKey({ arn: `arn:aws:elasticache:eu-west-1:${ACCT}:cluster:sessions` }), cache);
  assert.equal(canonicalKey({ arn: `arn:aws:elasticache:eu-west-1:${ACCT}:serverlesscache:sessions` }), cache);
});

test("parseArn and canonicalRegion", () => {
  assert.deepEqual(parseArn(`arn:aws:ecs:us-east-1:${ACCT}:service/c/s`), { partition: "aws", service: "ecs", region: "us-east-1", account: ACCT, resource: "service/c/s" });
  assert.equal(parseArn("not-an-arn"), undefined);
  assert.equal(canonicalRegion("ecs-service:eu-west-1/c/s"), "eu-west-1");
  assert.equal(canonicalRegion(`arn:aws:lambda:ap-south-1:${ACCT}:function:f`), "ap-south-1");
  assert.equal(canonicalRegion("arn:aws:s3:::bucket"), undefined);
  assert.equal(canonicalRegion("s3:bucket/key"), undefined);
  assert.equal(canonicalRegion("console:x"), undefined);
});
