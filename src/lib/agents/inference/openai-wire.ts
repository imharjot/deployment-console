// OpenAI Responses API wire format (POST /v1/responses, stream: true). Pure.
//
// - The console keeps the conversation itself, so requests go with `store: false` (nothing kept at OpenAI, no
//   previous_response_id); reasoning items come back encrypted (include reasoning.encrypted_content) as `native` blocks
//   and are sent back unchanged on the next turn.
// - `response.completed` is the ONLY success signal. `response.incomplete` is a result with stop max_tokens / refusal /
//   incomplete (its tool calls are never executable); `response.failed` and a top-level `error` event are errors; a
//   stream that ends without one of the three terminal events is an incomplete stream.
// - The ChatGPT-plan adapter (c-subscription-runtimes) reuses these builders with its own restrictions (no
//   max_output_tokens), passing `omitMaxOutputTokens`.
import { cleanMessage, streamBroke } from "./errors.ts";
import { emit, makeResult, parseToolInput } from "./messages.ts";
import type { SseEvent } from "./sse.ts";
import type { WireStream } from "./anthropic-wire.ts";
import { InferenceError, type Capabilities, type ContentBlock, type GenerateRequest, type ModelMessage, type StopReason, type StreamEvent, type Usage } from "./types.ts";

export const OPENAI_DEFAULT_BASE = "https://api.openai.com/v1";
const LABEL = "OpenAI";

export const openAiHeaders = (apiKey: string): Record<string, string> => ({
  authorization: `Bearer ${apiKey}`,
  "content-type": "application/json",
  accept: "text/event-stream",
});

type Item = Record<string, unknown>;

// Console messages → Responses input items. Tool results become function_call_output items (ahead of any text in the
// same turn), tool calls become function_call items, OpenAI native items (reasoning) go back as they came.
export function responsesInput(messages: readonly ModelMessage[]): Item[] {
  const out: Item[] = [];
  for (const m of messages) {
    if (m.role === "user") {
      const text: Item[] = [];
      for (const b of m.content) {
        if (b.type === "tool_result") out.push({ type: "function_call_output", call_id: b.callId, output: b.content });
        else if (b.type === "text" && b.text) text.push({ type: "input_text", text: b.text });
      }
      if (text.length) out.push({ type: "message", role: "user", content: text });
      continue;
    }
    let text: Item[] = [];
    const flush = () => {
      if (text.length) out.push({ type: "message", role: "assistant", content: text });
      text = [];
    };
    for (const b of m.content) {
      if (b.type === "text") {
        if (b.text) text.push({ type: "output_text", text: b.text, annotations: [] });
      } else if (b.type === "tool_call") {
        flush();
        out.push({ type: "function_call", call_id: b.id, name: b.name, arguments: JSON.stringify(b.input) });
      } else if (b.type === "native" && b.provider === "openai" && b.data && typeof b.data === "object") {
        flush();
        out.push(b.data as Item);
      }
    }
    flush();
  }
  return out;
}

export function buildResponsesRequest(
  req: GenerateRequest,
  model: string,
  eff: { parallelToolCalls: boolean; maxOutputTokens?: number },
  caps: Pick<Capabilities, "reasoning">,
  o: { omitMaxOutputTokens?: boolean } = {},
): Record<string, unknown> {
  const tools = req.tools ?? [];
  const choice = req.toolChoice ?? "auto";
  return {
    model,
    ...(req.system ? { instructions: req.system } : {}),
    input: responsesInput(req.messages),
    // strict: false — operation schemas have optional fields, which strict mode would reject; the runner validates
    // every argument against the schema itself.
    ...(tools.length
      ? {
          tools: tools.map((t) => ({ type: "function", name: t.name, description: t.description, parameters: { type: "object", ...t.inputSchema }, strict: false })),
          tool_choice: typeof choice === "object" ? { type: "function", name: choice.name } : choice,
          parallel_tool_calls: eff.parallelToolCalls,
        }
      : {}),
    ...(eff.maxOutputTokens !== undefined && !o.omitMaxOutputTokens ? { max_output_tokens: eff.maxOutputTokens } : {}),
    ...(req.thinking ? { reasoning: { effort: req.thinking.budgetTokens >= 16_000 ? "high" : req.thinking.budgetTokens >= 4_000 ? "medium" : "low" } } : {}),
    ...(caps.reasoning ? { include: ["reasoning.encrypted_content"] } : {}),
    ...(req.temperature !== undefined && !caps.reasoning ? { temperature: req.temperature } : {}),
    store: false,
    stream: true,
  };
}

