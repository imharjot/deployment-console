import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  actionsFor, ALL_WRITE_ACTIONS, combine, combineTargets, CONSOLE_WRITES, decide, denialIsFinal, ECS_WRITE_ACTIONS, OBSERVED_TTL_MS, RESOURCE_TYPED_ACTIONS, roleArnFromCaller,
  SERVICE_SCOPED_ACTIONS, simulationFailureNote, simulationTargets, TASK_DEFINITION_ACTIONS,
} from "./capability-rules.ts";

const NOW = 1_800_000_000_000;

test("CONSOLE_WRITES maps every console write to the IAM actions it needs", () => {
  for (const a of ["ecs.restart", "ecs.stop", "ecs.start", "ecs.switch", "ecs.scale"]) assert.deepEqual(CONSOLE_WRITES[a], ["ecs:UpdateService"]);
  assert.deepEqual(CONSOLE_WRITES["provision.service"], ["ecs:CreateService", "ecs:RegisterTaskDefinition", "iam:PassRole"]);
  assert.deepEqual(CONSOLE_WRITES["provision.create"], ["ec2:CreateSecurityGroup", "ec2:CreateTags", "ecs:RegisterTaskDefinition", "ecs:CreateService", "iam:PassRole"]);
  assert.deepEqual(CONSOLE_WRITES["provision.delete"], ["ecs:DeleteService", "ec2:DeleteSecurityGroup", "ec2:TerminateInstances"]);
  assert.deepEqual(actionsFor("vars.edit", ["ssm", "s3"]), ["ecs:RegisterTaskDefinition", "ecs:UpdateService", "ssm:PutParameter", "s3:PutObject"]);
  assert.deepEqual(actionsFor("vars.edit"), ["ecs:RegisterTaskDefinition", "ecs:UpdateService"]);
  assert.deepEqual(actionsFor("vars.reveal", ["secretsmanager"]), ["secretsmanager:GetSecretValue"]);
  assert.deepEqual(actionsFor("toString"), [], "own properties only");
  assert.ok(ALL_WRITE_ACTIONS.includes("secretsmanager:PutSecretValue"));
  assert.equal(new Set(ALL_WRITE_ACTIONS).size, ALL_WRITE_ACTIONS.length);
  assert.deepEqual(ECS_WRITE_ACTIONS, ["ecs:CreateService", "ecs:DeleteService", "ecs:RegisterTaskDefinition", "ecs:RunTask", "ecs:UpdateService"]);
});

test("roleArnFromCaller: an assumed-role session becomes its role; users and roles are unchanged", () => {
  assert.equal(roleArnFromCaller("arn:aws:sts::123456789012:assumed-role/acme-console/i-0abc"), "arn:aws:iam::123456789012:role/acme-console");
  assert.equal(roleArnFromCaller("arn:aws-us-gov:sts::123456789012:assumed-role/acme-console/s"), "arn:aws-us-gov:iam::123456789012:role/acme-console");
  assert.equal(roleArnFromCaller("arn:aws:iam::123456789012:user/acme-local"), "arn:aws:iam::123456789012:user/acme-local");
  assert.equal(roleArnFromCaller("arn:aws:iam::123456789012:role/acme-console"), "arn:aws:iam::123456789012:role/acme-console");
});

test("simulationFailureNote: a role under a path (NoSuchEntity) is explained; anything else keeps its error", () => {
  assert.match(simulationFailureNote({ name: "NoSuchEntityException", message: "The role with name acme-console cannot be found." }, "x"), /IAM path/);
  assert.match(simulationFailureNote({ name: "Error", message: "NoSuchEntity: role not found" }, "x"), /IAM path/);
  assert.equal(simulationFailureNote({ name: "ThrottlingException" }, "Rate exceeded"), "not verified: Rate exceeded");
  assert.equal(simulationFailureNote(undefined, "boom"), "not verified: boom");
});

