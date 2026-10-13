import { test } from "node:test";
import assert from "node:assert/strict";
import { backoffMs, cleanMessage, httpError, parseDuration, parseRetryAfter, recoveryFor, retryHint, toInferenceError } from "./errors.ts";
import { fixtureText } from "./fixtures/load.ts";
import { StreamIdleError } from "./sse.ts";
import { InferenceError, isInferenceError } from "./types.ts";

const H = (h: Record<string, string> = {}) => new Headers(h);
const NOW = Date.parse("2026-10-05T06:30:00Z");

test("retry hints: Retry-After (seconds or a date), Anthropic reset times, OpenAI durations — and nothing invented", () => {
  assert.equal(parseRetryAfter("12", NOW), 12_000);
  assert.equal(parseRetryAfter("Mon, 05 Oct 2026 06:30:30 GMT", NOW), 30_000);
  assert.equal(parseRetryAfter("soon", NOW), undefined);
  assert.equal(parseDuration("6m0s"), 360_000);
  assert.equal(parseDuration("1h2m3.5s"), 3_723_500);
  assert.equal(parseDuration("20ms"), 20);
  assert.equal(parseDuration("forever"), undefined);
  assert.deepEqual(retryHint(H({ "retry-after": "5" }), NOW), { retryAfterMs: 5_000, resetAt: NOW + 5_000 });
  assert.deepEqual(retryHint(H({ "anthropic-ratelimit-requests-reset": "2026-10-05T06:30:10Z", "anthropic-ratelimit-tokens-reset": "2026-10-05T06:30:40Z" }), NOW), { retryAfterMs: 40_000, resetAt: NOW + 40_000 });
  assert.deepEqual(retryHint(H({ "x-ratelimit-reset-requests": "1s", "x-ratelimit-reset-tokens": "6m0s" }), NOW), { retryAfterMs: 360_000, resetAt: NOW + 360_000 });
  assert.deepEqual(retryHint(H(), NOW), {});
});

test("HTTP failures map to kinds: 429 with a reset is throttling, without one (or with an out-of-quota code) it is quota", () => {
  const rate = httpError("Anthropic", 429, H({ "retry-after": "20", "request-id": "req_1" }), fixtureText("anthropic/429.json"), NOW);
  assert.equal(rate.kind, "rate_limited");
  assert.equal(rate.retryAfterMs, 20_000);
  assert.equal(rate.requestId, "req_1");
  assert.equal(rate.code, "rate_limit_error");

  const bare = httpError("Model endpoint", 429, H(), '{"error":{"message":"slow down"}}', NOW);
  assert.equal(bare.kind, "quota", "no reset time → pause, never guess one");
  assert.equal(bare.resetAt, undefined);
  assert.equal(bare.retryAfterMs, undefined);

  const quota = httpError("OpenAI", 429, H({ "x-ratelimit-reset-requests": "1s" }), fixtureText("openai/429-quota.json"), NOW);
  assert.equal(quota.kind, "quota", "insufficient_quota is quota even with a reset header");
  assert.equal(quota.retryAfterMs, undefined);

  assert.equal(httpError("OpenAI", 429, H({ "x-ratelimit-reset-requests": "2s" }), fixtureText("openai/429-rate.json"), NOW).kind, "rate_limited");
  assert.equal(httpError("Anthropic", 400, H(), fixtureText("anthropic/credit.json"), NOW).kind, "quota");
  assert.equal(httpError("Anthropic", 401, H(), fixtureText("anthropic/401.json"), NOW).kind, "auth");
  assert.equal(httpError("OpenAI", 403, H(), "{}", NOW).kind, "auth");
  assert.equal(httpError("Anthropic", 529, H({ "retry-after": "3" }), '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}', NOW).kind, "unavailable");
  assert.equal(httpError("Anthropic", 529, H({ "retry-after": "3" }), "", NOW).retryAfterMs, 3_000);
  assert.equal(httpError("Ollama", 404, H(), fixtureText("ollama/404.json"), NOW).kind, "unsupported");
  assert.equal(httpError("OpenAI", 404, H(), '{"error":{"code":"model_not_found","message":"The model `gpt-9` does not exist"}}', NOW).kind, "unsupported");
  assert.equal(httpError("OpenAI", 400, H(), '{"error":{"message":"Unsupported parameter: tools"}}', NOW).kind, "invalid_request");
  assert.equal(httpError("Model endpoint", 400, H(), '{"error":{"message":"this model does not support tools"}}', NOW).kind, "unsupported");
  assert.equal(httpError("Model endpoint", 502, H(), "<html>bad gateway</html>", NOW).kind, "unavailable");
});

