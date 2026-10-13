// Amazon Bedrock Converse wire format (ConverseStream). Pure: plain objects in the shapes the Bedrock runtime SDK takes
// and yields — this file must not import the SDK (src/lib/iam-policy.test.ts allows the runtime client only in
// src/lib/server/agents/inference/, where the connection's own credentials are used, never the console role).
//
// Stream members: messageStart → (contentBlockStart? → contentBlockDelta* → contentBlockStop)* → messageStop →
// metadata. Text blocks have no contentBlockStart; tool-use blocks do (toolUseId, name) and stream their input as JSON
// fragments. messageStop is the success signal; an exception member after the stream started is an incomplete stream.
import { cleanMessage, streamBroke } from "./errors.ts";
import { emit, makeResult, parseToolInput } from "./messages.ts";
import { InferenceError, type Capabilities, type ContentBlock, type GenerateRequest, type GenerateResult, type ModelInfo, type ModelMessage, type StopReason, type StreamEvent, type Usage } from "./types.ts";
import { bedrockBaseId, bedrockCrossRegion } from "./capabilities.ts";

const LABEL = "Bedrock";

type Block = Record<string, unknown>;

// Console messages → Converse messages. Tool results are toolResult blocks in the user turn (ahead of text);
// Bedrock-native blocks (reasoning content) go back unchanged; same-role neighbours are merged.
export function converseMessages(messages: readonly ModelMessage[]): { role: "user" | "assistant"; content: Block[] }[] {
  const out: { role: "user" | "assistant"; content: Block[] }[] = [];
  for (const m of messages) {
    const results: Block[] = [];
    const rest: Block[] = [];
    for (const b of m.content) {
      if (b.type === "text") {
        if (b.text) rest.push({ text: b.text });
      } else if (b.type === "tool_call") {
        if (m.role === "assistant") rest.push({ toolUse: { toolUseId: b.id, name: b.name, input: b.input } });
      } else if (b.type === "tool_result") {
        if (m.role === "user") results.push({ toolResult: { toolUseId: b.callId, content: [{ text: b.content || "(empty)" }], status: b.isError ? "error" : "success" } });
      } else if (b.provider === "bedrock" && m.role === "assistant" && b.data && typeof b.data === "object") rest.push(b.data as Block);
    }
    const content = [...results, ...rest];
    if (!content.length) continue;
    const last = out[out.length - 1];
    if (last?.role === m.role) {
      last.content.push(...content);
      if (m.role === "user") last.content.sort((a, b) => Number("toolResult" in b) - Number("toolResult" in a));
    } else out.push({ role: m.role, content });
  }
  return out;
}

const hasToolBlocks = (messages: readonly ModelMessage[]) => messages.some((m) => m.content.some((b) => b.type === "tool_call" || b.type === "tool_result"));

// The ConverseStream input (minus nothing: it is passed to the command as is).
// `eff` is what checkRequest() allowed: Claude's thinking as a budget or adaptive (newer Claude models refuse a budget),
// and no temperature where the model refuses it.
export function buildConverseInput(
  req: GenerateRequest,
  modelId: string,
  eff: { maxOutputTokens?: number; sampling?: false; thinkingMode?: "budget" | "adaptive" },
  caps: Pick<Capabilities, "reasoning">,
): Record<string, unknown> {
  const tools = req.tools ?? [];
  const choice = req.toolChoice ?? "auto";
  // Bedrock requires toolConfig whenever the history holds toolUse/toolResult blocks, so "none" keeps the tools and
  // only leaves the choice to the model (Converse has no "none").
  const withTools = tools.length > 0 && (choice !== "none" || hasToolBlocks(req.messages));
  const toolChoice = choice === "required" ? { any: {} } : typeof choice === "object" ? { tool: { name: choice.name } } : undefined;
  const anthropic = bedrockBaseId(modelId).startsWith("anthropic.");
  // Claude takes only tool choice "auto" (or none) while extended thinking is on.
  if (anthropic && req.thinking && caps.reasoning && withTools && toolChoice)
    throw new InferenceError("unsupported", "Bedrock: Claude can't be forced to call a tool while extended thinking is on", { provider: LABEL, code: "tool_choice" });
  return {
    modelId,
    messages: converseMessages(req.messages),
    ...(req.system ? { system: [{ text: req.system }] } : {}),
    inferenceConfig: {
      ...(eff.maxOutputTokens !== undefined ? { maxTokens: eff.maxOutputTokens } : {}),
      ...(req.temperature !== undefined && !req.thinking && eff.sampling !== false ? { temperature: req.temperature } : {}),
    },
    ...(withTools ? { toolConfig: { tools: tools.map((t) => ({ toolSpec: { name: t.name, description: t.description, inputSchema: { json: { type: "object", ...t.inputSchema } } } })), ...(toolChoice ? { toolChoice } : {}) } } : {}),
    ...(req.thinking && caps.reasoning && anthropic
      ? { additionalModelRequestFields: { thinking: eff.thinkingMode === "adaptive" ? { type: "adaptive" } : { type: "enabled", budget_tokens: req.thinking.budgetTokens } } }
      : {}),
  };
}

