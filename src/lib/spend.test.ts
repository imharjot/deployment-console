import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addDays, breakdowns, buildSpend, classifyCeError, daysBetween, daysInMonth, envForTag, fixFor, nextMonthStart, prevMonthStart, projectMonthEnd,
  samePoint, serviceLabel, spikes, sumDays, windowOf, type EnvRef, type SpendSnapshot,
} from "./spend.ts";

// Build a daily map from per-service functions of the day.
const fill = (from: string, toExclusive: string, per: Record<string, (d: string) => number>) =>
  Object.fromEntries(daysBetween(from, toExclusive).map((d) => [d, Object.fromEntries(Object.entries(per).map(([s, f]) => [s, f(d)]))]));

const ENVS: EnvRef[] = [
  { id: "staging", label: "Staging", cluster: "acme-staging", protected: false },
  { id: "production", label: "Production", cluster: "acme-production", protected: true },
];

test("date helpers: month edges, leap years, the snapshot window", () => {
  assert.equal(nextMonthStart("2026-12-15"), "2027-01-01");
  assert.equal(prevMonthStart("2026-01-31"), "2025-12-01");
  assert.equal(daysInMonth("2024-02-10"), 29);
  assert.equal(daysInMonth("2026-02-10"), 28);
  assert.equal(addDays("2026-02-28", 1), "2026-03-01");
  assert.deepEqual(daysBetween("2026-09-29", "2026-10-02"), ["2026-09-29", "2026-09-30", "2026-10-01"]);
  const w = windowOf("2026-03-01");
  assert.deepEqual(w, { today: "2026-03-01", tomorrow: "2026-03-02", month: "2026-03-01", nextMonth: "2026-04-01", lastMonth: "2026-02-01", dailyFrom: "2026-01-25", anomaliesFrom: "2026-01-30" });
  assert.equal(windowOf("2026-09-26").dailyFrom, "2026-08-01", "start of last month when that is further back than 35 days");
});

test("Cost Explorer errors map to a fix", () => {
  assert.equal(classifyCeError("AccessDeniedException", "User: arn:aws:sts::123456789012:assumed-role/console is not authorized to perform: ce:GetCostAndUsage"), "denied");
  assert.equal(classifyCeError("AccessDeniedException", "User not enabled for cost explorer access"), "not-enabled");
  assert.equal(classifyCeError("LimitExceededException", "Rate exceeded"), "throttled");
  assert.equal(classifyCeError("DataUnavailableException", "Insufficient amount of historical data"), "error");
  assert.match(fixFor("denied", "costs").join(" "), /ce:GetCostAndUsage/);
  assert.match(fixFor("not-enabled", "costs")[0], /Enable Cost Explorer/);
});

test("same point last month: full days only, clipped to a shorter last month, null on the 1st", () => {
  const daily = fill("2026-08-01", "2026-09-27", { EC2: (d) => (d < "2026-09-01" ? 10 : 12) });
  assert.deepEqual(samePoint(daily, "2026-09-26"), { days: 25, thisMonth: 300, lastMonth: 250, changePct: 20 });
  assert.equal(samePoint(daily, "2026-09-01"), null);
  const march = fill("2026-02-01", "2026-04-01", { EC2: () => 1 });
  assert.equal(samePoint(march, "2026-03-31")!.lastMonth, 28, "February has only 28 days to compare");
  assert.equal(samePoint(fill("2026-09-01", "2026-09-27", { EC2: () => 1 }), "2026-09-26")!.changePct, null, "no spend last month → no percentage");
});

test("month-end projection: AWS forecast for the rest of the month, else the 7-day run rate", () => {
  const daily = fill("2026-08-01", "2026-09-27", { EC2: () => 10 });
  assert.deepEqual(projectMonthEnd(daily, "2026-09-26", { status: "ok", amount: 55 }), { monthEnd: 250 + 55, method: "aws" });
  const rr = projectMonthEnd(daily, "2026-09-26", { status: "ok", amount: null })!;
  assert.equal(rr.method, "run-rate");
  assert.equal(rr.monthEnd, 250 + 10 * 5, "25 full days done, 5 left including today");
  assert.match(rr.note!, /enough history/);
  assert.match(projectMonthEnd(daily, "2026-09-26", { status: "unavailable", code: "denied", reason: "AccessDenied" })!.note!, /AccessDenied/);
  assert.equal(projectMonthEnd({}, "2026-09-26", { status: "ok", amount: null }), null);
  // Services scaled to zero mid-month: AWS's forecast still assumes the old rate; the 7-day run rate comes along.
  const dropped = fill("2026-08-01", "2026-09-27", { EC2: (d: string) => (d >= "2026-09-19" ? 1 : 10) });
  const f = projectMonthEnd(dropped, "2026-09-26", { status: "ok", amount: 50 })!;
  assert.equal(f.method, "aws");
  assert.equal(f.monthEnd, 18 * 10 + 7 * 1 + 50);
  assert.equal(f.runRate, 18 * 10 + 7 * 1 + 5 * 1);
  assert.match(f.note!, /assumes \$10\.00\/day .* averaged \$1\.00\/day/);
  // Pennies a day never warn, however far apart.
  assert.equal(projectMonthEnd(fill("2026-09-01", "2026-09-27", { EC2: () => 0.05 }), "2026-09-26", { status: "ok", amount: 1 })!.runRate, undefined);
});

