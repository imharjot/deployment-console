// What the Automation screens say about runs, plans, budgets, connections and agent clients. Pure (no React, DOM or
// Node APIs), so the screens and their tests share one set of words (AGENT_ARCHITECTURE §9.8 product tests,
// §10 product experience): a run says who asked, who pays, what it is waiting for and how it ended — and "AI response
// completed", "AWS request accepted" and "service verified healthy" are three different things, never one.
import type { AuthKind, ConnectionScope, EndpointEntry, Provider } from "../../lib/agents/connection-rules.ts";
import { usableEndpoint } from "../../lib/agents/connection-rules.ts";
import type { AgentTokenItem, BudgetLike, BudgetViewLike, EvidenceItem, OperationRef, PlanLike, ProposalView, RunDetail, RunListItem, RunMetrics, RunOutcome, RunState, UsageLike } from "./types.ts";

export type Tone = "ok" | "warn" | "bad" | "muted" | "accent";

// ---------- tabs ----------

export const AUTOMATION_TABS = ["approvals", "runs", "workflows", "agents", "connections", "connect", "tokens", "operations"] as const;
export type AutomationTab = (typeof AUTOMATION_TABS)[number];

// The hash is "#<tab>", "#runs/<run id>" or "#workflows/<workflow id>". No hash: Approvals when something waits for a
// decision, else Runs.
export function parseAutomationHash(hash: string, pending: number): { tab: AutomationTab; runId?: string; workflowId?: string } {
  const h = hash.replace(/^#/, "");
  const [tab, rest] = h.split("/", 2);
  if ((AUTOMATION_TABS as readonly string[]).includes(tab)) {
    const id = rest && /^[A-Za-z0-9_:.-]{1,100}$/.test(rest) ? rest : undefined;
    return { tab: tab as AutomationTab, ...(id && tab === "runs" ? { runId: id } : {}), ...(id && tab === "workflows" ? { workflowId: id } : {}) };
  }
  return { tab: pending > 0 ? "approvals" : "runs" };
}

// ---------- run states ----------

export const RUN_STATE: Record<RunState, { label: string; tone: Tone; final: boolean; hint: string }> = {
  queued: { label: "Queued", tone: "muted", final: false, hint: "Waiting for the worker to pick it up." },
  running: { label: "Running", tone: "accent", final: false, hint: "Working: reading evidence or thinking." },
  waiting_approval: { label: "Waiting for approval", tone: "accent", final: false, hint: "It asked for a change; a person decides in Approvals." },
  waiting_external: { label: "Waiting for AWS", tone: "warn", final: false, hint: "A change was sent; the console is checking what AWS did." },
  paused_auth: { label: "Paused: connection", tone: "warn", final: false, hint: "Its model connection was refused or disconnected. It never switches to another connection or payer." },
  paused_budget: { label: "Paused: budget", tone: "warn", final: false, hint: "It used up its turns, tool calls, time or cost limit." },
  succeeded: { label: "Succeeded", tone: "ok", final: true, hint: "Finished." },
  failed: { label: "Failed", tone: "bad", final: true, hint: "Stopped with an error." },
  cancelled: { label: "Stopped", tone: "muted", final: true, hint: "Stopped by a person (or its time ran out)." },
  outcome_unknown: { label: "Outcome unknown", tone: "bad", final: true, hint: "AWS may or may not have made the change. Check before asking again." },
};

export const runStateInfo = (s: string) => RUN_STATE[s as RunState] ?? { label: s.replace(/_/g, " "), tone: "muted" as Tone, final: false, hint: "" };
export const isFinalRunState = (s: string) => runStateInfo(s).final;

export const RUN_KIND: Record<string, string> = { assistant: "Assistant", workflow: "Workflow", external: "External agent" };

export const initiatorOf = (r: Pick<RunListItem, "initiator">): string | undefined =>
  typeof r.initiator === "string" ? r.initiator : r.initiator && typeof r.initiator === "object" ? (r.initiator.email ?? undefined) : undefined;

// What the run is waiting for, in one line — the server's own words when it gives them.
export function waitingText(r: Pick<RunListItem, "state" | "waitingFor">): string | undefined {
  if (r.waitingFor) return r.waitingFor;
  switch (r.state) {
    case "queued":
      return "the worker";
    case "waiting_approval":
      return "a person's approval";
    case "waiting_external":
      return "AWS to settle a change";
    case "paused_auth":
      return "its model connection to be fixed";
    case "paused_budget":
      return "more budget (or a person to stop it)";
    default:
      return undefined;
  }
}

// ---------- outcomes: three separate answers ----------

export interface Badge {
  key: "ai" | "aws" | "health";
  label: string;
  tone: Tone;
  hint: string;
}

// "AI completed", "AWS accepted" and "verified healthy" are separate badges, each with its own state: an accepted
// request is never shown as healthy, and a finished answer never as a change that happened. The runner's `aws:
// "unknown"` also covers a change still in flight, so a run that is still going (with no operation or step whose
// outcome is actually unknown) says "checking", not "unknown". A run with no AI step of its own (an external client,
// a deterministic workflow) never claims an AI answer. The server's own sentences (`outcome.text`) become the hints.
export interface OutcomeContext {
  final?: boolean;
  unknown?: boolean; // the run, or one of its operations or steps, is outcome_unknown (default: as `final` says)
  without?: "external" | "deterministic"; // the run has no AI step of its own
  noModelYet?: boolean; // a run that calls a model hasn't yet (its first turn is still queued)
}

export function outcomeBadges(o: RunOutcome | undefined, run?: OutcomeContext): Badge[] {
  if (!o) return [];
  const t = o.text;
  const ai: Badge =
    run?.without === "external" ? { key: "ai", label: "AI: in its client", tone: "muted", hint: t?.ai ?? "An external agent: its answers stay in its own client." }
    : run?.without === "deterministic" ? { key: "ai", label: "No AI step", tone: "muted", hint: t?.ai ?? "This run has no AI step: it follows its workflow's steps." }
    : run?.noModelYet && o.ai !== "failed" ? (run.final ? { key: "ai", label: "No AI answer", tone: "muted", hint: "The run ended before a model answered." } : { key: "ai", label: "AI working", tone: "accent", hint: "The model hasn't answered yet." })
    : o.ai === "completed" ? { key: "ai", label: "AI completed", tone: "ok", hint: t?.ai ?? "The model finished its answer." }
    : o.ai === "incomplete" ? { key: "ai", label: "AI incomplete", tone: "warn", hint: t?.ai ?? "The model stopped before finishing (limit, stop or a cut-off response)." }
    : o.ai === "failed" ? { key: "ai", label: "AI failed", tone: "bad", hint: t?.ai ?? "The model call failed." }
    : run?.final ? { key: "ai", label: "No AI answer", tone: "muted", hint: "The run ended without an answer from a model in the console (an external client keeps its own)." }
    : { key: "ai", label: "AI working", tone: "accent", hint: t?.ai ?? "The model hasn't finished yet." };
  // Without a context (an older caller) an unknown is taken at its word.
  const confirmedUnknown = !run || !!run.final || (run.unknown ?? false);
  const aws: Badge =
    o.aws === "accepted" ? { key: "aws", label: "AWS accepted", tone: "accent", hint: t?.aws ?? "AWS accepted the request. That is not yet proof the service is healthy." }
    : o.aws === "unknown" && !confirmedUnknown ? { key: "aws", label: "AWS: checking", tone: "accent", hint: "A change is in flight: the console is checking what AWS did, and never sends it twice." }
    : o.aws === "unknown" ? { key: "aws", label: "AWS outcome unknown", tone: "bad", hint: t?.aws ?? "The request may have reached AWS; its result wasn't confirmed." }
    : { key: "aws", label: "No AWS change", tone: "muted", hint: t?.aws ?? "Nothing was sent to AWS." };
  const health: Badge =
    o.health === "verified" ? { key: "health", label: "Verified healthy", tone: "ok", hint: t?.health ?? "The console checked the service after the change and it is healthy." }
    : o.health === "unhealthy" ? { key: "health", label: "Unhealthy", tone: "bad", hint: t?.health ?? "The check after the change found the service unhealthy — escalate." }
    : o.health === "pending" ? { key: "health", label: "Verifying health", tone: "accent", hint: t?.health ?? "Waiting for the service to settle on the new state." }
    : { key: "health", label: "Health: not applicable", tone: "muted", hint: t?.health ?? "No change to verify." };
  return [ai, aws, health];
}

// Whether AWS may or may not have acted — the run, one of its operations or steps is outcome_unknown, or the run ended
// with an unknown — as opposed to a change that is merely still in flight.
export function hasUnknownOutcome(r: Pick<RunDetail, "state" | "outcome" | "operations" | "steps">): boolean {
  if (r.state === "outcome_unknown") return true;
  if ((r.operations ?? []).some((o) => o.state === "outcome_unknown") || (r.steps ?? []).some((s) => s.state === "outcome_unknown")) return true;
  return isFinalRunState(r.state) && r.outcome?.aws === "unknown";
}

// What the outcome badges need to know about the run.
export function outcomeContext(r: Pick<RunDetail, "state" | "kind" | "connection" | "outcome" | "operations" | "steps">): OutcomeContext {
  const final = isFinalRunState(r.state);
  const models = (r.steps ?? []).some((s) => s.kind === "model");
  const without = r.kind === "external" ? "external" : !models && !r.connection && r.kind === "workflow" ? "deterministic" : undefined;
  return { final, unknown: hasUnknownOutcome(r), ...(without ? { without } : !models ? { noModelYet: true } : {}) };
}

// What to do when AWS may or may not have acted.
export function outcomeUnknownGuidance(r: Pick<RunDetail, "state" | "outcome" | "operations" | "steps">): string | undefined {
  if (!hasUnknownOutcome(r)) return undefined;
  return "AWS may have made this change. Look at the service (and the operation in the audit log) before asking again: the console never retries a change whose outcome is unknown, and it keeps checking until it can tell.";
}

// An operation's verification in words (null/undefined = still verifying; never "healthy" until verified).
export function verifyText(o: OperationRef): { text: string; tone: Tone } {
  if (o.state === "outcome_unknown") return { text: "outcome unknown", tone: "bad" };
  if (o.state === "failed") return { text: "failed", tone: "bad" };
  if (o.state === "cancelled") return { text: "cancelled", tone: "muted" };
  if (o.state === "queued" || o.state === "running") return { text: "in progress", tone: "accent" };
  const v = o.verify;
  const detail = v && typeof v === "object" && v.detail ? v.detail : o.detail;
  if (v === true || v === 1 || v === "verified" || (v && typeof v === "object" && v.ok === true)) return { text: "AWS accepted · verified healthy", tone: "ok" };
  if (v === false || v === 0 || v === "failed" || (v && typeof v === "object" && v.ok === false)) return { text: `AWS accepted · not healthy${detail ? ` (${detail})` : ""}`, tone: "bad" };
  if (typeof v === "string" && v) return { text: `AWS accepted · ${v}`, tone: "warn" };
  return { text: "AWS accepted · verifying", tone: "accent" };
}

// Whether a run still has something to follow: the run itself, a change being verified (the outcome's health says so)
// or one whose outcome is still being reconciled, or an operation still running. An operation's `verify: null` alone
// isn't one: the coordinator leaves it null for good on a failed change and on one it can't verify.
export const stillMoving = (r: Pick<RunDetail, "state" | "outcome" | "operations"> | undefined) =>
  !r || !isFinalRunState(r.state) || r.outcome?.health === "pending" || r.outcome?.aws === "unknown" || (r.operations ?? []).some((o) => o.state === "queued" || o.state === "running");

// ---------- budget ----------

export interface BudgetRow {
  key: "turns" | "tools" | "time" | "cost";
  label: string;
  used: number;
  limit: number;
  pct: number; // 0..1 (capped)
  tone: Tone;
  text: string;
  estimated?: boolean;
}

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

// The run's limits against what it has used. Only limits the run has (a deterministic workflow has no turns).
const isBudgetView = (b: BudgetLike | BudgetViewLike): b is BudgetViewLike => "limits" in b && !!b.limits && typeof b.limits === "object" && "used" in b;

// `budget` is the policy's limits (with `usage` beside it) or the runner's view ({ limits, used, cost }).
export function budgetRows(raw: BudgetLike | BudgetViewLike | null | undefined, usage: UsageLike | null | undefined, o: { now?: number; startedAt?: number; finishedAt?: number | null } = {}): BudgetRow[] {
  if (!raw) return [];
  const view = isBudgetView(raw) ? raw : undefined;
  const budget: BudgetLike = view ? view.limits : (raw as BudgetLike);
  const u: UsageLike = view ? { ...(usage ?? {}), turns: view.used.turns, toolCalls: view.used.toolCalls, runtimeSeconds: view.used.seconds, costUsd: view.used.costUsd } : (usage ?? {});
  const rows: BudgetRow[] = [];
  const add = (key: BudgetRow["key"], label: string, used: number | undefined, limit: number | undefined, fmt: (n: number) => string, estimated?: boolean) => {
    if (limit === undefined || limit <= 0) return;
    const usedN = Math.max(0, used ?? 0);
    const ratio = usedN / limit;
    rows.push({
      key, label, used: usedN, limit, pct: Math.min(1, ratio), tone: ratio >= 1 ? "bad" : ratio >= 0.8 ? "warn" : "ok",
      text: `${fmt(usedN)} of ${fmt(limit)}`, ...(estimated ? { estimated: true } : {}),
    });
  };
  add("turns", "Model turns", num(u.turns) ?? num(u.modelTurns), num(budget.turns) ?? num(budget.modelTurns), (n) => String(Math.round(n)));
  add("tools", "Tool calls", num(u.toolCalls), num(budget.toolCalls), (n) => String(Math.round(n)));
  const elapsed =
    num(u.runtimeSeconds) ?? (num(u.elapsedMs) !== undefined ? num(u.elapsedMs)! / 1000 : o.startedAt && (o.finishedAt || o.now) ? ((o.finishedAt || o.now)! - o.startedAt) / 1000 : undefined);
  add("time", "Time", elapsed, num(budget.runtimeSeconds), seconds);
  add("cost", "Cost", num(u.costUsd) ?? num(u.estimatedCostUsd), num(budget.costUsd), (n) => `$${n.toFixed(n < 1 ? 3 : 2)}`, true);
  return rows;
}

export function seconds(n: number): string {
  const s = Math.max(0, Math.round(n));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${s % 60 ? ` ${s % 60}s` : ""}`;
  return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60) ? ` ${Math.floor((s % 3600) / 60)}m` : ""}`;
}

// ---------- evidence ----------

// How old a piece of evidence is, and whether it is older than the policy allows for a decision.
export function evidenceAge(observedAt: number | undefined, now: number, maxAgeSeconds?: number): { text: string; stale: boolean } {
  if (!observedAt || !now) return { text: "age unknown", stale: true };
  const s = Math.max(0, Math.round((now - observedAt) / 1000));
  const text = s < 5 ? "just now" : `${seconds(s)} old`;
  return { text, stale: maxAgeSeconds !== undefined && s > maxAgeSeconds };
}

// The evidence a proposal or answer cites ("E1", "E3"), in citation order, plus ids that point nowhere.
export function citedEvidence(ids: readonly string[] | undefined, all: readonly EvidenceItem[] | undefined): { found: EvidenceItem[]; missing: string[] } {
  const byId = new Map((all ?? []).map((e) => [e.id, e]));
  const found: EvidenceItem[] = [];
  const missing: string[] = [];
  for (const id of new Set(ids ?? [])) {
    const e = byId.get(id);
    if (e) found.push(e);
    else missing.push(id);
  }
  return { found, missing };
}

// Citation ids in a text ("… restarts after OOM [E2], see E4").
export const citationsIn = (text: string | null | undefined): string[] => [...new Set((text ?? "").match(/\bE\d{1,4}\b/g) ?? [])];

// ---------- plan cards ----------

// How a change is judged done, per operation (the console's verification rules, said before anyone approves).
const VERIFIES: Record<string, string> = {
  "services.restart": "Verified when every task runs the new deployment and the service reports steady and healthy (within 15 minutes).",
  "services.scale": "Verified when the running task count reaches the new desired count and the service is steady.",
  "services.stop": "Verified when the service has no running tasks; Start restores the remembered count.",
  "services.start": "Verified when the remembered task count is running and healthy.",
  "services.switch": "Verified when every task runs the chosen revision and the service is steady.",
  "services.deploy": "Verified when every task runs the new image and the service is steady.",
};

export interface PlanFacts {
  summary: string;
  what: string[];
  where: string[];
  why?: string;
  evidence: { found: EvidenceItem[]; missing: string[]; oldest?: number };
  consumers: string[] | undefined; // undefined: not reported
  bounds: string[];
  success: string;
  warnings: string[];
  planHash: string;
  expiresAt: number | null;
  refreshed?: string; // evidence fetched again before the request because the policy found the old one too old
  stale?: boolean; // the newest evidence was older than the policy allows and couldn't be read again
}

export function planFacts(p: ProposalView, evidence?: readonly EvidenceItem[]): PlanFacts {
  const plan: PlanLike = p.plan ?? { summary: p.op };
  const ids = Array.isArray(p.evidence) ? p.evidence : p.evidence && typeof p.evidence === "object" ? (p.evidence.ids ?? []) : citationsIn(p.why);
  const cited = citedEvidence(ids, evidence);
  const oldest = cited.found.length ? Math.min(...cited.found.map((e) => e.observedAt)) : undefined;
  const bounds = [...(p.bounds ?? [])];
  if (plan.estimate) bounds.unshift(`≈ $${plan.estimate.monthlyUsd.toLocaleString("en-US", { maximumFractionDigits: 2 })}/month (${plan.estimate.note})`);
  return {
    summary: plan.summary,
    what: plan.changes?.length ? plan.changes : [plan.summary],
    where: p.targets.length ? p.targets : p.env ? [p.env] : [],
    ...(p.why ? { why: p.why } : {}),
    evidence: { ...cited, ...(oldest !== undefined ? { oldest } : {}) },
    consumers: p.consumers,
    bounds,
    success: p.verifies ?? VERIFIES[p.op] ?? "Verified when the console reads the resource back in the requested state.",
    warnings: plan.warnings ?? [],
    planHash: p.planHash ?? "",
    expiresAt: p.expiresAt,
    ...(p.evidence && !Array.isArray(p.evidence) && typeof p.evidence === "object" && p.evidence.refreshed ? { refreshed: p.evidence.refreshed } : {}),
    ...(p.evidence && !Array.isArray(p.evidence) && typeof p.evidence === "object" && p.evidence.stale === true ? { stale: true } : {}),
  };
}

// "sha256:3f9a…c21b" — enough to compare by eye with the hash an agent reports.
export function shortHash(h: string | null | undefined): string {
  if (!h) return "—";
  const [algo, hex] = h.includes(":") ? h.split(":", 2) : ["", h];
  const body = hex.length > 16 ? `${hex.slice(0, 8)}…${hex.slice(-4)}` : hex;
  return algo ? `${algo}:${body}` : body;
}

export const PROPOSAL_STATE: Record<string, { label: string; tone: Tone }> = {
  pending: { label: "waiting for approval", tone: "accent" },
  approved: { label: "approved — running", tone: "warn" },
  consumed: { label: "approved and run", tone: "ok" },
  rejected: { label: "rejected", tone: "muted" },
  expired: { label: "expired", tone: "muted" },
  invalidated: { label: "invalidated", tone: "bad" },
};

// Why an approval request ended without running ("invalidated: the plan changed since it was requested").
export function invalidationText(detail: string | null | undefined): string | undefined {
  if (!detail) return undefined;
  const m = /^invalidated:\s*(.+)$/i.exec(detail.trim());
  return m ? m[1] : undefined;
}

// A plan that warns about database migrations needs the approver's explicit acknowledgement (services.switch).
export const plansMigrations = (plan: PlanLike | null | undefined) => (plan?.warnings ?? []).some((w) => /migration/i.test(w));

// ---------- metrics ----------

export interface MetricTile {
  key: string;
  label: string;
  value: string;
  hint: string;
  tone?: Tone;
}

function rateText(v: RunMetrics["verifiedCompletion"], runs: number): string {
  if (v && typeof v === "object") {
    if (typeof v.rate === "number") return `${Math.round(v.rate * 100)}%`;
    return typeof v.count === "number" ? `${v.count}${runs ? ` of ${runs}` : ""}` : "—";
  }
  if (typeof v !== "number" || !Number.isFinite(v)) return "—";
  // A fraction (0..1, not a whole count) is a rate; a whole number is a count of runs.
  return !Number.isInteger(v) && v >= 0 && v <= 1 ? `${Math.round(v * 100)}%` : `${v}${runs ? ` of ${runs}` : ""}`;
}

// The release metrics (AGENT_ARCHITECTURE §9): safety and usefulness, not how confident the model sounded.
export function metricTiles(m: RunMetrics): MetricTile[] {
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  return [
    { key: "runs", label: "Runs", value: String(n(m.runs)), hint: "Runs started in this period." },
    {
      key: "verified", label: "Verified completion",
      value: m.verifiedCompletion === null ? "—" : typeof m.verifiedCompletion === "number" && m.changes !== undefined ? `${Math.round(m.verifiedCompletion * 100)}%` : rateText(m.verifiedCompletion, n(m.runs)),
      // runMetrics: the share of runs whose accepted changes all ended verified healthy; the counts are per change.
      hint: m.changes !== undefined ? `Runs whose changes were verified healthy afterwards, of the runs whose change AWS accepted (${m.verifiedChanges ?? 0} of ${m.changes} accepted change${m.changes === 1 ? "" : "s"} verified). Accepted is not done.` : "Changes verified healthy afterwards, not merely accepted by AWS.",
    },
    { key: "escalations", label: "Escalations", value: rateText(m.escalations, n(m.runs)), hint: "Runs that handed the problem to a person (unhealthy after a change, or no safe action)." },
    { key: "unknown", label: "Unknown outcomes", value: String(n(m.outcomeUnknown)), hint: "Changes AWS may or may not have made.", tone: n(m.outcomeUnknown) ? "warn" : undefined },
    { key: "prevented", label: "Prevented violations", value: String(n(m.preventedViolations)), hint: "Calls the policy refused: out of scope, a forbidden tool, or a hard-denied change." },
    { key: "duplicates", label: "Duplicate effects", value: String(n(m.duplicateEffects)), hint: "Changes that reached AWS twice for one request. Expected: 0.", tone: n(m.duplicateEffects) ? "bad" : "ok" },
    { key: "invalidated", label: "Approvals invalidated", value: String(n(m.approvalsInvalidated)), hint: "Requests withdrawn because the plan, the resource or the policy changed before the change ran." },
    {
      key: "cost", label: "Inference cost (est.)", value: typeof m.estimatedCostUsd === "number" ? `$${m.estimatedCostUsd.toFixed(m.estimatedCostUsd < 10 ? 2 : 0)}` : "—",
      hint: `Measured model cost only — a provider's price is never guessed.${m.unmeasuredModelCalls ? ` ${m.unmeasuredModelCalls} model call${m.unmeasuredModelCalls === 1 ? "" : "s"} couldn't be measured.` : ""}`,
    },
  ];
}

// ---------- run list filters ----------

export type RunFilter = "all" | "active" | "waiting" | "attention" | "done";
export const RUN_FILTERS: { value: RunFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "active", label: "Active" },
  { value: "waiting", label: "Waiting" },
  { value: "attention", label: "Needs attention" },
  { value: "done", label: "Done" },
];

