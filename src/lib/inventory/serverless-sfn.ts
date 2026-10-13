// Step Functions, pure part: what a state machine's definition (Amazon States Language) calls — Lambda functions,
// SNS topics, SQS queues, DynamoDB tables, ECS tasks, nested state machines, EventBridge buses, S3 buckets, Kinesis
// streams, HTTP endpoints — as Links, plus its execution role, log group and KMS key (A.3), the raw → Resource mapping
// shared by real and simulated discovery, and the default name start-execution gives an execution (F31).
// Paths computed at run time (Parameters keys ending in ".$", JSONata "{% … %}") can't be resolved and are skipped.
import {
  arnName, assumesLink, clip, encryptsLink, enrichmentOf, fmtTime, hostOf, kmsKeyRef, lambdaRef, logsLink, parseArn, props, queueArnFromUrl, tagsOf, unread,
} from "./serverless-common.ts";
import type { EnrichState, Health, Link, ProviderResult, Resource } from "./types.ts";

export interface AslRef {
  to: string; // resource key or reference (ARN, queue URL, hostname)
  kind: "invoke" | "writes" | "reads";
  service: string; // "lambda", "sns", "sqs", "dynamodb", "ecs", "states", "events", "s3", "kinesis", "http"
  states: string[]; // state names that make the call
}

export interface AslState {
  name: string;
  type: string;
  resource?: string; // the Task's Resource, as written
  target?: string; // what it calls, when known
}

