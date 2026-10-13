// Lambda provider: functions with their triggers (event source mappings from SQS / Kinesis / DynamoDB streams),
// dead-letter and async-destination targets, function URLs, VPC placement, reserved concurrency, the support links
// (execution role, the KMS key of the environment variables, the log group, EFS mounts) and env-var mentions (values
// stay on the server). The panel adds versions, aliases (with canary weights), triggers from the resource policy,
// configuration, and status kept in three parts: exists, deployment state, runtime health (errors and throttles).
// Actions: deploy code (zip / S3 / image, optional publish + alias move), publish a version, shift or roll back an
// alias, invoke a test event (danger: runs code with the function's role), set reserved concurrency and edit
// environment variables (values never echoed).
//
// Discovery lists, hands the list to ctx.checkpoint, then enriches the first 300 functions through enrich() (R18):
// deployment state and tags first, then URL, concurrency and destinations. R12: the deployment state (State,
// LastUpdateStatus) comes from GetFunctionConfiguration — ListFunctions leaves it out — cached on globalThis per
// FunctionArn + LastModified + CodeSha256; only the six state fields are kept, never the environment values that read
// also returns (the same values ListFunctions returns, so the read is declared like the list). GetFunction is never
// called: it also returns a presigned code-download URL.
import "server-only";
import {
  DeleteFunctionConcurrencyCommand, GetFunctionConcurrencyCommand, GetFunctionConfigurationCommand, GetPolicyCommand, InvokeCommand, LambdaClient,
  ListAliasesCommand, ListEventSourceMappingsCommand, ListFunctionEventInvokeConfigsCommand, ListFunctionUrlConfigsCommand, ListFunctionsCommand,
  ListTagsCommand, ListVersionsByFunctionCommand, PublishVersionCommand, PutFunctionConcurrencyCommand, UpdateAliasCommand, UpdateFunctionCodeCommand,
  UpdateFunctionConfigurationCommand, type FunctionConfiguration,
} from "@aws-sdk/client-lambda";
import { CloudWatchClient, GetMetricDataCommand } from "@aws-sdk/client-cloudwatch";
import { MAX_ZIP_BASE64, codeSha256, decodeZip, summarizePackage } from "../../inventory/serverless-code.ts";
import {
  arnName, awsTime, byteLength, clip, editEnv, field, fmtBytes, fmtCount, fmtSeconds, fmtTime, jsonProblem, lambdaBase, parseArn, pickFields, plural,
  propOf, runtimeDeprecation,
} from "../../inventory/serverless-common.ts";
import {
  DEPLOY_FIELDS, IMAGE_PACKAGE, P, configCache, deployLabel, deploySource, deployStateOf, describeAlias, isImage, lambdaResult, policyTriggers, rollbackTarget,
  shiftProblem, type Canary, type ConfigCacheEntry, type DeployInput, type DeployState, type RawAlias, type RawFunction, type RawFunctionEx, type RawLambda,
  type RawMapping,
} from "../../inventory/serverless-lambda.ts";
import type { Resource, ResourceDetail } from "../../inventory/types.ts";
import type { JsonSchema } from "../ops/types.ts";
import {
  simConcurrency, simDeploy, simDestinations, simFn, simFunctionConfiguration, simInvoke, simListFunctions, simMappings, simPublish, simReserved, simSetEnv,
  simTags, simUpdateAlias, simUrl,
} from "./mock/lambda.ts";
import { HOUR, series } from "./mock/serverless-sim.ts";
import { budget, conflict, enrich, invalid, own, paged, perRegion, sdkConfig, simDelay, softly, t } from "./serverless-util.ts";
import type { ActionContext, Provider, ProviderAction, ProviderContext } from "./types.ts";

const lambda = perRegion((region) => new LambdaClient(sdkConfig(region)), "lambda");
// F31: a RequestResponse invoke is sent once. A retry after an answer was lost would run the function a second time.
const lambdaOnce = perRegion((region) => new LambdaClient(sdkConfig(region, { maxAttempts: 1 })), "lambda");
const cloudwatch = perRegion((region) => new CloudWatchClient(sdkConfig(region)), "cloudwatch");

const DETAILS_MAX = 300; // functions whose deployment state / tags / URL / concurrency / destinations are read (5 calls each, fewer with the cache)
const AUTHORITATIVE_MS = 5_000; // the live tag read before a change (R01)
const LOG_TAIL = 4096;
const MAX_EVENT = 64 * 1024;

const regionOf = (r: Resource, fallback: string) => parseArn(r.key)?.region || r.region || fallback;
const nameOf = (r: Resource) => r.name || arnName(r.key);

// The deployment-state cache (R12), shared by the routes and the instrumentation bundle: an entry is used while the
// function's LastModified and CodeSha256 are unchanged, its state is settled and it is under an hour old.
const configs = () => {
  const g = globalThis as { __consoleLambdaConfigs?: Map<string, ConfigCacheEntry> };
  return configCache((g.__consoleLambdaConfigs ??= new Map()), { ttlMs: 60 * 60_000, max: 10_000 });
};

// ---------- discovery ----------

// The reads discovery makes, one per API call: the real account's, or the simulation's, which models the same API
// (the list carries no deployment state). Both go through the same list → checkpoint → enrich path below.
interface LambdaReads {
  functions(): Promise<(RawFunction & { lastActivityAt?: number })[]>;
  mappings(): Promise<RawMapping[]>;
  config(arn: string): Promise<RawFunction>;
  tags(arn: string): Promise<Record<string, string>>;
  url(arn: string): Promise<RawFunctionEx["url"]>;
  reserved(arn: string): Promise<number | undefined>;
  destinations(arn: string): Promise<RawFunctionEx["destinations"]>;
}

function realReads(ctx: ProviderContext): LambdaReads {
  const c = lambda(ctx.region);
  return {
    functions: () => paged(ctx, "lambda", async (Marker) => {
      const r = await c.send(new ListFunctionsCommand({ Marker, MaxItems: 50 }), t(ctx));
      return { items: r.Functions, next: r.NextMarker };
    }, { service: "lambda" }),
    mappings: () => paged(ctx, "lambda event source mappings", async (Marker) => {
      const r = await c.send(new ListEventSourceMappingsCommand({ Marker, MaxItems: 100 }), t(ctx));
      return { items: r.EventSourceMappings, next: r.NextMarker };
    }, { service: "lambda" }),
    config: (arn) => c.send(new GetFunctionConfigurationCommand({ FunctionName: arn }), t(ctx)),
    tags: async (arn) => (await c.send(new ListTagsCommand({ Resource: arn }), t(ctx))).Tags ?? {},
    url: async (arn) => {
      const u = await c.send(new ListFunctionUrlConfigsCommand({ FunctionName: arn, MaxItems: 10 }), t(ctx));
      const x = u.FunctionUrlConfigs?.find((y) => y.FunctionArn === arn) ?? u.FunctionUrlConfigs?.[0];
      return x?.FunctionUrl ? { url: x.FunctionUrl, authType: x.AuthType } : undefined;
    },
    reserved: async (arn) => (await c.send(new GetFunctionConcurrencyCommand({ FunctionName: arn }), t(ctx))).ReservedConcurrentExecutions,
    destinations: async (arn) => {
      const ev = await c.send(new ListFunctionEventInvokeConfigsCommand({ FunctionName: arn, MaxItems: 10 }), t(ctx));
      const cfg = ev.FunctionEventInvokeConfigs?.find((x) => x.FunctionArn && lambdaBase(x.FunctionArn) === x.FunctionArn) ?? ev.FunctionEventInvokeConfigs?.[0];
      const d = cfg?.DestinationConfig;
      return d?.OnSuccess?.Destination || d?.OnFailure?.Destination ? { onSuccess: d.OnSuccess?.Destination, onFailure: d.OnFailure?.Destination } : undefined;
    },
  };
}

