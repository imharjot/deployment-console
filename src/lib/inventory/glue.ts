// Glue jobs and crawlers as the cloud map sees them, pure (audit §6 A.2 P2 glue row): SDK-shaped GetJobs, GetJobRuns
// (the latest run per job), GetCrawlers and GetTags answers in; one node per job and per crawler out. The provider
// (../server/providers/glue.ts) and its simulation feed the same functions. No AWS calls.
//
// Glue lists no ARNs: keys are built with arnOf (the account from the job's role ARN, else the console's). Links: a
// job reads its script's bucket and writes its --TempDir bucket (the bucket only), a crawler reads its targets (S3
// paths, DynamoDB tables, catalog databases, the queue of S3 events) and writes its database; both assume their role,
// and a crawler logs to its log group. Secrets: job arguments (DefaultArguments, NonOverridableArguments) are often
// connection strings and passwords, so their values become Mention.refs only — never props, labels or evidence — and
// the run's own Arguments, the source-control token and the visual job graph are never read (A.0 rule 6; GetConnections
// is never called). Health: a failed last run (FAILED, ERROR, TIMEOUT) or a failed last crawl → warning; runs not read
// → unknown. lastActivityAt = the last run or crawl.
import { arnOf, partitionOf } from "./arn.ts";
import { roleRef } from "./compute-common.ts";
import {
  assumesLink, awsTime, clip, describeSchedule, enrichmentOf, envMentions, fmtTime, logGroupRef, props, tagsOf, unread,
} from "./serverless-common.ts";
import type { EnrichState, Health, Link, Mention, ProviderResult, Resource } from "./types.ts";

// ---------- raw shapes (the SDK's field names; dates as Date or ISO strings) ----------

type When = Date | string | number;
export interface RawGlueJob {
  Name?: string;
  Description?: string;
  Role?: string; // name or ARN
  CreatedOn?: When;
  LastModifiedOn?: When;
  Command?: { Name?: string; ScriptLocation?: string; PythonVersion?: string; Runtime?: string };
  DefaultArguments?: Record<string, string>; // secret-bearing: Mention.refs only
  NonOverridableArguments?: Record<string, string>; // secret-bearing: Mention.refs only
  Connections?: { Connections?: string[] };
  MaxRetries?: number;
  Timeout?: number; // minutes
  MaxCapacity?: number;
  WorkerType?: string;
  NumberOfWorkers?: number;
  GlueVersion?: string;
  ExecutionClass?: string;
  JobMode?: string;
}
export interface RawJobRun {
  Id?: string;
  JobName?: string;
  JobRunState?: string; // STARTING | RUNNING | STOPPING | STOPPED | SUCCEEDED | FAILED | TIMEOUT | ERROR | WAITING | EXPIRED
  StartedOn?: When;
  CompletedOn?: When;
  LastModifiedOn?: When;
  ExecutionTime?: number; // seconds
  TriggerName?: string;
  Attempt?: number;
  ErrorMessage?: string;
}
interface Paths { Paths?: string[] }
export interface RawCrawler {
  Name?: string;
  Role?: string;
  Description?: string;
  DatabaseName?: string;
  State?: string; // READY | RUNNING | STOPPING
  Schedule?: { ScheduleExpression?: string; State?: string };
  Targets?: {
    S3Targets?: { Path?: string; EventQueueArn?: string; ConnectionName?: string }[];
    JdbcTargets?: { ConnectionName?: string; Path?: string }[];
    MongoDBTargets?: { ConnectionName?: string; Path?: string }[];
    DynamoDBTargets?: { Path?: string }[];
    CatalogTargets?: { DatabaseName?: string; Tables?: string[]; EventQueueArn?: string }[];
    DeltaTargets?: { DeltaTables?: string[] }[];
    IcebergTargets?: Paths[];
    HudiTargets?: Paths[];
  };
  LastCrawl?: { Status?: string; ErrorMessage?: string; LogGroup?: string; LogStream?: string; StartTime?: When };
  CrawlElapsedTime?: number; // ms
  TablePrefix?: string;
  CreationTime?: When;
  LastUpdated?: When;
}

