// The workflow scheduler (master plan §6 C7 item 4; AGENT_ARCHITECTURE §8 phase 3): schedule triggers from the
// `schedules` table and event triggers from the sampler's state transitions and the cloud map's alarms. The worker
// loop calls tick() every 15 s while agents are on (steps.ts registers it); nothing here runs a step itself.
//
// Exactly one run per firing, across restarts and consoles: a firing's dedupe key — wf:<id>:<version>:<fireTimeIso>
// for a schedule slot — is the primary key of trigger_fires, claimed in the same transaction that creates the run.
// The slot then moves on by a compare-and-set on next_at. A slot missed by more than 15 minutes (the console was down)
// is skipped, never replayed late; several missed slots never become several runs.
//
// Revocation before the next fire: a schedule fires only while its version is the newest published one of a workflow
// that isn't disabled (disabling also turns its schedules off), and its publisher — whom the run acts for — still
// exists and isn't disabled. A limit (concurrency, cooldown, attempts per resource) skips a firing; it is recorded
// with no run.
//
// Event triggers: transitions are queued in memory by an onTransition listener (it never throws) and matched here;
// alarms are compared with what the previous pass saw (the first pass only remembers). Their dedupe key carries the
// resource, its new state and a 5-minute bucket, and the workflow's cooldown is checked in the same transaction.
import "server-only";
import { nextFire } from "../../agents/cron.ts";
import type { ScheduleRow } from "../../agents/records.ts";
import type { EventSelector, WorkflowTrigger } from "../../agents/workflows.ts";
import { keys } from "../../inventory/types.ts";
import { canonicalKey } from "../../mutation-keys.ts";
import type { EnvInfo } from "../../types.ts";
import { userById } from "../auth/users.ts";
import { onTransition } from "../console.ts";
import { getDb, newId } from "../db.ts";
import { errText } from "../errors.ts";
import { homeRegion } from "../sources.ts";
import { claimTriggerFire } from "./store.ts";
import { WorkflowLimitError, activeVersion, eventWorkflows, getVersion, startWorkflowRun, type TriggerFacts, type Version } from "./workflows.ts";

export const MISFIRE_GRACE_MS = 15 * 60_000;
const EVENT_BUCKET_MS = 5 * 60_000;
const DEFAULT_STATES = ["DOWN", "DEGRADED"];

const log = (level: number, msg: string, extra: Record<string, unknown> = {}) => console[level >= 50 ? "error" : "warn"](JSON.stringify({ level, msg, ...extra }));

export const scheduleDedupeKey = (workflowId: string, version: number, fireTime: number) => `wf:${workflowId}:${version}:${new Date(fireTime).toISOString()}`;
export const eventDedupeKey = (workflowId: string, version: number, source: string, resourceKey: string, state: string, at: number) =>
  `wf:${workflowId}:${version}:${source}:${resourceKey}:${state}:${Math.floor(at / EVENT_BUCKET_MS)}`;

interface QueuedEvent {
  source: "state" | "alarm";
  env?: string;
  key: string; // the sampler's key ("service:api") or the map's (an alarm's ARN)
  resourceKey: string; // the cloud map's key (eventResourceKey): what a model step investigates and limits count per
  aliases?: string[]; // other names a selector may use for it (the canonical coordinator key of an ECS service)
  kind: string;
  name: string;
  state: string;
  previous?: string;
  at: number;
}

interface TriggerState {
  started: boolean;
  queue: QueuedEvent[];
  alarms?: Map<string, string>; // alarm key → the state the last pass saw
}
const g = globalThis as { __consoleWorkflowTriggers?: TriggerState };
const st: TriggerState = (g.__consoleWorkflowTriggers ??= { started: false, queue: [] });

export interface TickReport {
  fired: { workflowId: string; version: number; runId: string; key: string }[];
  skipped: { workflowId: string; version: number; key?: string; why: string }[];
}

// One pass: due schedules, then queued state events, then alarms.
export async function tick(now = Date.now()): Promise<TickReport> {
  const out: TickReport = { fired: [], skipped: [] };
  const db = await getDb();
  const due = await db.all<ScheduleRow>("SELECT * FROM schedules WHERE enabled = 1 AND next_at IS NOT NULL AND next_at <= ? ORDER BY next_at LIMIT 50", [now]);
  for (const s of due) {
    try {
      await fireSchedule(s, now, out);
    } catch (e) {
      log(50, "workflow schedule failed", { schedule: s.id, err: errText(e) });
    }
  }
  await drainEvents(now, out).catch((e) => log(50, "workflow event triggers failed", { err: errText(e) }));
  await checkAlarms(now, out).catch((e) => log(40, "workflow alarm triggers failed", { err: errText(e) }));
  return out;
}