test("spikes: last 7 days vs the 21 before, with a threshold and a floor", () => {
  const today = "2026-09-26";
  const recent = (d: string) => d >= addDays(today, -7);
  const daily = fill("2026-08-01", "2026-09-27", {
    AmazonCloudWatch: (d) => (recent(d) ? 5 : 1),
    "Tiny service": (d) => (recent(d) ? 0.05 : 0.02),
    "New service": (d) => (recent(d) ? 3 : 0),
    Steady: (d) => (recent(d) ? 12 : 10),
    Cheaper: (d) => (recent(d) ? 1 : 10),
  });
  const s = spikes(daily, today, 30);
  assert.deepEqual(s.map((x) => x.service), ["AmazonCloudWatch", "New service"]);
  assert.equal(s[0].label, "CloudWatch");
  assert.equal(s[0].changePct, 400);
  assert.equal(Math.round(s[0].extraMonthly), Math.round(4 * (730 / 24)));
  assert.equal(s[1].changePct, null, "new spend has no baseline percentage");
  assert.ok(spikes(daily, today, 10).some((x) => x.service === "Steady"), "+20 % passes a 10 % threshold");
  const partialToday = { ...daily, [today]: { AmazonCloudWatch: 1000 } };
  assert.equal(spikes(partialToday, today, 30)[0].recentDaily, 5, "today's partial numbers are ignored");
});

test("tags map to environments; untagged spend and unknown clusters stay visible", () => {
  const rows = [
    { tag: "acme-production", service: "api", amount: 40 },
    { tag: "acme-production", service: "worker", amount: 10 },
    { tag: "acme-staging", service: "api", amount: 5 },
    { tag: "legacy-batch", service: "", amount: 3 },
    { tag: "", service: "", amount: 100 },
  ];
  const { envs, ecs } = breakdowns({ tagKey: "aws:ecs:clusterName", tags: { status: "ok", rows } }, ENVS, { "production/api": "Storefront API" });
  assert.equal(envs.status, "ok");
  assert.equal(envs.untagged, 100);
  assert.deepEqual(envs.rows.map((r) => [r.label, r.env, r.amount]), [["Production", "production", 50], ["Staging", "staging", 5], ["legacy-batch", undefined, 3]]);
  assert.equal(envs.rows[0].protected, true);
  assert.deepEqual(ecs.rows.map((r) => [r.name, r.envLabel, r.amount]), [["Storefront API", "Production", 40], ["worker", "Production", 10], ["api", "Staging", 5]]);

  const none = breakdowns({ tagKey: "aws:ecs:clusterName", tags: { status: "ok", rows: [{ tag: "", service: "", amount: 90 }] } }, ENVS, {});
  assert.equal(none.envs.status, "no-data");
  assert.match(none.envs.fix!.join(" "), /split cost allocation/i);
  assert.equal(none.ecs.status, "no-data");

  const denied = breakdowns({ tagKey: "aws:ecs:clusterName", tags: { status: "unavailable", code: "denied", reason: "AccessDenied" } }, ENVS, {});
  assert.equal(denied.envs.status, "unavailable");
  assert.equal(denied.envs.reason, "AccessDenied");
});

test("a user-defined tag matches env id, label or cluster; the cluster tag matches clusters only", () => {
  assert.equal(envForTag("Production", ENVS, "env")?.id, "production");
  assert.equal(envForTag("acme-staging", ENVS, "env")?.id, "staging");
  assert.equal(envForTag("staging", ENVS, "aws:ecs:clusterName"), undefined);
  assert.equal(envForTag("", ENVS, "env"), undefined);
});

test("buildSpend assembles the view from one snapshot", () => {
  const today = "2026-09-26";
  const snap: SpendSnapshot = {
    v: 1, fetchedAt: 1_000, today, source: "mock", requests: 4, estimated: true,
    daily: fill("2026-08-01", "2026-09-27", { "Amazon Relational Database Service": () => 6, AmazonCloudWatch: (d) => (d >= "2026-09-19" ? 5 : 1) }),
    tagKey: "aws:ecs:clusterName",
    tags: { status: "ok", rows: [{ tag: "acme-production", service: "api", amount: 20 }] },
    forecast: { status: "ok", amount: 40 },
    anomalies: { status: "ok", items: [{ id: "a1", start: "2026-09-19", service: "AmazonCloudWatch", impact: 28, score: 0.9 }, { id: "a0", start: "2026-09-02", end: "2026-09-03", service: "AWS Lambda", impact: 2, score: 0.4 }] },
  };
  const v = buildSpend(snap, { envs: ENVS, names: {}, spikePercent: 30, ttlMs: 6 * 3600_000 });
  assert.equal(v.expiresAt, 1_000 + 6 * 3600_000);
  assert.equal(v.monthToDate, sumDays(snap.daily, "2026-09-01", "2026-09-27"));
  assert.equal(v.lastMonth, 31 * 7);
  assert.equal(v.daily.length, 30);
  assert.deepEqual([v.daily[0].date, v.daily.at(-1)!.date, v.daily.at(-1)!.partial, v.daily[0].partial], ["2026-08-28", today, true, false]);
  assert.deepEqual(v.services.map((s) => s.label), ["RDS", "CloudWatch"]);
  assert.equal(v.forecast!.method, "aws");
  assert.equal(v.forecast!.monthEnd, sumDays(snap.daily, "2026-09-01", today) + 40);
  assert.equal(v.anomalies.status === "ok" && v.anomalies.items.map((a) => [a.id, a.open, a.label]).join("|"), "a1,true,CloudWatch|a0,false,Lambda");
  assert.deepEqual(v.spikes.map((s) => s.service), ["AmazonCloudWatch"]);
  assert.equal(serviceLabel("Amazon Elastic Compute Cloud - Compute"), "EC2 instances");
});
