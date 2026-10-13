// Env-wide observability (metrics with deploy markers), request performance, the activity feed, and the release
// chain (what each env runs vs the next env in promotion order). Everything is read from discovery. The rules (which
// series, per-minute scaling, attribution, markers, release steps) are pure, in ../observe-rules.ts and ../perf.ts.
import "server-only";
import { compareWhy, type DeployClass } from "../ci-rules.ts";
import type { Freshness } from "../freshness.ts";
import {
  attribute, capPerService, ecsMarkers, isSteady, mergeMarkers, obsSections, obsSpecs, perfTtlMs, releaseStep, snapMinutes, tgDim, type Marker, type TrafficTarget,
} from "../observe-rules.ts";
import { binLabel, fromAccessLogs, fromAlb, mergeLbSeries, periodFor, toPerformance, type AlbSeries, type Scoped } from "../perf.ts";
import type { ActivityItem, CiRun, EnvInfo, EnvName, InsightsResult, Observability, Performance, RawService, ReleaseStep, ReleaseView } from "../types.ts";
import { cached } from "./cache.ts";
import { deployClassifier, migrationsChanged } from "./ci.ts";
import { auditLog, events, overview, settle } from "./console.ts";
import { catalog, consoleConfig, envInfo, listEnvs, servicesOf, type Catalog } from "./discovery.ts";
import { errText } from "./errors.ts";
import { cloudFor, getCi, type Cloud, type MetricSpec } from "./sources.ts";

const apps = (cat: Catalog) => [...cat.meta.values()].filter((m) => !m.infra && !m.hidden);
const labels = (cat: Catalog) => Object.fromEntries([...cat.meta.values()].map((m) => [m.id, m.name]));
const DEPLOY_NAME = /deploy|release|publish/i;

// A run shown as a deploy of `env` (markers, activity): bound to it, or — for display only, never for safety (that is
// ci.ts) — a successful unbound workflow named like a deploy on its branch.
const deploysTo = (c: DeployClass, run: CiRun, env: EnvInfo) => (c.scope === "bound" ? c.env?.id === env.id : run.branch === env.branch && DEPLOY_NAME.test(run.workflow));

// A branch's newest 50 runs for markers and the activity feed, cached 15 s. Its own key: the CI page caches 25 per
// branch under `runs:<repo>:<branch>`, and a shared key would hand whichever list came first to the other.
const recentRuns = async (repo: string, branch: string) => {
  const ci = await getCi();
  return (await cached(`runs:${repo}:${branch}#50`, 15_000, () => ci.runs(repo, branch, 50))).value;
};

// Target group → load balancer ARN (F28: cached 10 min, ARNs don't move; the same key as console.ts, so one lookup).
async function tglbOf(env: EnvInfo, arns: string[]): Promise<Record<string, string>> {
  const c = await cloudFor(env);
  const sorted = [...new Set(arns)].sort();
  return (await cached(`tglb:${env.region}:${sorted.join(",")}`, 10 * 60_000, () => c.targetGroupLbs(sorted))).value;
}

// Every target group of every visible service (a service can have several, one per port), labelled by service.
function trafficTargets(cat: Catalog, svcs: RawService[]): TrafficTarget[] {
  return svcs.flatMap((s) => {
    const m = cat.meta.get(s.name);
    if (m?.hidden) return [];
    const name = m?.name ?? s.name;
    return s.targetGroupArns.map((tgArn) => ({ service: s.name, tgArn, label: s.targetGroupArns.length > 1 ? `${name} · ${tgDim(tgArn).split("/")[1]}` : name }));
  });
}

// The cache key carries the spec list's fingerprint: positional series ids must never meet another spec list's data.
const fingerprint = (specs: MetricSpec[]) => {
  let h = 0x811c9dc5;
  for (const ch of JSON.stringify(specs.map((s) => [s.namespace, s.metric, s.dims, s.stat]))) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193);
  return (h >>> 0).toString(36);
};

