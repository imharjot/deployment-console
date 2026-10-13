// The serverless providers (Lambda, SQS, SNS, EventBridge, Step Functions, Kinesis, DynamoDB, API Gateway), three ways:
// 1. The simulated estate, mapped by the same pure code real discovery uses: the edges the Acme story promises exist,
//    names line up with ./mock-names.ts (so other providers' edges land), nothing secret reaches a resource, and the
//    simulation answers like the real API (the Lambda list carries no deployment state — R12) in us-east-1 only.
// 2. The providers themselves against the simulation (a child process: they import "server-only", which only resolves
//    under the react-server condition): declarations (scope, kinds, covers, multi-region), per-action IAM equal to the
//    write list, human copy (summary, undo, verifies, field titles — F42/F06), list → checkpoint → enrich (R18), the
//    deployment-state cache, authoritative tag reads (R01), the default execution name (F31).
// 3. The providers against a fake AWS endpoint (AWS_ENDPOINT_URL, a local HTTP server in this process): R12 from the
//    real API shapes (a failed function only shows once its configuration is read, cached per version, environment
//    values never kept), R01 live tag reads (and refusals when they fail or take over 5 s), and F31 retries — the
//    writes that must not repeat are sent once, the others keep the SDK's retries.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import http from "node:http";
import http2 from "node:http2";
import { promisify } from "node:util";
import { apigwResult } from "../../inventory/serverless-apigw.ts";
import { dynamoResult, kinesisResult } from "../../inventory/serverless-data.ts";
import { deployStateOf, lambdaResult, type RawFunctionEx } from "../../inventory/serverless-lambda.ts";
import { eventsResult, snsResult, sqsResult } from "../../inventory/serverless-messaging.ts";
import { sfnResult } from "../../inventory/serverless-sfn.ts";
import { keys, type ProviderResult } from "../../inventory/types.ts";
import { PUBLIC_API_ACCESS_LOG, PUBLIC_DOMAIN_CERT, PUBLIC_DOMAIN_TARGET, simApigw } from "./mock/apigateway.ts";
import { simDynamo } from "./mock/dynamodb.ts";
import { simEvents } from "./mock/eventbridge.ts";
import { simKinesis } from "./mock/kinesis.ts";
import { simDestinations, simFunctionConfiguration, simListFunctions, simMappings, simReserved, simTags, simUrl } from "./mock/lambda.ts";
import { simSns } from "./mock/sns.ts";
import { simSqs } from "./mock/sqs.ts";
import { CHECKOUT_LOG_GROUP, simSfn } from "./mock/stepfunctions.ts";
import { ACCT, APIGW, COGNITO, DYNAMO, EU_REGION, EVENTS, EXISTING, IAM_ROLES, KINESIS, KMS_KEYS, LAMBDA, LOG_GROUPS, SFN, SNS, SQS } from "./mock-names.ts";

const run = promisify(execFile);

// What discovery assembles from the simulation's per-call answers when every read succeeds.
function simLambda(region?: string) {
  const functions: RawFunctionEx[] = simListFunctions(region).map((f) => ({
    ...f, ...deployStateOf(simFunctionConfiguration(f.FunctionArn!)), deployState: "ok", tags: simTags(f.FunctionArn!), url: simUrl(f.FunctionArn!),
    reserved: simReserved(f.FunctionArn!), destinations: simDestinations(f.FunctionArn!),
  }));
  return { functions, mappings: simMappings(region) };
}

const all: ProviderResult[] = [
  lambdaResult(simLambda(), Date.now()), sqsResult(simSqs()), snsResult(simSns()), eventsResult(simEvents()), sfnResult(simSfn()),
  kinesisResult(simKinesis()), dynamoResult(simDynamo()), apigwResult(simApigw()),
];
const resources = all.flatMap((r) => r.resources);
const links = all.flatMap((r) => r.links);
const mentions = all.flatMap((r) => r.mentions);
const byKey = new Map(resources.map((r) => [r.key, r]));
const has = (from: string, to: string, kind: string) => links.some((l) => l.from === from && l.to === to && l.kind === kind);
const http_ = `arn:aws:apigateway:us-east-1::/apis/${APIGW.publicHttp.id}`;
const rest = `arn:aws:apigateway:us-east-1::/restapis/${APIGW.partnersRest.id}`;

test("every shared name from mock-names.ts is a resource with that key", () => {
  for (const x of [...Object.values(LAMBDA), ...Object.values(SQS), ...Object.values(SNS), ...Object.values(DYNAMO), KINESIS.clickstream, SFN.checkout, EVENTS.shopBus, EVENTS.nightlyRule, EVENTS.orderPlacedRule]) {
    assert.ok(byKey.has(x.arn), `missing ${x.arn}`);
  }
  assert.ok(byKey.has(http_) && byKey.has(rest));
  assert.equal(byKey.get(EVENTS.defaultBus.arn)?.hidden, true, "the default bus: listed, not drawn");
  assert.equal(new Set(resources.map((r) => r.key)).size, resources.length, "keys are unique");
});

