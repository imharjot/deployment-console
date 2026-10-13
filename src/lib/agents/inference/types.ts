// The provider-independent inference interface (master plan §3.4, AGENT_ARCHITECTURE §5). The runner (c-runner) talks
// to every model through these shapes; each adapter keeps its provider's wire format to itself (anthropic-wire.ts,
// openai-wire.ts, compat-wire.ts, bedrock-wire.ts, scripted.ts). Pure: no I/O, no Node or DOM APIs.
//
// Rules every adapter follows:
// - Tool calls are proposals. Only a turn that ended with stop "tool_calls" carries executable calls (`toolCalls`); a
//   turn cut short (max_tokens, refusal, incomplete) never does, so the runner can buffer side effects until the turn
//   completed and every argument validated.
// - Tool results are untrusted evidence, never instructions (`untrusted: true` is part of the type).
// - `native` blocks carry a provider's continuation data (Anthropic thinking signatures, OpenAI reasoning items, Bedrock
//   reasoning content) and go back to the *same* provider unchanged; other providers drop them.
// - An adapter never falls back to another provider, connection, endpoint or model. A failure is an InferenceError
//   whose kind tells the runner to pause (paused_auth / paused_budget), retry with backoff, or fail (./errors.ts).
// - The endpoint comes only from the resolved connection (an admin-registered entry, or the provider's built-in
//   default); nothing a model or a run supplies can change where a request goes.

export type InferenceProvider = "scripted" | "anthropic" | "openai" | "openai-compatible" | "ollama" | "bedrock" | "chatgpt-plan";
export const INFERENCE_PROVIDERS: readonly InferenceProvider[] = ["scripted", "anthropic", "openai", "openai-compatible", "ollama", "bedrock", "chatgpt-plan"];
export const isInferenceProvider = (v: unknown): v is InferenceProvider => typeof v === "string" && (INFERENCE_PROVIDERS as readonly string[]).includes(v);

// ---------- messages ----------

export interface TextBlock {
  type: "text";
  text: string;
}

// A tool the model asked to call. `name` is the wire name from the request's ToolSpec ("services_restart"); the op name
// is ToolSpec.op. `inputError` is set when the arguments weren't a JSON object: such a call is never executable (the
// runner answers it with an error result). `itemId` is the provider's own item id (OpenAI Responses), kept for the
// transcript.
export interface ToolCallBlock {
  type: "tool_call";
  id: string;
  name: string;
  input: Record<string, unknown>;
  inputError?: string;
  itemId?: string;
}

// The console's answer to one tool call: always untrusted evidence. `content` is the text the model reads (the runner
// redacts, minimises and wraps it first). `evidenceId` is the citation id the runner assigned ("E3"), so a model can
// cite it.
export interface ToolResultBlock {
  type: "tool_result";
  callId: string;
  untrusted: true;
  content: string;
  isError?: boolean;
  evidenceId?: string;
}

// Provider continuation data, sent back unchanged to the provider that produced it (and dropped for any other).
// `kind` is the provider's block or item type ("thinking", "redacted_thinking", "reasoning", "scripted-turn", …).
export interface NativeBlock {
  type: "native";
  provider: InferenceProvider;
  kind: string;
  data: unknown;
}

export type ContentBlock = TextBlock | ToolCallBlock | ToolResultBlock | NativeBlock;

// Tool results travel in "user" messages (between the assistant's tool calls and its next turn); the system prompt is
// GenerateRequest.system, never a message.
export interface ModelMessage {
  role: "user" | "assistant";
  content: ContentBlock[];
}

// ---------- requests ----------

// A JSON Schema object, as the operation registry declares it (src/lib/ops-schema.ts converts operations).
export type JsonSchemaObject = { type?: string; properties?: Record<string, unknown>; required?: string[]; [k: string]: unknown };

// One tool the model may call. Descriptions and schemas come only from the operation registry, never from resource
// data (the runner hashes the list per run).
export interface ToolSpec {
  name: string; // wire name, [A-Za-z0-9_-]{1,64}: toolName(op) ("services.restart" → "services_restart")
  description: string;
  inputSchema: JsonSchemaObject;
  op?: string; // the operation it invokes ("services.restart")
}

export type ToolChoice = "auto" | "none" | "required" | { name: string };

// Streaming progress for the live run view. Listeners must not throw (adapters ignore a throwing listener).
export type StreamEvent =
  | { type: "text"; text: string }
  | { type: "tool_call"; id: string; name: string }
  | { type: "thinking" }
  | { type: "usage"; usage: Usage };

