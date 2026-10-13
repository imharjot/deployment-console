// Pure helpers shared by the serverless & messaging providers (Lambda, SQS, SNS, EventBridge, Step Functions, Kinesis,
// DynamoDB, API Gateway): ARN parsing and normalisation, target → Link mapping, the support links every one of them
// draws (role, KMS key, log group), tags that were or weren't read, one-line summaries of filter policies, event
// patterns and schedules, masking, formatting, action input fields for people, and the checks action inputs go
// through. No AWS calls and no `server-only`, so node:test runs them (see serverless-common.test.ts).
import { arnBase, arnOf } from "./arn.ts";
import type { JsonSchema } from "../server/ops/types.ts";
import type { EnrichState, Link, Mention, Prop, Resource } from "./types.ts";

// ---------- ARNs ----------

export interface Arn {
  partition: string;
  service: string;
  region: string;
  account: string;
  resource: string; // everything after the account: "function:name", "table/orders", "stream/clicks/consumer/x:1"
}

export function parseArn(arn: string | undefined): Arn | undefined {
  const m = /^arn:(aws[\w-]*):([a-z0-9-]+):([a-z0-9-]*):(\d*):(.+)$/.exec(arn ?? "");
  return m ? { partition: m[1], service: m[2], region: m[3], account: m[4], resource: m[5] } : undefined;
}

// The last path/colon segment of an ARN's resource part ("arn:…:sns:r:a:alerts" → "alerts", "…:table/orders" → "orders").
export const arnName = (arn: string | undefined) => (parseArn(arn)?.resource ?? arn ?? "").split(/[:/]/).pop() ?? "";

// Lambda ARNs may carry a qualifier (version or alias): "…:function:orders:live" → "…:function:orders".
export function lambdaBase(arn: string): string {
  const m = /^(arn:aws[\w-]*:lambda:[^:]+:\d+:function:[^:]+)(?::.+)?$/.exec(arn);
  return m ? m[1] : arn;
}

// A function reference as Step Functions / API Gateway / env vars write it — full ARN, partial ARN
// ("123456789012:function:orders"), name, or name:qualifier — as the function's unqualified ARN.
export function lambdaRef(ref: string, region: string, account: string, partition = "aws"): string {
  if (ref.startsWith("arn:")) return lambdaBase(ref);
  const partial = /^(\d{12}):function:([^:]+)/.exec(ref);
  if (partial) return `arn:${partition}:lambda:${region}:${partial[1]}:function:${partial[2]}`;
  const name = ref.split(":")[0];
  return `arn:${partition}:lambda:${region}:${account}:function:${name}`;
}

// Event source mappings name a DynamoDB *stream* or a Kinesis *consumer*; the map shows the table / stream.
export function eventSourceKey(arn: string): string {
  const ddb = /^(arn:aws[\w-]*:dynamodb:[^:]+:\d+:table\/[^/]+)\/stream\/.+$/.exec(arn);
  if (ddb) return ddb[1];
  const consumer = /^(arn:aws[\w-]*:kinesis:[^:]+:\d+:stream\/[^/]+)\/consumer\/.+$/.exec(arn);
  if (consumer) return consumer[1];
  return arn;
}

// "https://sqs.us-east-1.amazonaws.com/123456789012/orders" (and the legacy queue.amazonaws.com forms) → queue ARN.
export function queueArnFromUrl(url: string): string | undefined {
  const m = /^https?:\/\/(?:sqs\.([a-z0-9-]+)\.amazonaws\.com(?:\.cn)?|([a-z0-9-]+)\.queue\.amazonaws\.com|queue\.amazonaws\.com)\/(\d{12})\/([\w-]+(?:\.fifo)?)\/?$/.exec(url);
  if (!m) return undefined;
  const region = m[1] ?? m[2] ?? "us-east-1";
  return `arn:${region.startsWith("cn-") ? "aws-cn" : "aws"}:sqs:${region}:${m[3]}:${m[4]}`;
}

