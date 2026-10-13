import { test } from "node:test";
import assert from "node:assert/strict";
import {
  configCache, deployLabel, deploySource, deployStateOf, describeAlias, lambdaHealth, lambdaResult, mappingLinks, policyTriggers, rollbackTarget, settledState,
  shiftProblem, type ConfigCacheEntry, type RawFunctionEx,
} from "./serverless-lambda.ts";

const NOW = Date.UTC(2026, 8, 27);
const FN = "arn:aws:lambda:us-east-1:123456789012:function:orders";
// A function whose deployment state was read (GetFunctionConfiguration), as discovery hands it to the mapper.
const base: RawFunctionEx = { FunctionName: "orders", FunctionArn: FN, Runtime: "nodejs22.x", State: "Active", LastUpdateStatus: "Successful", PackageType: "Zip", deployState: "ok" };
const SENTINEL = "SECRET-SENTINEL-7f3a9c"; // an environment value: may reach mentions (server-only), never resources or links

test("R12: a ListFunctions-shaped function (no deployment state) is unknown, never ok — even one that has failed", () => {
  // The REVIEW reproduction: ListFunctions leaves State and LastUpdateStatus out, so a failed function looks bare.
  const listed: RawFunctionEx = { FunctionName: "payments", FunctionArn: FN, Runtime: "nodejs22.x" };
  assert.deepEqual(lambdaHealth(listed, NOW), { health: "unknown", reason: "deployment state not read (skipped)" });
  const r = lambdaResult({ functions: [listed], mappings: [] }, NOW).resources[0];
  assert.equal(r.health, "unknown");
  assert.equal(r.props.find((p) => p.label === "Deployment state")?.value, "not read (skipped)");
  // A stray State on an unread item is not trusted: only deployState "ok" makes it count.
  assert.equal(lambdaHealth({ ...listed, State: "Active", LastUpdateStatus: "Successful" }, NOW).health, "unknown");
  // Why it wasn't read: denied, past the 300-function cap, a failed read.
  assert.equal(lambdaHealth({ ...listed, deployState: "denied" }, NOW).reason, "deployment state not read (denied)");
  assert.equal(lambdaHealth({ ...listed, deployState: "capped" }, NOW).reason, "deployment state not read (capped)");
  // The same function once its configuration was read: Failed is an error.
  const read = { ...listed, deployState: "ok" as const, State: "Failed", StateReason: "The function's subnets have no free IP addresses" };
  assert.deepEqual(lambdaHealth(read, NOW), { health: "error", reason: "function failed: The function's subnets have no free IP addresses" });
  assert.equal(deployLabel(read), "Failed");
  // What discovery knows for certain still shows while the state is unread.
  assert.match(lambdaHealth({ ...listed, reserved: 0 }, NOW).reason!, /throttled/);
  assert.equal(lambdaHealth({ ...listed, Runtime: "nodejs18.x" }, NOW).health, "warning");
});

test("health from state, last update, concurrency and runtime", () => {
  assert.deepEqual(lambdaHealth(base, NOW), { health: "ok" });
  assert.equal(deployLabel(base), "Active · last update successful");
  assert.equal(deployLabel({ ...base, LastUpdateStatus: "InProgress" }), "Active · last update in progress");
  assert.equal(lambdaHealth({ ...base, State: "Failed", StateReason: "ENI limit" }, NOW).health, "error");
  assert.equal(lambdaHealth({ ...base, LastUpdateStatus: "Failed" }, NOW).health, "error");
  assert.equal(lambdaHealth({ ...base, State: "Inactive" }, NOW).health, "stopped");
  assert.deepEqual(lambdaHealth({ ...base, LastUpdateStatus: "InProgress" }, NOW), { health: "warning", reason: "update in progress" });
  assert.match(lambdaHealth({ ...base, reserved: 0 }, NOW).reason!, /throttled/);
  assert.match(lambdaHealth({ ...base, Runtime: "nodejs18.x" }, NOW).reason!, /deprecated \(since 2025-09-01\)/);
  assert.equal(lambdaHealth({ ...base, Runtime: "dotnet8" }, NOW).health, "ok"); // deprecates soon: noted, still ok
});

