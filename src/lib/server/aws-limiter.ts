// Concurrency at the SDK-call boundary (R19). Every AWS SDK client the server builds goes through limitedClient(), which
// wraps its send(): a call takes its service@region slot, then one of the console's global slots, and only then goes to
// AWS. Discovery, the inventory, the sampler and actions all share these slots, so a large account can't fan out
// unbounded calls under one outer slot, and a busy service can't starve a quiet one (src/lib/limiter.ts).
// withCallSignal() carries a caller's cancellation (a provider's deadline) into every wrapped send() made inside it —
// including calls nested in Cloud methods — so a cancelled run's queued calls never start and its in-flight ones abort.
// Per service and region it also counts requests, SDK attempts (retries included), throttles and errors, and keeps a
// latency estimate: GET /api/diagnostics/aws.
// Every finished call is also reported to an observer (capability.ts: a refusal or a success of an action the console's
// writes need), and a write aborted after it was sent is flagged so mutate() records it as outcome unknown (F31).
// State (slots, the AsyncLocalStorage, counters, the observer) lives on globalThis: the routes and the instrumentation
// bundle (the sampler) load separate copies of this module and must share one set of slots. No AWS SDK import here.
// Keep this module's imports as they are: adding one (./errors.ts) mid-session left the dev server's routes holding the
// old module ("outsideCallSignal is not a function"), like sources.ts (CODEX gotchas).
import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";
import { keyedLimiter, type KeyedLimiter } from "../limiter.ts";

export const GLOBAL_DEFAULT = 16; // CONSOLE_AWS_CONCURRENCY overrides it
export const PER_SERVICE_DEFAULT = 4;
// Services with low request quotas, or whose calls are expensive, get fewer slots per region.
export const PER_SERVICE: Readonly<Record<string, number>> = {
  logs: 2, cloudformation: 2, iam: 1, route53: 1, cloudcontrol: 2, tag: 2, "resource-explorer-2": 2, servicediscovery: 3, wafv2: 2,
};

// SDK serviceId (client.config.serviceId) → the name limits and diagnostics use: the IAM prefix where it differs.
const SERVICE_IDS: Readonly<Record<string, string>> = {
  "elastic load balancing v2": "elasticloadbalancing", "elastic load balancing": "elasticloadbalancing", "cloudwatch logs": "logs",
  "route 53": "route53", "secrets manager": "secretsmanager", "cost explorer": "ce", sfn: "states", eventbridge: "events",
  "api gateway": "apigateway", apigatewayv2: "apigateway", "elastic beanstalk": "elasticbeanstalk", "auto scaling": "autoscaling",
  "application auto scaling": "application-autoscaling", "resource groups tagging api": "tag", "resource explorer 2": "resource-explorer-2",
  "dynamodb streams": "dynamodb", "cognito identity provider": "cognito-idp", "config service": "config", "global accelerator": "globalaccelerator",
  "bedrock agent": "bedrock", "bedrock runtime": "bedrock", sesv2: "ses", "vpc lattice": "vpc-lattice",
};
export const serviceName = (serviceId: string): string => {
  const id = serviceId.trim().toLowerCase();
  return Object.hasOwn(SERVICE_IDS, id) ? SERVICE_IDS[id] : id.replace(/\s+/g, "-") || "aws";
};

const THROTTLED = /Throttl|TooManyRequests|RequestLimitExceeded|SlowDown|ProvisionedThroughputExceeded|RequestThrottled|PriorRequestNotComplete|BandwidthLimitExceeded/;
const SAMPLES = 200; // latencies kept per service@region for the p95 estimate

interface Counter {
  service: string;
  region: string;
  requests: number;
  attempts: number;
  throttled: number;
  errors: number;
  latencies: number[]; // ring buffer of the last SAMPLES call durations (ms)
  next: number;
}

// Hears every call that reached AWS: its IAM-style action ("ecs:UpdateService") and the error when it failed.
export type CallObserver = (call: { action: string; error?: unknown }) => void;

interface State {
  limiter: KeyedLimiter;
  signal: AsyncLocalStorage<AbortSignal>;
  counters: Map<string, Counter>;
  observer?: CallObserver; // missing on state an older module version created
}

const g = globalThis as { __consoleAwsLimiter?: State };

