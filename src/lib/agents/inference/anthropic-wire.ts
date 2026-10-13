// Anthropic Messages API wire format (POST /v1/messages, anthropic-version 2023-06-01, stream: true). Pure: builds the
// request body from a GenerateRequest and turns the SSE stream into a GenerateResult.
//
// Stream: message_start → (content_block_start → content_block_delta* → content_block_stop)* → message_delta →
// message_stop, with ping events anywhere. message_stop is the only success signal: a stream that ends without it, or
// an `error` event once it started, is an incomplete stream — nothing in it is used. Thinking blocks (with their
// signatures) and redacted thinking come back as `native` blocks and must be returned unchanged in the next request.
import { streamBroke } from "./errors.ts";
import { emit, makeResult, parseToolInput } from "./messages.ts";
import type { SseEvent } from "./sse.ts";
import { InferenceError, type Capabilities, type ContentBlock, type GenerateRequest, type GenerateResult, type ModelMessage, type StopReason, type StreamEvent, type Usage } from "./types.ts";

export const ANTHROPIC_VERSION = "2023-06-01";
export const ANTHROPIC_DEFAULT_BASE = "https://api.anthropic.com";
const LABEL = "Anthropic";
export const DEFAULT_MAX_TOKENS = 4_096;

export const anthropicHeaders = (apiKey: string): Record<string, string> => ({
  "x-api-key": apiKey,
  "anthropic-version": ANTHROPIC_VERSION,
  "content-type": "application/json",
  accept: "text/event-stream",
});

type Block = Record<string, unknown>;

// Console messages → Anthropic messages. Same-role neighbours are merged (the API wants alternating turns), a user
// turn's tool results come first (the API requires it), empty text is dropped, and native blocks from another provider
// are dropped.
export function anthropicMessages(messages: readonly ModelMessage[]): { role: "user" | "assistant"; content: Block[] }[] {
  const out: { role: "user" | "assistant"; content: Block[] }[] = [];
  for (const m of messages) {
    const results: Block[] = [];
    const rest: Block[] = [];
    for (const b of m.content) {
      if (b.type === "text") {
        if (b.text) rest.push({ type: "text", text: b.text });
      } else if (b.type === "tool_call") {
        if (m.role === "assistant") rest.push({ type: "tool_use", id: b.id, name: b.name, input: b.input });
      } else if (b.type === "tool_result") {
        if (m.role === "user") results.push({ type: "tool_result", tool_use_id: b.callId, ...(b.content ? { content: b.content } : {}), ...(b.isError ? { is_error: true } : {}) });
      } else if (b.provider === "anthropic" && m.role === "assistant" && b.data && typeof b.data === "object") rest.push(b.data as Block);
    }
    const content = [...results, ...rest];
    if (!content.length) continue;
    const last = out[out.length - 1];
    if (last?.role === m.role) {
      last.content.push(...content);
      if (m.role === "user") last.content.sort((a, b) => Number(b.type === "tool_result") - Number(a.type === "tool_result"));
    } else out.push({ role: m.role, content });
  }
  return out;
}

// `eff` is what checkRequest() allowed for this model: thinking as a budget (up to Claude 4.5) or adaptive (4.6 on —
// newer models refuse a budget), and no temperature where the model refuses it.
export function buildAnthropicRequest(
  req: GenerateRequest,
  model: string,
  eff: { parallelToolCalls: boolean; maxOutputTokens?: number; sampling?: false; thinkingMode?: "budget" | "adaptive" },
): Record<string, unknown> {
  const maxTokens = eff.maxOutputTokens ?? DEFAULT_MAX_TOKENS;
  const adaptive = eff.thinkingMode === "adaptive";
  if (req.thinking && !adaptive && (req.thinking.budgetTokens < 1_024 || req.thinking.budgetTokens >= maxTokens))
    throw new InferenceError("invalid_request", "the thinking budget must be at least 1024 tokens and below maxOutputTokens", { provider: LABEL });
  const tools = req.tools ?? [];
  const choice = req.toolChoice ?? "auto";
  // With thinking on, the API takes only tool choice "auto" or "none".
  if (req.thinking && tools.length && (choice === "required" || typeof choice === "object"))
    throw new InferenceError("unsupported", "Anthropic can't force a tool call while extended thinking is on", { provider: LABEL, code: "tool_choice" });
  const toolChoice =
    choice === "none" ? { type: "none" } : { ...(choice === "auto" ? { type: "auto" } : choice === "required" ? { type: "any" } : { type: "tool", name: choice.name }), ...(eff.parallelToolCalls ? {} : { disable_parallel_tool_use: true }) };
  return {
    model,
    max_tokens: maxTokens,
    stream: true,
    ...(req.system ? { system: req.system } : {}),
    messages: anthropicMessages(req.messages),
    ...(tools.length ? { tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: { type: "object", ...t.inputSchema } })), tool_choice: toolChoice } : {}),
    ...(req.thinking ? { thinking: adaptive ? { type: "adaptive" } : { type: "enabled", budget_tokens: req.thinking.budgetTokens } } : {}),
    ...(req.temperature !== undefined && !req.thinking && eff.sampling !== false ? { temperature: req.temperature } : {}),
  };
}

