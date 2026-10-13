// CloudWatch Synthetics canaries as the cloud map sees them, pure (audit §6 A.2 #27, CC-20): SDK-shaped DescribeCanaries
// and DescribeCanariesLastRun answers in; one node per canary out, its health from its own state and its last run — a
// real signal of whether what it checks works. The provider (../server/providers/synthetics.ts) and its simulation feed
// the same functions. No AWS calls.
//
// Key: arn:aws:synthetics:<region>:<account>:canary:<name>. Links: the Lambda functions it runs on (EngineArn, or one
// per browser from EngineConfigs on newer runtimes; invoke),
// the bucket its run artifacts go to (writes), its execution role (assumes), the KMS key of its artifacts (encrypts).
// The API exposes neither the URL a canary checks nor its run-time environment, so nothing else is drawn.
// Health: state ERROR → error; STOPPED → stopped (and READY: created, never started); last run FAILED → error ("canary
// failing — last run failed at T: <reason>"); a PASSED (or running) last run → ok; no run yet, or the last run not read
// → unknown.
import { arnOf } from "./arn.ts";
import { assumesLink, awsTime, clip, describeSchedule, encryptsLink, enrichmentOf, fmtTime, lambdaBase, props, tagsOf, unread } from "./serverless-common.ts";
import type { EnrichState, Health, Link, ProviderResult, Resource } from "./types.ts";

// ---------- raw shapes (the SDK's field names; dates as Date or ISO strings) ----------

type When = Date | string | number;
export interface RawCanaryRun {
  Id?: string;
  Name?: string;
  Status?: { State?: string; StateReason?: string; StateReasonCode?: string }; // RUNNING | PASSED | FAILED
  Timeline?: { Started?: When; Completed?: When };
  BrowserType?: string; // CHROME | FIREFOX (a canary that runs on several browsers has a last run per browser)
}
export interface RawCanary {
  Id?: string;
  Name?: string;
  Code?: { SourceLocationArn?: string; Handler?: string };
  ExecutionRoleArn?: string;
  Schedule?: { Expression?: string; DurationInSeconds?: number };
  RunConfig?: { TimeoutInSeconds?: number; MemoryInMB?: number; ActiveTracing?: boolean };
  SuccessRetentionPeriodInDays?: number;
  FailureRetentionPeriodInDays?: number;
  Status?: { State?: string; StateReason?: string; StateReasonCode?: string };
  Timeline?: { Created?: When; LastModified?: When; LastStarted?: When; LastStopped?: When };
  ArtifactS3Location?: string;
  EngineArn?: string; // runtimes before syn-nodejs-puppeteer-11.0 / syn-nodejs-playwright-3.0
  EngineConfigs?: { EngineArn?: string; BrowserType?: string }[]; // newer runtimes: one engine per browser, no EngineArn
  RuntimeVersion?: string;
  VpcConfig?: { VpcId?: string; SubnetIds?: string[]; SecurityGroupIds?: string[] };
  ArtifactConfig?: { S3Encryption?: { EncryptionMode?: string; KmsKeyArn?: string } };
  Tags?: Record<string, string>;
}

// The Lambda functions a canary runs on: EngineArn on older runtimes, one EngineConfigs entry per browser on newer ones
// (puppeteer 11+ and playwright 3+ have no EngineArn). Qualifiers stripped, duplicates dropped.
export function canaryEngines(c: RawCanary): { arn: string; browser?: string }[] {
  const out = new Map<string, string | undefined>();
  if (c.EngineArn?.startsWith("arn:")) out.set(lambdaBase(c.EngineArn), undefined);
  for (const e of c.EngineConfigs ?? []) if (e.EngineArn?.startsWith("arn:") && !out.has(lambdaBase(e.EngineArn))) out.set(lambdaBase(e.EngineArn), e.BrowserType);
  return [...out].map(([arn, browser]) => ({ arn, ...(browser ? { browser } : {}) }));
}

