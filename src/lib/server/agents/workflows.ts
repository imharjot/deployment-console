// Workflow versions and their runs (master plan §6 C7, §3.5; AGENT_ARCHITECTURE §7). The rules are pure in
// src/lib/agents/workflows.ts and templates.ts; this file stores versions in `workflows` (PK id + version), resolves
// target selectors against discovery, builds the preview a person accepts, publishes and disables, and starts runs.
//
// Lifecycle: a draft (version n, state draft) is edited in place; preview → { …, previewHash }; publish needs that
// hash (the person saw exactly this: workflow, resolved targets, payer) and freezes the version — its targets are
// written into the version and into its policy's bounded-act scope, its publisher becomes the delegator of scheduled
// and event runs, and its schedules replace the previous version's. A later save starts version n+1 as a draft.
// Disabling turns every version off at once: schedules stop before their next fire, and runs in flight end at their
// next step (steps.ts checks the version's state each time).
//
// Runs: startWorkflowRun() creates a run of kind "workflow" acting for a person (the one who started it by hand, or
// the publisher), with the version's policy, and its first step — the built-in check of inputs and targets. Concurrency,
// cooldown and maximum attempts per resource (the workflow's limits) are checked in the same transaction.
import "server-only";
import { policyHash } from "../../agents/policy.ts";
import { isFinalRun } from "../../agents/run-state.ts";
import type { AgentRunRow, WorkflowRow } from "../../agents/records.ts";
import { TEMPLATES, templateDraft, type TemplateOptions } from "../../agents/templates.ts";
import type { AgentPrincipal } from "../../agents/types.ts";
import {
  DEFAULT_LIMITS, buildPreview, publishedPolicy, resolveInputs, selectTargets, validateWorkflow, workflowHash, type OpCatalog, type Target, type TargetCandidate, type TargetSelector,
  type WorkflowDraft, type WorkflowPreview, type WorkflowTrigger,
} from "../../agents/workflows.ts";
import { nextFire } from "../../agents/cron.ts";
import { isTemplateName, type TemplateName } from "../../agents/policy.ts";
import { protectionOf } from "../../inventory/action-rules.ts";
import { canonicalKey } from "../../mutation-keys.ts";
import { can, type User } from "../../rbac.ts";
import { auditOrFail } from "../auth/audit.ts";
import { autoscalingOf, liveService } from "../console.ts";
import { getDb, newId, type Db } from "../db.ts";
import { catalog, listEnvs } from "../discovery.ts";
import { HttpError, errText } from "../errors.ts";
import { findOp } from "../ops/index.ts";
import { appendStep, createRun, getRun, getSteps, updateRun } from "./store.ts";

const coded = (status: number, message: string, code: string) => Object.assign(new HttpError(status, message), { code });
const parse = <T>(s: string | null, fallback: T): T => {
  try {
    return s ? (JSON.parse(s) as T) : fallback;
  } catch {
    return fallback;
  }
};

// What the registry says about an operation (exact names only; tool names don't count here).
export const opCatalog: OpCatalog = (name) => {
  const op = findOp(name);
  return op && op.name === name ? { risk: op.risk, perm: op.perm } : undefined;
};

// ---------- rows ----------

// A version as the graph column stores it (the draft minus what has its own column), plus what publishing froze.
interface Graph extends Omit<WorkflowDraft, "triggers" | "policy" | "connectionId"> {
  frozen?: { targets: Target[]; excluded: { key: string; why: string }[]; previewHash: string };
}

export interface Version {
  row: WorkflowRow;
  draft: WorkflowDraft;
  frozen?: Graph["frozen"];
  publisher?: { id: string; email: string };
}

export function versionOf(row: WorkflowRow): Version {
  const g = parse<Partial<Graph>>(row.graph, {});
  const { frozen, ...rest } = g;
  const draft = {
    format: 1, name: row.name, inputs: [], steps: [], limits: { ...DEFAULT_LIMITS }, ...rest,
    triggers: parse<WorkflowTrigger[]>(row.triggers, []), policy: parse(row.policy, null), connectionId: row.connection_id ?? "",
  } as unknown as WorkflowDraft;
  const p = parse<{ delegatorId?: string; delegatorEmail?: string } | null>(row.principal, null);
  return { row: norm(row), draft, frozen, ...(p?.delegatorId ? { publisher: { id: p.delegatorId, email: p.delegatorEmail ?? "" } } : {}) };
}

