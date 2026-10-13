// The HTTP inference adapters (Anthropic Messages, OpenAI Responses, OpenAI-compatible chat completions, Ollama),
// built over an injected fetch so every path is tested without a network: the server modules pass the console's
// egress-guarded safeFetch (src/lib/plugins/http.ts), tests pass a fake. No module state; the optional cache (Ollama's
// per-model capabilities) is handed in by the caller (the server keeps it on globalThis).
//
// Every request: the endpoint from the connection only (./endpoint.ts) — through the broker's connection-scoped
// fetch() when the connection carries one, else the injected fetch with the plan's egress rules —, redirects refused
// (a 30x could carry the key elsewhere), the credential read per request through the broker's secret(), and failures
// turned into InferenceErrors without the URL, headers or body (and scrubbed of the connection's own secret). Nothing
// ever retries on another connection or provider.
import type { Resolver, SafeInit, SafeOptions } from "../../plugins/http.ts";
import { ANTHROPIC_VERSION, anthropicHeaders, anthropicModelMatches, buildAnthropicRequest, createAnthropicStream, parseAnthropicModels, type WireStream } from "./anthropic-wire.ts";
import { capabilitiesFor, checkRequest, modelOffered, ollamaCloudModel } from "./capabilities.ts";
import { buildChatRequest, compatHeaders, createChatStream, parseCompatCompletion, parseCompatModels, parseOllamaShow, parseOllamaTags } from "./compat-wire.ts";
import { apiUrl, egressFor, planEndpoint, type EndpointPlan } from "./endpoint.ts";
import { cleanMessage, httpError, requestIdOf, streamBroke, toInferenceError } from "./errors.ts";
import { buildResponsesRequest, createResponsesStream, openAiHeaders, parseOpenAiModels } from "./openai-wire.ts";
import { DEFAULT_IDLE_MS, readBody, readSse, StreamIdleError } from "./sse.ts";
import {
  InferenceError,
  isInferenceError,
  type Capabilities,
  type ConnectionSecret,
  type GenerateRequest,
  type GenerateResult,
  type InferenceAdapter,
  type InferenceProvider,
  type ModelInfo,
  type ResolvedConnection,
  type ValidateResult,
} from "./types.ts";

export type FetchLike = (url: string, init: SafeInit, opts: SafeOptions) => Promise<Response>;

export interface HttpDeps {
  fetch: FetchLike;
  resolve?: Resolver; // tests: stands in for DNS
  now?: () => number;
  cache?: Map<string, { at: number; value: unknown }>;
  listTimeoutMs?: number; // model lists and validation (default 15 s)
}

const LIST_TIMEOUT_MS = 15_000;
const CACHE_MS = 10 * 60_000;

// ---------- plumbing ----------

// The connection's credential, read now. A broker failure that isn't already an InferenceError is an auth problem
// (revoked, can't be unsealed); its text is cleaned, never the secret.
export async function secretOf(conn: ResolvedConnection, label: string): Promise<ConnectionSecret> {
  try {
    return await conn.secret();
  } catch (e) {
    if (isInferenceError(e)) throw e;
    throw new InferenceError("auth", `${label} connection's credential could not be read: ${cleanMessage((e as Error)?.message ?? e)}`, { provider: label });
  }
}

async function apiKeyOf(conn: ResolvedConnection, label: string, required: boolean): Promise<string | undefined> {
  const s = await secretOf(conn, label);
  if (s.kind === "api-key" && s.apiKey) {
    if (/[\r\n\0]/.test(s.apiKey)) throw new InferenceError("auth", `${label} connection's API key is malformed`, { provider: label });
    return s.apiKey.trim();
  }
  if (!required && s.kind === "none") return undefined;
  throw new InferenceError("auth", `${label} connection has no API key`, { provider: label });
}

const linked = (a?: AbortSignal, ms?: number) => {
  const signals = [a, ms ? AbortSignal.timeout(ms) : undefined].filter((s): s is AbortSignal => !!s);
  return signals.length > 1 ? AbortSignal.any(signals) : signals[0];
};

