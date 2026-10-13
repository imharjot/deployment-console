// Contract tests of the HTTP adapters over a fake fetch: where requests go (and where they never go), what they carry,
// how provider answers and failures come back. No network: every response is a fixture.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Address, SafeInit, SafeOptions } from "../../plugins/http.ts";
import { fixtureJson, fixtureText, jsonResponse, sseResponse } from "./fixtures/load.ts";
import { createAnthropicAdapter, createCompatAdapter, createOllamaAdapter, createOpenAiAdapter, OLLAMA_CLOUD_NOTE, type HttpDeps } from "./http-adapters.ts";
import type { ConnectionSecret, GenerateRequest, ResolvedConnection, ToolSpec } from "./types.ts";

const SENTINEL = "sk-ant-api03-SENTINELsecretVALUE0123456789abcdefABCDEF";
const TOOLS: ToolSpec[] = [{ name: "services_get", description: "Service details", inputSchema: { type: "object", properties: { env: { type: "string" }, service: { type: "string" } } }, op: "services.get" }];
const REQ: GenerateRequest = { system: "Rules.", messages: [{ role: "user", content: [{ type: "text", text: "Why is billing degraded?" }] }], tools: TOOLS };
const kindOf = (e: unknown) => (e as { kind?: string }).kind;

interface Call {
  url: string;
  init: SafeInit;
  opts: SafeOptions;
  pinned?: Address[];
}

function fake(handler: (url: string, init: SafeInit) => Response | Promise<Response>, o: { resolve?: (host: string) => Address[] } = {}) {
  const calls: Call[] = [];
  const deps: HttpDeps = {
    fetch: async (url, init, opts) => {
      calls.push({ url, init, opts, pinned: opts.resolve ? await opts.resolve(new URL(url).hostname) : undefined });
      return handler(url, init);
    },
    ...(o.resolve ? { resolve: async (h: string) => o.resolve!(h) } : {}),
    cache: new Map(),
    listTimeoutMs: 2_000,
  };
  return { deps, calls };
}

function conn(o: Partial<ResolvedConnection> & { secretValue?: ConnectionSecret | Error } = {}): ResolvedConnection & { secretReads: number } {
  const { secretValue, ...rest } = o;
  const c = {
    id: "conn-1",
    provider: "anthropic" as const,
    authKind: "api-key",
    label: "Acme Anthropic",
    model: "claude-sonnet-4-5-20250929",
    egress: "cloud" as const,
    secretReads: 0,
    async secret(): Promise<ConnectionSecret> {
      c.secretReads++;
      if (secretValue instanceof Error) throw secretValue;
      return secretValue ?? { kind: "api-key", apiKey: SENTINEL };
    },
    ...rest,
  };
  return c;
}

const noSecret = (v: unknown) => assert.doesNotMatch(JSON.stringify(v, (_k, x) => (x instanceof Error ? { message: x.message } : x)) ?? "", /SENTINELsecret/);

test("Anthropic: the built-in endpoint, the key only in its header, redirects refused, the stream parsed", async () => {
  const { deps, calls } = fake(() => sseResponse(fixtureText("anthropic/tool-use.sse"), 9));
  const r = await createAnthropicAdapter(deps).generate(conn(), REQ);
  assert.equal(r.stop, "tool_calls");
  assert.equal(r.requestId, "req_fixture");
  assert.equal(calls.length, 1);
  const [c] = calls;
  assert.equal(c.url, "https://api.anthropic.com/v1/messages");
  assert.equal(c.init.method, "POST");
  assert.equal(c.init.redirect, "error");
  assert.equal(c.opts.maxRedirects, 0);
  assert.equal(c.opts.allowPrivate, false);
  const h = c.init.headers as Record<string, string>;
  assert.equal(h["x-api-key"], SENTINEL);
  assert.equal(h["anthropic-version"], "2023-06-01");
  const body = JSON.parse(c.init.body as string);
  assert.equal(body.model, "claude-sonnet-4-5-20250929");
  assert.doesNotMatch(c.init.body as string, /SENTINEL/, "the key never goes into a body");
  noSecret(r);
});

