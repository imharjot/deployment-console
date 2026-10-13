// Evidence and outcomes of an agent run (master plan §6 C6 items 2 and 4; AGENT_ARCHITECTURE §6 "prompt injection",
// §10 "distinguish AI response completed, AWS request accepted and service verified healthy"). Pure: the tool layer
// (src/lib/server/agents/tools.ts) and the runner store what is built here.
//
// Evidence: everything a run read from the world — an operation's result, already redacted and minimised
// (src/lib/agents/redact.ts prepareEvidence) — gets a citation id (E1, E2, … per run), a source ("logs.recent
// staging/api", built from the call, never from the data), the time it was observed and a one-line summary. The model
// reads it inside an `untrusted` envelope: data, never instructions.
//
// Outcomes: a run's result has three separate parts — did the AI finish its answer, did AWS accept a change, is the
// service verified healthy — and "AWS accepted" is never reported as "healthy".
import { VERIFY_WINDOW_MS, verifyOutcome } from "../overview-rules.ts";
import type { RawService } from "../types.ts";
import type { Budget } from "./redact.ts";

// ---------- citation ids and sources ----------

export const EVIDENCE_ID = /^E[1-9]\d{0,5}$/;
export const evidenceLabel = (n: number) => `E${Math.max(1, Math.floor(n))}`;
export const isEvidenceId = (v: unknown): v is string => typeof v === "string" && EVIDENCE_ID.test(v);

// The ids an answer cites ("… OOM kills [E3][E6]"), in order, once each.
export function citedIds(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\[(E[1-9]\d{0,5})\]/g)) if (!out.includes(m[1])) out.push(m[1]);
  return out;
}

// Logs keep their newest lines (and at most 200 of them); everything else keeps the head. 16 KB either way.
export const LOG_OPS: readonly string[] = ["logs.recent", "logs.search"];
export const EVIDENCE_BYTES = 16_384;
export const evidenceBudget = (op: string): Budget => (LOG_OPS.includes(op) ? { maxBytes: EVIDENCE_BYTES, maxLines: 200, maxArray: 200, keep: "tail" } : { maxBytes: EVIDENCE_BYTES, maxLines: 200 });

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const word = (v: unknown) => (typeof v === "string" && /^[\w.:/@-]{1,120}$/.test(v) ? v : undefined);

// Where the evidence came from, from the call alone (never from what came back): the operation and the resource it
// named. Only identifier-shaped input values are used, so nothing free-form a model typed ends up in the label.
export function sourceOf(op: string, input: Record<string, unknown>): string {
  const env = word(input.env);
  const svc = word(input.service) ?? (Array.isArray(input.services) ? input.services.map(word).filter(Boolean).slice(0, 3).join(",") || undefined : undefined);
  const res = word(input.key) ?? word(input.resource) ?? word(input.host) ?? word(input.database) ?? word(input.id);
  const where = [env, svc].filter(Boolean).join("/") || res;
  return clip(where ? `${op} ${where}${res && where !== res ? ` ${res}` : ""}` : op, 200);
}

// ---------- summaries and ages ----------

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const scalar = (v: unknown) => (typeof v === "string" ? clip(v.replace(/\s+/g, " "), 60) : typeof v === "number" || typeof v === "boolean" ? String(v) : undefined);

// A one-line summary of a (redacted) result for the run view: counts and a few identifying fields, never a whole value.
export function summarise(data: unknown, isError = false): string {
  if (isError) {
    const e = isObj(data) ? (scalar(data.error) ?? scalar(data.reason)) : scalar(data);
    return clip(`refused or failed${e ? `: ${e}` : ""}`, 160);
  }
  if (Array.isArray(data)) return `${data.length} item${data.length === 1 ? "" : "s"}`;
  if (isObj(data)) {
    if (data.truncated === true && typeof data.preview === "string") return "large result (cut to a preview)";
    const parts: string[] = [];
    for (const k of ["env", "service", "key", "state", "status", "worst", "running", "desired"]) {
      const v = scalar(data[k]);
      if (v !== undefined) parts.push(`${k} ${v}`);
    }
    for (const [k, v] of Object.entries(data)) if (Array.isArray(v) && parts.length < 6) parts.push(`${v.length} ${k}`);
    if (data.plan && isObj(data.plan) && typeof data.plan.summary === "string") parts.unshift(`plan: ${clip(data.plan.summary, 80)}`);
    return clip(parts.join(", ") || `${Object.keys(data).length} fields`, 160);
  }
  const s = scalar(data);
  return s === undefined ? "no data" : clip(s, 160);
}