test("the Acme serverless story's edges", () => {
  assert.ok(has(SQS.orders.arn, LAMBDA.orderEvents.arn, "poll"), "orders queue → order-events");
  assert.ok(has(SQS.orders.arn, SQS.ordersDlq.arn, "event"), "orders → DLQ");
  assert.ok(has(SNS.notifications.arn, LAMBDA.emailSender.arn, "event"));
  assert.ok(has(SNS.notifications.arn, SQS.emails.arn, "event"));
  assert.ok(has(SNS.notifications.arn, "hooks.example.net", "event"));
  assert.ok(has(EVENTS.nightlyRule.arn, LAMBDA.nightlyReport.arn, "event"));
  assert.ok(has(EVENTS.shopBus.arn, EVENTS.orderPlacedRule.arn, "event"));
  assert.ok(has(EVENTS.orderPlacedRule.arn, SQS.orders.arn, "event"));
  assert.ok(has(EVENTS.orderPlacedRule.arn, SFN.checkout.arn, "event"));
  assert.ok(has(SFN.checkout.arn, LAMBDA.checkoutStep.arn, "invoke"));
  assert.ok(has(SFN.checkout.arn, SNS.notifications.arn, "writes"));
  assert.ok(has(http_, LAMBDA.apiHandler.arn, "invoke"));
  assert.ok(has(http_, keys.loadBalancer(EXISTING.alb.name), "route"));
  assert.ok(has(rest, LAMBDA.partnersStaging.arn, "invoke"));
  assert.ok(has(LAMBDA.emailSender.arn, SNS.alarms.arn, "event"));
});

test("support links (A.3): roles, KMS keys, log groups, the Cognito authorizer, the custom domain's certificate", () => {
  for (const f of Object.values(LAMBDA)) {
    assert.ok(has(f.arn, IAM_ROLES.lambda.arn, "assumes"), `${f.name} runs as the Lambda role`);
    assert.ok(has(f.arn, LOG_GROUPS.arn(LOG_GROUPS.lambda(f.name)), "logs"), `${f.name} logs to its default group`);
  }
  assert.ok(has(KMS_KEYS.app.arn, LAMBDA.apiHandler.arn, "encrypts"), "public-api's variables");
  assert.ok(has(KMS_KEYS.app.aliasArn, SQS.emails.arn, "encrypts"), "a bare alias becomes the alias ARN");
  assert.ok(has(KMS_KEYS.awsManaged.sqs, SQS.ordersStaging.arn, "encrypts"), "alias/aws/sqs → the region's AWS-managed key (CC-19)");
  assert.ok(has(KMS_KEYS.app.aliasArn, SNS.notifications.arn, "encrypts"));
  assert.ok(has(KMS_KEYS.app.aliasArn, KINESIS.clickstream.arn, "encrypts"));
  assert.ok(has(KMS_KEYS.app.arn, DYNAMO.carts.arn, "encrypts"));
  assert.ok(has(KMS_KEYS.app.arn, SFN.checkout.arn, "encrypts"));
  assert.ok(has(SFN.checkout.arn, `arn:aws:iam::${ACCT}:role/acme-production-checkout-sfn`, "assumes"));
  assert.ok(has(SFN.checkout.arn, LOG_GROUPS.arn(CHECKOUT_LOG_GROUP), "logs"));
  assert.ok(has(EVENTS.orderPlacedRule.arn, `arn:aws:iam::${ACCT}:role/acme-events-start-checkout`, "assumes"), "the role EventBridge assumes for the checkout target");
  assert.ok(has(http_, COGNITO.customers.arn, "uses"), "JWT authorizer on the customers pool");
  assert.ok(has(PUBLIC_DOMAIN_CERT.arn, http_, "tls"));
  assert.ok(has(http_, LOG_GROUPS.arn(PUBLIC_API_ACCESS_LOG), "logs"));
});

test("health, idle hints, endpoints and mentions", () => {
  assert.equal(byKey.get(SQS.ordersDlq.arn)?.health, "warning");
  const legacy = byKey.get(LAMBDA.legacyCleanup.arn)!;
  assert.match(legacy.healthReason ?? "", /nodejs18\.x is deprecated/);
  assert.ok(Date.now() - legacy.lastActivityAt! >= 89 * 86_400_000);
  assert.ok(Date.now() - byKey.get(SQS.exportsOld.arn)!.lastActivityAt! >= 60 * 86_400_000);
  assert.ok(byKey.get(http_)!.endpoints!.includes(PUBLIC_DOMAIN_TARGET), "Route 53's alias target for the custom domain");
  assert.ok(byKey.get(http_)!.endpoints!.includes(APIGW.publicHttp.customDomain));
  const env = mentions.filter((m) => m.from === LAMBDA.apiHandler.arn);
  assert.ok(env.some((m) => m.refs.includes(DYNAMO.sessions.name)), "public-api env names the sessions table");
  assert.ok(env.some((m) => m.refs.includes(SQS.orders.url)), "public-api env names the orders queue URL");
  assert.ok(resources.every((r) => r.tagsUnread === undefined), "the simulation reads every tag");
});

test("R12: the simulated list call leaves the deployment state out, like ListFunctions; the configuration read has it", () => {
  const listed = simListFunctions();
  assert.equal(listed.length, Object.keys(LAMBDA).length);
  for (const f of listed) for (const k of ["State", "StateReason", "LastUpdateStatus", "LastUpdateStatusReason"]) assert.ok(!(k in f), `${f.FunctionName}: ${k} in the list`);
  assert.deepEqual(deployStateOf(simFunctionConfiguration(LAMBDA.orderEvents.arn)), { State: "Active", LastUpdateStatus: "Successful" });
  // The bare list maps to unknown health — never ok; only what is certain without it (a deprecated runtime) shows.
  const bare = lambdaResult({ functions: listed, mappings: [] }, Date.now()).resources;
  assert.ok(bare.every((r) => r.health === "unknown" || (r.health === "warning" && /deprecated/.test(r.healthReason ?? ""))), JSON.stringify(bare.map((r) => r.health)));
  assert.equal(bare.filter((r) => r.health === "unknown").length, listed.length - 1);
});

