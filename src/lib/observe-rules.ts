// Pure rules behind the Metrics page (src/lib/server/observe.ts): which CloudWatch series each chart asks for, how Sum
// buckets become per-minute values, how load balancer traffic is attributed to services, deploy markers from ECS
// events and GitHub, release steps and the activity cap. No AWS calls here, so every rule is unit-tested.
import { albSpecs, elasticacheSpecs, perMinuteScale, periodFor, rdsSpecs, type ChartMetricSpec } from "./metric-specs.ts";
import type { ObsChart, ReleaseStep } from "./types.ts";

// ---------- windows and caching (F28, F60) ----------

// The windows the Metrics page offers. Any other value is snapped to the nearest, so a client can't mint a cache key
// (and a CloudWatch bill) per float.
export const RANGES = [60, 360, 1440, 10_080] as const;
export function snapMinutes(m: unknown): number {
  const v = Number(m);
  if (!Number.isFinite(v)) return 60;
  return RANGES.reduce((best, r) => (Math.abs(r - v) < Math.abs(best - v) ? r : best), RANGES[0] as number);
}

// Request performance re-scans the whole window: refresh it no more often than 1/100 of the window (at least 60 s).
export const perfTtlMs = (minutes: number) => Math.max(60_000, minutes * 600);

// ---------- numbers ----------

// Three significant digits below 100 (a quiet service's 0.04 req/min must not round to 0, F09), whole numbers above.
export function sig3(v: number): number {
  if (!Number.isFinite(v) || v === 0) return Number.isFinite(v) ? 0 : v;
  return Math.abs(v) >= 100 ? Math.round(v) : Number(v.toPrecision(3));
}

// Sum of several series over the union of their timestamps (a missing point counts as 0).
export function sumSeries(list: [number, number][][]): [number, number][] {
  const m = new Map<number, number>();
  for (const s of list) for (const [t, v] of s) m.set(t, (m.get(t) ?? 0) + v);
  return [...m.entries()].sort((a, b) => a[0] - b[0]);
}

// ---------- load balancer attribution (R22) ----------

export const tgDim = (arn: string) => arn.split(":").pop() ?? arn; // "targetgroup/<name>/<id>"
export const lbDim = (arn: string | undefined) => arn?.split(":loadbalancer/")[1]; // "app/<name>/<id>"
export const lbName = (dim: string) => dim.split("/")[1] ?? dim;

export interface TrafficTarget {
  service: string; // ECS service name
  label: string; // display name
  tgArn: string;
}

export interface Attributed extends TrafficTarget {
  tg: string; // TargetGroup dimension
  lb?: string; // its OWN load balancer's LoadBalancer dimension; undefined when the lookup failed
}

// Each target group with the load balancer in front of IT (not the env's first one), and the distinct load balancers.
export function attribute(targets: TrafficTarget[], tglb: Record<string, string>): { targets: Attributed[]; lbs: string[] } {
  const out = targets.map((t) => {
    const lb = Object.hasOwn(tglb, t.tgArn) ? lbDim(tglb[t.tgArn]) : undefined;
    return { ...t, tg: tgDim(t.tgArn), ...(lb ? { lb } : {}) };
  });
  return { targets: out, lbs: [...new Set(out.flatMap((t) => (t.lb ? [t.lb] : [])))].sort() };
}

// ---------- the Metrics page (observability) ----------

export interface ObsSpec extends Omit<ChartMetricSpec, "unit"> {
  id: string;
  sum?: string; // series sharing a `sum` key are added into one line with that label
}

export interface ObsInput {
  minutes: number;
  cluster: string;
  apps: { id: string; name: string }[];
  traffic: Attributed[];
  lbs: string[];
  databases: { id: string }[];
  caches: { id: string; memberClusters?: string[] }[];
  hosts: { id: string; name?: string }[];
}

