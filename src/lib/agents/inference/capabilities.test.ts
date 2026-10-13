import { test } from "node:test";
import assert from "node:assert/strict";
import { bedrockBaseId, bedrockCrossRegion, CAPABILITY_MAP_VERSION, capabilitiesFor, checkRequest, conservativeCapabilities, modelListChange, modelOffered, ollamaCloudModel } from "./capabilities.ts";
import type { GenerateRequest, ToolSpec } from "./types.ts";

const TOOL: ToolSpec = { name: "envs_list", description: "List environments", inputSchema: { type: "object", properties: {} }, op: "envs.list" };
const req = (o: Partial<GenerateRequest> = {}): GenerateRequest => ({ messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }], ...o });

test("known families come from the versioned map; every entry carries the map version", () => {
  const sonnet = capabilitiesFor("anthropic", "claude-sonnet-4-5-20250929");
  assert.equal(sonnet.version, CAPABILITY_MAP_VERSION);
  assert.equal(sonnet.source, "map");
  assert.equal(sonnet.family, "claude-4");
  assert.ok(sonnet.tools && sonnet.parallelToolCalls && sonnet.hardOutputLimit && sonnet.reasoning);
  assert.equal(capabilitiesFor("anthropic", "claude-3-5-haiku-20241022").reasoning, false);
  assert.equal(capabilitiesFor("anthropic", "claude-2.1").tools, false);
  const gpt5 = capabilitiesFor("openai", "gpt-5");
  assert.ok(gpt5.reasoning && gpt5.strictSchemas && gpt5.hardOutputLimit);
  assert.equal(capabilitiesFor("openai", "text-embedding-3-small").tools, false);
  assert.equal(capabilitiesFor("chatgpt-plan", "gpt-5").hardOutputLimit, false, "the plan route rejects max_output_tokens");
  assert.equal(capabilitiesFor("bedrock", "us.anthropic.claude-sonnet-4-5-20250929-v1:0").family, "claude-4");
  assert.equal(capabilitiesFor("bedrock", "amazon.nova-pro-v1:0").family, "nova");
  assert.equal(capabilitiesFor("bedrock", "amazon.titan-text-express-v1").tools, false);
  assert.equal(capabilitiesFor("scripted", "incident-demo").cancellation, "abort");
});

test("Claude generations: how thinking is asked for, whether temperature and forced tool calls are accepted", () => {
  const row = (id: string, p: "anthropic" | "bedrock" = "anthropic") => {
    const c = capabilitiesFor(p, id);
    return [c.family, c.thinkingMode, c.sampling, c.forcedToolChoice];
  };
  for (const id of ["claude-sonnet-4-20250514", "claude-sonnet-4-5", "claude-opus-4-1-20250805", "claude-haiku-4-5", "claude-opus-4-5-20251101", "claude-opus-4"]) assert.deepEqual(row(id), ["claude-4", "budget", true, true], id);
  for (const id of ["claude-opus-4-6", "claude-sonnet-4-6"]) assert.deepEqual(row(id), ["claude-4.6", "adaptive", true, true], id);
  for (const id of ["claude-opus-4-7", "claude-opus-4-8", "claude-opus-5", "claude-sonnet-5", "claude-fable-5"]) assert.deepEqual(row(id), ["claude-4.7", "adaptive", false, true], id);
  for (const id of ["claude-opus-5-5", "claude-sonnet-5-5", "claude-fable-5-1", "claude-mythos-5-1", "claude-opus-6"]) assert.deepEqual(row(id), ["claude-5.5", "adaptive", false, false], id);
  // Bedrock ids as ListInferenceProfiles returns them in ap-south-1 (incl. the India geography "in.").
  assert.deepEqual(row("in.anthropic.claude-sonnet-5", "bedrock"), ["claude-4.7", "adaptive", false, true]);
  assert.deepEqual(row("global.anthropic.claude-opus-4-6-v1", "bedrock"), ["claude-4.6", "adaptive", true, true]);
  assert.deepEqual(row("apac.anthropic.claude-sonnet-4-20250514-v1:0", "bedrock"), ["claude-4", "budget", true, true]);
  assert.deepEqual(row("global.anthropic.claude-fable-5-1", "bedrock"), ["claude-5.5", "adaptive", false, false]);
  assert.equal(capabilitiesFor("anthropic", "claude-3-7-sonnet-20250219").thinkingMode, "budget");
  assert.equal(capabilitiesFor("openai", "gpt-6-sol").family, "gpt-5+");
});

test("unknown models — and every model behind a compatible endpoint — are conservative", () => {
  const unknown = capabilitiesFor("openai", "acme-internal-model");
  assert.equal(unknown.source, "conservative");
  assert.deepEqual({ ...unknown, version: "" }, { ...conservativeCapabilities(), version: "" });
  assert.ok(unknown.tools && !unknown.parallelToolCalls && !unknown.hardOutputLimit && !unknown.strictSchemas && unknown.cancellation === "best-effort");
  const qwen = capabilitiesFor("openai-compatible", "Qwen/Qwen2.5-72B-Instruct");
  assert.equal(qwen.family, "qwen");
  assert.ok(qwen.tools && !qwen.parallelToolCalls && !qwen.hardOutputLimit, "a compatible server only tells us the family calls tools");
  assert.equal(capabilitiesFor("ollama", "nomic-embed-text").tools, false);
  assert.equal(capabilitiesFor("ollama", "gpt-oss:120b-cloud").remote, true);
});