export async function observability(envId: EnvName, minutesIn: number): Promise<Observability & { freshness: Freshness }> {
  const minutes = snapMinutes(minutesIn);
  const env = await envInfo(envId);
  const cat = await catalog(env.id);
  const cloud = await cloudFor(env);
  const problems: string[] = [];
  const raw = await settle(servicesOf(env.cluster, env.region));
  if (!raw.ok) problems.push(`ECS services unreadable: ${raw.error}`);
  const targets = trafficTargets(cat, raw.ok ? raw.value : []);
  const tglb = targets.length ? await settle(tglbOf(env, targets.map((t) => t.tgArn))) : null;
  if (tglb && !tglb.ok) problems.push(`load balancer lookup failed: ${tglb.error}`);
  const a = attribute(targets, tglb?.ok ? tglb.value : {});

  const input = {
    minutes, cluster: env.cluster, apps: apps(cat).map((m) => ({ id: m.id, name: m.name })), traffic: a.targets, lbs: a.lbs,
    databases: cat.databases, caches: cat.caches, hosts: cat.hosts.map((h) => ({ id: h.id, name: h.tags.Name })),
  };
  const specs = obsSpecs(input);
  const r = await cached(`obs:${env.id}:${minutes}:${fingerprint(specs)}`, 60_000, () => cloud.metrics(specs, minutes));
  const sections = obsSections(input, specs, r.value);

  const { deploys, deploysNote } = await markers(env, cat, minutes);
  return {
    env: env.id, minutes, sections, deploys, ...(deploysNote ? { deploysNote } : {}),
    freshness: { observedAt: r.at, staleAfterMs: 3 * 60_000, source: "CloudWatch", completeness: problems.length ? "partial" : "complete", ...(problems.length ? { notes: problems } : {}) },
  };
}

// Deploy markers (F12): ECS's own deployment events per service, with a GitHub deploy run's commit and link merged
// in when one finished within 10 minutes. Whatever source is missing is said in deploysNote, never silently.
async function markers(env: EnvInfo, cat: Catalog, minutes: number): Promise<{ deploys: Marker[]; deploysNote?: string }> {
  const since = Date.now() - minutes * 60_000;
  const list = apps(cat);
  const notes: string[] = [];
  const evR = await Promise.all(list.map(async (m) => ({ m, r: await settle(events(env.id, m.id)) })));
  const ecs = evR.flatMap(({ m, r }) => (r.ok ? ecsMarkers(m.name, r.value, since) : []));
  const evBad = evR.filter((x) => !x.r.ok);
  if (evBad.length) notes.push(`ECS events unreadable for ${evBad.map((x) => x.m.name).join(", ")}`);

  const runs: { at: number; service: string; sha: string; title: string; url: string }[] = [];
  const repos = env.branch ? list.filter((m) => m.repo) : [];
  if (repos.length) {
    const classify = await settle(deployClassifier());
    const got = await Promise.all(repos.map(async (m) => ({ m, r: await settle(recentRuns(m.repo!, env.branch!)) })));
    const failed = got.find((x) => !x.r.ok);
    for (const { m, r } of got) {
      if (!r.ok || !classify.ok) continue;
      for (const run of r.value) {
        const at = Date.parse(run.updatedAt);
        if (run.conclusion === "success" && at >= since && deploysTo(classify.value(run), run, env)) runs.push({ at, service: m.name, sha: run.sha, title: run.title, url: run.url });
      }
    }
    if (failed && !failed.r.ok) {
      const why = /GITHUB_TOKEN is not set|not connected/i.test(failed.r.error) ? "GITHUB_TOKEN not set" : failed.r.error;
      notes.push(`GitHub deploy runs unavailable (${why}) — markers from ECS events only`);
    } else if (!classify.ok) notes.push(`GitHub deploy runs not classified (${classify.error}) — markers from ECS events only`);
  }
  return { deploys: mergeMarkers(ecs, runs), ...(notes.length ? { deploysNote: notes.join(" · ") } : {}) };
}