export function runMatches(r: Pick<RunListItem, "state">, f: RunFilter): boolean {
  switch (f) {
    case "all":
      return true;
    case "active":
      return r.state === "queued" || r.state === "running";
    case "waiting":
      return r.state === "waiting_approval" || r.state === "waiting_external";
    case "attention":
      return r.state === "paused_auth" || r.state === "paused_budget" || r.state === "failed" || r.state === "outcome_unknown";
    case "done":
      return r.state === "succeeded" || r.state === "cancelled";
  }
}

// ---------- agent tokens (F45: active first) ----------

export function agentTokenStatus(t: Pick<AgentTokenItem, "status" | "revokedAt" | "expiresAt">, now: number): "active" | "expired" | "revoked" {
  if (t.status) return t.status;
  if (t.revokedAt) return "revoked";
  if (t.expiresAt && t.expiresAt <= now) return "expired";
  return "active";
}

// ---------- connect your agent ----------

export interface ClientConfigs {
  claudeCode: string;
  mcpJson: string;
  gemini: string;
  curl: string;
}

// Configuration snippets for an MCP client: the console is a Streamable-HTTP MCP server at /api/mcp that takes the
// token as a bearer header. The client's own subscription pays for its model; the console never sees that login.
export function clientConfigs(origin: string, token: string): ClientConfigs {
  const url = `${origin.replace(/\/+$/, "")}/api/mcp`;
  const auth = `Bearer ${token}`;
  const init = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "curl", version: "1" } } });
  const list = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  const curl = (body: string) =>
    `curl -sS -X POST "${url}" \\\n  -H "Authorization: ${auth}" \\\n  -H "Content-Type: application/json" \\\n  -H "Accept: application/json, text/event-stream" \\\n  -d '${body}'`;
  return {
    claudeCode: `claude mcp add --transport http deployment-console ${url} --header "Authorization: ${auth}"`,
    mcpJson: JSON.stringify({ mcpServers: { "deployment-console": { type: "http", url, headers: { Authorization: auth } } } }, null, 2),
    gemini: JSON.stringify({ mcpServers: { "deployment-console": { httpUrl: url, headers: { Authorization: auth } } } }, null, 2),
    curl: `# initialize\n${curl(init)}\n\n# tools/list\n${curl(list)}`,
  };
}