test("what the provider reports refines the map", () => {
  const c = capabilitiesFor("ollama", "qwen3:8b", { tools: false, contextTokens: 40_960 });
  assert.equal(c.source, "provider");
  assert.equal(c.tools, false);
  assert.equal(c.parallelToolCalls, false);
  assert.equal(c.contextTokens, 40_960);
  assert.equal(capabilitiesFor("anthropic", "claude-sonnet-4-5", { maxOutputTokens: 64_000 }).maxOutputTokens, 64_000);
});

test("a request needing a missing capability is refused before any call; preferences are narrowed", () => {
  const noTools = capabilitiesFor("ollama", "gemma2:2b", { tools: false });
  assert.throws(() => checkRequest(req({ tools: [TOOL] }), noTools, "Ollama", "gemma2:2b"), (e: Error & { kind?: string }) => e.kind === "unsupported");
  assert.throws(() => checkRequest(req({ thinking: { budgetTokens: 2048 } }), capabilitiesFor("openai", "gpt-4o"), "OpenAI", "gpt-4o"), (e: Error & { kind?: string }) => e.kind === "unsupported");
  assert.throws(() => checkRequest(req({ toolChoice: "required" }), capabilitiesFor("openai", "gpt-5"), "OpenAI", "gpt-5"), (e: Error & { kind?: string }) => e.kind === "invalid_request");
  assert.throws(() => checkRequest(req({ tools: [TOOL], toolChoice: { name: "services_delete" } }), capabilitiesFor("openai", "gpt-5"), "OpenAI", "gpt-5"), (e: Error & { kind?: string }) => e.kind === "invalid_request");
  assert.throws(() => checkRequest(req(), capabilitiesFor("bedrock", "x.y", { streaming: false }), "Bedrock", "x.y"), (e: Error & { kind?: string }) => e.kind === "unsupported");
  const conservative = checkRequest(req({ tools: [TOOL], maxOutputTokens: 100_000 }), capabilitiesFor("openai-compatible", "mystery"), "Model endpoint", "mystery");
  assert.deepEqual(conservative, { parallelToolCalls: false, maxOutputTokens: 2_048 });
  assert.deepEqual(checkRequest(req({ tools: [TOOL], parallelToolCalls: false }), capabilitiesFor("anthropic", "claude-sonnet-4-5"), "Anthropic", "claude-sonnet-4-5"), { parallelToolCalls: false, maxOutputTokens: 32_000, thinkingMode: "budget" });
  // Newer Claude models: no forced tool call (refused before sending), no temperature (dropped), adaptive thinking.
  const latest = capabilitiesFor("anthropic", "claude-opus-5-5");
  assert.throws(() => checkRequest(req({ tools: [TOOL], toolChoice: "required" }), latest, "Anthropic", "claude-opus-5-5"), (e: Error & { kind?: string; code?: string }) => e.kind === "unsupported" && e.code === "tool_choice");
  assert.throws(() => checkRequest(req({ tools: [TOOL], toolChoice: { name: "envs_list" } }), latest, "Anthropic", "claude-opus-5-5"), (e: Error & { kind?: string }) => e.kind === "unsupported");
  assert.deepEqual(checkRequest(req({ tools: [TOOL], temperature: 0.2 }), latest, "Anthropic", "claude-opus-5-5"), { parallelToolCalls: true, maxOutputTokens: 128_000, sampling: false, thinkingMode: "adaptive" });
});

test("a model that disappeared from the account's list is reported, never silently replaced", () => {
  const models = [{ id: "a", label: "a", capabilities: conservativeCapabilities() }];
  assert.equal(modelOffered(models, "a", "X"), undefined);
  const gone = modelOffered(models, "b", "X");
  assert.equal(gone?.kind, "unsupported");
  assert.match(gone!.message, /no longer offers model b/);
  assert.equal(modelOffered(models, undefined, "X")?.kind, "invalid_request");
  assert.deepEqual(modelListChange(["a", "b"], ["b", "c"]), { added: ["c"], removed: ["a"] });
});

test("Bedrock ids and Ollama cloud names", () => {
  assert.equal(bedrockBaseId("eu.anthropic.claude-sonnet-4-5-20250929-v1:0"), "anthropic.claude-sonnet-4-5-20250929-v1:0");
  assert.equal(bedrockBaseId("arn:aws:bedrock:us-east-1::foundation-model/amazon.nova-pro-v1:0"), "amazon.nova-pro-v1:0");
  assert.ok(bedrockCrossRegion("global.anthropic.claude-sonnet-4-5-20250929-v1:0"));
  assert.ok(bedrockCrossRegion("in.anthropic.claude-sonnet-5"));
  assert.equal(bedrockBaseId("in.openai.gpt-5.6-terra"), "openai.gpt-5.6-terra");
  assert.equal(bedrockBaseId("deepseek.v3.2"), "deepseek.v3.2");
  assert.ok(!bedrockCrossRegion("amazon.nova-pro-v1:0"));
  assert.ok(ollamaCloudModel("gemma4:cloud") && ollamaCloudModel("gpt-oss:120b-cloud") && ollamaCloudModel("qwen3-coder:480b-cloud") && ollamaCloudModel("deepseek-v3.1:671b-cloud"));
  assert.ok(!ollamaCloudModel("qwen3:8b") && !ollamaCloudModel("cloudy-llama:7b"));
});