// ---------- request performance: RPS, avg/p50/p90/p99, 5xx rate ----------

async function insightsRun(cloud: Cloud, groups: string[], query: string, start: number, end: number): Promise<InsightsResult> {
  const id = await cloud.insightsStart(groups, query, start, end, 10_000);
  const deadline = Date.now() + 20_000;
  for (;;) {
    const r = await cloud.insightsResults(id);
    if (r.status === "Complete") return r;
    if (r.status !== "Running" && r.status !== "Scheduled") throw new Error(`Insights query ${r.status.toLowerCase()}`);
    if (Date.now() > deadline) throw new Error("Insights query still running after 20s");
    await new Promise((res) => setTimeout(res, 700));
  }
}

// A degraded answer (no load balancer found, a failed query): returned to the caller, never cached as data.
class Unavailable extends Error {
  perf: Performance;
  constructor(perf: Performance) {
    super(perf.note ?? "request performance unavailable");
    this.perf = perf;
  }
}

const SOURCE: Record<Performance["source"], string> = { alb: "CloudWatch (load balancer)", "access-logs": "Logs Insights (access logs)", none: "none" };

export async function performance(envId: EnvName, minutesIn: number): Promise<Performance & { freshness: Freshness }> {
  const minutes = snapMinutes(minutesIn);
  const period = periodFor(minutes);
  const env = await envInfo(envId);
  const ttl = perfTtlMs(minutes); // F60: a 7-day window is re-read every ~100 min, not every minute
  try {
    const r = await cached(`perf:${env.id}:${minutes}`, ttl, () => measure(env, minutes, period));
    return { ...r.value, freshness: { observedAt: r.at, staleAfterMs: ttl + 2 * 60_000, source: SOURCE[r.value.source], completeness: r.value.source === "none" ? "unknown" : "complete" } };
  } catch (e) {
    if (!(e instanceof Unavailable)) throw e;
    return { ...e.perf, freshness: { observedAt: Date.now(), staleAfterMs: ttl, source: "none", completeness: "unknown", error: e.perf.note } };
  }
}

