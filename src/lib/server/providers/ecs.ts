// The ECS side of the console as cloud-map providers: ECS services, load balancers, RDS instances and ElastiCache
// clusters. ECS services come from the discovery engine (../discovery.ts — the same 60 s inventory the environment views
// use) and the `Cloud` door (../sources.ts), so the simulated account works unchanged and the map, the ECS views and
// the actions always agree. Load balancers, RDS and ElastiCache are listed on their own, per region (R16): ECS
// ownership (which service sits behind a target group, which environment a database serves) is joined in when ECS
// discovery answers in time, and a failed or slow ECS pass only leaves a note. The rules (health, links, posture,
// env-file mentions) are pure, in ../../inventory/ecs-map.ts.
//
// Also here, because every AWS SDK command a provider file imports is listed in a provider's IAM lists: the two calls
// the inventory core itself makes — cloudwatch:GetMetricData (activity metrics for idle detection) is declared in the
// "ecs" provider's read list; sts:GetCallerIdentity (account id) needs no permission, so it isn't.
//
// Trust boundary: task-definition environment values and env-file values (F17) are read server-side and handed to the
// inventory only as Mention.refs (matched against other resources, then dropped). Props carry names, counts, images and
// hostnames only. The console's own service's env files are never read (meta.self, failing closed).
import "server-only";
import { CloudWatchClient, GetMetricDataCommand } from "@aws-sdk/client-cloudwatch";
import { DescribeCacheSubnetGroupsCommand, ElastiCacheClient, ListTagsForResourceCommand } from "@aws-sdk/client-elasticache";
import {
  DescribeListenersCommand, DescribeLoadBalancerAttributesCommand, DescribeLoadBalancersCommand, DescribeRulesCommand, DescribeTagsCommand,
  DescribeTargetGroupsCommand, ElasticLoadBalancingV2Client,
  type Listener, type Rule,
} from "@aws-sdk/client-elastic-load-balancing-v2";
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import { LIMITS } from "../../config.ts";
import { parseArn } from "../../inventory/arn.ts";
import {
  cacheArn, cacheResource, elbAction, elbLoadBalancer, elbRule, elbTargetGroup, envFileMentions, envFilesToRead, groupsOf, hostLinks, lbLinks, lbResource, lbSections, metricQueries,
  metricSeries, rdsResource, ruleHosts, serviceWires, sgSection, targetType, type EcsJoin, type ElbListener, type ElbLoadBalancer,
  type ElbTargetGroup, type Scaling,
} from "../../inventory/ecs-map.ts";
import { keys, type EnrichState, type Link, type Mention, type Prop, type Resource, type ResourceDetail } from "../../inventory/types.ts";
import { elasticacheSpecs, rdsSpecs, type ChartMetricSpec } from "../../metric-specs.ts";
import type { RawLb, RawService } from "../../types.ts";
import { limitedClient } from "../aws-limiter.ts";
import { connectionCredentials } from "../connection-credentials.ts";
import { perGeneration } from "../connection-state.ts";
import { cached } from "../cache.ts";
import { latestOverview } from "../console.ts";
import { inRegion, inventory, servicesOf, type Inventory } from "../discovery.ts";
import { errText } from "../errors.ts";
import { cloudFor, getCloud, homeRegion, type Cloud, type LbConfig } from "../sources.ts";
import { EXISTING, S3 as MOCK_S3, STANDALONE_ALB } from "./mock-names.ts";
import { budget, enrich, paged, perRegion, sdkConfig, softly, t } from "./serverless-util.ts";
import { deniedAction, type Provider, type ProviderContext } from "./types.ts";

const chunk = <T,>(a: T[], n: number) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));
const ago = (ms?: number) => (ms ? new Date(ms).toISOString().replace("T", " ").slice(0, 16) + " UTC" : "—");
const prop = (label: string, value: string | number | undefined, mono = false): Prop[] => (value === undefined || value === "" ? [] : [{ label, value: String(value), ...(mono ? { mono } : {}) }]);
const accountOf = (ctx: { accountId?: string }, arn?: string) => ctx.accountId ?? arn?.split(":")[4];
const lbName = (arn: string) => arn.split(":loadbalancer/")[1]?.split("/")[1] ?? arn;
const lbDims = (arn: string) => arn.split(":loadbalancer/")[1]; // "app/name/id" — CloudWatch's LoadBalancer dimension
const homeOf = async (ctx: { home?: string }) => ctx.home ?? homeRegion();
const regionOfArn = (arn: string, home: string) => arn.split(":")[3] || home;
const servicesIn = (env: { cluster: string; region: string }) => servicesOf(env.cluster, env.region);
const where = (ctx: ProviderContext, home: string) => (ctx.region !== home || (ctx.regions?.length ?? 1) > 1 ? ` in ${ctx.region}` : "");