test("decide: observed deny within TTL, explicit deny → denied; implicit → probably-denied; allowed; else unknown", () => {
  assert.equal(decide({ deniedAt: NOW - 60_000 }, NOW), "denied");
  assert.equal(decide({ deniedAt: NOW - OBSERVED_TTL_MS - 1, simulated: "allowed" }, NOW), "allowed", "an old refusal expires");
  assert.equal(decide({ deniedAt: NOW - OBSERVED_TTL_MS - 1 }, NOW), "unknown");
  assert.equal(decide({ simulated: "explicitDeny" }, NOW), "denied");
  assert.equal(decide({ simulated: "implicitDeny" }, NOW), "probably-denied");
  assert.equal(decide({ simulated: "allowed" }, NOW), "allowed");
  assert.equal(decide({}, NOW), "unknown");
  assert.equal(decide(undefined, NOW), "unknown");
  // A success after the refusal clears it; a real success outranks a simulated implicit deny, not an explicit one.
  assert.equal(decide({ deniedAt: NOW - 60_000, allowedAt: NOW - 1_000 }, NOW), "allowed");
  assert.equal(decide({ deniedAt: NOW - 1_000, allowedAt: NOW - 60_000 }, NOW), "denied");
  assert.equal(decide({ simulated: "implicitDeny", allowedAt: NOW - 1_000 }, NOW), "allowed");
  assert.equal(decide({ simulated: "explicitDeny", allowedAt: NOW - 1_000 }, NOW), "denied");
});

test("decide: an implicit deny against a real resource without missing context is a denial; a real success still wins", () => {
  assert.equal(decide({ simulated: "resourceDeny" }, NOW), "denied");
  assert.equal(decide({ simulated: "resourceDeny", allowedAt: NOW - 1_000 }, NOW), "allowed");
});

test("simulationTargets: per cluster, the first service that isn't the console's own, for the service-scoped actions", () => {
  const prod = { cluster: "acme-production", clusterArn: "arn:aws:ecs:eu-west-1:123456789012:cluster/acme-production", services: [
    { name: "deployment-console", family: "acme-console", taskDefinitionArn: "arn:aws:ecs:eu-west-1:123456789012:task-definition/acme-console:3" },
    { name: "api", family: "acme-api", taskDefinitionArn: "arn:aws:ecs:eu-west-1:123456789012:task-definition/acme-api:41" },
  ] };
  const staging = { cluster: "acme-staging", clusterArn: "arn:aws:ecs:eu-west-1:123456789012:cluster/acme-staging", services: [{ name: "web" }] };
  const prodApi = "arn:aws:ecs:eu-west-1:123456789012:service/acme-production/api";
  const stagingWeb = "arn:aws:ecs:eu-west-1:123456789012:service/acme-staging/web";
  assert.deepEqual(simulationTargets([prod, staging], { cluster: "acme-production", family: "acme-console" }), {
    ...Object.fromEntries(SERVICE_SCOPED_ACTIONS.map((a) => [a, [prodApi, stagingWeb]])),
    ...Object.fromEntries(TASK_DEFINITION_ACTIONS.map((a) => [a, ["arn:aws:ecs:eu-west-1:123456789012:task-definition/acme-api:41"]])),
  }, "one service per cluster; staging's web has no task definition ARN, so no RunTask or RegisterTaskDefinition target there");
  assert.deepEqual(simulationTargets([prod])["ecs:UpdateService"], ["arn:aws:ecs:eu-west-1:123456789012:service/acme-production/deployment-console"], "not on ECS: no service is the console");
  assert.deepEqual(simulationTargets([{ cluster: "", services: [{ name: "web" }] }]), {}, "a compose environment has no cluster ARN");
  assert.deepEqual(simulationTargets([{ ...prod, services: [prod.services[0]] }], { cluster: "acme-production", family: "acme-console" }), {}, "only the console itself: simulate against *");
});

