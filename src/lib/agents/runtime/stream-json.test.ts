// Contract tests for reading the runtime CLIs' stream-json output. claude-auth-401.jsonl was recorded from Claude Code
// 2.1.263 run with the exact restricted flags against a stub MCP server (ids replaced); the other fixtures follow the
// same shapes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  claudeOutcome,
  claudeStep,
  errorKindFromText,
  geminiOutcome,
  geminiStep,
  isGeminiConsoleTool,
  lineReader,
  newClaudeState,
  newGeminiState,
  parseLine,
  type ClaudeState,
  type GeminiState,
} from "./stream-json.ts";
import type { RuntimeEvent } from "./types.ts";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

function claude(name: string, o: { chunk?: number } = {}): { s: ClaudeState; events: RuntimeEvent[]; fatalAt?: number } {
  const s = newClaudeState();
  const events: RuntimeEvent[] = [];
  const r = lineReader();
  const text = fixture(name);
  let fatalAt: number | undefined;
  const size = o.chunk ?? text.length;
  for (let i = 0; i < text.length; i += size) {
    for (const line of r.push(text.slice(i, i + size))) {
      const e = parseLine(line);
      if (!e) continue;
      events.push(...claudeStep(s, e, 1));
      if (s.fatal && fatalAt === undefined) fatalAt = events.length;
    }
  }
  for (const line of r.end()) events.push(...claudeStep(s, parseLine(line) ?? {}, 1));
  return { s, events, fatalAt };
}

function gemini(name: string): { s: GeminiState; events: RuntimeEvent[] } {
  const s = newGeminiState();
  const events: RuntimeEvent[] = [];
  for (const line of fixture(name).split("\n")) {
    const e = parseLine(line);
    if (e) events.push(...geminiStep(s, e, 1));
  }
  return { s, events };
}

test("line reader: events split across chunks are reassembled; an oversized line throws", () => {
  const whole = claude("claude-success.jsonl");
  const bytewise = claude("claude-success.jsonl", { chunk: 7 });
  assert.deepEqual(bytewise.events, whole.events);
  const r = lineReader(10);
  assert.deepEqual(r.push('{"a":1}\n{"b"'), ['{"a":1}']);
  assert.deepEqual(r.push(":2}\n"), ['{"b":2}']);
  assert.throws(() => r.push("x".repeat(11)), /longer than 10/);
  assert.equal(parseLine("not json"), undefined);
  assert.equal(parseLine("[1,2]"), undefined);
});

test("Claude: a successful run — init passes the allowlist, the console's tools, the final answer, usage", () => {
  const { s, events } = claude("claude-success.jsonl");
  assert.equal(s.fatal, undefined);
  const init = events.find((e) => e.type === "init");
  assert.deepEqual(init && init.type === "init" ? { tools: init.tools, auth: init.auth } : null, {
    tools: ["mcp__deployment-console__envs_list", "mcp__deployment-console__envs_status"],
    auth: "none",
  });
  assert.deepEqual(events.filter((e) => e.type === "tool_use").map((e) => (e.type === "tool_use" ? e.name : "")), ["mcp__deployment-console__envs_list", "mcp__deployment-console__envs_status"]);
  assert.deepEqual(events.filter((e) => e.type === "tool_result").map((e) => (e.type === "tool_result" ? e.isError : null)), [false, false]);
  const out = claudeOutcome(s, { code: 0 });
  assert.equal(out.state, "completed");
  assert.match(out.text ?? "", /staging is DEGRADED/);
  assert.deepEqual(out.usage, { costUsd: 0.0412, inputTokens: 12 + 4100 + 8200, outputTokens: 310, turns: 4, durationMs: 9120 });
  // Success is what the CLI said, together with a clean exit.
  assert.equal(claudeOutcome(s, { code: 1 }).state, "failed");
});

