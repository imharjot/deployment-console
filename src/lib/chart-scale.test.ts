import { test } from "node:test";
import assert from "node:assert/strict";
import {
  asOf, createHoverStore, fmtAxis, fmtNumber, medianStep, nearestIndex, niceScale, niceStep, rateDisplay, segments, timePath, trimPartialBins, withUnit, xOf, yFloor,
  type Point,
} from "./chart-scale.ts";
import {
  auditRegion, capacityText, clientFreshness, effectiveOverview, filterTokens, groupByRegion, hopOf, keptFreshness, needsPromotion, opsOf, releasesHeadline, revisionGuard, savedViewHref,
  summarizeResult, tokenCounts, uptimeLabel, verificationText,
} from "./client/format.ts";
import type { EnvOverview, ReleaseView, ResourceView, RevisionView } from "./types.ts";

const MIN = 60_000;
const T0 = Date.UTC(2026, 9, 5, 12, 0, 0);
const series = (n: number, step = MIN, from = T0, v = (i: number) => i): Point[] => Array.from({ length: n }, (_, i) => [from + i * step, v(i)]);

// ---------- y scale (F36) ----------

test("niceStep snaps to 1-2-2.5-5 × 10^n", () => {
  assert.deepEqual([0.9, 1.5, 2.2, 3, 7, 12, 0.03, 260].map(niceStep), [1, 2, 2.5, 5, 10, 20, 0.05, 500]);
  assert.equal(niceStep(0), 1);
  assert.equal(niceStep(Number.NaN), 1);
});

test("niceScale starts at 0, covers the top, and never draws odd fractional ticks", () => {
  const s = niceScale(87);
  assert.equal(s.ticks[0], 0);
  assert.ok(s.max >= 87);
  assert.deepEqual(s.ticks, [0, 20, 40, 60, 80, 100]);
  assert.deepEqual(niceScale(0.0213).ticks, [0, 0.005, 0.01, 0.015, 0.02, 0.025]);
  assert.deepEqual(niceScale(2300).ticks, [0, 500, 1000, 1500, 2000, 2500]);
  for (const top of [0.3, 1, 1.01, 3.7, 9.99, 10, 101, 999, 1234, 57_000]) {
    const { ticks, max, step } = niceScale(top);
    assert.ok(max >= top, `max ${max} ≥ ${top}`);
    assert.ok(ticks.length <= 6, `${top}: ${ticks.length} ticks`);
    assert.ok([1, 2, 2.5, 5].includes(Number((step / 10 ** Math.floor(Math.log10(step))).toPrecision(3))), `${top}: step ${step}`);
  }
});

test("y floor: percentages keep 0–10 %, other units scale to their own values (no Math.max(1, …))", () => {
  assert.equal(niceScale(0.4, { floor: yFloor("%") }).max, 10);
  assert.equal(niceScale(0.4, { floor: yFloor("rps") }).max, 0.4);
  assert.equal(niceScale(0, { floor: yFloor("ms") }).max, 1, "an all-zero series still gets an axis");
});

// ---------- numbers (F09, F36) ----------

test("fmtNumber: two significant digits below 1, three above, whole with separators from 100", () => {
  assert.equal(fmtNumber(0.04321), "0.043");
  assert.equal(fmtNumber(0.5), "0.5");
  assert.equal(fmtNumber(3.14159), "3.14");
  assert.equal(fmtNumber(42.66), "42.7");
  assert.equal(fmtNumber(1234.5), "1,235");
  assert.equal(fmtNumber(0), "0");
  assert.equal(fmtNumber(Number.NaN), "—");
});

