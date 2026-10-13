import { test } from "node:test";
import assert from "node:assert/strict";
import { crawlerHealth, glueResults, jobHealth, lastErrorOf, runRows, s3Bucket, targetRows, type RawCrawler, type RawGlueJob, type RawJobRun } from "./glue.ts";
import { infer } from "./infer.ts";
import { keys, type ProviderResult } from "./types.ts";

const ACCT = "123456789012";
const R = "us-east-1";
const NOW = Date.UTC(2026, 9, 5, 12);
const MIN = 60_000;
const DAY = 86_400_000;
const SENTINEL = "SECRET_SENTINEL_9f1e";
const jobArn = (n: string) => `arn:aws:glue:${R}:${ACCT}:job/${n}`;
const crawlerArn = (n: string) => `arn:aws:glue:${R}:${ACCT}:crawler/${n}`;
const host = "acme-production-pg.c0example.us-east-1.rds.amazonaws.com";

// Job arguments carry connection strings and passwords; the source-control token, the visual job graph and a run's own
// arguments and session policy carry more. None of it may reach props, labels, evidence or link targets.
const job = (o: Partial<RawGlueJob> = {}): RawGlueJob => ({
  Name: "acme-nightly-etl", Description: "Nightly copy of orders", Role: `arn:aws:iam::${ACCT}:role/service-role/AWSGlueServiceRole-etl`,
  CreatedOn: new Date(NOW - 300 * DAY), LastModifiedOn: new Date(NOW - 20 * DAY),
  Command: { Name: "glueetl", ScriptLocation: "s3://acme-data-lake/scripts/nightly_etl.py", PythonVersion: "3" },
  DefaultArguments: { "--TempDir": `s3://acme-scratch/${SENTINEL}/tmp/`, "--SOURCE_DB_URL": `postgres://etl:${SENTINEL}@${host}:5432/shop`, "--job-language": "python" },
  NonOverridableArguments: { "--api_token": SENTINEL },
  Connections: { Connections: ["acme-production-jdbc"] },
  MaxRetries: 1, Timeout: 120, WorkerType: "G.1X", NumberOfWorkers: 4, GlueVersion: "4.0", ExecutionClass: "STANDARD",
  ...o,
  ...({ SourceControlDetails: { AuthToken: SENTINEL }, CodeGenConfigurationNodes: { n1: { JDBCConnectorSource: { ConnectionOptions: { password: SENTINEL } } } } } as object),
});
const run = (state: string, startedAgo: number, o: Partial<RawJobRun> = {}): RawJobRun => ({
  Id: "jr_0123456789abcdef", JobName: "acme-nightly-etl", JobRunState: state, StartedOn: new Date(NOW - startedAgo), CompletedOn: new Date(NOW - startedAgo + 21 * MIN), ExecutionTime: 1262,
  TriggerName: "acme-nightly-0200", ...o, ...({ Arguments: { "--password": SENTINEL }, ExecutionRoleSessionPolicy: SENTINEL } as object),
});
const crawler = (o: Partial<RawCrawler> = {}): RawCrawler => ({
  Name: "acme-orders-crawler", Role: "AWSGlueServiceRole-crawler", DatabaseName: "acme_lake", State: "READY",
  Targets: {
    S3Targets: [{ Path: "s3://acme-data-lake/orders/", EventQueueArn: `arn:aws:sqs:${R}:${ACCT}:lake-events` }],
    JdbcTargets: [{ ConnectionName: "acme-production-jdbc", Path: "shop/%" }],
    DynamoDBTargets: [{ Path: "acme-production-carts" }],
    CatalogTargets: [{ DatabaseName: "acme_raw", Tables: ["orders", "carts"] }],
    DeltaTargets: [{ DeltaTables: ["s3://acme-delta/sales/"] }],
  },
  Schedule: { ScheduleExpression: "cron(30 3 * * ? *)", State: "SCHEDULED" },
  LastCrawl: { Status: "SUCCEEDED", StartTime: new Date(NOW - 8 * 60 * MIN), LogGroup: "/aws-glue/crawlers", LogStream: "acme-orders-crawler" },
  CrawlElapsedTime: 94_000, CreationTime: new Date(NOW - 280 * DAY), LastUpdated: new Date(NOW - 40 * DAY),
  ...o,
});