interface Ctx {
  region: string;
  account: string;
  partition: string;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
// A static string parameter (Parameters for JSONPath, Arguments for JSONata); dynamic ones are skipped.
function param(state: Obj, key: string): string | undefined {
  for (const bag of [state.Parameters, state.Arguments]) {
    if (!isObj(bag)) continue;
    const v = bag[key];
    if (typeof v === "string" && !/^\{%.*%\}$/s.test(v.trim())) return v;
  }
  return undefined;
}

const WRITE_VERB = /^(put|update|delete|batchWrite|transactWrite|send|publish|create|copy|upload|start|execute)/i;
const READ_VERB = /^(get|query|scan|list|head|describe|select|batchGet|transactGet|receive)/i;

// What one Task state calls, or undefined when it's dynamic / not a resource the map knows.
function taskRef(state: Obj, c: Ctx): Omit<AslRef, "states"> | undefined {
  const res = typeof state.Resource === "string" ? state.Resource : "";
  const direct = parseArn(res);
  if (direct?.service === "lambda") return { to: lambdaRef(res, c.region, c.account, c.partition), kind: "invoke", service: "lambda" };
  if (direct?.service === "states" && direct.resource.startsWith("activity:")) return undefined;
  const m = /^arn:aws[\w-]*:states:::(.+?)(?:\.(?:sync(?::\d+)?|waitForTaskToken))?$/.exec(res);
  if (!m) return undefined;
  const api = m[1];
  const table = (name?: string) => (name ? (name.startsWith("arn:") ? name : `arn:${c.partition}:dynamodb:${c.region}:${c.account}:table/${name}`) : undefined);
  const queue = (url?: string) => (url ? queueArnFromUrl(url) ?? url : undefined);
  switch (api) {
    case "lambda:invoke": {
      const fn = param(state, "FunctionName");
      return fn ? { to: lambdaRef(fn, c.region, c.account, c.partition), kind: "invoke", service: "lambda" } : undefined;
    }
    case "sns:publish": {
      const topic = param(state, "TopicArn") ?? param(state, "TargetArn");
      return topic ? { to: topic, kind: "writes", service: "sns" } : undefined;
    }
    case "sqs:sendMessage": {
      const q = queue(param(state, "QueueUrl"));
      return q ? { to: q, kind: "writes", service: "sqs" } : undefined;
    }
    case "dynamodb:putItem":
    case "dynamodb:updateItem":
    case "dynamodb:deleteItem":
    case "dynamodb:getItem": {
      const t = table(param(state, "TableName"));
      return t ? { to: t, kind: api === "dynamodb:getItem" ? "reads" : "writes", service: "dynamodb" } : undefined;
    }
    case "ecs:runTask": {
      const cluster = param(state, "Cluster");
      if (!cluster) return undefined;
      const arn = cluster.startsWith("arn:") ? cluster : `arn:${c.partition}:ecs:${c.region}:${c.account}:cluster/${cluster}`;
      return { to: arn, kind: "invoke", service: "ecs" };
    }
    case "states:startExecution": {
      const sm = param(state, "StateMachineArn");
      return sm ? { to: sm, kind: "invoke", service: "states" } : undefined;
    }
    case "events:putEvents": {
      const entries = (isObj(state.Parameters) ? state.Parameters.Entries : isObj(state.Arguments) ? state.Arguments.Entries : undefined) as unknown;
      const bus = Array.isArray(entries) && isObj(entries[0]) && typeof entries[0].EventBusName === "string" ? (entries[0].EventBusName as string) : "default";
      const arn = bus.startsWith("arn:") ? bus : `arn:${c.partition}:events:${c.region}:${c.account}:event-bus/${bus}`;
      return { to: arn, kind: "writes", service: "events" };
    }
    case "http:invoke":
    case "apigateway:invoke": {
      const host = hostOf(param(state, "ApiEndpoint"));
      return host ? { to: host, kind: "invoke", service: "http" } : undefined;
    }
  }
  // AWS SDK integrations: arn:aws:states:::aws-sdk:<service>:<action>
  const sdk = /^aws-sdk:([a-z0-9]+):([A-Za-z0-9]+)$/.exec(api);
  if (!sdk) return undefined;
  const [, svc, action] = sdk;
  const kind: "writes" | "reads" | undefined = WRITE_VERB.test(action) ? "writes" : READ_VERB.test(action) ? "reads" : undefined;
  if (!kind) return undefined;
  switch (svc) {
    case "dynamodb": {
      const t = table(param(state, "TableName"));
      return t ? { to: t, kind, service: "dynamodb" } : undefined;
    }
    case "s3": {
      const b = param(state, "Bucket");
      return b ? { to: `arn:${c.partition}:s3:::${b}`, kind, service: "s3" } : undefined;
    }
    case "sqs": {
      const q = queue(param(state, "QueueUrl"));
      return q ? { to: q, kind, service: "sqs" } : undefined;
    }
    case "sns": {
      const t = param(state, "TopicArn");
      return t ? { to: t, kind, service: "sns" } : undefined;
    }
    case "kinesis": {
      const s = param(state, "StreamARN") ?? param(state, "StreamName");
      return s ? { to: s.startsWith("arn:") ? s : `arn:${c.partition}:kinesis:${c.region}:${c.account}:stream/${s}`, kind, service: "kinesis" } : undefined;
    }
    case "lambda": {
      const fn = param(state, "FunctionName");
      return fn && /^invoke/i.test(action) ? { to: lambdaRef(fn, c.region, c.account, c.partition), kind: "invoke", service: "lambda" } : undefined;
    }
    case "sfn": {
      const sm = param(state, "StateMachineArn");
      return sm && /^start/i.test(action) ? { to: sm, kind: "invoke", service: "states" } : undefined;
    }
    case "eventbridge": {
      return /^putEvents$/i.test(action) ? { to: `arn:${c.partition}:events:${c.region}:${c.account}:event-bus/default`, kind: "writes", service: "events" } : undefined;
    }
  }
  return undefined;
}

// Every state, recursively (Parallel branches, Map iterators / item processors).
function eachState(def: unknown, visit: (name: string, s: Obj) => void, depth = 0) {
  if (!isObj(def) || depth > 20 || !isObj(def.States)) return;
  for (const [name, s] of Object.entries(def.States)) {
    if (!isObj(s)) continue;
    visit(name, s);
    if (Array.isArray(s.Branches)) for (const b of s.Branches) eachState(b, visit, depth + 1);
    eachState(s.Iterator, visit, depth + 1);
    eachState(s.ItemProcessor, visit, depth + 1);
  }
}

export function parseAsl(definition: string | undefined): unknown {
  if (!definition) return undefined;
  try {
    return JSON.parse(definition);
  } catch {
    return undefined;
  }
}

// What a state machine calls, deduplicated by (target, kind), with the states that make each call.
export function aslRefs(definition: string | undefined, machineArn: string): AslRef[] {
  const a = parseArn(machineArn);
  const c: Ctx = { region: a?.region ?? "", account: a?.account ?? "", partition: a?.partition ?? "aws" };
  const out = new Map<string, AslRef>();
  eachState(parseAsl(definition), (name, s) => {
    if (s.Type !== "Task") return;
    const r = taskRef(s, c);
    if (!r) return;
    const id = `${r.to}|${r.kind}`;
    const prev = out.get(id);
    if (prev) prev.states.push(name);
    else out.set(id, { ...r, states: [name] });
  });
  return [...out.values()];
}

// The states table for the detail panel.
export function aslStates(definition: string | undefined, machineArn: string): AslState[] {
  const a = parseArn(machineArn);
  const c: Ctx = { region: a?.region ?? "", account: a?.account ?? "", partition: a?.partition ?? "aws" };
  const out: AslState[] = [];
  eachState(parseAsl(definition), (name, s) => {
    const type = typeof s.Type === "string" ? s.Type : "?";
    const resource = typeof s.Resource === "string" ? s.Resource : undefined;
    out.push({ name, type, resource, target: type === "Task" ? taskRef(s, c)?.to : undefined });
  });
  return out;
}

// ---------- raw → resources ----------

// Structural subset of DescribeStateMachine (+ tags, and the simulation's last activity).
export interface RawStateMachine {
  stateMachineArn?: string;
  name?: string;
  type?: string; // ListStateMachines has it too
  status?: string; // DescribeStateMachine only
  definition?: string;
  roleArn?: string;
  description?: string;
  creationDate?: Date;
  loggingConfiguration?: { level?: string; destinations?: { cloudWatchLogsLogGroup?: { logGroupArn?: string } }[] };
  tracingConfiguration?: { enabled?: boolean };
  encryptionConfiguration?: { type?: string; kmsKeyId?: string };
  tags?: Record<string, string>; // undefined = not read (tagsUnread)
  enrichment?: Record<string, EnrichState>; // definition (DescribeStateMachine), tags
  lastActivityAt?: number;
}

const refLabel = (r: AslRef) => {
  const verb = r.service === "lambda" ? "invoke" : r.service === "sns" ? "publish" : r.service === "sqs" ? "send message" : r.service === "ecs" ? "run task" : r.service === "states" ? "start execution" : r.kind === "reads" ? "read" : "write";
  return clip(`${verb} (${r.states.join(", ")})`, 80);
};

export function sfnConsoleUrl(arn: string, region: string) {
  return `https://${region}.console.aws.amazon.com/states/home?region=${region}#/statemachines/view/${encodeURIComponent(arn)}`;
}

// Health from what DescribeStateMachine reports (status, and a definition that parses); unknown when it wasn't read.
function machineHealth(m: RawStateMachine): { health: Health; reason?: string } {
  if (m.status === "DELETING") return { health: "warning", reason: "being deleted" };
  if (m.definition !== undefined && parseAsl(m.definition) === undefined) return { health: "warning", reason: "definition couldn't be parsed" };
  if (m.definition === undefined && !m.status) return { health: "unknown", reason: unread("definition", m.enrichment?.definition) };
  return { health: "ok" };
}

export function sfnResult(machines: RawStateMachine[]): ProviderResult {
  const resources: Resource[] = [];
  const links: Link[] = [];
  for (const m of machines) {
    const key = m.stateMachineArn;
    if (!key) continue;
    const arn = parseArn(key);
    const region = arn?.region ?? "";
    const refs = aslRefs(m.definition, key);
    const states = aslStates(m.definition, key);
    const { health, reason } = machineHealth(m);
    const read = m.definition !== undefined || !!m.status;
    const enrichment = enrichmentOf(m.enrichment);
    resources.push({
      key,
      kind: "stepfunctions",
      provider: "stepfunctions",
      name: m.name ?? arnName(key),
      region,
      ...tagsOf(m.tags),
      health,
      healthReason: reason,
      ...(enrichment ? { enrichment } : {}),
      props: props([
        { label: "Type", value: m.type ?? "STANDARD" },
        { label: "States", value: read ? String(states.length) : unread("", m.enrichment?.definition).trim() },
        { label: "Calls", value: refs.length ? refs.map((r) => `${r.service} ${arnName(r.to) || r.to}`).join(", ") : undefined },
        { label: "Logging", value: !read ? undefined : m.loggingConfiguration?.level && m.loggingConfiguration.level !== "OFF" ? m.loggingConfiguration.level : "off" },
        { label: "Tracing", value: m.tracingConfiguration?.enabled ? "X-Ray" : undefined },
        { label: "Encryption", value: m.encryptionConfiguration?.type === "CUSTOMER_MANAGED_KMS_KEY" && m.encryptionConfiguration.kmsKeyId ? `KMS ${arnName(m.encryptionConfiguration.kmsKeyId) || m.encryptionConfiguration.kmsKeyId}` : undefined },
        { label: "Role", value: m.roleArn ? arnName(m.roleArn) : undefined, mono: true },
        { label: "Status", value: m.status && m.status !== "ACTIVE" ? m.status : undefined },
        { label: "Created", value: m.creationDate ? fmtTime(m.creationDate.getTime()) : undefined },
      ]),
      aliases: [m.name ?? arnName(key)],
      lastActivityAt: m.lastActivityAt,
      consoleUrl: sfnConsoleUrl(key, region),
      createdAt: m.creationDate?.getTime(),
    });
    for (const r of refs) links.push({ from: key, to: r.to, kind: r.kind, label: refLabel(r), evidence: `state machine definition: ${r.states.map((s) => `"${s}"`).join(", ")} (${r.service})` });
    links.push(...machineSupport(key, m, region, arn?.account));
  }
  return { resources, links, mentions: [] };
}

// A.3: the execution role, the log groups it writes to (logging level other than OFF) and its customer-managed key.
export function machineSupport(key: string, m: RawStateMachine, region: string, account: string | undefined): Link[] {
  const logging = m.loggingConfiguration?.level && m.loggingConfiguration.level !== "OFF";
  const groups = logging ? (m.loggingConfiguration?.destinations ?? []).map((d) => d.cloudWatchLogsLogGroup?.logGroupArn).filter((x): x is string => !!x) : [];
  const kms = m.encryptionConfiguration?.type === "CUSTOMER_MANAGED_KMS_KEY" ? kmsKeyRef(m.encryptionConfiguration.kmsKeyId, region, account) : undefined;
  return [
    ...assumesLink(key, m.roleArn, "execution role", "state machine configuration (roleArn)"),
    ...groups.flatMap((g) => logsLink(key, g, `execution logs (${m.loggingConfiguration!.level})`, "state machine logging configuration (destinations)")),
    ...encryptsLink(kms, key, "definition and execution data", "state machine encryption configuration (kmsKeyId)"),
  ];
}

// ---------- start-execution: the default execution name (F31) ----------

// 32-bit FNV-1a, twice with different seeds: a short, stable id from text (no node:crypto in a module the UI may load).
function fnv(s: string, seed: number): string {
  let h = seed >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

export const NAME_WINDOW_MS = 15 * 60_000;

// The name an execution gets when the caller gives none: "console-<UTC quarter-hour>-<hash of machine, input and
// actor>". The plan shows it and the run uses the same one, so a retry of the same request (the SDK's, or a person's
// after "outcome unknown") within the quarter-hour can't start a second STANDARD execution: Step Functions answers a
// running one with the same execution, and a finished one with ExecutionAlreadyExists. A name of up to 80 characters
// from [A-Za-z0-9_-], as StartExecution allows.
export function defaultExecutionName(machineArn: string, input: string, actor: string, now: number): string {
  const window = Math.floor(now / NAME_WINDOW_MS) * NAME_WINDOW_MS;
  const stamp = new Date(window).toISOString().slice(0, 16).replace(/[-:T]/g, ""); // 202610051415
  const text = `${machineArn}\n${input}\n${actor}\n${window}`;
  return `console-${stamp}-${fnv(text, 0x811c9dc5)}${fnv(text, 0x01234567)}`;
}