// An optional join (ECS ownership, environment of a database): waited for until `until` at most (or the deadline),
// never thrown.
async function joined<T>(p: Promise<T>, until: number, signal: AbortSignal): Promise<{ value?: T; why?: string }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const late = new Promise<{ why: string }>((resolve) => {
    timer = setTimeout(() => resolve({ why: "still running" }), Math.max(500, until - Date.now()));
    onAbort = () => resolve({ why: "deadline" });
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([p.then((value) => ({ value }), (e) => ({ why: errText(e) })), late]);
  } finally {
    clearTimeout(timer);
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

// ECS ownership of one region's target groups and task IPs (for the elb provider; optional, R16).
async function ecsJoin(region: string, home: string): Promise<EcsJoin & { failed: number }> {
  const inv = await inventory();
  const byTg: EcsJoin["byTg"] = new Map();
  const byIp: EcsJoin["byIp"] = new Map();
  let failed = 0;
  await Promise.all(
    [...inv.catalogs.values()].filter((c) => c.env.region === region).map(async (cat) => {
      const services = await servicesIn(cat.env).catch(() => (failed++, [] as RawService[]));
      for (const s of services) {
        const key = keys.ecsService(cat.env.cluster, s.name, region, home);
        const hidden = !!cat.meta.get(s.name)?.hidden;
        for (const tg of s.targetGroupArns) byTg.set(tg, [...(byTg.get(tg) ?? []), { key, env: cat.env.id, desired: s.desired, hidden }]);
        if (!hidden) for (const x of s.tasks) if (x.lastStatus === "RUNNING" && x.privateIp) byIp.set(x.privateIp, key);
      }
    }),
  );
  return { byTg, byIp, failed };
}

// "<region>/<id>" → env id: an id can repeat across regions.
const dbOwners = (inv: Inventory | undefined) => {
  const db = new Map<string, string>(), cache = new Map<string, string>();
  for (const c of inv?.catalogs.values() ?? []) {
    for (const d of c.databases) db.set(`${c.env.region}/${d.id}`, c.env.id);
    for (const x of c.caches) cache.set(`${c.env.region}/${x.id}`, c.env.id);
  }
  return { db, cache };
};

// ---------- load balancers: reading ----------

const elb = perRegion((region) => new ElasticLoadBalancingV2Client(sdkConfig(region)), "elasticloadbalancing");

// Listeners, their rules and the access-log setting of one load balancer: configuration, so cached for 10 minutes
// (shared by the ecs provider's rule hostnames, the elb provider and the detail panel). Outside any caller's deadline.
async function lbConfigReal(region: string, arn: string): Promise<{ listeners: ElbListener[]; logs?: { bucket: string; prefix?: string } }> {
  return (
    await cached(`elb:config:${arn}`, 600_000, async () => {
      const o = () => ({ abortSignal: AbortSignal.timeout(LIMITS.awsTimeoutMs) });
      const listeners: Listener[] = [];
      let Marker: string | undefined;
      do {
        const r = await elb(region).send(new DescribeListenersCommand({ LoadBalancerArn: arn, Marker, PageSize: 400 }), o());
        listeners.push(...(r.Listeners ?? []));
        Marker = r.NextMarker;
      } while (Marker);
      const out: ElbListener[] = [];
      for (const l of listeners) {
        const rules: Rule[] = [];
        // Rules exist on HTTP(S) listeners; the others (TCP, UDP, TLS, GENEVE) only have default actions.
        if (l.ListenerArn && (l.Protocol === "HTTP" || l.Protocol === "HTTPS")) {
          let m: string | undefined;
          do {
            const r = await elb(region).send(new DescribeRulesCommand({ ListenerArn: l.ListenerArn, Marker: m, PageSize: 400 }), o());
            rules.push(...(r.Rules ?? []));
            m = r.NextMarker;
          } while (m);
        }
        out.push({ protocol: l.Protocol ?? "", port: l.Port ?? 0, rules: rules.length ? rules.map(elbRule) : [{ priority: "default", hosts: [], paths: [], ...elbAction(l.DefaultActions) }] });
      }
      // Access logs (Gateway Load Balancers have none).
      let logs: { bucket: string; prefix?: string } | undefined;
      if (!arn.includes(":loadbalancer/gwy/")) {
        const r = await elb(region).send(new DescribeLoadBalancerAttributesCommand({ LoadBalancerArn: arn }), o()).catch(() => undefined);
        const a = Object.fromEntries((r?.Attributes ?? []).map((x) => [x.Key ?? "", x.Value ?? ""]));
        if (a["access_logs.s3.enabled"] === "true" && a["access_logs.s3.bucket"]) logs = { bucket: a["access_logs.s3.bucket"], prefix: a["access_logs.s3.prefix"] || undefined };
      }
      return { listeners: out, logs };
    })
  ).value;
}

// One target group's health through the Cloud (shared with the ECS views' 10 s cache): counts, and every target when
// the adapter returns them.
async function healthOf(cloud: Cloud, g: ElbTargetGroup): Promise<void> {
  // `targets` is optional here: an adapter from before F58 answered counts only.
  const h = (await cloud.targetHealth([g.arn]))[0] as (Omit<Awaited<ReturnType<Cloud["targetHealth"]>>[number], "targets"> & { targets?: ElbTargetGroup["targets"] }) | undefined;
  if (!h) return;
  g.counts = { healthy: h.healthy, unhealthy: h.unhealthy, initial: h.initial, draining: h.draining };
  if (Array.isArray(h.targets)) {
    g.targets = h.targets;
    g.type ??= targetType(h.targets);
  }
}

// The simulated account has no ELB API: its load balancers are the ones mock-names declares, read through the mock
// Cloud (configuration, then target health): the production ALB and the internal ops ALB no ECS service uses.
const MOCK_LBS = [EXISTING.alb.arn, STANDALONE_ALB.arn];
const listenersOf = (raw: Pick<RawLb, "listeners">): ElbListener[] =>
  raw.listeners.map((l) => ({ protocol: l.protocol, port: l.port, rules: l.rules.map((r) => ({ priority: r.priority, hosts: r.hosts, paths: r.paths, action: r.action, targetGroupArns: r.targetGroupArn ? [r.targetGroupArn] : [] })) }));
// null: the simulated account has no such load balancer.
const mockConfig = (cloud: Cloud, arn: string): Promise<LbConfig | null> => cloud.lbConfig(arn).catch(() => null);
async function mockElb(cloud: Cloud, region: string, only?: string): Promise<{ lbs: ElbLoadBalancer[]; tgs: ElbTargetGroup[] }> {
  const lbs: ElbLoadBalancer[] = [];
  const tgs: ElbTargetGroup[] = [];
  for (const arn of MOCK_LBS.filter((a) => parseArn(a)?.region === region && (!only || a === only))) {
    const raw = await mockConfig(cloud, arn);
    if (!raw) continue;
    const acme = arn === EXISTING.alb.arn;
    lbs.push({
      arn, name: raw.name || lbName(arn), dns: raw.dns, type: raw.type, scheme: raw.scheme, state: raw.state, azs: raw.azs, createdAt: raw.createdAt, tags: {},
      vpcId: acme ? EXISTING.vpc.production : undefined, securityGroups: acme ? [EXISTING.securityGroups.prodAlb] : undefined,
      logs: acme ? { bucket: MOCK_S3.logs.name, prefix: "alb" } : undefined, listeners: listenersOf(raw),
    });
    for (const g of raw.targetGroups) tgs.push({ arn: g.arn, name: g.name, protocol: g.protocol, port: g.port, healthPath: g.healthPath, lbArns: [arn] });
  }
  await Promise.all(tgs.map((g) => healthOf(cloud, g).catch(() => undefined)));
  return { lbs, tgs };
}

// The listeners of one load balancer, whichever account (for the ecs provider's rule hostnames, F72).
async function listenersOfLb(arn: string, home: string): Promise<ElbListener[] | undefined> {
  const region = regionOfArn(arn, home);
  const cloud = await getCloud(region);
  if (cloud.kind === "aws") return (await lbConfigReal(region, arn)).listeners;
  const raw = await mockConfig(cloud, arn);
  return raw ? listenersOf(raw) : undefined;
}

// ---------- ECS services ----------

const STATE_HEALTH: Record<string, Resource["health"]> = { UP: "ok", DEPLOYING: "ok", DEGRADED: "warning", DOWN: "error", STOPPED: "stopped", BOX_STOPPED: "stopped", UNKNOWN: "unknown" };

function serviceHealth(s: RawService, sampled?: { state: string; reasons: string[] }): Pick<Resource, "health" | "healthReason"> {
  if (sampled) return { health: STATE_HEALTH[sampled.state] ?? "unknown", healthReason: sampled.state === "DEPLOYING" ? "deploying" : sampled.state === "UP" ? undefined : sampled.reasons[0] };
  if (s.desired === 0) return { health: "stopped", healthReason: "0 tasks desired" };
  if (s.deployments.some((d) => d.rolloutState === "FAILED")) return { health: "error", healthReason: s.deployments.find((d) => d.rolloutState === "FAILED")?.rolloutReason ?? "rollout failed" };
  if (s.running === 0) return { health: "error", healthReason: `0 of ${s.desired} tasks running` };
  if (s.running < s.desired) return { health: "warning", healthReason: `${s.running} of ${s.desired} tasks running` };
  return { health: "ok", healthReason: s.deployments.some((d) => d.rolloutState === "IN_PROGRESS") ? "deploying" : undefined };
}

const ecsConsoleUrl = (region: string, cluster: string, service: string) =>
  `https://${region}.console.aws.amazon.com/ecs/v2/clusters/${encodeURIComponent(cluster)}/services/${encodeURIComponent(service)}/health?region=${region}`;

// Catalog node ids (the ECS topology's "service:x", "database:y", …) → cloud-map keys.
// Within one environment (cluster + region): everything it names lives in that region.
function nodeKeyer(cluster: string, region: string, home: string, hidden: (s: string) => boolean, lb?: string) {
  return (id: string): string | undefined => {
    if (id.startsWith("service:")) return hidden(id.slice(8)) ? undefined : keys.ecsService(cluster, id.slice(8), region, home);
    if (id.startsWith("database:")) return keys.rds(id.slice(9), region, home);
    if (id.startsWith("cache:")) return keys.elasticache(id.slice(6), region, home);
    if (id.startsWith("ext:")) return keys.external(id.slice(4));
    if (id === "lb:alb") return lb ? keys.loadBalancer(lb, region, home) : undefined;
    return undefined;
  };
}

// Target group → load balancer ARN, each asked in the target group's own region.
async function tgToLb(ctx: ProviderContext, tgArns: string[], home: string): Promise<Record<string, string>> {
  if (!tgArns.length) return {};
  const byRegion = new Map<string, string[]>();
  for (const a of new Set(tgArns)) byRegion.set(regionOfArn(a, home), [...(byRegion.get(regionOfArn(a, home)) ?? []), a]);
  const parts = await Promise.all(
    [...byRegion].flatMap(([region, list]) => chunk(list, 20).map(async (c) => ctx.limit(async () => (await getCloud(region)).targetGroupLbs(c)))),
  );
  return Object.assign({}, ...parts);
}

// Subnet → VPC, asked per region.
async function subnetVpcsOf(ctx: ProviderContext, byRegion: Map<string, Set<string>>): Promise<Record<string, string>> {
  const parts = await Promise.all(
    [...byRegion].filter(([, s]) => s.size).map(([region, s]) => ctx.limit(async () => (await getCloud(region)).subnetVpcs([...s])).catch(() => ({}) as Record<string, string>)),
  );
  return Object.assign({}, ...parts);
}

// F17: env files are read once a minute at most (values stay in this process, only as mention refs). After a denial
// nothing is asked for 10 minutes.
const ENV_FILE_TTL = 60_000;
const gEnv = globalThis as { __consoleEnvFilesDeniedUntil?: number };
async function envFileText(cloud: Cloud, arn: string): Promise<string> {
  return (
    await cached(`map:envfile:${inRegion(arn, cloud.region)}`, ENV_FILE_TTL, async () => {
      return (await cloud.readEnvFile(arn)).text;
    })
  ).value;
}

const ecsProvider: Provider = {
  id: "ecs",
  label: "ECS services",
  scope: "home", // every environment of every console region, through the discovery inventory
  kinds: ["ecs-service"],
  covers: ["ecs:service"],
  read: [
    "ecs:ListClusters", "ecs:DescribeClusters", "ecs:ListServices", "ecs:DescribeServices", "ecs:ListTasks", "ecs:DescribeTasks", "ecs:DescribeTaskDefinition",
    "ecs:ListContainerInstances", "ecs:DescribeContainerInstances", "ec2:DescribeInstances", "ec2:DescribeSubnets", "ec2:DescribeSecurityGroups",
    "elasticloadbalancing:DescribeTargetGroups",
    // the inventory core (../inventory.ts): account id, activity metrics
    "cloudwatch:GetMetricData",
  ],
  // F17: env files on S3 (connection strings for the map's edges). Values only ever become mention refs.
  sensitive: ["s3:GetObject"],
  async discover(ctx) {
    const home = await homeOf(ctx);
    const until = budget();
    // R19: no ctx.limit around the shared discovery pass or the cached service lists — the SDK-call limiter bounds the
    // calls they make, and a deadline here would fail every joiner.
    const inv = await inventory();
    const resources: Resource[] = [];
    const links: Link[] = [];
    const mentions: Mention[] = [];
    const errors: unknown[] = [];
    const perEnv = await Promise.all(
      [...inv.catalogs.values()].map(async (cat) => {
        try {
          return { cat, services: await servicesIn(cat.env) };
        } catch (e) {
          errors.push(e);
          return { cat, services: [] as RawService[] };
        }
      }),
    );
    if (errors.length && !perEnv.some((p) => p.services.length)) throw errors[0];
    if (errors.length) ctx.note(`ecs: ${errors.length} cluster(s) couldn't be read`);
    const subnets = new Map<string, Set<string>>();
    for (const p of perEnv) for (const x of p.services.flatMap((s) => s.subnets)) (subnets.get(p.cat.env.region) ?? subnets.set(p.cat.env.region, new Set()).get(p.cat.env.region)!).add(x);
    const subnetVpc = await subnetVpcsOf(ctx, subnets);
    const tgLb = await tgToLb(ctx, perEnv.flatMap((p) => p.services.flatMap((s) => s.targetGroupArns)), home).catch(() => ({}) as Record<string, string>);

    // F72: forward rules' hostnames, per target group, from each load balancer the services sit behind.
    const hostsByTg = new Map<string, string[]>();
    await Promise.all(
      [...new Set(Object.values(tgLb).filter(Boolean))].map(async (lb) => {
        const listeners = await ctx.limit(() => listenersOfLb(lb, home)).catch(() => undefined);
        for (const [tg, hosts] of ruleHosts(listeners)) hostsByTg.set(tg, hosts);
      }),
    );
    // CC-20: Application Auto Scaling, per cluster (read by the Cloud adapter; denied → one note).
    let scalingNoted = false;
    const scaling = new Map<string, Map<string, Scaling>>();
    await Promise.all(
      perEnv.map(async ({ cat, services }) => {
        if (!services.length) return;
        const c = await cloudFor(cat.env);
        try {
          const list = await ctx.limit(() => c.scalableTargets(cat.env.cluster));
          scaling.set(cat.env.id, new Map(list.map((x) => [x.service, { min: x.min, max: x.max, policies: x.policies }])));
        } catch (e) {
          if (!scalingNoted) ctx.note(`ecs: autoscaling not read (${deniedAction(e) ? `${deniedAction(e)} denied` : errText(e)})`);
          scalingNoted = true;
        }
      }),
    );

    // F17: every service that may be the console (self, or no meta) is listed here with its env files — drawn on the map
    // or not (hidden, past the cap) — and `files` undefined when they couldn't be read, so its files are never read.
    // A cluster that couldn't be listed may hold the console too.
    const envReads: Promise<EnvRead>[] = errors.length ? [Promise.resolve({ key: "", self: true, cloud: await getCloud(home) })] : [];
    const filesOf = (containers: { files: string[] }[]) => [...new Set(containers.flatMap((c) => c.files))];
    let n = 0;
    for (const { cat, services } of perEnv) {
      const env = cat.env;
      const region = env.region;
      const cloud = await cloudFor(env);
      const sampled = latestOverview(env.id);
      const hosts = cat.hosts.filter((h) => h.state !== "terminated" && h.state !== "shutting-down");
      const hidden = (name: string) => !!cat.meta.get(name)?.hidden;
      const lbArn = services.flatMap((s) => s.targetGroupArns).map((x) => tgLb[x]).find(Boolean);
      const keyOf = nodeKeyer(env.cluster, region, home, hidden, lbArn ? lbName(lbArn) : undefined);
      for (const s of services) {
        const m = cat.meta.get(s.name);
        const td = s.taskDef;
        const self = m ? m.self : true; // no meta → can't tell it isn't the console (fail closed)
        if (hidden(s.name) || ++n > ctx.cap) {
          if (!hidden(s.name)) ctx.note(`ecs: showing the first ${ctx.cap} services`);
          // Not drawn, but it may still be the console: its env files must stay unread (names only, no mentions).
          if (self)
            envReads.push(
              td
                ? ctx.limit(() => cloud.containerEnv(td.arn)).then(
                    (containers) => ({ key: "", self, cloud, files: filesOf(containers) }),
                    () => ({ key: "", self, cloud }),
                  )
                : Promise.resolve({ key: "", self, cloud }),
            );
          continue;
        }
        const main = td?.containers.find((c) => c.name === td.main) ?? td?.containers[0];
        const hostNet = td?.networkMode === "host" || td?.networkMode === "bridge";
        const key = keys.ecsService(env.cluster, s.name, region, home);
        const acct = accountOf(ctx, env.clusterArn);
        const primary = s.deployments.find((d) => d.status === "PRIMARY");
        const view = sampled?.services.find((v) => v.key === `service:${s.name}`);
        const vpcId = hostNet ? hosts[0]?.vpcId : s.subnets.map((x) => subnetVpc[x]).find(Boolean);
        const scaled = scaling.get(env.id)?.get(s.name) ?? s.scalable;
        const wires = serviceWires(s, { key, region, account: acct, scaling: scaled, ruleHosts: s.targetGroupArns.flatMap((x) => hostsByTg.get(x) ?? []) });
        resources.push({
          key, kind: "ecs-service", provider: "ecs", name: s.name, region, tags: { ...s.tags },
          ...serviceHealth(s, view),
          props: [
            ...prop("Cluster", env.cluster, true),
            ...(m && m.name !== s.name ? prop("Display name", m.name) : []),
            ...prop("Launch type", s.launchType),
            ...prop("Tasks", `${s.running}/${s.desired} running${s.pending ? `, ${s.pending} pending` : ""}`),
            ...prop("Task definition", td ? `${td.family}:${td.revision}` : undefined, true),
            ...prop("Image", main?.image, true),
            ...prop("Network mode", td?.networkMode),
            ...prop("Ports", m?.ports.length ? m.ports.join(", ") : undefined),
            ...prop("Repository", m?.repo),
            ...wires.props,
            ...(m?.self ? prop("Note", "This is the console itself — it never acts on its own service.") : []),
          ],
          vpcId,
          subnetIds: s.subnets.length ? s.subnets : undefined,
          // Host/bridge networking shares the instance's groups: an SG rule then says "something on this host", not
          // which service — leave them out so the map doesn't draw a guess (the ECS views drop those edges too).
          securityGroups: hostNet ? undefined : s.securityGroups,
          endpoints: [...new Set([...cat.routes.filter((r) => r.service === s.name).map((r) => r.host), ...wires.endpoints])],
          // The task-definition family ARN (no revision) too: EventBridge Scheduler and Pipes name ECS targets by it.
          aliases: [
            ...(acct ? [`arn:aws:ecs:${region}:${acct}:service/${env.cluster}/${s.name}`] : []), ...(td?.family && td.family !== s.name ? [td.family] : []),
            ...(acct && td?.family ? [`arn:aws:ecs:${region}:${acct}:task-definition/${td.family}`] : []), ...wires.aliases,
          ],
          envHint: env.id,
          lastActivityAt: s.desired === 0 && s.running === 0 ? primary?.updatedAt : undefined,
          consoleUrl: ecsConsoleUrl(region, env.cluster, s.name),
          createdAt: s.createdAt,
          lastModified: primary?.updatedAt,
          ...(wires.facts ? { facts: wires.facts } : {}),
        });
        links.push(...wires.links);
        // The instances its tasks run on (the compute provider lists the instances themselves, keyed ec2:<id>@<region>
        // outside home).
        links.push(...hostLinks(s, { key, region, home, cluster: env.cluster, hosts: hosts.map((h) => h.id) }));
        // Environment values → mentions (server-side only; matched, then dropped).
        if (!td) envReads.push(Promise.resolve({ key, self, cloud }));
        else
          envReads.push(
            ctx.limit(() => cloud.containerEnv(td.arn)).then(
              (containers) => {
                for (const c of containers) {
                  for (const v of c.environment) if (v.value && v.value.length <= 4096) mentions.push({ from: key, refs: [v.value], via: `env ${v.name}` });
                  for (const v of c.secrets) if (v.valueFrom) mentions.push({ from: key, refs: [v.valueFrom], via: `secret ${v.name}` });
                  for (const f of c.files) mentions.push({ from: key, refs: [f], via: "env file" });
                }
                return { key, self, cloud, files: filesOf(containers) };
              },
              () => {
                ctx.note(`ecs: couldn't read the task definition of ${s.name}`);
                return { key, self, cloud };
              },
            ),
          );
      }
      // The ECS topology's inferred and declared connections, with their evidence. Load balancer → service edges
      // come from the "elb" provider (listener rules), so they're skipped here.
      for (const e of cat.edges) {
        if (e.source === "load balancer target group") continue;
        const from = keyOf(e.from), to = keyOf(e.to);
        if (!from || !to) continue;
        const src = e.source.replace(/^inferred · /, "");
        const confidence = src.startsWith("security group") ? "allowed" : src.startsWith("task definition env") ? "mentioned" : "config";
        const evidence = src.startsWith("task definition env ") ? `env ${src.slice("task definition env ".length)}` : src;
        // A declared ingress → service connection through the load balancer is the same path as its listener rule.
        const kind = from.startsWith("elb:") && e.kind === "http" ? "route" : e.kind === "api" ? "http" : e.kind;
        links.push({ from, to, kind, label: e.label ? e.label.replace(/^service(?=:|$)/, "tcp") : undefined, evidence, confidence });
      }
    }
    // R18: the services are listed; what follows (env values, env files) only adds mentions.
    ctx.checkpoint?.({ resources: [...resources], links: [...links], mentions: [...mentions] });
    await envFiles(ctx, await Promise.all(envReads), mentions, until);
    return { resources, links, mentions };
  },
  async detail(r, ctx) {
    // F15: only this provider's own keys; anything else (an external, another provider's resource) has no ECS detail.
    const m = /^ecs:service\/([^/]+)\/([^/@]+)(?:@(.+))?$/.exec(r.key);
    if (!m) return { key: r.key, sections: [] };
    const [, cluster, name, at] = m;
    const svc = (await servicesIn({ cluster, region: at ?? ctx.region })).find((s) => s.name === name);
    if (!svc) return { key: r.key, sections: [{ title: "Service", note: "No longer listed by ECS." }] };
    return {
      key: r.key,
      sections: [
        {
          title: "Deployments",
          table: {
            columns: ["Status", "Rollout", "Task definition", "Running", "Updated"],
            rows: svc.deployments.map((d) => [d.status, d.rolloutState ?? "—", d.taskDefinition.split("/").pop() ?? "", `${d.running}/${d.desired}`, ago(d.updatedAt)]),
          },
        },
        {
          title: "Tasks",
          table: {
            columns: ["Task", "Status", "Health", "Private IP", "Started", "Stopped reason"],
            rows: svc.tasks.slice(0, 20).map((x) => [x.id.slice(0, 12), x.lastStatus, x.health, x.privateIp ?? "", ago(x.startedAt), x.stoppedReason ?? ""]),
          },
        },
        { title: "More", note: "Logs, metrics, revisions, variables and actions for this service are on its environment page." },
      ],
    };
  },
};

// F17: env-file values as mentions, never the console's own: a file any possibly-self service uses is skipped, and
// nothing is read while a possibly-self service's files are unknown. Reads start only within the soft budget.
type EnvRead = { key: string; self: boolean; cloud: Cloud; files?: string[] };
async function envFiles(ctx: ProviderContext, reads: EnvRead[], mentions: Mention[], until: number) {
  const allowed = new Set(envFilesToRead(reads));
  if (!allowed.size) {
    if (reads.some((r) => !r.self && r.files?.length) && reads.some((r) => r.self && !r.files))
      ctx.note("ecs: env files not read — couldn't tell which are the console's own (a task definition or cluster wasn't read)");
    return;
  }
  if ((gEnv.__consoleEnvFilesDeniedUntil ?? 0) > Date.now()) {
    ctx.note("env files not read (needs s3:GetObject on the env-files bucket — full policy); the map uses config and security groups instead");
    return;
  }
  const users = new Map<string, { keys: string[]; cloud: Cloud }>();
  for (const r of reads) if (!r.self) for (const f of r.files ?? []) if (allowed.has(f)) users.set(f, { keys: [...(users.get(f)?.keys ?? []), r.key], cloud: r.cloud });
  let denied = false;
  let failed = 0;
  let late = 0;
  await Promise.all(
    [...users].map(async ([arn, u]) => {
      if (denied) return;
      try {
        if (Date.now() > until || ctx.signal.aborted) {
          late++;
          return;
        }
        const text = await ctx.limit(() => envFileText(u.cloud, arn));
        for (const key of u.keys) mentions.push(...envFileMentions(key, text));
      } catch (e) {
        if (deniedAction(e)) denied = true;
        else failed++;
      }
    }),
  );
  if (denied) {
    gEnv.__consoleEnvFilesDeniedUntil = Date.now() + 600_000;
    ctx.note("env files not read (needs s3:GetObject on the env-files bucket — full policy); the map uses config and security groups instead");
  }
  if (failed) ctx.note(`ecs: ${failed} env file(s) couldn't be read`);
  if (late && !ctx.signal.aborted) ctx.note(`ecs: ${late} env file(s) not read (discovery time budget)`);
}

// ---------- load balancers ----------

const elbProvider: Provider = {
  id: "elb",
  label: "Load balancers",
  scope: "regional",
  multiRegionMock: true,
  kinds: ["loadbalancer"],
  covers: ["elasticloadbalancing:loadbalancer/app", "elasticloadbalancing:loadbalancer/net", "elasticloadbalancing:loadbalancer/gwy"],
  read: [
    "elasticloadbalancing:DescribeLoadBalancers", "elasticloadbalancing:DescribeTargetGroups", "elasticloadbalancing:DescribeTargetHealth",
    "elasticloadbalancing:DescribeListeners", "elasticloadbalancing:DescribeRules", "elasticloadbalancing:DescribeTags",
    "elasticloadbalancing:DescribeLoadBalancerAttributes",
  ],
  async discover(ctx) {
    const home = await homeOf(ctx);
    const until = budget();
    const region = ctx.region;
    // R16: every load balancer, listener, target group and target health is read here, on its own. ECS ownership is
    // joined in if discovery answers in time; it is never awaited before listing.
    const joining = ecsJoin(region, home);
    joining.catch(() => undefined);
    const cloud = await getCloud(region);
    let lbs: ElbLoadBalancer[];
    let tgs: ElbTargetGroup[];
    let tgsRead = true;
    const state = new Map<string, Record<string, EnrichState>>();
    if (cloud.kind === "aws") {
      const [listed, groups] = await Promise.all([
        paged(ctx, "elb: load balancers", async (Marker) => {
          const r = await elb(region).send(new DescribeLoadBalancersCommand({ Marker, PageSize: 400 }), t(ctx));
          return { items: r.LoadBalancers, next: r.NextMarker };
        }, { service: "elasticloadbalancing" }),
        softly(ctx, "elb: target groups", { limited: false })(() =>
          paged(ctx, "elb: target groups", async (Marker) => {
            const r = await elb(region).send(new DescribeTargetGroupsCommand({ Marker, PageSize: 400 }), t(ctx));
            return { items: r.TargetGroups, next: r.NextMarker };
          }, { service: "elasticloadbalancing" }),
        ),
      ]);
      lbs = listed.filter((l) => l.LoadBalancerArn).map(elbLoadBalancer);
      tgs = (groups ?? []).filter((g) => g.TargetGroupArn).map(elbTargetGroup);
      tgsRead = !!groups;
    } else ({ lbs, tgs } = await ctx.limit(() => mockElb(cloud, region)));

    const base = lbs.map((lb) => lbResource(lb, tgsRead ? groupsOf(lb, tgs) : [], { region, home }));
    ctx.checkpoint?.({ resources: base, links: [], mentions: [] });

    if (cloud.kind === "aws") {
      // Tags in batches of 20; what isn't read (denied, time budget) stays unread, so protection fails closed.
      let tagState: EnrichState = "ok";
      for (const c of chunk(lbs.map((l) => l.arn), 20)) {
        if (Date.now() > until || ctx.signal.aborted) {
          tagState = "skipped";
          break;
        }
        try {
          const r = await ctx.limit(() => elb(region).send(new DescribeTagsCommand({ ResourceArns: c }), t(ctx)));
          for (const d of r.TagDescriptions ?? []) {
            const lb = lbs.find((l) => l.arn === d.ResourceArn);
            if (lb) lb.tags = Object.fromEntries((d.Tags ?? []).map((x) => [x.Key ?? "", x.Value ?? ""]));
          }
        } catch (e) {
          tagState = deniedAction(e) ? "denied" : "error";
          ctx.note(`elb: tags not read (${deniedAction(e) ? `${deniedAction(e)} denied` : errText(e)})`);
          break;
        }
      }
      if (tagState === "skipped") ctx.note("elb: tags: some not read (discovery time budget)");
      const attached = tgs.filter((g) => g.lbArns.length);
      const [conf, health] = await Promise.all([
        enrich(ctx, lbs, { label: "elb: listener rules", max: 200, until }, (lb) => lbConfigReal(region, lb.arn)),
        enrich(ctx, attached, { label: "elb: target health", max: 500, until }, (g) => healthOf(cloud, g)),
      ]);
      lbs.forEach((lb, i) => {
        const c = conf.results[i];
        if (c) Object.assign(lb, { listeners: c.listeners, logs: c.logs });
        state.set(lb.arn, { tags: lb.tags ? "ok" : tagState === "ok" ? "error" : tagState, rules: conf.state[i] });
      });
      attached.forEach((g, i) => {
        for (const lbArn of g.lbArns) {
          const s = state.get(lbArn);
          if (s && (s["target health"] ?? "ok") === "ok") s["target health"] = health.state[i];
        }
      });
    }

    const j = await joined(joining, until, ctx.signal);
    const join = j.value;
    if (!join) ctx.note(`elb${where(ctx, home)}: ECS services not read (${j.why}) — routes to ECS services and parked-service checks resume on the next refresh`);
    else if (join.failed) ctx.note(`elb${where(ctx, home)}: ${join.failed} ECS cluster(s) couldn't be read — their services' target groups count as unowned`);
    if (!tgsRead) ctx.note(`elb${where(ctx, home)}: target groups not read — load balancer health is unknown`);

    const resources: Resource[] = [];
    const links: Link[] = [];
    for (const lb of lbs) {
      const groups = tgsRead ? groupsOf(lb, tgs) : [];
      const r = lbResource(lb, groups, { region, home, join });
      const st = state.get(lb.arn);
      resources.push(st ? { ...r, enrichment: st } : r);
      links.push(...lbLinks(r.key, lb, groups, join, { region, home }));
      if (lb.logs) links.push({ from: r.key, to: `arn:aws:s3:::${lb.logs.bucket}`, kind: "writes", label: "access logs", evidence: `access logs → ${lb.logs.bucket}/${lb.logs.prefix ?? ""}` });
    }
    return { resources, links, mentions: [] };
  },
  activity(r) {
    const arn = r.aliases?.find((a) => a.includes(":loadbalancer/"));
    const dims = arn ? lbDims(arn) : undefined;
    if (!dims) return [];
    // R20: the series that shows use; full labels (F16) — the panel shows them as they are, one point per day.
    if (dims.startsWith("app/")) return [{ namespace: "AWS/ApplicationELB", metric: "RequestCount", dims: { LoadBalancer: dims }, stat: "Sum", label: "requests per day (idle check)", required: true }];
    if (dims.startsWith("net/")) return [{ namespace: "AWS/NetworkELB", metric: "NewFlowCount", dims: { LoadBalancer: dims }, stat: "Sum", label: "new connections per day (idle check)", required: true }];
    return [];
  },
  async detail(r, ctx) {
    const arn = r.aliases?.find((a) => a.includes(":loadbalancer/"));
    if (!arn) return { key: r.key, sections: [] };
    const home = await homeOf(ctx);
    const region = regionOfArn(arn, home);
    const cloud = await getCloud(region);
    const joining = ecsJoin(region, home);
    joining.catch(() => undefined);
    let lb: ElbLoadBalancer;
    let groups: ElbTargetGroup[];
    if (cloud.kind === "aws") {
      const gone = (e: unknown) => (/NotFound/.test((e as { name?: string })?.name ?? "") ? { LoadBalancers: [] } : Promise.reject(e));
      const [listed, conf, tgList] = await Promise.all([
        elb(region).send(new DescribeLoadBalancersCommand({ LoadBalancerArns: [arn] }), t(ctx)).catch(gone),
        lbConfigReal(region, arn).catch(() => undefined),
        elb(region).send(new DescribeTargetGroupsCommand({ LoadBalancerArn: arn }), t(ctx)).catch(() => undefined),
      ]);
      const raw = listed.LoadBalancers?.[0];
      if (!raw) return { key: r.key, sections: [{ title: "Load balancer", note: "No longer listed by Elastic Load Balancing." }] };
      lb = { ...elbLoadBalancer(raw), ...(conf ? { listeners: conf.listeners, logs: conf.logs } : {}) };
      groups = (tgList?.TargetGroups ?? []).filter((g) => g.TargetGroupArn).map(elbTargetGroup).slice(0, 50);
      await Promise.all(groups.map((g) => ctx.limit(() => healthOf(cloud, g)).catch(() => undefined)));
    } else {
      const m = await mockElb(cloud, region, arn);
      if (!m.lbs.length) return { key: r.key, sections: [{ title: "Load balancer", note: "No longer listed by Elastic Load Balancing." }] };
      lb = m.lbs[0];
      groups = m.tgs;
    }
    const j = await joined(joining, Date.now() + 3_000, ctx.signal);
    return { key: r.key, sections: lbSections(lb, groupsOf(lb, groups), j.value) };
  },
};

// ---------- RDS and ElastiCache ----------

// Charts for a detail panel (F16): a failure leaves the panel without them, never fails it.
async function charts(ctx: ProviderContext, cloud: Cloud, specs: ChartMetricSpec[], label: string): Promise<ResourceDetail["metrics"]> {
  const data = await softly(ctx, label)(() => cloud.metrics(metricQueries(specs), 360));
  return data ? metricSeries(specs, data) : undefined;
}

const keyName = (key: string, prefix: string) => key.slice(prefix.length).replace(/@[^@]+$/, "");

const rdsProvider: Provider = {
  id: "rds",
  label: "RDS databases",
  scope: "regional",
  multiRegionMock: true,
  kinds: ["rds"],
  covers: ["rds:db"],
  read: ["rds:DescribeDBInstances"],
  async discover(ctx) {
    const home = await homeOf(ctx);
    const until = budget();
    const region = ctx.region;
    const owners = inventory().then(dbOwners);
    owners.catch(() => undefined);
    const cloud = await getCloud(region);
    const dbs = (await ctx.limit(() => cached(`dbs:${inRegion("all", region)}`, 10_000, () => cloud.databases()))).value;
    if (dbs.length > ctx.cap) ctx.note(`rds${where(ctx, home)}: showing the first ${ctx.cap} databases`);
    const list = dbs.slice(0, ctx.cap);
    const build = (env?: { db: Map<string, string> }) => list.map((d) => rdsResource(d, { region, home, account: ctx.accountId, envHint: env?.db.get(`${region}/${d.id}`) }));
    const base = build();
    ctx.checkpoint?.({ resources: base.map((x) => x.resource), links: base.flatMap((x) => x.links), mentions: [] });
    const env = (await joined(owners, Math.min(until, Date.now() + 5_000), ctx.signal)).value;
    const out = env ? build(env) : base;
    return { resources: out.map((x) => x.resource), links: out.flatMap((x) => x.links), mentions: [] };
  },
  // R20: the series that shows use. The daily Maximum, so the label says "peak" (F16).
  activity: (r) => [{ namespace: "AWS/RDS", metric: "DatabaseConnections", dims: { DBInstanceIdentifier: r.name }, stat: "Maximum", label: "peak connections per day (idle check)", required: true }],
  async detail(r, ctx) {
    const id = keyName(r.key, "rds:");
    const cloud = await getCloud(ctx.region);
    const d = (await cached(`dbs:${inRegion("all", ctx.region)}`, 10_000, () => cloud.databases())).value.find((x) => x.id === id);
    if (!d) return { key: r.key, sections: [{ title: "Database", note: "No longer listed by RDS." }] };
    const [sgs, metrics] = await Promise.all([
      softly(ctx, "rds: security groups")(() => cloud.securityGroups(d.securityGroups)),
      charts(ctx, cloud, rdsSpecs(d.id), "rds: metrics"),
    ]);
    const row = (label: string, value?: string | number, mono = false) => prop(label, value, mono);
    return {
      key: r.key,
      sections: [
        sgSection(d.securityGroups, sgs ?? []),
        {
          title: "Network",
          rows: [
            ...row("VPC", d.vpcId, true), ...row("Subnets", d.subnetIds?.join(", "), true), ...row("Subnet group", d.subnetGroup, true),
            ...row("Endpoint", d.endpoint ? `${d.endpoint}${d.port ? `:${d.port}` : ""}` : undefined, true),
            ...row("Publicly accessible", d.publiclyAccessible === undefined ? undefined : d.publiclyAccessible ? "yes" : "no"),
          ],
        },
        {
          title: "Backups and maintenance",
          rows: [
            ...row("Backup retention", d.backupRetentionDays === undefined ? undefined : d.backupRetentionDays === 0 ? "off" : `${d.backupRetentionDays} days`),
            ...row("Backup window", d.backupWindow ? `${d.backupWindow} UTC` : undefined), ...row("Maintenance window", d.maintenanceWindow ? `${d.maintenanceWindow} UTC` : undefined),
            ...row("Deletion protection", d.deletionProtection === undefined ? undefined : d.deletionProtection ? "on" : "off"),
          ],
        },
        {
          title: "Configuration",
          rows: [
            ...row("Engine", `${d.engine} ${d.engineVersion}`.trim()), ...row("Class", d.instanceClass), ...row("Parameter group", d.parameterGroup, true),
            ...row("Option group", d.optionGroup, true), ...row("Encryption key", d.storageEncrypted === false ? "not encrypted" : d.kmsKeyId, true),
            ...row("CA certificate", d.caCertificate ? `${d.caCertificate}${d.caValidTill ? ` (valid till ${new Date(d.caValidTill).toISOString().slice(0, 10)})` : ""}` : undefined),
          ],
        },
      ].filter((s) => !("rows" in s) || s.rows?.length),
      ...(metrics?.length ? { metrics } : {}),
    };
  },
};

const elasticache = perRegion((region) => new ElastiCacheClient(sdkConfig(region)), "elasticache");

// Cache subnet groups of a region (name → VPC and subnets): one listing, cached 10 minutes.
async function subnetGroups(ctx: ProviderContext, region: string): Promise<Map<string, { vpcId?: string; subnets: string[] }> | undefined> {
  const list = await softly(ctx, "elasticache: subnet groups")(() =>
    cached(`elasticache:subnet-groups@${region}`, 600_000, async () => {
      const out: [string, { vpcId?: string; subnets: string[] }][] = [];
      let Marker: string | undefined;
      do {
        const r = await elasticache(region).send(new DescribeCacheSubnetGroupsCommand({ Marker, MaxRecords: 100 }), { abortSignal: AbortSignal.timeout(LIMITS.awsTimeoutMs) });
        for (const g of r.CacheSubnetGroups ?? [])
          if (g.CacheSubnetGroupName) out.push([g.CacheSubnetGroupName, { vpcId: g.VpcId, subnets: (g.Subnets ?? []).map((s) => s.SubnetIdentifier ?? "").filter(Boolean) }]);
        Marker = r.Marker;
      } while (Marker);
      return out;
    }).then((x) => x.value),
  );
  return list ? new Map(list) : undefined;
}

const elasticacheProvider: Provider = {
  id: "elasticache",
  label: "ElastiCache",
  scope: "regional",
  multiRegionMock: true,
  kinds: ["elasticache"],
  covers: ["elasticache:replicationgroup", "elasticache:cluster"],
  read: ["elasticache:DescribeReplicationGroups", "elasticache:DescribeCacheClusters", "elasticache:ListTagsForResource", "elasticache:DescribeCacheSubnetGroups"],
  async discover(ctx) {
    const home = await homeOf(ctx);
    const until = budget();
    const region = ctx.region;
    const owners = inventory().then(dbOwners);
    owners.catch(() => undefined);
    const cloud = await getCloud(region);
    const caches = (await ctx.limit(() => cached(`caches:${inRegion("all", region)}`, 15_000, () => cloud.caches()))).value;
    if (caches.length > ctx.cap) ctx.note(`elasticache${where(ctx, home)}: showing the first ${ctx.cap} caches`);
    const list = caches.slice(0, ctx.cap);
    const mock = cloud.kind !== "aws";
    const base = list.map((c) => cacheResource(c, { region, home, account: ctx.accountId, tags: mock ? c.tags ?? {} : c.tags }));
    ctx.checkpoint?.({ resources: base.map((x) => x.resource), links: base.flatMap((x) => x.links), mentions: [] });

    // Tags (bounded, one note on a denial: then {} and tagsUnread) and the VPC of each subnet group.
    let tags: (Record<string, string> | undefined)[] = list.map((c) => (mock ? c.tags ?? {} : c.tags));
    let tagState: EnrichState[] = list.map(() => "ok");
    let groups: Map<string, { vpcId?: string; subnets: string[] }> | undefined;
    if (!mock) {
      const [tagged, sg] = await Promise.all([
        enrich(ctx, list, { label: "elasticache: tags", max: 500, until }, async (c) => {
          const arn = cacheArn(c, region, ctx.accountId);
          if (!arn) return undefined;
          const r = await elasticache(region).send(new ListTagsForResourceCommand({ ResourceName: arn }), t(ctx));
          return Object.fromEntries((r.TagList ?? []).map((x) => [x.Key ?? "", x.Value ?? ""]));
        }),
        list.some((c) => c.subnetGroup && !c.vpcId) ? subnetGroups(ctx, region) : Promise.resolve(undefined),
      ]);
      tags = tagged.results;
      tagState = tagged.state;
      groups = sg;
    }
    const env = (await joined(owners, Math.min(until, Date.now() + 5_000), ctx.signal)).value;
    const out = list.map((c, i) => {
      const g = c.subnetGroup ? groups?.get(c.subnetGroup) : undefined;
      // Tags denied, skipped or failed: {} on the map, tagsUnread for protection (it fails closed).
      const x = cacheResource(c, { region, home, account: ctx.accountId, envHint: env?.cache.get(`${region}/${c.id}`), tags: tags[i], vpcId: c.vpcId ?? g?.vpcId, subnetIds: c.subnetIds ?? g?.subnets });
      return { ...x, resource: mock ? x.resource : { ...x.resource, enrichment: { tags: tagState[i] } } };
    });
    return { resources: out.map((x) => x.resource), links: out.flatMap((x) => x.links), mentions: [] };
  },
  async detail(r, ctx) {
    const id = keyName(r.key, "elasticache:");
    const cloud = await getCloud(ctx.region);
    const c = (await cached(`caches:${inRegion("all", ctx.region)}`, 15_000, () => cloud.caches())).value.find((x) => x.id === id);
    if (!c) return { key: r.key, sections: [{ title: "Cache", note: "No longer listed by ElastiCache." }] };
    const members = c.memberClusters?.length ? c.memberClusters : [c.id];
    const [sgs, groups, metrics] = await Promise.all([
      softly(ctx, "elasticache: security groups")(() => cloud.securityGroups(c.securityGroups)),
      cloud.kind === "aws" && c.subnetGroup && !c.subnetIds?.length ? subnetGroups(ctx, ctx.region) : Promise.resolve(undefined),
      // Per node: the first member, named when there are several.
      charts(ctx, cloud, elasticacheSpecs(members[0], members.length > 1 ? members[0] : undefined), "elasticache: metrics"),
    ]);
    const subnets = c.subnetIds ?? (c.subnetGroup ? groups?.get(c.subnetGroup)?.subnets : undefined);
    const row = (label: string, value?: string | number, mono = false) => prop(label, value, mono);
    const onOff = (v?: boolean) => (v === undefined ? undefined : v ? "on" : "off");
    return {
      key: r.key,
      sections: [
        sgSection(c.securityGroups, sgs ?? []),
        {
          title: "Network",
          rows: [
            ...row("VPC", r.vpcId ?? c.vpcId, true), ...row("Subnet group", c.subnetGroup, true), ...row("Subnets", subnets?.join(", "), true),
            ...row("Endpoint", c.endpoint ? `${c.endpoint}${c.port ? `:${c.port}` : ""}` : undefined, true),
          ],
        },
        {
          title: "Security",
          rows: [...row("Encryption at rest", onOff(c.atRestEncryption)), ...row("Encryption key", c.kmsKeyId, true), ...row("In-transit encryption", onOff(c.transitEncryption)), ...row("AUTH token", onOff(c.authToken))],
        },
        {
          title: "Backups and maintenance",
          rows: [
            ...row("Snapshot retention", c.snapshotRetentionDays === undefined ? undefined : c.snapshotRetentionDays === 0 ? "off" : `${c.snapshotRetentionDays} days`),
            ...row("Snapshot window", c.snapshotWindow ? `${c.snapshotWindow} UTC` : undefined), ...row("Maintenance window", c.maintenanceWindow ? `${c.maintenanceWindow} UTC` : undefined),
            ...row("Parameter group", c.parameterGroup, true),
          ],
        },
        ...(c.memberClusters?.length ? [{ title: "Member clusters", table: { columns: ["Cluster"], rows: c.memberClusters.map((x) => [x]) } }] : []),
      ].filter((s) => !("rows" in s) || s.rows?.length),
      ...(metrics?.length ? { metrics } : {}),
    };
  },
};

export const providers: Provider[] = [ecsProvider, elbProvider, rdsProvider, elasticacheProvider];

// ---------- inventory core helpers (real AWS only; the inventory never calls these in the simulated account) ----------

// One per AWS connection (connection-state.ts), like the CloudWatch clients below.
const stsClient = perGeneration(() => limitedClient(new STSClient({ region: homeRegion(), maxAttempts: 2, credentials: connectionCredentials })));
export async function callerAccount(): Promise<string | undefined> {
  return (await stsClient().send(new GetCallerIdentityCommand({}), { abortSignal: AbortSignal.timeout(5_000) })).Account;
}

export interface ActivityQuery {
  region: string;
  namespace: string;
  metric: string;
  dims: Record<string, string>;
  stat: "Sum" | "Average" | "Maximum";
}

const cw = perGeneration(() => new Map<string, CloudWatchClient>());
const cwFor = (region: string) => cw().get(region) ?? cw().set(region, limitedClient(new CloudWatchClient({ region, retryMode: "adaptive", maxAttempts: 3, credentials: connectionCredentials }))).get(region)!;

// Daily datapoints over the last `days` days for each query, batched ≤ 500 per GetMetricData call and grouped by
// region (CloudFront and Route 53 publish in us-east-1). A query whose result isn't Complete is left out: no evidence.
// Each batch stands alone: a failure (a region an SCP denies, a timeout) loses only that batch — every answered batch
// is kept, so nothing already paid for (GetMetricData is billed per metric) is requested again on the next build.
export async function activityData(queries: ActivityQuery[], days: number, limit: <T>(fn: () => Promise<T>) => Promise<T>): Promise<{ data: Map<number, [number, number][]>; failed: number[]; error?: unknown }> {
  const out = new Map<number, [number, number][]>();
  const failed: number[] = [];
  let error: unknown;
  const end = new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000);
  const start = new Date(end.getTime() - days * 86_400_000);
  const byRegion = new Map<string, number[]>();
  queries.forEach((q, i) => byRegion.set(q.region, [...(byRegion.get(q.region) ?? []), i]));
  for (const [region, idx] of byRegion) {
    for (const batch of chunk(idx, 500)) {
      const acc = new Map<number, [number, number][]>();
      const status = new Map<number, string>();
      let NextToken: string | undefined;
      try {
        do {
          const r = await limit(() =>
            cwFor(region).send(
              new GetMetricDataCommand({
                StartTime: start, EndTime: end, ScanBy: "TimestampAscending", NextToken,
                MetricDataQueries: batch.map((i) => {
                  const q = queries[i];
                  return { Id: `q${i}`, ReturnData: true, MetricStat: { Metric: { Namespace: q.namespace, MetricName: q.metric, Dimensions: Object.entries(q.dims).map(([Name, Value]) => ({ Name, Value })) }, Period: 86_400, Stat: q.stat } };
                }),
              }),
              { abortSignal: AbortSignal.timeout(20_000) },
            ),
          );
          for (const m of r.MetricDataResults ?? []) {
            const i = Number(m.Id?.slice(1));
            acc.set(i, [...(acc.get(i) ?? []), ...(m.Timestamps ?? []).map((t, j) => [t.getTime(), m.Values?.[j] ?? 0] as [number, number])]);
            status.set(i, m.StatusCode ?? "");
          }
          NextToken = r.NextToken;
        } while (NextToken);
      } catch (e) {
        error ??= e;
        failed.push(...batch);
        continue;
      }
      for (const i of batch) if (status.get(i) === "Complete") out.set(i, acc.get(i) ?? []);
    }
  }
  return { data: out, failed, error };
}
