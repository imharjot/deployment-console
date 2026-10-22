// Service layer: discovered resources + live signals → views, guarded actions with audit. Stateless apart from caches,
// the sampler's shared state and the audit/operations/state tables in the console DB. Nothing here names a company,
// cluster or service. Every change goes through the mutation coordinator (./mutations.ts); the pure rules live in
// ../status.ts, ../history.ts and ../overview-rules.ts.
import "server-only";
import { actionSpecs, checkAction, checkPower, parseActionBody, powerSpecs, type ActionContext, type RevisionFact } from "../actions.ts";
import { CONSOLE_WRITES } from "../capability-rules.ts";
import { LIMITS } from "../config.ts";
import { periodFor } from "../metric-specs.ts";
import { parseImageRef, placement } from "../discover.ts";
import type { Freshness } from "../freshness.ts";
import { WINDOW_MS, extendSpans, latestState, rebuild, record, restore, uptime, type Span, type Transition } from "../history.ts";
import { mutationState } from "../mutation-core.ts";
import { canonicalKey, parseArn } from "../mutation-keys.ts";
import {
  GIB, VERIFIED_ACTION, VERIFIED_ACTION_SQL, autoscalingNote, ecsServicesOf, imageVerdict, joinWarning, lbDim, lbRollup, migrationsWhy, mutableTag, outsideRange, rateStat,
  samplerStaleness, sig3, targetGroupItem, trafficPlan, trafficRates, verificationOf, verifyOutcome, withCapability, type Autoscaling, type ContainerCheck,
} from "../overview-rules.ts";
import { STATE_RANK, capacityState, deriveState, deriveWorkloadState, emptySummary, parseImage } from "../status.ts";
import type { Workload } from "../console-config.ts";
import type {
  ActionResult, ActionSpec, AuditEntry, BoxAction, CommitInfo, Derived, EnvInfo, EnvOverview, Fetched, MetricSeries, PropertyGroup, PropertyItem,
  OperationNote, ProbeResult, RawBox, RawCache, RawDb, RawLb, RawRevision, RawService, RawTargetHealth, ResourceView, RevisionView, Signals, State, TopoEdge, TopoNode,
} from "../types.ts";
import { readAudit, recallDesired, rememberDesired } from "./audit.ts";
import { cached, invalidate } from "./cache.ts";
import { migrationsChanged } from "./ci.ts";
import { capability } from "./capability.ts";
import { getDb, newId } from "./db.ts";
import { catalog, consoleConfig, envInfo, inRegion, listEnvs, metaOf, servicesAt, workloadsOf, type Catalog, type ServiceMeta } from "./discovery.ts";
import { HttpError, errText } from "./errors.ts";
import { mutate, onMutation, type MutationActor, type MutationEvent } from "./mutations.ts";
import { markVerified } from "./operations.ts";
import { probe } from "./probes.ts";
import { cloudFor, getCi, type Cloud, type LbConfig, type MetricSpec, type TargetHealthDetail } from "./sources.ts";

// Runs a fetch and keeps its failure as data, so one unreadable source degrades a tile instead of the whole view.
export const settle = async <T,>(p: Promise<T>): Promise<Fetched<T>> => {
  try {
    return { ok: true, value: await p };
  } catch (e) {
    return { ok: false, error: errText(e) };
  }
};

const ago = (ms?: number) => {
  if (!ms) return "—";
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 90) return `${s}s ago`;
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  if (s < 172800) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
};
const when = (ms?: number) => (ms ? `${new Date(ms).toISOString().replace("T", " ").slice(0, 16)} UTC · ${ago(ms)}` : "—");
const short = (id: string, n = 12) => (id.length > n ? id.slice(0, n) : id);
const log = (level: 40 | 50, msg: string, o: Record<string, unknown> = {}) =>
  (level === 50 ? console.error : console.warn)(JSON.stringify({ level, msg, ...o }));

type View = ResourceView;

// ---------- raw fetches (short TTLs; stale-while-revalidate only where it never feeds a state older than 20 s) ----------
// Each env is read through its own region's Cloud; cache keys carry the region outside home (inRegion).

const at = (env: EnvInfo) => inRegion(env.cluster || `box/${env.host}`, env.region); // a compose env has no cluster
const servicesRaw = (env: EnvInfo) => servicesAt(env.cluster, env.region);
const hostsRaw = (env: EnvInfo) =>
  cloudFor(env).then((c) => cached(`hosts:${at(env)}`, 5_000, () => (env.kind === "compose" ? c.instances([env.host!]) : c.hosts(env.cluster)), { staleMs: 12_000 }));
const dbsAll = (env: EnvInfo) => cloudFor(env).then((c) => cached(`dbs:${inRegion("all", env.region)}`, 10_000, () => c.databases(), { staleMs: 30_000 }));
const cachesAll = (env: EnvInfo) => cloudFor(env).then((c) => cached(`caches:${inRegion("all", env.region)}`, 15_000, () => c.caches(), { staleMs: 30_000 }));

// Target health per target group ARN (F58): one read per group, shared by the service tiles and the load balancer.
async function targetHealthOf(env: EnvInfo, arns: string[]): Promise<{ value: TargetHealthDetail[]; at: number }> {
  const c = await cloudFor(env);
  const list = await Promise.all([...new Set(arns)].map((arn) => cached(`tgh:${arn}`, 10_000, async () => (await c.targetHealth([arn]))[0] ?? null, { staleMs: 8_000 })));
  return { value: list.map((r) => r.value).filter((x): x is TargetHealthDetail => !!x), at: Math.min(Date.now(), ...list.map((r) => r.at)) };
}

// Target group → its load balancer (F28: cached 10 min; ARNs don't move).
const tglbOf = (env: EnvInfo, arns: string[]) =>
  cloudFor(env).then((c) => {
    const sorted = [...new Set(arns)].sort();
    return cached(`tglb:${env.region}:${sorted.join(",")}`, 10 * 60_000, () => c.targetGroupLbs(sorted)).then((r) => r.value);
  });

// The load balancer's listeners, rules and target groups, without health (F58: the Cloud caches it 10 min).
const lbConfigOf = (env: EnvInfo, lbArn: string): Promise<{ value: LbConfig; at: number }> =>
  cloudFor(env).then((c) => cached(`lb:${lbArn}`, 15_000, () => c.lbConfig(lbArn), { staleMs: 30_000 }));

// The load balancer an env's card describes: the one in front of the most service target groups.
const primaryLb = (tglb: Record<string, string>, tgs: string[]) => {
  const count = new Map<string, number>();
  for (const tg of tgs) if (Object.hasOwn(tglb, tg) && tglb[tg]) count.set(tglb[tg], (count.get(tglb[tg]) ?? 0) + 1);
  return [...count.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];
};

// Application Auto Scaling targets of an env's services (CC-20); none when the source can't tell.
async function scalableOf(env: EnvInfo): Promise<Map<string, Autoscaling>> {
  const c = await cloudFor(env);
  const list = (await cached(`scalable:${at(env)}`, 60_000, () => c.scalableTargets(env.cluster))).value;
  return new Map(list.map((t) => [t.service, { min: t.min, max: t.max, policies: t.policies }]));
}

export async function autoscalingOf(env: EnvInfo, service: string): Promise<Autoscaling | undefined> {
  const live = (await servicesRaw(env)).value.find((s) => s.name === service);
  if (live?.scalable) return live.scalable;
  return (await scalableOf(env).catch(() => new Map<string, Autoscaling>())).get(service);
}

async function probeFor(env: EnvInfo, m: ServiceMeta) {
  if (!m.healthcheck) return undefined;
  const c = await cloudFor(env);
  if (c.probe) return c.probe(env.cluster, m.id, m.healthcheck);
  return probe(m.healthcheck);
}

async function commitFor(repo: string | undefined, sha: string | undefined): Promise<CommitInfo | undefined> {
  if (!repo || !sha) return undefined;
  try {
    return (await (await getCi()).commit(repo, sha)) ?? undefined;
  } catch {
    return undefined;
  }
}

async function behindBy(env: EnvInfo, repo: string | undefined, sha: string | undefined) {
  if (!repo || !sha || !env.branch) return undefined;
  try {
    const r = await cached(`behind:${repo}:${sha}:${env.branch}`, 60_000, async () => (await getCi()).compare(repo, sha, env.branch!));
    return r.value?.aheadBy;
  } catch {
    return undefined;
  }
}

// CPU sparkline for every card in one GetMetricData call per env.
function sparkSpecs(env: EnvInfo, services: RawService[], hosts: RawBox[], dbs: RawDb[]): MetricSpec[] {
  const specs: MetricSpec[] = services.map((s, i) => ({ id: `s${i}`, namespace: "AWS/ECS", metric: "CPUUtilization", dims: { ClusterName: env.cluster, ServiceName: s.name }, stat: "Average" }));
  hosts.forEach((h, i) => specs.push({ id: `h${i}`, namespace: "AWS/EC2", metric: "CPUUtilization", dims: { InstanceId: h.id }, stat: "Average" }));
  dbs.forEach((d, i) => {
    specs.push({ id: `d${i}`, namespace: "AWS/RDS", metric: "CPUUtilization", dims: { DBInstanceIdentifier: d.id }, stat: "Average" });
    specs.push({ id: `c${i}`, namespace: "AWS/RDS", metric: "DatabaseConnections", dims: { DBInstanceIdentifier: d.id }, stat: "Average" });
  });
  return specs;
}

// ---------- capability and in-process locks on the views ----------

const ecsKey = (env: EnvInfo, service: string) => canonicalKey({ ecsService: { region: env.region, cluster: env.cluster, service } });
// A change to this key is being submitted in this process (the coordinator's mutexes); other processes show via 409.
const held = (key: string) => mutationState().held.has(key);

const capable = (write: string) => (spec: ActionSpec) => {
  const iam = Object.hasOwn(CONSOLE_WRITES, write) ? CONSOLE_WRITES[write] : [];
  return iam.length ? withCapability(spec, capability(iam), iam) : spec;
};

// ---------- views ----------

function probeItems(p: ProbeResult | undefined, none: string): PropertyItem[] {
  if (!p) return [{ label: "Probe", value: none, tone: "muted" }];
  return [
    { label: "Health check URL", value: p.url, href: p.url, mono: true },
    {
      label: "Probe result",
      value: p.pass ? `HTTP ${p.status} in ${p.ms}ms` : `${p.error ?? `HTTP ${p.status}`} (${p.consecutiveFailures} in a row)`,
      tone: p.pass ? "ok" : p.consecutiveFailures >= LIMITS.probeFailuresToFail ? "bad" : "warn",
    },
  ];
}

