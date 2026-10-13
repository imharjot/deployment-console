// EC2 Auto Scaling groups, per region: size, members (→ their EC2 instances), launch template, target groups (as
// mentions, resolved to load balancers by the inventory) and health. One action: set the desired capacity within the
// group's own min..max, refused for groups EKS or Elastic Beanstalk own (their own scaling controls would undo it); the
// group's tags are read live before it (R01).
import "server-only";
import {
  AutoScalingClient, DescribeAutoScalingGroupsCommand, DescribeScalingActivitiesCommand, DescribeTagsCommand, SetDesiredCapacityCommand, type AutoScalingGroup,
} from "@aws-sdk/client-auto-scaling";
import { LIMITS } from "../../config.ts";
import { ratesFrom } from "../../costs.ts";
import { asgOwnedProblem, asgOwner, asgResource, asgType, capacityDelta, desiredProblem, type AsgView } from "../../inventory/compute-ec2.ts";
import type { Link, Mention, Resource, ResourceDetail } from "../../inventory/types.ts";
import { consoleConfig } from "../discovery.ts";
import { HttpError } from "../errors.ts";
import { field } from "./edge-util.ts";
import { abortOpts, call, ms, regional, sdkConfig, tagMap } from "./compute-util.ts";
import { mockGroups } from "./mock/asg.ts";
import { MOCK_REGION, mockState } from "./mock/compute-state.ts";
import type { ActionContext, Provider, ProviderAction, ProviderContext } from "./types.ts";

const asg = regional((region) => new AutoScalingClient(sdkConfig(region)), "autoscaling");
const asgWrite = regional((region) => new AutoScalingClient(sdkConfig(region, { maxAttempts: 1 })), "autoscaling"); // sent once (F31)
// A group is read and changed in its own region (its ARN says which).
const regionOf = (r: Resource, ctx: { region: string }) => (r.region && r.region !== "global" ? r.region : ctx.region);

function view(g: AutoScalingGroup): AsgView {
  const lt = g.LaunchTemplate ?? g.MixedInstancesPolicy?.LaunchTemplate?.LaunchTemplateSpecification;
  return {
    name: g.AutoScalingGroupName!, arn: g.AutoScalingGroupARN!, min: g.MinSize ?? 0, max: g.MaxSize ?? 0, desired: g.DesiredCapacity ?? 0,
    instances: (g.Instances ?? []).map((i) => ({ id: i.InstanceId!, lifecycle: i.LifecycleState ?? "", health: i.HealthStatus ?? "", type: i.InstanceType, az: i.AvailabilityZone })),
    launchTemplate: lt ? `${lt.LaunchTemplateName ?? lt.LaunchTemplateId}:${lt.Version ?? "$Default"}` : undefined, launchConfig: g.LaunchConfigurationName,
    instanceTypes: (g.MixedInstancesPolicy?.LaunchTemplate?.Overrides ?? []).map((o) => o.InstanceType!).filter(Boolean),
    targetGroups: g.TargetGroupARNs ?? [], classicLbs: g.LoadBalancerNames ?? [],
    subnets: (g.VPCZoneIdentifier ?? "").split(",").map((x) => x.trim()).filter(Boolean),
    healthCheck: g.HealthCheckType ? `${g.HealthCheckType}, grace ${g.HealthCheckGracePeriod ?? 0} s` : undefined, status: g.Status,
    suspended: (g.SuspendedProcesses ?? []).map((p) => p.ProcessName!).filter(Boolean), tags: tagMap(g.Tags), createdAt: ms(g.CreatedTime),
  };
}

async function groups(ctx: ProviderContext): Promise<AsgView[]> {
  if (ctx.mock) return ctx.region === MOCK_REGION ? mockGroups() : [];
  const out: AsgView[] = [];
  let NextToken: string | undefined;
  do {
    const r = await call(ctx, (o) => asg(ctx.region).send(new DescribeAutoScalingGroupsCommand({ MaxRecords: 100, NextToken }), o));
    out.push(...(r.AutoScalingGroups ?? []).map(view));
    NextToken = r.NextToken;
  } while (NextToken && out.length < ctx.cap);
  if (NextToken || out.length > ctx.cap) ctx.note(`asg: showing the first ${ctx.cap.toLocaleString("en-US")} Auto Scaling groups`);
  return out.slice(0, ctx.cap);
}

async function discover(ctx: ProviderContext) {
  const region = ctx.region;
  const resources: Resource[] = [], links: Link[] = [], mentions: Mention[] = [];
  for (const g of await groups(ctx)) {
    const m = asgResource(g, region, ctx.home);
    resources.push(m.resource);
    links.push(...m.links);
    mentions.push(...m.mentions);
  }
  return { resources, links, mentions };
}

// R01: the group's tags, read live right before a capacity change.
async function authoritative(r: Resource, ctx: ActionContext): Promise<{ tags: Record<string, string> }> {
  if (ctx.mock) return { tags: { ...(await liveGroup(r.name, ctx)).tags } };
  const tags: Record<string, string> = {};
  let NextToken: string | undefined;
  do {
    const out = await asg(regionOf(r, ctx)).send(new DescribeTagsCommand({ Filters: [{ Name: "auto-scaling-group", Values: [r.name] }], MaxRecords: 100, NextToken }), abortOpts());
    for (const t of out.Tags ?? []) if (t.Key) tags[t.Key] = t.Value ?? "";
    NextToken = out.NextToken;
  } while (NextToken);
  return { tags };
}

async function liveGroup(name: string, ctx: { mock: boolean; region: string }): Promise<AsgView> {
  const g = ctx.mock
    ? mockGroups().find((x) => x.name === name)
    : (await asg(ctx.region).send(new DescribeAutoScalingGroupsCommand({ AutoScalingGroupNames: [name] }), abortOpts())).AutoScalingGroups?.map(view)[0];
  if (!g) throw new HttpError(404, `Auto Scaling group ${name} not found`);
  return g;
}