// The token shown in a snippet before one exists (nothing real is ever pre-filled).
export const TOKEN_PLACEHOLDER = "<your token>";

// ---------- connection form ----------

export interface ProviderOptionLike {
  id: Provider;
  label: string;
  authKinds: readonly AuthKind[];
  endpoint?: { builtin?: string; custom: "registered" | "registered-local" };
  region?: true;
  personalOnly?: true;
  adminOnly?: true;
  createVia?: "oauth";
  secret?: { label: string; hint: string };
  note?: string;
  canCreate?: boolean;
  why?: string;
  signIn?: string;
}

export type SecretFieldKey = "apiKey" | "accessKeyId" | "secretAccessKey" | "sessionToken" | "roleArn" | "externalId";
export interface SecretField {
  key: SecretFieldKey;
  label: string;
  required: boolean;
  secret: boolean; // a password-type, write-only input
  hint?: string;
  placeholder?: string;
}

// The write-only fields an auth kind needs (connection-rules checkSecret's shapes).
export function secretFields(authKind: AuthKind): SecretField[] {
  switch (authKind) {
    case "api-key":
      return [{ key: "apiKey", label: "API key", required: true, secret: true }];
    case "aws-keys":
      return [
        { key: "accessKeyId", label: "Access key id", required: true, secret: false, placeholder: "AKIA…" },
        { key: "secretAccessKey", label: "Secret access key", required: true, secret: true },
        { key: "sessionToken", label: "Session token", required: false, secret: true, hint: "Only for temporary (ASIA…) keys." },
      ];
    case "aws-role":
      return [
        { key: "roleArn", label: "Role ARN", required: true, secret: false, placeholder: "arn:aws:iam::123456789012:role/bedrock-invoke" },
        { key: "externalId", label: "External id", required: false, secret: false },
        { key: "accessKeyId", label: "Access key id that assumes it", required: true, secret: false, placeholder: "AKIA…", hint: "The role is assumed with these keys — never with the console's own AWS identity." },
        { key: "secretAccessKey", label: "Secret access key", required: true, secret: true },
        { key: "sessionToken", label: "Session token", required: false, secret: true, hint: "Only for temporary (ASIA…) keys." },
      ];
    default:
      return [];
  }
}