export interface GenerateRequest {
  model?: string; // defaults to the connection's model
  system?: string;
  messages: ModelMessage[];
  tools?: ToolSpec[];
  toolChoice?: ToolChoice;
  parallelToolCalls?: boolean; // false asks for at most one call per turn (ignored where the model can't do several)
  maxOutputTokens?: number; // a hard limit only where Capabilities.hardOutputLimit; otherwise cancellation is the bound
  temperature?: number;
  thinking?: { budgetTokens: number }; // extended thinking / reasoning, where the model has it (else "unsupported")
  signal?: AbortSignal; // cancel: the request is aborted and generate() throws kind "cancelled"
  idleTimeoutMs?: number; // a stream silent this long is cut off (incomplete_stream); default 120 s
  onEvent?(e: StreamEvent): void;
}

// ---------- results ----------

// end:        the model finished its answer.
// tool_calls: the model asked for tool calls (GenerateResult.toolCalls); the turn completed.
// max_tokens: cut off by the output (or context) limit; partial tool calls are dropped.
// refusal:    the model or the provider's filter declined (GenerateResult.refusal says what it said, if anything).
// incomplete: the provider ended the turn without completing it (OpenAI response.incomplete, Anthropic pause_turn).
// A stream that broke off is not a result: generate() throws InferenceError "incomplete_stream".
export type StopReason = "end" | "tool_calls" | "max_tokens" | "refusal" | "incomplete";

export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
}

export interface GenerateResult {
  stop: StopReason;
  message: ModelMessage; // role "assistant": text, tool_call and native blocks in the order the model produced them
  text: string; // the text blocks joined
  toolCalls: ToolCallBlock[]; // executable calls: non-empty only when stop === "tool_calls"
  usage: Usage; // measured by the provider (scripted: estimated from characters)
  model: string; // the model that answered, as the provider reported it
  requestId?: string; // the provider's request id (for support), never a secret
  providerStop?: string; // the provider's raw stop reason
  refusal?: string;
  incompleteReason?: string;
}

// ---------- capabilities ----------

// What a model can do, from the versioned map in ./capabilities.ts, refined by what the provider reports. Unknown
// models get the conservative entry: no parallel calls, no strict schemas, no hard output limit, best-effort cancel.
export interface Capabilities {
  version: string; // the capability map version that produced this entry
  source: "map" | "provider" | "conservative";
  family?: string; // the map entry that matched ("claude-4", "gpt-5", …)
  tools: boolean;
  streaming: boolean;
  parallelToolCalls: boolean;
  hardOutputLimit: boolean; // the provider stops at maxOutputTokens; otherwise the runner's cancellation is the bound
  strictSchemas: boolean; // the provider can enforce a tool's JSON Schema (the runner validates arguments either way)
  cancellation: "abort" | "best-effort"; // abort: closing the request stops generation; best-effort: it may run on
  reasoning: boolean; // produces native continuation blocks (thinking / reasoning) that must be sent back
  // How extended thinking is asked for where the provider has two forms (Anthropic, and Anthropic models on Bedrock):
  // "budget" = {type:"enabled", budget_tokens}; "adaptive" = {type:"adaptive"} (newer models refuse a budget with a 400).
  thinkingMode?: "budget" | "adaptive";
  sampling?: boolean; // false: the model refuses temperature (the request drops it — it is only a preference)
  forcedToolChoice?: boolean; // false: the model refuses tool choice "required" / a named tool (refused before sending)
  contextTokens?: number;
  maxOutputTokens?: number;
  remote?: boolean; // runs on the provider's cloud even when reached through a local endpoint (Ollama cloud models)
}

export interface ModelInfo {
  id: string;
  label: string;
  capabilities: Capabilities;
  cloud?: boolean; // Ollama: a cloud model behind the local endpoint (refused on a "local" connection)
  crossRegion?: boolean; // Bedrock: an inference profile that may process the request outside the connection's region
  deprecated?: boolean;
}

// ---------- errors ----------

// auth:              the credential was refused or has expired → pause the run (paused_auth) for re-authorisation.
// quota:             the account's quota or credit is exhausted → pause (paused_budget); no reset time is invented.
// rate_limited:      temporary throttling → bounded backoff (retryAfterMs when the provider said), then pause.
// unavailable:       the provider is down or overloaded → bounded backoff, then fail.
// invalid_request:   the request or the connection's configuration is wrong (incl. a refused endpoint) → fail.
// unsupported:       the model can't do what was asked (tools, thinking), or it is no longer offered → fail.
// cancelled:         the run was cancelled (the request's signal) → the run's own cancellation path.
// incomplete_stream: the stream broke off before the provider's terminal event → nothing in it is used; retry.
export type InferenceErrorKind = "auth" | "quota" | "rate_limited" | "unavailable" | "invalid_request" | "unsupported" | "cancelled" | "incomplete_stream";
export const INFERENCE_ERROR_KINDS: readonly InferenceErrorKind[] = ["auth", "quota", "rate_limited", "unavailable", "invalid_request", "unsupported", "cancelled", "incomplete_stream"];

