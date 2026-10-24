// Actual-spend analysis over Cost Explorer data. Pure (no AWS, no server-only) so node:test can run it, and so the
// UI can import the view types: date windows, the month-end projection, the same-point comparison, spikes, mapping
// cost-allocation tags to environments, and assembling the view. server/billing.ts fetches a snapshot through the
// Billing source (a fixed, small set of billed Cost Explorer requests) and calls buildSpend() on it per request, so
// config changes (spike threshold, env names) apply without paying for another snapshot.
import { usd, type Rates, type RunItem } from "./costs.ts";

export type Day = string; // "YYYY-MM-DD" in UTC — Cost Explorer's calendar

// ---------- dates ----------
const DAY_MS = 86_400_000;
const t = (d: Day) => Date.parse(`${d}T00:00:00Z`);
export const isoDay = (ms: number): Day => new Date(ms).toISOString().slice(0, 10);
export const addDays = (d: Day, n: number): Day => isoDay(t(d) + n * DAY_MS);
export const monthStart = (d: Day): Day => `${d.slice(0, 7)}-01`;
const shiftMonth = (d: Day, n: number): Day => {
  const x = new Date(t(monthStart(d)));
  x.setUTCMonth(x.getUTCMonth() + n);
  return isoDay(x.getTime());
};
export const nextMonthStart = (d: Day) => shiftMonth(d, 1);
export const prevMonthStart = (d: Day) => shiftMonth(d, -1);
export const daysInMonth = (d: Day) => Math.round((t(nextMonthStart(d)) - t(monthStart(d))) / DAY_MS);
export const dayOfMonth = (d: Day) => Number(d.slice(8, 10));
export function daysBetween(from: Day, toExclusive: Day): Day[] {
  const out: Day[] = [];
  for (let d = from; d < toExclusive; d = addDays(d, 1)) out.push(d);
  return out;
}

// The date ranges one snapshot asks for. Cost Explorer ranges are [Start, End) — End = tomorrow includes today's
// partial numbers and keeps Start < End on the 1st. Daily data reaches back to the start of last month (last month's
// total, the same-point comparison) and at least 35 days (the 30-day chart, 7-vs-21-day spikes).
export function windowOf(today: Day) {
  const lastMonth = prevMonthStart(today);
  const back35 = addDays(today, -35);
  return {
    today,
    tomorrow: addDays(today, 1),
    month: monthStart(today),
    nextMonth: nextMonthStart(today),
    lastMonth,
    dailyFrom: lastMonth < back35 ? lastMonth : back35,
    anomaliesFrom: addDays(today, -30),
  };
}

// ---------- snapshot: what the Billing source returned, normalised ----------

export type CeErrorCode = "denied" | "not-enabled" | "throttled" | "error";
export type Part<T> = ({ status: "ok" } & T) | { status: "unavailable"; code: CeErrorCode; reason: string };

export interface RawAnomaly {
  id: string;
  start?: Day;
  end?: Day; // unset while the anomaly is still open
  service?: string;
  region?: string;
  usageType?: string;
  impact: number; // total impact, USD above expected
  actual?: number;
  expected?: number;
  pct?: number;
  score: number;
}

export interface SpendSnapshot {
  v: 1;
  fetchedAt: number;
  today: Day;
  source: "aws" | "mock";
  requests: number; // billed Cost Explorer requests this snapshot made ($0.01 each)
  estimated: boolean; // AWS marks the open month as estimated until the invoice closes
  daily: Record<Day, Record<string, number>>; // day → AWS service → USD
  tagKey: string;
  tags: Part<{ rows: { tag: string; service: string; amount: number }[] }>; // month to date by (tagKey, aws:ecs:serviceName)
  forecast: Part<{ amount: number | null }>; // spend AWS expects from today to month end; null = too little history
  anomalies: Part<{ items: RawAnomaly[] }>;
}

// ---------- errors → what to do ----------

