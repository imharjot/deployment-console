// Glue provider (audit §6 A.2 P2, the glue row): ETL jobs with their latest run and crawlers with their latest crawl. A
// failed last run or crawl is a warning; lastActivityAt is the last run, so a job nobody runs any more shows as idle.
// Links: script and temporary-files buckets, crawler targets and database, roles, the crawler's log group. Job
// arguments (connection strings, passwords) become Mention.refs only, and GetConnections is never called (A.0 rule 6).
// The mapping is pure (../../inventory/glue.ts).
//
// Discovery lists (GetJobs and GetCrawlers, 1,000 a page), hands the list to ctx.checkpoint, then reads each job's
// latest run (GetJobRuns, 1 per job, the first 200 jobs) and tags (GetTags, first 200) through enrich() (R18).
// Read-only: no actions.
import "server-only";
import { GetCrawlersCommand, GetJobRunsCommand, GetJobsCommand, GetTagsCommand, GlueClient } from "@aws-sdk/client-glue";
import { arnOf, parseArn } from "../../inventory/arn.ts";
import { glueResults, lastErrorOf, runRows, targetRows, type GlueInput, type RawCrawler, type RawGlueJob, type RawJobRun } from "../../inventory/glue.ts";
import { awsTime, clip, fmtTime } from "../../inventory/serverless-common.ts";
import type { EnrichState, Prop, Resource, ResourceDetail } from "../../inventory/types.ts";
import { errText } from "../errors.ts";
import { simGlue } from "./mock/glue.ts";
import { budget, enrich, paged, perRegion, sdkConfig, t } from "./serverless-util.ts";
import { deniedAction, type Provider, type ProviderContext } from "./types.ts";

const glue = perRegion((r) => new GlueClient(sdkConfig(r)), "glue");
const RUNS_MAX = 200;
const TAGS_MAX = 200;
const RUNS_SHOWN = 10;

const regionOf = (r: Resource, fallback: string) => parseArn(r.key)?.region || fallback;
const acct = (role: string | undefined, ctx: ProviderContext) => (role?.startsWith("arn:") ? role.split(":")[4] : undefined) || ctx.accountId;

async function realInput(ctx: ProviderContext, base: Pick<GlueInput, "region" | "accountId" | "now">): Promise<GlueInput> {
  const c = glue(ctx.region);
  const [jobs, crawlers] = await Promise.all([
    paged<RawGlueJob>(ctx, "glue jobs", async (NextToken) => {
      const r = await c.send(new GetJobsCommand({ MaxResults: 1000, NextToken }), t(ctx, 10_000));
      return { items: r.Jobs, next: r.NextToken };
    }, { service: "glue" }),
    paged<RawCrawler>(ctx, "glue crawlers", async (NextToken) => {
      const r = await c.send(new GetCrawlersCommand({ MaxResults: 1000, NextToken }), t(ctx, 10_000));
      return { items: r.Crawlers, next: r.NextToken };
    }, { service: "glue" }),
  ]);
  ctx.checkpoint?.(glueResults({ ...base, jobs, crawlers }));
  const until = budget();
  const named = jobs.filter((j) => j.Name);
  const arns = [
    ...named.map((j) => acct(j.Role, ctx) && arnOf.glueJob(ctx.region, acct(j.Role, ctx)!, j.Name!)),
    ...crawlers.filter((x) => x.Name).map((x) => acct(x.Role, ctx) && arnOf.glueCrawler(ctx.region, acct(x.Role, ctx)!, x.Name!)),
  ].filter((x): x is string => !!x);
  const [runs, tags] = await Promise.all([
    enrich(ctx, named, { label: "glue job runs", max: RUNS_MAX, until }, async (j) =>
      (await c.send(new GetJobRunsCommand({ JobName: j.Name, MaxResults: 1 }), t(ctx))).JobRuns?.[0]),
    enrich(ctx, arns, { label: "glue tags", max: TAGS_MAX, until }, async (ResourceArn) => (await c.send(new GetTagsCommand({ ResourceArn }), t(ctx))).Tags ?? {}),
  ]);
  // By job name, which may be anything ("__proto__" included): objects without a prototype, so every name is a key.
  const runMap: Record<string, RawJobRun | undefined> = Object.create(null);
  const runState: Record<string, EnrichState> = Object.create(null);
  named.forEach((j, i) => {
    runState[j.Name!] = runs.state[i];
    if (runs.state[i] === "ok" && runs.results[i]) runMap[j.Name!] = pickRun(runs.results[i]!);
  });
  const tagMap: Record<string, Record<string, string> | undefined> = {};
  const tagState: Record<string, EnrichState> = {};
  arns.forEach((arn, i) => {
    tagState[arn] = tags.state[i];
    if (tags.state[i] === "ok") tagMap[arn] = tags.results[i] ?? {};
  });
  return { ...base, jobs, crawlers, runs: runMap, runState, tags: tagMap, tagState };
}

