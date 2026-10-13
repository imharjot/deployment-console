// The ChatGPT-plan inference adapter: the public Responses API (POST {apiBase}/responses) with the person's plan
// sign-in instead of an API key (AGENT_ARCHITECTURE §2 "important implementation restrictions"). Pure: fetch, the token
// refresher and the clock are injected (the server module, src/lib/server/agents/chatgpt-plan.ts, supplies them).
//
// What makes it different from the OpenAI API adapter, whose request builder and stream parser it reuses
// (../inference/openai-wire.ts):
// - `store: false` and `stream: true` always; never `background`, `previous_response_id`, `max_output_tokens`,
//   `temperature`, `top_p`, `metadata`, `truncation`, `user` or the other fields the plan route refuses;
// - the console's function tools are grouped in one namespace, as the route requires;
// - `response.completed` is the only success; `response.incomplete`, `response.failed` and a stream that breaks off are
//   never a completed turn;
// - quota (`subscription_sharing_usage_limit_exceeded`) pauses the run (paused_budget) with no reset time invented —
//   and nothing ever falls back to API billing or another connection;
// - a refused or revoked sign-in pauses the run for re-authorisation (paused_auth).
import { cleanMessage, httpError, requestIdOf, toInferenceError } from "../inference/errors.ts";
import { capabilitiesFor, checkRequest } from "../inference/capabilities.ts";
import { buildResponsesRequest, createResponsesStream } from "../inference/openai-wire.ts";
import { readBody, readSse } from "../inference/sse.ts";
import {
  InferenceError,
  isInferenceError,
  type ContentBlock,
  type GenerateRequest,
  type GenerateResult,
  type InferenceAdapter,
  type InferenceErrorKind,
  type ModelInfo,
  type ModelMessage,
  type ResolvedConnection,
  type ValidateResult,
} from "../inference/types.ts";
import { isPlanOAuthError, safeText, type PlanConfig, type PlanFetch, type Refresher, type TokenStore } from "./oauth.ts";

export const LABEL = "ChatGPT plan";
export const PLAN_NAMESPACE = "console";

// Request fields the plan route refuses (preview limitations, 5 October 2026). Removed whatever the shared builder
// produced; store and stream are then set to the only values the route accepts.
export const PLAN_FORBIDDEN_FIELDS = [
  "background",
  "conversation",
  "max_output_tokens",
  "max_tool_calls",
  "metadata",
  "moderation",
  "multi_agent",
  "prompt",
  "prompt_cache_retention",
  "safety_identifier",
  "temperature",
  "top_logprobs",
  "top_p",
  "truncation",
  "user",
  "previous_response_id",
] as const;

// The plan route's error codes (errors and recovery, 5 October 2026) → what the runner does.
export const PLAN_ERROR_KIND: Readonly<Record<string, InferenceErrorKind>> = {
  subscription_sharing_usage_limit_exceeded: "quota", // pause; link to ChatGPT → Settings → Usage
  subscription_sharing_usage_unavailable: "unavailable", // bounded backoff
  subscription_sharing_user_unavailable: "unavailable",
  subscription_sharing_invalid_user: "auth", // sign in again
  chatpass_v2_scope_not_authorized: "auth", // sign in again with the plan scope
  subscription_sharing_user_not_eligible: "invalid_request", // don't retry: the account or workspace isn't eligible
  subscription_sharing_route_not_supported: "invalid_request",
  subscription_sharing_unsupported_capability: "unsupported",
};

// The connection the broker hands this adapter carries the token store (resolveConnection(...).tokens).
export type PlanConnection = ResolvedConnection & { tokens?: TokenStore };

// Native continuation items are the plan route's own: they go back to it, and nothing from another provider does. The
// shared builder replays only "openai" natives, so ours are relabelled for the trip and the result relabelled back.
export function planMessages(messages: readonly ModelMessage[]): ModelMessage[] {
  return messages.map((m) => ({
    role: m.role,
    content: m.content.flatMap((b): ContentBlock[] => (b.type !== "native" ? [b] : b.provider === "chatgpt-plan" ? [{ ...b, provider: "openai" }] : [])),
  }));
}

const stripNamespace = (name: string) => {
  for (const p of [`${PLAN_NAMESPACE}.`, `${PLAN_NAMESPACE}__`, `${PLAN_NAMESPACE}/`]) if (name.startsWith(p)) return name.slice(p.length);
  return name;
};

