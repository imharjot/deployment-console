// The agent's tool layer (master plan §6 C6 items 1–2; AGENT_ARCHITECTURE §6 "prompt injection and credentials").
//
// - Tool definitions come only from the operation registry, filtered by the run's policy (toolSourcesFor): never from
//   resource data. A run records the sha256 of its list (names, descriptions, schemas) when it starts; every later
//   model turn — and the MCP tools/list of a run's own token (checkRunTools) — must produce the same hash, or the run
//   stops: "tool definitions changed during the run".
// - Every call goes through invoke() as the run's agent caller (principals.ts agentCaller), inside withAgentContext:
//   the policy engine, the role and the approvals decide, never the model.
// - What comes back is evidence: redacted, minimised (16 KB; logs at most their newest 200 lines), wrapped `untrusted`
//   with the time it was observed, and given a citation id (E1, E2, …). Refusals are results too — the model reads why.
import "server-only";
import { createHash } from "node:crypto";
import { evidenceBudget, sourceOf, summarise, toolResultText, type EvidenceView } from "../../agents/evidence.ts";
import { toolSpec } from "../../agents/inference/messages.ts";
import type { ToolCallBlock, ToolSpec } from "../../agents/inference/types.ts";
import { isFinalRun } from "../../agents/run-state.ts";
import { prepareEvidence } from "../../agents/redact.ts";
import type { AgentPrincipal } from "../../agents/types.ts";
import { toolName, validate } from "../../ops-schema.ts";
import { canonicalJson } from "../../plan-hash.ts";
import { HttpError, errText, errorBody } from "../errors.ts";
import { OpInputError, findOp, invoke, maskInput, toolSourcesFor, type Caller } from "../ops/index.ts";
import type { AnyOperation } from "../ops/types.ts";
import { withAgentContext } from "./principals.ts";
import { getRun, updateRun } from "./store.ts";

// ---------- definitions and their hash ----------

