// The ECS side of the cloud map as pure rules (src/lib/server/providers/ecs.ts does the reading): load balancer health
// from its control plane and its target groups (R17, F01), route edges and hostnames from listener rules (F72), what an
// ECS service is wired to (roles, Cloud Map, EFS, Service Connect, task IPs, autoscaling — audit A.3, F18, CC-20), RDS
// and ElastiCache posture (F16), and the mentions an env file yields (F17). No I/O and no server-only, so node:test
// covers every rule here (ecs-map.test.ts).
//
// Trust boundary: env-file and environment values only ever become Mention.refs (matched on the server, then dropped).
// Nothing here puts a value into a Resource, a Link's label or evidence, or a Mention's `via`.
import { placement } from "../discover.ts";
import { envFileVars, parseEnvFile } from "../envvars.ts";
import type { ChartMetricSpec } from "../metric-specs.ts";
import { targetGroupsHealth, tgHealthToResource, type TgInput } from "../status.ts";
import type { RawCache, RawDb, RawLbTarget, RawSecurityGroup, RawService } from "../types.ts";
import { arnOf } from "./arn.ts";
import { keys, type Facts, type Health, type Link, type Mention, type Prop, type Resource, type ResourceDetail } from "./types.ts";

const uniq = (a: (string | undefined)[]): string[] => [...new Set(a.filter((x): x is string => !!x))];
const prop = (label: string, value: string | number | undefined, mono = false): Prop[] =>
  value === undefined || value === "" ? [] : [{ label, value: String(value), ...(mono ? { mono } : {}) }];
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const day = (ms?: number) => (ms ? new Date(ms).toISOString().slice(0, 10) : undefined);

// ---------- load balancers (R16, R17, F01, F72) ----------

export interface ElbTargetGroup {
  arn: string;
  name: string;
  type?: string; // instance | ip | lambda | alb
  protocol?: string;
  port?: number;
  healthPath?: string;
  lbArns: string[]; // the load balancers whose listeners forward to it
  // Per-target health (DescribeTargetHealth), or only counts (the simulated account's Cloud.targetHealth). Neither: the
  // health wasn't read (denied, time budget) — no evidence either way.
  targets?: RawLbTarget[];
  counts?: { healthy: number; unhealthy: number; initial?: number; draining?: number };
}

export interface ElbRule {
  priority: string; // "10" | "default"
  hosts: string[];
  paths: string[];
  action: string; // forward | redirect | fixed-response | authenticate-oidc+forward
  targetGroupArns: string[]; // weighted forwards name several
}

export interface ElbListener {
  protocol: string;
  port: number;
  rules: ElbRule[];
}

export interface ElbLoadBalancer {
  arn: string;
  name: string;
  dns?: string;
  type?: string; // application | network | gateway
  scheme?: string; // internet-facing | internal
  state?: string; // active | provisioning | active_impaired | failed
  vpcId?: string;
  securityGroups?: string[];
  azs?: string[];
  createdAt?: number;
  tags?: Record<string, string>; // undefined: not read
  logs?: { bucket: string; prefix?: string }; // access logs → S3
  listeners?: ElbListener[]; // undefined: not read
}

// What ECS discovery says about one region's target groups. Optional: the elb provider lists everything on its own and
// joins this only when it arrives in time (R16).
export interface EcsJoin {
  byTg: Map<string, { key: string; env: string; desired: number; hidden: boolean }[]>;
  byIp: Map<string, string>; // RUNNING task private IP → ECS service key
}

const TG_NAME = (arn: string) => /targetgroup\/([^/]+)/.exec(arn)?.[1] ?? arn;

