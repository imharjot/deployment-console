import { test } from "node:test";
import assert from "node:assert/strict";
import { assignEnvs, envFromName, normalizeEnv, regionalEnv, type KnownEnv } from "./assign.ts";
import type { Edge, Resource } from "./types.ts";

const R = (key: string, extra: Partial<Resource> = {}): Resource => ({ key, kind: "lambda", provider: "lambda", name: key, region: "us-east-1", tags: {}, health: "ok", props: [], ...extra });
const E = (from: string, to: string): Edge => ({ id: `${from}->${to}:uses`, from, to, kind: "uses", evidence: [], confidence: "config" });
const KNOWN: KnownEnv[] = [
  { id: "staging", label: "Staging", protected: false, source: "ecs" },
  { id: "production", label: "Production", protected: true, source: "ecs" },
];

test("tag values and hints normalise to known environments, stage ids or slugs", () => {
  assert.equal(normalizeEnv("prd", KNOWN), "production");
  assert.equal(normalizeEnv("Live", KNOWN), "production");
  assert.equal(normalizeEnv("preprod", KNOWN), "staging");
  assert.equal(normalizeEnv("development", KNOWN), "dev");
  assert.equal(normalizeEnv("Data Team", KNOWN), "data-team");
  assert.equal(normalizeEnv("shared", KNOWN), null);
  assert.equal(normalizeEnv("production", [{ id: "prod" }]), "prod", "a pinned env id that is itself a stage word");
  assert.deepEqual(envFromName("acme-staging-orders", KNOWN), { env: "staging", token: "staging" });
  assert.equal(envFromName("prod-to-staging-sync", KNOWN), undefined, "ambiguous");
  assert.equal(envFromName("backstage-portal", KNOWN), undefined, "whole tokens only");
});

test("rule order: provider hint > console:env tag > Environment tag > name > VPC > connectivity", () => {
  const { resources } = assignEnvs(
    [
      R("a", { tags: { "console:env": "staging", Environment: "production" }, name: "acme-production-x" }),
      R("b", { tags: { Environment: "prod" }, envHint: "staging" }),
      R("c", { envHint: "production", name: "acme-staging-y" }),
      R("d:acme-staging-z", { name: "Zed" }),
      R("e", { name: "worker-e", vpcId: "vpc-p" }),
      R("f", { name: "anchor", envHint: "production", vpcId: "vpc-p" }),
      R("g", { name: "legacy-tool" }),
      R("h", { name: "explicitly-shared", tags: { Environment: "shared" }, vpcId: "vpc-p" }),
      R("x", { kind: "external", name: "status.vendor.io" }),
    ],
    [E("g", "f"), E("x", "f"), E("h", "f")],
    KNOWN,
  );
  const by = Object.fromEntries(resources.map((r) => [r.key, [r.env, r.envWhy]]));
  assert.deepEqual(by.a, ["staging", "tag console:env=staging"]);
  assert.deepEqual(by.b, ["staging", "reported by lambda"], "the provider's hint (e.g. the ECS cluster) outranks tags");
  assert.deepEqual(by.c, ["production", "reported by lambda"]);
  assert.deepEqual(by["d:acme-staging-z"], ["staging", 'name contains "staging"'], "the id, not the display name");
  assert.deepEqual(by.e, ["production", "VPC vpc-p"]);
  assert.deepEqual(by.g, ["production", "connected to anchor"]);
  assert.deepEqual(by.h, [undefined, "tag Environment=shared"], "explicitly shared stays shared");
  assert.deepEqual(by.x, [undefined, undefined], "externals are never assigned");
  const prot = Object.fromEntries(resources.map((r) => [r.key, r.protectedBy]));
  assert.ok(prot.a, "a tag saying staging can't remove the production its name and other tag say");
  assert.ok(prot.b, "Environment=prod still protects a resource its provider places in staging");
  assert.ok(prot.c && prot.e && prot.f && prot.g);
  assert.equal(prot["d:acme-staging-z"], undefined);
});

test("protection fails safe: tags add protection but never remove it; workloads inherit their cluster", () => {
  const { resources } = assignEnvs(
    [
      R("svc", { envHint: "production", tags: { Environment: "dev" } }),
      R("cl", { kind: "eks-cluster", name: "data-platform", tags: { Environment: "production" } }),
      R("wl", { kind: "eks-workload", name: "recommender", tags: { env: "sandbox" } }),
      R("tool", { name: "internal-tool", tags: { "console:protected": "true" } }),
    ],
    [E("cl", "wl")],
    KNOWN,
  );
  const by = Object.fromEntries(resources.map((r) => [r.key, r]));
  assert.equal(by.svc.env, "production");
  assert.ok(by.svc.protectedBy);
  assert.equal(by.wl.env, "production", "a workload runs in its cluster's environment");
  assert.ok(by.wl.protectedBy);
  assert.equal(by.tool.protectedBy, "tag console:protected");
});