// response.failed / error event codes → kinds.
const FAILED_KIND: Record<string, InferenceError["kind"]> = {
  rate_limit_exceeded: "rate_limited",
  insufficient_quota: "quota",
  server_error: "unavailable",
  invalid_prompt: "invalid_request",
  invalid_request_error: "invalid_request",
  model_not_found: "unsupported",
  context_length_exceeded: "invalid_request",
};

interface Streamed {
  item: Item;
  args: string;
  text: string;
  refusal: string;
}

// Items of a finished response → content blocks, in output order.
function blocksOf(items: readonly Item[], completed: boolean): { content: ContentBlock[]; refusal: string } {
  const content: ContentBlock[] = [];
  let refusal = "";
  for (const it of items) {
    if (!it || typeof it !== "object") continue;
    if (it.type === "message") {
      for (const part of Array.isArray(it.content) ? (it.content as Item[]) : []) {
        if (part.type === "output_text" && typeof part.text === "string") content.push({ type: "text", text: part.text });
        else if (part.type === "refusal" && typeof part.refusal === "string") refusal += part.refusal;
      }
    } else if (it.type === "function_call") {
      // In a response that didn't complete, a call is never executable; one still streaming is dropped entirely.
      if (!completed && it.status !== "completed") continue;
      const p = parseToolInput(typeof it.arguments === "string" ? it.arguments : "");
      content.push({
        type: "tool_call",
        id: String(it.call_id ?? it.id ?? ""),
        name: String(it.name ?? ""),
        input: p.input,
        ...(p.inputError ? { inputError: p.inputError } : {}),
        ...(typeof it.id === "string" ? { itemId: it.id } : {}),
      });
    } else if (typeof it.type === "string") content.push({ type: "native", provider: "openai", kind: it.type, data: { ...it } });
  }
  return { content, refusal };
}

function usageOf(u: unknown): Usage {
  if (!u || typeof u !== "object") return {};
  const x = u as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === "number" ? v : undefined);
  return {
    inputTokens: num(x.input_tokens),
    outputTokens: num(x.output_tokens),
    cacheReadTokens: num((x.input_tokens_details as Record<string, unknown> | undefined)?.cached_tokens),
    reasoningTokens: num((x.output_tokens_details as Record<string, unknown> | undefined)?.reasoning_tokens),
  };
}

