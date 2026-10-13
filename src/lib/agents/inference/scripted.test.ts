import { test } from "node:test";
import assert from "node:assert/strict";
import { createScriptedAdapter, nextTurn, readConversation, registerScript, resultData, scriptFor, unregisterScript, withFailure, type Script } from "./scripted.ts";
import { incidentDemo } from "./scripts/incident-demo.ts";
import type { GenerateRequest, GenerateResult, ModelMessage, ResolvedConnection, StreamEvent, ToolSpec } from "./types.ts";

const spec = (op: string): ToolSpec => ({ name: op.replace(/\./g, "_"), description: op, inputSchema: { type: "object" }, op });
const TOOLS = ["envs.list", "envs.status", "services.get"].map(spec);
const conn = (model: string, id = "scripted:test"): ResolvedConnection => ({ id, provider: "scripted", authKind: "none", label: "Scripted", model, egress: "local", secret: async () => ({ kind: "none" }) });
const kindOf = (e: unknown) => (e as { kind?: string }).kind;

// A declarative script: read the status; if a result mentions DEGRADED, look closer, else say all is well.
const TRIAGE: Script = {
  name: "test-triage",
  description: "Test triage: status then details",
  turns: [
    { id: "status", text: "Checking.", toolCalls: [{ op: "envs.status", input: { env: "staging" } }], next: [{ when: { resultFrom: "envs.status", resultContains: "degraded" }, goto: "details" }, { when: { isError: true }, goto: "failed" }] },
    { id: "fine", text: "Everything is fine." },
    { id: "details", text: "Looking closer.", toolCalls: [{ op: "services.get", input: { env: "staging", service: "api" } }, { op: "services.delete", input: { env: "staging", service: "api" } }] },
    { id: "done", text: "Done: api is degraded." },
    { id: "failed", text: "I couldn't read the status." },
  ],
};
registerScript(TRIAGE);

// The conversation so far plus the console's answers to the last turn's calls.
function answer(history: ModelMessage[], r: GenerateResult, results: Record<string, { content: string; isError?: boolean; evidenceId?: string }>): ModelMessage[] {
  return [...history, r.message, { role: "user", content: r.toolCalls.map((c) => ({ type: "tool_result" as const, callId: c.id, untrusted: true as const, ...results[c.name] })) }];
}

test("declarative turns: rule-based branching on tool results, remembered through a native marker", async () => {
  const a = createScriptedAdapter({ attempts: new Map() });
  const start: ModelMessage[] = [{ role: "user", content: [{ type: "text", text: "Is staging OK?" }] }];
  const t1 = await a.generate(conn("test-triage"), { messages: start, tools: TOOLS });
  assert.equal(t1.stop, "tool_calls");
  assert.deepEqual(t1.toolCalls.map((c) => [c.id, c.name, c.input]), [["sc_1_1", "envs_status", { env: "staging" }]]);
  assert.deepEqual(t1.message.content.at(-1), { type: "native", provider: "scripted", kind: "scripted-turn", data: { script: "test-triage", turn: "status" } });

  const degraded = answer(start, t1, { envs_status: { content: '{"resources":[{"id":"api","state":"DEGRADED"}]}' } });
  const t2 = await a.generate(conn("test-triage"), { messages: degraded, tools: TOOLS });
  assert.equal(t2.text, "Looking closer.");
  // services.delete isn't offered to this run, so a well-behaved script leaves it out.
  assert.deepEqual(t2.toolCalls.map((c) => c.name), ["services_get"]);
  const t3 = await a.generate(conn("test-triage"), { messages: answer(degraded, t2, { services_get: { content: "{}" } }), tools: TOOLS });
  assert.deepEqual([t3.stop, t3.text], ["end", "Done: api is degraded."]);

  const fine = await a.generate(conn("test-triage"), { messages: answer(start, t1, { envs_status: { content: '{"resources":[]}' } }), tools: TOOLS });
  assert.equal(fine.text, "Everything is fine.");
  const failed = await a.generate(conn("test-triage"), { messages: answer(start, t1, { envs_status: { content: "denied", isError: true } }), tools: TOOLS });
  assert.equal(failed.text, "I couldn't read the status.");

  // Deterministic: the same conversation gets the same turn, ids and usage.
  assert.deepEqual(await a.generate(conn("test-triage"), { messages: degraded, tools: TOOLS }), t2);
});