export function queueUrlFromArn(arn: string): string | undefined {
  const a = parseArn(arn);
  if (!a || a.service !== "sqs") return undefined;
  return `https://sqs.${a.region}.amazonaws.com${a.partition === "aws-cn" ? ".cn" : ""}/${a.account}/${a.resource}`;
}

// ALB/NLB listener ARN (API Gateway VPC-link integrations point at one) → load balancer name.
export function lbNameFromListener(arn: string): string | undefined {
  return /:elasticloadbalancing:[^:]*:\d*:listener\/(?:app|net)\/([^/]+)\//.exec(arn)?.[1];
}

// Host of a URL ("https://hooks.example.net/x?y" → "hooks.example.net"); bare hostnames pass through.
export function hostOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `https://${url}`).hostname.toLowerCase() || undefined;
  } catch {
    return undefined;
  }
}

// ---------- support links (A.3): role, KMS key, log group ----------

// A KMS key as a service reports it — a key or alias ARN, a bare key id ("1234abcd-…", "mrk-…") or a bare alias
// ("alias/aws/sqs") — as a reference the map resolves: bare ids and aliases become ARNs in the resource's own region
// and account (CC-19: "alias/aws/sqs" is that region's AWS-managed key). undefined without an account to build from.
export function kmsKeyRef(id: string | undefined, region: string, account: string | undefined): string | undefined {
  const v = id?.trim();
  if (!v) return undefined;
  if (v.startsWith("arn:")) return v;
  if (!account || !region) return undefined;
  return v.startsWith("alias/") ? arnOf.kmsAlias(region, account, v) : arnOf.kmsKey(region, account, v);
}

// KMS key → what it encrypts.
export const encryptsLink = (kms: string | undefined, to: string, label: string, evidence: string): Link[] =>
  kms ? [{ from: kms, to, kind: "encrypts", label, evidence }] : [];

// What runs as an IAM role → the role. Only role ARNs: a bare name can't be told apart from a policy or a user.
export const assumesLink = (from: string, role: string | undefined, label: string, evidence: string): Link[] =>
  role && /^arn:aws[\w-]*:iam::\d*:role\//.test(role) ? [{ from, to: role, kind: "assumes", label, evidence }] : [];

// Where something writes its logs: a log group ARN (without the ":*" some APIs append), or a Firehose stream / bucket ARN.
export const logsLink = (from: string, dest: string | undefined, label: string, evidence: string): Link[] =>
  dest?.startsWith("arn:") ? [{ from, to: arnBase(dest.trim()), kind: "logs", label, evidence }] : [];

// A log group by name in a resource's region and account ("/aws/lambda/orders" → its ARN).
export const logGroupRef = (name: string | undefined, region: string, account: string | undefined) =>
  name && account && region ? arnOf.logGroup(region, account, name) : undefined;

// ---------- tags, time, formatting ----------

type TagList = { Key?: string; Value?: string; key?: string; value?: string }[];
export function tagMap(tags?: Record<string, string> | TagList): Record<string, string> {
  if (!tags) return {};
  if (!Array.isArray(tags)) return { ...tags };
  return Object.fromEntries(tags.map((t) => [t.Key ?? t.key ?? "", t.Value ?? t.value ?? ""]).filter(([k]) => k));
}

// A resource's tags and whether they were read (R01, I06). Providers pass `undefined` when the tag read didn't happen
// (capped, past the time budget, denied, failed) and `{}` / [] when it happened and found none: "no tags" and "not
// looked" must never look alike, because protection fails closed on the second.
export function tagsOf(tags?: Record<string, string> | TagList): { tags: Record<string, string>; tagsUnread?: true } {
  return tags === undefined ? { tags: {}, tagsUnread: true } : { tags: tagMap(tags) };
}

// Per-read enrichment states for Resource.enrichment ({ tags: "capped", state: "ok" }), or undefined when none is known.
export function enrichmentOf(states: Record<string, EnrichState | undefined> | undefined): Record<string, EnrichState> | undefined {
  const out: Record<string, EnrichState> = {};
  for (const [k, v] of Object.entries(states ?? {})) if (v) out[k] = v;
  return Object.keys(out).length ? out : undefined;
}