const globalCap = () => {
  const n = Number(process.env.CONSOLE_AWS_CONCURRENCY);
  return Number.isInteger(n) && n >= 1 && n <= 256 ? n : GLOBAL_DEFAULT;
};
const perKey = (key: string) => {
  const service = key.slice(0, key.lastIndexOf("@"));
  return Object.hasOwn(PER_SERVICE, service) ? PER_SERVICE[service] : PER_SERVICE_DEFAULT;
};
const state = (): State => (g.__consoleAwsLimiter ??= { limiter: keyedLimiter({ global: globalCap(), perKey }), signal: new AsyncLocalStorage(), counters: new Map() });

// ---------- cancellation ----------

// Runs fn with `signal` attached to every wrapped send() it makes (directly or deep inside Cloud methods). Nested calls
// combine: an inner withCallSignal can only add a reason to stop, never lift an outer one.
export function withCallSignal<T>(signal: AbortSignal, fn: () => Promise<T>): Promise<T> {
  const outer = currentCallSignal();
  return state().signal.run(outer && outer !== signal ? AbortSignal.any([outer, signal]) : signal, fn);
}

export const currentCallSignal = (): AbortSignal | undefined => state().signal.getStore();

// Runs fn outside any caller's call signal. Shared work (a cached fetch others join, a background rebuild) must not
// inherit the deadline of whichever caller happened to start it: when that deadline fired, every joiner would fail.
// cache.ts does the same through the AsyncLocalStorage on globalThis (it can't import this server-only module).
export const outsideCallSignal = <T>(fn: () => Promise<T>): Promise<T> => state().signal.exit(fn);

// ---------- what calls teach ----------

// capability.ts registers itself here: it imports sources.ts, which loads aws.ts, which imports this module, so a static
// import the other way would be a cycle. One observer per process (the last registration wins); it must never throw.
export function observeCalls(fn: CallObserver | undefined): void {
  state().observer = fn;
}

// The operation a command runs: SDK v3 commands carry it in their schema ([kind, namespace, "UpdateService", …]), which
// survives minification; the class name ("UpdateServiceCommand") is the fallback.
export function operationOf(command: unknown): string {
  if (!command || typeof command !== "object") return "";
  const schema = (command as { schema?: unknown }).schema;
  if (Array.isArray(schema) && typeof schema[2] === "string") return schema[2];
  const name = command.constructor?.name ?? "";
  return name.endsWith("Command") ? name.slice(0, -"Command".length) : name === "Object" ? "" : name;
}

// Operations that only read. Anything else is treated as a write: when it is aborted after it was sent, AWS may have
// acted on it.
const READ_OP = /^(Describe|List|Get|Head|Search|Lookup|Filter|Simulate|Query|Scan|Select|Validate|Estimate|Preview|BatchGet|Detect|Poll)/;
export const isReadOperation = (op: string): boolean => READ_OP.test(op);

function observe(action: string, error?: unknown) {
  const fn = state().observer;
  if (!fn) return;
  try {
    fn(error === undefined ? { action } : { action, error });
  } catch {
    // an observer's failure never changes the call's outcome
  }
}

// ---------- the wrapper ----------

const WRAPPED = Symbol.for("deployment-console.limitedClient");
type SendOptions = { abortSignal?: AbortSignal } & Record<string, unknown>;
type Meta = { $metadata?: { attempts?: number; httpStatusCode?: number } };

function counter(service: string, region: string): Counter {
  const key = `${service}@${region}`;
  const counters = state().counters;
  let c = counters.get(key);
  if (!c) counters.set(key, (c = { service, region, requests: 0, attempts: 0, throttled: 0, errors: 0, latencies: [], next: 0 }));
  return c;
}

function sample(c: Counter, ms: number) {
  if (c.latencies.length < SAMPLES) c.latencies.push(ms);
  else c.latencies[c.next] = ms;
  c.next = (c.next + 1) % SAMPLES;
}

const throttled = (e: unknown) => {
  const err = e as { name?: string; Code?: string; $retryable?: { throttling?: boolean } } & Meta;
  return !!err?.$retryable?.throttling || err?.$metadata?.httpStatusCode === 429 || THROTTLED.test(err?.name ?? err?.Code ?? "");
};