// ---------- helpers ----------

export const FAILED_RUN = new Set(["FAILED", "ERROR", "TIMEOUT"]);
const BUCKET = /^s3a?:\/\/([a-z0-9][a-z0-9.-]{1,61}[a-z0-9])(?:\/|$)/;
export const s3Bucket = (path: string | undefined) => {
  const b = BUCKET.exec(path?.trim() ?? "")?.[1];
  return b ? `arn:aws:s3:::${b}` : undefined;
};
const own = <T>(o: Record<string, T> | undefined, k: string): T | undefined => (o && Object.hasOwn(o, k) ? o[k] : undefined);
const accountOf = (role: string | undefined, fallback: string | undefined) => (role?.startsWith("arn:") ? role.split(":")[4] : undefined) || fallback;
const duration = (s: number | undefined) => (s === undefined ? undefined : s < 60 ? `${s} s` : s < 3600 ? `${Math.round(s / 60)} min` : `${+(s / 3600).toFixed(1)} h`);
const JOB_TYPE: Record<string, string> = { glueetl: "Spark ETL", gluestreaming: "Spark streaming", pythonshell: "Python shell", glueray: "Ray" };

// The latest run's verdict for the map.
export function jobHealth(run: RawJobRun | undefined, state: EnrichState | undefined): { health: Health; reason?: string } {
  if (state && state !== "ok") return { health: "unknown", reason: unread("last run", state) };
  const s = (run?.JobRunState ?? "").toUpperCase();
  if (FAILED_RUN.has(s)) {
    const at = awsTime(run?.CompletedOn) ?? awsTime(run?.StartedOn);
    return { health: "warning", reason: `last run ${s}${at ? ` at ${fmtTime(at)}` : ""}` };
  }
  return { health: "ok" };
}

export function crawlerHealth(c: RawCrawler): { health: Health; reason?: string } {
  const s = (c.LastCrawl?.Status ?? "").toUpperCase();
  if (s === "FAILED") {
    const at = awsTime(c.LastCrawl?.StartTime);
    return { health: "warning", reason: `last crawl FAILED${at ? ` at ${fmtTime(at)}` : ""}${c.LastCrawl?.ErrorMessage ? `: ${clip(c.LastCrawl.ErrorMessage, 120)}` : ""}` };
  }
  return { health: "ok" };
}

// ---------- the jobs and crawlers as map resources ----------

export interface GlueInput {
  region: string;
  accountId?: string;
  now: number;
  jobs: RawGlueJob[];
  runs?: Record<string, RawJobRun | undefined>; // by job name: the latest run (missing with state ok = never run)
  runState?: Record<string, EnrichState>; // by job name
  crawlers: RawCrawler[];
  tags?: Record<string, Record<string, string> | undefined>; // by job / crawler ARN; missing = not read
  tagState?: Record<string, EnrichState>;
}

const jobUrl = (region: string, name: string) => `https://${region}.console.aws.amazon.com/gluestudio/home?region=${region}#/editor/job/${encodeURIComponent(name)}/details`;
const crawlerUrl = (region: string, name: string) => `https://${region}.console.aws.amazon.com/glue/home?region=${region}#/v2/data-catalog/crawlers/view/${encodeURIComponent(name)}`;

