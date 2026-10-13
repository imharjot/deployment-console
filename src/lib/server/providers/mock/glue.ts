// Simulated Glue (mock-names GLUE, us-east-1; other regions have none), in GetJobs / GetJobRuns / GetCrawlers / GetTags
// shapes so the real mapping runs. The nightly ETL job reads its script from the data lake, keeps temporary files there,
// and copies orders out of the production database (named in its arguments — a mention the map resolves, the value
// never shown); its runs succeed every night at 02:00 UTC. The orders crawler catalogues the lake's orders/ prefix into
// the acme_lake database (a generic row the catch-all lists) and logs to Glue's crawler log group.
import type { RawCrawler, RawGlueJob, RawJobRun } from "../../../inventory/glue.ts";
import { EXISTING, GLUE, REGION } from "../mock-names.ts";

const MIN = 60_000;
const DAY = 86_400_000;

// The latest <hh:mm> UTC at or before now.
const latest = (hh: number, mm: number) => {
  const t = Date.now();
  const at = Math.floor(t / DAY) * DAY + (hh * 60 + mm) * MIN;
  return at <= t ? at : at - DAY;
};

export function simGlue(region: string): { jobs: RawGlueJob[]; runs: Record<string, RawJobRun[]>; crawlers: RawCrawler[]; tags: Record<string, Record<string, string>> } {
  if (region !== REGION) return { jobs: [], runs: {}, crawlers: [], tags: {} };
  const night = latest(2, 0);
  const lake = `s3://${GLUE.lakeBucket}`;
  const job: RawGlueJob = {
    Name: GLUE.job.name, Description: "Nightly copy of orders into the data lake",
    CreatedOn: new Date(night - 300 * DAY), LastModifiedOn: new Date(night - 20 * DAY),
    Command: { Name: "glueetl", ScriptLocation: `${lake}/scripts/nightly_etl.py`, PythonVersion: "3" },
    DefaultArguments: {
      "--TempDir": `${lake}/tmp/`, "--job-language": "python", "--enable-metrics": "true",
      "--SOURCE_DB_URL": `postgres://etl@${EXISTING.rdsHost(EXISTING.rds.production)}:5432/shop`,
    },
    MaxRetries: 1, Timeout: 120, WorkerType: "G.1X", NumberOfWorkers: 4, GlueVersion: "4.0", ExecutionClass: "STANDARD",
  };
  const run = (daysAgo: number, state: string, secs: number): RawJobRun => {
    const start = night - daysAgo * DAY;
    const done = start + secs * 1000 <= Date.now(); // tonight's run may still be going
    return {
      Id: `jr_0acme${start.toString(16)}`, JobName: GLUE.job.name, JobRunState: done ? state : "RUNNING", TriggerName: "acme-nightly-0200",
      StartedOn: new Date(start), ...(done ? { CompletedOn: new Date(start + secs * 1000), ExecutionTime: secs } : {}), Attempt: 0,
    };
  };
  const crawler: RawCrawler = {
    Name: GLUE.crawler.name, DatabaseName: GLUE.database.name, State: "READY",
    Targets: { S3Targets: [{ Path: `${lake}/orders/` }] },
    Schedule: { ScheduleExpression: "cron(30 3 * * ? *)", State: "SCHEDULED" },
    LastCrawl: { Status: "SUCCEEDED", StartTime: new Date(latest(3, 30)), LogGroup: "/aws-glue/crawlers", LogStream: GLUE.crawler.name },
    CrawlElapsedTime: 94_000, CreationTime: new Date(night - 280 * DAY), LastUpdated: new Date(night - 40 * DAY),
  };
  return {
    jobs: [job],
    runs: { [GLUE.job.name]: [run(0, "SUCCEEDED", 1_262), run(1, "SUCCEEDED", 1_198), run(2, "SUCCEEDED", 1_305)] },
    crawlers: [crawler],
    tags: { [GLUE.job.arn]: { Environment: "production" }, [GLUE.crawler.arn]: { Environment: "production" } },
  };
}
