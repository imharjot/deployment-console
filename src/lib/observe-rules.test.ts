import { test } from "node:test";
import assert from "node:assert/strict";
import { periodFor } from "./metric-specs.ts";
import {
  RANGES, attribute, capPerService, ecsMarkers, inSync, mergeMarkers, obsChart, obsSections, obsSpecs, perfTtlMs, releaseStep, sig3, snapMinutes, sumSeries,
  type ObsInput, type ObsSpec,
} from "./observe-rules.ts";

const ARN = (kind: string, name: string, id: string) => `arn:aws:elasticloadbalancing:us-east-1:123456789012:${kind}/${name}/${id}`;
const ALB_A = ARN("loadbalancer/app", "acme-production", "aaaa");
const ALB_B = ARN("loadbalancer/app", "acme-partners", "bbbb");
const TG = { api: ARN("targetgroup", "acme-prod-api", "t1"), worker: ARN("targetgroup", "acme-prod-worker", "t2"), partners: ARN("targetgroup", "acme-prod-partners", "t3") };
const TRAFFIC = [
  { service: "api", label: "Storefront API", tgArn: TG.api },
  { service: "worker", label: "Jobs", tgArn: TG.worker },
  { service: "partners", label: "Partner API", tgArn: TG.partners },
];
const TGLB = { [TG.api]: ALB_A, [TG.worker]: ALB_A, [TG.partners]: ALB_B };

// What CloudWatch would return: per bucket, the per-minute rate × the bucket's minutes, for Sum statistics.
const RATE: Record<string, number> = { "targetgroup/acme-prod-api/t1": 300, "targetgroup/acme-prod-worker/t2": 120, "targetgroup/acme-prod-partners/t3": 30 };
function fake(specs: ObsSpec[], minutes: number, lbRate: Record<string, number>): Record<string, [number, number][]> {
  const step = periodFor(minutes);
  const out: Record<string, [number, number][]> = {};
  for (const s of specs) {
    const perMin = s.dims.TargetGroup ? (RATE[s.dims.TargetGroup] ?? 0) : s.dims.LoadBalancer ? (lbRate[s.dims.LoadBalancer] ?? 0) : 7;
    const v = s.stat === "Sum" ? perMin * (step / 60) : 42;
    out[s.id] = [[0, v], [step * 1000, v]];
  }
  return out;
}
const input = (minutes: number, o: Partial<ObsInput> = {}): ObsInput => {
  const a = attribute(TRAFFIC, TGLB);
  return { minutes, cluster: "acme-production", apps: [{ id: "api", name: "Storefront API" }], traffic: a.targets, lbs: a.lbs, databases: [], caches: [], hosts: [], ...o };
};

test("windows snap to 1 h / 6 h / 24 h / 7 d; Insights-backed performance refreshes with the window", () => {
  assert.deepEqual([15, 60, 61, 200, 359, 1000, 3000, 9000, 1e9, Number.NaN, "x"].map(snapMinutes), [60, 60, 60, 60, 360, 1440, 1440, 10_080, 10_080, 60, 60]);
  assert.deepEqual(RANGES.map(perfTtlMs), [60_000, 216_000, 864_000, 6_048_000]);
});

test("R22: each target group is measured on its OWN load balancer; the second ALB's service isn't asked on the first", () => {
  const a = attribute(TRAFFIC, TGLB);
  assert.deepEqual(a.lbs, ["app/acme-partners/bbbb", "app/acme-production/aaaa"]);
  assert.equal(a.targets.find((t) => t.service === "partners")?.lb, "app/acme-partners/bbbb");
  const specs = obsSpecs(input(60));
  const req = specs.filter((s) => s.chart === "req" && s.dims.TargetGroup);
  assert.deepEqual(req.map((s) => [s.label, s.metric, s.dims.TargetGroup, s.dims.LoadBalancer]), [
    ["Storefront API", "RequestCount", "targetgroup/acme-prod-api/t1", "app/acme-production/aaaa"],
    ["Jobs", "RequestCount", "targetgroup/acme-prod-worker/t2", "app/acme-production/aaaa"],
    ["Partner API", "RequestCount", "targetgroup/acme-prod-partners/t3", "app/acme-partners/bbbb"],
  ]);
  assert.ok(!specs.some((s) => s.metric === "RequestCountPerTarget"), "never the per-target count when the LB is known");
});

test("R22 + F03: every window shows true per-minute values; the total sums each distinct ALB once", () => {
  // The load balancers' own totals: A carries api + worker (+ 15/min of redirects), B carries partners.
  const lbRate = { "app/acme-production/aaaa": 435, "app/acme-partners/bbbb": 30 };
  for (const minutes of RANGES) {
    const o = input(minutes);
    const specs = obsSpecs(o);
    const sections = obsSections(o, specs, fake(specs, minutes, lbRate));
    const req = sections.find((s) => s.title === "Traffic")!.charts.find((c) => c.id === "req")!;
    const at0 = Object.fromEntries(req.series.map((s) => [s.label, s.points[0][1]]));
    assert.deepEqual(at0, { "Storefront API": 300, Jobs: 120, "Partner API": 30, Total: 465 }, `${minutes} min`);
    assert.equal(req.unit, "/min");
    assert.equal(req.stepSec, periodFor(minutes));
    const e5 = sections.find((s) => s.title === "Traffic")!.charts.find((c) => c.id === "5xx")!;
    assert.deepEqual(e5.series.map((s) => s.label), ["Storefront API", "Jobs", "Partner API", "Rejected by load balancer (503)"], "503s once per ALB, summed");
  }
});

