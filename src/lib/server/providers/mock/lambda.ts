// Simulated Lambda functions of the Acme account (names from ../mock-names.ts): the S3 thumbnailers, the order-events
// consumer of the orders queue (with a 10 % canary on its alias), the email sender behind the notifications topic,
// the nightly report (EventBridge schedule), the public API behind API Gateway (its env names the sessions table and
// the orders queue, encrypted with the application KMS key), the staging partners API, the checkout step inside the
// VPC, and an idle legacy cron on a deprecated runtime. They all run as the shared Lambda role and log to their default
// groups. Only us-east-1 has functions. Shapes are the SDK's, and the calls model the real API: the list leaves the
// deployment state out (R12) — only the configuration read returns State and LastUpdateStatus — and tags, URLs,
// concurrency and destinations are reads of their own. Actions change this state.
import { createHash } from "node:crypto";
import { DEPLOY_FIELDS, type RawAlias, type RawFunction, type RawMapping } from "../../../inventory/serverless-lambda.ts";
import { ACCT, APIGW, DYNAMO, EVENTS, EXISTING, IAM_ROLES, KMS_KEYS, LAMBDA, REGION, S3, SNS, SQS } from "../mock-names.ts";
import { DAY, HOUR, MIN, lambdaTime, simState } from "./serverless-sim.ts";

export interface SimVersion {
  version: string;
  sha: string;
  size: number;
  description: string;
  at: number;
}

export interface SimFn {
  cfg: RawFunction;
  tags: Record<string, string>;
  url?: { url: string; authType: string };
  reserved?: number;
  destinations?: { onSuccess?: string; onFailure?: string };
  versions: SimVersion[]; // published, oldest first
  aliases: RawAlias[];
  activeAgo: number; // last invocation, ms before now
  createdAt: number;
  updatingUntil?: number;
  triggers: { principal: string; source?: string }[]; // what its resource policy allows to invoke it
  rate: number; // invocations per hour (charts)
  errorShare: number; // share of invocations that fail
}

// A disabled hourly rule still targets the legacy cron (see ./eventbridge.ts) — why it has been idle for months.
export const LEGACY_RULE = "legacy-cleanup-hourly";

const sha = (s: string) => createHash("sha256").update(s).digest("base64");