const norm = (r: WorkflowRow): WorkflowRow => ({
  ...r, version: Number(r.version), created_at: Number(r.created_at), published_at: r.published_at === null ? null : Number(r.published_at), disabled_at: r.disabled_at === null ? null : Number(r.disabled_at),
});

// Triggers, policy and connection have their own columns; the rest (and what publishing froze) is the graph.
const graphOf = (d: WorkflowDraft, frozen?: Graph["frozen"]): string => {
  const rest: Record<string, unknown> = { ...d };
  for (const k of ["triggers", "policy", "connectionId"]) delete rest[k];
  return JSON.stringify({ ...rest, ...(frozen ? { frozen } : {}) });
};

export async function getVersion(id: string, version: number, db?: Db): Promise<Version | undefined> {
  const r = await (db ?? (await getDb())).get<WorkflowRow>("SELECT * FROM workflows WHERE id = ? AND version = ?", [id, version]);
  return r ? versionOf(r) : undefined;
}

async function versions(id: string, db?: Db): Promise<WorkflowRow[]> {
  return (await (db ?? (await getDb())).all<WorkflowRow>("SELECT * FROM workflows WHERE id = ? ORDER BY version DESC LIMIT 200", [String(id).slice(0, 100)])).map(norm);
}

// The version that runs: the newest published one (none while the workflow is disabled).
export async function activeVersion(id: string, db?: Db): Promise<Version | undefined> {
  const r = await (db ?? (await getDb())).get<WorkflowRow>("SELECT * FROM workflows WHERE id = ? AND state = 'published' ORDER BY version DESC LIMIT 1", [id]);
  return r ? versionOf(r) : undefined;
}

// ---------- views ----------

export interface WorkflowItem {
  id: string;
  version: number;
  name: string;
  state: WorkflowRow["state"];
  trigger: WorkflowTrigger | null; // the first trigger (§3.5); `triggers` has them all
  triggers: WorkflowTrigger[];
  scope: unknown;
  hash: string | null;
  publishedAt?: number;
  template?: string;
  mode?: string;
  owner: string | null;
  createdAt: number;
  activeVersion?: number; // the version that runs (when it isn't this one)
}

function itemOf(v: Version, active?: number): WorkflowItem {
  const r = v.row;
  return {
    id: r.id, version: r.version, name: r.name, state: r.state, trigger: v.draft.triggers[0] ?? null, triggers: v.draft.triggers, scope: parse(r.scope, {}), hash: r.hash,
    ...(r.published_at ? { publishedAt: r.published_at } : {}), ...(v.draft.template ? { template: v.draft.template } : {}), mode: v.draft.policy?.mode, owner: r.owner_id,
    createdAt: r.created_at, ...(active !== undefined && active !== r.version ? { activeVersion: active } : {}),
  };
}

// One item per workflow: its newest version (a draft shows the version that runs alongside).
export async function listWorkflows(): Promise<WorkflowItem[]> {
  const rows = (await (await getDb()).all<WorkflowRow>(
    "SELECT w.* FROM workflows w WHERE w.version = (SELECT MAX(x.version) FROM workflows x WHERE x.id = w.id) ORDER BY w.created_at DESC LIMIT 500",
  )).map(norm);
  const active = new Map(
    (await (await getDb()).all<{ id: string; v: number | string }>("SELECT id, MAX(version) AS v FROM workflows WHERE state = 'published' GROUP BY id")).map((r) => [r.id, Number(r.v)]),
  );
  return rows.map((r) => itemOf(versionOf(r), active.get(r.id)));
}

export async function getWorkflow(id: string): Promise<{ workflow: WorkflowItem; draft: WorkflowDraft; versions: WorkflowItem[]; problems: string[]; frozen?: Graph["frozen"] }> {
  const all = await versions(id);
  if (!all.length) throw new HttpError(404, "no such workflow");
  const latest = versionOf(all[0]);
  const active = all.find((r) => r.state === "published")?.version;
  return {
    workflow: itemOf(latest, active),
    draft: latest.draft,
    versions: all.map((r) => itemOf(versionOf(r))),
    problems: validateWorkflow(latest.draft, opCatalog),
    ...(latest.frozen ? { frozen: latest.frozen } : {}),
  };
}

