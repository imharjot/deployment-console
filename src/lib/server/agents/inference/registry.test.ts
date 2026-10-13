// The server registry: one adapter per provider and no fallback, the scripted demo wired in, refusals that happen
// before anything leaves the machine, and Bedrock never on the console's AWS identity. The modules import
// "server-only", which only resolves under the react-server condition, so the scenario runs in a child process. No
// network: every refusal below happens before a socket is opened (IP-literal endpoints need no DNS).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";

const here = new URL(".", import.meta.url);

const scenario = `
const reg = await import(${JSON.stringify(new URL("./registry.ts", import.meta.url).href)});
const out = {};
const kind = async (p) => { try { await p; return "ok"; } catch (e) { return [e.kind, e.code ?? null, e.name]; } };
out.providers = reg.inferenceProviders().sort();
out.each = Object.fromEntries(out.providers.map((p) => [p, reg.adapterFor(p).provider]));
out.lookups = [];
for (const p of ["chatgpt-plan", "runtime:claude-code", "gpt-4-proxy", "__proto__", "constructor", "toString"]) out.lookups.push([p, await kind((async () => reg.adapterFor(p))())]);

const ask = (text, tools) => ({ messages: [{ role: "user", content: [{ type: "text", text }] }], tools });
const demo = { id: "scripted:demo", provider: "scripted", authKind: "none", label: "Demo model (scripted)", model: "incident-demo", egress: "local", secret: async () => ({ kind: "none" }) };
const r = await reg.generateWith(demo, ask("Is anything degraded?", [{ name: "envs_list", description: "List", inputSchema: { type: "object" }, op: "envs.list" }]));
out.demo = { stop: r.stop, calls: r.toolCalls.map((c) => c.name), model: r.model };
out.demoValid = (await reg.adapterFor("scripted").validate(demo)).ok;

let secretReads = 0;
const counted = (s) => async () => { secretReads++; return s; };
out.unregistered = await kind(reg.generateWith({ id: "a", provider: "anthropic", authKind: "api-key", label: "A", model: "claude-sonnet-4-5", endpoint: "https://llm.attacker.example", egress: "cloud", secret: counted({ kind: "api-key", apiKey: "k" }) }, ask("hi")));
out.localPublic = await kind(reg.generateWith({ id: "o", provider: "ollama", authKind: "none", label: "O", model: "qwen3:8b", endpoint: "http://8.8.8.8:11434", endpointRegistered: true, egress: "local", secret: counted({ kind: "none" }) }, ask("hi")));
out.metadata = await kind(reg.generateWith({ id: "m", provider: "openai-compatible", authKind: "none", label: "M", model: "x", endpoint: "http://169.254.169.254/latest", endpointRegistered: true, egress: "cloud", secret: counted({ kind: "none" }) }, ask("hi")));
out.cloudModel = await kind(reg.generateWith({ id: "c", provider: "ollama", authKind: "none", label: "O", model: "gpt-oss:120b-cloud", endpoint: "http://127.0.0.1:9", endpointRegistered: true, egress: "local", secret: counted({ kind: "none" }) }, ask("hi")));
out.secretReads = secretReads;
out.bedrockRole = await kind(reg.generateWith({ id: "b", provider: "bedrock", authKind: "aws-role", label: "B", model: "amazon.nova-pro-v1:0", region: "us-east-1", egress: "cloud", secret: async () => ({ kind: "aws-role", roleArn: "arn:aws:iam::123456789012:role/acme-inference" }) }, ask("hi")));
out.bedrockRegion = await kind(reg.generateWith({ id: "b2", provider: "bedrock", authKind: "aws-keys", label: "B", model: "amazon.nova-pro-v1:0", egress: "cloud", secret: async () => ({ kind: "aws", accessKeyId: "AKIAACMEEXAMPLE00001", secretAccessKey: "x".repeat(40) }) }, ask("hi")));
out.wrongProvider = await kind(reg.generateWith({ ...demo, provider: "nope" }, ask("hi")));
out.recovery = ["auth", "quota", "rate_limited", "unsupported"].map((k) => reg.inferenceRecovery({ name: "InferenceError", kind: k, message: k }).action);
console.log(JSON.stringify(out));
`;

