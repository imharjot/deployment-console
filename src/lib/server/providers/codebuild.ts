// CodeBuild provider (audit §6 A.2 #20): every project in the region (ListProjects, then BatchGetProjects 100 at a time —
// the tags come with it), handed to ctx.checkpoint, then the latest build of the first 200 projects within the time
// budget (ListBuildsForProject newest first, one page; BatchGetBuilds 100 at a time, R18); the panel lists the latest
// 10. PLAINTEXT environment values become Mention.refs only; Parameter Store and Secrets Manager references become
// mentions (`reads`); the webhook secret and the buildspec are never read into props. Idle from the Builds metric
// (required, R20). Read-only: no actions. The mapping is pure (../../inventory/cicd.ts).
import "server-only";
import { BatchGetBuildsCommand, BatchGetProjectsCommand, CodeBuildClient, ListBuildsForProjectCommand, ListProjectsCommand, type Build, type Project } from "@aws-sdk/client-codebuild";
import { parseArn } from "../../inventory/arn.ts";
import { codebuildDetail, codebuildResults, type CodeBuildRaw, type RawBuild, type RawProject } from "../../inventory/cicd.ts";
import { simBuilds, simCodeBuild } from "./mock/codebuild.ts";
import { budget, enrich, paged, perRegion, sdkConfig, softly, t } from "./serverless-util.ts";
import type { Provider, ProviderContext } from "./types.ts";

const cb = perRegion((r) => new CodeBuildClient(sdkConfig(r)), "codebuild");
const BATCH = 100; // BatchGetProjects / BatchGetBuilds
const BUILD_READS = 200; // projects whose latest build is read
const DETAIL_BUILDS = 10;

const chunk = <T,>(a: T[], n: number) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));

// Only the fields the mapper reads: the webhook (its secret), buildspec and source auth stay behind.
const project = (p: Project): RawProject => ({
  name: p.name, arn: p.arn, description: p.description, serviceRole: p.serviceRole, created: p.created, lastModified: p.lastModified, encryptionKey: p.encryptionKey,
  timeoutInMinutes: p.timeoutInMinutes, concurrentBuildLimit: p.concurrentBuildLimit,
  source: p.source ? { type: p.source.type, location: p.source.location } : undefined,
  secondarySources: p.secondarySources?.map((s) => ({ type: s.type, location: s.location })),
  artifacts: p.artifacts ? { type: p.artifacts.type, location: p.artifacts.location } : undefined,
  environment: p.environment
    ? {
        type: p.environment.type, image: p.environment.image, computeType: p.environment.computeType, privilegedMode: p.environment.privilegedMode,
        environmentVariables: p.environment.environmentVariables?.map((v) => ({ name: v.name, value: v.value, type: v.type })),
        registryCredential: p.environment.registryCredential ? { credential: p.environment.registryCredential.credential } : undefined,
      }
    : undefined,
  logsConfig: p.logsConfig
    ? { cloudWatchLogs: p.logsConfig.cloudWatchLogs ? { status: p.logsConfig.cloudWatchLogs.status, groupName: p.logsConfig.cloudWatchLogs.groupName } : undefined, s3Logs: p.logsConfig.s3Logs ? { status: p.logsConfig.s3Logs.status, location: p.logsConfig.s3Logs.location } : undefined }
    : undefined,
  vpcConfig: p.vpcConfig ? { vpcId: p.vpcConfig.vpcId, subnets: p.vpcConfig.subnets, securityGroupIds: p.vpcConfig.securityGroupIds } : undefined,
  webhook: p.webhook ? { branchFilter: p.webhook.branchFilter, filterGroups: p.webhook.filterGroups } : undefined,
  tags: p.tags?.map((x) => ({ key: x.key, value: x.value })),
});
const build = (b: Build): RawBuild => ({
  id: b.id, buildNumber: b.buildNumber, buildStatus: b.buildStatus, startTime: b.startTime, endTime: b.endTime, currentPhase: b.currentPhase,
  sourceVersion: b.sourceVersion, resolvedSourceVersion: b.resolvedSourceVersion, initiator: b.initiator,
});