export const templateList = () => TEMPLATES.map((t) => ({ ...t }));

// ---------- drafts ----------

function mayEdit(user: User) {
  if (!can(user, "act")) throw new HttpError(403, `your role (${user.role}) can't manage workflows — needs developer`);
}

const MAX_DRAFT = 128 * 1024;
function checkDraftShape(d: unknown): WorkflowDraft {
  if (!d || typeof d !== "object" || Array.isArray(d)) throw new HttpError(400, "draft must be a JSON object");
  const text = JSON.stringify(d);
  if (text.length > MAX_DRAFT) throw new HttpError(413, "the workflow is too large");
  const o = d as Record<string, unknown>;
  if (o.format !== 1) throw new HttpError(400, "draft.format must be 1");
  if (typeof o.name !== "string" || !o.name.trim() || o.name.length > 100) throw new HttpError(400, "draft.name must be text (≤ 100 characters)");
  for (const k of ["inputs", "triggers", "steps"]) if (!Array.isArray(o[k])) throw new HttpError(400, `draft.${k} must be a list`);
  return JSON.parse(text) as WorkflowDraft;
}

async function writeDraft(id: string, version: number, user: User, d: WorkflowDraft, db: Db, insert: boolean) {
  const now = Date.now();
  const args = [d.name.trim(), workflowHash(d), graphOf(d), JSON.stringify(d.triggers), JSON.stringify(d.policy?.scope ?? {}), JSON.stringify(d.policy ?? null), d.connectionId ?? null];
  if (insert)
    await db.run(
      "INSERT INTO workflows (id, version, owner_id, name, hash, graph, triggers, scope, policy, connection_id, principal, state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'draft', ?)",
      [id, version, user.id, ...args, now],
    );
  else if ((await db.run("UPDATE workflows SET name = ?, hash = ?, graph = ?, triggers = ?, scope = ?, policy = ?, connection_id = ? WHERE id = ? AND version = ? AND state = 'draft'", [...args, id, version])) !== 1)
    throw coded(409, "this version was published or changed meanwhile — reload it", "version_changed");
}

// POST { template?, name, draft?, options? }: a new workflow (version 1, a draft) from a template or a given draft.
export async function createWorkflow(user: User, b: Record<string, unknown>, ip?: string): Promise<{ workflow: WorkflowItem; draft: WorkflowDraft; problems: string[] }> {
  mayEdit(user);
  const template = b.template;
  if (template !== undefined && !isTemplateName(template)) throw new HttpError(400, `template must be one of ${TEMPLATES.map((t) => t.name).join(", ")}`);
  if (b.name !== undefined && (typeof b.name !== "string" || !b.name.trim() || b.name.length > 100)) throw new HttpError(400, "name must be text (≤ 100 characters)");
  let d: WorkflowDraft;
  if (b.draft !== undefined) d = checkDraftShape(b.draft);
  else if (template) d = templateDraft(template as TemplateName, { ...templateOptions(b.options), ...(typeof b.name === "string" ? { name: b.name.trim() } : {}) });
  else throw new HttpError(400, "give a template or a draft");
  if (typeof b.name === "string") d.name = b.name.trim();
  const id = newId();
  const db = await getDb();
  await db.tx(async (tx) => {
    await auditOrFail({ action: "workflow.create", actor: user.email, target: d.name, ip, params: { id, template: template ?? null } });
    await writeDraft(id, 1, user, d, tx, true);
  });
  const w = await getWorkflow(id);
  return { workflow: w.workflow, draft: w.draft, problems: w.problems };
}

