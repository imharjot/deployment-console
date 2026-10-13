import { test } from "node:test";
import assert from "node:assert/strict";
import { anthropicMessages, anthropicModelMatches, buildAnthropicRequest, createAnthropicStream, parseAnthropicModels } from "./anthropic-wire.ts";
import { checkRequest } from "./capabilities.ts";
import { capabilitiesFor } from "./capabilities.ts";
import { CHUNK_SIZES, fixtureJson, fixtureText, parseFixture } from "./fixtures/load.ts";
import type { GenerateRequest, ModelMessage, StreamEvent, ToolSpec } from "./types.ts";

const TOOLS: ToolSpec[] = [
  { name: "services_get", description: "Service details", inputSchema: { type: "object", required: ["env", "service"], properties: { env: { type: "string" }, service: { type: "string" } } }, op: "services.get" },
  { name: "services_events", description: "Service events", inputSchema: { type: "object", properties: { env: { type: "string" } } }, op: "services.events" },
];
const kindOf = (e: unknown) => (e as { kind?: string }).kind;

test("tool use: arguments split mid-JSON (and the stream split at every byte) parse into executable calls", async () => {
  for (const size of CHUNK_SIZES) {
    const events: StreamEvent[] = [];
    const r = await parseFixture(fixtureText("anthropic/tool-use.sse"), size, createAnthropicStream({ onEvent: (e) => events.push(e) }));
    assert.equal(r.stop, "tool_calls", `size ${size}`);
    assert.deepEqual(r.toolCalls.map((c) => [c.id, c.name, c.input]), [
      ["toolu_01A", "services_get", { env: "production", service: "billing" }],
      ["toolu_01B", "services_events", { env: "production", service: "billing", limit: 10 }],
    ]);
    assert.equal(r.text, "Let me check the service and its events.");
    assert.equal(r.model, "claude-sonnet-4-5-20250929");
    assert.equal(r.requestId, "msg_01AcmeDemo");
    assert.deepEqual(r.usage, { inputTokens: 1520, outputTokens: 187, cacheReadTokens: 1024, cacheWriteTokens: 0 });
    assert.equal(r.providerStop, "tool_use");
    assert.ok(events.some((e) => e.type === "text") && events.filter((e) => e.type === "tool_call").length === 2 && events.some((e) => e.type === "thinking"));
  }
});

test("thinking keeps its signature and goes back to Anthropic unchanged (and nowhere else)", async () => {
  const r = await parseFixture(fixtureText("anthropic/tool-use.sse"), 5, createAnthropicStream());
  const native = r.message.content[0];
  assert.deepEqual(native, {
    type: "native",
    provider: "anthropic",
    kind: "thinking",
    data: { type: "thinking", thinking: "Billing is degraded in production; read its details and events first.", signature: "EqQBCgIYAhIM1gbcDa9GJwZA2b3hGgxBdjrkzLoky3dl1pkiMOYds=" },
  });
  const next: ModelMessage[] = [
    { role: "user", content: [{ type: "text", text: "Why is billing degraded?" }] },
    r.message,
    { role: "user", content: [
      { type: "tool_result", callId: "toolu_01A", untrusted: true, content: '{"state":"DEGRADED"}', evidenceId: "E1" },
      { type: "tool_result", callId: "toolu_01B", untrusted: true, content: "boom", isError: true },
    ] },
  ];
  const body = buildAnthropicRequest({ messages: next, tools: TOOLS }, "claude-sonnet-4-5-20250929", { parallelToolCalls: true, maxOutputTokens: 4096 });
  const msgs = body.messages as { role: string; content: Record<string, unknown>[] }[];
  assert.deepEqual(msgs[1].content[0], native.type === "native" ? native.data : null, "the thinking block is sent back byte for byte");
  assert.deepEqual(msgs[1].content.map((b) => b.type), ["thinking", "text", "tool_use", "tool_use"]);
  assert.deepEqual(msgs[2].content, [
    { type: "tool_result", tool_use_id: "toolu_01A", content: '{"state":"DEGRADED"}' },
    { type: "tool_result", tool_use_id: "toolu_01B", content: "boom", is_error: true },
  ]);
  // Another provider's native data never reaches Anthropic.
  const foreign = anthropicMessages([{ role: "assistant", content: [{ type: "native", provider: "openai", kind: "reasoning", data: { type: "reasoning", encrypted_content: "x" } }, { type: "text", text: "ok" }] }]);
  assert.deepEqual(foreign, [{ role: "assistant", content: [{ type: "text", text: "ok" }] }]);
});

