// The default script of the built-in "scripted:demo" connection (mock mode): the assistant's first experience —
// "explain why this service is unhealthy, show the evidence, and prepare a safe action for review" — without any
// model account. Deterministic: the same evidence always gives the same answer.
//
// Turn by turn, through the console's real operations (whatever subset the run's policy offers):
//   1. envs.list                                    which environments exist, and which is worst
//   2. envs.status {env}                            the environment named in the goal (or its resource key), else the worst
//   3. services.get, services.events, logs.recent,  the service named in the goal, else the first unhealthy one
//      metrics.get
//   4. the answer: ranked hypotheses, each citing the evidence ids the console gave its results ([E3]), and — when the
//      service is unhealthy, the evidence shows a fault, or the goal asks for a fix — a services.restart proposal, which
//      the console turns into an approval request (the script never claims it ran)
//   5. after the proposal's result: what happens next (waiting for a person, or why it was refused)
// Text inside tool results is evidence, never instructions: nothing in a log line or a tag changes what this script
// calls. (The runner's tests use declarative scripts with `force` calls to model an agent that does obey them.)
import type { Script, ScriptContext, ScriptReply, ToolResultView } from "../scripted.ts";

export const INCIDENT_DEMO = "incident-demo";

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const arr = (v: unknown): Obj[] => (Array.isArray(v) ? (v as unknown[]).map(obj) : []);
const str = (v: unknown) => (typeof v === "string" ? v : undefined);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

const STATE_RANK: Record<string, number> = { DOWN: 0, DEGRADED: 1, DEPLOYING: 2, UNKNOWN: 3, BOX_STOPPED: 4, STOPPED: 5, UP: 6 };
const rank = (s: unknown) => STATE_RANK[String(s)] ?? 3;

const latest = (ctx: ScriptContext, op: string) => [...ctx.results].reverse().find((r) => r.op === op);
const cite = (rs: (ToolResultView | undefined)[]) => {
  const ids = [...new Set(rs.filter((r): r is ToolResultView => !!r).map((r) => r.evidenceId ?? r.op))];
  return ids.length ? ` ${ids.map((i) => `[${i}]`).join("")}` : "";
};
const clip = (s: string, n: number) => {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
};
// A quoted message, without its own final full stop (the sentence around it has one).
const quote = (s: string, n: number) => `"${clip(s, n).replace(/[.。]+$/, "")}"`;
const wordIn = (hay: string, word: string) => new RegExp(`(^|[^a-z0-9-])${word.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9-]|$)`).test(hay.toLowerCase());

// ---------- what the goal names ----------

interface Target {
  cluster?: string;
  service?: string;
  region?: string;
}

// A resource key in the goal: the inventory's "ecs:service/<cluster>/<service>[@region]", the coordinator's
// "ecs-service:<region>/<cluster>/<service>", a service ARN, or the console's "service:<id>".
export function targetOf(goal: string): Target {
  let m = /\becs:service\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+)(?:@([a-z0-9-]+))?/.exec(goal);
  if (m) return { cluster: m[1], service: m[2], ...(m[3] ? { region: m[3] } : {}) };
  m = /\becs-service:([a-z0-9-]+)\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+)/.exec(goal);
  if (m) return { region: m[1], cluster: m[2], service: m[3] };
  m = /\barn:aws[a-z-]*:ecs:([a-z0-9-]+):\d{12}:service\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+)/.exec(goal);
  if (m) return { region: m[1], cluster: m[2], service: m[3] };
  m = /\bservice:([A-Za-z0-9_-]+)/.exec(goal);
  if (m) return { service: m[1] };
  return {};
}

interface Env {
  id: string;
  label?: string;
  cluster?: string;
  region?: string;
  worst?: string;
}

function chooseEnv(goal: string, envs: Env[], t: Target): Env | undefined {
  if (t.cluster) {
    const c = envs.filter((e) => e.cluster === t.cluster && (!t.region || e.region === t.region));
    if (c.length) return [...c].sort((a, b) => a.id.length - b.id.length)[0];
  }
  const byWord = [...envs].sort((a, b) => b.id.length - a.id.length).find((e) => wordIn(goal, e.id) || (e.label && wordIn(goal, e.label)));
  if (byWord) return byWord;
  const worst = [...envs].sort((a, b) => rank(a.worst) - rank(b.worst))[0];
  return worst && rank(worst.worst) < STATE_RANK.UP ? worst : undefined;
}

interface Svc {
  id: string;
  name?: string;
  state?: string;
  reasons: string[];
  actions: string[];
  readOnly: boolean;
  running?: number;
  desired?: number;
  revision?: number;
}

