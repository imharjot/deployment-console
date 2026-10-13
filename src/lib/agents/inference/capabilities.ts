// The versioned capability map: what each provider's model families can do (AGENT_ARCHITECTURE §5 "maintain a
// versioned capability map"). An endpoint advertising OpenAI compatibility is not evidence of tools, strict schemas,
// streaming or cancellation, so unknown models — and every model behind a custom compatible endpoint — get the
// conservative entry. What a provider reports itself (Ollama's /api/show capabilities, a models list with limits)
// refines an entry and is marked source "provider". Pure.
//
// Bump CAPABILITY_MAP_VERSION whenever an entry changes; it is stored with each model call so a run can be explained
// against the map it used.
import { InferenceError, type Capabilities, type GenerateRequest, type InferenceProvider, type ModelInfo } from "./types.ts";

export const CAPABILITY_MAP_VERSION = "2026-10-05.2";

type Caps = Omit<Capabilities, "version" | "source" | "family">;

// Unknown model: tools are attempted (the provider refuses with "unsupported" if it can't), but nothing else is assumed.
const CONSERVATIVE: Caps = {
  tools: true,
  streaming: true,
  parallelToolCalls: false,
  hardOutputLimit: false,
  strictSchemas: false,
  cancellation: "best-effort",
  reasoning: false,
  sampling: true,
  forcedToolChoice: true,
  contextTokens: 8_192,
  maxOutputTokens: 2_048,
};

const NO_TOOLS: Partial<Caps> = { tools: false, parallelToolCalls: false };

interface Entry {
  family: string;
  match: RegExp;
  caps: Partial<Caps>;
}

// Anthropic families, by the API's model id ("claude-sonnet-4-5-20250929", "claude-opus-4-1", "claude-opus-5-5",
// "claude-fable-5-1"). Bedrock ids ("global.anthropic.claude-sonnet-4-5-20250929-v1:0") are matched after their prefixes
// are removed. What changed between generations, and would otherwise be a 400 from the API:
// - thinking: up to 4.5 a fixed budget ({type:"enabled", budget_tokens}); from 4.6 adaptive ({type:"adaptive"}), and
//   from 4.7 on a budget is refused;
// - sampling: from 4.7 on temperature is refused (dropped: it is only a preference);
// - forced tool choice ("required" / a named tool): refused from Opus 5.5, Sonnet 5.5 and Fable 5.1 on — and assumed
//   refused for any later model the map doesn't name yet.
const CLAUDE_4: Partial<Caps> = { tools: true, parallelToolCalls: true, hardOutputLimit: true, reasoning: true, thinkingMode: "budget", contextTokens: 200_000, maxOutputTokens: 32_000 };
const CLAUDE_1M: Partial<Caps> = { tools: true, parallelToolCalls: true, hardOutputLimit: true, reasoning: true, thinkingMode: "adaptive", contextTokens: 1_000_000, maxOutputTokens: 128_000 };
const CLAUDE: Entry[] = [
  { family: "claude-legacy", match: /^claude-(2|instant)/, caps: NO_TOOLS },
  { family: "claude-3", match: /^claude-3-(opus|sonnet|haiku)/, caps: { tools: true, parallelToolCalls: true, hardOutputLimit: true, contextTokens: 200_000, maxOutputTokens: 4_096 } },
  { family: "claude-3.5", match: /^claude-3-5-/, caps: { tools: true, parallelToolCalls: true, hardOutputLimit: true, contextTokens: 200_000, maxOutputTokens: 8_192 } },
  { family: "claude-3.7", match: /^claude-3-7-/, caps: { tools: true, parallelToolCalls: true, hardOutputLimit: true, reasoning: true, thinkingMode: "budget", contextTokens: 200_000, maxOutputTokens: 64_000 } },
  // 4.0 – 4.5: opus-4, opus-4-1, sonnet-4, sonnet-4-5, haiku-4-5, opus-4-5 (bare, dated, "-latest" or a Bedrock "-v1:0").
  { family: "claude-4", match: /^claude-(opus|sonnet|haiku)-4(?:[.-][0-5])?(?=$|-\d{8}|-v\d|-latest|@)/, caps: CLAUDE_4 },
  { family: "claude-4.6", match: /^claude-(opus|sonnet)-4[.-]6(?!\d)/, caps: CLAUDE_1M },
  { family: "claude-4.7", match: /^claude-(opus-4[.-][78]|opus-5|sonnet-5|fable-5|mythos-5)(?![.-]?\d)/, caps: { ...CLAUDE_1M, sampling: false } },
  // Opus 5.5, Sonnet 5.5, Fable 5.1, Mythos 5.1 and any later Claude model.
  { family: "claude-5.5", match: /^claude-[a-z]+-([4-9]|[1-9]\d)(\b|[-.])/, caps: { ...CLAUDE_1M, sampling: false, forcedToolChoice: false } },
];

