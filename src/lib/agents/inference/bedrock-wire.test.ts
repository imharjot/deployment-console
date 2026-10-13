import { test } from "node:test";
import assert from "node:assert/strict";
import { bedrockError, buildConverseInput, converseMessages, createConverseStream, parseBedrockModels } from "./bedrock-wire.ts";
import { capabilitiesFor, checkRequest } from "./capabilities.ts";
import { fixtureJson } from "./fixtures/load.ts";
import type { GenerateRequest, ModelMessage, StreamEvent, ToolSpec } from "./types.ts";

const TOOLS: ToolSpec[] = [{ name: "envs_status", description: "Environment status", inputSchema: { type: "object", properties: { env: { type: "string" } } } }];
const kindOf = (e: unknown) => (e as { kind?: string }).kind;
const run = (events: unknown[], model = "us.anthropic.claude-sonnet-4-5-20250929-v1:0") => {
  const s = createConverseStream({ model });
  for (const e of events) s.push(e);
  return s.finish("req-bedrock");
};

test("ConverseStream: toolUse input in fragments, reasoning kept as native content, usage", () => {
  const events: StreamEvent[] = [];
  const s = createConverseStream({ model: "us.anthropic.claude-sonnet-4-5-20250929-v1:0", onEvent: (e) => events.push(e) });
  for (const e of fixtureJson<unknown[]>("bedrock/tool-use.json")) s.push(e);
  const r = s.finish("req-1");
  assert.equal(r.stop, "tool_calls");
  assert.deepEqual(r.toolCalls.map((c) => [c.id, c.name, c.input]), [["tooluse_Acme1", "envs_status", { env: "staging" }]]);
  assert.equal(r.text, "Checking staging.");
  assert.deepEqual(r.message.content[0], { type: "native", provider: "bedrock", kind: "reasoningContent", data: { reasoningContent: { reasoningText: { text: "Staging first; then the service.", signature: "ErcBCkgIBRABGAIiQNacme" } } } });
  assert.deepEqual(r.usage, { inputTokens: 812, outputTokens: 64, cacheReadTokens: 512 });
  assert.equal(r.requestId, "req-1");
  assert.ok(events.some((e) => e.type === "tool_call") && events.some((e) => e.type === "thinking"));
});

test("an exception member after the stream started, or no messageStop, is an incomplete stream", () => {
  assert.throws(() => run(fixtureJson<unknown[]>("bedrock/exception-after-start.json")), (e) => kindOf(e) === "incomplete_stream" && /ModelStreamErrorException/.test((e as Error).message));
  assert.throws(() => run([{ messageStart: { role: "assistant" } }, { contentBlockDelta: { contentBlockIndex: 0, delta: { text: "x" } } }]), (e) => kindOf(e) === "incomplete_stream");
  assert.throws(() => run([{ throttlingException: { message: "Too many requests" } }]), (e) => kindOf(e) === "rate_limited");
});

test("guardrails are refusals; a tool call cut by max_tokens is dropped", () => {
  const g = run(fixtureJson<unknown[]>("bedrock/guardrail.json"));
  assert.equal(g.stop, "refusal");
  assert.equal(g.refusal, "Sorry, I can't help with that.");
  const cut = run([{ messageStart: { role: "assistant" } }, { contentBlockStart: { contentBlockIndex: 0, start: { toolUse: { toolUseId: "t", name: "services_restart" } } } }, { contentBlockDelta: { contentBlockIndex: 0, delta: { toolUse: { input: '{"env":' } } } }, { messageStop: { stopReason: "max_tokens" } }]);
  assert.equal(cut.stop, "max_tokens");
  assert.deepEqual(cut.toolCalls, []);
  assert.deepEqual(cut.message.content, []);
});