test("request translation: schemas, tool choice, parallel calls, thinking, merged turns with tool results first", () => {
  const req: GenerateRequest = {
    system: "You are the console's investigator.",
    messages: [
      { role: "user", content: [{ type: "text", text: "a" }] },
      { role: "user", content: [{ type: "text", text: "" }, { type: "tool_result", callId: "t1", untrusted: true, content: "r" }] },
    ],
    tools: TOOLS,
    toolChoice: "required",
    temperature: 0.2,
  };
  const body = buildAnthropicRequest(req, "claude-sonnet-4-5", { parallelToolCalls: false, maxOutputTokens: 1000 });
  assert.equal(body.stream, true);
  assert.equal(body.max_tokens, 1000);
  assert.equal(body.system, "You are the console's investigator.");
  assert.deepEqual(body.tool_choice, { type: "any", disable_parallel_tool_use: true });
  assert.deepEqual((body.tools as unknown[])[0], { name: "services_get", description: "Service details", input_schema: TOOLS[0].inputSchema });
  assert.deepEqual(body.messages, [{ role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "r" }, { type: "text", text: "a" }] }]);
  assert.equal(body.temperature, 0.2);
  assert.deepEqual(buildAnthropicRequest({ ...req, toolChoice: { name: "services_get" } }, "m", { parallelToolCalls: true }).tool_choice, { type: "tool", name: "services_get" });
  assert.deepEqual(buildAnthropicRequest({ ...req, toolChoice: "none" }, "m", { parallelToolCalls: true }).tool_choice, { type: "none" });
  const thinking = buildAnthropicRequest({ ...req, toolChoice: "auto", thinking: { budgetTokens: 2048 } }, "m", { parallelToolCalls: true, maxOutputTokens: 8000 });
  assert.deepEqual(thinking.thinking, { type: "enabled", budget_tokens: 2048 });
  assert.equal(thinking.temperature, undefined, "temperature can't be set with thinking");
  assert.throws(() => buildAnthropicRequest({ ...req, thinking: { budgetTokens: 9000 } }, "m", { parallelToolCalls: true, maxOutputTokens: 8000 }), (e) => kindOf(e) === "invalid_request");
  assert.equal(buildAnthropicRequest({ messages: [] }, "m", { parallelToolCalls: true }).tools, undefined);
});

test("an error event after the stream started, or no message_stop, is an incomplete stream", async () => {
  await assert.rejects(parseFixture(fixtureText("anthropic/error-after-start.sse"), 9, createAnthropicStream()), (e) => kindOf(e) === "incomplete_stream" && /overloaded_error/.test((e as Error).message));
  await assert.rejects(parseFixture(fixtureText("anthropic/no-message-stop.sse"), 4, createAnthropicStream()), (e) => kindOf(e) === "incomplete_stream");
  await assert.rejects(parseFixture("", 4, createAnthropicStream()), (e) => kindOf(e) === "incomplete_stream");
  // An error before the message started is the request's own error.
  await assert.rejects(parseFixture('event: error\ndata: {"type":"error","error":{"type":"rate_limit_error","message":"slow"}}\n\n', 4, createAnthropicStream()), (e) => kindOf(e) === "rate_limited");
});

test("refusal and max_tokens: never executable; a tool call cut mid-arguments is dropped", async () => {
  const refusal = await parseFixture(fixtureText("anthropic/refusal.sse"), 6, createAnthropicStream());
  assert.equal(refusal.stop, "refusal");
  assert.equal(refusal.refusal, "I can't help with that.");
  assert.deepEqual(refusal.toolCalls, []);
  const cut = await parseFixture(fixtureText("anthropic/max-tokens.sse"), 6, createAnthropicStream());
  assert.equal(cut.stop, "max_tokens");
  assert.deepEqual(cut.toolCalls, []);
  assert.deepEqual(cut.message.content.map((b) => b.type), ["text"]);
  const answer = await parseFixture(fixtureText("anthropic/answer.sse"), 2, createAnthropicStream());
  assert.equal(answer.stop, "end");
  assert.equal(answer.text, "Billing is degraded: tasks run out of memory [E2].");
});

