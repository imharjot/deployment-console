import { test } from "node:test";
import assert from "node:assert/strict";
import { capabilitiesFor } from "./capabilities.ts";
import { CHUNK_SIZES, fixtureJson, fixtureText, parseFixture } from "./fixtures/load.ts";
import { buildResponsesRequest, createResponsesStream, parseOpenAiModels, responsesInput } from "./openai-wire.ts";
import type { ModelMessage, ToolSpec } from "./types.ts";

const TOOLS: ToolSpec[] = [{ name: "envs_status", description: "Environment status", inputSchema: { type: "object", required: ["env"], properties: { env: { type: "string" } } }, op: "envs.status" }];
const kindOf = (e: unknown) => (e as { kind?: string }).kind;

test("function calls: arguments split across deltas (and the stream split anywhere) → executable calls; reasoning kept", async () => {
  for (const size of CHUNK_SIZES) {
    const r = await parseFixture(fixtureText("openai/function-call.sse"), size, createResponsesStream());
    assert.equal(r.stop, "tool_calls", `size ${size}`);
    assert.deepEqual(r.toolCalls, [{ type: "tool_call", id: "call_Acme1", name: "envs_status", input: { env: "production" }, itemId: "fc_0acme" }]);
    assert.deepEqual(r.message.content[0], { type: "native", provider: "openai", kind: "reasoning", data: { id: "rs_0acme", type: "reasoning", summary: [], encrypted_content: "gAAAAABo-encrypted-reasoning-blob==" } });
    assert.deepEqual(r.usage, { inputTokens: 2010, outputTokens: 96, cacheReadTokens: 1536, reasoningTokens: 64 });
    assert.equal(r.model, "gpt-5-2025-08-07");
    assert.equal(r.requestId, "resp_0acme");
  }
});

test("response.completed is the only success: a stream without it is incomplete, even with every item done", async () => {
  await assert.rejects(parseFixture(fixtureText("openai/no-completed.sse"), 13, createResponsesStream()), (e) => kindOf(e) === "incomplete_stream");
  await assert.rejects(parseFixture(fixtureText("openai/error-event.sse"), 13, createResponsesStream()), (e) => kindOf(e) === "incomplete_stream" && /server_error/.test((e as Error).message));
  await assert.rejects(
    parseFixture('data: {"type":"response.completed","response":{"id":"r","status":"in_progress","output":[]}}\n\n', 5, createResponsesStream()),
    (e) => kindOf(e) === "incomplete_stream",
    "a completed event must say completed",
  );
});

test("response.failed maps to kinds; response.incomplete is a result whose calls never execute", async () => {
  await assert.rejects(parseFixture(fixtureText("openai/failed-rate.sse"), 9, createResponsesStream()), (e) => kindOf(e) === "rate_limited");
  await assert.rejects(parseFixture(fixtureText("openai/failed-server.sse"), 9, createResponsesStream()), (e) => kindOf(e) === "unavailable");
  const r = await parseFixture(fixtureText("openai/incomplete.sse"), 9, createResponsesStream());
  assert.equal(r.stop, "max_tokens");
  assert.deepEqual(r.toolCalls, []);
  assert.equal(r.providerStop, "incomplete:max_output_tokens");
});

test("refusal and plain text", async () => {
  const refusal = await parseFixture(fixtureText("openai/refusal.sse"), 4, createResponsesStream());
  assert.equal(refusal.stop, "refusal");
  assert.equal(refusal.refusal, "I can't help with deleting production data.");
  const text = await parseFixture(fixtureText("openai/text.sse"), 3, createResponsesStream());
  assert.equal(text.stop, "end");
  assert.equal(text.text, "Billing is degraded: its tasks run out of memory [E2].");
});

test("request: store:false, encrypted reasoning, function tools, history with outputs and native items sent back unchanged", async () => {
  const first = await parseFixture(fixtureText("openai/function-call.sse"), 64, createResponsesStream());
  const history: ModelMessage[] = [
    { role: "user", content: [{ type: "text", text: "Is production healthy?" }] },
    first.message,
    { role: "user", content: [{ type: "tool_result", callId: "call_Acme1", untrusted: true, content: '{"summary":{"UP":9}}', evidenceId: "E1" }] },
  ];
  const caps = capabilitiesFor("openai", "gpt-5");
  const body = buildResponsesRequest({ system: "Rules.", messages: history, tools: TOOLS, toolChoice: "auto", maxOutputTokens: 2000, temperature: 0.3 }, "gpt-5", { parallelToolCalls: true, maxOutputTokens: 2000 }, caps);
  assert.equal(body.store, false);
  assert.equal(body.stream, true);
  assert.equal(body.instructions, "Rules.");
  assert.deepEqual(body.include, ["reasoning.encrypted_content"]);
  assert.equal(body.temperature, undefined, "reasoning models take no temperature");
  assert.equal(body.max_output_tokens, 2000);
  assert.deepEqual(body.tools, [{ type: "function", name: "envs_status", description: "Environment status", parameters: TOOLS[0].inputSchema, strict: false }]);
  assert.deepEqual(body.input, [
    { type: "message", role: "user", content: [{ type: "input_text", text: "Is production healthy?" }] },
    { id: "rs_0acme", type: "reasoning", summary: [], encrypted_content: "gAAAAABo-encrypted-reasoning-blob==" },
    { type: "function_call", call_id: "call_Acme1", name: "envs_status", arguments: '{"env":"production"}' },
    { type: "function_call_output", call_id: "call_Acme1", output: '{"summary":{"UP":9}}' },
  ]);
  assert.equal(buildResponsesRequest({ messages: history }, "gpt-5", { parallelToolCalls: true, maxOutputTokens: 10 }, caps, { omitMaxOutputTokens: true }).max_output_tokens, undefined);
  assert.deepEqual(buildResponsesRequest({ messages: [], tools: TOOLS, toolChoice: { name: "envs_status" } }, "gpt-4o", { parallelToolCalls: false }, capabilitiesFor("openai", "gpt-4o")).tool_choice, { type: "function", name: "envs_status" });
  // Other providers' native blocks are dropped.
  assert.deepEqual(responsesInput([{ role: "assistant", content: [{ type: "native", provider: "anthropic", kind: "thinking", data: { type: "thinking" } }, { type: "text", text: "ok" }] }]), [
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "ok", annotations: [] }] },
  ]);
});

test("model list → ids with map capabilities", () => {
  const models = parseOpenAiModels(fixtureJson("openai/models.json"), (id) => capabilitiesFor("openai", id));
  assert.deepEqual(models.map((m) => [m.id, m.capabilities.tools]), [["gpt-4.1-mini", true], ["gpt-5", true], ["text-embedding-3-small", false]]);
});
