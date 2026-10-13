// CodeDeploy provider (audit §6 A.2 #21, CC-19): every deployment group in the region — ListApplications, then per
// application ListDeploymentGroups and BatchGetDeploymentGroups (100 at a time) — handed to ctx.checkpoint, then tags
// (first 200 groups, within the time budget, R18). Health comes from lastAttemptedDeployment / lastSuccessfulDeployment
// in that answer, so no deployment is read during discovery; the panel lists the latest 25 (ListDeployments +
// BatchGetDeployments, 25 at most). ECS blue/green groups `manage` their ECS services. Read-only: no actions. The mapping
// is pure (../../inventory/cicd.ts).
import "server-only";
import {
  BatchGetDeploymentGroupsCommand, BatchGetDeploymentsCommand, CodeDeployClient, ListApplicationsCommand, ListDeploymentGroupsCommand, ListDeploymentsCommand,
  ListTagsForResourceCommand, type DeploymentGroupInfo,
} from "@aws-sdk/client-codedeploy";
import { parseArn } from "../../inventory/arn.ts";
import { codedeployDetail, codedeployKey, codedeployResults, type CodeDeployRaw, type RawDeployment, type RawDeploymentGroup } from "../../inventory/cicd.ts";
import { simCodeDeploy, simDeployments } from "./mock/codedeploy.ts";
import { budget, enrich, paged, perRegion, sdkConfig, softly, t } from "./serverless-util.ts";
import type { Provider, ProviderContext } from "./types.ts";

const cd = perRegion((r) => new CodeDeployClient(sdkConfig(r)), "codedeploy");
const GROUPS_BATCH = 100; // BatchGetDeploymentGroups
const DEPLOYMENTS_BATCH = 25; // BatchGetDeployments (A.0.a)
const TAG_READS = 200;

const chunk = <T,>(a: T[], n: number) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));
const info = (d: { deploymentId?: string; status?: string; createTime?: Date; endTime?: Date } | undefined) =>
  d ? { deploymentId: d.deploymentId, status: d.status, createTime: d.createTime, endTime: d.endTime } : undefined;
const group = (g: DeploymentGroupInfo): RawDeploymentGroup => ({
  applicationName: g.applicationName, deploymentGroupName: g.deploymentGroupName, deploymentConfigName: g.deploymentConfigName, serviceRoleArn: g.serviceRoleArn,
  computePlatform: g.computePlatform, deploymentStyle: g.deploymentStyle ? { deploymentType: g.deploymentStyle.deploymentType, deploymentOption: g.deploymentStyle.deploymentOption } : undefined,
  ec2TagFilters: g.ec2TagFilters?.map((f) => ({ Key: f.Key, Value: f.Value, Type: f.Type })),
  autoScalingGroups: g.autoScalingGroups?.map((a) => ({ name: a.name })),
  ecsServices: g.ecsServices?.map((s) => ({ serviceName: s.serviceName, clusterName: s.clusterName })),
  loadBalancerInfo: g.loadBalancerInfo
    ? {
        targetGroupInfoList: g.loadBalancerInfo.targetGroupInfoList?.map((x) => ({ name: x.name })),
        targetGroupPairInfoList: g.loadBalancerInfo.targetGroupPairInfoList?.map((p) => ({ targetGroups: p.targetGroups?.map((x) => ({ name: x.name })) })),
        elbInfoList: g.loadBalancerInfo.elbInfoList?.map((x) => ({ name: x.name })),
      }
    : undefined,
  lastAttemptedDeployment: info(g.lastAttemptedDeployment), lastSuccessfulDeployment: info(g.lastSuccessfulDeployment),
  triggerConfigurations: g.triggerConfigurations?.map((x) => ({ triggerName: x.triggerName, triggerTargetArn: x.triggerTargetArn })),
  alarmConfiguration: g.alarmConfiguration ? { enabled: g.alarmConfiguration.enabled, alarms: g.alarmConfiguration.alarms?.map((a) => ({ name: a.name })) } : undefined,
});

