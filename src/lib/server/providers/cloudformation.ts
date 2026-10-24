// CloudFormation provider (audit §6 A.2 #22): every stack in the region (DescribeStacks — it leaves deleted stacks out)
// with its status, drift, parameter keys and safe outputs, handed to ctx.checkpoint, then the resources of the first 50
// stacks within the time budget (ListStackResources, R18) for `manages` edges to what CloudFormation can't tag. Tag-based
// stack → resource edges are drawn by the inventory rules from aws:cloudformation:stack-id, at no API cost. The panel
// adds the stack's resources and recent events (DescribeStackEvents). Never GetTemplate or GetResource: templates and
// resource properties may hold secrets. Read-only: no actions. The mapping is pure (../../inventory/cloudformation.ts).
import "server-only";
import { CloudFormationClient, DescribeStackEventsCommand, DescribeStacksCommand, ListStackResourcesCommand, type StackResourceSummary } from "@aws-sdk/client-cloudformation";
import { parseArn } from "../../inventory/arn.ts";
import { cfnDetail, cfnResults, type CfnRaw, type RawStack, type RawStackEvent, type RawStackResource } from "../../inventory/cloudformation.ts";
import { simStackEvents, simStackResources, simStacks } from "./mock/cloudformation.ts";
import { budget, enrich, paged, perRegion, sdkConfig, softly, t } from "./serverless-util.ts";
import type { Provider, ProviderContext } from "./types.ts";

const cfn = perRegion((r) => new CloudFormationClient(sdkConfig(r)), "cloudformation");
const RESOURCE_STACKS = 50; // stacks whose resources are listed (A.2 #22)
const RESOURCE_PAGES = 5; // ListStackResources answers 100 per page: up to 500 resources per stack

const summary = (x: StackResourceSummary): RawStackResource => ({
  LogicalResourceId: x.LogicalResourceId, PhysicalResourceId: x.PhysicalResourceId, ResourceType: x.ResourceType, ResourceStatus: x.ResourceStatus,
  ResourceStatusReason: x.ResourceStatusReason, LastUpdatedTimestamp: x.LastUpdatedTimestamp,
});

async function stackResources(ctx: { signal?: AbortSignal }, region: string, StackName: string): Promise<RawStackResource[]> {
  const out: RawStackResource[] = [];
  let NextToken: string | undefined;
  for (let i = 0; i < RESOURCE_PAGES; i++) {
    const r = await cfn(region).send(new ListStackResourcesCommand({ StackName, NextToken }), t(ctx));
    out.push(...(r.StackResourceSummaries ?? []).map(summary));
    NextToken = r.NextToken;
    if (!NextToken || ctx.signal?.aborted) break;
  }
  return out;
}

async function realStacks(ctx: ProviderContext): Promise<CfnRaw> {
  const stacks = (await paged(ctx, "cloudformation stacks", async (NextToken) => {
    const r = await cfn(ctx.region).send(new DescribeStacksCommand({ NextToken }), t(ctx));
    return { items: r.Stacks as RawStack[] | undefined, next: r.NextToken };
  }, { service: "cloudformation" })).filter((s) => s.StackId && s.StackStatus !== "DELETE_COMPLETE");
  const o = { region: ctx.region, accountId: ctx.accountId, home: ctx.home, now: Date.now() };
  ctx.checkpoint?.(cfnResults({ stacks }, o));
  const res = await enrich(ctx, stacks, { label: "cloudformation: stack resources", max: RESOURCE_STACKS, until: budget(), concurrency: 2 }, (s) => stackResources(ctx, ctx.region, s.StackId!));
  return { stacks, resources: Object.fromEntries(stacks.map((s, i) => [s.StackId!, { ...(res.results[i] ? { value: res.results[i] } : {}), state: res.state[i] }])) };
}

function simRaw(region: string, now: number): CfnRaw {
  const stacks = simStacks(region, now);
  return { stacks, resources: Object.fromEntries(stacks.map((s) => [s.StackId!, { value: simStackResources(region, s.StackId!), state: "ok" as const }])) };
}

export const cloudformationProvider: Provider = {
  id: "cloudformation",
  label: "CloudFormation",
  kinds: ["cfn-stack"],
  scope: "regional",
  covers: ["cloudformation:stack"],
  ttlMs: 10 * 60_000,
  multiRegionMock: true,
  read: ["cloudformation:DescribeStacks", "cloudformation:ListStackResources", "cloudformation:DescribeStackEvents"],
  // DescribeStacks without a StackName (the listing) is authorized as cloudformation:ListStacks.
  implicit: ["cloudformation:ListStacks"],
  async discover(ctx) {
    const o = { region: ctx.region, accountId: ctx.accountId, home: ctx.home, now: Date.now() };
    return cfnResults(ctx.mock ? simRaw(ctx.region, o.now) : await realStacks(ctx), o);
  },
  // The stack as it is now, its resources and its 25 latest events (never resource properties or the template).
  async detail(r, ctx) {
    const region = parseArn(r.key)?.region || ctx.region;
    if (ctx.mock) return cfnDetail(r.key, simStacks(region).find((s) => s.StackId === r.key), simStackResources(region, r.key), simStackEvents(region, r.key));
    const soft = softly(ctx, "cloudformation", { service: "cloudformation" });
    const [stack, resources, events] = await Promise.all([
      soft(async () => (await cfn(region).send(new DescribeStacksCommand({ StackName: r.key }), t(ctx))).Stacks?.[0] as RawStack | undefined),
      soft(() => stackResources(ctx, region, r.key)),
      soft(async () => ((await cfn(region).send(new DescribeStackEventsCommand({ StackName: r.key }), t(ctx))).StackEvents ?? []).map((e): RawStackEvent => ({
        Timestamp: e.Timestamp, LogicalResourceId: e.LogicalResourceId, ResourceType: e.ResourceType, ResourceStatus: e.ResourceStatus, ResourceStatusReason: e.ResourceStatusReason,
      }))),
    ]);
    return cfnDetail(r.key, stack, resources, events);
  },
};