// Where one adapter call goes: the connection (its broker-scoped fetch, when it has one), the endpoint plan and the
// checked egress — all settled before the credential is read, so a refused destination never opens a secret.
interface Target {
  conn: ResolvedConnection;
  plan: EndpointPlan;
  label: string;
  egress?: { allowPrivate: boolean; resolve?: Resolver };
}
async function target(deps: HttpDeps, conn: ResolvedConnection, label: string): Promise<Target> {
  const plan = planEndpoint(conn, label);
  if (conn.fetch) {
    // The broker enforces the endpoint's egress class and pins the addresses; a local connection is also checked here
    // (its endpoint must resolve to loopback/private only), and plain http needs a local endpoint.
    if (plan.requirePrivate && !plan.local) throw new InferenceError("invalid_request", `${label}: plain http is only allowed to a local (loopback or private) endpoint`, { provider: label, code: "egress" });
    if (plan.local) await egressFor(plan, label, deps.resolve);
    return { conn, plan, label };
  }
  return { conn, plan, label, egress: await egressFor(plan, label, deps.resolve) };
}

// The path the broker's fetch() appends to the connection's endpoint: the URL relative to the registered endpoint, or
// to the origin for a built-in default (the broker's built-in bases are the providers' origins).
function brokerPath(t: Target, url: string): string {
  const u = new URL(url);
  const base = t.plan.custom ? t.plan.base.pathname.replace(/\/+$/, "") : "";
  return `${u.pathname.slice(base.length) || "/"}${u.search}`;
}

async function send(deps: HttpDeps, t: Target, url: string, init: { method: "GET" | "POST"; headers: Record<string, string>; body?: string }, signal?: AbortSignal, callerSignal?: AbortSignal): Promise<Response> {
  const { conn, label } = t;
  let res: Response;
  try {
    if (conn.fetch) res = await conn.fetch(brokerPath(t, url), { ...init, signal });
    else res = await deps.fetch(url, { ...init, signal, redirect: "error" }, { ...t.egress!, maxRedirects: 0 });
  } catch (e) {
    if (isInferenceError(e)) throw e;
    if (/redirect refused/i.test((e as Error)?.message ?? "")) throw new InferenceError("invalid_request", `${label} endpoint redirected — register the final URL`, { provider: label, code: "redirect" });
    throw toInferenceError(e, label, callerSignal ?? signal);
  }
  if (!res.ok) {
    const text = await readBody(res.body, { signal, max: 64_000 }).catch(() => "");
    throw httpError(label, res.status, res.headers, text, deps.now?.());
  }
  return res;
}

async function getJson(deps: HttpDeps, t: Target, url: string, headers: Record<string, string>, o: { signal?: AbortSignal; method?: "GET" | "POST"; body?: unknown } = {}): Promise<unknown> {
  const signal = linked(o.signal, deps.listTimeoutMs ?? LIST_TIMEOUT_MS);
  const res = await send(deps, t, url, { method: o.method ?? "GET", headers: { ...headers, accept: "application/json" }, ...(o.body !== undefined ? { body: JSON.stringify(o.body) } : {}) }, signal, o.signal);
  let text: string;
  try {
    text = await readBody(res.body, { signal });
  } catch (e) {
    throw toInferenceError(e, t.label, o.signal);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new InferenceError("unavailable", `${t.label} answered with something that is not JSON`, { provider: t.label });
  }
}

// A provider message may quote the connection's own key; the broker's scrub() removes it (redact() already removed
// what it recognises).
export async function scrubbed(conn: ResolvedConnection, e: unknown, label: string, signal?: AbortSignal): Promise<InferenceError> {
  const err = toInferenceError(e, label, signal);
  if (!conn.scrub) return err;
  let message = err.message;
  try {
    message = await conn.scrub(err.message);
  } catch {
    // keep the redacted message
  }
  return message === err.message ? err : new InferenceError(err.kind, message, err);
}

