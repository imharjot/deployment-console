import { test } from "node:test";
import assert from "node:assert/strict";
import { artifactBucket, canaryEngines, canaryHealth, canaryResults, lastRunByCanary, type RawCanary, type RawCanaryRun } from "./synthetics.ts";

const ACCT = "123456789012";
const R = "us-east-1";
const NOW = Date.UTC(2026, 9, 5, 12);
const MIN = 60_000;
const DAY = 86_400_000;
const SENTINEL = "SECRET_SENTINEL_5c7a";
const key = (name: string) => `arn:aws:synthetics:${R}:${ACCT}:canary:${name}`;

// Run-config environment variables are write-only in the API, but a future SDK might echo them, and the code bundle's
// dependencies or visual references name things that never belong on the map.
const canary = (o: Partial<RawCanary> = {}): RawCanary => ({
  Id: "c0ffee00-1111-4222-8333-000000000001", Name: "acme-checkout-canary",
  Code: { Handler: "checkout.handler", SourceLocationArn: `arn:aws:lambda:${R}:${ACCT}:layer:cwsyn-acme-checkout-canary:3` },
  ExecutionRoleArn: `arn:aws:iam::${ACCT}:role/service-role/acme-canary-role`,
  Schedule: { Expression: "rate(5 minutes)", DurationInSeconds: 0 }, RunConfig: { TimeoutInSeconds: 60, MemoryInMB: 1500, ActiveTracing: true },
  SuccessRetentionPeriodInDays: 7, FailureRetentionPeriodInDays: 31, Status: { State: "RUNNING" },
  Timeline: { Created: new Date(NOW - 160 * DAY), LastModified: new Date(NOW - 12 * DAY), LastStarted: new Date(NOW - 12 * DAY) },
  ArtifactS3Location: "cw-syn-results-123456789012-us-east-1/canary/us-east-1/acme-checkout-canary",
  EngineArn: `arn:aws:lambda:${R}:${ACCT}:function:cwsyn-acme-checkout-canary-0acme0c9:7`,
  RuntimeVersion: "syn-nodejs-puppeteer-9.1",
  VpcConfig: { VpcId: "vpc-prod", SubnetIds: ["subnet-prod-a"], SecurityGroupIds: ["sg-prod-api"] },
  ArtifactConfig: { S3Encryption: { EncryptionMode: "SSE_KMS", KmsKeyArn: `arn:aws:kms:${R}:${ACCT}:key/k1` } },
  Tags: { Environment: "production" },
  ...o,
  ...({ RunConfigEnvironment: { PASSWORD: SENTINEL }, Code: { ...(o.Code ?? { Handler: "checkout.handler", SourceLocationArn: `arn:aws:lambda:${R}:${ACCT}:layer:cwsyn-acme-checkout-canary:3` }), Dependencies: [{ Reference: SENTINEL }] }, VisualReference: { BaseScreenshots: [{ ScreenshotName: SENTINEL }] } } as object),
});
const failed: RawCanaryRun = {
  Id: "r1", Name: "acme-checkout-canary",
  Status: { State: "FAILED", StateReason: "Waiting for selector `#checkout-button` failed: timeout 30000ms exceeded", StateReasonCode: "CANARY_FAILURE" },
  Timeline: { Started: new Date(NOW - 4 * MIN), Completed: new Date(NOW - 4 * MIN + 41_000) },
};

