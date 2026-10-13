// Connection rules (AGENT_ARCHITECTURE §4–§6, §9.5): who may create, change and use a connection, which endpoints it
// may reach, how secrets are validated (never echoed), and who pays.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AUTH_KINDS, DEFAULT_CONNECTION_POLICY, DEMO_CONNECTION_ID, DEMO_SCRIPT, ENDPOINT_PROVIDERS, PROVIDERS, PROVIDER_IDS, checkConnectionPolicy, checkEndpointList, checkNewConnection, checkPatch,
  checkSecret, chooseEndpoint, currentEndpoint, decideUse, normaliseEndpoint, payerOf, providerSpec,
  type CreateContext, type EndpointEntry, type UseRequest,
} from "./connection-rules.ts";
import { INFERENCE_PROVIDERS } from "./inference/types.ts";
import { RUNTIME_KINDS } from "./runtime/types.ts";

const ctx = (o: Partial<CreateContext> = {}): CreateContext => ({ isAdmin: false, mock: true, chatgptPlan: false, via: "form", endpoints: [], policy: { ...DEFAULT_CONNECTION_POLICY }, ...o });
const KEY = "sk-ant-api03-" + "Zq7Lw2Xk9Mv4Np1Rt6Yb3Hc5SENTINEL";
const entry = (o: Partial<EndpointEntry> = {}): EndpointEntry => ({ id: "proxy", url: "https://llm.acme.example/v1", label: "Proxy", providers: ["openai", "openai-compatible"], local: false, personal: true, ...o });

test("the provider list covers every inference adapter and runtime, with sane auth kinds and https defaults", () => {
  assert.deepEqual([...PROVIDER_IDS].sort(), [...INFERENCE_PROVIDERS, ...RUNTIME_KINDS.map((k) => `runtime:${k}`)].sort());
  assert.deepEqual(PROVIDERS.map((p) => p.id).sort(), [...PROVIDER_IDS].sort());
  for (const p of PROVIDERS) {
    assert.ok(p.authKinds.length && p.authKinds.every((k) => AUTH_KINDS.includes(k)), p.id);
    if (p.endpoint?.builtin) assert.match(p.endpoint.builtin, /^https:\/\/[a-z.]+$/, p.id);
    if (p.endpoint) assert.ok(ENDPOINT_PROVIDERS.includes(p.id), p.id);
  }
  assert.equal(DEMO_CONNECTION_ID, "scripted:demo");
  assert.equal(DEMO_SCRIPT, "incident-demo");
});

test("endpoint URLs: https for cloud, no credentials, query, fragment or dot segments; normalised", () => {
  assert.deepEqual(normaliseEndpoint("https://LLM.acme.example/v1/", { local: false }), { ok: true, value: "https://llm.acme.example/v1" });
  assert.deepEqual(normaliseEndpoint("http://127.0.0.1:11434", { local: true }), { ok: true, value: "http://127.0.0.1:11434" });
  for (const [url, local] of [
    ["http://llm.acme.example", false],
    ["https://user:pw@llm.acme.example", false],
    ["https://llm.acme.example/v1?key=abc", false],
    ["https://llm.acme.example/#x", false],
    ["ftp://llm.acme.example", true],
    ["https://llm.acme.example/a/../b", false],
    ["not a url", true],
    ["", true],
  ] as const)
    assert.equal(normaliseEndpoint(url, { local }).ok, false, url);
});

test("the endpoint registry: Ollama only local, unique URLs and ids, unknown providers refused", () => {
  const ok = checkEndpointList([
    { url: "http://10.0.0.5:11434", label: "GPU box", providers: ["ollama", "openai-compatible"], local: true },
    { url: "https://llm.acme.example/v1", label: "GPU box", providers: ["openai"], personal: false },
  ]);
  assert.ok(ok.ok);
  if (ok.ok) {
    assert.deepEqual(ok.value.map((e) => [e.id, e.local, e.personal]), [["gpu-box", true, false], ["gpu-box-2", false, false]]);
  }
  // Personal connections use the built-in endpoints: an entry is for organisation connections unless an admin says so.
  const personal = checkEndpointList([{ url: "https://llm.acme.example/v1", label: "Proxy", providers: ["openai"] }, { url: "https://llm2.acme.example", label: "Shared", providers: ["openai"], personal: true }]);
  assert.ok(personal.ok && personal.value[0].personal === false && personal.value[1].personal === true);
  if (personal.ok) {
    assert.equal(chooseEndpoint("openai", "https://llm.acme.example/v1", "personal", personal.value).ok, false, "a default entry is organisation-only");
    assert.ok(chooseEndpoint("openai", "https://llm.acme.example/v1", "org", personal.value).ok);
    assert.ok(chooseEndpoint("openai", "https://llm2.acme.example", "personal", personal.value).ok, "an entry an admin marked personal");
  }
  assert.equal(checkEndpointList([{ url: "https://x.example", label: "x", providers: ["ollama"] }]).ok, false, "Ollama must be local");
  assert.equal(checkEndpointList([{ url: "https://x.example", label: "x", providers: ["bedrock"] }]).ok, false, "Bedrock has no endpoint");
  assert.equal(checkEndpointList([{ url: "https://x.example", label: "a", providers: ["openai"] }, { url: "https://x.example/", label: "b", providers: ["openai"] }]).ok, false, "listed twice");
  assert.equal(checkEndpointList({}).ok, false);
  assert.equal(checkEndpointList(Array.from({ length: 51 }, (_, i) => ({ url: `https://h${i}.example`, label: `h${i}`, providers: ["openai"] }))).ok, false);
});

