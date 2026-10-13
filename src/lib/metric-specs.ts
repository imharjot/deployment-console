// CloudWatch metric specs for the panels and Metrics page, as pure data (F16, F70). Each spec names the chart it
// belongs to, its series label, the scale to apply to raw values and the unit after scaling. Callers add an `id`
// and pass them to Cloud.metrics(); values are multiplied by `scale` (default 1).
//
// Units: RDS reports bytes for memory and storage; they are shown in binary units (MiB, GiB) so 20 GiB of storage
// reads as 20, not 21.5. Sum statistics are per bucket: multiply by perMinuteScale(period) to show "/min".

export type MetricStat = "Average" | "Maximum" | "Minimum" | "Sum" | "p50" | "p90" | "p95" | "p99";

export interface ChartMetricSpec {
  chart: string; // series with the same chart id are drawn together
  label: string;
  namespace: string;
  metric: string;
  dims: Record<string, string>;
  stat: MetricStat;
  scale?: number;
  unit: string; // after scaling
}

const MIB = 1 / 1024 ** 2;
const GIB = 1 / 1024 ** 3;

// The period Cloud.metrics() uses for a window (aws.ts and the mock): 1 min up to 3 h, 5 min up to a day, else 1 h.
export const periodFor = (minutes: number) => (minutes <= 180 ? 60 : minutes <= 1440 ? 300 : 3600);

// A Sum over a `periodSec` bucket → per minute.
export const perMinuteScale = (periodSec: number) => 60 / periodSec;

export function rdsSpecs(id: string, label?: string): ChartMetricSpec[] {
  const dims = { DBInstanceIdentifier: id };
  const l = (x: string) => (label ? `${label} ${x}` : x);
  const s = (chart: string, x: string, metric: string, stat: MetricStat, unit: string, scale?: number): ChartMetricSpec => ({
    chart, label: l(x), namespace: "AWS/RDS", metric, dims, stat, unit, ...(scale !== undefined ? { scale } : {}),
  });
  return [
    s("dbcpu", "CPU", "CPUUtilization", "Average", "%"),
    s("dbconn", "Connections", "DatabaseConnections", "Average", ""),
    s("dblat", "Read", "ReadLatency", "Average", "ms", 1000),
    s("dblat", "Write", "WriteLatency", "Average", "ms", 1000),
    s("dbiops", "Read", "ReadIOPS", "Average", "IOPS"),
    s("dbiops", "Write", "WriteIOPS", "Average", "IOPS"),
    s("dbmem", "Freeable memory", "FreeableMemory", "Minimum", "MiB", MIB),
    s("dbdisk", "Free storage", "FreeStorageSpace", "Minimum", "GiB", GIB),
  ];
}

// Per node: CacheClusterId is a node group member ("acme-redis-001"), not the replication group id.
export function elasticacheSpecs(cacheClusterId: string, label?: string): ChartMetricSpec[] {
  const dims = { CacheClusterId: cacheClusterId };
  const l = (x: string) => (label ? `${label} ${x}` : x);
  const s = (chart: string, x: string, metric: string, stat: MetricStat, unit: string): ChartMetricSpec => ({
    chart, label: l(x), namespace: "AWS/ElastiCache", metric, dims, stat, unit,
  });
  return [
    s("cachecpu", "CPU", "CPUUtilization", "Average", "%"),
    s("cacheengine", "Engine CPU", "EngineCPUUtilization", "Average", "%"),
    s("cachemem", "Memory used", "DatabaseMemoryUsagePercentage", "Average", "%"),
    s("cacheconn", "Connections", "CurrConnections", "Average", ""),
    s("cacheevict", "Evictions", "Evictions", "Sum", ""),
  ];
}

// Load balancer traffic for one target group (tgDim "targetgroup/<name>/<id>") on its OWN load balancer (lbDim
// "app/<name>/<id>"), R22: RequestCount (not RequestCountPerTarget, which is divided by the number of targets).
// Without a target group: the load balancer as a whole. Without a load balancer nothing is queryable — ALB metrics
// for a target group are published only together with its LoadBalancer dimension — so the result is empty.
// Sum series are per bucket; scale them with perMinuteScale(period) for "/min".
export function albSpecs(tgDim: string | undefined, lbDim?: string, label?: string): ChartMetricSpec[] {
  if (!lbDim) return [];
  const dims: Record<string, string> = tgDim ? { TargetGroup: tgDim, LoadBalancer: lbDim } : { LoadBalancer: lbDim };
  const ns = "AWS/ApplicationELB";
  const l = (x: string) => label ?? x;
  return [
    { chart: "req", label: l("Requests"), namespace: ns, metric: "RequestCount", dims, stat: "Sum", unit: "/min" },
    { chart: "5xx", label: l("Target 5xx"), namespace: ns, metric: "HTTPCode_Target_5XX_Count", dims, stat: "Sum", unit: "/min" },
    { chart: "rejected", label: l("Load balancer 503"), namespace: ns, metric: "HTTPCode_ELB_503_Count", dims: { LoadBalancer: lbDim }, stat: "Sum", unit: "/min" },
    { chart: "p95", label: l("Latency p95"), namespace: ns, metric: "TargetResponseTime", dims, stat: "p95", scale: 1000, unit: "ms" },
  ];
}
