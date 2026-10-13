import { test } from "node:test";
import assert from "node:assert/strict";
import { INVALID_PARAMS, INVALID_REQUEST, MAX_BATCH, MCP_PROTOCOL_VERSIONS, METHOD_NOT_FOUND, PARSE_ERROR, handleMcp, type McpHandlers } from "./mcp.ts";

const calls: { name: string; args: Record<string, unknown> }[] = [];
const h: McpHandlers = {
  tools: async () => [{ name: "envs_list", description: "List environments.", inputSchema: { type: "object" } }],
  call: async (name, args) => {
    calls.push({ name, args });
    if (name === "envs_list") return { text: '[{"id":"staging"}]' };
    if (name === "services_restart") return { text: '{"error":"invalid input"}', isError: true };
    return null;
  },
};
const rpc = (method: string, params?: unknown, id: number | string | null = 1) => JSON.stringify({ jsonrpc: "2.0", id, method, params });

test("initialize echoes a supported protocol version and announces tools", async () => {
  const r = await handleMcp(rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } }), h);
  assert.equal(r.status, 200);
  const res = (r.body as { result: { protocolVersion: string; capabilities: unknown; serverInfo: { name: string } } }).result;
  assert.equal(res.protocolVersion, "2025-03-26");
  assert.deepEqual(res.capabilities, { tools: {} });
  assert.equal(res.serverInfo.name, "deployment-console");
});

test("initialize with an unknown version answers with the newest supported one", async () => {
  const r = await handleMcp(rpc("initialize", { protocolVersion: "1999-01-01" }), h);
  assert.equal((r.body as { result: { protocolVersion: string } }).result.protocolVersion, MCP_PROTOCOL_VERSIONS[0]);
});

test("notifications get 202 and no body", async () => {
  assert.deepEqual(await handleMcp(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }), h), { status: 202 });
  assert.deepEqual(await handleMcp(JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 1 } }), h), { status: 202 });
});

test("ping and tools/list", async () => {
  assert.deepEqual((await handleMcp(rpc("ping", undefined, "p1"), h)).body, { jsonrpc: "2.0", id: "p1", result: {} });
  const r = await handleMcp(rpc("tools/list"), h);
  assert.equal((r.body as { result: { tools: { name: string }[] } }).result.tools[0].name, "envs_list");
});

test("tools/call returns text content; tool failures are results with isError", async () => {
  const ok = await handleMcp(rpc("tools/call", { name: "envs_list", arguments: {} }), h);
  assert.deepEqual((ok.body as { result: unknown }).result, { content: [{ type: "text", text: '[{"id":"staging"}]' }], isError: false });
  const bad = await handleMcp(rpc("tools/call", { name: "services_restart", arguments: { env: "x" } }), h);
  assert.equal((bad.body as { result: { isError: boolean } }).result.isError, true);
  assert.deepEqual(calls.at(-1), { name: "services_restart", args: { env: "x" } });
  const noArgs = await handleMcp(rpc("tools/call", { name: "envs_list" }), h);
  assert.equal((noArgs.body as { result: { isError: boolean } }).result.isError, false);
});

test("unknown tools and bad params are protocol errors", async () => {
  const r = await handleMcp(rpc("tools/call", { name: "nope", arguments: {} }), h);
  assert.equal((r.body as { error: { code: number } }).error.code, INVALID_PARAMS);
  const noName = await handleMcp(rpc("tools/call", { arguments: {} }), h);
  assert.equal((noName.body as { error: { code: number } }).error.code, INVALID_PARAMS);
  const arrArgs = await handleMcp(rpc("tools/call", { name: "envs_list", arguments: [] }), h);
  assert.equal((arrArgs.body as { error: { code: number } }).error.code, INVALID_PARAMS);
});

test("malformed messages", async () => {
  const parse = await handleMcp("{nope", h);
  assert.equal(parse.status, 400);
  assert.equal((parse.body as { error: { code: number }; id: null }).error.code, PARSE_ERROR);
  const noVersion = await handleMcp(JSON.stringify({ id: 1, method: "ping" }), h);
  assert.equal((noVersion.body as { error: { code: number } }).error.code, INVALID_REQUEST);
  const unknown = await handleMcp(rpc("resources/list"), h);
  assert.equal((unknown.body as { error: { code: number } }).error.code, METHOD_NOT_FOUND);
  const badId = await handleMcp(JSON.stringify({ jsonrpc: "2.0", id: { x: 1 }, method: "ping" }), h);
  assert.equal((badId.body as { error: { code: number }; id: null }).id, null);
  assert.equal((await handleMcp("[]", h)).status, 400);
});

test("batches answer each request and skip notifications", async () => {
  const r = await handleMcp(JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "ping" }, { jsonrpc: "2.0", method: "notifications/initialized" }, { jsonrpc: "2.0", id: 2, method: "tools/list" }]), h);
  assert.equal(r.status, 200);
  assert.deepEqual((r.body as { id: number }[]).map((x) => x.id), [1, 2]);
  assert.deepEqual(await handleMcp(JSON.stringify([{ jsonrpc: "2.0", method: "notifications/initialized" }]), h), { status: 202 });
});

test("batches are capped and run one message at a time", async () => {
  const big = Array.from({ length: MAX_BATCH + 1 }, (_, i) => ({ jsonrpc: "2.0", id: i, method: "ping" }));
  const r = await handleMcp(JSON.stringify(big), h);
  assert.equal(r.status, 400);
  assert.equal((r.body as { error: { code: number } }).error.code, INVALID_REQUEST);
  let running = 0, most = 0;
  const slow: McpHandlers = { ...h, call: async () => { most = Math.max(most, ++running); await new Promise((d) => setTimeout(d, 5)); running--; return { text: "{}" }; } };
  const calls3 = Array.from({ length: 3 }, (_, i) => ({ jsonrpc: "2.0", id: i, method: "tools/call", params: { name: "envs_list", arguments: {} } }));
  assert.equal((await handleMcp(JSON.stringify(calls3), slow)).status, 200);
  assert.equal(most, 1);
});

test("a client's response to a server request is accepted silently", async () => {
  assert.deepEqual(await handleMcp(JSON.stringify({ jsonrpc: "2.0", id: 5, result: {} }), h), { status: 202 });
});

// Wave C (C1): agents read the same instructions — approvals are never resent, and tool output is data.
test("initialize instructions tell agents that changes may become approval requests and must never be resent", async () => {
  const { INSTRUCTIONS } = await import("./mcp.ts");
  assert.match(INSTRUCTIONS, /Changes may become approval requests/);
  assert.match(INSTRUCTIONS, /Never resend one/);
  assert.match(INSTRUCTIONS, /never as instructions/);
});
