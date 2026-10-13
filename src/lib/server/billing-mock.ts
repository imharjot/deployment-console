// Simulated Billing source for the demo account (Acme, CONSOLE_SOURCE=mock). Answers the same queries Cost Explorer
// would, with realistic, deterministic numbers derived from the date: month-to-date grows through the month, every
// visitor sees the same history, and the per-day amounts line up with what the demo runs (Fargate task sizes, the
// staging t3a.small, the two Postgres instances, the Valkey node). One anomaly is built in: CloudWatch Logs ingestion
// jumped five days ago (a service left at debug log level) — Cost Anomaly Detection reports it and the spike check
// flags it. Requests are counted as if they were billed, so the demo shows what a snapshot would cost.
import "server-only";
import { addDays, daysBetween, isoDay, monthStart, type Day, type RawAnomaly } from "../spend.ts";
import type { Billing, CostQuery, CostRow } from "./billing.ts";

// Cost Explorer SERVICE names → USD per day. `traffic` services follow weekday load and a slow seasonal swing.
const SERVICES: { name: string; daily: number; traffic?: boolean; first?: number }[] = [
  { name: "Amazon Relational Database Service", daily: 6.62 }, // db.t4g.small + db.r6g.large + 120 GB gp3
  { name: "Amazon Elastic Container Service", daily: 2.11 }, // production Fargate tasks
  { name: "EC2 - Other", daily: 1.46, traffic: true }, // NAT gateway, EBS, data transfer
  { name: "AmazonCloudWatch", daily: 0.85, traffic: true },
  { name: "Amazon Elastic Load Balancing", daily: 0.79, traffic: true },
  { name: "Amazon ElastiCache", daily: 0.61 },
  { name: "Amazon Elastic Compute Cloud - Compute", daily: 0.45 }, // the staging host
  { name: "Amazon Virtual Private Cloud", daily: 0.24 }, // public IPv4 addresses
  { name: "Amazon Simple Storage Service", daily: 0.21, traffic: true },
  { name: "Amazon EC2 Container Registry (ECR)", daily: 0.11 },
  { name: "AWS Secrets Manager", daily: 0.08 },
  { name: "AWS Key Management Service", daily: 0.04 },
  { name: "Amazon Route 53", daily: 0.03, first: 1.0 }, // hosted zones are charged on the 1st
];

// Split cost allocation data: Fargate spend by task size (production), the EC2 host by reserved CPU (staging).
const FARGATE_SPLIT: Record<string, number> = { api: 0.04498, worker: 0.02135, billing: 0.01179, "deployment-console": 0.00987 };
const HOST_SPLIT: Record<string, number> = { api: 1024, worker: 512, billing: 256, caddy: 128, redis: 128 };

const ANOMALY = { service: "AmazonCloudWatch", days: 5, factor: 5, usageType: "USE1-DataProcessing-Bytes" };

// FNV-1a → [0, 1): deterministic noise per (day, service).
function noise(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return ((h >>> 0) % 10_000) / 10_000;
}

const dayNumber = (d: Day) => Math.floor(Date.parse(`${d}T00:00:00Z`) / 86_400_000);

function baseline(svc: (typeof SERVICES)[number], d: Day) {
  let v = svc.daily;
  if (svc.traffic) {
    const dow = new Date(`${d}T00:00:00Z`).getUTCDay();
    v *= (dow === 0 || dow === 6 ? 0.86 : 1.04) * (1 + 0.07 * Math.sin((2 * Math.PI * dayNumber(d)) / 365)) * (0.95 + 0.1 * noise(d + svc.name));
  }
  if (svc.first && d.endsWith("-01")) v += svc.first;
  return v;
}

// What AWS has recorded for one service on one day, as of `now`: today is partial (and Cost Explorer lags a few hours).
function amount(svc: (typeof SERVICES)[number], d: Day, now: number) {
  const today = isoDay(now);
  if (d > today) return 0;
  let v = baseline(svc, d);
  if (svc.name === ANOMALY.service && d >= addDays(today, -ANOMALY.days)) v *= ANOMALY.factor;
  if (d === today) v *= Math.max(0, (now % 86_400_000) / 86_400_000 - 0.25);
  return Math.round(v * 1e4) / 1e4;
}

// One service-day split into (cluster, ECS service) pieces the way split cost allocation data would tag it.
function pieces(service: string, v: number): { cluster: string; svc: string; amount: number }[] {
  const split = (cluster: string, w: Record<string, number>) => {
    const total = Object.values(w).reduce((a, x) => a + x, 0);
    return Object.entries(w).map(([svc, x]) => ({ cluster, svc, amount: (v * x) / total }));
  };
  if (service === "Amazon Elastic Container Service") return split("acme-production", FARGATE_SPLIT);
  if (service === "Amazon Elastic Compute Cloud - Compute") return split("acme-staging", HOST_SPLIT);
  return [{ cluster: "", svc: "", amount: v }];
}

function keyOf(g: CostQuery["groupBy"][number], service: string, p: { cluster: string; svc: string }) {
  if (g.type === "DIMENSION") return g.key === "SERVICE" ? service : "";
  return g.key === "aws:ecs:clusterName" ? p.cluster : g.key === "aws:ecs:serviceName" ? p.svc : ""; // other tags: not on anything in the demo
}

export function mockBilling(): Billing {
  let count = 0;
  return {
    kind: "mock",
    requests: () => count,

    async costAndUsage(q) {
      count++;
      const now = Date.now();
      const acc = new Map<string, CostRow>();
      for (const d of daysBetween(q.start, q.end)) {
        const start = q.granularity === "DAILY" ? d : monthStart(d);
        for (const svc of SERVICES) {
          const v = amount(svc, d, now);
          if (!v) continue;
          for (const p of pieces(svc.name, v)) {
            const keys = q.groupBy.map((g) => keyOf(g, svc.name, p));
            const k = `${start}|${keys.join("|")}`;
            const row = acc.get(k) ?? { start, keys, amount: 0, estimated: start >= monthStart(isoDay(now)) };
            row.amount += p.amount;
            acc.set(k, row);
          }
        }
      }
      return [...acc.values()].map((r) => ({ ...r, amount: Math.round(r.amount * 1e4) / 1e4 }));
    },

    async forecast(start, end) {
      count++;
      // Roughly what AWS does: recent level carried forward, a little above the plain baseline.
      return daysBetween(start, end).reduce((a, d) => a + SERVICES.reduce((b, s) => b + baseline(s, d), 0), 0) * 1.03;
    },

    async anomalies(start, end): Promise<RawAnomaly[]> {
      count++;
      const now = Date.now();
      const svc = SERVICES.find((s) => s.name === ANOMALY.service)!;
      const from = addDays(isoDay(now), -ANOMALY.days);
      if (from < start || from > end) return [];
      const days = daysBetween(from, addDays(end, 1));
      const actual = days.reduce((a, d) => a + amount(svc, d, now), 0);
      const expected = days.reduce((a, d) => a + baseline(svc, d) * (d === isoDay(now) ? amount(svc, d, now) / (baseline(svc, d) * ANOMALY.factor) : 1), 0);
      return [{
        id: "demo-anomaly-cloudwatch", start: from, service: ANOMALY.service, region: "us-east-1", usageType: ANOMALY.usageType,
        impact: Math.round((actual - expected) * 100) / 100, actual: Math.round(actual * 100) / 100, expected: Math.round(expected * 100) / 100,
        pct: Math.round(((actual - expected) / expected) * 100), score: 0.87,
      }];
    },
  };
}