// "deployment state not read (capped)" — why an optional read has no answer, for props and health reasons. The state
// word is the enrichment state: skipped (time budget or deadline), denied, capped (past the per-run limit) or error.
export const unread = (what: string, state: EnrichState | undefined) => `${what} not read (${state && state !== "ok" ? state : "skipped"})`;

// Lambda writes "2024-05-01T10:00:00.000+0000"; everything else is a Date or epoch seconds as a string.
export function awsTime(v: string | Date | number | undefined): number | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? undefined : v.getTime();
  if (typeof v === "number") return v;
  if (/^\d{9,11}$/.test(v)) return Number(v) * 1000; // SQS: epoch seconds
  const t = Date.parse(v.replace(/([+-]\d\d)(\d\d)$/, "$1:$2"));
  return Number.isNaN(t) ? undefined : t;
}

export function fmtBytes(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n)) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${+(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${+(n / 1024 ** 2).toFixed(1)} MB`;
  return `${+(n / 1024 ** 3).toFixed(2)} GB`;
}

export function fmtSeconds(s: number | undefined): string {
  if (s === undefined || !Number.isFinite(s)) return "—";
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${+(s / 60).toFixed(1)} min`;
  if (s < 86_400) return `${+(s / 3600).toFixed(1)} h`;
  return `${+(s / 86_400).toFixed(1)} days`;
}

export const fmtCount = (n: number | undefined) => (n === undefined || !Number.isFinite(n) ? "—" : n.toLocaleString("en-US"));
export const fmtTime = (ms: number | undefined) => (ms === undefined ? "—" : `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`);
export const plural = (n: number, one: string, many = `${one}s`) => `${fmtCount(n)} ${n === 1 ? one : many}`;
export const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

// A Prop list without the rows whose value is missing.
export function props(rows: (Prop | false | undefined | null | { label: string; value: undefined })[]): Prop[] {
  return rows.filter((r): r is Prop => !!r && typeof r.value === "string" && r.value !== "");
}

// The value of a Prop by label — actions' when() read the facts discovery put there.
export const propOf = (r: Pick<Resource, "props">, label: string) => r.props.find((p) => p.label === label)?.value;

// ---------- masking ----------

// "ops-team@acme.example" → "o…@acme.example". Enough to recognise a list, not to harvest it.
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at < 1) return "…";
  return `${email[0]}…${email.slice(at)}`;
}

// "+15551234567" → "+…67".
export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  return digits.length < 4 ? "…" : `${phone.trim().startsWith("+") ? "+" : ""}…${digits.slice(-2)}`;
}

// ---------- policies, patterns, schedules ----------

// One line for an SNS filter policy or an EventBridge event pattern (same matching language):
// {"source":["acme.shop"],"detail":{"amount":[{"numeric":[">",100]}]}} → "source: acme.shop; detail.amount: > 100".
export function patternSummary(json: string | undefined, max = 200): string | undefined {
  if (!json) return undefined;
  let o: unknown;
  try {
    o = JSON.parse(json);
  } catch {
    return "(unreadable pattern)";
  }
  const out: string[] = [];
  walkPattern(o, "", out);
  return out.length ? clip(out.join("; "), max) : undefined;
}

function walkPattern(o: unknown, path: string, out: string[]) {
  if (Array.isArray(o)) {
    out.push(`${path || "value"}: ${o.map(matcher).join(" | ")}`);
    return;
  }
  if (o && typeof o === "object") {
    for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
      if (k === "$or" && Array.isArray(v)) {
        const alts = v.map((x) => {
          const sub: string[] = [];
          walkPattern(x, path, sub);
          return sub.join("; ");
        });
        out.push(`(${alts.join(") or (")})`);
      } else walkPattern(v, path ? `${path}.${k}` : k, out);
    }
    return;
  }
  out.push(`${path || "value"}: ${matcher(o)}`);
}

