// Create & scale: every rule that doesn't touch AWS — input parsing, guards, confirmations and the plan text — so the
// API, the agent operations and the UI's buttons use the same functions (one guard, many callers) and node:test can
// run them.
//
// Safety boundaries enforced here (the server adds discovery, roles, locks and the audit log around them):
// - Everything is validated before any AWS call: names, counts, Fargate sizes, image URIs, commands, instance types.
// - Counts are capped (`provisioning.maxTasks`, `provisioning.maxHosts`); start/stop stay in the regular actions.
// - The console deletes only what it created (tag console:created=true) and never touches its own service.
// - Protected environments need a typed confirmation and a reason; deletes need both everywhere.
// - A service is never copied out of a protected environment into an unprotected one (its variables and secret
//   references would become readable by more people).
import { CONSOLE_WRITES } from "./capability-rules.ts";
import { DEFAULT_RATES, HOURS_PER_MONTH, ec2Hourly, fargateHourly, monthly, usd, type Rates } from "./costs.ts";
import type { CapState } from "./types.ts";

export const CREATED_TAG = "console:created";
export const CREATED_FROM_TAG = "console:created-from";
export const isConsoleCreated = (tags: Record<string, string> | undefined) => tags?.[CREATED_TAG] === "true";

export type ProvisionAction = "clone" | "scale" | "run-task" | "add-host" | "delete-service" | "terminate-host";
export type Check = { ok: true } | { ok: false; status: number; error: string };
type Parsed<T> = { ok: true; value: T } | { ok: false; status: 400; error: string };
const fail = (status: number, error: string): Check => ({ ok: false, status, error });
const OK: Check = { ok: true };

// ---------- limits (console.config.json → provisioning) ----------

export interface ProvisionLimits {
  enabled: boolean; // false: no create / scale / run / add; deleting what the console created stays possible
  maxTasks: number; // most tasks a service may be created or scaled to
  maxHosts: number; // most console-created EC2 hosts per environment
  allowedInstanceTypes?: string[]; // when set, new hosts must use one of these
  allowedImageRegistries?: string[]; // when set, image overrides must come from one of these (registry host or host/path prefix)
}
export const DEFAULT_LIMITS: ProvisionLimits = { enabled: true, maxTasks: 10, maxHosts: 3 };
export const limitsOf = (c?: Partial<ProvisionLimits>): ProvisionLimits => ({
  enabled: c?.enabled ?? DEFAULT_LIMITS.enabled,
  maxTasks: c?.maxTasks ?? DEFAULT_LIMITS.maxTasks,
  maxHosts: c?.maxHosts ?? DEFAULT_LIMITS.maxHosts,
  ...(c?.allowedInstanceTypes?.length ? { allowedInstanceTypes: c.allowedInstanceTypes } : {}),
  ...(c?.allowedImageRegistries?.length ? { allowedImageRegistries: c.allowedImageRegistries } : {}),
});

// ---------- names, sizes, images, commands ----------

// ECS service names and task-definition families: up to 255 letters, digits, "_" and "-". New names must also start
// with a letter or digit (they double as the family name and appear in URLs and log stream prefixes).
export const NEW_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,254}$/;
const SERVICE = /^[A-Za-z0-9_-]{1,255}$/;
const ENV = /^[a-z0-9][a-z0-9-]{0,62}$/;
const INSTANCE_ID = /^i-[0-9a-f]{8,17}$/;
const INSTANCE_TYPE = /^[a-z][a-z0-9-]*\.[a-z0-9]+$/;
// [registry[:port]/]repo[/path]:tag, …@sha256:digest or both. An explicit tag or digest is required: "latest" by
// omission makes the plan lie about what will run.
const IMAGE = /^(?:[A-Za-z0-9.-]+(?::\d{1,5})?\/)?[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*(?:\/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*)*(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}(?:@sha256:[a-f0-9]{64})?|@sha256:[a-f0-9]{64})$/;

export function newNameProblem(name: string, taken: string[]): string | undefined {
  if (!NEW_NAME.test(name)) return `"${name}" isn't a valid service name (letters, digits, "_" and "-", starting with a letter or digit, up to 255)`;
  if (taken.includes(name)) return `a service named "${name}" already exists in this cluster`;
  return undefined;
}

// `allowed`: registries an override may pull from — a registry host ("123456789012.dkr.ecr.us-east-1.amazonaws.com")
// or a host/path prefix ("ghcr.io/acme"), matched on whole path segments. Unset = any registry (supply-chain risk:
// the copy runs that image with the source service's roles and secrets).
export function imageProblem(image: string, allowed?: string[]): string | undefined {
  if (image.length > 255 || !IMAGE.test(image)) return `"${image.slice(0, 80)}" isn't a full image URI with a tag or digest (e.g. 123456789012.dkr.ecr.us-east-1.amazonaws.com/api:1.4.2)`;
  if (allowed?.length && !allowed.some((p) => image.startsWith(`${p.replace(/\/+$/, "")}/`)))
    return `images must come from ${allowed.join(" or ")} here (provisioning.allowedImageRegistries)`;
  return undefined;
}

// Valid Fargate task sizes: cpu units → memory MiB (Linux). The 8 and 16 vCPU sizes need platform version 1.4.0+.
const range = (from: number, to: number, step: number) => Array.from({ length: (to - from) / step + 1 }, (_, i) => from + i * step);
const FARGATE: Record<number, number[]> = {
  256: [512, 1024, 2048],
  512: range(1024, 4096, 1024),
  1024: range(2048, 8192, 1024),
  2048: range(4096, 16384, 1024),
  4096: range(8192, 30720, 1024),
  8192: range(16384, 61440, 4096),
  16384: range(32768, 122880, 8192),
};
export const FARGATE_CPU = Object.keys(FARGATE).map(Number);
export const fargateMemoryFor = (cpu: number) => FARGATE[cpu] ?? [];