test("F03: a 300 s Sum bucket of 300 is 60 per minute", () => {
  const specs: ObsSpec[] = [{ id: "m0", chart: "req", label: "api", namespace: "AWS/ApplicationELB", metric: "RequestCount", dims: {}, stat: "Sum", scale: 60 / 300 }];
  assert.equal(obsChart("req", specs, { m0: [[0, 300]] }, 300).series[0].points[0][1], 60);
});

test("R22: a target group whose load balancer is unknown falls back to the per-target count, labelled as such", () => {
  const a = attribute(TRAFFIC.slice(0, 1), {});
  const o = input(360, { traffic: a.targets, lbs: a.lbs });
  const specs = obsSpecs(o);
  assert.deepEqual(specs.filter((s) => s.chart === "req").map((s) => [s.label, s.metric, JSON.stringify(s.dims)]), [["Storefront API (per target)", "RequestCountPerTarget", '{"TargetGroup":"targetgroup/acme-prod-api/t1"}']]);
  assert.ok(!specs.some((s) => s.chart === "p95"), "latency needs the load balancer dimension");
  const traffic = obsSections(o, specs, {}).find((s) => s.title === "Traffic")!;
  assert.match(traffic.charts[0].note ?? "", /load balancer unknown — requests per target/);
});

test("one service behind one ALB: no separate Total line", () => {
  const a = attribute(TRAFFIC.slice(0, 1), TGLB);
  const specs = obsSpecs(input(60, { traffic: a.targets, lbs: a.lbs }));
  assert.equal(specs.filter((s) => s.chart === "req").length, 1);
});

test("F16 / F70: Database charts in MiB and GiB, a Cache section per member node, EC2 network in MB per minute", () => {
  const o = input(1440, {
    traffic: [], lbs: [],
    databases: [{ id: "acme-production-pg" }],
    caches: [{ id: "acme-production-valkey", memberClusters: ["acme-production-valkey-001", "acme-production-valkey-002"] }],
    hosts: [{ id: "i-0abc", name: "acme-box" }],
  });
  const specs = obsSpecs(o);
  const sections = obsSections(o, specs, fake(specs, 1440, {}));
  assert.deepEqual(sections.map((s) => s.title), ["Services", "Traffic", "Database", "Cache", "EC2 host"]);
  const db = sections.find((s) => s.title === "Database")!;
  assert.deepEqual(db.charts.map((c) => [c.id, c.unit]), [["dbcpu", "%"], ["dbconn", ""], ["dblat", "ms"], ["dbiops", "IOPS"], ["dbmem", "MiB"], ["dbdisk", "GiB"]]);
  const disk = specs.find((s) => s.metric === "FreeStorageSpace")!;
  assert.equal(20 * 1024 ** 3 * disk.scale!, 20);
  const cache = sections.find((s) => s.title === "Cache")!;
  assert.deepEqual(cache.charts.find((c) => c.id === "cachecpu")!.series.map((s) => s.label), ["acme-production-valkey-001 CPU", "acme-production-valkey-002 CPU"]);
  assert.ok(specs.filter((s) => s.namespace === "AWS/ElastiCache").every((s) => s.dims.CacheClusterId.endsWith("-001") || s.dims.CacheClusterId.endsWith("-002")));
  const evict = cache.charts.find((c) => c.id === "cacheevict")!;
  assert.equal(evict.unit, "/min");
  assert.equal(evict.series[0].points[0][1], 7, "Sum per 5-min bucket → per minute");
  const net = sections.find((s) => s.title === "EC2 host")!.charts.find((c) => c.id === "boxnet")!;
  assert.equal(net.unit, "MB/min");
  const spec = specs.find((s) => s.metric === "NetworkIn")!;
  assert.equal(spec.scale, (1 / 1e6) * (60 / 300));
  // No display unit is ever passed to CloudWatch (it would be sent as Unit "%" and fail the query).
  assert.ok(specs.every((s) => !("unit" in s)));
});

test("sums and significant digits", () => {
  assert.deepEqual(sumSeries([[[0, 1], [60, 2]], [[60, 3], [120, 4]]]), [[0, 1], [60, 5], [120, 4]]);
  assert.deepEqual([0.04321, 12.345, 2752.8, 0, -0.5].map(sig3), [0.0432, 12.3, 2753, 0, -0.5]);
});