test("golden: a job whose last run succeeded — links to its script and temp buckets and role; arguments only as mentions", () => {
  const out = glueResults({ region: R, accountId: ACCT, now: NOW, jobs: [job()], runs: { "acme-nightly-etl": run("SUCCEEDED", 10 * 60 * MIN) }, crawlers: [], tags: { [jobArn("acme-nightly-etl")]: { Environment: "production" } } });
  assert.deepEqual(out.resources, [{
    key: jobArn("acme-nightly-etl"), kind: "glue-job", provider: "glue", name: "acme-nightly-etl", region: R, tags: { Environment: "production" }, health: "ok",
    props: [
      { label: "Type", value: "Spark ETL" },
      { label: "Last run", value: "SUCCEEDED at 2026-10-05 02:00 UTC" },
      { label: "Run time", value: "21 min" },
      { label: "Glue version", value: "4.0" },
      { label: "Capacity", value: "4 × G.1X" },
      { label: "Script", value: "s3://acme-data-lake/scripts/nightly_etl.py", mono: true },
      { label: "Connections", value: "acme-production-jdbc" },
      { label: "Arguments", value: "--SOURCE_DB_URL, --TempDir, --api_token, --job-language" },
      { label: "Timeout", value: "120 min" },
      { label: "Max retries", value: "1" },
      { label: "Description", value: "Nightly copy of orders" },
    ],
    aliases: ["acme-nightly-etl"],
    consoleUrl: `https://${R}.console.aws.amazon.com/gluestudio/home?region=${R}#/editor/job/acme-nightly-etl/details`,
    createdAt: NOW - 300 * DAY, lastModified: NOW - 20 * DAY, lastActivityAt: NOW - 10 * 60 * MIN + 21 * MIN, observedAt: NOW,
    enrichment: { lastRun: "ok", tags: "ok" },
  }]);
  assert.deepEqual(out.links, [
    { from: jobArn("acme-nightly-etl"), to: "arn:aws:s3:::acme-data-lake", kind: "reads", label: "script", evidence: "job Command.ScriptLocation" },
    { from: jobArn("acme-nightly-etl"), to: "arn:aws:s3:::acme-scratch", kind: "writes", label: "temporary files", evidence: "job argument --TempDir (bucket)" },
    { from: jobArn("acme-nightly-etl"), to: `arn:aws:iam::${ACCT}:role/service-role/AWSGlueServiceRole-etl`, kind: "assumes", label: "job role", evidence: "job Role" },
  ]);
  // The sentinel: nowhere in resources or links; the arguments' values only in Mention.refs, named by argument.
  assert.ok(!JSON.stringify({ resources: out.resources, links: out.links }).includes(SENTINEL), "argument values, tokens and the job graph never reach the map");
  assert.deepEqual(out.mentions.map((m) => m.via), ["glue job argument --SOURCE_DB_URL", "glue job argument --job-language", "glue job argument --api_token"], "--TempDir is a link already");
  assert.ok(out.mentions.every((m) => !m.via.includes(SENTINEL)));
  assert.ok(out.mentions[0].refs.includes(`postgres://etl:${SENTINEL}@${host}:5432/shop`), "the value stays server-side, for matching only");
});