export function planRequest(req: GenerateRequest, model: string): Record<string, unknown> {
  const caps = capabilitiesFor("chatgpt-plan", model);
  const eff = checkRequest(req, caps, LABEL, model);
  const body = buildResponsesRequest({ ...req, messages: planMessages(req.messages) }, model, eff, caps, { omitMaxOutputTokens: true });
  for (const k of PLAN_FORBIDDEN_FIELDS) delete body[k];
  if (Array.isArray(body.tools) && body.tools.length) {
    body.tools = [{ type: "namespace", name: PLAN_NAMESPACE, description: "Deployment console operations: status, logs, metrics and guarded actions.", tools: body.tools }];
    if (Array.isArray(body.input)) body.input = body.input.map((it: Record<string, unknown>) => (it.type === "function_call" ? { ...it, namespace: PLAN_NAMESPACE } : it));
  }
  body.store = false;
  body.stream = true;
  return body;
}

// The result as the console stores it: natives labelled as this provider's, tool names without the namespace.
export function planResult(r: GenerateResult): GenerateResult {
  const fix = (b: ContentBlock): ContentBlock => (b.type === "native" ? { ...b, provider: "chatgpt-plan" } : b.type === "tool_call" ? { ...b, name: stripNamespace(b.name) } : b);
  const content = r.message.content.map(fix);
  return { ...r, message: { ...r.message, content }, toolCalls: r.toolCalls.map((c) => ({ ...c, name: stripNamespace(c.name) })) };
}

// An InferenceError from the shared parser or HTTP mapping, re-read with the plan route's own codes. A quota never
// carries a reset time unless the provider gave one.
export function planError(e: InferenceError, detail?: string): InferenceError {
  const kind = e.code ? PLAN_ERROR_KIND[e.code] : undefined;
  if (!kind || kind === e.kind) return e;
  const why =
    kind === "quota"
      ? "your ChatGPT plan's usage limit for this app was reached — the run is paused; manage it in ChatGPT → Settings → Usage (the console never falls back to API billing)"
      : kind === "auth"
        ? "ChatGPT refused the sign-in — sign in again"
        : e.code === "subscription_sharing_user_not_eligible"
          ? "this ChatGPT account or workspace isn't eligible for plan usage in this app"
          : e.message;
  return new InferenceError(kind, `${LABEL}: ${why}${detail ? ` (${detail})` : ""}`, { provider: LABEL, status: e.status, code: e.code, requestId: e.requestId, resetAt: kind === "quota" ? e.resetAt : undefined });
}

// A failed sign-in renewal, as the runner reads it.
export function oauthToInference(e: unknown): InferenceError {
  if (!isPlanOAuthError(e)) return toInferenceError(e, LABEL);
  const kind: InferenceErrorKind = e.code === "temporary" ? "unavailable" : e.code === "config" ? "invalid_request" : "auth";
  return new InferenceError(kind, `${LABEL}: ${e.message}`, { provider: LABEL, status: e.status, code: e.providerCode ?? e.code });
}

// Pre-stream admission errors may be {"detail": "…"} instead of an API error object.
function admissionError(status: number, headers: Headers, text: string, sent: string): InferenceError {
  let body = text;
  try {
    const j = JSON.parse(text) as Record<string, unknown>;
    if (typeof j.detail === "string" && !j.error) body = JSON.stringify({ error: { message: j.detail } });
  } catch {
    // plain text
  }
  const e = httpError(LABEL, status, headers, safeText(body, [sent], 20_000));
  return planError(e);
}

export interface PlanAdapterDeps {
  config(): PlanConfig;
  fetch: PlanFetch;
  refresher: Refresher;
  // Records what the provider said about the connection (needs_auth after a refused sign-in). Never throws.
  markStatus?(connectionId: string, status: "active" | "needs_auth" | "error"): Promise<void> | void;
}