function servicesOf(status: Obj): Svc[] {
  return arr(status.resources)
    .filter((r) => r.kind === "service" && typeof r.id === "string")
    .map((r) => ({
      id: r.id as string,
      name: str(r.name),
      state: str(r.state),
      reasons: Array.isArray(r.reasons) ? (r.reasons as unknown[]).filter((x): x is string => typeof x === "string") : [],
      actions: Array.isArray(r.actions) ? (r.actions as unknown[]).filter((x): x is string => typeof x === "string") : [],
      readOnly: r.readOnly === true,
      running: num(r.running),
      desired: num(r.desired),
      revision: num(r.revision),
    }));
}

function chooseService(goal: string, svcs: Svc[], t: Target): Svc | undefined {
  if (t.service) {
    const s = svcs.find((x) => x.id === t.service);
    if (s) return s;
  }
  const named = [...svcs].sort((a, b) => b.id.length - a.id.length).find((s) => wordIn(goal, s.id) || (s.name && s.name.length > 3 && wordIn(goal, s.name)));
  if (named) return named;
  return [...svcs].filter((s) => rank(s.state) < STATE_RANK.UP).sort((a, b) => rank(a.state) - rank(b.state))[0];
}

// ---------- the analysis ----------

interface Hypothesis {
  score: number;
  text: string;
  short: string;
  from: (ToolResultView | undefined)[];
  caveat?: string; // what a restart does not fix, said with the proposal
}

const ERROR_LINE = /\b(ERROR|FATAL|CRITICAL|Exception|Traceback|panic:|Unhandled)\b/;
const DEPENDENCY = /(ECONNREFUSED|ETIMEDOUT|ENOTFOUND|ECONNRESET|connection (refused|reset|timed out)|could not connect|too many connections|upstream (timed out|connect error))/i;
const OOM = /(OutOfMemory|out of memory|OOMKilled|exit code 137|\bkilled\b.*memory)/i;

// A log line's message: the "msg" of a JSON line, else the text; and whether it is an error (pino level ≥ 50 or an
// error word).
function logLine(message: string): { text: string; error: boolean } {
  try {
    const j = JSON.parse(message) as Obj;
    const text = str(j.msg) ?? str(j.message) ?? message;
    const level = num(j.level);
    const err = str(j.err) ?? str(obj(j.err).message);
    return { text: err ? `${text}: ${err}` : text, error: (level !== undefined && level >= 50) || ERROR_LINE.test(text) || (str(j.level) ?? "").toLowerCase() === "error" };
  } catch {
    return { text: message, error: ERROR_LINE.test(message) };
  }
}