// A compose env's app (console.config.json `workloads`). Read-only: AWS can't restart a docker compose container.
function workloadView(env: EnvInfo, id: string, w: Workload, d: Derived, p: ProbeResult | undefined, checkedAt: number): View {
  const platform = w.platform ?? "docker compose";
  return {
    key: `service:${id}`, kind: "service", env: env.id, id, name: w.name, subtitle: id, state: d.state, reasons: d.reasons,
    checkedAt, fetchedAt: checkedAt, repo: w.repo, readOnly: true, infra: !w.repo, tabs: ["overview"],
    stats: [{ label: "", value: platform }],
    properties: [
      {
        title: "Workload",
        items: [
          { label: "Platform", value: platform },
          { label: "Host", value: env.host ?? "—", mono: true },
          ...(w.url ? [{ label: "URL", value: w.url, href: w.url, mono: true }] : []),
          { label: "Repository", value: w.repo ?? "not mapped", href: w.repo ? `https://github.com/${w.repo}` : undefined, tone: w.repo ? undefined : ("muted" as const) },
          ...(w.note ? [{ label: "Note", value: w.note }] : []),
          { label: "Declared in", value: `console.config.json · workloads.${id}`, mono: true },
        ],
      },
      { title: "Health", items: probeItems(p, `none (set workloads.${id}.healthcheck to add one)`) },
    ],
    actions: [],
  };
}

function serviceView(env: EnvInfo, svc: Fetched<RawService>, m: ServiceMeta, d: Derived, routes: Catalog["routes"], names: Map<string, string>, extras: {
  checkedAt: number; probe?: Signals["probe"]; targets?: Signals["targets"]; commit?: CommitInfo; behind?: number; spark?: number[]; locked: boolean;
  autoscaling?: Autoscaling; shortfallSince?: number; operations?: OperationNote[];
}): View {
  const name = m.id;
  const base = {
    key: `service:${name}`, kind: "service" as const, env: env.id, id: name, name: m.name, state: d.state, reasons: d.reasons,
    checkedAt: extras.checkedAt, fetchedAt: extras.checkedAt, repo: m.repo, readOnly: m.self, infra: m.infra,
    tabs: [...(["overview", "revisions", "variables", "events"] as const), ...(m.logs ? (["logs"] as const) : []), "metrics"] as ResourceView["tabs"],
  };
  if (!svc.ok) {
    return { ...base, subtitle: name, stats: [], properties: [{ title: "Runtime", items: [{ label: "Error", value: svc.error, tone: "bad" }] }], actions: [] };
  }
  const s = svc.value;
  const td = s.taskDef;
  const img = td ? parseImage(td.image) : undefined;
  const inProgress = s.deployments.some((x) => x.rolloutState === "IN_PROGRESS");
  const ctx: ActionContext = { env: env.id, protected: env.protected, service: name, desired: s.desired, inProgress, isSelf: m.self, locked: extras.locked, liveArn: td?.arn };
  const running = s.tasks.filter((t) => t.desiredStatus === "RUNNING");
  const stopped = s.tasks.filter((t) => t.desiredStatus !== "RUNNING");
  const cap = capacityState({ desired: s.desired, running: s.running, pending: s.pending, rollout: inProgress }, extras.shortfallSince, Date.now(), LIMITS.capacityGraceMs);
  const scaling = extras.autoscaling;
  const probeItem = probeItems(extras.probe, "none (tag console:healthcheck=<url> to add one)");

  const properties: PropertyGroup[] = [
    {
      title: "Runtime",
      items: [
        { label: "Desired count", value: String(s.desired), edit: m.self ? undefined : "desired" },
        { label: "Running / pending", value: `${s.running} / ${s.pending}`, tone: cap.state === "short" ? "bad" : cap.state === "starting" ? "warn" : undefined },
        ...(cap.reason ? [{ label: "Capacity", value: cap.reason, tone: cap.state === "short" ? ("bad" as const) : ("warn" as const) }] : []),
        ...(scaling ? [{ label: "Autoscaling", value: `min ${scaling.min} · max ${scaling.max}${scaling.policies.length ? ` · ${scaling.policies.join(", ")}` : ""}` }] : []),
        { label: "Launch type", value: s.launchType },
        { label: "Cluster", value: s.cluster, mono: true },
        { label: "Service status", value: s.status },
        { label: "Circuit breaker", value: s.circuitBreaker ? "on (auto-rollback)" : "off", tone: s.circuitBreaker ? "ok" : "warn" },
        { label: "Created", value: when(s.createdAt) },
      ],
    },
    {
      title: "Revision",
      items: [
        { label: "Task definition", value: td ? `${td.family}:${td.revision}` : "—", mono: true, edit: m.self ? undefined : "revision" },
        { label: "Image tag", value: img?.tag ?? "—", mono: true, copy: true },
        { label: "Commit", value: img?.sha ? img.sha.slice(0, 7) : "unknown (tag has no git sha)", mono: true, href: extras.commit?.url, tone: img?.sha ? undefined : "warn" },
        ...(extras.commit ? [{ label: "Title", value: extras.commit.title }, { label: "Author", value: `${extras.commit.author} · ${ago(Date.parse(extras.commit.date))}` }] : []),
        ...(extras.behind !== undefined ? [{ label: "Behind branch", value: extras.behind === 0 ? `up to date with ${env.branch}` : `${extras.behind} commit(s) behind ${env.branch}`, tone: extras.behind === 0 ? ("ok" as const) : ("warn" as const) }] : []),
        { label: "Repository", value: m.repo ? `${m.repo}${m.repoSource === "guess" ? " (matched by name)" : ""}` : "not mapped", href: m.repo ? `https://github.com/${m.repo}` : undefined, tone: m.repo ? undefined : "muted" },
        { label: "Registered", value: when(td?.registeredAt) },
      ],
    },
    {
      title: "Container",
      items: [
        { label: "Main container", value: td?.main || "—", mono: true },
        { label: "CPU units", value: td?.cpu ?? "—" },
        { label: "Memory (hard)", value: td?.memory ? `${td.memory} MiB` : "—" },
        ...(td?.memoryReservation ? [{ label: "Memory (reserved)", value: `${td.memoryReservation} MiB` }] : []),
        { label: "Network mode", value: td?.networkMode ?? "—" },
        { label: "Ports", value: td?.ports.join(", ") || "—", mono: true },
        { label: "Health check", value: td?.healthcheck ?? "none", mono: true },
        { label: "Log group", value: m.logs ? `${m.logs.group}${m.logs.prefix ? ` · ${m.logs.prefix}*` : ""}` : "no awslogs configuration", mono: true, copy: !!m.logs, tone: m.logs ? undefined : "warn" },
        ...((td?.containers.length ?? 0) > 1 ? [{ label: "Sidecars", value: td!.containers.filter((c) => c.name !== td!.main).map((c) => c.name).join(", "), mono: true }] : []),
      ],
    },
    ...(m.proxy && routes.length
      ? [{ title: "Routing", items: routes.map((r) => ({ label: r.host, value: `→ ${names.get(r.service) ?? r.service}${r.port ? ` · :${r.port}` : ""}`, mono: true })) }]
      : []),
    { title: "Health", items: [...probeItem, ...(extras.targets ?? []).map((tg) => targetGroupItem(tg, s.desired))] },
    {
      title: "Tasks",
      items: [
        ...running.map((t) => ({
          label: `Task ${short(t.id)}`,
          value: `${t.lastStatus} · health ${t.hasHealthcheck ? t.health : "n/a"} · started ${ago(t.startedAt)}`,
          tone: t.lastStatus === "RUNNING" && (t.health === "HEALTHY" || !t.hasHealthcheck) ? ("ok" as const) : ("warn" as const),
        })),
        ...stopped.map((t) => ({ label: `Stopped ${short(t.id)}`, value: `${t.stoppedReason ?? "stopped"}${t.exitCode !== undefined ? ` · exit ${t.exitCode}` : ""} · ${ago(t.stoppedAt)}`, tone: "muted" as const })),
        ...(s.tasks.length ? [] : [{ label: "Tasks", value: s.running > 0 ? `${s.running} running (details unavailable)` : "none", tone: "muted" as const }]),
      ],
    },
    {
      title: "Deployments",
      items: s.deployments.map((x) => ({
        label: `${x.status.toLowerCase()} ${short(x.id.replace("ecs-svc/", ""), 10)}`,
        value: `${x.rolloutState ?? "—"} · rev ${x.taskDefinition.split(":").pop()} · ${x.running}/${x.desired} running · ${ago(x.createdAt)}${x.rolloutReason ? ` · ${x.rolloutReason}` : ""}`,
        tone: x.rolloutState === "FAILED" ? ("bad" as const) : x.rolloutState === "IN_PROGRESS" ? ("warn" as const) : undefined,
      })),
    },
  ];

  // Autoscaling overrides counts outside its range (CC-20): Stop (0) and Start (the remembered count) say so.
  const scaled = (spec: ActionSpec): ActionSpec =>
    scaling && spec.enabled && ((spec.name === "stop" && outsideRange(scaling, 0)) || spec.name === "start") ? { ...spec, warning: joinWarning(spec.warning, autoscalingNote(scaling)) } : spec;

  return {
    ...base,
    subtitle: name,
    sha: img?.sha,
    commit: extras.commit,
    behindBy: extras.behind,
    stats: [
      { label: "tasks", value: `${s.running}/${s.desired}` },
      { label: "rev", value: td ? String(td.revision) : "—" },
      { label: "mem", value: td?.memory ? `${td.memory}M` : "—" },
    ],
    spark: extras.spark,
    properties,
    capacity: { desired: s.desired, running: s.running, pending: s.pending, ...(extras.shortfallSince !== undefined ? { shortfallSince: extras.shortfallSince } : {}) },
    ...(scaling ? { autoscaling: scaling } : {}),
    ...(extras.operations?.length ? { operations: extras.operations } : {}),
    actions: m.self ? [] : actionSpecs(ctx).map((a) => scaled(capable(`ecs.${a.name}`)(a))),
  };
}

// What runs on a host. Compose: every declared workload. ECS: placement() of the env's tasks — tasks whose host wasn't
// read are `unknown` (any host may have them) and their services `maybe` here: never shown as absent.
interface OnHost { services: string[]; maybe: string[]; running: number; starting: number; unknown: number }

