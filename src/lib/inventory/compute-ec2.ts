// Pure rules for the EC2 and Auto Scaling providers (src/lib/server/providers/ec2.ts, asg.ts): health from instance
// state and status checks, when a stopped instance stopped, which power actions may run, desired-capacity validation,
// the list-price delta of a capacity change, and what an instance is wired to (its instance profile, public address).
// No AWS calls, so node:test runs them.
import { DEFAULT_RATES, ec2Hourly, monthly, usd, type Rates } from "../costs.ts";
import { arnOf } from "./arn.ts";
import { day, profileRef, prop, props, uniq } from "./compute-common.ts";
import { keys, type Health, type Link, type Mention, type Resource } from "./types.ts";

// StateTransitionReason carries the time for user/API stops: "User initiated (2025-05-30 10:12:03 GMT)".
export function stoppedSince(reason?: string): number | undefined {
  const m = /\((\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) GMT\)/.exec(reason ?? "");
  if (!m) return undefined;
  const t = Date.parse(`${m[1]}T${m[2]}Z`);
  return Number.isFinite(t) ? t : undefined;
}

export interface InstanceFacts {
  state: string; // pending | running | stopping | stopped | shutting-down
  reason?: string; // StateTransitionReason
  checks?: { system?: string; instance?: string }; // DescribeInstanceStatus: ok | impaired | initializing | insufficient-data
  events?: string[]; // scheduled events: "instance-retirement 2026-10-01"
  rebooting?: boolean;
}

export function instanceHealth(i: InstanceFacts): { health: Health; healthReason?: string } {
  switch (i.state) {
    case "running": {
      const bad = i.checks?.system === "impaired" ? "system" : i.checks?.instance === "impaired" ? "instance" : undefined;
      if (bad) return { health: "warning", healthReason: `${bad} status check impaired` };
      if (i.rebooting) return { health: "warning", healthReason: "rebooting" };
      if (i.events?.length) return { health: "warning", healthReason: `scheduled: ${i.events[0]}` };
      return { health: "ok" };
    }
    case "stopped": {
      const at = stoppedSince(i.reason);
      return { health: "stopped", healthReason: at ? `stopped since ${day(at)}` : "stopped" };
    }
    case "pending":
      return { health: "warning", healthReason: "starting" };
    case "stopping":
      return { health: "warning", healthReason: "stopping" };
    case "shutting-down":
      return { health: "warning", healthReason: "terminating" };
    default:
      return { health: "unknown", healthReason: i.state };
  }
}

export const profileName = (arn?: string) => (arn ? arn.split("/").pop() : undefined);

export function instanceEndpoints(i: { privateIp?: string; publicIp?: string; privateDns?: string; publicDns?: string; elasticIps?: string[] }): string[] {
  return uniq([i.privateIp, i.privateDns, i.publicIp, i.publicDns, ...(i.elasticIps ?? [])]);
}

// ---------- power actions ----------

export type PowerAction = "start" | "stop" | "reboot";
export interface PowerTarget {
  self?: boolean; // the console itself runs on this instance (CONSOLE_SELF_INSTANCE or tag console:self=true)
  state: string;
  asg?: string; // aws:autoscaling:groupName
  ecs?: { cluster: string; env?: string; protected: boolean }; // an ECS container instance
}

// undefined = allowed. Start stays possible everywhere; stop and reboot interrupt what runs on the instance, so they
// refuse Auto Scaling members (stop only: the group would replace it) and hosts of protected ECS environments.
export function powerProblem(action: PowerAction, t: PowerTarget): string | undefined {
  if (t.self && action !== "start") return "the console runs on this instance — it never stops or reboots itself";
  if (["pending", "stopping", "shutting-down"].includes(t.state)) return `instance is ${t.state} — wait for it to settle`;
  if (action === "start") return t.state === "stopped" ? undefined : t.state === "running" ? "already running" : `can't start from "${t.state}"`;
  if (action === "stop" && t.asg) return `member of Auto Scaling group ${t.asg} — stopping it would just start a replacement; scale the group instead`;
  if (t.ecs?.protected) return `container instance of ECS cluster ${t.ecs.cluster} in protected environment ${t.ecs.env ?? t.ecs.cluster} — ${action === "stop" ? "stopping" : "rebooting"} it would stop every task on it`;
  if (t.state !== "running") return t.state === "stopped" ? "already stopped" : `can't ${action} from "${t.state}"`;
  return undefined;
}

// ---------- Auto Scaling ----------

// Groups another service owns: changing their capacity directly is undone (EKS, Beanstalk) or fights its scaling (ECS).
export function asgOwner(tags: Record<string, string>): { by: "eks" | "beanstalk" | "ecs"; name: string } | undefined {
  if (tags["eks:nodegroup-name"]) return { by: "eks", name: `${tags["eks:cluster-name"] ?? "?"}/${tags["eks:nodegroup-name"]}` };
  if (tags["elasticbeanstalk:environment-name"]) return { by: "beanstalk", name: tags["elasticbeanstalk:environment-name"] };
  if ("AmazonECSManaged" in tags) return { by: "ecs", name: "ECS capacity provider" };
  return undefined;
}

