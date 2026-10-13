import { test } from "node:test";
import assert from "node:assert/strict";
import {
  actionLinks, buildEnvMentions, buildHealth, codebuildDetail, codebuildResults, codedeployDetail, codedeployResults, deployHealth, pipelineDetail, pipelineHealth, pipelineResults, revisionText,
  secretIdOf, type CodeBuildRaw, type PipelineRaw, type RawPipeline,
} from "./cicd.ts";
import { simBuilds, simCodeBuild } from "../server/providers/mock/codebuild.ts";
import { simCodeDeploy, simDeployments } from "../server/providers/mock/codedeploy.ts";
import { simPipelines } from "../server/providers/mock/codepipeline.ts";
import type { Resource } from "./types.ts";

const R = "us-east-1";
const A = "123456789012";
const NOW = Date.parse("2026-10-05T12:00:00Z");
const DAY = 86_400_000;
const SENTINEL = "SENTINEL-cicd-52f0aa";
const prop = (r: Resource, label: string) => r.props.find((p) => p.label === label)?.value;
const o = { region: R, accountId: A, home: R, now: NOW };

// ---------- CodeBuild ----------

// Golden: BatchGetProjects + the latest build. A PLAINTEXT value, the webhook secret and the buildspec carry the
// sentinel: the value may only reach Mention.refs; the other two nowhere.
const BUILD: CodeBuildRaw = {
  projects: [
    {
      name: "web-build", arn: `arn:aws:codebuild:${R}:${A}:project/web-build`, serviceRole: `arn:aws:iam::${A}:role/service-role/cb`, created: new Date(NOW - 300 * DAY),
      encryptionKey: "alias/aws/s3", timeoutInMinutes: 20,
      source: { type: "GITHUB", location: `https://x-token:${SENTINEL}@github.com/acme/web.git`, buildspec: SENTINEL } as never,
      artifacts: { type: "S3", location: "web-artifacts" },
      environment: {
        type: "LINUX_CONTAINER", image: `${A}.dkr.ecr.${R}.amazonaws.com/build/node:22`, computeType: "BUILD_GENERAL1_SMALL", privilegedMode: false,
        environmentVariables: [
          { name: "API_TOKEN", value: SENTINEL, type: "PLAINTEXT" },
          { name: "DB_PASSWORD", value: "/web/db/password", type: "PARAMETER_STORE" },
          { name: "STRIPE", value: `arn:aws:secretsmanager:${R}:${A}:secret:web/stripe-AbCdEf:STRIPE_KEY::`, type: "SECRETS_MANAGER" },
        ],
      },
      logsConfig: { cloudWatchLogs: { status: "ENABLED" }, s3Logs: { status: "ENABLED", location: "web-logs/codebuild" } },
      vpcConfig: { vpcId: "vpc-1", subnets: ["subnet-1"], securityGroupIds: ["sg-1"] },
      webhook: { branchFilter: "^main$", secret: SENTINEL, payloadUrl: SENTINEL } as never,
      tags: [{ key: "Environment", value: "production" }],
    },
    { name: "never", created: new Date(NOW - 100 * DAY), logsConfig: { cloudWatchLogs: { status: "DISABLED" } } },
    { name: "broken", created: new Date(NOW - 10 * DAY) },
    { name: "unread", created: new Date(NOW - 10 * DAY) },
  ],
  lastBuild: {
    "web-build": { state: "ok", value: { id: "web-build:1", buildNumber: 88, buildStatus: "SUCCEEDED", startTime: new Date(NOW - DAY), initiator: "GitHub-Hookshot/abc", resolvedSourceVersion: "abcdef0123456789" } },
    never: { state: "ok", value: null },
    broken: { state: "ok", value: { id: "broken:7", buildNumber: 7, buildStatus: "FAILED", startTime: new Date("2026-10-04T10:00:00Z") } },
    unread: { state: "denied" },
  },
};
const builds = () => codebuildResults(BUILD, o);
const project = (n: string) => builds().resources.find((r) => r.name === n)!;