test("multi-region: every serverless simulation is empty outside us-east-1", () => {
  const eu = [
    lambdaResult(simLambda(EU_REGION), Date.now()), sqsResult(simSqs(EU_REGION)), snsResult(simSns(EU_REGION)), eventsResult(simEvents(EU_REGION)),
    sfnResult(simSfn(EU_REGION)), kinesisResult(simKinesis(EU_REGION)), dynamoResult(simDynamo(EU_REGION)), apigwResult(simApigw(EU_REGION)),
  ];
  assert.deepEqual(eu.map((r) => r.resources.length + r.links.length + r.mentions.length), [0, 0, 0, 0, 0, 0, 0, 0]);
});

test("nothing secret on the map: env values, emails, phone numbers, webhook paths", () => {
  const shown = JSON.stringify({ resources, links });
  for (const bad of ["sim-only", "ops-team@", "oncall@", "dev@acme", "+15555550142", "token=", "/acme/notify"]) assert.ok(!shown.includes(bad), `leaked ${bad}`);
});

// ---------- 2. the providers against the simulation ----------

const providersUrl = JSON.stringify(new URL("./serverless.ts", import.meta.url).href);
const sfnUrl = JSON.stringify(new URL("../../inventory/serverless-sfn.ts", import.meta.url).href);

async function child<T>(script: string, env: Record<string, string>): Promise<T> {
  const base = { ...process.env };
  for (const k of ["NODE_TEST_CONTEXT", "AWS_PROFILE", "AWS_DEFAULT_PROFILE", "AWS_SESSION_TOKEN", "AWS_ENDPOINT_URL"]) delete base[k];
  const { stdout } = await run(process.execPath, ["--conditions=react-server", "--no-warnings", "--input-type=module", "-e", script], {
    encoding: "utf8", env: { ...base, CONSOLE_SQLITE_PATH: ":memory:", ...env }, timeout: 90_000, maxBuffer: 16 << 20,
  });
  return JSON.parse(stdout.trim().split("\n").pop()!) as T;
}

const mockScenario = `
const { providers } = await import(${providersUrl});
const { defaultExecutionName } = await import(${sfnUrl});
const ctxFor = (region, checkpoints = [], notes = []) => ({ region, accountId: "123456789012", mock: true, cap: 2000, signal: new AbortController().signal, limit: (fn) => fn(), note: (m) => notes.push(m), checkpoint: (r) => checkpoints.push(r) });
const by = Object.fromEntries(providers.map((p) => [p.id, p]));
const out = { decl: {}, us: {}, eu: {}, checkpoints: {}, auth: {}, after: {} };
const titles = (schema, path = "") => Object.entries(schema.properties ?? {}).flatMap(([k, s]) => [...(s.title ? [] : [path + k]), ...titles(s, path + k + ".")]);
for (const p of providers) {
  out.decl[p.id] = {
    scope: p.scope, multiRegionMock: p.multiRegionMock, kinds: p.kinds, covers: p.covers, write: p.write ?? [], authoritative: typeof p.authoritative === "function",
    actions: (p.actions ?? []).map((a) => ({ id: a.id, iam: a.iam ?? [], summary: a.summary, undo: a.undo, verifies: a.verifies, retrySafe: a.retrySafe, untitled: titles(a.input), input: a.input })),
    activity: null,
  };
  const checkpoints = [];
  out.us[p.id] = await p.discover(ctxFor("us-east-1", checkpoints));
  out.checkpoints[p.id] = checkpoints.map((c) => c.resources.map((r) => ({ key: r.key, health: r.health, healthReason: r.healthReason, tagsUnread: r.tagsUnread })));
  out.eu[p.id] = (await p.discover(ctxFor("eu-west-1"))).resources.length;
  const first = out.us[p.id].resources.find((r) => !r.hidden && r.kind !== "eventbridge-bus");
  if (first) out.decl[p.id].activity = p.activity?.(first) ?? null;
}
const res = (id, name) => out.us[id].resources.find((r) => r.name === name);
const actx = { region: "us-east-1", mock: true, actor: "op@example.com" };
for (const [id, name] of [["lambda", ${JSON.stringify(LAMBDA.apiHandler.name)}], ["sqs", ${JSON.stringify(SQS.orders.name)}], ["sns", ${JSON.stringify(SNS.notifications.name)}], ["eventbridge", ${JSON.stringify(EVENTS.orderPlacedRule.name)}], ["stepfunctions", ${JSON.stringify(SFN.checkout.name)}], ["apigateway", ${JSON.stringify(APIGW.partnersRest.name)}], ["kinesis", ${JSON.stringify(KINESIS.clickstream.name)}], ["dynamodb", ${JSON.stringify(DYNAMO.carts.name)}]]) {
  out.auth[id] =await by[id].authoritative(res(id, name), actx);
  out.auth[id + ":missing"] = await by[id].authoritative({ ...res(id, name), key: res(id, name).key + "-gone", name: name + "-gone" }, actx).then(() => "read", (e) => "threw");
}
const cache = globalThis.__consoleLambdaConfigs;
out.after.cache = { size: cache?.size ?? 0, json: JSON.stringify([...(cache ?? new Map())]) };
const machine = res("stepfunctions", ${JSON.stringify(SFN.checkout.name)});
const start = by.stepfunctions.actions.find((a) => a.id === "start-execution");
out.after.sfnPlan = await start.plan(machine, { input: "{}" }, actx);
out.after.sfnRun = await start.run(machine, { input: "{}" }, actx);
out.after.sfnExpected = defaultExecutionName(machine.key, "{}", actx.actor, Date.now());
out.after.sfnNamed = await start.run(machine, { input: "{}", name: "manual-1" }, actx);
const fn = res("lambda", ${JSON.stringify(LAMBDA.apiHandler.name)});
out.after.lambdaDetail = (await by.lambda.detail(fn, ctxFor("us-east-1"))).sections.map((s) => [s.title, (s.rows ?? []).map((r) => r.label)]);
const deploy = by.lambda.actions.find((a) => a.id === "deploy-code");
out.after.deployWrong = await deploy.plan(fn, { imageUri: "123456789012.dkr.ecr.us-east-1.amazonaws.com/acme/api:1" }, actx).then(() => "ok", (e) => e.message);
const invoke = by.lambda.actions.find((a) => a.id === "invoke");
out.after.invokeAudit = invoke.auditSummary({ function: "f", statusCode: 200, logTail: "secret log", response: "payload", executedVersion: "$LATEST" }, {});
console.log(JSON.stringify(out));
`;