const run = (plan: string) => {
  const raw = execFileSync(process.execPath, ["--conditions=react-server", "--no-warnings", "--input-type=module", "-e", scenario], {
    encoding: "utf8",
    env: { ...process.env, CONSOLE_SOURCE: "mock", CONSOLE_SQLITE_PATH: ":memory:", AUTH_MODE: "dev", NODE_ENV: "test", CONSOLE_CHATGPT_PLAN: plan },
    timeout: 60_000,
  });
  return JSON.parse(raw.trim().split("\n").pop()!);
};

test("adapterFor: one adapter per provider, unknown providers refused, never a fallback", () => {
  const out = run("");
  assert.deepEqual(out.providers, ["anthropic", "bedrock", "ollama", "openai", "openai-compatible", "scripted"]);
  for (const p of out.providers) assert.equal(out.each[p], p);
  // With CONSOLE_CHATGPT_PLAN off the plan adapter isn't listed and is refused like any unknown provider. Runtime
  // connections go to runtimeFor(), never here.
  const lookups = new Map<string, unknown>(out.lookups);
  assert.deepEqual(lookups.get("chatgpt-plan"), ["unsupported", "provider", "InferenceError"]);
  for (const p of ["runtime:claude-code", "gpt-4-proxy", "__proto__", "constructor", "toString"]) assert.deepEqual(lookups.get(p), ["unsupported", "provider", "InferenceError"], p);
  assert.deepEqual(out.demo, { stop: "tool_calls", calls: ["envs_list"], model: "incident-demo" });
  assert.equal(out.demoValid, true);
  assert.deepEqual(out.unregistered, ["invalid_request", "egress", "InferenceError"]);
  assert.deepEqual(out.localPublic, ["invalid_request", "egress", "InferenceError"]);
  assert.deepEqual(out.metadata, ["invalid_request", "egress", "InferenceError"]);
  assert.deepEqual(out.cloudModel, ["invalid_request", "egress", "InferenceError"]);
  assert.equal(out.secretReads, 0, "every refusal came before the credential was read");
  assert.deepEqual(out.bedrockRole, ["auth", "no-base-credentials", "InferenceError"]);
  assert.equal(out.bedrockRegion[0], "invalid_request");
  assert.deepEqual(out.wrongProvider, ["unsupported", "provider", "InferenceError"]);
  assert.deepEqual(out.recovery, ["pause", "pause", "retry", "fail"]);
});

test("the ChatGPT-plan adapter is listed only with CONSOLE_CHATGPT_PLAN=eligible", () => {
  const out = run(" Eligible ");
  assert.deepEqual(out.providers, ["anthropic", "bedrock", "chatgpt-plan", "ollama", "openai", "openai-compatible", "scripted"]);
  assert.equal(out.each["chatgpt-plan"], "chatgpt-plan");
  assert.equal(new Map<string, unknown>(out.lookups).get("chatgpt-plan"), "ok");
  // Everything else is unchanged: no provider stands in for another.
  assert.deepEqual(out.wrongProvider, ["unsupported", "provider", "InferenceError"]);
});

test("model calls never use the console's AWS identity: explicit connection credentials on every client here", () => {
  const files = readdirSync(here).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
  for (const f of files) {
    const src = readFileSync(new URL(f, here), "utf8");
    // The console's own AWS plumbing (limiter, regional config, Cloud) belongs to the console role.
    assert.doesNotMatch(src, /aws-limiter|sdkConfig|getCloud|credential-provider-node|fromNodeProviderChain|fromIni|fromEnv/, f);
    for (const m of src.matchAll(/new (\w+Client)\(\{([^}]*)/g)) assert.match(m[2], /credentials: creds\(/, `${f}: ${m[1]} must be built with the connection's credentials`);
  }
  assert.ok(files.includes("bedrock.ts") && files.includes("registry.ts"));
});