const CHARTS: Record<string, { title: string; unit: string }> = {
  cpu: { title: "CPU", unit: "%" },
  mem: { title: "Memory", unit: "%" },
  req: { title: "Requests", unit: "/min" },
  "5xx": { title: "5xx responses", unit: "/min" },
  p95: { title: "Latency p95", unit: "ms" },
  dbcpu: { title: "CPU", unit: "%" },
  dbconn: { title: "Connections", unit: "" },
  dblat: { title: "Latency", unit: "ms" },
  dbiops: { title: "IOPS", unit: "IOPS" },
  dbmem: { title: "Freeable memory", unit: "MiB" },
  dbdisk: { title: "Free storage", unit: "GiB" },
  cachecpu: { title: "CPU", unit: "%" },
  cacheengine: { title: "Engine CPU", unit: "%" },
  cachemem: { title: "Memory used", unit: "%" },
  cacheconn: { title: "Connections", unit: "" },
  cacheevict: { title: "Evictions", unit: "/min" },
  boxcpu: { title: "CPU", unit: "%" },
  boxcred: { title: "CPU credits", unit: "" },
  boxnet: { title: "Network", unit: "MB/min" },
};

// Every series the page shows. Sum statistics are per CloudWatch bucket (1 min, 5 min or 1 h by window), so they are
// multiplied by 60 / period to be true per-minute values at every window (F03).
export function obsSpecs(o: ObsInput): ObsSpec[] {
  const perMin = perMinuteScale(periodFor(o.minutes));
  const out: ObsSpec[] = [];
  const add = (s: Omit<ObsSpec, "id">) => out.push({ ...s, id: `m${out.length}`, ...(s.stat === "Sum" ? { scale: (s.scale ?? 1) * perMin } : {}) });
  const fromChart = (s: ChartMetricSpec, extra: Partial<ObsSpec> = {}) => {
    const { unit: _unit, ...rest } = s; // a display unit, never sent to CloudWatch
    void _unit;
    add({ ...rest, ...extra });
  };

  for (const m of o.apps) {
    const dims = { ClusterName: o.cluster, ServiceName: m.id };
    add({ chart: "cpu", label: m.name, namespace: "AWS/ECS", metric: "CPUUtilization", dims, stat: "Average" });
    add({ chart: "mem", label: m.name, namespace: "AWS/ECS", metric: "MemoryUtilization", dims, stat: "Average" });
  }

  // Traffic per service from its target group on its OWN load balancer (R22). RequestCount, not RequestCountPerTarget
  // (that one is divided by the number of targets) — except when the load balancer couldn't be resolved: then the
  // per-target count is all CloudWatch can give for the target group alone, and the series says so.
  for (const t of o.traffic) {
    if (!t.lb) {
      add({ chart: "req", label: `${t.label} (per target)`, namespace: "AWS/ApplicationELB", metric: "RequestCountPerTarget", dims: { TargetGroup: t.tg }, stat: "Sum" });
      continue;
    }
    for (const s of albSpecs(t.tg, t.lb, t.label)) if (s.chart !== "rejected") fromChart(s, { label: t.label });
  }
  // The whole of each distinct load balancer, once: the total (no double counting when services share one) and the
  // requests it answered itself with 503 because no target was healthy.
  if (o.traffic.length > 1 || o.lbs.length > 1) {
    for (const lb of o.lbs) add({ chart: "req", label: "Total", sum: "Total", namespace: "AWS/ApplicationELB", metric: "RequestCount", dims: { LoadBalancer: lb }, stat: "Sum" });
  }
  for (const lb of o.lbs) {
    add({ chart: "5xx", label: "Rejected by load balancer (503)", sum: "Rejected by load balancer (503)", namespace: "AWS/ApplicationELB", metric: "HTTPCode_ELB_503_Count", dims: { LoadBalancer: lb }, stat: "Sum" });
  }

  const manyDb = o.databases.length > 1;
  for (const db of o.databases) for (const s of rdsSpecs(db.id, manyDb ? db.id : undefined)) fromChart(s);

  const nodes = o.caches.flatMap((c) => (c.memberClusters?.length ? c.memberClusters : [c.id]));
  for (const n of nodes) for (const s of elasticacheSpecs(n, nodes.length > 1 ? n : undefined)) fromChart(s);

  const multi = o.hosts.length > 1;
  for (const h of o.hosts) {
    const d = { InstanceId: h.id };
    const l = (x: string) => (multi ? `${h.name ?? h.id} ${x}` : x);
    add({ chart: "boxcpu", label: l("CPU"), namespace: "AWS/EC2", metric: "CPUUtilization", dims: d, stat: "Average" });
    add({ chart: "boxcred", label: l("Credit balance"), namespace: "AWS/EC2", metric: "CPUCreditBalance", dims: d, stat: "Average" });
    add({ chart: "boxnet", label: l("In"), namespace: "AWS/EC2", metric: "NetworkIn", dims: d, stat: "Sum", scale: 1 / 1e6 });
    add({ chart: "boxnet", label: l("Out"), namespace: "AWS/EC2", metric: "NetworkOut", dims: d, stat: "Sum", scale: 1 / 1e6 });
  }
  return out;
}