async function detail(r: Resource, ctx: ProviderContext): Promise<ResourceDetail> {
  const where = { ...ctx, region: regionOf(r, ctx) };
  const g = await liveGroup(r.name, where);
  const acts: string[][] = ctx.mock
    ? mockState().nodegroup.updates.filter(() => asgOwner(g.tags)?.by === "eks").map((u) => [new Date(u.at).toISOString(), "Successful", `Nodegroup update (${u.params})`])
    : ((await call(ctx, (o) => asg(where.region).send(new DescribeScalingActivitiesCommand({ AutoScalingGroupName: r.name, MaxRecords: 10 }), o))).Activities ?? []).map((a) => [
        a.StartTime?.toISOString() ?? "", a.StatusCode ?? "", (a.Description ?? "").slice(0, 200),
      ]);
  return {
    key: r.key,
    sections: [
      { title: "Instances", table: { columns: ["Instance", "Type", "Zone", "Lifecycle", "Health"], rows: g.instances.map((i) => [i.id, i.type ?? "", i.az ?? "", i.lifecycle, i.health]) } },
      { title: "Recent scaling activity", table: { columns: ["Started", "Status", "Description"], rows: acts }, note: acts.length ? undefined : "No scaling activity recorded." },
      ...(g.targetGroups.length ? [{ title: "Target groups", table: { columns: ["ARN"], rows: g.targetGroups.map((t) => [t]) } }] : []),
    ],
  };
}

const setDesired: ProviderAction<{ desired: number }> = {
  id: "set-desired", kind: "asg", title: "Set desired capacity",
  summary: "Changes how many instances this group runs, within its own min and max; it launches or terminates instances to match.",
  description: "Sets an Auto Scaling group's desired capacity (SetDesiredCapacity, ignoring cooldowns) within its own min..max; the group then launches or terminates instances. Refuses groups owned by an EKS nodegroup (use Scale nodegroup) or an Elastic Beanstalk environment. The plan shows the monthly list-price change. Returns the group name and the new desired capacity.",
  risk: "change", perm: "provision",
  iam: ["autoscaling:SetDesiredCapacity"],
  undo: "Set the desired capacity back to its previous value (the plan shows it); terminated instances are replaced by new ones, not restored",
  verifies: "The group's in-service instance count reaches the new desired capacity",
  retrySafe: true, // setting the same capacity twice changes nothing more
  input: {
    type: "object", additionalProperties: false, required: ["desired"],
    properties: { desired: field({ type: "integer", title: "Desired capacity", minimum: 0, maximum: 1000, description: "New desired capacity, between the group's min and max." }) },
  },
  when: (r) => asgOwnedProblem(r.tags),
  async plan(r, input, ctx) {
    const g = await check(r, input, ctx);
    const type = asgType(g);
    const warnings: string[] = [];
    if (asgOwner(g.tags)?.by === "ecs") warnings.push("An ECS capacity provider manages this group: its managed scaling may change the count again.");
    if (input.desired < g.desired) warnings.push(`${g.desired - input.desired} instance${g.desired - input.desired === 1 ? "" : "s"} will be terminated (the group picks which, by its termination policy) — anything running on them stops.`);
    if (g.targetGroups.length || g.classicLbs.length) warnings.push("Instances register with / drain from the group's load balancer targets.");
    warnings.push("Scaling policies or a scheduled action may adjust the count later.");
    return {
      summary: `Set ${g.name} desired capacity ${g.desired} → ${input.desired} (min ${g.min}, max ${g.max})`,
      changes: [`SetDesiredCapacity ${g.name} = ${input.desired}${type ? ` (${type})` : ""}`], warnings,
      estimate: capacityDelta(type, g.desired, input.desired, ratesFrom(consoleConfig().config.pricing)),
    };
  },
  async run(r, input, ctx) {
    const g = await check(r, input, ctx);
    if (ctx.mock) throw new HttpError(409, "the simulated account has no Auto Scaling group you may resize directly");
    await asgWrite(regionOf(r, ctx)).send(new SetDesiredCapacityCommand({ AutoScalingGroupName: g.name, DesiredCapacity: input.desired, HonorCooldown: false }), { abortSignal: AbortSignal.timeout(LIMITS.awsWriteTimeoutMs) });
    return { group: g.name, from: g.desired, desired: input.desired };
  },
};

async function check(r: Resource, input: { desired: number }, ctx: ActionContext): Promise<AsgView> {
  const g = await liveGroup(r.name, { ...ctx, region: regionOf(r, ctx) });
  const msg = asgOwnedProblem(g.tags) ?? desiredProblem(input.desired, g);
  if (msg) throw new HttpError(409, msg);
  return g;
}

export const asgProvider: Provider = {
  id: "asg",
  label: "EC2 Auto Scaling",
  scope: "regional",
  multiRegionMock: true,
  kinds: ["asg"],
  covers: ["autoscaling:autoScalingGroup"],
  read: ["autoscaling:DescribeAutoScalingGroups", "autoscaling:DescribeScalingActivities", "autoscaling:DescribeTags"],
  write: ["autoscaling:SetDesiredCapacity"],
  discover,
  authoritative,
  // R20: the members' CPU (AWS/EC2 aggregated by AutoScalingGroupName) shows the group is used.
  activity: (r) => [{ namespace: "AWS/EC2", metric: "CPUUtilization", dims: { AutoScalingGroupName: r.name }, stat: "Average", label: "CPU % (group)", required: true }],
  detail,
  actions: [setDesired as ProviderAction],
};
