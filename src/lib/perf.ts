// Request performance (RPS, avg / p50 / p90 / p99 latency, 5xx rate) from either source, as one shape.
//  - behind an ALB: CloudWatch metrics (RequestCount, TargetResponseTime percentiles, HTTPCode_Target_5XX_Count and the
//    load balancer's own HTTPCode_ELB_503_Count)
//  - behind Caddy (no ALB): its JSON access logs via Logs Insights (duration, status, request.host per request)
import { periodFor } from "./metric-specs.ts";
import { sig3, sumSeries } from "./observe-rules.ts";
import type { ObsChart, PerfTiles, Performance } from "./types.ts";

export { periodFor };

export interface Bin {
  t: number;
  n: number; // requests in the bin that reached a target
  avg?: number; // ms
  p50?: number;
  p90?: number;
  p99?: number;
  e5: number; // 5xx responses from targets
  rej?: number; // requests the load balancer answered itself with 503 (no healthy target); "all" scope only
}

export type Scoped = Record<string, Bin[]>; // scope id ("all" or service) → bins in time order

export const binLabel = (periodSec: number) => (periodSec >= 3600 ? "1h" : periodSec >= 300 ? "5m" : "1m");

// Insights row timestamps look like "2026-09-25 18:35:00.000" (UTC).
const insightsTime = (s: string) => Date.parse(`${s.trim().replace(" ", "T")}Z`);
const num = (v: string | undefined) => (v === undefined || v === "" ? undefined : Number(v));

// Rows from: stats count(*) as n, avg(duration) as avg, pct(duration, 50) as p50, … by bin(X)[, request.host]
// plus a separate "status >= 500 | stats count(*) as e by bin(X)[, request.host]". Durations are seconds.
export function fromAccessLogs(
  byHost: Record<string, string>[],
  all: Record<string, string>[],
  errs: Record<string, string>[],
  hostToService: Record<string, string>,
  periodSec: number,
): Scoped {
  const bin = `bin(${binLabel(periodSec)})`;
  const errKey = (r: Record<string, string>) => `${insightsTime(r[bin])}|${r["request.host"] ?? "all"}`;
  const errMap = new Map<string, number>();
  for (const r of errs) {
    const k = errKey(r);
    errMap.set(k, (errMap.get(k) ?? 0) + (num(r.e) ?? 0));
  }
  const errAll = new Map<number, number>();
  for (const r of errs) errAll.set(insightsTime(r[bin]), (errAll.get(insightsTime(r[bin])) ?? 0) + (num(r.e) ?? 0));
  const ms = (v?: number) => (v === undefined || !Number.isFinite(v) ? undefined : Math.round(v * 1000 * 10) / 10);
  const toBin = (r: Record<string, string>, e5: number): Bin => ({
    t: insightsTime(r[bin]),
    n: num(r.n) ?? 0,
    avg: ms(num(r.avg)),
    p50: ms(num(r.p50)),
    p90: ms(num(r.p90)),
    p99: ms(num(r.p99)),
    e5,
  });
  const out: Scoped = { all: all.map((r) => toBin(r, errAll.get(insightsTime(r[bin])) ?? 0)) };
  for (const r of byHost) {
    const svc = hostToService[r["request.host"]] ?? r["request.host"] ?? "other"; // unmapped hosts become their own scope
    (out[svc] ??= []).push(toBin(r, errMap.get(errKey(r)) ?? 0));
  }
  for (const k of Object.keys(out)) out[k] = out[k].filter((b) => Number.isFinite(b.t)).sort((a, b) => a.t - b.t);
  return out;
}

export type Pts = [number, number][];
export interface AlbSeries {
  req: Pts;
  avg: Pts;
  p50: Pts;
  p90: Pts;
  p99: Pts;
  e5: Pts;
  rej?: Pts; // HTTPCode_ELB_503_Count on the load balancer
}