// One streamed turn: POST, then the event stream through the provider's parser. An error while reading — a reset, our
// idle timer, a malformed event — after the stream started is an incomplete stream; the caller's abort is "cancelled".
async function streamTurn(
  deps: HttpDeps,
  t: Target,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  req: GenerateRequest,
  stream: WireStream,
  jsonFallback?: (json: unknown, requestId?: string) => GenerateResult,
): Promise<GenerateResult> {
  const label = t.label;
  // The same idle limit bounds the wait for the answer to start: a provider that accepts the connection and never
  // answers would otherwise hold the run until it is cancelled.
  const idleMs = req.idleTimeoutMs ?? DEFAULT_IDLE_MS;
  const firstByte = new AbortController();
  const timer = setTimeout(() => firstByte.abort(new StreamIdleError(idleMs)), idleMs);
  let res: Response;
  try {
    res = await send(deps, t, url, { method: "POST", headers, body: JSON.stringify(body) }, req.signal ? AbortSignal.any([req.signal, firstByte.signal]) : firstByte.signal, req.signal);
  } catch (e) {
    if (firstByte.signal.aborted && !req.signal?.aborted) throw new InferenceError("unavailable", `${label} did not start answering within ${Math.round(idleMs / 1000)} s`, { provider: label, code: "timeout" });
    throw e;
  } finally {
    clearTimeout(timer);
  }
  const requestId = requestIdOf(res.headers);
  if (!res.body) throw streamBroke(label, "no-body", "the answer had no body", requestId);
  const type = res.headers.get("content-type") ?? "";
  if (jsonFallback && /application\/json/i.test(type) && !/event-stream/i.test(type)) {
    let text = "";
    try {
      text = await readBody(res.body, { signal: req.signal, idleMs: req.idleTimeoutMs });
      return jsonFallback(JSON.parse(text), requestId);
    } catch (e) {
      if (isInferenceError(e)) throw e;
      if (req.signal?.aborted) throw toInferenceError(e, label, req.signal);
      throw streamBroke(label, "bad-json", "the answer was not a complete completion", requestId);
    }
  }
  try {
    for await (const ev of readSse(res.body, { signal: req.signal, idleMs: req.idleTimeoutMs })) stream.push(ev);
  } catch (e) {
    if (isInferenceError(e)) throw e;
    if (req.signal?.aborted) throw new InferenceError("cancelled", `${label} request cancelled`, { provider: label, requestId });
    if (e instanceof StreamIdleError) throw streamBroke(label, "idle", e.message, requestId);
    throw streamBroke(label, (e as { code?: string })?.code ?? "read", "the connection broke off", requestId);
  }
  if (req.signal?.aborted) throw new InferenceError("cancelled", `${label} request cancelled`, { provider: label, requestId });
  return stream.finish(requestId);
}

function modelOf(conn: ResolvedConnection, req: GenerateRequest, label: string): string {
  const m = (req.model ?? conn.model ?? "").trim();
  if (!m) throw new InferenceError("invalid_request", `${label} connection has no model selected`, { provider: label });
  if (m.length > 200 || /[\s\0]/.test(m)) throw new InferenceError("invalid_request", `${label} model name is not valid`, { provider: label });
  return m;
}

// models() and generate() with every failure an InferenceError whose message the broker scrubbed.
function guarded(conn: ResolvedConnection, label: string, signal: AbortSignal | undefined) {
  return async <T,>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (e) {
      throw await scrubbed(conn, e, label, signal);
    }
  };
}

const errOf = async (conn: ResolvedConnection, e: unknown, label: string, signal?: AbortSignal) => {
  const err = await scrubbed(conn, e, label, signal);
  return { kind: err.kind, message: err.message };
};