// Why set-desired can't run on this group at all (EKS / Beanstalk own it); an ECS capacity provider only warns.
export function asgOwnedProblem(tags: Record<string, string>): string | undefined {
  const o = asgOwner(tags);
  if (o?.by === "eks") return `managed by EKS nodegroup ${o.name} — use "Scale nodegroup" on the cluster instead`;
  if (o?.by === "beanstalk") return `managed by Elastic Beanstalk environment ${o.name} — change its capacity in Beanstalk`;
  return undefined;
}

export function desiredProblem(desired: number, g: { min: number; max: number; desired: number }): string | undefined {
  if (!Number.isInteger(desired) || desired < 0) return "desired capacity must be a whole number, 0 or more";
  if (desired < g.min || desired > g.max) return `desired capacity must be between the group's min ${g.min} and max ${g.max} (change the limits in AWS to go further)`;
  if (desired === g.desired) return `desired capacity is already ${desired}`;
  return undefined;
}

export function mostCommon(a: (string | undefined)[]): string | undefined {
  const n = new Map<string, number>();
  for (const x of a) if (x) n.set(x, (n.get(x) ?? 0) + 1);
  return [...n.entries()].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))[0]?.[0];
}

// Monthly list-price change of running `to` instead of `from` instances (negative = saving). undefined = no price.
export function capacityDelta(instanceType: string | undefined, from: number, to: number, r: Rates = DEFAULT_RATES): { monthlyUsd: number; note: string } | undefined {
  const p = instanceType ? ec2Hourly(instanceType, r) : undefined;
  if (p === undefined || from === to) return undefined;
  const each = monthly(p);
  const d = to - from;
  return {
    monthlyUsd: each * d,
    note: `${d > 0 ? "+" : "−"}${Math.abs(d)} × ${instanceType} at ${usd(each)}/month each (on-demand Linux list price; EBS and data transfer extra)${d < 0 ? " — a saving" : ""}`,
  };
}

// ---------- resources ----------

// An instance as both the real API and the simulated account describe it.
export interface InstanceView {
  id: string;
  type: string;
  state: string;
  reason?: string;
  launchedAt?: number;
  privateIp?: string;
  publicIp?: string;
  privateDns?: string;
  publicDns?: string;
  elasticIps?: string[];
  vpcId?: string;
  subnetId?: string;
  securityGroups: string[];
  profileArn?: string;
  platform?: string;
  imageId?: string;
  az?: string;
  keyName?: string;
  tags: Record<string, string>;
  checks?: InstanceFacts["checks"];
  events?: string[];
  rebooting?: boolean;
}
export interface EcsHostRef { cluster: string; env?: string; protected: boolean }

const ec2Console = (region: string, hash: string) => `https://${region}.console.aws.amazon.com/ec2/home?region=${region}#${hash}`;

// Publicly addressable: a public IP now, or an Elastic IP it keeps across stops (facts.public, owner-set).
export const isPublicInstance = (i: Pick<InstanceView, "publicIp" | "elasticIps">) => !!i.publicIp || !!i.elasticIps?.length;

// Keys follow the console keys' region rule (CC-6): "ec2:<id>" in the home region, "ec2:<id>@<region>" elsewhere — the
// form the VPC, EBS, Cloud Map, CloudFormation and ARN-resolution rules use for parents and links. Outside home the
// region-less form is an alias too (links that name an instance by id alone still land on it), and with the account
// the instance's ARN is one, so Resource Explorer rows and ARNs in configuration match it.
export function instanceResource(i: InstanceView, region: string, ecs?: EcsHostRef, account?: string, home?: string): Resource {
  const h = instanceHealth(i);
  const t = i.tags;
  const eks = t["eks:cluster-name"] ?? t["eks:eks-cluster-name"];
  const key = keys.ec2(i.id, region, home);
  return {
    key, kind: "ec2-instance", provider: "ec2", name: t.Name || i.id, region, tags: t, health: h.health, healthReason: h.healthReason,
    props: props(
      prop("Instance id", i.id, true), prop("Type", i.type), prop("State", i.state), prop("Platform", i.platform),
      i.state === "running" && prop("Launched", day(i.launchedAt)),
      prop("Private IP", i.privateIp, true), prop("Public IP", i.publicIp, true), prop("Elastic IP", i.elasticIps?.join(", "), true),
      prop("Availability zone", i.az), prop("IAM instance profile", profileName(i.profileArn)), prop("AMI", i.imageId, true), prop("Key pair", i.keyName),
      ecs && prop("ECS cluster", `${ecs.cluster}${ecs.env ? ` (${ecs.env}${ecs.protected ? ", protected" : ""})` : ""}`),
      prop("Auto Scaling group", t["aws:autoscaling:groupName"]),
      eks && prop("EKS nodegroup", `${eks}${t["eks:nodegroup-name"] ? ` / ${t["eks:nodegroup-name"]}` : ""}`),
      prop("Beanstalk environment", t["elasticbeanstalk:environment-name"]),
    ),
    vpcId: i.vpcId, subnetIds: i.subnetId ? [i.subnetId] : undefined, securityGroups: i.securityGroups,
    endpoints: instanceEndpoints(i), aliases: uniq([i.id, key !== keys.ec2(i.id) ? keys.ec2(i.id) : undefined, account ? arnOf.ec2Instance(region, account, i.id) : undefined]),
    envHint: ecs?.env,
    facts: { public: isPublicInstance(i) },
    lastActivityAt: i.state === "stopped" ? stoppedSince(i.reason) : undefined,
    consoleUrl: ec2Console(region, `InstanceDetails:instanceId=${i.id}`),
  };
}