export const AUTH_LABEL: Record<AuthKind, string> = {
  "api-key": "API key",
  "aws-role": "AWS role",
  "aws-keys": "AWS access keys",
  "oauth-plan": "Sign in",
  "local-runtime": "Local CLI login",
  none: "No key",
};

export interface ConnectionDraft {
  provider: Provider;
  authKind: AuthKind;
  label: string;
  scope: ConnectionScope;
  model: string;
  endpoint: string; // "" = the provider's built-in endpoint
  region: string;
  backgroundOk: boolean;
  minRole: string;
  secret: Partial<Record<SecretFieldKey, string>>;
}

export function emptyDraft(p: ProviderOptionLike): ConnectionDraft {
  return { provider: p.id, authKind: p.authKinds[0], label: p.label, scope: "personal", model: "", endpoint: "", region: "", backgroundOk: false, minRole: "developer", secret: {} };
}

// The endpoints a provider may use with a scope (the same rule the server applies on create and on every use).
export function endpointChoices(p: ProviderOptionLike, scope: ConnectionScope, registry: readonly EndpointEntry[]): { value: string; label: string }[] {
  if (!p.endpoint) return [];
  const out: { value: string; label: string }[] = [];
  if (p.endpoint.builtin) out.push({ value: "", label: `${p.endpoint.builtin} (built in)` });
  for (const e of registry) if (usableEndpoint(p.id, scope, e).ok) out.push({ value: e.url, label: `${e.label} — ${e.url}${e.local ? " (local)" : ""}` });
  return out;
}

