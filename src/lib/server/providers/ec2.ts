// EC2 instances, per region: every instance that isn't terminated, with its Elastic IPs, status checks, instance
// profile (→ its role), public address, and what it belongs to (an ECS cluster, an Auto Scaling group, an EKS
// nodegroup, a Beanstalk environment). The instance list is handed over before the region-wide Elastic IP and status
// reads (R18). Start / stop / reboot follow the ECS hosts' power rules: stop refuses Auto Scaling members, stop and
// reboot refuse hosts of protected ECS environments, and nothing terminates (only the console-created-host flow in
// Create & scale does that). Before any of them the instance's tags are read live (R01).
import "server-only";
import {
  DescribeAddressesCommand, DescribeInstanceStatusCommand, DescribeInstancesCommand, DescribeSecurityGroupsCommand, DescribeTagsCommand, EC2Client,
  RebootInstancesCommand, StartInstancesCommand, StopInstancesCommand, type Instance, type SecurityGroup,
} from "@aws-sdk/client-ec2";
import { LIMITS } from "../../config.ts";
import { ratesFrom } from "../../costs.ts";
import { day, propOf } from "../../inventory/compute-common.ts";
import { capacityDelta, instanceLinks, instanceResource, powerProblem, type EcsHostRef, type InstanceView, type PowerAction, type PowerTarget } from "../../inventory/compute-ec2.ts";
import type { Link, Resource, ResourceDetail } from "../../inventory/types.ts";
import type { RawBox } from "../../types.ts";
import { invalidate } from "../cache.ts";
import { consoleConfig, inventory, listEnvs } from "../discovery.ts";
import { HttpError } from "../errors.ts";
import { getCloud } from "../sources.ts";
import { abortOpts, call, ms, optional, regional, sdkConfig, tagMap } from "./compute-util.ts";
import { mockHostProfile, mockInstances } from "./mock/ec2.ts";
import { mockPower, mockState, MOCK_REGION } from "./mock/compute-state.ts";
import type { ActionContext, Provider, ProviderAction, ProviderContext } from "./types.ts";

const ec2 = regional((region) => new EC2Client(sdkConfig(region)), "ec2");
// Power changes are sent once, with the longer write timeout (F31): a timed-out one is "outcome unknown", not retried.
const ec2Write = regional((region) => new EC2Client(sdkConfig(region, { maxAttempts: 1 })), "ec2");
const writeOpts = () => ({ abortSignal: AbortSignal.timeout(LIMITS.awsWriteTimeoutMs) });
const LIVE = ["pending", "running", "stopping", "stopped", "shutting-down"];
const idOf = (r: Resource) => r.key.replace(/^ec2:/, "").replace(/@.*$/, "");
// Detail and actions read and change an instance in its own region (the inventory and the action runner pass it too).
const regionOf = (r: Resource, ctx: { region: string }) => (r.region && r.region !== "global" ? r.region : ctx.region);

// ---------- ECS container instances ----------

// Which instances are ECS container instances, from the console's own ECS discovery (cached 60 s). Kept on globalThis
// so `when()` (synchronous, for the button hint) can use the last known answer; plan/run look it up again.
type EcsHost = EcsHostRef & { box: RawBox; region: string };
const g = globalThis as { __computeEcsHosts?: { hosts: Map<string, EcsHost> } };

async function ecsHosts(): Promise<Map<string, EcsHost>> {
  const inv = await inventory();
  const hosts = new Map<string, EcsHost>();
  for (const c of inv.catalogs.values()) for (const h of c.hosts) hosts.set(h.id, { cluster: c.env.cluster, env: c.env.id, protected: c.env.protected, box: h, region: c.env.region });
  g.__computeEcsHosts = { hosts };
  return hosts;
}

// Instances tagged with a cluster ECS discovery doesn't cover (ignored clusters, other tooling). Cluster names repeat
// across regions: the environment is the one of that name in the instance's region.
async function ecsByTag(tags: Record<string, string>, region: string): Promise<EcsHostRef | undefined> {
  const cluster = tags["aws:ecs:cluster-name"] ?? tags["ecs:cluster-name"];
  if (!cluster) return undefined;
  const env = (await listEnvs().catch(() => [])).find((e) => e.cluster === cluster && e.region === region);
  return { cluster, env: env?.id, protected: env?.protected ?? false };
}

const boxView = (b: RawBox): InstanceView => ({
  id: b.id, type: b.type, state: b.state, launchedAt: b.launchedAt, privateIp: b.privateIp, publicIp: b.publicIp, vpcId: b.vpcId,
  securityGroups: b.securityGroups, platform: b.platform, az: b.az, tags: b.tags,
});