test("axis labels use k and M; counts stay whole; units are appended", () => {
  assert.equal(fmtAxis(2500), "2.5k");
  assert.equal(fmtAxis(1_200_000), "1.2M");
  assert.equal(fmtAxis(20_000), "20k");
  assert.equal(fmtAxis(0.025), "0.025");
  assert.equal(withUnit(12.345, "%"), "12.3%");
  assert.equal(withUnit(340, "ms"), "340 ms");
  assert.equal(withUnit(1204.4, ""), "1,204");
  assert.equal(withUnit(0.5, ""), "0.5");
  assert.equal(withUnit(2500, "ms", true), "2.5k ms");
});

test("rps below 1 reads per minute; at or above 1 it stays per second", () => {
  const low = rateDisplay("rps", [{ id: "a", points: [[1, 0.2], [2, 0.5]] as Point[] }]);
  assert.equal(low.unit, "req/min");
  assert.deepEqual(low.series[0].points, [[1, 12], [2, 30]]);
  assert.equal(rateDisplay("rps", [{ id: "a", points: [[1, 3]] as Point[] }]).unit, "rps");
  assert.equal(rateDisplay("ms", [{ id: "a", points: [[1, 0.2]] as Point[] }]).unit, "ms");
});

// ---------- time axis (F13) ----------

test("x is time, not index: uneven points land at their timestamps", () => {
  const f = { range: [T0, T0 + 10 * MIN] as [number, number], width: 100, height: 50, max: 10 };
  assert.equal(xOf(T0, f), 0);
  assert.equal(xOf(T0 + 5 * MIN, f), 50);
  const { line } = timePath([[T0, 1], [T0 + MIN, 1], [T0 + 2 * MIN, 1], [T0 + 3 * MIN, 1], [T0 + 9 * MIN, 1], [T0 + 10 * MIN, 1]], f);
  // The 6-minute hole is a gap: two runs, the second starting at x = 90.
  assert.match(line, /^M0\.0,[\d.]+L10\.0,[\d.]+L20\.0,[\d.]+L30\.0,[\d.]+M90\.0,[\d.]+L100\.0,[\d.]+$/);
});

test("gaps longer than 2 × the median step break the line; a lone point is a dot", () => {
  const pts: Point[] = [...series(5), [T0 + 20 * MIN, 3], ...series(3, MIN, T0 + 40 * MIN)];
  assert.equal(medianStep(pts), MIN);
  const runs = segments(pts);
  assert.equal(runs.length, 3);
  assert.deepEqual(runs.map((r) => r.length), [5, 1, 3]);
  const f = { range: [T0, T0 + 42 * MIN] as [number, number], width: 420, height: 100, max: 10 };
  const p = timePath(pts, f);
  assert.equal(p.runs, 3);
  assert.match(p.line, /M200\.0,[\d.]+h0\.01/, "the isolated point is drawn as a dot");
  assert.equal((p.area.match(/Z/g) ?? []).length, 2, "areas only under runs of two or more");
  // Exactly 2 × the step is not a gap.
  assert.equal(segments([[0, 1], [MIN, 1], [3 * MIN, 1], [4 * MIN, 1]]).length, 1);
  // Non-finite values are gaps too.
  assert.equal(segments([[0, 1], [MIN, Number.NaN], [2 * MIN, 1], [3 * MIN, 1]]).length, 2);
});

test("points outside the range are not drawn", () => {
  const f = { range: [T0 + 2 * MIN, T0 + 4 * MIN] as [number, number], width: 100, height: 50, max: 10 };
  const { line } = timePath(series(10), f);
  assert.equal(line.split(/[ML]/).filter(Boolean).length, 3);
});

test("nearestIndex: binary search by time, ties go to the earlier point", () => {
  const pts = series(100);
  assert.equal(nearestIndex(pts, T0 + 41.4 * MIN), 41);
  assert.equal(nearestIndex(pts, T0 + 41.6 * MIN), 42);
  assert.equal(nearestIndex(pts, T0 + 41.5 * MIN), 41);
  assert.equal(nearestIndex(pts, T0 - 9 * MIN), 0);
  assert.equal(nearestIndex(pts, T0 + 999 * MIN), 99);
  assert.equal(nearestIndex([], T0), -1);
});

