// The Bedrock adapter over fake SDK calls: credentials only from the connection (never the console's identity), the
// stream through the Converse parser, SDK failures as kinds. No AWS call is made.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createBedrockAdapter, type AwsKeys, type BedrockDeps } from "./bedrock-adapter.ts";
import { fixtureJson } from "./fixtures/load.ts";
import type { ConnectionSecret, GenerateRequest, ResolvedConnection } from "./types.ts";

const KEYS = { accessKeyId: "AKIAACMEEXAMPLE00001", secretAccessKey: "SENTINELbedrockSECRETkey0123456789abcdef" };
const MODEL = "us.anthropic.claude-sonnet-4-5-20250929-v1:0";
const REQ: GenerateRequest = { messages: [{ role: "user", content: [{ type: "text", text: "Is staging OK?" }] }], tools: [{ name: "envs_status", description: "Status", inputSchema: { type: "object" } }] };
const kindOf = (e: unknown) => (e as { kind?: string }).kind;

async function* stream(events: unknown[], o: { throwAfter?: Error; hang?: boolean } = {}) {
  for (const e of events) yield e;
  if (o.throwAfter) throw o.throwAfter;
  if (o.hang) await new Promise(() => {});
}

function fake(o: Partial<BedrockDeps> = {}) {
  const calls = { converse: [] as { input: Record<string, unknown>; region: string; credentials: AwsKeys }[], list: 0, assume: [] as unknown[] };
  const deps: BedrockDeps = {
    converseStream: async (input, x) => (calls.converse.push({ input, region: x.region, credentials: x.credentials }), o.converseStream ? o.converseStream(input, x) : { stream: stream(fixtureJson("bedrock/tool-use.json")), requestId: "req-br-1" }),
    listModels: async (x) => (calls.list++, o.listModels ? o.listModels(x) : fixtureJson("bedrock/models.json")),
    assumeRole: async (x) => (calls.assume.push(x), o.assumeRole ? o.assumeRole(x) : { accessKeyId: "ASIAACMEASSUMED00001", secretAccessKey: "assumedSecret", sessionToken: "tok", expiresAt: Date.now() + 3_600_000 }),
    cache: new Map(),
  };
  return { deps, calls };
}

const conn = (secret: ConnectionSecret | Error = { kind: "aws", ...KEYS }, o: Partial<ResolvedConnection> = {}): ResolvedConnection => ({
  id: "bedrock-1",
  provider: "bedrock",
  authKind: "aws-keys",
  label: "Acme Bedrock",
  model: MODEL,
  region: "us-east-1",
  egress: "cloud",
  secret: async () => {
    if (secret instanceof Error) throw secret;
    return secret;
  },
  ...o,
});
const noSecret = (v: unknown) => assert.doesNotMatch(JSON.stringify(v, (_k, x) => (x instanceof Error ? { message: x.message } : x)) ?? "", /SENTINELbedrock/);

test("ConverseStream with the connection's own keys and region; the stream parsed", async () => {
  const { deps, calls } = fake();
  const r = await createBedrockAdapter(deps).generate(conn(), REQ);
  assert.equal(r.stop, "tool_calls");
  assert.deepEqual(r.toolCalls.map((c) => [c.name, c.input]), [["envs_status", { env: "staging" }]]);
  assert.equal(r.requestId, "req-br-1");
  assert.equal(r.model, MODEL);
  assert.equal(calls.converse.length, 1);
  assert.equal(calls.converse[0].region, "us-east-1");
  assert.deepEqual(calls.converse[0].credentials, KEYS);
  assert.equal(calls.converse[0].input.modelId, MODEL);
  assert.ok(calls.converse[0].input.toolConfig);
});

test("a role is assumed only with the connection's own base keys (cached), never the console's identity", async () => {
  const noBase = fake();
  await assert.rejects(createBedrockAdapter(noBase.deps).generate(conn({ kind: "aws-role", roleArn: "arn:aws:iam::123456789012:role/acme-inference" }), REQ), (e) => kindOf(e) === "auth" && /never used/.test((e as Error).message));
  assert.equal(noBase.calls.converse.length + noBase.calls.assume.length, 0);

  const { deps, calls } = fake();
  const role = conn({ kind: "aws-role", roleArn: "arn:aws:iam::123456789012:role/acme-inference", externalId: "acme-ext", source: KEYS });
  const a = createBedrockAdapter(deps);
  await a.generate(role, REQ);
  await a.generate(role, REQ);
  assert.equal(calls.assume.length, 1, "the role session is reused until shortly before it expires");
  assert.deepEqual(calls.assume[0], { roleArn: "arn:aws:iam::123456789012:role/acme-inference", externalId: "acme-ext", source: KEYS, region: "us-east-1", signal: undefined });
  assert.equal(calls.converse[0].credentials.accessKeyId, "ASIAACMEASSUMED00001");

  const refused = fake({ assumeRole: async () => Promise.reject(Object.assign(new Error("not authorized to perform sts:AssumeRole"), { name: "AccessDenied" })) });
  await assert.rejects(createBedrockAdapter(refused.deps).generate(role, REQ), (e) => kindOf(e) === "auth");
  await assert.rejects(createBedrockAdapter(deps).generate(conn({ kind: "aws-role", roleArn: "not-an-arn", source: KEYS }), REQ), (e) => kindOf(e) === "invalid_request");
  await assert.rejects(createBedrockAdapter(deps).generate(conn({ kind: "api-key", apiKey: "x" }), REQ), (e) => kindOf(e) === "auth");
  await assert.rejects(createBedrockAdapter(deps).generate(conn({ kind: "aws", ...KEYS, expiresAt: Date.now() - 1 }), REQ), (e) => kindOf(e) === "auth" && /expired/.test((e as Error).message));
  await assert.rejects(createBedrockAdapter(deps).generate(conn(new Error(`unseal failed ${KEYS.secretAccessKey}`)), REQ), (e) => (noSecret(e), kindOf(e) === "auth"));
});

