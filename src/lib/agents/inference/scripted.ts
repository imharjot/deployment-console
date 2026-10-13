// The scripted "model": a deterministic adapter for the demo, the runner's tests and the agent scenarios. No network,
// no randomness, no clock in its answers — the same conversation always gets the same turn.
//
// A script is either
// - declarative: an ordered list of turns (text and/or tool calls), each with optional rules choosing the next turn
//   from the tool results that answered it ("when a result from services.get contains DEGRADED → go to turn x"); the
//   turn played is remembered in a `native` block (provider "scripted"), which the runner sends back unchanged; or
// - programmatic: next(ctx) computes the reply from the goal and the tool results so far (./scripts/incident-demo.ts).
//
// Failures can be injected per turn or per script (quota, auth, rate limits, an outage, an incomplete stream, a
// cancellation, a hang until the run is cancelled), optionally only for the first N attempts, so the runner's pause /
// retry / cancel paths are exercised exactly as a real provider would trigger them.
import { capabilitiesFor, checkRequest, modelOffered } from "./capabilities.ts";
import { emit, estimateTokens, findTool, makeResult, messageText, opOf, textOf, toolName } from "./messages.ts";
import {
  InferenceError,
  type ContentBlock,
  type GenerateRequest,
  type InferenceAdapter,
  type ModelInfo,
  type ModelMessage,
  type ResolvedConnection,
  type StopReason,
  type ToolSpec,
} from "./types.ts";

const LABEL = "Scripted model";

// ---------- script shapes ----------

export type InjectedFailure =
  | { kind: "quota"; resetAt?: number; message?: string }
  | { kind: "auth"; message?: string }
  | { kind: "rate_limited"; retryAfterMs?: number; message?: string }
  | { kind: "unavailable"; message?: string }
  | { kind: "incomplete_stream"; partialText?: string }
  | { kind: "cancelled" }
  | { kind: "hang" }; // waits until the request's signal aborts, then "cancelled"

// `times`: fail only the first N attempts of that turn (a retry then succeeds); absent = every attempt.
export type ScheduledFailure = InjectedFailure & { times?: number };

export interface ScriptCall {
  op: string; // operation name ("services.get") or wire name ("services_get")
  input: Record<string, unknown>;
  // Call it even if the request didn't offer the tool (a model obeying an injected instruction does that); by default
  // a call to a tool the request doesn't list is left out, as a well-behaved model would.
  force?: boolean;
}

export interface ScriptReply {
  text?: string;
  toolCalls?: ScriptCall[];
  stop?: Exclude<StopReason, "tool_calls">; // default: "tool_calls" when there are calls, else "end"
  refusal?: string;
  fail?: ScheduledFailure;
}

export interface ScriptCondition {
  resultFrom?: string; // only results of this operation
  resultContains?: string; // case-insensitive, in the result text
  isError?: boolean;
  goalContains?: string; // case-insensitive, in the first user message
}

export interface ScriptTurn extends ScriptReply {
  id: string;
  next?: { when: ScriptCondition; goto: string }[]; // first match wins; no match → the following turn
}

// What a programmatic script sees: the goal, every tool call so far with its result, and the tools on offer.
export interface ToolResultView {
  callId: string;
  op: string;
  name: string;
  input: Record<string, unknown>;
  content: string;
  isError: boolean;
  evidenceId?: string;
  data: unknown; // the result parsed (an untrusted envelope or { result } unwrapped); the raw text when it isn't JSON
}

export interface ScriptContext {
  request: GenerateRequest;
  goal: string;
  turn: number; // assistant turns so far
  results: ToolResultView[]; // every answered call, oldest first
  last: ToolResultView[]; // the results of the latest user message
  tool(op: string): ToolSpec | undefined;
}

export interface Script {
  name: string;
  description: string;
  models?: string[]; // the model ids that select this script (default [name])
  turns?: ScriptTurn[];
  next?(ctx: ScriptContext): ScriptReply;
  fail?: ScheduledFailure & { atTurn?: number }; // a failure for the whole script (or one turn number)
}

// ---------- registry (on globalThis: the worker and the routes are separate bundles) ----------

const g = globalThis as typeof globalThis & { __consoleInferenceScripts?: Map<string, Script>; __consoleScriptedAttempts?: Map<string, number> };

