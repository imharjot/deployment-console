// Opt-in smoke test with the real Claude Code CLI (master plan C4 item 6): a stub MCP server on a random loopback port
// (the console's own handleMcp with two fake tools and a fixed bearer token), and the adapter running `claude` with its
// exact restricted flags on "List the environments and say which are unhealthy". It checks that the init tool list
// passed the allowlist, that only the stub's tools were called (with the run token), and that the run completed.
//
//   CONSOLE_RUNTIME_SMOKE=1 [CONSOLE_CLAUDE_BIN=/abs/path/claude] node --test src/lib/server/agents/runtime/claude-smoke.test.ts
//
// It uses the machine's Claude Code login (a subscription run), so it never runs as part of `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { promisify } from "node:util";
import { handleMcp } from "../../../mcp.ts";

const enabled = process.env.CONSOLE_RUNTIME_SMOKE === "1";
const TOKEN = `da_${"s".repeat(20)}${"m".repeat(23)}`;

test("real Claude Code against a stub MCP server: allowlisted tools only, stub tools called, completed", { skip: !enabled && "set CONSOLE_RUNTIME_SMOKE=1 to run the real CLI" }, async () => {
  const seen: { method: string; auth: boolean; rpc?: string }[] = [];
  const called: string[] = [];
  const server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    const auth = req.headers.authorization === `Bearer ${TOKEN}`;
    let rpc: string | undefined;
    try {
      rpc = (JSON.parse(raw) as { method?: string }).method;
    } catch {
      // GET (stream attempt) or garbage
    }
    seen.push({ method: req.method ?? "", auth, rpc });
    if (!auth) return void res.writeHead(401).end();
    if (req.method !== "POST") return void res.writeHead(405).end();
    const r = await handleMcp(raw, {
      tools: async () => [
        { name: "envs_list", description: "List the environments with their health.", inputSchema: { type: "object", properties: {} } },
        { name: "envs_status", description: "Health of one environment.", inputSchema: { type: "object", properties: { env: { type: "string" } }, required: ["env"] } },
      ],
      call: async (name, args) => {
        called.push(name);
        if (name === "envs_list") return { text: JSON.stringify({ envs: [{ id: "production", health: "HEALTHY" }, { id: "staging", health: "DEGRADED", reason: "api: 1 of 3 tasks failing health checks" }] }) };
        if (name === "envs_status") return { text: JSON.stringify({ env: args.env, health: args.env === "staging" ? "DEGRADED" : "HEALTHY" }) };
        return null;
      },
    });
    if (r.body === undefined) return void res.writeHead(r.status).end();
    res.writeHead(r.status, { "content-type": "application/json" }).end(JSON.stringify(r.body));
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
  try {
    const script = `
const { runtimeFor } = await import(${JSON.stringify(new URL("./registry.ts", import.meta.url).href)});
const rt = runtimeFor("claude-code");
const avail = await rt.available();
const events = [];
const r = await rt.run({ prompt: "List the environments and say which are unhealthy", mcpUrl: ${JSON.stringify(url)}, token: ${JSON.stringify(TOKEN)},
  deadlineMs: 240000, signal: new AbortController().signal, onEvent: (e) => events.push(e) });
console.log(JSON.stringify({ avail, r, events }));`;
    const { stdout } = await promisify(execFile)(process.execPath, ["--conditions=react-server", "--no-warnings", "--input-type=module", "-e", script], {
      env: { ...process.env, CONSOLE_SOURCE: "mock", CONSOLE_SQLITE_PATH: ":memory:", NODE_ENV: "test" },
      timeout: 300_000,
      maxBuffer: 32 << 20,
    });
    const out = JSON.parse(stdout.trim().split("\n").pop()!) as {
      avail: { ok: boolean; version?: string; why?: string };
      r: { state: string; text?: string; error?: string; errorKind?: string; tools?: string[]; version?: string };
      events: { type: string; name?: string; tools?: string[] }[];
    };
    const summary = {
      version: out.avail.version,
      tools: out.r.tools,
      toolCalls: out.events.filter((e) => e.type === "tool_use").map((e) => e.name),
      stubCalls: called,
      state: out.r.state,
      errorKind: out.r.errorKind,
      error: out.r.error,
      answer: out.r.text?.slice(0, 300),
    };
    console.log(`smoke: ${JSON.stringify(summary)}`);
    assert.ok(out.avail.ok, out.avail.why);
    assert.ok(out.r.tools?.length, "the init event listed the console's tools");
    for (const t of out.r.tools ?? []) assert.match(t, /^(mcp__deployment-console__\w+|ListMcpResourcesTool|ReadMcpResourceTool|ReadMcpResourceDirTool)$/);
    assert.ok(seen.every((s) => s.auth), "every request carried the run token");
    assert.ok(called.every((n) => n === "envs_list" || n === "envs_status"));
    assert.equal(out.r.state, "completed", `${out.r.errorKind}: ${out.r.error}`);
    assert.ok(called.length > 0, "the model called the stub's tools");
  } finally {
    server.close();
  }
});