test("through infer: the argument's connection string becomes a sql edge to the database; no value on the map", () => {
  const rds: ProviderResult = { resources: [{ key: keys.rds("acme-production-pg"), kind: "rds", provider: "rds", name: "acme-production-pg", region: R, tags: {}, health: "ok", props: [], endpoints: [host] }], links: [], mentions: [] };
  const out = infer({ results: [rds, glueResults({ region: R, accountId: ACCT, now: NOW, jobs: [job()], runs: {}, crawlers: [] })], home: R, accountId: ACCT, regions: [R] });
  const e = out.edges.find((x) => x.from === jobArn("acme-nightly-etl") && x.to === keys.rds("acme-production-pg"));
  assert.deepEqual([e?.kind, e?.confidence, e?.evidence], ["sql", "mentioned", ["glue job argument --SOURCE_DB_URL"]]);
  assert.ok(!JSON.stringify(out).includes(SENTINEL));
});

test("job health: a failed, errored or timed-out last run warns; runs not read are unknown; never run is ok", () => {
  assert.deepEqual(jobHealth(run("FAILED", 2 * DAY), "ok"), { health: "warning", reason: "last run FAILED at 2026-10-03 12:21 UTC" });
  assert.equal(jobHealth(run("TIMEOUT", DAY), "ok").health, "warning");
  assert.equal(jobHealth(run("ERROR", DAY), "ok").health, "warning");
  assert.deepEqual(jobHealth(run("STOPPED", DAY), "ok"), { health: "ok" });
  assert.deepEqual(jobHealth(undefined, "ok"), { health: "ok" });
  assert.deepEqual(jobHealth(undefined, "capped"), { health: "unknown", reason: "last run not read (capped)" });
  const out = glueResults({ region: R, accountId: ACCT, now: NOW, jobs: [job(), job({ Name: "never" })], runs: {}, runState: { "acme-nightly-etl": "denied" }, crawlers: [] });
  assert.deepEqual(out.resources.map((r) => [r.name, r.health, r.props.find((p) => p.label === "Last run")?.value, r.lastActivityAt]), [
    ["acme-nightly-etl", "unknown", "last run not read (denied)", undefined],
    ["never", "ok", "never run", undefined],
  ]);
  const listed = glueResults({ region: R, accountId: ACCT, now: NOW, jobs: [job()], crawlers: [] }).resources[0];
  assert.deepEqual([listed.health, listed.tagsUnread, listed.enrichment], ["unknown", true, { lastRun: "skipped" }], "the checkpoint: runs and tags not read yet");
});

test("golden: a crawler — reads its targets, polls its S3 events, writes its database, logs to Glue's group", () => {
  const out = glueResults({ region: R, accountId: ACCT, now: NOW, jobs: [], crawlers: [crawler()], tags: { [crawlerArn("acme-orders-crawler")]: {} } });
  const c = out.resources[0];
  assert.deepEqual([c.key, c.kind, c.health, c.lastActivityAt, c.tags, c.tagsUnread], [crawlerArn("acme-orders-crawler"), "glue-crawler", "ok", NOW - 8 * 60 * MIN, {}, undefined]);
  assert.deepEqual(c.props, [
    { label: "State", value: "ready" },
    { label: "Last crawl", value: "SUCCEEDED at 2026-10-05 04:00 UTC" },
    { label: "Schedule", value: "daily at 03:30 UTC" },
    { label: "Database", value: "acme_lake" },
    { label: "Targets", value: "s3://acme-data-lake/orders/, JDBC acme-production-jdbc shop/%, DynamoDB acme-production-carts, catalog acme_raw (2 tables), s3://acme-delta/sales/", mono: true },
    { label: "Crawl time", value: "2 min" },
  ]);
  const k = crawlerArn("acme-orders-crawler");
  assert.deepEqual(out.links.map((l) => [l.to, l.kind, l.label]), [
    [`arn:aws:sqs:${R}:${ACCT}:lake-events`, "poll", "S3 events"],
    ["arn:aws:s3:::acme-data-lake", "reads", "S3 target"],
    [`arn:aws:dynamodb:${R}:${ACCT}:table/acme-production-carts`, "reads", "DynamoDB target"],
    [`arn:aws:glue:${R}:${ACCT}:database/acme_raw`, "reads", "catalog target"],
    ["arn:aws:s3:::acme-delta", "reads", "table target"],
    [`arn:aws:glue:${R}:${ACCT}:database/acme_lake`, "writes", "table definitions"],
    [`arn:aws:iam::${ACCT}:role/AWSGlueServiceRole-crawler`, "assumes", "crawler role"],
    [`arn:aws:logs:${R}:${ACCT}:log-group:/aws-glue/crawlers`, "logs", "crawl logs"],
  ]);
  assert.ok(out.links.every((l) => l.from === k));
  // A cross-account DynamoDB target is named by its ARN: kept as given, not wrapped in another table ARN.
  const remote = `arn:aws:dynamodb:${R}:210987654321:table/partner-orders`;
  const x = glueResults({ region: R, accountId: ACCT, now: NOW, jobs: [], crawlers: [crawler({ Targets: { DynamoDBTargets: [{ Path: remote }] } })] });
  assert.deepEqual(x.links.filter((l) => l.kind === "reads").map((l) => l.to), [remote]);
});