// ---------- real API → InstanceView ----------

function view(i: Instance, eips: Map<string, string[]>, status: Map<string, { checks: InstanceView["checks"]; events: string[] }>): InstanceView {
  const st = status.get(i.InstanceId!);
  return {
    id: i.InstanceId!, type: i.InstanceType ?? "", state: i.State?.Name ?? "unknown", reason: i.StateTransitionReason, launchedAt: ms(i.LaunchTime),
    privateIp: i.PrivateIpAddress, publicIp: i.PublicIpAddress, privateDns: i.PrivateDnsName, publicDns: i.PublicDnsName, elasticIps: eips.get(i.InstanceId!) ?? [],
    vpcId: i.VpcId, subnetId: i.SubnetId, securityGroups: (i.SecurityGroups ?? []).map((x) => x.GroupId!).filter(Boolean), profileArn: i.IamInstanceProfile?.Arn,
    platform: i.PlatformDetails, imageId: i.ImageId, az: i.Placement?.AvailabilityZone, keyName: i.KeyName, tags: tagMap(i.Tags), checks: st?.checks, events: st?.events,
  };
}

async function describeAll(ctx: ProviderContext): Promise<Instance[]> {
  const out: Instance[] = [];
  let NextToken: string | undefined;
  do {
    const r = await call(ctx, (o) => ec2(ctx.region).send(new DescribeInstancesCommand({ Filters: [{ Name: "instance-state-name", Values: LIVE }], MaxResults: 1000, NextToken }), o));
    out.push(...(r.Reservations ?? []).flatMap((x) => x.Instances ?? []));
    NextToken = r.NextToken;
  } while (NextToken && out.length < ctx.cap);
  if (out.length > ctx.cap || NextToken) ctx.note(`ec2: showing the first ${ctx.cap.toLocaleString("en-US")} instances`);
  return out.slice(0, ctx.cap);
}

async function statuses(ctx: ProviderContext) {
  const out = new Map<string, { checks: InstanceView["checks"]; events: string[] }>();
  let NextToken: string | undefined;
  let n = 0;
  do {
    const r = await call(ctx, (o) => ec2(ctx.region).send(new DescribeInstanceStatusCommand({ MaxResults: 1000, NextToken }), o));
    for (const s of r.InstanceStatuses ?? []) {
      out.set(s.InstanceId!, {
        checks: { system: s.SystemStatus?.Status, instance: s.InstanceStatus?.Status },
        events: (s.Events ?? []).filter((e) => !e.Description?.startsWith("[Completed]") && !e.Description?.startsWith("[Canceled]")).map((e) => `${e.Code}${e.NotBefore ? ` ${day(e.NotBefore.getTime())}` : ""}`),
      });
    }
    NextToken = r.NextToken;
  } while (NextToken && ++n < 20);
  return out;
}

async function elasticIps(ctx: ProviderContext) {
  const r = await call(ctx, (o) => ec2(ctx.region).send(new DescribeAddressesCommand({}), o));
  const out = new Map<string, string[]>();
  for (const a of r.Addresses ?? []) if (a.InstanceId && a.PublicIp) out.set(a.InstanceId, [...(out.get(a.InstanceId) ?? []), a.PublicIp]);
  return out;
}

// ---------- discover ----------

async function discover(ctx: ProviderContext) {
  const region = ctx.region;
  const ecs = await optional(ctx, "ec2: ECS container instances", ecsHosts, new Map<string, EcsHost>());
  const result = async (views: InstanceView[]) => {
    const resources: Resource[] = [], links: Link[] = [];
    for (const v of views) {
      resources.push(instanceResource(v, region, ecs.get(v.id) ?? (await ecsByTag(v.tags, region)), ctx.accountId, ctx.home));
      links.push(...instanceLinks(v, ctx.accountId, region, ctx.home));
    }
    return { resources, links, mentions: [] };
  };
  if (ctx.mock) {
    // The simulated instances live in the home region; the ECS hosts come from ../../mock.ts via discovery, each in its
    // environment's region.
    const mine = region === MOCK_REGION ? mockInstances() : [];
    const reboots = mockState().reboots;
    const hosts = [...ecs.values()]
      .filter((h) => h.region === region && !mine.some((m) => m.id === h.box.id))
      .map((h) => ({ ...boxView(h.box), profileArn: mockHostProfile(h.box.id), rebooting: (reboots.get(h.box.id) ?? 0) > Date.now() }));
    return result([...mine, ...hosts]);
  }
  const list = await describeAll(ctx);
  // R18: the instances first; Elastic IPs and status checks (one region-wide call each) refine them.
  ctx.checkpoint?.(await result(list.map((i) => view(i, new Map(), new Map()))));
  const [eips, status] = await Promise.all([
    optional(ctx, "ec2: Elastic IPs", () => elasticIps(ctx), new Map<string, string[]>()),
    optional(ctx, "ec2: status checks", () => statuses(ctx), new Map<string, { checks: InstanceView["checks"]; events: string[] }>()),
  ]);
  return result(list.map((i) => view(i, eips, status)));
}