const slug = (s: string) => s.replace(/[^a-z0-9]/gi, "_").toLowerCase();

// One chart from the specs that belong to it: scaled, three significant digits, `sum` groups added up.
export function obsChart(id: string, specs: ObsSpec[], data: Record<string, [number, number][]>, stepSec: number, note?: string): ObsChart {
  const mine = specs.filter((s) => s.chart === id);
  const scaled = (s: ObsSpec) => (data[s.id] ?? []).map(([t, v]) => [t, v * (s.scale ?? 1)] as [number, number]);
  const lines: { label: string; points: [number, number][] }[] = [];
  const sums = new Map<string, [number, number][][]>();
  for (const s of mine) {
    if (s.sum) (sums.get(s.sum) ?? sums.set(s.sum, []).get(s.sum)!).push(scaled(s));
    else lines.push({ label: s.label, points: scaled(s) });
  }
  for (const [label, parts] of sums) lines.push({ label, points: sumSeries(parts) });
  const meta = CHARTS[id] ?? { title: id, unit: "" };
  return {
    id, title: meta.title, unit: meta.unit, stepSec, ...(note ? { note } : {}),
    series: lines.map((l) => ({ id: slug(`${id}-${l.label}`), label: l.label, points: l.points.map(([t, v]) => [t, sig3(v)] as [number, number]) })),
  };
}

export function obsSections(o: ObsInput, specs: ObsSpec[], data: Record<string, [number, number][]>): { title: string; charts: ObsChart[] }[] {
  const step = periodFor(o.minutes);
  const c = (id: string, note?: string) => obsChart(id, specs, data, step, note);
  const perTarget = o.traffic.filter((t) => !t.lb).map((t) => t.label);
  const sections: { title: string; charts: ObsChart[] }[] = [{ title: "Services", charts: [c("cpu"), c("mem")] }];
  if (o.traffic.length) {
    const note = perTarget.length ? `${perTarget.join(", ")}: load balancer unknown — requests per target, not the service's total` : undefined;
    sections.push({ title: "Traffic", charts: [c("req", note), c("5xx"), c("p95")] });
  } else {
    sections.push({ title: "Traffic", charts: [{ id: "req", title: "Requests", unit: "/min", stepSec: step, series: [], note: "No load balancer in this environment — see Request performance above (from access logs), or Logs → Insights." }] });
  }
  if (o.databases.length) sections.push({ title: o.databases.length > 1 ? "Databases" : "Database", charts: ["dbcpu", "dbconn", "dblat", "dbiops", "dbmem", "dbdisk"].map((id) => c(id)) });
  if (o.caches.length) sections.push({ title: "Cache", charts: ["cachecpu", "cacheengine", "cachemem", "cacheconn", "cacheevict"].map((id) => c(id)) });
  if (o.hosts.length) sections.push({ title: o.hosts.length > 1 ? "EC2 hosts" : "EC2 host", charts: [c("boxcpu"), c("boxcred"), c("boxnet")] });
  return sections;
}

// ---------- deploy markers (F12) ----------

export interface Marker {
  at: number;
  service: string;
  sha?: string;
  title: string;
  url?: string;
  source: "github" | "ecs";
  kind: "deploy" | "rollback";
}

const DEPLOY_DONE = /\(deployment ([^)\s]+)\) deployment completed/i;
const ROLLBACK = /rolling back|circuit breaker/i;
const ROLLBACK_TO = /rolling back to (?:deployment )?([\w/-]+)/i;