const NUM_OP: Record<string, string> = { ">": ">", ">=": "≥", "<": "<", "<=": "≤", "=": "=" };

function matcher(v: unknown): string {
  if (v === null) return "null";
  if (typeof v !== "object") return String(v);
  if (Array.isArray(v)) return v.map(matcher).join(" | ");
  const o = v as Record<string, unknown>;
  const [k, x] = Object.entries(o)[0] ?? ["", undefined];
  switch (k) {
    case "prefix":
      return `starts with ${matcher(x)}`;
    case "suffix":
      return `ends with ${matcher(x)}`;
    case "anything-but":
      return `not ${matcher(x)}`;
    case "exists":
      return x === false ? "missing" : "exists";
    case "equals-ignore-case":
      return `≈ ${matcher(x)}`;
    case "wildcard":
      return `like ${matcher(x)}`;
    case "cidr":
      return `in ${matcher(x)}`;
    case "numeric": {
      const a = Array.isArray(x) ? x : [];
      const parts: string[] = [];
      for (let i = 0; i + 1 < a.length; i += 2) parts.push(`${NUM_OP[String(a[i])] ?? a[i]} ${a[i + 1]}`);
      return parts.join(" ");
    }
    default:
      return JSON.stringify(o);
  }
}

// "rate(5 minutes)" → "every 5 minutes"; "cron(0 2 * * ? *)" → "daily at 02:00 UTC". undefined when it isn't simple.
export function describeSchedule(expr: string | undefined): string | undefined {
  if (!expr) return undefined;
  const rate = /^rate\((\d+)\s+(minute|minutes|hour|hours|day|days)\)$/.exec(expr.trim());
  if (rate) {
    const n = Number(rate[1]);
    const unit = rate[2].replace(/s$/, "");
    return n === 1 ? `every ${unit}` : `every ${n} ${unit}s`;
  }
  const cron = /^cron\((.+)\)$/.exec(expr.trim());
  if (!cron) return undefined;
  const f = cron[1].trim().split(/\s+/);
  if (f.length !== 6) return undefined;
  const [min, hour, dom, month, dow] = f;
  if (!/^\d{1,2}$/.test(min)) return undefined;
  const any = (x: string) => x === "*" || x === "?";
  const at = /^\d{1,2}$/.test(hour) ? `${hour.padStart(2, "0")}:${min.padStart(2, "0")} UTC` : undefined;
  if (at && any(dom) && any(month) && any(dow)) return `daily at ${at}`;
  if (at && any(dom) && any(month) && /^[A-Z0-9,-]+$/i.test(dow)) return `${dow} at ${at}`;
  if (hour === "*" && any(dom) && any(month) && any(dow)) return `hourly at :${min.padStart(2, "0")}`;
  if (at && /^\d{1,2}$/.test(dom) && any(month) && any(dow)) return `monthly on day ${dom} at ${at}`;
  return undefined;
}

// ---------- links from targets / subscriptions / destinations ----------

// Where an ARN points on the map: Lambda qualifiers stripped, DynamoDB streams → table, Kinesis consumers → stream.
export function targetKey(arn: string): string {
  const a = parseArn(arn);
  if (!a) return arn;
  if (a.service === "lambda") return lambdaBase(arn);
  return eventSourceKey(arn);
}

export interface EbTarget {
  Id?: string;
  Arn?: string;
  RoleArn?: string;
  Input?: string;
  InputPath?: string;
  InputTransformer?: unknown;
  EcsParameters?: { TaskDefinitionArn?: string; LaunchType?: string; TaskCount?: number };
  DeadLetterConfig?: { Arn?: string };
  RetryPolicy?: { MaximumRetryAttempts?: number; MaximumEventAgeInSeconds?: number };
}