test("simulationTargets: other writes, against the first resource of their type in each environment and region of the inventory", () => {
  const A = "123456789012";
  const ec2 = (id: string, env?: string, tags: Record<string, string> = {}) => ({ key: `ec2:${id}`, aliases: [id, `arn:aws:ec2:eu-west-1:${A}:instance/${id}`], region: "eu-west-1", env, tags });
  const rds = (id: string, env: string, more = {}) => ({ key: `rds:${id}`, aliases: [`arn:aws:rds:eu-west-1:${A}:db:${id}`, `aurora:${id}`], region: "eu-west-1", env, tags: {}, ...more });
  const fn = (name: string, region: string, more: { account?: string; source?: "reference" } = {}) => ({ key: `arn:aws:lambda:${region}:${more.account ?? A}:function:${name}`, region, env: "production", tags: {}, ...more });
  // In key order, which decides the sample: the console's host (tagged), the CONSOLE_SELF_INSTANCE box, two in production…
  const [CONSOLE, BOX, PROD_A, PROD_B, STAGE, LOOSE] = [0, 1, 2, 3, 4, 5].map((n) => `i-0123456789abcdef${n}`);
  const rows = [
    ec2(PROD_B, "production"), ec2(PROD_A, "production"), ec2(STAGE, "staging"), ec2(LOOSE),
    ec2(CONSOLE, "production", { "console:self": "true" }),
    ec2(BOX),
    rds("acme-staging-pg", "staging"), rds("acme-production-pg", "production"), rds("acme-old", "production", { tagsUnread: true }),
    fn("acme-orders", "eu-west-1"), fn("acme-orders", "us-east-1"), fn("acme-partner", "eu-central-1", { account: "111122223333" }),
    fn("acme-ref", "us-west-2", { source: "reference" }),
    { key: `arn:aws:cloudfront::${A}:distribution/EDFDVBD632BHDS5`, region: "global", env: "production", tags: {} },
    { key: "ecs:service/acme-production/api", aliases: [`arn:aws:ecs:eu-west-1:${A}:task-definition/acme-api`], region: "eu-west-1", env: "production", tags: {} },
    ...["a", "b", "c", "d", "e", "f"].map((env) => ({ key: `arn:aws:sqs:eu-west-1:${A}:acme-jobs-${env}`, region: "eu-west-1", env, tags: {} })),
  ];
  const t = simulationTargets([], undefined, rows, BOX);
  const instance = (id: string) => `arn:aws:ec2:eu-west-1:${A}:instance/${id}`;
  for (const a of ["ec2:StartInstances", "ec2:StopInstances", "ec2:RebootInstances", "ec2:TerminateInstances"]) {
    assert.deepEqual(t[a], [instance(PROD_A), instance(STAGE), instance(LOOSE)], `${a}: one per environment (and the unassigned), never the console's own host`);
  }
  assert.deepEqual(t["rds:StopDBInstance"], [`arn:aws:rds:eu-west-1:${A}:db:acme-production-pg`, `arn:aws:rds:eu-west-1:${A}:db:acme-staging-pg`], "the console key's ARN alias; unread tags are skipped");
  assert.deepEqual(t["lambda:InvokeFunction"], [`arn:aws:lambda:eu-west-1:${A}:function:acme-orders`, `arn:aws:lambda:us-east-1:${A}:function:acme-orders`], "one per region too; never another account's, nor a reference");
  assert.deepEqual(t["cloudfront:CreateInvalidation"], [`arn:aws:cloudfront::${A}:distribution/EDFDVBD632BHDS5`]);
  assert.equal(t["sqs:SendMessage"], undefined, "found in more places than are sampled: against *");
  assert.equal(t["ecs:RunTask"], undefined, "ECS targets come from the clusters, never from inventory rows");
  assert.equal(t["ec2:RunInstances"], undefined, "a launch names resources that don't exist yet: against *");
  assert.ok(Object.keys(RESOURCE_TYPED_ACTIONS).every((a) => !a.startsWith("ecs:")));
});

