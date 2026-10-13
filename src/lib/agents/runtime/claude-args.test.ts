import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CLAUDE_SERVER_RULE,
  CLAUDE_TOOL_RULE,
  FORBIDDEN_CLAUDE_FLAGS,
  MIN_CLAUDE_VERSION,
  claudeArgs,
  claudeMcpConfig,
  compareVersions,
  parseClaudeVersion,
  unexpectedTools,
} from "./claude-args.ts";

const FILE = "/tmp/dc-claude-x/mcp.json";

test("the command line is exactly the restricted one from the plan (decision 11)", () => {
  assert.deepEqual(claudeArgs({ prompt: "List the environments", mcpConfigFile: FILE }), [
    "-p", "List the environments", "--restricted", "--tools", "", "--disable-slash-commands", "--strict-mcp-config", "--mcp-config", FILE,
    "--allowedTools", "mcp__deployment-console__*", "--permission-mode", "dontAsk", "--permission-prompts", "none", "--output-format", "stream-json",
    "--verbose", "--no-session-persistence",
  ]);
  const withExtras = claudeArgs({ prompt: "x", mcpConfigFile: FILE, model: "sonnet", budgetUsd: 2.5 });
  assert.deepEqual(withExtras.slice(-4), ["--model", "sonnet", "--max-budget-usd", "2.5"]);
  // The server-level rule, for a CLI that would reject the wildcard.
  assert.equal(claudeArgs({ prompt: "x", mcpConfigFile: FILE, toolRule: CLAUDE_SERVER_RULE })[10], "mcp__deployment-console");
  assert.equal(CLAUDE_TOOL_RULE, "mcp__deployment-console__*");
});

test("never a dangerous flag, whatever the prompt or model says", () => {
  const nasty = ["--bare", "--dangerously-skip-permissions", "--add-dir /", "--settings {}", "-r abc", "--resume", "--plugin-dir /tmp/p"];
  const required = ["--bare", "--dangerously-skip-permissions", "--allow-dangerously-skip-permissions", "--add-dir", "--plugin-dir", "--plugin-url", "--settings", "--chrome", "--resume"];
  for (const f of required) assert.ok((FORBIDDEN_CLAUDE_FLAGS as readonly string[]).includes(f), f);
  for (const prompt of ["Investigate api", ...nasty, `${nasty.join(" ")}\nthen restart`]) {
    const args = claudeArgs({ prompt, mcpConfigFile: FILE, model: "opus", budgetUsd: 1 });
    // The prompt is one element right after -p; no element is ever a forbidden option.
    for (const [i, a] of args.entries()) if (i !== 1) assert.ok(!(FORBIDDEN_CLAUDE_FLAGS as readonly string[]).includes(a), `${a} in argv`);
    assert.ok(!args[1].startsWith("-"), "a prompt that looks like an option is prefixed");
    assert.equal(args.filter((a) => a === "-p").length, 1);
  }
  // The model and budget can't smuggle a flag either.
  assert.throws(() => claudeArgs({ prompt: "x", mcpConfigFile: FILE, model: "--dangerously-skip-permissions" }), /invalid model/);
  assert.throws(() => claudeArgs({ prompt: "x", mcpConfigFile: FILE, model: "sonnet --bare" }), /invalid model/);
  for (const b of [0, -1, Number.NaN, Infinity, 5_000]) assert.throws(() => claudeArgs({ prompt: "x", mcpConfigFile: FILE, budgetUsd: b }), /budget/);
  assert.throws(() => claudeArgs({ prompt: "x", mcpConfigFile: "relative.json" }), /absolute/);
  assert.throws(() => claudeArgs({ prompt: "x", mcpConfigFile: FILE, toolRule: "*" as never }), /tool rule/);
  assert.throws(() => claudeArgs({ prompt: "   ", mcpConfigFile: FILE }), /empty/);
});

test("the MCP config names one HTTP server, the console, with the bearer token", () => {
  const token = `da_${"A".repeat(43)}`;
  assert.deepEqual(claudeMcpConfig("http://127.0.0.1:3200/api/mcp", token), {
    mcpServers: { "deployment-console": { type: "http", url: "http://127.0.0.1:3200/api/mcp", headers: { Authorization: `Bearer ${token}` } } },
  });
});

test("the init tool list: only the console's MCP tools and Claude Code's three resource helpers", () => {
  assert.deepEqual(unexpectedTools(["mcp__deployment-console__envs_list", "ListMcpResourcesTool", "ReadMcpResourceTool", "ReadMcpResourceDirTool"]), []);
  assert.deepEqual(unexpectedTools([]), []);
  assert.deepEqual(
    unexpectedTools(["Bash", "Read", "Edit", "Write", "WebFetch", "Task", "Glob", "Grep", "NotebookEdit", "mcp__other__x", "mcp__deployment-console__", "mcp__deployment-consolex__y", { name: "obj" }]),
    ["Bash", "Read", "Edit", "Write", "WebFetch", "Task", "Glob", "Grep", "NotebookEdit", "mcp__other__x", "mcp__deployment-console__", "mcp__deployment-consolex__y", '{"name":"obj"}'],
  );
});

test("versions", () => {
  assert.equal(parseClaudeVersion("2.1.263 (Claude Code)\n"), "2.1.263");
  assert.equal(parseClaudeVersion("v2.2.0"), "2.2.0");
  assert.equal(parseClaudeVersion("claude: command not found"), undefined);
  assert.equal(compareVersions("2.1.263", MIN_CLAUDE_VERSION), 0);
  assert.equal(compareVersions("2.1.300", "2.1.263"), 1);
  assert.equal(compareVersions("2.0.999", "2.1.263"), -1);
  assert.equal(compareVersions("10.0.0", "9.9.9"), 1);
});