test("the endpoint comes only from the connection: an unregistered custom endpoint is refused before the key is read", async () => {
  const { deps, calls } = fake(() => sseResponse(fixtureText("anthropic/answer.sse")));
  const c = conn({ endpoint: "https://evil.example.com" });
  await assert.rejects(createAnthropicAdapter(deps).generate(c, REQ), (e) => kindOf(e) === "invalid_request" && /admin registered/.test((e as Error).message));
  assert.equal(calls.length, 0);
  assert.equal(c.secretReads, 0);
  // The built-in default spelled out is still the default.
  await createAnthropicAdapter(deps).generate(conn({ endpoint: "https://api.anthropic.com/" }), REQ);
  // A registered endpoint is used as registered (an OpenAI-style base keeps its path).
  await createAnthropicAdapter(deps).generate(conn({ endpoint: "https://llm-gateway.acme.test/anthropic", endpointRegistered: true }), REQ);
  assert.deepEqual(calls.map((x) => x.url), ["https://api.anthropic.com/v1/messages", "https://llm-gateway.acme.test/anthropic/v1/messages"]);
  for (const bad of ["ftp://x.test", "https://user:pw@x.test", "https://x.test/?k=1", "not a url"])
    await assert.rejects(createAnthropicAdapter(deps).generate(conn({ endpoint: bad, endpointRegistered: true }), REQ), (e) => kindOf(e) === "invalid_request", bad);
});

test("OpenAI Responses: built-in endpoint, bearer key, store:false", async () => {
  const { deps, calls } = fake(() => sseResponse(fixtureText("openai/function-call.sse"), 11));
  const r = await createOpenAiAdapter(deps).generate(conn({ provider: "openai", model: "gpt-5" }), { ...REQ, tools: [{ ...TOOLS[0], name: "envs_status" }] });
  assert.equal(r.stop, "tool_calls");
  assert.equal(calls[0].url, "https://api.openai.com/v1/responses");
  assert.equal((calls[0].init.headers as Record<string, string>).authorization, `Bearer ${SENTINEL}`);
  assert.equal(JSON.parse(calls[0].init.body as string).store, false);
});

test("quota: 429 with and without a reset, and an out-of-quota code; provider messages lose the key", async () => {
  const cases: [Response, string, number | undefined][] = [
    [jsonResponse(fixtureJson("anthropic/429.json"), 429, { "retry-after": "17" }), "rate_limited", 17_000],
    [jsonResponse(fixtureJson("anthropic/429.json"), 429), "quota", undefined],
    [jsonResponse(fixtureJson("openai/429-quota.json"), 429, { "x-ratelimit-reset-tokens": "1s" }), "quota", undefined],
    [jsonResponse(fixtureJson("anthropic/credit.json"), 400), "quota", undefined],
    [jsonResponse({ type: "error", error: { type: "authentication_error", message: `invalid x-api-key ${SENTINEL}` } }, 401), "auth", undefined],
    [jsonResponse({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }, 529, { "retry-after": "2" }), "unavailable", 2_000],
  ];
  for (const [res, kind, after] of cases) {
    const { deps } = fake(() => res);
    const err = await createAnthropicAdapter(deps).generate(conn(), REQ).then(() => undefined, (e) => e as { kind: string; retryAfterMs?: number; message: string });
    assert.equal(err?.kind, kind);
    assert.equal(err?.retryAfterMs, after);
    noSecret(err);
  }
});

test("the broker's scrub() removes the connection's own secret from provider messages", async () => {
  const odd = "acme-gw-token-ZZZ999notRecognisedByRedact";
  const { deps } = fake(() => jsonResponse({ error: { message: `token ${odd} is not allowed`, code: "forbidden" } }, 403));
  const c = conn({ provider: "openai-compatible", model: "m", endpoint: "https://gw.acme.test/v1", endpointRegistered: true, secretValue: { kind: "api-key", apiKey: odd }, scrub: async (t) => t.split(odd).join("[scrubbed]") });
  const err = await createCompatAdapter(deps).generate(c, REQ).then(() => undefined, (e) => e as Error & { kind: string });
  assert.equal(err?.kind, "auth");
  assert.doesNotMatch(err!.message, /ZZZ999/);
  assert.match(err!.message, /\[scrubbed\]/);
});

test("the broker's connection-scoped fetch is used when present (a fixed API path, never a URL)", async () => {
  const { deps, calls } = fake(() => {
    throw new Error("the injected fetch must not be used");
  });
  const paths: string[] = [];
  const brokered = (provider: ResolvedConnection["provider"], extra: Partial<ResolvedConnection>, res: () => Response) =>
    conn({ provider, ...extra, fetch: async (path: string) => (paths.push(path), res()) });
  await createAnthropicAdapter(deps).generate(brokered("anthropic", {}, () => sseResponse(fixtureText("anthropic/answer.sse"))), REQ);
  await createOpenAiAdapter(deps).generate(brokered("openai", { model: "gpt-5" }, () => sseResponse(fixtureText("openai/text.sse"))), REQ);
  await createCompatAdapter(deps).generate(brokered("openai-compatible", { model: "m", endpoint: "https://gw.acme.test/v1", endpointRegistered: true }, () => sseResponse(fixtureText("compat/text.sse"))), REQ);
  assert.deepEqual(paths, ["/v1/messages", "/v1/responses", "/chat/completions"]);
  assert.equal(calls.length, 0);
});