async function realCodeBuild(ctx: ProviderContext): Promise<CodeBuildRaw> {
  const c = cb(ctx.region);
  const names = await paged(ctx, "codebuild projects", async (nextToken) => {
    const r = await c.send(new ListProjectsCommand({ sortBy: "NAME", nextToken }), t(ctx));
    return { items: r.projects, next: r.nextToken };
  }, { service: "codebuild" });
  const projects: RawProject[] = [];
  for (const names100 of chunk(names, BATCH)) {
    if (ctx.signal.aborted) break;
    const r = await ctx.limit(() => c.send(new BatchGetProjectsCommand({ names: names100 }), t(ctx)), { service: "codebuild" });
    projects.push(...(r.projects ?? []).map(project));
  }
  const o = { region: ctx.region, accountId: ctx.accountId, home: ctx.home, now: Date.now() };
  ctx.checkpoint?.(codebuildResults({ projects }, o));

  // The newest build id per project (one page, newest first), then those builds in batches of 100.
  const until = budget();
  const ids = await enrich(ctx, projects, { label: "codebuild: latest builds", max: BUILD_READS, until }, async (p) =>
    (await c.send(new ListBuildsForProjectCommand({ projectName: p.name, sortOrder: "DESCENDING" }), t(ctx))).ids?.[0] ?? null);
  const wanted = ids.results.filter((x): x is string => typeof x === "string");
  const builds = new Map<string, RawBuild>();
  const soft = softly(ctx, "codebuild: builds", { service: "codebuild", until });
  for (const batch of chunk(wanted, BATCH)) {
    const r = await soft(() => c.send(new BatchGetBuildsCommand({ ids: batch }), t(ctx)));
    for (const b of r?.builds ?? []) if (b.id) builds.set(b.id, build(b));
  }
  const lastBuild: CodeBuildRaw["lastBuild"] = {};
  projects.forEach((p, i) => {
    const id = ids.results[i];
    const state = ids.state[i];
    if (!p.name) return;
    if (state !== "ok") lastBuild[p.name] = { state };
    else if (id === null || id === undefined) lastBuild[p.name] = { value: null, state };
    else lastBuild[p.name] = builds.has(id) ? { value: builds.get(id)!, state } : { state: "skipped" };
  });
  return { projects, lastBuild };
}

export const codebuildProvider: Provider = {
  id: "codebuild",
  label: "CodeBuild",
  kinds: ["codebuild-project"],
  scope: "regional",
  covers: ["codebuild:project"],
  ttlMs: 5 * 60_000,
  multiRegionMock: true,
  read: ["codebuild:ListProjects", "codebuild:BatchGetProjects", "codebuild:ListBuildsForProject", "codebuild:BatchGetBuilds"],
  async discover(ctx) {
    const o = { region: ctx.region, accountId: ctx.accountId, home: ctx.home, now: Date.now() };
    return codebuildResults(ctx.mock ? simCodeBuild(ctx.region, o.now) : await realCodeBuild(ctx), o);
  },
  // The latest 10 builds (one ListBuildsForProject page, then BatchGetBuilds).
  async detail(r, ctx) {
    const region = parseArn(r.key)?.region || ctx.region;
    if (ctx.mock) return codebuildDetail(r.key, simBuilds(region, r.name));
    const soft = softly(ctx, "codebuild builds", { service: "codebuild" });
    const builds = await soft(async () => {
      const c = cb(region);
      const ids = ((await c.send(new ListBuildsForProjectCommand({ projectName: r.name, sortOrder: "DESCENDING" }), t(ctx))).ids ?? []).slice(0, DETAIL_BUILDS);
      return ids.length ? ((await c.send(new BatchGetBuildsCommand({ ids }), t(ctx))).builds ?? []).map(build) : [];
    });
    return codebuildDetail(r.key, builds);
  },
  activity: (r) => [{ namespace: "AWS/CodeBuild", metric: "Builds", dims: { ProjectName: r.name }, stat: "Sum", label: "builds", region: parseArn(r.key)?.region || undefined, required: true }],
};