// A group's target type from its targets, when the listing didn't say (the Cloud adapter's configuration omits it).
export function targetType(targets: RawLbTarget[]): string | undefined {
  const id = targets[0]?.id;
  if (!id) return undefined;
  if (/^i-[0-9a-z]+$/.test(id)) return "instance"; // AWS ids are hex; an IP target never starts with "i-"
  if (/^arn:aws[a-z-]*:lambda:/.test(id)) return "lambda";
  if (/^arn:aws[a-z-]*:elasticloadbalancing:.*:loadbalancer\//.test(id)) return "alb";
  return "ip";
}

// Target states → the counts targetGroupsHealth() needs. "unavailable" because health checks are off (Lambda's
// default) still serves traffic: healthy. "unused" (not registered in an enabled zone, a stopped instance) serves
// nothing and is left out, so a group of only such targets has no healthy one. Any other "unavailable" proves nothing.
export function tgCounts(g: ElbTargetGroup): { healthy: number; unhealthy: number; initial: number; draining: number; unused: number; unknown: number } | undefined {
  if (g.targets) {
    const c = { healthy: 0, unhealthy: 0, initial: 0, draining: 0, unused: 0, unknown: 0 };
    for (const t of g.targets) {
      if (t.state === "healthy" || (t.state === "unavailable" && t.reason === "Target.HealthCheckDisabled")) c.healthy++;
      else if (t.state === "unhealthy" || t.state === "unhealthy.draining") c.unhealthy++;
      else if (t.state === "initial") c.initial++;
      else if (t.state === "draining") c.draining++;
      else if (t.state === "unused") c.unused++;
      else c.unknown++;
    }
    return c;
  }
  if (g.counts) return { healthy: g.counts.healthy, unhealthy: g.counts.unhealthy, initial: g.counts.initial ?? 0, draining: g.counts.draining ?? 0, unused: 0, unknown: 0 };
  return undefined;
}

// Registered targets, when known (undefined: health not read).
export const targetCount = (g: ElbTargetGroup): number | undefined => {
  const c = tgCounts(g);
  return c ? c.healthy + c.unhealthy + c.initial + c.draining + c.unused + c.unknown : undefined;
};

// One group's input to targetGroupsHealth(), or undefined when it gives no evidence (health unread, or every target's
// state unavailable). `desired`: the summed desired count of the ECS services attached (undefined: none, or unknown).
export function tgInput(g: ElbTargetGroup, desired?: number): TgInput | undefined {
  const c = tgCounts(g);
  if (!c) return undefined;
  if (c.unknown && !(c.healthy + c.unhealthy + c.initial + c.draining + c.unused)) return undefined;
  return { arn: g.arn, name: g.name, healthy: c.healthy, unhealthy: c.unhealthy, initial: c.initial, draining: c.draining, ...(desired !== undefined ? { desired } : {}) };
}

interface Verdict {
  health: Health;
  reason?: string;
}

// The control plane's own word (State.Code).
export function controlHealth(state?: string): Verdict {
  if (state === undefined || state === "active") return { health: "ok" };
  if (state === "failed") return { health: "error", reason: "load balancer failed" };
  if (state === "provisioning" || state === "active_impaired") return { health: "warning", reason: state.replace("_", " ") };
  return { health: "unknown", reason: `state ${state}` };
}

// Health = combine(control plane, backend serving health). The backend comes only from target groups: none, or none
// whose health was read, is unknown ("no backend evidence"), never a default ok (R17). A group with no targets whose
// ECS services are all scaled to 0 is idle (parked) and fine; behind a service with desired > 0, or with no service
// (or ECS unread), an empty group is bad (F01).
export function lbHealth(
  state: string | undefined, groups: { g: ElbTargetGroup; desired?: number }[], o: { ecsRead?: boolean } = {},
): { health: Health; healthReason?: string; control: Verdict; backend: Verdict } {
  const control = controlHealth(state);
  let backend: Verdict;
  let idle = false;
  if (!groups.length) backend = { health: "unknown", reason: "no backend evidence (no target groups)" };
  else {
    const inputs = groups.map((x) => tgInput(x.g, x.desired)).filter((x): x is TgInput => !!x);
    if (!inputs.length) backend = { health: "unknown", reason: "no backend evidence (target health not read)" };
    else {
      const r = targetGroupsHealth(inputs);
      const res = tgHealthToResource(r);
      idle = r.idle.length > 0;
      const unread = groups.length - inputs.length;
      const empty = res.health !== "ok" && o.ecsRead === false && inputs.some((x) => x.desired === undefined && x.healthy + x.unhealthy + (x.initial ?? 0) + (x.draining ?? 0) === 0);
      backend = {
        health: res.health,
        reason: `${res.reason}${unread ? ` · ${plural(unread, "target group")} not read` : ""}${empty ? " (ECS services not read: an empty group of a stopped service can't be told apart)" : ""}`,
      };
    }
  }
  const pick = (v: Verdict) => ({ health: v.health, ...(v.reason ? { healthReason: v.reason } : {}), control, backend });
  if (control.health === "error") return pick(control);
  if (backend.health === "error") return pick(backend);
  if (control.health === "warning") return pick(control);
  if (backend.health === "warning") return pick(backend);
  if (control.health === "unknown") return pick(control);
  if (backend.health === "unknown") return pick(backend);
  return { health: "ok", ...(idle && backend.reason ? { healthReason: backend.reason } : {}), control, backend };
}

// "3 healthy · 1 unhealthy · 1 registering", or undefined when nothing was read.
export function targetSummary(groups: ElbTargetGroup[]): string | undefined {
  const all = groups.map(tgCounts).filter((c): c is NonNullable<ReturnType<typeof tgCounts>> => !!c);
  if (!all.length) return undefined;
  const sum = (k: keyof (typeof all)[number]) => all.reduce((a, c) => a + c[k], 0);
  const parts = [
    sum("healthy") && `${sum("healthy")} healthy`, sum("unhealthy") && `${sum("unhealthy")} unhealthy`, sum("initial") && `${sum("initial")} registering`,
    sum("draining") && `${sum("draining")} draining`, sum("unused") && `${sum("unused")} unused`, sum("unknown") && `${sum("unknown")} unknown`,
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : "no registered targets";
}

// ---------- the ELB API's shapes → the above (structural, so this module needs no SDK) ----------

interface SdkAction { Type?: string; Order?: number; TargetGroupArn?: string; ForwardConfig?: { TargetGroups?: { TargetGroupArn?: string }[] } }
interface SdkCondition { Field?: string; Values?: string[]; HostHeaderConfig?: { Values?: string[] }; PathPatternConfig?: { Values?: string[] } }

// Actions in order ("authenticate-oidc+forward"); a weighted forward names every group it splits over.
export function elbAction(actions: SdkAction[] | undefined): Pick<ElbRule, "action" | "targetGroupArns"> {
  const sorted = [...(actions ?? [])].sort((a, b) => (a.Order ?? 0) - (b.Order ?? 0));
  const tgs = sorted.flatMap((a) => (a.Type === "forward" ? [a.TargetGroupArn, ...(a.ForwardConfig?.TargetGroups ?? []).map((x) => x.TargetGroupArn)] : []));
  return { action: sorted.map((a) => a.Type ?? "").filter(Boolean).join("+") || "none", targetGroupArns: uniq(tgs) };
}

export function elbRule(r: { Priority?: string; IsDefault?: boolean; Conditions?: SdkCondition[]; Actions?: SdkAction[] }): ElbRule {
  const values = (field: string) =>
    (r.Conditions ?? []).filter((c) => c.Field === field).flatMap((c) => (field === "host-header" ? c.HostHeaderConfig?.Values : c.PathPatternConfig?.Values) ?? c.Values ?? []);
  return { priority: r.IsDefault ? "default" : r.Priority ?? "?", hosts: values("host-header"), paths: values("path-pattern"), ...elbAction(r.Actions) };
}

export function elbLoadBalancer(l: {
  LoadBalancerArn?: string; LoadBalancerName?: string; DNSName?: string; Type?: string; Scheme?: string; State?: { Code?: string }; VpcId?: string; SecurityGroups?: string[];
  AvailabilityZones?: { ZoneName?: string }[]; CreatedTime?: Date;
}): ElbLoadBalancer {
  const arn = l.LoadBalancerArn ?? "";
  return {
    arn, name: l.LoadBalancerName ?? arn.split(":loadbalancer/")[1]?.split("/")[1] ?? arn, dns: l.DNSName, type: l.Type, scheme: l.Scheme, state: l.State?.Code, vpcId: l.VpcId,
    securityGroups: l.SecurityGroups, azs: (l.AvailabilityZones ?? []).map((z) => z.ZoneName ?? "").filter(Boolean), createdAt: l.CreatedTime?.getTime(),
  };
}

export function elbTargetGroup(g: { TargetGroupArn?: string; TargetGroupName?: string; TargetType?: string; Protocol?: string; Port?: number; HealthCheckPath?: string; LoadBalancerArns?: string[] }): ElbTargetGroup {
  return { arn: g.TargetGroupArn ?? "", name: g.TargetGroupName ?? TG_NAME(g.TargetGroupArn ?? ""), type: g.TargetType, protocol: g.Protocol, port: g.Port, healthPath: g.HealthCheckPath, lbArns: g.LoadBalancerArns ?? [] };
}

const ruleWhat = (r: ElbRule) => [...r.hosts, ...r.paths].join(" ") || (r.priority === "default" ? "default" : `rule ${r.priority}`);

// The groups a load balancer forwards to: those naming it, plus any its rules name.
export const groupsOf = (lb: ElbLoadBalancer, all: ElbTargetGroup[]): ElbTargetGroup[] => {
  const named = new Set((lb.listeners ?? []).flatMap((l) => l.rules.flatMap((r) => r.targetGroupArns)));
  return all.filter((g) => g.lbArns.includes(lb.arn) || named.has(g.arn));
};

// Route edges: listener rule → each ECS service behind the group (the rule's hosts/paths as the label, " · no targets"
// when the group has none — F72), else → each registered target (instance → EC2, ip → the ECS task that holds it or
// the address itself, lambda → the function, alb → that load balancer). Groups no rule names (rules unread, NLB
// default actions) are linked by name. `at`: the load balancer's region and the home region, for instance keys outside
// home (ec2:<id>@<region>). Several rules into one group are one connection on the map: every link gets the first
// rule's label plus "+N" for the other hosts and paths, and each rule's evidence names its own.
export function lbLinks(from: string, lb: ElbLoadBalancer, groups: ElbTargetGroup[], join?: EcsJoin, at?: { region: string; home: string }): Link[] {
  const out: Link[] = [];
  const byArn = new Map(groups.map((g) => [g.arn, g]));
  const done = new Set<string>();
  const conds = (r: ElbRule) => [...r.hosts, ...r.paths];
  const reach = new Map<string, { label: string; first: Set<string>; all: Set<string> }>(); // target group → its rules
  for (const l of lb.listeners ?? [])
    for (const r of l.rules)
      for (const arn of r.targetGroupArns) {
        const g = reach.get(arn) ?? { label: ruleWhat(r), first: new Set(conds(r)), all: new Set<string>() };
        for (const c of conds(r)) g.all.add(c);
        reach.set(arn, g);
      }
  const labelOf = (arn: string) => {
    const g = reach.get(arn)!;
    const more = [...g.all].filter((c) => !g.first.has(c)).length;
    return more ? `${g.label} +${more}` : g.label;
  };
  const to = (arn: string, label: string, evidence: string) => {
    const g = byArn.get(arn);
    const name = g?.name ?? TG_NAME(arn);
    const empty = g && targetCount(g) === 0;
    const svcs = (join?.byTg.get(arn) ?? []).filter((s) => !s.hidden);
    if (svcs.length) {
      for (const s of svcs) out.push({ from, to: s.key, kind: "route", label: `${label}${empty ? " · no targets" : ""}`, evidence });
      return;
    }
    if (!g?.targets) return;
    for (const t of g.targets.slice(0, 50)) {
      const port = t.port ? ` → :${t.port}` : "";
      const why = `${evidence}: ${t.state}`;
      if (g.type === "lambda") out.push({ from, to: t.id, kind: "invoke", label: name, evidence: `${evidence} (Lambda target)` });
      else if (g.type === "instance") out.push({ from, to: keys.ec2(t.id, at?.region, at?.home), kind: "route", label: `${label}${port}`, evidence: why });
      else if (g.type === "alb") out.push({ from, to: t.id, kind: "route", label: `${label}${port}`, evidence: why });
      else out.push({ from, to: join?.byIp.get(t.id) ?? t.id, kind: "route", label: `${label}${port}`, evidence: why });
    }
  };
  for (const l of lb.listeners ?? [])
    for (const r of l.rules)
      for (const arn of r.targetGroupArns) {
        done.add(arn);
        const what = conds(r).join(" ");
        to(arn, labelOf(arn), `listener ${l.protocol}:${l.port} rule ${r.priority}${what ? ` (${what})` : ""} → ${byArn.get(arn)?.name ?? TG_NAME(arn)}`);
      }
  for (const g of groups) if (!done.has(g.arn)) to(g.arn, g.name, `target group ${g.name}`);
  return out;
}

// Hostnames of forward rules, per target group: they become endpoints of the services behind the group (F72), so a
// URL naming one finds its service.
export function ruleHosts(listeners: ElbListener[] | undefined): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const l of listeners ?? [])
    for (const r of l.rules) {
      if (!/forward/.test(r.action) || !r.hosts.length) continue;
      for (const tg of r.targetGroupArns) out.set(tg, uniq([...(out.get(tg) ?? []), ...r.hosts.filter((h) => !h.includes("*"))]));
    }
  return out;
}