// The POST body for a draft. The secret goes out once, only with the fields its auth kind takes, and empty optional
// fields are left out so the server applies its defaults; nothing else of the draft is ever echoed back.
export function connectionBody(d: ConnectionDraft, p: ProviderOptionLike, o: { admin: boolean }): Record<string, unknown> {
  const t = (s: string | undefined) => (s ?? "").trim();
  const body: Record<string, unknown> = { provider: d.provider, authKind: d.authKind, label: t(d.label) };
  const scope: ConnectionScope = o.admin && !p.personalOnly ? d.scope : "personal";
  body.scope = scope;
  if (t(d.model)) body.model = t(d.model);
  if (p.endpoint && t(d.endpoint)) body.endpoint = t(d.endpoint);
  if (p.region && t(d.region)) body.region = t(d.region);
  if (d.backgroundOk) body.backgroundOk = true;
  if (scope === "org" && d.minRole) body.minRole = d.minRole;
  const secret = secretBody(d.authKind, d.secret);
  if (secret !== undefined) body.secret = secret;
  return body;
}

// The write-only secret of a create or rotate (PATCH { secret }) request, in connection-rules checkSecret's shapes.
// undefined for auth kinds without one.
export function secretBody(authKind: AuthKind, s: Partial<Record<SecretFieldKey, string>>): unknown {
  const t = (v: string | undefined) => (v ?? "").trim();
  const keys = (k: Partial<Record<SecretFieldKey, string>>) => ({ accessKeyId: t(k.accessKeyId), secretAccessKey: t(k.secretAccessKey), ...(t(k.sessionToken) ? { sessionToken: t(k.sessionToken) } : {}) });
  if (authKind === "api-key") return t(s.apiKey);
  if (authKind === "aws-keys") return keys(s);
  if (authKind === "aws-role") return { roleArn: t(s.roleArn), ...(t(s.externalId) ? { externalId: t(s.externalId) } : {}), source: keys(s) };
  return undefined;
}