// OpenAI families (Responses API ids). Reasoning models return reasoning items that must go back unchanged.
const OPENAI: Entry[] = [
  { family: "openai-no-tools", match: /^(gpt-3\.5-turbo-instruct|davinci|babbage|text-|whisper|tts-|dall-e|gpt-image|omni-moderation|o1-mini|o1-preview|chatgpt-4o-latest)/, caps: NO_TOOLS },
  { family: "gpt-5+", match: /^gpt-([5-9]|[1-9]\d)(?!\d)/, caps: { tools: true, parallelToolCalls: true, hardOutputLimit: true, strictSchemas: true, reasoning: true, contextTokens: 400_000, maxOutputTokens: 128_000 } },
  { family: "gpt-4.1", match: /^gpt-4\.1/, caps: { tools: true, parallelToolCalls: true, hardOutputLimit: true, strictSchemas: true, contextTokens: 1_047_576, maxOutputTokens: 32_768 } },
  { family: "gpt-4o", match: /^gpt-4o/, caps: { tools: true, parallelToolCalls: true, hardOutputLimit: true, strictSchemas: true, contextTokens: 128_000, maxOutputTokens: 16_384 } },
  { family: "o-series", match: /^o[1-9](-|$)/, caps: { tools: true, parallelToolCalls: false, hardOutputLimit: true, strictSchemas: true, reasoning: true, contextTokens: 200_000, maxOutputTokens: 100_000 } },
  { family: "gpt-4", match: /^gpt-4(-turbo|-\d|$)/, caps: { tools: true, parallelToolCalls: true, hardOutputLimit: true, contextTokens: 128_000, maxOutputTokens: 4_096 } },
  { family: "gpt-oss", match: /^gpt-oss/, caps: { tools: true, hardOutputLimit: true, reasoning: true, contextTokens: 131_072, maxOutputTokens: 32_768 } },
];

// Open-weight families as compatible servers (vLLM, LM Studio, Ollama's /v1) name them. Only "can it call tools" is
// recorded; everything else stays conservative because the server, not the model, decides it.
const OPEN: Entry[] = [
  { family: "embedding", match: /(embed|bge-|nomic-embed|mxbai-embed|all-minilm|rerank)/, caps: NO_TOOLS },
  { family: "gpt-oss", match: /^gpt-oss/, caps: { tools: true, reasoning: false } },
  { family: "llama-3.1+", match: /^(meta-llama\/)?(llama-?3\.[1-3]|llama-?4)/i, caps: { tools: true } },
  { family: "qwen", match: /^(qwen\/)?qwen(2\.5|3)/i, caps: { tools: true } },
  { family: "mistral", match: /^(mistralai\/)?(mistral|mixtral|ministral|devstral|magistral)/i, caps: { tools: true } },
  { family: "deepseek-r1", match: /deepseek-r1/i, caps: NO_TOOLS },
  { family: "llama-legacy", match: /^(llama2|llama-2|codellama|llama3(:|$)|llama-3-)/i, caps: NO_TOOLS },
];

// Bedrock model ids without their prefixes, for the non-Anthropic families.
const BEDROCK: Entry[] = [
  { family: "bedrock-no-tools", match: /^(amazon\.titan-|cohere\.embed|stability\.|ai21\.j2|deepseek\.r1|amazon\.rerank|cohere\.rerank|twelvelabs\.)/, caps: NO_TOOLS },
  { family: "nova", match: /^amazon\.nova-(premier|pro|lite|micro)/, caps: { tools: true, hardOutputLimit: true, contextTokens: 300_000, maxOutputTokens: 10_000 } },
  { family: "llama-3.1+", match: /^meta\.llama(3-[1-3]|4)/, caps: { tools: true, hardOutputLimit: true, contextTokens: 128_000, maxOutputTokens: 4_096 } },
  { family: "mistral-large", match: /^mistral\.(mistral-large|pixtral-large)/, caps: { tools: true, hardOutputLimit: true, contextTokens: 128_000, maxOutputTokens: 8_192 } },
  { family: "command-r", match: /^cohere\.command-r/, caps: { tools: true, hardOutputLimit: true, contextTokens: 128_000, maxOutputTokens: 4_096 } },
  { family: "gpt-oss", match: /^openai\.gpt-oss/, caps: { tools: true, hardOutputLimit: true, contextTokens: 128_000, maxOutputTokens: 32_768 } },
];