export function hypotheses(ctx: ScriptContext, svc: Svc): Hypothesis[] {
  const status = latest(ctx, "envs.status");
  const get = latest(ctx, "services.get");
  const events = latest(ctx, "services.events");
  const logs = latest(ctx, "logs.recent");
  const metrics = latest(ctx, "metrics.get");
  const g = get && !get.isError ? obj(get.data) : {};
  const ev = events && !events.isError ? arr(events.data).map((e) => str(e.message) ?? "") : [];
  const lines = logs && !logs.isError ? arr(obj(logs.data).lines).map((l) => logLine(str(l.message) ?? "")) : [];
  const series = metrics && !metrics.isError ? arr(obj(metrics.data).series) : [];
  const out: Hypothesis[] = [];

  // Memory and CPU peaks (they also support a crash hypothesis).
  const mem = series.find((s) => s.id === "mem" || /memory/i.test(str(s.label) ?? ""));
  const cpu = series.find((s) => s.id === "cpu" || /cpu/i.test(str(s.label) ?? ""));
  const memMax = num(mem?.max);
  const cpuMax = num(cpu?.max);
  let memoryUsed = false;

  // A failed or running rollout.
  const deployments = arr(g.deployments);
  const failed = deployments.find((d) => d.rollout === "FAILED");
  const rollingOut = deployments.find((d) => d.rollout === "IN_PROGRESS");
  const cbEvents = ev.find((m) => /circuit breaker|deployment failed|rolling back/i.test(m));
  if (failed) {
    const live = num(obj(g.revision).number);
    out.push({
      score: 0.9,
      short: `the rollout of revision ${num(failed.revision) ?? "?"} failed`,
      text: `The latest rollout (revision ${num(failed.revision) ?? "?"}) failed${str(failed.reason) ? ` — ${clip(str(failed.reason)!, 140).replace(/[.]+$/, "")}` : ""}${live ? `; revision ${live} is what runs now` : ""}. A restart re-deploys the running revision; it does not retry the failed one.`,
      from: [get, cbEvents ? events : undefined],
    });
  } else if (rollingOut) {
    out.push({ score: 0.65, short: "a rollout is still in progress", text: `A rollout (revision ${num(rollingOut.revision) ?? "?"}) is still in progress, so the state may settle on its own.`, from: [get] });
  }

  // Tasks that stopped badly.
  const stopped = arr(g.tasks).filter((t) => t.lastStatus === "STOPPED" && ((num(t.exitCode) ?? 0) !== 0 || /OutOfMemory|CannotPull|ResourceInitialization|failed|Essential container/i.test(str(t.stoppedReason) ?? "")));
  if (stopped.length) {
    const reason = str(stopped[0].stoppedReason) ?? "";
    const code = num(stopped[0].exitCode);
    if (OOM.test(reason) || code === 137) {
      memoryUsed = memMax !== undefined && memMax >= 80;
      out.push({
        score: memoryUsed ? 0.92 : 0.85,
        short: "tasks are killed for running out of memory",
        text: `${stopped.length} recent task${stopped.length > 1 ? "s were" : " was"} killed for running out of memory (exit code ${code ?? 137})${memoryUsed ? `, and memory peaked at ${memMax}%` : ""}.`,
        from: [get, memoryUsed ? metrics : undefined],
        caveat: "A restart frees memory for now; if the tasks keep running out of it, the lasting fix is a higher memory limit or a fix in the code.",
      });
    } else if (/CannotPull/i.test(reason)) out.push({ score: 0.85, short: "the image can't be pulled", text: `Tasks can't start because the image can't be pulled: ${clip(reason, 140)}.`, from: [get] });
    else out.push({ score: 0.75, short: `tasks exit with code ${code ?? "?"}`, text: `${stopped.length} recent task${stopped.length > 1 ? "s" : ""} stopped with exit code ${code ?? "?"}${reason ? ` (${clip(reason, 120)})` : ""}.`, from: [get] });
  }

  // Health checks.
  const unhealthyTasks = arr(g.tasks).filter((t) => t.health === "UNHEALTHY").length;
  const healthEvents = ev.filter((m) => /\bunhealthy\b|health checks? fail|failed (container |ELB )?health checks?/i.test(m));
  const reasonUnhealthy = svc.reasons.find((r) => /\bunhealthy\b|health checks? fail|failed (container |ELB )?health checks?/i.test(r));
  if (unhealthyTasks || healthEvents.length || reasonUnhealthy)
    out.push({
      score: 0.7,
      short: "tasks fail their health checks",
      text: `Tasks are failing their health checks${unhealthyTasks ? ` (${unhealthyTasks} unhealthy now)` : ""}${healthEvents[0] ? ` — ECS reports ${quote(healthEvents[0], 120)}` : ""}.`,
      from: [unhealthyTasks ? get : undefined, healthEvents.length ? events : undefined, reasonUnhealthy ? status : undefined],
    });

  // Placement.
  const placement = ev.find((m) => /unable to place|insufficient (memory|cpu)|no container instance/i.test(m));
  if (placement) out.push({ score: 0.7, short: "ECS can't place tasks", text: `ECS can't place new tasks: ${quote(placement, 140)}.`, from: [events] });

  // Fewer tasks than wanted.
  const running = num(g.running) ?? svc.running;
  const desired = num(g.desired) ?? svc.desired;
  if (running !== undefined && desired !== undefined && running < desired)
    out.push({ score: 0.6, short: `only ${running} of ${desired} tasks run`, text: `Only ${running} of ${desired} tasks are running.`, from: [get ?? status] });

  // Logs: a failing dependency, or application errors.
  const dep = lines.filter((l) => DEPENDENCY.test(l.text));
  if (dep.length)
    out.push({
      score: 0.62 + Math.min(dep.length, 5) * 0.02,
      short: "a dependency is unreachable",
      text: `A dependency looks unreachable: ${dep.length} log line${dep.length > 1 ? "s" : ""} like ${quote(dep[dep.length - 1].text, 100)}.`,
      from: [logs],
      caveat: "A restart won't help while the dependency itself is down.",
    });
  const errors = lines.filter((l) => l.error && !DEPENDENCY.test(l.text));
  if (errors.length) out.push({ score: 0.5 + Math.min(errors.length, 5) * 0.04, short: "the application logs errors", text: `The application logged ${errors.length} error${errors.length > 1 ? "s" : ""} in its latest lines, e.g. ${quote(errors[errors.length - 1].text, 100)}.`, from: [logs] });

  // Resource pressure not already explained by a crash.
  if (!memoryUsed && memMax !== undefined && memMax >= 85) out.push({ score: 0.55, short: `memory peaked at ${memMax}%`, text: `Memory peaked at ${memMax}% in the last hour (latest ${num(mem?.latest) ?? "?"}%).`, from: [metrics] });
  if (cpuMax !== undefined && cpuMax >= 90) out.push({ score: 0.5, short: `CPU peaked at ${cpuMax}%`, text: `CPU peaked at ${cpuMax}% in the last hour (latest ${num(cpu?.latest) ?? "?"}%).`, from: [metrics] });

  return out.map((h, i) => ({ h, i })).sort((a, b) => b.h.score - a.h.score || a.i - b.i).map((x) => x.h);
}