test("asOf: a last point hours before the end is 'as of', a current one is 'now'", () => {
  const pts = series(30, MIN);
  assert.equal(asOf(pts, T0 + 30 * MIN), undefined);
  assert.equal(asOf(pts, T0 + 3 * 3600_000), pts[29][0]);
  assert.equal(asOf([], T0), undefined);
});

test("trimPartialBins drops a first bin that starts before the window and a last bin still open", () => {
  const pts = series(6, 5 * MIN, T0 - 2 * MIN);
  const out = trimPartialBins(pts, 5 * MIN, T0, T0 + 26 * MIN);
  assert.equal(out[0][0], T0 + 3 * MIN);
  assert.equal(out[out.length - 1][0], T0 + 18 * MIN);
  assert.equal(trimPartialBins(pts, 5 * MIN, T0 - 2 * MIN, T0 + 99 * MIN).length, 6, "whole bins are kept");
});

test("hover store notifies only on change", () => {
  const h = createHoverStore();
  let n = 0;
  const off = h.subscribe(() => n++);
  h.set(5);
  h.set(5);
  h.set(null);
  assert.equal(n, 2);
  assert.equal(h.get(), null);
  off();
  h.set(1);
  assert.equal(n, 2);
});

// ---------- freshness on screen (R21) ----------

const tile = (key: string, o: Partial<ResourceView> = {}): ResourceView => ({
  key, kind: "service", env: "staging", id: key.split(":")[1], name: key, subtitle: "", state: "UP", reasons: ["1/1 running"], checkedAt: T0, stats: [], properties: [], actions: [], tabs: [], ...o,
});
const overview = (o: Partial<EnvOverview> = {}): EnvOverview => ({
  env: "staging", checkedAt: T0, frame: { kind: "fargate", title: "t", subtitle: "s" },
  services: [tile("service:api"), tile("service:web", { fetchedAt: T0 - 5 * MIN })],
  infra: [tile("database:db", { kind: "database" })],
  summary: { UP: 3, DEGRADED: 0, DOWN: 0, DEPLOYING: 0, STOPPED: 0, BOX_STOPPED: 0, UNKNOWN: 0 },
  source: "mock",
  topology: { nodes: [{ id: "service:api", label: "api", sub: "", kind: "service", lane: 2, state: "UP", resourceKey: "service:api" }, { id: "ext:x", label: "x", sub: "", kind: "external", lane: 4 }], edges: [] },
  freshness: { observedAt: T0, staleAfterMs: 30_000, source: "sampler", completeness: "complete" },
  ...o,
});

test("effectiveOverview: fresh data is returned as is; a tile with an old fetchedAt alone goes UNKNOWN", () => {
  const o = overview({ services: [tile("service:api")] });
  const fresh = effectiveOverview(o, T0 + 10_000);
  assert.equal(fresh.o, o, "same object, so memoised cards don't re-render");
  assert.equal(fresh.stale, false);
  assert.equal(fresh.next, T0 + 30_001);
  const mixed = effectiveOverview(overview(), T0 + 10_000);
  assert.equal(mixed.o.services[0].state, "UP");
  assert.equal(mixed.o.services[1].state, "UNKNOWN");
  assert.equal(mixed.o.services[1].reasons[0], "data stale — last read 11:55 UTC");
  assert.equal(mixed.o.summary.UNKNOWN, 1);
  assert.equal(mixed.o.summary.UP, 2);
});

