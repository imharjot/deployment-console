// AWS Batch provider: compute environments and job queues. DescribeComputeEnvironments and DescribeJobQueues (100 per
// page; tags come with them), checkpoint, then — when there is anything — ListJobs (RUNNABLE and FAILED for health,
// RUNNING and SUCCEEDED for the last activity; one page of 100 each) per queue through enrich() (R18, first 50 queues)
// and DescribeJobDefinitions (ACTIVE). Job-definition
// environment values become mentions only. A compute environment's ECS cluster is a prop, not a link. Read-only: no
// actions, no activity series (lastActivityAt = newest listed job). The mapper is pure (../../inventory/batch.ts).
import "server-only";
import { BatchClient, DescribeComputeEnvironmentsCommand, DescribeJobDefinitionsCommand, DescribeJobQueuesCommand, ListJobsCommand } from "@aws-sdk/client-batch";
import { parseArn } from "../../inventory/arn.ts";
import {
  JOBS_PAGE, JOBS_QUEUES_MAX, batchEnvironmentDetail, batchQueueDetail, batchResult, type BatchInput, type QueueJobs, type RawComputeEnvironment, type RawJob,
  type RawJobDefinition, type RawJobQueue,
} from "../../inventory/batch.ts";
import { simBatch, simBatchDefinitions, simBatchJobs } from "./mock/batch.ts";
import { budget, enrich, paged, perRegion, sdkConfig, softly, t } from "./serverless-util.ts";
import type { Provider, ProviderContext } from "./types.ts";

const batch = perRegion((region) => new BatchClient(sdkConfig(region)), "batch");
const DETAIL_JOBS = 10; // per status, in a queue's panel

const regionOf = (key: string, fallback: string) => parseArn(key)?.region || fallback;

const listJobs = async (region: string, jobQueue: string, jobStatus: "RUNNABLE" | "FAILED" | "RUNNING" | "SUCCEEDED", maxResults: number, ctx: ProviderContext) => {
  const r = await batch(region).send(new ListJobsCommand({ jobQueue, jobStatus, maxResults }), t(ctx));
  return { jobs: (r.jobSummaryList ?? []) as RawJob[], more: !!r.nextToken };
};

async function jobsOf(region: string, queue: string, ctx: ProviderContext): Promise<QueueJobs> {
  const [runnable, running, failed, succeeded] = await Promise.all((["RUNNABLE", "RUNNING", "FAILED", "SUCCEEDED"] as const).map((s) => listJobs(region, queue, s, JOBS_PAGE, ctx)));
  return {
    runnable: runnable.jobs, running: running.jobs, failed: failed.jobs, succeeded: succeeded.jobs,
    more: { runnable: runnable.more, running: running.more, failed: failed.more, succeeded: succeeded.more },
  };
}

const definitionsPage = (region: string, ctx: ProviderContext) => async (nextToken: string | undefined) => {
  const r = await batch(region).send(new DescribeJobDefinitionsCommand({ status: "ACTIVE", maxResults: 100, nextToken }), t(ctx));
  return { items: r.jobDefinitions as RawJobDefinition[] | undefined, next: r.nextToken };
};