test("error messages never carry the key a provider echoed", () => {
  const e = httpError("OpenAI", 401, H(), JSON.stringify({ error: { message: "Incorrect API key provided: sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcdefghij.", code: "invalid_api_key" } }), NOW);
  assert.equal(e.kind, "auth");
  assert.doesNotMatch(e.message, /AbCdEfGhIjKlMnOp/);
  assert.doesNotMatch(cleanMessage("Authorization: Bearer da_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ"), /abcdefghijklmnop/);
  assert.ok(cleanMessage("x".repeat(1000)).length <= 300);
});

test("thrown things become InferenceErrors: the caller's abort is cancelled, refused egress is a configuration error", () => {
  const ac = new AbortController();
  ac.abort();
  assert.equal(toInferenceError(new Error("aborted"), "OpenAI", ac.signal).kind, "cancelled");
  assert.equal(toInferenceError(Object.assign(new Error("that address is link-local"), { name: "EgressRefused" }), "OpenAI").kind, "invalid_request");
  assert.equal(toInferenceError(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }), "Ollama").kind, "unavailable");
  // Our own idle timer: the stream started and went silent, so whatever arrived is unusable (not "unreachable").
  const idle = toInferenceError(new StreamIdleError(120_000), "OpenAI");
  assert.deepEqual([idle.kind, idle.code], ["incomplete_stream", "idle"]);
  assert.equal(toInferenceError(Object.assign(new Error("the connection was disconnected"), { name: "CredentialError", code: "connection_revoked", status: 409 }), "OpenAI").kind, "auth");
  assert.equal(toInferenceError(Object.assign(new Error("audit down"), { name: "CredentialError", code: "audit_unavailable", status: 503 }), "OpenAI").kind, "unavailable");
  const kept = new InferenceError("quota", "out");
  assert.equal(toInferenceError(kept, "x"), kept);
  assert.ok(isInferenceError({ name: "InferenceError", kind: "auth", message: "from another bundle" }));
  assert.ok(!isInferenceError({ name: "InferenceError", kind: "nope" }));
});

test("recovery never switches connection: auth and quota pause, throttling and outages retry boundedly, the rest fail", () => {
  assert.deepEqual(recoveryFor(new InferenceError("auth", "refused")), { action: "pause", state: "paused_auth", cause: "refused" });
  assert.deepEqual(recoveryFor(new InferenceError("quota", "out", { resetAt: 5 })), { action: "pause", state: "paused_budget", cause: "out", resetAt: 5 });
  const r = recoveryFor(new InferenceError("rate_limited", "slow", { retryAfterMs: 9_000 }), 0);
  assert.deepEqual(r, { action: "retry", afterMs: 9_000, cause: "slow" });
  assert.equal(recoveryFor(new InferenceError("rate_limited", "slow"), 3).action, "pause", "still throttled after the retries → paused_budget");
  // A limit that lifts later than the backoff cap: paused until then, never retried early.
  assert.deepEqual(recoveryFor(new InferenceError("rate_limited", "slow", { retryAfterMs: 3_600_000, resetAt: 99 }), 0), { action: "pause", state: "paused_budget", cause: "slow", resetAt: 99 });
  assert.equal(recoveryFor(new InferenceError("unavailable", "down"), 1).action, "retry");
  assert.deepEqual(recoveryFor(new InferenceError("unavailable", "down"), 3), { action: "fail", cause: "down" });
  assert.equal(recoveryFor(new InferenceError("incomplete_stream", "cut"), 0).action, "retry");
  assert.equal(recoveryFor(new InferenceError("incomplete_stream", "cut"), 2).action, "fail");
  assert.equal(recoveryFor(new InferenceError("unsupported", "no tools")).action, "fail");
  assert.equal(recoveryFor(new InferenceError("invalid_request", "bad")).action, "fail");
  assert.equal(recoveryFor(new InferenceError("cancelled", "stop")).action, "cancelled");
  assert.equal(recoveryFor(new Error("weird")).action, "retry");
  assert.ok(backoffMs(0) === 2_000 && backoffMs(1) === 4_000 && backoffMs(10) === 60_000 && backoffMs(0, 1) === 2_500);
});