// R01: the instance's tags, read live right before a power change (the simulated account: its own state).
async function authoritative(r: Resource, ctx: ActionContext): Promise<{ tags: Record<string, string> }> {
  const id = idOf(r);
  if (ctx.mock) return { tags: { ...(await live(r, ctx)).tags } };
  const tags: Record<string, string> = {};
  let NextToken: string | undefined;
  do {
    const out = await ec2(regionOf(r, ctx)).send(new DescribeTagsCommand({ Filters: [{ Name: "resource-id", Values: [id] }], MaxResults: 1000, NextToken }), abortOpts());
    for (const t of out.Tags ?? []) if (t.Key) tags[t.Key] = t.Value ?? "";
    NextToken = out.NextToken;
  } while (NextToken);
  return { tags };
}

// ---------- detail ----------

function rulesLine(sg: SecurityGroup): string {
  return (sg.IpPermissions ?? []).map((p) => {
    const port = p.IpProtocol === "-1" ? "all" : p.FromPort === p.ToPort ? `${p.IpProtocol} ${p.FromPort}` : `${p.IpProtocol} ${p.FromPort}-${p.ToPort}`;
    const from = [...(p.IpRanges ?? []).map((x) => x.CidrIp), ...(p.Ipv6Ranges ?? []).map((x) => x.CidrIpv6), ...(p.UserIdGroupPairs ?? []).map((x) => x.GroupId), ...(p.PrefixListIds ?? []).map((x) => x.PrefixListId)];
    return `${port} ← ${from.filter(Boolean).join(", ") || "?"}`;
  }).join("; ") || "no inbound rules";
}

async function detail(r: Resource, ctx: ProviderContext): Promise<ResourceDetail> {
  const id = idOf(r);
  const region = regionOf(r, ctx);
  if (ctx.mock) {
    const i = mockState().instances.get(id);
    const sgs = await (await getCloud(region)).securityGroups(r.securityGroups ?? []);
    return {
      key: r.key,
      sections: [
        { title: "Status checks", rows: [{ label: "System", value: i?.state === "running" || !i ? "ok" : "—" }, { label: "Instance", value: i?.state === "running" || !i ? "ok" : "—" }] },
        { title: "Security groups", table: { columns: ["Group", "Name", "Inbound"], rows: (r.securityGroups ?? []).map((sg) => { const x = sgs.find((s) => s.id === sg); return [sg, x?.name ?? "", x ? x.inbound.map((p) => `tcp ${p.fromPort} ← ${p.groups.join(", ")}`).join("; ") || "no inbound rules" : "(not in this simulation)"]; }) } },
      ],
    };
  }
  const [d, st] = await Promise.all([
    call(ctx, (o) => ec2(region).send(new DescribeInstancesCommand({ InstanceIds: [id] }), o)),
    optional(ctx, "ec2: status checks", () => call(ctx, (o) => ec2(region).send(new DescribeInstanceStatusCommand({ InstanceIds: [id], IncludeAllInstances: true }), o)), undefined),
  ]);
  const i = d.Reservations?.flatMap((x) => x.Instances ?? [])[0];
  if (!i) throw new HttpError(404, `instance ${id} not found`);
  const s = st?.InstanceStatuses?.[0];
  const ids = (i.SecurityGroups ?? []).map((x) => x.GroupId!).filter(Boolean);
  const sgs = ids.length ? await optional(ctx, "ec2: security groups", async () => (await call(ctx, (o) => ec2(region).send(new DescribeSecurityGroupsCommand({ GroupIds: ids }), o))).SecurityGroups ?? [], []) : [];
  const md = i.MetadataOptions;
  return {
    key: r.key,
    sections: [
      {
        title: "Instance",
        rows: [
          { label: "AMI", value: i.ImageId ?? "", mono: true }, { label: "Architecture", value: i.Architecture ?? "" }, { label: "Root device", value: `${i.RootDeviceType ?? ""} ${i.RootDeviceName ?? ""}`.trim() },
          { label: "Volumes", value: String(i.BlockDeviceMappings?.length ?? 0) }, { label: "Monitoring", value: i.Monitoring?.State ?? "" },
          { label: "Instance metadata", value: md ? `IMDSv2 ${md.HttpTokens === "required" ? "required" : "optional (v1 allowed)"}, hop limit ${md.HttpPutResponseHopLimit ?? "?"}` : "" },
          { label: "State reason", value: i.StateTransitionReason ?? "" },
        ].filter((x) => x.value),
      },
      {
        title: "Status checks",
        rows: [{ label: "System", value: s?.SystemStatus?.Status ?? "—" }, { label: "Instance", value: s?.InstanceStatus?.Status ?? "—" }, ...(s?.Events ?? []).map((e) => ({ label: `Event ${e.Code}`, value: e.Description ?? "" }))],
      },
      { title: "Security groups", table: { columns: ["Group", "Name", "Inbound"], rows: sgs.map((x) => [x.GroupId ?? "", x.GroupName ?? "", rulesLine(x)]) } },
      { title: "Tags", table: { columns: ["Key", "Value"], rows: Object.entries(r.tags).sort().map(([k, v]) => [k, v]) } },
    ],
  };
}