function templateOptions(v: unknown): TemplateOptions {
  if (v === undefined) return {};
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new HttpError(400, "options must be an object");
  const o = v as Record<string, unknown>;
  const out: TemplateOptions = {};
  const list = (k: string) => {
    const x = Object.hasOwn(o, k) ? o[k] : undefined;
    if (x === undefined) return undefined;
    if (!Array.isArray(x) || x.length > 50 || !x.every((s) => typeof s === "string" && s.length > 0 && s.length <= 255)) throw new HttpError(400, `options.${k} must be a list of names`);
    return x as string[];
  };
  out.envs = list("envs");
  out.services = list("services");
  for (const k of ["tz", "connectionId"] as const) {
    const x = Object.hasOwn(o, k) ? o[k] : undefined;
    if (x !== undefined && (typeof x !== "string" || x.length > 200)) throw new HttpError(400, `options.${k} must be text`);
    if (typeof x === "string") out[k] = x;
  }
  const n = Object.hasOwn(o, "notify") ? o.notify : undefined;
  if (n !== undefined && n !== "run" && n !== "integrations") throw new HttpError(400, 'options.notify must be "run" or "integrations"');
  if (n) out.notify = n as "run" | "integrations";
  return out;
}

// PATCH save: edits the draft, or starts the next version as a draft when the newest one is published or disabled.
export async function saveDraft(user: User, id: string, draft: unknown, ip?: string): Promise<{ workflow: WorkflowItem; draft: WorkflowDraft; problems: string[] }> {
  mayEdit(user);
  const d = checkDraftShape(draft);
  const db = await getDb();
  await db.tx(async (tx) => {
    const [latest] = await versions(id, tx);
    if (!latest) throw new HttpError(404, "no such workflow");
    const insert = latest.state !== "draft";
    const version = insert ? latest.version + 1 : latest.version;
    await auditOrFail({ action: "workflow.save", actor: user.email, target: d.name, ip, params: { id, version } });
    await writeDraft(id, version, user, d, tx, insert);
  });
  const w = await getWorkflow(id);
  return { workflow: w.workflow, draft: w.draft, problems: w.problems };
}

// ---------- targets ----------

// The ECS services a selector names, with what the exclusions need: tags read live, the console's own service,
// Application Auto Scaling. An environment that doesn't exist is reported, never guessed.
export async function resolveTargets(sel: TargetSelector): Promise<{ targets: Target[]; excluded: { key: string; env: string; service: string; why: string }[] }> {
  const envs = await listEnvs();
  const cands: TargetCandidate[] = [];
  const missing: { key: string; env: string; service: string; why: string }[] = [];
  for (const id of sel.envs) {
    const env = envs.find((e) => e.id === id);
    if (!env) {
      missing.push({ key: `env:${id}`, env: id, service: "", why: "no such environment" });
      continue;
    }
    const cat = await catalog(id);
    for (const [name, meta] of cat.meta) {
      if (sel.services?.length && !sel.services.includes(name)) continue;
      const key = canonicalKey({ ecsService: { region: env.region, cluster: env.cluster, service: name } });
      let tags: Record<string, string> | null = null;
      let autoscaled: boolean | undefined;
      try {
        const live = await liveService(env, name);
        tags = { ...(live.tags ?? {}) };
        autoscaled = live.scalable !== undefined ? true : !!(await autoscalingOf(env, name).catch(() => undefined));
      } catch {
        tags = null;
      }
      const prot = env.protected || (tags !== null && protectionOf({ env: id, tags }, [{ id, protected: env.protected }]).protected);
      cands.push({ key, env: id, service: name, region: env.region, envProtected: env.protected, protected: prot, self: meta.self === true ? true : meta.self === false ? false : "unknown", tags, autoscaled });
    }
  }
  const out = selectTargets(sel, cands);
  return { targets: out.targets, excluded: [...missing, ...out.excluded] };
}

// ---------- preview and publish ----------

// Who pays for the model steps: the connection's provider account, as the broker describes it to this person.
async function payerOf(d: WorkflowDraft, user: User): Promise<string> {
  if (!d.connectionId) return "nobody: no model steps (deterministic)";
  try {
    const { listConnections } = await import("./credentials.ts");
    const c = (await listConnections(user)).find((x) => x.id === d.connectionId);
    if (c) return c.payer;
  } catch {
    // the listing failed: the connection id still names what pays
  }
  return `connection ${d.connectionId} (not visible to you)`;
}