interface Decl {
  scope: string; multiRegionMock: boolean; kinds: string[]; covers: string[]; write: string[]; authoritative: boolean;
  actions: { id: string; iam: string[]; summary?: string; undo?: string; verifies?: string; retrySafe?: boolean; untitled: string[]; input: { properties?: Record<string, { "x-group"?: string }>; "x-groups"?: { id: string; ifProp?: unknown; unlessProp?: unknown }[] } }[];
  activity: { metric: string; required?: boolean }[] | null;
}
interface R { key: string; name: string; health: string; healthReason?: string; tagsUnread?: boolean; enrichment?: Record<string, string>; props: { label: string; value: string }[]; hidden?: boolean }
interface MockOut {
  decl: Record<string, Decl>;
  us: Record<string, { resources: R[]; links: { from: string; to: string; kind: string }[] }>;
  eu: Record<string, number>;
  checkpoints: Record<string, { key: string; health: string; healthReason?: string; tagsUnread?: boolean }[][]>;
  auth: Record<string, { tags: Record<string, string> } | string>;
  after: Record<string, unknown> & { cache: { size: number; json: string } };
}

const mock = child<MockOut>(mockScenario, { CONSOLE_SOURCE: "mock" });

test("declarations: regional, multi-region mocks, kinds and Resource Explorer covers", async () => {
  const o = await mock;
  assert.deepEqual(Object.keys(o.decl), ["lambda", "sqs", "sns", "eventbridge", "stepfunctions", "kinesis", "dynamodb", "apigateway"]);
  for (const [id, d] of Object.entries(o.decl)) {
    assert.equal(d.scope, "regional", id);
    assert.equal(d.multiRegionMock, true, id);
    assert.ok(d.kinds.length && d.covers.length, id);
    // R01: every one reads its tags live — the providers with actions for their own changes, Kinesis and DynamoDB for a
    // change another provider makes to one of theirs (the runner falls back to the resource's own provider's read).
    assert.equal(d.authoritative, true, `${id}: an authoritative tag read (R01)`);
  }
  assert.deepEqual(o.decl.eventbridge.covers, ["events:event-bus", "events:rule"]);
  assert.deepEqual(o.decl.apigateway.covers, ["apigateway:restapis", "apigateway:apis"]);
});

test("F06 / F42: every action's iam, write = union of iam, summary, undo, verifies, titled fields", async () => {
  const o = await mock;
  for (const [id, d] of Object.entries(o.decl)) {
    const union = [...new Set(d.actions.flatMap((a) => a.iam))].sort();
    assert.deepEqual(union, [...d.write].sort(), `${id}: write must equal the union of its actions' iam`);
    for (const a of d.actions) {
      const what = `${id}.${a.id}`;
      assert.ok(a.iam.length, `${what}: iam`);
      for (const k of ["summary", "undo", "verifies"] as const) assert.ok((a[k] ?? "").length > 10, `${what}: ${k}`);
      assert.ok(/\.$/.test(a.summary!) && a.summary!.split(/\.\s/).length === 1, `${what}: one sentence`);
      assert.equal(typeof a.retrySafe, "boolean", `${what}: retrySafe decided`);
      assert.deepEqual(a.untitled, [], `${what}: fields without a title`);
    }
  }
  const purge = o.decl.sqs.actions.find((a) => a.id === "purge")!;
  assert.equal(purge.undo, "Irreversible — messages are deleted");
  const deploy = o.decl.lambda.actions.find((a) => a.id === "deploy-code")!;
  assert.match(deploy.undo!, /previous version to the alias/);
  assert.match(deploy.verifies!, /LastUpdateStatus Successful/);
  const groups = Object.fromEntries(Object.entries(deploy.input.properties ?? {}).map(([k, s]) => [k, s["x-group"]]));
  assert.deepEqual(groups, { zipBase64: "zip", s3Bucket: "s3", s3Key: "s3", s3ObjectVersion: "s3", imageUri: "image", publish: undefined, alias: undefined, description: undefined });
  assert.deepEqual(deploy.input["x-groups"]?.map((g) => [g.id, !!g.ifProp, !!g.unlessProp]), [["zip", false, true], ["s3", false, true], ["image", true, false]], "image only for image functions");
  // F31: the writes that must not repeat are never retry-safe.
  // A purge repeated after an unknown outcome would also delete the messages sent since: not retry-safe either.
  for (const [p, a] of [["lambda", "invoke"], ["sns", "publish-test"], ["sqs", "send-test-message"], ["sqs", "purge"], ["stepfunctions", "start-execution"]])
    assert.equal(o.decl[p].actions.find((x) => x.id === a)?.retrySafe, false, `${p}.${a}`);
});

