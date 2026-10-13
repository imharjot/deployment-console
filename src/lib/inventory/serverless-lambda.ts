// Lambda, pure part: raw function configurations (the SDK's shapes, or the simulation's) → Resources, Links (event
// source mappings, dead-letter queues, async destinations, and the support links: execution role, the KMS key of the
// environment variables, the log group, EFS mounts) and env-var Mentions; health; the deployment-state cache rules;
// and the rules behind the alias / deploy actions (canary routing, rollback target, which code source an input names).
// Shared by real and simulated discovery; tested in serverless-lambda.test.ts.
//
// R12: ListFunctions leaves State and LastUpdateStatus out, so health comes from them only when a
// GetFunctionConfiguration read supplied them (`deployState: "ok"`); otherwise it is unknown, "deployment state not
// read (…)". Existence (listed), deployment state (that read) and runtime health (Errors / Throttles, read by the
// panel) are kept apart.
import {
  arnName, assumesLink, awsTime, clip, encryptsLink, enrichmentOf, envMentions, eventSourceKey, fmtBytes, fmtSeconds, fmtTime, hostOf, kmsKeyRef, lambdaBase,
  logGroupRef, logsLink, parseArn, patternSummary, props, runtimeDeprecation, tagsOf, targetKey, unread,
} from "./serverless-common.ts";
import type { EnrichState, Health, Link, Mention, ProviderResult, Resource } from "./types.ts";

// Structural subset of the SDK's FunctionConfiguration.
export interface RawFunction {
  FunctionName?: string;
  FunctionArn?: string;
  Runtime?: string;
  Role?: string;
  Handler?: string;
  CodeSize?: number;
  Description?: string;
  Timeout?: number;
  MemorySize?: number;
  LastModified?: string;
  CodeSha256?: string;
  Version?: string;
  VpcConfig?: { SubnetIds?: string[]; SecurityGroupIds?: string[]; VpcId?: string };
  DeadLetterConfig?: { TargetArn?: string };
  Environment?: { Variables?: Record<string, string> };
  // Only GetFunctionConfiguration (and GetFunction) return these five; ListFunctions leaves them out (R12).
  State?: string;
  StateReason?: string;
  StateReasonCode?: string;
  LastUpdateStatus?: string;
  LastUpdateStatusReason?: string;
  LastUpdateStatusReasonCode?: string;
  PackageType?: string;
  Architectures?: string[];
  EphemeralStorage?: { Size?: number };
  Layers?: { Arn?: string; CodeSize?: number }[];
  LoggingConfig?: { LogGroup?: string; LogFormat?: string };
  TracingConfig?: { Mode?: string };
  KMSKeyArn?: string;
  FileSystemConfigs?: { Arn?: string; LocalMountPath?: string }[];
}

// A function plus what discovery reads around it (each piece optional: a denied sub-call leaves it out).
export interface RawFunctionEx extends RawFunction {
  tags?: Record<string, string>; // undefined = not read (tagsUnread); {} = read, none
  url?: { url: string; authType?: string };
  reserved?: number; // reserved concurrency; undefined = unreserved (or unknown)
  destinations?: { onSuccess?: string; onFailure?: string };
  // How the deployment-state read went: "ok" means State / LastUpdateStatus above come from GetFunctionConfiguration.
  // Anything else (or nothing: a ListFunctions-shaped item) means they are unknown.
  deployState?: EnrichState;
  enrichment?: Record<string, EnrichState>; // every optional read: state, tags, url, concurrency, destinations
  lastActivityAt?: number; // simulation only
}

// ---------- deployment state (R12) ----------

export const DEPLOY_FIELDS = ["State", "StateReason", "StateReasonCode", "LastUpdateStatus", "LastUpdateStatusReason", "LastUpdateStatusReasonCode"] as const;
export type DeployState = Pick<RawFunction, (typeof DEPLOY_FIELDS)[number]>;