export function createResponsesStream(o: { onEvent?: (e: StreamEvent) => void; label?: string } = {}): WireStream {
  const label = o.label ?? LABEL;
  const items = new Map<number, Streamed>();
  let started = false;
  let terminal: { kind: "completed" | "incomplete"; response: Item } | undefined;
  let responseId: string | undefined;
  let model = "";

  const at = (i: unknown, item?: Item): Streamed => {
    const n = Number(i);
    let p = items.get(n);
    if (!p) items.set(n, (p = { item: item ?? {}, args: "", text: "", refusal: "" }));
    else if (item) p.item = item;
    return p;
  };

  return {
    get started() {
      return started;
    },
    push(ev: SseEvent) {
      if (terminal) return;
      if (ev.data === "[DONE]") return;
      let d: Item;
      try {
        d = JSON.parse(ev.data) as Item;
      } catch {
        if (started) throw streamBroke(label, "bad-json", "an event was not valid JSON", responseId);
        throw new InferenceError("unavailable", `${label} answered with something that is not an event stream`, { provider: label });
      }
      const type = typeof d.type === "string" ? d.type : ev.event;
      switch (type) {
        case "response.created":
        case "response.in_progress":
        case "response.queued": {
          started = true;
          const r = (d.response ?? {}) as Item;
          if (typeof r.id === "string") responseId = r.id;
          if (typeof r.model === "string") model = r.model;
          return;
        }
        case "response.output_item.added": {
          started = true;
          const item = (d.item ?? {}) as Item;
          at(d.output_index, { ...item });
          if (item.type === "function_call") emit(o.onEvent, { type: "tool_call", id: String(item.call_id ?? item.id ?? ""), name: String(item.name ?? "") });
          if (item.type === "reasoning") emit(o.onEvent, { type: "thinking" });
          return;
        }
        case "response.output_text.delta":
          if (typeof d.delta === "string") {
            at(d.output_index).text += d.delta;
            emit(o.onEvent, { type: "text", text: d.delta });
          }
          return;
        case "response.refusal.delta":
          if (typeof d.delta === "string") at(d.output_index).refusal += d.delta;
          return;
        case "response.function_call_arguments.delta":
          if (typeof d.delta === "string") at(d.output_index).args += d.delta;
          return;
        case "response.function_call_arguments.done":
          if (typeof d.arguments === "string") at(d.output_index).args = d.arguments;
          return;
        case "response.output_item.done":
          at(d.output_index, { ...((d.item ?? {}) as Item) });
          return;
        case "response.completed":
        case "response.incomplete": {
          started = true;
          const r = (d.response ?? {}) as Item;
          if (typeof r.model === "string") model = r.model;
          if (typeof r.id === "string") responseId = r.id;
          if (type === "response.completed" && r.status !== undefined && r.status !== "completed") throw streamBroke(label, String(r.status), "response.completed carried a status other than completed", responseId);
          terminal = { kind: type === "response.completed" ? "completed" : "incomplete", response: r };
          return;
        }
        case "response.failed": {
          const r = (d.response ?? {}) as Item;
          const e = (r.error ?? {}) as Item;
          const code = typeof e.code === "string" ? e.code : undefined;
          const kind = FAILED_KIND[code ?? ""] ?? (code && /quota/.test(code) ? "quota" : "unavailable");
          throw new InferenceError(kind, `${label} response failed${code ? ` (${code})` : ""}${typeof e.message === "string" ? `: ${cleanMessage(e.message)}` : ""}`, { provider: label, code, requestId: responseId });
        }
        case "error": {
          const code = typeof d.code === "string" ? d.code : typeof (d.error as Item | undefined)?.code === "string" ? String((d.error as Item).code) : undefined;
          const msg = typeof d.message === "string" ? d.message : (d.error as Item | undefined)?.message;
          if (started) throw streamBroke(label, code, msg, responseId);
          throw new InferenceError(FAILED_KIND[code ?? ""] ?? "unavailable", `${label} error${code ? ` (${code})` : ""}${msg ? `: ${cleanMessage(msg)}` : ""}`, { provider: label, code });
        }
        default:
          return; // content_part, reasoning summaries, annotations and later additions
      }
    },
    finish(requestId?: string) {
      if (!terminal) throw streamBroke(label, "no-terminal-event", started ? "the stream ended before response.completed" : "the stream ended before the response started", requestId ?? responseId);
      const r = terminal.response;
      const completed = terminal.kind === "completed";
      // The terminal response's output is authoritative; the streamed items are the fallback when it is absent.
      const streamed = [...items.keys()].sort((a, b) => a - b).map((k) => {
        const p = items.get(k)!;
        const it = { ...p.item };
        if (it.type === "function_call" && typeof it.arguments !== "string") it.arguments = p.args;
        if (it.type === "message" && !Array.isArray(it.content)) it.content = [...(p.text ? [{ type: "output_text", text: p.text }] : []), ...(p.refusal ? [{ type: "refusal", refusal: p.refusal }] : [])];
        return it;
      });
      const output = Array.isArray(r.output) && r.output.length ? (r.output as Item[]) : streamed;
      const { content, refusal } = blocksOf(output, completed);
      const calls = content.some((b) => b.type === "tool_call");
      let stop: StopReason;
      let incompleteReason: string | undefined;
      if (completed) stop = calls ? "tool_calls" : refusal ? "refusal" : "end";
      else {
        incompleteReason = String(((r.incomplete_details ?? {}) as Item).reason ?? "unknown");
        stop = incompleteReason === "max_output_tokens" ? "max_tokens" : incompleteReason === "content_filter" ? "refusal" : "incomplete";
      }
      return makeResult({
        stop,
        content,
        usage: usageOf(r.usage),
        model: typeof r.model === "string" ? r.model : model,
        requestId: requestId ?? responseId,
        providerStop: completed ? "completed" : `incomplete:${incompleteReason}`,
        ...(refusal || stop === "refusal" ? { refusal } : {}),
        ...(incompleteReason && stop === "incomplete" ? { incompleteReason } : {}),
      });
    },
  };
}

// GET /v1/models → ids. The list carries no capabilities; the map supplies them.
export function parseOpenAiModels(json: unknown, caps: (id: string) => Capabilities) {
  const data = Array.isArray((json as { data?: unknown })?.data) ? ((json as { data: unknown[] }).data as Record<string, unknown>[]) : [];
  return data
    .filter((m) => typeof m?.id === "string")
    .map((m) => ({ id: m.id as string, label: m.id as string, capabilities: caps(m.id as string) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}
