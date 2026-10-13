import { test } from "node:test";
import assert from "node:assert/strict";
import { checkMcpUrl, consoleMcpUrl, isRunToken, promptArg, runtimeEnv, scrub } from "./env.ts";

test("a runtime gets a minimal environment: no AWS, console, provider or database secrets", () => {
  const server = {
    PATH: "/usr/bin:/bin",
    HOME: "/Users/ada",
    USER: "ada",
    LANG: "en_GB.UTF-8",
    TERM: "xterm-256color",
    CLAUDE_CONFIG_DIR: "/Users/ada/.claude-work",
    AWS_ACCESS_KEY_ID: "AKIASENTINEL00000000",
    AWS_SECRET_ACCESS_KEY: "sentinel",
    AWS_PROFILE: "prod",
    CONSOLE_SECRET_KEY: "sentinel",
    CONSOLE_SOURCE: "aws",
    ANTHROPIC_API_KEY: "sk-ant-sentinel",
    ANTHROPIC_BASE_URL: "http://127.0.0.1:9/",
    OPENAI_API_KEY: "sk-sentinel",
    GITHUB_TOKEN: "ghp_sentinel",
    DATABASE_URL: "postgres://u:p@h/db",
    PGPASSWORD: "sentinel",
    NODE_OPTIONS: "--require /tmp/evil.js",
    CLAUDECODE: "1",
  };
  const env = runtimeEnv(server, { tmpDir: "/tmp/dc-claude-x/tmp" });
  assert.deepEqual(Object.keys(env).sort(), ["CLAUDE_CONFIG_DIR", "DISABLE_AUTOUPDATER", "HOME", "LANG", "PATH", "TERM", "TMPDIR", "USER"]);
  assert.equal(env.HOME, "/Users/ada"); // the subscription login lives there
  assert.equal(env.TERM, "dumb");
  assert.equal(env.TMPDIR, "/tmp/dc-claude-x/tmp");
  assert.ok(!JSON.stringify(env).includes("sentinel"));
  // CLAUDE_CONFIG_DIR only when the server has it; a PATH is always there.
  assert.deepEqual(Object.keys(runtimeEnv({})).sort(), ["DISABLE_AUTOUPDATER", "LANG", "PATH", "TERM"]);
  // An adapter's additions can't carry a credential either.
  const extra = runtimeEnv({}, { extra: { GEMINI_CLI_TRUST_WORKSPACE: "true", NO_COLOR: "1", GEMINI_API_KEY: "x", GOOGLE_APPLICATION_CREDENTIALS: "/k.json", AWS_REGION: "x", MY_TOKEN: "x", API_KEY_HELPER: "x", CONSOLE_X: "x" } });
  assert.equal(extra.GEMINI_CLI_TRUST_WORKSPACE, "true");
  assert.equal(extra.NO_COLOR, "1");
  for (const k of ["GEMINI_API_KEY", "GOOGLE_APPLICATION_CREDENTIALS", "AWS_REGION", "MY_TOKEN", "API_KEY_HELPER", "CONSOLE_X"]) assert.equal(extra[k], undefined, k);
});

test("run tokens, MCP URLs, prompts", () => {
  assert.ok(isRunToken(`da_${"a1_-".repeat(10)}abc`));
  for (const t of [undefined, "", `dc_${"a".repeat(43)}`, `da_${"a".repeat(42)}`, `da_${"a".repeat(43)}\nX-Evil: 1`, `da_${"a".repeat(42)}"`]) assert.ok(!isRunToken(t), String(t));
  assert.equal(checkMcpUrl("http://127.0.0.1:3200/api/mcp"), "http://127.0.0.1:3200/api/mcp");
  assert.throws(() => checkMcpUrl("file:///etc/passwd"), /http/);
  assert.throws(() => checkMcpUrl("http://u:p@127.0.0.1/api/mcp"), /credentials/);
  assert.throws(() => checkMcpUrl("not a url"), /valid URL/);
  assert.equal(promptArg("  investigate api \0 "), "investigate api");
  assert.equal(promptArg("--dangerously-skip-permissions"), "Task: --dangerously-skip-permissions");
  assert.throws(() => promptArg(""), /empty/);
  assert.throws(() => promptArg("x".repeat(100_001)), /longer/);
});

test("the console's MCP URL for a local CLI: CONSOLE_PUBLIC_URL, else loopback on PORT", () => {
  assert.equal(consoleMcpUrl({ PORT: "3200" }), "http://127.0.0.1:3200/api/mcp");
  assert.equal(consoleMcpUrl({}), "http://127.0.0.1:3200/api/mcp");
  assert.equal(consoleMcpUrl({ PORT: "abc" }), "http://127.0.0.1:3200/api/mcp");
  assert.equal(consoleMcpUrl({ PORT: "3201", CONSOLE_PUBLIC_URL: "https://console.acme.io/" }), "https://console.acme.io/api/mcp");
});

test("scrub: tokens, keys and terminal codes never reach a diagnostic", () => {
  const s = scrub(
    `Authorization: Bearer da_${"x".repeat(43)} key=sk-ant-${"y".repeat(30)} AKIAABCDEFGHIJKLMNOP eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlLXZhbHVl "refresh_token":"rt-123456789" \u001b[31mred\u001b[0m`,
  );
  for (const bad of ["da_xxxx", "sk-ant-yyy", "AKIAABCDEFGHIJKLMNOP", "eyJhbGci", "rt-123456789", "\u001b["]) assert.ok(!s.includes(bad), `${bad} in ${s}`);
  assert.ok(scrub("x".repeat(5000), 100).length <= 101);
});
