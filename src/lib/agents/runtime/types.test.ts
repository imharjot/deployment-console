import { test } from "node:test";
import assert from "node:assert/strict";
import { absoluteDeadline, runStateForRuntimeError, runtimeKindOf } from "./types.ts";

test("runtime connections, deadlines and what a failure does to the run", () => {
  assert.equal(runtimeKindOf("runtime:claude-code"), "claude-code");
  assert.equal(runtimeKindOf("runtime:gemini-cli"), "gemini-cli");
  for (const p of ["claude-code", "runtime:", "runtime:codex", "anthropic", "chatgpt-plan"]) assert.equal(runtimeKindOf(p), undefined, p);
  assert.equal(absoluteDeadline(600_000, 1_000), 601_000);
  assert.equal(absoluteDeadline(1_800_000_000_000, 1_000), 1_800_000_000_000);
  assert.equal(absoluteDeadline(-5, 1_000), 1_000);
  // Quota and budget pause the run, a refused login pauses it for sign-in; nothing falls back to another connection.
  assert.equal(runStateForRuntimeError("quota"), "paused_budget");
  assert.equal(runStateForRuntimeError("budget"), "paused_budget");
  assert.equal(runStateForRuntimeError("auth"), "paused_auth");
  for (const k of ["unavailable", "deadline", "tools", "mcp", "runtime", undefined] as const) assert.equal(runStateForRuntimeError(k), "failed", String(k));
});