test("event source mappings: source → function (poll), streams resolve to their table / stream", () => {
  const [sqs] = mappingLinks({ EventSourceArn: "arn:aws:sqs:us-east-1:1:orders", FunctionArn: `${FN}:live`, State: "Enabled", BatchSize: 10, MaximumBatchingWindowInSeconds: 5 });
  assert.deepEqual(sqs, { from: "arn:aws:sqs:us-east-1:1:orders", to: FN, kind: "poll", label: "batch 10", evidence: "event source mapping (enabled, batch 10, window 5 s)" });
  const ddb = mappingLinks({
    EventSourceArn: "arn:aws:dynamodb:us-east-1:1:table/carts/stream/2025", FunctionArn: FN, State: "Disabled", BatchSize: 100, StartingPosition: "LATEST",
    DestinationConfig: { OnFailure: { Destination: "arn:aws:sqs:us-east-1:1:failed" } }, FilterCriteria: { Filters: [{ Pattern: JSON.stringify({ eventName: ["INSERT"] }) }] },
  });
  assert.equal(ddb[0].from, "arn:aws:dynamodb:us-east-1:1:table/carts");
  assert.equal(ddb[0].label, "disabled · batch 100");
  assert.match(ddb[0].evidence, /from latest, filter eventName: INSERT/);
  assert.deepEqual([ddb[1].from, ddb[1].to, ddb[1].kind], [FN, "arn:aws:sqs:us-east-1:1:failed", "event"]);
  assert.deepEqual(mappingLinks({ FunctionArn: FN }), []); // self-managed Kafka: no ARN to link
});

test("lambdaResult: props never hold variable values; URL host is an endpoint; values become mentions", () => {
  const r = lambdaResult({
    functions: [{
      ...base, MemorySize: 512, Timeout: 30, CodeSize: 1_480_000, Handler: "index.handler", LastModified: "2026-09-26T10:00:00.000+0000",
      Environment: { Variables: { QUEUE_URL: "https://sqs.us-east-1.amazonaws.com/1/orders", API_KEY: "super-secret-value", TOKEN: SENTINEL } },
      VpcConfig: { VpcId: "vpc-1", SubnetIds: ["s-1", "s-2"], SecurityGroupIds: ["sg-1"] },
      DeadLetterConfig: { TargetArn: "arn:aws:sqs:us-east-1:1:dlq" }, destinations: { onFailure: `${FN}-alarm:live` },
      url: { url: "https://abc123.lambda-url.us-east-1.on.aws/", authType: "NONE" }, tags: { Environment: "production" }, reserved: 5,
    }],
    mappings: [],
  }, NOW);
  const f = r.resources[0];
  assert.equal(f.key, FN);
  assert.ok(!JSON.stringify(f).includes("super-secret-value"));
  assert.equal(f.props.find((p) => p.label === "Environment variables")?.value, "3");
  assert.equal(f.props.find((p) => p.label === "Reserved concurrency")?.value, "5");
  assert.deepEqual(f.endpoints, ["abc123.lambda-url.us-east-1.on.aws"]);
  assert.deepEqual([f.vpcId, f.subnetIds, f.securityGroups], ["vpc-1", ["s-1", "s-2"], ["sg-1"]]);
  assert.equal(f.lastModified, Date.UTC(2026, 8, 26, 10));
  assert.deepEqual(r.links.filter((l) => l.kind === "event").map((l) => [l.to, l.label]), [["arn:aws:sqs:us-east-1:1:dlq", "dead-letter"], [`${FN}-alarm`, "on failure"]]);
  assert.deepEqual(r.mentions.map((m) => m.via), ["env QUEUE_URL", "env API_KEY", "env TOKEN"]);
  assert.ok(!JSON.stringify({ resources: r.resources, links: r.links }).includes(SENTINEL), "variable values stay in mentions");
  assert.deepEqual(f.tags, { Environment: "production" });
  assert.equal(f.tagsUnread, undefined);
  const img = lambdaResult({ functions: [{ ...base, PackageType: "Image", Runtime: undefined }], mappings: [] }, NOW).resources[0];
  assert.equal(img.props.find((p) => p.label === "Package type")?.value, "Container image");
});