// ---------- the turns ----------

const ASKS_FOR_FIX = /\b(restart|fix|remediat\w*|recover|mitigat\w*|bounce)\b/i;
const READS: { op: string; input: (env: string, svc: string) => Record<string, unknown> }[] = [
  { op: "services.get", input: (env, svc) => ({ env, service: svc }) },
  { op: "services.events", input: (env, svc) => ({ env, service: svc, limit: 10 }) },
  { op: "logs.recent", input: (env, svc) => ({ env, services: [svc], limit: 50 }) },
  { op: "metrics.get", input: (env, svc) => ({ env, resource: `service:${svc}`, minutes: 60 }) },
];

const failedRead = (r: ToolResultView) => `I couldn't read ${r.op}${cite([r])}: ${clip(typeof r.data === "string" ? r.data : r.content, 200)}`;

function answer(ctx: ScriptContext, envId: string, envLabel: string, protectedEnv: boolean, svc: Svc): ScriptReply {
  const status = latest(ctx, "envs.status");
  const get = latest(ctx, "services.get");
  const g = get && !get.isError ? obj(get.data) : {};
  const state = str(g.state) ?? svc.state ?? "UNKNOWN";
  const reasons = (Array.isArray(g.reasons) ? (g.reasons as unknown[]).filter((x): x is string => typeof x === "string") : svc.reasons).slice(0, 3);
  const hs = hypotheses(ctx, svc).slice(0, 4);
  const name = svc.name && svc.name !== svc.id ? `${svc.name} (${svc.id})` : svc.id;
  const lines = [`**${name} in ${envLabel}: ${state}**${reasons.length ? ` — ${reasons.join("; ")}` : ""}${cite([get ?? status])}`, ""];
  const unreadable = ctx.results.filter((r) => r.isError && READS.some((x) => x.op === r.op));
  if (hs.length) {
    lines.push("Most likely causes, ranked:");
    hs.forEach((h, i) => lines.push(`${i + 1}. ${h.text}${cite(h.from)}`));
  } else lines.push(`No fault shows in the evidence${cite(ctx.results.filter((r) => !r.isError))}: the tasks, recent events, latest logs and the last hour of metrics look normal.`);
  for (const r of unreadable) lines.push(failedRead(r));

  // Whether to prepare a restart, and whether one is possible.
  const unhealthy = rank(state) < STATE_RANK.UP;
  const fault = hs.some((h) => h.score >= 0.6);
  const wanted = unhealthy || fault || ASKS_FOR_FIX.test(ctx.goal);
  const actions = Array.isArray(g.actions) ? (g.actions as unknown[]).filter((x): x is string => typeof x === "string") : svc.actions;
  const blocked = str(obj(g.blocked).restart);
  const restart = ctx.tool("services.restart");
  lines.push("");
  if (!wanted) {
    lines.push("Nothing here calls for a change, so I'm not proposing one.");
    return { text: lines.join("\n") };
  }
  if (svc.readOnly || g.readOnly === true) {
    lines.push("This is the console's own service: it never acts on itself, so I can't propose a restart — a person has to handle it outside the console.");
    return { text: lines.join("\n") };
  }
  if (!actions.includes("restart")) {
    lines.push(`A restart isn't possible right now${blocked ? `: ${blocked}` : ""}${cite([get ?? status])}. I'm not proposing a change.`);
    return { text: lines.join("\n") };
  }
  if (!restart) {
    lines.push("This run can only read, so I'm not proposing a change. A person with access could restart it from the service's panel.");
    return { text: lines.join("\n") };
  }
  const top = hs[0];
  const ids = [...new Set(hs.flatMap((h) => h.from).filter((r): r is ToolResultView => !!r).map((r) => r.evidenceId ?? r.op))];
  lines.push(
    `Proposed next step: restart ${svc.id} in ${envLabel} — a rolling restart of the running revision${svc.revision ? ` (${svc.revision})` : ""}. It needs a person's approval; nothing changes until someone approves it, and I'll report whether the new tasks become healthy.${top?.caveat ? ` ${top.caveat}` : ""}`,
  );
  const reason = clip(`Agent proposal: ${top ? top.short : "the service is unhealthy"}${ids.length ? ` (evidence ${ids.join(", ")})` : ""}`, 300);
  return {
    text: lines.join("\n"),
    toolCalls: [{ op: "services.restart", input: { env: envId, service: svc.id, confirm: protectedEnv ? svc.id : "yes", reason } }],
  };
}