// Whether the required fields are there (the server re-validates everything).
export function draftReady(d: ConnectionDraft, p: ProviderOptionLike): boolean {
  if (!d.label.trim()) return false;
  if (p.region && !d.region.trim()) return false;
  if (p.endpoint && !p.endpoint.builtin && !d.endpoint.trim()) return false;
  return secretFields(d.authKind).every((f) => !f.required || !!d.secret[f.key]?.trim());
}

// ---------- agent templates ----------

export const TEMPLATES: { id: string; name: string; mode: "observe" | "propose" | "bounded-act"; blurb: string; llm: boolean }[] = [
  { id: "incident-investigator", name: "Incident investigator", mode: "propose", llm: true, blurb: "Explains why a service is unhealthy, cites the evidence and proposes one safe action for a person to approve." },
  { id: "approved-remediation", name: "Approved remediation", mode: "propose", llm: true, blurb: "Investigates, proposes one restart, scale or rollback, runs it only after approval, then verifies health and escalates if it isn't." },
  { id: "nonproduction-schedule", name: "Non-production schedule", mode: "bounded-act", llm: false, blurb: "Stops and starts explicitly listed non-production services on a schedule. No model; start restores the remembered task count." },
  { id: "daily-digest", name: "Daily digest", mode: "observe", llm: true, blurb: "Gathers the day's changes, failures, CI runs, costs and pending approvals into one summary." },
  { id: "cost-review", name: "Cost review", mode: "observe", llm: true, blurb: "Explains spend and idle resources (only with complete evidence). Never deletes anything." },
  { id: "config-drift", name: "Config drift", mode: "observe", llm: true, blurb: "Compares variable names and value fingerprints across environments. Fixes are tasks for a person in the Variables editor." },
];