// What the instance runs as: its instance profile (the IAM provider answers to profile ARNs through its roles).
export function instanceLinks(i: Pick<InstanceView, "id" | "profileArn">, account?: string, region?: string, home?: string): Link[] {
  const profile = profileRef(i.profileArn, account, region);
  return profile ? [{ from: keys.ec2(i.id, region, home), to: profile, kind: "assumes", label: "instance profile", evidence: "IamInstanceProfile.Arn" }] : [];
}

export interface AsgView {
  name: string;
  arn: string;
  min: number;
  max: number;
  desired: number;
  instances: { id: string; lifecycle: string; health: string; type?: string; az?: string }[];
  launchTemplate?: string; // "name:version"
  launchConfig?: string;
  instanceTypes: string[]; // mixed-instances overrides
  targetGroups: string[];
  classicLbs: string[];
  subnets: string[];
  healthCheck?: string; // "ELB, grace 300 s"
  status?: string; // "Delete in progress"
  suspended: string[];
  tags: Record<string, string>;
  createdAt?: number;
}

// The instance type a group launches: what its members mostly run, else its first mixed-instances override.
export const asgType = (g: Pick<AsgView, "instances" | "instanceTypes">) => mostCommon(g.instances.map((x) => x.type)) ?? g.instanceTypes[0];

export function asgResource(g: AsgView, region: string, home?: string): { resource: Resource; links: Link[]; mentions: Mention[] } {
  const inService = g.instances.filter((x) => x.lifecycle === "InService" && x.health === "Healthy").length;
  const unhealthy = g.instances.filter((x) => x.health !== "Healthy").length;
  const owner = asgOwner(g.tags);
  let health: Health = "ok";
  let healthReason: string | undefined;
  if (g.status) [health, healthReason] = ["warning", g.status.toLowerCase()];
  else if (g.desired === 0 && !g.instances.length) [health, healthReason] = ["stopped", "scaled to 0"];
  else if (unhealthy) [health, healthReason] = ["warning", `${unhealthy} unhealthy instance${unhealthy === 1 ? "" : "s"}`];
  else if (inService < g.desired) [health, healthReason] = ["warning", `${inService}/${g.desired} in service`];
  const resource: Resource = {
    key: g.arn, kind: "asg", provider: "asg", name: g.name, region, tags: g.tags, health, healthReason,
    props: props(
      prop("Min / desired / max", `${g.min} / ${g.desired} / ${g.max}`), prop("In service", `${inService} of ${g.instances.length}`),
      prop("Instance type", asgType(g)), prop("Launch template", g.launchTemplate ?? g.launchConfig), prop("Target groups", g.targetGroups.length || undefined),
      prop("Health check", g.healthCheck), owner && prop("Managed by", owner.by === "eks" ? `EKS nodegroup ${owner.name}` : owner.by === "beanstalk" ? `Beanstalk ${owner.name}` : owner.name),
      prop("Suspended processes", g.suspended.join(", ")),
    ),
    subnetIds: g.subnets.length ? g.subnets : undefined, aliases: [g.name], createdAt: g.createdAt,
    consoleUrl: ec2Console(region, `AutoScalingGroupDetails:id=${encodeURIComponent(g.name)}`),
  };
  const links = g.instances.map((x): Link => ({ from: g.arn, to: keys.ec2(x.id, region, home), kind: "uses", label: "member", evidence: `Auto Scaling group member (${x.lifecycle}, ${x.health})` }));
  const mentions: Mention[] = [];
  if (g.targetGroups.length) mentions.push({ from: g.arn, refs: g.targetGroups, via: "target group" });
  if (g.classicLbs.length) mentions.push({ from: g.arn, refs: g.classicLbs, via: "classic load balancer" });
  return { resource, links, mentions };
}
