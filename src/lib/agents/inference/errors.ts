// How provider failures become InferenceErrors, and what the runner does with each kind. Pure.
//
// The one rule that matters: a failure never moves the request to another provider, connection, endpoint or model —
// that would change who pays and who sees the data (AGENT_ARCHITECTURE §5). It pauses the run with the cause
// (paused_auth / paused_budget), retries the same request with bounded backoff, or fails it.
import { redact } from "../redact.ts";
import { InferenceError, isInferenceError, type InferenceErrorKind } from "./types.ts";

export const MAX_MESSAGE = 300;

// One line, bounded, and run through redaction: provider messages sometimes echo part of a key ("Incorrect API key
// provided: sk-ab…yz") or a URL with a signature.
export function cleanMessage(s: unknown, max = MAX_MESSAGE): string {
  const one = String(s ?? "").replace(/\s+/g, " ").trim();
  const text = redact(one).text;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

// ---------- retry hints ----------

export interface HeaderLike {
  get(name: string): string | null;
}

// Retry-After: delta-seconds or an HTTP date.
export function parseRetryAfter(v: string | null | undefined, now = Date.now()): number | undefined {
  if (!v) return undefined;
  const t = v.trim();
  if (/^\d+(\.\d+)?$/.test(t)) return Math.round(Number(t) * 1000);
  const at = Date.parse(t);
  return Number.isFinite(at) ? Math.max(0, at - now) : undefined;
}

// OpenAI's x-ratelimit-reset-*: Go-style durations ("1s", "6m0s", "20ms", "1h2m3.5s").
export function parseDuration(v: string | null | undefined): number | undefined {
  if (!v) return undefined;
  const t = v.trim();
  if (!t || !/^(\d+(\.\d+)?(ms|h|m|s))+$/.test(t)) return undefined;
  let ms = 0;
  for (const m of t.matchAll(/(\d+(?:\.\d+)?)(ms|h|m|s)/g)) ms += Number(m[1]) * { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[m[2] as "ms" | "s" | "m" | "h"];
  return Math.round(ms);
}

// When the provider said the limit resets: Retry-After first (authoritative), else the latest of the per-limit reset
// headers (Anthropic RFC 3339 times, OpenAI durations). Nothing is invented: no header → no hint.
export function retryHint(h: HeaderLike, now = Date.now()): { retryAfterMs?: number; resetAt?: number } {
  const after = parseRetryAfter(h.get("retry-after"), now);
  if (after !== undefined) return { retryAfterMs: after, resetAt: now + after };
  const resets: number[] = [];
  for (const name of ["anthropic-ratelimit-requests-reset", "anthropic-ratelimit-tokens-reset", "anthropic-ratelimit-input-tokens-reset", "anthropic-ratelimit-output-tokens-reset"]) {
    const at = Date.parse(h.get(name) ?? "");
    if (Number.isFinite(at)) resets.push(at);
  }
  for (const name of ["x-ratelimit-reset-requests", "x-ratelimit-reset-tokens"]) {
    const d = parseDuration(h.get(name));
    if (d !== undefined) resets.push(now + d);
  }
  if (!resets.length) return {};
  const resetAt = Math.max(...resets);
  return { retryAfterMs: Math.max(0, resetAt - now), resetAt };
}

// ---------- HTTP failures ----------

// Codes and texts that mean "the account is out of quota or credit" (pause; nothing resets it by waiting a few seconds).
const QUOTA_CODES = new Set(["insufficient_quota", "billing_hard_limit_reached", "billing_error", "billing_not_active", "credit_balance_too_low", "ServiceQuotaExceededException"]);
const QUOTA_TEXT = /credit balance is too low|insufficient[_ ]quota|exceeded your current quota|billing (hard )?limit|purchase (more )?credits/i;
const UNSUPPORTED_TEXT = /does(n't| not) support (tool|function|tools|tool use|streaming|thinking|reasoning)|tools? (are|is) not supported|not support(ed)? (for|with) this model/i;
const MODEL_TEXT = /\bmodel\b/i;

export const requestIdOf = (h: HeaderLike) => h.get("request-id") ?? h.get("x-request-id") ?? h.get("x-amzn-requestid") ?? undefined;

interface ErrorBody {
  code?: string;
  message?: string;
}

// The error shapes providers answer with: Anthropic {type:"error", error:{type, message}}, OpenAI and most compatible
// servers {error:{message, type, code}}, Ollama {error:"…"}; anything else is text.
export function errorBody(text: string): ErrorBody {
  let j: unknown;
  try {
    j = JSON.parse(text);
  } catch {
    return { message: text };
  }
  if (!j || typeof j !== "object") return { message: text };
  const e = (j as { error?: unknown }).error;
  if (typeof e === "string") return { message: e };
  if (e && typeof e === "object") {
    const o = e as { code?: unknown; type?: unknown; message?: unknown };
    const code = typeof o.code === "string" && o.code ? o.code : typeof o.type === "string" ? o.type : undefined;
    return { code, message: typeof o.message === "string" ? o.message : undefined };
  }
  const m = (j as { message?: unknown }).message;
  return { message: typeof m === "string" ? m : undefined };
}

export function kindFor(status: number, code: string | undefined, message: string, hint: { retryAfterMs?: number }): InferenceErrorKind {
  if ((code && QUOTA_CODES.has(code)) || QUOTA_TEXT.test(message)) return "quota";
  if (status === 401 || status === 403) return "auth";
  if (status === 402) return "quota";
  // 429 with a reset hint is throttling (wait and retry); without one we can't tell when it ends — pause, never guess.
  if (status === 429) return hint.retryAfterMs !== undefined ? "rate_limited" : "quota";
  if (status === 404) return MODEL_TEXT.test(message) || code === "model_not_found" ? "unsupported" : "invalid_request";
  if (code === "model_not_found") return "unsupported";
  if (status === 408 || status === 409) return "unavailable";
  if (status >= 500) return "unavailable"; // incl. Anthropic's 529 overloaded
  if (UNSUPPORTED_TEXT.test(message)) return "unsupported";
  return "invalid_request";
}

const VERB: Record<InferenceErrorKind, string> = {
  auth: "refused the credential",
  quota: "says the account is out of quota",
  rate_limited: "is rate limiting this connection",
  unavailable: "is unavailable",
  invalid_request: "refused the request",
  unsupported: "can't do this",
  cancelled: "request cancelled",
  incomplete_stream: "stream broke off",
};

// A non-2xx answer → InferenceError. Never includes the URL, a header or the request body.
export function httpError(label: string, status: number, headers: HeaderLike, bodyText: string, now = Date.now()): InferenceError {
  const b = errorBody(bodyText.slice(0, 20_000));
  const message = cleanMessage(b.message ?? "");
  const hint = status === 429 || status >= 500 ? retryHint(headers, now) : {};
  const kind = kindFor(status, b.code, message, hint);
  const quota = kind === "quota";
  return new InferenceError(kind, `${label} ${VERB[kind]} (HTTP ${status}${b.code ? `, ${b.code}` : ""})${message ? `: ${message}` : ""}`, {
    provider: label,
    status,
    code: b.code,
    requestId: requestIdOf(headers),
    // A quota pause carries the provider's reset time only when it gave one.
    retryAfterMs: quota ? undefined : hint.retryAfterMs,
    resetAt: hint.resetAt,
  });
}

// An error event inside a stream that already started: whatever arrived is unusable (no terminal event).
export function streamBroke(label: string, code: string | undefined, message: unknown, requestId?: string): InferenceError {
  const m = cleanMessage(message);
  return new InferenceError("incomplete_stream", `${label} stream broke off${code ? ` (${code})` : ""}${m ? `: ${m}` : ""}`, { provider: label, code, requestId });
}

// Anything thrown while talking to a provider → InferenceError. An abort the caller asked for is "cancelled"; our own
// idle timer is "incomplete_stream"; an egress refusal is a configuration problem; network failures are "unavailable".
export function toInferenceError(e: unknown, label: string, signal?: AbortSignal): InferenceError {
  if (isInferenceError(e)) return e;
  if (signal?.aborted) return new InferenceError("cancelled", `${label} request cancelled`, { provider: label });
  const err = e as Error & { code?: string; cause?: { code?: string } };
  if (err?.name === "AbortError") return new InferenceError("cancelled", `${label} request cancelled`, { provider: label });
  if (err?.name === "EgressRefused" || err?.code === "EGRESS_REFUSED") return new InferenceError("invalid_request", `${label} endpoint refused: ${cleanMessage(err.message)}`, { provider: label, code: "egress" });
  // The credential broker refused (revoked, needs sign-in, not allowed for this run): re-authorisation, except when its
  // own storage is down.
  if (err?.name === "CredentialError") {
    const status = (err as { status?: number }).status;
    return new InferenceError(status !== undefined && status >= 500 ? "unavailable" : "auth", `${label} connection unavailable: ${cleanMessage(err.message)}`, { provider: label, code: err.code, status });
  }
  if (err?.name === "StreamIdleError") return new InferenceError("incomplete_stream", `${label} stream went silent`, { provider: label, code: "idle" });
  if (err?.name === "TimeoutError") return new InferenceError("unavailable", `${label} did not answer in time`, { provider: label, code: "timeout" });
  const code = err?.code ?? err?.cause?.code;
  return new InferenceError("unavailable", `${label} could not be reached${code ? ` (${code})` : ""}`, { provider: label, code });
}

// ---------- what the runner does ----------

export type InferenceRecovery =
  | { action: "pause"; state: "paused_auth" | "paused_budget"; cause: string; resetAt?: number }
  | { action: "retry"; afterMs: number; cause: string }
  | { action: "fail"; cause: string }
  | { action: "cancelled"; cause: string };

// Retries of the *same* request on the *same* connection before giving up.
export const RETRY_LIMITS: Readonly<Partial<Record<InferenceErrorKind, number>>> = { rate_limited: 3, unavailable: 3, incomplete_stream: 2 };
const BACKOFF_CAP_MS = 60_000;

// 2 s, 4 s, 8 s … (capped), with up to 25 % jitter from `rand` (0–1).
export const backoffMs = (attempt: number, rand = 0) => Math.min(BACKOFF_CAP_MS, 2_000 * 2 ** Math.max(0, attempt)) * (1 + 0.25 * Math.min(1, Math.max(0, rand)));

// `attempt` = retries already made for this turn (0 on the first failure).
export function recoveryFor(e: unknown, attempt = 0, rand = 0): InferenceRecovery {
  const err = isInferenceError(e) ? e : new InferenceError("unavailable", cleanMessage((e as Error)?.message ?? e));
  const cause = err.message;
  switch (err.kind) {
    case "auth":
      return { action: "pause", state: "paused_auth", cause };
    case "quota":
      return { action: "pause", state: "paused_budget", cause, resetAt: err.resetAt };
    case "cancelled":
      return { action: "cancelled", cause };
    case "rate_limited":
    case "unavailable":
    case "incomplete_stream": {
      const limit = RETRY_LIMITS[err.kind] ?? 0;
      // A provider that says the limit lifts later than the backoff cap: wait for it paused, never retry early.
      if (err.kind === "rate_limited" && (err.retryAfterMs ?? 0) > BACKOFF_CAP_MS) return { action: "pause", state: "paused_budget", cause, resetAt: err.resetAt };
      if (attempt < limit) return { action: "retry", afterMs: Math.min(BACKOFF_CAP_MS, Math.max(err.retryAfterMs ?? 0, backoffMs(attempt, rand))), cause };
      // Still throttled after the retries: the budget of this connection is the problem — pause, don't spin.
      if (err.kind === "rate_limited") return { action: "pause", state: "paused_budget", cause, resetAt: err.resetAt };
      return { action: "fail", cause };
    }
    default:
      return { action: "fail", cause };
  }
}