async function regionOf(config: { region?: unknown } | undefined): Promise<string> {
  try {
    const r = config?.region;
    const v = typeof r === "function" ? await (r as () => unknown)() : r;
    return typeof v === "string" && v ? v : "unknown";
  } catch {
    return "unknown";
  }
}

// Anything with an AWS SDK v3 style send(command, options?) → Promise.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type SdkClient = { send: (...a: any[]) => Promise<any> };

// Wraps client.send in place and returns the same client. `service` defaults to the client's serviceId (mapped to the
// IAM prefix), `region` to its configured region. Wrapping an already wrapped client changes nothing.
export function limitedClient<C extends SdkClient>(client: C, service?: string, region?: string): C {
  const c = client as C & { [WRAPPED]?: true; config?: { serviceId?: unknown; region?: unknown } };
  if (c[WRAPPED]) return client;
  const svc = service || serviceName(typeof c.config?.serviceId === "string" ? c.config.serviceId : "aws");
  let where: Promise<string> | undefined = region ? Promise.resolve(region) : undefined;
  const send = c.send.bind(c) as (command: unknown, options?: unknown, cb?: unknown) => Promise<unknown>;
  const limited = async (command: unknown, options?: unknown, cb?: unknown): Promise<unknown> => {
    if (typeof options === "function" || typeof cb === "function") return send(command, options, cb); // callback style: unused here
    const opts = (options ?? undefined) as SendOptions | undefined;
    const signals = [opts?.abortSignal, currentCallSignal()].filter((s): s is AbortSignal => !!s);
    const abortSignal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
    const r = await (where ??= regionOf(c.config));
    return state().limiter.run(`${svc}@${r}`, async () => {
      const k = counter(svc, r);
      k.requests++;
      const op = operationOf(command);
      const t0 = performance.now();
      try {
        const out = (await send(command, abortSignal ? { ...opts, abortSignal } : opts)) as Meta;
        k.attempts += out?.$metadata?.attempts ?? 1;
        if (op) observe(`${svc}:${op}`);
        return out;
      } catch (caught) {
        let e = caught;
        k.attempts += (e as Meta)?.$metadata?.attempts ?? 1;
        k.errors++;
        if (throttled(e)) k.throttled++;
        // The request had been handed to the SDK: a write cut short by a deadline or an abort may have taken effect.
        // A handler that rejects with the signal's own reason shares that object with every call the signal stopped
        // before it started, so the flag goes on a copy.
        const name = (e as { name?: unknown })?.name;
        if ((name === "AbortError" || name === "TimeoutError") && !isReadOperation(op)) {
          if (abortSignal && e === abortSignal.reason) e = Object.assign(new Error(String((e as { message?: unknown }).message ?? name)), { name, cause: caught });
          (e as { afterSend?: boolean }).afterSend = true; // errors.ts flagAfterSend, inlined (see the note on imports at the top)
        }
        if (op) observe(`${svc}:${op}`, e);
        throw e;
      } finally {
        sample(k, performance.now() - t0);
      }
    }, abortSignal);
  };
  Object.defineProperty(c, "send", { value: limited, configurable: true, writable: true });
  Object.defineProperty(c, WRAPPED, { value: true });
  return client;
}

// ---------- diagnostics ----------

export interface AwsCallStat {
  service: string;
  region: string;
  requests: number;
  attempts: number;
  throttled: number;
  errors: number;
  p95Ms: number;
  active: number;
  queued: number;
}

const p95 = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.ceil(0.95 * s.length) - 1)]);
};

export function awsCallStats(): AwsCallStat[] {
  const s = state();
  const live = s.limiter.stats();
  const out = new Map<string, AwsCallStat>();
  for (const [key, c] of s.counters) {
    out.set(key, { service: c.service, region: c.region, requests: c.requests, attempts: c.attempts, throttled: c.throttled, errors: c.errors, p95Ms: p95(c.latencies), active: 0, queued: 0 });
  }
  for (const [key, l] of Object.entries(live)) {
    const at = key.lastIndexOf("@");
    const row = out.get(key) ?? { service: key.slice(0, at), region: key.slice(at + 1), requests: 0, attempts: 0, throttled: 0, errors: 0, p95Ms: 0, active: 0, queued: 0 };
    out.set(key, { ...row, active: l.active, queued: l.queued });
  }
  return [...out.values()].sort((a, b) => a.service.localeCompare(b.service) || a.region.localeCompare(b.region));
}