async function measure(env: EnvInfo, minutes: number, period: number): Promise<Performance> {
  const cloud = await cloudFor(env);
  const cat = await catalog(env.id);
  const LABELS = labels(cat);
  const none = (note: string) => new Unavailable(toPerformance(env.id, minutes, period, "none", {}, LABELS, note));
  const raw = await settle(servicesOf(env.cluster, env.region));
  if (!raw.ok) throw none(`ECS services unreadable: ${raw.error}`);
  const targets = trafficTargets(cat, raw.value);

  // Behind a load balancer: it measures every request. Each service on its own load balancer; "all" = every distinct
  // load balancer at load balancer level, added up (R22).
  if (targets.length) {
    const tglb = await settle(tglbOf(env, targets.map((t) => t.tgArn)));
    if (!tglb.ok) throw none(`load balancer lookup failed: ${tglb.error}`);
    const a = attribute(targets, tglb.value);
    if (!a.lbs.length) throw none("load balancer lookup found no load balancer for these target groups");
    type K = "req" | "avg" | "p50" | "p90" | "p99" | "e5" | "rej";
    const specs: (MetricSpec & { scope: string; k: K })[] = [];
    const add = (scope: string, k: K, metric: string, dims: Record<string, string>, stat: MetricSpec["stat"]) =>
      specs.push({ id: `q${specs.length}`, scope, k, namespace: "AWS/ApplicationELB", metric, dims, stat });
    const latency = (scope: string, dims: Record<string, string>) => {
      add(scope, "req", "RequestCount", dims, "Sum");
      add(scope, "avg", "TargetResponseTime", dims, "Average");
      add(scope, "p50", "TargetResponseTime", dims, "p50");
      add(scope, "p90", "TargetResponseTime", dims, "p90");
      add(scope, "p99", "TargetResponseTime", dims, "p99");
      add(scope, "e5", "HTTPCode_Target_5XX_Count", dims, "Sum");
    };
    for (const lb of a.lbs) {
      latency(`lb:${lb}`, { LoadBalancer: lb });
      add(`lb:${lb}`, "rej", "HTTPCode_ELB_503_Count", { LoadBalancer: lb }, "Sum"); // answered by the ALB itself: no healthy target
    }
    for (const t of a.targets) if (t.lb) latency(`tg:${t.service}:${t.tg}`, { LoadBalancer: t.lb, TargetGroup: t.tg });
    const data = await cloud.metrics(specs, minutes);
    const bySeries = new Map<string, AlbSeries>();
    for (const sp of specs) {
      const s = bySeries.get(sp.scope) ?? { req: [], avg: [], p50: [], p90: [], p99: [], e5: [] };
      s[sp.k] = data[sp.id] ?? [];
      bySeries.set(sp.scope, s);
    }
    // A service with several target groups: add them up like load balancers.
    const series: Record<string, AlbSeries> = { all: mergeLbSeries(a.lbs.map((lb) => bySeries.get(`lb:${lb}`)!)) };
    for (const svc of new Set(a.targets.filter((t) => t.lb).map((t) => t.service))) {
      const parts = a.targets.filter((t) => t.service === svc && t.lb).map((t) => bySeries.get(`tg:${svc}:${t.tg}`)!);
      series[svc] = parts.length === 1 ? parts[0] : mergeLbSeries(parts);
    }
    const unknown = a.targets.filter((t) => !t.lb).map((t) => t.label);
    const scoped = fromAlb(series, { start: Date.now() - minutes * 60_000, stepSec: period });
    const notes = [a.lbs.length > 1 ? `measured by ${a.lbs.length} load balancers (CloudWatch); percentiles across them show the slowest` : "measured by the load balancer (CloudWatch)"];
    if (unknown.length) notes.push(`${unknown.join(", ")}: load balancer unknown, not shown per service`);
    return toPerformance(env.id, minutes, period, "alb", scoped, LABELS, notes.join(" · "));
  }

  // No load balancer: derive the same numbers from the reverse proxy's JSON access log (Caddy format).
  const proxy = cat.ingress?.startsWith("service:") ? cat.meta.get(cat.ingress.slice(8)) : undefined;
  if (!proxy?.logs) return toPerformance(env.id, minutes, period, "none", {}, LABELS, "no load balancer and no reverse proxy with CloudWatch logs in this environment");
  if (!/caddy/i.test(proxy.id) && !/caddy/i.test(proxy.ecrRepo ?? "") && !proxy.proxy) return toPerformance(env.id, minutes, period, "none", {}, LABELS, "request metrics need a load balancer or Caddy JSON access logs");
  const bin = binLabel(period);
  const end = Date.now();
  const start = end - minutes * 60_000;
  const stream = proxy.logs.prefix ? ` and @logStream like /^${proxy.logs.prefix.replace(/[/.]/g, "\\$&")}/` : "";
  const base = `filter logger like /http\\.log\\.access/${stream}`;
  const stats = "stats count(*) as n, avg(duration) as avg, pct(duration, 50) as p50, pct(duration, 90) as p90, pct(duration, 99) as p99";
  try {
    const g = [proxy.logs.group];
    const allQuery = () => insightsRun(cloud, g, `${base} | ${stats} by bin(${bin})`, start, end);
    // One host answering (the usual small setup): its rows ARE the total, so the separate "all" scan is skipped (F60).
    const [byHost, errs, early] = await Promise.all([
      insightsRun(cloud, g, `${base} | ${stats} by bin(${bin}), request.host`, start, end),
      insightsRun(cloud, g, `${base} and status >= 500 | stats count(*) as e by bin(${bin}), request.host`, start, end),
      cat.routes.length > 1 ? allQuery() : Promise.resolve(null),
    ]);
    const hosts = new Set(byHost.rows.map((r) => r["request.host"]));
    const all = early ?? (hosts.size <= 1 ? { ...byHost, rows: byHost.rows.map(({ "request.host": _h, ...rest }) => (void _h, rest)) } : await allQuery());
    const scoped: Scoped = fromAccessLogs(byHost.rows, all.rows, errs.rows, Object.fromEntries(cat.routes.map((r) => [r.host, r.service])), period);
    if (!all.rows.length) return toPerformance(env.id, minutes, period, "none", {}, LABELS, `no access-log lines from ${proxy.name} — enable Caddy's JSON access log (log { format json })`);
    return toPerformance(env.id, minutes, period, "access-logs", scoped, LABELS, `from ${proxy.name} access logs via Logs Insights`);
  } catch (e) {
    throw none(`access-log query failed: ${errText(e)}`);
  }
}

