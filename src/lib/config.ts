// Timing and size knobs. Everything about *what* exists (environments, services, databases, connections) is
// discovered from AWS — see src/lib/server/discovery.ts and the optional console.config.json.
export const REGION = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-east-1";

export const LIMITS = {
  staleMs: 30_000,
  deployStuckMs: 15 * 60_000,
  boxBootGraceMs: 5 * 60_000, // after an EC2 host starts, ECS needs a few minutes to place tasks
  failedDeployWindowMs: 60 * 60_000,
  probeFailuresToFail: 2,
  awsTimeoutMs: 5_000,
  githubTimeoutMs: 5_000,
  probeTimeoutMs: 3_000,
  logTailMax: 10_000,
  logSearchMaxRangeMs: 24 * 60 * 60_000,
  awsWriteTimeoutMs: 20_000, // writes get longer than reads: a timed-out write is "outcome unknown", never retried blindly
  logEventsTps: 12, // stay under CloudWatch Logs' GetLogEvents quota (25/s per account and region) with room for others
  logTailMaxStreams: 24, // streams tailed at once; the rest are named in LogPage.note
  logSearchBudgetMs: 8_000, // one search request scans for at most this long, then returns what it has
  capacityGraceMs: 5 * 60_000, // running < desired with no rollout: "starting" for this long, then "short" (R11)
  samplerStaleIntervals: 3, // a sampled overview older than this many sampler intervals is stale (R21)
  activityMetricsPerHour: 5_000, // CloudWatch metric reads per hour for idle detection (cost bound)
};
