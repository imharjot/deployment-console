// CloudWatch Synthetics provider (audit §6 A.2 #27, CC-20): every canary in the region with its state and its last run
// — a real health signal: a canary whose last run failed is an error even when every service behind it says healthy.
// Links: the Lambda function it runs on, its artifacts bucket, its role and KMS key. The mapping is pure
// (../../inventory/synthetics.ts).
//
// Discovery lists (DescribeCanaries, 20 a page; tags come with it), hands the list to ctx.checkpoint, then reads every
// canary's last run in one pass (DescribeCanariesLastRun, 100 a page) — denied or failed, the canaries stay with an
// unknown health and a note. No activity metrics (the API names no target). Read-only: no actions.
import "server-only";
import { DescribeCanariesCommand, DescribeCanariesLastRunCommand, SyntheticsClient } from "@aws-sdk/client-synthetics";
import { parseArn } from "../../inventory/arn.ts";
import { awsTime, fmtTime } from "../../inventory/serverless-common.ts";
import { canaryEngines, canaryResults, lastRunByCanary, type RawCanary, type RawCanaryRun } from "../../inventory/synthetics.ts";
import type { EnrichState, Prop, Resource, ResourceDetail } from "../../inventory/types.ts";
import { errText } from "../errors.ts";
import { simCanaries } from "./mock/synthetics.ts";
import { paged, perRegion, sdkConfig, t } from "./serverless-util.ts";
import { deniedAction, type Provider, type ProviderContext } from "./types.ts";

const synthetics = perRegion((r) => new SyntheticsClient(sdkConfig(r)), "synthetics");
const regionOf = (r: Resource, fallback: string) => parseArn(r.key)?.region || fallback;

// Every canary's last run, by canary name (a multi-browser canary's failed browser wins). Never throws unless the run's deadline passed: a denial or a failure is
// noted once and comes back as its state.
async function lastRuns(ctx: ProviderContext): Promise<{ runs?: Record<string, RawCanaryRun | undefined>; state: EnrichState }> {
  const c = synthetics(ctx.region);
  try {
    const list = await paged(ctx, "canary last runs", async (NextToken) => {
      const r = await c.send(new DescribeCanariesLastRunCommand({ MaxResults: 100, NextToken }), t(ctx));
      return { items: r.CanariesLastRun, next: r.NextToken };
    }, { service: "synthetics" });
    return { runs: lastRunByCanary(list), state: "ok" };
  } catch (e) {
    if (ctx.signal.aborted) throw e;
    const denied = deniedAction(e);
    ctx.note(denied ? `canary last runs skipped: ${denied} denied` : `canary last runs: ${errText(e)}`);
    return { state: denied ? "denied" : "error" };
  }
}

const row = (label: string, value: string | number | undefined): Prop[] => (value === undefined || value === "" ? [] : [{ label, value: String(value) }]);

export const syntheticsProvider: Provider = {
  id: "synthetics",
  label: "CloudWatch Synthetics",
  kinds: ["synthetics-canary"],
  scope: "regional",
  covers: ["synthetics:canary"],
  ttlMs: 5 * 60_000,
  multiRegionMock: true,
  read: ["synthetics:DescribeCanaries", "synthetics:DescribeCanariesLastRun"],
  async discover(ctx) {
    const base = { region: ctx.region, accountId: ctx.accountId, now: Date.now() };
    if (ctx.mock) {
      const sim = simCanaries(ctx.region);
      return canaryResults({ ...base, canaries: sim.canaries, lastRuns: sim.lastRuns, runsState: "ok" });
    }
    const c = synthetics(ctx.region);
    const canaries = await paged<RawCanary>(ctx, "canaries", async (NextToken) => {
      const r = await c.send(new DescribeCanariesCommand({ MaxResults: 20, NextToken }), t(ctx));
      return { items: r.Canaries, next: r.NextToken };
    }, { service: "synthetics" });
    ctx.checkpoint?.(canaryResults({ ...base, canaries, runsState: "skipped" }));
    if (!canaries.length) return canaryResults({ ...base, canaries });
    const runs = await lastRuns(ctx);
    return canaryResults({ ...base, canaries, lastRuns: runs.runs, runsState: runs.state });
  },
  // The last run as it is now, and what the canary runs.
  async detail(r, ctx): Promise<ResourceDetail> {
    let canary: RawCanary | undefined;
    let run: RawCanaryRun | undefined;
    const notes: string[] = [];
    if (ctx.mock) {
      const sim = simCanaries(regionOf(r, ctx.region));
      canary = sim.canaries.find((x) => x.Name === r.name);
      run = Object.hasOwn(sim.lastRuns, r.name) ? sim.lastRuns[r.name] : undefined;
    } else {
      const c = synthetics(regionOf(r, ctx.region));
      const [a, b] = await Promise.allSettled([
        ctx.limit(() => c.send(new DescribeCanariesCommand({ Names: [r.name] }), t(ctx)), { service: "synthetics" }),
        ctx.limit(() => c.send(new DescribeCanariesLastRunCommand({ Names: [r.name] }), t(ctx)), { service: "synthetics" }),
      ]);
      const why = (e: unknown) => (deniedAction(e) ? `${deniedAction(e)} denied` : errText(e));
      if (a.status === "fulfilled") canary = a.value.Canaries?.find((x) => x.Name === r.name);
      else notes.push(`canary: ${why(a.reason)}`);
      if (b.status === "fulfilled") {
        const runs = lastRunByCanary((b.value.CanariesLastRun ?? []).filter((x) => x.CanaryName === r.name));
        run = Object.hasOwn(runs, r.name) ? runs[r.name] : undefined;
      }
      else notes.push(`last run: ${why(b.reason)}`);
    }
    const started = awsTime(run?.Timeline?.Started), completed = awsTime(run?.Timeline?.Completed);
    return {
      key: r.key,
      sections: [
        run
          ? {
            title: "Last run",
            rows: [
              ...row("Result", run.Status?.State), ...row("Reason", run.Status?.StateReason), ...row("Reason code", run.Status?.StateReasonCode),
              ...row("Started", started ? fmtTime(started) : undefined), ...row("Completed", completed ? fmtTime(completed) : undefined),
              ...row("Duration", started && completed ? `${Math.round((completed - started) / 1000)} s` : undefined),
            ],
          }
          : { title: "Last run", note: notes.length ? "Not loaded." : "No run recorded yet." },
        ...(canary
          ? [{
            title: "Script",
            rows: [
              ...row("Handler", canary.Code?.Handler), ...row("Runtime", canary.RuntimeVersion), ...row("Artifacts", canary.ArtifactS3Location ? `s3://${canary.ArtifactS3Location.replace(/^s3:\/\//, "")}` : undefined),
              ...row("Runs on", canaryEngines(canary).map((e) => (e.browser ? `${e.arn} (${e.browser.toLowerCase()})` : e.arn)).join(", ") || undefined), ...row("Last started", awsTime(canary.Timeline?.LastStarted) ? fmtTime(awsTime(canary.Timeline?.LastStarted)) : undefined),
            ].map((p) => (p.label === "Runs on" || p.label === "Artifacts" ? { ...p, mono: true } : p)),
          }]
          : []),
        ...(notes.length ? [{ title: "Not loaded", note: notes.join(" · ") }] : []),
      ],
    };
  },
};