export const ageSeconds = (observedAt: number, now = Date.now()) => Math.max(0, Math.round((now - observedAt) / 1000));
export const isFresh = (observedAt: number, maxAgeSeconds: number, now = Date.now()) => now - observedAt <= maxAgeSeconds * 1000;

// What the model reads for one tool call: the untrusted envelope with its citation id.
export function toolResultText(evidenceId: string, envelope: { untrusted: true; source: string; observedAt: number; data: unknown }): string {
  return JSON.stringify({ evidenceId, untrusted: true, source: envelope.source, observedAt: new Date(envelope.observedAt).toISOString(), data: envelope.data });
}

// What the API shows for one piece of evidence (§3.5 `evidence[]`).
export interface EvidenceView {
  id: string;
  stepId: string;
  op: string;
  source: string;
  observedAt: number;
  ageSeconds: number;
  summary: string;
  isError: boolean;
  outcome: "result" | "denied" | "error";
  cut?: string[]; // what minimisation removed
  redacted?: string[]; // which kinds of secret were removed
}

// ---------- verification of one change ----------

// A services.get result → what verifyOutcome (overview-rules.ts, the sampler's own rule) needs. Own properties only;
// anything missing reads as unknown. undefined: not a service.
export interface ServiceFacts {
  state?: string;
  status?: string;
  desired?: number;
  running?: number;
  pending?: number;
  revisionArn?: string;
  deployments: { status?: string; rollout?: string; reason?: string; createdAt?: number; running?: number }[];
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const str = (v: unknown) => (typeof v === "string" ? v : undefined);

export function serviceFacts(get: unknown): ServiceFacts | undefined {
  if (!isObj(get) || typeof get.service !== "string") return undefined;
  const deployments = Array.isArray(get.deployments) ? get.deployments.filter(isObj) : [];
  const rev = isObj(get.revision) ? get.revision : {};
  return {
    state: str(get.state),
    status: str(get.status),
    desired: num(get.desired),
    running: num(get.running),
    pending: num(get.pending),
    revisionArn: str(rev.arn),
    deployments: deployments.map((d) => ({ status: str(d.status), rollout: str(d.rollout), reason: str(d.reason), createdAt: typeof d.createdAt === "string" ? Date.parse(d.createdAt) : num(d.createdAt), running: num(d.running) })),
  };
}

export type Health = "verified" | "unhealthy" | "pending";
export interface ChangeCheck {
  health: Health;
  detail?: string;
}

const BAD_STATES = ["DOWN", "DEGRADED"];

// Is an accepted change verified healthy? The operation's own verification (the sampler's, `verify`) wins when it has
// one; otherwise the service as just read must be steady on the new state (verifyOutcome) and report UP. A service
// that is steady but DOWN or DEGRADED is unhealthy; one that never settles within the window is unhealthy too.
export function checkChange(
  op: { action: string; createdAt: number; verify?: "verified" | "failed" | null; detail?: string },
  facts: ServiceFacts | null | undefined,
  now: number,
  windowMs = VERIFY_WINDOW_MS,
): ChangeCheck {
  const bad = facts?.state && BAD_STATES.includes(facts.state) ? `the service reports ${facts.state}` : undefined;
  if (op.verify === "failed") return { health: "unhealthy", detail: op.detail || "the change didn't take effect" };
  if (op.verify === "verified") return bad ? { health: "unhealthy", detail: `the change took effect, but ${bad}` } : { health: "verified" };
  const svc =
    facts === null || facts === undefined
      ? facts
      : ({
          status: facts.status ?? "ACTIVE",
          desired: facts.desired ?? 0,
          running: facts.running ?? 0,
          pending: facts.pending ?? 0,
          deployments: facts.deployments.map((d) => ({
            status: d.status ?? "PRIMARY", rolloutState: d.rollout, rolloutReason: d.reason, createdAt: d.createdAt ?? 0, running: d.running ?? 0, taskDefinition: "",
          })),
          taskDef: facts.revisionArn ? { arn: facts.revisionArn } : null,
        } as unknown as RawService);
  const v = verifyOutcome({ action: op.action, createdAt: op.createdAt }, svc, now, windowMs);
  if (v.result === "failed") return { health: "unhealthy", detail: v.detail };
  if (v.result === "pending") return { health: "pending", ...(v.detail ? { detail: v.detail } : {}) };
  if (bad) return { health: "unhealthy", detail: `steady on the new state, but ${bad}` };
  if (facts && facts.state && facts.state !== "UP" && !/^stop$/.test(op.action.slice(op.action.lastIndexOf(".") + 1))) return { health: "pending", detail: `the service reports ${facts.state}` };
  return { health: "verified" };
}

// ---------- the run's outcome ----------

export type AiOutcome = "completed" | "incomplete" | "failed" | "pending";
export type AwsOutcome = "accepted" | "none" | "unknown";
export type HealthOutcome = "verified" | "unhealthy" | "pending" | "n/a";

// One change the run made (an execute step and the verification after it).
export interface ChangeFacts {
  op: string;
  operationId?: string;
  aws: "accepted" | "failed" | "unknown" | "pending" | "none"; // pending: still in flight; none: never reached AWS
  health: Health | "n/a"; // n/a: not a change the console can verify (or nothing was accepted)
  detail?: string;
}

export interface OutcomeFacts {
  ai: { answered: boolean; incomplete?: boolean; failed?: boolean; without?: "external" | "deterministic" }; // without: a run with no AI step of its own
  changes: ChangeFacts[];
}

export interface RunOutcome {
  ai: AiOutcome;
  aws: AwsOutcome;
  health: HealthOutcome;
  text: { ai: string; aws: string; health: string };
}

export function runOutcome(f: OutcomeFacts): RunOutcome {
  const ai: AiOutcome = f.ai.failed ? "failed" : f.ai.incomplete ? "incomplete" : f.ai.answered ? "completed" : "pending";
  const unknown = f.changes.filter((c) => c.aws === "unknown" || c.aws === "pending");
  const accepted = f.changes.filter((c) => c.aws === "accepted");
  const aws: AwsOutcome = unknown.length ? "unknown" : accepted.length ? "accepted" : "none";
  const checked = accepted.filter((c) => c.health !== "n/a");
  const health: HealthOutcome =
    aws === "none" ? "n/a"
    : aws === "unknown" ? "pending"
    : checked.some((c) => c.health === "unhealthy") ? "unhealthy"
    : checked.some((c) => c.health === "pending") ? "pending"
    : checked.length ? "verified"
    : "n/a";
  const failed = f.changes.filter((c) => c.aws === "failed");
  return {
    ai,
    aws,
    health,
    text: {
      ai:
        f.ai.without === "external" ? "an external agent: its answers stay in its own client"
        : f.ai.without === "deterministic" ? "no AI step in this run"
        : ai === "completed" ? "AI response completed"
        : ai === "incomplete" ? "the AI response was cut off before it finished"
        : ai === "failed" ? "the AI response failed"
        : "the AI is still working",
      aws:
        aws === "accepted" ? `AWS accepted ${accepted.length === 1 ? "the change" : `${accepted.length} changes`} (accepted is not the same as healthy)`
        : aws === "unknown" ? `whether AWS acted on ${unknown.length === 1 ? "a change" : `${unknown.length} changes`} is not known yet — verifying, never resending`
        : failed.length ? `no change reached AWS successfully (${failed.length} refused or failed)`
        : "no change was made",
      health:
        health === "verified" ? "service verified healthy after the change"
        : health === "unhealthy" ? `not healthy after the change — escalated to a person${checked.find((c) => c.health === "unhealthy")?.detail ? `: ${checked.find((c) => c.health === "unhealthy")!.detail}` : ""}`
        : health === "pending" ? "verifying whether the service is healthy"
        : aws === "accepted" ? "this kind of change can't be verified by the console — check the resource"
        : "nothing to verify",
    },
  };
}

// The state a finished run ends in (nothing left to run, no request waiting for a person): an unknown outcome stays
// unknown, an unhealthy result or a failed answer fails the run (its notification is the escalation), otherwise it
// succeeded.
export function finalState(o: RunOutcome, changes: ChangeFacts[]): { state: "succeeded" | "failed" | "outcome_unknown"; error?: string } {
  if (o.aws === "unknown") return { state: "outcome_unknown", error: "a change's outcome is unknown — check the resource before trying again" };
  if (o.health === "unhealthy") return { state: "failed", error: `escalated: ${o.text.health}` };
  if (o.ai === "failed") return { state: "failed", error: "the AI response failed" };
  if (o.ai === "incomplete") return { state: "failed", error: "the AI response was cut off before it finished" };
  const refused = changes.filter((c) => c.aws === "failed");
  if (refused.length && o.aws === "none") return { state: "failed", error: `the approved change didn't go through: ${refused.map((c) => c.detail ?? c.op).join("; ").slice(0, 300)}` };
  return { state: "succeeded" };
}