function mockReads(ctx: ProviderContext): LambdaReads {
  return {
    functions: async () => simListFunctions(ctx.region),
    mappings: async () => simMappings(ctx.region),
    config: async (arn) => simFunctionConfiguration(arn),
    tags: async (arn) => simTags(arn),
    url: async (arn) => simUrl(arn),
    reserved: async (arn) => simReserved(arn),
    destinations: async (arn) => simDestinations(arn),
  };
}

// R12: the function's deployment state, from the cache when its version is unchanged, else read and cached. Only the
// state fields survive deployStateOf(): the environment values in the answer are dropped before anything is kept.
async function deployState(io: LambdaReads, f: RawFunction): Promise<DeployState> {
  const cache = configs();
  const hit = cache.get(f, Date.now());
  if (hit) return hit;
  const state = deployStateOf(await io.config(f.FunctionArn!));
  cache.put(f, state, Date.now());
  return state;
}

async function fetchLambda(ctx: ProviderContext, io: LambdaReads): Promise<RawLambda> {
  const fns = await io.functions();
  const mappings = (await softly(ctx, "lambda event source mappings", { limited: false, service: "lambda" })(() => io.mappings())) ?? [];
  // What the list says — no deployment state (AWS doesn't send it here; a stray one is dropped). Served, marked partial,
  // if the deadline cuts the reads below short.
  const out: RawFunctionEx[] = fns.map((f) => {
    const x: RawFunctionEx = { ...f };
    for (const k of DEPLOY_FIELDS) delete x[k];
    return x;
  });
  ctx.checkpoint?.(lambdaResult({ functions: out, mappings }, Date.now()));

  const until = budget();
  const read = <R>(label: string, fn: (f: RawFunctionEx) => Promise<R>) => enrich(ctx, out, { label: `lambda ${label}`, max: DETAILS_MAX, until }, fn);
  // Health and protection first, then the reads that only add detail.
  const [state, tags] = await Promise.all([read("deployment state", (f) => deployState(io, f)), read("tags", (f) => io.tags(f.FunctionArn!))]);
  const [urls, conc, dest] = await Promise.all([
    read("function URLs", (f) => io.url(f.FunctionArn!)),
    read("reserved concurrency", (f) => io.reserved(f.FunctionArn!)),
    read("async destinations", (f) => io.destinations(f.FunctionArn!)),
  ]);
  out.forEach((f, i) => {
    const s = state.results[i];
    if (s) Object.assign(f, s);
    f.deployState = state.state[i] !== "ok" ? state.state[i] : s ? "ok" : "error"; // ok without an answer: gone since the list
    if (tags.state[i] === "ok") f.tags = tags.results[i] ?? {};
    if (urls.state[i] === "ok") f.url = urls.results[i];
    if (conc.state[i] === "ok") f.reserved = conc.results[i];
    if (dest.state[i] === "ok") f.destinations = dest.results[i];
    f.enrichment = { state: f.deployState, tags: tags.state[i], url: urls.state[i], concurrency: conc.state[i], destinations: dest.state[i] };
  });
  return { functions: out, mappings };
}

// ---------- detail ----------

interface DetailInput {
  cfg?: RawFunction;
  reserved?: number;
  versions: { version: string; at?: number; sha?: string; size?: number; description?: string }[];
  aliases: RawAlias[];
  mappings: RawMapping[];
  triggers: { principal: string; source?: string }[];
  metrics?: { errors: [number, number][]; throttles: [number, number][]; invocations: [number, number][] };
}

const short = (sha?: string) => (sha ? `${sha.slice(0, 12)}…` : "—");
const sum = (pts?: [number, number][]) => (pts ?? []).reduce((n, [, v]) => n + v, 0);

// Status in its three parts (R12): the function exists, what Lambda says about its deployment, and how its code is
// doing at run time (CloudWatch errors and throttles) — one doesn't imply the others.
function statusRows(d: DetailInput): ResourceDetail["sections"][number] {
  const f = d.cfg;
  const inv = sum(d.metrics?.invocations);
  const err = sum(d.metrics?.errors);
  const thr = sum(d.metrics?.throttles);
  return {
    title: "Status",
    rows: [
      { label: "Exists", value: f ? "yes" : "not found — it may have been deleted" },
      { label: P.deploy, value: f ? deployLabel({ ...f, deployState: "ok" }) + (f.StateReason && f.State !== "Active" ? ` — ${clip(f.StateReason, 160)}` : f.LastUpdateStatusReason && f.LastUpdateStatus === "Failed" ? ` — ${clip(f.LastUpdateStatusReason, 160)}` : "") : "not read" },
      {
        label: "Runtime health (last 3 hours)",
        value: !d.metrics ? "not read (CloudWatch metrics)" : !inv && !thr ? "no invocations" : `${fmtCount(err)} errors in ${plural(inv, "invocation")}${inv ? ` (${+((err / inv) * 100).toFixed(2)} %)` : ""} · ${fmtCount(thr)} throttled`,
      },
    ],
  };
}