// Who a scheduled or event run acts for: the version's publisher, as long as they exist and aren't disabled.
async function delegatorOf(v: Version): Promise<{ id: string; email: string } | string> {
  if (!v.publisher) return "the version has no publisher";
  const u = await userById(v.publisher.id).catch(() => undefined);
  if (!u || Number(u.disabled)) return `${v.publisher.email} (who published it) is disabled or no longer exists`;
  return { id: u.id, email: u.email };
}

async function fireSchedule(s: ScheduleRow, now: number, out: TickReport) {
  const db = await getDb();
  const at = Number(s.next_at);
  const version = Number(s.workflow_version);
  const v = await getVersion(s.workflow_id, version);
  const active = await activeVersion(s.workflow_id);
  if (!v || v.row.state !== "published" || !active || active.row.version !== version) {
    await db.run("UPDATE schedules SET enabled = 0 WHERE id = ? AND enabled = 1", [s.id]);
    out.skipped.push({ workflowId: s.workflow_id, version, why: "not the version that runs (disabled or superseded)" });
    return;
  }
  const key = scheduleDedupeKey(s.workflow_id, version, at);
  if (now - at > MISFIRE_GRACE_MS) out.skipped.push({ workflowId: s.workflow_id, version, key, why: `missed by ${Math.round((now - at) / 60_000)} min — skipped, not replayed late` });
  else {
    const trig = v.draft.triggers.find((t): t is Extract<WorkflowTrigger, { type: "schedule" }> => t.type === "schedule" && t.cron === s.cron && t.tz === (s.tz ?? "UTC"));
    const facts: TriggerFacts = { type: "schedule", at: now, fireTime: new Date(at).toISOString(), ...(trig?.inputs ? { inputs: trig.inputs } : {}) };
    await fire(v, key, facts, undefined, out);
  }
  // The slot moves on (of several consoles, the one whose compare-and-set lands).
  let next: number | null = null;
  try {
    next = nextFire(s.cron, s.tz ?? "UTC", Math.max(now, at));
  } catch (e) {
    log(50, "workflow schedule can't compute its next time", { schedule: s.id, err: errText(e) });
  }
  await db.run("UPDATE schedules SET next_at = ?, last_fired_at = ? WHERE id = ? AND next_at = ?", [next, at, s.id, at]);
}

// Claims the firing and starts its run in one transaction; a limit or a gone delegator records it with no run.
async function fire(v: Version, key: string, facts: TriggerFacts, resourceKey: string | undefined, out: TickReport): Promise<void> {
  const who = await delegatorOf(v);
  const db = await getDb();
  const runId = newId();
  const result = await db.tx(async (tx) => {
    if (!(await claimTriggerFire({ dedupeKey: key, workflowId: v.row.id, workflowVersion: v.row.version, runId: typeof who === "string" ? undefined : runId }, tx))) return "duplicate";
    if (typeof who === "string") return who;
    try {
      await startWorkflowRun({ version: v, delegator: who, trigger: facts, resourceKey, runId, db: tx });
      return "started";
    } catch (e) {
      if (!(e instanceof WorkflowLimitError) && !(e instanceof Error && /invalid inputs/.test(e.message))) throw e;
      await tx.run("UPDATE trigger_fires SET run_id = NULL WHERE dedupe_key = ?", [key.slice(0, 500)]);
      return (e as Error).message;
    }
  });
  if (result === "started") out.fired.push({ workflowId: v.row.id, version: v.row.version, runId, key });
  else if (result !== "duplicate") {
    out.skipped.push({ workflowId: v.row.id, version: v.row.version, key, why: result });
    log(40, "workflow trigger skipped", { workflow: v.row.id, version: v.row.version, key, why: result });
  }
}

// ---------- events ----------

// Subscribes the sampler's transitions once per process (the instrumentation bundle, where the sampler runs).
export function startEventTriggers(): void {
  if (st.started) return;
  st.started = true;
  onTransition(({ env, r, previous }) => {
    try {
      const resourceKey = eventResourceKey(env, r, homeRegion());
      const aliases = r.kind === "service" ? [canonicalKey({ ecsService: { region: env.region, cluster: env.cluster, service: r.id } })] : undefined;
      st.queue.push({ source: "state", env: env.id, key: r.key, resourceKey, ...(aliases ? { aliases } : {}), kind: r.kind, name: r.name, state: r.state, previous, at: Date.now() });
      if (st.queue.length > 500) st.queue.splice(0, st.queue.length - 500);
    } catch {
      /* a listener never throws */
    }
  });
}

