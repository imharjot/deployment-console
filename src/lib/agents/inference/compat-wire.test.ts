import { test } from "node:test";
import assert from "node:assert/strict";
import { buildChatRequest, chatMessages, createChatStream, parseCompatCompletion, parseCompatModels, parseOllamaShow, parseOllamaTags } from "./compat-wire.ts";
import { CHUNK_SIZES, fixtureJson, fixtureText, parseFixture } from "./fixtures/load.ts";
import type { ToolSpec } from "./types.ts";

const TOOLS: ToolSpec[] = [{ name: "envs_status", description: "Environment status", inputSchema: { type: "object", properties: { env: { type: "string" } } } }];
const kindOf = (e: unknown) => (e as { kind?: string }).kind;
const chunk = (delta: object, finish: string | null = null) => `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;

test("tool calls split across deltas — id and name first, arguments in fragments — at any chunking", async () => {
  for (const size of CHUNK_SIZES) {
    const r = await parseFixture(fixtureText("compat/split-tool-calls.sse"), size, createChatStream());
    assert.equal(r.stop, "tool_calls", `size ${size}`);
    assert.deepEqual(r.toolCalls.map((c) => [c.id, c.name, c.input]), [["call_c1", "envs_status", { env: "staging" }], ["call_c2", "services_get", { env: "staging", service: "api" }]]);
    assert.equal(r.text, "Checking both.");
    assert.deepEqual(r.usage, { inputTokens: 900, outputTokens: 40 });
  }
});

test("Ollama's finish_reason \"stop\" on a tool-calling turn is a tool_calls turn", async () => {
  const r = await parseFixture(fixtureText("compat/ollama-stop-with-tools.sse"), 5, createChatStream({ label: "Ollama" }));
  assert.equal(r.stop, "tool_calls");
  assert.deepEqual(r.toolCalls.map((c) => [c.id, c.input]), [["call_o1", { env: "staging" }]]);
  assert.equal(r.model, "qwen3:8b");
});

test("servers that omit the index or reuse it for a new call", async () => {
  const noIndex = chunk({ tool_calls: [{ id: "a", function: { name: "envs_status", arguments: '{"env":' } }] }) + chunk({ tool_calls: [{ function: { arguments: '"x"}' } }] }) + chunk({ tool_calls: [{ id: "b", function: { name: "envs_list", arguments: "{}" } }] }) + chunk({}, "tool_calls");
  const r1 = await parseFixture(noIndex, 7, createChatStream());
  assert.deepEqual(r1.toolCalls.map((c) => [c.id, c.name, c.input]), [["a", "envs_status", { env: "x" }], ["b", "envs_list", {}]]);
  const reused = chunk({ tool_calls: [{ index: 0, id: "a", function: { name: "envs_list", arguments: "{}" } }] }) + chunk({ tool_calls: [{ index: 0, id: "b", function: { name: "envs_status", arguments: '{"env":"y"}' } }] }) + chunk({}, "tool_calls");
  const r2 = await parseFixture(reused, 7, createChatStream());
  assert.deepEqual(r2.toolCalls.map((c) => c.id), ["a", "b"]);
  const objectArgs = chunk({ tool_calls: [{ index: 0, id: "c", function: { name: "envs_status", arguments: { env: "z" } } }] }) + chunk({}, "tool_calls");
  assert.deepEqual((await parseFixture(objectArgs, 50, createChatStream())).toolCalls[0].input, { env: "z" });
  const bad = chunk({ tool_calls: [{ index: 0, id: "d", function: { name: "envs_status", arguments: '{"env": ' } }] }) + chunk({}, "tool_calls");
  const r3 = await parseFixture(bad, 50, createChatStream());
  assert.equal(r3.toolCalls[0].inputError, "the arguments were not valid JSON", "kept for the runner to answer, never executed as {}");
});

test("no finish_reason (with or without [DONE]), or an error once started → incomplete stream", async () => {
  await assert.rejects(parseFixture(fixtureText("compat/no-finish.sse"), 8, createChatStream()), (e) => kindOf(e) === "incomplete_stream");
  await assert.rejects(parseFixture(chunk({ content: "half" }), 8, createChatStream()), (e) => kindOf(e) === "incomplete_stream");
  await assert.rejects(parseFixture(fixtureText("compat/error-after-start.sse"), 8, createChatStream()), (e) => kindOf(e) === "incomplete_stream");
  const cut = chunk({ tool_calls: [{ index: 0, id: "e", function: { name: "services_restart", arguments: '{"env":"pro' } }] }) + chunk({}, "length");
  const r = await parseFixture(cut, 8, createChatStream());
  assert.equal(r.stop, "max_tokens");
  assert.deepEqual(r.toolCalls, []);
  assert.equal((await parseFixture(chunk({ content: "no" }) + chunk({}, "content_filter"), 8, createChatStream())).stop, "refusal");
  assert.equal((await parseFixture(fixtureText("compat/text.sse"), 8, createChatStream())).text, "Staging is healthy.");
});

test("a server that ignores stream:true and answers one completion", () => {
  const r = parseCompatCompletion(fixtureJson("compat/completion.json"));
  assert.equal(r.stop, "tool_calls");
  assert.deepEqual(r.toolCalls.map((c) => [c.id, c.name, c.input]), [["call_n1", "envs_list", {}]]);
  assert.throws(() => parseCompatCompletion({ choices: [{ message: { content: "x" } }] }), (e) => kindOf(e) === "incomplete_stream");
});

test("request: system message, tool messages right after the calling turn, conservative parameters", () => {
  const body = buildChatRequest(
    {
      system: "Rules.",
      messages: [
        { role: "user", content: [{ type: "text", text: "Status?" }] },
        { role: "assistant", content: [{ type: "native", provider: "anthropic", kind: "thinking", data: {} }, { type: "tool_call", id: "c1", name: "envs_status", input: { env: "staging" } }] },
        { role: "user", content: [{ type: "text", text: "and?" }, { type: "tool_result", callId: "c1", untrusted: true, content: "UP" }] },
      ],
      tools: TOOLS,
      maxOutputTokens: 500,
    },
    "qwen3:8b",
    { parallelToolCalls: false, maxOutputTokens: 500 },
  );
  assert.deepEqual(body.messages, [
    { role: "system", content: "Rules." },
    { role: "user", content: "Status?" },
    { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "envs_status", arguments: '{"env":"staging"}' } }] },
    { role: "tool", tool_call_id: "c1", content: "UP" },
    { role: "user", content: "and?" },
  ]);
  assert.equal(body.parallel_tool_calls, undefined, "not sent unless known to be supported");
  assert.equal(body.max_tokens, 500);
  assert.deepEqual(body.stream_options, { include_usage: true });
  assert.deepEqual(chatMessages(undefined, []), []);
});

test("model lists: compatible /models, Ollama tags (cloud models flagged) and /api/show", () => {
  assert.deepEqual(parseCompatModels(fixtureJson("compat/models.json")), ["Qwen/Qwen2.5-72B-Instruct", "meta-llama/Llama-3.3-70B-Instruct"]);
  assert.deepEqual(parseOllamaTags(fixtureJson("ollama/tags.json")).map((m) => [m.id, m.remote]), [["qwen3:8b", false], ["gemma2:2b", false], ["gpt-oss:120b-cloud", true]]);
  assert.deepEqual(parseOllamaShow(fixtureJson("ollama/show-tools.json")), { tools: true, contextTokens: 40_960 });
  assert.deepEqual(parseOllamaShow(fixtureJson("ollama/show-no-tools.json")), { tools: false, contextTokens: 8_192 });
});