export function glueResults(i: GlueInput): ProviderResult {
  const resources: Resource[] = [];
  const links: Link[] = [];
  const mentions: Mention[] = [];
  const p = partitionOf(i.region);

  for (const j of i.jobs) {
    const name = j.Name;
    const account = accountOf(j.Role, i.accountId);
    if (!name || !account) continue;
    const key = arnOf.glueJob(i.region, account, name);
    const run = own(i.runs, name);
    const runState: EnrichState = own(i.runState, name) ?? (i.runs ? "ok" : "skipped");
    const h = jobHealth(run, runState);
    const script = j.Command?.ScriptLocation;
    const args = { ...(j.DefaultArguments ?? {}), ...(j.NonOverridableArguments ?? {}) };
    const tempDir = own(args, "--TempDir");
    const scriptBucket = s3Bucket(script);
    if (scriptBucket) links.push({ from: key, to: scriptBucket, kind: "reads", label: "script", evidence: "job Command.ScriptLocation" });
    const tempBucket = s3Bucket(tempDir);
    if (tempBucket) links.push({ from: key, to: tempBucket, kind: "writes", label: "temporary files", evidence: "job argument --TempDir (bucket)" });
    links.push(...assumesLink(key, roleRef(j.Role, account, i.region), "job role", "job Role"));
    // Every argument value is a mention (server-side only); --TempDir is a link already (its bucket), not both.
    mentions.push(...envMentions(key, tempBucket ? Object.fromEntries(Object.entries(args).filter(([k]) => k !== "--TempDir")) : args, "glue job argument"));
    const started = awsTime(run?.StartedOn), completed = awsTime(run?.CompletedOn);
    const runText = runState !== "ok" ? unread("last run", runState) : run ? `${run.JobRunState ?? "?"}${started ? ` at ${fmtTime(started)}` : ""}` : "never run";
    const capacity = j.NumberOfWorkers ? `${j.NumberOfWorkers} × ${j.WorkerType ?? "worker"}` : j.MaxCapacity ? `${j.MaxCapacity} DPU` : undefined;
    const tags = own(i.tags, key);
    const enrichment = enrichmentOf({ lastRun: runState, tags: own(i.tagState, key) ?? (tags ? "ok" : undefined) });
    const lastActivityAt = Math.max(started ?? 0, completed ?? 0) || undefined;
    resources.push({
      key, kind: "glue-job", provider: "glue", name, region: i.region, ...tagsOf(tags),
      health: h.health, ...(h.reason ? { healthReason: h.reason } : {}),
      props: props([
        { label: "Type", value: j.Command?.Name ? (JOB_TYPE[j.Command.Name] ?? j.Command.Name) : undefined },
        { label: "Last run", value: runText },
        { label: "Run time", value: run ? duration(run.ExecutionTime) : undefined },
        { label: "Glue version", value: j.GlueVersion },
        { label: "Capacity", value: capacity },
        { label: "Script", value: script, mono: true },
        { label: "Connections", value: j.Connections?.Connections?.length ? clip(j.Connections.Connections.join(", "), 160) : undefined },
        { label: "Arguments", value: Object.keys(args).length ? clip(Object.keys(args).sort().join(", "), 200) : undefined }, // names only, never values
        { label: "Timeout", value: j.Timeout ? `${j.Timeout} min` : undefined },
        { label: "Max retries", value: j.MaxRetries ? String(j.MaxRetries) : undefined },
        { label: "Execution class", value: j.ExecutionClass && j.ExecutionClass !== "STANDARD" ? j.ExecutionClass.toLowerCase() : undefined },
        { label: "Description", value: j.Description ? clip(j.Description, 160) : undefined },
      ]),
      aliases: [name],
      consoleUrl: jobUrl(i.region, name),
      ...(awsTime(j.CreatedOn) ? { createdAt: awsTime(j.CreatedOn) } : {}),
      ...(awsTime(j.LastModifiedOn) ? { lastModified: awsTime(j.LastModifiedOn) } : {}),
      ...(lastActivityAt ? { lastActivityAt } : {}),
      observedAt: i.now,
      ...(enrichment ? { enrichment } : {}),
    });
  }

  for (const c of i.crawlers) {
    const name = c.Name;
    const account = accountOf(c.Role, i.accountId);
    if (!name || !account) continue;
    const key = arnOf.glueCrawler(i.region, account, name);
    const t = c.Targets ?? {};
    const reads = new Map<string, string>(); // target → label
    for (const s of t.S3Targets ?? []) {
      const b = s3Bucket(s.Path);
      if (b) reads.set(b, "S3 target");
      if (s.EventQueueArn) links.push({ from: key, to: s.EventQueueArn, kind: "poll", label: "S3 events", evidence: "crawler S3 target EventQueueArn" });
    }
    // A table name in the crawler's region and account, or (cross-account crawls) the table's ARN as given.
    for (const d of t.DynamoDBTargets ?? []) if (d.Path) reads.set(d.Path.startsWith("arn:") ? d.Path : `arn:${p}:dynamodb:${i.region}:${account}:table/${d.Path}`, "DynamoDB target");
    for (const d of t.CatalogTargets ?? []) {
      if (d.DatabaseName) reads.set(`arn:${p}:glue:${i.region}:${account}:database/${d.DatabaseName}`, "catalog target");
      if (d.EventQueueArn) links.push({ from: key, to: d.EventQueueArn, kind: "poll", label: "S3 events", evidence: "crawler catalog target EventQueueArn" });
    }
    for (const path of [...(t.DeltaTargets ?? []).flatMap((d) => d.DeltaTables ?? []), ...(t.IcebergTargets ?? []).flatMap((d) => d.Paths ?? []), ...(t.HudiTargets ?? []).flatMap((d) => d.Paths ?? [])]) {
      const b = s3Bucket(path);
      if (b) reads.set(b, "table target");
    }
    for (const [to, label] of reads) links.push({ from: key, to, kind: "reads", label, evidence: `crawler targets (${label})` });
    if (c.DatabaseName) links.push({ from: key, to: `arn:${p}:glue:${i.region}:${account}:database/${c.DatabaseName}`, kind: "writes", label: "table definitions", evidence: "crawler DatabaseName" });
    links.push(...assumesLink(key, roleRef(c.Role, account, i.region), "crawler role", "crawler Role"));
    const logGroup = logGroupRef(c.LastCrawl?.LogGroup, i.region, account);
    if (logGroup) links.push({ from: key, to: logGroup, kind: "logs", label: "crawl logs", evidence: "crawler LastCrawl.LogGroup" });

    const h = crawlerHealth(c);
    const lastAt = awsTime(c.LastCrawl?.StartTime);
    const running = c.State === "RUNNING" || c.State === "STOPPING";
    const lastActivityAt = running ? i.now : lastAt;
    const targets = [
      ...(t.S3Targets ?? []).map((x) => x.Path).filter(Boolean),
      ...(t.JdbcTargets ?? []).map((x) => `JDBC ${x.ConnectionName ?? "?"}${x.Path ? ` ${x.Path}` : ""}`),
      ...(t.MongoDBTargets ?? []).map((x) => `MongoDB ${x.ConnectionName ?? "?"}${x.Path ? ` ${x.Path}` : ""}`),
      ...(t.DynamoDBTargets ?? []).map((x) => `DynamoDB ${x.Path ?? "?"}`),
      ...(t.CatalogTargets ?? []).map((x) => `catalog ${x.DatabaseName ?? "?"}${x.Tables?.length ? ` (${x.Tables.length} tables)` : ""}`),
      ...(t.DeltaTargets ?? []).flatMap((x) => x.DeltaTables ?? []),
      ...(t.IcebergTargets ?? []).flatMap((x) => x.Paths ?? []),
      ...(t.HudiTargets ?? []).flatMap((x) => x.Paths ?? []),
    ];
    const schedule = c.Schedule?.ScheduleExpression;
    const tags = own(i.tags, key);
    const enrichment = enrichmentOf({ tags: own(i.tagState, key) ?? (tags ? "ok" : undefined) });
    resources.push({
      key, kind: "glue-crawler", provider: "glue", name, region: i.region, ...tagsOf(tags),
      health: h.health, ...(h.reason ? { healthReason: h.reason } : {}),
      props: props([
        { label: "State", value: c.State?.toLowerCase() },
        { label: "Last crawl", value: c.LastCrawl?.Status ? `${c.LastCrawl.Status}${lastAt ? ` at ${fmtTime(lastAt)}` : ""}` : "never crawled" },
        { label: "Schedule", value: schedule ? `${describeSchedule(schedule) ?? schedule}${c.Schedule?.State === "NOT_SCHEDULED" ? " (paused)" : ""}` : "on demand" },
        { label: "Database", value: c.DatabaseName },
        { label: "Targets", value: targets.length ? clip(targets.join(", "), 240) : undefined, mono: true },
        { label: "Table prefix", value: c.TablePrefix },
        { label: "Crawl time", value: c.CrawlElapsedTime ? duration(Math.round(c.CrawlElapsedTime / 1000)) : undefined },
        { label: "Description", value: c.Description ? clip(c.Description, 160) : undefined },
      ]),
      aliases: [name],
      consoleUrl: crawlerUrl(i.region, name),
      ...(awsTime(c.CreationTime) ? { createdAt: awsTime(c.CreationTime) } : {}),
      ...(awsTime(c.LastUpdated) ? { lastModified: awsTime(c.LastUpdated) } : {}),
      ...(lastActivityAt ? { lastActivityAt } : {}),
      observedAt: i.now,
      ...(enrichment ? { enrichment } : {}),
    });
  }
  return { resources, links, mentions };
}