export function classifyCeError(name: string | undefined, message: string | undefined): CeErrorCode {
  const n = name ?? "", m = (message ?? "").toLowerCase();
  if (m.includes("not enabled for cost explorer") || (m.includes("cost explorer") && m.includes("not enabled"))) return "not-enabled";
  if (/AccessDenied|Unauthorized|NotAuthorized|Forbidden/i.test(n) || m.includes("not authorized") || m.includes("access denied")) return "denied";
  if (/Throttl|LimitExceeded|TooManyRequests/i.test(n) || m.includes("rate exceeded")) return "throttled";
  return "error";
}

export const SPLIT_COST_TAG = "aws:ecs:clusterName";
export const SERVICE_TAG = "aws:ecs:serviceName";

export function fixFor(code: CeErrorCode, part: "costs" | "anomalies"): string[] {
  if (code === "not-enabled")
    return [
      "Enable Cost Explorer: open Billing and Cost Management → Cost Explorer once, signed in as an account administrator. It is free to enable.",
      "AWS needs up to 24 hours to prepare the data after the first launch.",
    ];
  if (code === "denied")
    return part === "anomalies"
      ? ["Grant the console's role ce:GetAnomalies (it is in the CostsRead statement of the shipped policies)."]
      : [
          "Grant the console's role ce:GetCostAndUsage, ce:GetCostForecast and ce:GetAnomalies — the CostsRead statement in infra/iam-policy.json and infra/iam-policy-readonly.json.",
          "In an AWS Organizations member account, the management account must also let member accounts use Cost Explorer (Billing → Cost Management preferences).",
        ];
  if (code === "throttled") return ["Cost Explorer throttled the request. Try Refresh again in a few minutes."];
  return ["The console's log has the full error. Estimates below don't need Cost Explorer and still work."];
}

export function tagFix(tagKey: string): string[] {
  return tagKey === SPLIT_COST_TAG
    ? [
        "Turn on split cost allocation data for Amazon ECS: Billing and Cost Management → Cost Management preferences → Split cost allocation data.",
        `Activate the ${SPLIT_COST_TAG} and ${SERVICE_TAG} cost allocation tags: Billing and Cost Management → Cost allocation tags → AWS-generated.`,
        "Data starts within 24 hours of activation and is not back-filled, so this month fills in from then on.",
      ]
    : [
        `Activate the ${tagKey} cost allocation tag: Billing and Cost Management → Cost allocation tags → User-defined.`,
        `Tag each environment's resources with ${tagKey}=<environment id or cluster name>. Data starts within 24 hours and is not back-filled.`,
      ];
}

// ---------- analysis ----------

type Daily = SpendSnapshot["daily"];

export function sumDays(daily: Daily, from: Day, toExclusive: Day, service?: string): number {
  let s = 0;
  for (const [d, byService] of Object.entries(daily)) {
    if (d < from || d >= toExclusive) continue;
    if (service !== undefined) s += byService[service] ?? 0;
    else for (const v of Object.values(byService)) s += v;
  }
  return s;
}

export interface SamePoint {
  days: number; // full days compared (today is partial, so it's left out of both sides)
  thisMonth: number;
  lastMonth: number;
  changePct: number | null; // null when last month had no spend in the window
}

export function samePoint(daily: Daily, today: Day): SamePoint | null {
  const days = dayOfMonth(today) - 1;
  if (days < 1) return null;
  const lm = prevMonthStart(today);
  const thisMonth = sumDays(daily, monthStart(today), today);
  const lastMonth = sumDays(daily, lm, addDays(lm, Math.min(days, daysInMonth(lm))));
  return { days, thisMonth, lastMonth, changePct: lastMonth > 0.005 ? ((thisMonth - lastMonth) / lastMonth) * 100 : null };
}

export interface Forecast {
  monthEnd: number;
  method: "aws" | "run-rate";
  note?: string;
  runRate?: number; // month end at the last 7 days' average, when AWS's forecast assumes a very different daily spend
}