function buildDetail(key: string, d: DetailInput, now: number): ResourceDetail {
  const f = d.cfg;
  const dep = runtimeDeprecation(f?.Runtime, now);
  const vars = Object.keys(f?.Environment?.Variables ?? {}).sort();
  const sections: ResourceDetail["sections"] = [statusRows(d)];
  if (f) {
    sections.push({
      title: "Configuration",
      rows: [
        isImage(f) ? { label: "Package type", value: "Container image" } : { label: "Runtime", value: f.Runtime ?? "?" },
        { label: "Architecture", value: (f.Architectures ?? ["x86_64"]).join(", ") },
        { label: "Memory", value: `${f.MemorySize ?? 128} MB` },
        { label: "Timeout", value: fmtSeconds(f.Timeout ?? 3) },
        { label: "Ephemeral storage", value: `${f.EphemeralStorage?.Size ?? 512} MB` },
        ...(f.Handler ? [{ label: "Handler", value: f.Handler, mono: true }] : []),
        ...(!isImage(f) ? [{ label: "Code size", value: fmtBytes(f.CodeSize) }] : []),
        { label: "Code SHA-256", value: f.CodeSha256 ?? "—", mono: true },
        { label: "Last modified", value: fmtTime(awsTime(f.LastModified)) },
        { label: "Reserved concurrency", value: d.reserved === undefined ? "unreserved (account pool)" : d.reserved === 0 ? "0 — every invocation is throttled" : String(d.reserved) },
        ...(f.Role ? [{ label: "Role", value: f.Role, mono: true }] : []),
        ...(f.LoggingConfig?.LogGroup ? [{ label: "Log group", value: f.LoggingConfig.LogGroup, mono: true }] : []),
        { label: "Tracing", value: f.TracingConfig?.Mode === "Active" ? "X-Ray active" : "pass-through" },
        ...(f.VpcConfig?.VpcId ? [{ label: "VPC", value: `${f.VpcConfig.VpcId} · subnets ${(f.VpcConfig.SubnetIds ?? []).join(", ")} · security groups ${(f.VpcConfig.SecurityGroupIds ?? []).join(", ")}`, mono: true }] : []),
        ...(f.Layers?.length ? [{ label: "Layers", value: f.Layers.map((l) => arnName(l.Arn?.replace(/:\d+$/, "")) + (l.Arn?.match(/:(\d+)$/)?.[0] ?? "")).join(", "), mono: true }] : []),
        ...(f.KMSKeyArn ? [{ label: "Variables key", value: arnName(f.KMSKeyArn), mono: true }] : []),
      ],
      note: dep?.deprecated ? `Runtime ${f.Runtime} is deprecated since ${dep.date}: no security patches, and AWS will block creating and then updating functions on it. Move to a supported runtime.` : dep?.soon ? `Runtime ${f.Runtime} is deprecated on ${dep.date}.` : undefined,
    });
    sections.push({
      title: "Environment variables",
      table: vars.length ? { columns: ["Name"], rows: vars.map((v) => [v]) } : undefined,
      note: vars.length ? "Names only — values are never shown. Change them with “Update environment variables”." : "No environment variables.",
    });
  }
  sections.push({
    title: "Aliases",
    table: d.aliases.length ? { columns: ["Alias", "Points at", "Description"], rows: d.aliases.map((a) => [a.Name ?? "?", describeAlias(a), a.Description ?? ""]) } : undefined,
    note: d.aliases.length ? undefined : "No aliases.",
  });
  const versions = d.versions.filter((v) => v.version !== "$LATEST").sort((a, b) => Number(b.version) - Number(a.version));
  sections.push({
    title: "Versions",
    table: versions.length ? { columns: ["Version", "Published", "Code SHA-256", "Size", "Description"], rows: versions.slice(0, 15).map((v) => [v.version, fmtTime(v.at), short(v.sha), fmtBytes(v.size), v.description ?? ""]) } : undefined,
    note: versions.length > 15 ? `Showing the newest 15 of ${versions.length} versions.` : versions.length ? undefined : "Only $LATEST — no published versions.",
  });
  const triggerRows = [
    ...d.mappings.map((m) => [arnName(m.EventSourceArn), `event source mapping (${parseArn(m.EventSourceArn)?.service ?? "?"})`, `${(m.State ?? "?").toLowerCase()} · batch ${m.BatchSize ?? "?"}${m.LastProcessingResult ? ` · last: ${m.LastProcessingResult}` : ""}`]),
    ...d.triggers.map((x) => [x.source ? arnName(x.source) || x.source : "(any)", `resource policy: ${x.principal}`, x.source ? clip(x.source, 90) : ""]),
  ];
  sections.push({ title: "Triggers", table: triggerRows.length ? { columns: ["Source", "How", "Details"], rows: triggerRows } : undefined, note: triggerRows.length ? undefined : "No triggers found." });
  return {
    key,
    sections,
    metrics: d.metrics ? [
      { id: "errors", label: "Errors (5 min)", points: d.metrics.errors },
      { id: "throttles", label: "Throttles (5 min)", points: d.metrics.throttles },
    ] : undefined,
  };
}

async function errorMetrics(region: string, name: string, ctx: ProviderContext): Promise<DetailInput["metrics"]> {
  const end = new Date();
  const start = new Date(end.getTime() - 3 * HOUR);
  const q = (id: string, metric: string) => ({ Id: id, MetricStat: { Metric: { Namespace: "AWS/Lambda", MetricName: metric, Dimensions: [{ Name: "FunctionName", Value: name }] }, Period: 300, Stat: "Sum" } });
  const r = await cloudwatch(region).send(new GetMetricDataCommand({ StartTime: start, EndTime: end, ScanBy: "TimestampAscending", MetricDataQueries: [q("errors", "Errors"), q("throttles", "Throttles"), q("invocations", "Invocations")] }), t(ctx));
  const pts = (id: string): [number, number][] => {
    const m = r.MetricDataResults?.find((x) => x.Id === id);
    return (m?.Timestamps ?? []).map((ts, i) => [ts.getTime(), m?.Values?.[i] ?? 0]);
  };
  return { errors: pts("errors"), throttles: pts("throttles"), invocations: pts("invocations") };
}

async function allVersions(c: LambdaClient, FunctionName: string, ctx?: { signal?: AbortSignal }): Promise<FunctionConfiguration[]> {
  const out: FunctionConfiguration[] = [];
  let Marker: string | undefined;
  do {
    const r = await c.send(new ListVersionsByFunctionCommand({ FunctionName, Marker, MaxItems: 50 }), t(ctx));
    out.push(...(r.Versions ?? []));
    Marker = r.NextMarker;
  } while (Marker && out.length < 1000);
  return out;
}

async function allAliases(c: LambdaClient, FunctionName: string, ctx?: { signal?: AbortSignal }): Promise<RawAlias[]> {
  const out: RawAlias[] = [];
  let Marker: string | undefined;
  do {
    const r = await c.send(new ListAliasesCommand({ FunctionName, Marker, MaxItems: 50 }), t(ctx));
    out.push(...(r.Aliases ?? []));
    Marker = r.NextMarker;
  } while (Marker && out.length < 500);
  return out;
}

async function realDetail(r: Resource, ctx: ProviderContext): Promise<ResourceDetail> {
  const region = regionOf(r, ctx.region);
  const c = lambda(region);
  const FunctionName = nameOf(r);
  const [cfg, versions, aliases, mappings, policy, metrics, conc] = await Promise.all([
    softly(ctx, "lambda configuration")(() => c.send(new GetFunctionConfigurationCommand({ FunctionName: r.key }), t(ctx))),
    softly(ctx, "lambda versions")(() => allVersions(c, FunctionName, ctx)),
    softly(ctx, "lambda aliases")(() => allAliases(c, FunctionName, ctx)),
    softly(ctx, "lambda event source mappings")(() => c.send(new ListEventSourceMappingsCommand({ FunctionName, MaxItems: 100 }), t(ctx))),
    softly(ctx, "lambda resource policy")(() => c.send(new GetPolicyCommand({ FunctionName }), t(ctx))),
    softly(ctx, "lambda metrics")(() => errorMetrics(region, FunctionName, ctx)),
    softly(ctx, "lambda reserved concurrency")(() => c.send(new GetFunctionConcurrencyCommand({ FunctionName }), t(ctx))),
  ]);
  return buildDetail(r.key, {
    cfg,
    reserved: conc?.ReservedConcurrentExecutions,
    versions: (versions ?? []).map((v) => ({ version: v.Version ?? "?", at: awsTime(v.LastModified), sha: v.CodeSha256, size: v.CodeSize, description: v.Description })),
    aliases: aliases ?? [],
    mappings: mappings?.EventSourceMappings ?? [],
    triggers: policyTriggers(policy?.Policy),
    metrics,
  }, Date.now());
}