test("activity: the primary series is required (R20)", async () => {
  const o = await mock;
  for (const [id, d] of Object.entries(o.decl)) assert.ok(d.activity?.[0]?.required === true, `${id}: ${JSON.stringify(d.activity)}`);
  assert.deepEqual(o.decl.lambda.activity?.map((a) => [a.metric, a.required ?? false]), [["Invocations", true], ["Errors", false]]);
});

test("R18: Lambda hands its bare list to the checkpoint (unknown health, tags unread), then enriches; eu-west-1 is empty", async () => {
  const o = await mock;
  const [cp] = o.checkpoints.lambda;
  assert.equal(cp.length, Object.keys(LAMBDA).length);
  assert.ok(cp.every((r) => r.health !== "ok" && r.tagsUnread === true), JSON.stringify(cp));
  assert.equal(cp.filter((r) => r.health === "unknown" && r.healthReason === "deployment state not read (skipped)").length, cp.length - 1, "all but the deprecated-runtime warning");
  for (const id of ["sqs", "sns", "eventbridge", "stepfunctions", "kinesis", "dynamodb", "apigateway"]) assert.equal(o.checkpoints[id].length, 0, `${id}: the simulation answers at once`);
  const fns = o.us.lambda.resources;
  assert.ok(fns.every((r) => r.health !== "unknown" && r.tagsUnread === undefined), "every state and tag read");
  assert.deepEqual(fns[0].enrichment, { state: "ok", tags: "ok", url: "ok", concurrency: "ok", destinations: "ok" });
  assert.equal(fns.find((r) => r.name === LAMBDA.orderEvents.name)?.props.find((p) => p.label === "Deployment state")?.value, "Active · last update successful");
  assert.deepEqual(Object.values(o.eu), [0, 0, 0, 0, 0, 0, 0, 0]);
});

test("R12: the deployment-state cache holds no environment value", async () => {
  const o = await mock;
  assert.ok(o.after.cache.size >= Object.keys(LAMBDA).length);
  assert.ok(!o.after.cache.json.includes("sim-only") && !o.after.cache.json.includes("Variables"), "no environment in the cache");
});

test("R01: authoritative tag reads return the live tags and throw for what isn't there", async () => {
  const o = await mock;
  for (const id of ["lambda", "sqs", "sns", "eventbridge", "stepfunctions", "apigateway", "kinesis", "dynamodb"]) {
    assert.ok(typeof o.auth[id] === "object" && Object.keys((o.auth[id] as { tags: object }).tags).length, `${id}: ${JSON.stringify(o.auth[id])}`);
    assert.equal(o.auth[`${id}:missing`], "threw", id);
  }
  assert.equal((o.auth.lambda as { tags: Record<string, string> }).tags.Environment, "production");
});

test("F31: start-execution names the execution in the plan and starts exactly that one; panels and copy", async () => {
  const o = await mock;
  const plan = o.after.sfnPlan as { changes: string[] };
  const run = o.after.sfnRun as { executionName: string; executionArn: string };
  assert.equal(run.executionName, o.after.sfnExpected);
  assert.ok(plan.changes[0].startsWith(`execution name: ${run.executionName} (default`), plan.changes[0]);
  assert.ok(run.executionArn.endsWith(`:${run.executionName}`));
  assert.equal((o.after.sfnNamed as { executionName: string }).executionName, "manual-1");
  const status = (o.after.lambdaDetail as [string, string[]][])[0];
  assert.deepEqual(status, ["Status", ["Exists", "Deployment state", "Runtime health (last 3 hours)"]]);
  assert.equal(o.after.deployWrong, "This function runs a .zip package: give a .zip upload (zipBase64) or a .zip in S3 (s3Bucket + s3Key), not an image.");
  assert.deepEqual(o.after.invokeAudit, { function: "f", statusCode: 200, executedVersion: "$LATEST" }, "never the log or the payload");
});

// ---------- 3. the providers against a fake AWS endpoint ----------

const SENTINEL = "SECRET-SENTINEL-env-9d2f";
const A = (svc: string, rest: string) => `arn:aws:${svc}:us-east-1:123456789012:${rest}`;

interface Hit { method: string; path: string; target?: string; action?: string; body: string }