test("effectiveOverview: a stale overview shows every state and node as UNKNOWN, never the last good one", () => {
  const r = effectiveOverview(overview(), T0 + 31_000);
  assert.equal(r.stale, true);
  assert.ok([...r.o.services, ...r.o.infra].every((x) => x.state === "UNKNOWN"));
  assert.equal(r.o.topology.nodes[0].state, "UNKNOWN");
  assert.equal(r.o.topology.nodes[1].state, undefined, "external nodes stay unmonitored");
  assert.equal(effectiveOverview(overview({ freshness: { staleAfterMs: 30_000, source: "x", completeness: "complete" } }), T0).stale, true, "unknown age is stale");
  assert.equal(effectiveOverview(overview(), 0).stale, false, "no clock yet (server render): decide later");
  assert.equal(effectiveOverview(overview({ freshness: undefined }), T0 + 99 * MIN).stale, false, "no freshness model: unchanged");
});

test("clientFreshness: the delivery delay doesn't count against the data, up to one staleAfterMs", () => {
  const f = { observedAt: T0, staleAfterMs: 30_000, source: "sampler", completeness: "complete" as const };
  // Read 25 s before it arrived, then kept 20 s until the next poll: 45 s old, but fresh.
  const c = clientFreshness(f, T0 + 25_000)!;
  assert.equal(c.staleAfterMs, 55_000);
  assert.equal(effectiveOverview(overview(), T0 + 45_000, T0 + 25_000).stale, false);
  assert.equal(effectiveOverview(overview(), T0 + 45_000).stale, true, "judged without the delay it would read stale");
  // Already 90 s old on arrival: the move is capped, so it is stale at once.
  assert.equal(effectiveOverview(overview(), T0 + 90_001, T0 + 90_000).stale, true);
  assert.equal(clientFreshness(f, undefined), f);
  assert.equal(clientFreshness(undefined, T0), undefined);
});

test("keptFreshness: a failed refresh keeps the data's time and adds the error", () => {
  assert.equal(keptFreshness({ data: undefined, error: new Error("x"), source: "s", staleAfterMs: 1 }), undefined);
  assert.equal(keptFreshness({ data: [], error: undefined, source: "s", staleAfterMs: 1 }), undefined);
  const base = { observedAt: T0, staleAfterMs: 1000, source: "CloudWatch", completeness: "partial" as const };
  assert.equal(keptFreshness({ data: [], error: undefined, base, source: "s", staleAfterMs: 1 }), base);
  assert.deepEqual(keptFreshness({ data: [], error: new Error("HTTP 502"), loadedAt: T0, source: "GitHub", staleAfterMs: 60_000 }), {
    observedAt: T0, staleAfterMs: 60_000, source: "GitHub", completeness: "complete", error: "HTTP 502",
  });
  assert.equal(keptFreshness({ data: {}, error: new Error("boom"), base: { ...base, error: "eu-west-1 denied" }, source: "s", staleAfterMs: 1 })?.error, "eu-west-1 denied; boom");
});

// ---------- services ----------

test("capacityText (R11) and uptimeLabel (F39)", () => {
  assert.equal(capacityText({ desired: 5, running: 1, pending: 4 }), "1/5 running · 4 pending");
  assert.equal(capacityText({ desired: 2, running: 1, pending: 0 }), "1/2 running");
  assert.equal(capacityText({ desired: 2, running: 2, pending: 0 }), undefined);
  assert.equal(capacityText({ desired: 0, running: 0, pending: 0 }), undefined);
  assert.equal(capacityText(undefined), undefined);
  assert.equal(uptimeLabel({ pct: 100, coveredMs: 23 * MIN }), "healthy 100% · last 23m");
  assert.equal(uptimeLabel({ pct: 91.7, coveredMs: 7200_000 }), "healthy 91.7% · last 2h");
  assert.equal(uptimeLabel({ pct: null, coveredMs: 0 }), "collecting…");
});

test("verification: accepted is not done", () => {
  assert.deepEqual(verificationText({ verification: "accepted" }), { text: "AWS accepted — verifying", tone: "accent" });
  assert.equal(verificationText({ verification: "failed", detail: "did not stabilise in 15 min" }).text, "did not stabilise in 15 min");
  assert.equal(verificationText({ verification: "failed" }).text, "did not stabilise");
  assert.equal(verificationText({ verification: "verified" }).tone, "ok");
  assert.equal(opsOf({ operations: [{ id: "a", verification: "accepted" }, null, { id: 3 }] }).length, 1);
  assert.deepEqual(opsOf({}), []);
});