test("CodeBuild: environment values never reach props or links — only Mention.refs; references become mentions", () => {
  const out = builds();
  assert.ok(!JSON.stringify({ resources: out.resources, links: out.links }).includes(SENTINEL));
  assert.ok(out.mentions.every((m) => !m.via.includes(SENTINEL)));
  const key = `arn:aws:codebuild:${R}:${A}:project/web-build`;
  assert.deepEqual(out.mentions.filter((m) => m.from === key).map((m) => [m.via, m.refs[0]]), [
    ["env API_TOKEN", SENTINEL],
    ["env DB_PASSWORD (Parameter Store)", "/web/db/password"],
    ["env STRIPE (Secrets Manager)", `arn:aws:secretsmanager:${R}:${A}:secret:web/stripe-AbCdEf`],
  ]);
  assert.equal(prop(project("web-build"), "Environment variables"), "API_TOKEN, DB_PASSWORD (Parameter Store), STRIPE (Secrets Manager)");
  assert.equal(prop(project("web-build"), "Source"), "github https://github.com/acme/web.git", "credentials scrubbed from the source URL");
  assert.equal(prop(project("web-build"), "Webhook"), "on (branches ^main$)");
  assert.equal(secretIdOf("acme/web:KEY:AWSCURRENT"), "acme/web");
  assert.deepEqual(buildEnvMentions("k", [{ name: "FLAG", value: "true" }]).mentions, [], "flags can't name anything");
});

test("CodeBuild: links — role, logs (default group), S3 logs and artifacts, ECR build image, KMS; network fields", () => {
  const key = `arn:aws:codebuild:${R}:${A}:project/web-build`;
  assert.deepEqual(builds().links.filter((l) => l.from === key || l.to === key).map((l) => [l.kind, l.from === key ? l.to : l.from]), [
    ["assumes", `arn:aws:iam::${A}:role/service-role/cb`],
    ["logs", `arn:aws:logs:${R}:${A}:log-group:/aws/codebuild/web-build`],
    ["logs", "arn:aws:s3:::web-logs"],
    ["writes", "arn:aws:s3:::web-artifacts"],
    ["pulls", `arn:aws:ecr:${R}:${A}:repository/build/node`],
    ["encrypts", `arn:aws:kms:${R}:${A}:alias/aws/s3`],
  ]);
  assert.equal(builds().links.filter((l) => l.from.endsWith("project/never") && l.kind === "logs").length, 0, "logs disabled");
  const p = project("web-build");
  assert.deepEqual([p.vpcId, p.subnetIds, p.securityGroups], ["vpc-1", ["subnet-1"], ["sg-1"]]);
  assert.deepEqual(p.tags, { Environment: "production" });
});

test("CodeBuild: health from the last build; never built is unknown (idle from creation); unread is unknown", () => {
  assert.equal(project("web-build").health, "ok");
  assert.equal(project("web-build").lastActivityAt, NOW - DAY);
  assert.deepEqual([project("never").health, project("never").healthReason, project("never").lastActivityAt], ["unknown", "never built", NOW - 100 * DAY]);
  assert.deepEqual([project("broken").health, project("broken").healthReason], ["error", "last build #7 failed (2026-10-04 10:00 UTC)"]);
  assert.deepEqual([project("unread").health, project("unread").healthReason, project("unread").enrichment], ["unknown", "last build not read (denied)", { builds: "denied" }]);
  assert.equal(buildHealth({ buildStatus: "STOPPED" }, "ok").health, "warning");
  assert.equal(buildHealth({ buildStatus: "TIMED_OUT" }, "ok").health, "error");
  assert.equal(buildHealth({ buildStatus: "IN_PROGRESS", currentPhase: "BUILD" }, "ok").reason, "building (build)");
  const d = codebuildDetail("k", simBuilds("us-east-1", "acme-billing-build", NOW).reverse());
  assert.deepEqual(d.sections[0].table?.rows.map((r) => [r[0], r[1], r[3]]), [["#412", "succeeded", "6 min"], ["#411", "succeeded", "5 min"], ["#410", "failed", "3 min"]]);
  assert.equal(codebuildDetail("k", []).sections[0].note, "Never built.");
});

// ---------- CodePipeline ----------