// The deployment-state fields of a GetFunctionConfiguration answer and nothing else. The answer also holds the
// environment variables' values: only these six strings are copied out, so the values are dropped right here, before
// anything is kept or cached (the list's copy is the one that becomes server-side mentions).
export function deployStateOf(cfg: RawFunction): DeployState {
  const out: DeployState = {};
  for (const k of DEPLOY_FIELDS) {
    const v = cfg[k];
    if (typeof v === "string" && v) out[k] = v;
  }
  return out;
}

// A function changes version when its code or configuration changes: LastModified moves, and CodeSha256 with new code.
export const configVersion = (f: Pick<RawFunction, "LastModified" | "CodeSha256">) => `${f.LastModified ?? ""}|${f.CodeSha256 ?? ""}`;

// A state that only changes with a new version (or after weeks idle: Active → Inactive). Pending and InProgress move on
// their own within seconds or minutes, so they are never served from the cache.
export const settledState = (s: DeployState) => s.State !== "Pending" && s.LastUpdateStatus !== "InProgress" && !!s.State;

export interface ConfigCacheEntry {
  version: string;
  at: number;
  state: DeployState;
}

// The deployment-state cache: one entry per FunctionArn, valid while LastModified and CodeSha256 are unchanged, the
// state is settled and the entry is younger than `ttlMs` (Inactive / Failed can still arrive without a new version).
// Bounded: the oldest entries go past `max`. The store lives on globalThis in the provider (routes and the sampler).
export function configCache(store: Map<string, ConfigCacheEntry>, o: { ttlMs: number; max: number }) {
  return {
    get(f: Pick<RawFunction, "FunctionArn" | "LastModified" | "CodeSha256">, now: number): DeployState | undefined {
      const e = f.FunctionArn ? store.get(f.FunctionArn) : undefined;
      if (!e) return undefined;
      if (e.version !== configVersion(f) || now - e.at > o.ttlMs || !settledState(e.state)) {
        store.delete(f.FunctionArn!);
        return undefined;
      }
      return { ...e.state };
    },
    put(f: Pick<RawFunction, "FunctionArn" | "LastModified" | "CodeSha256">, state: DeployState, now: number) {
      if (!f.FunctionArn || !settledState(state)) return;
      store.delete(f.FunctionArn); // re-inserted last: Map order is age order
      store.set(f.FunctionArn, { version: configVersion(f), at: now, state: { ...state } });
      for (const k of store.keys()) {
        if (store.size <= o.max) break;
        store.delete(k);
      }
    },
  };
}

// Structural subset of EventSourceMappingConfiguration.
export interface RawMapping {
  UUID?: string;
  EventSourceArn?: string;
  FunctionArn?: string;
  State?: string;
  BatchSize?: number;
  MaximumBatchingWindowInSeconds?: number;
  StartingPosition?: string;
  DestinationConfig?: { OnFailure?: { Destination?: string } };
  FilterCriteria?: { Filters?: { Pattern?: string }[] };
  LastProcessingResult?: string;
  ScalingConfig?: { MaximumConcurrency?: number };
}

export interface RawLambda {
  functions: RawFunctionEx[];
  mappings: RawMapping[];
}

// Labels that actions' when() read back.
export const P = {
  runtime: "Runtime",
  package: "Package type",
  reserved: "Reserved concurrency",
  envCount: "Environment variables",
  deploy: "Deployment state",
} as const;

export const IMAGE_PACKAGE = "Container image"; // the Package type prop of image functions (the deploy form's image group)
export const isImage = (f: Pick<RawFunction, "PackageType">) => f.PackageType === "Image";

export function lambdaConsoleUrl(name: string, region: string) {
  return `https://${region}.console.aws.amazon.com/lambda/home?region=${region}#/functions/${encodeURIComponent(name)}`;
}

// "Active · last update successful", "Failed", "Pending" — or why it wasn't read.
export function deployLabel(f: RawFunctionEx): string {
  if (f.deployState !== "ok") return unread("", f.deployState).trim();
  return [f.State ?? "?", f.LastUpdateStatus && `last update ${f.LastUpdateStatus === "InProgress" ? "in progress" : f.LastUpdateStatus.toLowerCase()}`].filter(Boolean).join(" · ");
}