function hostView(env: EnvInfo, h: RawBox, checkedAt: number, on: OnHost, spark?: number[]): View {
  const placed = on.services.length;
  const compose = env.kind === "compose"; // the box runs docker compose: no ECS agent, no container instance
  // shutting-down is deliberate (a terminate), not an outage: no "down" alert while a console-created host goes away.
  const map: Record<string, State> = { running: "UP", stopped: "STOPPED", pending: "DEPLOYING", stopping: "DEPLOYING", "shutting-down": "STOPPED" };
  const state = h.state === "running" && h.agentConnected === false ? "DEGRADED" : (map[h.state] ?? "DOWN");
  return {
    key: `box:${h.id}`, kind: "box", env: env.id, id: h.id, name: h.tags.Name ?? h.id, checkedAt, fetchedAt: checkedAt,
    tabs: compose ? ["overview", "metrics"] : ["overview", "containers", "metrics"],
    subtitle: `${h.id} · ${h.type}`,
    state,
    reasons: [state === "DEPLOYING" ? `${h.state}…` : state === "DEGRADED" ? "ECS agent disconnected — tasks can't be placed" : `instance ${h.state}`],
    stats: [
      { label: "", value: h.type },
      compose
        ? { label: placed === 1 ? "container" : "containers", value: String(placed) }
        : { label: on.running === 1 && !on.unknown ? "task" : "tasks", value: on.unknown ? (on.running ? `${on.running}+` : "?") : String(on.running) },
      { label: "up", value: h.state === "running" ? ago(h.launchedAt).replace(" ago", "") : "—" },
    ],
    placed: on.services,
    ...(on.maybe.length ? { maybePlaced: on.maybe } : {}),
    spark,
    properties: [
      {
        title: "Instance",
        items: [
          { label: "Power", value: h.state, edit: "power", tone: h.state === "running" ? "ok" : "warn" },
          { label: "Instance id", value: h.id, mono: true, copy: true },
          { label: "Type", value: h.type },
          { label: "Availability zone", value: h.az ?? "—" },
          { label: "Platform", value: h.platform ?? "—" },
          { label: "Private IP", value: h.privateIp ?? "—", mono: true },
          { label: "Public IP", value: h.publicIp ?? "—", mono: true },
          { label: "Running since", value: h.state === "running" ? when(h.launchedAt) : "—" },
          ...(h.asg ? [{ label: "Auto Scaling group", value: h.asg, mono: true }] : []),
        ],
      },
      compose
        ? { title: "Docker compose", items: [{ label: "Workloads declared", value: String(placed) }] }
        : { title: "Capacity", items: [{ label: "ECS cluster", value: env.cluster, mono: true }, { label: "Services placed", value: `${placed}${on.maybe.length ? ` (+${on.maybe.length} unknown)` : ""}` }, { label: "Tasks running", value: `${on.running}${on.unknown ? " known" : ""}${on.starting ? ` · ${on.starting} starting` : ""}` }, ...(on.unknown ? [{ label: "Placement", value: `${on.unknown} task${on.unknown === 1 ? "" : "s"} not read — may run here`, tone: "warn" as const }] : []), { label: "ECS agent", value: h.agentConnected === false ? "disconnected" : "connected", tone: h.agentConnected === false ? "bad" : "ok" }] },
    ],
    actions: powerSpecs({ kind: "host", state: h.state, protected: env.protected, asg: h.asg }).map(capable("host.power")),
  };
}

const DB_STATE: Record<string, State> = { available: "UP", stopped: "STOPPED", starting: "DEPLOYING", stopping: "DEPLOYING", modifying: "DEPLOYING", "backing-up": "UP", rebooting: "DEPLOYING", upgrading: "DEPLOYING" };
const ENGINE: Record<string, string> = { postgres: "PostgreSQL", "aurora-postgresql": "Aurora PostgreSQL", mysql: "MySQL", "aurora-mysql": "Aurora MySQL", mariadb: "MariaDB", "sqlserver-se": "SQL Server", oracle: "Oracle" };
const ENGINE_SHORT: Record<string, string> = { postgres: "Postgres", "aurora-postgresql": "Aurora Postgres", mysql: "MySQL", "aurora-mysql": "Aurora MySQL", mariadb: "MariaDB", "sqlserver-se": "SQL Server", oracle: "Oracle" };

function dbView(env: EnvInfo, d: RawDb, checkedAt: number, spark?: number[]): View {
  const state = DB_STATE[d.status] ?? "DOWN";
  return {
    key: `database:${d.id}`, kind: "database", env: env.id, id: d.id, name: ENGINE[d.engine] ?? d.engine, subtitle: d.id, state, reasons: [`status ${d.status}`], checkedAt, fetchedAt: checkedAt,
    // Cards print "<value> <label>": "Postgres 17.6 · db.r6g.large · 100 GiB disk" (F39); RDS storage is in GiB (F70).
    stats: [{ label: d.engineVersion, value: ENGINE_SHORT[d.engine] ?? d.engine }, { label: "", value: d.instanceClass }, { label: "disk", value: `${d.storageGb} GiB` }],
    spark,
    properties: [
      {
        title: "Database",
        items: [
          { label: "Status", value: d.status, tone: state === "UP" ? "ok" : "warn", edit: "power" },
          { label: "Identifier", value: d.id, mono: true, copy: true },
          { label: "Engine", value: `${d.engine} ${d.engineVersion}` },
          { label: "Instance class", value: d.instanceClass },
          { label: "Storage", value: `${d.storageGb} GiB` },
          { label: "Multi-AZ", value: d.multiAz ? "yes" : "no" },
          { label: "Endpoint", value: d.endpoint ? `${d.endpoint}${d.port ? `:${d.port}` : ""}` : "—", mono: true, copy: true },
          ...(d.aurora ? [{ label: "Aurora cluster", value: d.aurora, mono: true }] : []),
        ],
      },
    ],
    actions: powerSpecs({ kind: "database", state: d.status, protected: env.protected, aurora: d.aurora }).map(capable("db.power")),
    tabs: ["overview", "metrics"],
  };
}

function cacheView(env: EnvInfo, c: RawCache, checkedAt: number): View {
  const state: State = c.status === "available" ? "UP" : ["creating", "modifying", "snapshotting"].includes(c.status) ? "DEPLOYING" : "DEGRADED";
  const engine = c.engine === "valkey" ? "Valkey" : c.engine === "memcached" ? "Memcached" : "Redis";
  return {
    key: `cache:${c.id}`, kind: "cache", env: env.id, id: c.id, name: engine, subtitle: c.id, state, checkedAt, fetchedAt: checkedAt, readOnly: true, tabs: ["overview"],
    reasons: [`status ${c.status}`],
    stats: [
      ...(c.engineVersion ? [{ label: c.engineVersion, value: engine }] : []),
      { label: "", value: c.nodeType ?? "—" },
      { label: c.nodes === 1 ? "node" : "nodes", value: String(c.nodes) },
    ],
    properties: [{ title: "Cache", items: [
      { label: "Status", value: c.status, tone: state === "UP" ? "ok" : "warn" },
      { label: "Id", value: c.id, mono: true, copy: true },
      { label: "Engine", value: `${c.engine} ${c.engineVersion ?? ""}`.trim() },
      { label: "Node type", value: c.nodeType ?? "—" },
      { label: "Nodes", value: String(c.nodes) },
      { label: "Endpoint", value: c.endpoint ? `${c.endpoint}${c.port ? `:${c.port}` : ""}` : "—", mono: true, copy: !!c.endpoint },
    ] }],
    actions: [],
  };
}

interface LbState {
  state: State;
  reasons: string[];
  internet: boolean;
}