// A tiny AWS: just the calls these scenarios make, in each service's wire protocol. Served over HTTP/1.1, and over
// cleartext HTTP/2 for Kinesis (its client speaks only HTTP/2).
function fakeAws(hits: Hit[]) {
  const tagsJson = { Environment: "production" };
  return (req: http.IncomingMessage, res: http.ServerResponse) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const path = decodeURIComponent((req.url ?? "").split("?")[0]).replace(/(.)\/$/, "$1");
      const target = req.headers["x-amz-target"] as string | undefined;
      const action = !target && body.includes("Action=") ? new URLSearchParams(body).get("Action") ?? undefined : undefined;
      hits.push({ method: req.method ?? "", path, target, action, body });
      const send = (status: number, payload: unknown, type = "application/json", headers: Record<string, string> = {}) => {
        res.writeHead(status, { "content-type": type, ...headers });
        res.end(typeof payload === "string" ? payload : JSON.stringify(payload));
      };
      const jsonError = (status: number, type: string) => send(status, { __type: type, message: type === "AccessDeniedException" ? "User: test is not authorized to perform: x:Y" : "boom" }, "application/x-amz-json-1.0", { "x-amzn-ErrorType": type });
      const restError = (status: number, type: string) => send(status, { message: type === "AccessDeniedException" ? "User: test is not authorized to perform: lambda:ListTags" : "boom" }, "application/json", { "x-amzn-ErrorType": type });
      // JSON protocols: SQS, Step Functions, EventBridge.
      if (target) {
        const op = target.split(".")[1];
        const b = JSON.parse(body || "{}") as Record<string, string>;
        if (op === "GetQueueAttributes") return send(200, { Attributes: { QueueArn: A("sqs", b.QueueUrl.split("/").pop()!), ...(b.QueueUrl.endsWith(".fifo") ? { FifoQueue: "true", ContentBasedDeduplication: "false" } : {}) } });
        if (op === "ListQueueTags") return send(200, { Tags: tagsJson });
        if (op === "SendMessage") return jsonError(500, "InternalError");
        if (op === "DescribeStateMachine") return send(200, { stateMachineArn: b.stateMachineArn, name: b.stateMachineArn.split(":").pop(), type: b.stateMachineArn.includes("express") ? "EXPRESS" : "STANDARD", status: "ACTIVE", definition: "{}", roleArn: "arn:aws:iam::123456789012:role/sfn", creationDate: 1_700_000_000 });
        if (op === "StartExecution") return jsonError(500, "InternalError");
        // DynamoDB and Kinesis page tags: the protection tag is on the second page.
        if (op === "ListTables") return send(200, { TableNames: ["paged"] });
        if (op === "DescribeTable") return send(200, { Table: { TableName: b.TableName, TableArn: A("dynamodb", `table/${b.TableName}`), TableStatus: "ACTIVE" } });
        if (op === "ListTagsOfResource") return send(200, b.NextToken ? { Tags: [{ Key: "console:protected", Value: "true" }] } : { Tags: [{ Key: "Environment", Value: "production" }], NextToken: "page-2" });
        if (op === "ListTagsForStream") return send(200, b.ExclusiveStartTagKey ? { Tags: [{ Key: "console:protected", Value: "true" }], HasMoreTags: false } : { Tags: [{ Key: "Environment", Value: "production" }], HasMoreTags: true });
        if (op === "ListTagsForResource" && target.startsWith("AWSStepFunctions")) return send(200, { tags: [{ key: "Environment", value: "production" }] });
        if (op === "ListTagsForResource") return send(200, { Tags: [{ Key: "Environment", Value: "production" }] });
        return jsonError(400, "UnknownOperationException");
      }
      // Query protocol: SNS.
      if (action === "Publish") return send(500, `<ErrorResponse><Error><Type>Receiver</Type><Code>InternalError</Code><Message>boom</Message></Error><RequestId>r</RequestId></ErrorResponse>`, "text/xml");
      if (action === "ListTagsForResource")
        return send(200, `<ListTagsForResourceResponse xmlns="http://sns.amazonaws.com/doc/2010-03-31/"><ListTagsForResourceResult><Tags><member><Key>Environment</Key><Value>production</Value></member></Tags></ListTagsForResourceResult><ResponseMetadata><RequestId>r</RequestId></ResponseMetadata></ListTagsForResourceResponse>`, "text/xml");
      // REST: Lambda, API Gateway.
      const fn = /\/functions\/([^/]+)\//.exec(path)?.[1] ?? "";
      if (path === "/2015-03-31/functions")
        return send(200, { Functions: [{ FunctionName: "pay", FunctionArn: A("lambda", "function:pay"), Runtime: "nodejs22.x", Role: "arn:aws:iam::123456789012:role/pay", LastModified: "2026-10-01T10:00:00.000+0000", CodeSha256: "abc=", Environment: { Variables: { TOKEN: SENTINEL } } }] });
      if (path === "/2015-03-31/event-source-mappings") return send(200, { EventSourceMappings: [] });
      if (path.endsWith("/configuration")) {
        const failed = fn.includes("pay");
        return send(200, {
          FunctionName: fn.split(":").pop(), FunctionArn: fn.startsWith("arn:") ? fn : A("lambda", `function:${fn}`), Runtime: "nodejs22.x", LastModified: "2026-10-01T10:00:00.000+0000", CodeSha256: "abc=",
          Environment: { Variables: { TOKEN: SENTINEL } }, State: failed ? "Failed" : "Active", StateReason: failed ? "The function's subnets have no free IP addresses" : undefined, LastUpdateStatus: "Successful",
        });
      }
      if (path.startsWith("/2017-03-31/tags/")) {
        if (path.includes(":function:pay")) return restError(403, "AccessDeniedException");
        if (path.includes(":function:broken")) return restError(500, "ServiceException");
        if (path.includes(":function:slow")) return; // never answers: the 5 s limit must end the read
        return send(200, { Tags: tagsJson });
      }
      if (path.endsWith("/urls")) return send(200, { FunctionUrlConfigs: [] });
      if (path.endsWith("/concurrency")) return send(200, {});
      if (path.endsWith("/event-invoke-config/list")) return send(200, { FunctionEventInvokeConfigs: [] });
      if (path.endsWith("/invocations") || path.endsWith("/versions")) return restError(500, "ServiceException");
      if (path.startsWith("/tags/") || path.startsWith("/v2/tags/")) return send(200, { tags: tagsJson });
      if (process.env.FAKE_AWS_DEBUG) console.error("fake AWS: no route for", req.method, path, target ?? action ?? "");
      return restError(404, "ResourceNotFoundException");
    });
  };
}