function build(): Record<string, SimFn> {
  const now = Date.now();
  const fns: Record<string, SimFn> = {};
  interface Meta {
    vars?: Record<string, string>;
    tags?: Record<string, string>;
    versions?: number; // published versions 1..n
    lastDeployAgo?: number;
    alias?: RawAlias; // default: "live" → the newest version
    extra?: Partial<SimFn>;
  }
  const add = (def: { name: string; arn: string; runtime: string; env?: string }, cfg: Partial<RawFunction>, m: Meta) => {
    const lastAt = now - (m.lastDeployAgo ?? 6 * DAY);
    const n = m.versions ?? 0;
    const size = cfg.CodeSize ?? 1_000_000;
    const versions: SimVersion[] = Array.from({ length: n }, (_, i) => {
      const v = i + 1;
      return { version: String(v), sha: sha(`${def.name}:v${v}`), size: size - (n - v) * 1_200, description: v === n ? "current release" : `release ${v}`, at: lastAt - (n - v) * 4 * DAY };
    });
    fns[def.name] = {
      cfg: {
        FunctionName: def.name, FunctionArn: def.arn, Runtime: def.runtime, PackageType: "Zip", Architectures: ["arm64"], MemorySize: 512, Timeout: 30,
        Handler: "index.handler", CodeSize: size, Role: IAM_ROLES.lambda.arn, State: "Active", LastUpdateStatus: "Successful",
        Version: "$LATEST", CodeSha256: n ? versions[n - 1].sha : sha(`${def.name}:latest`), LastModified: lambdaTime(lastAt), EphemeralStorage: { Size: 512 },
        LoggingConfig: { LogGroup: `/aws/lambda/${def.name}`, LogFormat: "Text" }, TracingConfig: { Mode: "PassThrough" },
        Environment: { Variables: m.vars ?? {} },
        ...cfg,
      },
      tags: m.tags ?? (def.env ? { Environment: def.env, Team: "shop", ManagedBy: "terraform" } : {}),
      versions,
      aliases: m.alias ? [m.alias] : n ? [{ Name: "live", FunctionVersion: String(n), Description: "production traffic", RevisionId: sha(`${def.name}:alias`).slice(0, 12) }] : [],
      activeAgo: 2 * MIN,
      createdAt: lastAt - (n + 3) * 4 * DAY,
      triggers: [],
      rate: 120,
      errorShare: 0.002,
      ...m.extra,
    };
  };
  const executeApi = (id: string) => `arn:aws:execute-api:${REGION}:${ACCT}:${id}/*/*`;
  const sinceNightly = (((now % DAY) - (2 * HOUR + 4 * MIN)) % DAY + DAY) % DAY; // the 02:00 UTC run took ~4 min

  add(LAMBDA.thumbnailerStaging, { MemorySize: 1024, Timeout: 60, CodeSize: 2_210_000 }, {
    versions: 3, lastDeployAgo: 2 * DAY,
    vars: { OUTPUT_BUCKET: S3.uploadsStaging.name, THUMB_SIZES: "128,512", LOG_LEVEL: "debug" },
    tags: { Environment: "staging", Team: "media", Service: "thumbnailer" },
    extra: { activeAgo: 25 * MIN, rate: 6, triggers: [{ principal: "s3.amazonaws.com", source: S3.uploadsStaging.arn }] },
  });
  add(LAMBDA.thumbnailerProd, { MemorySize: 1024, Timeout: 60, CodeSize: 2_240_000 }, {
    versions: 9, lastDeployAgo: 5 * DAY,
    vars: { OUTPUT_BUCKET: S3.assets.name, THUMB_SIZES: "128,512,1024", LOG_LEVEL: "info" },
    tags: { Environment: "production", Team: "media", Service: "thumbnailer" },
    extra: { reserved: 50, activeAgo: 3 * MIN, rate: 340, triggers: [{ principal: "s3.amazonaws.com", source: S3.uploads.arn }] },
  });
  add(LAMBDA.orderEvents, { CodeSize: 1_480_000 }, {
    versions: 13, lastDeployAgo: 1 * DAY,
    vars: { CARTS_TABLE: DYNAMO.carts.name, NOTIFY_TOPIC_ARN: SNS.notifications.arn, POWERTOOLS_SERVICE_NAME: "order-events" },
    alias: { Name: "live", FunctionVersion: "12", Description: "production traffic (canary on 13)", RoutingConfig: { AdditionalVersionWeights: { "13": 0.1 } }, RevisionId: "a1b2c3d4e5f6" },
    extra: { activeAgo: 40_000, rate: 900, errorShare: 0.004 },
  });
  add(LAMBDA.emailSender, { Architectures: ["x86_64"], Handler: "app.handler", MemorySize: 256, Timeout: 15, CodeSize: 380_000 }, {
    versions: 4, lastDeployAgo: 21 * DAY,
    vars: { FROM_ADDRESS: "no-reply@acme.example", TEMPLATE_BUCKET: S3.assets.name },
    extra: { destinations: { onFailure: SNS.alarms.arn }, activeAgo: 6 * MIN, rate: 210, triggers: [{ principal: "sns.amazonaws.com", source: SNS.notifications.arn }] },
  });
  add(LAMBDA.nightlyReport, { Architectures: ["x86_64"], Handler: "report.main", MemorySize: 1024, Timeout: 900, CodeSize: 5_600_000 }, {
    versions: 6, lastDeployAgo: 34 * DAY,
    vars: { REPORT_BUCKET: S3.logs.name, REPORT_TIMEZONE: "UTC" },
    extra: { activeAgo: sinceNightly, rate: 0.05, triggers: [{ principal: "events.amazonaws.com", source: EVENTS.nightlyRule.arn }] },
  });
  add(LAMBDA.apiHandler, { Handler: "dist/lambda.handler", MemorySize: 1024, Timeout: 29, CodeSize: 3_900_000, KMSKeyArn: KMS_KEYS.app.arn }, {
    versions: 7, lastDeployAgo: 3 * DAY,
    vars: { SESSIONS_TABLE: DYNAMO.sessions.name, ORDERS_QUEUE_URL: SQS.orders.url, JWT_SECRET: "sim-only-not-a-real-secret-1f3c", NODE_OPTIONS: "--enable-source-maps" },
    tags: { Environment: "production", Team: "shop", Service: "public-api" },
    extra: { activeAgo: 20_000, rate: 2_400, errorShare: 0.001, triggers: [{ principal: "apigateway.amazonaws.com", source: executeApi(APIGW.publicHttp.id) }] },
  });
  add(LAMBDA.partnersStaging, { Architectures: ["x86_64"], Timeout: 10, CodeSize: 820_000 }, {
    lastDeployAgo: 9 * DAY,
    vars: { SESSIONS_TABLE: DYNAMO.sessionsStaging.name, PARTNER_SIGNING_KEY: "sim-only-partner-key-77aa" },
    tags: { Environment: "staging", Team: "partners" },
    extra: {
      url: { url: "https://p4rtn3rsx7y2zq5.lambda-url.us-east-1.on.aws/", authType: "AWS_IAM" }, activeAgo: 3 * HOUR, rate: 4,
      triggers: [{ principal: "apigateway.amazonaws.com", source: executeApi(APIGW.partnersRest.id) }],
    },
  });
  add(LAMBDA.checkoutStep, {
    Timeout: 20, CodeSize: 1_120_000,
    // Its own security group: functions take no inbound traffic, so sharing an ECS service's group would suggest edges into it.
    VpcConfig: { VpcId: EXISTING.vpc.production, SubnetIds: EXISTING.subnets.production, SecurityGroupIds: ["sg-prod-checkout-fn"] },
  }, {
    versions: 5, lastDeployAgo: 8 * DAY,
    vars: { CARTS_TABLE: DYNAMO.carts.name, DB_HOST: `${EXISTING.rds.production}.c0example.${REGION}.rds.amazonaws.com` },
    extra: { activeAgo: 90_000, rate: 380, triggers: [{ principal: "states.amazonaws.com" }] },
  });
  add(LAMBDA.legacyCleanup, { Architectures: ["x86_64"], MemorySize: 128, Timeout: 300, CodeSize: 41_000, Description: "Deletes old backups nightly (replaced by S3 lifecycle rules)" }, {
    lastDeployAgo: 700 * DAY,
    vars: { TARGET_BUCKET: S3.backupsOld.name, DRY_RUN: "false" },
    tags: {},
    extra: { activeAgo: 90 * DAY, rate: 0, triggers: [{ principal: "events.amazonaws.com", source: `arn:aws:events:${REGION}:${ACCT}:rule/${LEGACY_RULE}` }] },
  });
  return fns;
}