function mockDetail(r: Resource): ResourceDetail {
  const f = simFn(r.key);
  if (!f) return { key: r.key, sections: [{ title: "Not found", note: "This function no longer exists in the simulated account." }] };
  const now = Date.now();
  const inv = series(`${r.key}:inv`, now, 36, 300_000, f.rate / 12);
  const errors = inv.map(([ts, v], i) => [ts, Math.round(v * f.errorShare * (1 + ((i * 7) % 5)))] as [number, number]);
  const throttles = inv.map(([ts]) => [ts, f.reserved === 0 ? 3 : 0] as [number, number]);
  return buildDetail(r.key, {
    cfg: simFunctionConfiguration(r.key),
    reserved: f.reserved,
    versions: f.versions.map((v) => ({ version: v.version, at: v.at, sha: v.sha, size: v.size, description: v.description })),
    aliases: f.aliases,
    mappings: simMappings().filter((m) => m.FunctionArn && lambdaBase(m.FunctionArn) === r.key),
    triggers: f.triggers,
    metrics: { invocations: inv, errors, throttles },
  }, now);
}

// ---------- actions: shared reads ----------

type Live = { cfg: RawFunction & { RevisionId?: string }; reserved?: number };

async function live(r: Resource, ctx: ActionContext): Promise<Live> {
  const name = nameOf(r);
  if (ctx.mock) {
    const f = simFn(r.key);
    if (!f) throw invalid(`function ${name} not found`);
    return { cfg: simFunctionConfiguration(r.key), reserved: f.reserved };
  }
  const c = lambda(regionOf(r, ctx.region));
  const [cfg, conc] = await Promise.all([
    c.send(new GetFunctionConfigurationCommand({ FunctionName: name }), t()),
    c.send(new GetFunctionConcurrencyCommand({ FunctionName: name }), t()).catch(() => undefined),
  ]);
  return { cfg, reserved: conc?.ReservedConcurrentExecutions };
}

async function versionsOf(r: Resource, ctx: ActionContext): Promise<string[]> {
  if (ctx.mock) return ["$LATEST", ...(simFn(nameOf(r))?.versions.map((v) => v.version) ?? [])];
  return (await allVersions(lambda(regionOf(r, ctx.region)), nameOf(r))).map((v) => v.Version ?? "").filter(Boolean);
}

async function aliasOf(r: Resource, alias: string, ctx: ActionContext): Promise<RawAlias> {
  const list = ctx.mock ? simFn(nameOf(r))?.aliases ?? [] : await allAliases(lambda(regionOf(r, ctx.region)), nameOf(r));
  const a = list.find((x) => x.Name === alias);
  if (!a) throw invalid(`alias "${alias}" doesn't exist on ${nameOf(r)}${list.length ? ` (aliases: ${list.map((x) => x.Name).join(", ")})` : " (it has no aliases)"}`);
  return a;
}

// Real updates are asynchronous: wait (bounded) until Lambda reports the update finished.
async function settled(r: Resource, ctx: ActionContext, maxMs = 90_000): Promise<RawFunction> {
  const name = nameOf(r);
  const deadline = Date.now() + maxMs;
  for (;;) {
    const cfg = ctx.mock ? simFunctionConfiguration(r.key) : await lambda(regionOf(r, ctx.region)).send(new GetFunctionConfigurationCommand({ FunctionName: name }), t());
    if (cfg.LastUpdateStatus !== "InProgress" || Date.now() > deadline) return cfg;
    await new Promise((res) => setTimeout(res, ctx.mock ? 500 : 2_000));
  }
}

const inProgress = (r: Resource) => (r.healthReason === "update in progress" ? "an update is in progress — wait for it to finish" : undefined);

// ---------- actions ----------

const ALIAS_NAME: JsonSchema = { type: "string", pattern: "^(?!^[0-9]+$)[A-Za-z0-9_-]{1,128}$", description: "Alias name, e.g. live." };
const VERSION: JsonSchema = { type: "string", pattern: "^([0-9]{1,10}|\\$LATEST)$", description: "A published version number, or $LATEST." };

// deploy-code's form shows one way to give the code at a time (x-group on each field): a .zip upload or a .zip in S3
// for .zip functions, an image URI only for functions whose Package type prop is "Container image".
const DEPLOY_GROUPS = [
  { id: "zip", title: "Upload a .zip", unlessProp: { label: P.package, value: IMAGE_PACKAGE } },
  { id: "s3", title: "A .zip in S3", unlessProp: { label: P.package, value: IMAGE_PACKAGE } },
  { id: "image", title: "Container image", ifProp: { label: P.package, value: IMAGE_PACKAGE } },
];