const DECL: RawPipeline = {
  name: "web-release", roleArn: `arn:aws:iam::${A}:role/pipeline`,
  artifactStore: { type: "S3", location: "web-artifacts", encryptionKey: { id: `arn:aws:kms:${R}:${A}:key/k1` } },
  stages: [
    { name: "Source", actions: [{ name: "GitHub", actionTypeId: { category: "Source", owner: "ThirdParty", provider: "GitHub" }, configuration: { Owner: "acme", Repo: "web", Branch: "main", OAuthToken: SENTINEL } }] },
    { name: "Build", actions: [{ name: "Build", actionTypeId: { category: "Build", owner: "AWS", provider: "CodeBuild" }, configuration: { ProjectName: "web-build", EnvironmentVariables: JSON.stringify([{ name: "T", value: SENTINEL, type: "PLAINTEXT" }]) } }] },
    {
      name: "Deploy",
      actions: [
        { name: "Prod", actionTypeId: { category: "Deploy", owner: "AWS", provider: "ECS" }, configuration: { ClusterName: "prod", ServiceName: "web" } },
        { name: "EU", region: "eu-west-1", actionTypeId: { category: "Deploy", owner: "AWS", provider: "ECS" }, configuration: { ClusterName: "prod", ServiceName: "web" }, roleArn: `arn:aws:iam::${A}:role/cross-region` },
        { name: "Infra", actionTypeId: { category: "Deploy", owner: "AWS", provider: "CloudFormation" }, configuration: { StackName: "web-infra", ParameterOverrides: SENTINEL } },
        { name: "Site", actionTypeId: { category: "Deploy", owner: "AWS", provider: "S3" }, configuration: { BucketName: "web-site" } },
        { name: "Notify", actionTypeId: { category: "Invoke", owner: "AWS", provider: "Lambda" }, configuration: { FunctionName: "notify", UserParameters: SENTINEL } },
        { name: "BlueGreen", actionTypeId: { category: "Deploy", owner: "AWS", provider: "CodeDeployToECS" }, configuration: { ApplicationName: "web", DeploymentGroupName: "web-bg" } },
      ],
    },
  ],
};
const PIPES: PipelineRaw = {
  pipelines: [{ name: "web-release", created: new Date(NOW - 200 * DAY) }, { name: "idle", created: new Date(NOW - 90 * DAY) }, { name: "held" }],
  declaration: { "web-release": { state: "ok", value: DECL } },
  state: {
    "web-release": { state: "ok", value: [{ stageName: "Source", latestExecution: { status: "Succeeded" } }, { stageName: "Build", inboundTransitionState: { enabled: true }, latestExecution: { status: "Failed" }, actionStates: [{ actionName: "Build", latestExecution: { status: "Failed", errorDetails: { code: "JobFailed", message: "Build terminated with state: FAILED" } } }] }] },
    held: { state: "ok", value: [{ stageName: "Deploy", inboundTransitionState: { enabled: false, disabledReason: "release freeze" } }] },
  },
  executions: {
    "web-release": { state: "ok", value: [{ pipelineExecutionId: "e1", status: "Failed", startTime: new Date("2026-10-05T09:00:00Z") }] },
    idle: { state: "ok", value: [] },
    held: { state: "ok", value: [{ status: "Succeeded", startTime: new Date(NOW - DAY) }] },
  },
  tags: { "web-release": { state: "ok", value: [{ key: "team", value: "web" }] }, idle: { state: "denied" } },
};
const pipes = () => pipelineResults(PIPES, o);
const pipe = (n: string) => pipes().resources.find((r) => r.name === n)!;

test("CodePipeline: the key has no type segment; action configurations become links in the action's region", () => {
  const key = `arn:aws:codepipeline:${R}:${A}:web-release`;
  assert.equal(pipe("web-release").key, key);
  assert.deepEqual(pipes().links.filter((l) => l.from === key || l.to === key).map((l) => [l.kind, l.from === key ? l.to : l.from, l.label]), [
    ["assumes", `arn:aws:iam::${A}:role/pipeline`, "pipeline role"],
    ["writes", "arn:aws:s3:::web-artifacts", "artifacts"],
    ["encrypts", `arn:aws:kms:${R}:${A}:key/k1`, "artifacts"],
    ["invoke", `arn:aws:codebuild:${R}:${A}:project/web-build`, "Build"],
    ["manages", "ecs:service/prod/web", "deploys"],
    ["manages", "ecs:service/prod/web@eu-west-1", "deploys"],
    ["assumes", `arn:aws:iam::${A}:role/cross-region`, "EU"],
    ["manages", "web-infra", "Infra"],
    ["writes", "arn:aws:s3:::web-site", "Site"],
    ["invoke", `arn:aws:lambda:${R}:${A}:function:notify`, "Notify"],
    ["invoke", `arn:aws:codedeploy:${R}:${A}:deploymentgroup:web/web-bg`, "deploys"],
  ]);
  assert.deepEqual(actionLinks("p", { name: "x", actionTypeId: { provider: "ECS" }, configuration: Object.create({ ClusterName: "c", ServiceName: "s" }) }, { region: R, home: R }), [], "own properties only");
});