export const MODE_LABEL: Record<string, { label: string; tone: Tone; hint: string }> = {
  observe: { label: "Observe", tone: "muted", hint: "Reads and explains; every change is refused." },
  propose: { label: "Propose", tone: "accent", hint: "Reads and plans; every change waits for a person's approval." },
  "bounded-act": { label: "Bounded act", tone: "warn", hint: "Listed changes on explicitly listed, unprotected non-production resources run within limits; everything else asks a person." },
};

// ---------- live updates ----------

// The stream events after which a run's record is re-read: its own run/step/operation/approval events, and the
// replay marker a reconnect sends first (so whatever happened while disconnected shows at once).
export const RUN_REFRESH_EVENTS = ["run", "step", "operation", "approval", "replayed"] as const;

export type LiveStatus = "connecting" | "live" | "reconnecting" | "ended";
export function liveLabel(s: LiveStatus, final: boolean): string {
  if (final) return "Finished";
  return s === "live" ? "Live" : s === "reconnecting" ? "Reconnecting — catching up when back" : s === "ended" ? "Not live (reload to follow)" : "Connecting";
}

// ---------- emergency stop ----------

// The banner every Automation tab shows while the stop is on (people see why and since when; admins can lift it).
export function stopBannerText(s: { on: boolean; by?: string; reason?: string } | undefined): string | undefined {
  if (!s?.on) return undefined;
  return `Emergency stop is on${s.by ? ` (turned on by ${s.by})` : ""}: no agent can change anything until an admin lifts it. Reads and investigations go on.${s.reason ? ` Reason: ${s.reason}` : ""}`;
}

// The agents switch: who decides, and whether the toggle can change it.
export function agentsSwitchText(e: { on: boolean; source: "env" | "settings" | "default" }, mode: "mock" | "aws" | string): { text: string; locked: boolean } {
  if (e.source === "env") return { text: `${e.on ? "On" : "Off"} — set by CONSOLE_AGENTS on the server. Unset it to decide here.`, locked: true };
  if (e.source === "settings") return { text: `${e.on ? "On" : "Off"} — set by an admin here.`, locked: false };
  return { text: `${e.on ? "On" : "Off"} by default (${mode === "aws" ? "off against a real AWS account until an admin turns them on" : "on with the simulated account"}).`, locked: false };
}

// A time in the future ("in 12m", "expired"), for approval and grant expiries.
export function untilText(at: number | null | undefined, now: number): string {
  if (!at) return "no expiry";
  if (!now) return "—";
  const ms = at - now;
  if (ms <= 0) return "expired";
  return ms < 3_600_000 ? `in ${Math.ceil(ms / 60_000)}m` : ms < 86_400_000 ? `in ${Math.floor(ms / 3_600_000)}h` : `in ${Math.floor(ms / 86_400_000)}d`;
}

// A resource selector in one line ("envs staging · 2 resources · unprotected only"); an empty one is everything the
// person can reach.
export function scopeText(s: { account?: string; regions?: string[]; envs?: string[]; keys?: string[]; kinds?: string[]; tags?: Record<string, string>; excludeProtected?: boolean } | null | undefined): string {
  if (!s) return "not recorded";
  const parts: string[] = [];
  if (s.envs?.length) parts.push(`${s.envs.length === 1 ? "env" : "envs"} ${s.envs.join(", ")}`);
  if (s.keys?.length) parts.push(s.keys.length <= 2 ? s.keys.join(", ") : `${s.keys.length} listed resources`);
  if (s.kinds?.length) parts.push(`kinds ${s.kinds.join(", ")}`);
  if (s.regions?.length) parts.push(`${s.regions.length === 1 ? "region" : "regions"} ${s.regions.join(", ")}`);
  if (s.account) parts.push(`account ${s.account}`);
  const tags = Object.entries(s.tags ?? {});
  if (tags.length) parts.push(`tags ${tags.map(([k, v]) => `${k}=${v}`).join(", ")}`);
  if (s.excludeProtected) parts.push("unprotected only");
  return parts.length ? parts.join(" · ") : "everything the person it acts for can reach";
}

