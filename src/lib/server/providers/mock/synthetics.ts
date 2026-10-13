// Simulated CloudWatch Synthetics (us-east-1; other regions have none), in DescribeCanaries / DescribeCanariesLastRun
// shapes so the real mapping runs. The story (mock-names CANARY): a browser canary walks the shop's checkout every five
// minutes, and its last run failed — the checkout button no longer appears — so the canary is an error on the map even
// though every service behind it reports healthy. Its run artifacts go to the shared logs bucket.
import type { RawCanary, RawCanaryRun } from "../../../inventory/synthetics.ts";
import { CANARY, REGION, S3 } from "../mock-names.ts";

const MIN = 60_000;
const DAY = 86_400_000;
const now = () => Math.floor(Date.now() / MIN) * MIN;

export function simCanaries(region: string): { canaries: RawCanary[]; lastRuns: Record<string, RawCanaryRun> } {
  if (region !== REGION) return { canaries: [], lastRuns: {} };
  const t = now();
  const canary: RawCanary = {
    Id: "0acme0c9-1111-4222-8333-000000000001", Name: CANARY.name,
    Code: { Handler: "checkout.handler" },
    Schedule: { Expression: "rate(5 minutes)", DurationInSeconds: 0 },
    RunConfig: { TimeoutInSeconds: 60, MemoryInMB: 1500, ActiveTracing: true },
    SuccessRetentionPeriodInDays: 7, FailureRetentionPeriodInDays: 31,
    Status: { State: "RUNNING" },
    Timeline: { Created: new Date(t - 160 * DAY), LastModified: new Date(t - 12 * DAY), LastStarted: new Date(t - 12 * DAY) },
    ArtifactS3Location: `${S3.logs.name}/canary/${REGION}/${CANARY.name}`,
    RuntimeVersion: "syn-nodejs-puppeteer-9.1",
    Tags: { Environment: "production", Checks: "checkout" },
  };
  const last: RawCanaryRun = {
    Id: "0acme0ca-2222-4333-8444-000000000001", Name: CANARY.name,
    Status: { State: CANARY.lastRun, StateReason: "Waiting for selector `#checkout-button` failed: timeout 30000ms exceeded", StateReasonCode: "CANARY_FAILURE" },
    Timeline: { Started: new Date(t - 4 * MIN), Completed: new Date(t - 4 * MIN + 41_000) },
  };
  return { canaries: [canary], lastRuns: { [CANARY.name]: last } };
}