// ECS's own record of deployments: "(service api) (deployment ecs-svc/123) deployment completed." is a deploy;
// anything rolling back (the circuit breaker, a failed deployment) is a rollback. The rollback target's own
// "deployment completed" that follows is part of the rollback, not another deploy.
export function ecsMarkers(service: string, events: { id: string; at: number; message: string }[], since: number): Marker[] {
  const asc = [...events].filter((e) => e.at >= since).sort((a, b) => a.at - b.at);
  const rolledBackTo = new Set<string>(); // deployments a rollback named as its target
  let unnamedUntil = -Infinity; // a rollback that named no target: the next completion within 15 min is it finishing
  const out: Marker[] = [];
  for (const e of asc) {
    const msg = e.message.replace(/^\(service [^)]+\) /, "");
    if (ROLLBACK.test(msg)) {
      const to = ROLLBACK_TO.exec(msg)?.[1];
      if (to) rolledBackTo.add(to);
      else unnamedUntil = e.at + 15 * 60_000;
      if (out.some((m) => m.kind === "rollback" && e.at - m.at < 60_000)) continue; // one marker per rollback
      out.push({ at: e.at, service, title: `Rolled back · ${msg}`.slice(0, 200), source: "ecs", kind: "rollback" });
      continue;
    }
    const done = DEPLOY_DONE.exec(msg);
    if (!done) continue;
    if (rolledBackTo.delete(done[1])) continue;
    if (e.at <= unnamedUntil) {
      unnamedUntil = -Infinity;
      continue;
    }
    out.push({ at: e.at, service, title: "Deployment completed", source: "ecs", kind: "deploy" });
  }
  return out;
}

// A successful GitHub deploy run lends its commit, link and title to the ECS deploy of the same service within
// 10 minutes of it; one with no such ECS deploy (events unreadable, or already rotated out) is its own marker.
export function mergeMarkers(ecs: Marker[], runs: { at: number; service: string; sha: string; title: string; url: string }[], windowMs = 10 * 60_000): Marker[] {
  const out = ecs.map((m) => ({ ...m }));
  for (const r of [...runs].sort((a, b) => a.at - b.at)) {
    let best: Marker | undefined;
    for (const m of out) {
      if (m.source !== "ecs" || m.kind !== "deploy" || m.service !== r.service || m.sha || Math.abs(m.at - r.at) > windowMs) continue;
      if (!best || Math.abs(m.at - r.at) < Math.abs(best.at - r.at)) best = m;
    }
    if (best) Object.assign(best, { sha: r.sha, url: r.url, title: r.title });
    else out.push({ at: r.at, service: r.service, sha: r.sha, title: r.title, url: r.url, source: "github", kind: "deploy" });
  }
  return out.sort((a, b) => a.at - b.at);
}

// ---------- releases (F07, F08) ----------

// Two stages are in sync only when they run the same commit, or a comparison found nothing either way.
export const inSync = (s: Pick<ReleaseStep, "aheadBy" | "behindBy">, sameSha = false) => sameSha || (s.aheadBy === 0 && s.behindBy === 0);

export function releaseStep(
  from: string,
  to: string,
  cmp: { aheadBy: number; behindBy: number; commits: { sha: string; title: string; author: string; date: string }[] } | null | undefined,
  mig: { changed: boolean | "unknown"; why?: string },
): ReleaseStep {
  const step: ReleaseStep = { from, to, commits: [], migrations: mig.changed, ...(mig.why ? { migrationsWhy: mig.why } : {}) };
  if (cmp) {
    step.aheadBy = cmp.aheadBy;
    step.behindBy = cmp.behindBy; // a hotfix on `to` that `from` lacks: not "in sync" (F08)
    step.commits = cmp.commits.slice(-50).reverse(); // newest first
  }
  return step;
}

// ---------- activity (F11) ----------

// At most `cap` entries per service, counted after steady-state noise is dropped, newest kept.
export function capPerService<T extends { service?: string; at: number }>(items: T[], cap = 50): T[] {
  const count = new Map<string, number>();
  return [...items]
    .sort((a, b) => b.at - a.at)
    .filter((i) => {
      const k = i.service ?? "";
      const n = (count.get(k) ?? 0) + 1;
      count.set(k, n);
      return n <= cap;
    });
}

export const isSteady = (message: string) => /steady state/i.test(message);