const awsScenario = `
const { providers } = await import(${providersUrl});
const { defaultExecutionName } = await import(${sfnUrl});
const by = Object.fromEntries(providers.map((p) => [p.id, p]));
const notes = [], checkpoints = [];
const ctx = { region: "us-east-1", accountId: "123456789012", mock: false, cap: 2000, signal: new AbortController().signal, limit: (fn) => fn(), note: (m) => notes.push(m), checkpoint: (r) => checkpoints.push(r) };
const actx = { region: "us-east-1", mock: false, actor: "op@example.com" };
const out = {};
const first = await by.lambda.discover(ctx);
const second = await by.lambda.discover(ctx);
out.discover = { first, second: second.resources.map((r) => r.health), notes, checkpoint: checkpoints[0]?.resources.map((r) => [r.health, r.healthReason, r.tagsUnread]) };
out.cache = JSON.stringify([...(globalThis.__consoleLambdaConfigs ?? new Map())]);
const settle = (p) => p.then((v) => ({ ok: v }), (e) => ({ error: e.name ?? String(e), message: e.message }));
const A = (svc, rest) => "arn:aws:" + svc + ":us-east-1:123456789012:" + rest;
const r = (key, name, extra = {}) => ({ key, name, kind: "x", provider: "x", region: "us-east-1", tags: {}, health: "ok", props: [], ...extra });
// SQS sends each call to its queue URL's host: the queues live on the fake endpoint.
const queue = (name) => r(A("sqs", name), name, { aliases: [process.env.AWS_ENDPOINT_URL + "/123456789012/" + name] });
out.auth = {
  lambda: await settle(by.lambda.authoritative(r(A("lambda", "function:tagged"), "tagged"), actx)),
  lambdaDenied: await settle(by.lambda.authoritative(r(A("lambda", "function:pay"), "pay"), actx)),
  lambdaFailing: await settle(by.lambda.authoritative(r(A("lambda", "function:broken"), "broken"), actx)),
  sqs: await settle(by.sqs.authoritative(queue("orders"), actx)),
  sns: await settle(by.sns.authoritative(r(A("sns", "alerts"), "alerts"), actx)),
  eventbridge: await settle(by.eventbridge.authoritative(r(A("events", "rule/nightly"), "nightly"), actx)),
  stepfunctions: await settle(by.stepfunctions.authoritative(r(A("states", "stateMachine:checkout"), "checkout"), actx)),
  apigatewayRest: await settle(by.apigateway.authoritative(r("arn:aws:apigateway:us-east-1::/restapis/r1", "partners"), actx)),
  apigatewayHttp: await settle(by.apigateway.authoritative(r("arn:aws:apigateway:us-east-1::/apis/a1", "public"), actx)),
  kinesis: await settle(by.kinesis.authoritative(r(A("kinesis", "stream/clicks"), "clicks"), actx)),
  dynamodb: await settle(by.dynamodb.authoritative(r(A("dynamodb", "table/paged"), "paged"), actx)),
};
out.dynamo = (await by.dynamodb.discover(ctx)).resources.map((x) => ({ key: x.key, tags: x.tags, tagsUnread: x.tagsUnread }));
const t0 = Date.now();
out.auth.slow = await settle(by.lambda.authoritative(r(A("lambda", "function:slow"), "slow"), actx));
out.auth.slowMs = Date.now() - t0;
const act = (p, id) => by[p].actions.find((a) => a.id === id);
out.writes = {
  invoke: await settle(act("lambda", "invoke").run(r(A("lambda", "function:inv"), "inv"), { payload: "{}" }, actx)),
  publishVersion: await settle(act("lambda", "publish-version").run(r(A("lambda", "function:pub"), "pub"), {}, actx)),
  snsPublish: await settle(act("sns", "publish-test").run(r(A("sns", "alerts"), "alerts"), { message: "hi" }, actx)),
  sqsStandard: await settle(act("sqs", "send-test-message").run(queue("std"), { body: "hi" }, actx)),
  sqsFifoDedup: await settle(act("sqs", "send-test-message").run(queue("jobs.fifo"), { body: "hi", groupId: "g", deduplicationId: "d-1" }, actx)),
  sfnExpress: await settle(act("stepfunctions", "start-execution").run(r(A("states", "stateMachine:express-sm"), "express-sm"), {}, actx)),
  sfnStandard: await settle(act("stepfunctions", "start-execution").run(r(A("states", "stateMachine:standard-sm"), "standard-sm"), {}, actx)),
};
out.expectedName = defaultExecutionName(A("states", "stateMachine:standard-sm"), "{}", actx.actor, Date.now());
console.log(JSON.stringify(out));
`;

interface AwsOut {
  discover: { first: { resources: R[]; links: { from: string; to: string; kind: string }[] }; second: string[]; notes: string[]; checkpoint: [string, string, boolean][] };
  cache: string;
  auth: Record<string, { ok?: { tags: Record<string, string> }; error?: string; message?: string }> & { slowMs: number };
  writes: Record<string, { ok?: unknown; error?: string; message?: string }>;
  expectedName: string;
  dynamo: { key: string; tags: Record<string, string>; tagsUnread?: boolean }[];
}

const aws = (async () => {
  const hits: Hit[] = [];
  const handle = fakeAws(hits);
  const server = http.createServer(handle);
  const h2 = http2.createServer((req, res) => handle(req as unknown as http.IncomingMessage, res as unknown as http.ServerResponse));
  await Promise.all([server, h2].map((x) => new Promise<void>((done) => x.listen(0, "127.0.0.1", done))));
  try {
    const port = (x: { address(): unknown }) => (x.address() as { port: number }).port;
    const out = await child<AwsOut>(awsScenario, {
      CONSOLE_SOURCE: "aws", AWS_ENDPOINT_URL: `http://127.0.0.1:${port(server)}`, AWS_ENDPOINT_URL_KINESIS: `http://127.0.0.1:${port(h2)}`, AWS_REGION: "us-east-1",
      AWS_ACCESS_KEY_ID: "AKIDFAKETEST", AWS_SECRET_ACCESS_KEY: "fake-test-secret", AWS_EC2_METADATA_DISABLED: "true",
    });
    return { out, hits };
  } finally {
    server.closeAllConnections();
    server.close();
    h2.close();
  }
})();