// ---------- activity ----------

export async function activity(envId: EnvName): Promise<ActivityItem[]> {
  const env = await envInfo(envId);
  const cat = await catalog(env.id);
  const items: ActivityItem[] = [];
  const repos = env.branch ? apps(cat).filter((m) => m.repo) : [];
  const [ciR, evR, auR, cls] = await Promise.all([
    Promise.all(repos.map((m) => settle(recentRuns(m.repo!, env.branch!).then((runs) => ({ m, runs }))))),
    Promise.all(apps(cat).map((m) => settle(events(env.id, m.id).then((ev) => ({ m, ev }))))),
    settle(auditLog(300, env.id)),
    repos.length ? settle(deployClassifier()) : Promise.resolve(null),
  ]);
  for (const r of ciR) {
    if (!r.ok) continue;
    for (const run of r.value.runs) {
      const done = run.status === "completed";
      const deploy = cls?.ok ? deploysTo(cls.value(run), run, env) : DEPLOY_NAME.test(run.workflow);
      items.push({
        id: `ci-${run.id}-${run.attempt}`, at: Date.parse(run.createdAt), kind: deploy ? "deploy" : "ci", env: env.id, service: r.value.m.name,
        tone: !done ? "info" : run.conclusion === "success" ? "ok" : run.conclusion === "failure" ? "bad" : "warn",
        title: `${deploy ? "Deploy" : run.workflow} ${done ? run.conclusion : run.status.replace("_", " ")}`,
        detail: `${run.sha.slice(0, 7)} · ${run.title}`, url: run.url, user: run.actor,
      });
    }
  }
  // ECS keeps up to 100 events per service; steady-state noise is dropped first, then each service keeps its newest 50 (F11).
  const ecs: ActivityItem[] = [];
  for (const r of evR) {
    if (!r.ok) continue;
    for (const e of r.value.ev) {
      if (isSteady(e.message)) continue;
      const bad = /fail|unable|unhealthy|rolling back|stopped .* essential/i.test(e.message);
      ecs.push({ id: `ecs-${e.id}`, at: e.at, kind: "ecs", env: env.id, service: r.value.m.name, tone: bad ? "bad" : /completed/i.test(e.message) ? "ok" : "info", title: bad ? "ECS problem" : "ECS", detail: e.message.replace(/^\(service [^)]+\) /, "") });
    }
  }
  items.push(...capPerService(ecs, 50));
  if (auR.ok) {
    for (const a of auR.value) {
      if (a.phase !== "result") continue;
      items.push({ id: `au-${a.at}-${a.target}-${a.action}`, at: a.at, kind: "action", env: env.id, service: cat.meta.get(a.target)?.name ?? a.target, tone: a.result === "ok" ? "ok" : "bad", title: `${a.action} ${a.result}`, detail: a.reason ?? a.detail, user: a.user });
    }
  }
  return items.sort((a, b) => b.at - a.at).slice(0, 250);
}

// ---------- releases ----------