async function realGroups(ctx: ProviderContext): Promise<CodeDeployRaw> {
  const c = cd(ctx.region);
  const apps = await paged(ctx, "codedeploy applications", async (nextToken) => {
    const r = await c.send(new ListApplicationsCommand({ nextToken }), t(ctx));
    return { items: r.applications, next: r.nextToken };
  }, { service: "codedeploy" });
  const groups = (
    await Promise.all(
      apps.map(async (applicationName) => {
        const names = await paged(ctx, `codedeploy groups of ${applicationName}`, async (nextToken) => {
          const r = await c.send(new ListDeploymentGroupsCommand({ applicationName, nextToken }), t(ctx));
          return { items: r.deploymentGroups, next: r.nextToken };
        }, { service: "codedeploy" });
        const out: RawDeploymentGroup[] = [];
        for (const deploymentGroupNames of chunk(names, GROUPS_BATCH)) {
          const r = await ctx.limit(() => c.send(new BatchGetDeploymentGroupsCommand({ applicationName, deploymentGroupNames }), t(ctx)), { service: "codedeploy" });
          out.push(...(r.deploymentGroupsInfo ?? []).map(group));
        }
        return out;
      }),
    )
  ).flat();
  const o = { region: ctx.region, accountId: ctx.accountId, home: ctx.home, now: Date.now() };
  ctx.checkpoint?.(codedeployResults({ groups }, o));
  const arns = groups.map((g) => codedeployKey(ctx.region, ctx.accountId, g.applicationName!, g.deploymentGroupName!));
  const tags = ctx.accountId
    ? await enrich(ctx, arns, { label: "codedeploy: tags", max: TAG_READS, until: budget() }, async (ResourceArn) => (await c.send(new ListTagsForResourceCommand({ ResourceArn }), t(ctx))).Tags ?? [])
    : { results: [], state: [] };
  return { groups, tags: Object.fromEntries(arns.map((a, i) => [a, { ...(tags.results[i] ? { value: tags.results[i] } : {}), state: tags.state[i] ?? "skipped" }])) };
}

async function latestDeployments(ctx: ProviderContext, region: string, applicationName: string, deploymentGroupName: string): Promise<RawDeployment[]> {
  const c = cd(region);
  const ids = ((await c.send(new ListDeploymentsCommand({ applicationName, deploymentGroupName }), t(ctx))).deployments ?? []).slice(0, DEPLOYMENTS_BATCH);
  if (!ids.length) return [];
  const r = await c.send(new BatchGetDeploymentsCommand({ deploymentIds: ids }), t(ctx));
  return (r.deploymentsInfo ?? []).map((d) => ({
    deploymentId: d.deploymentId, status: d.status, createTime: d.createTime, completeTime: d.completeTime, creator: d.creator,
    errorInformation: d.errorInformation ? { code: d.errorInformation.code, message: d.errorInformation.message } : undefined,
  }));
}

export const codedeployProvider: Provider = {
  id: "codedeploy",
  label: "CodeDeploy",
  kinds: ["codedeploy-group"],
  scope: "regional",
  covers: ["codedeploy:application"],
  ttlMs: 5 * 60_000,
  multiRegionMock: true,
  read: [
    "codedeploy:ListApplications", "codedeploy:ListDeploymentGroups", "codedeploy:BatchGetDeploymentGroups", "codedeploy:ListTagsForResource",
    "codedeploy:ListDeployments", "codedeploy:BatchGetDeployments",
  ],
  async discover(ctx) {
    const o = { region: ctx.region, accountId: ctx.accountId, home: ctx.home, now: Date.now() };
    return codedeployResults(ctx.mock ? simCodeDeploy(ctx.region, o.now) : await realGroups(ctx), o);
  },
  // The latest 25 deployments of the group, newest first.
  async detail(r, ctx) {
    const p = parseArn(r.key);
    const region = p?.region || ctx.region;
    const [app, name] = (p?.id ?? "").split("/");
    if (ctx.mock) return codedeployDetail(r.key, simDeployments(region, name ?? r.name));
    const soft = softly(ctx, "codedeploy deployments", { service: "codedeploy" });
    return codedeployDetail(r.key, app && name ? await soft(() => latestDeployments(ctx, region, app, name)) : undefined);
  },
};