test("CodePipeline: configuration values outside the allow-list never leave; CodeBuild action PLAINTEXT values only as mentions", () => {
  const out = pipes();
  assert.ok(!JSON.stringify({ resources: out.resources, links: out.links }).includes(SENTINEL));
  assert.deepEqual(out.mentions.map((m) => [m.via, m.refs[0]]), [["action Build env T", SENTINEL]]);
  assert.equal(prop(pipe("web-release"), "Source"), "acme/web @ main");
  assert.equal(prop(pipe("web-release"), "Stages"), "Source (GitHub) → Build (CodeBuild) → Deploy (ECS, ECS, CloudFormation, S3, Lambda, CodeDeployToECS)");
});

test("CodePipeline: health — the latest run failed → error; a disabled transition → warning; never run → unknown", () => {
  assert.deepEqual([pipe("web-release").health, pipe("web-release").healthReason], ["error", "last run failed in Build/Build: Build terminated with state: FAILED (2026-10-05 09:00 UTC)"]);
  assert.deepEqual([pipe("held").health, pipe("held").healthReason], ["warning", "transition into Deploy disabled: release freeze"]);
  assert.deepEqual([pipe("idle").health, pipe("idle").healthReason, pipe("idle").lastActivityAt], ["unknown", "never run", NOW - 90 * DAY]);
  assert.equal(pipe("idle").tagsUnread, true);
  assert.deepEqual(pipe("web-release").tags, { team: "web" });
  assert.equal(pipelineHealth(undefined, undefined, { executions: "skipped" }).reason, "executions not read (skipped)");
  const d = pipelineDetail("k", PIPES.executions!["web-release"].value, PIPES.state!.held.value);
  assert.deepEqual(d.sections.map((s) => s.title), ["Stages", "Runs (latest 1)"]);
});

// ---------- CodeDeploy ----------

test("CodeDeploy: health from the last attempted deployment; blue/green manages ECS services; ASGs, role, triggers", () => {
  const out = codedeployResults({
    groups: [
      {
        applicationName: "web", deploymentGroupName: "web-bg", computePlatform: "ECS", serviceRoleArn: `arn:aws:iam::${A}:role/cd`,
        deploymentStyle: { deploymentType: "BLUE_GREEN", deploymentOption: "WITH_TRAFFIC_CONTROL" },
        ecsServices: [{ clusterName: "prod", serviceName: "web" }], loadBalancerInfo: { targetGroupPairInfoList: [{ targetGroups: [{ name: "blue" }, { name: "green" }] }] },
        lastAttemptedDeployment: { deploymentId: "d-2", status: "Ready", createTime: new Date(NOW - 3_600_000) },
        triggerConfigurations: [{ triggerName: "to-slack", triggerTargetArn: `arn:aws:sns:${R}:${A}:deploys` }],
      },
      { applicationName: "legacy", deploymentGroupName: "legacy-prod", autoScalingGroups: [{ name: "legacy-asg" }], lastAttemptedDeployment: { deploymentId: "d-9", status: "Failed", endTime: new Date("2026-10-01T08:00:00Z") }, lastSuccessfulDeployment: { deploymentId: "d-8", status: "Succeeded", endTime: new Date("2026-09-01T08:00:00Z") } },
      { applicationName: "new", deploymentGroupName: "new-grp" },
    ],
    tags: { [`arn:aws:codedeploy:${R}:${A}:deploymentgroup:web/web-bg`]: { state: "ok", value: [{ Key: "Environment", Value: "production" }] } },
  }, { ...o, region: "eu-west-1" });
  const [bg, legacy, fresh] = out.resources;
  assert.equal(bg.key, `arn:aws:codedeploy:eu-west-1:${A}:deploymentgroup:web/web-bg`);
  assert.deepEqual([bg.health, bg.healthReason], ["ok", "waiting for traffic shift"]);
  assert.deepEqual([legacy.health, legacy.healthReason], ["error", "last deployment d-9 failed (2026-10-01 08:00 UTC); last success 2026-09-01 08:00 UTC"]);
  assert.deepEqual([fresh.health, fresh.healthReason], ["unknown", "never deployed"]);
  assert.equal(legacy.tagsUnread, true);
  assert.equal(prop(bg, "Target groups"), "blue, green");
  assert.deepEqual(out.links.map((l) => [l.from.split(":").pop(), l.kind, l.to, l.label]), [
    ["web/web-bg", "manages", "ecs:service/prod/web@eu-west-1", "blue/green"],
    ["web/web-bg", "assumes", `arn:aws:iam::${A}:role/cd`, "service role"],
    ["web/web-bg", "event", `arn:aws:sns:${R}:${A}:deploys`, "to-slack"],
    ["legacy/legacy-prod", "manages", "legacy-asg", "deploys"],
  ]);
  assert.equal(deployHealth({ lastAttemptedDeployment: { status: "Stopped" } }).health, "warning");
  assert.equal(deployHealth({ lastAttemptedDeployment: { status: "InProgress" } }).reason, "deploying");
  const d = codedeployDetail("k", [{ deploymentId: "old", status: "Succeeded", createTime: new Date(NOW - 9 * DAY) }, { deploymentId: "new", status: "Failed", createTime: new Date(NOW - DAY), errorInformation: { code: "TIMEOUT", message: "timed out" } }]);
  assert.deepEqual(d.sections[0].table?.rows.map((r) => [r[0], r[5]]), [["new", "TIMEOUT: timed out"], ["old", ""]]);
  assert.equal(codedeployDetail("k", undefined).sections[0].note, "The deployments couldn't be read.");
});