const STOP: Record<string, StopReason> = {
  end_turn: "end",
  stop_sequence: "end",
  tool_use: "tool_calls",
  max_tokens: "max_tokens",
  model_context_window_exceeded: "max_tokens",
  refusal: "refusal",
  pause_turn: "incomplete",
};

// The kinds an `error` event names, for an error before the stream really started.
const ERROR_KIND: Record<string, InferenceError["kind"]> = {
  overloaded_error: "unavailable",
  api_error: "unavailable",
  rate_limit_error: "rate_limited",
  authentication_error: "auth",
  permission_error: "auth",
  billing_error: "quota",
  not_found_error: "invalid_request",
  invalid_request_error: "invalid_request",
  request_too_large: "invalid_request",
};

interface Slot {
  type: string;
  text: string;
  json: string;
  id?: string;
  name?: string;
  thinking: string;
  signature: string;
  raw: Block;
  closed: boolean;
}

export interface WireStream {
  push(ev: SseEvent): void;
  readonly started: boolean;
  finish(requestId?: string): GenerateResult;
}

export function createAnthropicStream(o: { onEvent?: (e: StreamEvent) => void } = {}): WireStream {
  const slots = new Map<number, Slot>();
  const usage: Usage = {};
  let started = false;
  let stopped = false;
  let stopReason: string | undefined;
  let stopDetails: string | undefined; // a refusal's category / explanation (stop_details), when the API gives one
  let model = "";
  let messageId: string | undefined;

  const take = (u: unknown) => {
    if (!u || typeof u !== "object") return;
    const x = u as Record<string, unknown>;
    const n = (k: string) => (typeof x[k] === "number" ? (x[k] as number) : undefined);
    if (n("input_tokens") !== undefined) usage.inputTokens = n("input_tokens");
    if (n("output_tokens") !== undefined) usage.outputTokens = n("output_tokens");
    if (n("cache_read_input_tokens") !== undefined) usage.cacheReadTokens = n("cache_read_input_tokens");
    if (n("cache_creation_input_tokens") !== undefined) usage.cacheWriteTokens = n("cache_creation_input_tokens");
  };

  return {
    get started() {
      return started;
    },
    push(ev: SseEvent) {
      if (stopped) return; // nothing after message_stop counts
      let d: Record<string, unknown>;
      try {
        d = JSON.parse(ev.data) as Record<string, unknown>;
      } catch {
        if (started) throw streamBroke(LABEL, "bad-json", "an event was not valid JSON", messageId);
        throw new InferenceError("unavailable", "Anthropic answered with something that is not an event stream", { provider: LABEL });
      }
      const type = typeof d.type === "string" ? d.type : ev.event;
      switch (type) {
        case "message_start": {
          started = true;
          const m = (d.message ?? {}) as Record<string, unknown>;
          if (typeof m.model === "string") model = m.model;
          if (typeof m.id === "string") messageId = m.id;
          take(m.usage);
          return;
        }
        case "content_block_start": {
          const i = Number(d.index);
          const b = (d.content_block ?? {}) as Block;
          slots.set(i, {
            type: String(b.type ?? ""),
            text: typeof b.text === "string" ? b.text : "",
            json: "",
            id: typeof b.id === "string" ? b.id : undefined,
            name: typeof b.name === "string" ? b.name : undefined,
            thinking: typeof b.thinking === "string" ? b.thinking : "",
            signature: typeof b.signature === "string" ? b.signature : "",
            raw: b,
            closed: false,
          });
          if (b.type === "tool_use" && typeof b.id === "string") emit(o.onEvent, { type: "tool_call", id: b.id, name: String(b.name ?? "") });
          if (b.type === "thinking" || b.type === "redacted_thinking") emit(o.onEvent, { type: "thinking" });
          return;
        }
        case "content_block_delta": {
          const s = slots.get(Number(d.index));
          const delta = (d.delta ?? {}) as Record<string, unknown>;
          if (!s) throw streamBroke(LABEL, "protocol", "a delta arrived for a block that never started", messageId);
          if (delta.type === "text_delta" && typeof delta.text === "string") {
            s.text += delta.text;
            emit(o.onEvent, { type: "text", text: delta.text });
          } else if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") s.json += delta.partial_json;
          else if (delta.type === "thinking_delta" && typeof delta.thinking === "string") s.thinking += delta.thinking;
          else if (delta.type === "signature_delta" && typeof delta.signature === "string") s.signature += delta.signature;
          return;
        }
        case "content_block_stop": {
          const s = slots.get(Number(d.index));
          if (s) s.closed = true;
          return;
        }
        case "message_delta": {
          const delta = (d.delta ?? {}) as Record<string, unknown>;
          if (typeof delta.stop_reason === "string") stopReason = delta.stop_reason;
          const sd = (delta.stop_details ?? {}) as Record<string, unknown>;
          const why = [sd.category, sd.explanation].filter((x): x is string => typeof x === "string" && !!x).join(": ");
          if (why) stopDetails = why;
          take(d.usage);
          emit(o.onEvent, { type: "usage", usage: { ...usage } });
          return;
        }
        case "message_stop":
          stopped = true;
          return;
        case "error": {
          const e = (d.error ?? {}) as Record<string, unknown>;
          const code = typeof e.type === "string" ? e.type : undefined;
          if (started) throw streamBroke(LABEL, code, e.message, messageId);
          throw new InferenceError(ERROR_KIND[code ?? ""] ?? "unavailable", `Anthropic error${code ? ` (${code})` : ""}`, { provider: LABEL, code });
        }
        default:
          return; // ping and event types added later
      }
    },
    finish(requestId?: string): GenerateResult {
      if (!started || !stopped) throw streamBroke(LABEL, "no-message-stop", started ? "the stream ended before message_stop" : "the stream ended before message_start", requestId ?? messageId);
      const stop: StopReason = STOP[stopReason ?? ""] ?? (stopReason ? "incomplete" : "end");
      const content: ContentBlock[] = [];
      for (const i of [...slots.keys()].sort((a, b) => a - b)) {
        const s = slots.get(i)!;
        if (s.type === "text") content.push({ type: "text", text: s.text });
        else if (s.type === "tool_use") {
          // A tool call cut off mid-arguments (max_tokens) is dropped; in a completed turn bad JSON is kept as an
          // inputError the runner answers instead of executing.
          if (!s.closed && stop !== "tool_calls") continue;
          const p = parseToolInput(s.json);
          if (p.inputError && stop !== "tool_calls") continue;
          content.push({ type: "tool_call", id: s.id ?? `toolu_${i}`, name: s.name ?? "", input: p.input, ...(p.inputError ? { inputError: p.inputError } : {}) });
        } else if (s.type === "thinking") content.push({ type: "native", provider: "anthropic", kind: "thinking", data: { type: "thinking", thinking: s.thinking, signature: s.signature } });
        else if (s.type === "redacted_thinking") content.push({ type: "native", provider: "anthropic", kind: "redacted_thinking", data: { ...s.raw } });
        else if (s.type) content.push({ type: "native", provider: "anthropic", kind: s.type, data: { ...s.raw } });
      }
      const hasCalls = content.some((b) => b.type === "tool_call");
      const finalStop: StopReason = stop === "tool_calls" && !hasCalls ? "end" : stop;
      return makeResult({
        stop: finalStop,
        content,
        usage,
        model,
        requestId: requestId ?? messageId,
        providerStop: stopReason,
        ...(finalStop === "refusal" ? { refusal: content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("") || stopDetails || "" } : {}),
        ...(finalStop === "incomplete" ? { incompleteReason: stopReason } : {}),
      });
    },
  };
}