const consoleLbUrl = (region: string, arn: string) => `https://${region}.console.aws.amazon.com/ec2/home?region=${region}#LoadBalancer:loadBalancerArn=${encodeURIComponent(arn)}`;

// The map resource of one load balancer. `groups`: the target groups it forwards to (groupsOf).
export function lbResource(lb: ElbLoadBalancer, groups: ElbTargetGroup[], o: { region: string; home: string; join?: EcsJoin }): Resource {
  const desired = (g: ElbTargetGroup) => {
    const svcs = o.join?.byTg.get(g.arn);
    return svcs?.length ? svcs.reduce((a, s) => a + s.desired, 0) : undefined;
  };
  const h = lbHealth(lb.state, groups.map((g) => ({ g, desired: desired(g) })), { ecsRead: !!o.join });
  const envs = new Set(groups.flatMap((g) => o.join?.byTg.get(g.arn) ?? []).map((s) => s.env));
  const listeners = lb.listeners?.map((l) => `${l.protocol}:${l.port}`).join(", ");
  return {
    key: keys.loadBalancer(lb.name, o.region, o.home), kind: "loadbalancer", provider: "elb", name: lb.name, region: o.region, tags: { ...(lb.tags ?? {}) },
    ...(lb.tags === undefined ? { tagsUnread: true } : {}),
    health: h.health, ...(h.healthReason ? { healthReason: h.healthReason } : {}),
    props: [
      ...prop("Type", lb.type),
      ...prop("Scheme", lb.scheme),
      ...prop("State", lb.state),
      ...prop("Backend", h.backend.health === "ok" ? h.backend.reason ?? "healthy" : h.backend.reason),
      ...prop("DNS name", lb.dns, true),
      ...prop("Listeners", listeners || undefined),
      ...prop("Target groups", groups.length),
      ...prop("Targets", targetSummary(groups)),
      ...prop("Availability zones", lb.azs?.join(", ")),
    ],
    vpcId: lb.vpcId,
    securityGroups: lb.securityGroups?.length ? lb.securityGroups : undefined,
    endpoints: lb.dns ? [lb.dns] : undefined,
    aliases: [lb.arn],
    envHint: envs.size === 1 ? [...envs][0] : undefined,
    consoleUrl: consoleLbUrl(o.region, lb.arn),
    createdAt: lb.createdAt,
    ...(lb.scheme ? { facts: { public: lb.scheme === "internet-facing" } } : {}),
  };
}