test("model list: ids, names and capabilities; a changed list drops a model", () => {
  const caps = (id: string, reported?: Parameters<typeof capabilitiesFor>[2]) => capabilitiesFor("anthropic", id, reported);
  const models = parseAnthropicModels(fixtureJson("anthropic/models.json"), caps);
  assert.deepEqual(models.map((m) => [m.id, m.label, m.capabilities.family]), [
    ["claude-sonnet-4-5-20250929", "Claude Sonnet 4.5", "claude-4"],
    ["claude-haiku-4-5-20251001", "Claude Haiku 4.5", "claude-4"],
    ["claude-3-5-haiku-20241022", "Claude Haiku 3.5", "claude-3.5"],
  ]);
  assert.ok(!parseAnthropicModels(fixtureJson("anthropic/models-changed.json"), caps).some((m) => m.id === "claude-sonnet-4-5-20250929"));
  assert.equal(parseAnthropicModels({ data: [{ id: "claude-x", max_tokens: 1234 }] }, caps)[0].capabilities.maxOutputTokens, 1234);
  assert.deepEqual(parseAnthropicModels({ nope: 1 }, caps), []);
});

test("newer Claude models: adaptive thinking (a budget is refused there), no temperature, no forced call while thinking", () => {
  const req: GenerateRequest = { messages: [{ role: "user", content: [{ type: "text", text: "a" }] }], tools: TOOLS, temperature: 0.2 };
  const latest = (r: GenerateRequest, model: string) => buildAnthropicRequest(r, model, checkRequest(r, capabilitiesFor("anthropic", model), "Anthropic", model));
  const opus = latest({ ...req, thinking: { budgetTokens: 4096 } }, "claude-opus-5-5");
  assert.deepEqual(opus.thinking, { type: "adaptive" });
  assert.equal(opus.max_tokens, 128_000);
  assert.equal(latest(req, "claude-opus-5-5").temperature, undefined, "Opus 5.5 refuses temperature: dropped");
  assert.equal(latest(req, "claude-sonnet-4-6").temperature, 0.2);
  assert.deepEqual(latest({ ...req, thinking: { budgetTokens: 2048 } }, "claude-sonnet-4-6").thinking, { type: "adaptive" });
  assert.deepEqual(latest({ ...req, thinking: { budgetTokens: 2048 } }, "claude-sonnet-4-5").thinking, { type: "enabled", budget_tokens: 2048 });
  assert.throws(() => latest({ ...req, thinking: { budgetTokens: 512 } }, "claude-sonnet-4-5"), (e) => kindOf(e) === "invalid_request", "a budget is at least 1024");
  assert.throws(() => latest({ ...req, toolChoice: "required", thinking: { budgetTokens: 2048 } }, "claude-sonnet-4-5"), (e) => kindOf(e) === "unsupported");
  assert.throws(() => latest({ ...req, toolChoice: "required" }, "claude-fable-5-1"), (e) => kindOf(e) === "unsupported");
});

test("a refusal without text carries the API's stop_details", async () => {
  const sse = [
    { type: "message_start", message: { id: "msg_1", model: "claude-opus-5-5", usage: { input_tokens: 10, output_tokens: 1 } } },
    { type: "message_delta", delta: { stop_reason: "refusal", stop_details: { type: "refusal", category: "cyber", explanation: "declined by a safety classifier" } }, usage: { output_tokens: 1 } },
    { type: "message_stop" },
  ]
    .map((d) => `event: ${d.type}\ndata: ${JSON.stringify(d)}\n\n`)
    .join("");
  const r = await parseFixture(sse, 5, createAnthropicStream());
  assert.equal(r.stop, "refusal");
  assert.equal(r.refusal, "cyber: declined by a safety classifier");
  assert.deepEqual(r.toolCalls, []);
});

test("a model alias is offered while the list has a dated id of it", () => {
  assert.ok(anthropicModelMatches("claude-sonnet-4-5-20250929", "claude-sonnet-4-5"));
  assert.ok(anthropicModelMatches("claude-3-5-haiku-20241022", "claude-3-5-haiku-latest"));
  assert.ok(anthropicModelMatches("claude-opus-5-5", "claude-opus-5-5"));
  assert.ok(!anthropicModelMatches("claude-sonnet-4-5-20250929", "claude-sonnet-4"), "4 is not 4.5");
  assert.ok(!anthropicModelMatches("claude-opus-5-5", "claude-opus-5"));
});
