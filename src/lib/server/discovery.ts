// Discovery: what exists in this AWS account, mapped into environments. Nothing here is company-specific —
// clusters become environments, services/tasks/logs/LBs come from ECS, databases and caches are attributed by tags,
// security groups, names or VPC, and connections are inferred. console.config.json only fills gaps.
// Multi-region: clusters are listed in every region the console reads (server/regions.ts); an env lives in one region
// and everything about it (services, hosts, databases, caches, security groups) is read in that region only.
import "server-only";
import type { ConsoleConfig } from "../console-config.ts";
import { PROXY_IMAGE, aliasTarget, attribute, envTagDecides, envTagOf, envsFromClusters, inferEdges, parseImageRef, placement, stageWordsOf, workloadGraph, type HostRef, type NodeRef, type SgRule } from "../discover.ts";
import { clusterSkip, configWarnings, healthcheckProblem, unassignedOf, type DiscoveryWarning } from "../discovery-rules.ts";
import { simulationTargets, type SampleRow } from "../capability-rules.ts";
import { regionalIds } from "../regions.ts";
import type { EdgeKind, EnvInfo, RawBox, RawCache, RawCluster, RawDb, RawService, TopoEdge, TopoNode } from "../types.ts";
import { cached } from "./cache.ts";
import { generation, isConnectionChanged } from "./connection-state.ts";
import { consoleConfig } from "./config-check.ts";
import { HttpError, errText } from "./errors.ts";
import { consoleRegions } from "./regions.ts";
import { getCi, getCloud, homeRegion } from "./sources.ts";

// ---------- config file ----------

// console.config.json: CONSOLE_CONFIG, else ./console.config.json, else (demo only) the bundled example, re-read when it
// changes. Loaded in config-check.ts, which keeps the last good version and fails closed when none could be read.
export { consoleConfig };
export type { DiscoveryWarning };

// Discovery reads (cluster lists, the per-region inventory) are served stale for up to 5 minutes while one refresh
// runs in the background (F57); invalidate() — a re-scan, an action — still forces a fresh read.
const DISCOVERY_STALE_MS = 5 * 60_000;

// ---------- environments ----------

// Cluster names, families and repositories are only unique within a region: cache keys that hold one say
// "<name>@<region>" outside the home region (and the plain name in it, as before multi-region).
export const inRegion = (name: string, region?: string) => (!region || region === homeRegion() ? name : `${name}@${region}`);

// A region other than home that failed to answer is skipped (and reported) for a minute instead of slowing every call.
const RETRY_REGION_MS = 60_000;
const g = globalThis as { __consoleRegionErrors?: Map<string, { until: number; error: string }> };
const regionErrors = () => (g.__consoleRegionErrors ??= new Map());

// Every region's ECS clusters, home first. The home region's failure is everyone's (thrown); another region's is noted.
async function clustersByRegion(): Promise<{ home: string; byRegion: [string, RawCluster[]][] }> {
  const { home, regions } = await consoleRegions();
  const byRegion = await Promise.all(
    regions.map(async (region): Promise<[string, RawCluster[]]> => {
      const read = async () => (await cached(`discovery:envs@${region}`, 60_000, async () => (await getCloud(region)).clusters(), { staleMs: DISCOVERY_STALE_MS })).value;
      if (region === home) return [region, await read()];
      const down = regionErrors().get(region);
      if (down && down.until > Date.now()) return [region, []];
      const born = generation();
      try {
        const clusters = await read();
        regionErrors().delete(region);
        return [region, clusters];
      } catch (e) {
        // Cut off by a switch of the AWS connection: not this region's failure (the new connection reads it afresh).
        if (generation() === born && !isConnectionChanged(e)) regionErrors().set(region, { until: Date.now() + RETRY_REGION_MS, error: errText(e) });
        return [region, []];
      }
    }),
  );
  return { home, byRegion };
}