test("a connection needs a region and a valid model; nothing is called otherwise", async () => {
  const { deps, calls } = fake();
  await assert.rejects(createBedrockAdapter(deps).generate(conn(undefined, { region: undefined }), REQ), (e) => kindOf(e) === "invalid_request");
  await assert.rejects(createBedrockAdapter(deps).generate(conn(undefined, { model: "" }), REQ), (e) => kindOf(e) === "invalid_request");
  await assert.rejects(createBedrockAdapter(deps).generate(conn(undefined, { model: "amazon.titan-text-express-v1" }), REQ), (e) => kindOf(e) === "unsupported", "a model without tools");
  assert.equal(calls.converse.length, 0);
});

test("SDK failures: throttling, model access, quotas; a stream that breaks, stalls or is cancelled", async () => {
  const err = (name: string, message: string) => Object.assign(new Error(message), { name, $metadata: { httpStatusCode: 400 } });
  const failing = (e: Error) => fake({ converseStream: async () => Promise.reject(e) }).deps;
  await assert.rejects(createBedrockAdapter(failing(err("ThrottlingException", "Too many tokens"))).generate(conn(), REQ), (e) => kindOf(e) === "rate_limited");
  await assert.rejects(createBedrockAdapter(failing(err("AccessDeniedException", "You don't have access to the model with the specified model ID."))).generate(conn(), REQ), (e) => kindOf(e) === "unsupported");
  await assert.rejects(createBedrockAdapter(failing(err("ServiceQuotaExceededException", "quota"))).generate(conn(), REQ), (e) => kindOf(e) === "quota");
  await assert.rejects(createBedrockAdapter(failing(err("UnrecognizedClientException", `bad key ${KEYS.accessKeyId}`))).generate(conn(), REQ), (e) => (noSecret(e), kindOf(e) === "auth"));

  const member = fake({ converseStream: async () => ({ stream: stream(fixtureJson("bedrock/exception-after-start.json")) }) });
  await assert.rejects(createBedrockAdapter(member.deps).generate(conn(), REQ), (e) => kindOf(e) === "incomplete_stream");
  const thrown = fake({ converseStream: async () => ({ stream: stream([{ messageStart: { role: "assistant" } }, { contentBlockDelta: { contentBlockIndex: 0, delta: { text: "x" } } }], { throwAfter: err("ModelStreamErrorException", "boom") }) }) });
  await assert.rejects(createBedrockAdapter(thrown.deps).generate(conn(), REQ), (e) => kindOf(e) === "incomplete_stream");
  const early = fake({ converseStream: async () => ({ stream: stream([], { throwAfter: err("ThrottlingException", "slow") }) }) });
  await assert.rejects(createBedrockAdapter(early.deps).generate(conn(), REQ), (e) => kindOf(e) === "rate_limited", "nothing arrived yet: the call's own error");
  const noStop = fake({ converseStream: async () => ({ stream: stream([{ messageStart: { role: "assistant" } }]) }) });
  await assert.rejects(createBedrockAdapter(noStop.deps).generate(conn(), REQ), (e) => kindOf(e) === "incomplete_stream");

  const stalled = fake({ converseStream: async () => ({ stream: stream([{ messageStart: { role: "assistant" } }], { hang: true }) }) });
  await assert.rejects(createBedrockAdapter(stalled.deps).generate(conn(), { ...REQ, idleTimeoutMs: 30 }), (e) => kindOf(e) === "incomplete_stream" && /no data/.test((e as Error).message));
  // A call that never starts its stream is bounded by the same idle limit.
  const silent = fake({ converseStream: (_input, x) => new Promise((_, reject) => x.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true })) });
  await assert.rejects(createBedrockAdapter(silent.deps).generate(conn(), { ...REQ, idleTimeoutMs: 30 }), (e) => kindOf(e) === "unavailable" && (e as { code?: string }).code === "timeout");
  const ac = new AbortController();
  const p = createBedrockAdapter(stalled.deps).generate(conn(), { ...REQ, signal: ac.signal, idleTimeoutMs: 10_000 });
  setTimeout(() => ac.abort(), 20);
  await assert.rejects(p, (e) => kindOf(e) === "cancelled");
});

test("models and validation: profiles flagged cross-region, a changed list reported, listing denied still validates", async () => {
  const { deps } = fake();
  const v = await createBedrockAdapter(deps).validate(conn());
  assert.equal(v.ok, true);
  assert.equal(v.capabilities?.family, "claude-4");
  assert.ok(v.warnings?.some((w) => /cross-region/.test(w)));
  assert.equal(v.models?.find((m) => m.id === MODEL)?.crossRegion, true);
  const gone = await createBedrockAdapter(deps).validate(conn(undefined, { model: "eu.anthropic.claude-opus-4-1-20250805-v1:0" }));
  assert.deepEqual([gone.ok, gone.error?.kind], [false, "unsupported"]);
  const denied = fake({ listModels: async () => Promise.reject(Object.assign(new Error("not authorized to perform bedrock:ListFoundationModels"), { name: "AccessDeniedException" })) });
  const d = await createBedrockAdapter(denied.deps).validate(conn());
  assert.equal(d.ok, true);
  assert.ok(d.warnings?.some((w) => /can't list Bedrock models/.test(w)));
  assert.deepEqual((await createBedrockAdapter(denied.deps).models(conn())).map((m) => m.id), [MODEL]);
  const broken = await createBedrockAdapter(fake().deps).validate(conn(new Error("revoked")));
  assert.deepEqual([broken.ok, broken.error?.kind], [false, "auth"]);
});