test("connectivity needs agreement, a mixed VPC decides nothing, and it spreads a few hops", () => {
  const { resources } = assignEnvs(
    [
      R("p", { envHint: "production", vpcId: "vpc-shared" }),
      R("s", { envHint: "staging", vpcId: "vpc-shared" }),
      R("mixed", { vpcId: "vpc-shared" }),
      R("both"),
      R("hop1"),
      R("hop2"),
    ],
    [E("both", "p"), E("both", "s"), E("hop1", "p"), E("hop2", "hop1")],
    KNOWN,
  );
  const env = (k: string) => resources.find((r) => r.key === k)!.env;
  assert.equal(env("mixed"), undefined);
  assert.equal(env("both"), undefined);
  assert.equal(env("hop1"), "production");
  assert.equal(env("hop2"), "production");
});

test("connectivity: neighbours that disagree once every hop is placed leave a resource shared, and what only it placed", () => {
  // s (staging) — a — b — p (production): one pass gave a staging and b production; settled, each has a neighbour in
  // the other environment. leaf hangs off a only, tail off p only.
  const { resources } = assignEnvs(
    [R("s", { envHint: "staging" }), R("a"), R("b"), R("p", { envHint: "production" }), R("leaf"), R("tail")],
    [E("a", "s"), E("a", "b"), E("b", "p"), E("leaf", "a"), E("tail", "p")],
    KNOWN,
  );
  const by = Object.fromEntries(resources.map((r) => [r.key, [r.env, r.envWhy]]));
  assert.deepEqual(by.a, [undefined, undefined]);
  assert.deepEqual(by.b, [undefined, undefined]);
  assert.deepEqual(by.leaf, [undefined, undefined], "placed only through a");
  assert.deepEqual(by.tail, ["production", "connected to p"]);
});

test("environments: ECS ones always listed; new ids from tags and names, protected when production-like or tagged", () => {
  const { envs } = assignEnvs(
    [
      R("a", { tags: { Environment: "qa" } }),
      R("acme-uat-api", { name: "API" }),
      R("c", { tags: { "console:env": "Data Platform", "console:protected": "true" } }),
    ],
    [],
    KNOWN,
  );
  assert.deepEqual(envs.map((e) => [e.id, e.protected, e.source]), [
    ["staging", false, "ecs"],
    ["production", true, "ecs"],
    ["qa", false, "tags"],
    ["uat", false, "names"],
    ["data-platform", true, "tags"],
  ]);
  const only = assignEnvs([R("x", { tags: { env: "live" } })], [], []);
  assert.deepEqual(only.envs, [{ id: "production", label: "Production", protected: true, source: "tags" }]);
});

test("CC-15: hubs receive an environment but never decide a VPC or pass one on", () => {
  const { resources } = assignEnvs(
    [
      R("api", { envHint: "production", vpcId: "vpc-p" }),
      R("worker", { vpcId: "vpc-p" }),
      R("sg-stg-tagged", { kind: "security-group", tags: { Environment: "staging" }, vpcId: "vpc-p" }), // tagged wrongly: must not make vpc-p "mixed"
      R("sg-plain", { kind: "security-group", vpcId: "vpc-p" }),
      R("key", { kind: "kms-key" }),
      R("fn", {}),
      R("generic", { kind: "aws-resource", vpcId: "vpc-p" }),
      R("generic-tagged", { kind: "aws-resource", tags: { env: "staging" } }),
    ],
    [E("key", "api"), E("key", "fn"), E("generic", "api")],
    KNOWN,
  );
  const by = Object.fromEntries(resources.map((r) => [r.key, [r.env, r.envWhy]]));
  assert.deepEqual(by.worker, ["production", "VPC vpc-p"], "a tagged security group doesn't make the VPC mixed");
  assert.deepEqual(by["sg-plain"], ["production", "VPC vpc-p"], "a hub may receive");
  assert.deepEqual(by["sg-stg-tagged"], ["staging", "tag Environment=staging"]);
  assert.deepEqual(by.key, ["production", "connected to api"]);
  assert.deepEqual(by.fn, [undefined, undefined], "the key it shares with api doesn't place it");
  assert.deepEqual(by.generic, [undefined, undefined], "generic rows: tags and ids only");
  assert.deepEqual(by["generic-tagged"], ["staging", "tag env=staging"]);
  // Protection still fails safe: a hub in a production-only VPC is protected, whatever placed it (or nothing did).
  const prot = Object.fromEntries(resources.map((r) => [r.key, r.protectedBy]));
  assert.equal(prot.generic, "VPC vpc-p → production");
  assert.equal(prot["sg-stg-tagged"], "VPC vpc-p → production");
});

