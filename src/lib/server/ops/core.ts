// Core operations: what the console already does, as model-friendly tools. Each one calls the same server function
// the UI's routes call (act, powerAct, saveVars, rerun, …), so every guard, lock, confirmation and audit row still
// applies; the registry (./index.ts) adds input validation, the role check and the token-mode gate in front.
// Outputs are compact on purpose — names, states, counts and short text, never the UI's big view models — and never
// contain secret values: there is deliberately no operation that reveals environment variable values.
import "server-only";
import { actionSpecs, checkPower, expectedConfirm, type ActionContext } from "../../actions.ts";
import { CONSOLE_WRITES } from "../../capability-rules.ts";
import { rerunRules, type RerunMode } from "../../ci-rules.ts";
import { summarize, type VarChanges } from "../../envvars.ts";
import { uptime } from "../../history.ts";
import type { Target } from "../../logpaging.ts";
import { autoscalingNote, outsideRange } from "../../overview-rules.ts";
import { STATE_RANK, parseImage } from "../../status.ts";
import type { ActionName, LogPage, ResourceView, State } from "../../types.ts";
import { recallDesired } from "../audit.ts";
import { capability } from "../capability.ts";
import { assertRepo, deployTarget, rerunCiRun, runs } from "../ci.ts";
import {
  act, auditLog, autoscalingOf, events, hostIssues, latestOverview, liveService, metrics, operationsFor, overview, powerAct, revisions, samplerStatus, worstState,
} from "../console.ts";
import { catalog, envInfo, knownRepos, listEnvs, metaOf, servicesOf } from "../discovery.ts";
import { listVars, saveVars, varsProtected } from "../envvars.ts";
import { HttpError } from "../errors.ts";
import { logSearch, logTail, servicesParam } from "../logs.ts";
import type { MutationActor } from "../mutations.ts";
import { releases } from "../observe.ts";
import { getCi } from "../sources.ts";
import type { AnyOperation, JsonSchema, OpContext, Operation, Plan } from "./types.ts";

// ---------- shared schema pieces ----------