test("golden: a running canary whose last run failed — an error, links to its function, bucket, role and key, its VPC", () => {
  const out = canaryResults({ region: R, accountId: ACCT, now: NOW, canaries: [canary()], lastRuns: { "acme-checkout-canary": failed }, runsState: "ok" });
  assert.deepEqual(out.resources, [{
    key: key("acme-checkout-canary"), kind: "synthetics-canary", provider: "synthetics", name: "acme-checkout-canary", region: R, tags: { Environment: "production" },
    health: "error", healthReason: "canary failing — last run failed at 2026-10-05 11:56 UTC: Waiting for selector `#checkout-button` failed: timeout 30000ms exceeded",
    props: [
      { label: "State", value: "RUNNING" },
      { label: "Last run", value: "FAILED at 2026-10-05 11:56 UTC" },
      { label: "Last run reason", value: "Waiting for selector `#checkout-button` failed: timeout 30000ms exceeded" },
      { label: "Schedule", value: "every 5 minutes" },
      { label: "Runtime", value: "syn-nodejs-puppeteer-9.1" },
      { label: "Timeout", value: "60 s" },
      { label: "Memory", value: "1500 MB" },
      { label: "X-Ray tracing", value: "on" },
      { label: "Keeps runs", value: "7 days (passed) · 31 days (failed)" },
    ],
    vpcId: "vpc-prod", subnetIds: ["subnet-prod-a"], securityGroups: ["sg-prod-api"],
    aliases: ["acme-checkout-canary", "c0ffee00-1111-4222-8333-000000000001"],
    consoleUrl: `https://${R}.console.aws.amazon.com/cloudwatch/home?region=${R}#synthetics:canary/detail/acme-checkout-canary`,
    createdAt: NOW - 160 * DAY, lastModified: NOW - 12 * DAY, observedAt: NOW, enrichment: { lastRun: "ok" },
  }]);
  assert.deepEqual(out.links, [
    { from: key("acme-checkout-canary"), to: `arn:aws:lambda:${R}:${ACCT}:function:cwsyn-acme-checkout-canary-0acme0c9`, kind: "invoke", label: "runs on", evidence: "canary EngineArn (its Lambda function)" },
    { from: key("acme-checkout-canary"), to: "arn:aws:s3:::cw-syn-results-123456789012-us-east-1", kind: "writes", label: "run artifacts", evidence: "canary ArtifactS3Location" },
    { from: key("acme-checkout-canary"), to: `arn:aws:iam::${ACCT}:role/service-role/acme-canary-role`, kind: "assumes", label: "execution role", evidence: "canary ExecutionRoleArn" },
    { from: `arn:aws:kms:${R}:${ACCT}:key/k1`, to: key("acme-checkout-canary"), kind: "encrypts", label: "run artifacts", evidence: "canary ArtifactConfig.S3Encryption" },
  ]);
  assert.ok(!JSON.stringify(out).includes(SENTINEL), "environment, dependencies and screenshots never reach the map");
});

test("health: ERROR and STOPPED win, a passed run is ok, no run or an unread run is unknown", () => {
  const passed: RawCanaryRun = { Status: { State: "PASSED" }, Timeline: { Started: new Date(NOW - MIN) } };
  assert.deepEqual(canaryHealth(canary({ Status: { State: "ERROR", StateReason: "Lambda function not found" } }), failed, true), { health: "error", reason: "canary in ERROR: Lambda function not found" });
  assert.deepEqual(canaryHealth(canary({ Status: { State: "STOPPED" } }), failed, true), { health: "stopped", reason: "stopped — its last run failed" });
  assert.deepEqual(canaryHealth(canary({ Status: { State: "READY" } }), undefined, true), { health: "stopped", reason: "created, never started" });
  assert.deepEqual(canaryHealth(canary(), passed, true), { health: "ok" });
  assert.deepEqual(canaryHealth(canary(), { Status: { State: "RUNNING" } }, true), { health: "ok" });
  assert.deepEqual(canaryHealth(canary(), undefined, true), { health: "unknown", reason: "no run recorded yet" });
  assert.deepEqual(canaryHealth(canary(), undefined, false), { health: "unknown", reason: "last run not read" });
});

test("last runs denied: every canary says so; the checkpoint before the read does too", () => {
  const out = canaryResults({ region: R, accountId: ACCT, now: NOW, canaries: [canary()], runsState: "denied" });
  const r = out.resources[0];
  assert.deepEqual([r.health, r.props.find((p) => p.label === "Last run")?.value, r.enrichment], ["unknown", "last run not read (denied)", { lastRun: "denied" }]);
  const cp = canaryResults({ region: R, accountId: ACCT, now: NOW, canaries: [canary()], runsState: "skipped" }).resources[0];
  assert.equal(cp.props.find((p) => p.label === "Last run")?.value, "last run not read (skipped)");
  const none = canaryResults({ region: R, accountId: ACCT, now: NOW, canaries: [canary()], lastRuns: {}, runsState: "ok" }).resources[0];
  assert.deepEqual([none.health, none.props.find((p) => p.label === "Last run")?.value], ["unknown", "none yet"]);
});

test("tags come with DescribeCanaries (no tags is an answer, not 'unread'); the account comes from the canary's ARNs", () => {
  const out = canaryResults({ region: R, now: NOW, canaries: [canary({ Tags: undefined, ExecutionRoleArn: undefined, EngineArn: `arn:aws:lambda:${R}:210987654321:function:cwsyn-x:1` })], lastRuns: {}, runsState: "ok" });
  assert.deepEqual([out.resources[0].tags, out.resources[0].tagsUnread, out.resources[0].key], [{}, undefined, `arn:aws:synthetics:${R}:210987654321:canary:acme-checkout-canary`]);
  assert.deepEqual(canaryResults({ region: R, now: NOW, canaries: [canary({ EngineArn: undefined, ExecutionRoleArn: undefined })] }).resources, [], "no account to build the key from");
});