// Several load balancers as one "all services" scope (R22): requests, target 5xx and 503s add up; the mean latency is
// weighted by requests; a percentile can't be combined, so the worst load balancer's is shown.
export function mergeLbSeries(list: AlbSeries[]): AlbSeries {
  if (list.length === 1) return list[0];
  const req = sumSeries(list.map((s) => s.req));
  const total = new Map(req);
  const weighted = new Map<number, number>();
  for (const s of list) {
    const n = new Map(s.req);
    for (const [t, v] of s.avg) weighted.set(t, (weighted.get(t) ?? 0) + v * (n.get(t) ?? 0));
  }
  const avg: Pts = [...weighted.entries()].filter(([t]) => (total.get(t) ?? 0) > 0).map(([t, w]) => [t, w / total.get(t)!] as [number, number]).sort((a, b) => a[0] - b[0]);
  const worst = (k: "p50" | "p90" | "p99"): Pts => {
    const m = new Map<number, number>();
    for (const s of list) for (const [t, v] of s[k]) m.set(t, Math.max(m.get(t) ?? -Infinity, v));
    return [...m.entries()].sort((a, b) => a[0] - b[0]);
  };
  return { req, avg, p50: worst("p50"), p90: worst("p90"), p99: worst("p99"), e5: sumSeries(list.map((s) => s.e5)), rej: sumSeries(list.map((s) => s.rej ?? [])) };
}

// ALB: per scope, CloudWatch series keyed by metric. A bin is any timestamp seen in the requests, the 5xx or the 503
// series (F10: 503s during a full outage have no request datapoint), zero-filled at the period across the window up
// to the newest datapoint seen (CloudWatch publishes ALB metrics only for buckets with traffic; the newest bucket may
// simply not be reported yet, so the grid never runs past the data).
export function fromAlb(series: Record<string, AlbSeries>, window?: { start: number; stepSec: number }): Scoped {
  const out: Scoped = {};
  let newest: number | undefined;
  for (const s of Object.values(series)) for (const pts of [s.req, s.e5, s.rej ?? [], s.avg]) for (const [t] of pts) if (newest === undefined || t > newest) newest = t;
  for (const [scope, s] of Object.entries(series)) {
    const at = (pts: Pts) => new Map(pts.map(([t, v]) => [t, v]));
    const [req, avg, p50, p90, p99, e5, rej] = [at(s.req), at(s.avg), at(s.p50), at(s.p90), at(s.p99), at(s.e5), at(s.rej ?? [])];
    const times = new Set<number>([...req.keys(), ...e5.keys(), ...rej.keys()]);
    if (window && newest !== undefined && times.size) {
      const step = window.stepSec * 1000;
      const anchor = [...times].reduce((a, b) => Math.min(a, b));
      for (let t = anchor - Math.floor((anchor - window.start) / step) * step; t <= newest; t += step) times.add(t);
    }
    const ms = (v?: number) => (v === undefined ? undefined : Math.round(v * 1000 * 10) / 10); // seconds → ms
    out[scope] = [...times].sort((a, b) => a - b).map((t) => ({
      t, n: req.get(t) ?? 0, avg: ms(avg.get(t)), p50: ms(p50.get(t)), p90: ms(p90.get(t)), p99: ms(p99.get(t)), e5: e5.get(t) ?? 0,
      ...(s.rej ? { rej: rej.get(t) ?? 0 } : {}),
    }));
  }
  return out;
}

const r1 = (v: number) => Math.round(v * 10) / 10;

// Errors as a share of everything clients sent: target 5xx plus the load balancer's own 503s, over requests that
// reached a target plus those 503s (RequestCount leaves out what the load balancer rejected). A bucket with 5xx but no
// request count (the two series are published separately) counts the 5xx as its requests. At most 100 %.
export function errPct(e5: number, n: number, rej = 0): number | null {
  const all = Math.max(n, e5) + rej;
  return all > 0 ? Math.min(100, Math.round(((e5 + rej) / all) * 10000) / 100) : null;
}

