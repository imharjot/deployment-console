import { test } from "node:test";
import assert from "node:assert/strict";
import { binLabel, errPct, fromAccessLogs, fromAlb, mergeLbSeries, periodFor, tiles, toPerformance, type AlbSeries } from "./perf.ts";

const HOSTS = { "api.staging.acme.dev": "api", "jobs.staging.acme.dev": "worker" };
const row = (t: string, host: string | null, n: number, avg: number, p50: number, p90: number, p99: number) => ({
  "bin(1m)": t, ...(host ? { "request.host": host } : {}), n: String(n), avg: String(avg), p50: String(p50), p90: String(p90), p99: String(p99),
});

test("period and bin sizes follow the window", () => {
  assert.deepEqual([periodFor(60), periodFor(360), periodFor(10080)], [60, 300, 3600]);
  assert.deepEqual([binLabel(60), binLabel(300), binLabel(3600)], ["1m", "5m", "1h"]);
});

test("access-log rows → per-service bins in ms, with 5xx joined by bin and host", () => {
  const s = fromAccessLogs(
    [row("2026-09-25 18:01:00.000", "api.staging.acme.dev", 120, 0.05, 0.03, 0.09, 0.4), row("2026-09-25 18:00:00.000", "api.staging.acme.dev", 60, 0.04, 0.02, 0.08, 0.3), row("2026-09-25 18:00:00.000", "weird.host", 5, 0.01, 0.01, 0.01, 0.01)],
    [row("2026-09-25 18:00:00.000", null, 65, 0.04, 0.02, 0.08, 0.3)],
    [{ "bin(1m)": "2026-09-25 18:00:00.000", "request.host": "api.staging.acme.dev", e: "3" }],
    HOSTS,
    60,
  );
  assert.equal(s["api"].length, 2);
  assert.ok(s["api"][0].t < s["api"][1].t, "sorted by time");
  assert.equal(s["api"][0].e5, 3);
  assert.equal(s["api"][1].p99, 400);
  assert.equal(s["weird.host"].length, 1, "unmapped hosts are kept as their own scope");
  assert.equal(s.all[0].e5, 3);
});

test("ALB series → bins; seconds become ms; missing 5xx is zero", () => {
  const t = [1000, 61000];
  const s = fromAlb({ all: { req: [[t[0], 600], [t[1], 1200]], avg: [[t[0], 0.05]], p50: [[t[0], 0.03]], p90: [[t[0], 0.08]], p99: [[t[0], 0.25]], e5: [[t[1], 12]] } });
  assert.deepEqual(s.all[0], { t: 1000, n: 600, avg: 50, p50: 30, p90: 80, p99: 250, e5: 0 });
  assert.equal(s.all[1].e5, 12);
  assert.equal(s.all[1].p99, undefined);
});

test("tiles: RPS over ~5 min, weighted avg, latest percentiles, error %", () => {
  const bins = Array.from({ length: 10 }, (_, i) => ({ t: i * 60_000, n: 600, avg: i < 5 ? 100 : 50, p50: 20 + i, p90: 80, p99: 300, e5: i >= 5 ? 6 : 0 }));
  const x = tiles(bins, 60);
  assert.equal(x.rps, 10);
  assert.equal(x.avg, 50);
  assert.equal(x.p50, 29);
  assert.equal(x.errPct, 1);
  assert.equal(x.requests, 6000);
  assert.equal(x.errors5xx, 30);
  assert.equal(x.rejected, null, "no 503 series: unknown, not zero");
  assert.deepEqual(tiles([], 60), { rps: null, avg: null, p50: null, p90: null, p99: null, errPct: null, requests: null, errors5xx: null, rejected: null });
});

test("toPerformance builds scopes, RPS per service + total, latency and error charts", () => {
  const bins = [{ t: 0, n: 120, avg: 40, p50: 20, p90: 70, p99: 200, e5: 6 }];
  const p = toPerformance("staging", 60, 60, "access-logs", { all: bins, "api": bins }, { "api": "Storefront API" });
  assert.deepEqual(p.scopes.map((s) => s.id), ["all", "api"]);
  assert.deepEqual(p.rps.series.map((s) => s.label), ["Storefront API", "Total"]);
  assert.equal(p.rps.series[0].points[0][1], 2);
  assert.deepEqual(p.latency["api"].series.map((s) => s.label), ["p50", "p90", "p99", "avg"]);
  assert.equal(p.errors.series[0].points[0][1], 5);
});