test("a forced call reaches the console even when the run doesn't offer the tool (an obeyed injection, for the policy tests)", async () => {
  registerScript({ name: "test-obey", description: "Obeys", turns: [{ id: "x", toolCalls: [{ op: "services.delete", input: { env: "production", service: "billing" }, force: true }] }] });
  const r = await createScriptedAdapter({ attempts: new Map() }).generate(conn("test-obey"), { messages: [{ role: "user", content: [{ type: "text", text: "go" }] }], tools: TOOLS });
  assert.deepEqual(r.toolCalls.map((c) => [c.name, c.input]), [["services_delete", { env: "production", service: "billing" }]]);
  unregisterScript("test-obey");
});

test("injected failures: quota, auth, rate limits, outages, a broken stream, cancel and hang — optionally only the first N attempts", async () => {
  const a = createScriptedAdapter({ attempts: new Map() });
  const req: GenerateRequest = { messages: [{ role: "user", content: [{ type: "text", text: "Is staging OK?" }] }], tools: TOOLS };
  for (const kind of ["quota", "auth", "rate_limited", "unavailable", "incomplete_stream", "cancelled"] as const) {
    registerScript(withFailure(TRIAGE, { kind }));
    await assert.rejects(a.generate(conn(`test-triage+${kind}`), req), (e) => kindOf(e) === kind, kind);
  }
  registerScript(withFailure(TRIAGE, { kind: "quota", resetAt: 1_800_000_000_000 }, "test-quota-reset"));
  await assert.rejects(a.generate(conn("test-quota-reset"), req), (e) => (e as { resetAt?: number }).resetAt === 1_800_000_000_000);

  // Fails twice, then the retry of the same turn succeeds; a different connection counts on its own.
  registerScript(withFailure(TRIAGE, { kind: "rate_limited", retryAfterMs: 1000, times: 2 }, "test-flaky"));
  await assert.rejects(a.generate(conn("test-flaky"), req), (e) => kindOf(e) === "rate_limited" && (e as { retryAfterMs?: number }).retryAfterMs === 1000);
  await assert.rejects(a.generate(conn("test-flaky"), req), (e) => kindOf(e) === "rate_limited");
  assert.equal((await a.generate(conn("test-flaky"), req)).stop, "tool_calls");
  await assert.rejects(a.generate(conn("test-flaky", "other-conn"), req), (e) => kindOf(e) === "rate_limited");

  // A failure at one turn only.
  registerScript(withFailure(TRIAGE, { kind: "incomplete_stream", partialText: "Check", atTurn: 1 }, "test-late"));
  const t1 = await a.generate(conn("test-late"), req);
  const events: StreamEvent[] = [];
  await assert.rejects(a.generate(conn("test-late"), { ...req, messages: answer(req.messages, t1, { envs_status: { content: "degraded" } }), onEvent: (e) => events.push(e) }), (e) => kindOf(e) === "incomplete_stream");
  assert.deepEqual(events, [{ type: "text", text: "Check" }], "a broken stream may have shown partial text");

  registerScript(withFailure(TRIAGE, { kind: "hang" }, "test-hang"));
  const ac = new AbortController();
  const p = a.generate(conn("test-hang"), { ...req, signal: ac.signal });
  setTimeout(() => ac.abort(), 10);
  await assert.rejects(p, (e) => kindOf(e) === "cancelled");
  await assert.rejects(a.generate(conn("test-hang"), req), (e) => kindOf(e) === "invalid_request", "a hang without a signal would never end");
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(a.generate(conn("test-triage"), { ...req, signal: aborted.signal }), (e) => kindOf(e) === "cancelled");
});