test("Claude: the recorded 401 — subtype success with is_error true is an auth failure, never completed", () => {
  const { s, events } = claude("claude-auth-401.jsonl");
  assert.deepEqual(events.filter((e) => e.type === "retry").map((e) => (e.type === "retry" ? e.status : 0)), [401, 401]);
  const out = claudeOutcome(s, { code: 1 });
  assert.equal(out.state, "failed");
  assert.equal(out.errorKind, "auth"); // → paused_auth
  assert.match(out.error ?? "", /sign in to Claude Code again/);
  // The error text never becomes the answer.
  assert.equal(out.text, undefined);
  assert.deepEqual(s.texts, []);
});

test("Claude: unexpected tools in the init list stop the run before anything else is read", () => {
  const { s, fatalAt } = claude("claude-extra-tools.jsonl");
  assert.equal(fatalAt, 1, "fatal right at the init event");
  assert.equal(s.fatal?.kind, "tools");
  assert.match(s.fatal?.error ?? "", /^runtime exposed unexpected tools: Bash, Read, mcp__other-server__query, WebFetch$/);
  const out = claudeOutcome(s, { code: 0 });
  assert.deepEqual([out.state, out.errorKind], ["failed", "tools"]);
});

test("Claude: a tool call outside the allowlist is fatal even when the init list looked fine", () => {
  const s = newClaudeState();
  claudeStep(s, JSON.parse(fixture("claude-success.jsonl").split("\n")[0]), 1);
  assert.equal(s.fatal, undefined);
  claudeStep(s, { type: "assistant", message: { content: [{ type: "tool_use", id: "t", name: "Bash", input: { command: "env" } }] } }, 1);
  assert.deepEqual(s.fatal, { kind: "tools", error: "runtime called a tool outside the allowlist: Bash" });
});

test("Claude: no init event → fail closed; MCP not connected → fail", () => {
  const s = newClaudeState();
  claudeStep(s, { type: "result", subtype: "success", is_error: false, result: "fine" }, 1);
  assert.deepEqual([claudeOutcome(s, { code: 0 }).state, claudeOutcome(s, { code: 0 }).errorKind], ["failed", "tools"]);
  const m = claude("claude-mcp-failed.jsonl");
  assert.equal(m.s.fatal?.kind, "mcp");
  assert.match(m.s.fatal?.error ?? "", /status: failed/);
  const missing = newClaudeState();
  claudeStep(missing, { type: "system", subtype: "init", tools: [], mcp_servers: [] }, 1);
  assert.match(missing.fatal?.error ?? "", /server not loaded/);
  const pending = newClaudeState();
  claudeStep(pending, { type: "system", subtype: "init", tools: [], mcp_servers: [{ name: "deployment-console", status: "pending" }] }, 1);
  assert.equal(pending.fatal, undefined);
  // …but if the console's tools never arrived, a "successful" answer is a tool-less guess, not a completed run.
  claudeStep(pending, { type: "result", subtype: "success", is_error: false, result: "Everything is healthy." }, 1);
  assert.deepEqual([claudeOutcome(pending, { code: 0 }).state, claudeOutcome(pending, { code: 0 }).errorKind], ["failed", "mcp"]);
  // Tools that arrived after init and were called make it a real run.
  const late = newClaudeState();
  claudeStep(late, { type: "system", subtype: "init", tools: [], mcp_servers: [{ name: "deployment-console", status: "pending" }] }, 1);
  claudeStep(late, { type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "mcp__deployment-console__envs_list", input: {} }] } }, 1);
  claudeStep(late, { type: "result", subtype: "success", is_error: false, result: "staging is degraded" }, 1);
  assert.equal(claudeOutcome(late, { code: 0 }).state, "completed");
});

test("Claude: quota → paused_budget kind, budget cap → budget, a crash without a result → runtime with scrubbed stderr", () => {
  const q = claudeOutcome(claude("claude-quota.jsonl").s, { code: 1 });
  assert.deepEqual([q.state, q.errorKind], ["failed", "quota"]);
  assert.ok(!/resets? at \d/.test(q.error ?? ""), "no invented reset time");
  const b = claudeOutcome(claude("claude-budget.jsonl").s, { code: 1 });
  assert.deepEqual([b.state, b.errorKind], ["failed", "budget"]);
  const crash = claudeOutcome(newClaudeState(), { code: 2, stderr: `boom Bearer da_${"z".repeat(43)}` });
  assert.equal(crash.errorKind, "runtime");
  assert.match(crash.error ?? "", /exited with code 2 without a result/);
  assert.ok(!crash.error?.includes("zzzz"));
  const noLogin = claudeOutcome(newClaudeState(), { code: 1, stderr: "Not logged in · Please run /login" });
  assert.equal(noLogin.errorKind, "auth");
});