test("SDK errors map to kinds: throttling, quotas, credentials, model access, validation", () => {
  const err = (name: string, message = "", status?: number) => bedrockError(Object.assign(new Error(message), { name, $metadata: { httpStatusCode: status, requestId: "r1" } }));
  assert.equal(err("ThrottlingException", "Too many tokens", 429).kind, "rate_limited");
  assert.equal(err("ServiceQuotaExceededException", "quota", 400).kind, "quota");
  assert.equal(err("UnrecognizedClientException", "The security token included in the request is invalid.", 403).kind, "auth");
  assert.equal(err("ExpiredTokenException", "expired", 400).kind, "auth");
  assert.equal(err("AccessDeniedException", "You don't have access to the model with the specified model ID.", 403).kind, "unsupported");
  assert.equal(err("AccessDeniedException", "User is not authorized to perform bedrock:InvokeModelWithResponseStream", 403).kind, "auth");
  assert.equal(err("ValidationException", "This model doesn't support tool use in streaming mode.", 400).kind, "unsupported");
  assert.equal(err("ValidationException", "messages: first turn must be user", 400).kind, "invalid_request");
  assert.equal(err("ResourceNotFoundException", "Model not found", 404).kind, "unsupported");
  assert.equal(err("ModelNotReadyException", "", 429).kind, "unavailable");
  assert.equal(err("Weird", "", 503).kind, "unavailable");
  assert.equal(err("ThrottlingException").requestId, "r1");
});

test("input: system, inference config, toolConfig kept for history even with choice none, thinking for Claude", () => {
  const messages = [
    { role: "user" as const, content: [{ type: "text" as const, text: "go" }] },
    { role: "assistant" as const, content: [{ type: "tool_call" as const, id: "t1", name: "envs_status", input: { env: "x" } }, { type: "native" as const, provider: "openai" as const, kind: "reasoning", data: {} }] },
    { role: "user" as const, content: [{ type: "tool_result" as const, callId: "t1", untrusted: true as const, content: "", isError: true }, { type: "text" as const, text: "more" }] },
  ];
  const input = buildConverseInput({ system: "Rules.", messages, tools: TOOLS, toolChoice: "none", maxOutputTokens: 900, thinking: { budgetTokens: 1024 } }, "anthropic.claude-sonnet-4-5-20250929-v1:0", { maxOutputTokens: 900 }, capabilitiesFor("bedrock", "anthropic.claude-sonnet-4-5-20250929-v1:0"));
  assert.deepEqual(input.system, [{ text: "Rules." }]);
  assert.deepEqual(input.inferenceConfig, { maxTokens: 900 });
  assert.deepEqual(input.toolConfig, { tools: [{ toolSpec: { name: "envs_status", description: "Environment status", inputSchema: { json: TOOLS[0].inputSchema } } }] });
  assert.deepEqual(input.additionalModelRequestFields, { thinking: { type: "enabled", budget_tokens: 1024 } });
  assert.deepEqual(input.messages, [
    { role: "user", content: [{ text: "go" }] },
    { role: "assistant", content: [{ toolUse: { toolUseId: "t1", name: "envs_status", input: { env: "x" } } }] },
    { role: "user", content: [{ toolResult: { toolUseId: "t1", content: [{ text: "(empty)" }], status: "error" } }, { text: "more" }] },
  ]);
  const required = buildConverseInput({ messages: [messages[0]], tools: TOOLS, toolChoice: "required" }, "amazon.nova-pro-v1:0", {}, capabilitiesFor("bedrock", "amazon.nova-pro-v1:0"));
  assert.deepEqual((required.toolConfig as { toolChoice: unknown }).toolChoice, { any: {} });
  assert.equal(buildConverseInput({ messages: [messages[0]], tools: TOOLS, toolChoice: "none" }, "amazon.nova-pro-v1:0", {}, capabilitiesFor("bedrock", "amazon.nova-pro-v1:0")).toolConfig, undefined);
  assert.deepEqual(converseMessages([{ role: "assistant", content: [{ type: "native", provider: "bedrock", kind: "reasoningContent", data: { reasoningContent: { reasoningText: { text: "t", signature: "s" } } } }] }]), [
    { role: "assistant", content: [{ reasoningContent: { reasoningText: { text: "t", signature: "s" } } }] },
  ]);
});