test("a changed model list: validate reports the connection's model is gone, without throwing", async () => {
  const ok = await createAnthropicAdapter(fake(() => jsonResponse(fixtureJson("anthropic/models.json"))).deps).validate(conn());
  assert.equal(ok.ok, true);
  assert.equal(ok.capabilities?.family, "claude-4");
  assert.equal(ok.models?.length, 3);
  // The list has dated ids; a connection saved with the alias is still offered.
  const alias = await createAnthropicAdapter(fake(() => jsonResponse(fixtureJson("anthropic/models.json"))).deps).validate(conn({ model: "claude-sonnet-4-5" }));
  assert.deepEqual([alias.ok, alias.capabilities?.family], [true, "claude-4"]);
  const gone = await createAnthropicAdapter(fake(() => jsonResponse(fixtureJson("anthropic/models-changed.json"))).deps).validate(conn());
  assert.equal(gone.ok, false);
  assert.equal(gone.error?.kind, "unsupported");
  assert.match(gone.error!.message, /no longer offers model claude-sonnet-4-5-20250929/);
  const denied = await createAnthropicAdapter(fake(() => jsonResponse(fixtureJson("anthropic/401.json"), 401)).deps).validate(conn());
  assert.deepEqual([denied.ok, denied.error?.kind], [false, "auth"]);
  const broken = await createOpenAiAdapter(fake(() => jsonResponse({})).deps).validate(conn({ provider: "openai", secretValue: new Error(`vault sealed ${SENTINEL}`) }));
  assert.deepEqual([broken.ok, broken.error?.kind], [false, "auth"]);
  noSecret(broken);
});

