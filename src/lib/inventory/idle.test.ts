import { test } from "node:test";
import assert from "node:assert/strict";
import { activityBudgetOf, estMonthlyUsd, idleDaysOf, idleEvidenceOf, idleOf, isErrorCounter, metricsLastHour, takeTokens } from "./idle.ts";

const DAY = 86_400_000;
const HOUR = 3_600_000;
const now = Date.UTC(2026, 8, 27);
const series = (label: string, values: number[], required?: boolean) => ({
  label,
  points: values.map((v, i) => [now - (values.length - i) * DAY, v] as [number, number]),
  ...(required ? { required } : {}),
});

test("metrics decide first: all zero over the window is idle, any activity is not", () => {
  assert.deepEqual(idleOf({ kind: "lambda", health: "ok" }, { now, windowDays: 14, activity: [series("invocations", Array(14).fill(0))] }), { since: undefined, why: "no invocations in 14 days" });
  assert.deepEqual(idleOf({ kind: "sqs", health: "ok" }, { now, windowDays: 14, activity: [{ label: "messages sent", points: [] }, { label: "messages received", points: [] }] })?.why, "no messages sent or messages received in 14 days");
  assert.equal(idleOf({ kind: "lambda", health: "ok" }, { now, windowDays: 14, activity: [series("invocations", [0, 0, 3])] }), undefined);
  // metrics win over a provider's last-activity time
  assert.equal(idleOf({ kind: "s3", health: "ok", lastActivityAt: now - 90 * DAY }, { now, windowDays: 14, activity: [series("requests", [1])] }), undefined);
  assert.equal(idleOf({ kind: "s3", health: "ok", lastActivityAt: now - DAY }, { now, windowDays: 14, activity: [series("requests", [0])] })?.why, "no requests in 14 days");
  assert.equal(idleOf({ kind: "loadbalancer", health: "ok" }, { now, windowDays: 14, activity: [series("requests per day (idle check)", [0])] })?.why, "no requests in 14 days", "full F16 labels read as the thing counted");
});

test("without metrics: an old last activity, or stopped since before the window", () => {
  const old = now - 40 * DAY;
  assert.deepEqual(idleOf({ kind: "sqs", health: "ok", lastActivityAt: old }, { now, windowDays: 14 }), { since: old, why: "last activity 2026-08-18, over 14 days ago" });
  assert.deepEqual(idleOf({ kind: "ec2-instance", health: "stopped", lastActivityAt: old }, { now, windowDays: 14 }), { since: old, why: "stopped since 2026-08-18" });
  assert.equal(idleOf({ kind: "sqs", health: "ok", lastActivityAt: now - 3 * DAY }, { now, windowDays: 14 }), undefined);
});

test("never idle without evidence, when too new, or for externals", () => {
  assert.equal(idleOf({ kind: "lambda", health: "ok" }, { now, windowDays: 14 }), undefined);
  assert.equal(idleOf({ kind: "ec2-instance", health: "stopped" }, { now, windowDays: 14 }), undefined, "stopped, but since when?");
  assert.equal(idleOf({ kind: "lambda", health: "ok", createdAt: now - 2 * DAY }, { now, windowDays: 14, activity: [series("invocations", [0])] }), undefined);
  assert.equal(idleOf({ kind: "external", health: "unknown", lastActivityAt: 1 }, { now, windowDays: 14 }), undefined);
  assert.deepEqual([idleDaysOf(undefined), idleDaysOf(30), idleDaysOf(0), idleDaysOf(1.5), idleDaysOf(999)], [14, 30, 14, 14, 14]);
});