const obj = (properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema => ({ type: "object", properties, required, additionalProperties: false });
const ENV: JsonSchema = { type: "string", pattern: "^[a-z0-9][a-z0-9-]{0,62}$", description: "Environment id, from envs.list." };
const SERVICE: JsonSchema = { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9_-]{0,254}$", description: "ECS service name: the `id` of a service in envs.status." };
const CONFIRM: JsonSchema = {
  type: "string",
  maxLength: 200,
  description: 'Confirmation text. "yes" on non-protected environments. On protected ones, the `confirm` value from a dry run\'s plan (when a person approves an agent\'s request, they type it themselves).',
};
const REASON: JsonSchema = { type: "string", maxLength: 500, description: "Why this is being done. Required on protected environments (at least 3 characters); stored in the audit log." };
const SERVICES: JsonSchema = { type: "array", maxItems: 20, items: SERVICE, description: "Services to read (default: every service in the environment that has logs)." };

const op = <I,>(o: Operation<I>) => o as AnyOperation;
const byEnv = (i: { env: string }) => i.env;

const iso = (ms?: number | null) => (ms ? new Date(ms).toISOString() : undefined);
const sha7 = (s?: string) => s?.slice(0, 7);
const nonzero = (s: Record<string, number>) => Object.fromEntries(Object.entries(s).filter(([, n]) => n > 0));
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
// Drops undefined keys so outputs stay small.
const compact = <T extends Record<string, unknown>>(o: T) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
const enabledActions = (r: ResourceView) => r.actions.filter((a) => a.enabled).map((a) => (a.name === "boxStart" ? "start" : a.name === "boxStop" ? "stop" : a.name));
// Who the coordinator records: the audit display string plus the caller's ids (a token's id, an approval's id; an
// agent's run, step and grant come from the mutation context the registry sets).
const whoOf = (ctx: OpContext): MutationActor => ({
  display: ctx.actor, kind: ctx.via === "agent" ? "agent" : ctx.via === "token" && !ctx.approval ? "token" : "person", userId: ctx.user.id, via: ctx.via,
  ...(ctx.tokenId ? { tokenId: ctx.tokenId } : {}), ...(ctx.approval ? { approvalId: ctx.approval } : {}), ...(ctx.ip ? { ip: ctx.ip } : {}),
});
// The IAM permission a console write needs, when the console's identity probably lacks it (F06).
function permissionWarning(write: string): string | undefined {
  const iam = Object.hasOwn(CONSOLE_WRITES, write) ? CONSOLE_WRITES[write] : [];
  const cap = iam.length ? capability(iam) : undefined;
  if (cap?.state === "denied") return `the console's AWS identity can't call ${(cap.missing.length ? cap.missing : iam).join(", ")} — AWS will refuse this`;
  if (cap?.state === "probably-denied") return `AWS permission not verified — likely denied (${(cap.missing.length ? cap.missing : iam).join(", ")})`;
  return undefined;
}
const byState = (a: { state: State }, b: { state: State }) => STATE_RANK[a.state] - STATE_RANK[b.state];

// ---------- environments ----------

const envsList = op<Record<string, never>>({
  name: "envs.list",
  title: "List environments",
  description:
    "Lists every environment the console discovered (one per ECS cluster): id, label, whether it is protected (production-like: changes need a typed confirmation and a reason), region, cluster, capacity kind, the git branch that deploys there, and its worst current state with per-state counts from the background sampler. `stale: true` means the sampler hasn't read it for a while (worst is then UNKNOWN, `staleReason` says since when). Start here; other operations take the `id` as `env`.",
  risk: "read",
  perm: "view",
  input: obj({}),
  run: async () =>
    (await listEnvs()).map((e) => {
      const o = latestOverview(e.id);
      const s = samplerStatus(e.id);
      return compact({
        id: e.id, label: e.label, protected: e.protected, region: e.region, cluster: e.cluster, kind: e.kind, branch: e.branch,
        worst: s.stale ? "UNKNOWN" : o ? worstState(o) : undefined, counts: o && !s.stale ? nonzero(o.summary) : undefined,
        sampledAt: iso(s.sampledAt), stale: s.stale || undefined, staleReason: s.reason,
      });
    }),
});

const envsStatus = op<{ env: string }>({
  name: "envs.status",
  title: "Environment status",
  description:
    "Current status of one environment: every service, EC2 host, database, cache and load balancer with its state (UP, DEGRADED, DOWN, DEPLOYING, STOPPED, BOX_STOPPED, UNKNOWN), the reasons behind it, and for services running/desired task counts, task-definition revision, image tag, git sha and whether a rollout is in progress. Problems come first. `actions` lists what can be done to a resource right now. Use this to answer \"is everything OK?\" or to find a service id.",
  risk: "read",
  perm: "view",
  input: obj({ env: ENV }, ["env"]),
  env: byEnv,
  run: async ({ env }) => {
    const info = await envInfo(env);
    const [o, raw] = await Promise.all([overview(env, { light: true }), servicesOf(info.cluster, info.region).catch(() => [])]);
    const live = new Map(raw.map((s) => [s.name, s]));
    const resources = [...o.services, ...o.infra]
      .map((r) => {
        const s = r.kind === "service" ? live.get(r.id) : undefined;
        const img = s?.taskDef ? parseImage(s.taskDef.image) : undefined;
        return compact({
          key: r.key, kind: r.kind, id: r.id, name: r.name, state: r.state, reasons: r.reasons.slice(0, 5),
          running: s?.running, desired: s?.desired, pending: s?.pending || undefined, revision: s?.taskDef?.revision, version: img?.tag, sha: sha7(img?.sha),
          rollout: s?.deployments.some((d) => d.rolloutState === "IN_PROGRESS") ? "in progress" : undefined,
          actions: r.readOnly ? undefined : enabledActions(r), readOnly: r.readOnly || undefined,
        });
      })
      .sort((a, b) => byState(a as { state: State }, b as { state: State }));
    return { env: info.id, label: info.label, protected: info.protected, checkedAt: iso(o.checkedAt), summary: nonzero(o.summary), resources };
  },
});

// ---------- services ----------

const servicesGet = op<{ env: string; service: string }>({
  name: "services.get",
  title: "Service details",
  description:
    "Everything about one service: state and reasons, desired/running/pending tasks, the live revision (task definition, image tag, git sha), deployments with rollout state and reason, recent tasks (status, health, stop reason, exit code), repository, health check, whether it has logs, Application Auto Scaling limits, the actions possible right now and why others are blocked, and the changes of the last 15 minutes with their verification (`accepted` = AWS accepted it, still verifying; `verified` = steady on the new state; `failed`). Use after envs.status when something looks wrong, and after a change to see whether it took effect.",
  risk: "read",
  perm: "view",
  input: obj({ env: ENV, service: SERVICE }, ["env", "service"]),
  env: byEnv,
  run: async ({ env, service }) => {
    const info = await envInfo(env);
    const live = await liveService(info, service);
    const meta = await metaOf(info, live);
    const [view, scaling, ops] = await Promise.all([
      overview(env, { light: true }).then((o) => o.services.find((r) => r.id === service), () => undefined),
      autoscalingOf(info, service).catch(() => undefined),
      operationsFor(info, service).catch(() => []),
    ]);
    const td = live.taskDef;
    const img = td ? parseImage(td.image) : undefined;
    return compact({
      env: info.id, service, name: meta.name, state: view?.state ?? "UNKNOWN", reasons: view?.reasons ?? [],
      desired: live.desired, running: live.running, pending: live.pending, launchType: live.launchType, status: live.status, circuitBreaker: live.circuitBreaker,
      revision: td ? { number: td.revision, family: td.family, arn: td.arn, image: td.image, tag: img?.tag, sha: img?.sha, registeredAt: iso(td.registeredAt) } : null,
      deployments: live.deployments.map((d) => compact({ status: d.status, rollout: d.rolloutState, reason: d.rolloutReason, revision: Number(d.taskDefinition.split(":").pop()), running: d.running, desired: d.desired, failedTasks: d.failedTasks || undefined, createdAt: iso(d.createdAt) })),
      tasks: live.tasks.slice(0, 20).map((t) => compact({ id: t.id.split("/").pop(), lastStatus: t.lastStatus, desiredStatus: t.desiredStatus, health: t.hasHealthcheck ? t.health : undefined, startedAt: iso(t.startedAt), stoppedAt: iso(t.stoppedAt), stoppedReason: t.stoppedReason, exitCode: t.exitCode })),
      repo: meta.repo, healthcheck: meta.healthcheck, logs: !!meta.logs, infra: meta.infra || undefined, readOnly: meta.self || undefined,
      autoscaling: scaling,
      operations: ops.length ? ops.map((o) => compact({ id: o.id, action: o.action, by: o.actor, at: iso(o.at), verification: o.verification, detail: o.detail })) : undefined,
      actions: view && !meta.self ? enabledActions(view) : [],
      blocked: view && !meta.self ? Object.fromEntries(view.actions.filter((a) => !a.enabled).map((a) => [a.name, a.why])) : undefined,
    });
  },
});

const servicesEvents = op<{ env: string; service: string; limit?: number }>({
  name: "services.events",
  title: "Service events",
  description: "Recent ECS service events (newest first): deployments starting and completing, tasks failing health checks, placement problems, steady state. Use to explain why a service is deploying, degraded or down.",
  risk: "read",
  perm: "view",
  input: obj({ env: ENV, service: SERVICE, limit: { type: "integer", minimum: 1, maximum: 100, default: 25, description: "How many events (default 25)." } }, ["env", "service"]),
  env: byEnv,
  run: async ({ env, service, limit }) => {
    await liveService(await envInfo(env), service); // only discovered services reach AWS
    return (await events(env, service)).slice(0, limit ?? 25).map((e) => ({ at: iso(e.at), message: cut(e.message, 500) }));
  },
});

const servicesRevisions = op<{ env: string; service: string; limit?: number }>({
  name: "services.revisions",
  title: "Service revisions",
  description:
    "Task-definition revisions of a service, newest first: revision number, image tag, git sha and commit title, which one is live, whether every essential container's image still exists (`imageCheck`: present, missing — can't start — or unknown with `imageWhy`), whether the image is referenced by a tag that has moved (`tagWarning`), the CI result for that commit and whether database migrations changed relative to the live revision (true, false, or \"unknown\" with `migrationsWhy` — unknown still needs migrationAck). Use before services.switch to pick a revision to roll back or forward to.",
  risk: "read",
  perm: "view",
  input: obj({ env: ENV, service: SERVICE, limit: { type: "integer", minimum: 1, maximum: 50, default: 10, description: "How many revisions (default 10)." } }, ["env", "service"]),
  env: byEnv,
  run: async ({ env, service, limit }) =>
    (await revisions(env, service))
      .sort((a, b) => b.revision - a.revision)
      .slice(0, limit ?? 10)
      .map((r) => compact({
        revision: r.revision, live: r.live || undefined, tag: r.tag, sha: sha7(r.sha), title: r.commit?.title, author: r.commit?.author, registeredAt: iso(r.registeredAt),
        imagePresent: r.imagePresent, imageCheck: r.imageCheck, imageWhy: r.imageCheckWhy ? cut(r.imageCheckWhy, 300) : undefined, tagWarning: r.mutableTag ? r.mutableTagWhy : undefined,
        ci: r.ci, migrations: r.migrations, migrationsWhy: r.migrationsWhy,
      })),
});

// Restart / stop / start / switch: act() applies the same guards and confirmations as the UI's buttons.
type ActionInput = { env: string; service: string; confirm: string; reason?: string; revision?: number; migrationAck?: boolean };

async function servicePlan(action: ActionName, i: ActionInput): Promise<Plan> {
  const info = await envInfo(i.env);
  const live = await liveService(info, i.service);
  const meta = await metaOf(info, live);
  const cur = live.taskDef?.revision;
  const warnings: string[] = [];
  const changes: string[] = [];
  let targetSha: string | undefined;
  if (action === "switch") {
    const target = (await revisions(i.env, i.service)).find((r) => r.revision === i.revision);
    if (!target) warnings.push(`revision ${i.revision} not found for this service — the switch will be refused`);
    else {
      targetSha = target.sha;
      changes.push(`task definition revision ${cur ?? "?"} → ${target.revision} (${target.tag}${target.commit ? `: ${target.commit.title}` : ""})`);
      if (target.live) warnings.push("that revision is already live — the switch will be refused");
      if (!target.imagePresent) warnings.push(`that revision's image is no longer in ECR — it cannot start${target.imageCheckWhy ? ` (${target.imageCheckWhy})` : ""}`);
      else if (target.imageCheck === "unknown") warnings.push(`whether its image still exists could not be verified (${target.imageCheckWhy ?? "no check available"}); the switch is allowed but may fail to start`);
      if (target.mutableTag && target.mutableTagWhy) warnings.push(target.mutableTagWhy);
      if (target.migrations === true) warnings.push("database migrations changed between these commits; rolling back code does not undo them (migrationAck: true is required)");
      // F07/R25: "unknown" is never reported as "no migrations".
      if (target.migrations === "unknown") warnings.push(`database migrations could not be checked (${target.migrationsWhy ?? "comparison unavailable"}); migrationAck: true is required`);
    }
  }
  const permission = permissionWarning(`ecs.${action}`);
  if (permission) warnings.push(permission);
  // CC-20: Application Auto Scaling sets the count back inside [min, max].
  const scaling = action === "stop" || action === "start" ? await autoscalingOf(info, i.service).catch(() => undefined) : undefined;
  const startCount = action === "start" ? ((await recallDesired(info.id, i.service).catch(() => undefined)) ?? 1) : undefined;
  if (scaling && outsideRange(scaling, action === "stop" ? 0 : startCount)) warnings.push(autoscalingNote(scaling));
  const ctx: ActionContext = {
    env: info.id, protected: info.protected, service: i.service, desired: live.desired, inProgress: live.deployments.some((d) => d.rolloutState === "IN_PROGRESS"),
    isSelf: meta.self, locked: false, liveArn: live.taskDef?.arn,
  };
  const spec = actionSpecs(ctx).find((a) => a.name === action);
  if (spec && !spec.enabled) warnings.push(`refused right now: ${spec.why}`);
  if (info.protected && (!i.reason || i.reason.trim().length < 3)) warnings.push("a reason is required on a protected environment");
  // Desired, not running: the plan is what an approval binds (its hash), and the running count moves on its own.
  if (action === "restart") changes.push(`new deployment of revision ${cur ?? "?"} (${live.desired} task${live.desired === 1 ? "" : "s"}, rolling)`);
  if (action === "stop") changes.push(`desired count ${live.desired} → 0; the count is remembered for start`);
  if (action === "start") changes.push(`desired count 0 → ${startCount} (the count it had before it was stopped, 1 if unknown)`);
  const verb = { restart: "Restart", stop: "Stop", start: "Start", switch: `Switch revision of` }[action];
  return {
    summary: `${verb} ${i.service} in ${info.label}${action === "switch" && i.revision ? ` to revision ${i.revision}` : ""}${info.protected ? " (protected)" : ""}`,
    changes,
    warnings,
    confirm: expectedConfirm(info.protected, action, i.service, info.id, targetSha),
  };
}

async function serviceAct(action: ActionName, i: ActionInput, ctx: OpContext) {
  let revisionArn: string | undefined;
  if (action === "switch") {
    revisionArn = (await revisions(i.env, i.service)).find((r) => r.revision === i.revision)?.arn;
    if (!revisionArn) throw new HttpError(409, `revision ${i.revision} not found for ${i.service}`);
  }
  const body = compact({ action, confirm: i.confirm, reason: i.reason, revisionArn, migrationAck: action === "switch" ? i.migrationAck : undefined });
  return act(i.env, i.service, body, whoOf(ctx), ctx.ip);
}

const ACTION_OPS: { name: string; action: ActionName; title: string; description: string }[] = [
  {
    name: "services.restart",
    action: "restart",
    title: "Restart a service",
    description:
      "Starts fresh tasks of a service on the same revision (a new ECS deployment, rolling: normally no downtime). Use when a service is stuck, leaking memory or needs to re-read secrets. Refused while a rollout is in progress, when the service is stopped, or on the console's own service. Returns the ECS request id, the operation id and `verification: \"accepted\"` (AWS accepted it; it is not done yet) — services.get shows the operation as verified once the new tasks are steady, or failed.",
  },
  {
    name: "services.stop",
    action: "stop",
    title: "Stop a service",
    description: "Sets a service's desired count to 0: it stops serving (and any scheduled work it does) until started again. The previous count is remembered for services.start. Refused when already stopped or on the console's own service. If Application Auto Scaling manages the service with a minimum above 0, it starts tasks again — the plan warns.",
  },
  { name: "services.start", action: "start", title: "Start a service", description: "Starts a stopped service with the task count it had before it was stopped (1 if unknown). Refused unless the service is stopped (desired count 0)." },
  {
    name: "services.switch",
    action: "switch",
    title: "Switch a service's revision",
    description:
      "Rolls a service back or forward to another task-definition revision (see services.revisions). The circuit breaker rolls back automatically if the new tasks fail to start. Refused if the revision is already live, an essential container's image is gone from ECR, or a rollout is in progress; when database migrations changed between the commits — or could not be checked — migrationAck: true is required. Returns the operation id with `verification: \"accepted\"`; services.get shows when it is verified.",
  },
];

const actionOps = ACTION_OPS.map(({ name, action, title, description }) =>
  op<ActionInput>({
    name,
    title,
    description,
    risk: "change",
    perm: "act",
    input: obj(
      {
        env: ENV,
        service: SERVICE,
        ...(action === "switch"
          ? {
              revision: { type: "integer", minimum: 1, description: "Task-definition revision number to switch to (from services.revisions)." },
              migrationAck: { type: "boolean", description: "Acknowledge that database migrations changed between the live and the target commit." },
            }
          : {}),
        confirm: CONFIRM,
        reason: REASON,
      },
      action === "switch" ? ["env", "service", "revision", "confirm"] : ["env", "service", "confirm"],
    ),
    env: byEnv,
    plan: (i) => servicePlan(action, i),
    run: (i, ctx) => serviceAct(action, i, ctx),
  }),
);

// ---------- hosts and databases ----------

type PowerInput = { env: string; host?: string; database?: string; action: "start" | "stop"; confirm: string };

async function powerPlan(kind: "host" | "database", i: PowerInput): Promise<Plan> {
  const info = await envInfo(i.env);
  // A permanent refusal fails the plan, so no approval request is created that could only ever fail.
  if (info.protected) throw new HttpError(409, "power actions are never allowed on protected environments");
  const cat = await catalog(info.id);
  const id = (kind === "host" ? i.host : i.database) ?? "";
  const h = kind === "host" ? cat.hosts.find((x) => x.id === id) : undefined;
  const d = kind === "database" ? cat.databases.find((x) => x.id === id) : undefined;
  const check = checkPower(i.action, { kind, state: h?.state ?? d?.status, protected: info.protected, asg: h?.asg, aurora: d?.aurora }, "yes");
  const noun = kind === "host" ? "EC2 instance" : "database";
  return {
    summary: `${i.action === "start" ? "Start" : "Stop"} ${noun} ${id} in ${info.label}`,
    changes: [kind === "host" ? (i.action === "stop" ? "every service placed on this host goes offline until it starts again" : "ECS places its services again once the agent reconnects (2–4 min)") : i.action === "stop" ? "services that use this database fail until it starts again; AWS restarts a stopped instance after 7 days" : "starting takes 3–8 minutes"],
    warnings: check.ok ? [] : [`refused right now: ${check.error}`],
    confirm: "yes",
  };
}

const POWER_ACTION: JsonSchema = { type: "string", enum: ["start", "stop"], description: "start or stop." };
const POWER_CONFIRM: JsonSchema = { type: "string", enum: ["yes"], description: 'Always "yes".' };

const hostsPower = op<PowerInput>({
  name: "hosts.power",
  title: "Start or stop an EC2 host",
  description:
    "Starts or stops an EC2 container instance of an environment (see envs.status for hosts: kind \"box\"). Stopping takes every service placed on it offline. Refused on protected environments, for instances in an Auto Scaling group (scale the group instead) and while the instance is starting or stopping.",
  risk: "change",
  perm: "power",
  input: obj({ env: ENV, host: { type: "string", pattern: "^i-[0-9a-f]{8,17}$", description: "EC2 instance id (i-…)." }, action: POWER_ACTION, confirm: POWER_CONFIRM }, ["env", "host", "action", "confirm"]),
  env: byEnv,
  plan: (i) => powerPlan("host", i),
  run: (i, ctx) => powerAct(i.env, "host", i.host, i.action, i.confirm, whoOf(ctx), ctx.ip),
});

const databasesPower = op<PowerInput>({
  name: "databases.power",
  title: "Start or stop a database",
  description:
    "Starts or stops an RDS instance that belongs to an environment (see envs.status: kind \"database\"). Stop the services that use it first, or they will fail. Refused on protected environments, for Aurora members (Aurora stops per cluster) and while the instance is changing state.",
  risk: "change",
  perm: "power",
  input: obj({ env: ENV, database: { type: "string", pattern: "^[A-Za-z][A-Za-z0-9-]{0,62}$", description: "RDS instance identifier." }, action: POWER_ACTION, confirm: POWER_CONFIRM }, ["env", "database", "action", "confirm"]),
  env: byEnv,
  plan: (i) => powerPlan("database", i),
  run: (i, ctx) => powerAct(i.env, "database", i.database, i.action, i.confirm, whoOf(ctx), ctx.ip),
});

// ---------- logs ----------

const MAX_LOG_CHARS = 60_000;

function logLines(page: LogPage, targets: Target[], limit: number, contains?: string) {
  const serviceOf = (stream: string) =>
    targets.length === 1 ? targets[0].service : (targets.find((t) => t.prefix && stream.startsWith(t.prefix)) ?? targets.find((t) => !t.shared))?.service;
  const needle = contains?.toLowerCase();
  let lines = page.lines
    .map(([ts, i, msg]) => ({ at: iso(ts)!, service: serviceOf(page.streams[i] ?? ""), message: cut(msg.trimEnd(), 2_000) }))
    .filter((l) => !needle || l.message.toLowerCase().includes(needle));
  const matched = lines.length;
  lines = lines.slice(-limit);
  let size = lines.reduce((n, l) => n + l.message.length + 40, 0);
  while (size > MAX_LOG_CHARS && lines.length > 1) size -= lines.shift()!.message.length + 40;
  return { lines, returned: lines.length, matched, truncated: lines.length < matched || undefined };
}

const logsRecent = op<{ env: string; services?: string[]; limit?: number; contains?: string }>({
  name: "logs.recent",
  title: "Recent log lines",
  description:
    "The latest log lines of one or more services (from CloudWatch Logs, the current task and the one before it), oldest first, each with its time and service. Optionally keep only lines containing some text. For a specific time range or a CloudWatch filter pattern, use logs.search. Output is capped (≈60 KB); `truncated` says when lines were left out.",
  risk: "read",
  perm: "view",
  input: obj(
    {
      env: ENV,
      services: SERVICES,
      limit: { type: "integer", minimum: 1, maximum: 1000, default: 200, description: "Maximum lines (default 200)." },
      contains: { type: "string", maxLength: 200, description: "Keep only lines containing this text (case-insensitive)." },
    },
    ["env"],
  ),
  env: byEnv,
  run: async ({ env, services, limit, contains }) => {
    const targets = await servicesParam(env, services?.length ? services.join(",") : "all");
    const n = limit ?? 200;
    const page = await logTail(targets, null, contains ? 2_000 : Math.max(n, 100));
    return { env, services: targets.map((t) => t.service), ...logLines(page, targets, n, contains) };
  },
});

const logsSearch = op<{ env: string; services?: string[]; query: string; mode?: "text" | "pattern"; minutes?: number; limit?: number }>({
  name: "logs.search",
  title: "Search logs",
  description:
    "Searches the logs of one or more services over the last N minutes (up to 24 hours). mode \"text\" (default) matches the query literally; mode \"pattern\" passes a CloudWatch filter pattern as-is (e.g. `?ERROR ?WARN`, `{ $.level >= 50 }`). Returns matching lines oldest first with time and service; `truncated` means more matched than were returned — narrow the range or the query.",
  risk: "read",
  perm: "view",
  input: obj(
    {
      env: ENV,
      services: SERVICES,
      query: { type: "string", minLength: 1, maxLength: 1024, description: "Text to find, or a CloudWatch filter pattern when mode is \"pattern\". One line." },
      mode: { type: "string", enum: ["text", "pattern"], default: "text", description: "text (literal match) or pattern (CloudWatch filter pattern)." },
      minutes: { type: "integer", minimum: 1, maximum: 1440, default: 60, description: "How far back to search (default 60)." },
      limit: { type: "integer", minimum: 1, maximum: 1000, default: 200, description: "Maximum lines (default 200)." },
    },
    ["env", "query"],
  ),
  env: byEnv,
  run: async ({ env, services, query, mode, minutes, limit }) => {
    const targets = await servicesParam(env, services?.length ? services.join(",") : "all");
    const end = Date.now();
    const page = await logSearch(targets, query, mode ?? "text", end - (minutes ?? 60) * 60_000, end, null);
    const out = logLines(page, targets, limit ?? 200);
    return { env, services: targets.map((t) => t.service), from: iso(end - (minutes ?? 60) * 60_000), to: iso(end), ...out, truncated: out.truncated || (page.cursor ? true : undefined) };
  },
});

// ---------- metrics ----------

const metricsGet = op<{ env: string; resource: string; minutes?: number }>({
  name: "metrics.get",
  title: "Resource metrics",
  description:
    "CloudWatch metrics of one resource over the last N minutes, summarised per series (latest, min, max, average) with up to 30 points. Resources are keys from envs.status: \"service:<id>\" (CPU, memory %), \"box:<instance id>\" (CPU, credit balance), \"database:<id>\" (CPU, connections, free storage GB) or \"loadbalancer:alb\" (requests/s, latency p50/p90/p99 ms, 5xx, connections).",
  risk: "read",
  perm: "view",
  input: obj(
    {
      env: ENV,
      resource: { type: "string", pattern: "^(service|box|database|loadbalancer):[A-Za-z0-9._/-]{1,255}$", description: "Resource key, e.g. \"service:api\" or \"loadbalancer:alb\"." },
      minutes: { type: "integer", minimum: 15, maximum: 1440, default: 60, description: "Window in minutes (15–1440, default 60)." },
    },
    ["env", "resource"],
  ),
  env: byEnv,
  run: async ({ env, resource, minutes }) => {
    const m = minutes ?? 60;
    const series = await metrics(env, resource, m);
    return {
      env, resource, minutes: m,
      series: series.map((s) => {
        const vals = s.points.map((p) => p[1]);
        const round = (v: number) => Math.round(v * 100) / 100;
        const step = Math.max(1, Math.ceil(s.points.length / 30));
        const points: [string, number][] = [];
        for (let i = 0; i < s.points.length; i += step) {
          const chunk = s.points.slice(i, i + step);
          points.push([iso(chunk[0][0])!, round(chunk.reduce((a, p) => a + p[1], 0) / chunk.length)]);
        }
        return vals.length
          ? { id: s.id, label: s.label, unit: s.unit, latest: round(vals[vals.length - 1]), min: round(Math.min(...vals)), max: round(Math.max(...vals)), avg: round(vals.reduce((a, b) => a + b, 0) / vals.length), points }
          : { id: s.id, label: s.label, unit: s.unit, points: [], note: "no data in this window" };
      }),
    };
  },
});

// ---------- environment variables ----------

const variablesList = op<{ env: string; service: string }>({
  name: "variables.list",
  title: "List environment variables",
  description:
    "Names of a service's environment variables and where each lives: the task definition (plain), SSM Parameter Store or Secrets Manager (with the parameter/secret name), or an S3 env file. Never values — no operation reveals values. Also returns `revision`, which variables.update must quote, and whether editing is possible now (`canEdit`, `editWhy`). A reference other services read lists them in `sharedWith` (\"env/service\"); `lockedWhy` says why it can't be changed here (a protected or console-owned reader), and `protected` is true when a save follows the protected rules.",
  risk: "read",
  perm: "view",
  input: obj({ env: ENV, service: SERVICE }, ["env", "service"]),
  env: byEnv,
  run: async ({ env, service }, ctx) => {
    const v = await listVars(env, service, ctx.user);
    const shared = (l?: { env: string; service: string; self?: true }[]) => (l?.length ? l.map((x) => (x.self ? `${x.env}/${x.service} (this console)` : `${x.env}/${x.service}`)) : undefined);
    return compact({
      revision: v.revision, protected: v.protected, envProtected: v.envProtected, canEdit: v.canEdit, why: v.why, editWhy: v.editWhy, sharingUnknown: v.sharingUnknown,
      containers: v.containers,
      vars: v.vars.map((x) => compact({ container: x.container, name: x.name, source: x.source, ref: x.ref, file: x.file, sharedWith: shared(x.sharedWith), lockedWhy: x.lockedWhy })),
      files: v.files.map((f) => compact({ container: f.container, file: f.file, label: f.label, error: f.error, sharedWith: shared(f.sharedWith), lockedWhy: f.lockedWhy })),
    });
  },
});

type VarsInput = { env: string; service: string; revision: string; confirm: string; reason?: string; changes: Partial<VarChanges> & { plain?: { container: string; set?: Record<string, string>; remove?: string[] }[]; files?: { container: string; file: string; set?: Record<string, string>; remove?: string[] }[] } };

const normalizeChanges = (c: VarsInput["changes"]): VarChanges => ({
  plain: (c.plain ?? []).map((p) => ({ container: p.container, set: p.set ?? {}, remove: p.remove ?? [] })),
  secrets: c.secrets ?? [],
  files: (c.files ?? []).map((f) => ({ container: f.container, file: f.file, set: f.set ?? {}, remove: f.remove ?? [] })),
});

const NAMES: JsonSchema = { type: "array", maxItems: 100, items: { type: "string", maxLength: 255 }, description: "Variable names to remove." };
const SET: JsonSchema = { type: "object", description: "NAME → new value (strings). New names are added." };
const CONTAINER: JsonSchema = { type: "string", maxLength: 255, description: "Container name (from variables.list)." };

const variablesUpdate = op<VarsInput>({
  name: "variables.update",
  title: "Change environment variables",
  description:
    "Changes a service's environment variables. Plain (task-definition) values: registers a new revision and deploys it. Secret values (SSM / Secrets Manager, existing references only) and S3 env files: writes the new value, then restarts the service so new tasks read it. Quote `revision` from variables.list; if the service changed since, the save is refused — list again. Refused during a rollout, for invalid or reserved names, and on the console's own service. Values are never echoed back; the plan and audit log list names only.",
  risk: "change",
  perm: "env",
  input: obj(
    {
      env: ENV,
      service: SERVICE,
      revision: { type: "string", maxLength: 2048, description: "The `revision` (task definition ARN) returned by variables.list." },
      changes: {
        type: "object",
        additionalProperties: false,
        description: "What to change. At least one entry.",
        properties: {
          plain: { type: "array", maxItems: 20, items: obj({ container: CONTAINER, set: SET, remove: NAMES }, ["container"]), description: "Task-definition variables per container." },
          secrets: { type: "array", maxItems: 50, items: obj({ container: CONTAINER, name: { type: "string", maxLength: 255 }, value: { type: "string", maxLength: 32_768 } }, ["container", "name", "value"]), description: "New values for existing secret references." },
          files: { type: "array", maxItems: 20, items: obj({ container: CONTAINER, file: { type: "string", maxLength: 2048, description: "Env file S3 ARN (from variables.list `files`)." }, set: SET, remove: NAMES }, ["container", "file"]), description: "Edits to S3 env files." },
        },
      },
      confirm: CONFIRM,
      reason: REASON,
    },
    ["env", "service", "revision", "changes", "confirm"],
  ),
  secretFields: ["changes"],
  env: byEnv,
  // A reference a protected service reads makes the save protected even on an unprotected environment (R02).
  protectedOf: (i) => varsProtected(i.env, i.service),
  plan: async (i, ctx) => {
    const v = await listVars(i.env, i.service, ctx.user);
    const changes = normalizeChanges(i.changes);
    const where = (s: { source: string; where: string }) => (s.source === "plain" ? `task definition · ${s.where}` : s.source === "file" ? `env file · ${s.where.replace(/^arn:aws[\w-]*:s3:::/, "s3://")}` : "secret values");
    const lines = summarize(changes, v.vars).map((s) => `${where(s)}: ${[s.added.length && `add ${s.added.join(", ")}`, s.changed.length && `change ${s.changed.join(", ")}`, s.removed.length && `remove ${s.removed.join(", ")}`].filter(Boolean).join("; ")}`);
    const warnings: string[] = [];
    if (!lines.length) warnings.push("nothing to change");
    if (!v.canEdit) warnings.push(`refused right now: ${v.why}`);
    if (v.revision !== i.revision) warnings.push("the service changed since that revision was read — the save will be refused; list the variables again");
    if (v.protected && (!i.reason || i.reason.trim().length < 3)) warnings.push("a reason is required on a protected environment");
    const restart = changes.secrets.length || changes.files.length;
    return {
      summary: `Change ${summarize(changes, v.vars).reduce((n, s) => n + s.added.length + s.changed.length + s.removed.length, 0)} variable(s) of ${i.service} in ${i.env}${v.protected ? " (protected)" : ""}`,
      changes: [...lines, changes.plain.length ? "then: register a new task-definition revision and deploy it" : restart ? "then: restart the service so new tasks read the new values" : ""].filter(Boolean),
      warnings,
      confirm: v.protected ? i.service : "yes",
    };
  },
  // The audit actor rides in user.email: saveVars records whoever it is handed (with token name / approver).
  run: (i, ctx) => saveVars(i.env, i.service, { revision: i.revision, confirm: i.confirm, reason: i.reason, changes: normalizeChanges(i.changes) }, { ...ctx.user, email: ctx.actor }, ctx.ip),
});

// ---------- CI ----------

const ciRuns = op<{ repo?: string; branch?: string; limit?: number }>({
  name: "ci.runs",
  title: "CI runs",
  description:
    "Recent GitHub Actions runs, newest first: id, repository, workflow, branch, short sha, title, who triggered it, status and conclusion, attempt and link. Give `repo` (owner/name, the `repo` of a service in services.get) or leave it out for runs across every repository mapped to a service. Only repositories mapped to discovered services can be read.",
  risk: "read",
  perm: "view",
  input: obj({
    repo: { type: "string", pattern: "^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$", description: "GitHub repository owner/name." },
    branch: { type: "string", maxLength: 255, description: "Only runs on this branch." },
    limit: { type: "integer", minimum: 1, maximum: 50, default: 15, description: "How many runs (default 15)." },
  }),
  run: async ({ repo, branch, limit }) => {
    const repos = repo ? [await assertRepo(repo)] : (await knownRepos()).slice(0, 10);
    const all = (await Promise.all(repos.map((r) => runs(r, branch).catch(() => [])))).flat();
    return all
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
      .slice(0, limit ?? 15)
      .map((r) => ({ id: r.id, repo: r.repo, workflow: r.workflow, branch: r.branch, sha: sha7(r.sha), title: cut(r.title, 200), actor: r.actor, status: r.status, conclusion: r.conclusion, attempt: r.attempt, createdAt: r.createdAt, url: r.url }));
  },
});

type RerunInput = { repo: string; run: number; mode?: RerunMode; failedOnly?: boolean; confirm: string; reason?: string };
// failedOnly is the older spelling of mode "tests".
const modeOf = (i: RerunInput): RerunMode => i.mode ?? (i.failedOnly ? "tests" : "redeploy");

// A deploy workflow on a protected environment's branch is a deploy to that environment: the registry treats the
// re-run as touching it (protected permission, approval for tokens). deployTarget() says where and how sure (R03).
async function rerunTarget(i: RerunInput) {
  const repo = await assertRepo(i.repo);
  const run = await (await getCi()).run(repo, i.run);
  return { run, ...(await deployTarget(run)) };
}

const ciRerun = op<RerunInput>({
  name: "ci.rerun",
  title: "Re-run CI",
  description:
    "Re-runs a completed GitHub Actions run. mode \"tests\" re-runs the failed jobs and is refused for a workflow that deploys (use \"redeploy\"); mode \"redeploy\" re-runs every job. Re-running a deploy workflow bound to a protected environment — or an unbound one on a protected environment's branch, which counts as a deploy there — needs the protected permission, the environment id as confirmation and a reason. Refused while the run is still in progress. Returns the operation id.",
  risk: "change",
  perm: "ci:rerun",
  input: obj(
    {
      repo: { type: "string", pattern: "^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$", description: "GitHub repository owner/name." },
      run: { type: "integer", minimum: 1, description: "Run id (from ci.runs)." },
      mode: { type: "string", enum: ["tests", "redeploy"], description: "tests: re-run the failed jobs (not for deploy workflows). redeploy: re-run every job. Default: redeploy (tests when failedOnly is true)." },
      failedOnly: { type: "boolean", description: "Older spelling of mode \"tests\"." },
      confirm: CONFIRM,
      reason: REASON,
    },
    ["repo", "run", "confirm"],
  ),
  env: async (i) => (await rerunTarget(i)).protectedEnv?.id,
  plan: async (i) => {
    const t = await rerunTarget(i);
    const mode = modeOf(i);
    // The same rules rerunCiRun() enforces (ci-rules.ts), so the plan never promises what the run refuses.
    const rules = rerunRules(t, mode);
    const warnings: string[] = [];
    if (t.run.status !== "completed") warnings.push("the run is still in progress — the re-run will be refused");
    if (rules.refused) warnings.push(rules.refused);
    if (t.scope === "protected-branch-unknown") warnings.push(t.why);
    if (t.protectedEnv) warnings.push(`this re-runs a deploy to ${t.protectedEnv.label} (protected)`);
    if (rules.needsReason && (!i.reason || i.reason.trim().length < 3)) warnings.push("a reason is required for a deploy to a protected environment");
    return {
      summary: `Re-run ${t.run.workflow} #${t.run.id} on ${t.run.branch} (${mode === "tests" ? "failed jobs" : "all jobs"})`,
      changes: [`${i.repo} @ ${sha7(t.run.sha)}: ${cut(t.run.title, 120)}`, ...(t.env && t.scope !== "none" ? [`deploys to: ${t.env.label}${t.scope === "bound" ? "" : " (by branch)"}`] : [])],
      warnings,
      confirm: rules.confirm,
    };
  },
  // rerunCiRun() (ci.ts) holds the whole re-run path — classification, permission, the protected confirmation and the
  // coordinator — shared with the route. The coordinator records the token or approval behind this call.
  run: async (i, ctx) => {
    const r = await rerunCiRun(i.run, { repo: i.repo, mode: modeOf(i), confirm: i.confirm, reason: i.reason, actor: whoOf(ctx) }, ctx.user, ctx.ip);
    if (!("result" in r)) throw new HttpError(400, "confirm is required");
    return r.result;
  },
});

// ---------- audit, issues, releases ----------

const auditRecent = op<{ limit?: number; env?: string; action?: string }>({
  name: "audit.recent",
  title: "Recent audit log",
  description:
    "The console's audit log, newest first: every action (intent before, result after), variable changes and reveals (names only), CI re-runs, sign-ins and admin changes — who, when, target, environment, reason and result. Agents appear as `<person> via token \"<name>\"`, approved requests as `<approver> approving token \"<name>\"`.",
  risk: "read",
  perm: "view",
  input: obj({
    limit: { type: "integer", minimum: 1, maximum: 200, default: 50, description: "How many entries (default 50)." },
    env: ENV,
    action: { type: "string", maxLength: 100, description: "Only entries whose action starts with this (e.g. \"services.\", \"env.\", \"auth.\")." },
  }),
  run: async ({ limit, env, action }) => {
    const rows = await auditLog(action ? 500 : (limit ?? 50), env);
    return rows
      .filter((r) => !action || r.action.startsWith(action))
      .slice(0, limit ?? 50)
      .map((r) => {
        const params = JSON.stringify(r.params ?? {});
        return compact({ at: iso(r.at), phase: r.phase, env: r.env || undefined, target: r.target || undefined, action: r.action, user: r.user, result: r.result, reason: r.reason, detail: r.detail ? cut(r.detail, 300) : undefined, params: params.length > 2 && params.length <= 600 ? r.params : undefined });
      });
  },
});

const PROBLEM = new Set<State>(["DOWN", "DEGRADED", "UNKNOWN"]);
const issuesList = op<Record<string, never>>({
  name: "issues.list",
  title: "Current issues",
  description: "Everything that is down, degraded or unreadable, across every environment, worst first: environment, resource key, name, state, reasons and since when. An environment the background sampler hasn't read recently is one UNKNOWN entry (\"not sampled since …\"); EC2 hosts launched for a cluster that never joined it are listed too. An empty list means all clear.",
  risk: "read",
  perm: "view",
  input: obj({}),
  run: async () => {
    const envs = await listEnvs();
    const all = await Promise.all(
      envs.map(async (e) => {
        // A stale sample is never reported as current: read the environment now instead (light: describes only).
        const s = samplerStatus(e.id);
        const o = (s.stale ? undefined : latestOverview(e.id)) ?? (await overview(e.id, { light: true }).catch(() => undefined));
        if (!o) return [{ env: e.id, key: "env", name: e.label, state: "UNKNOWN" as State, reasons: [s.reason ?? "could not read this environment"] }];
        return [...o.services, ...o.infra].filter((r) => PROBLEM.has(r.state)).map((r) => compact({ env: e.id, protected: e.protected || undefined, key: r.key, kind: r.kind, name: r.name, state: r.state, reasons: r.reasons.slice(0, 5), since: iso(uptime(`${e.id}/${r.key}`).since) }));
      }),
    );
    const hosts = (await hostIssues().catch(() => [])).map((h) => ({ env: h.env, key: `box:${h.id}`, kind: "box", name: h.id, state: "DEGRADED" as State, reasons: [h.reason], since: iso(h.at) }));
    return [...all.flat(), ...hosts].sort((a, b) => byState(a as { state: State }, b as { state: State }));
  },
});

const releasesCompare = op<{ service?: string }>({
  name: "releases.compare",
  title: "Compare releases across environments",
  description:
    "For each service with a repository: which commit and revision every environment runs (in promotion order, e.g. staging before production), and for each next environment how many commits it is behind, their titles (up to 10) and whether database migrations are among them. Use to answer \"what would go out if we promoted staging?\".",
  risk: "read",
  perm: "view",
  input: obj({ service: { type: "string", maxLength: 255, description: "Only this service (ECS service name)." } }),
  run: async ({ service }) =>
    (await releases())
      .filter((r) => !service || r.service === service)
      .map((r) => compact({
        service: r.service, name: r.name, repo: r.repo, note: r.note,
        stages: r.stages.map((s) => compact({ env: s.env, protected: s.protected || undefined, sha: sha7(s.sha), revision: s.revision, state: s.state })),
        steps: r.steps.map((s) => compact({ from: s.from, to: s.to, behind: s.aheadBy, migrations: s.migrations || undefined, commits: s.commits.slice(0, 10).map((c) => `${sha7(c.sha)} ${cut(c.title, 100)}`), note: s.note })),
      })),
});

export const ops: AnyOperation[] = [
  envsList, envsStatus, issuesList,
  servicesGet, servicesEvents, servicesRevisions, ...actionOps,
  hostsPower, databasesPower,
  logsRecent, logsSearch, metricsGet,
  variablesList, variablesUpdate,
  ciRuns, ciRerun,
  auditRecent, releasesCompare,
];
