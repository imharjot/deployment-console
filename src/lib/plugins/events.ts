// Console events: what the console tells integrations about, and the pure routing rules (subscription + env filter,
// flapping suppression, CI failure detection). Delivery itself lives in src/lib/server/events.ts.
import type { State } from "../types.ts";

type Base = { at: number; url: string /* deep link into the console */ };
export type ServiceEventType = "service.down" | "service.degraded" | "service.recovered";
export type ConsoleEvent =
  | (Base & { type: ServiceEventType; env: string; envLabel: string; protected: boolean; key: string; name: string; state: State; previous: State; reasons: string[] })
  | (Base & { type: "action"; env: string; envLabel: string; protected: boolean; target: string; action: string; actor: string; reason?: string; result: "ok" | "error"; detail?: string })
  // env/protected are set when the branch deploys to a known env, so env filters can apply to CI too.
  | (Base & { type: "ci.failed"; repo: string; branch: string; workflow: string; title: string; sha: string; actor: string; runId?: number; attempt?: number; runUrl?: string; env?: string; protected?: boolean })
  // Agent platform (wave C), delivered through the agent outbox (src/lib/server/agents/outbox.ts) so a failed
  // notification is retried without repeating anything the agent did.
  | (Base & { type: "agent.approval_needed"; runId: string; runTitle?: string; op: string; summary: string; env?: string; envLabel?: string; protected?: boolean; approvalId: string; requestedFor: string; expiresAt?: number })
  | (Base & { type: "agent.run_finished" | "agent.run_failed"; runId: string; title: string; kind: string; by?: string; error?: string })
  | (Base & { type: "test"; message: string });

export type EventType = ConsoleEvent["type"];
// Subscribable types, in UI order ("test" is always delivered when an admin asks for it).
export const EVENT_TYPES = [
  "service.down", "service.degraded", "service.recovered", "action", "ci.failed", "agent.approval_needed", "agent.run_finished", "agent.run_failed",
] as const satisfies readonly EventType[];
export const EVENT_LABELS: Record<EventType, string> = {
  "service.down": "Service down",
  "service.degraded": "Service degraded",
  "service.recovered": "Service recovered",
  action: "Console actions",
  "ci.failed": "CI failures",
  "agent.approval_needed": "Agent approval requests",
  "agent.run_finished": "Agent runs finished",
  "agent.run_failed": "Agent runs failed",
  test: "Test",
};

export type EnvFilter = "all" | "protected" | string[];
export interface Subscription {
  types: EventType[];
  envs: EnvFilter;
}
export const DEFAULT_SUBSCRIPTION: Subscription = { types: ["service.down", "service.recovered", "ci.failed"], envs: "all" };

const envOfEvent = (e: ConsoleEvent): { env?: string; protected?: boolean } => ("env" in e ? { env: e.env, protected: e.protected } : {});

export function matches(sub: Subscription, e: ConsoleEvent): boolean {
  if (e.type === "test") return true;
  if (!sub.types.includes(e.type)) return false;
  if (sub.envs === "all") return true;
  const { env, protected: prot } = envOfEvent(e);
  if (!env) return false; // CI on a branch no env deploys from: only "all" wants it
  return sub.envs === "protected" ? !!prot : sub.envs.includes(env);
}

// Same key within the dedupe window = the same news (a service flapping, a watcher double-firing).
export function eventKey(e: ConsoleEvent): string {
  switch (e.type) {
    case "service.down":
    case "service.degraded":
    case "service.recovered":
      return `${e.type}:${e.env}:${e.key}`;
    case "action":
      return `action:${e.env}:${e.target}:${e.action}:${e.result}:${e.at}`;
    case "ci.failed":
      return `ci.failed:${e.repo}:${e.runId ?? e.sha}:${e.attempt ?? 1}`;
    case "agent.approval_needed":
      return `agent.approval_needed:${e.approvalId}`;
    case "agent.run_finished":
    case "agent.run_failed":
      return `${e.type}:${e.runId}`;
    case "test":
      return `test:${e.at}`;
  }
}

// Returns true when (integration, key) was not seen within `windowMs`; remembers it either way.
export function createDeduper(windowMs = 60_000) {
  const seen = new Map<string, number>();
  return (integration: string, key: string, now = Date.now()): boolean => {
    if (seen.size > 5_000) for (const [k, t] of seen) if (now - t >= windowMs) seen.delete(k);
    const k = `${integration}\u0000${key}`;
    const last = seen.get(k);
    if (last !== undefined && now - last < windowMs) return false;
    seen.set(k, now);
    return true;
  };
}

export interface RoutableIntegration {
  id: string;
  enabled: boolean;
  capabilities: readonly string[];
  subscription: Subscription;
}
export const route = <T extends RoutableIntegration>(integrations: T[], e: ConsoleEvent): T[] =>
  integrations.filter((i) => i.enabled && i.capabilities.includes("notify") && matches(i.subscription, e));

export function parseSubscription(v: unknown): Subscription {
  const o = (v && typeof v === "object" ? v : {}) as { types?: unknown; envs?: unknown };
  const types = Array.isArray(o.types) ? (o.types.filter((t) => (EVENT_TYPES as readonly string[]).includes(t as string)) as EventType[]) : DEFAULT_SUBSCRIPTION.types;
  const envs: EnvFilter =
    o.envs === "protected" ? "protected" : Array.isArray(o.envs) ? o.envs.filter((x): x is string => typeof x === "string" && /^[a-z0-9][a-z0-9-]{0,62}$/.test(x)) : "all";
  return { types: [...new Set(types)], envs };
}