export async function previewDraft(d: WorkflowDraft, user: User, now = Date.now()): Promise<{ preview?: WorkflowPreview; resolved?: Awaited<ReturnType<typeof resolveTargets>>; problems: string[] }> {
  const problems = validateWorkflow(d, opCatalog, now);
  if (problems.length) return { problems };
  const resolved = d.targets ? await resolveTargets(d.targets) : undefined;
  return { preview: buildPreview(d, { now, catalog: opCatalog, payer: await payerOf(d, user), resolved }), resolved, problems: [] };
}

// PATCH preview: the newest version (the draft, or the version that runs when there is no draft).
export async function previewWorkflow(user: User, id: string): Promise<WorkflowPreview & { problems: string[] }> {
  mayEdit(user);
  const [latest] = await versions(id);
  if (!latest) throw new HttpError(404, "no such workflow");
  const { preview, problems } = await previewDraft(versionOf(latest).draft, user);
  if (!preview) throw Object.assign(new HttpError(400, `the workflow can't be activated yet: ${problems.join("; ")}`), { code: "invalid_workflow", problems });
  return { ...preview, problems };
}

function schedulesOf(d: WorkflowDraft, now: number): { cron: string; tz: string; next: number | null }[] {
  return d.triggers.filter((t): t is Extract<WorkflowTrigger, { type: "schedule" }> => t.type === "schedule").map((t) => ({ cron: t.cron, tz: t.tz, next: nextFire(t.cron, t.tz, now) }));
}

// PATCH publish { previewHash }: activation needs the preview the person accepted — recomputed now, and refused when
// anything it showed (the workflow, the resolved targets, the payer) has changed since.
export async function publishWorkflow(user: User, id: string, previewHash: unknown, ip?: string): Promise<{ workflow: WorkflowItem; preview: WorkflowPreview }> {
  mayEdit(user);
  if (typeof previewHash !== "string" || !previewHash) throw coded(400, "publishing needs the previewHash of the preview you accepted — preview first", "preview_required");
  const [latest] = await versions(id);
  if (!latest) throw new HttpError(404, "no such workflow");
  if (latest.state !== "draft") throw coded(409, `version ${latest.version} is already ${latest.state} — save a change to start a new draft`, "not_a_draft");
  const v = versionOf(latest);
  const now = Date.now();
  const { preview, resolved, problems } = await previewDraft(v.draft, user, now);
  if (!preview) throw Object.assign(new HttpError(400, `the workflow can't be activated: ${problems.join("; ")}`), { code: "invalid_workflow", problems });
  if (preview.previewHash !== previewHash) throw coded(409, "the preview changed since you saw it (the workflow, its targets or who pays) — preview again", "preview_changed");
  const targets = resolved?.targets ?? [];
  const policy = publishedPolicy(v.draft, targets);
  const frozen: Graph["frozen"] = { targets, excluded: preview.excluded, previewHash: preview.previewHash };
  const db = await getDb();
  await db.tx(async (tx) => {
    await auditOrFail({ action: "workflow.publish", actor: user.email, target: v.draft.name, ip, params: { id, version: latest.version, hash: preview.hash, targets: targets.length, mode: policy.mode } });
    const n = await tx.run(
      `UPDATE workflows SET state = 'published', published_at = ?, hash = ?, graph = ?, scope = ?, policy = ?, principal = ? WHERE id = ? AND version = ? AND state = 'draft'`,
      [now, preview.hash, graphOf(v.draft, frozen), JSON.stringify(policy.scope), JSON.stringify(policy), JSON.stringify({ delegatorId: user.id, delegatorEmail: user.email, publishedAt: now }), id, latest.version],
    );
    if (n !== 1) throw coded(409, "this version changed meanwhile — preview again", "version_changed");
    // The previous versions stop firing; their runs in flight finish under their own version.
    await tx.run("UPDATE schedules SET enabled = 0 WHERE workflow_id = ? AND workflow_version <> ?", [id, latest.version]);
    let i = 0;
    for (const s of schedulesOf(v.draft, now))
      await tx.run("INSERT INTO schedules (id, workflow_id, workflow_version, cron, tz, next_at, last_fired_at, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, NULL, 1, ?)", [
        `${id}:${latest.version}:${i++}`, id, latest.version, s.cron, s.tz, s.next, now,
      ]);
  });
  forgetEventCache();
  return { workflow: (await getWorkflow(id)).workflow, preview };
}