const none = (): AlbSeries => ({ req: [], avg: [], p50: [], p90: [], p99: [], e5: [], rej: [] });
const MIN = 60_000;

test("F10: 5xx timestamps missing from the requests are still bins, and the window is zero-filled up to the newest data", () => {
  const s = fromAlb({ all: { ...none(), req: [[2 * MIN, 600]], e5: [[3 * MIN, 12]], rej: [[3 * MIN, 30]] } }, { start: 0, stepSec: 60 });
  assert.deepEqual(s.all.map((b) => [b.t / MIN, b.n, b.e5, b.rej]), [[0, 0, 0, 0], [1, 0, 0, 0], [2, 600, 0, 0], [3, 0, 12, 30]]);
  assert.equal(errPct(s.all[3].e5, s.all[3].n, s.all[3].rej), 100, "nothing reached a target: 100 %, not 0 % or —");
  // Without a window only the timestamps seen are bins (the access-log path and older callers).
  assert.equal(fromAlb({ x: { ...none(), req: [[0, 1]], e5: [[5 * MIN, 1]] } }).x.length, 2);
});

test("F10: the load balancer's own 503s count in the numerator and the denominator (16,222 / 13,764 → 45.9 %)", () => {
  assert.equal(errPct(0, 16_222, 13_764), 45.9);
  assert.equal(errPct(0, 0, 50), 100);
  assert.equal(errPct(5, 0, 0), 100, "clamped");
  assert.equal(errPct(0, 0, 0), null);
  const bins = [{ t: 0, n: 16_222, e5: 0, rej: 13_764 }];
  const p = toPerformance("production", 60, 300, "alb", { all: bins, api: [{ t: 0, n: 16_222, e5: 0 }] }, { api: "API" });
  assert.equal(p.tiles.all.errPct, 45.9);
  assert.equal(p.tiles.all.rejected, 13_764);
  assert.equal(p.tiles.api.rejected, null, "a service scope can't see what the load balancer rejected");
  assert.equal(p.errors.series.find((x) => x.id === "err-all")?.points[0][1], 45.9);
  assert.match(p.note ?? "", /13,764 requests rejected by the load balancer \(no healthy target\)/);
  assert.equal(p.rejected?.series[0].points[0][1], 2753, "per minute: 13,764 in a 5-minute bucket");
  assert.equal(p.stepSec, 300);
  assert.equal(p.rps.stepSec, 300);
});

test("F09: RPS keeps three significant digits instead of rounding a quiet service to 0", () => {
  const p = toPerformance("staging", 60, 60, "alb", { all: [{ t: 0, n: 3, e5: 0 }, { t: MIN, n: 2, e5: 0 }] }, {});
  assert.deepEqual(p.rps.series[0].points.map((x) => x[1]), [0.05, 0.0333]);
  assert.equal(tiles([{ t: 0, n: 5, e5: 0 }], 60).rps, 0.0833);
});

test("R22: several load balancers as 'all services' — requests add, avg is weighted, percentiles are the worst", () => {
  const a: AlbSeries = { ...none(), req: [[0, 100], [MIN, 100]], avg: [[0, 0.1], [MIN, 0.1]], p99: [[0, 0.5]], e5: [[0, 1]], rej: [[MIN, 4]] };
  const b: AlbSeries = { ...none(), req: [[0, 300]], avg: [[0, 0.3]], p99: [[0, 0.9]], e5: [[0, 2]] };
  const m = mergeLbSeries([a, b]);
  assert.deepEqual(m.req, [[0, 400], [MIN, 100]]);
  assert.deepEqual(m.avg.map(([t, v]) => [t, Math.round(v * 1000) / 1000]), [[0, 0.25], [MIN, 0.1]]);
  assert.deepEqual(m.p99, [[0, 0.9]]);
  assert.deepEqual(m.e5, [[0, 3]]);
  assert.deepEqual(m.rej, [[MIN, 4]]);
  assert.equal(mergeLbSeries([a]), a);
});