// The cloud map's key of a resource the sampler watches — what a run's model step investigates (the runner looks it up
// on the map) and what the workflow's cooldown and attempts count per. Resources the map doesn't key the same way keep
// "<env>/<sampler key>".
export function eventResourceKey(env: Pick<EnvInfo, "id" | "region" | "cluster">, r: { kind: string; key: string; id?: string }, home: string): string {
  const id = r.id ?? r.key.slice(r.key.indexOf(":") + 1);
  if (r.kind === "service") return keys.ecsService(env.cluster, id, env.region, home);
  if (r.kind === "database") return keys.rds(id, env.region, home);
  if (r.kind === "cache") return keys.elasticache(id, env.region, home);
  if (r.kind === "box") return keys.ec2(id, env.region, home);
  return `${env.id}/${r.key}`;
}

// For tests and the smoke suite: what a transition would queue.
export function queueEvent(e: QueuedEvent): void {
  st.queue.push(e);
}

export function matches(sel: EventSelector, e: Pick<QueuedEvent, "env" | "key" | "resourceKey" | "aliases" | "kind" | "state" | "previous">, defaults = DEFAULT_STATES): boolean {
  if (sel.envs?.length && !(e.env && sel.envs.includes(e.env))) return false;
  if (sel.keys?.length && ![e.key, e.resourceKey, ...(e.aliases ?? [])].some((k) => sel.keys!.includes(k))) return false;
  if (sel.kinds?.length && !sel.kinds.includes(e.kind)) return false;
  const states = sel.states?.length ? sel.states : defaults;
  // Entering one of the states, not moving between them.
  return states.includes(e.state) && !(e.previous && states.includes(e.previous));
}

// Events queued while agents were off (the tick doesn't run then) are as stale as a missed slot: skipped.
async function drainEvents(now: number, out: TickReport) {
  if (!st.queue.length) return;
  const events = st.queue.splice(0, st.queue.length);
  const list = await eventWorkflows(now);
  for (const e of events) {
    if (now - e.at > MISFIRE_GRACE_MS) {
      out.skipped.push({ workflowId: "", version: 0, key: `${e.source}:${e.resourceKey}:${e.state}`, why: `the event is ${Math.round((now - e.at) / 60_000)} min old — skipped, not acted on late` });
      continue;
    }
    await dispatch(e, list, out);
  }
}

async function dispatch(e: QueuedEvent, list: Version[], out: TickReport) {
  for (const v of list)
    for (const t of v.draft.triggers) {
      if (t.type !== "event" || t.source !== e.source || !matches(t.selector, e, e.source === "alarm" ? ["ALARM"] : DEFAULT_STATES)) continue;
      const facts: TriggerFacts = {
        type: "event", at: e.at, source: e.source, event: { env: e.env, key: e.key, kind: e.kind, name: e.name, state: e.state, previous: e.previous }, resourceKey: e.resourceKey,
        ...(e.env ? { env: e.env } : {}), ...(t.inputs ? { inputs: t.inputs } : {}),
      };
      await fire(v, eventDedupeKey(v.row.id, v.row.version, e.source, e.resourceKey, e.state, e.at), facts, e.resourceKey, out).catch((err) =>
        log(50, "workflow event trigger failed", { workflow: v.row.id, key: e.key, err: errText(err) }),
      );
      break; // one run per workflow per event, whichever of its triggers matched
    }
}

// CloudWatch alarms on the cloud map: a change into ALARM since the previous pass (only when some workflow listens).
async function checkAlarms(now: number, out: TickReport) {
  const list = (await eventWorkflows(now)).filter((v) => v.draft.triggers.some((t) => t.type === "event" && t.source === "alarm"));
  if (!list.length) return;
  const { getInventory } = await import("../inventory.ts");
  const view = await getInventory();
  const seen = new Map<string, string>();
  const first = !st.alarms;
  for (const r of view.resources) {
    if (r.kind !== "cloudwatch-alarm") continue;
    const state = r.health === "error" ? "ALARM" : r.health === "ok" ? "OK" : "INSUFFICIENT_DATA";
    seen.set(r.key, state);
    const previous = st.alarms?.get(r.key);
    if (first || previous === state) continue;
    await dispatch({ source: "alarm", env: r.env ?? undefined, key: r.key, resourceKey: r.key, kind: r.kind, name: r.name, state, previous, at: now }, list, out);
  }
  st.alarms = seen;
}