// PATCH disable: every version off at once; no schedule fires again and runs in flight end at their next step.
export async function disableWorkflow(user: User, id: string, ip?: string): Promise<WorkflowItem> {
  mayEdit(user);
  const all = await versions(id);
  if (!all.length) throw new HttpError(404, "no such workflow");
  const db = await getDb();
  await db.tx(async (tx) => {
    await auditOrFail({ action: "workflow.disable", actor: user.email, target: all[0].name, ip, params: { id } });
    await tx.run("UPDATE schedules SET enabled = 0 WHERE workflow_id = ?", [id]);
    await tx.run("UPDATE workflows SET state = 'disabled', disabled_at = ? WHERE id = ? AND state = 'published'", [Date.now(), id]);
  });
  forgetEventCache();
  return (await getWorkflow(id)).workflow;
}

// A pause for a person's review lasts at most until the run's time limit (its policy's runtimeSeconds, counted from
// the start): after it every call the run makes would be refused anyway, and a stop scheduled for the evening must not
// happen the next morning because someone answered late. steps.ts then cancels the run; its next trigger starts afresh.
export function reviewDeadline(run: Pick<AgentRunRow, "created_at" | "policy">): number {
  const p = parse<{ limits?: { runtimeSeconds?: unknown } } | null>(run.policy, null);
  const secs = typeof p?.limits?.runtimeSeconds === "number" ? p.limits.runtimeSeconds : 600;
  return Number(run.created_at) + secs * 1000;
}

// PATCH review { runId, decision: "continue" | "cancel" }: a person's answer to a run paused for review (targets that
// weren't previewed, or an approval step). "continue" never adds the unexpected targets: the run goes on with the
// ones that were published.
export async function reviewRun(user: User, id: string, runId: unknown, decision: unknown, ip?: string): Promise<{ runId: string; decision: string }> {
  mayEdit(user);
  if (typeof runId !== "string" || !runId) throw new HttpError(400, "runId is required");
  if (decision !== "continue" && decision !== "cancel") throw new HttpError(400, 'decision must be "continue" or "cancel"');
  const db = await getDb();
  const run = await db.get<AgentRunRow>("SELECT * FROM agent_runs WHERE id = ? AND workflow_id = ?", [runId, id]);
  if (!run) throw new HttpError(404, "no such run of this workflow");
  if (run.initiator_id !== user.id && !can(user, "act:protected")) throw new HttpError(403, "only the person the run acts for, or an operator, can review it");
  if (isFinalRun(run.state)) throw coded(409, `this run has already ended (${run.state.replace(/_/g, " ")})`, "not_waiting");
  if (decision === "continue" && Date.now() >= reviewDeadline(run)) throw coded(409, "the review came after the run's time limit — the run is being cancelled; start it again if it is still needed", "review_expired");
  const step = (await getSteps(runId)).find((s) => s.state === "waiting" && (s.kind === "approval" || s.kind === "condition") && parse<{ review?: unknown }>(s.result, {}).review !== undefined);
  if (!step) throw coded(409, "this run isn't waiting for a review", "not_waiting");
  const result = { ...parse<Record<string, unknown>>(step.result, {}), decision, decidedBy: user.email, decidedAt: Date.now() };
  await db.tx(async (tx) => {
    await auditOrFail({ action: "workflow.review", actor: user.email, target: run.title ?? id, ip, params: { id, runId, decision } });
    const n = await tx.run("UPDATE agent_steps SET result = ?, wake_at = ?, updated_at = ? WHERE id = ? AND state = 'waiting'", [JSON.stringify(result), Date.now(), Date.now(), step.id]);
    if (n !== 1) throw coded(409, "the run moved on meanwhile — try again", "not_waiting");
  });
  const { nudge } = await import("./worker.ts");
  nudge();
  return { runId, decision };
}

// ---------- runs ----------

export interface TriggerFacts {
  type: WorkflowTrigger["type"];
  at: number;
  fireTime?: string; // a schedule's slot (ISO)
  source?: "state" | "alarm";
  event?: Record<string, unknown>; // what the event said (env, key, kind, name, state, previous)
  resourceKey?: string;
  env?: string;
  inputs?: Record<string, unknown>;
  by?: string; // who started it by hand
}