// Tiles cover the newest ~5 minutes (or the newest bin when bins are larger).
export function tiles(bins: Bin[], periodSec: number): PerfTiles {
  if (!bins.length) return { rps: null, avg: null, p50: null, p90: null, p99: null, errPct: null, requests: null, errors5xx: null, rejected: null };
  const k = Math.max(1, Math.round(300 / periodSec));
  const recent = bins.slice(-k);
  const n = recent.reduce((a, b) => a + b.n, 0);
  const e = recent.reduce((a, b) => a + b.e5, 0);
  const rj = recent.reduce((a, b) => a + (b.rej ?? 0), 0);
  const last = [...recent].reverse().find((b) => b.p50 !== undefined);
  // Percentiles can't be averaged across bins; weighted mean is fine for avg, latest bin for percentiles.
  const wavg = n ? recent.reduce((a, b) => a + (b.avg ?? 0) * b.n, 0) / n : undefined;
  return {
    rps: sig3(n / (recent.length * periodSec)),
    avg: wavg !== undefined ? r1(wavg) : null,
    p50: last?.p50 ?? null,
    p90: last?.p90 ?? null,
    p99: last?.p99 ?? null,
    errPct: errPct(e, n, rj),
    requests: Math.round(bins.reduce((a, b) => a + b.n, 0)),
    errors5xx: Math.round(e),
    rejected: bins.some((b) => b.rej !== undefined) ? Math.round(rj) : null,
  };
}

export function toPerformance(env: Performance["env"], minutes: number, periodSec: number, source: Performance["source"], scoped: Scoped, labels: Record<string, string>, note?: string): Performance {
  const services = Object.keys(scoped).filter((k) => k !== "all" && scoped[k].length);
  const scopes = [{ id: "all", label: "All services" }, ...services.map((id) => ({ id, label: labels[id] ?? id }))];
  const rps: ObsChart = {
    id: "rps", title: "Requests per second", unit: "rps", stepSec: periodSec,
    series: [
      ...services.map((id) => ({ id: `rps-${id}`, label: labels[id] ?? id, points: scoped[id].map((b) => [b.t, sig3(b.n / periodSec)] as [number, number]) })),
      ...(scoped.all?.length ? [{ id: "rps-total", label: "Total", points: scoped.all.map((b) => [b.t, sig3(b.n / periodSec)] as [number, number]) }] : []),
    ],
  };
  const latency: Record<string, ObsChart> = {};
  for (const s of scopes) {
    const bins = scoped[s.id] ?? [];
    const line = (k: "avg" | "p50" | "p90" | "p99", label: string) => ({ id: `${s.id}-${k}`, label, points: bins.filter((b) => b[k] !== undefined).map((b) => [b.t, b[k]!] as [number, number]) });
    latency[s.id] = { id: `lat-${s.id}`, title: `Latency · ${s.label}`, unit: "ms", stepSec: periodSec, series: [line("p50", "p50"), line("p90", "p90"), line("p99", "p99"), line("avg", "avg")] };
  }
  const errors: ObsChart = {
    id: "err", title: "5xx error rate", unit: "%", stepSec: periodSec,
    series: [...services, "all"].filter((id) => scoped[id]?.length).map((id) => ({
      id: `err-${id}`, label: id === "all" ? "Total" : (labels[id] ?? id),
      points: scoped[id].map((b) => [b.t, errPct(b.e5, b.n, b.rej) ?? 0] as [number, number]),
    })),
  };
  const allBins = scoped.all ?? [];
  const rejectedTotal = allBins.reduce((a, b) => a + (b.rej ?? 0), 0);
  const rejected: ObsChart | undefined = allBins.some((b) => b.rej !== undefined)
    ? { id: "rejected", title: "Rejected by the load balancer (503)", unit: "/min", stepSec: periodSec, series: [{ id: "rejected-all", label: "503 · no healthy target", points: allBins.map((b) => [b.t, sig3(((b.rej ?? 0) * 60) / periodSec)] as [number, number]) }] }
    : undefined;
  // Per-service scopes can't see these: the load balancer answered before any target group was chosen.
  const rejNote = rejectedTotal > 0 ? `${Math.round(rejectedTotal).toLocaleString("en-US")} requests rejected by the load balancer (no healthy target)` : undefined;
  return {
    env, minutes, source, note: [note, rejNote].filter(Boolean).join(" · ") || undefined, scopes, rps, latency, errors, stepSec: periodSec,
    ...(rejected ? { rejected } : {}),
    tiles: Object.fromEntries(scopes.map((s) => [s.id, tiles(scoped[s.id] ?? [], periodSec)])),
  };
}