export function scriptRegistry(): Map<string, Script> {
  return (g.__consoleInferenceScripts ??= new Map());
}
export function registerScript(s: Script): void {
  if (!s?.name || (!s.turns?.length && typeof s.next !== "function")) throw new Error("a script needs a name and turns or next()");
  scriptRegistry().set(s.name, s);
}
export function unregisterScript(name: string): boolean {
  return scriptRegistry().delete(name);
}
export const scriptModels = (s: Script) => s.models?.length ? s.models : [s.name];
export function scriptFor(model: string | undefined): Script | undefined {
  if (!model) return undefined;
  for (const s of scriptRegistry().values()) if (scriptModels(s).includes(model)) return s;
  return undefined;
}

// A copy of a script that fails as described (for the agent scenarios: "the demo, but the provider is out of quota").
export function withFailure(s: Script, fail: ScheduledFailure & { atTurn?: number }, name = `${s.name}+${fail.kind}`): Script {
  return { ...s, name, models: [name], fail };
}

// ---------- reading the conversation ----------

const EVIDENCE_ID = /^E\d{1,6}$/;

// A result's text → its data: untrusted envelopes ({ untrusted, source, observedAt, data }) and REST bodies
// ({ result }) unwrapped; plain text stays text.
export function resultData(content: string): { data: unknown; evidenceId?: string } {
  let v: unknown;
  try {
    v = JSON.parse(content);
  } catch {
    const m = /^\s*\[?(E\d{1,6})\]?[:\s]/.exec(content);
    return { data: content, ...(m ? { evidenceId: m[1] } : {}) };
  }
  let evidenceId: string | undefined;
  for (let i = 0; i < 3 && v && typeof v === "object" && !Array.isArray(v); i++) {
    const o = v as Record<string, unknown>;
    for (const k of ["evidenceId", "evidence", "citation", "id"]) if (!evidenceId && typeof o[k] === "string" && EVIDENCE_ID.test(o[k] as string)) evidenceId = o[k] as string;
    if (o.untrusted === true && Object.hasOwn(o, "data")) v = o.data;
    else if (Object.hasOwn(o, "result") && Object.keys(o).length <= 3) v = o.result;
    else break;
  }
  return { data: v, ...(evidenceId ? { evidenceId } : {}) };
}

export function readConversation(req: GenerateRequest): Omit<ScriptContext, "tool" | "request"> {
  const firstUser = req.messages.find((m) => m.role === "user");
  const goal = firstUser ? textOf(firstUser.content) : "";
  const calls = new Map<string, { name: string; input: Record<string, unknown> }>();
  const results: ToolResultView[] = [];
  let last: ToolResultView[] = [];
  let turn = 0;
  for (const m of req.messages) {
    if (m.role === "assistant") {
      turn++;
      for (const b of m.content) if (b.type === "tool_call") calls.set(b.id, { name: b.name, input: b.input });
      continue;
    }
    const here: ToolResultView[] = [];
    for (const b of m.content) {
      if (b.type !== "tool_result") continue;
      const c = calls.get(b.callId);
      const parsed = resultData(b.content);
      here.push({
        callId: b.callId,
        name: c?.name ?? "",
        op: c ? opOf(req.tools, c.name) : "",
        input: c?.input ?? {},
        content: b.content,
        isError: !!b.isError,
        data: parsed.data,
        ...((b.evidenceId ?? parsed.evidenceId) ? { evidenceId: b.evidenceId ?? parsed.evidenceId } : {}),
      });
    }
    if (here.length) {
      results.push(...here);
      last = here;
    } else if (m.content.some((b) => b.type === "text")) last = [];
  }
  return { goal, turn, results, last };
}

// The declarative turn played last (from its native marker), if any.
function lastTurnId(messages: readonly ModelMessage[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "assistant") continue;
    for (const b of m.content) if (b.type === "native" && b.provider === "scripted" && b.kind === "scripted-turn") return String((b.data as { turn?: unknown })?.turn ?? "");
    return undefined;
  }
  return undefined;
}

