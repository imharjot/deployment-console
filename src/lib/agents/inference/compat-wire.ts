// OpenAI-compatible chat completions (POST <base>/chat/completions, stream: true): vLLM, LM Studio, gateways and
// Ollama's /v1 endpoint. Pure.
//
// Compatible servers differ in the details, so the parser is forgiving where it is safe and strict where it matters:
// - tool calls arrive split across deltas (id and name first, arguments in fragments, keyed by `index`); a server that
//   omits `index` or reuses index 0 for a second call with a new id is handled;
// - Ollama reports finish_reason "stop" on a turn that called tools — calls present means "tool_calls";
// - a turn is complete only once a finish_reason arrived; a stream that ends without one (with or without [DONE]) is
//   an incomplete stream, and so is an `error` object once the stream started;
// - a server that ignores stream: true and answers with one JSON completion is accepted (parseCompatCompletion).
import { cleanMessage, streamBroke } from "./errors.ts";
import { emit, makeResult, parseToolInput } from "./messages.ts";
import type { SseEvent } from "./sse.ts";
import type { WireStream } from "./anthropic-wire.ts";
import { InferenceError, type ContentBlock, type GenerateRequest, type GenerateResult, type ModelMessage, type StopReason, type StreamEvent, type Usage } from "./types.ts";

export const compatHeaders = (apiKey?: string): Record<string, string> => ({
  ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
  "content-type": "application/json",
  accept: "text/event-stream",
});

type Msg = Record<string, unknown>;

// Console messages → chat messages. Tool results become role "tool" messages right after the assistant turn that
// called them (before any user text); native blocks are dropped (chat completions has no continuation data).
export function chatMessages(system: string | undefined, messages: readonly ModelMessage[]): Msg[] {
  const out: Msg[] = system ? [{ role: "system", content: system }] : [];
  for (const m of messages) {
    if (m.role === "user") {
      const text: string[] = [];
      for (const b of m.content) {
        if (b.type === "tool_result") out.push({ role: "tool", tool_call_id: b.callId, content: b.content });
        else if (b.type === "text" && b.text) text.push(b.text);
      }
      if (text.length) out.push({ role: "user", content: text.join("\n\n") });
      continue;
    }
    const text = m.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { text: string }).text)
      .join("");
    const calls = m.content.flatMap((b) => (b.type === "tool_call" ? [{ id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(b.input) } }] : []));
    if (!text && !calls.length) continue;
    out.push({ role: "assistant", content: text || null, ...(calls.length ? { tool_calls: calls } : {}) });
  }
  return out;
}

export function buildChatRequest(req: GenerateRequest, model: string, eff: { parallelToolCalls: boolean; maxOutputTokens?: number }, o: { parallelParam?: boolean } = {}): Record<string, unknown> {
  const tools = req.tools ?? [];
  const choice = req.toolChoice ?? "auto";
  return {
    model,
    messages: chatMessages(req.system, req.messages),
    ...(tools.length
      ? {
          tools: tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: { type: "object", ...t.inputSchema } } })),
          tool_choice: typeof choice === "object" ? { type: "function", function: { name: choice.name } } : choice,
          // Sent only where the model is known to honour it; many servers reject unknown parameters.
          ...(o.parallelParam ? { parallel_tool_calls: eff.parallelToolCalls } : {}),
        }
      : {}),
    ...(eff.maxOutputTokens !== undefined ? { max_tokens: eff.maxOutputTokens } : {}),
    ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    stream: true,
    stream_options: { include_usage: true },
  };
}

const FINISH: Record<string, StopReason> = { stop: "end", tool_calls: "tool_calls", function_call: "tool_calls", length: "max_tokens", content_filter: "refusal" };

interface Call {
  id: string;
  name: string;
  args: string;
}

function usageOf(u: unknown): Usage {
  if (!u || typeof u !== "object") return {};
  const x = u as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === "number" ? v : undefined);
  return {
    inputTokens: num(x.prompt_tokens),
    outputTokens: num(x.completion_tokens),
    cacheReadTokens: num((x.prompt_tokens_details as Record<string, unknown> | undefined)?.cached_tokens),
    reasoningTokens: num((x.completion_tokens_details as Record<string, unknown> | undefined)?.reasoning_tokens),
  };
}