// Health from what Lambda reports about the deployment (only when it was read — R12), then what discovery knows for
// certain (reserved concurrency 0, a deprecated runtime). Neither read nor a known problem: unknown, never ok.
export function lambdaHealth(f: RawFunctionEx, now: number): { health: Health; reason?: string } {
  const read = f.deployState === "ok";
  if (read) {
    if (f.State === "Failed") return { health: "error", reason: clip(`function failed: ${f.StateReason ?? "unknown reason"}`, 160) };
    if (f.LastUpdateStatus === "Failed") return { health: "error", reason: clip(`last update failed: ${f.LastUpdateStatusReason ?? "unknown reason"}`, 160) };
    if (f.State === "Inactive") return { health: "stopped", reason: "inactive — reclaimed after weeks without invocations; the next invocation re-activates it" };
    if (f.State === "Pending" || f.LastUpdateStatus === "InProgress") return { health: "warning", reason: "update in progress" };
  }
  if (f.reserved === 0) return { health: "warning", reason: "reserved concurrency is 0 — every invocation is throttled" };
  const dep = runtimeDeprecation(f.Runtime, now);
  if (dep?.deprecated) return { health: "warning", reason: `runtime ${f.Runtime} is deprecated (since ${dep.date}) — no more security patches` };
  if (!read) return { health: "unknown", reason: unread("deployment state", f.deployState) };
  if (dep?.soon) return { health: "ok", reason: `runtime ${f.Runtime} is deprecated on ${dep.date}` };
  return { health: "ok" };
}

function mappingEvidence(m: RawMapping): string {
  const bits = [(m.State ?? "unknown").toLowerCase(), m.BatchSize !== undefined && `batch ${m.BatchSize}`];
  if (m.MaximumBatchingWindowInSeconds) bits.push(`window ${m.MaximumBatchingWindowInSeconds} s`);
  if (m.StartingPosition) bits.push(`from ${m.StartingPosition.toLowerCase()}`);
  if (m.ScalingConfig?.MaximumConcurrency) bits.push(`max concurrency ${m.ScalingConfig.MaximumConcurrency}`);
  const filters = (m.FilterCriteria?.Filters ?? []).map((x) => patternSummary(x.Pattern, 80)).filter(Boolean);
  if (filters.length) bits.push(`filter ${filters.join(" or ")}`);
  if (m.LastProcessingResult && m.LastProcessingResult !== "OK" && m.LastProcessingResult !== "No records processed") bits.push(`last result: ${m.LastProcessingResult}`);
  return `event source mapping (${bits.filter(Boolean).join(", ")})`;
}

export function mappingLinks(m: RawMapping): Link[] {
  if (!m.EventSourceArn || !m.FunctionArn) return [];
  const fn = lambdaBase(m.FunctionArn);
  const enabled = m.State === "Enabled" || m.State === "Enabling" || m.State === "Updating";
  const out: Link[] = [
    { from: eventSourceKey(m.EventSourceArn), to: fn, kind: "poll", label: `${enabled ? "" : "disabled · "}batch ${m.BatchSize ?? "?"}`, evidence: mappingEvidence(m) },
  ];
  const onFailure = m.DestinationConfig?.OnFailure?.Destination;
  if (onFailure) out.push({ from: fn, to: targetKey(onFailure), kind: "event", label: "on failure (mapping)", evidence: `event source mapping on-failure destination (${arnName(m.EventSourceArn)})` });
  return out;
}