const deployCode: ProviderAction<DeployInput> = {
  id: "deploy-code",
  kind: "lambda",
  title: "Deploy new code",
  description:
    "Replaces the function's code: a .zip upload (zipBase64, at most 8 MB), a .zip already in S3 (s3Bucket + s3Key, optional s3ObjectVersion — the console's role needs s3:GetObject on it), or, for container-image functions, an ECR image URI (imageUri). Waits until Lambda finishes the update, then optionally publishes a version (publish: true) and moves an alias to it (alias, needs publish). The plan shows the package size and SHA-256 (base64, the form Lambda reports as CodeSha256), whether the handler file is in the zip, the runtime, and where the alias will move. Refused when the source doesn't fit the function's package type or an update is already running. Returns the new CodeSha256, size, version and alias.",
  risk: "danger", // new code runs with the function's role on its next trigger: an agent's request always needs a person
  perm: "act",
  summary: "Replaces the function's code with a new .zip or container image, then can publish a version and move an alias to it.",
  iam: ["lambda:UpdateFunctionCode", "lambda:PublishVersion", "lambda:UpdateAlias"],
  undo: "Roll back by publishing the previous version to the alias (Roll back an alias); $LATEST keeps the new code until the previous package is deployed again",
  verifies: "Lambda reports LastUpdateStatus Successful for the new code (its CodeSha256 is in the result); a published version and the alias's new routing are in the result too",
  retrySafe: true, // the same package again leaves the same code, version and alias
  input: {
    type: "object",
    additionalProperties: false,
    "x-groups": DEPLOY_GROUPS,
    properties: {
      zipBase64: field("Upload a .zip", { type: "string", maxLength: MAX_ZIP_BASE64 + 4, description: "The deployment package (.zip), base64-encoded; at most 8 MB decoded." }, "zip"),
      s3Bucket: field("S3 bucket", { type: "string", pattern: "^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$", description: "S3 bucket holding the .zip (same region as the function)." }, "s3"),
      s3Key: field("S3 object key", { type: "string", minLength: 1, maxLength: 1024, description: "Object key of the .zip." }, "s3"),
      s3ObjectVersion: field("S3 object version (optional)", { type: "string", maxLength: 1024, description: "Object version, for versioned buckets." }, "s3"),
      imageUri: field("Container image URI", { type: "string", maxLength: 512, pattern: "^[0-9]{12}\\.dkr\\.ecr\\.[a-z0-9-]+\\.amazonaws\\.com(\\.cn)?/[a-z0-9._/-]+(:[A-Za-z0-9._-]{1,128}|@sha256:[a-f0-9]{64})$", description: "ECR image URI, for container-image functions." }, "image"),
      publish: field("Publish a new version afterwards", { type: "boolean", default: false, description: "Publish a version after the update." }),
      alias: field("Then move this alias", { ...ALIAS_NAME, description: "Move this alias to the new version; needs “Publish a new version afterwards” (publish: true)." }),
      description: field("Version description (optional)", { type: "string", maxLength: 256, description: "Description of the published version." }),
    },
  },
  auditSummary: (res) => pickFields(res, ["function", "codeSha256", "codeSize", "version", "alias", "status"]),
  when: inProgress,
  async plan(r, i, ctx) {
    const { cfg } = await live(r, ctx);
    const src = deploySource(i, cfg.PackageType);
    if ("problem" in src) throw invalid(src.problem);
    const name = nameOf(r);
    const changes: string[] = [];
    const warnings: string[] = [];
    if (src.kind === "zip") {
      const z = decodeZip(i.zipBase64 ?? "");
      if (!z.bytes) throw invalid(z.problem ?? "unreadable package");
      const pkg = summarizePackage(z.bytes, cfg.Runtime, cfg.Handler);
      changes.push(`code: upload a ${fmtBytes(pkg.size)} zip${pkg.files !== undefined ? ` (${plural(pkg.files, "file")})` : ""}, sha256 ${pkg.sha256}`);
      if (pkg.sha256 === cfg.CodeSha256) warnings.push("identical to the deployed code (same sha256) — nothing would change");
      warnings.push(...pkg.warnings);
    } else if (src.kind === "s3") {
      changes.push(`code: from s3://${src.bucket}/${src.key}${src.version ? ` (version ${src.version})` : ""} — size and sha256 are known once Lambda has fetched it`);
    } else changes.push(`image: ${src.uri}`);
    changes.push(`replaces: ${isImage(cfg) ? "the current image" : `${fmtBytes(cfg.CodeSize)}`}, sha256 ${cfg.CodeSha256 ?? "?"}, last modified ${fmtTime(awsTime(cfg.LastModified))}`);
    changes.push(isImage(cfg) ? "package: container image (unchanged)" : `runtime: ${cfg.Runtime} · handler ${cfg.Handler} (unchanged)`);
    if (i.publish) {
      const versions = await versionsOf(r, ctx);
      const last = versions.filter((v) => /^\d+$/.test(v)).map(Number).sort((a, b) => b - a)[0];
      changes.push(`then: publish version ${last === undefined ? 1 : last + 1}`);
    }
    if (i.alias) {
      const a = await aliasOf(r, i.alias, ctx);
      changes.push(`then: move alias ${i.alias} from ${describeAlias(a)} to the new version${Object.keys(a.RoutingConfig?.AdditionalVersionWeights ?? {}).length ? " (its canary routing is removed)" : ""}`);
    } else if (i.publish) changes.push("no alias moves — traffic through aliases stays where it is");
    const dep = runtimeDeprecation(cfg.Runtime, Date.now());
    if (dep?.deprecated) warnings.push(`runtime ${cfg.Runtime} is deprecated since ${dep.date}; AWS may refuse updates on it`);
    if (cfg.LastUpdateStatus === "InProgress") warnings.push("another update is in progress — the deploy will be refused until it finishes");
    return { summary: `Deploy new code to ${name}${i.publish ? ", publish a version" : ""}${i.alias ? ` and move alias ${i.alias}` : ""}`, changes, warnings };
  },
  async run(r, i, ctx) {
    const name = nameOf(r);
    const { cfg } = await live(r, ctx);
    const src = deploySource(i, cfg.PackageType);
    if ("problem" in src) throw invalid(src.problem);
    if (cfg.LastUpdateStatus === "InProgress") throw conflict("another update is in progress — try again when it finishes");
    let bytes: Uint8Array | undefined;
    if (src.kind === "zip") {
      const z = decodeZip(i.zipBase64 ?? "");
      if (!z.bytes) throw invalid(z.problem ?? "unreadable package");
      bytes = z.bytes;
    }
    if (ctx.mock) {
      await simDelay(700);
      const sha = bytes ? codeSha256(bytes) : codeSha256(new TextEncoder().encode(`${src.kind === "s3" ? `${src.bucket}/${src.key}` : src.kind === "image" ? src.uri : ""}:${Date.now()}`));
      simDeploy(name, { sha, size: bytes?.length ?? cfg.CodeSize ?? 0 });
    } else {
      await lambda(regionOf(r, ctx.region)).send(new UpdateFunctionCodeCommand({
        FunctionName: name, RevisionId: cfg.RevisionId, Publish: false,
        ...(src.kind === "zip" ? { ZipFile: bytes } : src.kind === "s3" ? { S3Bucket: src.bucket, S3Key: src.key, S3ObjectVersion: src.version } : { ImageUri: src.uri }),
      }), t(undefined, 60_000));
    }
    const after = await settled(r, ctx);
    if (after.LastUpdateStatus === "Failed") throw conflict(`Lambda rejected the new code: ${after.LastUpdateStatusReason ?? "unknown reason"}`);
    const result: Record<string, unknown> = { function: name, codeSha256: after.CodeSha256, codeSize: after.CodeSize, lastModified: after.LastModified };
    if (after.LastUpdateStatus === "InProgress") return { ...result, status: "updating", note: "still updating after 90 s — publish a version later with publish-version" };
    if (!i.publish) return { ...result, status: "updated" };
    const version = await publish(r, ctx, i.description, after.CodeSha256);
    result.version = version;
    if (i.alias) result.alias = await pointAlias(r, ctx, i.alias, version, undefined);
    return { ...result, status: "updated" };
  },
};

async function publish(r: Resource, ctx: ActionContext, description?: string, sha?: string): Promise<string> {
  if (ctx.mock) {
    await simDelay(300);
    return simPublish(nameOf(r), description).version;
  }
  const v = await lambda(regionOf(r, ctx.region)).send(new PublishVersionCommand({ FunctionName: nameOf(r), Description: description, CodeSha256: sha }), t(undefined, 30_000));
  return v.Version ?? "?";
}

async function pointAlias(r: Resource, ctx: ActionContext, alias: string, version: string, canary: Canary | undefined, revisionId?: string) {
  const weights = canary ? { [canary.version]: canary.weight } : {};
  if (ctx.mock) {
    await simDelay(300);
    const { before, after } = simUpdateAlias(nameOf(r), alias, version, weights);
    return { name: alias, from: describeAlias(before), to: describeAlias(after) };
  }
  const before = await aliasOf(r, alias, ctx);
  const after = await lambda(regionOf(r, ctx.region)).send(new UpdateAliasCommand({ FunctionName: nameOf(r), Name: alias, FunctionVersion: version, RoutingConfig: { AdditionalVersionWeights: weights }, RevisionId: revisionId }), t());
  return { name: alias, from: describeAlias(before), to: describeAlias(after) };
}