test("refusal, max_tokens (the simulated hard limit) and serial tool calls", async () => {
  registerScript({ name: "test-refuse", description: "Refuses", turns: [{ id: "r", text: "I won't do that.", stop: "refusal", toolCalls: [{ op: "envs.list", input: {} }] }] });
  const a = createScriptedAdapter({ attempts: new Map() });
  const req: GenerateRequest = { messages: [{ role: "user", content: [{ type: "text", text: "Delete it." }] }], tools: TOOLS };
  const refused = await a.generate(conn("test-refuse"), req);
  assert.deepEqual([refused.stop, refused.refusal, refused.toolCalls], ["refusal", "I won't do that.", []]);
  const capped = await a.generate(conn("test-triage"), { ...req, maxOutputTokens: 2 });
  assert.deepEqual([capped.stop, capped.toolCalls.length], ["max_tokens", 0]);
  registerScript({ name: "test-two", description: "Two calls", turns: [{ id: "t", toolCalls: [{ op: "envs.list", input: {} }, { op: "envs.status", input: { env: "staging" } }] }] });
  assert.equal((await a.generate(conn("test-two"), req)).toolCalls.length, 2);
  assert.equal((await a.generate(conn("test-two"), { ...req, parallelToolCalls: false })).toolCalls.length, 1);
  assert.ok(capped.usage.inputTokens! > 0);
});

test("models are the registered scripts; an unregistered script is a changed model list, never a silent swap", async () => {
  const a = createScriptedAdapter({ attempts: new Map(), scripts: [incidentDemo] });
  assert.ok((await a.models(conn("x"))).some((m) => m.id === "incident-demo" && m.label === "Demo model (scripted)"));
  registerScript({ name: "test-gone", description: "Soon gone", turns: [{ id: "a", text: "hi" }] });
  assert.equal((await a.validate(conn("test-gone"))).ok, true);
  unregisterScript("test-gone");
  const v = await a.validate(conn("test-gone"));
  assert.deepEqual([v.ok, v.error?.kind], [false, "unsupported"]);
  await assert.rejects(a.generate(conn("test-gone"), { messages: [] }), (e) => kindOf(e) === "unsupported");
  assert.equal(scriptFor("incident-demo")?.name, "incident-demo");
  // A connection without a model uses the default script, when one is configured.
  const d = createScriptedAdapter({ attempts: new Map(), defaultScript: "incident-demo" });
  assert.equal((await d.validate({ ...conn(""), model: undefined })).model, "incident-demo");
  assert.throws(() => registerScript({ name: "bad", description: "" }), /turns or next/);
});

test("reading results: untrusted envelopes and REST bodies unwrapped, evidence ids found", () => {
  assert.deepEqual(resultData('{"untrusted":true,"source":"services.get","observedAt":1,"id":"E4","data":{"state":"UP"}}'), { data: { state: "UP" }, evidenceId: "E4" });
  assert.deepEqual(resultData('{"result":[1,2]}'), { data: [1, 2] });
  assert.deepEqual(resultData("[E7] plain text"), { data: "[E7] plain text", evidenceId: "E7" });
  const conv = readConversation({
    tools: TOOLS,
    messages: [
      { role: "user", content: [{ type: "text", text: "goal" }] },
      { role: "assistant", content: [{ type: "tool_call", id: "c1", name: "envs_list", input: {} }] },
      { role: "user", content: [{ type: "tool_result", callId: "c1", untrusted: true, content: "[]", evidenceId: "E1" }] },
    ],
  });
  assert.deepEqual([conv.goal, conv.turn, conv.results[0].op, conv.results[0].evidenceId, conv.last.length], ["goal", 1, "envs.list", "E1", 1]);
  assert.equal(nextTurn(TRIAGE, { messages: [] })?.id, "status");
});