test("support links (A.3): execution role, the variables' KMS key, the log group, EFS mounts", () => {
  const role = "arn:aws:iam::123456789012:role/orders-exec";
  const key = "arn:aws:kms:us-east-1:123456789012:key/mrk-0acme";
  const ap = "arn:aws:elasticfilesystem:us-east-1:123456789012:access-point/fsap-1";
  const links = (f: RawFunctionEx) => lambdaResult({ functions: [f], mappings: [] }, NOW).links.map((l) => [l.kind, l.from, l.to, l.label ?? ""]);
  assert.deepEqual(links({ ...base, Role: role, KMSKeyArn: key, FileSystemConfigs: [{ Arn: ap, LocalMountPath: "/mnt/media" }] }), [
    ["assumes", FN, role, "execution role"],
    ["encrypts", key, FN, "environment variables"],
    ["logs", FN, "arn:aws:logs:us-east-1:123456789012:log-group:/aws/lambda/orders", "/aws/lambda/orders"], // Lambda's default group
    ["mounts", FN, ap, "/mnt/media"],
  ]);
  // A custom log group (LoggingConfig) wins; a role that isn't a role ARN is not linked.
  assert.deepEqual(links({ ...base, Role: "not-an-arn", LoggingConfig: { LogGroup: "/shared/functions" } }), [
    ["logs", FN, "arn:aws:logs:us-east-1:123456789012:log-group:/shared/functions", "/shared/functions"],
  ]);
});

test("R01: tags not read are tagsUnread, tags read and empty are not; enrichment states are kept", () => {
  const [unread, empty] = lambdaResult({ functions: [{ ...base, enrichment: { state: "ok", tags: "capped" } }, { ...base, FunctionArn: `${FN}2`, FunctionName: "orders2", tags: {} }], mappings: [] }, NOW).resources;
  assert.deepEqual([unread.tags, unread.tagsUnread, unread.enrichment], [{}, true, { state: "ok", tags: "capped" }]);
  assert.deepEqual([empty.tags, empty.tagsUnread], [{}, undefined]);
});

test("R12: the deployment-state cache keeps six state fields per version, never the environment values", () => {
  const cfg = { ...base, LastModified: "2026-09-26T10:00:00.000+0000", CodeSha256: "abc=", Environment: { Variables: { TOKEN: SENTINEL } }, Role: "arn:aws:iam::1:role/x" };
  const state = deployStateOf(cfg);
  assert.deepEqual(state, { State: "Active", LastUpdateStatus: "Successful" });
  assert.ok(!JSON.stringify(state).includes(SENTINEL));
  const store = new Map<string, ConfigCacheEntry>();
  const cache = configCache(store, { ttlMs: 60_000, max: 2 });
  cache.put(cfg, state, NOW);
  assert.ok(!JSON.stringify([...store]).includes(SENTINEL), "nothing secret is cached");
  assert.deepEqual(cache.get(cfg, NOW + 1_000), state, "same version: served from the cache");
  assert.equal(cache.get({ ...cfg, LastModified: "2026-09-27T10:00:00.000+0000" }, NOW + 1_000), undefined, "a new LastModified is re-read");
  cache.put(cfg, state, NOW);
  assert.equal(cache.get({ ...cfg, CodeSha256: "def=" }, NOW + 1_000), undefined, "new code is re-read");
  cache.put(cfg, state, NOW);
  assert.equal(cache.get(cfg, NOW + 61_000), undefined, "older than the TTL: re-read (Inactive or Failed may arrive without a new version)");
  // Transient states are never cached: Pending and InProgress move on by themselves.
  assert.equal(settledState({ State: "Pending" }), false);
  assert.equal(settledState({ State: "Active", LastUpdateStatus: "InProgress" }), false);
  cache.put(cfg, { State: "Active", LastUpdateStatus: "InProgress" }, NOW);
  assert.equal(cache.get(cfg, NOW), undefined);
  // Bounded: the oldest entry goes first.
  for (const n of ["a", "b", "c"]) cache.put({ ...cfg, FunctionArn: `${FN}-${n}` }, state, NOW);
  assert.deepEqual([...store.keys()], [`${FN}-b`, `${FN}-c`]);
});