const ACTIVE = ["queued", "running", "waiting_approval", "waiting_external", "paused_auth", "paused_budget"];

// Concurrency, cooldown and maximum attempts (per resource) of the workflow's limits — inside the caller's transaction.
async function limitRefusal(v: Version, resourceKey: string | undefined, db: Db, now: number): Promise<string | undefined> {
  const l = v.draft.limits ?? DEFAULT_LIMITS;
  const id = v.row.id;
  // The workflow's own runs only: a model step's child run carries the workflow id and resource too, but it is part of
  // its parent's attempt, not another one.
  const active = await db.get<{ n: number | string }>(
    `SELECT COUNT(*) AS n FROM agent_runs WHERE workflow_id = ? AND kind = 'workflow' AND parent_run_id IS NULL AND state IN (${ACTIVE.map(() => "?").join(", ")})`,
    [id, ...ACTIVE],
  );
  if (Number(active?.n ?? 0) >= l.maxConcurrentRuns) return `${active?.n} run(s) of this workflow are still going (limit ${l.maxConcurrentRuns})`;
  if (!resourceKey) return undefined;
  const recent = await db.all<{ created_at: number | string }>(
    "SELECT created_at FROM agent_runs WHERE workflow_id = ? AND kind = 'workflow' AND parent_run_id IS NULL AND resource_key = ? AND created_at > ? ORDER BY created_at DESC LIMIT 1000",
    [id, resourceKey, now - l.attemptWindowSeconds * 1000],
  );
  if (recent.length && l.cooldownSeconds > 0 && now - Number(recent[0].created_at) < l.cooldownSeconds * 1000)
    return `cooldown: the last run for ${resourceKey} started ${Math.round((now - Number(recent[0].created_at)) / 1000)} s ago (cooldown ${l.cooldownSeconds} s)`;
  if (recent.length >= l.maxAttempts) return `maximum attempts: ${recent.length} run(s) for ${resourceKey} in the last ${Math.round(l.attemptWindowSeconds / 3600)} h (limit ${l.maxAttempts}) — a person should look`;
  return undefined;
}

export class WorkflowLimitError extends HttpError {
  code = "workflow_limit";
  constructor(message: string) {
    super(429, message);
  }
}

// A run of a published version, acting for `delegator`. With `db` it joins the caller's transaction (the scheduler
// claims the trigger fire and starts the run together). Returns the run id; throws WorkflowLimitError when a limit
// refuses it.
export async function startWorkflowRun(o: { version: Version; delegator: { id: string; email: string }; trigger: TriggerFacts; resourceKey?: string; runId?: string; db?: Db }): Promise<string> {
  const v = o.version;
  if (v.row.state !== "published") throw coded(409, `version ${v.row.version} of this workflow isn't published`, "not_published");
  const policy = v.draft.policy;
  const { problems } = resolveInputs(v.draft.inputs ?? [], o.trigger.inputs);
  if (problems.length) throw Object.assign(new HttpError(400, `invalid inputs: ${problems.join("; ")}`), { problems });
  const runId = o.runId ?? newId();
  const hash = policyHash(policy);
  const principal: AgentPrincipal = {
    id: `agent:${runId}`, kind: "agent", runId, delegatorId: o.delegator.id, delegatorEmail: o.delegator.email, workflowId: v.row.id, workflowVersion: v.row.version, policyHash: hash, mode: policy.mode,
  };
  const now = Date.now();
  const go = async (tx: Db) => {
    const why = await limitRefusal(v, o.resourceKey, tx, now);
    if (why) throw new WorkflowLimitError(why);
    await createRun(
      {
        id: runId, kind: "workflow", title: `${v.draft.name}${o.resourceKey ? ` — ${o.resourceKey}` : ""}`.slice(0, 300), initiatorId: o.delegator.id, principal, workflowId: v.row.id,
        workflowVersion: v.row.version, connectionId: v.draft.connectionId || null, policy, policyHash: hash, state: "running", trigger: o.trigger, resourceKey: o.resourceKey,
        deadlineAt: now + policy.limits.runtimeSeconds * 1000,
      },
      tx,
    );
    await appendStep(runId, { kind: "condition", name: "check inputs and targets", input: { wf: { id: v.row.id, version: v.row.version, hash: v.row.hash, node: -1, nodeId: "@start" } }, retrySafe: true }, tx);
  };
  if (o.db) await go(o.db);
  else await (await getDb()).tx(go);
  const { nudge } = await import("./worker.ts");
  nudge();
  return runId;
}