// Promotion chain per service: envs where it runs, in order, and what each next env would receive.
export async function releases(): Promise<ReleaseView[]> {
  const envs = await listEnvs();
  const overviews = new Map(await Promise.all(envs.map(async (e) => [e.id, await settle(overview(e.id, { light: true }))] as const)));
  const cats = new Map(await Promise.all(envs.map(async (e) => [e.id, await settle(catalog(e.id))] as const)));
  const ci = await getCi();
  const workloads = Object.values(consoleConfig().config.workloads ?? {});
  const rev = (v?: { properties: { items: { label: string; value: string }[] }[] }) => {
    const td = v?.properties.flatMap((g) => g.items).find((i) => i.label === "Task definition")?.value;
    return td ? Number(td.split(":").pop()) : undefined;
  };
  // One row per app service that has a repo, across every env it appears in.
  const services = new Map<string, { name: string; repo: string; migrations: string[] }>();
  for (const e of envs) {
    const c = cats.get(e.id);
    if (!c?.ok) continue;
    for (const m of apps(c.value)) if (m.repo && !m.self && !services.has(m.id)) services.set(m.id, { name: m.name, repo: m.repo, migrations: m.migrations });
  }
  const out: ReleaseView[] = [];
  for (const [id, svc] of services) {
    const stages = envs.flatMap((e: EnvInfo) => {
      const o = overviews.get(e.id);
      const v = o?.ok ? o.value.services.find((x) => x.id === id) : undefined;
      return v ? [{ env: e.id, label: e.label, protected: e.protected, sha: v.sha, revision: rev(v), state: v.state }] : [];
    });
    const steps: ReleaseStep[] = [];
    for (let i = 0; i + 1 < stages.length; i++) {
      const a = stages[i], b = stages[i + 1];
      let step: ReleaseStep;
      if (a.sha && b.sha && a.sha !== b.sha) {
        // What `b` would get from `a`: base = b's commit, head = a's (ahead = new to b, behind = only on b).
        try {
          const cmp = (await cached(`cmp:${svc.repo}:${b.sha}:${a.sha}`, 10 * 60_000, () => ci.compare(svc.repo, b.sha!, a.sha!))).value;
          step = releaseStep(a.env, b.env, cmp, cmp ? await migrationsChanged(svc.repo, b.sha, a.sha, svc.migrations) : { changed: "unknown", why: "compare failed" });
        } catch (e) {
          step = releaseStep(a.env, b.env, null, { changed: "unknown", why: compareWhy(e) });
          step.note = `compare failed: ${errText(e)}`;
        }
        step.compareUrl = `https://github.com/${svc.repo}/compare/${b.sha}...${a.sha}`;
      } else if (a.sha && a.sha === b.sha) {
        step = { ...releaseStep(a.env, b.env, { aheadBy: 0, behindBy: 0, commits: [] }, { changed: false }) };
      } else {
        step = releaseStep(a.env, b.env, null, { changed: "unknown", why: "commit unknown (image tag has no git sha)" });
        step.note = "commit unknown (image tag has no git sha)";
      }
      steps.push(step);
    }
    // F05: the same repo also runs outside ECS as a declared workload (console.config.json `workloads`).
    const elsewhere = workloads.filter((w) => w.repo === svc.repo && !stages.some((s) => s.env === w.env));
    const where = (w: (typeof workloads)[number]) => (w.env ? (envs.find((e) => e.id === w.env)?.label ?? w.env) : w.name);
    const note = elsewhere.length
      ? `ECS: ${stages.map((s) => s.label).join(", ") || "no environment"} only — ${[...new Set(elsewhere.map(where))].join(", ")} runs as a declared workload (see the cloud map)`
      : stages.length < 2 ? `runs only in ${stages[0]?.label ?? "no environment"}` : undefined;
    out.push({ service: id, name: svc.name, repo: svc.repo, stages, steps, ...(note ? { note } : {}) });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