const state = () => simState("__dcSimLambda", () => ({ fns: build(), mappings: seedMappings() }));

function seedMappings(): RawMapping[] {
  return [
    {
      UUID: "6f1e2d3c-orders-0001", EventSourceArn: SQS.orders.arn, FunctionArn: LAMBDA.orderEvents.arn, State: "Enabled", BatchSize: 10, MaximumBatchingWindowInSeconds: 5,
      ScalingConfig: { MaximumConcurrency: 20 }, LastProcessingResult: "OK",
    },
  ];
}

// A function by name or (qualified or not) ARN.
const nameOf = (ref: string) => (ref.startsWith("arn:") ? ref.split(":")[6] ?? "" : ref.split(":")[0]);
export const simFn = (ref: string): SimFn | undefined => state().fns[nameOf(ref)];
const inRegion = (region: string) => region === REGION;

// ---------- the reads discovery makes (one per API call, like the real account) ----------

// ListFunctions: the configuration without the deployment state (AWS leaves State, StateReason and LastUpdateStatus
// out of this call). Environment values come with it, as from the real API — they stay on the server as mentions.
export function simListFunctions(region: string = REGION): (RawFunction & { lastActivityAt: number })[] {
  if (!inRegion(region)) return [];
  const now = Date.now();
  return Object.values(state().fns).map((f) => {
    const cfg: RawFunction & { lastActivityAt: number } = { ...f.cfg, Environment: { Variables: { ...(f.cfg.Environment?.Variables ?? {}) } }, lastActivityAt: now - f.activeAgo };
    for (const k of DEPLOY_FIELDS) delete cfg[k];
    return cfg;
  });
}

// GetFunctionConfiguration: everything, with State and LastUpdateStatus (InProgress while an update settles).
export function simFunctionConfiguration(ref: string): RawFunction {
  const f = must(ref);
  return { ...f.cfg, Environment: { Variables: { ...(f.cfg.Environment?.Variables ?? {}) } }, LastUpdateStatus: simUpdating(f.cfg.FunctionName!) ? "InProgress" : "Successful" };
}

export const simTags = (ref: string): Record<string, string> => ({ ...must(ref).tags });
export const simUrl = (ref: string) => must(ref).url;
export const simReserved = (ref: string) => must(ref).reserved;
export const simDestinations = (ref: string) => must(ref).destinations;
export const simMappings = (region: string = REGION): RawMapping[] => (inRegion(region) ? state().mappings : []);