// The common validate(): list models, check the connection's model is still offered, report its capabilities.
async function validateWith(
  adapter: Pick<InferenceAdapter, "models">,
  conn: ResolvedConnection,
  label: string,
  o: { signal?: AbortSignal } = {},
  same: (listed: string, model: string) => boolean = (a, b) => a === b,
): Promise<ValidateResult> {
  try {
    const models = await adapter.models(conn, o);
    const missing = modelOffered(models, conn.model, label, same);
    if (missing) return { ok: false, models, error: { kind: missing.kind, message: missing.message } };
    return { ok: true, model: conn.model, models, capabilities: models.find((m) => m.id === conn.model)?.capabilities ?? models.find((m) => same(m.id, conn.model!))!.capabilities };
  } catch (e) {
    return { ok: false, error: await errOf(conn, e, label, o.signal) };
  }
}

// ---------- Anthropic ----------

export function createAnthropicAdapter(deps: HttpDeps): InferenceAdapter {
  const label = "Anthropic";
  const caps = (id: string, reported?: Partial<Capabilities>) => capabilitiesFor("anthropic", id, reported);
  const adapter: InferenceAdapter = {
    provider: "anthropic",
    label,
    models: (conn, o = {}) =>
      guarded(conn, label, o.signal)(async () => {
        const t = await target(deps, conn, label);
        const key = await apiKeyOf(conn, label, true);
        const json = await getJson(deps, t, apiUrl(t.plan.base, "/models?limit=1000", "anthropic"), { "x-api-key": key!, "anthropic-version": ANTHROPIC_VERSION }, o);
        return parseAnthropicModels(json, caps);
      }),
    validate: (conn, o) => validateWith(adapter, conn, label, o, anthropicModelMatches),
    generate: (conn, req) =>
      guarded(conn, label, req.signal)(async () => {
        const model = modelOf(conn, req, label);
        const eff = checkRequest(req, caps(model), label, model);
        const body = buildAnthropicRequest(req, model, eff);
        const t = await target(deps, conn, label);
        const key = await apiKeyOf(conn, label, true);
        return streamTurn(deps, t, apiUrl(t.plan.base, "/messages", "anthropic"), anthropicHeaders(key!), body, req, createAnthropicStream({ onEvent: req.onEvent }));
      }),
  };
  return adapter;
}

// ---------- OpenAI Responses ----------

export function createOpenAiAdapter(deps: HttpDeps): InferenceAdapter {
  const label = "OpenAI";
  const caps = (id: string) => capabilitiesFor("openai", id);
  const adapter: InferenceAdapter = {
    provider: "openai",
    label,
    models: (conn, o = {}) =>
      guarded(conn, label, o.signal)(async () => {
        const t = await target(deps, conn, label);
        const key = await apiKeyOf(conn, label, true);
        return parseOpenAiModels(await getJson(deps, t, apiUrl(t.plan.base, "/models", "openai"), { authorization: `Bearer ${key}` }, o), caps);
      }),
    validate: (conn, o) => validateWith(adapter, conn, label, o),
    generate: (conn, req) =>
      guarded(conn, label, req.signal)(async () => {
        const model = modelOf(conn, req, label);
        const c = caps(model);
        const eff = checkRequest(req, c, label, model);
        const body = buildResponsesRequest(req, model, eff, c);
        const t = await target(deps, conn, label);
        const key = await apiKeyOf(conn, label, true);
        return streamTurn(deps, t, apiUrl(t.plan.base, "/responses", "openai"), openAiHeaders(key!), body, req, createResponsesStream({ onEvent: req.onEvent, label }));
      }),
  };
  return adapter;
}

// ---------- OpenAI-compatible ----------

// A server that can't list models answers 404/405/501 on /models: the connection still works, its model name just
// can't be checked in advance.
const NO_LISTING = new Set([404, 405, 501]);
const COMPAT_NOTE = "an OpenAI-compatible endpoint is not evidence of the same tool, streaming or cancellation behaviour; capabilities are assumed conservatively";