const publishVersion: ProviderAction<{ description?: string }> = {
  id: "publish-version",
  kind: "lambda",
  title: "Publish a version",
  description: "Publishes the function's current code and configuration ($LATEST) as a new immutable version. When nothing changed since the newest version, Lambda returns that version instead of creating one (the plan says so). Returns the version number.",
  risk: "change",
  perm: "act",
  summary: "Publishes the function's current code and settings as a new numbered version.",
  iam: ["lambda:PublishVersion"],
  undo: "Nothing to undo: versions are immutable and an unused version changes nothing — aliases still point where they did",
  verifies: "Lambda returns the version number; it appears under Versions",
  retrySafe: true, // unchanged code returns the same version
  input: { type: "object", additionalProperties: false, properties: { description: field("Version description (optional)", { type: "string", maxLength: 256, description: "Version description." }) } },
  when: inProgress,
  async plan(r, _i, ctx) {
    const [{ cfg }, versions] = await Promise.all([live(r, ctx), versionsOf(r, ctx)]);
    const nums = versions.filter((v) => /^\d+$/.test(v)).map(Number).sort((a, b) => b - a);
    const newest = nums[0];
    const newestSha = ctx.mock ? simFn(nameOf(r))?.versions.at(-1)?.sha : newest === undefined ? undefined : (await allVersions(lambda(regionOf(r, ctx.region)), nameOf(r))).find((v) => v.Version === String(newest))?.CodeSha256;
    const same = newestSha !== undefined && newestSha === cfg.CodeSha256;
    return {
      summary: same ? `No new version for ${nameOf(r)}: $LATEST is unchanged since version ${newest}` : `Publish version ${newest === undefined ? 1 : newest + 1} of ${nameOf(r)}`,
      changes: [`from $LATEST: sha256 ${cfg.CodeSha256 ?? "?"}, last modified ${fmtTime(awsTime(cfg.LastModified))}`],
      warnings: [...(same ? [`the code hasn't changed since version ${newest} — Lambda returns version ${newest}`] : []), ...(cfg.LastUpdateStatus === "InProgress" ? ["an update is in progress — publishing is refused until it finishes"] : [])],
    };
  },
  async run(r, i, ctx) {
    const { cfg } = await live(r, ctx);
    if (cfg.LastUpdateStatus === "InProgress") throw conflict("an update is in progress — try again when it finishes");
    const version = await publish(r, ctx, i.description, cfg.CodeSha256);
    return { function: nameOf(r), version, codeSha256: cfg.CodeSha256 };
  },
};

type ShiftInput = { alias: string; version: string; canary?: Canary };

const shiftAlias: ProviderAction<ShiftInput> = {
  id: "shift-alias",
  kind: "lambda",
  title: "Shift an alias",
  description:
    "Points an alias (e.g. live) at a version. With `canary` { version, weight }, the alias keeps `version` as its main version and sends `weight` (0–1, e.g. 0.1 = 10 %) of invocations to the canary version — both must be published versions. Without `canary`, any existing canary routing is removed. Returns the alias's routing before and after.",
  risk: "change",
  perm: "act",
  summary: "Points an alias at a version, optionally sending a share of the traffic to a canary version.",
  iam: ["lambda:UpdateAlias"],
  undo: "Shift the alias back to its previous routing (the plan and the result show it)",
  verifies: "Lambda answers with the alias's new routing, shown in the result next to the old one",
  retrySafe: true,
  input: {
    type: "object",
    additionalProperties: false,
    required: ["alias", "version"],
    properties: {
      alias: field("Alias", ALIAS_NAME),
      version: field("Version", VERSION),
      canary: field("Canary (optional)", {
        type: "object",
        additionalProperties: false,
        required: ["version", "weight"],
        description: "Weighted routing: send `weight` of traffic to `version`.",
        properties: {
          version: field("Canary version", { type: "string", pattern: "^[0-9]{1,10}$", description: "Canary version (published)." }),
          weight: field("Share of traffic (0–1)", { type: "number", minimum: 0, maximum: 1, description: "Share of traffic, between 0 and 1 (exclusive)." }),
        },
      }),
    },
  },
  async plan(r, i, ctx) {
    const [a, versions] = await Promise.all([aliasOf(r, i.alias, ctx), versionsOf(r, ctx)]);
    const problem = shiftProblem(i.version, i.canary, versions);
    if (problem) throw invalid(problem);
    const next: RawAlias = { ...a, FunctionVersion: i.version, RoutingConfig: i.canary ? { AdditionalVersionWeights: { [i.canary.version]: i.canary.weight } } : undefined };
    return {
      summary: `Point alias ${i.alias} of ${nameOf(r)} at ${describeAlias(next)}`,
      changes: [`alias ${i.alias}: ${describeAlias(a)} → ${describeAlias(next)}`],
      warnings: describeAlias(a) === describeAlias(next) ? ["the alias already routes exactly like this"] : [],
    };
  },
  async run(r, i, ctx) {
    const [a, versions] = await Promise.all([aliasOf(r, i.alias, ctx), versionsOf(r, ctx)]);
    const problem = shiftProblem(i.version, i.canary, versions);
    if (problem) throw invalid(problem);
    return { function: nameOf(r), alias: await pointAlias(r, ctx, i.alias, i.version, i.canary, a.RevisionId) };
  },
};

const rollbackAlias: ProviderAction<{ alias: string; toVersion?: string }> = {
  id: "rollback-alias",
  kind: "lambda",
  title: "Roll back an alias",
  description:
    "Rolls an alias back: if it has a canary, the canary is removed (all traffic returns to its main version); otherwise it moves to the newest published version older than its current one — or to `toVersion` when given. Refused when there is no older version. Returns the routing before and after.",
  risk: "change",
  perm: "act",
  summary: "Moves an alias back to the previous version, or removes its canary.",
  iam: ["lambda:UpdateAlias"],
  undo: "Shift the alias forward again (Shift an alias; the result shows where it pointed)",
  verifies: "Lambda answers with the alias's new routing (the older version, or no canary), shown in the result",
  retrySafe: false, // a second rollback moves the alias one more version back
  input: {
    type: "object",
    additionalProperties: false,
    required: ["alias"],
    properties: { alias: field("Alias", ALIAS_NAME), toVersion: field("Roll back to version (optional)", { ...VERSION, description: "Roll back to this version instead of the previous one." }) },
  },
  async plan(r, i, ctx) {
    const { target, a } = await rollbackOf(r, i, ctx);
    return { summary: `Roll back alias ${i.alias} of ${nameOf(r)}: ${target.why}`, changes: [`alias ${i.alias}: ${describeAlias(a)} → ${target.version}`] };
  },
  async run(r, i, ctx) {
    const { target, a } = await rollbackOf(r, i, ctx);
    return { function: nameOf(r), alias: await pointAlias(r, ctx, i.alias, target.version, undefined, a.RevisionId) };
  },
};