function must(ref: string): SimFn {
  const name = nameOf(ref);
  const f = simFn(name);
  if (!f) throw Object.assign(new Error(`Function not found: ${name}`), { name: "ResourceNotFoundException" });
  return f;
}

export function simDeploy(name: string, code: { sha: string; size: number; imageUri?: string }) {
  const f = must(name);
  const now = Date.now();
  f.cfg.CodeSha256 = code.sha;
  f.cfg.CodeSize = code.size;
  f.cfg.LastModified = lambdaTime(now);
  f.updatingUntil = now + 2_500;
  return { codeSha256: f.cfg.CodeSha256, codeSize: f.cfg.CodeSize, lastModified: f.cfg.LastModified };
}

export const simUpdating = (name: string) => (must(name).updatingUntil ?? 0) > Date.now();

// Like PublishVersion: unchanged code returns the latest version instead of a new one.
export function simPublish(name: string, description?: string): { version: string; created: boolean } {
  const f = must(name);
  const last = f.versions.at(-1);
  if (last && last.sha === f.cfg.CodeSha256) return { version: last.version, created: false };
  const version = String(Number(last?.version ?? 0) + 1);
  f.versions.push({ version, sha: f.cfg.CodeSha256 ?? "", size: f.cfg.CodeSize ?? 0, description: description ?? "", at: Date.now() });
  return { version, created: true };
}

export function simUpdateAlias(name: string, alias: string, version: string, weights: Record<string, number>) {
  const f = must(name);
  let a = f.aliases.find((x) => x.Name === alias);
  if (!a) throw Object.assign(new Error(`Alias not found: ${alias}`), { name: "ResourceNotFoundException" });
  const before = { ...a, RoutingConfig: a.RoutingConfig ? { AdditionalVersionWeights: { ...(a.RoutingConfig.AdditionalVersionWeights ?? {}) } } : undefined };
  a = Object.assign(a, { FunctionVersion: version, RoutingConfig: Object.keys(weights).length ? { AdditionalVersionWeights: weights } : undefined, RevisionId: Math.random().toString(16).slice(2, 14) });
  return { before, after: { ...a } };
}

export function simConcurrency(name: string, reserved: number | undefined) {
  const f = must(name);
  const before = f.reserved;
  f.reserved = reserved;
  return { before, after: reserved };
}

export function simSetEnv(name: string, vars: Record<string, string>) {
  const f = must(name);
  const now = Date.now();
  f.cfg.Environment = { Variables: { ...vars } };
  f.cfg.LastModified = lambdaTime(now);
  f.updatingUntil = now + 1_500;
}

// A test invocation: echoes a summary of the event; `{"fail": true}` makes it throw like a handler would.
export function simInvoke(name: string, qualifier: string | undefined, payload: string) {
  const f = must(name);
  const id = `${Math.random().toString(16).slice(2, 10)}-${Math.random().toString(16).slice(2, 6)}`;
  const version = qualifier ? (f.aliases.find((a) => a.Name === qualifier)?.FunctionVersion ?? qualifier) : "$LATEST";
  let event: unknown;
  try {
    event = payload ? JSON.parse(payload) : {};
  } catch {
    event = {};
  }
  const fail = !!event && typeof event === "object" && (event as Record<string, unknown>).fail === true;
  const ms = 8 + (payload.length % 40);
  f.activeAgo = 0;
  const lines = [
    `START RequestId: ${id} Version: ${version}`,
    fail ? `${new Date().toISOString()}\t${id}\tERROR\tInvoke Error \t{"errorType":"Error","errorMessage":"simulated failure"}` : `${new Date().toISOString()}\t${id}\tINFO\thandled test event (${Object.keys((event as object) ?? {}).length} keys)`,
    `END RequestId: ${id}`,
    `REPORT RequestId: ${id}\tDuration: ${ms}.42 ms\tBilled Duration: ${ms + 1} ms\tMemory Size: ${f.cfg.MemorySize} MB\tMax Memory Used: ${60 + (ms % 30)} MB`,
  ];
  return {
    StatusCode: 200,
    FunctionError: fail ? "Unhandled" : undefined,
    ExecutedVersion: version,
    LogResult: Buffer.from(lines.join("\n") + "\n").toString("base64"),
    Payload: new TextEncoder().encode(fail ? JSON.stringify({ errorType: "Error", errorMessage: "simulated failure" }) : JSON.stringify({ statusCode: 200, body: JSON.stringify({ ok: true, function: name }) })),
  };
}