// An EventBridge rule's target as Links (the target itself, plus its dead-letter queue when set). API destinations
// resolve to their endpoint's host (never the path: webhook URLs often carry tokens).
export function ebTargetLinks(ruleKey: string, t: EbTarget, apiDestinations: Record<string, string> = {}): Link[] {
  if (!t.Arn) return [];
  const a = parseArn(t.Arn);
  const input = t.InputTransformer ? "input transformer" : t.Input ? "constant input" : t.InputPath ? `input path ${t.InputPath}` : undefined;
  const why = `EventBridge target${t.Id ? ` ${t.Id}` : ""}${input ? ` (${input})` : ""}`;
  const out: Link[] = [];
  if (a?.service === "events" && a.resource.startsWith("api-destination/")) {
    const host = hostOf(apiDestinations[t.Arn]);
    out.push({ from: ruleKey, to: host ?? t.Arn, kind: "event", label: `API destination ${a.resource.split("/")[1]}`, evidence: why });
  } else if (a?.service === "events" && a.resource.startsWith("event-bus/")) {
    out.push({ from: ruleKey, to: t.Arn, kind: "event", label: "forward to bus", evidence: why });
  } else if (a?.service === "ecs") {
    const td = t.EcsParameters?.TaskDefinitionArn;
    const family = (td && /:task-definition\/(.+)$/.exec(td)?.[1]) || td || "task"; // "family:revision"
    out.push({ from: ruleKey, to: t.Arn, kind: "invoke", label: `run task ${family}`, evidence: `${why}, ECS RunTask ${t.EcsParameters?.LaunchType ?? ""}`.trim() });
  } else {
    out.push({ from: ruleKey, to: targetKey(t.Arn), kind: "event", label: "target", evidence: why });
  }
  if (t.DeadLetterConfig?.Arn) out.push({ from: ruleKey, to: t.DeadLetterConfig.Arn, kind: "event", label: "target dead-letter queue", evidence: `dead-letter queue of target ${t.Id ?? ""}`.trim() });
  return out;
}

export interface SnsSub {
  SubscriptionArn?: string;
  Protocol?: string;
  Endpoint?: string;
  filterPolicy?: string;
  filterPolicyScope?: string;
  rawDelivery?: boolean;
  redriveTo?: string; // subscription dead-letter queue ARN
}

// An SNS subscription: a Link for endpoints that are resources or hosts, a masked value for people (email, SMS).
export function snsSubscription(topicKey: string, s: SnsSub): { links: Link[]; masked?: { protocol: string; value: string } } {
  const protocol = (s.Protocol ?? "").toLowerCase();
  const endpoint = s.Endpoint ?? "";
  const pending = s.SubscriptionArn === "PendingConfirmation";
  const filter = patternSummary(s.filterPolicy, 120);
  const bits = [pending && "pending confirmation", filter && `filter${s.filterPolicyScope === "MessageBody" ? " (body)" : ""}: ${filter}`, s.rawDelivery && "raw delivery"].filter(Boolean);
  const evidence = `SNS subscription (${protocol})${bits.length ? `, ${bits.join(", ")}` : ""}`;
  const links: Link[] = [];
  const dlq = s.redriveTo ? [{ from: topicKey, to: s.redriveTo, kind: "event" as const, label: "subscription dead-letter queue", evidence: `redrive policy of the ${protocol} subscription` }] : [];
  switch (protocol) {
    case "lambda":
    case "sqs":
    case "firehose":
      if (endpoint) links.push({ from: topicKey, to: targetKey(endpoint), kind: "event", label: pending ? "subscription (pending)" : "subscription", evidence });
      return { links: [...links, ...dlq] };
    case "http":
    case "https": {
      const host = hostOf(endpoint);
      if (host) links.push({ from: topicKey, to: host, kind: "event", label: `webhook ${protocol}${pending ? " (pending)" : ""}`, evidence });
      return { links: [...links, ...dlq] };
    }
    case "email":
    case "email-json":
      return { links: dlq, masked: { protocol, value: maskEmail(endpoint) } };
    case "sms":
      return { links: dlq, masked: { protocol, value: maskPhone(endpoint) } };
    default:
      return { links: dlq, masked: { protocol: protocol || "unknown", value: protocol === "application" ? "mobile endpoint" : "…" } };
  }
}