async function rollbackOf(r: Resource, i: { alias: string; toVersion?: string }, ctx: ActionContext) {
  const [a, versions] = await Promise.all([aliasOf(r, i.alias, ctx), versionsOf(r, ctx)]);
  if (i.toVersion) {
    const problem = shiftProblem(i.toVersion, undefined, versions);
    if (problem) throw invalid(problem);
    return { a, target: { version: i.toVersion, why: `${describeAlias(a)} → ${i.toVersion}` } };
  }
  const target = rollbackTarget(a, versions);
  if ("problem" in target) throw invalid(target.problem);
  return { a, target };
}

const invoke: ProviderAction<{ payload?: string; qualifier?: string }> = {
  id: "invoke",
  kind: "lambda",
  title: "Invoke with a test event",
  description:
    "Runs the function once, synchronously, with a test event (payload: JSON text, at most 64 KB; default {}), optionally at a version or alias (qualifier). This runs real code with the function's IAM role — anything it writes, sends or deletes really happens — so it is always a danger action. Sent once, never retried (a retry could run it twice). Waits up to 60 s. Returns the status code, the function error (if it threw), the executed version, the last 4 KB of the log and the first 4 KB of the response.",
  risk: "danger",
  perm: "act",
  summary: "Runs the function once with a test event and shows its answer and the end of its log.",
  iam: ["lambda:InvokeFunction"],
  undo: "Irreversible — whatever the function wrote, sent or deleted really happened",
  verifies: "The status code, any function error and the log tail are shown",
  retrySafe: false,
  input: {
    type: "object",
    additionalProperties: false,
    properties: {
      payload: field("Test event (JSON)", { type: "string", maxLength: MAX_EVENT, description: "The test event as JSON text (at most 64 KB)." }),
      qualifier: field("Version or alias (optional)", { type: "string", pattern: "^(\\$LATEST|[0-9]{1,10}|(?!^[0-9]+$)[A-Za-z0-9_-]{1,128})$", description: "Version or alias to invoke (default $LATEST)." }),
    },
  },
  // The log tail and the response are the function's output: never in the audit log.
  auditSummary: (res) => pickFields(res, ["function", "statusCode", "functionError", "executedVersion"]),
  when: (r) => (propOf(r, P.reserved)?.startsWith("0") ? "reserved concurrency is 0 — every invocation is throttled" : undefined),
  async plan(r, i, ctx) {
    const problem = jsonProblem(i.payload, MAX_EVENT, "the test event");
    if (problem) throw invalid(problem);
    const { cfg, reserved } = await live(r, ctx);
    return {
      summary: `Invoke ${nameOf(r)}${i.qualifier ? `:${i.qualifier}` : ""} once with a ${fmtBytes(byteLength(i.payload || "{}"))} test event`,
      changes: [`runs ${isImage(cfg) ? "the container image" : cfg.Runtime} code as role ${arnName(cfg.Role) || "?"} (timeout ${fmtSeconds(cfg.Timeout ?? 3)})`],
      warnings: [
        "this runs real code: whatever the function writes, sends or deletes really happens",
        ...(reserved === 0 ? ["reserved concurrency is 0 — the call will be throttled"] : []),
        ...((cfg.Timeout ?? 3) > 60 ? ["the console waits at most 60 s for the result; a longer run keeps going in the background"] : []),
      ],
    };
  },
  async run(r, i, ctx) {
    const problem = jsonProblem(i.payload, MAX_EVENT, "the test event");
    if (problem) throw invalid(problem);
    const payload = i.payload || "{}";
    let out: { StatusCode?: number; FunctionError?: string; ExecutedVersion?: string; LogResult?: string; Payload?: Uint8Array };
    if (ctx.mock) {
      await simDelay(500);
      out = simInvoke(nameOf(r), i.qualifier, payload);
    } else {
      out = await lambdaOnce(regionOf(r, ctx.region)).send(new InvokeCommand({ FunctionName: nameOf(r), Qualifier: i.qualifier, InvocationType: "RequestResponse", LogType: "Tail", Payload: new TextEncoder().encode(payload) }), t(undefined, 65_000));
    }
    const log = out.LogResult ? Buffer.from(out.LogResult, "base64").toString("utf8") : "";
    const response = out.Payload ? new TextDecoder().decode(out.Payload) : "";
    return {
      function: nameOf(r),
      statusCode: out.StatusCode,
      functionError: out.FunctionError,
      executedVersion: out.ExecutedVersion,
      logTail: log.length > LOG_TAIL ? log.slice(-LOG_TAIL) : log,
      response: response.length > 4096 ? `${response.slice(0, 4096)}…` : response,
    };
  },
};

const setConcurrency: ProviderAction<{ reserved?: number; remove?: boolean }> = {
  id: "set-concurrency",
  kind: "lambda",
  title: "Set reserved concurrency",
  description:
    "Reserves concurrent executions for the function (reserved: 0–10,000), which also caps it there; 0 throttles every invocation (an emergency stop). remove: true returns it to the account's unreserved pool. Returns the setting before and after.",
  risk: "change",
  perm: "act",
  summary: "Reserves (and caps) the function's concurrent executions; 0 stops every invocation.",
  iam: ["lambda:PutFunctionConcurrency", "lambda:DeleteFunctionConcurrency"],
  undo: "Set it back to the value the plan showed, or remove the reservation",
  verifies: "Lambda answers with the new reserved concurrency (removing it answers with none)",
  retrySafe: true,
  input: {
    type: "object",
    additionalProperties: false,
    properties: {
      reserved: field("Reserved concurrency", { type: "integer", minimum: 0, maximum: 10_000, description: "Concurrent executions to reserve (0 = throttle everything)." }),
      remove: field("Remove the reservation instead", { type: "boolean", description: "Remove the reservation instead." }),
    },
  },
  async plan(r, i, ctx) {
    const want = concurrencyInput(i);
    const { reserved } = await live(r, ctx);
    const fmt = (n?: number) => (n === undefined ? "unreserved" : String(n));
    return {
      summary: want === undefined ? `Remove the reserved concurrency of ${nameOf(r)}` : want === 0 ? `Throttle every invocation of ${nameOf(r)} (reserved concurrency 0)` : `Reserve ${want} concurrent executions for ${nameOf(r)}`,
      changes: [`reserved concurrency: ${fmt(reserved)} → ${fmt(want)}`],
      warnings: [
        ...(want === 0 ? ["0 throttles every invocation until you change it — triggers retry or fail, events may be lost"] : []),
        ...(want !== undefined && want > 0 ? ["reserving takes concurrency away from every other function in the account and region"] : []),
      ],
    };
  },
  async run(r, i, ctx) {
    const want = concurrencyInput(i);
    const name = nameOf(r);
    if (ctx.mock) {
      await simDelay(300);
      return { function: name, ...simConcurrency(name, want) };
    }
    const c = lambda(regionOf(r, ctx.region));
    const before = (await c.send(new GetFunctionConcurrencyCommand({ FunctionName: name }), t())).ReservedConcurrentExecutions;
    if (want === undefined) {
      await c.send(new DeleteFunctionConcurrencyCommand({ FunctionName: name }), t());
      return { function: name, before, after: undefined };
    }
    const out = await c.send(new PutFunctionConcurrencyCommand({ FunctionName: name, ReservedConcurrentExecutions: want }), t());
    return { function: name, before, after: out.ReservedConcurrentExecutions ?? want };
  },
};