// ---------- detail ----------

// Job runs as table rows (newest first): run, state, started, run time, trigger. Never the run's arguments.
export const runRows = (runs: RawJobRun[]): string[][] =>
  [...runs]
    .sort((a, b) => (awsTime(b.StartedOn) ?? 0) - (awsTime(a.StartedOn) ?? 0))
    .map((r) => [r.Id ? clip(r.Id, 24) : "?", r.JobRunState ?? "?", fmtTime(awsTime(r.StartedOn)), duration(r.ExecutionTime) ?? "—", r.TriggerName ?? (r.Attempt ? `retry ${r.Attempt}` : "—")]);

// A crawler's targets as table rows: kind, what (paths, tables, connection names — never a connection's properties).
export function targetRows(c: RawCrawler): string[][] {
  const t = c.Targets ?? {};
  return [
    ...(t.S3Targets ?? []).map((x) => ["S3", x.Path ?? "?"]),
    ...(t.JdbcTargets ?? []).map((x) => ["JDBC", `${x.ConnectionName ?? "?"}${x.Path ? ` · ${x.Path}` : ""}`]),
    ...(t.MongoDBTargets ?? []).map((x) => ["MongoDB", `${x.ConnectionName ?? "?"}${x.Path ? ` · ${x.Path}` : ""}`]),
    ...(t.DynamoDBTargets ?? []).map((x) => ["DynamoDB", x.Path ?? "?"]),
    ...(t.CatalogTargets ?? []).map((x) => ["Data Catalog", `${x.DatabaseName ?? "?"}${x.Tables?.length ? ` · ${x.Tables.join(", ")}` : ""}`]),
    ...(t.DeltaTargets ?? []).flatMap((x) => (x.DeltaTables ?? []).map((p) => ["Delta", p])),
    ...(t.IcebergTargets ?? []).flatMap((x) => (x.Paths ?? []).map((p) => ["Iceberg", p])),
    ...(t.HudiTargets ?? []).flatMap((x) => (x.Paths ?? []).map((p) => ["Hudi", p])),
  ].map(([k, v]) => [k, clip(v, 200)]);
}

export const lastErrorOf = (runs: RawJobRun[]) => {
  const failed = [...runs].sort((a, b) => (awsTime(b.StartedOn) ?? 0) - (awsTime(a.StartedOn) ?? 0)).find((r) => FAILED_RUN.has((r.JobRunState ?? "").toUpperCase()) && r.ErrorMessage);
  return failed ? `${failed.JobRunState} ${fmtTime(awsTime(failed.StartedOn))}: ${clip(failed.ErrorMessage!, 300)}` : undefined;
};