// A.3: the execution role, the key that encrypts the environment variables, the log group (LoggingConfig, else
// Lambda's default /aws/lambda/<name>) and the EFS access points it mounts. Image functions' ECR repository would need
// GetFunction, which also returns a presigned code URL — not read.
export function supportLinks(key: string, f: RawFunction, region: string, account: string | undefined): Link[] {
  const group = f.LoggingConfig?.LogGroup || (f.FunctionName ? `/aws/lambda/${f.FunctionName}` : undefined);
  return [
    ...assumesLink(key, f.Role, "execution role", "function configuration (Role)"),
    ...encryptsLink(kmsKeyRef(f.KMSKeyArn, region, account), key, "environment variables", "function configuration (KMSKeyArn: environment variables)"),
    ...logsLink(key, logGroupRef(group, region, account), group ?? "", f.LoggingConfig?.LogGroup ? "function logging config (LogGroup)" : "Lambda's default log group (/aws/lambda/<function>)"),
    ...(f.FileSystemConfigs ?? []).filter((m) => m.Arn).map((m): Link => ({ from: key, to: m.Arn!, kind: "mounts", label: m.LocalMountPath, evidence: "function configuration (FileSystemConfigs: EFS access point)" })),
  ];
}

export function lambdaResult(raw: RawLambda, now: number): ProviderResult {
  const resources: Resource[] = [];
  const links: Link[] = [];
  const mentions: Mention[] = [];
  for (const f of raw.functions) {
    if (!f.FunctionArn || !f.FunctionName) continue;
    const key = lambdaBase(f.FunctionArn);
    const arn = parseArn(key);
    const region = arn?.region ?? "";
    const { health, reason } = lambdaHealth(f, now);
    const dep = runtimeDeprecation(f.Runtime, now);
    const vars = f.Environment?.Variables ?? {};
    const vpcId = f.VpcConfig?.VpcId || undefined;
    const urlHost = hostOf(f.url?.url);
    const enrichment = enrichmentOf(f.enrichment ?? { state: f.deployState });
    resources.push({
      key,
      kind: "lambda",
      provider: "lambda",
      name: f.FunctionName,
      region,
      ...tagsOf(f.tags),
      health,
      healthReason: reason,
      ...(enrichment ? { enrichment } : {}),
      props: props([
        { label: P.deploy, value: deployLabel(f) },
        isImage(f) ? { label: P.package, value: IMAGE_PACKAGE } : { label: P.runtime, value: `${f.Runtime ?? "?"}${dep?.deprecated ? " (deprecated)" : ""}` },
        { label: "Architecture", value: (f.Architectures ?? ["x86_64"]).join(", ") },
        { label: "Memory", value: f.MemorySize ? `${f.MemorySize} MB` : undefined },
        { label: "Timeout", value: f.Timeout !== undefined ? fmtSeconds(f.Timeout) : undefined },
        { label: "Code size", value: !isImage(f) && f.CodeSize ? fmtBytes(f.CodeSize) : undefined },
        { label: "Handler", value: f.Handler, mono: true },
        { label: P.envCount, value: String(Object.keys(vars).length) },
        { label: P.reserved, value: f.reserved === undefined ? undefined : f.reserved === 0 ? "0 (throttled)" : String(f.reserved) },
        { label: "Function URL", value: f.url ? `${f.url.url} (${f.url.authType === "NONE" ? "public" : "IAM auth"})` : undefined, mono: true },
        { label: "VPC", value: vpcId ? `${vpcId} · ${f.VpcConfig?.SubnetIds?.length ?? 0} subnets` : undefined, mono: true },
        { label: "Layers", value: f.Layers?.length ? String(f.Layers.length) : undefined },
        { label: "Dead-letter target", value: f.DeadLetterConfig?.TargetArn ? arnName(f.DeadLetterConfig.TargetArn) : undefined },
        { label: "Role", value: f.Role ? arnName(f.Role) : undefined, mono: true },
        { label: "File systems", value: f.FileSystemConfigs?.length ? f.FileSystemConfigs.map((m) => m.LocalMountPath ?? arnName(m.Arn)).join(", ") : undefined, mono: true },
        { label: "Last modified", value: fmtTime(awsTime(f.LastModified)) },
        { label: "Description", value: f.Description ? clip(f.Description, 120) : undefined },
      ]),
      vpcId,
      subnetIds: vpcId ? f.VpcConfig?.SubnetIds : undefined,
      securityGroups: vpcId ? f.VpcConfig?.SecurityGroupIds : undefined,
      endpoints: urlHost ? [urlHost] : undefined,
      aliases: [f.FunctionName],
      lastActivityAt: f.lastActivityAt,
      consoleUrl: lambdaConsoleUrl(f.FunctionName, region),
      lastModified: awsTime(f.LastModified),
    });
    if (f.DeadLetterConfig?.TargetArn) links.push({ from: key, to: targetKey(f.DeadLetterConfig.TargetArn), kind: "event", label: "dead-letter", evidence: "dead-letter config (failed async invocations)" });
    if (f.destinations?.onFailure) links.push({ from: key, to: targetKey(f.destinations.onFailure), kind: "event", label: "on failure", evidence: "async invocation destination (on failure)" });
    if (f.destinations?.onSuccess) links.push({ from: key, to: targetKey(f.destinations.onSuccess), kind: "event", label: "on success", evidence: "async invocation destination (on success)" });
    links.push(...supportLinks(key, f, region, arn?.account));
    mentions.push(...envMentions(key, vars));
  }
  for (const m of raw.mappings) links.push(...mappingLinks(m));
  return { resources, links, mentions };
}