test("artifact locations: with or without s3://, only the bucket", () => {
  assert.equal(artifactBucket("s3://acme-logs/canary/x"), "arn:aws:s3:::acme-logs");
  assert.equal(artifactBucket("acme-logs/canary/x"), "arn:aws:s3:::acme-logs");
  assert.equal(artifactBucket("acme-logs"), "arn:aws:s3:::acme-logs");
  assert.equal(artifactBucket("Not A Bucket/x"), undefined);
  assert.equal(artifactBucket(undefined), undefined);
});

// Runtimes from syn-nodejs-puppeteer-11.0 / syn-nodejs-playwright-3.0 on have no EngineArn: one EngineConfigs entry per
// browser instead. Without them the canary had no "runs on" link (and no account when it has no role ARN either).
test("newer runtimes: EngineConfigs give one 'runs on' link per browser, and the account", () => {
  const engines = [
    { EngineArn: `arn:aws:lambda:${R}:210987654321:function:cwsyn-acme-checkout-canary-chrome:4`, BrowserType: "CHROME" },
    { EngineArn: `arn:aws:lambda:${R}:210987654321:function:cwsyn-acme-checkout-canary-firefox:4`, BrowserType: "FIREFOX" },
  ];
  const c = canary({ EngineArn: undefined, ExecutionRoleArn: undefined, EngineConfigs: engines, RuntimeVersion: "syn-nodejs-puppeteer-11.0" });
  assert.deepEqual(canaryEngines(c), [
    { arn: `arn:aws:lambda:${R}:210987654321:function:cwsyn-acme-checkout-canary-chrome`, browser: "CHROME" },
    { arn: `arn:aws:lambda:${R}:210987654321:function:cwsyn-acme-checkout-canary-firefox`, browser: "FIREFOX" },
  ]);
  const out = canaryResults({ region: R, now: NOW, canaries: [c], lastRuns: {}, runsState: "ok" });
  assert.equal(out.resources[0].key, `arn:aws:synthetics:${R}:210987654321:canary:acme-checkout-canary`);
  assert.deepEqual(out.links.filter((l) => l.kind === "invoke").map((l) => [l.to.split(":").pop(), l.label]), [
    ["cwsyn-acme-checkout-canary-chrome", "runs on (chrome)"], ["cwsyn-acme-checkout-canary-firefox", "runs on (firefox)"],
  ]);
  assert.deepEqual(canaryEngines(canary({ EngineConfigs: [{ EngineArn: canary().EngineArn }] })).length, 1, "the same function twice is one engine");
});

test("last runs per canary: a multi-browser canary's failed browser wins, else the newest; any name is a key", () => {
  const run = (state: string, ago: number, browser?: string): RawCanaryRun => ({ Status: { State: state }, Timeline: { Started: new Date(NOW - ago) }, ...(browser ? { BrowserType: browser } : {}) });
  const runs = lastRunByCanary([
    { CanaryName: "checkout", LastRun: run("FAILED", 9 * MIN, "FIREFOX") },
    { CanaryName: "checkout", LastRun: run("PASSED", 2 * MIN, "CHROME") },
    { CanaryName: "login", LastRun: run("PASSED", 9 * MIN) },
    { CanaryName: "login", LastRun: run("PASSED", 1 * MIN) },
    { CanaryName: "__proto__", LastRun: run("FAILED", MIN) },
    { CanaryName: "never" },
  ]);
  assert.deepEqual([runs.checkout.Status?.State, runs.checkout.BrowserType], ["FAILED", "FIREFOX"]);
  assert.equal(runs.login.Timeline?.Started instanceof Date && runs.login.Timeline.Started.getTime(), NOW - MIN);
  assert.ok(Object.hasOwn(runs, "__proto__"), "a canary named __proto__ is a key, not the prototype");
  assert.ok(!Object.hasOwn(runs, "never"));
  const out = canaryResults({ region: R, accountId: ACCT, now: NOW, canaries: [canary({ Name: "__proto__" })], lastRuns: runs, runsState: "ok" });
  assert.equal(out.resources[0].health, "error");
});