// DescribeCanariesLastRun entries → one last run per canary. A canary that runs on several browsers can answer once per
// browser: a failed run wins (one browser failing is the canary failing), then the newest.
export function lastRunByCanary(entries: { CanaryName?: string; LastRun?: RawCanaryRun }[]): Record<string, RawCanaryRun> {
  const out: Record<string, RawCanaryRun> = Object.create(null); // a canary may be named "__proto__"
  const failed = (r: RawCanaryRun) => (r.Status?.State ?? "").toUpperCase() === "FAILED";
  const at = (r: RawCanaryRun) => awsTime(r.Timeline?.Started) ?? 0;
  for (const e of entries) {
    const name = e.CanaryName, run = e.LastRun;
    if (!name || !run) continue;
    const had = Object.hasOwn(out, name) ? out[name] : undefined;
    if (!had || (failed(run) && !failed(had)) || (failed(run) === failed(had) && at(run) > at(had))) out[name] = run;
  }
  return out;
}

// "cw-syn-results-123-us-east-1/canary/us-east-1/checkout" or "s3://bucket/prefix" → the bucket's ARN.
export function artifactBucket(location: string | undefined): string | undefined {
  const b = /^(?:s3:\/\/)?([a-z0-9][a-z0-9.-]{1,61}[a-z0-9])(?:\/|$)/.exec(location?.trim() ?? "")?.[1];
  return b ? `arn:aws:s3:::${b}` : undefined;
}

export function canaryHealth(c: RawCanary, run: RawCanaryRun | undefined, runRead: boolean): { health: Health; reason?: string } {
  const state = (c.Status?.State ?? "").toUpperCase();
  const last = (run?.Status?.State ?? "").toUpperCase();
  const started = awsTime(run?.Timeline?.Started);
  const why = (s: string | undefined) => (s ? `: ${clip(s, 140)}` : "");
  if (state === "ERROR") return { health: "error", reason: `canary in ERROR${why(c.Status?.StateReason)}` };
  if (state === "STOPPED") return { health: "stopped", reason: `stopped${last === "FAILED" ? " — its last run failed" : ""}` };
  if (state === "READY") return { health: "stopped", reason: "created, never started" };
  if (last === "FAILED") return { health: "error", reason: `canary failing — last run failed${started ? ` at ${fmtTime(started)}` : ""}${why(run?.Status?.StateReason)}` };
  if (!runRead) return { health: "unknown", reason: "last run not read" };
  if (!last) return { health: "unknown", reason: "no run recorded yet" };
  return { health: "ok" };
}

export interface SyntheticsInput {
  region: string;
  accountId?: string;
  now: number;
  canaries: RawCanary[];
  lastRuns?: Record<string, RawCanaryRun | undefined>; // by canary name; missing = no run (when runsState is ok)
  runsState?: EnrichState; // DescribeCanariesLastRun as a whole: ok, or why it wasn't read
}

const consoleUrl = (region: string, name: string) => `https://${region}.console.aws.amazon.com/cloudwatch/home?region=${region}#synthetics:canary/detail/${encodeURIComponent(name)}`;

