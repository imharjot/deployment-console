// Real Billing source: AWS Cost Explorer through the SDK's default credential chain (the task role on ECS).
// Cost Explorer is a global API served from us-east-1 whatever AWS_REGION says, and every request is billed ($0.01):
// billing.ts decides when to call; this file only makes the calls, pages them (bounded) and counts them.
// Read-only: ce:GetCostAndUsage, ce:GetCostForecast, ce:GetAnomalies.
// Credits and refunds are filtered out so the numbers say what running costs, not what the invoice nets to after
// promotional credits (tax stays in).
import "server-only";
import { CostExplorerClient, GetAnomaliesCommand, GetCostAndUsageCommand, GetCostForecastCommand, type Expression } from "@aws-sdk/client-cost-explorer";
import type { RawAnomaly } from "../spend.ts";
import { limitedClient } from "./aws-limiter.ts";
import { connectionCredentials } from "./connection-credentials.ts";
import { perGeneration } from "./connection-state.ts";
import type { Billing, CostRow } from "./billing.ts";

// Few retries: a retried request may be billed again, and a throttled snapshot can simply be retried later. One client
// per AWS connection (connection-state.ts).
const ce = perGeneration(() => limitedClient(new CostExplorerClient({ region: "us-east-1", retryMode: "adaptive", maxAttempts: 2, credentials: connectionCredentials }), "ce", "us-east-1"));
const t = () => ({ abortSignal: AbortSignal.timeout(15_000) }); // Cost Explorer is slower than the regional APIs
const MAX_PAGES = 10; // bounds what one snapshot can cost even for accounts with very many services
const NO_CREDITS: Expression = { Not: { Dimensions: { Key: "RECORD_TYPE", Values: ["Credit", "Refund"] } } };

export function awsBilling(): Billing {
  let count = 0;
  return {
    kind: "aws",
    requests: () => count,

    async costAndUsage(q) {
      const rows: CostRow[] = [];
      const isTag = q.groupBy.map((x) => x.type === "TAG");
      let NextPageToken: string | undefined;
      let pages = 0;
      do {
        count++;
        const r = await ce().send(
          new GetCostAndUsageCommand({
            TimePeriod: { Start: q.start, End: q.end }, Granularity: q.granularity, Metrics: ["UnblendedCost"], Filter: NO_CREDITS,
            GroupBy: q.groupBy.length ? q.groupBy.map((x) => ({ Type: x.type, Key: x.key })) : undefined, NextPageToken,
          }),
          t(),
        );
        for (const p of r.ResultsByTime ?? []) {
          const start = p.TimePeriod?.Start ?? q.start;
          const estimated = !!p.Estimated;
          // Tag group keys come back as "key$value" ("key$" when the resource lacks the tag); tag keys can't contain "$".
          for (const grp of p.Groups ?? []) {
            const keys = (grp.Keys ?? []).map((k, i) => (isTag[i] ? k.slice(k.indexOf("$") + 1) : k));
            rows.push({ start, keys, amount: Number(grp.Metrics?.UnblendedCost?.Amount ?? 0) || 0, estimated });
          }
          if (!q.groupBy.length && p.Total?.UnblendedCost) rows.push({ start, keys: [], amount: Number(p.Total.UnblendedCost.Amount ?? 0) || 0, estimated });
        }
        NextPageToken = r.NextPageToken;
      } while (NextPageToken && ++pages < MAX_PAGES);
      return rows;
    },

    async forecast(start, end) {
      count++;
      try {
        const r = await ce().send(new GetCostForecastCommand({ TimePeriod: { Start: start, End: end }, Metric: "UNBLENDED_COST", Granularity: "MONTHLY", Filter: NO_CREDITS }), t());
        return Number(r.Total?.Amount ?? 0) || 0;
      } catch (e) {
        // New accounts (or ones with a gap in spend) don't have the history AWS needs to forecast.
        if ((e as Error).name === "DataUnavailableException") return null;
        throw e;
      }
    },

    async anomalies(start, end) {
      const out: RawAnomaly[] = [];
      let NextPageToken: string | undefined;
      let pages = 0;
      do {
        count++;
        const r = await ce().send(new GetAnomaliesCommand({ DateInterval: { StartDate: start, EndDate: end }, MaxResults: 50, NextPageToken }), t());
        for (const a of r.Anomalies ?? []) {
          const cause = a.RootCauses?.[0];
          out.push({
            id: a.AnomalyId ?? "", start: a.AnomalyStartDate?.slice(0, 10), end: a.AnomalyEndDate?.slice(0, 10),
            service: cause?.Service ?? a.DimensionValue, region: cause?.Region, usageType: cause?.UsageType,
            impact: a.Impact?.TotalImpact ?? a.Impact?.MaxImpact ?? 0, actual: a.Impact?.TotalActualSpend, expected: a.Impact?.TotalExpectedSpend,
            pct: a.Impact?.TotalImpactPercentage, score: a.AnomalyScore?.MaxScore ?? 0,
          });
        }
        NextPageToken = r.NextPageToken;
      } while (NextPageToken && ++pages < 3);
      return out;
    },
  };
}