test("denialIsFinal: only for services without resource policies", () => {
  for (const a of ["ecs:UpdateService", "ec2:StopInstances", "rds:StopDBInstance", "autoscaling:SetDesiredCapacity", "states:StartExecution"]) assert.equal(denialIsFinal(a), true, a);
  for (const a of ["lambda:InvokeFunction", "sqs:SendMessage", "sns:Publish", "events:EnableRule", "s3:PutObject", "iam:PassRole"]) assert.equal(denialIsFinal(a), false, `${a}: a resource policy may grant it`);
});

test("combineTargets: allowed or denied only when every cluster agrees; a mix is a probably", () => {
  assert.equal(combineTargets([]), undefined);
  assert.equal(combineTargets(["allowed", "allowed"]), "allowed");
  assert.equal(combineTargets(["resourceDeny", "resourceDeny"]), "resourceDeny", "a read-only identity: denied everywhere");
  assert.equal(combineTargets(["explicitDeny", "resourceDeny"]), "resourceDeny");
  assert.equal(combineTargets(["explicitDeny"]), "explicitDeny");
  assert.equal(combineTargets(["resourceDeny", "allowed"]), "implicitDeny", "scoped to the staging cluster: not denied outright");
  assert.equal(combineTargets(["implicitDeny", "resourceDeny"]), "implicitDeny", "a tag condition the simulator can't see");
});

test("combine: the worst state wins; nothing needed is allowed", () => {
  assert.equal(combine(["allowed", "unknown", "probably-denied"]), "probably-denied");
  assert.equal(combine(["allowed", "denied", "probably-denied"]), "denied");
  assert.equal(combine(["allowed", "unknown"]), "unknown");
  assert.equal(combine(["allowed"]), "allowed");
  assert.equal(combine([]), "allowed");
});

// The store imports "server-only" (it resolves only under the react-server condition), so it runs in a child process.
const store = new URL("./server/capability.ts", import.meta.url).href;
const runChild = (source: "aws" | "mock", body: string) => {
  const out = execFileSync(process.execPath, ["--conditions=react-server", "--no-warnings", "--input-type=module", "-e", body], {
    encoding: "utf8",
    env: { ...process.env, CONSOLE_SOURCE: source, CONSOLE_SQLITE_PATH: ":memory:" },
    timeout: 60_000,
  });
  return JSON.parse(out.trim().split("\n").pop()!);
};

test("capability store (simulated account): everything allowed after a refresh", () => {
  const o = runChild("mock", `
const c = await import(${JSON.stringify(store)});
const before = c.capabilityView();
await c.refreshCapability();
const after = c.capabilityView();
console.log(JSON.stringify({ before: before.source, after, scale: c.capability(["ecs:UpdateService"]) }));`);
  assert.equal(o.before, "none");
  assert.equal(o.after.source, "simulated");
  assert.equal(o.after.readOnly, false);
  assert.deepEqual(o.after.denied, []);
  assert.equal(o.after.actions["ecs:UpdateService"], "allowed");
  assert.deepEqual(o.scale, { state: "allowed", missing: [] });
});