// Who the function's resource policy lets invoke it — the triggers configured on the other side (S3 notifications,
// API Gateway, EventBridge, SNS): [{ principal: "s3.amazonaws.com", source: "arn:aws:s3:::uploads" }].
export function policyTriggers(policy: string | undefined): { principal: string; source?: string }[] {
  if (!policy) return [];
  let doc: { Statement?: unknown };
  try {
    doc = JSON.parse(policy) as { Statement?: unknown };
  } catch {
    return [];
  }
  const stmts = (Array.isArray(doc.Statement) ? doc.Statement : doc.Statement ? [doc.Statement] : []) as Record<string, unknown>[];
  const out: { principal: string; source?: string }[] = [];
  for (const s of stmts) {
    if (s.Effect !== "Allow") continue;
    const p = s.Principal as string | Record<string, unknown> | undefined;
    const who = typeof p === "string" ? p : p ? p.Service ?? p.AWS ?? "?" : "?";
    let source: string | undefined;
    for (const op of Object.values((s.Condition ?? {}) as Record<string, Record<string, unknown>>)) {
      for (const [k, v] of Object.entries(op ?? {})) if (/^aws:sourcearn$/i.test(k)) source = String([v].flat()[0]);
    }
    out.push({ principal: [who].flat().join(", "), source });
  }
  return out;
}

// ---------- aliases & versions ----------

export interface RawAlias {
  Name?: string;
  FunctionVersion?: string;
  Description?: string;
  RoutingConfig?: { AdditionalVersionWeights?: Record<string, number> };
  RevisionId?: string;
}

const pct = (w: number) => `${+(w * 100).toFixed(1)} %`;

// "7" or "12 (90 %) + 13 (10 %)".
export function describeAlias(a: RawAlias): string {
  const extra = Object.entries(a.RoutingConfig?.AdditionalVersionWeights ?? {});
  if (!extra.length) return a.FunctionVersion ?? "?";
  const rest = 1 - extra.reduce((n, [, w]) => n + w, 0);
  return [`${a.FunctionVersion} (${pct(rest)})`, ...extra.map(([v, w]) => `${v} (${pct(w)})`)].join(" + ");
}

export interface Canary {
  version: string;
  weight: number; // 0 < weight < 1: share of traffic sent to `version`
}