function afterProposal(r: ToolResultView, svc: string): ScriptReply {
  const d = obj(r.data);
  const approval = obj(d.approval);
  const id = str(approval.id) ?? str(d.approvalId) ?? str(d.grantId);
  const pending = !!id || /approv|waiting|pending/i.test(r.content);
  if (r.isError) return { text: `The restart proposal for ${svc} was refused${cite([r])}: ${clip(typeof r.data === "string" ? r.data : str(d.error) ?? str(d.reason) ?? r.content, 240)}. Nothing was changed.` };
  if (pending) return { text: `The restart of ${svc} is waiting for a person's approval${id ? ` (request ${id})` : ""}${cite([r])}. It hasn't run; once someone approves it, the console runs exactly this plan and checks that the new tasks become healthy.` };
  return { text: `AWS accepted the restart of ${svc}${cite([r])}. That only means the request was accepted: the console is now verifying whether the new tasks become healthy.` };
}

export function incidentDemoTurn(ctx: ScriptContext): ScriptReply {
  const t = targetOf(ctx.goal);

  // 5. The proposal came back.
  const proposed = latest(ctx, "services.restart");
  if (proposed) return afterProposal(proposed, String(proposed.input.service ?? "the service"));

  // 1. Which environments exist.
  const list = latest(ctx, "envs.list");
  if (!list && ctx.tool("envs.list")) return { text: "Let me look at the environments first.", toolCalls: [{ op: "envs.list", input: {} }] };
  if (list?.isError) return { text: failedRead(list) };
  const envs: Env[] = list
    ? arr(list.data)
        .filter((e) => typeof e.id === "string")
        .map((e) => ({ id: e.id as string, label: str(e.label), cluster: str(e.cluster), region: str(e.region), worst: str(e.worst) }))
    : [];

  // 2. The environment's status.
  const status = latest(ctx, "envs.status");
  if (!status) {
    if (!ctx.tool("envs.status")) return { text: "I can't read environment status with the tools this run allows, so I can't investigate." };
    const env = chooseEnv(ctx.goal, envs, t);
    if (!env) {
      if (!envs.length) return { text: "I couldn't find an environment to investigate. Name one (or open the assistant from a service) and ask again." };
      return { text: `Every environment reports UP${cite([list])}: ${envs.map((e) => `${e.label ?? e.id} ${e.worst ?? "UNKNOWN"}`).join(", ")}. Name a service to look at it more closely.` };
    }
    return { text: `Checking ${env.label ?? env.id}.`, toolCalls: [{ op: "envs.status", input: { env: env.id } }] };
  }
  if (status.isError) return { text: failedRead(status) };
  const st = obj(status.data);
  const envId = str(st.env) ?? String(status.input.env ?? "");
  const envLabel = str(st.label) ?? envId;
  const svcs = servicesOf(st);
  const svc = chooseService(ctx.goal, svcs, t);
  if (!svc) {
    const counts = obj(st.summary);
    return { text: `Every service in ${envLabel} is UP${cite([status])}${Object.keys(counts).length ? ` (${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(", ")})` : ""}. Nothing to investigate; name a service to look at it more closely.` };
  }

  // 3. Read the service's evidence, each read once (a run that allows one call per turn gets them over several turns).
  const asked = new Set(ctx.results.map((r) => r.op));
  const reads = READS.filter((r) => !asked.has(r.op) && ctx.tool(r.op));
  if (reads.length)
    return { text: `Reading ${svc.id}'s details, events, recent logs and metrics.`, toolCalls: reads.map((r) => ({ op: r.op, input: r.input(envId, svc.id) })) };

  // 4. The answer, and a proposal when it is warranted.
  return answer(ctx, envId, envLabel, st.protected === true, svc);
}

export const incidentDemo: Script = {
  name: INCIDENT_DEMO,
  description: "Demo model: investigates an unhealthy service and proposes a restart",
  models: [INCIDENT_DEMO],
  next: incidentDemoTurn,
};