test("children take their parent's environment unless they say otherwise; protection counts the parent too", () => {
  const { resources } = assignEnvs(
    [
      R("vpc", { kind: "vpc", tags: { Environment: "production" } }),
      R("subnet", { kind: "subnet", parent: "vpc" }),
      R("nat", { kind: "nat-gateway", parent: "subnet" }),
      R("subnet-tagged", { kind: "subnet", parent: "vpc", tags: { env: "staging" } }),
      R("cluster", { kind: "rds-cluster", envHint: "staging" }),
      R("member", { kind: "rds", parent: "cluster", vpcId: "vpc-x" }),
      R("prod-anchor", { envHint: "production", vpcId: "vpc-x" }),
    ],
    [E("member", "prod-anchor")],
    KNOWN,
  );
  const by = Object.fromEntries(resources.map((r) => [r.key, r]));
  assert.deepEqual([by.subnet.env, by.subnet.envWhy], ["production", "part of vpc"]);
  assert.deepEqual([by.nat.env, by.nat.envWhy], ["production", "part of subnet"], "a chain settles");
  assert.deepEqual([by["subnet-tagged"].env, by["subnet-tagged"].protectedBy], ["staging", "part of vpc → production"], "its own tag places it; its parent still protects it");
  assert.deepEqual([by.member.env, by.member.envWhy], ["staging", "part of cluster"], "the parent beats the VPC and the connections");
});

test("F69: name hints come from ids, never display names, and yield to an authoritative hint", () => {
  const { resources } = assignEnvs(
    [
      R("workload:live-core-staging", { kind: "workload", provider: "declared", name: "Live Core", envHint: "staging" }),
      R("i-0abc", { kind: "ec2-instance", name: "Live Core" }),
      R("arn:aws:lambda:us-east-1:123456789012:function:orders-prod", { name: "Orders" }),
      R("arn:aws:s3:::acme-ops", { kind: "s3" }),
      R("arn:aws:s3:::acme-uploads", { kind: "s3" }),
      R("arn:aws:s3:::acme-media", { kind: "s3" }),
      R("svc", { envHint: "production" }),
      R("svc2", { envHint: "production" }),
    ],
    [
      { ...E("svc", "arn:aws:s3:::acme-ops"), evidence: ["env file"], confidence: "mentioned" },
      { ...E("svc2", "arn:aws:s3:::acme-ops"), evidence: ["env file"], confidence: "mentioned" },
      { ...E("svc", "arn:aws:s3:::acme-uploads"), evidence: ["env UPLOADS_BUCKET"], confidence: "mentioned" },
      { ...E("svc", "arn:aws:s3:::acme-media"), evidence: ["env file MEDIA_BUCKET"], confidence: "mentioned" },
    ],
    KNOWN,
  );
  const by = Object.fromEntries(resources.map((r) => [r.key, r]));
  assert.deepEqual([by["workload:live-core-staging"].env, by["workload:live-core-staging"].protectedBy], ["staging", undefined], "'Live' in a display name doesn't make staging production");
  assert.deepEqual([by["i-0abc"].env, by["i-0abc"].protectedBy], [undefined, undefined]);
  assert.equal(by["arn:aws:lambda:us-east-1:123456789012:function:orders-prod"].env, "production", "the function name is an id");
  assert.deepEqual([by["arn:aws:s3:::acme-ops"].env, by["arn:aws:s3:::acme-ops"].protectedBy], [undefined, undefined], "env files alone don't place a bucket");
  assert.equal(by["arn:aws:s3:::acme-uploads"].env, "production", "a real data path still does");
  assert.equal(by["arn:aws:s3:::acme-media"].env, "production", "so does a variable inside an env file that names the bucket");
});