function result(o: { text: string; refusal: string; calls: Call[]; finish?: string; usage: Usage; model: string; requestId?: string }): GenerateResult {
  let stop: StopReason = FINISH[o.finish ?? ""] ?? "end";
  if (o.calls.length && stop === "end") stop = "tool_calls"; // Ollama: finish_reason "stop" on a tool-calling turn
  if (stop === "tool_calls" && !o.calls.length) stop = "end";
  const content: ContentBlock[] = [{ type: "text", text: o.text }];
  for (const c of o.calls) {
    if (stop !== "tool_calls") break; // calls cut off by max_tokens or a filter are never executable
    const p = parseToolInput(c.args);
    content.push({ type: "tool_call", id: c.id, name: c.name, input: p.input, ...(p.inputError ? { inputError: p.inputError } : {}) });
  }
  return makeResult({
    stop,
    content,
    usage: o.usage,
    model: o.model,
    requestId: o.requestId,
    providerStop: o.finish,
    ...(o.refusal || stop === "refusal" ? { refusal: o.refusal } : {}),
  });
}

export function createChatStream(o: { onEvent?: (e: StreamEvent) => void; label?: string } = {}): WireStream {
  const label = o.label ?? "Model endpoint";
  const calls: Call[] = [];
  const byIndex = new Map<number, Call>();
  let text = "";
  let refusal = "";
  let finish: string | undefined;
  let usage: Usage = {};
  let model = "";
  let id: string | undefined;
  let started = false;
  let done = false;

  const callFor = (d: Record<string, unknown>): Call => {
    const index = typeof d.index === "number" ? d.index : undefined;
    const newId = typeof d.id === "string" && d.id ? d.id : undefined;
    let c = index !== undefined ? byIndex.get(index) : newId ? calls.find((x) => x.id === newId) : calls[calls.length - 1];
    // A server that reuses an index (or sends no index) for a second call announces it with a new id.
    if (c && newId && c.id && c.id !== newId) c = undefined;
    if (!c) {
      c = { id: newId ?? `call_${calls.length}`, name: "", args: "" };
      calls.push(c);
      if (index !== undefined) byIndex.set(index, c);
    }
    return c;
  };

  return {
    get started() {
      return started;
    },
    push(ev: SseEvent) {
      if (done) return;
      if (ev.data.trim() === "[DONE]") {
        done = true;
        return;
      }
      let d: Record<string, unknown>;
      try {
        d = JSON.parse(ev.data) as Record<string, unknown>;
      } catch {
        if (started) throw streamBroke(label, "bad-json", "a chunk was not valid JSON", id);
        throw new InferenceError("unavailable", `${label} answered with something that is not an event stream`, { provider: label });
      }
      if (d.error) {
        const e = d.error as Record<string, unknown> | string;
        const msg = typeof e === "string" ? e : e.message;
        const code = typeof e === "object" && typeof e.code === "string" ? e.code : typeof e === "object" && typeof e.type === "string" ? e.type : undefined;
        if (started) throw streamBroke(label, code, msg, id);
        throw new InferenceError("unavailable", `${label} error${code ? ` (${code})` : ""}${msg ? `: ${cleanMessage(msg)}` : ""}`, { provider: label, code });
      }
      started = true;
      if (typeof d.model === "string" && d.model) model = d.model;
      if (typeof d.id === "string" && d.id) id = d.id;
      if (d.usage) usage = usageOf(d.usage);
      for (const ch of Array.isArray(d.choices) ? (d.choices as Record<string, unknown>[]) : []) {
        if ((ch.index ?? 0) !== 0) continue; // n = 1: only the first choice
        const delta = (ch.delta ?? {}) as Record<string, unknown>;
        if (typeof delta.content === "string" && delta.content) {
          text += delta.content;
          emit(o.onEvent, { type: "text", text: delta.content });
        }
        if (typeof delta.refusal === "string") refusal += delta.refusal;
        if (typeof delta.reasoning_content === "string" || typeof delta.reasoning === "string") emit(o.onEvent, { type: "thinking" });
        for (const tc of Array.isArray(delta.tool_calls) ? (delta.tool_calls as Record<string, unknown>[]) : []) {
          const c = callFor(tc);
          const fn = (tc.function ?? {}) as Record<string, unknown>;
          if (typeof fn.name === "string" && fn.name) {
            const first = !c.name;
            c.name = c.name && c.name !== fn.name ? c.name + fn.name : fn.name;
            if (first) emit(o.onEvent, { type: "tool_call", id: c.id, name: c.name });
          }
          // Some servers send the whole arguments object instead of a string fragment.
          if (typeof fn.arguments === "string") c.args += fn.arguments;
          else if (fn.arguments && typeof fn.arguments === "object") c.args = JSON.stringify(fn.arguments);
        }
        if (typeof ch.finish_reason === "string" && ch.finish_reason) finish = ch.finish_reason;
      }
    },
    finish(requestId?: string) {
      if (!finish) throw streamBroke(label, "no-finish-reason", started ? "the stream ended before a finish_reason" : "the stream ended before any chunk", requestId ?? id);
      return result({ text, refusal, calls, finish, usage, model, requestId: requestId ?? id });
    },
  };
}