test("R20 (REVIEW): Lambda Invocations unavailable and Errors empty is not idle — the evidence is insufficient", () => {
  const fn = { kind: "lambda" as const, health: "ok" as const };
  // What the inventory passes now: the required series that couldn't be read has no points.
  const r = idleEvidenceOf(fn, { now, windowDays: 14, activity: [{ label: "Invocations", required: true }, { label: "Errors", points: [] }] });
  assert.deepEqual(r, { evidence: "insufficient" });
  // The REVIEW reproduction literally: only the Errors series reached the classifier (the old data flow).
  assert.deepEqual(idleEvidenceOf(fn, { now, windowDays: 14, activity: [{ label: "Errors", points: [] }] }), { evidence: "insufficient" });
  // Both read and both zero: confirmed zero, idle, and the reason names the series that shows use.
  const both = idleEvidenceOf(fn, { now, windowDays: 14, activity: [series("Invocations", [0, 0], true), series("Errors", [0, 0])] });
  assert.equal(both.evidence, "confirmed-zero");
  assert.equal(both.idle?.why, "no Invocations in 14 days");
  // An optional series that can't be read doesn't matter once the required ones are in.
  assert.equal(idleEvidenceOf(fn, { now, windowDays: 14, activity: [series("Invocations", [0], true), { label: "Errors" }] }).evidence, "confirmed-zero");
});

test("R20: unmarked series — every non-error series is required; errors alone never make a resource idle", () => {
  const q = { kind: "sqs" as const, health: "ok" as const };
  // one of two usage series unread → insufficient
  assert.equal(idleEvidenceOf(q, { now, windowDays: 14, activity: [series("Messages sent", [0]), { label: "Messages received" }] }).evidence, "insufficient");
  // activity anywhere (even only on an error counter, even when a required series is missing) → used
  assert.equal(idleEvidenceOf(q, { now, windowDays: 14, activity: [{ label: "Messages sent", required: true }, series("Errors", [2])] }).evidence, "activity");
  // a resource that declares only error counters is never idle
  assert.equal(idleOf({ kind: "lambda", health: "ok" }, { now, windowDays: 14, activity: [series("Errors", [0]), series("Throttles", [0])] }), undefined);
  assert.deepEqual(["Errors", "Throttles", "5XX errors", "4xx", "Dead-letter errors", "Invocations", "Requests", "CPU %"].map(isErrorCounter), [true, true, true, true, true, false, false, false]);
  // no metrics declared at all (simulated account): the provider's own last activity still counts
  assert.equal(idleEvidenceOf(q, { now, windowDays: 14, activity: [] }).evidence, "none");
  assert.equal(idleEvidenceOf({ ...q, lastActivityAt: now - 40 * DAY }, { now, windowDays: 14 }).evidence, "provider");
});

test("CC-10: the hourly metric budget is a token bucket; spend in the last hour and its monthly cost", () => {
  const per = 5000;
  let { bucket, granted } = takeTokens(undefined, 3000, now, per);
  assert.equal(granted, 3000);
  ({ bucket, granted } = takeTokens(bucket, 3000, now + 1000, per));
  assert.equal(granted, 2001, "2,000 left, plus a second's refill (5000/3600 ≈ 1.4)");
  ({ bucket, granted } = takeTokens(bucket, 10, now + 2000, per));
  assert.equal(granted, 1, "refill is continuous, never more than accrued");
  assert.equal(metricsLastHour(bucket, now + 2000), 5002);
  // half an hour later: half the budget is back
  ({ bucket, granted } = takeTokens(bucket, 10_000, now + HOUR / 2 + 2000, per));
  assert.ok(granted >= 2499 && granted <= 2501, String(granted));
  // after an hour, the first spends fall out of the last-hour count; the bucket never holds more than one hour's worth
  assert.equal(metricsLastHour(bucket, now + HOUR + 5000), granted);
  assert.equal(takeTokens(bucket, 1e9, now + 10 * HOUR, per).granted, per);
  assert.equal(takeTokens(undefined, 50, now, 0).granted, 0, "budget 0 = no activity metrics");
  assert.equal(estMonthlyUsd(5000), 36);
  assert.equal(estMonthlyUsd(0), 0);
  assert.deepEqual([activityBudgetOf(undefined), activityBudgetOf(""), activityBudgetOf("1200"), activityBudgetOf("0"), activityBudgetOf("-1"), activityBudgetOf("1.5"), activityBudgetOf("lots")], [5000, 5000, 1200, 0, 5000, 5000, 5000]);
});