// Regions other than home whose clusters didn't answer lately (their environments are missing for now).
export function unreadRegions(): { region: string; error: string }[] {
  return [...regionErrors()].filter(([, x]) => x.until > Date.now()).map(([region, x]) => ({ region, error: x.error }));
}

export async function listEnvs(): Promise<EnvInfo[]> {
  const { home, byRegion } = await clustersByRegion();
  const { config, failClosed } = consoleConfig();
  const envs = byRegion.flatMap(([region, clusters]) => envsIn(region, home, clusters, config, !!failClosed));
  return regionalIds(envs, home).sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

// The envs of one region. A config entry pins its cluster in its `region` (default: home). Clusters discovery leaves
// out: not ACTIVE, ignored (ignoreClusters, tag console:ignore=true), AWS Batch's own (unless pinned), and with
// discoverClusters false every unpinned one. `failClosed`: the config file couldn't be read — every env is protected.
// A config entry with a `host` instead of a cluster is a compose env: one EC2 box, its apps declared as `workloads`.
function envsIn(region: string, home: string, all: RawCluster[], config: ConsoleConfig, failClosed: boolean): EnvInfo[] {
  const entries = Object.entries(config.environments ?? {}).filter(([, e]) => (e.region ?? home) === region);
  const pinned = new Map(entries.filter(([, e]) => e.cluster).map(([id, e]) => [e.cluster!, { id, ...e }]));
  const clusters = all.filter((c) => !clusterSkip(c, config, pinned.has(c.name)));
  const boxes = entries.filter(([, e]) => e.host).map(([id, e]): EnvInfo => {
    const d = envsFromClusters([{ name: id, tags: {} }])[0]; // stage words give the label, protection and order
    return { id, label: e.label ?? d.label, protected: failClosed || (e.protected ?? d.protected), region, cluster: "", kind: "compose", host: e.host, branch: e.branch, order: e.order ?? d.order, source: "config" };
  });
  return [...boxes, ...envsFromClusters(clusters).map((d, i) => {
    const c = clusters.find((x) => x.name === d.cluster)!;
    const p = pinned.get(d.cluster);
    const fargate = c.capacityProviders.some((x) => x.startsWith("FARGATE"));
    return {
      id: p?.id ?? d.id,
      label: p?.label ?? d.label,
      protected: failClosed || (p?.protected ?? d.protected),
      region,
      cluster: c.name,
      clusterArn: c.arn,
      kind: c.containerInstances > 0 ? (fargate ? "mixed" : "ec2") : fargate || c.activeServices ? "fargate" : "unknown",
      branch: p?.branch ?? d.branch,
      order: p?.order ?? d.order ?? i,
      source: p ? "config" : "discovered",
    } satisfies EnvInfo;
  })];
}

export async function envInfo(id: string): Promise<EnvInfo> {
  const e = (await listEnvs()).find((x) => x.id === id);
  if (!e) throw new HttpError(404, `unknown environment "${id}"`);
  return e;
}

// ---------- per-service facts ----------

export interface ServiceMeta {
  id: string; // ECS service name
  name: string;
  repo?: string; // GitHub owner/name
  repoSource?: "tag" | "config" | "guess";
  ecrRepo?: string;
  infra: boolean;
  hidden: boolean;
  healthcheck?: string; // a valid http(s) URL only (F33): an invalid one is reported, never probed
  healthcheckProblem?: string;
  migrations: string[];
  family?: string;
  logs?: { group: string; prefix?: string; container: string };
  ports: number[];
  proxy: boolean; // looks like a reverse proxy (ingress when there is no load balancer)
  self: boolean;
}

const DEFAULT_MIGRATIONS = ["prisma/migrations/", "migrations/", "db/migrate/", "alembic/versions/", "src/migrations/"];
const split = (v?: string) => (v ? v.split(",").map((x) => x.trim()).filter(Boolean) : undefined);

function serviceMeta(env: EnvInfo, s: RawService, self?: SelfRef): ServiceMeta {
  const { config } = consoleConfig();
  const o = config.services && Object.hasOwn(config.services, s.name) ? config.services[s.name] : {};
  const tag = s.tags;
  const td = s.taskDef;
  const main = td?.containers.find((c) => c.name === td.main) ?? td?.containers[0];
  const img = main ? parseImageRef(main.image) : undefined;
  const hc = tag["console:healthcheck"] ?? (typeof o.healthcheck === "string" ? o.healthcheck : o.healthcheck && Object.hasOwn(o.healthcheck, env.id) ? o.healthcheck[env.id] : undefined);
  const hcProblem = hc === undefined ? undefined : healthcheckProblem(hc);
  const repo = tag["console:repo"] ?? o.repo;
  return {
    id: s.name,
    name: tag["console:name"] ?? o.name ?? s.name,
    repo,
    repoSource: tag["console:repo"] ? "tag" : o.repo ? "config" : undefined,
    ecrRepo: img?.ecr ? img.repository : undefined,
    infra: o.infra ?? (tag["console:role"] ? tag["console:role"] === "infra" : !!img && !img.ecr),
    hidden: o.hidden ?? tag["console:hidden"] === "true",
    healthcheck: hcProblem ? undefined : hc,
    ...(hcProblem ? { healthcheckProblem: `${tag["console:healthcheck"] !== undefined ? "console:healthcheck tag" : `services.${s.name}.healthcheck`} ${hcProblem}` } : {}),
    migrations: o.migrations ?? split(tag["console:migrations"]) ?? DEFAULT_MIGRATIONS,
    family: td?.family,
    logs: main?.logGroup ? { group: main.logGroup, prefix: main.logStreamPrefix ? `${main.logStreamPrefix}/${main.name}/` : undefined, container: main.name } : undefined,
    ports: main?.ports ?? td?.ports ?? [],
    proxy: !!img && PROXY_IMAGE.test(img.repository),
    self: tag["console:self"] === "true" || (!!self && ("unknown" in self || (self.cluster === s.cluster && self.family === td?.family))),
  };
}

// ---------- self (the console never acts on itself) ----------

// `unknown`: running on ECS, but the task metadata endpoint didn't answer.
export type SelfRef = { cluster: string; family: string } | { unknown: true };

// CONSOLE_SELF="cluster/family", else the ECS task metadata endpoint when running on ECS. Not on ECS (a laptop, plain
// Docker) → undefined: no service in any cluster is the console.
async function selfRef(): Promise<SelfRef | undefined> {
  const pinned = process.env.CONSOLE_SELF;
  if (pinned?.includes("/")) {
    const [cluster, family] = pinned.split("/");
    return { cluster, family };
  }
  const uri = process.env.ECS_CONTAINER_METADATA_URI_V4;
  if (!uri) return undefined;
  try {
    return (
      await cached("discovery:self", 24 * 3600_000, async () => {
        const r = (await (await fetch(`${uri}/task`, { signal: AbortSignal.timeout(2000) })).json()) as { Cluster?: string; Family?: string };
        if (!r.Cluster || !r.Family) throw new Error("task metadata without cluster/family");
        return { cluster: r.Cluster.split("/").pop()!, family: r.Family };
      })
    ).value;
  } catch {
    // Fail closed: we can't tell which service is ours, so every service counts as possibly ours (no actions, edits,
    // reveals, copies or one-off tasks) until the endpoint answers. Failures aren't cached; the next call retries.
    console.error(JSON.stringify({ level: 40, msg: "ECS task metadata unavailable; treating every service as the console's own until it answers" }));
    return { unknown: true };
  }
}

// The console's own cluster when no environment is built from it (ignored, AWS Batch, discoverClusters false): what the
// console reads must still count as its own wherever another service shares it (envvars.ts). undefined: not on ECS,
// unknown (every service already counts as the console's), or its cluster is an environment. Read in the home region.
export async function selfOutsideEnvs(): Promise<{ cluster: string; family: string; region: string } | undefined> {
  const self = await selfRef();
  if (!self || "unknown" in self) return undefined;
  if ((await listEnvs()).some((e) => e.cluster === self.cluster)) return undefined;
  return { ...self, region: homeRegion() };
}

// Real resources for the IAM simulation (capability.ts, F06): per cluster, a service that isn't the console, and its
// task definition; for the other writes, resources of each action's type among `rows` (the cloud-map inventory's last
// build, which capability.ts hands in). {} — simulate against "*" — when the console can't tell which service is its
// own, or there is none.
export async function simulationTargetsNow(rows: SampleRow[] = []): Promise<Record<string, string[]>> {
  const self = await selfRef();
  if (self && "unknown" in self) return {};
  const clusters = [];
  for (const e of await listEnvs()) {
    if (!e.cluster || !e.clusterArn) continue;
    const services = await servicesOf(e.cluster, e.region).catch(() => [] as RawService[]);
    const sampled = services.map((x) => ({ name: x.name, family: x.taskDef?.family, taskDefinitionArn: x.taskDef?.arn }));
    clusters.push({ cluster: e.cluster, clusterArn: e.clusterArn, services: sampled });
  }
  return simulationTargets(clusters, self, rows, process.env.CONSOLE_SELF_INSTANCE?.trim() || undefined);
}

// ---------- per-region inventory → per-env catalog ----------

export interface Catalog {
  env: EnvInfo;
  meta: Map<string, ServiceMeta>;
  hosts: RawBox[];
  databases: RawDb[];
  caches: RawCache[];
  edges: TopoEdge[]; // inferred + declared, resolved to node ids
  externals: TopoNode[];
  routes: { host: string; service: string; port?: number }[];
  ingress?: string; // node id: "lb:alb" or "service:<proxy>"
  warnings: string[];
}

export interface Inventory {
  at: number;
  catalogs: Map<string, Catalog>;
  unassigned: { databases: RawDb[]; caches: RawCache[] };
  errors: string[];
  // Ids of every RDS instance and ElastiCache group/cluster read, per region (missing: that list couldn't be read):
  // what the config's environments.<id>.databases / caches are checked against.
  seen: Record<string, { databases?: string[]; caches?: string[] }>;
}

// Each region is built on its own (cache key "discovery:inventory@<region>") and the parts are merged per call: the home
// region always, other regions when they have environments. A region that fails is reported, never fatal (except home).
export async function inventory(): Promise<Inventory> {
  const { home, regions } = await consoleRegions();
  const envs = await listEnvs();
  const want = regions.filter((r) => r === home || envs.some((e) => e.region === r));
  const parts = await Promise.all(
    want.map(async (region) => {
      try {
        return (await cached(`discovery:inventory@${region}`, 60_000, () => buildInventory(region, home), { staleMs: DISCOVERY_STALE_MS })).value;
      } catch (e) {
        if (region === home) throw e;
        return { at: Date.now(), catalogs: new Map(), unassigned: { databases: [], caches: [] }, errors: [`${region}: ${errText(e)}`], seen: {} } satisfies Inventory;
      }
    }),
  );
  const down = [...regionErrors()].filter(([r, x]) => regions.includes(r) && x.until > Date.now()).map(([r, x]) => `${r}: ECS clusters: ${x.error}`);
  return {
    at: Math.min(...parts.map((p) => p.at)),
    catalogs: new Map(parts.flatMap((p) => [...p.catalogs])),
    unassigned: { databases: parts.flatMap((p) => p.unassigned.databases), caches: parts.flatMap((p) => p.unassigned.caches) },
    errors: [...parts.flatMap((p) => p.errors), ...down],
    seen: Object.assign({}, ...parts.map((p) => p.seen ?? {})),
  };
}

export async function catalog(envId: string): Promise<Catalog> {
  const inv = await inventory();
  const c = inv.catalogs.get(envId);
  if (c) return c;
  await envInfo(envId); // 404 for unknown ids
  throw new HttpError(503, `environment "${envId}" could not be discovered: ${inv.errors.join("; ") || "no data yet"}`);
}

const settle = async <T,>(p: Promise<T>, fallback: T, errors: string[], what: string): Promise<T> => {
  try {
    return await p;
  } catch (e) {
    errors.push(`${what}: ${errText(e)}`);
    return fallback;
  }
};

async function buildInventory(region: string, home: string): Promise<Inventory> {
  const cloud = await getCloud(region);
  const { config } = consoleConfig();
  const errors: string[] = [];
  const envs = (await listEnvs()).filter((e) => e.region === region);
  const self = await selfRef();
  const where = region === home ? "" : `${region}: `; // errors outside the home region say which region
  const read = { databases: true, caches: true };
  const [perEnv, dbs, caches] = await Promise.all([
    Promise.all(
      envs.map(async (env) => ({
        env,
        services: await settle(servicesOf(env.cluster, region), [], errors, `${env.id} services`),
        hosts:
          env.kind === "compose" ? await settle(cloud.instances([env.host!]), [], errors, `${env.id} box`)
          : env.kind === "ec2" || env.kind === "mixed" ? await settle(cloud.hosts(env.cluster), [], errors, `${env.id} hosts`)
          : [],
      })),
    ),
    settle(cloud.databases().catch((e) => { read.databases = false; throw e; }), [], errors, `${where}RDS`),
    settle(cloud.caches().catch((e) => { read.caches = false; throw e; }), [], errors, `${where}ElastiCache`),
  ]);

  // Security groups referenced anywhere, and each env's VPCs.
  const sgIds = new Set<string>([...dbs.flatMap((d) => d.securityGroups), ...caches.flatMap((c) => c.securityGroups)]);
  for (const e of perEnv) for (const x of [...e.services.flatMap((s) => s.securityGroups), ...e.hosts.flatMap((h) => h.securityGroups)]) sgIds.add(x);
  const [sgs, subnetVpc] = await Promise.all([
    settle(cloud.securityGroups([...sgIds]), [], errors, `${where}security groups`),
    settle(cloud.subnetVpcs([...new Set(perEnv.flatMap((e) => e.services.flatMap((s) => s.subnets)))]), {} as Record<string, string>, errors, `${where}subnets`),
  ]);
  const rules: Record<string, SgRule[]> = Object.fromEntries(sgs.map((g) => [g.id, g.inbound]));

  const dbNodes: NodeRef[] = dbs.map((d) => ({ id: `database:${d.id}`, kind: "database", securityGroups: d.securityGroups, ports: d.port ? [d.port] : [], hosts: d.endpoint ? [d.endpoint] : [], engine: d.engine.replace(/^aurora-/, "") }));
  const cacheNodes: NodeRef[] = caches.map((c) => ({ id: `cache:${c.id}`, kind: "cache", securityGroups: c.securityGroups, ports: c.port ? [c.port] : [], hosts: c.endpoint ? [c.endpoint.replace(/^[^.]+\./, "")] : [], engine: c.engine }));

  const drafts = await Promise.all(
    perEnv.map(async ({ env, services, hosts }) => {
      const hostSgs = hosts.flatMap((h) => h.securityGroups);
      const meta = new Map(services.map((s) => [s.name, serviceMeta(env, s, self)]));
      const svcNodes: NodeRef[] = services.map((s) => {
        const td = s.taskDef;
        const m = meta.get(s.name)!;
        const host = td?.networkMode === "host" || td?.networkMode === "bridge";
        const p = placement(s);
        return {
          id: `service:${s.name}`, kind: "service", securityGroups: s.securityGroups.length ? s.securityGroups : host ? hostSgs : [], ports: m.ports,
          hosts: [s.name, ...(td?.containers.map((c) => c.name) ?? [])], hostNetwork: td?.networkMode === "host",
          instances: [...p.on.keys()], placedAll: !p.unplaced,
        };
      });
      const envHosts: Record<string, HostRef[]> = Object.fromEntries(services.map((s) => [`service:${s.name}`, s.taskDef?.containers.flatMap((c) => c.envHosts) ?? []]));
      // Host-networked services share the instance's security groups; an SG edge from one of them says "something on
      // this host", not which service — only keep SG edges for services with their own (awsvpc) groups.
      const all = inferEdges([...svcNodes, ...dbNodes, ...cacheNodes], rules, envHosts);
      const inferred = all.filter((e) => !(e.source.startsWith("security group") && svcNodes.find((n) => n.id === e.from)?.securityGroups === hostSgs && hostSgs.length));
      const vpcIds = [...new Set([...services.flatMap((s) => s.subnets.map((x) => subnetVpc[x])), ...hosts.map((h) => h.vpcId)].filter(Boolean) as string[])];
      await guessRepos(env, services, meta, config.github?.owner);
      return { env, services, hosts, meta, inferred, all, vpcIds };
    }),
  );

  // Attribute the region's databases and caches to one env each (of this region).
  const envKeys = drafts.map((d) => ({ id: d.env.id, stageWords: stageWordsOf(d.env.id, d.env.cluster), vpcIds: d.vpcIds }));
  const configured: Record<string, string> = {};
  for (const [id, e] of Object.entries(config.environments ?? {})) {
    if (envs.some((x) => x.id === id)) for (const x of [...(e.databases ?? []), ...(e.caches ?? [])]) configured[x] = id;
  }
  const owner = (nodeId: string, r: { id: string; tags: Record<string, string>; vpcId?: string }) =>
    attribute(r, envKeys, new Set(drafts.filter((d) => d.all.some((e) => e.to === nodeId)).map((d) => d.env.id)), configured);
  const dbOwner = new Map(dbs.map((d) => [d.id, owner(`database:${d.id}`, d)]));
  const cacheOwner = new Map(caches.map((c) => [c.id, owner(`cache:${c.id}`, { id: c.id, tags: {} })]));

  const catalogs = new Map<string, Catalog>();
  for (const d of drafts) {
    const mine = { databases: dbs.filter((x) => dbOwner.get(x.id) === d.env.id), caches: caches.filter((x) => cacheOwner.get(x.id) === d.env.id) };
    const lb = d.services.some((s) => s.targetGroupArns.length);
    const proxy = [...d.meta.values()].find((m) => m.proxy);
    // A compose env's nodes are its declared workloads (AWS sees none of its containers).
    const wg = d.env.kind === "compose"
      ? workloadGraph(workloadsOf(config, d.env.id), { databases: mine.databases.map((x) => x.id), caches: mine.caches.map((x) => x.id), externals: Object.keys(config.externals ?? {}),
          sources: Object.entries(config.externals ?? {}).filter(([, x]) => x.side === "source").map(([id]) => id) })
      : undefined;
    const ingress = wg ? wg.ingress : lb ? "lb:alb" : proxy ? `service:${proxy.id}` : undefined;
    const nodeIds = new Set([...d.services.map((s) => `service:${s.name}`), ...(wg?.nodes ?? []), ...mine.databases.map((x) => `database:${x.id}`), ...mine.caches.map((x) => `cache:${x.id}`)]);
    const edges: TopoEdge[] = d.inferred
      .filter((e) => nodeIds.has(e.from) && nodeIds.has(e.to))
      .map((e) => ({ id: `${e.from}>${e.to}`, from: e.from, to: e.to, label: e.label, kind: e.kind, source: `inferred · ${e.source}` }));
    for (const e of wg?.edges ?? []) edges.push({ id: `${e.from}>${e.to}`, ...e, source: "console.config.json workloads" });
    if (lb) for (const s of d.services.filter((x) => x.targetGroupArns.length)) edges.push({ id: `lb:alb>service:${s.name}`, from: "lb:alb", to: `service:${s.name}`, label: "target group", kind: "http", source: "load balancer target group" });
    const externals = Object.entries(config.externals ?? {}).map(([id, x]) => ({ id: `ext:${id}`, label: x.label, sub: x.sub ?? "external", kind: "external" as const, lane: (x.side === "destination" ? 4 : 0) as 0 | 4, note: x.note ?? "External system — not monitored here." }));
    const pinned = config.environments && Object.hasOwn(config.environments, d.env.id) ? config.environments[d.env.id] : undefined;
    const dbAlias = aliasTarget(mine.databases, pinned?.databases), cacheAlias = aliasTarget(mine.caches, pinned?.caches);
    const resolve = (ref: string) =>
      ref === "ingress" ? ingress : ref === "db" ? (dbAlias ? `database:${dbAlias}` : undefined) : ref === "cache" ? (cacheAlias ? `cache:${cacheAlias}` : [...d.meta.values()].find((m) => /redis|valkey|memcached/.test(m.id)) ? `service:${[...d.meta.values()].find((m) => /redis|valkey|memcached/.test(m.id))!.id}` : undefined) : ref;
    const known = new Set([...nodeIds, ...externals.map((x) => x.id), ...(lb ? ["lb:alb"] : [])]);
    for (const c of config.connections ?? []) {
      if (c.envs && !c.envs.includes(d.env.id)) continue;
      const from = resolve(c.from), to = resolve(c.to);
      if (!from || !to || !known.has(from) || !known.has(to)) continue;
      const id = `${from}>${to}`;
      const i = edges.findIndex((e) => e.id === id);
      const e: TopoEdge = { id, from, to, label: c.label ?? edges[i]?.label ?? "", kind: (c.kind ?? edges[i]?.kind ?? "http") as EdgeKind, source: "console.config.json" };
      if (i >= 0) edges[i] = e;
      else edges.push(e);
    }
    const warnings: string[] = [];
    for (const [name, m] of d.meta) {
      // An invalid health-check URL is reported even on hidden services: it is a tag someone can set.
      if (m.healthcheckProblem) warnings.push(`${name}: ${m.healthcheckProblem} — not probed`);
      if (m.hidden) continue;
      if (!m.logs) warnings.push(`${name}: no awslogs log configuration on its main container — logs unavailable`);
      if (!m.infra && !m.repo) warnings.push(`${name}: no GitHub repo — tag the service console:repo=owner/name (or set services.${name}.repo)`);
    }
    catalogs.set(d.env.id, { env: d.env, meta: d.meta, hosts: d.hosts, ...mine, edges, externals, routes: pinned?.routes ?? [], ingress, warnings });
  }
  const ids = new Set(catalogs.keys());
  return {
    at: Date.now(),
    catalogs,
    // A database whose tag names an environment with no ECS cluster (or "shared") isn't waiting for a tag: the cloud map
    // places it, so it isn't listed as unattributed.
    unassigned: { databases: unassignedOf(dbs, dbOwner, ids).filter((d) => !envTagDecides(envTagOf(d.tags) ?? "")), caches: unassignedOf(caches, cacheOwner, ids) },
    errors,
    seen: {
      [region]: {
        ...(read.databases ? { databases: dbs.map((x) => x.id) } : {}),
        ...(read.caches ? { caches: [...new Set(caches.flatMap((x) => [x.id, ...(x.memberClusters ?? [])]))] } : {}),
      },
    },
  };
}

// What console.config.json names that the account doesn't have (F05), the regions the console couldn't resolve, and
// health-check tags it won't probe. Warnings only: the environment list stays what discovery found.
export async function discoveryWarnings(): Promise<DiscoveryWarning[]> {
  const regions = await consoleRegions();
  const [{ home, byRegion }, envs, inv] = await Promise.all([clustersByRegion(), listEnvs(), inventory()]);
  const down = new Set(unreadRegions().map((x) => x.region));
  const clusters: Record<string, RawCluster[] | undefined> = Object.fromEntries(byRegion.map(([r, list]) => [r, down.has(r) ? undefined : list]));
  const out: DiscoveryWarning[] = (regions.problems ?? []).map((m) => ({ kind: "region" as const, scope: "regions", message: m, hint: "check CONSOLE_REGIONS or inventory.regions" }));
  out.push(
    ...configWarnings({
      home, regions: regions.regions, clusters, config: consoleConfig().config, envs,
      databases: Object.fromEntries(Object.entries(inv.seen).map(([r, x]) => [r, x.databases])),
      caches: Object.fromEntries(Object.entries(inv.seen).map(([r, x]) => [r, x.caches])),
    }),
  );
  for (const c of inv.catalogs.values())
    for (const m of c.meta.values())
      if (m.healthcheckProblem) out.push({ kind: "healthcheck", scope: `service ${c.env.id}/${m.id}`, env: c.env.id, region: c.env.region, message: `${c.env.id}/${m.id}: ${m.healthcheckProblem} — not probed`, hint: "use an http:// or https:// URL of at most 2,048 characters" });
  return out;
}

// A compose env's apps: the workloads console.config.json gives that env id.
export const workloadsOf = (config: ConsoleConfig, envId: string) => Object.fromEntries(Object.entries(config.workloads ?? {}).filter(([, w]) => w.env === envId));

// Services per cluster (in a region; default home), shared with the overview so discovery never doubles ECS calls.
// Fresh for 5 s, then served stale for up to 12 s more while one refresh runs (F57): ttl + stale stays ≤ 20 s because
// the overview derives states from `at`. invalidate() (after an action) forces a blocking re-read.
// No cluster (a compose env) → no ECS services; never ask ECS about "", which it would read as the "default" cluster.
export const servicesAt = (cluster: string, region?: string): Promise<{ value: RawService[]; at: number }> =>
  !cluster ? Promise.resolve({ value: [], at: Date.now() }) : getCloud(region).then((c) => cached(`svc:${inRegion(cluster, region)}`, 5_000, () => c.services(cluster), { staleMs: 12_000 }));
export const servicesOf = (cluster: string, region?: string) => servicesAt(cluster, region).then((r) => r.value);

// No tag or config → try "<owner>/<ECR repo or service name>" when GITHUB_OWNER (or config github.owner) is set.
async function guessRepos(env: EnvInfo, services: RawService[], meta: Map<string, ServiceMeta>, cfgOwner?: string) {
  const owner = cfgOwner || process.env.GITHUB_OWNER;
  if (!owner) return;
  const ci = await getCi();
  await Promise.all(
    services.map(async (s) => {
      const m = meta.get(s.name)!;
      if (m.repo || m.infra) return;
      for (const name of [...new Set([m.ecrRepo?.split("/").pop(), s.name].filter(Boolean) as string[])]) {
        try {
          if (await ci.repoExists(`${owner}/${name}`)) {
            m.repo = `${owner}/${name}`;
            m.repoSource = "guess";
            return;
          }
        } catch {
          return; // GitHub unreachable or no token: leave unmapped
        }
      }
    }),
  );
}

export async function knownRepos(): Promise<string[]> {
  const inv = await inventory();
  return [...new Set([...inv.catalogs.values()].flatMap((c) => [...c.meta.values()].filter((m) => m.repo && !m.hidden).map((m) => m.repo!)))].sort();
}

// The env's service metadata for one service, falling back to a fresh read for services newer than the catalog.
export async function metaOf(env: EnvInfo, s: RawService): Promise<ServiceMeta> {
  const c = (await inventory()).catalogs.get(env.id);
  return c?.meta.get(s.name) ?? serviceMeta(env, s, await selfRef());
}