// ---------- the simulation ----------

test("CodePipeline: revision text — CodeStar JSON summaries become the commit's first line; anything else as it is", () => {
  assert.equal(revisionText({ revisionId: "0123456789abcdef", revisionSummary: '{"ProviderType":"GitHub","CommitMessage":"Fix login\\n\\nlong body"}' }, 80), "0123456789ab Fix login");
  assert.equal(revisionText({ revisionId: "abc", revisionSummary: "Plain message" }, 80), "abc Plain message");
  assert.equal(revisionText({ revisionSummary: "{not json" }, 80), "{not json");
  assert.equal(revisionText({}, 80), undefined);
  assert.equal(revisionText(undefined, 80), undefined);
});

test("CI/CD: the Acme simulation — the billing pipeline builds and deploys billing; the legacy admin group failed; no secret leaks", () => {
  const cb = codebuildResults(simCodeBuild("us-east-1", NOW), o);
  const cp = pipelineResults(simPipelines("us-east-1", NOW), o);
  const cd = codedeployResults(simCodeDeploy("us-east-1", NOW), o);
  assert.deepEqual([cb.resources.map((r) => [r.name, r.health]), cp.resources.map((r) => [r.name, r.health]), cd.resources.map((r) => [r.name, r.health])], [
    [["acme-billing-build", "ok"]], [["acme-billing-release", "ok"]], [["acme-legacy-admin-prod", "error"]],
  ]);
  const pipeKey = cp.resources[0].key;
  assert.ok(cp.links.some((l) => l.from === pipeKey && l.to === "ecs:service/acme-production/billing" && l.kind === "manages"));
  assert.ok(cp.links.some((l) => l.from === pipeKey && l.to === cb.resources[0].key && l.kind === "invoke"));
  for (const secret of ["sntrys_fake_acme_build_token", "dckr_pat_fake_acme_pipeline"]) {
    assert.ok(!JSON.stringify({ a: cb.resources, b: cb.links, c: cp.resources, d: cp.links }).includes(secret), `leaked ${secret}`);
  }
  assert.ok(cb.mentions.some((m) => m.via === "env JWT_SIGNING_KEY (Parameter Store)" && m.refs[0] === "/acme/production/billing/JWT_SIGNING_KEY"));
  assert.ok(cb.mentions.some((m) => m.via === "env STRIPE_SECRET_KEY (Secrets Manager)" && m.refs[0] === "acme/production/billing"));
  assert.equal(codedeployDetail(cd.resources[0].key, simDeployments("us-east-1", "acme-legacy-admin-prod", NOW)).sections[0].table?.rows[0][1], "failed");
  // CodeStar connections send the revision summary as JSON: people see the commit's first line.
  assert.equal(cp.resources[0].props.find((x) => x.label === "Revision")?.value, "4f2a9c1e7b3d Retry failed invoices");
  for (const r of ["eu-west-1", "ap-south-1"]) {
    assert.deepEqual([simCodeBuild(r).projects, simPipelines(r).pipelines, simCodeDeploy(r).groups], [[], [], []]);
  }
});