export function fargateSizeProblem(cpu: number, memory: number): string | undefined {
  const mems = FARGATE[cpu];
  if (!mems) return `${cpu} isn't a Fargate CPU size (${FARGATE_CPU.join(", ")})`;
  if (!mems.includes(memory)) return `${cpu} CPU units allow ${mems[0]}–${mems[mems.length - 1]} MiB memory in steps of ${mems.length > 1 ? mems[1] - mems[0] : mems[0]} MiB, not ${memory}`;
  return undefined;
}

export function instanceTypeProblem(type: string, allowed?: string[]): string | undefined {
  if (!INSTANCE_TYPE.test(type)) return `"${type}" isn't an EC2 instance type (e.g. t3a.medium)`;
  if (allowed?.length && !allowed.includes(type)) return `instance type ${type} isn't allowed here (provisioning.allowedInstanceTypes: ${allowed.join(", ")})`;
  return undefined;
}

// A command override in exec form. The UI turns one line into arguments with splitCommand (shell-like quoting, no
// expansion); ECS receives the array as-is — nothing is run through a shell unless the command itself starts one.
export const MAX_ARGS = 64;
export const MAX_COMMAND = 4_000;

export function splitCommand(line: string): { ok: true; args: string[] } | { ok: false; error: string } {
  if (/[\0-\x08\n\r\x0b-\x1f\x7f]/.test(line)) return { ok: false, error: "the command must be one line without control characters" };
  const args: string[] = [];
  let cur = "", has = false, quote: "'" | '"' | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote === "'") {
      if (c === "'") quote = null;
      else cur += c;
    } else if (quote === '"') {
      if (c === '"') quote = null;
      else if (c === "\\" && (line[i + 1] === '"' || line[i + 1] === "\\")) cur += line[++i];
      else cur += c;
    } else if (c === "'" || c === '"') {
      quote = c;
      has = true;
    } else if (c === "\\" && i + 1 < line.length) {
      cur += line[++i];
      has = true;
    } else if (c === " " || c === "\t") {
      if (has || cur) args.push(cur);
      cur = "";
      has = false;
    } else {
      cur += c;
      has = true;
    }
  }
  if (quote) return { ok: false, error: `unclosed ${quote === '"' ? "double" : "single"} quote` };
  if (has || cur) args.push(cur);
  return { ok: true, args };
}

export function commandProblem(args: string[]): string | undefined {
  if (!args.length || !args[0]) return "the command is empty";
  if (args.length > MAX_ARGS) return `the command has more than ${MAX_ARGS} arguments`;
  if (args.join(" ").length > MAX_COMMAND) return `the command is longer than ${MAX_COMMAND} characters`;
  if (args.some((a) => /[\0-\x08\n\r\x0b-\x1f\x7f]/.test(a))) return "the command can't contain control characters";
  return undefined;
}

// ---------- input parsing (strict: unknown keys are rejected, not ignored) ----------

export interface Confirmable {
  confirm?: string;
  reason?: string;
}
export interface CloneInput extends Confirmable {
  env: string; // create the service here
  sourceEnv: string;
  source: string; // ECS service to copy
  name: string;
  image?: string;
  desired: number;
  cpu?: number;
  memory?: number;
}
export interface ScaleInput extends Confirmable {
  env: string;
  service: string;
  desired: number;
}
export interface RunTaskInput extends Confirmable {
  env: string;
  service: string;
  container?: string;
  command?: string[];
}
export interface AddHostInput extends Confirmable {
  env: string;
  from: string; // instance id of an existing container instance
  count: number;
  instanceType?: string;
}
export interface DeleteServiceInput extends Confirmable {
  env: string;
  service: string;
}
export interface TerminateHostInput extends Confirmable {
  env: string;
  id: string;
}

type Field = { type: "string" | "int" | "strings"; re?: RegExp; required?: boolean; max?: number; what?: string };
// dryRun is read by the route (any value but false/0 means plan only) and never reaches the server functions.
const COMMON: Record<string, Field> = { confirm: { type: "string", max: 300 }, reason: { type: "string", max: 500 }, dryRun: { type: "string" } };

function parse<T>(body: unknown, fields: Record<string, Field>): Parsed<T> {
  const bad = (error: string): Parsed<T> => ({ ok: false, status: 400, error });
  if (!body || typeof body !== "object" || Array.isArray(body)) return bad("body must be an object");
  const b = body as Record<string, unknown>;
  const all = { ...fields, ...COMMON };
  const extra = Object.keys(b).filter((k) => !Object.hasOwn(all, k)); // not `in`: that accepts "constructor", "__proto__"
  if (extra.length) return bad(`unknown field(s): ${extra.join(", ")}`);
  const out: Record<string, unknown> = {};
  for (const [k, f] of Object.entries(all)) {
    const v = b[k];
    if (k === "dryRun") continue; // read by the route; never reaches the server functions
    if (v === undefined || v === null || v === "") {
      if (f.required) return bad(`${k} is required`);
      continue;
    }
    if (f.type === "int") {
      if (typeof v !== "number" || !Number.isInteger(v)) return bad(`${k} must be a whole number`);
      out[k] = v;
    } else if (f.type === "strings") {
      if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) return bad(`${k} must be a list of strings`);
      out[k] = v;
    } else {
      if (typeof v !== "string") return bad(`${k} must be a string`);
      if (f.max && v.length > f.max) return bad(`${k} must be at most ${f.max} characters`);
      if (f.re && !f.re.test(v)) return bad(`${k} must be ${f.what ?? "valid"}`);
      out[k] = k === "reason" ? v.trim() || undefined : v;
    }
  }
  return { ok: true, value: out as T };
}