// The real account's 23 resources (anonymised: names, ids and account replaced), as assigned before this change. Two
// differences are intended: the ops bucket was placed in production only because three services read env files from
// it (now unassigned, F69), and the staging "Live Orders" workload was protected as production because of its display
// name (now not).
test("regression: the real account's 23 resources keep their environments", () => {
  const P = "ap-south-1";
  const res = (key: string, kind: Resource["kind"], provider: string, name: string, extra: Partial<Resource> = {}) => R(key, { kind, provider, name, region: P, ...extra });
  const svc = (n: string) => res(`ecs:service/acme-production/${n}`, "ecs-service", "ecs", n, { tags: { env: "production" }, vpcId: "vpc-0acme0000", envHint: "production" });
  const ext = (id: string, name: string) => res(`external:${id}`, "external", "ecs", name, { region: "global" });
  const wl = (id: string, name: string) => res(`workload:${id}`, "workload", "declared", name, { region: "global", envHint: "staging" });
  const cf = (id: string, name: string, tag: string) => res(`arn:aws:cloudfront::123456789012:distribution/${id}`, "cloudfront", "cloudfront", name, { region: "global", tags: { Name: tag } });
  const input: Resource[] = [
    svc("acme-jobs"), svc("acme-storefront"), svc("acme-portal"),
    ext("users", "Users"), ext("events", "Events"), ext("crm", "CRM"), ext("erp", "ERP"),
    res("elb:acme-production", "loadbalancer", "elb", "acme-production", { tags: { env: "production" }, vpcId: "vpc-0acme0000", envHint: "production" }),
    res("rds:acme-production-pg", "rds", "rds", "acme-production-pg", { tags: { env: "production" }, vpcId: "vpc-0acme0000", envHint: "production" }),
    res("rds:acme-staging-pg", "rds", "rds", "acme-staging-pg", { tags: { env: "staging" }, vpcId: "vpc-0acme0001" }),
    res("elasticache:acme-production", "elasticache", "elasticache", "acme-production", { envHint: "production" }),
    res("ec2:i-0acme0staging0001", "ec2-instance", "ec2", "acme-staging", { tags: { Name: "acme-staging", deploy: "github", env: "staging" }, vpcId: "vpc-0acme0001" }),
    res("arn:aws:s3:::acme-assets", "s3", "s3", "acme-assets", { tags: { product: "storefront" } }),
    res("arn:aws:s3:::acme-portal-assets", "s3", "s3", "acme-portal-assets", { tags: { product: "portal" } }),
    res("arn:aws:s3:::acme-ops-123456789012", "s3", "s3", "acme-ops-123456789012"),
    cf("E0ACMEPORTAL01", "E0ACMEPORTAL01", "acme-portal-assets"), cf("E0ACMEASSETS01", "acme assets", "acme-assets"),
    res("arn:aws:route53:::hostedzone/Z0ACMEINTERNAL1", "route53-zone", "route53", "acme.internal", { region: "global", vpcId: "vpc-0acme0000" }),
    wl("caddy-staging", "Caddy (TLS + routing)"), wl("redis-staging", "Redis"), wl("portal-staging", "Portal"), wl("live-orders-staging", "Live Orders"), wl("jobs-staging", "Jobs"),
  ];
  const s = (n: string) => `ecs:service/acme-production/${n}`;
  const cfg = (from: string, to: string, evidence = "console.config.json"): Edge => ({ ...E(from, to), evidence: [evidence] });
  const edges: Edge[] = [
    cfg(s("acme-storefront"), s("acme-jobs")), cfg(s("acme-jobs"), s("acme-storefront")),
    ...["acme-jobs", "acme-storefront", "acme-portal"].flatMap((n) => [cfg(s(n), "rds:acme-production-pg"), cfg(s(n), "elasticache:acme-production"), cfg("elb:acme-production", s(n))]),
    cfg("external:users", "elb:acme-production"), cfg("external:events", s("acme-jobs")), cfg(s("acme-jobs"), "external:crm"), cfg("external:crm", s("acme-jobs")),
    cfg(s("acme-storefront"), "external:crm"), cfg(s("acme-storefront"), "external:erp"),
    cfg("arn:aws:cloudfront::123456789012:distribution/E0ACMEPORTAL01", "arn:aws:s3:::acme-portal-assets", "CloudFront origin (S3, origin access control)"),
    cfg("arn:aws:cloudfront::123456789012:distribution/E0ACMEASSETS01", "arn:aws:s3:::acme-assets", "CloudFront origin (S3, origin access control)"),
    ...["caddy-staging", "redis-staging", "portal-staging", "live-orders-staging", "jobs-staging"].map((w) => cfg(`workload:${w}`, "ec2:i-0acme0staging0001", `workloads.${w}.host in console.config.json`)),
    ...["live-orders-staging", "jobs-staging", "portal-staging"].map((w) => cfg("workload:caddy-staging", `workload:${w}`, "workloads.caddy-staging.uses in console.config.json")),
    ...["portal-staging", "live-orders-staging", "jobs-staging"].flatMap((w) => [cfg(`workload:${w}`, "rds:acme-staging-pg"), cfg(`workload:${w}`, "workload:redis-staging")]),
    cfg("workload:live-orders-staging", "external:crm"), cfg("workload:live-orders-staging", "external:erp"), cfg("workload:jobs-staging", "external:events"), cfg("workload:jobs-staging", "external:crm"),
    ...["acme-jobs", "acme-storefront", "acme-portal"].map((n) => ({ ...E(s(n), "arn:aws:s3:::acme-ops-123456789012"), evidence: ["env file"], confidence: "mentioned" as const })),
    { ...E("ec2:i-0acme0staging0001", "rds:acme-staging-pg"), evidence: ["security group sg-0acme0002 allows sg-0acme0003"], confidence: "allowed" },
  ];
  const { resources, envs } = assignEnvs(input, edges, [{ id: "production", label: "Production", protected: true, source: "config" }]);
  const got = Object.fromEntries(resources.map((r) => [r.key, [r.env ?? null, r.envWhy ?? null, r.protectedBy ?? null]]));
  const prod = (why: string) => ["production", why, `${why} → production`];
  assert.deepEqual(got, {
    [s("acme-jobs")]: prod("reported by ecs"), [s("acme-storefront")]: prod("reported by ecs"), [s("acme-portal")]: prod("reported by ecs"),
    "external:users": [null, null, null], "external:events": [null, null, null], "external:crm": [null, null, null], "external:erp": [null, null, null],
    "elb:acme-production": prod("reported by elb"), "rds:acme-production-pg": prod("reported by rds"),
    "rds:acme-staging-pg": ["staging", "tag env=staging", null], "elasticache:acme-production": prod("reported by elasticache"),
    "ec2:i-0acme0staging0001": ["staging", "tag env=staging", null],
    "arn:aws:s3:::acme-assets": [null, null, null], "arn:aws:s3:::acme-portal-assets": [null, null, null],
    "arn:aws:s3:::acme-ops-123456789012": [null, null, null], // was production via "connected to acme-jobs and 2 more" (env files only)
    "arn:aws:cloudfront::123456789012:distribution/E0ACMEPORTAL01": [null, null, null], "arn:aws:cloudfront::123456789012:distribution/E0ACMEASSETS01": [null, null, null],
    "arn:aws:route53:::hostedzone/Z0ACMEINTERNAL1": prod("VPC vpc-0acme0000"),
    "workload:caddy-staging": ["staging", "reported by declared", null], "workload:redis-staging": ["staging", "reported by declared", null],
    "workload:portal-staging": ["staging", "reported by declared", null], "workload:jobs-staging": ["staging", "reported by declared", null],
    "workload:live-orders-staging": ["staging", "reported by declared", null], // was protectedBy "its name → production" ("Live Orders")
  });
  assert.deepEqual(envs.map((e) => [e.id, e.protected, e.source]), [["production", true, "config"], ["staging", false, "tags"]]);
});

