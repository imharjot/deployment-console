// CodeBuild projects, CodePipeline pipelines and CodeDeploy deployment groups, pure part (audit §6 A.2 #19–#21): the
// SDK shapes the three providers read, real or simulated, → Resources, Links and Mentions. No AWS calls and no
// `server-only`, so node:test runs it (cicd.test.ts).
//
// Secrets (A.0 rule 6): CodeBuild PLAINTEXT environment values — in a project and in a pipeline's CodeBuild action — are
// handed over only as Mention.refs (matched against other resources, never shown); PARAMETER_STORE and SECRETS_MANAGER
// values are references, and become mentions too (the map draws `reads` to the parameter or secret). A project's
// webhook secret, its buildspec and a pipeline action's other configuration values (OAuth tokens, user parameters) are
// never copied: props show only the names in the allow-lists below.
import { arnBase, arnOf, partitionOf } from "./arn.ts";
import { safeOutput } from "./cloudformation.ts";
import { ecrRepoRef, roleRef } from "./compute-common.ts";
import { awsTime, clip, enrichmentOf, envMentions, fmtTime, kmsKeyRef, lambdaRef, logGroupRef, props, tagsOf, unread } from "./serverless-common.ts";
import { keys, type EnrichState, type Health, type Link, type Mention, type ProviderResult, type Resource, type ResourceDetail } from "./types.ts";