const env = (what = "an environment id"): Field => ({ type: "string", re: ENV, required: true, what });
const service: Field = { type: "string", re: SERVICE, required: true, what: "an ECS service name" };

export const parseClone = (b: unknown) =>
  parse<CloneInput>(b, {
    env: env("the id of the environment to create the service in"), sourceEnv: env("the id of the source service's environment"), source: service,
    name: { type: "string", required: true, max: 255 }, image: { type: "string", max: 255 }, desired: { type: "int", required: true }, cpu: { type: "int" }, memory: { type: "int" },
  });
export const parseScale = (b: unknown) => parse<ScaleInput>(b, { env: env(), service, desired: { type: "int", required: true } });
export const parseRunTask = (b: unknown) =>
  parse<RunTaskInput>(b, { env: env(), service, container: { type: "string", re: SERVICE, what: "a container name" }, command: { type: "strings" } });
export const parseAddHost = (b: unknown) =>
  parse<AddHostInput>(b, { env: env(), from: { type: "string", re: INSTANCE_ID, required: true, what: "an EC2 instance id" }, count: { type: "int", required: true }, instanceType: { type: "string", max: 40 } });
export const parseDeleteService = (b: unknown) => parse<DeleteServiceInput>(b, { env: env(), service });
export const parseTerminateHost = (b: unknown) => parse<TerminateHostInput>(b, { env: env(), id: { type: "string", re: INSTANCE_ID, required: true, what: "an EC2 instance id" } });

// ---------- confirmations ----------

export const DANGER: ProvisionAction[] = ["delete-service", "terminate-host"];
export interface ConfirmNeed {
  expected: string; // "yes" = one click
  needReason: boolean;
}

// What proves intent. Deletes: the resource's name and a reason, always. Protected envs: the subject (new or existing
// service name; the env id for new hosts) and a reason. Anything else: one click.
export function confirmFor(action: ProvisionAction, protectedEnv: boolean, subject: string): ConfirmNeed {
  if (DANGER.includes(action)) return { expected: subject, needReason: true };
  if (protectedEnv) return { expected: subject, needReason: true };
  return { expected: "yes", needReason: false };
}

export function checkConfirm(need: ConfirmNeed, input: Confirmable): Check {
  if (need.needReason && (!input.reason || input.reason.trim().length < 3)) return fail(400, "a reason is required (at least 3 characters; it goes to the audit log)");
  if (input.confirm !== need.expected) return fail(400, `confirmation text does not match (expected "${need.expected}")`);
  return OK;
}

// ---------- guards (the UI draws buttons with the same functions) ----------

export interface ServiceFacts {
  desired: number;
  inProgress: boolean;
  isSelf: boolean;
  created: boolean; // tag console:created=true
  hasTaskDef: boolean;
}

const disabled = (l: ProvisionLimits): Check => (l.enabled ? OK : fail(403, "provisioning is turned off for this console (console.config.json → provisioning.enabled)"));

export function scaleCheck(s: ServiceFacts, limits: ProvisionLimits, desired?: number): Check {
  if (s.isSelf) return fail(403, "the console never changes its own service");
  const off = disabled(limits);
  if (!off.ok) return off;
  // Bad input first (400), then the service's state (409): a wrong number is wrong whatever the service is doing.
  if (desired !== undefined && (!Number.isInteger(desired) || desired < 1 || desired > limits.maxTasks)) return fail(400, `desired count must be 1–${limits.maxTasks} (stop the service to go to 0)`);
  if (s.desired === 0) return fail(409, "the service is stopped — use Start (it brings back its previous task count), then scale");
  if (s.inProgress) return fail(409, "a rollout is in progress — wait for it to finish");
  if (desired === undefined) return OK;
  if (desired === s.desired) return fail(409, `already running with ${desired} task${desired === 1 ? "" : "s"}`);
  return OK;
}

export function runTaskCheck(s: ServiceFacts, limits: ProvisionLimits): Check {
  if (s.isSelf) return fail(403, "the console never runs tasks from its own task definition (they would carry its role)");
  const off = disabled(limits);
  if (!off.ok) return off;
  if (!s.hasTaskDef) return fail(409, "the service has no task definition yet");
  return OK;
}

export function deleteServiceCheck(s: ServiceFacts): Check {
  if (s.isSelf) return fail(403, "the console never deletes its own service");
  if (!s.created) return fail(403, "only services the console created (tag console:created=true) can be deleted here");
  return OK;
}

export interface CloneSourceFacts {
  isSelf: boolean;
  hasTaskDef: boolean;
  sourceProtected: boolean;
  targetProtected: boolean;
  launchType: string; // EC2 | FARGATE | EXTERNAL | UNKNOWN
}

export function cloneCheck(s: CloneSourceFacts, limits: ProvisionLimits): Check {
  const off = disabled(limits);
  if (!off.ok) return off;
  if (s.isSelf) return fail(403, "the console never copies its own service (the copy would carry the console's role)");
  if (!s.hasTaskDef) return fail(409, "the source service has no task definition to copy");
  if (s.sourceProtected && !s.targetProtected) return fail(403, "a service from a protected environment can't be copied into an unprotected one — its variables and secret references would become readable by more people");
  if (s.launchType === "EXTERNAL") return fail(409, "services on external (ECS Anywhere) capacity can't be copied");
  return OK;
}

export interface HostFacts {
  state: string; // EC2 instance state
  asg?: string;
  created: boolean;
}

const GONE = new Set(["shutting-down", "terminated"]);