const SINCE = 1_000_000;
const ev = (at: number, message: string) => ({ id: `e${at}`, at, message });

test("F12: deploy markers from ECS events; rollbacks are their own kind and their completion isn't a deploy", () => {
  const events = [
    ev(SINCE + 1000, "(service api) has reached a steady state."),
    ev(SINCE + 2000, "(service api) (deployment ecs-svc/111) deployment completed."),
    ev(SINCE + 9000, "(service api) (deployment ecs-svc/222) deployment failed: tasks failed to start."),
    ev(SINCE + 9500, "(service api) rolling back to deployment ecs-svc/111."),
    ev(SINCE + 30_000, "(service api) (deployment ecs-svc/111) deployment completed."),
    ev(SINCE - 5000, "(service api) (deployment ecs-svc/000) deployment completed."), // outside the window
  ];
  const m = ecsMarkers("Storefront API", events, SINCE);
  assert.deepEqual(m.map((x) => [x.at - SINCE, x.kind, x.source]), [[2000, "deploy", "ecs"], [9500, "rollback", "ecs"]]);
  assert.match(m[1].title, /^Rolled back · rolling back to deployment ecs-svc\/111/);
  // The simulated account's wording: "deployment failed: … Rolling back." names no target; the next completion is it.
  const sim = ecsMarkers("api", [ev(SINCE, "(service api) (deployment d1) deployment failed: tasks failed to start. Rolling back."), ev(SINCE + 60_000, "(service api) (deployment d0) deployment completed."), ev(SINCE + 3_600_000, "(service api) (deployment d2) deployment completed.")], SINCE);
  assert.deepEqual(sim.map((x) => x.kind), ["rollback", "deploy"]);
  assert.equal(ecsMarkers("api", [ev(SINCE, "(service api) (deployment x) deployment failed: ECS deployment circuit breaker: tasks failed to start.")], SINCE)[0].kind, "rollback");
});

test("F12: a GitHub deploy run lends sha and link to the ECS marker within 10 min; others stay their own markers", () => {
  const ecs = ecsMarkers("api", [ev(SINCE, "(service api) (deployment a) deployment completed."), ev(SINCE + 3_600_000, "(service api) (deployment b) deployment completed.")], 0);
  const runs = [
    { at: SINCE - 4 * 60_000, service: "api", sha: "abc1234", title: "Fix cart totals", url: "https://github.com/acme/storefront-api/actions/runs/1" },
    { at: SINCE + 7_200_000, service: "api", sha: "def5678", title: "Add refunds", url: "https://github.com/acme/storefront-api/actions/runs/2" },
    { at: SINCE + 60_000, service: "jobs", sha: "0000000", title: "Other service", url: "https://github.com/acme/jobs/actions/runs/3" },
  ];
  const m = mergeMarkers(ecs, runs);
  assert.deepEqual(m.map((x) => [x.at - SINCE, x.service, x.sha ?? null, x.source]), [
    [0, "api", "abc1234", "ecs"],
    [60_000, "jobs", "0000000", "github"],
    [3_600_000, "api", null, "ecs"],
    [7_200_000, "api", "def5678", "github"],
  ]);
  assert.equal(m[0].title, "Fix cart totals");
  assert.equal(mergeMarkers([], runs).length, 3, "no ECS events: GitHub runs alone");
});

test("F08 / F07: a release step keeps behindBy (ahead 0, behind 3 is not in sync) and carries migrations unknown", () => {
  const s = releaseStep("staging", "production", { aheadBy: 0, behindBy: 3, commits: [] }, { changed: "unknown", why: "GitHub not connected" });
  assert.deepEqual([s.aheadBy, s.behindBy, s.migrations, s.migrationsWhy], [0, 3, "unknown", "GitHub not connected"]);
  assert.equal(inSync(s), false);
  assert.equal(inSync({ aheadBy: 0, behindBy: 0 }), true);
  assert.equal(inSync({}, true), true, "same sha");
  assert.equal(inSync({}), false, "unknown is not in sync");
  const commits = Array.from({ length: 60 }, (_, i) => ({ sha: `c${i}`, title: `t${i}`, author: "a", date: "d" }));
  const big = releaseStep("staging", "production", { aheadBy: 60, behindBy: 0, commits }, { changed: false });
  assert.deepEqual([big.commits.length, big.commits[0].sha, big.commits[49].sha], [50, "c59", "c10"], "newest 50, newest first");
});

test("F11: the activity cap applies per service after steady-state events are gone", () => {
  const items = [
    ...Array.from({ length: 80 }, (_, i) => ({ service: "api", at: i })),
    ...Array.from({ length: 10 }, (_, i) => ({ service: "jobs", at: 1000 + i })),
  ];
  const kept = capPerService(items, 50);
  assert.equal(kept.filter((x) => x.service === "api").length, 50);
  assert.equal(kept.filter((x) => x.service === "jobs").length, 10);
  assert.equal(Math.min(...kept.filter((x) => x.service === "api").map((x) => x.at)), 30, "newest kept");
});
