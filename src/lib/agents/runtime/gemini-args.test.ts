import { test } from "node:test";
import assert from "node:assert/strict";
import { GEMINI_BUILTIN_TOOLS, GEMINI_ENV, MIN_GEMINI_VERSION, geminiArgs, geminiSettings, geminiTooOld, missingGeminiFeatures, parseGeminiVersion } from "./gemini-args.ts";
import { runtimeEnv } from "./env.ts";

test("the Gemini command line: headless, stream-json, no YOLO, only the console's MCP server, no extensions", () => {
  assert.deepEqual(geminiArgs({ prompt: "List the environments" }), [
    "-p", "List the environments", "--output-format", "stream-json", "--approval-mode", "default", "--allowed-mcp-server-names", "deployment-console", "-e", "none",
  ]);
  assert.deepEqual(geminiArgs({ prompt: "x", model: "gemini-2.5-pro" }).slice(-2), ["-m", "gemini-2.5-pro"]);
  for (const a of geminiArgs({ prompt: "--yolo", model: "gemini-2.5-pro" })) assert.ok(!["--yolo", "-y", "--sandbox", "--include-directories", "--all-files"].includes(a), a);
  assert.throws(() => geminiArgs({ prompt: "x", model: "--yolo" }), /invalid model/);
});

test("the workspace settings: the console over HTTP with its bearer token, nothing built in, nothing reported home", () => {
  const token = `da_${"B".repeat(43)}`;
  const s = geminiSettings("http://127.0.0.1:3200/api/mcp", token);
  assert.deepEqual(s.mcpServers, {
    "deployment-console": { httpUrl: "http://127.0.0.1:3200/api/mcp", headers: { Authorization: `Bearer ${token}` }, trust: true, timeout: 120_000 },
  });
  assert.deepEqual(s.mcp.allowed, ["deployment-console"]);
  assert.deepEqual(s.tools.core, []);
  for (const t of ["run_shell_command", "write_file", "replace", "read_file", "web_fetch", "google_web_search", "save_memory"]) assert.ok((s.tools.exclude as string[]).includes(t), t);
  assert.equal(s.tools.exclude.length, GEMINI_BUILTIN_TOOLS.length);
  assert.equal(s.security.disableYoloMode, true);
  assert.equal(s.telemetry.enabled, false);
  assert.equal(s.privacy.usageStatisticsEnabled, false);
  // The trust flag for the run's own workspace survives the environment filter.
  assert.equal(runtimeEnv({}, { extra: { ...GEMINI_ENV } }).GEMINI_CLI_TRUST_WORKSPACE, "true");
});

test("versions and features: 0.1.5 is too old for HTTP MCP", () => {
  assert.equal(parseGeminiVersion("0.1.5\n"), "0.1.5");
  assert.equal(parseGeminiVersion("gemini 0.12.0"), "0.12.0");
  assert.equal(parseGeminiVersion("nope"), undefined);
  assert.equal(MIN_GEMINI_VERSION, "0.11.0");
  assert.match(geminiTooOld("0.1.5"), /^Gemini CLI 0\.1\.5 is too old for HTTP MCP \(needs 0\.11\.0 or newer/);
  const old = "Options:\n  -m, --model\n  -p, --prompt\n  -y, --yolo\n";
  assert.deepEqual(missingGeminiFeatures(old), ["stream-json", "--approval-mode", "--allowed-mcp-server-names", "--extensions"]);
  const modern = "--output-format  [choices: \"text\", \"json\", \"stream-json\"]\n--approval-mode\n--allowed-mcp-server-names\n-e, --extensions";
  assert.deepEqual(missingGeminiFeatures(modern), []);
});