// `existingCreated`: every console-created host that counts toward the cap — in the cluster, launched and still joining
// it, or reserved by a launch in flight (countHosts below); `detail` says how that number breaks down.
export function addHostCheck(h: HostFacts, limits: ProvisionLimits, existingCreated: number, count?: number, detail?: string): Check {
  const off = disabled(limits);
  if (!off.ok) return off;
  if (h.asg) return fail(409, `this host belongs to Auto Scaling group ${h.asg} — scale the Auto Scaling group ${h.asg} instead`);
  if (GONE.has(h.state)) return fail(409, `this host is ${h.state}`);
  const why = detail ? ` (${detail})` : "";
  if (existingCreated >= limits.maxHosts) return fail(409, `this environment already has ${existingCreated} console-created host${existingCreated === 1 ? "" : "s"}${why} (limit ${limits.maxHosts}) — terminate one first`);
  if (count === undefined) return OK;
  const room = limits.maxHosts - existingCreated;
  if (!Number.isInteger(count) || count < 1 || count > room) return fail(400, `count must be 1–${room} (at most ${limits.maxHosts} console-created hosts per environment, ${existingCreated} exist${why})`);
  return OK;
}

// ---------- the host cap while hosts boot (R23) ----------
// A launched instance needs a minute or more before its ECS agent registers it with the cluster. Until then the
// container-instance list doesn't show it, so the cap also counts EC2 instances tagged for the cluster
// (console:cluster=<cluster>) and launches reserved in the console DB (host_reservations) before RunInstances is
// called. One instance counts once, whichever lists name it.

export type ReservationState = "pending" | "registered" | "failed" | "released";
export interface HostReservation {
  id: string;
  operationId?: string;
  count: number;
  instanceIds: string[]; // empty until RunInstances answered (or when its outcome is unknown)
  state: ReservationState;
  createdAt: number;
  expiresAt: number; // createdAt + JOIN_TIMEOUT_MS: the instances must have joined the cluster by then
}

export const JOIN_TIMEOUT_MS = 15 * 60_000;
// EC2 is eventually consistent: a new instance can be missing from DescribeInstances for a little while.
export const LAUNCH_GRACE_MS = 2 * 60_000;

export interface HostCount {
  total: number; // what the cap compares against
  registered: number; // console-created container instances of the cluster
  joining: number; // launched for the cluster (tagged), not registered yet
  reserved: number; // launches in flight whose instances neither list shows yet
}

// registered: the cluster's container instances (tags from EC2); tagged: cloud.taggedHosts(cluster) (pending or
// running); reservations: the env's rows. A pending reservation counts until it expires; after that its instances, if
// they exist, are still counted through their tags.
export function countHosts(o: { registered: { id: string; state: string; tags: Record<string, string> }[]; tagged: { id: string; state: string }[]; reservations: HostReservation[]; now: number }): HostCount {
  const reg = new Set(o.registered.filter((h) => isConsoleCreated(h.tags) && !GONE.has(h.state)).map((h) => h.id));
  const joining = new Set(o.tagged.filter((h) => !GONE.has(h.state) && !reg.has(h.id)).map((h) => h.id));
  let reserved = 0;
  const seen = new Set<string>();
  for (const r of o.reservations) {
    if (r.state !== "pending" || o.now >= r.expiresAt) continue;
    if (!r.instanceIds.length) {
      reserved += Math.max(0, r.count);
      continue;
    }
    for (const id of r.instanceIds) if (!reg.has(id) && !joining.has(id) && !seen.has(id)) seen.add(id);
  }
  reserved += seen.size;
  return { total: reg.size + joining.size + reserved, registered: reg.size, joining: joining.size, reserved };
}

// "2 in the cluster, 1 launched and not joined yet" — undefined when every counted host is in the cluster.
export function hostCountDetail(c: HostCount): string | undefined {
  if (!c.joining && !c.reserved) return undefined;
  return [
    c.registered ? `${c.registered} in the cluster` : "",
    c.joining ? `${c.joining} launched and not joined yet` : "",
    c.reserved ? `${c.reserved} reserved by a recent launch` : "",
  ].filter(Boolean).join(", ");
}

export type ReservationVerdict =
  | { state: "pending" }
  | { state: "registered" }
  | { state: "released"; detail: string }
  | { state: "failed"; instanceIds: string[]; detail?: string }; // detail unset: the standard "never joined" issue per id

// What becomes of a pending reservation, from what the cluster and EC2 say now. `operation` is the launch's operation
// state when known (failed or cancelled: nothing was launched).
export function reservationVerdict(
  r: HostReservation,
  seen: { registered: Set<string>; tagged: Set<string> },
  now: number,
  cluster: string,
  operation?: string,
): ReservationVerdict {
  if (r.state !== "pending") return { state: "pending" };
  if (!r.instanceIds.length) {
    if (operation === "failed" || operation === "cancelled") return { state: "released", detail: "the launch was refused — nothing was started" };
    if (operation === "succeeded") return { state: "released", detail: "launched, but the instance ids weren't recorded — the hosts are counted through their tags" };
    if (now < r.expiresAt) return { state: "pending" };
    return {
      state: "failed",
      instanceIds: [],
      detail: `a launch of ${r.count} host${r.count === 1 ? "" : "s"} for ${cluster} has an unknown outcome${r.operationId ? ` (operation ${r.operationId})` : ""} — look for EC2 instances tagged console:cluster=${cluster}`,
    };
  }
  const waiting = r.instanceIds.filter((id) => !seen.registered.has(id) && seen.tagged.has(id));
  if (waiting.length) return now >= r.expiresAt ? { state: "failed", instanceIds: waiting } : { state: "pending" };
  // Neither list has these: not visible yet (EC2's eventual consistency), or they ended before joining. A host the
  // console terminated after it joined was dropped from the reservation, so it never lands here.
  const missing = r.instanceIds.filter((id) => !seen.registered.has(id));
  if (!missing.length) return { state: "registered" };
  if (now - r.createdAt < LAUNCH_GRACE_MS) return { state: "pending" };
  return { state: "failed", instanceIds: missing, detail: `host${missing.length === 1 ? "" : "s"} ${missing.join(", ")} ended before joining ${cluster}` };
}

