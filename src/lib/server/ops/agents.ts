// Agent-platform operations (master plan §6 C7 item 6): start and follow runs, list workflows, compare variables
// across environments, and check what happened to a change — operation records with their safe fields only, so an
// external agent can see an outcome (including outcome_unknown) without sending the change again. Registered in
// ops/index.ts as `agentOps` (the wave-C cross-package step).
//
// runs.start is a change in an administrative area: agents can never call it (HARD_DENY in src/lib/agents/policy.ts);
// people and API tokens start a published workflow or an assistant run with their own rights. Reads show a caller its
// own runs and operations: an agent only its run, an API token its owner's runs and its own operations.
import "server-only";
import type { AgentRunRow, AgentStepRow } from "../../agents/records.ts";
import { can } from "../../rbac.ts";
import type { OperationView } from "../../types.ts";
import { getRun, getSteps, listRuns } from "../agents/store.ts";
import { listWorkflows, startManualRun } from "../agents/workflows.ts";
import { getDb } from "../db.ts";
import { catalog, listEnvs } from "../discovery.ts";
import { varFingerprints } from "../envvars.ts";
import { HttpError, errText } from "../errors.ts";
import { getOperation, listOperations } from "../operations.ts";
import { defineOps, type JsonSchema, type OpContext } from "./types.ts";