const has = (hay: string, needle: string) => hay.toLowerCase().includes(needle.toLowerCase());
function matches(c: ScriptCondition, ctx: Omit<ScriptContext, "tool" | "request">): boolean {
  if (c.goalContains !== undefined && !has(ctx.goal, c.goalContains)) return false;
  const pool = ctx.last.filter((r) => (c.resultFrom === undefined || r.op === c.resultFrom || r.name === c.resultFrom) && (c.isError === undefined || r.isError === c.isError));
  if (c.resultFrom !== undefined || c.isError !== undefined || c.resultContains !== undefined) {
    if (!pool.length) return false;
    if (c.resultContains !== undefined && !pool.some((r) => has(r.content, c.resultContains!))) return false;
  }
  return true;
}

// Which declarative turn comes next.
export function nextTurn(s: Script, req: GenerateRequest): ScriptTurn | undefined {
  const turns = s.turns ?? [];
  if (!turns.length) return undefined;
  const conv = readConversation(req);
  if (conv.turn === 0) return turns[0];
  const id = lastTurnId(req.messages);
  const i = id !== undefined ? turns.findIndex((t) => t.id === id) : conv.turn - 1;
  if (i < 0) return undefined;
  for (const rule of turns[i].next ?? []) if (matches(rule.when, conv)) return turns.find((t) => t.id === rule.goto);
  return turns[i + 1];
}

// ---------- the adapter ----------

function failure(f: InjectedFailure, signal?: AbortSignal): Promise<never> {
  const err = (kind: InferenceError["kind"], message: string, extra: { retryAfterMs?: number; resetAt?: number } = {}) => new InferenceError(kind, `${LABEL}: ${message}`, { provider: "scripted", code: `injected-${f.kind}`, ...extra });
  switch (f.kind) {
    case "quota":
      return Promise.reject(err("quota", f.message ?? "the account is out of quota (injected)", f.resetAt !== undefined ? { resetAt: f.resetAt } : {}));
    case "auth":
      return Promise.reject(err("auth", f.message ?? "the credential was refused (injected)"));
    case "rate_limited":
      return Promise.reject(err("rate_limited", f.message ?? "rate limited (injected)", f.retryAfterMs !== undefined ? { retryAfterMs: f.retryAfterMs } : {}));
    case "unavailable":
      return Promise.reject(err("unavailable", f.message ?? "the provider is unavailable (injected)"));
    case "incomplete_stream":
      return Promise.reject(err("incomplete_stream", "the stream broke off before the turn completed (injected)"));
    case "cancelled":
      return Promise.reject(err("cancelled", "request cancelled (injected)"));
    case "hang":
      if (!signal) return Promise.reject(err("invalid_request", "an injected hang needs a request signal"));
      return new Promise<never>((_, reject) => {
        const done = () => reject(err("cancelled", "request cancelled"));
        if (signal.aborted) done();
        else signal.addEventListener("abort", done, { once: true });
      });
  }
}

export interface ScriptedOptions {
  scripts?: Script[]; // registered when the adapter is created (unless a script of that name already is)
  attempts?: Map<string, number>; // failure counters (default: one on globalThis)
  defaultScript?: string; // used when a connection names no model
}