export function terminateHostCheck(h: HostFacts): Check {
  if (!h.created) return fail(403, "only EC2 hosts the console created (tag console:created=true) can be terminated here");
  if (GONE.has(h.state)) return fail(409, `this host is already ${h.state}`);
  return OK;
}

// ---------- networking and capacity for a copy ----------

export interface Donor {
  service: string;
  subnets: string[];
  launchType: string;
  isSelf: boolean;
}
export type NetworkChoice =
  | { ok: true; mode: "host"; why: string }
  | { ok: true; mode: "awsvpc"; from: string; sameAsSource: boolean; why: string }
  | { ok: false; error: string };

// awsvpc services need subnets and security groups. Same env: the source's. Another env: those of a service already
// running there — preferably one with the source's name, then one with the same launch type. Never the console's own
// service: its security groups usually reach more than an app should.
export function pickNetwork(source: { service: string; networkMode?: string; launchType: string; sameEnv: boolean }, targetEnv: string, donors: Donor[]): NetworkChoice {
  if (source.networkMode !== "awsvpc") {
    return { ok: true, mode: "host", why: `${source.networkMode ?? "bridge"} networking — tasks use the EC2 host's network, there are no subnets or security groups to choose` };
  }
  if (source.sameEnv) return { ok: true, mode: "awsvpc", from: source.service, sameAsSource: true, why: `same subnets and security groups as ${source.service}` };
  const ok = donors.filter((d) => d.subnets.length && !d.isSelf).sort((a, b) => a.service.localeCompare(b.service));
  const pick = ok.find((d) => d.service === source.service) ?? ok.find((d) => d.launchType === source.launchType) ?? ok[0];
  if (!pick) return { ok: false, error: `no service in ${targetEnv} uses awsvpc networking to borrow subnets and security groups from — create one there first` };
  const because = pick.service === source.service ? "it has the same name as the source" : pick.launchType === source.launchType ? `it also runs on ${pick.launchType}` : "the first service there with awsvpc networking";
  return { ok: true, mode: "awsvpc", from: pick.service, sameAsSource: false, why: `subnets and security groups of ${targetEnv}/${pick.service} (${because})` };
}

// Can the target cluster run what the source runs on? (Only asked for a copy into another environment.)
export function capacityProblem(spec: { launchType?: string; capacityProviders: string[] }, target: { env: string; capacityProviders: string[]; containerInstances: number }): string | undefined {
  const missing = spec.capacityProviders.filter((p) => !target.capacityProviders.includes(p));
  if (missing.length) return `capacity provider${missing.length > 1 ? "s" : ""} ${missing.join(", ")} ${missing.length > 1 ? "aren't" : "isn't"} available in ${target.env}'s cluster`;
  if (spec.launchType === "EC2" && target.containerInstances === 0) return `${target.env} has no EC2 container instances to place an EC2 service on`;
  return undefined;
}

// ---------- cost estimates (list prices from ./costs.ts) ----------

export type Estimate = { monthlyUsd: number; note: string };

export function taskMonthly(launchType: string, cpu?: number, memory?: number, arm = false, rates: Rates = DEFAULT_RATES): number | undefined {
  if (launchType !== "FARGATE" || !cpu || !memory) return undefined;
  return monthly(fargateHourly(cpu, memory, arm, rates));
}

const size = (cpu: number, mem: number) => `${cpu / 1024} vCPU · ${mem / 1024} GB`;

export function serviceEstimate(launchType: string, cpu: number | undefined, memory: number | undefined, count: number, arm = false, rates: Rates = DEFAULT_RATES): Estimate {
  const per = taskMonthly(launchType, cpu, memory, arm, rates);
  if (per === undefined) return { monthlyUsd: 0, note: "runs on the cluster's existing EC2 capacity — no added instance cost unless it needs another host" };
  return { monthlyUsd: per * count, note: `${count} × ${usd(per)}/month per task (${size(cpu!, memory!)}, Fargate ${arm ? "ARM" : "x86"} list price, before Savings Plans)` };
}

export function hostEstimate(instanceType: string, count: number, rates: Rates = DEFAULT_RATES): Estimate | undefined {
  const h = ec2Hourly(instanceType, rates);
  if (h === undefined) return undefined;
  return { monthlyUsd: monthly(h) * count, note: `${count} × ${instanceType} at ${usd(monthly(h))}/month (on-demand list price, Linux, EBS not included)` };
}

// ---------- plans (what a dry run returns and what the review step shows; names, ids and counts only) ----------