async function fetchBatch(ctx: ProviderContext): Promise<BatchInput> {
  const [environments, queues] = await Promise.all([
    paged(ctx, "batch compute environments", async (nextToken) => {
      const r = await batch(ctx.region).send(new DescribeComputeEnvironmentsCommand({ maxResults: 100, nextToken }), t(ctx));
      return { items: r.computeEnvironments as RawComputeEnvironment[] | undefined, next: r.nextToken };
    }, { service: "batch" }),
    paged(ctx, "batch job queues", async (nextToken) => {
      const r = await batch(ctx.region).send(new DescribeJobQueuesCommand({ maxResults: 100, nextToken }), t(ctx));
      return { items: r.jobQueues as RawJobQueue[] | undefined, next: r.nextToken };
    }, { service: "batch" }),
  ]);
  const base = queues.filter((q) => q.jobQueueArn).map((q): RawJobQueue => ({ ...q, enrichment: { jobs: "skipped" } }));
  const now = Date.now();
  ctx.checkpoint?.(batchResult({ environments, queues: base }, { region: ctx.region, account: ctx.accountId, now }));
  // Nothing set up here: no job or definition reads.
  if (!environments.length && !base.length) return { environments, queues: base, definitions: [] };
  const until = budget();
  const [jobs, definitions] = await Promise.all([
    enrich(ctx, base, { label: "batch jobs", max: JOBS_QUEUES_MAX, until }, (q) => jobsOf(ctx.region, q.jobQueueArn!, ctx)),
    softly(ctx, "batch job definitions", { limited: false, until, service: "batch" })(() => paged(ctx, "batch job definitions", definitionsPage(ctx.region, ctx), { service: "batch" })),
  ]);
  return {
    environments,
    queues: base.map((q, i) => ({ ...q, ...(jobs.state[i] === "ok" && jobs.results[i] ? { jobs: jobs.results[i] } : {}), enrichment: { jobs: jobs.state[i] } })),
    definitions,
  };
}

async function queueDetail(region: string, key: string, ctx: ProviderContext) {
  const q = (await batch(region).send(new DescribeJobQueuesCommand({ jobQueues: [key] }), t(ctx))).jobQueues?.[0] as RawJobQueue | undefined;
  if (!q) return batchQueueDetail(key, undefined, { now: Date.now() });
  const read = softly(ctx, "batch jobs", { service: "batch" });
  const statuses = ["RUNNABLE", "RUNNING", "FAILED", "SUCCEEDED"] as const;
  const recent = await Promise.all(statuses.map(async (status) => ({ status, jobs: (await read(() => listJobs(region, key, status, DETAIL_JOBS, ctx)))?.jobs ?? [] })));
  const used = [...new Set(recent.flatMap((r) => r.jobs.map((j) => j.jobDefinition)).filter((d): d is string => !!d))].slice(0, 100);
  const definitions = used.length
    ? await softly(ctx, "batch job definitions", { service: "batch" })(async () => (await batch(region).send(new DescribeJobDefinitionsCommand({ jobDefinitions: used }), t(ctx))).jobDefinitions as RawJobDefinition[] | undefined)
    : [];
  return batchQueueDetail(key, q, { now: Date.now(), recent, definitions });
}

export const batchProvider: Provider = {
  id: "batch",
  label: "AWS Batch",
  kinds: ["batch-environment", "batch-queue"],
  scope: "regional",
  covers: ["batch:compute-environment", "batch:job-queue"],
  ttlMs: 10 * 60_000,
  multiRegionMock: true,
  read: ["batch:DescribeComputeEnvironments", "batch:DescribeJobQueues", "batch:ListJobs", "batch:DescribeJobDefinitions"],
  async discover(ctx) {
    return batchResult(ctx.mock ? simBatch(ctx.region) : await fetchBatch(ctx), { region: ctx.region, account: ctx.accountId, now: Date.now() });
  },
  async detail(r, ctx) {
    const region = regionOf(r.key, ctx.region);
    if (ctx.mock) {
      const sim = simBatch(region);
      if (r.kind === "batch-environment") return batchEnvironmentDetail(r.key, sim.environments.find((c) => c.computeEnvironmentArn === r.key));
      const q = sim.queues.find((x) => x.jobQueueArn === r.key);
      const jobs = simBatchJobs();
      const recent = q ? [{ status: "RUNNABLE", jobs: jobs.runnable }, { status: "RUNNING", jobs: jobs.running }, { status: "FAILED", jobs: jobs.failed }, { status: "SUCCEEDED", jobs: jobs.succeeded }] : [];
      return batchQueueDetail(r.key, q, { now: Date.now(), recent, definitions: simBatchDefinitions() });
    }
    if (r.kind === "batch-environment") {
      const c = (await batch(region).send(new DescribeComputeEnvironmentsCommand({ computeEnvironments: [r.key] }), t(ctx))).computeEnvironments?.[0] as RawComputeEnvironment | undefined;
      return batchEnvironmentDetail(r.key, c);
    }
    return queueDetail(region, r.key, ctx);
  },
};