// ---------- workflow drafts (structured editing, no free JSON) ----------

// A step's input as editable rows. Values are text in the form: a number stays a number, true/false a boolean, null
// null, a "{{ path }}" template stays a template, a [a, b] list a list of strings, and JSON ({…}, [1, 2], "007") is read
// as JSON; anything else is text. Rows are written so that reading them back gives the same input (a string that would
// read as something else is shown quoted), so editing one field never changes another.
export interface InputRow {
  key: string;
  value: string;
}
const NUMBER = /^-?\d+(\.\d+)?$/;
const asNumber = (v: string) => (NUMBER.test(v) && String(Number(v)) === v ? Number(v) : undefined);
// A string that reads back as itself when written bare (a "{{ template }}" does; "12", "true" or " x" don't).
const plainText = (v: string) => v === v.trim() && readValue(v) === v;
const plainItem = (v: unknown): v is string => typeof v === "string" && !!v && plainText(v) && !/[,\]]/.test(v);
export function inputRows(input: Record<string, unknown> | undefined): InputRow[] {
  return Object.entries(input ?? {}).map(([key, v]) => ({
    key,
    value:
      typeof v === "string" ? (plainText(v) ? v : JSON.stringify(v))
      : typeof v === "number" || typeof v === "boolean" ? String(v)
      : v === null || v === undefined ? "null"
      : Array.isArray(v) && v.length && v.every(plainItem) ? `[${v.join(", ")}]`
      : JSON.stringify(v),
  }));
}
export function rowsToInput(rows: readonly InputRow[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const r of rows) {
    const k = r.key.trim();
    if (!k || k === "__proto__" || k === "constructor" || k === "prototype") continue;
    out[k] = readValue(r.value.trim());
  }
  return out;
}
function readValue(v: string): unknown {
  const n = asNumber(v);
  if (n !== undefined) return n;
  if (v === "true" || v === "false") return v === "true";
  if (v === "null") return null;
  if (/^["[{]/.test(v)) {
    try {
      return JSON.parse(v);
    } catch {
      // not JSON: a "{{ template }}", a [a, b] list or text
    }
  }
  if (/^\[.*\]$/.test(v)) return v.slice(1, -1).split(",").map((s) => s.trim()).filter(Boolean);
  return v;
}

export const WORKFLOW_STEP_KINDS = ["tool", "model", "approval", "wait", "condition", "verify", "notify"] as const;
export type WorkflowStepKind = (typeof WORKFLOW_STEP_KINDS)[number];

export const STEP_KIND_LABEL: Record<WorkflowStepKind, { label: string; hint: string }> = {
  tool: { label: "Operation", hint: "Call one operation (a read, or a change the policy decides on)." },
  model: { label: "Model", hint: "Give a model a goal; it reads and proposes within the policy. Needs a connection (it pays)." },
  approval: { label: "Approval", hint: "Wait for a person to continue or stop the run." },
  wait: { label: "Wait", hint: "Pause for a number of seconds." },
  condition: { label: "Condition", hint: "Stop here unless an expression over earlier results holds." },
  verify: { label: "Verify", hint: "Repeat a read until an expression holds, or time out." },
  notify: { label: "Report", hint: "Write the result to the run, or announce it to the integrations." },
};

// A new step of a kind, with an id unique in the draft ("restart-2").
export function newStep(kind: WorkflowStepKind, taken: readonly string[]): Record<string, unknown> & { id: string; kind: WorkflowStepKind } {
  let n = 1;
  while (taken.includes(`${kind}-${n}`)) n++;
  const id = `${kind}-${n}`;
  switch (kind) {
    case "tool":
      return { id, kind, op: "envs.status", input: {} };
    case "model":
      return { id, kind, goal: "" };
    case "approval":
      return { id, kind, message: "Continue?" };
    case "wait":
      return { id, kind, seconds: 60 };
    case "condition":
      return { id, kind, expr: "true" };
    case "verify":
      return { id, kind, op: "services.get", input: {}, expect: "result.status == 'UP'", timeoutSeconds: 600 };
    case "notify":
      return { id, kind, to: "run", report: "text" };
  }
}

// A trigger in a few words, for lists (the preview has the server's own, longer wording).
export function triggerLabel(t: { type: string; cron?: string; tz?: string; source?: string; selector?: { envs?: string[]; keys?: string[] } } | undefined): string {
  if (!t) return "manual";
  if (t.type === "schedule") return `schedule ${t.cron ?? "?"}${t.tz && t.tz !== "UTC" ? ` (${t.tz})` : ""}`;
  if (t.type === "event") {
    const where = [...(t.selector?.envs ?? []), ...(t.selector?.keys ?? [])];
    return `${t.source === "alarm" ? "alarm" : "state change"}${where.length ? ` in ${where.join(", ")}` : ""}`;
  }
  return "manual";
}