// ---------- actions ----------

interface Live { state: string; type: string; tags: Record<string, string>; hasEip: boolean; ecs?: EcsHostRef; mockBox?: boolean }

// The instance as it is now (not as the map last saw it), and whether it is an ECS host of a protected environment.
async function live(r: Resource, ctx: ActionContext): Promise<Live> {
  const id = idOf(r);
  const region = regionOf(r, ctx);
  const hosts = await ecsHosts().catch(() => g.__computeEcsHosts?.hosts ?? new Map<string, EcsHost>());
  if (ctx.mock) {
    const i = mockState().instances.get(id);
    if (i) return { state: i.state, type: i.type, tags: i.tags, hasEip: !!i.eip };
    const h = hosts.get(id);
    if (!h) throw new HttpError(404, `instance ${id} not found`);
    const box = (await (await getCloud(region)).hosts(h.cluster)).find((b) => b.id === id) ?? h.box;
    return { state: box.state, type: box.type, tags: box.tags, hasEip: false, ecs: h, mockBox: true };
  }
  const d = await ec2(region).send(new DescribeInstancesCommand({ InstanceIds: [id] }), abortOpts());
  const i = d.Reservations?.flatMap((x) => x.Instances ?? [])[0];
  if (!i || i.State?.Name === "terminated") throw new HttpError(404, `instance ${id} not found`);
  const tags = tagMap(i.Tags);
  const eips = await ec2(region).send(new DescribeAddressesCommand({ Filters: [{ Name: "instance-id", Values: [id] }] }), abortOpts()).catch(() => undefined);
  return { state: i.State?.Name ?? "unknown", type: i.InstanceType ?? "", tags, hasEip: !!eips?.Addresses?.length, ecs: hosts.get(id) ?? (await ecsByTag(tags, region)) };
}

// The console on plain EC2 (not ECS) knows its instance from CONSOLE_SELF_INSTANCE or the tag console:self=true.
const isSelf = (id: string, tags: Record<string, string>) => id === process.env.CONSOLE_SELF_INSTANCE?.trim() || tags["console:self"] === "true";
const targetOf = (l: Live, id: string): PowerTarget => ({ state: l.state, asg: l.tags["aws:autoscaling:groupName"], ecs: l.ecs, self: isSelf(id, l.tags) });
const refuse = (msg: string | undefined) => {
  if (msg) throw new HttpError(409, msg);
};
const rates = () => ratesFrom(consoleConfig().config.pricing);

const TEXT: Record<PowerAction, { title: string; description: string; summary: string; undo: string; verifies: string }> = {
  start: {
    title: "Start instance",
    description: "Starts a stopped EC2 instance (StartInstances). Its public IP changes unless it has an Elastic IP. Returns the instance id and request id.",
    summary: "Starts this stopped instance; it gets a new public IP unless it has an Elastic IP.",
    undo: "Stop it again",
    verifies: "State running and both status checks ok",
  },
  stop: {
    title: "Stop instance",
    description: "Stops a running EC2 instance (StopInstances); EBS volumes are kept. Refuses members of an Auto Scaling group (the group would start a replacement — scale the group instead) and container instances of protected ECS environments. Returns the instance id and request id.",
    summary: "Stops this instance: whatever runs on it stops; its EBS volumes are kept.",
    undo: "Start it again (instance-store data is lost, and the public IP changes unless it has an Elastic IP)",
    verifies: "State stopped",
  },
  reboot: {
    title: "Reboot instance",
    description: "Reboots a running EC2 instance (RebootInstances): an OS restart, IPs and volumes stay. Refuses container instances of protected ECS environments. Returns the instance id and request id.",
    summary: "Restarts this instance's operating system; its IPs and volumes stay.",
    undo: "Nothing to undo — a reboot only restarts the operating system",
    verifies: "State running and both status checks ok after the restart",
  },
};
const IAM: Record<PowerAction, string> = { start: "ec2:StartInstances", stop: "ec2:StopInstances", reboot: "ec2:RebootInstances" };