// One card per environment: the primary load balancer, with every service target group's health (F01).
function lbView(env: EnvInfo, lb: RawLb, state: LbState, svcByTg: Map<string, string>, names: Map<string, string>, health: Map<string, RawTargetHealth>, desiredByTg: Map<string, number>, perMin: number | undefined, checkedAt: number, others: number): View {
  const svcName = (tg?: string) => (tg ? (names.get(svcByTg.get(tg) ?? "") ?? svcByTg.get(tg) ?? tg.split("/")[1]) : "");
  const targets = lb.targetGroups.flatMap((g) => g.targets.map((t) => ({ g, t })));
  // Targets draining from a stopped service's group are leaving: the group reads as idle (as in tgInputs).
  const counts = (g: RawLb["targetGroups"][number]) => {
    const h = health.get(g.arn);
    const c = h
      ? { healthy: h.healthy, total: h.healthy + h.unhealthy + (h.initial ?? 0) + (h.draining ?? 0), draining: h.draining ?? 0 }
      : { healthy: g.targets.filter((t) => t.state === "healthy").length, total: g.targets.length, draining: g.targets.filter((t) => t.state === "draining").length };
    return desiredByTg.get(g.arn) === 0 && c.total === c.draining ? { healthy: 0, total: 0, draining: c.draining } : c;
  };
  const all = lb.targetGroups.map(counts).reduce((a, c) => ({ healthy: a.healthy + c.healthy, total: a.total + c.total }), { healthy: 0, total: 0 });
  const ruleCount = lb.listeners.reduce((a, l) => a + l.rules.length, 0);
  const traffic = perMin !== undefined ? rateStat(perMin) : undefined;
  return {
    key: "loadbalancer:alb", kind: "loadbalancer", env: env.id, id: "alb", name: "Load balancer", subtitle: lb.name, state: state.state, reasons: state.reasons, checkedAt, fetchedAt: checkedAt,
    readOnly: true, tabs: ["overview", "metrics"], actions: [],
    stats: [
      { label: "healthy targets", value: `${all.healthy}/${all.total}` },
      { label: ruleCount === 1 ? "rule" : "rules", value: String(ruleCount) },
      ...(traffic ? [traffic] : []),
    ],
    properties: [
      {
        title: "Load balancer",
        items: [
          { label: "State", value: lb.state, tone: lb.state === "active" ? "ok" : "warn" },
          { label: "Name", value: lb.name, mono: true },
          { label: "DNS name", value: lb.dns, mono: true, copy: true },
          { label: "Scheme / type", value: `${lb.scheme} · ${lb.type}` },
          { label: "Availability zones", value: lb.azs.join(", ") || "—" },
          { label: "Created", value: when(lb.createdAt) },
          ...(others ? [{ label: "Other load balancers", value: `${others} more in front of this environment's services (traffic totals include them)`, tone: "muted" as const }] : []),
        ],
      },
      {
        title: "Routing (listener rules, in priority order)",
        items: lb.listeners.flatMap((l) =>
          l.rules.map((r) => {
            const match = [...r.hosts.map((h) => `host ${h}`), ...r.paths.map((p) => `path ${p}`)].join(" + ") || "everything else";
            const to = r.action.includes("forward") ? `→ ${svcName(r.targetGroupArn)}${r.action.startsWith("authenticate") ? " (sign-in first)" : ""}` : r.action === "redirect" ? "→ redirect (HTTPS)" : r.action === "fixed-response" ? "→ fixed response" : `→ ${r.action}`;
            return { label: `${l.protocol} :${l.port} · ${r.priority === "default" ? "default" : `#${r.priority}`}`, value: `${match} ${to}`, mono: true };
          }),
        ),
      },
      {
        title: "Target groups",
        items: lb.targetGroups.map((g): PropertyItem => {
          const c = counts(g);
          const idle = c.total === 0 && desiredByTg.get(g.arn) === 0;
          return {
            label: `${g.name} → ${svcName(g.arn)}`,
            value: `${idle ? "no targets (service stopped)" : `${c.healthy}/${c.total} healthy`} · checks ${g.protocol ?? "HTTP"} ${g.healthPath ?? "/"} every ${g.healthInterval ?? "?"}s · ${g.healthyThreshold ?? "?"} up / ${g.unhealthyThreshold ?? "?"} down · expects ${g.matcher ?? "200"}`,
            tone: idle ? "muted" : c.total && c.healthy === c.total ? "ok" : "bad",
          };
        }),
      },
      {
        title: "Targets",
        items: targets.length
          ? targets.map(({ g, t }) => ({
              label: `${svcName(g.arn)} · ${t.id}${t.port ? `:${t.port}` : ""}${t.az ? ` (${t.az})` : ""}`,
              value: t.state === "healthy" ? "healthy" : `${t.state}${t.reason ? ` — ${t.reason}` : ""}${t.description ? `: ${t.description}` : ""}`,
              tone: t.state === "healthy" ? ("ok" as const) : t.state === "initial" || t.state === "draining" ? ("warn" as const) : ("bad" as const),
            }))
          : lb.targetGroups.map((g): PropertyItem => {
              const h = health.get(g.arn);
              const c = counts(g);
              const idle = c.total === 0 && desiredByTg.get(g.arn) === 0;
              return {
                label: svcName(g.arn),
                value: idle ? "no targets (service stopped)" : h ? `${h.healthy} healthy · ${h.unhealthy} unhealthy${h.initial ? ` · ${h.initial} registering` : ""}${h.draining ? ` · ${h.draining} draining` : ""}${h.reasons.length ? ` (${h.reasons.join(", ")})` : ""}` : "health unknown",
                tone: idle ? "muted" : h && h.unhealthy === 0 && h.healthy > 0 ? "ok" : "bad",
              };
            }),
      },
    ],
  };
}

// Topology: discovered resources + declared externals + the load balancer; edges from discovery (inferred + declared).
function topology(cat: Catalog | undefined, services: ResourceView[], infra: ResourceView[], lb: LbState | null, rates: { services: Record<string, number>; total?: number }) {
  const nodes: TopoNode[] = [];
  const has = new Set<string>();
  const add = (n: TopoNode) => {
    nodes.push(n);
    has.add(n.id);
  };
  for (const x of cat?.externals ?? []) add(x);
  if (lb) add({ id: "lb:alb", label: "Load balancer", sub: "ALB", kind: "loadbalancer", lane: 1, state: lb.state, note: lb.reasons.join(" · "), resourceKey: infra.some((r) => r.key === "loadbalancer:alb") ? "loadbalancer:alb" : undefined });
  for (const r of services) {
    const m = cat?.meta.get(r.id);
    const lane = cat?.ingress === r.key ? 1 : (m?.infra ?? r.infra) && /redis|valkey|memcache|postgres|mysql|mongo/i.test(r.id) ? 3 : 2;
    add({ id: r.key, label: r.name, sub: r.id, kind: r.kind, lane, state: r.state, resourceKey: r.key });
  }
  for (const r of infra) if (r.kind !== "box" && r.kind !== "loadbalancer") add({ id: r.key, label: r.name, sub: r.subtitle, kind: r.kind, lane: 3, state: r.state, resourceKey: r.key });
  const edges: TopoEdge[] = (cat?.edges ?? []).filter((e) => has.has(e.from) && has.has(e.to));
  // Something must reach the entry point: an internet-facing ALB gets an "Internet" source unless one was declared.
  const entry = lb ? "lb:alb" : cat?.ingress;
  if (entry && has.has(entry) && !edges.some((e) => e.to === entry) && (lb?.internet ?? true)) {
    add({ id: "ext:internet", label: "Internet", sub: "public traffic", kind: "external", lane: 0, note: "Public traffic reaching the environment's entry point." });
    edges.push({ id: `ext:internet>${entry}`, from: "ext:internet", to: entry, label: "HTTPS", kind: "http", source: lb ? "internet-facing load balancer" : "reverse proxy" });
  }
  for (const e of edges) {
    const svc = e.from === "lb:alb" && e.to.startsWith("service:") ? e.to.slice("service:".length) : undefined;
    const perMin = svc !== undefined ? (Object.hasOwn(rates.services, svc) ? rates.services[svc] : undefined) : e.to === "lb:alb" ? rates.total : undefined;
    if (perMin !== undefined) e.rate = { value: sig3(perMin), unit: "req/min" };
  }
  return { nodes, edges };
}

export interface OverviewOptions {
  light?: boolean; // states only: no metrics, commits, compare, autoscaling or operations (used by the background sampler)
}

// ---------- shared state (globalThis: the sampler runs in the instrumentation bundle, routes in another) ----------

type Transition0 = { env: EnvInfo; r: ResourceView; previous: State };
// An action as notify.ts and the live event stream see it; fired from onMutation for every mutate() caller.
type ActionEvent = {
  env: Pick<EnvInfo, "id" | "label" | "protected"> & { region?: string };
  target: string; action: string; user: string; reason?: string; result: "ok" | "error"; detail?: string;
  operationId?: string; outcome?: MutationEvent["state"];
};
interface SamplerState {
  startedAt: number;
  running: boolean;
  lastTickAt?: number;
  lastTickMs?: number;
  prunedAt?: number;
  timer?: ReturnType<typeof setTimeout>;
}
interface Shared {
  latest: Map<string, EnvOverview>;
  transitions: ((t: Transition0) => void)[];
  actions: ((e: ActionEvent) => void)[];
  sampled?: Map<string, number>; // env → when the sampler last read it (R21)
  spans?: Map<string, Span[]>; // env → when the sampler was observing it (persisted, for uptime after a restart)
  shortfall?: Map<string, number>; // "<env>/<service>" → first sight of running < desired without a rollout (R11)
  restoring?: Map<string, Promise<void>>; // env → its state history restored from the console DB (once per process)
  bridged?: boolean;
  sampler?: SamplerState;
}
const fresh = (): Shared => ({ latest: new Map(), transitions: [], actions: [] });
const shared: Shared = ((globalThis as { __consoleShared?: Shared }).__consoleShared ??= fresh());
const latest = shared.latest;
const sampled = (shared.sampled ??= new Map());
const spans = (shared.spans ??= new Map());
const shortfalls = (shared.shortfall ??= new Map());
const restoring = (shared.restoring ??= new Map());
export const latestOverview = (env: string) => latest.get(env);
// Subscribers get an unsubscribe function (the live event stream subscribes per connection). Removal replaces the
// array, so a broadcast already iterating the old one is never disturbed.
export const onTransition = (f: (t: Transition0) => void) => {
  shared.transitions.push(f);
  return () => void (shared.transitions = shared.transitions.filter((x) => x !== f));
};
export const onAction = (f: (e: ActionEvent) => void) => {
  shared.actions.push(f);
  return () => void (shared.actions = shared.actions.filter((x) => x !== f));
};

// Every finished mutation (console actions, provisioning, variables, map actions, CI re-runs …) reaches the action
// listeners once per process, whichever bundle loaded this module first. Integration saves and tickets (R10) are
// audited and recorded as operations but never posted to integrations as actions.
if (!shared.bridged) {
  shared.bridged = true;
  onMutation((e) => {
    if (/^(integration|ticket)\./.test(e.action)) return;
    const ev: ActionEvent = {
      env: { id: e.env?.id ?? "", label: e.env?.label ?? e.env?.id ?? "", protected: e.env?.protected ?? false, region: e.env?.region },
      target: e.target, action: e.action, user: e.actor.display, reason: e.reason, result: e.state === "succeeded" ? "ok" : "error", detail: e.detail,
      operationId: e.operationId, outcome: e.state,
    };
    for (const f of shared.actions) {
      try {
        f(ev);
      } catch {
        // listeners never break a change
      }
    }
  });
}

// When a service's shortfall began (R11); cleared when it is full again or a rollout runs (that has its own clock).
function shortfallSince(env: EnvInfo, s: RawService, seenAt: number): number | undefined {
  const k = `${env.id}/${s.name}`;
  const rollout = s.deployments.some((d) => d.rolloutState === "IN_PROGRESS");
  if (s.desired > 0 && s.running < s.desired && !rollout) {
    if (!shortfalls.has(k)) shortfalls.set(k, seenAt);
    return shortfalls.get(k);
  }
  shortfalls.delete(k);
  return undefined;
}

// Records a resource's state; a change is persisted to state_changes so uptime and "since" survive a restart.
function noteState(env: EnvInfo, key: string, state: State, t: number) {
  const k = `${env.id}/${key}`;
  const prev = latestState(k);
  record(k, state, t);
  if (prev === state || latestState(k) !== state) return;
  void getDb()
    .then((db) => db.run("INSERT INTO state_changes (id, env, rkey, state, at) VALUES (?, ?, ?, ?, ?)", [newId(), env.id, key, state, t]))
    .catch((e) => log(40, "state history: could not persist a transition", { env: env.id, key, err: errText(e) }));
}

// ---------- operations shown on the service cards (accepted → verified) ----------

interface OpRow {
  id: string;
  action: string;
  actor: string;
  env: string | null;
  region: string | null;
  targets: string;
  params: string | null;
  state: string;
  verify: string | null;
  error: string | null;
  created_at: number;
}

const parseJson = <T,>(s: string | null | undefined): T | undefined => {
  try {
    return s ? (JSON.parse(s) as T) : undefined;
  } catch {
    return undefined;
  }
};

// ECS operations on this env's services in the last 15 minutes, newest first, by service name.
async function recentOperations(env: EnvInfo, now: number): Promise<Map<string, OperationNote[]>> {
  const rows = await (await getDb()).all<OpRow>(
    `SELECT id, action, actor, env, region, targets, params, state, verify, error, created_at FROM operations WHERE state IN ('succeeded', 'outcome_unknown') AND created_at > ? AND region = ? AND ${VERIFIED_ACTION_SQL} ORDER BY created_at DESC LIMIT 100`,
    [now - 15 * 60_000, env.region],
  );
  const out = new Map<string, OperationNote[]>();
  for (const r of rows) {
    if (!VERIFIED_ACTION.test(r.action)) continue;
    for (const s of ecsServicesOf(parseJson<{ keys?: unknown }>(r.targets)?.keys)) {
      if (s.region !== env.region || s.cluster !== env.cluster) continue;
      const list = out.get(s.service) ?? [];
      list.push({
        id: r.id, action: r.action, actor: r.actor, at: Number(r.created_at),
        verification: r.state === "outcome_unknown" ? "unknown" : verificationOf(r.verify),
        ...(r.state === "outcome_unknown" || r.verify === "failed" ? { detail: r.error ?? undefined } : {}),
      });
      out.set(s.service, list);
    }
  }
  return out;
}

// The recent ECS operations on one service (services.get for agents: "accepted" until the sampler verifies them).
export async function operationsFor(env: EnvInfo, service: string): Promise<OperationNote[]> {
  return (await recentOperations(env, Date.now())).get(service) ?? [];
}

// ---------- overview ----------

export async function overview(envId: string, opts: OverviewOptions = {}): Promise<EnvOverview> {
  const now = Date.now();
  const env = await envInfo(envId);
  const cloud = await cloudFor(env);
  const catR = await settle(catalog(env.id));
  const cat = catR.ok ? catR.value : undefined;
  const ec2 = env.kind === "ec2" || env.kind === "mixed";
  const compose = env.kind === "compose"; // no ECS services: its apps are config workloads on one EC2 box
  const boxed = ec2 || compose;
  const [svcsR, hostsR, dbsR, cachesR, scalR, opsR] = await Promise.all([
    settle(servicesRaw(env)),
    boxed ? settle(hostsRaw(env)) : Promise.resolve(undefined),
    cat?.databases.length ? settle(dbsAll(env)) : Promise.resolve(undefined),
    cat?.caches.length ? settle(cachesAll(env)) : Promise.resolve(undefined),
    opts.light ? Promise.resolve(undefined) : settle(scalableOf(env)),
    opts.light ? Promise.resolve(undefined) : settle(recentOperations(env, now)),
  ]);
  const svcAll = svcsR.ok ? svcsR.value.value : [];
  const svcAt = svcsR.ok ? svcsR.value.at : now;
  const metas = new Map(await Promise.all(svcAll.map(async (s) => [s.name, await metaOf(env, s)] as const)));
  const svcList = svcAll.filter((s) => !metas.get(s.name)?.hidden);
  const hosts = hostsR?.ok ? hostsR.value.value : [];
  const dbIds = new Set(cat?.databases.map((d) => d.id) ?? []);
  const dbs = dbsR?.ok ? dbsR.value.value.filter((d) => dbIds.has(d.id)) : (cat?.databases ?? []);
  const cacheIds = new Set(cat?.caches.map((c) => c.id) ?? []);
  const caches = cachesR?.ok ? cachesR.value.value.filter((c) => cacheIds.has(c.id)) : (cat?.caches ?? []);
  const names = new Map([...metas.values()].map((m) => [m.id, m.name]));
  const notes: string[] = [];
  for (const [what, r] of [["catalog", catR], ["hosts", hostsR], ["databases", dbsR], ["caches", cachesR]] as const) if (r && !r.ok) notes.push(`${what}: ${r.error}`);

  // Services on EC2 capacity are "parked", not down, when the capacity itself is off.
  const box: Fetched<RawBox | null> | undefined = !boxed || !hostsR ? undefined : !hostsR.ok ? hostsR : { ok: true, value: hosts.length === 1 ? hosts[0] : hosts.find((h) => h.state === "running") ?? hosts[0] ?? null };

  const spark = opts.light
    ? ({ ok: false, error: "light" } as Fetched<Record<string, [number, number][]>>)
    : await settle(cached(`spark:${at(env)}`, 60_000, () => cloud.metrics(sparkSpecs(env, svcList, hosts, dbs), 60)).then((r) => r.value));
  const sparkOf = (id: string) => (spark.ok ? spark.value[id]?.map((p) => sig3(p[1])) : undefined);

  // Target health once per target group, for the tiles and the load balancer (F58).
  const tgs = [...new Set(svcList.flatMap((s) => s.targetGroupArns))];
  const th = tgs.length ? await settle(targetHealthOf(env, tgs)) : undefined;
  const healthByTg = new Map((th?.ok ? th.value.value : []).map((h) => [h.targetGroupArn, h]));

  const services = await Promise.all(
    svcList.map(async (raw, idx) => {
      const m = metas.get(raw.name)!;
      const runtime: Fetched<RawService> = { ok: true, value: raw };
      const probeR = await settle(probeFor(env, m));
      const targets = raw.targetGroupArns.length ? raw.targetGroupArns.map((a) => healthByTg.get(a)).filter((x): x is TargetHealthDetail => !!x) : undefined;
      const signals: Signals = {
        runtime,
        probe: !m.healthcheck ? undefined : probeR.ok ? probeR.value : { url: m.healthcheck, pass: false, consecutiveFailures: 1, error: probeR.error },
        targets: th?.ok ? targets : undefined,
        box: raw.launchType === "EC2" ? box : undefined,
        fetchedAt: svcAt,
      };
      const since = shortfallSince(env, raw, svcAt);
      let d = deriveState(signals, now, { shortfallSince: since });
      if (raw.targetGroupArns.length && th && !th.ok) d = { state: d.state === "UP" ? "UNKNOWN" : d.state, reasons: [...d.reasons, `load balancer: ${th.error}`] };
      const sha = raw.taskDef ? parseImage(raw.taskDef.image).sha : undefined;
      const [commit, behind] = opts.light ? [undefined, undefined] : await Promise.all([commitFor(m.repo, sha), behindBy(env, m.repo, sha)]);
      return serviceView(env, runtime, m, d, cat?.routes ?? [], names, {
        checkedAt: svcAt, probe: signals.probe, targets: signals.targets, commit, behind, spark: sparkOf(`s${idx}`), locked: held(ecsKey(env, raw.name)),
        autoscaling: raw.scalable ?? (scalR?.ok ? scalR.value.get(raw.name) : undefined), shortfallSince: since, operations: opsR?.ok ? opsR.value.get(raw.name) : undefined,
      });
    }),
  );
  if (compose) {
    const workloads = Object.entries(workloadsOf(consoleConfig().config, env.id));
    const hostsAt = hostsR?.ok ? hostsR.value.at : now;
    const views = await Promise.all(
      workloads.map(async ([id, w]) => {
        const p = w.healthcheck ? await settle(probe(w.healthcheck)) : undefined;
        const result = !p || !w.healthcheck ? undefined : p.ok ? p.value : { url: w.healthcheck, pass: false, consecutiveFailures: 1, error: p.error };
        return workloadView(env, id, w, deriveWorkloadState(box ?? { ok: true, value: null }, result), result, hostsAt);
      }),
    );
    services.push(...views);
  }
  if (!svcsR.ok) services.push({ key: "service:?", kind: "service", env: env.id, id: "?", name: "Services", subtitle: env.cluster, state: "UNKNOWN", reasons: [svcsR.error], checkedAt: now, stats: [], properties: [], actions: [], tabs: ["overview"], readOnly: true });
  services.sort((a, b) => Number(!!(metas.get(a.id)?.infra ?? a.infra)) - Number(!!(metas.get(b.id)?.infra ?? b.infra)) || a.name.localeCompare(b.name));

  const infra: View[] = [];
  const hostsAt = hostsR?.ok ? hostsR.value.at : now;
  // ECS placement (task → container instance → EC2 instance); hidden services' tasks count, their tiles aren't listed.
  const where = svcAll.map((s) => ({ s, p: placement(s), tile: svcList.includes(s) ? `service:${s.name}` : undefined }));
  const unread = where.filter((x) => x.s.launchType === "EC2" && x.p.unplaced);
  const tiles = (l: typeof where) => l.flatMap((x) => (x.tile ? [x.tile] : []));
  const onHost = (id: string): OnHost => {
    const here = where.filter((x) => x.p.on.has(id));
    const sum = (k: "running" | "starting") => here.reduce((a, x) => a + x.p.on.get(id)![k], 0);
    return {
      services: tiles(here), maybe: tiles(unread.filter((x) => !x.p.on.has(id))), running: sum("running"), starting: sum("starting"),
      unknown: unread.reduce((a, x) => a + x.p.unplaced, 0),
    };
  };
  const composeOn: OnHost = { services: services.map((s) => s.key), maybe: [], running: 0, starting: 0, unknown: 0 };
  hosts.forEach((h, i) => infra.push(hostView(env, h, hostsAt, compose ? composeOn : onHost(h.id), sparkOf(`h${i}`))));
  if (hostsR && !hostsR.ok) infra.push({ key: "box:?", kind: "box", env: env.id, id: "?", name: "EC2 hosts", subtitle: env.cluster || env.host || "", state: "UNKNOWN", reasons: [hostsR.error], checkedAt: now, stats: [], properties: [], actions: [], tabs: ["overview"], readOnly: true });
  const dbAt = dbsR?.ok ? dbsR.value.at : now;
  for (const d of dbs) {
    const v = dbView(env, d, dbAt, sparkOf(`d${dbs.indexOf(d)}`));
    const conn = sparkOf(`c${dbs.indexOf(d)}`)?.at(-1);
    if (conn !== undefined) v.stats = [...v.stats, { label: "conn", value: String(Math.round(conn)) }];
    if (dbsR && !dbsR.ok) v.reasons = [...v.reasons, `stale: ${dbsR.error}`];
    infra.push(v);
  }
  for (const c of caches) infra.push(cacheView(env, c, cachesR?.ok ? cachesR.value.at : now));

  // Load balancer: target groups rolled up with the desired counts of their services (F01: a parked service's empty
  // group is idle, not down), its listeners from lbConfig per ARN, traffic per own ALB (R22).
  let lb: LbState | null = null;
  let rates: { services: Record<string, number>; total?: number } = { services: {} };
  if (tgs.length) {
    const tglbR = await settle(tglbOf(env, tgs));
    const tglb = tglbR.ok ? tglbR.value : {};
    if (!tglbR.ok) notes.push(`load balancer lookup: ${tglbR.error}`);
    if (!th!.ok) {
      lb = { state: "UNKNOWN", reasons: [th!.error], internet: true };
      notes.push(`target health: ${th!.error}`);
    } else {
      const roll = lbRollup(svcList, th!.value.value);
      lb = { state: roll.state, reasons: [roll.reason], internet: true };
    }
    if (!opts.light) rates = await settle(traffic(env, cloud, svcList, tglb)).then((r) => (r.ok ? r.value : { services: {} }));
    const primary = primaryLb(tglb, tgs);
    const health = new Map<string, TargetHealthDetail>(healthByTg);
    let full: RawLb | undefined;
    let lbAt = now;
    if (primary) {
      const cfgR = await settle(lbConfigOf(env, primary));
      if (cfgR.ok) {
        const cfg = cfgR.value.value;
        // Every group on this load balancer is listed: the services' groups are read already, the others once (cached).
        const extra = cfg.targetGroups.map((g) => g.arn).filter((a) => !healthByTg.has(a));
        const more = extra.length ? await settle(targetHealthOf(env, extra)) : undefined;
        for (const h of more?.ok ? more.value.value : []) health.set(h.targetGroupArn, h);
        full = { ...cfg, targetGroups: cfg.targetGroups.map((g) => ({ ...g, targets: health.get(g.arn)?.targets ?? [] })) };
        lbAt = cfgR.value.at;
      } else notes.push(`load balancer: ${cfgR.error}`);
    }
    if (full) {
      lb.internet = full.scheme === "internet-facing";
      const svcByTg = new Map(svcList.flatMap((s) => s.targetGroupArns.map((a) => [a, s.name] as [string, string])));
      const desiredByTg = new Map<string, number>();
      for (const s of svcList) for (const a of new Set(s.targetGroupArns)) desiredByTg.set(a, (desiredByTg.get(a) ?? 0) + s.desired);
      const others = new Set(Object.values(tglb).filter((a) => a && a !== primary)).size;
      infra.unshift(lbView(env, full, lb, svcByTg, names, health, desiredByTg, rates.total, Math.min(lbAt, th?.ok ? th.value.at : now), others));
    }
  }

  // History: record every state (changes are persisted, after this process restored what an earlier one wrote);
  // attach uptime to full views.
  await restoreEnv(env);
  for (const r of [...services, ...infra]) noteState(env, r.key, r.state, now);
  if (!opts.light) for (const r of [...services, ...infra]) r.uptime = uptime(`${env.id}/${r.key}`, now);

  const summary = emptySummary();
  for (const r of [...services, ...infra]) summary[r.state]++;
  const oneHost = hosts.length === 1 ? hosts[0] : undefined;
  const freshness: Freshness = {
    observedAt: svcsR.ok ? svcAt : undefined,
    // Two sampler intervals: the services read can be up to ~30 s old when served (cache plus delivery); each tile
    // still turns UNKNOWN on its own fetchedAt after LIMITS.staleMs.
    staleAfterMs: 2 * SAMPLER_INTERVAL_MS,
    source: compose ? (cloud.kind === "mock" ? "simulated EC2 + health checks" : "EC2 + health checks") : cloud.kind === "mock" ? "simulated ECS" : "ECS",
    completeness: !svcsR.ok ? "unknown" : notes.length ? "partial" : "complete",
    ...(svcsR.ok ? {} : { error: svcsR.error, refreshFailedAt: now }),
    ...(notes.length ? { notes } : {}),
  };
  return {
    env: env.id,
    region: env.region,
    checkedAt: Math.min(svcAt, now),
    frame: compose
      ? { kind: "box", title: oneHost ? (oneHost.tags.Name ?? oneHost.id) : env.host ?? "EC2 box", subtitle: "docker compose on EC2", boxKey: oneHost ? `box:${oneHost.id}` : undefined }
      : ec2 && hosts.length
      ? { kind: "box", title: oneHost ? (oneHost.tags.Name ?? oneHost.id) : `${hosts.length} EC2 hosts`, subtitle: `ECS on EC2 · cluster ${env.cluster}`, boxKey: oneHost ? `box:${oneHost.id}` : undefined }
      : { kind: "fargate", title: "Fargate", subtitle: `ECS Fargate · cluster ${env.cluster}` },
    services,
    infra,
    summary,
    source: cloud.kind,
    topology: topology(cat, services, infra, lb, rates),
    freshness,
  };
}

// ALB requests per minute per service and for the env's load balancers (R22): each target group on its own ALB.
async function traffic(env: EnvInfo, cloud: Cloud, raw: RawService[], tglb: Record<string, string>) {
  const plan = trafficPlan(raw, tglb);
  if (!plan.specs.length) return { services: {} };
  const key = plan.specs.map((s) => s.dims.TargetGroup ?? s.dims.LoadBalancer).join(",");
  const data = (await cached(`rates:${at(env)}:${key}`, 60_000, () => cloud.metrics(plan.specs, 15))).value;
  return trafficRates(plan, data);
}

export const worstState = (o: EnvOverview): State =>
  [...o.services, ...o.infra].reduce<State>((w, r) => (STATE_RANK[r.state] < STATE_RANK[w] ? r.state : w), "UP");

// ---------- the background sampler ----------

export const SAMPLER_INTERVAL_MS = 30_000;
const SAMPLER_CONCURRENCY = 4;
const STATE_HISTORY_DAYS = 14;

// How fresh the sampler's view of an env is (R21): /api/envs and /api/issues mark it stale (worst UNKNOWN) when the
// sampler hasn't read it for samplerStaleIntervals intervals.
export function samplerStatus(envId: string, now = Date.now()): { sampledAt?: number; stale: boolean; reason?: string } {
  // A sampler started by an older copy of this module (before a restart) leaves only its overviews: their checkedAt.
  const sampledAt = sampled.get(envId) ?? latest.get(envId)?.checkedAt;
  const startedAt = shared.sampler?.startedAt ?? ((globalThis as { __consoleSampler?: unknown }).__consoleSampler ? sampledAt : undefined);
  const s = samplerStaleness({ sampledAt, startedAt, now, intervalMs: SAMPLER_INTERVAL_MS, intervals: LIMITS.samplerStaleIntervals });
  return { ...(sampledAt !== undefined ? { sampledAt } : {}), ...s };
}

export function samplerHealth(): { startedAt?: number; lastTickAt?: number; lastTickMs?: number; running: boolean } {
  const s = shared.sampler;
  return s ? { startedAt: s.startedAt, lastTickAt: s.lastTickAt, lastTickMs: s.lastTickMs, running: s.running } : { running: false };
}

// Background sampler: record states every 30 s so uptime reflects reality, not who had the page open. Light mode keeps
// it to describes and probes (no CloudWatch metrics, no GitHub). One tick at a time (re-armed when it ends), four
// environments at a time; failures are logged, never swallowed.
export function startSampler() {
  const g = globalThis as { __consoleSampler?: unknown };
  if (shared.sampler || g.__consoleSampler) return; // one per process (an older copy of this module used __consoleSampler)
  const st: SamplerState = { startedAt: Date.now(), running: false };
  shared.sampler = st;
  g.__consoleSampler = st;
  const tick = async () => {
    if (st.running) return;
    st.running = true;
    const t0 = Date.now();
    try {
      await sampleOnce(st);
    } catch (e) {
      log(50, "sampler: tick failed", { err: errText(e) });
    } finally {
      st.running = false;
      st.lastTickAt = Date.now();
      st.lastTickMs = st.lastTickAt - t0;
      st.timer = setTimeout(() => void tick(), SAMPLER_INTERVAL_MS);
      st.timer.unref?.();
    }
  };
  void tick();
}

async function sampleOnce(st: SamplerState) {
  let envs: EnvInfo[];
  try {
    envs = await listEnvs();
  } catch (e) {
    log(40, "sampler: listing environments failed", { err: errText(e) });
    return;
  }
  const queue = [...envs];
  await Promise.allSettled(
    Array.from({ length: Math.min(SAMPLER_CONCURRENCY, queue.length) }, async () => {
      for (let env = queue.shift(); env; env = queue.shift()) await sampleEnv(env);
    }),
  );
  // R23: hosts launched for a cluster that never joined it (provision.ts); never allowed to stop the sampler. Imported
  // when needed: provision.ts imports this module.
  try {
    await (await import("./provision.ts")).reconcileHostReservations(envs);
  } catch (e) {
    log(40, "sampler: host reservations not reconciled", { err: errText(e) });
  }
  await verifyOperations(envs).catch((e) => log(40, "sampler: operation verification failed", { err: errText(e) }));
  if (!st.prunedAt || Date.now() - st.prunedAt > 3600_000) {
    st.prunedAt = Date.now();
    await getDb()
      .then((db) => db.run("DELETE FROM state_changes WHERE at < ?", [Date.now() - STATE_HISTORY_DAYS * 86_400_000]))
      .catch((e) => log(40, "sampler: could not prune state history", { err: errText(e) }));
  }
}

async function sampleEnv(env: EnvInfo) {
  try {
    const o = await overview(env.id, { light: true });
    const t = Date.now();
    const prev = latest.get(env.id);
    latest.set(env.id, o);
    sampled.set(env.id, t);
    observed(env.id, t);
    if (!prev) return;
    for (const r of [...o.services, ...o.infra]) {
      const was = [...prev.services, ...prev.infra].find((x) => x.key === r.key)?.state;
      if (!was || was === r.state) continue;
      for (const f of shared.transitions) {
        try {
          f({ env, r, previous: was });
        } catch {
          // listeners never break the sampler
        }
      }
    }
  } catch (e) {
    log(40, "sampler: env overview failed", { env: env.id, err: errText(e) });
  }
}

// The spans during which the sampler observed an env, persisted so a restart can tell observed time from downtime.
function observed(envId: string, t: number) {
  const next = extendSpans(spans.get(envId) ?? [], t, LIMITS.samplerStaleIntervals * SAMPLER_INTERVAL_MS);
  spans.set(envId, next);
  void getDb()
    .then((db) => db.run("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", [`observed:${envId}`, JSON.stringify(next)]))
    .catch((e) => log(40, "state history: could not persist observed spans", { env: envId, err: errText(e) }));
}

// After a restart: rebuild the last two hours of an env's resource histories from state_changes and the spans the
// sampler observed it, once per process and before this process records anything for it (so its first sample isn't
// mistaken for a change).
function restoreEnv(env: EnvInfo): Promise<void> {
  let p = restoring.get(env.id);
  if (!p) {
    p = restoreHistory(env).catch((e) => log(40, "state history: could not restore", { env: env.id, err: errText(e) }));
    restoring.set(env.id, p);
  }
  return p;
}

async function restoreHistory(env: EnvInfo) {
  const db = await getDb();
  const now = Date.now();
  const start = now - WINDOW_MS;
  const saved = parseJson<Span[]>((await db.get<{ value: string }>("SELECT value FROM settings WHERE key = ?", [`observed:${env.id}`]))?.value);
  const envSpans = Array.isArray(saved) ? saved.filter((s) => Array.isArray(s) && s.length === 2 && s.every((n) => typeof n === "number")) : [];
  if (envSpans.length && !spans.has(env.id)) spans.set(env.id, envSpans);
  const rows = await db.all<{ rkey: string; state: State; at: number }>(
    `SELECT s.rkey, s.state, s.at FROM state_changes s WHERE s.env = ? AND (s.at >= ? OR s.at = (SELECT MAX(t.at) FROM state_changes t WHERE t.env = s.env AND t.rkey = s.rkey AND t.at < ?)) ORDER BY s.at`,
    [env.id, start, start],
  );
  const byKey = new Map<string, Transition[]>();
  for (const r of rows) byKey.set(r.rkey, [...(byKey.get(r.rkey) ?? []), [Number(r.at), r.state]]);
  for (const [rkey, list] of byKey) {
    const last = list[list.length - 1];
    restore(`${env.id}/${rkey}`, rebuild(list, envSpans, now), [last[1], last[0]]);
  }
}

// "AWS accepted" → verified (REVIEW): ECS operations of the last hour whose service is steady on the new state are
// marked verified; ones that failed a rollout or didn't settle within 15 minutes, failed.
async function verifyOperations(envs: EnvInfo[]) {
  const now = Date.now();
  const rows = await (await getDb()).all<OpRow>(
    `SELECT id, action, actor, env, region, targets, params, state, verify, error, created_at FROM operations WHERE state = 'succeeded' AND verify IS NULL AND created_at > ? AND ${VERIFIED_ACTION_SQL} ORDER BY created_at LIMIT 100`,
    [now - 3600_000],
  );
  for (const r of rows) {
    if (!VERIFIED_ACTION.test(r.action)) continue;
    const target = ecsServicesOf(parseJson<{ keys?: unknown }>(r.targets)?.keys)[0];
    const env = target && envs.find((e) => e.region === target.region && e.cluster === target.cluster);
    if (!target || !env) continue;
    const list = await settle(servicesRaw(env));
    const svc = list.ok ? list.value.value.find((s) => s.name === target.service) : null;
    const v = verifyOutcome({ action: r.action, createdAt: Number(r.created_at), params: parseJson<Record<string, unknown>>(r.params) }, svc, now);
    if (v.result === "verified") await markVerified(r.id, true);
    else if (v.result === "failed") await markVerified(r.id, false, v.detail);
  }
}

// Hosts launched for a cluster that never joined it (R23; b-provisioning marks the reservation failed): issues for
// /api/issues for a day.
export async function hostIssues(): Promise<{ env: string; cluster: string; id: string; reason: string; at: number }[]> {
  const rows = await (await getDb()).all<{ env: string; cluster: string; instance_ids: string; detail: string | null; created_at: number }>(
    "SELECT env, cluster, instance_ids, detail, created_at FROM host_reservations WHERE state = 'failed' AND created_at > ? ORDER BY created_at DESC LIMIT 50",
    [Date.now() - 86_400_000],
  );
  return rows.flatMap((r) => {
    const ids = parseJson<unknown>(r.instance_ids);
    const list = Array.isArray(ids) ? ids.filter((x): x is string => typeof x === "string") : [];
    return (list.length ? list : ["?"]).map((id) => ({ env: r.env, cluster: r.cluster, id, reason: r.detail || `host ${id} launched but never joined ${r.cluster}`, at: Number(r.created_at) }));
  });
}

// ---------- revisions / events / metrics ----------

export async function liveService(env: EnvInfo, service: string) {
  const live = (await servicesRaw(env)).value.find((s) => s.name === service);
  if (!live) throw new HttpError(404, `service "${service}" not found in ${env.cluster}`);
  return live;
}

// The containers whose images a revision needs: the essential ones (all, when ECS didn't say), else its main image.
const essentials = (r: RawRevision, main?: string) => {
  const list = r.containers?.length ? r.containers.filter((c) => c.essential !== false) : [];
  return list.length ? list : [{ name: main ?? "main", image: r.image }];
};

// Does a container's image exist (R24)? Only ECR can be asked: one DescribeImages per image ref (cached 60 s). An image
// in another account's registry isn't checked.
async function checkImage(env: EnvInfo, cloud: Cloud, c: { name: string; image: string }, revArn: string): Promise<ContainerCheck> {
  const p = parseImageRef(c.image);
  const ref = { container: c.name, image: c.image, ecr: p.ecr, repository: p.repository, tag: p.tag, digest: p.digest };
  if (!p.ecr) return { ref, found: null };
  const account = p.registry.split(".")[0];
  const own = parseArn(revArn)?.account;
  if (own && account !== own) return { ref, error: `registry of account ${account}, not checked` };
  try {
    const what = p.digest ? { digest: p.digest } : { tag: p.tag ?? "latest" };
    // Registry-qualified, so the repository is read in its own registry's region.
    const found = (await cached(`img:${p.registry}/${p.repository}:${p.digest ?? p.tag}`, 60_000, () => cloud.imageExists(`${p.registry}/${p.repository}`, what))).value;
    return { ref, found };
  } catch (e) {
    return { ref, error: errText(e) };
  }
}

// The digest each container of the live revision actually runs (most running tasks agree), from DescribeTasks (F68).
function liveDigests(live: RawService): Map<string, string> {
  const votes = new Map<string, Map<string, number>>();
  for (const t of live.tasks) {
    if (t.lastStatus !== "RUNNING" || t.taskDefinition !== live.taskDef?.arn || !t.imageDigests) continue;
    for (const [c, d] of Object.entries(t.imageDigests)) {
      const m = votes.get(c) ?? new Map<string, number>();
      m.set(d, (m.get(d) ?? 0) + 1);
      votes.set(c, m);
    }
  }
  return new Map([...votes].map(([c, m]) => [c, [...m].sort((a, b) => b[1] - a[1])[0][0]]));
}

// Did database migrations change between two commits (F07, R25)? true/false only from a complete comparison (ci.ts
// migrationsChanged, b-observability); anything else is "unknown" with the reason, and still needs the acknowledgement.
async function migrationsFor(repo: string, older: string, newer: string, paths: string[]): Promise<{ migrations: boolean | "unknown"; why?: string }> {
  try {
    const r = await migrationsChanged(repo, older, newer, paths);
    return r.changed === "unknown" ? { migrations: "unknown", why: r.why || "comparison incomplete" } : { migrations: r.changed };
  } catch (e) {
    return { migrations: "unknown", why: migrationsWhy(e) };
  }
}

async function revisionFacts(env: EnvInfo, live: RawService): Promise<RevisionView[]> {
  const cloud = await cloudFor(env);
  const m = await metaOf(env, live);
  const family = m.family ?? live.taskDef?.family;
  if (!family) return [];
  // A revision's image is its main container's: the one this service runs as (it may name its own — mainHint).
  const main = live.taskDef?.main;
  const revs = (await cached(`revs:${inRegion(family, env.region)}`, 15_000, () => cloud.revisions(family))).value
    .map((r) => ({ ...r, image: r.containers?.find((c) => c.name === main)?.image ?? r.image }));
  const liveArn = live.taskDef?.arn;
  const liveRev = revs.find((r) => r.arn === liveArn);
  const liveSha = liveRev ? parseImage(liveRev.image).sha : undefined;
  const liveMain = liveRev ? (essentials(liveRev, main).find((c) => c.name === main) ?? essentials(liveRev, main)[0]) : undefined;
  const digests = liveDigests(live);
  return Promise.all(
    revs.map(async (r): Promise<RevisionView> => {
      const img = parseImage(r.image);
      const containers = essentials(r, main);
      const checks = await Promise.all(containers.map((c) => checkImage(env, cloud, c, r.arn)));
      const verdict = imageVerdict(checks);
      const mainC = containers.find((c) => c.name === main) ?? containers[0];
      const mainRef = parseImageRef(mainC.image);
      const mainCheck = checks.find((c) => c.ref.container === mainC.name);
      const mt = mutableTag({
        tag: mainRef.tag, digestPinned: !!mainRef.digest, current: mainCheck?.found?.digest, live: digests.get(mainC.name),
        isLive: r.arn === liveArn, sameRefAsLive: !!liveMain && liveMain.image === mainC.image,
      });
      // Only a service with a repository and migration paths can be checked; there, a revision whose commit can't be
      // told (a tag without a git sha, on either side) is "unknown" — never a silent "no migrations" (R25).
      let mig: { migrations?: boolean | "unknown"; why?: string } = {};
      if (m.repo && m.migrations.length && r.arn !== liveArn) {
        if (!img.sha || !liveSha) mig = { migrations: "unknown", why: `the ${img.sha ? "live revision's" : "revision's"} image tag carries no git sha` };
        else if (img.sha !== liveSha) {
          const [older, newer] = r.revision < (liveRev?.revision ?? 0) ? [img.sha, liveSha] : [liveSha, img.sha];
          mig = await migrationsFor(m.repo, older, newer, m.migrations);
        }
      }
      return {
        arn: r.arn, revision: r.revision, image: r.image, tag: img.tag, sha: img.sha, registeredAt: r.registeredAt, live: r.arn === liveArn,
        imagePresent: verdict.present, imageCheck: verdict.imageCheck, ...(verdict.why ? { imageCheckWhy: verdict.why } : {}),
        ...((mainCheck?.found?.digest ?? mainRef.digest) ? { digest: mainCheck?.found?.digest ?? mainRef.digest } : {}),
        ...(mt.mutable ? { mutableTag: true, mutableTagWhy: mt.why } : {}),
        commit: await commitFor(m.repo, img.sha),
        ...(mig.migrations !== undefined ? { migrations: mig.migrations } : {}),
        ...(mig.why ? { migrationsWhy: mig.why } : {}),
      };
    }),
  );
}

export async function revisions(envId: string, service: string): Promise<RevisionView[]> {
  const env = await envInfo(envId);
  const live = await liveService(env, service);
  const out = await revisionFacts(env, live);
  // CI conclusion per sha, from the branch's recent runs (one call, ETag-cached).
  const repo = (await metaOf(env, live)).repo;
  if (repo && env.branch) {
    try {
      const runs = (await cached(`runs:${repo}:${env.branch}`, 15_000, async () => (await getCi()).runs(repo, env.branch, 50))).value;
      for (const r of out) {
        const mine = runs.filter((x) => x.sha === r.sha && !/deploy/i.test(x.workflow));
        if (!mine.length) continue;
        r.ci = mine.some((x) => x.status !== "completed") ? "in_progress" : mine.every((x) => x.conclusion === "success") ? "success" : mine.some((x) => x.conclusion === "failure") ? "failure" : "cancelled";
      }
    } catch {
      /* CI unknown is shown as unknown */
    }
  }
  return out;
}

// ECS service events, newest first: from the batched DescribeServices the overview already made (F11), else one call.
export async function events(envId: string, service: string) {
  const env = await envInfo(envId);
  const live = (await servicesRaw(env)).value.find((s) => s.name === service);
  if (live?.events) return live.events;
  const cloud = await cloudFor(env);
  return (await cached(`events:${at(env)}:${service}`, 5_000, () => cloud.events(env.cluster, service))).value;
}

// Minutes as the metrics routes and operations take them: whole minutes, 15 min to 7 days (F28: one cache key each).
// Above a day every series is read at 3600 s (periodFor), at most 168 points.
export const metricMinutes = (v: unknown) => Math.round(Math.min(Math.max(Number(v) || 60, 15), 7 * 24 * 60));

export async function metrics(envId: string, key: string, minutesIn: number): Promise<MetricSeries[]> {
  const env = await envInfo(envId);
  const cloud = await cloudFor(env);
  const minutes = metricMinutes(minutesIn);
  const [kind, ...rest] = key.split(":");
  const id = rest.join(":");
  let specs: (MetricSpec & { label: string; unit: string; scale?: number })[] = [];
  // Only resources this env owns — never an arbitrary name from the query string.
  if (kind === "service") {
    await liveService(env, id);
    specs = [
      { id: "cpu", label: "CPU", unit: "%", namespace: "AWS/ECS", metric: "CPUUtilization", dims: { ClusterName: env.cluster, ServiceName: id }, stat: "Average" },
      { id: "mem", label: "Memory", unit: "%", namespace: "AWS/ECS", metric: "MemoryUtilization", dims: { ClusterName: env.cluster, ServiceName: id }, stat: "Average" },
    ];
  } else if (kind === "box") {
    if (!(await hostsRaw(env)).value.some((h) => h.id === id)) throw new HttpError(404, `no host "${id}" in ${env.id}`);
    specs = [
      { id: "cpu", label: "CPU", unit: "%", namespace: "AWS/EC2", metric: "CPUUtilization", dims: { InstanceId: id }, stat: "Average" },
      { id: "credits", label: "CPU credit balance", unit: "credits", namespace: "AWS/EC2", metric: "CPUCreditBalance", dims: { InstanceId: id }, stat: "Average" },
    ];
  } else if (kind === "loadbalancer") {
    const tgs = [...new Set((await servicesRaw(env)).value.flatMap((s) => s.targetGroupArns))];
    const lbArn = tgs.length ? primaryLb(await tglbOf(env, tgs), tgs) : undefined;
    const LoadBalancer = lbArn ? lbDim(lbArn) : undefined;
    if (!LoadBalancer) return [];
    const d = { LoadBalancer };
    const period = periodFor(minutes);
    specs = [
      { id: "rps", label: "Requests per second", unit: "rps", namespace: "AWS/ApplicationELB", metric: "RequestCount", dims: d, stat: "Sum", scale: 1 / period },
      { id: "p50", label: "Latency p50", unit: "ms", namespace: "AWS/ApplicationELB", metric: "TargetResponseTime", dims: d, stat: "p50", scale: 1000 },
      { id: "p90", label: "Latency p90", unit: "ms", namespace: "AWS/ApplicationELB", metric: "TargetResponseTime", dims: d, stat: "p90", scale: 1000 },
      { id: "p99", label: "Latency p99", unit: "ms", namespace: "AWS/ApplicationELB", metric: "TargetResponseTime", dims: d, stat: "p99", scale: 1000 },
      { id: "t5xx", label: "Target 5xx", unit: "", namespace: "AWS/ApplicationELB", metric: "HTTPCode_Target_5XX_Count", dims: d, stat: "Sum" },
      { id: "e5xx", label: "Load balancer 5xx", unit: "", namespace: "AWS/ApplicationELB", metric: "HTTPCode_ELB_5XX_Count", dims: d, stat: "Sum" },
      { id: "conn", label: "Active connections", unit: "", namespace: "AWS/ApplicationELB", metric: "ActiveConnectionCount", dims: d, stat: "Sum" },
    ];
  } else if (kind === "database") {
    if (!(await catalog(env.id)).databases.some((d) => d.id === id)) throw new HttpError(404, `no database "${id}" in ${env.id}`);
    specs = [
      { id: "cpu", label: "CPU", unit: "%", namespace: "AWS/RDS", metric: "CPUUtilization", dims: { DBInstanceIdentifier: id }, stat: "Average" },
      { id: "conn", label: "Connections", unit: "", namespace: "AWS/RDS", metric: "DatabaseConnections", dims: { DBInstanceIdentifier: id }, stat: "Average" },
      { id: "free", label: "Free storage", unit: "GiB", namespace: "AWS/RDS", metric: "FreeStorageSpace", dims: { DBInstanceIdentifier: id }, stat: "Minimum", scale: 1 / GIB },
    ];
  } else throw new HttpError(400, "unknown resource kind");
  const data = (await cached(`metrics:${env.id}:${key}:${minutes}`, 60_000, () => cloud.metrics(specs, minutes))).value;
  // Three significant digits, so a quiet load balancer's 0.04 rps doesn't round to 0 (F09).
  return specs.map((s) => ({ id: s.id, label: s.label, unit: s.unit, points: (data[s.id] ?? []).map(([t, v]) => [t, sig3(v * (s.scale ?? 1))] as [number, number]) }));
}

// ---------- actions (every one through the mutation coordinator, R04) ----------

// Who a change runs as: an audit display string (routes, operations) or a full coordinator actor.
export type Who = string | MutationActor;
const actorOf = (who: Who, ip?: string): MutationActor => (typeof who === "string" ? { display: who, kind: "person", ...(ip ? { ip } : {}) } : { ...who, ...(ip && !who.ip ? { ip } : {}) });
const envRef = (env: EnvInfo) => ({ id: env.id, label: env.label, protected: env.protected, region: env.region });

// Restart / stop / start / switch. Under the service's canonical key: re-read the live service, run the guards on what
// AWS says now, record the intent, then call ECS. "AWS accepted" comes back with the operation id; the sampler marks it
// verified once the service is steady on the new state.
export async function act(envId: string, service: string, body: unknown, who: Who, ip?: string): Promise<ActionResult> {
  const parsed = parseActionBody(body);
  if (!parsed.ok) throw new HttpError(parsed.status, parsed.error);
  const req = parsed.req;
  const env = await envInfo(envId);
  const cloud = await cloudFor(env);
  try {
    const { operationId, result } = await mutate(
      { action: `services.${req.action}`, actor: actorOf(who, ip), env: envRef(env), target: service, keys: [ecsKey(env, service)], reason: req.reason, params: {} },
      async (h) => {
        invalidate(`svc:${at(env)}`);
        const live = await liveService(env, service);
        const m = await metaOf(env, live);
        let facts: RevisionFact[] | undefined;
        if (req.action === "switch") {
          if (m.family) invalidate(`revs:${inRegion(m.family, env.region)}`);
          facts = (await revisionFacts(env, live)).map((r) => ({ arn: r.arn, imagePresent: r.imagePresent, sha: r.sha, migrations: r.migrations, migrationsWhy: r.migrationsWhy }));
        }
        const ctx: ActionContext = {
          env: env.id, protected: env.protected, service, desired: live.desired, inProgress: live.deployments.some((d) => d.rolloutState === "IN_PROGRESS"),
          isSelf: m.self, locked: false, liveArn: live.taskDef?.arn, revisions: facts,
        };
        const check = checkAction(req, ctx);
        if (!check.ok) throw new HttpError(check.status, check.error);
        const startCount = req.action === "start" ? ((await recallDesired(env.id, service)) ?? 1) : undefined;
        const desiredAfter = req.action === "stop" ? 0 : startCount;
        await h.intent({ from: live.taskDef?.arn, to: req.revisionArn, desiredBefore: live.desired, desiredAfter });
        if (req.action === "stop") await rememberDesired(env.id, service, live.desired);
        const requestId = await cloud.updateService(env.cluster, service, {
          desired: desiredAfter,
          taskDefinition: req.action === "switch" ? req.revisionArn : undefined,
          force: req.action === "restart" ? true : undefined,
        });
        h.requestId(requestId);
        return requestId;
      },
    );
    return { ok: true, requestId: result, operationId, verification: "accepted" };
  } finally {
    invalidate(`svc:${at(env)}`);
    invalidate(`events:${at(env)}:${service}`);
  }
}

// Start/stop an EC2 container instance or an RDS instance that belongs to the env, under its canonical key.
export async function powerAct(envId: string, kind: unknown, id: unknown, action: unknown, confirm: unknown, who: Who, ip?: string): Promise<ActionResult> {
  if (action !== "start" && action !== "stop") throw new HttpError(400, "action must be start | stop");
  if (kind !== "host" && kind !== "database") throw new HttpError(400, "kind must be host | database");
  if (typeof id !== "string" || !id) throw new HttpError(400, "id is required");
  const env = await envInfo(envId);
  const cloud = await cloudFor(env);
  if (kind === "database" && !(await catalog(env.id)).databases.some((d) => d.id === id)) throw new HttpError(404, `no database "${id}" in ${env.id}`);
  const key = kind === "host" ? canonicalKey({ ec2: { region: env.region, id } }) : canonicalKey({ rds: { region: env.region, id } });
  try {
    const { operationId, result } = await mutate(
      { action: `${kind === "host" ? "hosts" : "databases"}.${action}`, actor: actorOf(who, ip), env: envRef(env), target: id, keys: [key], params: {} },
      async (h) => {
        let target: Parameters<typeof checkPower>[1];
        if (kind === "host") {
          invalidate(`hosts:${at(env)}`);
          const box = (await hostsRaw(env)).value.find((x) => x.id === id);
          target = { kind, state: box?.state, protected: env.protected, asg: box?.asg };
        } else {
          invalidate(`dbs:${inRegion("all", env.region)}`);
          const d = (await dbsAll(env)).value.find((x) => x.id === id);
          target = { kind, state: d?.status, protected: env.protected, aurora: d?.aurora };
        }
        const check = checkPower(action as BoxAction, target, confirm);
        if (!check.ok) throw new HttpError(check.status, check.error);
        await h.intent({ state: target.state });
        const requestId = await (kind === "host" ? cloud.hostPower(id, action as BoxAction) : cloud.dbPower(id, action as BoxAction));
        h.requestId(requestId);
        return requestId;
      },
    );
    return { ok: true, requestId: result, operationId, verification: "accepted" };
  } finally {
    invalidate(`hosts:${at(env)}`);
    invalidate(`dbs:${inRegion("all", env.region)}`);
    invalidate(`svc:${at(env)}`);
  }
}

// The audit log, with each verified-kind change's outcome (ECS changes, image deploys, scale and delete): one read of
// their operation rows per page. verify null = AWS accepted it and the sampler is still verifying.
export async function auditLog(limit: number, env?: string): Promise<AuditEntry[]> {
  const rows = await readAudit(limit, env);
  const ids = [...new Set(rows.filter((r) => r.phase === "result" && r.result === "ok" && r.operationId && VERIFIED_ACTION.test(r.action)).map((r) => r.operationId!))];
  if (!ids.length) return rows;
  const ops = await (await getDb())
    .all<{ id: string; verify: string | null; error: string | null }>(`SELECT id, verify, error FROM operations WHERE id IN (${ids.map(() => "?").join(", ")})`, ids)
    .catch(() => []);
  const byId = new Map(ops.map((o) => [o.id, o]));
  return rows.map((r) => {
    const o = r.phase === "result" && r.result === "ok" && r.operationId && VERIFIED_ACTION.test(r.action) ? byId.get(r.operationId) : undefined;
    if (!o) return r;
    const v = verificationOf(o.verify);
    return { ...r, verify: v === "accepted" ? null : v, ...(v === "failed" && o.error ? { verifyDetail: o.error } : {}) };
  });
}