const obj = (properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema => ({ type: "object", properties, required, additionalProperties: false });
const UUID: JsonSchema = { type: "string", pattern: "^[0-9a-fA-F-]{36}$" };
const ENV: JsonSchema = { type: "string", pattern: "^[a-z0-9][a-z0-9-]{0,62}$" };
const SERVICE: JsonSchema = { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9_-]{0,254}$" };
const RUN_STATES = ["queued", "running", "waiting_approval", "waiting_external", "paused_auth", "paused_budget", "succeeded", "failed", "cancelled", "outcome_unknown"];
const OP_STATES = ["queued", "running", "succeeded", "failed", "outcome_unknown", "cancelled"];
const iso = (ms?: number | null) => (ms ? new Date(Number(ms)).toISOString() : undefined);
const compact = <T extends Record<string, unknown>>(o: T) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
const parse = <T>(s: string | null, fallback: T): T => {
  try {
    return s ? (JSON.parse(s) as T) : fallback;
  } catch {
    return fallback;
  }
};

// ---------- runs ----------

// Which runs a caller may read: an agent its own run; anyone else the runs they started (admins: all).
function mayReadRun(run: AgentRunRow, ctx: OpContext): boolean {
  if (ctx.via === "agent") return !!ctx.principal?.runId && run.id === ctx.principal.runId;
  if (ctx.via !== "token" && can(ctx.user, "admin")) return true;
  return run.initiator_id === ctx.user.id;
}

const runBrief = (r: AgentRunRow) =>
  compact({
    id: r.id, kind: r.kind, title: r.title ?? undefined, state: r.state, createdAt: iso(r.created_at), updatedAt: iso(r.updated_at), finishedAt: iso(r.finished_at),
    workflow: r.workflow_id ? { id: r.workflow_id, version: r.workflow_version } : undefined, resourceKey: r.resource_key ?? undefined, error: r.error ? r.error.slice(0, 300) : undefined,
  });

const stepBrief = (s: AgentStepRow) => {
  const result = parse<Record<string, unknown>>(s.result, {});
  const report = result.report && typeof result.report === "object" ? (result.report as { headline?: unknown }).headline : undefined;
  return compact({
    seq: s.seq, kind: s.kind, name: s.name ?? undefined, state: s.state, at: iso(s.updated_at), error: s.error ? s.error.slice(0, 300) : undefined, operationId: s.operation_id ?? undefined,
    report: typeof report === "string" ? report : undefined, approvalId: (result.approval as { id?: string } | undefined)?.id,
  });
};

// The safe fields of an operation record: never its parameters, hashes or raw result.
const opView = (o: OperationView) =>
  compact({ id: o.id, action: o.action, target: o.target, env: o.env, region: o.region, actor: o.actorDisplay, state: o.state, verify: o.verify ?? undefined, createdAt: iso(o.createdAt), finishedAt: iso(o.finishedAt), verifiedAt: iso(o.verifiedAt), detail: o.detail });

type StartIn = { workflowId?: string; inputs?: Record<string, unknown>; resourceKey?: string; goal?: string; connectionId?: string };

async function startRun(i: StartIn, ctx: OpContext) {
  if (ctx.via === "agent") throw new HttpError(403, "agents can never start runs");
  if (!!i.workflowId === !!i.goal) throw new HttpError(400, "give a workflowId (a published workflow) or a goal (an assistant run), not both");
  if (i.workflowId) {
    const runId = await startManualRun(ctx.user, i.workflowId, i.inputs, i.resourceKey);
    const run = await getRun(runId);
    return { runId, kind: "workflow", workflow: run?.workflow_id ? { id: run.workflow_id, version: run.workflow_version } : undefined, state: run?.state };
  }
  if (!i.connectionId) throw new HttpError(400, "an assistant run needs a connectionId (who pays for the model)");
  const m = (await import("../agents/runner.ts")) as unknown as { startRun?: (input: Record<string, unknown>) => Promise<string | { runId: string }> };
  if (typeof m.startRun !== "function") throw new HttpError(503, "the agent runner isn't available on this console");
  const r = await m.startRun({ kind: "assistant", initiator: ctx.user, connectionId: i.connectionId, goal: i.goal, resourceKey: i.resourceKey });
  const runId = typeof r === "string" ? r : r.runId;
  return { runId, kind: "assistant", state: (await getRun(runId))?.state };
}

async function runDetail(id: string, ctx: OpContext) {
  const run = await getRun(id);
  if (!run || !mayReadRun(run, ctx)) throw new HttpError(404, "no such run");
  const steps = await getSteps(id);
  const ops = await listOperations({ runId: id, limit: 50 }).catch(() => []);
  const pending = await (await getDb()).all<{ id: string; op: string; plan: string | null }>("SELECT id, op, plan FROM approvals WHERE run_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 20", [id]);
  return {
    ...runBrief(run),
    steps: steps.slice(-100).map(stepBrief),
    ...(steps.length > 100 ? { earlierSteps: steps.length - 100 } : {}),
    operations: ops.map(opView),
    pendingApprovals: pending.map((a) => ({ id: a.id, op: a.op, summary: String(parse<{ summary?: unknown }>(a.plan, {}).summary ?? a.op).slice(0, 300) })),
  };
}

async function runList(i: { state?: string; kind?: AgentRunRow["kind"]; limit?: number }, ctx: OpContext) {
  if (ctx.via === "agent") {
    const own = ctx.principal?.runId ? await getRun(ctx.principal.runId) : undefined;
    return own ? [runBrief(own)] : [];
  }
  const all = ctx.via !== "token" && can(ctx.user, "admin");
  const rows = await listRuns({ initiator: all ? undefined : ctx.user.id, state: i.state as AgentRunRow["state"] | undefined, kind: i.kind, limit: i.limit ?? 20 });
  return rows.map(runBrief);
}

// ---------- operations ----------

// An agent sees the operations of its run, an API token its own, a person every one (like the audit log).
async function mayReadOperation(id: string, ctx: OpContext): Promise<boolean> {
  if (ctx.via !== "agent" && ctx.via !== "token") return true;
  const r = await (await getDb()).get<{ run_id: string | null; token_id: string | null }>("SELECT run_id, token_id FROM operations WHERE id = ?", [id]);
  if (!r) return false;
  return ctx.via === "agent" ? !!ctx.principal?.runId && r.run_id === ctx.principal.runId : !!ctx.tokenId && r.token_id === ctx.tokenId;
}

async function operationList(i: { state?: string; runId?: string; limit?: number }, ctx: OpContext) {
  const limit = i.limit ?? 20;
  if (ctx.via === "agent") {
    const runId = ctx.principal?.runId;
    if (!runId || (i.runId && i.runId !== runId)) return [];
    return (await listOperations({ state: i.state, runId, limit })).map(opView);
  }
  if (ctx.via === "token") {
    if (!ctx.tokenId) return [];
    const where = ["token_id = ?"];
    const args: unknown[] = [ctx.tokenId];
    if (i.state) {
      where.push("state = ?");
      args.push(i.state);
    }
    if (i.runId) {
      where.push("run_id = ?");
      args.push(i.runId);
    }
    const ids = await (await getDb()).all<{ id: string }>(`SELECT id FROM operations WHERE ${where.join(" AND ")} ORDER BY created_at DESC LIMIT ?`, [...args, limit]);
    return (await Promise.all(ids.map((r) => getOperation(r.id)))).filter((o): o is OperationView => !!o).map(opView);
  }
  return (await listOperations({ state: i.state, runId: i.runId, limit })).map(opView);
}

// ---------- variables ----------

type Fp = { source: string; fp: string | null };
type Cmp = "same" | "different" | "missing" | "unknown";

// Same / different / missing per variable name and environment, against the first environment. Fingerprints are
// keyed digests that stay on the server: neither values nor digests leave this function.
export function compareFingerprints(envs: string[], byEnv: Map<string, Map<string, Fp>>): { name: string; status: "same" | "different" | "missing"; envs: Record<string, Cmp>; sourceDiffers?: true }[] {
  const ref = envs[0];
  const names = new Set<string>();
  for (const m of byEnv.values()) for (const n of m.keys()) names.add(n);
  const out: { name: string; status: "same" | "different" | "missing"; envs: Record<string, Cmp>; sourceDiffers?: true }[] = [];
  for (const name of [...names].sort()) {
    const base = byEnv.get(ref)?.get(name);
    const per: Record<string, Cmp> = {};
    const sources = new Set<string>();
    for (const e of envs) {
      const m = byEnv.get(e);
      if (!m) continue; // unreadable there: reported separately
      const x = m.get(name);
      if (x) sources.add(x.source);
      if (!x) per[e] = "missing";
      else if (e === ref) per[e] = "same";
      else if (!base) per[e] = "different";
      else if (x.fp === null || base.fp === null) per[e] = "unknown";
      else per[e] = x.fp === base.fp ? "same" : "different";
    }
    const vals = Object.values(per);
    const status = vals.includes("missing") ? "missing" : vals.some((v) => v === "different" || v === "unknown") ? "different" : "same";
    out.push({ name, status, envs: per, ...(sources.size > 1 ? { sourceDiffers: true as const } : {}) });
  }
  return out;
}

async function variablesCompare(i: { envs: string[]; services?: string[] }) {
  const envs = [...new Set(i.envs)];
  if (envs.length < 2) throw new HttpError(400, "name at least two different environments");
  const known = await listEnvs();
  for (const e of envs) if (!known.some((k) => k.id === e)) throw new HttpError(404, `unknown environment "${e}"`);
  const services = i.services?.length ? [...new Set(i.services)] : [...(await catalog(envs[0])).meta.values()].filter((m) => !m.hidden && !m.self).map((m) => m.id).sort().slice(0, 20);
  const out = [];
  for (const service of services) {
    const byEnv = new Map<string, Map<string, Fp>>();
    const unreadable: { env: string; why: string }[] = [];
    const missingIn: string[] = [];
    for (const e of envs) {
      try {
        const rows = await varFingerprints(e, service);
        const m = new Map<string, Fp>();
        for (const r of rows) {
          const prev = m.get(r.name);
          // The same name in several containers: equal only when every container's value is.
          m.set(r.name, prev ? { source: prev.source === r.source ? r.source : "mixed", fp: prev.fp !== null && r.fingerprint !== null ? [prev.fp, r.fingerprint].sort().join("|") : null } : { source: r.source, fp: r.fingerprint });
        }
        byEnv.set(e, m);
      } catch (err) {
        if (err instanceof HttpError && err.status === 404) missingIn.push(e);
        else unreadable.push({ env: e, why: err instanceof HttpError ? err.message : errText(err) });
      }
    }
    const variables = compareFingerprints(envs.filter((e) => byEnv.has(e)), byEnv);
    out.push(compact({ service, variables, missingIn: missingIn.length ? missingIn : undefined, unreadable: unreadable.length ? unreadable : undefined }));
  }
  const differing = out.reduce((n, s) => n + (s.variables ?? []).filter((v) => v.status !== "same").length, 0);
  return {
    envs, reference: envs[0], services: out, differing,
    note: "Same / different / missing per variable against the reference environment. Values and fingerprints never leave the console; a difference is for a person to review in the Variables editor.",
  };
}

// ---------- the operations ----------

const VAR_PROTECTED = async (i: { envs?: string[] }) => (await listEnvs()).some((e) => e.protected && (i.envs ?? []).includes(e.id));

export const ops = defineOps([
  {
    name: "runs.start",
    title: "Start a workflow or assistant run",
    description:
      "Starts a published workflow by its id (`workflowId`, with its `inputs` and an optional `resourceKey` it is about) or an assistant run with a `goal` and the `connectionId` that pays for the model. The run acts for you with your current role, under the workflow's (or the incident-investigator) policy; changes it proposes wait for a person. Refused when the workflow can't be started by hand, is disabled, or one of its limits (concurrent runs, cooldown, attempts per resource) holds. Returns the run id — follow it with runs.get. Agents can never start runs.",
    risk: "change",
    perm: "act",
    input: obj({
      workflowId: { type: "string", maxLength: 100, description: "A published workflow's id (workflows.list)." },
      inputs: { type: "object", description: "The workflow's inputs, by name." },
      resourceKey: { type: "string", maxLength: 2048, description: "The resource the run is about (a key from envs.status, cloud.map or an ARN)." },
      goal: { type: "string", minLength: 3, maxLength: 2000, description: "For an assistant run: what to investigate or answer." },
      connectionId: { type: "string", maxLength: 200, description: "For an assistant run: the model connection that pays." },
    }),
    plan: async (i: StartIn, ctx) => ({
      summary: i.workflowId ? `Start workflow ${i.workflowId} acting for ${ctx.user.email}` : `Start an assistant run acting for ${ctx.user.email}`,
      changes: [i.workflowId ? `a new run of the published version of ${i.workflowId}` : `a new assistant run on connection ${i.connectionId ?? "?"}`, ...(i.resourceKey ? [`about ${i.resourceKey}`] : [])],
    }),
    run: (i: StartIn, ctx) => startRun(i, ctx),
  },
  {
    name: "runs.get",
    title: "Check a run",
    description:
      "One agent or workflow run: its state (queued, running, waiting_approval, waiting_external, paused_auth, paused_budget, succeeded, failed, cancelled, outcome_unknown), its steps with their state and errors, the operations it made with their outcome and verification, and the approval requests still waiting for a person. An agent sees only its own run; others see the runs they started.",
    risk: "read",
    perm: "view",
    input: obj({ id: { ...UUID, description: "The run id." } }, ["id"]),
    run: (i: { id: string }, ctx) => runDetail(i.id, ctx),
  },
  {
    name: "runs.list",
    title: "List runs",
    description: "Recent agent and workflow runs, newest first: id, kind, title, state, workflow and version, the resource it is about and its error. Your own runs (admins see all; an agent sees only its own).",
    risk: "read",
    perm: "view",
    input: obj({
      state: { type: "string", enum: RUN_STATES, description: "Only runs in this state." },
      kind: { type: "string", enum: ["assistant", "workflow", "external"], description: "Only runs of this kind." },
      limit: { type: "integer", minimum: 1, maximum: 100, default: 20, description: "How many (default 20)." },
    }),
    run: (i: { state?: string; kind?: AgentRunRow["kind"]; limit?: number }, ctx) => runList(i, ctx),
  },
  {
    name: "workflows.list",
    title: "List workflows",
    description: "The console's workflows: id, newest version, name, state (draft, published, disabled), its triggers (manual, schedule with cron and time zone, event), mode and when it was published. runs.start takes a published one's id.",
    risk: "read",
    perm: "view",
    input: obj({ state: { type: "string", enum: ["draft", "published", "disabled"], description: "Only workflows whose newest version is in this state." } }),
    run: async (i: { state?: string }) =>
      (await listWorkflows())
        .filter((w) => !i.state || w.state === i.state)
        .map((w) => compact({ id: w.id, version: w.version, name: w.name, state: w.state, mode: w.mode, template: w.template, triggers: w.triggers.map((t) => t.type === "schedule" ? `schedule ${t.cron} (${t.tz})` : t.type === "event" ? `event: ${t.source}` : "manual"), publishedAt: iso(w.publishedAt), activeVersion: w.activeVersion })),
  },
  {
    name: "variables.compare",
    title: "Compare variables across environments",
    description:
      "Compares the environment variables of services across environments, against the first one: for every variable name, per environment `same`, `different`, `missing` or `unknown` (its value couldn't be compared), and whether it is stored differently (plain, SSM, Secrets Manager, env file). Values and their fingerprints never leave the console — only the comparison does. Defaults to every service of the first environment (up to 20). A difference is for a person to fix in the Variables editor; agents can never change variables.",
    risk: "read",
    perm: "env",
    input: obj({ envs: { type: "array", items: ENV, maxItems: 6, description: "Environments to compare; the first is the reference." }, services: { type: "array", items: SERVICE, maxItems: 20, description: "Service names (default: the first environment's)." } }, ["envs"]),
    protectedOf: VAR_PROTECTED,
    run: (i: { envs: string[]; services?: string[] }) => variablesCompare(i),
  },
  {
    name: "operations.get",
    title: "Check what happened to a change",
    description:
      "One change the console made, by its operation id (returned by every change operation): action, target, environment, who, state (queued, running, succeeded, failed, outcome_unknown — AWS may have acted, check before trying again — or cancelled), whether it was verified on the resource afterwards, and when. Never its parameters. Use it instead of sending a change again. An agent sees only its run's operations, an API token its own.",
    risk: "read",
    perm: "view",
    input: obj({ id: { ...UUID, description: "The operation id." } }, ["id"]),
    run: async (i: { id: string }, ctx) => {
      const o = (await mayReadOperation(i.id, ctx)) ? await getOperation(i.id) : undefined;
      if (!o) throw new HttpError(404, "no such operation");
      return opView(o);
    },
  },
  {
    name: "operations.list",
    title: "List recent changes",
    description: "Recent operations, newest first, with the same safe fields as operations.get; filter by `state` (outcome_unknown lists changes whose result must be checked) or `runId`. An agent sees only its run's operations, an API token its own.",
    risk: "read",
    perm: "view",
    input: obj({ state: { type: "string", enum: OP_STATES, description: "Only operations in this state." }, runId: { ...UUID, description: "Only the operations of this run." }, limit: { type: "integer", minimum: 1, maximum: 100, default: 20, description: "How many (default 20)." } }),
    run: (i: { state?: string; runId?: string; limit?: number }, ctx) => operationList(i, ctx),
  },
]);