export function createCompatAdapter(deps: HttpDeps): InferenceAdapter {
  const label = "Model endpoint";
  const caps = (id: string) => capabilitiesFor("openai-compatible", id);
  const list = async (conn: ResolvedConnection, o: { signal?: AbortSignal }): Promise<ModelInfo[] | undefined> => {
    const t = await target(deps, conn, label);
    const key = await apiKeyOf(conn, label, false);
    try {
      const ids = parseCompatModels(await getJson(deps, t, apiUrl(t.plan.base, "/models", "openai"), compatHeaders(key), o));
      return ids.map((id) => ({ id, label: id, capabilities: caps(id) }));
    } catch (e) {
      if (isInferenceError(e) && e.status !== undefined && NO_LISTING.has(e.status)) return undefined;
      throw e;
    }
  };
  const adapter: InferenceAdapter = {
    provider: "openai-compatible",
    label,
    models: (conn, o = {}) => guarded(conn, label, o.signal)(async () => (await list(conn, o)) ?? (conn.model ? [{ id: conn.model, label: conn.model, capabilities: caps(conn.model) }] : [])),
    async validate(conn, o = {}) {
      try {
        const models = await list(conn, o);
        if (!models) {
          const warnings = ["this endpoint doesn't list its models, so the model name wasn't checked", COMPAT_NOTE];
          if (!conn.model) return { ok: false, warnings, error: { kind: "invalid_request", message: `${label} connection has no model selected` } };
          return { ok: true, model: conn.model, capabilities: caps(conn.model), warnings };
        }
        const missing = modelOffered(models, conn.model, label);
        if (missing) return { ok: false, models, error: { kind: missing.kind, message: missing.message } };
        return { ok: true, model: conn.model, models, capabilities: caps(conn.model!), warnings: [COMPAT_NOTE] };
      } catch (e) {
        return { ok: false, error: await errOf(conn, e, label, o.signal) };
      }
    },
    generate: (conn, req) =>
      guarded(conn, label, req.signal)(async () => {
        const model = modelOf(conn, req, label);
        const eff = checkRequest(req, caps(model), label, model);
        const body = buildChatRequest(req, model, eff);
        const t = await target(deps, conn, label);
        const key = await apiKeyOf(conn, label, false);
        return streamTurn(deps, t, apiUrl(t.plan.base, "/chat/completions", "openai"), compatHeaders(key), body, req, createChatStream({ onEvent: req.onEvent, label }), (json, rid) => parseCompatCompletion(json, label, rid));
      }),
  };
  return adapter;
}

// ---------- Ollama ----------

// Shown with every Ollama connection: "local" describes the endpoint, not where the model runs.
export const OLLAMA_CLOUD_NOTE =
  "Ollama can also run cloud models through this same local endpoint (names like \"gemma4:cloud\" or \"gpt-oss:120b-cloud\"); their prompts leave the machine. A local-only connection refuses them, but only Ollama's own setting (OLLAMA_NO_CLOUD=1, or disable_ollama_cloud in ~/.ollama/server.json) and the server's network rules make the endpoint itself local-only.";

const sameModel = (a: string, b: string) => a === b || (!a.includes(":") && `${a}:latest` === b) || (!b.includes(":") && `${b}:latest` === a);
const cloudRefusal = (label: string, model: string) =>
  new InferenceError("invalid_request", `${label}: ${model} is a cloud model — it runs on ollama.com even through this endpoint, and this connection is local-only`, { provider: label, code: "egress" });

