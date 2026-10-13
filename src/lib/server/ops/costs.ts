// Cost operations for agents and API clients: the spend summary, the run-rate estimate, and a manual refresh.
// Outputs are compact JSON for a language model — rounded dollars, short service names, only what answers
// "what are we spending, where, and is anything unusual" — not the UI's view models. Everything needs `costs`
// (operator and up). The reads serve the cached Cost Explorer snapshot and only pay for a new one (~$0.04) when it is
// older than costs.cacheHours; costs.refresh always pays, is limited to once per 5 minutes and is audited.
import { HttpError } from "../errors.ts";
import { refreshCosts, refreshInfo, runRate, spendView } from "../billing.ts";
import type { SpendUnavailable, SpendView } from "../../spend.ts";
import { defineOps } from "./types.ts";

const usd = (n: number) => Math.round(n * 100) / 100;
const pct = (n: number | null | undefined) => (n === null || n === undefined ? null : Math.round(n * 10) / 10);

function summary(v: SpendView | SpendUnavailable) {
  if (v.status !== "ok") return { available: false, reason: v.reason, fix: v.fix, estimatesStillWork: "use costs.estimate for a list-price run rate" };
  const envs =
    v.envs.status === "ok"
      ? [...v.envs.rows.map((r) => ({ env: r.env ?? r.key, usd: usd(r.amount) })), ...(v.envs.untagged ? [{ env: "(untagged: shared and non-ECS resources)", usd: usd(v.envs.untagged) }] : [])]
      : { unavailable: v.envs.reason ?? `no spend carries the ${v.envs.tagKey} tag yet`, fix: v.envs.fix };
  return {
    available: true,
    currency: "USD",
    asOf: new Date(v.fetchedAt).toISOString(),
    source: v.source,
    ...(v.warning ? { warning: v.warning } : {}),
    month: v.month.slice(0, 7),
    monthToDate: usd(v.monthToDate),
    forecastMonthEnd: v.forecast ? { usd: usd(v.forecast.monthEnd), method: v.forecast.method, ...(v.forecast.note ? { note: v.forecast.note } : {}) } : null,
    lastMonth: usd(v.lastMonth),
    vsSamePointLastMonth: v.samePoint ? { pct: pct(v.samePoint.changePct), thisMonth: usd(v.samePoint.thisMonth), lastMonth: usd(v.samePoint.lastMonth), fullDays: v.samePoint.days } : null,
    topServices: v.services.slice(0, 6).map((s) => ({ service: s.label, usd: usd(s.amount), lastMonthUsd: usd(s.lastMonth) })),
    environments: envs,
    topEcsServices: v.ecsServices.rows.slice(0, 8).map((r) => ({ env: r.env ?? r.envLabel, service: r.service, usd: usd(r.amount) })),
    anomalies:
      v.anomalies.status === "ok"
        ? v.anomalies.items.slice(0, 10).map((a) => ({ service: a.label, start: a.start, end: a.end ?? null, open: a.open, impactUsd: usd(a.impact), pct: pct(a.pct), usageType: a.usageType, region: a.region }))
        : { unavailable: v.anomalies.reason, fix: v.anomalies.fix },
    spikes: v.spikes.map((s) => ({ service: s.label, recentDailyUsd: usd(s.recentDaily), baselineDailyUsd: usd(s.baselineDaily), pct: pct(s.changePct), extraMonthlyUsd: usd(s.extraMonthly) })),
    notes: [
      "Month-to-date includes today's partial numbers; AWS updates cost data a few times a day.",
      "Unblended cost, credits and refunds excluded, tax included.",
      `Spikes: last 7 full days vs the 21 before, more than ${v.spikePercent}% and $1/day higher.`,
    ],
  };
}