const STOP: Record<string, StopReason> = {
  end_turn: "end",
  stop_sequence: "end",
  tool_use: "tool_calls",
  max_tokens: "max_tokens",
  model_context_window_exceeded: "max_tokens",
  guardrail_intervened: "refusal",
  content_filtered: "refusal",
};

// Exception members of the stream and errors the SDK throws → kinds.
const EXCEPTION_KIND: Record<string, InferenceError["kind"]> = {
  ThrottlingException: "rate_limited",
  ServiceQuotaExceededException: "quota",
  AccessDeniedException: "auth",
  UnrecognizedClientException: "auth",
  InvalidSignatureException: "auth",
  ExpiredTokenException: "auth",
  IncompleteSignature: "auth",
  MissingAuthenticationToken: "auth",
  ResourceNotFoundException: "unsupported",
  ValidationException: "invalid_request",
  ModelNotReadyException: "unavailable",
  ModelTimeoutException: "unavailable",
  ModelErrorException: "unavailable",
  ServiceUnavailableException: "unavailable",
  InternalServerException: "unavailable",
  ModelStreamErrorException: "incomplete_stream",
};
const STREAM_EXCEPTIONS: Record<string, string> = {
  internalServerException: "InternalServerException",
  modelStreamErrorException: "ModelStreamErrorException",
  validationException: "ValidationException",
  throttlingException: "ThrottlingException",
  serviceUnavailableException: "ServiceUnavailableException",
};