// GET /v1/models lists dated ids ("claude-sonnet-4-5-20250929") for older models, while a connection may name the alias
// the API also accepts ("claude-sonnet-4-5", "claude-3-5-haiku-latest"): the alias is offered while a dated id of it is.
export function anthropicModelMatches(listed: string, model: string): boolean {
  if (listed === model) return true;
  const base = model.replace(/-latest$/, "");
  return listed.startsWith(`${base}-`) && /^\d{8}$/.test(listed.slice(base.length + 1));
}

// GET /v1/models → ModelInfo[]. Limits the API reports (max_input_tokens / max_tokens, where present) refine the map.
export function parseAnthropicModels(json: unknown, caps: (id: string, reported?: Partial<Capabilities>) => Capabilities) {
  const data = Array.isArray((json as { data?: unknown })?.data) ? ((json as { data: unknown[] }).data as Record<string, unknown>[]) : [];
  return data
    .filter((m) => typeof m?.id === "string")
    .map((m) => {
      const reported: Partial<Capabilities> = {};
      if (typeof m.max_input_tokens === "number") reported.contextTokens = m.max_input_tokens;
      if (typeof m.max_tokens === "number") reported.maxOutputTokens = m.max_tokens;
      const id = m.id as string;
      return { id, label: typeof m.display_name === "string" ? m.display_name : id, capabilities: caps(id, Object.keys(reported).length ? reported : undefined) };
    });
}