test("outside the home region, a tag or id naming a renamed environment places the resource in the region's one", () => {
  const known: KnownEnv[] = [...KNOWN, { id: "production-eu-west-1", label: "Production (eu-west-1)", protected: true, source: "ecs" }];
  assert.equal(regionalEnv("production", "eu-west-1", known), "production-eu-west-1");
  assert.equal(regionalEnv("production", "us-east-1", known), "production");
  assert.equal(regionalEnv("staging", "eu-west-1", known), "staging", "no staging environment was renamed for eu-west-1");
  const { resources } = assignEnvs(
    [
      R("arn:aws:s3:::acme-production-assets-eu", { kind: "s3", region: "eu-west-1", tags: { Environment: "production" } }),
      R("vpc-eu-prod", { kind: "vpc", region: "eu-west-1", name: "acme-production-eu" }),
      R("arn:aws:lambda:eu-west-1:1:function:acme-production-thumbs", { region: "eu-west-1" }),
      R("arn:aws:lambda:us-east-1:1:function:acme-production-thumbs", { region: "us-east-1" }),
      R("ecs:service/acme-production/api@eu-west-1", { kind: "ecs-service", region: "eu-west-1", envHint: "production-eu-west-1" }),
    ],
    [],
    known,
  );
  assert.deepEqual(resources.map((r) => r.env), ["production-eu-west-1", "production-eu-west-1", "production-eu-west-1", "production", "production-eu-west-1"]);
});