// Month end = full days so far + the rest of the month. AWS's forecast covers [today, month end) when it has one;
// otherwise the last 7 full days' average runs the rest of the month (explained in `note`). AWS's model learns from
// months of history and lags a recent change (services scaled to zero, a new fleet): when the daily spend it assumes is
// over twice, or under half, the 7-day average, the run-rate figure comes along and `note` says why.
export function projectMonthEnd(daily: Daily, today: Day, forecast: SpendSnapshot["forecast"]): Forecast | null {
  const done = sumDays(daily, monthStart(today), today);
  const avg = sumDays(daily, addDays(today, -7), today) / 7;
  const left = daysInMonth(today) - dayOfMonth(today) + 1;
  if (forecast.status === "ok" && forecast.amount !== null) {
    const assumed = forecast.amount / left;
    const off = Math.max(assumed, avg) >= 1 && (assumed > 2 * avg || assumed < avg / 2);
    const runRate = done + avg * left;
    return {
      monthEnd: done + forecast.amount, method: "aws",
      ...(off ? { runRate, note: `AWS's forecast assumes ${usd(assumed)}/day for the rest of the month; the last 7 days averaged ${usd(avg)}/day — ${usd(runRate)} at that rate.` } : {}),
    };
  }
  if (!avg && !done) return null;
  const why = forecast.status === "ok" ? "AWS doesn't have enough history to forecast yet" : `AWS forecast unavailable (${forecast.reason})`;
  return { monthEnd: done + avg * left, method: "run-rate", note: `${why} — projected from the last 7 days' average.` };
}

export interface Spike {
  service: string;
  label: string;
  recentDaily: number; // average over the last 7 full days
  baselineDaily: number; // average over the 21 days before that
  changePct: number | null; // null = new (no spend in the baseline)
  extraMonthly: number; // what the increase costs over a month at this rate
}

const DAYS_PER_MONTH = 730 / 24;

// Services whose last-7-day daily average is more than `percent` above the prior 21 days' average. Today (partial)
// is excluded; `minDailyUsd` keeps pennies from becoming headlines (a $0.02 → $0.05 day is +150 %).
export function spikes(daily: Daily, today: Day, percent: number, minDailyUsd = 1): Spike[] {
  const recentFrom = addDays(today, -7), baseFrom = addDays(today, -28);
  const services = new Set(Object.entries(daily).filter(([d]) => d >= baseFrom && d < today).flatMap(([, v]) => Object.keys(v)));
  const out: Spike[] = [];
  for (const service of services) {
    const recentDaily = sumDays(daily, recentFrom, today, service) / 7;
    const baselineDaily = sumDays(daily, baseFrom, recentFrom, service) / 21;
    const delta = recentDaily - baselineDaily;
    if (delta < minDailyUsd) continue;
    const changePct = baselineDaily > 0.005 ? (delta / baselineDaily) * 100 : null;
    if (changePct !== null && changePct <= percent) continue;
    out.push({ service, label: serviceLabel(service), recentDaily, baselineDaily, changePct, extraMonthly: delta * DAYS_PER_MONTH });
  }
  return out.sort((a, b) => b.extraMonthly - a.extraMonthly);
}

// Cost Explorer's SERVICE names are long ("Amazon Elastic Compute Cloud - Compute"); the UI shows these.
const SHORT: Record<string, string> = {
  "Amazon Elastic Container Service": "ECS · Fargate",
  "Amazon Elastic Compute Cloud - Compute": "EC2 instances",
  "EC2 - Other": "EC2 other · EBS, NAT, transfer",
  "Amazon Relational Database Service": "RDS",
  "Amazon ElastiCache": "ElastiCache",
  "Amazon Elastic Load Balancing": "Load balancers",
  AmazonCloudWatch: "CloudWatch",
  "Amazon EC2 Container Registry (ECR)": "ECR",
  "Amazon Simple Storage Service": "S3",
  "Amazon Virtual Private Cloud": "VPC · public IPv4",
  "AWS Key Management Service": "KMS",
  "AWS Secrets Manager": "Secrets Manager",
  "Amazon Simple Queue Service": "SQS",
  "Amazon Simple Notification Service": "SNS",
};
export const serviceLabel = (s: string) => SHORT[s] ?? (s.replace(/^(Amazon|AWS)\s*/, "") || s);