export const ops = defineOps([
  {
    name: "costs.summary",
    title: "Summarise AWS spend",
    description:
      "Actual AWS spend from Cost Explorer: month to date, the forecast for month end, last month's total and the change against the same point last month, the top AWS services, spend per environment and per ECS service (from cost allocation tags), cost anomalies from AWS Cost Anomaly Detection and services whose daily spend recently spiked. " +
      "Use it for questions like 'what are we spending', 'why did the bill go up', 'which environment costs most'. Serves a cached snapshot (refreshed at most every few hours); `asOf` says when it was taken. " +
      "If Cost Explorer is not enabled or not permitted it returns available:false with the fix — use costs.estimate instead.",
    risk: "read",
    perm: "costs",
    input: { type: "object", properties: {}, additionalProperties: false },
    run: async () => summary(await spendView()),
  },
  {
    name: "costs.estimate",
    title: "Estimate the monthly run rate",
    description:
      "A free, instant list-price estimate of what runs now, per environment and resource: Fargate tasks (task size × running count, ARM priced lower), EC2 hosts, RDS instances and ElastiCache nodes, as USD per month (730 hours). " +
      "On-demand prices, excluding data transfer, storage, load balancers, NAT gateways, Spot and Savings Plans. Services on EC2 hosts show null with a note — their cost is the host's. " +
      "Use it when Cost Explorer is unavailable, to compare environments by what they run, or to see what a resource costs. Optional `env` limits it to one environment id.",
    risk: "read",
    perm: "costs",
    input: {
      type: "object",
      properties: { env: { type: "string", description: "Environment id, e.g. \"production\". Omit for all.", pattern: "^[a-z0-9][a-z0-9-]{0,62}$" } },
      additionalProperties: false,
    },
    run: async (input: { env?: string }) => {
      const r = await runRate();
      const envs = input.env ? r.envs.filter((e) => e.env === input.env) : r.envs;
      if (input.env && !envs.length) throw new HttpError(404, `unknown environment "${input.env}"`);
      return {
        currency: "USD",
        monthlyTotal: usd(envs.reduce((a, e) => a + e.monthly, 0)),
        note: `List-price estimate${r.customRates ? " (custom rates from console.config.json)" : ", us-east-1 on-demand"}; excludes data transfer, storage, load balancers, NAT, Spot and Savings Plans.`,
        environments: envs.map((e) => ({
          env: e.env || "(not in an environment)",
          label: e.label,
          monthly: usd(e.monthly),
          items: e.items.map((i) => ({ kind: i.kind, name: i.name, detail: i.detail, monthly: i.monthly === null ? null : usd(i.monthly), ...(i.note ? { note: i.note } : {}) })),
          ...(e.unpriced.length ? { noListPrice: e.unpriced } : {}),
        })),
        ...(r.errors.length ? { incomplete: r.errors } : {}),
      };
    },
  },
  {
    name: "costs.refresh",
    title: "Refresh spend from Cost Explorer",
    description:
      "Takes a new Cost Explorer snapshot now instead of waiting for the cached one to expire, then returns the same summary as costs.summary. " +
      "Each snapshot is a few billed Cost Explorer requests (about $0.04), so only use it when the user needs numbers newer than `asOf` — AWS itself updates cost data only a few times a day. " +
      "Refused (HTTP 429) within 5 minutes of the previous snapshot.",
    risk: "change",
    perm: "costs",
    input: { type: "object", properties: {}, additionalProperties: false },
    plan: async () => {
      const { allowedAt, requests } = await refreshInfo();
      const wait = allowedAt - Date.now();
      return {
        summary: `Take a new Cost Explorer snapshot (${requests} billed requests, about $${(requests * 0.01).toFixed(2)})`,
        warnings: wait > 0 ? [`Refused until ${new Date(allowedAt).toISOString()}: one refresh per 5 minutes.`] : undefined,
      };
    },
    run: async (_input: Record<string, never>, ctx) => {
      const v = await refreshCosts(ctx.actor, ctx.ip);
      return summary(v.actual);
    },
  },
]);