export interface InferenceErrorDetails {
  provider?: string;
  status?: number; // HTTP status, when there was one
  code?: string; // the provider's error type or code ("rate_limit_error", "insufficient_quota", "ThrottlingException")
  requestId?: string;
  retryAfterMs?: number; // only when the provider said when to retry
  resetAt?: number; // epoch ms, only when the provider said
}

// Messages never contain a credential, a request header or a request body; provider messages are trimmed and passed
// through redaction before they get here.
export class InferenceError extends Error {
  readonly kind: InferenceErrorKind;
  readonly provider?: string;
  readonly status?: number;
  readonly code?: string;
  readonly requestId?: string;
  readonly retryAfterMs?: number;
  readonly resetAt?: number;
  constructor(kind: InferenceErrorKind, message: string, d: InferenceErrorDetails = {}) {
    super(message);
    this.name = "InferenceError";
    this.kind = kind;
    this.provider = d.provider;
    this.status = d.status;
    this.code = d.code;
    this.requestId = d.requestId;
    this.retryAfterMs = d.retryAfterMs;
    this.resetAt = d.resetAt;
  }
  toJSON() {
    return { kind: this.kind, message: this.message, provider: this.provider, status: this.status, code: this.code, requestId: this.requestId, retryAfterMs: this.retryAfterMs, resetAt: this.resetAt };
  }
}

// Works across bundles (the worker and the routes each load their own copy of this class).
export const isInferenceError = (e: unknown): e is InferenceError =>
  e instanceof InferenceError ||
  (!!e && typeof e === "object" && (e as { name?: unknown }).name === "InferenceError" && (INFERENCE_ERROR_KINDS as readonly unknown[]).includes((e as { kind?: unknown }).kind));

// ---------- connections ----------

// What secret() returns, by auth kind. Bedrock never uses the console's own AWS identity: "aws" is the connection's
// keys (or short-lived credentials the broker resolved); "aws-role" names a role assumed *with the connection's own
// base keys* (`source`) — without them it is refused.
export type ConnectionSecret =
  | { kind: "none" }
  | { kind: "api-key"; apiKey: string }
  | { kind: "aws"; accessKeyId: string; secretAccessKey: string; sessionToken?: string; expiresAt?: number }
  | { kind: "aws-role"; roleArn: string; externalId?: string; source?: { accessKeyId: string; secretAccessKey: string; sessionToken?: string } }
  | { kind: "oauth"; accessToken: string; accountId?: string };

// A connection the credential broker (c-credentials-connections, resolveConnection) has checked for this purpose: owner
// or org scope, the delegator's right to use it, not revoked, background use, egress policy, and — for a custom
// endpoint — an admin-registered entry. secret() is the only way to the credential; adapters call it per request and
// never log, return or forward it.
export interface ResolvedConnection {
  id: string;
  provider: InferenceProvider;
  authKind: string; // "api-key" | "aws-keys" | "aws-role" | "oauth-plan" | "none" | …
  label: string;
  model?: string; // the default model (scripted: the script's name)
  endpoint?: string; // base URL from an admin-registered entry; absent → the provider's built-in default
  endpointRegistered?: boolean; // true only when `endpoint` is an admin-registered entry (settings agents:endpoints)
  region?: string; // Bedrock
  egress: "local" | "cloud"; // local: every resolved address must be loopback/private, and cloud models are refused
  scope?: "personal" | "org";
  ownerId?: string;
  secret(): Promise<ConnectionSecret>;
  // Optional, from the credential broker (src/lib/server/agents/credentials.ts): fetch() for this connection's endpoint
  // only — a fixed API path appended to the endpoint (the built-in default's origin, or the registered URL), its egress
  // class enforced, redirects refused — and scrub(), which removes the connection's own secret from a provider message.
  // The HTTP adapters use them when present.
  fetch?(path: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }): Promise<Response>;
  scrub?(text: string): Promise<string>;
}

// ---------- adapters ----------

export interface CallOptions {
  signal?: AbortSignal;
}

// validate() answers the connection test (POST /api/agents/connections/[id]/test): ok with the models and the default
// model's capabilities, or the error (its message is redacted again by the route). It never throws for a provider
// failure.
export interface ValidateResult {
  ok: boolean;
  model?: string;
  models?: ModelInfo[];
  capabilities?: Capabilities;
  warnings?: string[]; // e.g. "a local Ollama endpoint can still reach Ollama's cloud models"
  error?: { kind: InferenceErrorKind; message: string };
}

export interface InferenceAdapter {
  provider: InferenceProvider;
  label: string;
  validate(conn: ResolvedConnection, o?: CallOptions): Promise<ValidateResult>;
  models(conn: ResolvedConnection, o?: CallOptions): Promise<ModelInfo[]>; // throws InferenceError
  generate(conn: ResolvedConnection, req: GenerateRequest): Promise<GenerateResult>; // throws InferenceError
}