const SCRIPTED: Caps = { tools: true, streaming: true, parallelToolCalls: true, hardOutputLimit: true, strictSchemas: true, cancellation: "abort", reasoning: false, contextTokens: 200_000, maxOutputTokens: 8_192 };

// "us.anthropic.claude-sonnet-4-5-20250929-v1:0" → "anthropic.claude-sonnet-4-5-20250929-v1:0"; inference profiles
// carry a geography prefix (us, eu, apac, us-gov, jp, au, global).
// The geography prefixes of system-defined inference profiles ("in." routes within India: ap-south-1 and ap-south-2).
export const BEDROCK_GEO_PREFIX = /^(us-gov|us|eu|apac|jp|au|ca|in|global)\./;
export const bedrockBaseId = (id: string) => id.replace(/^arn:aws[a-z-]*:bedrock:[^:]*:[^:]*:(inference-profile|foundation-model)\//, "").replace(BEDROCK_GEO_PREFIX, "");
// Cross-region (and global) profiles may process a request outside the connection's region (AGENT_ARCHITECTURE §5).
export const bedrockCrossRegion = (id: string) => BEDROCK_GEO_PREFIX.test(id.replace(/^arn:[^/]*\//, ""));

// Ollama's cloud models are named "<model>:cloud" or "<model>:<size>-cloud"; they run on ollama.com even when asked
// through a local endpoint (docs.ollama.com/cloud).
export const ollamaCloudModel = (id: string) => /(^|[-:])cloud$/.test(id.trim().toLowerCase());

function pick(entries: Entry[], id: string): Entry | undefined {
  return entries.find((e) => e.match.test(id));
}

function build(provider: InferenceProvider, model: string): { caps: Caps; family?: string; source: "map" | "conservative" } {
  const id = model.trim().toLowerCase();
  const from = (base: Caps, e: Entry | undefined) => (e ? { caps: { ...base, ...e.caps }, family: e.family, source: "map" as const } : { caps: { ...CONSERVATIVE }, source: "conservative" as const });
  switch (provider) {
    case "scripted":
      return { caps: { ...SCRIPTED }, family: "scripted", source: "map" };
    case "anthropic":
      return from(CONSERVATIVE, pick(CLAUDE, id));
    case "openai":
    case "chatgpt-plan": {
      const r = from(CONSERVATIVE, pick(OPENAI, id));
      // The ChatGPT-plan route rejects max_output_tokens: no hard limit, cancellation is the only bound.
      if (provider === "chatgpt-plan") r.caps.hardOutputLimit = false;
      return r;
    }
    case "bedrock": {
      const base = bedrockBaseId(id);
      if (base.startsWith("anthropic.")) return from(CONSERVATIVE, pick(CLAUDE, base.slice("anthropic.".length)));
      return from(CONSERVATIVE, pick(BEDROCK, base));
    }
    case "ollama":
    case "openai-compatible": {
      const r = from(CONSERVATIVE, pick(OPEN, id.replace(/^[^/]+\/(?=(gpt-oss|llama|qwen|mistral|deepseek))/, "")));
      // Only "can it call tools" comes from the map here; limits, parallel calls and cancellation are the server's.
      if (r.source === "map") r.caps = { ...CONSERVATIVE, tools: r.caps.tools, reasoning: r.caps.reasoning };
      if (provider === "ollama" && ollamaCloudModel(id)) r.caps.remote = true;
      return r;
    }
  }
}

// The capabilities of one model. `reported` (from the provider itself) refines the map: a provider saying "no tools"
// wins over the map's "tools".
export function capabilitiesFor(provider: InferenceProvider, model: string | undefined, reported?: Partial<Caps>): Capabilities {
  const b = build(provider, model ?? "");
  const caps = { ...b.caps };
  let source: Capabilities["source"] = b.source;
  if (reported) {
    for (const [k, v] of Object.entries(reported)) {
      if (v === undefined || !(Object.hasOwn(CONSERVATIVE, k) || k === "remote")) continue;
      (caps as Record<string, unknown>)[k] = v;
    }
    source = "provider";
  }
  if (!caps.tools) caps.parallelToolCalls = false;
  return { version: CAPABILITY_MAP_VERSION, source, ...(b.family ? { family: b.family } : {}), ...caps };
}

export const conservativeCapabilities = (): Capabilities => ({ version: CAPABILITY_MAP_VERSION, source: "conservative", ...CONSERVATIVE });

// What a request may actually ask of this model. Throws "unsupported" (before any network call) when it needs a
// capability the model lacks; quietly narrows what is only a preference (parallel calls, an output limit above the
// model's maximum).
export interface EffectiveRequest {
  parallelToolCalls: boolean;
  maxOutputTokens?: number;
  sampling?: false; // present only when the model refuses temperature
  thinkingMode?: "budget" | "adaptive";
}

export function checkRequest(req: GenerateRequest, caps: Capabilities, label: string, model: string): EffectiveRequest {
  const tools = req.tools?.length ?? 0;
  if (tools && !caps.tools) throw new InferenceError("unsupported", `${label} model ${model} can't call tools`, { provider: label, code: "tools" });
  if (!tools && req.toolChoice && req.toolChoice !== "auto" && req.toolChoice !== "none") throw new InferenceError("invalid_request", "a tool choice was given without tools", { provider: label });
  if (typeof req.toolChoice === "object" && !req.tools?.some((t) => t.name === (req.toolChoice as { name: string }).name)) throw new InferenceError("invalid_request", "the chosen tool is not in the request's tool list", { provider: label });
  if (tools && (req.toolChoice === "required" || typeof req.toolChoice === "object") && caps.forcedToolChoice === false)
    throw new InferenceError("unsupported", `${label} model ${model} can't be forced to call a tool (tool choice "auto" only)`, { provider: label, code: "tool_choice" });
  if (req.thinking && !caps.reasoning) throw new InferenceError("unsupported", `${label} model ${model} has no extended thinking`, { provider: label, code: "thinking" });
  if (!caps.streaming) throw new InferenceError("unsupported", `${label} model ${model} can't stream`, { provider: label, code: "streaming" });
  if (req.maxOutputTokens !== undefined && (!Number.isInteger(req.maxOutputTokens) || req.maxOutputTokens < 1)) throw new InferenceError("invalid_request", "maxOutputTokens must be a positive integer", { provider: label });
  const max = req.maxOutputTokens !== undefined && caps.maxOutputTokens ? Math.min(req.maxOutputTokens, caps.maxOutputTokens) : (req.maxOutputTokens ?? caps.maxOutputTokens);
  return {
    parallelToolCalls: caps.parallelToolCalls && req.parallelToolCalls !== false,
    maxOutputTokens: max,
    ...(caps.sampling === false ? { sampling: false as const } : {}),
    ...(caps.thinkingMode ? { thinkingMode: caps.thinkingMode } : {}),
  };
}

// "The connection's model is no longer offered": the account's model list changed under a saved connection. Never
// silently swap in another model — the run fails with the cause and the person picks one.
// `same` says whether a listed id serves the connection's model (an alias of a dated id); default: equal ids.
export function modelOffered(models: readonly ModelInfo[], model: string | undefined, label: string, same: (listed: string, model: string) => boolean = (a, b) => a === b): InferenceError | undefined {
  if (!model) return new InferenceError("invalid_request", `${label} connection has no model selected`, { provider: label });
  if (models.some((m) => same(m.id, model))) return undefined;
  return new InferenceError("unsupported", `${label} no longer offers model ${model} to this account — pick another model for the connection`, { provider: label, code: "model_not_found" });
}

// What changed in an account's model list since it was last read (shown on the connection; never acted on silently).
export function modelListChange(before: readonly string[], after: readonly string[]): { added: string[]; removed: string[] } {
  const a = new Set(after);
  const b = new Set(before);
  return { added: after.filter((m) => !b.has(m)), removed: before.filter((m) => !a.has(m)) };
}