function concurrencyInput(i: { reserved?: number; remove?: boolean }): number | undefined {
  const reserved = own<number>(i, "reserved");
  const remove = own<boolean>(i, "remove") === true;
  if ((reserved === undefined) === !remove) throw invalid("give either reserved (a number) or remove: true");
  if (reserved !== undefined && (!Number.isInteger(reserved) || reserved < 0 || reserved > 10_000)) throw invalid("reserved must be an integer between 0 and 10,000");
  return remove ? undefined : reserved;
}

type EnvInput = { set?: Record<string, unknown>; remove?: string[] };

const updateEnv: ProviderAction<EnvInput> = {
  id: "update-env",
  kind: "lambda",
  title: "Update environment variables",
  description:
    "Sets and/or removes environment variables of the function, keeping every other variable. `set` maps NAME → value (strings); `remove` lists names. Names follow Lambda's rules (a letter, then letters, digits, _) and AWS-reserved names are refused, as is going over Lambda's 4 KB total. Values are never echoed back: the plan, the result and the audit log list names only. New invocations see the new values once Lambda finishes the update.",
  risk: "change",
  perm: "env",
  secretFields: ["set"],
  summary: "Adds, changes or removes environment variables; values are never shown back.",
  iam: ["lambda:UpdateFunctionConfiguration"],
  undo: "Set the old values again — the console never shows values, so keep your own copy before changing them",
  verifies: "Lambda reports LastUpdateStatus Successful; new invocations read the new values",
  retrySafe: true, // the same set / remove again leaves the same variables
  input: {
    type: "object",
    additionalProperties: false,
    properties: {
      set: field("Set variables", { type: "object", description: "NAME → new value (strings). New names are added." }),
      remove: field("Remove variables", { type: "array", maxItems: 100, items: { type: "string", maxLength: 255 }, description: "Variable names to remove." }),
    },
  },
  auditSummary: (res) => pickFields(res, ["function", "added", "changed", "removed", "status"]),
  when: inProgress,
  async plan(r, i, ctx) {
    const { cfg } = await live(r, ctx);
    const e = envEdit(cfg, i);
    return {
      summary: `Change ${e.added.length + e.changed.length + e.removed.length} environment variable(s) of ${nameOf(r)}`,
      changes: [
        ...(e.added.length ? [`add ${e.added.join(", ")}`] : []),
        ...(e.changed.length ? [`change ${e.changed.join(", ")}`] : []),
        ...(e.removed.length ? [`remove ${e.removed.join(", ")}`] : []),
        "then: Lambda updates the configuration; new invocations read the new values",
      ],
      warnings: [
        ...(!e.added.length && !e.changed.length && !e.removed.length ? ["nothing to change"] : []),
        ...(cfg.KMSKeyArn ? ["the variables are encrypted with a customer-managed KMS key — the console's role needs kms:Encrypt on it"] : []),
        ...(cfg.LastUpdateStatus === "InProgress" ? ["an update is in progress — the change is refused until it finishes"] : []),
      ],
    };
  },
  async run(r, i, ctx) {
    const { cfg } = await live(r, ctx);
    if (cfg.LastUpdateStatus === "InProgress") throw conflict("an update is in progress — try again when it finishes");
    const e = envEdit(cfg, i);
    const name = nameOf(r);
    if (ctx.mock) {
      await simDelay(500);
      simSetEnv(name, e.next);
    } else {
      await lambda(regionOf(r, ctx.region)).send(new UpdateFunctionConfigurationCommand({ FunctionName: name, Environment: { Variables: e.next }, RevisionId: cfg.RevisionId }), t(undefined, 15_000));
    }
    const after = await settled(r, ctx, 30_000);
    if (after.LastUpdateStatus === "Failed") throw conflict(`Lambda rejected the change: ${after.LastUpdateStatusReason ?? "unknown reason"}`);
    return { function: name, added: e.added, changed: e.changed, removed: e.removed, status: after.LastUpdateStatus === "InProgress" ? "updating" : "updated" };
  },
};

function envEdit(cfg: RawFunction, i: EnvInput) {
  const set = own<Record<string, unknown>>(i, "set") ?? {};
  const remove = own<string[]>(i, "remove") ?? [];
  if (typeof set !== "object" || Array.isArray(set) || !Array.isArray(remove)) throw invalid("set must be an object of NAME → value and remove a list of names");
  if (!Object.keys(set).length && !remove.length) throw invalid("nothing to change: give set and/or remove");
  const e = editEnv(cfg.Environment?.Variables ?? {}, set, remove);
  if (e.problems.length) throw invalid(e.problems.join("; "));
  return e;
}

export const lambdaProvider: Provider = {
  id: "lambda",
  label: "Lambda",
  scope: "regional",
  kinds: ["lambda"],
  covers: ["lambda:function"],
  multiRegionMock: true,
  read: [
    "lambda:ListFunctions", "lambda:ListTags", "lambda:ListEventSourceMappings", "lambda:ListFunctionUrlConfigs", "lambda:ListFunctionEventInvokeConfigs",
    "lambda:GetFunctionConcurrency", "lambda:GetFunctionConfiguration", "lambda:ListAliases", "lambda:ListVersionsByFunction", "lambda:GetPolicy",
    "cloudwatch:GetMetricData",
  ],
  write: [
    "lambda:UpdateFunctionCode", "lambda:PublishVersion", "lambda:UpdateAlias", "lambda:InvokeFunction", "lambda:PutFunctionConcurrency",
    "lambda:DeleteFunctionConcurrency", "lambda:UpdateFunctionConfiguration",
  ],
  async discover(ctx) {
    return lambdaResult(await fetchLambda(ctx, ctx.mock ? mockReads(ctx) : realReads(ctx)), Date.now());
  },
  activity: (r) => [
    { namespace: "AWS/Lambda", metric: "Invocations", dims: { FunctionName: nameOf(r) }, stat: "Sum", label: "Invocations", region: regionOf(r, r.region), required: true },
    { namespace: "AWS/Lambda", metric: "Errors", dims: { FunctionName: nameOf(r) }, stat: "Sum", label: "Errors", region: regionOf(r, r.region) },
  ],
  detail: (r, ctx) => (ctx.mock ? Promise.resolve(mockDetail(r)) : realDetail(r, ctx)),
  // R01: the function's tags, read live right before a change (5 s; throws when they can't be read).
  async authoritative(r, ctx) {
    if (ctx.mock) return { tags: simTags(r.key) };
    const out = await lambda(regionOf(r, ctx.region)).send(new ListTagsCommand({ Resource: r.key }), t(undefined, AUTHORITATIVE_MS));
    return { tags: out.Tags ?? {} };
  },
  actions: [deployCode, publishVersion, shiftAlias, rollbackAlias, invoke, setConcurrency, updateEnv] as ProviderAction[],
};