export function createPlanAdapter(deps: PlanAdapterDeps): InferenceAdapter {
  const storeOf = (conn: PlanConnection): TokenStore => {
    if (!conn.tokens) throw new InferenceError("invalid_request", `${LABEL}: the connection has no sign-in record (it must come from the credential broker)`, { provider: LABEL });
    return conn.tokens;
  };
  const access = async (conn: PlanConnection, o: { rejected?: string; signal?: AbortSignal } = {}) => {
    try {
      return await deps.refresher.access(conn.id, storeOf(conn), o);
    } catch (e) {
      if (isInferenceError(e)) throw e;
      throw oauthToInference(e);
    }
  };
  const mark = async (id: string, s: "active" | "needs_auth" | "error") => {
    try {
      await deps.markStatus?.(id, s);
    } catch {
      // status is advisory
    }
  };
  // One authorised call: on a 401 the token is renewed once (unless someone already did) and the call repeated.
  const call = async (conn: PlanConnection, path: string, init: { method: string; body?: string; accept: string; signal?: AbortSignal }) => {
    let token = await access(conn, { signal: init.signal });
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await deps.fetch(`${deps.config().apiBase}${path}`, {
          method: init.method,
          headers: { authorization: `Bearer ${token}`, accept: init.accept, ...(init.body ? { "content-type": "application/json" } : {}) },
          ...(init.body ? { body: init.body } : {}),
          signal: init.signal,
        });
      } catch (e) {
        throw toInferenceError(e, LABEL, init.signal);
      }
      if (res.status === 401 && attempt === 0) {
        await res.body?.cancel().catch(() => {});
        token = await access(conn, { rejected: token, signal: init.signal });
        continue;
      }
      if (!res.ok) {
        const text = await readBody(res.body, { signal: init.signal, max: 20_000 }).catch(() => "");
        const err = admissionError(res.status, res.headers, text, token);
        if (err.kind === "auth") await mark(conn.id, "needs_auth");
        if (err.code === "subscription_sharing_user_not_eligible") await mark(conn.id, "error");
        throw err;
      }
      return res;
    }
  };

  const models = async (conn: PlanConnection, o: { signal?: AbortSignal } = {}): Promise<ModelInfo[]> => {
    const res = await call(conn, "/models", { method: "GET", accept: "application/json", signal: o.signal });
    let j: unknown;
    try {
      j = JSON.parse(await readBody(res.body, { signal: o.signal, max: 2_000_000 }));
    } catch {
      throw new InferenceError("unavailable", `${LABEL} answered the model list with something that isn't JSON`, { provider: LABEL });
    }
    // { models: [{ slug, display_name, visibility }] }; anything not listed for display is left out.
    const list = Array.isArray((j as { models?: unknown })?.models) ? ((j as { models: Record<string, unknown>[] }).models ?? []) : [];
    return list
      .filter((m) => m && typeof m.slug === "string" && (m.visibility === undefined || m.visibility === "list"))
      .map((m) => ({ id: m.slug as string, label: typeof m.display_name === "string" ? cleanMessage(m.display_name, 80) : (m.slug as string), capabilities: capabilitiesFor("chatgpt-plan", m.slug as string) }));
  };

  return {
    provider: "chatgpt-plan",
    label: LABEL,
    models: (conn, o) => models(conn as PlanConnection, o),
    async validate(conn, o): Promise<ValidateResult> {
      try {
        const list = await models(conn as PlanConnection, o);
        const model = conn.model ?? list[0]?.id;
        await mark(conn.id, "active");
        return {
          ok: true,
          ...(model ? { model, capabilities: capabilitiesFor("chatgpt-plan", model) } : {}),
          models: list,
          warnings: [`Runs use your ChatGPT plan's allowance; manage this app's limit at ${deps.config().usageUrl}. The console can't see how much is left.`],
        };
      } catch (e) {
        const err = isInferenceError(e) ? e : oauthToInference(e);
        return { ok: false, error: { kind: err.kind, message: err.message } };
      }
    },
    async generate(conn, req): Promise<GenerateResult> {
      const model = req.model ?? conn.model;
      if (!model) throw new InferenceError("invalid_request", `${LABEL} connection has no model selected`, { provider: LABEL });
      const body = planRequest(req, model); // throws "unsupported" before any network call
      const res = await call(conn as PlanConnection, "/responses", { method: "POST", body: JSON.stringify(body), accept: "text/event-stream", signal: req.signal });
      if (!res.body) throw new InferenceError("incomplete_stream", `${LABEL} answered without a stream`, { provider: LABEL });
      const wire = createResponsesStream({ onEvent: req.onEvent, label: LABEL });
      try {
        for await (const ev of readSse(res.body, { signal: req.signal, idleMs: req.idleTimeoutMs })) wire.push(ev);
        return planResult(wire.finish(requestIdOf(res.headers)));
      } catch (e) {
        const err = isInferenceError(e)
          ? planError(e)
          : (e as Error)?.name === "StreamIdleError" && !req.signal?.aborted
            ? new InferenceError("incomplete_stream", `${LABEL} stream went silent before response.completed`, { provider: LABEL })
            : toInferenceError(e, LABEL, req.signal);
        if (err.kind === "auth") await mark(conn.id, "needs_auth");
        throw err;
      }
    },
  };
}