test("capability store (AWS-shaped): simulation, observations, throttled refresh and failures that never throw", () => {
  const o = runChild("aws", `
let calls = 0; let fail = false; let targets;
globalThis.__consoleCloud = Promise.resolve({
  clusters: async () => [],
  simulate: async (actions, t) => {
    calls++;
    targets = t;
    if (fail) throw Object.assign(new Error("User: arn:aws:sts::123456789012:assumed-role/acme-console/s is not authorized to perform: iam:SimulatePrincipalPolicy on resource: arn:aws:iam::123456789012:role/acme-console"), { name: "AccessDenied" });
    return Object.fromEntries(actions.map((a) => [a, a.startsWith("ecs:") ? "implicitDeny" : a === "ec2:StopInstances" ? "explicitDeny" : "allowed"]));
  },
});
const c = await import(${JSON.stringify(store)});
const out = {};
await Promise.all([c.refreshCapability(), c.refreshCapability()]);
out.callsAfterFirst = calls;
out.targetsBeforeInventory = targets;
out.view = c.capabilityView();
out.scale = c.capability(["ecs:UpdateService"]);
out.power = c.capability(["ec2:StartInstances", "ec2:StopInstances"]);
await c.refreshCapability();
out.callsThrottled = calls;
// The cloud-map inventory's first build arrives: simulated again once, against its resources.
const arn = "arn:aws:ec2:us-east-1:123456789012:instance/i-0123456789abcdef0";
globalThis.__consoleInventory.built = { view: { resources: [{ key: "ec2:i-0123456789abcdef0", aliases: [arn], region: "us-east-1", env: "staging", tags: {} }] } };
await c.refreshCapability();
out.callsAfterInventory = calls;
out.stopTargets = targets["ec2:StopInstances"];
await c.refreshCapability();
out.callsThrottledAgain = calls;
c.noteAllowed("ecs:UpdateService");
out.scaleAfterSuccess = c.capability(["ecs:UpdateService"]).state;
out.readOnlyAfterSuccess = c.capabilityView().readOnly;
c.noteDenied("rds:StartDBInstance", "arn:aws:rds:eu-west-1:123456789012:db:acme");
out.db = c.capability(["rds:StartDBInstance"]);
c.noteAllowed("rds:StartDBInstance");
out.dbAfter = c.capability(["rds:StartDBInstance"]).state;
fail = true;
await c.refreshCapability(true);
out.callsForced = calls;
out.failedView = c.capabilityView();
console.log(JSON.stringify(out));`);
  assert.equal(o.callsAfterFirst, 1, "concurrent refreshes share one simulation");
  assert.equal(o.view.source, "simulated");
  assert.equal(o.view.readOnly, true, "every ECS write probably denied");
  assert.ok(o.view.denied.includes("ecs:UpdateService") && o.view.denied.includes("ec2:StopInstances"));
  assert.equal(o.view.actions["rds:StopDBInstance"], "allowed");
  assert.equal(o.scale.state, "probably-denied");
  assert.deepEqual(o.scale.missing, ["ecs:UpdateService"]);
  assert.match(o.scale.why, /probably doesn't allow ecs:UpdateService/);
  assert.equal(o.power.state, "denied");
  assert.deepEqual(o.power.missing, ["ec2:StopInstances"]);
  assert.match(o.power.why, /can't ec2:StopInstances \(denied by its IAM policy\)/);
  assert.equal(o.callsThrottled, 1, "at most every 10 minutes");
  assert.deepEqual(o.targetsBeforeInventory, {}, "no clusters and no inventory yet: everything against *");
  assert.equal(o.callsAfterInventory, 2, "the inventory's first build is simulated against at once");
  assert.deepEqual(o.stopTargets, ["arn:aws:ec2:us-east-1:123456789012:instance/i-0123456789abcdef0"]);
  assert.equal(o.callsThrottledAgain, 2, "then every 10 minutes again");
  assert.equal(o.scaleAfterSuccess, "allowed");
  assert.equal(o.readOnlyAfterSuccess, false);
  assert.equal(o.db.state, "denied");
  assert.match(o.db.why, /AWS refused it recently/);
  assert.equal(o.dbAfter, "allowed", "a success clears the refusal");
  assert.equal(o.callsForced, 3);
  assert.match(o.failedView.note, /^not verified: The console's AWS identity can't iam:SimulatePrincipalPolicy/);
  assert.ok(!o.failedView.note.includes("assumed-role"));
  assert.equal(o.failedView.source, "simulated", "the previous result stays");
  assert.equal(o.failedView.actions["ecs:UpdateService"], "allowed", "observation still applies");
});