// The tools a model may see for this caller, as the registry describes them (sorted, so the hash is stable).
export function toolSpecsFor(c: Caller): ToolSpec[] {
  return toolSourcesFor(c)
    .map((s) => toolSpec(s))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export const toolsHash = (specs: readonly ToolSpec[]): string =>
  `sha256:${createHash("sha256").update(canonicalJson({ v: 1, tools: specs.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) })).digest("hex")}`;

export const TOOLS_CHANGED = "tool definitions changed during the run";

// Ends the run when its tool list no longer hashes as it did at the start (a changed description could carry an
// instruction; a changed schema or a new tool is a different agent). Runs without a recorded hash (an external agent's)
// aren't checked. Returns false when it stopped the run.
export async function ensureToolsUnchanged(runId: string, specs: readonly ToolSpec[]): Promise<boolean> {
  const run = await getRun(runId);
  if (!run?.tools_hash) return true;
  if (toolsHash(specs) === run.tools_hash) return true;
  if (!isFinalRun(run.state)) await updateRun(runId, { state: "failed", error: TOOLS_CHANGED }).catch(() => {});
  return false;
}

// For the MCP endpoint's tools/list with a run's own token (an embedded CLI): the list it is about to send must be
// the one the run started with. Throws 409 (and the run is stopped) when it isn't.
export async function checkRunTools(c: Caller): Promise<void> {
  if (c.via !== "agent" || !c.runId) return;
  if (!(await ensureToolsUnchanged(c.runId, toolSpecsFor(c)))) throw Object.assign(new HttpError(409, `${TOOLS_CHANGED} — the run was stopped`), { code: "tools_changed" });
}

// ---------- a model's calls ----------

export type CallPlan =
  | { kind: "read" | "change"; call: ToolCallBlock; op: AnyOperation; input: Record<string, unknown> }
  | { kind: "invalid"; call: ToolCallBlock; error: string };

// What a call is, before anything runs: its operation (by wire name, from the registry — a tool the run wasn't offered
// still goes to the registry, which refuses it on the record), and whether its arguments validate. Unknown names and
// arguments that aren't a valid object are refused here.
export function classifyCall(call: ToolCallBlock, offered: readonly ToolSpec[]): CallPlan {
  if (call.inputError) return { kind: "invalid", call, error: `the arguments of ${call.name} were not usable: ${call.inputError}` };
  const spec = offered.find((t) => t.name === call.name);
  const op = findOp(spec?.op ?? call.name);
  if (!op || toolName(op.name) !== call.name) return { kind: "invalid", call, error: `there is no tool called ${String(call.name).slice(0, 80)}` };
  const problems = validate(op.input, call.input);
  if (problems.length) return { kind: "invalid", call, error: `invalid input for ${call.name}: ${problems.join("; ").slice(0, 600)}` };
  const risk = op.riskOf?.(call.input) ?? op.risk;
  return { kind: risk === "read" ? "read" : "change", call, op, input: call.input };
}

// ---------- results as evidence ----------

export interface ToolOutcome {
  evidenceId?: string;
  op: string;
  input: Record<string, unknown>; // masked (secret fields hidden)
  source: string;
  observedAt: number;
  outcome: "result" | "denied" | "error";
  isError: boolean;
  status?: number;
  code?: string;
  summary: string;
  content: string; // what the model reads: the untrusted envelope with its citation id
  cut?: string[];
  redacted?: string[];
  bytes?: number;
}

const DENIED = new Set([401, 403, 409, 423, 503]);

// A result (or a refusal) → evidence. `data` is what the operation returned; nothing here is trusted.
export function asEvidence(o: { op: string; input: Record<string, unknown>; data: unknown; observedAt: number; evidenceId?: string; outcome?: ToolOutcome["outcome"]; status?: number; code?: string }): ToolOutcome {
  const op = findOp(o.op);
  let masked: Record<string, unknown> = {};
  try {
    masked = maskInput(op, o.input);
  } catch {
    masked = {};
  }
  const outcome = o.outcome ?? "result";
  const isError = outcome !== "result";
  const source = sourceOf(o.op, o.input);
  const p = prepareEvidence(source, o.observedAt, o.data, evidenceBudget(o.op));
  const content = o.evidenceId ? toolResultText(o.evidenceId, p.evidence) : JSON.stringify(p.evidence);
  return {
    ...(o.evidenceId ? { evidenceId: o.evidenceId } : {}),
    op: o.op, input: masked, source, observedAt: o.observedAt, outcome, isError,
    ...(o.status ? { status: o.status } : {}), ...(o.code ? { code: o.code } : {}),
    summary: summarise(p.evidence.data, isError), content,
    ...(p.cut.length ? { cut: p.cut.slice(0, 20) } : {}), ...(p.findings.length ? { redacted: [...new Set(p.findings)] } : {}), bytes: p.bytes,
  };
}

const refusal = (e: unknown) => {
  const status = e instanceof HttpError ? e.status : (e as { status?: number })?.status;
  const body = e instanceof HttpError ? errorBody(e) : { error: errText(e) };
  return { status, data: { ...body, ...(e instanceof OpInputError ? { problems: e.problems } : {}) }, outcome: (typeof status === "number" && DENIED.has(status) ? "denied" : "error") as ToolOutcome["outcome"] };
};

// One read, as the run's agent: invoke() (policy, role, scope), then evidence. Never throws for the call's own
// failure — a refusal is a result the model reads.
export async function readAsEvidence(c: Caller | (() => Promise<Caller>), principal: AgentPrincipal, op: string, input: Record<string, unknown>, evidenceId?: string): Promise<ToolOutcome> {
  try {
    const caller = typeof c === "function" ? await c() : c;
    const r = await withAgentContext(principal, () => invoke(op, input, caller));
    const data = r.kind === "result" ? r.result : r.kind === "plan" ? { plan: r.plan } : { approval: { id: r.approval.id, status: r.approval.status } };
    return asEvidence({ op, input, data, observedAt: Date.now(), evidenceId });
  } catch (e) {
    const f = refusal(e);
    return asEvidence({ op, input, data: f.data, observedAt: Date.now(), evidenceId, outcome: f.outcome, status: f.status, code: (f.data as { code?: string }).code });
  }
}

// A refusal of a change (a propose step's dry run or request), as the model reads it.
export function refusalText(e: unknown): { content: string; status?: number; code?: string; outcome: ToolOutcome["outcome"]; error: string } {
  const f = refusal(e);
  return { content: JSON.stringify({ ...f.data, status: f.status }), status: f.status, code: (f.data as { code?: string }).code, outcome: f.outcome, error: String((f.data as { error?: string }).error ?? "refused") };
}

// The API's view of one piece of evidence (§3.5), from a stored tool outcome.
export const evidenceView = (stepId: string, t: ToolOutcome, now = Date.now()): EvidenceView | undefined =>
  t.evidenceId
    ? {
        id: t.evidenceId, stepId, op: t.op, source: t.source, observedAt: t.observedAt, ageSeconds: Math.max(0, Math.round((now - t.observedAt) / 1000)), summary: t.summary,
        isError: t.isError, outcome: t.outcome, ...(t.cut ? { cut: t.cut } : {}), ...(t.redacted ? { redacted: t.redacted } : {}),
      }
    : undefined;