export function canaryResults(i: SyntheticsInput): ProviderResult {
  const resources: Resource[] = [];
  const links: Link[] = [];
  const runsRead = i.runsState === "ok" || (i.runsState === undefined && i.lastRuns !== undefined);
  for (const c of i.canaries) {
    const name = c.Name;
    if (!name) continue;
    const engines = canaryEngines(c);
    const account = (engines[0]?.arn ?? c.ExecutionRoleArn)?.split(":")[4] || i.accountId;
    if (!account) continue;
    const key = arnOf.syntheticsCanary(i.region, account, name);
    const run = runsRead && i.lastRuns && Object.hasOwn(i.lastRuns, name) ? i.lastRuns[name] : undefined;
    const h = canaryHealth(c, run, runsRead);
    for (const e of engines)
      links.push({ from: key, to: e.arn, kind: "invoke", label: e.browser ? `runs on (${e.browser.toLowerCase()})` : "runs on", evidence: e.browser ? `canary EngineConfigs (its ${e.browser} Lambda function)` : "canary EngineArn (its Lambda function)" });
    const bucket = artifactBucket(c.ArtifactS3Location);
    if (bucket) links.push({ from: key, to: bucket, kind: "writes", label: "run artifacts", evidence: "canary ArtifactS3Location" });
    links.push(...assumesLink(key, c.ExecutionRoleArn, "execution role", "canary ExecutionRoleArn"));
    links.push(...encryptsLink(c.ArtifactConfig?.S3Encryption?.KmsKeyArn, key, "run artifacts", "canary ArtifactConfig.S3Encryption"));
    const lastState = (run?.Status?.State ?? "").toUpperCase();
    const lastAt = awsTime(run?.Timeline?.Completed) ?? awsTime(run?.Timeline?.Started);
    const schedule = c.Schedule?.Expression;
    const enrichment = enrichmentOf({ lastRun: i.runsState ?? (i.lastRuns ? "ok" : undefined) });
    resources.push({
      key, kind: "synthetics-canary", provider: "synthetics", name, region: i.region, ...tagsOf(c.Tags ?? {}),
      health: h.health, ...(h.reason ? { healthReason: h.reason } : {}),
      props: props([
        { label: "State", value: c.Status?.State },
        { label: "Last run", value: runsRead ? (lastState ? `${lastState}${lastAt ? ` at ${fmtTime(lastAt)}` : ""}` : "none yet") : unread("last run", i.runsState) },
        { label: "Last run reason", value: run?.Status?.StateReason ? clip(run.Status.StateReason, 200) : undefined },
        { label: "Schedule", value: schedule ? (schedule === "rate(0 minute)" || schedule === "rate(0 minutes)" ? "run once" : (describeSchedule(schedule) ?? schedule)) : undefined },
        { label: "Runtime", value: c.RuntimeVersion },
        { label: "Timeout", value: c.RunConfig?.TimeoutInSeconds ? `${c.RunConfig.TimeoutInSeconds} s` : undefined },
        { label: "Memory", value: c.RunConfig?.MemoryInMB ? `${c.RunConfig.MemoryInMB} MB` : undefined },
        c.RunConfig?.ActiveTracing && { label: "X-Ray tracing", value: "on" },
        { label: "Keeps runs", value: c.SuccessRetentionPeriodInDays || c.FailureRetentionPeriodInDays ? `${c.SuccessRetentionPeriodInDays ?? "?"} days (passed) · ${c.FailureRetentionPeriodInDays ?? "?"} days (failed)` : undefined },
        { label: "State reason", value: c.Status?.StateReason && (c.Status.State ?? "").toUpperCase() !== "RUNNING" ? clip(c.Status.StateReason, 200) : undefined },
      ]),
      ...(c.VpcConfig?.VpcId ? { vpcId: c.VpcConfig.VpcId } : {}),
      ...(c.VpcConfig?.SubnetIds?.length ? { subnetIds: [...c.VpcConfig.SubnetIds] } : {}),
      ...(c.VpcConfig?.SecurityGroupIds?.length ? { securityGroups: [...c.VpcConfig.SecurityGroupIds] } : {}),
      aliases: [name, ...(c.Id ? [c.Id] : [])],
      consoleUrl: consoleUrl(i.region, name),
      ...(awsTime(c.Timeline?.Created) ? { createdAt: awsTime(c.Timeline?.Created) } : {}),
      ...(awsTime(c.Timeline?.LastModified) ? { lastModified: awsTime(c.Timeline?.LastModified) } : {}),
      observedAt: i.now,
      ...(enrichment ? { enrichment } : {}),
    });
  }
  return { resources, links, mentions: [] };
}