test("choosing an endpoint: built-in default, admin-registered entries only, personal vs organisation entries", () => {
  assert.deepEqual(chooseEndpoint("anthropic", undefined, "personal", []), { ok: true, value: { kind: "builtin", url: "https://api.anthropic.com" } });
  assert.deepEqual(chooseEndpoint("anthropic", "https://api.anthropic.com/", "personal", []), { ok: true, value: { kind: "builtin", url: "https://api.anthropic.com" } });
  // §9.5: a personal connection can't use a custom endpoint nobody registered
  const custom = chooseEndpoint("openai", "https://evil.example/v1", "personal", [entry()]);
  assert.equal(custom.ok, false);
  if (!custom.ok) assert.match(custom.error, /isn't a registered endpoint/);
  assert.ok(chooseEndpoint("openai", "https://llm.acme.example/v1", "personal", [entry()]).ok);
  const orgOnly = chooseEndpoint("openai", "https://llm.acme.example/v1", "personal", [entry({ personal: false })]);
  assert.equal(orgOnly.ok, false);
  assert.ok(chooseEndpoint("openai", "https://llm.acme.example/v1", "org", [entry({ personal: false })]).ok);
  assert.equal(chooseEndpoint("anthropic", "https://llm.acme.example/v1", "org", [entry()]).ok, false, "not registered for this provider");
  assert.equal(chooseEndpoint("ollama", "https://llm.acme.example/v1", "org", [entry({ providers: ["ollama"] })]).ok, false, "Ollama needs a local entry");
  assert.equal(chooseEndpoint("openai-compatible", undefined, "personal", [entry()]).ok, false, "no built-in default");
  assert.equal(chooseEndpoint("bedrock", "https://bedrock.example", "personal", []).ok, false);
  assert.deepEqual(chooseEndpoint("bedrock", undefined, "personal", []), { ok: true, value: { kind: "none" } });
  // Re-checked at use: an entry removed or narrowed later stops the connection.
  assert.equal(currentEndpoint("openai", "personal", "https://llm.acme.example/v1", []).ok, false);
  assert.equal(currentEndpoint("openai", "personal", "https://llm.acme.example/v1", [entry({ personal: false })]).ok, false);
  assert.ok(currentEndpoint("openai", "personal", null, []).ok);
});

test("secrets: validated per sign-in kind, normalised, and never echoed in an error", () => {
  assert.deepEqual(checkSecret("api-key", `  ${KEY}  `, { required: true }), { ok: true, value: { kind: "api-key", apiKey: KEY } });
  assert.deepEqual(checkSecret("none", undefined, { required: true }), { ok: true, value: { kind: "none" } });
  assert.equal(checkSecret("none", "x", { required: true }).ok, false);
  assert.equal(checkSecret("api-key", undefined, { required: true }).ok, false);
  assert.deepEqual(checkSecret("api-key", undefined, { required: false }), { ok: true, value: undefined });
  const keys = { accessKeyId: "AKIA" + "QX7W2ZK4M9PLR3TN", secretAccessKey: "wJal" + "rXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY" };
  assert.deepEqual(checkSecret("aws-keys", keys, { required: true }), { ok: true, value: { kind: "aws-keys", ...keys } });
  assert.equal(checkSecret("aws-keys", { ...keys, accessKeyId: "ASIA" + "QX7W2ZK4M9PLR3TN" }, { required: true }).ok, false, "temporary keys need their session token");
  const role = checkSecret("aws-role", { roleArn: "arn:aws:iam::123456789012:role/bedrock-invoke", externalId: "acme-console", source: keys }, { required: true });
  assert.ok(role.ok && role.value?.kind === "aws-role" && role.value.source.accessKeyId === keys.accessKeyId);
  const noSource = checkSecret("aws-role", { roleArn: "arn:aws:iam::123456789012:role/bedrock-invoke" }, { required: true });
  assert.equal(noSource.ok, false, "a role is never assumed with the console's own identity");
  if (!noSource.ok) assert.match(noSource.error, /never used/);
  assert.equal(checkSecret("aws-role", { roleArn: "arn:aws:iam::12:user/x", source: keys }, { required: true }).ok, false);
  assert.ok(checkSecret("oauth-plan", { tokens: { access_token: "a", refresh_token: "b" } }, { required: true }).ok);
  // Errors never contain the value they refused.
  for (const [kind, bad] of [
    ["api-key", `${KEY} with spaces`],
    ["aws-keys", { accessKeyId: KEY, secretAccessKey: KEY }],
    ["aws-role", { roleArn: KEY, source: keys }],
    ["aws-keys", { ...keys, sessionToken: `${KEY}!!` , accessKeyId: "ASIA" + "QX7W2ZK4M9PLR3TN" }],
  ] as const) {
    const r = checkSecret(kind, bad, { required: true });
    assert.equal(r.ok, false, kind);
    assert.ok(!JSON.stringify(r).includes("SENTINEL") && !JSON.stringify(r).includes("rXUtnFEMI"), JSON.stringify(r));
  }
});

test("creating: scope, admin-only providers, mock-only scripts, the plan flag, regions, policy and unknown fields", () => {
  const ok = checkNewConnection({ provider: "anthropic", label: " Mine ", secret: KEY }, ctx());
  assert.ok(ok.ok);
  if (ok.ok) assert.deepEqual({ ...ok.value, secret: ok.value.secret.kind }, { provider: "anthropic", authKind: "api-key", label: "Mine", scope: "personal", endpoint: "https://api.anthropic.com", endpointLocal: false, backgroundOk: false, minRole: "viewer", egress: "cloud", secret: "api-key" });
  const refuse = (raw: unknown, c: CreateContext, re: RegExp) => {
    const r = checkNewConnection(raw, c);
    assert.equal(r.ok, false, JSON.stringify(raw));
    if (!r.ok) {
      assert.match(r.error, re);
      assert.ok(!r.error.includes("SENTINEL"));
    }
  };
  refuse({ provider: "anthropic", label: "x", secret: KEY, scope: "org" }, ctx(), /only an admin/);
  refuse({ provider: "runtime:claude-code", label: "x" }, ctx(), /only an admin/);
  refuse({ provider: "runtime:claude-code", label: "x", scope: "org" }, ctx({ isAdmin: true }), /personal sign-in/);
  refuse({ provider: "scripted", label: "x" }, ctx({ mock: false }), /simulated account/);
  refuse({ provider: "chatgpt-plan", label: "x", authKind: "oauth-plan" }, ctx(), /turned off/);
  refuse({ provider: "chatgpt-plan", label: "x", authKind: "oauth-plan" }, ctx({ chatgptPlan: true }), /signing in/);
  refuse({ provider: "bedrock", label: "x", authKind: "aws-keys", secret: {} }, ctx(), /needs a region|accessKeyId/);
  refuse({ provider: "anthropic", label: "x", secret: KEY, region: "eu-west-1" }, ctx(), /don't take a region/);
  refuse({ provider: "anthropic", label: "x", secret: KEY, minRole: "admin" }, ctx(), /organisation connections only/);
  refuse({ provider: "anthropic", label: "x", secret: KEY, extra: 1 }, ctx(), /unknown field/);
  refuse({ provider: "anthropic", label: "", secret: KEY }, ctx(), /label/);
  refuse({ provider: "anthropic", label: "x", authKind: "none" }, ctx(), /authenticates with/);
  refuse({ provider: "anthropic", label: "x", secret: KEY }, ctx({ policy: { personal: false, localOnly: false } }), /organisation connections only/);
  refuse({ provider: "anthropic", label: "x", secret: KEY }, ctx({ policy: { personal: true, localOnly: true } }), /only local/);
  refuse({ provider: "anthropic", label: "x", secret: KEY }, ctx({ policy: { personal: true, localOnly: false, providers: ["openai"] } }), /doesn't allow/);
  refuse({ provider: "nope", label: "x" }, ctx(), /provider must be one of/);
  refuse([], ctx(), /JSON object/);

  const plan = checkNewConnection({ provider: "chatgpt-plan", label: "Plan", authKind: "oauth-plan", secret: { tokens: { access_token: "a" } } }, ctx({ chatgptPlan: true, via: "oauth" }));
  assert.ok(plan.ok);
  const script = checkNewConnection({ provider: "scripted", label: "Demo" }, ctx());
  assert.ok(script.ok && script.value.model === "incident-demo" && script.value.egress === "local");
  const org = checkNewConnection({ provider: "openai", label: "Org", scope: "org", secret: "sk-proj-abcdefghijk", minRole: "operator", backgroundOk: true }, ctx({ isAdmin: true }));
  assert.ok(org.ok && org.value.minRole === "operator" && org.value.backgroundOk);
  const orgDefault = checkNewConnection({ provider: "openai", label: "Org", scope: "org", secret: "sk-proj-abcdefghijk" }, ctx({ isAdmin: true }));
  assert.ok(orgDefault.ok && orgDefault.value.minRole === "developer");
  const local = checkNewConnection({ provider: "ollama", label: "Local", endpoint: "http://10.0.0.5:11434" }, ctx({ endpoints: [entry({ url: "http://10.0.0.5:11434", providers: ["ollama"], local: true })] }));
  assert.ok(local.ok && local.value.egress === "local" && local.value.endpointLocal && local.value.secret.kind === "none");
  const bedrock = checkNewConnection(
    { provider: "bedrock", label: "Bedrock", authKind: "aws-role", region: "eu-west-1", secret: { roleArn: "arn:aws:iam::123456789012:role/invoke", source: { accessKeyId: "AKIA" + "QX7W2ZK4M9PLR3TN", secretAccessKey: "wJal" + "rXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY" } } },
    ctx(),
  );
  assert.ok(bedrock.ok && bedrock.value.region === "eu-west-1" && !bedrock.value.endpoint);
});

test("changing: only label, model, background, minRole (org) and a rotated secret; plan sign-ins can't be typed in", () => {
  const c = { provider: "anthropic" as const, authKind: "api-key" as const, scope: "personal" as const };
  assert.deepEqual(checkPatch({ label: "New", model: null, backgroundOk: true }, c), { ok: true, value: { label: "New", model: null, backgroundOk: true } });
  const rot = checkPatch({ secret: KEY }, c);
  assert.ok(rot.ok && rot.value.secret?.kind === "api-key");
  assert.equal(checkPatch({ provider: "openai" }, c).ok, false);
  assert.equal(checkPatch({ endpoint: "https://evil.example" }, c).ok, false, "the endpoint can't be changed afterwards");
  assert.equal(checkPatch({ minRole: "admin" }, c).ok, false);
  assert.ok(checkPatch({ minRole: "admin" }, { ...c, scope: "org" }).ok);
  assert.equal(checkPatch({}, c).ok, false);
  assert.equal(checkPatch({ secret: { tokens: {} } }, { provider: "chatgpt-plan", authKind: "oauth-plan", scope: "personal" }).ok, false);
  assert.equal(checkPatch({ secret: "x" }, { provider: "runtime:claude-code", authKind: "local-runtime", scope: "personal" }).ok, false);
  const bad = checkPatch({ secret: "bad key with spaces SENTINEL" }, c);
  assert.ok(!bad.ok && !JSON.stringify(bad).includes("SENTINEL"));
});

test("using: the broker's checks in order — revoked, person, owner or role, policy, endpoint, run binding, background", () => {
  const base: UseRequest = {
    connection: { id: "c1", ownerId: "alice", scope: "personal", provider: "anthropic", egress: "cloud", backgroundOk: false, status: "active", revoked: false, endpoint: null, minRole: "viewer" },
    who: { id: "alice", role: "developer" },
    purpose: "run",
    run: { id: "r1", connectionId: "c1", state: "running", kind: "assistant", delegatorId: "alice" },
    interactive: true,
    policy: { ...DEFAULT_CONNECTION_POLICY },
    endpoints: [],
  };
  const code = (o: Partial<UseRequest> & { c?: Partial<UseRequest["connection"]>; r?: Partial<NonNullable<UseRequest["run"]>> }) => {
    const d = decideUse({ ...base, ...o, connection: { ...base.connection, ...o.c }, run: Object.hasOwn(o, "run") ? o.run : { ...base.run!, ...o.r } });
    return d.ok ? "ok" : d.code;
  };
  assert.equal(code({}), "ok");
  assert.equal(code({ c: { revoked: true } }), "connection_revoked");
  assert.equal(code({ c: { status: "needs_auth" } }), "connection_needs_auth");
  assert.equal(code({ c: { status: "needs_auth" }, purpose: "test", run: undefined }), "ok", "a person may test a connection that needs re-authentication");
  assert.equal(code({ who: undefined }), "delegator_inactive");
  assert.equal(code({ who: { id: "alice", role: "developer", disabled: true } }), "delegator_inactive");
  assert.equal(code({ who: { id: "bob", role: "admin" }, r: { delegatorId: "bob" } }), "connection_forbidden", "personal connections are never shared, not even with an admin");
  assert.equal(code({ c: { scope: "org", ownerId: "root", minRole: "operator" } }), "connection_forbidden");
  assert.equal(code({ c: { scope: "org", ownerId: "root", minRole: "developer" } }), "ok");
  assert.equal(code({ policy: { personal: false, localOnly: false } }), "policy_personal");
  assert.equal(code({ policy: { personal: true, localOnly: true } }), "policy_egress");
  assert.equal(code({ policy: { personal: true, localOnly: true }, c: { egress: "local", provider: "scripted" } }), "ok");
  assert.equal(code({ policy: { personal: true, localOnly: false, providers: ["openai"] } }), "policy_provider");
  assert.equal(code({ c: { provider: "openai", endpoint: "https://llm.acme.example/v1" } }), "endpoint_unregistered");
  assert.equal(code({ c: { provider: "openai", endpoint: "https://llm.acme.example/v1" }, endpoints: [entry()] }), "ok");
  // The egress class follows the registry as it is now: an entry re-classed from local to cloud is cloud egress.
  const compat = { c: { provider: "openai-compatible" as const, egress: "local" as const, endpoint: "https://llm.acme.example/v1" }, policy: { personal: true, localOnly: true } };
  assert.equal(code({ ...compat, endpoints: [entry({ local: true })] }), "ok");
  assert.equal(code({ ...compat, endpoints: [entry({ local: false })] }), "policy_egress");
  const d = decideUse({ ...base, connection: { ...base.connection, ...compat.c }, endpoints: [entry({ local: false })] });
  assert.ok(d.ok && d.egress === "cloud", "the adapter is told the current class");
  assert.equal(code({ run: undefined }), "run_not_found");
  assert.equal(code({ r: { connectionId: "c2" } }), "connection_mismatch", "no fallback to another connection");
  assert.equal(code({ r: { connectionId: null } }), "connection_mismatch");
  for (const s of ["succeeded", "failed", "cancelled", "outcome_unknown"] as const) assert.equal(code({ r: { state: s } }), "run_finished");
  assert.equal(code({ r: { delegatorId: "bob" } }), "delegator_mismatch");
  assert.equal(code({ interactive: false }), "background_not_allowed");
  assert.equal(code({ interactive: false, c: { backgroundOk: true } }), "ok");
  assert.equal(code({ interactive: false, purpose: "test", run: undefined }), "ok", "background applies to runs only");
});

test("organisation policy parsing fails closed to the defaults and refuses unknown fields", () => {
  assert.deepEqual(checkConnectionPolicy({ personal: false, localOnly: true, providers: ["ollama", "ollama"] }), { ok: true, value: { personal: false, localOnly: true, providers: ["ollama"] } });
  assert.equal(checkConnectionPolicy({ personal: "no" }).ok, false);
  assert.equal(checkConnectionPolicy({ egress: "local" }).ok, false);
  assert.equal(checkConnectionPolicy({ providers: ["nope"] }).ok, false);
  assert.deepEqual(checkConnectionPolicy({}), { ok: true, value: DEFAULT_CONNECTION_POLICY });
});

test("who pays is spelled out for every provider and scope", () => {
  for (const p of PROVIDER_IDS)
    for (const scope of ["personal", "org"] as const) {
      const s = payerOf({ provider: p, scope, ownerEmail: "alice@acme.test", region: "eu-west-1", account: "123456789012", plan: "pro", egress: "cloud" });
      assert.ok(s.length > 10 && !/undefined|null/.test(s), `${p}/${scope}: ${s}`);
    }
  assert.match(payerOf({ provider: "anthropic", scope: "org" }), /organisation's Anthropic/);
  assert.match(payerOf({ provider: "bedrock", scope: "personal", account: "123456789012", region: "eu-west-1" }), /123456789012.*eu-west-1/);
  assert.match(payerOf({ provider: "chatgpt-plan", scope: "personal", ownerEmail: "a@b.test", plan: "plus" }), /ChatGPT plan \(plus\).*never API billing/);
  assert.match(payerOf({ provider: "scripted", scope: "org" }), /no cost/);
  assert.equal(providerSpec("ollama").endpoint?.custom, "registered-local");
});