export function createOllamaAdapter(deps: HttpDeps): InferenceAdapter {
  const label = "Ollama";
  const cache = deps.cache ?? new Map<string, { at: number; value: unknown }>();
  const now = () => deps.now?.() ?? Date.now();
  const caps = (id: string, reported?: Partial<Capabilities>) => capabilitiesFor("ollama", id, reported);

  // What the model reports about itself (tools, context, remote), cached per connection and model for 10 minutes.
  const show = async (t: Target, key: string | undefined, model: string, signal?: AbortSignal) => {
    const k = `ollama-show|${t.conn.id}|${t.plan.base.href}|${model}`;
    const hit = cache.get(k);
    if (hit && now() - hit.at < CACHE_MS) return hit.value as ReturnType<typeof parseOllamaShow>;
    const value = parseOllamaShow(await getJson(deps, t, apiUrl(t.plan.base, "/api/show", "root"), compatHeaders(key), { signal, method: "POST", body: { model } }));
    cache.set(k, { at: now(), value });
    if (cache.size > 500) cache.delete(cache.keys().next().value!);
    return value;
  };
  const capsOf = async (t: Target, key: string | undefined, model: string, signal?: AbortSignal) => {
    const s = await show(t, key, model, signal);
    return caps(model, { ...(s.tools !== undefined ? { tools: s.tools } : {}), ...(s.contextTokens ? { contextTokens: s.contextTokens } : {}), ...(s.remote ? { remote: true } : {}) });
  };
  const tags = async (conn: ResolvedConnection, o: { signal?: AbortSignal }) => {
    const t = await target(deps, conn, label);
    const key = await apiKeyOf(conn, label, false);
    const list = parseOllamaTags(await getJson(deps, t, apiUrl(t.plan.base, "/api/tags", "root"), compatHeaders(key), o));
    return {
      t,
      key,
      models: list.map((m) => ({ id: m.id, label: m.remote ? `${m.id} (cloud)` : m.id, capabilities: caps(m.id, m.remote ? { remote: true } : undefined), ...(m.remote ? { cloud: true } : {}) })) as ModelInfo[],
    };
  };

  const adapter: InferenceAdapter = {
    provider: "ollama",
    label,
    models: (conn, o = {}) => guarded(conn, label, o.signal)(async () => (await tags(conn, o)).models),
    async validate(conn, o = {}) {
      const warnings = [OLLAMA_CLOUD_NOTE];
      try {
        const { t, key, models } = await tags(conn, o);
        const cloud = models.filter((m) => m.cloud).map((m) => m.id);
        if (cloud.length && conn.egress === "local") warnings.push(`cloud models refused on this local-only connection: ${cloud.slice(0, 10).join(", ")}${cloud.length > 10 ? ", …" : ""}`);
        const found = conn.model ? models.find((m) => sameModel(conn.model!, m.id)) : undefined;
        if (!found) {
          const missing = modelOffered(models, conn.model, label)!;
          return { ok: false, models, warnings, error: { kind: missing.kind, message: missing.message } };
        }
        const c = await capsOf(t, key, found.id, o.signal);
        if (conn.egress === "local" && (found.cloud || c.remote)) {
          const e = cloudRefusal(label, conn.model!);
          return { ok: false, models, warnings, capabilities: c, error: { kind: e.kind, message: e.message } };
        }
        return { ok: true, model: conn.model, models, capabilities: c, warnings };
      } catch (e) {
        return { ok: false, warnings, error: await errOf(conn, e, label, o.signal) };
      }
    },
    generate: (conn, req) =>
      guarded(conn, label, req.signal)(async () => {
        const model = modelOf(conn, req, label);
        if (conn.egress === "local" && ollamaCloudModel(model)) throw cloudRefusal(label, model);
        const t = await target(deps, conn, label);
        const key = await apiKeyOf(conn, label, false);
        const c = await capsOf(t, key, model, req.signal).catch((e) => {
          // A model the server doesn't have, a refused key or endpoint, a cancel: the request's problem. Anything else (an
          // older server without /api/show) falls back to the map's conservative entry.
          if (isInferenceError(e) && (e.kind === "unsupported" || e.kind === "auth" || e.kind === "cancelled" || e.code === "egress")) throw e;
          return caps(model);
        });
        if (conn.egress === "local" && c.remote) throw cloudRefusal(label, model);
        const eff = checkRequest(req, c, label, model);
        const body = buildChatRequest(req, model, eff);
        return streamTurn(deps, t, apiUrl(t.plan.base, "/v1/chat/completions", "root"), compatHeaders(key), body, req, createChatStream({ onEvent: req.onEvent, label }), (json, rid) => parseCompatCompletion(json, label, rid));
      }),
  };
  return adapter;
}

export const HTTP_PROVIDERS: readonly InferenceProvider[] = ["anthropic", "openai", "openai-compatible", "ollama"];
