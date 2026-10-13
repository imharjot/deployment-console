// Small helpers every adapter shares: building results with the "only a completed tool_calls turn is executable" rule,
// tool-argument parsing, tool lookup, safe event delivery. Pure.
import type { ContentBlock, GenerateResult, JsonSchemaObject, ModelMessage, StopReason, StreamEvent, TextBlock, ToolCallBlock, ToolResultBlock, ToolSpec, Usage } from "./types.ts";

// "services.restart" → "services_restart" (the same rule as src/lib/ops-schema.ts toolName and the MCP endpoint).
export const toolName = (op: string) => op.replace(/\./g, "_");

// An operation as the registry describes it → the ToolSpec a model sees. The schema is deep-copied so nothing
// downstream can change a registered operation.
export function toolSpec(op: { name: string; description: string; input: unknown }): ToolSpec {
  return { name: toolName(op.name), description: op.description, inputSchema: JSON.parse(JSON.stringify(op.input ?? { type: "object" })) as JsonSchemaObject, op: op.name };
}

// A tool by op name ("services.get") or wire name ("services_get").
export function findTool(tools: readonly ToolSpec[] | undefined, nameOrOp: string): ToolSpec | undefined {
  if (!tools) return undefined;
  return tools.find((t) => t.op === nameOrOp) ?? tools.find((t) => t.name === nameOrOp) ?? tools.find((t) => t.name === toolName(nameOrOp));
}

// The op a tool call invokes, given the request's tools.
export const opOf = (tools: readonly ToolSpec[] | undefined, name: string) => {
  const t = tools?.find((x) => x.name === name);
  return t?.op ?? name.replace(/_/g, ".");
};

export const textOf = (blocks: readonly ContentBlock[]) =>
  blocks
    .filter((b): b is TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");

export const callsOf = (blocks: readonly ContentBlock[]) => blocks.filter((b): b is ToolCallBlock => b.type === "tool_call");
export const resultsOf = (blocks: readonly ContentBlock[]) => blocks.filter((b): b is ToolResultBlock => b.type === "tool_result");

// Arguments as the model streamed them (a JSON text) → an object, or the reason it isn't one. An empty text is {}.
export function parseToolInput(json: string): { input: Record<string, unknown>; inputError?: string } {
  const t = json.trim();
  if (!t) return { input: {} };
  let v: unknown;
  try {
    v = JSON.parse(t);
  } catch {
    return { input: {}, inputError: "the arguments were not valid JSON" };
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return { input: {}, inputError: "the arguments were not a JSON object" };
  return { input: v as Record<string, unknown> };
}

// A listener that throws must not break a stream.
export function emit(onEvent: ((e: StreamEvent) => void) | undefined, e: StreamEvent) {
  if (!onEvent) return;
  try {
    onEvent(e);
  } catch {
    // ignored: the live view is best-effort
  }
}

// The assistant turn as a result. Tool calls are executable only when the turn completed with stop "tool_calls";
// otherwise the calls stay in the transcript (message) but `toolCalls` is empty.
export function makeResult(o: {
  stop: StopReason;
  content: ContentBlock[];
  usage: Usage;
  model: string;
  requestId?: string;
  providerStop?: string;
  refusal?: string;
  incompleteReason?: string;
}): GenerateResult {
  // Merge adjacent text blocks (streams deliver text in pieces) and drop empty ones.
  const content: ContentBlock[] = [];
  for (const b of o.content) {
    if (b.type === "text") {
      if (!b.text) continue;
      const last = content[content.length - 1];
      if (last?.type === "text") {
        content[content.length - 1] = { type: "text", text: last.text + b.text };
        continue;
      }
    }
    content.push(b);
  }
  const calls = callsOf(content);
  const message: ModelMessage = { role: "assistant", content };
  const usage = Object.fromEntries(Object.entries(o.usage).filter(([, v]) => typeof v === "number" && Number.isFinite(v))) as Usage;
  return {
    stop: o.stop,
    message,
    text: textOf(content),
    toolCalls: o.stop === "tool_calls" ? calls : [],
    usage,
    model: o.model,
    ...(o.requestId ? { requestId: o.requestId } : {}),
    ...(o.providerStop ? { providerStop: o.providerStop } : {}),
    ...(o.refusal !== undefined ? { refusal: o.refusal } : {}),
    ...(o.incompleteReason ? { incompleteReason: o.incompleteReason } : {}),
  };
}

// Rough token estimate (about four characters a token) for the scripted adapter and budget pre-checks; real adapters
// report the provider's measured usage.
export const estimateTokens = (text: string) => Math.ceil(text.length / 4);

export function messageText(m: ModelMessage): string {
  return m.content
    .map((b) => (b.type === "text" ? b.text : b.type === "tool_result" ? b.content : b.type === "tool_call" ? `${b.name} ${JSON.stringify(b.input)}` : ""))
    .join("\n");
}