// Only the fields the map shows: never the run's Arguments (secrets) or its session policy.
const pickRun = (r: RawJobRun): RawJobRun => ({
  Id: r.Id, JobName: r.JobName, JobRunState: r.JobRunState, StartedOn: r.StartedOn, CompletedOn: r.CompletedOn, LastModifiedOn: r.LastModifiedOn,
  ExecutionTime: r.ExecutionTime, TriggerName: r.TriggerName, Attempt: r.Attempt, ErrorMessage: r.ErrorMessage,
});

const row = (label: string, value: string | number | undefined): Prop[] => (value === undefined || value === "" ? [] : [{ label, value: String(value) }]);
const why = (e: unknown) => (deniedAction(e) ? `the console's role can't read it (${deniedAction(e)})` : errText(e));

// One crawler by name (GetCrawlers pages; there is no single-crawler read in the console's policy).
async function findCrawler(ctx: ProviderContext, region: string, name: string): Promise<RawCrawler | undefined> {
  const c = glue(region);
  let token: string | undefined;
  let seen = 0;
  do {
    const r = await ctx.limit(() => c.send(new GetCrawlersCommand({ MaxResults: 1000, NextToken: token }), t(ctx, 10_000)), { service: "glue" });
    const hit = r.Crawlers?.find((x) => x.Name === name);
    if (hit) return hit;
    seen += r.Crawlers?.length ?? 0;
    token = r.NextToken || undefined;
  } while (token && seen < ctx.cap && !ctx.signal.aborted);
  return undefined;
}

export const glueProvider: Provider = {
  id: "glue",
  label: "Glue",
  kinds: ["glue-job", "glue-crawler"],
  scope: "regional",
  covers: ["glue:job", "glue:crawler"],
  ttlMs: 10 * 60_000,
  multiRegionMock: true,
  read: ["glue:GetJobs", "glue:GetJobRuns", "glue:GetCrawlers", "glue:GetTags"],
  async discover(ctx) {
    const base = { region: ctx.region, accountId: ctx.accountId, now: Date.now() };
    if (ctx.mock) {
      const sim = simGlue(ctx.region);
      const runs = Object.fromEntries(Object.entries(sim.runs).map(([name, list]) => [name, list[0]]));
      return glueResults({ ...base, jobs: sim.jobs, crawlers: sim.crawlers, runs, tags: sim.tags });
    }
    return glueResults(await realInput(ctx, base));
  },
  // A job's recent runs (and the latest failure's message); a crawler's targets and its last crawl.
  async detail(r, ctx): Promise<ResourceDetail> {
    const region = regionOf(r, ctx.region);
    if (r.kind === "glue-job") {
      let runs: RawJobRun[] | undefined;
      let note: string | undefined;
      if (ctx.mock) runs = Object.hasOwn(simGlue(region).runs, r.name) ? simGlue(region).runs[r.name] : [];
      else {
        try {
          const out = await ctx.limit(() => glue(region).send(new GetJobRunsCommand({ JobName: r.name, MaxResults: RUNS_SHOWN }), t(ctx)), { service: "glue" });
          runs = (out.JobRuns ?? []).map(pickRun);
        } catch (e) {
          if (ctx.signal.aborted) throw e;
          note = `Runs not loaded: ${why(e)}.`;
        }
      }
      const error = runs ? lastErrorOf(runs) : undefined;
      return {
        key: r.key,
        sections: [
          runs
            ? { title: "Recent runs", table: { columns: ["Run", "State", "Started", "Run time", "Trigger"], rows: runRows(runs) }, ...(runs.length ? {} : { note: "This job has never run." }) }
            : { title: "Recent runs", note },
          ...(error ? [{ title: "Latest failure", note: error }] : []),
        ],
      };
    }
    let crawler: RawCrawler | undefined;
    if (ctx.mock) crawler = simGlue(region).crawlers.find((x) => x.Name === r.name);
    else {
      try {
        crawler = await findCrawler(ctx, region, r.name);
      } catch (e) {
        if (ctx.signal.aborted) throw e;
        return { key: r.key, sections: [{ title: "Crawler", note: `Not loaded: ${why(e)}.` }] };
      }
    }
    if (!crawler) return { key: r.key, sections: [{ title: "Crawler", note: "This crawler no longer exists." }] };
    const last = crawler.LastCrawl;
    const targets = targetRows(crawler);
    return {
      key: r.key,
      sections: [
        { title: "Targets", table: { columns: ["Kind", "Target"], rows: targets }, ...(targets.length ? {} : { note: "No targets." }) },
        last
          ? {
            title: "Last crawl",
            rows: [
              ...row("Result", last.Status), ...row("Started", awsTime(last.StartTime) ? fmtTime(awsTime(last.StartTime)) : undefined),
              ...row("Crawl time", crawler.CrawlElapsedTime ? `${Math.round(crawler.CrawlElapsedTime / 1000)} s` : undefined),
              ...row("Log", last.LogGroup ? `${last.LogGroup}${last.LogStream ? ` · ${last.LogStream}` : ""}` : undefined),
              ...row("Error", last.ErrorMessage ? clip(last.ErrorMessage, 300) : undefined),
            ],
          }
          : { title: "Last crawl", note: "Never crawled." },
      ],
    };
  },
};