const rev = (o: Partial<RevisionView & { mutableTagWhy?: string }> = {}): RevisionView & { mutableTagWhy?: string } => ({ arn: "a", revision: 7, image: "i", tag: "latest", live: false, imagePresent: true, ...o });
const svc = { readOnly: false, state: "UP" as const, actions: [{ name: "switch" as const, label: "Switch", enabled: true }] };

test("revisionGuard: a missing image disables with the reason; unknown and moving tags warn (R24, F68)", () => {
  assert.deepEqual(revisionGuard(svc, rev({ imageCheck: "missing", imageCheckWhy: "acme/api:abc is no longer in ECR (container api)" })), {
    disabled: true, why: "acme/api:abc is no longer in ECR (container api)", warnings: [],
  });
  const unknown = revisionGuard(svc, rev({ imageCheck: "unknown", imageCheckWhy: "another account's registry" }));
  assert.equal(unknown.disabled, false);
  assert.match(unknown.warnings[0], /another account's registry/);
  assert.match(revisionGuard(svc, rev({ imageCheck: "present", mutableTag: true, mutableTagWhy: "tag production now points to sha256:ab" })).warnings[0], /now points/);
  assert.equal(revisionGuard(svc, rev({ live: true })).why, "live now");
  assert.equal(revisionGuard(svc, rev({ imagePresent: false })).why, "image expired from ECR", "older servers without imageCheck");
  assert.equal(revisionGuard({ ...svc, readOnly: true, actions: [{ name: "switch", label: "Switch", enabled: false, why: "the console's own service" }] }, rev()).why, "the console's own service");
  assert.deepEqual(revisionGuard({ ...svc, actions: [{ name: "switch", label: "Switch", enabled: true, warning: "AWS permission not verified" }] }, rev({ imageCheck: "present" })).warnings, ["AWS permission not verified"]);
});

// ---------- releases (F08) ----------

test("hopOf: in sync only when proven; diverged warns about dropped commits; no compare is unknown", () => {
  assert.equal(hopOf({ aheadBy: 0, behindBy: 0 }, "a", "b", "Production").kind, "sync");
  assert.equal(hopOf({}, "abc", "abc", "Production").kind, "sync", "same sha needs no compare");
  assert.equal(hopOf({ aheadBy: 0 }, "a", "b", "Production").kind, "unknown", "behind unknown is not in sync");
  assert.equal(hopOf({}, "a", "b", "Production").text, "unknown");
  assert.deepEqual(hopOf({ aheadBy: 3, behindBy: 0 }, "a", "b", "Production"), { kind: "waiting", ahead: 3, behind: 0, text: "3 waiting" });
  assert.equal(hopOf({ aheadBy: 0, behindBy: 2 }, "a", "b", "Production").text, "Production is 2 ahead (hotfix/rollback?)");
  const d = hopOf({ aheadBy: 4, behindBy: 1 }, "a", "b", "Production");
  assert.equal(d.text, "diverged: 4 ahead / 1 behind");
  assert.equal(d.warning, "Promoting drops 1 commit that only Production has.");
});

const release = (stages: number, steps: { aheadBy?: number; behindBy?: number }[]): ReleaseView => ({
  service: "api", name: "api",
  stages: Array.from({ length: stages }, (_, i) => ({ env: `e${i}`, label: `E${i}`, protected: false, state: "UP" as const, sha: `s${i}` })),
  steps: steps.map((s, i) => ({ from: `e${i}`, to: `e${i + 1}`, commits: [], migrations: false, ...s })),
});

test("releases: waiting includes behind; 'in sync' needs 2+ stages and known steps", () => {
  assert.equal(needsPromotion(release(2, [{ aheadBy: 0, behindBy: 2 }])), true);
  assert.equal(needsPromotion(release(2, [{ aheadBy: 0, behindBy: 0 }])), false);
  assert.equal(releasesHeadline([release(1, [])])?.tone, "muted");
  assert.equal(releasesHeadline([]), undefined);
  assert.equal(releasesHeadline([release(2, [{ aheadBy: 0, behindBy: 0 }])])?.text, "Every environment is in sync.");
  assert.equal(releasesHeadline([release(2, [{}])])?.text, "Some steps couldn't be compared.");
  assert.match(releasesHeadline([release(2, [{ aheadBy: 1, behindBy: 0 }]), release(2, [{ aheadBy: 0, behindBy: 1 }])])!.text, /^2 services/);
});

// ---------- regions, tokens, approvals ----------

test("groupByRegion: home first, then by name, order kept inside a group", () => {
  const g = groupByRegion([{ id: "a", region: "eu-west-1" }, { id: "b", region: "us-east-1" }, { id: "c", region: "ap-south-1" }, { id: "d", region: "us-east-1" }], "us-east-1");
  assert.deepEqual(g.map((x) => [x.region, x.items.map((i) => i.id)]), [["us-east-1", ["b", "d"]], ["ap-south-1", ["c"]], ["eu-west-1", ["a"]]]);
});

test("token filter: counts per status, active by default in the UI", () => {
  const list = [{ status: "active" }, { status: "expired" }, { status: "active" }, { status: "revoked" }];
  assert.deepEqual(tokenCounts(list), { active: 2, expired: 1, revoked: 1, all: 4 });
  assert.equal(filterTokens(list, "active").length, 2);
  assert.equal(filterTokens(list, "all").length, 4);
});

test("summarizeResult: a short line, never the raw JSON", () => {
  assert.equal(summarizeResult({ revision: 124, restarted: true, url: "https://x", nested: { a: 1 } }), "revision: 124 · restarted: true");
  assert.equal(summarizeResult({ ok: true, operationId: "op-1", taskArns: ["a", "b"] }), "operation id: op-1 · task arns: 2 items");
  assert.equal(summarizeResult("done"), "done");
  assert.equal(summarizeResult(null), undefined);
  assert.equal(summarizeResult({ deep: { a: 1 } }), undefined);
});

test("savedViewHref: same-origin console pages only, never another site or the API", () => {
  assert.equal(savedViewHref({ path: "/logs", search: "?env=staging&q=error" }), "/logs?env=staging&q=error");
  assert.equal(savedViewHref({ path: "/metrics" }), "/metrics");
  assert.equal(savedViewHref({ path: "/", search: "" }), "/");
  for (const path of ["//evil.example/x", "/\\evil.example", "https://evil.example", "javascript:alert(1)", "logs", "/api/tokens", "/a b", 42]) assert.equal(savedViewHref({ path, search: "" }), undefined, String(path));
  for (const search of ["env=x", "?a b", 7]) assert.equal(savedViewHref({ path: "/logs", search }), undefined, String(search));
  assert.equal(savedViewHref(undefined), undefined);
});

test("auditRegion: the entry's region, else its environment's, else home; none without an environment", () => {
  const envs = [{ id: "production", region: "us-east-1" }, { id: "production-eu-west-1", region: "eu-west-1" }];
  assert.equal(auditRegion({ env: "production", region: "eu-west-1" }, envs, "us-east-1"), "eu-west-1");
  assert.equal(auditRegion({ env: "production-eu-west-1" }, envs, "us-east-1"), "eu-west-1"); // an older row: not the home region
  assert.equal(auditRegion({ env: "gone" }, envs, "us-east-1"), "us-east-1");
  assert.equal(auditRegion({ env: "" }, envs, "us-east-1"), undefined);
});