test("an OpenAI-compatible endpoint needs a registered endpoint; one without a model list still validates, conservatively", async () => {
  const none = fake(() => jsonResponse({}));
  await assert.rejects(createCompatAdapter(none.deps).generate(conn({ provider: "openai-compatible", model: "m" }), REQ), (e) => kindOf(e) === "invalid_request");
  assert.equal(none.calls.length, 0);
  const { deps, calls } = fake(() => jsonResponse({ error: "not found" }, 404));
  const v = await createCompatAdapter(deps).validate(conn({ provider: "openai-compatible", model: "my-model", endpoint: "https://vllm.acme.test/v1", endpointRegistered: true, secretValue: { kind: "none" } }));
  assert.equal(v.ok, true);
  assert.equal(v.capabilities?.source, "conservative");
  assert.ok(v.warnings?.some((w) => /doesn't list its models/.test(w)));
  assert.equal(calls[0].url, "https://vllm.acme.test/v1/models");
  assert.equal((calls[0].init.headers as Record<string, string>).authorization, undefined, "no key → no header");
  // A server that ignores stream:true and answers JSON.
  const json = fake(() => jsonResponse(fixtureJson("compat/completion.json")));
  const r = await createCompatAdapter(json.deps).generate(conn({ provider: "openai-compatible", model: "m", endpoint: "https://vllm.acme.test/v1", endpointRegistered: true }), REQ);
  assert.equal(r.stop, "tool_calls");
});

test("plain http only to loopback/private addresses; a local connection is pinned to private addresses", async () => {
  const publicDns = fake(() => jsonResponse({}), { resolve: () => [{ address: "203.0.113.10", family: 4 }] });
  await assert.rejects(
    createCompatAdapter(publicDns.deps).generate(conn({ provider: "openai-compatible", model: "m", endpoint: "http://llm.acme.test:8000/v1", endpointRegistered: true }), REQ),
    (e) => kindOf(e) === "invalid_request" && /plain http/.test((e as Error).message),
  );
  const localPublic = fake(() => jsonResponse({}), { resolve: () => [{ address: "10.0.0.5", family: 4 }, { address: "198.51.100.7", family: 4 }] });
  const lp = conn({ provider: "ollama", model: "qwen3:8b", endpoint: "http://ollama.acme.test:11434", endpointRegistered: true, egress: "local", secretValue: { kind: "none" } });
  await assert.rejects(createOllamaAdapter(localPublic.deps).generate(lp, REQ), (e) => kindOf(e) === "invalid_request" && /local-only/.test((e as Error).message));
  assert.equal(lp.secretReads, 0, "a refused destination never opens the credential");
  assert.equal(publicDns.calls.length + localPublic.calls.length, 0, "nothing was sent");
  const linkLocal = fake(() => jsonResponse({}), { resolve: () => [{ address: "169.254.169.254", family: 4 }] });
  await assert.rejects(
    createOllamaAdapter(linkLocal.deps).generate(conn({ provider: "ollama", model: "qwen3:8b", endpoint: "http://metadata.acme.test", endpointRegistered: true, egress: "local", secretValue: { kind: "none" } }), REQ),
    (e) => kindOf(e) === "invalid_request",
  );
  const local = fake((url) => (url.endsWith("/api/show") ? jsonResponse(fixtureJson("ollama/show-tools.json")) : sseResponse(fixtureText("compat/ollama-stop-with-tools.sse"))), { resolve: () => [{ address: "10.0.0.5", family: 4 }] });
  const r = await createOllamaAdapter(local.deps).generate(conn({ provider: "ollama", model: "qwen3:8b", endpoint: "http://ollama.acme.test:11434", endpointRegistered: true, egress: "local", secretValue: { kind: "none" } }), { ...REQ, tools: [{ ...TOOLS[0], name: "envs_status" }] });
  assert.equal(r.stop, "tool_calls");
  assert.deepEqual(local.calls.map((c) => c.url), ["http://ollama.acme.test:11434/api/show", "http://ollama.acme.test:11434/v1/chat/completions"]);
  for (const c of local.calls) {
    assert.equal(c.opts.allowPrivate, true);
    assert.deepEqual(c.pinned, [{ address: "10.0.0.5", family: 4 }], "the request dials only the checked addresses");
  }
});

test("Ollama: a local endpoint can still reach cloud models — shown on validate, refused on a local connection", async () => {
  const handler = (url: string) => (url.endsWith("/api/tags") ? jsonResponse(fixtureJson("ollama/tags.json")) : url.endsWith("/api/show") ? jsonResponse(fixtureJson("ollama/show-tools.json")) : sseResponse(fixtureText("compat/text.sse")));
  const base = { provider: "ollama" as const, endpoint: "http://127.0.0.1:11434", endpointRegistered: true, egress: "local" as const, secretValue: { kind: "none" as const } };
  const v = await createOllamaAdapter(fake(handler).deps).validate(conn({ ...base, model: "qwen3:8b" }));
  assert.equal(v.ok, true);
  assert.equal(v.warnings?.[0], OLLAMA_CLOUD_NOTE);
  assert.ok(v.warnings?.some((w) => /cloud models refused on this local-only connection: gpt-oss:120b-cloud/.test(w)));
  assert.deepEqual([v.capabilities?.tools, v.capabilities?.contextTokens, v.capabilities?.source], [true, 40_960, "provider"]);
  assert.equal(v.models?.find((m) => m.id === "gpt-oss:120b-cloud")?.cloud, true);
  const cloudPick = await createOllamaAdapter(fake(handler).deps).validate(conn({ ...base, model: "gpt-oss:120b-cloud" }));
  assert.deepEqual([cloudPick.ok, cloudPick.error?.kind], [false, "invalid_request"]);
  const f = fake(handler);
  await assert.rejects(createOllamaAdapter(f.deps).generate(conn({ ...base, model: "gpt-oss:120b-cloud" }), REQ), (e) => kindOf(e) === "invalid_request" && /cloud model/.test((e as Error).message));
  assert.equal(f.calls.length, 0, "refused before anything is sent");
  // A cloud connection may use it (the person chose cloud egress).
  const cloud = await createOllamaAdapter(fake(handler).deps).generate(conn({ ...base, egress: "cloud", model: "gpt-oss:120b-cloud" }), { messages: REQ.messages });
  assert.equal(cloud.text, "Staging is healthy.");
  // The tag "latest" is implied.
  const latest = fake((url) => (url.endsWith("/api/tags") ? jsonResponse({ models: [{ name: "llama3.1:latest" }] }) : jsonResponse(fixtureJson("ollama/show-tools.json"))));
  assert.equal((await createOllamaAdapter(latest.deps).validate(conn({ ...base, model: "llama3.1" }))).ok, true);
  assert.deepEqual(JSON.parse(latest.calls[1].init.body as string), { model: "llama3.1:latest" });
});

test("an unsupported capability is refused before the model is called", async () => {
  const f = fake((url) => (url.endsWith("/api/show") ? jsonResponse(fixtureJson("ollama/show-no-tools.json")) : sseResponse(fixtureText("compat/text.sse"))));
  await assert.rejects(createOllamaAdapter(f.deps).generate(conn({ provider: "ollama", model: "gemma2:2b", endpoint: "http://127.0.0.1:11434", endpointRegistered: true, egress: "local", secretValue: { kind: "none" } }), REQ), (e) => kindOf(e) === "unsupported");
  assert.deepEqual(f.calls.map((c) => new URL(c.url).pathname), ["/api/show"]);
  const a = fake(() => sseResponse(fixtureText("anthropic/answer.sse")));
  await assert.rejects(createAnthropicAdapter(a.deps).generate(conn({ model: "claude-3-5-haiku-20241022" }), { ...REQ, thinking: { budgetTokens: 1024 } }), (e) => kindOf(e) === "unsupported");
  await assert.rejects(createOpenAiAdapter(a.deps).generate(conn({ provider: "openai", model: "text-embedding-3-small" }), REQ), (e) => kindOf(e) === "unsupported");
  assert.equal(a.calls.length, 0);
});

test("streams: an abort is cancelled; silence, a reset or a missing terminal event is an incomplete stream", async () => {
  const ac = new AbortController();
  const hang = fake(() => sseResponse(fixtureText("anthropic/tool-use.sse").slice(0, 400), 50, {}, { hangAfter: true }));
  const p = createAnthropicAdapter(hang.deps).generate(conn(), { ...REQ, signal: ac.signal, idleTimeoutMs: 10_000 });
  setTimeout(() => ac.abort(), 20);
  await assert.rejects(p, (e) => kindOf(e) === "cancelled");
  await assert.rejects(createAnthropicAdapter(hang.deps).generate(conn(), { ...REQ, idleTimeoutMs: 30 }), (e) => kindOf(e) === "incomplete_stream" && /no data/.test((e as Error).message));
  const reset = fake(() => sseResponse(fixtureText("openai/function-call.sse").slice(0, 900), 64, {}, { failAfter: Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }) }));
  await assert.rejects(createOpenAiAdapter(reset.deps).generate(conn({ provider: "openai", model: "gpt-5" }), REQ), (e) => kindOf(e) === "incomplete_stream");
  const cut = fake(() => sseResponse(fixtureText("openai/no-completed.sse")));
  await assert.rejects(createOpenAiAdapter(cut.deps).generate(conn({ provider: "openai", model: "gpt-5" }), REQ), (e) => kindOf(e) === "incomplete_stream");
  const already = new AbortController();
  already.abort();
  const before = fake(() => {
    throw Object.assign(new Error("This operation was aborted"), { name: "AbortError" });
  });
  await assert.rejects(createAnthropicAdapter(before.deps).generate(conn(), { ...REQ, signal: already.signal }), (e) => kindOf(e) === "cancelled");
  const redirect = fake(() => {
    throw new Error("redirect refused (HTTP 302)");
  });
  await assert.rejects(createAnthropicAdapter(redirect.deps).generate(conn(), REQ), (e) => kindOf(e) === "invalid_request" && (e as { code?: string }).code === "redirect");
  const down = fake(() => {
    throw Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:11434"), { code: "ECONNREFUSED" });
  });
  await assert.rejects(createAnthropicAdapter(down.deps).generate(conn(), REQ), (e) => kindOf(e) === "unavailable");
});

test("a provider that accepts the connection but never answers is cut off by the idle limit (and a cancel still wins)", async () => {
  const hang = (_url: string, init: SafeInit) =>
    new Promise<Response>((_, reject) => init.signal?.addEventListener("abort", () => reject(init.signal?.reason ?? new DOMException("aborted", "AbortError")), { once: true }));
  const slow = await createAnthropicAdapter(fake(hang).deps).generate(conn(), { ...REQ, idleTimeoutMs: 30 }).then(() => undefined, (e) => e as Error & { kind: string; code?: string });
  assert.deepEqual([slow?.kind, slow?.code], ["unavailable", "timeout"]);
  assert.match(slow!.message, /did not start answering/);
  const ac = new AbortController();
  const p = createOpenAiAdapter(fake(hang).deps).generate(conn({ provider: "openai", model: "gpt-5" }), { ...REQ, signal: ac.signal, idleTimeoutMs: 10_000 });
  setTimeout(() => ac.abort(), 20);
  await assert.rejects(p, (e) => kindOf(e) === "cancelled");
});