// ---------- cost-allocation tags → environments ----------

export interface EnvRef {
  id: string;
  label: string;
  cluster: string;
  protected: boolean;
}

export interface EnvSpend {
  key: string; // the tag value
  label: string;
  env?: string; // set when the value is a discovered environment
  protected?: boolean;
  amount: number;
}

export interface EnvBreakdown {
  status: "ok" | "no-data" | "unavailable";
  tagKey: string;
  rows: EnvSpend[]; // tagged spend, largest first
  untagged: number; // everything without the tag: RDS, NAT, load balancers, … unless you tag them yourself
  reason?: string;
  fix?: string[];
}

export interface EcsServiceSpend {
  env?: string;
  envLabel: string;
  service: string; // ECS service name
  name: string; // display name from discovery
  amount: number;
}

export interface EcsBreakdown {
  status: "ok" | "no-data" | "unavailable";
  rows: EcsServiceSpend[];
  reason?: string;
  fix?: string[];
}

// Cluster-name tags match on the cluster; a user-defined tag may hold the env id, its label or its cluster.
export function envForTag(value: string, envs: EnvRef[], tagKey: string): EnvRef | undefined {
  if (!value) return undefined;
  if (tagKey === SPLIT_COST_TAG) return envs.find((e) => e.cluster === value);
  const v = value.toLowerCase();
  return envs.find((e) => e.id === v || e.cluster.toLowerCase() === v || e.label.toLowerCase() === v);
}

export function breakdowns(snap: Pick<SpendSnapshot, "tags" | "tagKey">, envs: EnvRef[], names: Record<string, string>): { envs: EnvBreakdown; ecs: EcsBreakdown } {
  const { tags, tagKey } = snap;
  if (tags.status !== "ok") {
    const fix = fixFor(tags.code, "costs");
    return { envs: { status: "unavailable", tagKey, rows: [], untagged: 0, reason: tags.reason, fix }, ecs: { status: "unavailable", rows: [], reason: tags.reason, fix } };
  }
  const byTag = new Map<string, number>();
  const bySvc = new Map<string, EcsServiceSpend>();
  let untagged = 0;
  for (const r of tags.rows) {
    if (!r.tag) untagged += r.amount;
    else byTag.set(r.tag, (byTag.get(r.tag) ?? 0) + r.amount);
    if (!r.service) continue;
    const env = envForTag(r.tag, envs, tagKey);
    const k = `${r.tag}/${r.service}`;
    const cur = bySvc.get(k) ?? { env: env?.id, envLabel: env?.label ?? (r.tag || "untagged"), service: r.service, name: (env && names[`${env.id}/${r.service}`]) || r.service, amount: 0 };
    cur.amount += r.amount;
    bySvc.set(k, cur);
  }
  const rows: EnvSpend[] = [...byTag.entries()]
    .map(([key, amount]) => {
      const env = envForTag(key, envs, tagKey);
      return { key, label: env?.label ?? key, env: env?.id, protected: env?.protected, amount };
    })
    .filter((r) => Math.abs(r.amount) >= 0.005)
    .sort((a, b) => b.amount - a.amount);
  const ecsRows = [...bySvc.values()].filter((r) => Math.abs(r.amount) >= 0.005).sort((a, b) => b.amount - a.amount);
  const fix = tagFix(tagKey);
  return {
    envs: rows.length ? { status: "ok", tagKey, rows, untagged } : { status: "no-data", tagKey, rows, untagged, fix },
    ecs: ecsRows.length ? { status: "ok", rows: ecsRows } : { status: "no-data", rows: [], fix: tagFix(SPLIT_COST_TAG) },
  };
}

// ---------- the views ----------

export interface AnomalyView extends RawAnomaly {
  label: string;
  open: boolean; // no end date, or it ended yesterday or later
}