// The detail panel's tables for a load balancer.
export function lbSections(lb: ElbLoadBalancer, groups: ElbTargetGroup[], join?: EcsJoin): ResourceDetail["sections"] {
  const name = (arn: string) => groups.find((g) => g.arn === arn)?.name ?? TG_NAME(arn);
  // Hidden services stay off the map, so off its tables too (their desired counts still count for health).
  const services = (arn: string) => (join?.byTg.get(arn) ?? []).filter((s) => !s.hidden).map((s) => s.key.replace(/^ecs:service\/[^/]+\//, "")).join(", ");
  const sections: ResourceDetail["sections"] = [];
  if (lb.listeners)
    sections.push({
      title: "Listener rules",
      table: {
        columns: ["Listener", "Priority", "Hosts", "Paths", "Action", "Target group"],
        rows: lb.listeners.flatMap((l) => l.rules.map((r) => [`${l.protocol}:${l.port}`, r.priority, r.hosts.join(" "), r.paths.join(" "), r.action, r.targetGroupArns.map(name).join(", ")])),
      },
    });
  else sections.push({ title: "Listener rules", note: "Not read (the console's role can't read them, or the time budget ran out)." });
  sections.push({
    title: "Target groups",
    table: {
      columns: ["Target group", "Type", "Port", "Health check", "Targets", "ECS services"],
      rows: groups.map((g) => [g.name, g.type ?? "", g.port ? `${g.protocol ?? ""}:${g.port}`.replace(/^:/, "") : "", g.healthPath ?? "", targetSummary([g]) ?? "not read", services(g.arn)]),
    },
  });
  const targets = groups.flatMap((g) => (g.targets ?? []).slice(0, 50).map((t) => [g.name, t.id, t.port ? String(t.port) : "", t.az ?? "", t.state, t.reason ?? t.description ?? ""]));
  if (targets.length) sections.push({ title: "Targets", table: { columns: ["Target group", "Target", "Port", "Zone", "State", "Reason"], rows: targets.slice(0, 200) } });
  return sections;
}

// ---------- ECS services: what they're wired to (A.3, F18, CC-20) ----------

export interface Scaling {
  min: number;
  max: number;
  policies: string[]; // "target tracking (CPU 60 %)"
}

// "min 2 · max 6 · target tracking (CPU 60 %)" (CC-20).
export const scalingText = (t: Scaling) => [`min ${t.min}`, `max ${t.max}`, ...t.policies].join(" · ");

// Links, aliases, endpoints, props and facts an ECS service adds beyond its own resource: task and execution roles
// (assumes), Cloud Map registries (route, "ECS service registry"), EFS volumes (mounts), Service Connect names as
// aliases (so "http://web:8080" in another service's env resolves), RUNNING task private IPs and listener-rule
// hostnames as endpoints, the deployment controller and autoscaling as props, facts.public from assignPublicIp and
// facts.desired (the desired task count, for health rules that compare it with what is registered).
export function serviceWires(
  s: RawService, o: { key: string; region: string; account?: string; scaling?: Scaling; ruleHosts?: string[] },
): { links: Link[]; aliases: string[]; endpoints: string[]; props: Prop[]; facts?: Facts } {
  const td = s.taskDef;
  const where = td ? `task definition ${td.family}:${td.revision}` : "task definition";
  const links: Link[] = [];
  if (td?.taskRoleArn) links.push({ from: o.key, to: td.taskRoleArn, kind: "assumes", label: "task role", evidence: `${where} taskRoleArn` });
  if (td?.executionRoleArn) links.push({ from: o.key, to: td.executionRoleArn, kind: "assumes", label: "execution role", evidence: `${where} executionRoleArn` });
  for (const r of s.serviceRegistries ?? [])
    links.push({
      from: r.registryArn, to: o.key, kind: "route", label: "ECS service registry",
      evidence: `ECS service registry${r.containerName ? ` → ${r.containerName}${r.containerPort ? `:${r.containerPort}` : ""}` : ""}`,
    });
  for (const v of td?.volumes ?? []) {
    if (!v.efs?.fileSystemId) continue;
    links.push({
      from: o.key, to: o.account ? arnOf.efs(o.region, o.account, v.efs.fileSystemId) : v.efs.fileSystemId, kind: "mounts",
      label: v.efs.accessPointId ? `${v.name} (access point ${v.efs.accessPointId})` : v.name, evidence: `${where} EFS volume ${v.name}`,
    });
  }
  const sc = s.serviceConnect ?? [];
  const aliases = uniq([...sc.map((x) => x.discoveryName), ...sc.flatMap((x) => x.clientAliases.map((a) => a.dnsName))]);
  const endpoints = uniq([...(o.ruleHosts ?? []), ...s.tasks.filter((t) => t.lastStatus === "RUNNING").map((t) => t.privateIp)]);
  const controller = s.deploymentController === "CODE_DEPLOY" ? "CodeDeploy" : s.deploymentController === "EXTERNAL" ? "an external controller" : undefined;
  const strategy = (s.capacityProviderStrategy ?? []).map((c) => `${c.provider}${c.base ? ` (base ${c.base})` : ""}${c.weight !== undefined && (s.capacityProviderStrategy?.length ?? 0) > 1 ? ` ×${c.weight}` : ""}`);
  const props: Prop[] = [
    ...prop("Deploys with", controller),
    ...prop("Capacity providers", strategy.join(", ")),
    ...(o.scaling ? prop("Autoscaling", scalingText(o.scaling)) : []),
    ...prop("Public IP", s.assignPublicIp ? "assigned to every task" : undefined),
    ...prop("Service Connect", aliases.join(", ")),
  ];
  return { links, aliases, endpoints, props, facts: { desired: s.desired, ...(s.assignPublicIp !== undefined ? { public: s.assignPublicIp } : {}) } };
}

// Where an ECS-on-EC2 service runs: "runs on" (or "starting on") each instance its live tasks are placed on. While some
// live tasks' hosts weren't read (placement().unplaced), the cluster's other instances are candidates — "may run on",
// up to 10, "runs on" when there is only one. A service with no live task runs nowhere: no link, however many hosts.
export function hostLinks(s: RawService, o: { key: string; region: string; home: string; cluster: string; hosts: string[] }): Link[] {
  const { on, unplaced } = placement(s);
  const links: Link[] = [...on].map(([id, c]) => ({
    from: o.key, to: keys.ec2(id, o.region, o.home), kind: "uses", label: c.running ? "runs on" : "starting on",
    evidence: `ECS task placement: ${[c.running && `${c.running} running`, c.starting && `${c.starting} starting`].filter(Boolean).join(", ")} on this instance`,
  }));
  if (unplaced && s.launchType === "EC2" && o.hosts.length <= 10)
    for (const h of o.hosts.filter((x) => !on.has(x)))
      links.push({
        from: o.key, to: keys.ec2(h, o.region, o.home), kind: "uses", label: o.hosts.length === 1 ? "runs on" : "may run on",
        evidence: `EC2 launch type in cluster ${o.cluster}: ${unplaced} task${unplaced === 1 ? "" : "s"} not placed in what was read`,
      });
  return links;
}

// ---------- RDS and ElastiCache (F16, CC-22) ----------

// A KMS key as AWS names it, as a resolvable reference: a full ARN stands; a bare key id or alias gets this region and
// account (an alias ARN, so "alias/aws/rds" resolves to that region's managed key — CC-19).
export function kmsRef(id: string | undefined, region: string, account?: string): string | undefined {
  if (!id) return undefined;
  if (id.startsWith("arn:")) return id;
  if (!account) return undefined;
  return id.startsWith("alias/") ? arnOf.kmsAlias(region, account, id) : arnOf.kmsKey(region, account, id);
}
const kmsShort = (id: string) => id.replace(/^arn:[^:]+:kms:[^:]*:\d*:/, "");

export function dbHealth(status: string): { health: Health; healthReason?: string } {
  if (status === "available") return { health: "ok" };
  if (status === "stopped") return { health: "stopped", healthReason: "stopped" };
  if (/^(failed|incompatible|inaccessible|storage-full|restore-error)/.test(status)) return { health: "error", healthReason: `status ${status}` };
  return { health: "warning", healthReason: `status ${status}` };
}

const backupsText = (days?: number, window?: string) =>
  days === undefined ? undefined : days === 0 ? "off" : `${plural(days, "day")}${window ? ` · window ${window} UTC` : ""}`;
const onOff = (v?: boolean) => (v === undefined ? undefined : v ? "on" : "off");
const yesNo = (v?: boolean) => (v === undefined ? undefined : v ? "yes" : "no");

export function rdsResource(d: RawDb, o: { region: string; home: string; account?: string; envHint?: string }): { resource: Resource; links: Link[] } {
  const key = keys.rds(d.id, o.region, o.home);
  const kms = d.storageEncrypted === false ? undefined : kmsRef(d.kmsKeyId, o.region, o.account);
  const links: Link[] = kms ? [{ from: kms, to: key, kind: "encrypts", label: "storage", evidence: "RDS storage encryption key (KmsKeyId)" }] : [];
  const resource: Resource = {
    key, kind: "rds", provider: "rds", name: d.id, region: o.region, tags: { ...d.tags },
    ...dbHealth(d.status),
    props: [
      ...prop("Engine", `${d.engine} ${d.engineVersion}`.trim()),
      ...prop("Class", d.instanceClass),
      ...prop("Storage", d.storageGb ? `${d.storageGb} GiB` : undefined),
      ...prop("Multi-AZ", d.multiAz ? "yes" : "no"),
      ...prop("Endpoint", d.endpoint ? `${d.endpoint}${d.port ? `:${d.port}` : ""}` : undefined, true),
      ...prop("Status", d.status),
      ...prop("Aurora cluster", d.aurora, true),
      ...prop("Publicly accessible", yesNo(d.publiclyAccessible)),
      ...prop("Encryption", d.storageEncrypted === undefined ? undefined : d.storageEncrypted ? (d.kmsKeyId ? `KMS ${kmsShort(d.kmsKeyId)}` : "on") : "not encrypted", d.storageEncrypted === true && !!d.kmsKeyId),
      ...prop("Backups", backupsText(d.backupRetentionDays, d.backupWindow)),
      ...prop("Deletion protection", onOff(d.deletionProtection)),
      ...prop("Created", day(d.createdAt)),
    ],
    vpcId: d.vpcId,
    subnetIds: d.subnetIds?.length ? d.subnetIds : undefined,
    securityGroups: d.securityGroups.length ? d.securityGroups : undefined,
    endpoints: d.endpoint ? [d.endpoint] : undefined,
    aliases: [...(o.account ? [arnOf.rdsDb(o.region, o.account, d.id)] : []), ...(d.aurora ? [`aurora:${d.aurora}`] : [])],
    ...(d.aurora && o.account ? { parent: arnOf.rdsCluster(o.region, o.account, d.aurora) } : {}),
    envHint: o.envHint,
    consoleUrl: `https://${o.region}.console.aws.amazon.com/rds/home?region=${o.region}#database:id=${encodeURIComponent(d.id)};is-cluster=false`,
    createdAt: d.createdAt,
    ...(d.publiclyAccessible !== undefined ? { facts: { public: d.publiclyAccessible } } : {}),
  };
  return { resource, links };
}

export function cacheHealth(status: string): { health: Health; healthReason?: string } {
  if (status === "available") return { health: "ok" };
  if (/failed|incompatible/.test(status)) return { health: "error", healthReason: `status ${status}` };
  return { health: "warning", healthReason: `status ${status}` };
}

// The ARN of a cache: its own, else built from its id (a replication group when it has member clusters).
export const cacheArn = (c: RawCache, region: string, account?: string): string | undefined =>
  c.arn ?? (account ? (c.memberClusters?.length ? arnOf.elasticacheRg(region, account, c.id) : arnOf.elasticacheCluster(region, account, c.id)) : undefined);

// `tags` undefined: not read (denied, time budget) — tagsUnread, so protection fails closed (R01).
export function cacheResource(
  c: RawCache, o: { region: string; home: string; account?: string; envHint?: string; tags?: Record<string, string>; vpcId?: string; subnetIds?: string[] },
): { resource: Resource; links: Link[] } {
  const key = keys.elasticache(c.id, o.region, o.home);
  const kms = c.atRestEncryption === false ? undefined : kmsRef(c.kmsKeyId, o.region, o.account);
  const links: Link[] = kms ? [{ from: kms, to: key, kind: "encrypts", label: "at rest", evidence: "ElastiCache at-rest encryption key (KmsKeyId)" }] : [];
  const arn = cacheArn(c, o.region, o.account);
  const members = c.memberClusters ?? [];
  const subnets = o.subnetIds ?? c.subnetIds;
  const resource: Resource = {
    key, kind: "elasticache", provider: "elasticache", name: c.id, region: o.region, tags: { ...(o.tags ?? {}) },
    ...(o.tags === undefined ? { tagsUnread: true } : {}),
    ...cacheHealth(c.status),
    props: [
      ...prop("Engine", `${c.engine}${c.engineVersion ? ` ${c.engineVersion}` : ""}`),
      ...prop("Node type", c.nodeType),
      ...prop("Nodes", c.nodes),
      ...prop("Members", members.length > 1 ? members.join(", ") : undefined, true),
      ...prop("Endpoint", c.endpoint ? `${c.endpoint}${c.port ? `:${c.port}` : ""}` : undefined, true),
      ...prop("Status", c.status),
      ...prop("Encryption at rest", c.atRestEncryption === undefined ? undefined : c.atRestEncryption ? (c.kmsKeyId ? `KMS ${kmsShort(c.kmsKeyId)}` : "on (AWS-owned key)") : "off", c.atRestEncryption === true && !!c.kmsKeyId),
      ...prop("In-transit encryption", onOff(c.transitEncryption)),
      ...prop("AUTH token", onOff(c.authToken)),
      ...prop("Backups", backupsText(c.snapshotRetentionDays, c.snapshotWindow)),
      ...prop("Automatic failover", c.automaticFailover),
      ...prop("Multi-AZ", yesNo(c.multiAz)),
      ...prop("Subnet group", c.subnetGroup, true),
      ...prop("Created", day(c.createdAt)),
    ],
    vpcId: o.vpcId ?? c.vpcId,
    subnetIds: subnets?.length ? subnets : undefined,
    securityGroups: c.securityGroups.length ? c.securityGroups : undefined,
    endpoints: c.endpoint ? [c.endpoint] : undefined,
    // CC-22: a member cluster ("acme-redis-001") names the group, by id and by ARN.
    aliases: uniq([arn, ...members, ...(o.account ? members.map((m) => arnOf.elasticacheCluster(o.region, o.account!, m)) : [])]),
    envHint: o.envHint,
    consoleUrl: `https://${o.region}.console.aws.amazon.com/elasticache/home?region=${o.region}#/${c.engine === "memcached" ? "memcached" : "redis"}/${encodeURIComponent(c.id)}`,
    createdAt: c.createdAt,
  };
  return { resource, links };
}

// ---------- detail panels ----------

// One security group's inbound rules on a line: "port 5432 ← sg-api, 10.0.0.0/16; all traffic ← pl-123".
export function inboundLine(inbound: RawSecurityGroup["inbound"]): string {
  return (
    inbound
      .map((p) => {
        const port = p.fromPort === undefined || p.fromPort === -1 ? "all traffic" : p.fromPort === p.toPort || p.toPort === undefined ? `port ${p.fromPort}` : `ports ${p.fromPort}-${p.toPort}`;
        const from = [...p.groups, ...(p.cidrs ?? []), ...(p.prefixLists ?? [])];
        return `${port} ← ${from.join(", ") || "?"}${p.description ? ` (${p.description})` : ""}`;
      })
      .join("; ") || "no inbound rules"
  );
}

export function sgSection(ids: string[], groups: RawSecurityGroup[]): ResourceDetail["sections"][number] {
  return {
    title: "Security groups",
    table: { columns: ["Group", "Name", "Inbound"], rows: ids.map((id) => { const g = groups.find((x) => x.id === id); return [id, g?.name ?? "", g ? inboundLine(g.inbound) : "(not read)"]; }) },
  };
}

const CHART_TITLES: Record<string, string> = {
  dbcpu: "CPU", dbconn: "Connections", dblat: "Latency", dbiops: "IOPS", dbmem: "Freeable memory", dbdisk: "Free storage",
  cachecpu: "CPU", cacheengine: "Engine CPU", cachemem: "Memory used", cacheconn: "Connections", cacheevict: "Evictions",
};

// Chart specs → the Cloud.metrics() queries (ids "m0", "m1", …).
export const metricQueries = (specs: ChartMetricSpec[]) =>
  specs.map((s, i) => ({ id: `m${i}`, namespace: s.namespace, metric: s.metric, dims: { ...s.dims }, stat: s.stat }));

// …and its answer → the panel's series, scaled, one per spec. A series of a chart with several ("Latency · Read").
export function metricSeries(specs: ChartMetricSpec[], data: Record<string, [number, number][]>): NonNullable<ResourceDetail["metrics"]> {
  const perChart = new Map<string, number>();
  for (const s of specs) perChart.set(s.chart, (perChart.get(s.chart) ?? 0) + 1);
  return specs.map((s, i) => {
    const title = CHART_TITLES[s.chart];
    const label = (perChart.get(s.chart) ?? 0) > 1 && title ? `${title} · ${s.label}` : s.label;
    const k = s.scale ?? 1;
    return { id: `${s.chart}-${i}`, label, unit: s.unit, points: (data[`m${i}`] ?? []).map(([t, v]) => [t, v * k] as [number, number]) };
  });
}

// ---------- env files (F17) ----------

// Env files the console may read: those of services known not to be the console. A file any possibly-self service
// uses (self, or unknown — no meta; drawn on the map or not) is never read, even when another service shares it.
// `files` undefined: not known (task definition or cluster unread) — if that service may be the console, any file
// could be its own, so none is read (fail closed).
export function envFilesToRead(services: { files?: string[]; self: boolean }[]): string[] {
  if (services.some((s) => s.self && !s.files)) return [];
  const mine = new Set(services.filter((s) => s.self).flatMap((s) => s.files ?? []));
  return uniq(services.filter((s) => !s.self).flatMap((s) => s.files ?? [])).filter((f) => !mine.has(f));
}

// One mention per variable (values ≤ 4096 characters), named by the variable: "env file DATABASE_URL". The value is a
// ref only — matched against the account's names and endpoints on the server, never stored or shown.
export function envFileMentions(from: string, text: string): Mention[] {
  return envFileVars(parseEnvFile(text))
    .filter((v) => v.value && v.value.length <= 4096)
    .map((v) => ({ from, refs: [v.value], via: `env file ${v.name}` }));
}