test("crawler health and activity: a failed crawl warns; a running crawler is active now; paused schedules say so", () => {
  assert.deepEqual(crawlerHealth(crawler({ LastCrawl: { Status: "FAILED", StartTime: new Date(NOW - DAY), ErrorMessage: "Insufficient Lake Formation permission(s)" } })), { health: "warning", reason: "last crawl FAILED at 2026-10-04 12:00 UTC: Insufficient Lake Formation permission(s)" });
  assert.deepEqual(crawlerHealth(crawler({ LastCrawl: { Status: "CANCELLED" } })), { health: "ok" });
  const out = glueResults({ region: R, accountId: ACCT, now: NOW, jobs: [], crawlers: [crawler({ State: "RUNNING", Schedule: { ScheduleExpression: "cron(30 3 * * ? *)", State: "NOT_SCHEDULED" }, LastCrawl: undefined })] });
  const c = out.resources[0];
  assert.deepEqual([c.lastActivityAt, c.props.find((p) => p.label === "Schedule")?.value, c.props.find((p) => p.label === "Last crawl")?.value], [NOW, "daily at 03:30 UTC (paused)", "never crawled"]);
});

test("keys: the account from the role's ARN, else the console's; without either, no node", () => {
  const out = glueResults({ region: R, now: NOW, jobs: [job({ Role: "arn:aws:iam::210987654321:role/x" }), job({ Name: "b", Role: "plain-name" })], crawlers: [] });
  assert.deepEqual(out.resources.map((r) => r.key), ["arn:aws:glue:us-east-1:210987654321:job/acme-nightly-etl"]);
});

test("detail rows: runs newest first without arguments; targets; the latest failure's message, shortened", () => {
  const runs = [run("SUCCEEDED", 2 * DAY), run("FAILED", DAY, { Id: "jr_2", ErrorMessage: "An error occurred while calling o108.pyWriteDynamicFrame. " + "x".repeat(400) })];
  assert.deepEqual(runRows(runs).map((r) => [r[0], r[1]]), [["jr_2", "FAILED"], ["jr_0123456789abcdef", "SUCCEEDED"]]);
  assert.ok(!JSON.stringify(runRows(runs)).includes(SENTINEL));
  assert.ok(lastErrorOf(runs)!.startsWith("FAILED 2026-10-04 12:00 UTC: An error occurred"));
  assert.equal(lastErrorOf([run("SUCCEEDED", DAY)]), undefined);
  assert.deepEqual(targetRows(crawler()).map((r) => r[0]), ["S3", "JDBC", "DynamoDB", "Data Catalog", "Delta"]);
  assert.deepEqual([s3Bucket("s3a://b-1/x"), s3Bucket("s3://Bad_Bucket/x"), s3Bucket("acme/x")], ["arn:aws:s3:::b-1", undefined, undefined]);
});