// ---------- env-var mentions ----------

// One Mention per variable (via names the variable, never the value). Values stay on the server; the inventory only
// matches them against other resources' names / ARNs / endpoints. Flags, numbers and tiny values can't name anything.
export function envMentions(from: string, vars: Record<string, string> | undefined, via = "env"): Mention[] {
  const out: Mention[] = [];
  for (const [name, value] of Object.entries(vars ?? {})) {
    const v = (value ?? "").trim();
    if (v.length < 3 || v.length > 4096 || /^(true|false|yes|no|on|off|null|-?\d+(\.\d+)?)$/i.test(v)) continue;
    const parts = v.split(/[\s,;]+/).filter((p) => p.length >= 3 && p !== v);
    out.push({ from, refs: [v, ...parts], via: `${via} ${name}` });
  }
  return out;
}

// ---------- action input fields for people (F42) ----------

// One property of an action's input schema with a title for the form (the map's action dialog shows `title`; agents and
// MCP read `description`) and, where a form shows one group of fields at a time, an `x-group` hint. Structurally the
// JSON Schema subset of src/lib/server/ops/types.ts plus those two keys, so it fits an action's `input` as is.
export type InputField = JsonSchema;

export const field = (title: string, s: Omit<InputField, "title">, group?: string): InputField => ({ title, ...s, ...(group ? { "x-group": group } : {}) });

// What an action's audit record keeps of its result: these own fields only (R08 — never logs, payloads or values).
export function pickFields(v: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  const o = v as Record<string, unknown>;
  return Object.fromEntries(keys.filter((k) => Object.hasOwn(o, k) && o[k] !== undefined).map((k) => [k, o[k]]));
}

// ---------- input checks for actions ----------

export const byteLength = (s: string) => new TextEncoder().encode(s).length;

// A problem with a JSON text input (size in bytes, then syntax), or undefined when it's fine. Empty = allowed.
export function jsonProblem(text: string | undefined, maxBytes: number, what = "input"): string | undefined {
  if (text === undefined || text === "") return undefined;
  const n = byteLength(text);
  if (n > maxBytes) return `${what} is ${fmtBytes(n)} — at most ${fmtBytes(maxBytes)}`;
  try {
    JSON.parse(text);
  } catch (e) {
    return `${what} isn't valid JSON (${(e as Error).message.slice(0, 80)})`;
  }
  return undefined;
}

// Message attributes for test messages: string → string, names per SQS/SNS rules, at most 10.
export function attributesProblem(attrs: Record<string, unknown> | undefined): string | undefined {
  if (!attrs) return undefined;
  const entries = Object.entries(attrs);
  if (entries.length > 10) return "at most 10 message attributes";
  for (const [k, v] of entries) {
    if (!/^[A-Za-z0-9_.-]{1,256}$/.test(k) || /^(aws\.|amazon\.)/i.test(k) || k.startsWith(".") || k.endsWith(".") || k.includes("..")) return `"${k}" isn't a valid attribute name`;
    if (typeof v !== "string" || v.length === 0 || v.length > 1024) return `attribute "${k}" must be a non-empty string of at most 1,024 characters`;
  }
  return undefined;
}

// Lambda environment variable names and the variables AWS reserves.
const LAMBDA_RESERVED = new Set([
  "_HANDLER", "_X_AMZN_TRACE_ID", "AWS_DEFAULT_REGION", "AWS_REGION", "AWS_EXECUTION_ENV", "AWS_LAMBDA_FUNCTION_NAME", "AWS_LAMBDA_FUNCTION_MEMORY_SIZE",
  "AWS_LAMBDA_FUNCTION_VERSION", "AWS_LAMBDA_INITIALIZATION_TYPE", "AWS_LAMBDA_LOG_GROUP_NAME", "AWS_LAMBDA_LOG_STREAM_NAME", "AWS_ACCESS_KEY",
  "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_LAMBDA_RUNTIME_API", "LAMBDA_TASK_ROOT", "LAMBDA_RUNTIME_DIR",
]);
export const LAMBDA_ENV_MAX_BYTES = 4096; // all variables together