type When = Date | string | number;
export interface Read<T> { value?: T; state: EnrichState }
export interface CicdOptions { region: string; accountId?: string; home?: string; now?: number }
type Tag = { key?: string; value?: string };
const tagList = (tags: Tag[] | undefined) => (tags ? tags.map((t) => ({ Key: t.key, Value: t.value })) : undefined);
const s3Arn = (region: string, bucket: string) => `arn:${partitionOf(region)}:s3:::${bucket}`;
const bucketOf = (location: string | undefined) => location?.replace(/^s3:\/\//, "").split("/")[0] || undefined;

// ---------- CodeBuild ----------

export interface RawEnvVar { name?: string; value?: string; type?: string } // PLAINTEXT | PARAMETER_STORE | SECRETS_MANAGER
export interface RawProject {
  name?: string;
  arn?: string;
  description?: string;
  serviceRole?: string;
  created?: When;
  lastModified?: When;
  encryptionKey?: string;
  timeoutInMinutes?: number;
  concurrentBuildLimit?: number;
  source?: { type?: string; location?: string };
  secondarySources?: { type?: string; location?: string }[];
  artifacts?: { type?: string; location?: string };
  environment?: { type?: string; image?: string; computeType?: string; privilegedMode?: boolean; environmentVariables?: RawEnvVar[]; registryCredential?: { credential?: string } };
  logsConfig?: { cloudWatchLogs?: { status?: string; groupName?: string }; s3Logs?: { status?: string; location?: string } };
  vpcConfig?: { vpcId?: string; subnets?: string[]; securityGroupIds?: string[] };
  webhook?: { branchFilter?: string; filterGroups?: unknown[] }; // (its url, payloadUrl and secret are never read)
  tags?: Tag[];
}
export interface RawBuild { id?: string; buildNumber?: number; buildStatus?: string; startTime?: When; endTime?: When; currentPhase?: string; sourceVersion?: string; resolvedSourceVersion?: string; initiator?: string }
export interface CodeBuildRaw { projects: RawProject[]; lastBuild?: Record<string, Read<RawBuild | null>> } // by project name; null = never built

// A SECRETS_MANAGER value is "<secret-id>[:<json-key>[:<stage>[:<version>]]]" (the id may be an ARN, itself with ":").
export function secretIdOf(value: string): string {
  const v = value.trim();
  if (v.startsWith("arn:")) return arnBase(v.split(":").slice(0, 7).join(":"));
  return v.split(":")[0];
}

// Environment variables → mentions (values never leave the server) and the names people may see.
export function buildEnvMentions(from: string, vars: RawEnvVar[] | undefined, via = "env"): { mentions: Mention[]; names: string[] } {
  const plain: Record<string, string> = {};
  const mentions: Mention[] = [];
  const names: string[] = [];
  for (const v of vars ?? []) {
    if (!v.name) continue;
    const type = v.type ?? "PLAINTEXT";
    if (type === "PARAMETER_STORE" && v.value) mentions.push({ from, refs: [v.value.trim()], via: `${via} ${v.name} (Parameter Store)` });
    else if (type === "SECRETS_MANAGER" && v.value) mentions.push({ from, refs: [secretIdOf(v.value)], via: `${via} ${v.name} (Secrets Manager)` });
    else if (v.value) plain[v.name] = v.value;
    names.push(type === "PLAINTEXT" ? v.name : `${v.name} (${type === "PARAMETER_STORE" ? "Parameter Store" : type === "SECRETS_MANAGER" ? "Secrets Manager" : type})`);
  }
  return { mentions: [...envMentions(from, plain, via), ...mentions], names };
}

export function buildHealth(b: RawBuild | null | undefined, state: EnrichState | undefined): { health: Health; reason?: string } {
  if (b === undefined) return { health: "unknown", reason: unread("last build", state) };
  if (b === null) return { health: "unknown", reason: "never built" };
  const when = fmtTime(awsTime(b.startTime));
  const n = b.buildNumber !== undefined ? ` #${b.buildNumber}` : "";
  switch (b.buildStatus) {
    case "SUCCEEDED":
      return { health: "ok" };
    case "IN_PROGRESS":
      return { health: "ok", reason: `building${n} (${(b.currentPhase ?? "").toLowerCase().replace(/_/g, " ") || "started"})` };
    case "FAILED":
    case "FAULT":
    case "TIMED_OUT":
      return { health: "error", reason: `last build${n} ${b.buildStatus === "TIMED_OUT" ? "timed out" : "failed"} (${when})` };
    case "STOPPED":
      return { health: "warning", reason: `last build${n} was stopped (${when})` };
    default:
      return { health: "unknown", ...(b.buildStatus ? { reason: `last build ${b.buildStatus.toLowerCase()}` } : {}) };
  }
}

const srcText = (s: { type?: string; location?: string } | undefined) =>
  s?.type ? `${s.type.toLowerCase().replace(/_/g, " ")}${s.location ? ` ${safeOutput(s.location) ?? (s.type === "S3" ? s.location.split("/")[0] : "")}` : ""}`.trim() : undefined;

export function codebuildResults(raw: CodeBuildRaw, o: CicdOptions): ProviderResult {
  const resources: Resource[] = [];
  const links: Link[] = [];
  const mentions: Mention[] = [];
  for (const p of raw.projects) {
    if (!p.name) continue;
    const key = p.arn ?? arnOf.codebuildProject(o.region, o.accountId ?? "", p.name);
    const region = key.split(":")[3] || o.region;
    const account = key.split(":")[4] || o.accountId;
    const read = raw.lastBuild?.[p.name];
    const b = read?.state === "ok" ? read.value ?? null : read?.value;
    const { health, reason } = buildHealth(read ? b : undefined, read?.state);
    const env = buildEnvMentions(key, p.environment?.environmentVariables);
    const created = awsTime(p.created);
    const started = b ? awsTime(b.startTime) : undefined;
    const enrichment = enrichmentOf({ builds: read?.state });
    const logGroup = p.logsConfig?.cloudWatchLogs?.status !== "DISABLED" ? logGroupRef(p.logsConfig?.cloudWatchLogs?.groupName || `/aws/codebuild/${p.name}`, region, account) : undefined;
    resources.push({
      key, kind: "codebuild-project", provider: "codebuild", name: p.name, region,
      ...tagsOf(tagList(p.tags) ?? []), // BatchGetProjects returns the tags: always read
      health, ...(reason ? { healthReason: reason } : {}), ...(enrichment ? { enrichment } : {}),
      ...(p.vpcConfig?.vpcId ? { vpcId: p.vpcConfig.vpcId } : {}),
      ...(p.vpcConfig?.subnets?.length ? { subnetIds: p.vpcConfig.subnets } : {}),
      ...(p.vpcConfig?.securityGroupIds?.length ? { securityGroups: p.vpcConfig.securityGroupIds } : {}),
      props: props([
        { label: "Last build", value: b ? `${(b.buildStatus ?? "").toLowerCase().replace(/_/g, " ")}${b.buildNumber !== undefined ? ` #${b.buildNumber}` : ""} · ${fmtTime(started)}` : b === null ? "never built" : undefined },
        { label: "Started by", value: b?.initiator ? clip(b.initiator, 120) : undefined },
        { label: "Source version", value: b?.resolvedSourceVersion ?? b?.sourceVersion, mono: true },
        { label: "Source", value: srcText(p.source) },
        { label: "Environment", value: p.environment ? [p.environment.image, p.environment.computeType?.replace(/^BUILD_GENERAL1_/, "").toLowerCase(), p.environment.privilegedMode ? "privileged (Docker)" : undefined].filter(Boolean).join(" · ") : undefined },
        { label: "Environment variables", value: env.names.length ? clip(env.names.join(", "), 240) : undefined },
        { label: "Webhook", value: p.webhook ? `on${p.webhook.branchFilter ? ` (branches ${clip(p.webhook.branchFilter, 60)})` : ""}` : undefined },
        { label: "Timeout", value: p.timeoutInMinutes ? `${p.timeoutInMinutes} min` : undefined },
        { label: "Description", value: p.description ? clip(p.description, 200) : undefined },
        { label: "Created", value: created !== undefined ? fmtTime(created) : undefined },
      ]),
      aliases: [p.name],
      consoleUrl: `https://${region}.console.aws.amazon.com/codesuite/codebuild/projects/${encodeURIComponent(p.name)}?region=${region}`,
      ...(created !== undefined ? { createdAt: created } : {}),
      ...(started !== undefined ? { lastActivityAt: started } : b === null && created !== undefined ? { lastActivityAt: created } : {}),
      ...(o.now ? { observedAt: o.now } : {}),
    });
    const role = roleRef(p.serviceRole, account, region);
    if (role) links.push({ from: key, to: role, kind: "assumes", label: "service role", evidence: "project serviceRole" });
    if (logGroup) links.push({ from: key, to: logGroup, kind: "logs", label: "build logs", evidence: "project logsConfig.cloudWatchLogs" });
    const s3Logs = p.logsConfig?.s3Logs?.status === "ENABLED" ? bucketOf(p.logsConfig.s3Logs.location) : undefined;
    if (s3Logs) links.push({ from: key, to: s3Arn(region, s3Logs), kind: "logs", label: "build logs", evidence: "project logsConfig.s3Logs" });
    for (const s of [p.source, ...(p.secondarySources ?? [])]) {
      const bucket = s?.type === "S3" ? bucketOf(s.location) : undefined;
      if (bucket) links.push({ from: key, to: s3Arn(region, bucket), kind: "reads", label: "source", evidence: "project source (S3)" });
    }
    const out = p.artifacts?.type === "S3" ? bucketOf(p.artifacts.location) : undefined;
    if (out) links.push({ from: key, to: s3Arn(region, out), kind: "writes", label: "artifacts", evidence: "project artifacts (S3)" });
    const repo = ecrRepoRef(p.environment?.image);
    if (repo) links.push({ from: key, to: repo, kind: "pulls", label: "build image", evidence: `environment image ${clip(p.environment!.image!, 200)}` });
    if (p.environment?.registryCredential?.credential) links.push({ from: key, to: p.environment.registryCredential.credential, kind: "reads", label: "registry credentials", evidence: "environment registryCredential" });
    const kms = kmsKeyRef(p.encryptionKey, region, account);
    if (kms) links.push({ from: kms, to: key, kind: "encrypts", label: "artifacts", evidence: "project encryptionKey" });
    mentions.push(...env.mentions);
  }
  return { resources, links, mentions };
}

// The panel: the latest builds, newest first (status, number, when, how long, who started it, the source version).
export function codebuildDetail(key: string, builds: RawBuild[] | undefined): ResourceDetail {
  if (!builds) return { key, sections: [{ title: "Builds", note: "The builds couldn't be read." }] };
  if (!builds.length) return { key, sections: [{ title: "Builds", note: "Never built." }] };
  const rows = [...builds].sort((a, b) => (awsTime(b.startTime) ?? 0) - (awsTime(a.startTime) ?? 0)).map((b) => {
    const start = awsTime(b.startTime);
    const end = awsTime(b.endTime);
    return [
      b.buildNumber !== undefined ? `#${b.buildNumber}` : (b.id ?? "").split(":").pop()?.slice(0, 8) ?? "", (b.buildStatus ?? "").toLowerCase().replace(/_/g, " "), fmtTime(start),
      start !== undefined && end !== undefined ? `${Math.max(1, Math.round((end - start) / 60_000))} min` : "—", clip(b.initiator ?? "", 60), (b.resolvedSourceVersion ?? b.sourceVersion ?? "").slice(0, 12),
    ];
  });
  return { key, sections: [{ title: `Builds (latest ${rows.length})`, table: { columns: ["Build", "Status", "Started", "Took", "Started by", "Source"], rows } }] };
}

// ---------- CodePipeline ----------

export interface RawAction {
  name?: string;
  actionTypeId?: { category?: string; owner?: string; provider?: string };
  configuration?: Record<string, string>;
  roleArn?: string;
  region?: string;
}
export interface RawPipeline {
  name?: string;
  roleArn?: string;
  pipelineType?: string;
  executionMode?: string;
  artifactStore?: { type?: string; location?: string; encryptionKey?: { id?: string } };
  artifactStores?: Record<string, { type?: string; location?: string; encryptionKey?: { id?: string } }>;
  stages?: { name?: string; actions?: RawAction[] }[];
}
export interface RawStageState {
  stageName?: string;
  inboundTransitionState?: { enabled?: boolean; disabledReason?: string };
  latestExecution?: { status?: string };
  actionStates?: { actionName?: string; latestExecution?: { status?: string; errorDetails?: { code?: string; message?: string } } }[];
}
export interface RawExecution { pipelineExecutionId?: string; status?: string; startTime?: When; lastUpdateTime?: When; sourceRevisions?: { actionName?: string; revisionId?: string; revisionSummary?: string }[]; trigger?: { triggerType?: string } }
export interface PipelineRaw {
  pipelines: { name?: string; created?: When; updated?: When; pipelineType?: string; arn?: string }[]; // ListPipelines (+ metadata.pipelineArn)
  declaration?: Record<string, Read<RawPipeline>>; // GetPipeline, by name
  state?: Record<string, Read<RawStageState[]>>; // GetPipelineState
  executions?: Record<string, Read<RawExecution[]>>; // ListPipelineExecutions (newest first)
  tags?: Record<string, Read<Tag[]>>;
}

// A run's source revision for people: the short commit id and its message. CodeStar connections (GitHub, Bitbucket,
// GitLab) send the summary as JSON ({"ProviderType":"GitHub","CommitMessage":"…"}); the first line of the message is kept.
export function revisionText(r: { revisionId?: string; revisionSummary?: string } | undefined, max: number): string | undefined {
  if (!r) return undefined;
  let summary = r.revisionSummary ?? "";
  if (summary.startsWith("{")) {
    try {
      const j = JSON.parse(summary) as { CommitMessage?: unknown };
      summary = typeof j.CommitMessage === "string" ? j.CommitMessage : "";
    } catch {
      // not JSON after all: shown as it is
    }
  }
  return clip(`${r.revisionId?.slice(0, 12) ?? ""} ${summary.split("\n")[0]}`.trim(), max) || undefined;
}

// Configuration keys whose values may be shown (they name things); every other value stays out of props.
const CONFIG_SHOWN = ["FullRepositoryId", "BranchName", "RepositoryName", "ImageTag", "ProjectName", "ClusterName", "ServiceName", "StackName", "ApplicationName", "DeploymentGroupName", "BucketName", "S3Bucket", "FunctionName", "Owner", "Repo", "Branch"];

// Links an action's configuration names, in the action's region.
export function actionLinks(from: string, a: RawAction, o: { region: string; account?: string; home: string }): Link[] {
  const c = a.configuration ?? {};
  const own = (k: string) => (Object.hasOwn(c, k) && typeof c[k] === "string" && c[k].trim() ? c[k].trim() : undefined);
  const region = a.region || o.region;
  const acct = o.account ?? "";
  const provider = a.actionTypeId?.provider ?? "";
  const category = a.actionTypeId?.category ?? "";
  const label = a.name;
  const ev = `action ${a.name} (${provider})`;
  const out: Link[] = [];
  if (provider === "CodeBuild" && own("ProjectName")) out.push({ from, to: arnOf.codebuildProject(region, acct, own("ProjectName")!), kind: "invoke", label, evidence: `${ev} ProjectName` });
  if (provider === "ECS" && own("ClusterName") && own("ServiceName"))
    out.push({ from, to: keys.ecsService(own("ClusterName")!, own("ServiceName")!, region, o.home), kind: "manages", label: "deploys", evidence: `${ev} ClusterName + ServiceName` });
  if ((provider === "CodeDeploy" || provider === "CodeDeployToECS") && own("ApplicationName") && own("DeploymentGroupName"))
    out.push({ from, to: arnOf.codedeployGroup(region, acct, own("ApplicationName")!, own("DeploymentGroupName")!), kind: "invoke", label: "deploys", evidence: `${ev} ApplicationName + DeploymentGroupName` });
  if (provider.startsWith("CloudFormation") && own("StackName")) out.push({ from, to: own("StackName")!, kind: "manages", label, evidence: `${ev} StackName` });
  if (provider === "S3" && category === "Deploy" && own("BucketName")) out.push({ from, to: s3Arn(region, own("BucketName")!), kind: "writes", label, evidence: `${ev} BucketName` });
  if (provider === "S3" && category === "Source" && own("S3Bucket")) out.push({ from, to: s3Arn(region, own("S3Bucket")!), kind: "reads", label: "source", evidence: `${ev} S3Bucket` });
  if (provider === "Lambda" && own("FunctionName")) out.push({ from, to: lambdaRef(own("FunctionName")!, region, acct, partitionOf(region)), kind: "invoke", label, evidence: `${ev} FunctionName` });
  if (provider === "ECR" && own("RepositoryName")) out.push({ from, to: arnOf.ecrRepository(region, acct, own("RepositoryName")!), kind: "pulls", label: "source image", evidence: `${ev} RepositoryName` });
  if (provider === "CodeCommit" && own("RepositoryName")) out.push({ from, to: `arn:${partitionOf(region)}:codecommit:${region}:${acct}:${own("RepositoryName")}`, kind: "reads", label: "source", evidence: `${ev} RepositoryName` });
  const role = roleRef(a.roleArn, o.account, region);
  if (role) out.push({ from, to: role, kind: "assumes", label, evidence: `${ev} roleArn` });
  return out;
}

// A CodeBuild action's EnvironmentVariables (a JSON list) → mentions; anything unparsable is dropped.
export function actionEnvMentions(from: string, a: RawAction): Mention[] {
  const raw = a.actionTypeId?.provider === "CodeBuild" && a.configuration && Object.hasOwn(a.configuration, "EnvironmentVariables") ? a.configuration.EnvironmentVariables : undefined;
  if (!raw) return [];
  try {
    const vars = JSON.parse(raw) as RawEnvVar[];
    return Array.isArray(vars) ? buildEnvMentions(from, vars.filter((v) => v && typeof v === "object"), `action ${a.name} env`).mentions : [];
  } catch {
    return [];
  }
}

export function pipelineHealth(state: RawStageState[] | undefined, executions: RawExecution[] | undefined, read: { state?: EnrichState; executions?: EnrichState }): { health: Health; reason?: string } {
  const latest = executions?.[0];
  const disabled = (state ?? []).filter((s) => s.inboundTransitionState && s.inboundTransitionState.enabled === false);
  if (latest?.status === "Failed") {
    const stage = (state ?? []).find((s) => s.latestExecution?.status === "Failed");
    const action = stage?.actionStates?.find((x) => x.latestExecution?.status === "Failed");
    const msg = action?.latestExecution?.errorDetails?.message;
    return { health: "error", reason: `last run failed${stage?.stageName ? ` in ${stage.stageName}` : ""}${action?.actionName ? `/${action.actionName}` : ""}${msg ? `: ${clip(msg, 160)}` : ""} (${fmtTime(awsTime(latest.startTime))})` };
  }
  if (disabled.length)
    return { health: "warning", reason: `transition into ${disabled.map((s) => s.stageName).join(", ")} disabled${disabled[0].inboundTransitionState?.disabledReason ? `: ${clip(disabled[0].inboundTransitionState.disabledReason, 120)}` : ""}` };
  if (!latest) return executions ? { health: "unknown", reason: "never run" } : { health: "unknown", reason: unread("executions", read.executions) };
  if (latest.status === "InProgress") return { health: "ok", reason: "running" };
  return { health: "ok" };
}

export function pipelineResults(raw: PipelineRaw, o: CicdOptions): ProviderResult {
  const resources: Resource[] = [];
  const links: Link[] = [];
  const mentions: Mention[] = [];
  const home = o.home ?? o.region;
  for (const p of raw.pipelines) {
    if (!p.name) continue;
    const key = p.arn ?? arnOf.pipeline(o.region, o.accountId ?? "", p.name);
    const region = key.split(":")[3] || o.region;
    const account = key.split(":")[4] || o.accountId;
    const decl = raw.declaration?.[p.name];
    const st = raw.state?.[p.name];
    const ex = raw.executions?.[p.name];
    const tg = raw.tags?.[p.name];
    const d = decl?.value;
    const { health, reason } = pipelineHealth(st?.value, ex?.value, { state: st?.state, executions: ex?.state });
    const latest = ex?.value?.[0];
    const created = awsTime(p.created);
    const actions = (d?.stages ?? []).flatMap((s) => s.actions ?? []);
    const source = actions.find((a) => a.actionTypeId?.category === "Source");
    const conf = (a: RawAction | undefined, k: string) => (CONFIG_SHOWN.includes(k) && a?.configuration && Object.hasOwn(a.configuration, k) ? a.configuration[k] : undefined);
    const enrichment = enrichmentOf({ declaration: decl?.state, state: st?.state, executions: ex?.state, tags: tg?.state });
    const started = awsTime(latest?.startTime);
    resources.push({
      key, kind: "pipeline", provider: "codepipeline", name: p.name, region,
      ...tagsOf(tg?.state === "ok" ? tagList(tg.value ?? []) : undefined),
      health, ...(reason ? { healthReason: reason } : {}), ...(enrichment ? { enrichment } : {}),
      props: props([
        { label: "Last run", value: latest ? `${(latest.status ?? "").toLowerCase()} · ${fmtTime(started)}${latest.trigger?.triggerType ? ` · ${latest.trigger.triggerType}` : ""}` : ex?.state === "ok" ? "never run" : undefined },
        { label: "Revision", value: revisionText(latest?.sourceRevisions?.[0], 120) },
        { label: "Stages", value: d?.stages?.length ? clip(d.stages.map((s) => `${s.name} (${(s.actions ?? []).map((a) => a.actionTypeId?.provider).filter(Boolean).join(", ")})`).join(" → "), 240) : undefined },
        { label: "Source", value: source ? clip([conf(source, "FullRepositoryId") ?? conf(source, "RepositoryName") ?? conf(source, "S3Bucket") ?? (conf(source, "Owner") && `${conf(source, "Owner")}/${conf(source, "Repo")}`), conf(source, "BranchName") ?? conf(source, "Branch") ?? conf(source, "ImageTag")].filter(Boolean).join(" @ "), 160) : undefined },
        { label: "Type", value: d?.pipelineType ?? p.pipelineType },
        { label: "Execution mode", value: d?.executionMode?.toLowerCase() },
        { label: "Created", value: created !== undefined ? fmtTime(created) : undefined },
      ]),
      aliases: [p.name],
      consoleUrl: `https://${region}.console.aws.amazon.com/codesuite/codepipeline/pipelines/${encodeURIComponent(p.name)}/view?region=${region}`,
      ...(created !== undefined ? { createdAt: created } : {}), ...(awsTime(p.updated) !== undefined ? { lastModified: awsTime(p.updated) } : {}),
      ...(started !== undefined ? { lastActivityAt: started } : ex?.state === "ok" && !ex.value?.length && created !== undefined ? { lastActivityAt: created } : {}),
      ...(o.now ? { observedAt: o.now } : {}),
    });
    if (!d) continue;
    const role = roleRef(d.roleArn, account, region);
    if (role) links.push({ from: key, to: role, kind: "assumes", label: "pipeline role", evidence: "pipeline roleArn" });
    const stores = [...(d.artifactStore ? [[region, d.artifactStore] as const] : []), ...Object.entries(d.artifactStores ?? {})];
    for (const [r, s] of stores) {
      if (s.type === "S3" && s.location) links.push({ from: key, to: s3Arn(r, s.location), kind: "writes", label: "artifacts", evidence: "pipeline artifactStore" });
      const kms = kmsKeyRef(s.encryptionKey?.id, r, account);
      if (kms) links.push({ from: kms, to: key, kind: "encrypts", label: "artifacts", evidence: "pipeline artifactStore encryptionKey" });
    }
    const seen = new Set<string>();
    for (const a of actions) {
      for (const l of actionLinks(key, a, { region, account, home })) {
        const id = `${l.to} ${l.kind}`;
        if (!seen.has(id)) links.push(l);
        seen.add(id);
      }
      mentions.push(...actionEnvMentions(key, a));
    }
  }
  return { resources, links, mentions };
}

// ---------- CodeDeploy ----------

export interface RawDeploymentInfo { deploymentId?: string; status?: string; createTime?: When; endTime?: When }
export interface RawDeploymentGroup {
  applicationName?: string;
  deploymentGroupName?: string;
  deploymentConfigName?: string;
  serviceRoleArn?: string;
  computePlatform?: string; // Server | Lambda | ECS
  deploymentStyle?: { deploymentType?: string; deploymentOption?: string };
  ec2TagFilters?: { Key?: string; Value?: string; Type?: string }[];
  autoScalingGroups?: { name?: string }[];
  ecsServices?: { serviceName?: string; clusterName?: string }[];
  loadBalancerInfo?: { targetGroupInfoList?: { name?: string }[]; targetGroupPairInfoList?: { targetGroups?: { name?: string }[] }[]; elbInfoList?: { name?: string }[] };
  lastAttemptedDeployment?: RawDeploymentInfo;
  lastSuccessfulDeployment?: RawDeploymentInfo;
  triggerConfigurations?: { triggerName?: string; triggerTargetArn?: string }[];
  alarmConfiguration?: { enabled?: boolean; alarms?: { name?: string }[] };
}
export interface CodeDeployRaw { groups: RawDeploymentGroup[]; tags?: Record<string, Read<{ Key?: string; Value?: string }[]>> } // tags by group ARN

const deployWhen = (d: RawDeploymentInfo | undefined) => awsTime(d?.endTime) ?? awsTime(d?.createTime);

export function deployHealth(g: Pick<RawDeploymentGroup, "lastAttemptedDeployment" | "lastSuccessfulDeployment">): { health: Health; reason?: string } {
  const last = g.lastAttemptedDeployment;
  if (!last?.status) return { health: "unknown", reason: "never deployed" };
  const id = last.deploymentId ? ` ${last.deploymentId}` : "";
  const ok = g.lastSuccessfulDeployment && g.lastSuccessfulDeployment.deploymentId !== last.deploymentId ? `; last success ${fmtTime(deployWhen(g.lastSuccessfulDeployment))}` : "";
  switch (last.status) {
    case "Failed":
      return { health: "error", reason: `last deployment${id} failed (${fmtTime(deployWhen(last))})${ok}` };
    case "Stopped":
      return { health: "warning", reason: `last deployment${id} was stopped${ok}` };
    case "Ready":
      return { health: "ok", reason: "waiting for traffic shift" };
    case "InProgress":
    case "Created":
    case "Queued":
    case "Baking":
      return { health: "ok", reason: "deploying" };
    case "Succeeded":
      return { health: "ok" };
    default:
      return { health: "unknown", reason: `last deployment ${last.status.toLowerCase()}` };
  }
}

export const codedeployKey = (region: string, account: string | undefined, app: string, group: string) => arnOf.codedeployGroup(region, account ?? "", app, group);

export function codedeployResults(raw: CodeDeployRaw, o: CicdOptions): ProviderResult {
  const resources: Resource[] = [];
  const links: Link[] = [];
  const home = o.home ?? o.region;
  for (const g of raw.groups) {
    if (!g.applicationName || !g.deploymentGroupName) continue;
    const key = codedeployKey(o.region, o.accountId, g.applicationName, g.deploymentGroupName);
    const { health, reason } = deployHealth(g);
    const tg = raw.tags?.[key];
    const ecs = (g.ecsServices ?? []).filter((s) => s.clusterName && s.serviceName);
    const asgs = (g.autoScalingGroups ?? []).map((x) => x.name).filter((x): x is string => !!x);
    const tagFilters = (g.ec2TagFilters ?? []).map((f) => (f.Type === "KEY_ONLY" ? f.Key : f.Type === "VALUE_ONLY" ? `*=${f.Value}` : `${f.Key}=${f.Value}`)).filter(Boolean);
    const targetGroups = [...(g.loadBalancerInfo?.targetGroupInfoList ?? []), ...(g.loadBalancerInfo?.targetGroupPairInfoList ?? []).flatMap((x) => x.targetGroups ?? []), ...(g.loadBalancerInfo?.elbInfoList ?? [])].map((x) => x.name).filter(Boolean);
    const last = deployWhen(g.lastAttemptedDeployment);
    const enrichment = enrichmentOf({ tags: tg?.state });
    resources.push({
      key, kind: "codedeploy-group", provider: "codedeploy", name: g.deploymentGroupName, region: o.region,
      ...tagsOf(tg?.state === "ok" ? tg.value ?? [] : undefined),
      health, ...(reason ? { healthReason: reason } : {}), ...(enrichment ? { enrichment } : {}),
      props: props([
        { label: "Application", value: g.applicationName },
        { label: "Compute platform", value: g.computePlatform },
        { label: "Deployment type", value: g.deploymentStyle?.deploymentType ? `${g.deploymentStyle.deploymentType.toLowerCase().replace(/_/g, " ")}${g.deploymentStyle.deploymentOption === "WITH_TRAFFIC_CONTROL" ? ", with traffic control" : ""}` : undefined },
        { label: "Deployment config", value: g.deploymentConfigName },
        { label: "Targets", value: clip([...ecs.map((s) => `ECS ${s.clusterName}/${s.serviceName}`), ...asgs.map((n) => `Auto Scaling ${n}`), ...(tagFilters.length ? [`EC2 tags ${tagFilters.join(", ")}`] : [])].join("; "), 240) || undefined },
        { label: "Target groups", value: targetGroups.length ? clip(targetGroups.join(", "), 160) : undefined },
        { label: "Last deployment", value: g.lastAttemptedDeployment?.status ? `${g.lastAttemptedDeployment.status.toLowerCase()} · ${fmtTime(last)}` : "never deployed" },
        { label: "Last success", value: g.lastSuccessfulDeployment ? fmtTime(deployWhen(g.lastSuccessfulDeployment)) : undefined },
        { label: "Rollback alarms", value: g.alarmConfiguration?.enabled ? clip((g.alarmConfiguration.alarms ?? []).map((a) => a.name).join(", "), 160) : undefined },
      ]),
      aliases: [g.deploymentGroupName, `${g.applicationName}/${g.deploymentGroupName}`],
      consoleUrl: `https://${o.region}.console.aws.amazon.com/codesuite/codedeploy/applications/${encodeURIComponent(g.applicationName)}/deployment-groups/${encodeURIComponent(g.deploymentGroupName)}?region=${o.region}`,
      ...(last !== undefined ? { lastActivityAt: last } : {}), ...(o.now ? { observedAt: o.now } : {}),
    });
    for (const s of ecs)
      links.push({ from: key, to: keys.ecsService(s.clusterName!, s.serviceName!, o.region, home), kind: "manages", label: "blue/green", evidence: "deployment group ecsServices" });
    for (const n of asgs) links.push({ from: key, to: n, kind: "manages", label: "deploys", evidence: "deployment group autoScalingGroups" });
    const role = roleRef(g.serviceRoleArn, o.accountId, o.region);
    if (role) links.push({ from: key, to: role, kind: "assumes", label: "service role", evidence: "deployment group serviceRoleArn" });
    for (const t of g.triggerConfigurations ?? []) if (t.triggerTargetArn) links.push({ from: key, to: t.triggerTargetArn, kind: "event", label: t.triggerName ?? "deployment events", evidence: "deployment group triggerConfigurations" });
  }
  return { resources, links, mentions: [] };
}

// The panel: the latest deployments (BatchGetDeployments, at most 25), newest first.
export interface RawDeployment { deploymentId?: string; status?: string; createTime?: When; completeTime?: When; creator?: string; errorInformation?: { code?: string; message?: string }; description?: string }
export function codedeployDetail(key: string, deployments: RawDeployment[] | undefined): ResourceDetail {
  if (!deployments) return { key, sections: [{ title: "Deployments", note: "The deployments couldn't be read." }] };
  if (!deployments.length) return { key, sections: [{ title: "Deployments", note: "No deployments yet." }] };
  const rows = [...deployments].sort((a, b) => (awsTime(b.createTime) ?? 0) - (awsTime(a.createTime) ?? 0)).map((d) => [
    d.deploymentId ?? "", (d.status ?? "").toLowerCase(), fmtTime(awsTime(d.createTime)), d.completeTime ? fmtTime(awsTime(d.completeTime)) : "—", d.creator ?? "",
    d.errorInformation?.message ? clip(`${d.errorInformation.code ? `${d.errorInformation.code}: ` : ""}${d.errorInformation.message}`, 200) : "",
  ]);
  return { key, sections: [{ title: `Deployments (latest ${rows.length})`, table: { columns: ["Deployment", "Status", "Created", "Completed", "Started by", "Error"], rows } }] };
}

// The pipeline panel: the latest runs.
export function pipelineDetail(key: string, executions: RawExecution[] | undefined, state: RawStageState[] | undefined): ResourceDetail {
  return {
    key,
    sections: [
      ...(state?.length
        ? [{ title: "Stages", table: { columns: ["Stage", "Latest", "Transition in"], rows: state.map((s) => [s.stageName ?? "", (s.latestExecution?.status ?? "—").toLowerCase(), s.inboundTransitionState?.enabled === false ? `disabled${s.inboundTransitionState.disabledReason ? `: ${clip(s.inboundTransitionState.disabledReason, 80)}` : ""}` : "enabled"]) } }]
        : []),
      executions === undefined
        ? { title: "Runs", note: "The runs couldn't be read." }
        : executions.length
          ? { title: `Runs (latest ${executions.length})`, table: { columns: ["Run", "Status", "Started", "Trigger", "Revision"], rows: executions.map((e) => [(e.pipelineExecutionId ?? "").slice(0, 8), (e.status ?? "").toLowerCase(), fmtTime(awsTime(e.startTime)), e.trigger?.triggerType ?? "", revisionText(e.sourceRevisions?.[0], 80) ?? ""]) } }
          : { title: "Runs", note: "Never run." },
    ],
  };
}