// ---------- rendering (shared by Slack, logs and delivery records) ----------

export type Tone = "bad" | "warn" | "ok" | "info";
export interface Described {
  tone: Tone;
  title: string;
  fields: [label: string, value: string][];
  links: { label: string; url: string }[];
}

export function describe(e: ConsoleEvent): Described {
  const open = { label: "Open in console", url: e.url };
  switch (e.type) {
    case "service.down":
    case "service.degraded":
    case "service.recovered": {
      const verb = e.type === "service.down" ? "is down" : e.type === "service.degraded" ? "is degraded" : "recovered";
      const fields: Described["fields"] = [["Environment", e.envLabel], ["Service", e.name], ["State", `${e.previous} → ${e.state}`]];
      if (e.reasons.length) fields.push(["Reason", e.reasons.slice(0, 3).join("; ")]);
      return { tone: e.type === "service.down" ? "bad" : e.type === "service.degraded" ? "warn" : "ok", title: `${e.name} ${verb} in ${e.envLabel}`, fields, links: [open] };
    }
    case "action": {
      const fields: Described["fields"] = [["Environment", e.envLabel], ["Target", e.target], ["By", e.actor]];
      if (e.reason) fields.push(["Reason", e.reason]);
      if (e.result === "error" && e.detail) fields.push(["Error", e.detail]);
      return { tone: e.result === "error" ? "bad" : "info", title: `${e.action} ${e.target} in ${e.envLabel}${e.result === "error" ? " failed" : ""}`, fields, links: [open] };
    }
    case "ci.failed": {
      const fields: Described["fields"] = [["Repository", e.repo], ["Workflow", e.workflow], ["Branch", e.branch], ["Commit", e.sha.slice(0, 7)], ["By", e.actor]];
      const links = e.runUrl ? [open, { label: "View run", url: e.runUrl }] : [open];
      return { tone: "bad", title: `CI failed: ${e.title}`, fields, links };
    }
    case "agent.approval_needed": {
      const fields: Described["fields"] = [["Change", e.summary], ["Operation", e.op], ["Agent acts for", e.requestedFor]];
      if (e.envLabel ?? e.env) fields.push(["Environment", `${e.envLabel ?? e.env}${e.protected ? " (protected)" : ""}`]);
      if (e.runTitle) fields.push(["Run", e.runTitle]);
      // The request lapses unanswered: say until when (UTC, to the minute).
      if (e.expiresAt && Number.isFinite(e.expiresAt)) fields.push(["Expires", `${new Date(e.expiresAt).toISOString().slice(0, 16).replace("T", " ")} UTC`]);
      return { tone: "warn", title: `An agent asks to: ${e.summary}`, fields, links: [{ label: "Review in console", url: e.url }] };
    }
    case "agent.run_finished":
    case "agent.run_failed": {
      const fields: Described["fields"] = [["Run", e.title], ["Kind", e.kind]];
      if (e.by) fields.push(["For", e.by]);
      if (e.error) fields.push(["Error", e.error]);
      return { tone: e.type === "agent.run_failed" ? "bad" : "ok", title: `Agent run ${e.type === "agent.run_failed" ? "failed" : "finished"}: ${e.title}`, fields, links: [open] };
    }
    case "test":
      return { tone: "info", title: "Test notification from the deployment console", fields: [["Message", e.message]], links: [open] };
  }
}

// ---------- CI watcher ----------

export interface CiRunLike {
  id: number;
  status: string;
  conclusion: string | null;
  updatedAt: string;
}
type CiRunFull = CiRunLike & { repo: string; branch: string; workflow: string; title: string; sha: string; actor: string; attempt: number; url: string };
const FAILED = new Set(["failure", "timed_out", "startup_failure"]);

// Runs that completed as failed strictly after the high-water mark (ms), plus the new mark.
// The mark only moves forward over completed runs, so a restart never re-announces what it already saw.
export function newFailures<T extends CiRunLike>(runs: T[], hwm: number): { failed: T[]; hwm: number } {
  let next = hwm;
  const failed: T[] = [];
  for (const r of runs) {
    if (r.status !== "completed") continue;
    const t = Date.parse(r.updatedAt);
    if (!Number.isFinite(t) || t <= hwm) continue;
    next = Math.max(next, t);
    if (r.conclusion && FAILED.has(r.conclusion)) failed.push(r);
  }
  return { failed, hwm: next };
}

// env/protected come from the env that deploys this branch, so env filters apply to CI too.
export function ciFailedEvent(run: CiRunFull, envs: { id: string; protected: boolean; branch?: string }[], consoleUrl: string): ConsoleEvent {
  const env = envs.find((x) => x.branch && x.branch === run.branch);
  return {
    type: "ci.failed", at: Date.parse(run.updatedAt) || Date.now(), url: consoleUrl,
    repo: run.repo, branch: run.branch, workflow: run.workflow, title: run.title, sha: run.sha, actor: run.actor,
    runId: run.id, attempt: run.attempt, runUrl: run.url, env: env?.id, protected: env?.protected,
  };
}