// Why an alias shift can't be done as asked, given the published versions.
export function shiftProblem(version: string, canary: Canary | undefined, versions: string[]): string | undefined {
  const known = (v: string) => v === "$LATEST" || versions.includes(v);
  if (!known(version)) return `version ${version} doesn't exist (published: ${versions.filter((v) => v !== "$LATEST").slice(-8).join(", ") || "none"})`;
  if (!canary) return undefined;
  if (!(canary.weight > 0 && canary.weight < 1)) return "the canary weight must be between 0 and 1 (e.g. 0.1 = 10 % of traffic)";
  if (canary.version === version) return "the canary version must differ from the alias's main version";
  if (version === "$LATEST" || canary.version === "$LATEST") return "weighted routing needs published versions, not $LATEST";
  if (!known(canary.version)) return `canary version ${canary.version} doesn't exist`;
  return undefined;
}

// Where rollback-alias sends an alias: a canary is removed (all traffic back to the main version); otherwise the
// alias moves to the newest published version older than its current one.
export function rollbackTarget(a: RawAlias, versions: string[]): { version: string; why: string } | { problem: string } {
  const current = a.FunctionVersion ?? "";
  if (Object.keys(a.RoutingConfig?.AdditionalVersionWeights ?? {}).length) return { version: current, why: `remove the canary — all traffic back to version ${current}` };
  if (current === "$LATEST") return { problem: "the alias points at $LATEST — give toVersion to pin it to a published version" };
  const older = versions.filter((v) => /^\d+$/.test(v) && Number(v) < Number(current)).sort((x, y) => Number(y) - Number(x));
  if (!older.length) return { problem: `no published version older than ${current}` };
  return { version: older[0], why: `version ${current} → ${older[0]} (the newest older version)` };
}

// ---------- deploy input ----------

export type DeployInput = {
  zipBase64?: string;
  s3Bucket?: string;
  s3Key?: string;
  s3ObjectVersion?: string;
  imageUri?: string;
  publish?: boolean;
  alias?: string;
  description?: string;
};

export type DeploySource = { kind: "zip" } | { kind: "s3"; bucket: string; key: string; version?: string } | { kind: "image"; uri: string };

// The deploy form's three ways to give code (x-group hints on deploy-code's input): a .zip upload, a .zip in S3, or a
// container image — the image group only for functions whose Package type is "Container image", the others only
// for .zip functions.
export const CODE_SOURCES = {
  zip: "a .zip upload (zipBase64)",
  s3: "a .zip in S3 (s3Bucket + s3Key)",
  image: "a container image (imageUri)",
} as const;

// Which code source the input names, refused in plain words (field names in parentheses) when it names none, several,
// or the wrong kind for the function.
export function deploySource(i: DeployInput, packageType: string | undefined): DeploySource | { problem: string } {
  const given = [i.zipBase64 ? CODE_SOURCES.zip : "", i.s3Bucket || i.s3Key ? CODE_SOURCES.s3 : "", i.imageUri ? CODE_SOURCES.image : ""].filter(Boolean);
  const image = packageType === "Image";
  if (!given.length) return { problem: image ? `Choose the new code: ${CODE_SOURCES.image}.` : `Choose the new code: ${CODE_SOURCES.zip} or ${CODE_SOURCES.s3}.` };
  if (given.length > 1) return { problem: `Choose one code source, not ${given.length}: ${given.join(" and ")}.` };
  if (image && !i.imageUri) return { problem: `This function runs a container image: give the new image's ECR URI (imageUri), not ${given[0]}.` };
  if (!image && i.imageUri) return { problem: `This function runs a .zip package: give ${CODE_SOURCES.zip} or ${CODE_SOURCES.s3}, not an image.` };
  if (i.alias && !i.publish) return { problem: "Moving an alias needs a published version: also choose “Publish a new version afterwards” (publish)." };
  if (i.imageUri) return { kind: "image", uri: i.imageUri };
  if (i.s3Bucket || i.s3Key) {
    if (!i.s3Bucket || !i.s3Key) return { problem: "Give both the S3 bucket (s3Bucket) and the object key of the .zip (s3Key)." };
    return { kind: "s3", bucket: i.s3Bucket, key: i.s3Key, version: i.s3ObjectVersion };
  }
  return { kind: "zip" };
}