export function createScriptedAdapter(o: ScriptedOptions = {}): InferenceAdapter {
  for (const s of o.scripts ?? []) if (!scriptRegistry().has(s.name)) registerScript(s);
  const attempts = o.attempts ?? (g.__consoleScriptedAttempts ??= new Map());
  const modelOf = (conn: ResolvedConnection, req?: GenerateRequest) => req?.model ?? conn.model ?? o.defaultScript;

  const list = (): ModelInfo[] =>
    [...scriptRegistry().values()]
      .flatMap((s) => scriptModels(s).map((id) => ({ id, label: `${s.description.split(/[.:]/)[0] || s.name} (scripted)`, capabilities: capabilitiesFor("scripted", id) })))
      .sort((a, b) => a.id.localeCompare(b.id));

  // Should this attempt fail? Counts attempts per connection, script, turn and history length, so a retry of the same
  // turn is recognised while a later turn starts fresh.
  const due = (conn: ResolvedConnection, script: Script, turnKey: string, req: GenerateRequest, f: ScheduledFailure | undefined): boolean => {
    if (!f) return false;
    if (f.times === undefined) return true;
    const key = `${conn.id}|${script.name}|${turnKey}|${req.messages.length}`;
    const n = (attempts.get(key) ?? 0) + 1;
    attempts.set(key, n);
    if (attempts.size > 10_000) attempts.delete(attempts.keys().next().value!);
    return n <= f.times;
  };

  return {
    provider: "scripted",
    label: LABEL,
    async models() {
      return list();
    },
    async validate(conn) {
      const models = list();
      const model = modelOf(conn);
      const missing = modelOffered(models, model, LABEL);
      if (missing) return { ok: false, models, error: { kind: missing.kind, message: missing.message } };
      return { ok: true, model, models, capabilities: capabilitiesFor("scripted", model) };
    },
    async generate(conn, req) {
      if (req.signal?.aborted) throw new InferenceError("cancelled", `${LABEL}: request cancelled`, { provider: "scripted" });
      const model = modelOf(conn, req);
      const script = scriptFor(model);
      if (!script) throw new InferenceError("unsupported", `${LABEL}: no script named ${model ?? "(none)"} — it is no longer offered`, { provider: "scripted", code: "model_not_found" });
      const caps = capabilitiesFor("scripted", model);
      const eff = checkRequest(req, caps, LABEL, model!);
      const conv = readConversation(req);

      // The reply, and the turn it came from.
      let reply: ScriptReply;
      let turnId: string | undefined;
      if (script.turns?.length) {
        const t = nextTurn(script, req);
        reply = t ?? { text: "(the script has no further turns)" };
        turnId = t?.id;
      } else reply = script.next!({ ...conv, request: req, tool: (op) => findTool(req.tools, op) });

      const scriptFail = script.fail && (script.fail.atTurn === undefined || script.fail.atTurn === conv.turn) ? script.fail : undefined;
      const f = reply.fail ?? scriptFail;
      if (due(conn, script, turnId ?? `turn-${conv.turn}`, req, f)) {
        if (f!.kind === "incomplete_stream" && f!.partialText) emit(req.onEvent, { type: "text", text: f!.partialText });
        await failure(f!, req.signal);
      }

      // Tool calls the request offers (or forced ones), with ids unique in the conversation and stable across reruns.
      const calls: ContentBlock[] = [];
      for (const [i, c] of (reply.toolCalls ?? []).entries()) {
        const spec = findTool(req.tools, c.op);
        if (!spec && !c.force) continue;
        const name = spec?.name ?? toolName(c.op);
        const id = `sc_${conv.turn + 1}_${i + 1}`;
        calls.push({ type: "tool_call", id, name, input: structuredClone(c.input) });
        emit(req.onEvent, { type: "tool_call", id, name });
      }
      if (!eff.parallelToolCalls && calls.length > 1) calls.length = 1;
      let text = reply.text ?? "";
      let stop: StopReason = reply.stop ?? (calls.length ? "tool_calls" : "end");
      // The hard output limit, simulated: an answer longer than maxOutputTokens is cut and its calls dropped.
      const outTokens = estimateTokens(text) + estimateTokens(JSON.stringify(calls));
      if (eff.maxOutputTokens !== undefined && outTokens > eff.maxOutputTokens) {
        text = text.slice(0, eff.maxOutputTokens * 4);
        calls.length = 0;
        stop = "max_tokens";
      }
      if (text) emit(req.onEvent, { type: "text", text });
      const content: ContentBlock[] = [...(text ? [{ type: "text" as const, text }] : []), ...(stop === "refusal" ? [] : calls)];
      if (turnId !== undefined) content.push({ type: "native", provider: "scripted", kind: "scripted-turn", data: { script: script.name, turn: turnId } });
      const input = estimateTokens([req.system ?? "", JSON.stringify(req.tools ?? []), ...req.messages.map(messageText)].join("\n"));
      const usage = { inputTokens: input, outputTokens: Math.min(outTokens, eff.maxOutputTokens ?? outTokens) };
      emit(req.onEvent, { type: "usage", usage });
      return makeResult({
        stop,
        content,
        usage,
        model: model!,
        requestId: `scripted-${conn.id}-${conv.turn + 1}`,
        providerStop: stop,
        ...(stop === "refusal" ? { refusal: reply.refusal ?? text } : {}),
        ...(stop === "incomplete" ? { incompleteReason: "scripted" } : {}),
      });
    },
  };
}