const count = (hits: Hit[], f: (h: Hit) => boolean) => hits.filter(f).length;

test("R12 on the real API shapes: a failed function shows as failed only from its configuration read, cached per version", async () => {
  const { out, hits } = await aws;
  // The checkpoint (the list alone) never says healthy.
  assert.deepEqual(out.discover.checkpoint, [["unknown", "deployment state not read (skipped)", true]]);
  const [fn] = out.discover.first.resources;
  assert.deepEqual([fn.health, fn.healthReason], ["error", "function failed: The function's subnets have no free IP addresses"]);
  assert.equal(fn.props.find((p) => p.label === "Deployment state")?.value, "Failed · last update successful");
  assert.deepEqual(out.discover.second, ["error"], "the second build serves the cached state");
  assert.equal(count(hits, (h) => h.path.endsWith(":function:pay/configuration")), 1, "GetFunctionConfiguration once: the version didn't change");
  assert.equal(count(hits, (h) => /^\/2015-03-31\/functions\/[^/]+$/.test(h.path) && h.method === "GET"), 0, "GetFunction is never called (presigned code URL)");
  assert.ok(!JSON.stringify(out.discover.first.resources).includes(SENTINEL) && !JSON.stringify(out.discover.first.links).includes(SENTINEL), "values stay in mentions");
  assert.ok(!out.cache.includes(SENTINEL) && out.cache.includes("Failed"), "the cache keeps the state, never the environment");
  // R01: the ListTags denial leaves the tags unread (protection fails closed), with one note.
  assert.deepEqual([fn.tagsUnread, fn.enrichment?.tags, fn.enrichment?.state], [true, "denied", "ok"]);
  assert.ok(out.discover.notes.some((n) => n === "lambda tags skipped: lambda:ListTags denied"), out.discover.notes.join(" | "));
  assert.ok(out.discover.first.links.some((l) => l.kind === "assumes" && l.to === "arn:aws:iam::123456789012:role/pay"));
});

test("R01 on the real API shapes: live tag reads per service; a denied, failing or slow read throws", async () => {
  const { out } = await aws;
  for (const id of ["lambda", "sqs", "sns", "eventbridge", "stepfunctions", "apigatewayRest", "apigatewayHttp"]) assert.deepEqual(out.auth[id].ok, { tags: { Environment: "production" } }, `${id}: ${JSON.stringify(out.auth[id])}`);
  assert.equal(out.auth.lambdaDenied.error, "AccessDeniedException");
  assert.equal(out.auth.lambdaFailing.error, "ServiceException");
  // Paged tag reads (DynamoDB, Kinesis): every page, so a protection tag on page two is never missed.
  const both = { Environment: "production", "console:protected": "true" };
  assert.deepEqual(out.auth.kinesis.ok, { tags: both }, JSON.stringify(out.auth.kinesis));
  assert.deepEqual(out.auth.dynamodb.ok, { tags: both }, JSON.stringify(out.auth.dynamodb));
  assert.deepEqual(out.dynamo, [{ key: "arn:aws:dynamodb:us-east-1:123456789012:table/paged", tags: both }], "discovery reads every page of a table's tags too");
  assert.ok(out.auth.slow.error, "a read that never answers is refused");
  assert.ok(out.auth.slowMs >= 4_500 && out.auth.slowMs < 9_000, `ended by the 5 s limit (${out.auth.slowMs} ms)`);
});

test("F31: invoke, publish, standard / non-deduplicated sends and EXPRESS starts go out once; the rest keep the SDK's retries", async () => {
  const { out, hits } = await aws;
  for (const [k, v] of Object.entries(out.writes)) assert.ok(v.error, `${k} failed against the fake endpoint: ${JSON.stringify(v)}`);
  assert.equal(count(hits, (h) => h.path.endsWith("/functions/inv/invocations")), 1, "Lambda Invoke (RequestResponse): once");
  assert.equal(count(hits, (h) => h.path.endsWith("/functions/pub/versions")), 3, "PublishVersion (unchanged code returns the same version): retried");
  assert.equal(count(hits, (h) => h.action === "Publish"), 1, "SNS Publish: once");
  assert.equal(count(hits, (h) => h.target === "AmazonSQS.SendMessage" && h.body.includes("/std")), 1, "SQS standard queue: once");
  assert.equal(count(hits, (h) => h.target === "AmazonSQS.SendMessage" && h.body.includes("jobs.fifo")), 3, "FIFO with a deduplication id: SQS drops duplicates, retried");
  const starts = hits.filter((h) => h.target === "AWSStepFunctions.StartExecution");
  assert.equal(starts.filter((h) => h.body.includes("express-sm")).length, 1, "EXPRESS: once");
  const standard = starts.filter((h) => h.body.includes("standard-sm")).map((h) => (JSON.parse(h.body) as { name: string }).name);
  assert.equal(standard.length, 3, "STANDARD: retried, under one name");
  assert.deepEqual([...new Set(standard)], [out.expectedName], "the default name from the plan, so a retry can't start a second execution");
});