export interface SpendView {
  status: "ok";
  source: "aws" | "mock";
  fetchedAt: number;
  expiresAt: number;
  requests: number;
  warning?: string; // the last refresh failed; these numbers are from the snapshot before it
  today: Day;
  month: Day;
  lastMonthStart: Day;
  daysInMonth: number;
  estimated: boolean;
  monthToDate: number;
  lastMonth: number;
  samePoint: SamePoint | null;
  forecast: Forecast | null;
  daily: { date: Day; amount: number; partial: boolean }[]; // last 30 days, oldest first; today is partial
  services: { service: string; label: string; amount: number; lastMonth: number }[]; // month to date, largest first
  envs: EnvBreakdown;
  ecsServices: EcsBreakdown;
  anomalies: { status: "ok"; items: AnomalyView[] } | { status: "unavailable"; reason: string; fix: string[] };
  spikes: Spike[];
  spikePercent: number;
}

export interface SpendUnavailable {
  status: "unavailable";
  source: "aws" | "mock";
  code: CeErrorCode;
  reason: string;
  fix: string[];
  at: number;
}

export interface RunRateEnv {
  env: string; // "" for resources not attributed to an environment
  label: string;
  protected: boolean;
  monthly: number;
  items: RunItem[];
  unpriced: string[];
}

export interface RunRateView {
  at: number;
  monthly: number;
  rates: Rates;
  customRates: boolean; // console.config.json → pricing overrides a default
  envs: RunRateEnv[];
  errors: string[]; // discovery errors that leave the estimate incomplete
}

export interface CostsView {
  actual: SpendView | SpendUnavailable;
  estimate: RunRateView;
  refresh: { allowedAt: number; cacheHours: number; requestsPerSnapshot: number };
  settings: { tagKey: string; spikePercent: number };
}

export function buildSpend(s: SpendSnapshot, ctx: { envs: EnvRef[]; names: Record<string, string>; spikePercent: number; ttlMs: number }): SpendView {
  const w = windowOf(s.today);
  const services = [...new Set(Object.values(s.daily).flatMap((v) => Object.keys(v)))]
    .map((service) => ({ service, label: serviceLabel(service), amount: sumDays(s.daily, w.month, w.tomorrow, service), lastMonth: sumDays(s.daily, w.lastMonth, w.month, service) }))
    .filter((x) => Math.abs(x.amount) >= 0.005 || Math.abs(x.lastMonth) >= 0.005)
    .sort((a, b) => b.amount - a.amount || b.lastMonth - a.lastMonth);
  const { envs, ecs } = breakdowns(s, ctx.envs, ctx.names);
  const yesterday = addDays(s.today, -1);
  return {
    status: "ok",
    source: s.source,
    fetchedAt: s.fetchedAt,
    expiresAt: s.fetchedAt + ctx.ttlMs,
    requests: s.requests,
    today: s.today,
    month: w.month,
    lastMonthStart: w.lastMonth,
    daysInMonth: daysInMonth(s.today),
    estimated: s.estimated,
    monthToDate: sumDays(s.daily, w.month, w.tomorrow),
    lastMonth: sumDays(s.daily, w.lastMonth, w.month),
    samePoint: samePoint(s.daily, s.today),
    forecast: projectMonthEnd(s.daily, s.today, s.forecast),
    daily: daysBetween(addDays(s.today, -29), w.tomorrow).map((date) => ({ date, amount: sumDays(s.daily, date, addDays(date, 1)), partial: date === s.today })),
    services,
    envs,
    ecsServices: ecs,
    anomalies:
      s.anomalies.status === "ok"
        ? { status: "ok", items: [...s.anomalies.items].sort((a, b) => b.impact - a.impact).map((a) => ({ ...a, label: a.service ? serviceLabel(a.service) : "Unattributed", open: !a.end || a.end >= yesterday })) }
        : { status: "unavailable", reason: s.anomalies.reason, fix: fixFor(s.anomalies.code, "anomalies") },
    spikes: spikes(s.daily, s.today, ctx.spikePercent),
    spikePercent: ctx.spikePercent,
  };
}