function powerAction(action: PowerAction): ProviderAction {
  const { title, description, summary, undo, verifies } = TEXT[action];
  return {
    id: action, kind: "ec2-instance", title, description, summary, risk: "change", perm: "power",
    iam: [IAM[action]], undo, verifies,
    retrySafe: true, // F31: starting a running or stopping a stopped instance changes nothing more
    input: { type: "object", additionalProperties: false, properties: {} },
    when: (r) => powerProblem(action, { state: propOf(r, "State") ?? "unknown", asg: r.tags["aws:autoscaling:groupName"], ecs: g.__computeEcsHosts?.hosts.get(idOf(r)), self: isSelf(idOf(r), r.tags) }),
    async plan(r, _input, ctx) {
      const l = await live(r, ctx);
      refuse(powerProblem(action, targetOf(l, idOf(r))));
      const id = idOf(r);
      const warnings: string[] = [];
      if (l.ecs) warnings.push(action === "start" ? `ECS places tasks on it once its agent reconnects to ${l.ecs.cluster}.` : `Every ECS task on it stops; ECS reschedules them only where ${l.ecs.cluster} still has capacity.`);
      if (action === "stop") warnings.push(`Whatever runs on it stops; EBS volumes stay (and keep billing), instance-store data is lost${l.hasEip ? "" : ", and its public IP is released"}.`);
      if (action === "start" && !l.hasEip) warnings.push("It gets a new public IP (no Elastic IP) — DNS records pointing at the old one break.");
      if (action === "reboot") warnings.push("About a minute or two of downtime for whatever runs on it.");
      if (action !== "start" && l.tags["eks:cluster-name"]) warnings.push("It is a Kubernetes node: its pods are not drained first.");
      const est = action === "start" ? capacityDelta(l.type, 0, 1, rates()) : action === "stop" ? capacityDelta(l.type, 1, 0, rates()) : undefined;
      return { summary: `${title.split(" ")[0]} ${r.name} (${id}, ${l.type})`, changes: [`${action === "start" ? "StartInstances" : action === "stop" ? "StopInstances" : "RebootInstances"} ${id}`], warnings, estimate: est };
    },
    async run(r, _input, ctx) {
      const l = await live(r, ctx);
      refuse(powerProblem(action, targetOf(l, idOf(r))));
      const id = idOf(r);
      if (l.ecs) invalidate(`hosts:${l.ecs.cluster}`);
      if (ctx.mock) {
        if (l.mockBox && action !== "reboot") return { instanceId: id, action, requestId: await (await getCloud(regionOf(r, ctx))).hostPower(id, action) };
        return { ...mockPower(id, action), action };
      }
      const c = ec2Write(regionOf(r, ctx));
      const InstanceIds = [id];
      const res =
        action === "start" ? await c.send(new StartInstancesCommand({ InstanceIds }), writeOpts())
        : action === "stop" ? await c.send(new StopInstancesCommand({ InstanceIds }), writeOpts())
        : await c.send(new RebootInstancesCommand({ InstanceIds }), writeOpts());
      return { instanceId: id, action, requestId: res.$metadata.requestId ?? "" };
    },
  };
}

export const ec2Provider: Provider = {
  id: "ec2",
  label: "EC2",
  scope: "regional",
  multiRegionMock: true,
  kinds: ["ec2-instance"],
  covers: ["ec2:instance"],
  read: ["ec2:DescribeInstances", "ec2:DescribeAddresses", "ec2:DescribeInstanceStatus", "ec2:DescribeSecurityGroups", "ec2:DescribeTags"],
  write: ["ec2:StartInstances", "ec2:StopInstances", "ec2:RebootInstances"],
  discover,
  authoritative,
  // R20: CPU is the series that shows the instance is used (documented dimension InstanceId).
  activity: (r) => [{ namespace: "AWS/EC2", metric: "CPUUtilization", dims: { InstanceId: idOf(r) }, stat: "Average", label: "CPU %", required: true }],
  detail,
  actions: [powerAction("start"), powerAction("stop"), powerAction("reboot")],
};