// An error the SDK threw (before or instead of a stream) → InferenceError.
export function bedrockError(e: unknown): InferenceError {
  const err = (e ?? {}) as { name?: string; message?: string; $metadata?: { httpStatusCode?: number; requestId?: string } };
  const name = err.name ?? "";
  const message = cleanMessage(err.message ?? "");
  let kind: InferenceError["kind"] = EXCEPTION_KIND[name] ?? (err.$metadata?.httpStatusCode && err.$metadata.httpStatusCode >= 500 ? "unavailable" : "invalid_request");
  if (name === "ValidationException" && /doesn't support|does not support|not supported|model identifier is invalid|on-demand throughput isn.t supported/i.test(message)) kind = "unsupported";
  if (name === "AccessDeniedException" && /don't have access to the model|not authorized to access this model|model access/i.test(message)) kind = "unsupported";
  return new InferenceError(kind, `Bedrock ${name || "error"}${message ? `: ${message}` : ""}`, { provider: LABEL, code: name || undefined, status: err.$metadata?.httpStatusCode, requestId: err.$metadata?.requestId });
}

interface Slot {
  kind: "text" | "toolUse" | "reasoning" | "other";
  text: string;
  json: string;
  id?: string;
  name?: string;
  signature: string;
  redacted?: unknown;
  closed: boolean;
}

export interface BedrockStream {
  push(ev: unknown): void;
  readonly started: boolean;
  finish(requestId?: string): GenerateResult;
}

export function createConverseStream(o: { onEvent?: (e: StreamEvent) => void; model?: string } = {}): BedrockStream {
  const slots = new Map<number, Slot>();
  const usage: Usage = {};
  let started = false;
  let stopped = false;
  let stopReason: string | undefined;

  const slot = (i: unknown, kind: Slot["kind"]): Slot => {
    const n = Number(i) || 0;
    let s = slots.get(n);
    if (!s) slots.set(n, (s = { kind, text: "", json: "", signature: "", closed: false }));
    return s;
  };

  return {
    get started() {
      return started;
    },
    push(ev: unknown) {
      if (!ev || typeof ev !== "object") return;
      const e = ev as Record<string, Record<string, unknown> | undefined>;
      for (const [member, name] of Object.entries(STREAM_EXCEPTIONS)) {
        const x = e[member];
        if (!x) continue;
        if (started) throw streamBroke(LABEL, name, x.message);
        throw bedrockError({ name, message: x.message });
      }
      if (e.messageStart) {
        started = true;
        return;
      }
      if (e.contentBlockStart) {
        started = true;
        const st = (e.contentBlockStart.start ?? {}) as Record<string, Record<string, unknown> | undefined>;
        if (st.toolUse) {
          const s = slot(e.contentBlockStart.contentBlockIndex, "toolUse");
          s.kind = "toolUse";
          s.id = String(st.toolUse.toolUseId ?? "");
          s.name = String(st.toolUse.name ?? "");
          emit(o.onEvent, { type: "tool_call", id: s.id, name: s.name });
        }
        return;
      }
      if (e.contentBlockDelta) {
        started = true;
        const d = (e.contentBlockDelta.delta ?? {}) as Record<string, unknown>;
        const i = e.contentBlockDelta.contentBlockIndex;
        if (typeof d.text === "string") {
          slot(i, "text").text += d.text;
          emit(o.onEvent, { type: "text", text: d.text });
        } else if (d.toolUse && typeof (d.toolUse as Record<string, unknown>).input === "string") slot(i, "toolUse").json += (d.toolUse as Record<string, unknown>).input as string;
        else if (d.reasoningContent && typeof d.reasoningContent === "object") {
          const r = d.reasoningContent as Record<string, unknown>;
          const s = slot(i, "reasoning");
          s.kind = "reasoning";
          if (typeof r.text === "string") s.text += r.text;
          if (typeof r.signature === "string") s.signature += r.signature;
          if (r.redactedContent !== undefined) s.redacted = r.redactedContent;
          emit(o.onEvent, { type: "thinking" });
        }
        return;
      }
      if (e.contentBlockStop) {
        const s = slots.get(Number(e.contentBlockStop.contentBlockIndex) || 0);
        if (s) s.closed = true;
        return;
      }
      if (e.messageStop) {
        started = true;
        stopped = true;
        if (typeof e.messageStop.stopReason === "string") stopReason = e.messageStop.stopReason;
        return;
      }
      if (e.metadata) {
        const u = (e.metadata.usage ?? {}) as Record<string, unknown>;
        const num = (v: unknown) => (typeof v === "number" ? v : undefined);
        usage.inputTokens = num(u.inputTokens);
        usage.outputTokens = num(u.outputTokens);
        usage.cacheReadTokens = num(u.cacheReadInputTokens);
        usage.cacheWriteTokens = num(u.cacheWriteInputTokens);
        emit(o.onEvent, { type: "usage", usage: { ...usage } });
      }
    },
    finish(requestId?: string) {
      if (!stopped) throw streamBroke(LABEL, "no-message-stop", started ? "the stream ended before messageStop" : "the stream ended before it started", requestId);
      const stop: StopReason = STOP[stopReason ?? ""] ?? "incomplete";
      const content: ContentBlock[] = [];
      for (const i of [...slots.keys()].sort((a, b) => a - b)) {
        const s = slots.get(i)!;
        if (s.kind === "text") content.push({ type: "text", text: s.text });
        else if (s.kind === "toolUse") {
          if (stop !== "tool_calls") continue;
          const p = parseToolInput(s.json);
          content.push({ type: "tool_call", id: s.id ?? `tooluse_${i}`, name: s.name ?? "", input: p.input, ...(p.inputError ? { inputError: p.inputError } : {}) });
        } else if (s.kind === "reasoning")
          content.push({
            type: "native",
            provider: "bedrock",
            kind: "reasoningContent",
            data: { reasoningContent: s.redacted !== undefined ? { redactedContent: s.redacted } : { reasoningText: { text: s.text, ...(s.signature ? { signature: s.signature } : {}) } } },
          });
      }
      const calls = content.some((b) => b.type === "tool_call");
      const final: StopReason = stop === "tool_calls" && !calls ? "end" : stop;
      return makeResult({
        stop: final,
        content,
        usage,
        model: o.model ?? "",
        requestId,
        providerStop: stopReason,
        ...(final === "refusal" ? { refusal: content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("") } : {}),
        ...(final === "incomplete" ? { incompleteReason: stopReason ?? "unknown" } : {}),
      });
    },
  };
}

// The regions a profile routes to, from its model ARNs ("arn:aws:bedrock:ap-south-2::foundation-model/…"; a global
// profile also lists a region-less ARN, counted as "" — anywhere).
function profileRegions(p: Record<string, unknown>): Set<string> {
  const out = new Set<string>();
  for (const m of Array.isArray(p.models) ? (p.models as Record<string, unknown>[]) : []) {
    const arn = typeof m?.modelArn === "string" ? m.modelArn : "";
    const r = /^arn:aws[a-z-]*:bedrock:([^:]*):/.exec(arn);
    if (r) out.add(r[1]);
  }
  return out;
}

// The foundation model ids a profile routes to.
function profileModels(p: Record<string, unknown>): string[] {
  return (Array.isArray(p.models) ? (p.models as Record<string, unknown>[]) : []).flatMap((m) => {
    const r = /:foundation-model\/(.+)$/.exec(typeof m?.modelArn === "string" ? m.modelArn : "");
    return r ? [r[1]] : [];
  });
}

// ListFoundationModels + ListInferenceProfiles → the text models this connection can call with ConverseStream.
// Foundation models offered only through an inference profile are listed through their profiles; cross-region and
// global profiles are flagged (they may process the request outside the connection's region).
export function parseBedrockModels(foundation: unknown[], profiles: unknown[], caps: (id: string, reported?: Partial<Capabilities>) => Capabilities): ModelInfo[] {
  const out: ModelInfo[] = [];
  const text = new Set<string>(); // every text model of the region, however it is invoked
  for (const m of foundation as Record<string, unknown>[]) {
    if (typeof m?.modelId === "string" && (!Array.isArray(m.outputModalities) || (m.outputModalities as string[]).includes("TEXT"))) text.add(m.modelId);
  }
  for (const m of foundation as Record<string, unknown>[]) {
    if (typeof m?.modelId !== "string") continue;
    const outputs = Array.isArray(m.outputModalities) ? (m.outputModalities as string[]) : ["TEXT"];
    if (!outputs.includes("TEXT")) continue;
    const types = Array.isArray(m.inferenceTypesSupported) ? (m.inferenceTypesSupported as string[]) : ["ON_DEMAND"];
    if (!types.includes("ON_DEMAND")) continue; // reachable only through a profile (listed below) or provisioned throughput
    const lifecycle = (m.modelLifecycle ?? {}) as Record<string, unknown>;
    const reported = m.responseStreamingSupported === false ? { streaming: false } : undefined;
    out.push({
      id: m.modelId,
      label: [m.providerName, m.modelName].filter((x) => typeof x === "string").join(" ") || m.modelId,
      capabilities: caps(m.modelId, reported),
      ...(lifecycle.status === "LEGACY" ? { deprecated: true } : {}),
    });
  }
  for (const p of profiles as Record<string, unknown>[]) {
    if (typeof p?.inferenceProfileId !== "string" || (p.status !== undefined && p.status !== "ACTIVE")) continue;
    // Profiles of non-text models (embeddings, video) are left out like their models are.
    const bases = profileModels(p);
    if (text.size && !(bases.length ? bases : [bedrockBaseId(p.inferenceProfileId)]).some((b) => text.has(b))) continue;
    out.push({
      id: p.inferenceProfileId,
      label: typeof p.inferenceProfileName === "string" ? p.inferenceProfileName : p.inferenceProfileId,
      capabilities: caps(p.inferenceProfileId),
      ...(bedrockCrossRegion(p.inferenceProfileId) || profileRegions(p).size !== 1 ? { crossRegion: true } : {}),
    });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}