test("aliases: describe, shift rules, rollback target", () => {
  assert.equal(describeAlias({ FunctionVersion: "7" }), "7");
  assert.equal(describeAlias({ FunctionVersion: "12", RoutingConfig: { AdditionalVersionWeights: { "13": 0.1 } } }), "12 (90 %) + 13 (10 %)");
  const versions = ["$LATEST", "1", "2", "3"];
  assert.equal(shiftProblem("3", undefined, versions), undefined);
  assert.equal(shiftProblem("$LATEST", undefined, versions), undefined);
  assert.match(shiftProblem("9", undefined, versions)!, /doesn't exist/);
  assert.equal(shiftProblem("2", { version: "3", weight: 0.1 }, versions), undefined);
  assert.match(shiftProblem("2", { version: "2", weight: 0.1 }, versions)!, /must differ/);
  assert.match(shiftProblem("2", { version: "3", weight: 1 }, versions)!, /between 0 and 1/);
  assert.match(shiftProblem("$LATEST", { version: "3", weight: 0.5 }, versions)!, /published versions/);
  assert.deepEqual(rollbackTarget({ FunctionVersion: "3" }, versions), { version: "2", why: "version 3 → 2 (the newest older version)" });
  assert.deepEqual(rollbackTarget({ FunctionVersion: "2", RoutingConfig: { AdditionalVersionWeights: { "3": 0.2 } } }, versions), { version: "2", why: "remove the canary — all traffic back to version 2" });
  assert.match((rollbackTarget({ FunctionVersion: "1" }, versions) as { problem: string }).problem, /no published version older/);
  assert.match((rollbackTarget({ FunctionVersion: "$LATEST" }, versions) as { problem: string }).problem, /toVersion/);
});

test("deploy input: exactly one source, matching the package type, refused in plain words", () => {
  assert.deepEqual(deploySource({ zipBase64: "UEsDBA==" }, "Zip"), { kind: "zip" });
  assert.deepEqual(deploySource({ s3Bucket: "b", s3Key: "k.zip" }, "Zip"), { kind: "s3", bucket: "b", key: "k.zip", version: undefined });
  assert.deepEqual(deploySource({ imageUri: "1.dkr.ecr/x:1" }, "Image"), { kind: "image", uri: "1.dkr.ecr/x:1" });
  const problem = (i: Parameters<typeof deploySource>[0], type: string) => (deploySource(i, type) as { problem: string }).problem;
  assert.equal(problem({}, "Zip"), "Choose the new code: a .zip upload (zipBase64) or a .zip in S3 (s3Bucket + s3Key).");
  assert.equal(problem({}, "Image"), "Choose the new code: a container image (imageUri).");
  assert.equal(problem({ zipBase64: "x", imageUri: "y" }, "Zip"), "Choose one code source, not 2: a .zip upload (zipBase64) and a container image (imageUri).");
  assert.equal(problem({ zipBase64: "x" }, "Image"), "This function runs a container image: give the new image's ECR URI (imageUri), not a .zip upload (zipBase64).");
  assert.equal(problem({ imageUri: "y" }, "Zip"), "This function runs a .zip package: give a .zip upload (zipBase64) or a .zip in S3 (s3Bucket + s3Key), not an image.");
  assert.equal(problem({ s3Bucket: "b" }, "Zip"), "Give both the S3 bucket (s3Bucket) and the object key of the .zip (s3Key).");
  assert.match(problem({ zipBase64: "x", alias: "live" }, "Zip"), /“Publish a new version afterwards” \(publish\)/);
});

test("resource policy → triggers", () => {
  const policy = JSON.stringify({
    Statement: [
      { Effect: "Allow", Principal: { Service: "s3.amazonaws.com" }, Action: "lambda:InvokeFunction", Condition: { ArnLike: { "AWS:SourceArn": "arn:aws:s3:::uploads" } } },
      { Effect: "Allow", Principal: { Service: ["events.amazonaws.com"] }, Action: "lambda:InvokeFunction" },
      { Effect: "Deny", Principal: "*", Action: "lambda:InvokeFunction" },
    ],
  });
  assert.deepEqual(policyTriggers(policy), [{ principal: "s3.amazonaws.com", source: "arn:aws:s3:::uploads" }, { principal: "events.amazonaws.com", source: undefined }]);
  assert.deepEqual(policyTriggers("{bad"), []);
  assert.deepEqual(policyTriggers(undefined), []);
});
