// Idle detection for the cloud map, pure (tested in idle.test.ts). A resource is idle when there is evidence nobody
// uses it over the idle window (default 14 days, `inventory.idleDays` in console.config.json):
//   - activity metrics (CloudWatch, summed over the window): every series that shows use was read and is zero, and no
//     series at all shows activity — metrics win over anything a provider says;
//   - no metrics, but the provider's own last activity (`lastActivityAt`) is older than the window;
//   - it is stopped (EC2 instance, ECS service at 0 tasks) and has been since before the window.
// No evidence, no mark: a resource without metrics or a last-activity time is never idle, and one created inside the
// window is too new to judge.
//
// R20: evidence must be complete. A provider marks the series that show use as `required` (Lambda Invocations, not
// Errors). When a required series could not be read (the query failed or was denied, it wasn't asked yet, or the hourly
// budget held it back) the evidence is insufficient: never idle, and the inventory notes facts.idleEvidence
// "insufficient". Zero activity ("confirmed zero") and unreadable metrics are different things. Without any `required`
// mark, every series that isn't an error counter is required; error counters (Errors, Throttles, 5XX…) alone never make
// a resource idle — a busy function with no errors has no errors.
//
// Also here: the hourly budget for those metric reads (CC-10). GetMetricData is billed per metric ($0.01 per 1,000), and
// the map is rebuilt every couple of minutes while someone looks at it, so reads are capped per hour (a token bucket,
// CONSOLE_ACTIVITY_BUDGET, default 5,000 an hour) and Settings shows the metric count and its monthly cost.
import type { Resource } from "./types.ts";

export const DEFAULT_IDLE_DAYS = 14;
const DAY = 86_400_000;
const HOUR = 3_600_000;

// One activity metric over the window, one point per day ([timestamp ms, value]). An empty list is a successful query
// that found nothing (CloudWatch publishes no datapoints for a metric nobody touched); no `points` at all is a series
// that wasn't read.
export interface ActivitySeries {
  label: string; // "Invocations", "Messages sent"
  points?: [number, number][]; // undefined = not read (failed, denied, not asked yet, over the hourly budget)
  required?: boolean; // R20: this series shows the resource is used
}

export interface IdleInput {
  now: number;
  windowDays: number;
  activity?: ActivitySeries[]; // undefined = no metrics for this resource (none declared, or simulated data)
}

// How the idle decision was reached. "insufficient": metrics are declared, but a series that shows use couldn't be read.
export type IdleEvidence = "confirmed-zero" | "activity" | "insufficient" | "provider" | "none";

// Counters of failures, not of use: on their own they never prove a resource is unused.
const ERROR_COUNTER = /error|fault|fail|throttl|reject|dead.?letter|\b[45]xx\b|timeout/i;
export const isErrorCounter = (label: string) => ERROR_COUNTER.test(label);

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const total = (s: ActivitySeries) => (s.points ?? []).reduce((b, [, v]) => b + (Number.isFinite(v) ? Math.abs(v) : 0), 0);

export function idleEvidenceOf(r: Pick<Resource, "kind" | "health" | "lastActivityAt" | "createdAt">, input: IdleInput): { idle?: Resource["idle"]; evidence: IdleEvidence } {
  if (r.kind === "external") return { evidence: "none" };
  const windowMs = input.windowDays * DAY;
  const cutoff = input.now - windowMs;
  if (r.createdAt && r.createdAt > cutoff) return { evidence: "none" };
  const old = r.lastActivityAt !== undefined && r.lastActivityAt < cutoff ? r.lastActivityAt : undefined;
  const series = input.activity ?? [];
  if (series.length) {
    // Activity on any series that was read — required or not — means it is used.
    if (series.some((s) => s.points && total(s) > 0)) return { evidence: "activity" };
    const marked = series.filter((s) => s.required);
    const usage = marked.length ? marked : series.filter((s) => !isErrorCounter(s.label));
    if (!usage.length || usage.some((s) => !s.points)) return { evidence: "insufficient" };
    // Providers label activity series in full ("requests per day (idle check)"); the reason names the thing counted.
    const what = [...new Set(usage.map((s) => s.label.replace(/ per day.*$/, "")))].join(" or ");
    return { idle: { since: old, why: `${r.health === "stopped" ? "stopped; " : ""}no ${what} in ${input.windowDays} days` }, evidence: "confirmed-zero" };
  }
  if (old === undefined) return { evidence: "none" };
  if (r.health === "stopped") return { idle: { since: old, why: `stopped since ${day(old)}` }, evidence: "provider" };
  return { idle: { since: old, why: `last activity ${day(old)}, over ${input.windowDays} days ago` }, evidence: "provider" };
}

export function idleOf(r: Pick<Resource, "kind" | "health" | "lastActivityAt" | "createdAt">, input: IdleInput): Resource["idle"] {
  return idleEvidenceOf(r, input).idle;
}

// console.config.json `inventory.idleDays`, clamped to 1–365.
export const idleDaysOf = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 365 ? v : DEFAULT_IDLE_DAYS);

// ---------- the hourly metric budget (CC-10) ----------

export const DEFAULT_ACTIVITY_BUDGET = 5000;
export const USD_PER_METRIC = 0.01 / 1000; // GetMetricData, standard pricing

// CONSOLE_ACTIVITY_BUDGET: metrics an hour, 0 (no activity metrics at all) to 1,000,000. Anything else: the default.
export function activityBudgetOf(v: string | undefined): number {
  const n = v === undefined || v.trim() === "" ? NaN : Number(v);
  return Number.isInteger(n) && n >= 0 && n <= 1_000_000 ? n : DEFAULT_ACTIVITY_BUDGET;
}

// A token bucket that refills `perHour` tokens an hour (continuously, never above `perHour`), plus the log of what was
// spent in the last hour.
export interface Bucket {
  tokens: number;
  at: number;
  spent: [number, number][]; // [when, metrics], the last hour only
}

const prune = (spent: [number, number][], now: number) => spent.filter(([at]) => now - at < HOUR);

// Takes up to `want` tokens. Pure: returns the new bucket and how many were granted.
export function takeTokens(b: Bucket | undefined, want: number, now: number, perHour: number): { bucket: Bucket; granted: number } {
  const start: Bucket = b ?? { tokens: perHour, at: now, spent: [] };
  const refill = Math.max(0, now - start.at) * (perHour / HOUR);
  const tokens = Math.min(perHour, start.tokens + refill);
  const granted = Math.max(0, Math.min(Math.floor(want), Math.floor(tokens)));
  const spent = prune(start.spent, now);
  if (granted > 0) spent.push([now, granted]);
  return { bucket: { tokens: tokens - granted, at: now, spent }, granted };
}

export const metricsLastHour = (b: Bucket | undefined, now: number) => prune(b?.spent ?? [], now).reduce((a, [, n]) => a + n, 0);

// What a steady rate of metrics an hour costs in a 30-day month, in dollars (two decimals).
export const estMonthlyUsd = (perHour: number) => Math.round(perHour * 24 * 30 * USD_PER_METRIC * 100) / 100;