test("models: on-demand text models and inference profiles (cross-region flagged); embeddings and profile-only ids left out", () => {
  const m = fixtureJson<{ foundation: unknown[]; profiles: unknown[] }>("bedrock/models.json");
  const models = parseBedrockModels(m.foundation, m.profiles, (id, r) => capabilitiesFor("bedrock", id, r));
  assert.deepEqual(models.map((x) => [x.id, !!x.crossRegion, !!x.deprecated, x.capabilities.tools]), [
    ["amazon.nova-pro-v1:0", false, false, true],
    ["amazon.titan-text-express-v1", false, true, false],
    ["global.anthropic.claude-sonnet-4-5-20250929-v1:0", true, false, true],
    ["us.anthropic.claude-sonnet-4-5-20250929-v1:0", true, false, true],
  ]);
});

test("a real region's listing (ap-south-1): profile-only models via their profiles, the India geography, cross-region from the routed regions", () => {
  const m = fixtureJson<{ foundation: unknown[]; profiles: unknown[] }>("bedrock/ap-south-1.json");
  const models = parseBedrockModels(m.foundation, m.profiles, (id, r) => capabilitiesFor("bedrock", id, r));
  const by = new Map(models.map((x) => [x.id, x]));
  // Claude Sonnet 5 is offered here only through an inference profile; the provisioned-throughput variant isn't callable.
  assert.ok(!by.has("anthropic.claude-sonnet-5") && !by.has("anthropic.claude-3-haiku-20240307-v1:0:48k"));
  assert.ok(by.has("qwen.qwen3-32b-v1:0") && !by.get("qwen.qwen3-32b-v1:0")!.crossRegion);
  const india = by.get("in.anthropic.claude-sonnet-5")!;
  assert.deepEqual([india.crossRegion, india.capabilities.family, india.capabilities.thinkingMode, india.capabilities.sampling], [true, "claude-4.7", "adaptive", false]);
  assert.equal(by.get("global.anthropic.claude-fable-5")?.crossRegion, true);
  assert.equal(by.get("apac.amazon.nova-pro-v1:0")?.capabilities.family, "nova");
  assert.ok(!by.has("global.cohere.embed-v4:0"), "an embeddings profile is not a model to talk to");
  // An application profile over one regional model stays in the region.
  assert.equal(by.get("acmebilling1")?.crossRegion, undefined);
});

test("newer Claude models on Bedrock: adaptive thinking, temperature dropped; no forced call while thinking", () => {
  const messages: ModelMessage[] = [{ role: "user", content: [{ type: "text", text: "a" }] }];
  const build = (model: string, extra: Partial<GenerateRequest> = {}) => {
    const req: GenerateRequest = { messages, tools: TOOLS, temperature: 0.4, ...extra };
    const caps = capabilitiesFor("bedrock", model);
    return buildConverseInput(req, model, checkRequest(req, caps, "Bedrock", model), caps);
  };
  const sonnet5 = build("in.anthropic.claude-sonnet-5", { thinking: { budgetTokens: 2048 } });
  assert.deepEqual(sonnet5.additionalModelRequestFields, { thinking: { type: "adaptive" } });
  assert.equal((build("in.anthropic.claude-sonnet-5").inferenceConfig as { temperature?: number }).temperature, undefined);
  assert.equal((build("apac.anthropic.claude-sonnet-4-20250514-v1:0").inferenceConfig as { temperature?: number }).temperature, 0.4);
  assert.throws(() => build("apac.anthropic.claude-sonnet-4-20250514-v1:0", { toolChoice: "required", thinking: { budgetTokens: 2048 } }), (e) => (e as { kind?: string }).kind === "unsupported");
});