// runs.start and the Workflows tab: a person starts the version that runs, by hand, with their own rights.
export async function startManualRun(user: User, workflowId: string, inputs?: unknown, resourceKey?: string): Promise<string> {
  const v = await activeVersion(workflowId);
  if (!v) throw coded(409, "this workflow has no published version (or it is disabled)", "not_published");
  if (!v.draft.triggers.some((t) => t.type === "manual")) throw coded(409, "this workflow can't be started by hand (no manual trigger)", "no_manual_trigger");
  const manual = v.draft.triggers.find((t) => t.type === "manual")!;
  const merged = { ...(manual.inputs ?? {}), ...(inputs && typeof inputs === "object" && !Array.isArray(inputs) ? (inputs as Record<string, unknown>) : {}) };
  return startWorkflowRun({ version: v, delegator: { id: user.id, email: user.email }, trigger: { type: "manual", at: Date.now(), inputs: merged, by: user.email, ...(resourceKey ? { resourceKey } : {}) }, resourceKey });
}

// Ends a run that can't go on (best effort: a run that already ended stays as it is). A run that stops early (the
// workflow was disabled, a person cancelled it, a step failed) stops its model steps' child runs with it: an agent run
// must not go on proposing or making changes for a workflow that ended.
export async function endRun(runId: string, state: "succeeded" | "failed" | "cancelled", error?: string): Promise<void> {
  await updateRun(runId, { state, ...(error ? { error } : {}) }).catch((e) => {
    if (!(e instanceof HttpError) || (e.status !== 409 && e.status !== 404)) console.error(JSON.stringify({ level: 40, msg: "workflow run not ended", runId, state, err: errText(e) }));
  });
  if (state !== "succeeded") await cancelChildren(runId, error ?? state).catch((e) => console.error(JSON.stringify({ level: 40, msg: "workflow child runs not cancelled", runId, err: errText(e) })));
}

async function cancelChildren(runId: string, why: string) {
  const db = await getDb();
  const kids = await db.all<{ id: string }>(`SELECT id FROM agent_runs WHERE parent_run_id = ? AND state IN (${ACTIVE.map(() => "?").join(", ")})`, [runId, ...ACTIVE]);
  if (!kids.length) return;
  const run = await getRun(runId);
  const p = parse<{ delegatorId?: string; delegatorEmail?: string } | null>(run?.principal ?? null, null);
  const m = (await import("./runner.ts")) as unknown as { cancelRun?: (id: string, by: User) => Promise<unknown> };
  if (typeof m.cancelRun !== "function") return;
  // Cancelled in the name of the person the workflow acts for (the audit row says why).
  const by: User = { id: p?.delegatorId ?? run?.initiator_id ?? "", email: `${p?.delegatorEmail ?? "workflow"} (workflow run ${runId.slice(0, 8)} ended: ${why.slice(0, 120)})`, role: "viewer" };
  for (const k of kids) await m.cancelRun(k.id, by).catch(() => undefined);
}

// ---------- event-trigger cache (scheduler.ts reads it) ----------

const g = globalThis as { __consoleWorkflowEvents?: { at: number; list: Version[] } | undefined };
export const forgetEventCache = () => void (g.__consoleWorkflowEvents = undefined);

// Published versions with an event trigger (the newest per workflow), cached 30 s.
export async function eventWorkflows(now = Date.now()): Promise<Version[]> {
  const c = g.__consoleWorkflowEvents;
  if (c && now - c.at < 30_000) return c.list;
  const rows = await (await getDb()).all<WorkflowRow>(
    "SELECT w.* FROM workflows w WHERE w.state = 'published' AND w.version = (SELECT MAX(x.version) FROM workflows x WHERE x.id = w.id AND x.state = 'published')",
  );
  const list = rows.map(versionOf).filter((v) => v.draft.triggers.some((t) => t.type === "event"));
  g.__consoleWorkflowEvents = { at: now, list };
  return list;
}