export interface ProvisionPlan {
  action: ProvisionAction;
  env: string;
  summary: string;
  changes: string[];
  warnings: string[];
  estimate?: Estimate;
  confirm: ConfirmNeed;
  risk: "change" | "danger";
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const tagLine = (from: string) => `Tags: ${CREATED_TAG}=true, ${CREATED_FROM_TAG}=${from}`;

export interface CloneFacts {
  env: { id: string; protected: boolean };
  source: { env: string; service: string; family: string; revision: number; image: string; launchType: string; networkMode?: string; cpu?: number; memory?: number; arm?: boolean; execEnabled: boolean; loadBalancers: number; registries: number; serviceConnect: boolean };
  name: string;
  desired: number;
  image?: string;
  cpu?: number;
  memory?: number;
  network: Extract<NetworkChoice, { ok: true }>;
  familyExists: boolean; // a console-created family of that name already exists (earlier copy)
  runningHosts?: number; // EC2 host networking: hosts that could place a task
  rates?: Rates;
}

export function clonePlan(f: CloneFacts): ProvisionPlan {
  const src = `${f.source.env}/${f.source.service}`;
  const cross = f.source.env !== f.env.id;
  const cpu = f.cpu ?? f.source.cpu;
  const memory = f.memory ?? f.source.memory;
  const resized = f.cpu !== undefined || f.memory !== undefined;
  const changes = [
    `Register task definition ${f.name} (${f.familyExists ? "a new revision of the family the console created earlier" : "new family"}), copied from ${f.source.family}:${f.source.revision}`,
    f.image ? `Image: ${f.image} (instead of ${f.source.image})` : `Image: ${f.source.image} (same as the source)`,
    ...(f.source.launchType === "FARGATE" && cpu && memory ? [`Size: ${size(cpu, memory)}${resized ? " (changed)" : " (same as the source)"}`] : []),
    `Create service ${f.name} in ${f.env.id} on ${f.source.launchType} with ${plural(f.desired, "task")}, circuit breaker on (rolls back if tasks fail to start)`,
    `Networking: ${f.network.why}`,
    `Logs: same log group as the source, stream prefix ${f.name}/ so they don't mix with ${f.source.service}'s`,
    `${tagLine(src)} — tasks inherit them (propagateTags SERVICE)`,
    `ECS Exec: ${f.source.execEnabled ? "on" : "off"} (copied)`,
  ];
  const notCopied = [f.source.loadBalancers ? `load balancer (${plural(f.source.loadBalancers, "target group")})` : "", f.source.serviceConnect ? "Service Connect" : "", f.source.registries ? "service discovery" : "", "auto scaling policies"].filter(Boolean);
  const warnings = [
    `Not copied: ${notCopied.join(", ")}. The copy receives no traffic from a load balancer.`,
    cross
      ? `Environment variables, secret references and the task and execution roles are copied from ${f.source.env} — the copy talks to whatever ${f.source.service} talks to there (databases, queues, APIs). Review its Variables tab before giving it tasks.`
      : `Environment variables, secret references and roles are the source's — the copy uses the same database, queues and secrets as ${f.source.service}.`,
    ...(cross && f.desired > 0 ? ["Tip: create it with 0 tasks, check its variables, then scale it up."] : []),
    ...(f.image ? ["The new image must exist and be pullable by the task's execution role."] : []),
    ...(f.network.mode === "host" && f.desired > 0 ? [`Host networking binds the same host ports as ${f.source.service}: each EC2 host fits one such task${f.runningHosts !== undefined ? ` (${plural(f.runningHosts, "running host")})` : ""} — a host already running ${f.source.service} can't place the copy.`] : []),
  ];
  return {
    action: "clone", env: f.env.id, risk: "danger",
    summary: `Create ${f.name} in ${f.env.id} as a copy of ${src} (${plural(f.desired, "task")})`,
    changes, warnings,
    estimate: serviceEstimate(f.source.launchType, cpu, memory, Math.max(f.desired, 0), f.source.arm, f.rates),
    confirm: confirmFor("clone", f.env.protected, f.name),
  };
}

export interface ScaleFacts {
  env: { id: string; protected: boolean };
  service: string;
  from: number;
  to: number;
  launchType: string;
  networkMode?: string;
  cpu?: number;
  memory?: number;
  arm?: boolean;
  runningHosts?: number;
  // The service's Application Auto Scaling target (CC-20): null = it has none; undefined = it couldn't be read.
  autoscaling?: Autoscaling | null;
  rates?: Rates;
}

export interface Autoscaling {
  min: number;
  max: number;
  policies: string[];
}

// What the autoscaler does to a hand-set desired count. Outside [min, max] it is overridden at the next scaling
// activity (AWS: below the minimum, a scale-out first sets the minimum; above the maximum, a scale-in first sets the
// maximum); inside, the policies keep adjusting it.
export function autoscalingWarning(a: Autoscaling | null | undefined, desired: number): string | undefined {
  if (a === null) return undefined;
  if (a === undefined) return "If Application Auto Scaling manages this service, it may change the count back.";
  const range = `min ${a.min}, max ${a.max}${a.policies.length ? `; ${a.policies.join(", ")}` : ""}`;
  if (desired < a.min || desired > a.max)
    return `Application Auto Scaling manages this service (${range}): a desired count of ${desired} is outside that range, so the autoscaler will override it — its next scaling activity sets ${desired < a.min ? `the minimum, ${a.min}` : `the maximum, ${a.max}`}. Change the scalable target's minimum/maximum instead.`;
  return `Application Auto Scaling manages this service (${range}): its scaling policies may change the count again.`;
}

export function scalePlan(f: ScaleFacts): ProvisionPlan {
  const per = taskMonthly(f.launchType, f.cpu, f.memory, f.arm, f.rates);
  const delta = f.to - f.from;
  const auto = autoscalingWarning(f.autoscaling, f.to);
  const warnings = auto ? [auto] : [];
  if (f.networkMode === "host" && f.runningHosts !== undefined && f.to > f.runningHosts) warnings.push(`Host networking fits one task per EC2 host: ${plural(f.to, "task")} need ${f.to} hosts, the cluster has ${f.runningHosts} running — the rest stay pending.`);
  if (f.networkMode === "bridge") warnings.push("Bridge networking with fixed host ports fits one task per EC2 host per port.");
  if (f.launchType === "EC2" && delta > 0) warnings.push("New tasks need free CPU and memory on the cluster's EC2 hosts.");
  return {
    action: "scale", env: f.env.id, risk: "change",
    summary: `Scale ${f.service} in ${f.env.id} from ${f.from} to ${plural(f.to, "task")}`,
    changes: [`Set the desired count of ${f.service} to ${f.to} (now ${f.from}) — ECS ${delta > 0 ? "starts" : "stops"} ${plural(Math.abs(delta), "task")}, no new deployment`],
    warnings,
    estimate: per === undefined ? undefined : { monthlyUsd: per * delta, note: `${delta > 0 ? "+" : "−"}${usd(Math.abs(per * delta))}/month (${plural(Math.abs(delta), "task")} × ${usd(per)}, Fargate list price)` },
    confirm: confirmFor("scale", f.env.protected, f.service),
  };
}

export interface RunTaskFacts {
  env: { id: string; protected: boolean };
  service: string;
  taskDefinition: string; // family:revision
  launchType: string;
  networkMode?: string;
  container?: string;
  command?: string[];
  logs?: { group: string; prefix?: string };
  network: string; // human description
  cpu?: number;
  memory?: number;
  arm?: boolean;
  rates?: Rates;
}

export function runTaskPlan(f: RunTaskFacts): ProvisionPlan {
  const per = taskMonthly(f.launchType, f.cpu, f.memory, f.arm, f.rates);
  const changes = [
    `Run one task of ${f.taskDefinition} in ${f.env.id} on ${f.launchType}, outside the service (it isn't replaced when it exits)`,
    f.command ? `Command for container ${f.container}: ${f.command.map((a) => (/[\s"']/.test(a) || !a ? JSON.stringify(a) : a)).join(" ")}` : "Command: the task definition's own",
    `Networking: ${f.network}`,
    f.logs ? `Logs: ${f.logs.group}${f.logs.prefix ? `, stream ${f.logs.prefix}/${f.container}/<task id>` : ""}` : "Logs: the container has no awslogs configuration — output only in ECS",
    `${tagLine(`${f.env.id}/${f.service}`)}`,
    ...(per !== undefined ? [`Billed per second while it runs: about ${usd(per / HOURS_PER_MONTH)}/hour (Fargate list price)`] : []),
  ];
  const warnings = [
    "The task gets the service's variables, secrets and role: it can change the same data the service can.",
    ...(f.command ? ["The command runs with the service's role and is recorded in the audit log, ECS and CloudTrail — don't put secrets in it."] : []),
    ...(f.networkMode === "host" ? [`Host networking: the task binds the same host ports as ${f.service}, so it can't be placed on a host where ${f.service} already runs.`] : []),
  ];
  return {
    action: "run-task", env: f.env.id, risk: f.command ? "danger" : "change",
    summary: `Run a one-off task of ${f.service} in ${f.env.id}${f.command ? ` (${f.command[0]} …)` : ""}`,
    changes, warnings,
    confirm: confirmFor("run-task", f.env.protected, f.service),
  };
}

export interface AddHostFacts {
  env: { id: string; protected: boolean };
  cluster: string;
  source: { id: string; name: string; instanceType: string; imageId: string; subnetId?: string; securityGroups: string[]; instanceProfile?: string; keyName?: string; hasUserData: boolean; launchTemplate?: { id: string; version: string }; hasPublicIp: boolean };
  count: number;
  instanceType: string; // effective
  name: string; // Name tag of the new hosts
  rates?: Rates;
}

export function addHostPlan(f: AddHostFacts): ProvisionPlan {
  const s = f.source;
  const type = f.instanceType === s.instanceType ? `${f.instanceType} (same as ${s.name})` : `${f.instanceType} (instead of ${s.instanceType})`;
  const changes = s.launchTemplate
    ? [
        `Launch ${plural(f.count, "EC2 instance")} from launch template ${s.launchTemplate.id} version ${s.launchTemplate.version} (the template ${s.name} was launched from) — it decides the AMI, security groups, instance profile and user data`,
        `Instance type: ${type}`,
        ...(s.subnetId ? [`Subnet: ${s.subnetId} (same as ${s.name}, unless the template defines network interfaces)`] : []),
      ]
    : [
        `Launch ${plural(f.count, "EC2 instance")} like ${s.name} (${s.id})`,
        `Instance type: ${type}`,
        `AMI ${s.imageId}, subnet ${s.subnetId ?? "—"}, security groups ${s.securityGroups.join(", ") || "—"}`,
        `Instance profile: ${s.instanceProfile ?? "none"} · key pair: ${s.keyName ?? "none"} · user data: ${s.hasUserData ? "copied (not shown)" : "none"}`,
      ];
  changes.push(`Name ${f.name}; ${tagLine(s.id)} (instances and volumes)`);
  const warnings = [
    `The new host joins ${f.cluster} only if its user data (or AMI) registers it there — ECS then places tasks on it as capacity allows.`,
    ...(!s.launchTemplate && !s.hasUserData ? ["No user data: an ECS-optimized AMI registers into the cluster named \"default\" unless configured otherwise."] : []),
    ...(!s.launchTemplate ? ["Not copied: extra EBS volumes, root volume size (the AMI's default is used), Elastic IPs, a public IP (follows the subnet's setting)."] : []),
  ];
  const est = hostEstimate(f.instanceType, f.count, f.rates);
  if (!est) warnings.push(`No list price known for ${f.instanceType} — no estimate.`);
  return {
    action: "add-host", env: f.env.id, risk: "danger",
    summary: `Add ${plural(f.count, "EC2 host")} (${f.instanceType}) to ${f.env.id} like ${s.name}`,
    changes, warnings, estimate: est,
    confirm: confirmFor("add-host", f.env.protected, f.env.id),
  };
}

export interface DeleteServiceFacts {
  env: { id: string; protected: boolean };
  service: string;
  desired: number;
  family?: string;
  rates?: Rates;
}

export function deleteServicePlan(f: DeleteServiceFacts): ProvisionPlan {
  return {
    action: "delete-service", env: f.env.id, risk: "danger",
    summary: `Delete ${f.service} from ${f.env.id}`,
    changes: [
      `Set its desired count to 0 (now ${f.desired}), then delete the service (DeleteService, force)`,
      `Keep its task definitions${f.family ? ` (family ${f.family})` : ""} — harmless, and they keep the history; deregister them in AWS if you want them gone`,
    ],
    warnings: ["Its tasks stop within a minute. This can't be undone — creating it again makes a new service."],
    confirm: confirmFor("delete-service", f.env.protected, f.service),
  };
}

export interface TerminateHostFacts {
  env: { id: string; protected: boolean };
  id: string;
  name: string;
  instanceType: string;
  otherRunningHosts: number; // running hosts of the cluster besides this one
  ec2Services: number; // EC2 services with tasks to place
}

export function terminateHostPlan(f: TerminateHostFacts): ProvisionPlan {
  const last = f.otherRunningHosts === 0;
  return {
    action: "terminate-host", env: f.env.id, risk: "danger",
    summary: `Terminate EC2 host ${f.name} (${f.id}, ${f.instanceType}) in ${f.env.id}`,
    changes: [`Terminate instance ${f.id} — ECS removes it from the cluster; its root volume is deleted with it`],
    warnings: [
      "Tasks placed on it stop; ECS starts service tasks on the remaining hosts if they have room.",
      ...(last && f.ec2Services ? [`No other host is running — ${plural(f.ec2Services, "EC2 service")} will have nowhere to run.`] : []),
      "This can't be undone.",
    ],
    confirm: confirmFor("terminate-host", f.env.protected, f.id),
  };
}

// ---------- what the console's AWS identity may do (F06) ----------

// The IAM actions each provisioning action needs (CONSOLE_WRITES in capability-rules.ts). A delete is ECS only, a
// terminate EC2 only, though both share the "provision.delete" entry; scaling is an UpdateService like the actions.
export function provisionIam(action: ProvisionAction): string[] {
  const of = (write: string) => (Object.hasOwn(CONSOLE_WRITES, write) ? [...CONSOLE_WRITES[write]] : []);
  switch (action) {
    case "clone":
      return of("provision.service");
    case "scale":
      return of("ecs.scale");
    case "run-task":
      return of("provision.task");
    case "add-host":
      return of("provision.hosts");
    case "delete-service":
      return of("provision.delete").filter((a) => a.startsWith("ecs:"));
    case "terminate-host":
      return of("provision.delete").filter((a) => a.startsWith("ec2:"));
  }
}

export interface CapabilityGate {
  enabled: boolean;
  why?: string; // when disabled
  warning?: string; // enabled, but AWS will probably refuse
}

// denied → the button is disabled with the reason; probably denied → enabled with a warning; allowed or unknown
// (nothing verified yet) → nothing. AWS stays the authority: the run itself is never refused on this alone.
export function capabilityGate(cap: { state: CapState; missing: string[] }, iam: readonly string[]): CapabilityGate {
  const what = (cap.missing.length ? cap.missing : [...iam]).join(", ");
  if (cap.state === "denied") return { enabled: false, why: `the console's AWS identity can't call ${what}` };
  if (cap.state === "probably-denied") return { enabled: true, warning: `AWS permission not verified — likely denied (${what})` };
  return { enabled: true };
}

// The same gate as a plan warning, so an agent's dry run says what the button would.
export const capabilityWarning = (g: CapabilityGate): string | undefined =>
  !g.enabled ? `${g.why} — AWS will refuse this (Settings → AWS permissions)` : g.warning;

// What the UI reads to draw the Create & scale buttons and forms (GET /api/provision): the same facts the guards above
// take, so a disabled button and a refused request always give the same reason.
export interface ProvisionInfo {
  env: string;
  protected: boolean;
  kind: string; // EnvInfo kind: fargate | ec2 | mixed | unknown
  limits: ProvisionLimits;
  can: { provision: boolean; act: boolean; provisionRole: string; actRole: string };
  services: {
    name: string; display: string; status: string; desired: number; launchType: string; created: boolean; self: boolean; inProgress: boolean; hasTaskDef: boolean;
    networkMode?: string; cpu?: number; memory?: number; image?: string; containers: string[]; main?: string;
  }[];
  hosts: { id: string; name: string; type: string; state: string; asg?: string; created: boolean; launchTemplate?: string }[];
  // Console-created hosts counted against provisioning.maxHosts: in the cluster, launched and still joining it, or being
  // launched (R23). Pass it to addHostCheck instead of counting `hosts`, which only lists the ones that joined.
  hostCount: HostCount;
  hostCountDetail?: string;
  capability: Record<ProvisionAction, CapabilityGate>; // F06: what the console's AWS identity may do
  sources?: { env: string; envLabel: string; protected: boolean; name: string; display: string; launchType: string; networkMode?: string; cpu?: number; memory?: number; image?: string; self: boolean }[];
}

// Tags to put on something the console creates, keeping a source's own tags except AWS-reserved ones and earlier
// console bookkeeping.
export function createdTags(from: string, keep: Record<string, string> = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(keep)) if (!k.startsWith("aws:") && k !== CREATED_TAG && k !== CREATED_FROM_TAG) out[k] = v;
  return { ...out, [CREATED_TAG]: "true", [CREATED_FROM_TAG]: from.slice(0, 256) };
}