// A server that answered stream: true with a single JSON completion.
export function parseCompatCompletion(json: unknown, label = "Model endpoint", requestId?: string): GenerateResult {
  const d = (json ?? {}) as Record<string, unknown>;
  if (d.error) {
    const e = d.error as Record<string, unknown> | string;
    throw new InferenceError("unavailable", `${label} error: ${cleanMessage(typeof e === "string" ? e : e.message)}`, { provider: label });
  }
  const ch = (Array.isArray(d.choices) ? (d.choices as Record<string, unknown>[])[0] : undefined) ?? {};
  const msg = (ch.message ?? {}) as Record<string, unknown>;
  if (typeof ch.finish_reason !== "string") throw streamBroke(label, "no-finish-reason", "the completion had no finish_reason", requestId);
  const calls = (Array.isArray(msg.tool_calls) ? (msg.tool_calls as Record<string, unknown>[]) : []).map((tc, i) => {
    const fn = (tc.function ?? {}) as Record<string, unknown>;
    return { id: typeof tc.id === "string" ? tc.id : `call_${i}`, name: String(fn.name ?? ""), args: typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments ?? {}) };
  });
  return result({
    text: typeof msg.content === "string" ? msg.content : "",
    refusal: typeof msg.refusal === "string" ? msg.refusal : "",
    calls,
    finish: ch.finish_reason,
    usage: usageOf(d.usage),
    model: typeof d.model === "string" ? d.model : "",
    requestId: requestId ?? (typeof d.id === "string" ? d.id : undefined),
  });
}

// GET <base>/models (OpenAI shape) → ids.
export function parseCompatModels(json: unknown): string[] {
  const data = Array.isArray((json as { data?: unknown })?.data) ? ((json as { data: unknown[] }).data as Record<string, unknown>[]) : [];
  return data.filter((m) => typeof m?.id === "string").map((m) => m.id as string);
}

// Ollama's GET /api/tags → names, and which of them are cloud models (a `remote_host`, or a "-cloud" name).
export function parseOllamaTags(json: unknown): { id: string; remote: boolean; family?: string }[] {
  const models = Array.isArray((json as { models?: unknown })?.models) ? ((json as { models: unknown[] }).models as Record<string, unknown>[]) : [];
  return models
    .filter((m) => typeof (m?.name ?? m?.model) === "string")
    .map((m) => {
      const id = String(m.name ?? m.model);
      const details = (m.details ?? {}) as Record<string, unknown>;
      return { id, remote: typeof m.remote_host === "string" || typeof m.remote_model === "string" || /(^|[-:])cloud$/i.test(id), ...(typeof details.family === "string" ? { family: details.family } : {}) };
    });
}

// Ollama's POST /api/show → what the model itself reports: capabilities ("completion", "tools", "thinking", …) and its
// context length (model_info "<arch>.context_length").
export function parseOllamaShow(json: unknown): { tools?: boolean; contextTokens?: number; remote?: boolean } {
  const d = (json ?? {}) as Record<string, unknown>;
  const caps = Array.isArray(d.capabilities) ? (d.capabilities as unknown[]).filter((c): c is string => typeof c === "string") : undefined;
  const info = (d.model_info ?? {}) as Record<string, unknown>;
  const ctxKey = Object.keys(info).find((k) => k.endsWith(".context_length"));
  const ctx = ctxKey && typeof info[ctxKey] === "number" ? (info[ctxKey] as number) : undefined;
  return {
    ...(caps ? { tools: caps.includes("tools") } : {}),
    ...(ctx ? { contextTokens: ctx } : {}),
    ...(typeof d.remote_host === "string" || typeof d.remote_model === "string" ? { remote: true } : {}),
  };
}