export function lambdaEnvNameProblem(name: string): string | undefined {
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name)) return `"${name}" isn't a valid variable name (a letter, then letters, digits and _)`;
  if (LAMBDA_RESERVED.has(name)) return `"${name}" is reserved by Lambda`;
  return undefined;
}

export interface EnvEdit {
  next: Record<string, string>;
  added: string[];
  changed: string[];
  removed: string[];
  problems: string[];
}

// Apply set/remove to a function's variables, keeping every other one. Names only in added/changed/removed.
export function editEnv(current: Record<string, string>, set: Record<string, unknown> = {}, remove: string[] = []): EnvEdit {
  const next: Record<string, string> = { ...current };
  const out: EnvEdit = { next, added: [], changed: [], removed: [], problems: [] };
  for (const [k, v] of Object.entries(set)) {
    const p = lambdaEnvNameProblem(k);
    if (p) out.problems.push(p);
    else if (typeof v !== "string") out.problems.push(`the value of "${k}" must be a string`);
    else if (remove.includes(k)) out.problems.push(`"${k}" is both set and removed`);
    else {
      // Never compare against the current value: "unchanged" would tell whoever plans a change what a secret is.
      if (!Object.hasOwn(current, k)) out.added.push(k);
      else out.changed.push(k);
      next[k] = v;
    }
  }
  for (const k of remove) {
    if (Object.hasOwn(next, k) && !Object.hasOwn(set, k)) {
      delete next[k];
      out.removed.push(k);
    } else if (!Object.hasOwn(current, k)) out.problems.push(`"${k}" isn't set, nothing to remove`);
  }
  const size = Object.entries(next).reduce((n, [k, v]) => n + byteLength(k) + byteLength(v), 0);
  // No exact total: it would leak the length of values nobody may read.
  if (size > LAMBDA_ENV_MAX_BYTES) out.problems.push(`the variables would exceed Lambda's ${fmtBytes(LAMBDA_ENV_MAX_BYTES)} limit for all variables together`);
  return out;
}

// ---------- Lambda runtimes ----------

// Deprecation dates (Lambda's "deprecation" phase: no more security patches) as of 2026-09. Update when AWS announces
// new ones: https://docs.aws.amazon.com/lambda/latest/dg/lambda-runtimes.html
const RUNTIME_DEPRECATION: Record<string, string> = {
  "nodejs4.3": "2020-03-05", "nodejs6.10": "2019-08-12", "nodejs8.10": "2020-03-06", "nodejs10.x": "2021-07-30", "nodejs12.x": "2023-03-31",
  "nodejs14.x": "2023-12-04", "nodejs16.x": "2024-06-12", "nodejs18.x": "2025-09-01", "nodejs20.x": "2026-04-30",
  "python2.7": "2021-07-15", "python3.6": "2022-07-18", "python3.7": "2023-12-04", "python3.8": "2024-10-14", "python3.9": "2025-12-15", "python3.10": "2026-06-30",
  "ruby2.5": "2021-07-30", "ruby2.7": "2023-12-07", "ruby3.2": "2026-03-31",
  java8: "2024-01-08", "dotnetcore2.1": "2022-01-05", "dotnetcore3.1": "2023-04-03", dotnet6: "2024-12-20", dotnet7: "2024-05-14", dotnet8: "2026-11-10",
  "go1.x": "2023-12-31", provided: "2023-12-31",
};

// { date, deprecated } for runtimes with a known date; `soon` = within 120 days.
export function runtimeDeprecation(runtime: string | undefined, now: number): { date: string; deprecated: boolean; soon: boolean } | undefined {
  const date = runtime ? RUNTIME_DEPRECATION[runtime] : undefined;
  if (!date) return undefined;
  const at = Date.parse(`${date}T00:00:00Z`);
  return { date, deprecated: at <= now, soon: at > now && at - now < 120 * 86_400_000 };
}