test("Claude: an answer that talks about rate limits is still a success", () => {
  const s = newClaudeState();
  claudeStep(s, JSON.parse(fixture("claude-success.jsonl").split("\n")[0]), 1);
  claudeStep(s, { type: "result", subtype: "success", is_error: false, result: "The API hit its rate limit and its quota; not logged in users see errors." }, 1);
  assert.equal(claudeOutcome(s, { code: 0 }).state, "completed");
});

test("Claude: the console's tools refused by the CLI's own permission check is a failure, not a tool-less answer", () => {
  const s = newClaudeState();
  claudeStep(s, JSON.parse(fixture("claude-success.jsonl").split("\n")[0]), 1);
  claudeStep(s, { type: "result", subtype: "success", is_error: false, result: "I couldn't reach the tools.", permission_denials: [{ tool_name: "mcp__deployment-console__envs_list", tool_use_id: "t", tool_input: {} }, { tool_name: "Bash" }] }, 1);
  const out = claudeOutcome(s, { code: 0 });
  assert.deepEqual([out.state, out.errorKind], ["failed", "tools"]);
  assert.match(out.error ?? "", /refused the console's tools \(mcp__deployment-console__envs_list\)/);
  // A denial of something else (a tool the CLI doesn't have) doesn't change a completed run.
  const t = newClaudeState();
  claudeStep(t, JSON.parse(fixture("claude-success.jsonl").split("\n")[0]), 1);
  claudeStep(t, { type: "result", subtype: "success", is_error: false, result: "done", permission_denials: [{ tool_name: "Bash" }] }, 1);
  assert.equal(claudeOutcome(t, { code: 0 }).state, "completed");
});

test("error words", () => {
  assert.equal(errorKindFromText("Failed to authenticate. API Error: 401 OAuth access token is invalid."), "auth");
  assert.equal(errorKindFromText("Claude AI usage limit reached|1760000000"), "quota");
  assert.equal(errorKindFromText("Credit balance is too low"), "quota");
  assert.equal(errorKindFromText("connection reset"), undefined);
});

test("Gemini: success assembles deltas; only the console's namespace may be called; quota is recognised", () => {
  const ok = gemini("gemini-success.jsonl");
  assert.equal(ok.s.fatal, undefined);
  const out = geminiOutcome(ok.s, { code: 0 });
  assert.deepEqual([out.state, out.text], ["completed", "Staging is DEGRADED."]);
  assert.deepEqual(out.usage, { inputTokens: 400, outputTokens: 20, durationMs: 3100 });
  assert.equal(geminiOutcome(ok.s, { code: 1 }).state, "failed");

  const shell = gemini("gemini-shell.jsonl");
  assert.deepEqual(shell.s.fatal, { kind: "tools", error: "runtime called a tool outside the allowlist: run_shell_command" });

  const q = geminiOutcome(gemini("gemini-quota.jsonl").s, { code: 1 });
  assert.deepEqual([q.state, q.errorKind], ["failed", "quota"]);
  assert.deepEqual([geminiOutcome(newGeminiState(), { code: 53 }).error], ["the CLI reached its turn limit"]);

  assert.ok(isGeminiConsoleTool("mcp_deployment-console_envs_list"));
  assert.ok(isGeminiConsoleTool("deployment-console__envs_list"));
  for (const n of ["envs_list", "mcp_deployment-console_", "mcp_other_x", "run_shell_command", "mcp_deployment-consolex_y"]) assert.ok(!isGeminiConsoleTool(n), n);
});
