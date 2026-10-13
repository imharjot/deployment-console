// The credential broker and the connection routes (master plan §6 C5, AGENT_ARCHITECTURE §9.4 / §9.5), run for real:
// the route handlers, the broker, secrets.ts sealing, the audit log and an in-memory SQLite DB, in a child process
// (they import "server-only", which resolves only under the react-server condition; a resolve hook maps "@/…" to src/
// and "next/server" to next/server.js). A loopback stub stands in for a model provider; nothing leaves the machine.
//
// Covered: cross-user access → 403; adapter errors redacted (the provider echoes the key back); disconnect while a run
// waits → paused_auth, no fallback; no secret in any route response or audit row (a sentinel scan); a model-supplied
// URL is refused; a personal connection can't use a custom endpoint; the built-in scripted:demo connection exists with
// the simulated account only; background use, demotion, run binding and rotation.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";

const SRC = new URL("../../../", import.meta.url).href; // …/src/
const hooks = `
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
const SRC = ${JSON.stringify(SRC)};
export async function resolve(spec, ctx, next) {
  if (spec === "next/server") return next("next/server.js", ctx);
  if (spec.startsWith("@/")) {
    for (const ext of [".ts", ".tsx", "/index.ts"]) {
      const url = new URL(spec.slice(2) + ext, SRC);
      if (existsSync(fileURLToPath(url))) return next(url.href, ctx);
    }
  }
  return next(spec, ctx);
}`;
const register = `import { register } from "node:module"; register(${JSON.stringify(`data:text/javascript,${encodeURIComponent(hooks)}`)});`;

function run(scenario: string, env: Record<string, string> = {}) {
  const raw = execFileSync(process.execPath, ["--conditions=react-server", "--no-warnings", "--import", `data:text/javascript,${encodeURIComponent(register)}`, "--input-type=module", "-e", scenario], {
    encoding: "utf8",
    timeout: 120_000,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      CONSOLE_SOURCE: "mock",
      CONSOLE_SQLITE_PATH: ":memory:",
      CONSOLE_SECRET_KEY: randomBytes(36).toString("base64"),
      CONSOLE_TRUSTED_PROXIES: "0",
      NODE_ENV: "test",
      ...env,
    },
  });
  return JSON.parse(raw.trim().split("\n").pop()!);
}

// Shared by the scenarios: users, a request builder that plays the proxy (verified identity headers), and helpers.
const prelude = `
const src = (p) => new URL(p, ${JSON.stringify(SRC)}).href;
const { NextRequest } = await import("next/server.js");
const { getDb } = await import(src("lib/server/db.ts"));
const { createUser } = await import(src("lib/server/auth/users.ts"));
const db = await getDb();
const mk = async (email, role) => { const r = await createUser({ email, role }); return { id: r.id, email, role }; };
const alice = await mk("alice@acme.test", "developer");
const bob = await mk("bob@acme.test", "developer");
const admin = await mk("admin@acme.test", "admin");
const viewer = await mk("val@acme.test", "viewer");
const bodies = [];
const call = async (mod, method, who, { path = "/api/agents/connections", body, params, via = "session" } = {}) => {
  const headers = { "x-console-user-id": who.id, "x-console-user-email": who.email, "x-console-user-role": who.role, "x-console-auth-via": via, "content-type": "application/json" };
  const req = new NextRequest("http://127.0.0.1:3200" + path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const res = await mod[method](req, { params: Promise.resolve(params ?? {}) });
  const text = await res.text();
  bodies.push(text);
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json };
};
const list = await import(src("app/api/agents/connections/route.ts"));
const one = await import(src("app/api/agents/connections/[id]/route.ts"));
const testRoute = await import(src("app/api/agents/connections/[id]/test/route.ts"));
const modelsRoute = await import(src("app/api/agents/models/route.ts"));
const broker = await import(src("lib/server/agents/credentials.ts"));
const egress = await import(src("lib/server/agents/egress.ts"));
const settle = (p) => p.then((v) => ({ ok: v }), (e) => ({ status: e.status, code: e.code, name: e.name, error: String(e.message) }));
const insertRun = (id, connectionId, state, delegatorId, kind = "assistant") => db.run(
  "INSERT INTO agent_runs (id, kind, title, initiator_id, principal, connection_id, state, created_at, updated_at) VALUES (?, ?, 't', ?, ?, ?, ?, ?, ?)",
  [id, kind, delegatorId, JSON.stringify({ id: "p-" + id, kind: "agent", runId: id, delegatorId, delegatorEmail: "x", policyHash: "h", mode: "propose" }), connectionId, state, Date.now(), Date.now()],
);
const runState = async (id) => (await db.get("SELECT state, error FROM agent_runs WHERE id = ?", [id]));
`;

// Sentinels: a value of every secret kind a connection holds. None may appear in any response, audit row or error.
const KEY = `sk-ant-api03-${"Zq7Lw2Xk9Mv4Np1Rt6Yb3Hc5Jd8Fg0Sq"}SENTINEL`;
const KEY2 = `sk-ant-api03-${"Rt6Yb3Hc5Jd8Fg0SqZq7Lw2Xk9Mv4Np1"}ROTATED`;
const AWS_ID = "AKIA" + "QX7W2ZK4M9PLR3TN";
const AWS_SECRET = "wJal" + "rXUtnFEMI/K7MDENG/bPxRfiCYSENTINELXY"; // 40 characters
const COMPAT_KEY = "ck-" + "Lw9Xz4Nv7Bm1Rt6Yp3Hs5Kq2Lw9Xz4Nv7SENTINEL";
const FRAGMENTS = ["Zq7Lw2Xk9Mv4Np1", "Rt6Yb3Hc5Jd8Fg0", "QX7W2ZK4M9PLR3TN", "rXUtnFEMI/K7MDENG", "Lw9Xz4Nv7Bm1Rt6", "SENTINEL", "ROTATED", "v1:"];
const leaks = (text: string) => FRAGMENTS.filter((f) => text.includes(f));

test("connections: create, see, rotate, test and revoke — cross-user 403, secrets never come back, adapter errors scrubbed", () => {
  const o = run(`${prelude}
const out = {};
// A loopback stub "provider" that echoes the key it was sent in every error (as real providers sometimes do).
const http = await import("node:http");
const seen = [];
const stub = http.createServer((req, res) => {
  seen.push({ path: req.url, auth: req.headers.authorization ?? "" });
  res.writeHead(401, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: { message: "Incorrect API key provided: " + (req.headers.authorization ?? "").replace(/^Bearer /, "") + " (tried " + req.url + ")", type: "invalid_request_error", code: "invalid_api_key" } }));
});
await new Promise((r) => stub.listen(0, "127.0.0.1", r));
const stubUrl = "http://127.0.0.1:" + stub.address().port;

// People only: an API token (via token) or an agent is refused even if it reached the route.
out.tokenList = (await call(list, "GET", alice, { via: "token" })).status;
out.agentList = (await call(list, "GET", alice, { via: "agent" })).status;

// Alice: a personal Anthropic connection on the built-in endpoint.
const created = await call(list, "POST", alice, { body: { provider: "anthropic", label: "Alice Claude", secret: ${JSON.stringify(KEY)}, model: "claude-sonnet-4-5" } });
out.created = { status: created.status, keys: Object.keys(created.json.connection).sort(), conn: created.json.connection };
const aid = created.json.connection.id;

// Bedrock with keys, and with a role assumed by its own keys: the role's account pays; no key comes back.
const bk = await call(list, "POST", alice, { body: { provider: "bedrock", authKind: "aws-keys", label: "Bedrock keys", region: "eu-west-1", secret: { accessKeyId: ${JSON.stringify(AWS_ID)}, secretAccessKey: ${JSON.stringify(AWS_SECRET)} } } });
const br = await call(list, "POST", alice, { body: { provider: "bedrock", authKind: "aws-role", label: "Bedrock role", region: "eu-west-1", secret: { roleArn: "arn:aws:iam::210987654321:role/bedrock-invoke", externalId: "acme-console", source: { accessKeyId: ${JSON.stringify(AWS_ID)}, secretAccessKey: ${JSON.stringify(AWS_SECRET)} } } } });
out.bedrock = { keys: bk.status, role: br.status, payer: br.json.connection?.payer, rolelessRefused: (await call(list, "POST", alice, { body: { provider: "bedrock", authKind: "aws-role", label: "x", region: "eu-west-1", secret: { roleArn: "arn:aws:iam::210987654321:role/bedrock-invoke" } } })).status };
const brConn = await broker.resolveConnection(br.json.connection.id, { kind: "test", user: alice });
const brSecret = await brConn.secret();
out.bedrockSecret = { kind: brSecret.kind, sourceKey: brSecret.source?.accessKeyId === ${JSON.stringify(AWS_ID)}, region: brConn.region, endpoint: brConn.endpoint ?? null };

// Org connections and admin-only providers.
out.orgByDev = await call(list, "POST", bob, { body: { provider: "openai", label: "Shared", scope: "org", secret: "sk-proj-abcdefghijklmnop" } });
out.runtimeByDev = await call(list, "POST", bob, { body: { provider: "runtime:claude-code", label: "My CLI" } });
out.unknownField = await call(list, "POST", bob, { body: { provider: "openai", label: "x", secret: "sk-proj-abcdefghijklmnop", url: "https://evil.example" } });
out.missingSecret = await call(list, "POST", bob, { body: { provider: "openai", label: "x" } });
out.planViaForm = await call(list, "POST", bob, { body: { provider: "chatgpt-plan", label: "x" } });

// Cross-user: Bob can't see, change, test, list models of or revoke Alice's personal connection.
out.bobGet = (await call(one, "GET", bob, { path: "/api/agents/connections/" + aid, params: { id: aid } })).status;
out.bobPatch = (await call(one, "PATCH", bob, { path: "/api/agents/connections/" + aid, params: { id: aid }, body: { label: "mine now" } })).status;
out.bobRotate = (await call(one, "PATCH", bob, { path: "/api/agents/connections/" + aid, params: { id: aid }, body: { secret: "sk-ant-api03-stolen-attempt-xxxxxxxx" } })).status;
out.bobTest = (await call(testRoute, "POST", bob, { path: "/api/agents/connections/" + aid + "/test", params: { id: aid } })).status;
out.bobModels = (await call(modelsRoute, "GET", bob, { path: "/api/agents/models?connection=" + aid })).status;
out.bobDelete = (await call(one, "DELETE", bob, { path: "/api/agents/connections/" + aid, params: { id: aid } })).status;
out.bobList = (await call(list, "GET", bob)).json.connections.map((c) => c.id);
// The admin sees it (metadata) but can't use or change it; only revoke.
out.adminGet = (await call(one, "GET", admin, { path: "/api/agents/connections/" + aid, params: { id: aid } })).status;
out.adminPatch = (await call(one, "PATCH", admin, { path: "/api/agents/connections/" + aid, params: { id: aid }, body: { label: "x" } })).status;
out.adminTest = (await call(testRoute, "POST", admin, { path: "/api/agents/connections/" + aid + "/test", params: { id: aid } })).status;
out.adminAllList = (await call(list, "GET", admin, { path: "/api/agents/connections?all=1" })).json.connections.map((c) => c.id).includes(aid);
out.adminDefaultList = (await call(list, "GET", admin)).json.connections.map((c) => c.id).includes(aid);

// Rotation by the owner: the new key is sealed, the old one is gone, and nothing comes back.
const rot = await call(one, "PATCH", alice, { path: "/api/agents/connections/" + aid, params: { id: aid }, body: { secret: ${JSON.stringify(KEY2)}, label: "Alice Claude 2" } });
out.rotated = { status: rot.status, label: rot.json.connection?.label, hasSecret: rot.json.connection?.hasSecret };
const stored = await db.get("SELECT credential, key_version FROM agent_connections WHERE id = ?", [aid]);
out.sealed = { prefix: stored.credential.slice(0, 3), plaintext: stored.credential.includes("ROTATED") || stored.credential.includes("SENTINEL"), keyVersion: stored.key_version === broker.sealingKeyVersion() };
const conn = await broker.resolveConnection(aid, { kind: "test", user: alice });
out.adapterSecret = (await conn.secret()).apiKey === ${JSON.stringify(KEY2)};

// Admin registers a local endpoint (the stub) for OpenAI-compatible connections, personal use allowed.
out.badEndpoint = await call(list, "PUT", admin, { body: { endpoints: [{ url: "https://user:pw@proxy.example", label: "x", providers: ["openai"] }] } });
out.devRegisters = (await call(list, "PUT", bob, { body: { endpoints: [] } })).status;
out.linkLocal = await call(list, "PUT", admin, { body: { endpoints: [{ url: "http://169.254.169.254", label: "metadata", providers: ["openai-compatible"], local: true }] } });
out.publicAsLocal = await call(list, "PUT", admin, { body: { endpoints: [{ url: "http://93.184.216.34", label: "pub", providers: ["openai-compatible"], local: true }] } });
const reg = await call(list, "PUT", admin, { body: { endpoints: [
  { url: stubUrl + "/v1", label: "Stub", providers: ["openai-compatible"], local: true, personal: true },
  { url: "https://93.184.216.34", label: "Org proxy", providers: ["openai"], personal: false },
  { url: "https://93.184.216.35", label: "Unmarked proxy", providers: ["openai"] },
] } });
out.registered = { status: reg.status, endpoints: reg.json.endpoints?.map((e) => [e.id, e.local, e.personal, !!e.addedBy]) };

// Personal connections can't use a custom endpoint unless an admin registered it for personal use.
out.customUnregistered = await call(list, "POST", bob, { body: { provider: "openai", label: "x", secret: "sk-proj-abcdefghijklmnop", endpoint: "https://proxy.example.net" } });
out.orgOnlyEndpoint = await call(list, "POST", bob, { body: { provider: "openai", label: "x", secret: "sk-proj-abcdefghijklmnop", endpoint: "https://93.184.216.34" } });
out.unmarkedEndpoint = await call(list, "POST", bob, { body: { provider: "openai", label: "x", secret: "sk-proj-abcdefghijklmnop", endpoint: "https://93.184.216.35" } });
out.adminOrgEndpoint = (await call(list, "POST", admin, { body: { provider: "openai", label: "Org via proxy", scope: "org", secret: "sk-proj-abcdefghijklmnop", endpoint: "https://93.184.216.34" } })).status;
out.compatNoEndpoint = await call(list, "POST", bob, { body: { provider: "openai-compatible", label: "x", authKind: "none" } });

// Bob's personal compatible connection on the registered stub; its test fails with the key echoed back — scrubbed.
const compat = await call(list, "POST", bob, { body: { provider: "openai-compatible", label: "Stub model", secret: ${JSON.stringify(COMPAT_KEY)}, endpoint: stubUrl + "/v1/", model: "stub-1" } });
out.compat = { status: compat.status, egress: compat.json.connection?.egress, endpoint: compat.json.connection?.endpoint === stubUrl + "/v1" };
const cid = compat.json.connection.id;
const t = await call(testRoute, "POST", bob, { path: "/api/agents/connections/" + cid + "/test", params: { id: cid } });
out.compatTest = { status: t.status, ok: t.json.ok, errorKind: t.json.errorKind, hasError: typeof t.json.error === "string" && t.json.error.length > 0, stubSawKey: seen.some((s) => s.auth.includes("SENTINEL")) };
out.compatStatus = (await db.get("SELECT status FROM agent_connections WHERE id = ?", [cid])).status;
const m = await call(modelsRoute, "GET", bob, { path: "/api/agents/models?connection=" + cid });
out.compatModels = { status: m.status };

// The resolved connection's fetch() goes only to its endpoint: a model-supplied URL is refused before any request.
const bc = await broker.resolveConnection(cid, { kind: "test", user: bob });
const before = seen.length;
out.urlRefused = await Promise.all(["https://evil.example/steal", "//evil.example/x", "/v1/../../admin", "/v1/%2e%2e/x", "relative/path"].map((p) => settle(bc.fetch(p)).then((r) => r.name ?? r.status ?? "ok")));
out.stubHitByRefused = seen.length - before;
const okFetch = await bc.fetch("/models");
out.fixedPathStatus = okFetch.status;
out.scrubbed = await bc.scrub("echo " + ${JSON.stringify(COMPAT_KEY)} + " and part " + ${JSON.stringify(COMPAT_KEY.slice(5, 25))});
// An admin removes the entry: the connection an adapter still holds stops at its next request (nothing is sent).
const beforeUnregister = seen.length;
out.unregister = (await call(list, "PUT", admin, { body: { endpoints: [] } })).status;
out.afterUnregister = (await settle(bc.fetch("/models"))).code;
out.secretAfterUnregister = (await settle(bc.secret())).code;
out.stubHitAfterUnregister = seen.length - beforeUnregister;
out.withinEndpoint = [stubUrl + "/v1/chat", stubUrl + "/v2/chat", "https://evil.example/v1/chat"].map((u) => { try { egress.assertWithinEndpoint(stubUrl + "/v1", u); return "ok"; } catch (e) { return e.name; } });

// The built-in demo connection (simulated account): listed for everyone, read-only, usable, never stored.
const vl = await call(list, "GET", viewer);
const demo = vl.json.connections.find((c) => c.id === "scripted:demo");
out.demo = demo && { builtIn: demo.builtIn, scope: demo.scope, provider: demo.provider, model: demo.model, canEdit: demo.canEdit, canRevoke: demo.canRevoke, usable: demo.usable, payer: demo.payer };
out.demoPatch = (await call(one, "PATCH", admin, { path: "/api/agents/connections/scripted:demo", params: { id: "scripted:demo" }, body: { label: "x" } })).status;
out.demoDelete = (await call(one, "DELETE", admin, { path: "/api/agents/connections/scripted:demo", params: { id: "scripted:demo" } })).status;
out.demoRows = (await db.get("SELECT COUNT(*) AS n FROM agent_connections WHERE provider = 'scripted'")).n;
const demoTest = await call(testRoute, "POST", viewer, { path: "/api/agents/connections/scripted:demo/test", params: { id: "scripted:demo" } });
out.demoTest = { status: demoTest.status, ok: demoTest.json.ok };
const demoModels = await call(modelsRoute, "GET", viewer, { path: "/api/agents/models?connection=scripted:demo" });
out.demoModels = { status: demoModels.status, n: demoModels.json.models?.length };

// Revoke by the owner: the sealed secret is deleted and an API key's revocation is honestly "not confirmed".
const del = await call(one, "DELETE", alice, { path: "/api/agents/connections/" + aid, params: { id: aid }, body: { reason: "rotating providers" } });
out.revoked = { status: del.status, state: del.json.connection?.status, confirmed: del.json.connection?.revokeConfirmed, hasSecret: del.json.connection?.hasSecret, notes: del.json.connection?.notes?.length };
out.afterRevoke = await db.get("SELECT credential, key_version, status FROM agent_connections WHERE id = ?", [aid]);
out.useRevoked = await settle(broker.resolveConnection(aid, { kind: "test", user: alice }));
out.patchRevoked = (await call(one, "PATCH", alice, { path: "/api/agents/connections/" + aid, params: { id: aid }, body: { label: "again" } })).status;
out.deleteAgain = (await call(one, "DELETE", alice, { path: "/api/agents/connections/" + aid, params: { id: aid } })).status;

// The audit log: every change and every credential use, with ids and field names only.
const audit = await db.all("SELECT action, phase, actor, params FROM audit ORDER BY at");
out.auditActions = [...new Set(audit.map((a) => a.action))].sort();
out.auditText = JSON.stringify(audit);
out.bodies = bodies.join("\\n");
stub.close();
console.log(JSON.stringify(out));
`);
  assert.equal(o.tokenList, 403, "API tokens are refused");
  assert.equal(o.agentList, 403, "agent tokens are refused");
  assert.equal(o.created.status, 201);
  assert.ok(!o.created.keys.includes("secret") && !o.created.keys.includes("credential"), o.created.keys.join(","));
  assert.equal(o.created.conn.hasSecret, true);
  assert.equal(o.created.conn.scope, "personal");
  assert.equal(o.created.conn.owner, "alice@acme.test");
  assert.match(o.created.conn.payer, /alice@acme\.test's Anthropic API account/);
  assert.equal(o.created.conn.egress, "cloud");
  assert.deepEqual({ ...o.bedrock, payer: undefined }, { keys: 201, role: 201, payer: undefined, rolelessRefused: 400 });
  assert.match(o.bedrock.payer, /AWS account 210987654321 \(Bedrock, eu-west-1\)/);
  assert.deepEqual(o.bedrockSecret, { kind: "aws-role", sourceKey: true, region: "eu-west-1", endpoint: null }, "the adapter gets the role and the keys that assume it");
  assert.equal(o.orgByDev.status, 403, "only admins create organisation connections");
  assert.equal(o.runtimeByDev.status, 403, "only admins connect a local CLI");
  assert.equal(o.unknownField.status, 400);
  assert.equal(o.missingSecret.status, 400);
  assert.equal(o.planViaForm.status, 400, "plan connections are created by signing in (and off without the flag)");

  // §9.5 cross-user connection access
  assert.deepEqual([o.bobGet, o.bobPatch, o.bobRotate, o.bobTest, o.bobModels, o.bobDelete], [403, 403, 403, 403, 403, 403]);
  assert.ok(!o.bobList.includes(o.created.conn.id), "someone else's personal connection isn't listed");
  assert.equal(o.adminGet, 200);
  assert.equal(o.adminPatch, 403, "an admin can't change someone's personal connection");
  assert.equal(o.adminTest, 403, "an admin can't use someone's personal connection");
  assert.equal(o.adminAllList, true);
  assert.equal(o.adminDefaultList, false);

  assert.deepEqual(o.rotated, { status: 200, label: "Alice Claude 2", hasSecret: true });
  assert.deepEqual(o.sealed, { prefix: "v1:", plaintext: false, keyVersion: true });
  assert.equal(o.adapterSecret, true, "the adapter gets the rotated key through secret()");

  assert.equal(o.badEndpoint.status, 400, "credentials in an endpoint URL are refused");
  assert.equal(o.devRegisters, 403);
  assert.equal(o.linkLocal.status, 400, "metadata addresses can't be registered, even as local");
  assert.match(o.linkLocal.json.error, /link-local/);
  assert.equal(o.publicAsLocal.status, 400, "a local endpoint must be loopback/private");
  assert.equal(o.registered.status, 200, JSON.stringify(o.registered));
  assert.deepEqual(o.registered.endpoints.map((e: unknown[]) => e.slice(1)), [[true, true, true], [false, false, true], [false, false, true]]);

  // §9.5: a personal connection can't use a custom endpoint
  assert.equal(o.customUnregistered.status, 400);
  assert.match(o.customUnregistered.json.error, /isn't a registered endpoint/);
  assert.equal(o.orgOnlyEndpoint.status, 400);
  assert.match(o.orgOnlyEndpoint.json.error, /organisation connections only/);
  assert.equal(o.unmarkedEndpoint.status, 400, "an entry is organisation-only unless an admin marked it personal");
  assert.match(o.unmarkedEndpoint.json.error, /organisation connections only/);
  assert.equal(o.adminOrgEndpoint, 201);
  assert.equal(o.compatNoEndpoint.status, 400);

  assert.deepEqual(o.compat, { status: 201, egress: "local", endpoint: true });
  // §9.5 leaked diagnostics: the stub received the key and echoed it; the response is scrubbed.
  assert.equal(o.compatTest.status, 200);
  assert.equal(o.compatTest.ok, false);
  assert.equal(o.compatTest.hasError, true);
  assert.equal(o.compatTest.stubSawKey, true, `the stub really received (and echoed) the key: ${JSON.stringify(o.compatTest)}`);
  assert.equal(o.compatTest.errorKind, "auth");
  assert.equal(o.compatStatus, "needs_auth", "a refused credential marks the connection");
  assert.equal(o.compatModels.status, 502);

  // §9.4 a model-supplied URL is refused, before anything is sent
  assert.deepEqual(o.urlRefused, ["EgressRefused", "EgressRefused", "EgressRefused", "EgressRefused", "EgressRefused"]);
  assert.equal(o.stubHitByRefused, 0);
  assert.equal(o.fixedPathStatus, 401, "a fixed API path under the endpoint does reach it");
  assert.ok(!o.scrubbed.includes("Lw9Xz4Nv7Bm1Rt6"), o.scrubbed);
  assert.equal(o.unregister, 200);
  assert.equal(o.afterUnregister, "endpoint_unregistered", "a held connection re-checks the registry at each request");
  assert.equal(o.secretAfterUnregister, "endpoint_unregistered");
  assert.equal(o.stubHitAfterUnregister, 0);
  assert.deepEqual(o.withinEndpoint, ["ok", "EgressRefused", "EgressRefused"]);

  // the built-in demo connection
  assert.deepEqual(o.demo, { builtIn: true, scope: "org", provider: "scripted", model: "incident-demo", canEdit: false, canRevoke: false, usable: true, payer: o.demo.payer });
  assert.match(o.demo.payer, /no provider, no cost/);
  assert.equal(o.demoPatch, 403);
  assert.equal(o.demoDelete, 403);
  assert.equal(o.demoRows, 0, "never stored");
  assert.deepEqual(o.demoTest, { status: 200, ok: true });
  assert.equal(o.demoModels.status, 200);
  assert.ok(o.demoModels.n >= 1);

  assert.equal(o.revoked.status, 200);
  assert.equal(o.revoked.state, "revoked");
  assert.equal(o.revoked.confirmed, false, "an API key can't be revoked from here; the console says so");
  assert.equal(o.revoked.hasSecret, false);
  assert.ok(o.revoked.notes >= 1);
  assert.deepEqual(o.afterRevoke, { credential: null, key_version: null, status: "revoked" });
  assert.equal(o.useRevoked.code, "connection_revoked");
  assert.equal(o.patchRevoked, 409);
  assert.equal(o.deleteAgain, 200, "revoking twice is harmless");

  for (const a of ["connection.create", "connection.rotate", "connection.revoke", "credential.use", "agents.connection-settings"]) assert.ok(o.auditActions.includes(a), `${a} audited: ${o.auditActions}`);
  // §9.5: no secret in any route response, error or audit row
  assert.deepEqual(leaks(o.bodies), [], "route responses");
  assert.deepEqual(leaks(o.auditText), [], "audit rows");
});

test("runs: bound to their connection, delegator re-read, background use, disconnect pauses waiting runs (no fallback)", () => {
  const o = run(`${prelude}
const out = {};
const actor = (u) => ({ user: u });
const conn = await broker.createConnection({ provider: "anthropic", label: "Alice", secret: ${JSON.stringify(KEY)}, backgroundOk: false }, actor(alice));
const other = await broker.createConnection({ provider: "openai", label: "Alice 2", secret: "sk-proj-abcdefghijklmnopqrstu" }, actor(alice));
const org = await broker.createConnection({ provider: "anthropic", label: "Org", scope: "org", secret: ${JSON.stringify(KEY)}, minRole: "developer", backgroundOk: true }, actor(admin));
await insertRun("r-wait", conn.id, "waiting_approval", alice.id);
await insertRun("r-run", conn.id, "running", alice.id);
await insertRun("r-budget", conn.id, "paused_budget", alice.id);
await insertRun("r-done", conn.id, "succeeded", alice.id);
await insertRun("r-other", other.id, "waiting_approval", alice.id);
await insertRun("r-bob", conn.id, "running", bob.id);
await insertRun("r-wf", conn.id, "running", alice.id, "workflow");
await insertRun("r-org", org.id, "running", bob.id);
await insertRun("r-org-viewer", org.id, "running", viewer.id);

const use = (id, runId, principal) => settle(broker.resolveConnection(id, { kind: "run", runId, ...(principal ? { principal } : {}) }).then((c) => ({ provider: c.provider, purpose: c.purpose, runId: c.runId, payer: c.payer })));
out.ok = await use(conn.id, "r-wait");
out.mismatch = await use(other.id, "r-wait"); // a run never switches to another connection
out.someoneElses = await use(conn.id, "r-bob"); // Bob's run can't use Alice's personal connection
out.spoofed = await use(conn.id, "r-wait", { delegatorId: bob.id, runId: "r-wait" });
out.finished = await use(conn.id, "r-done");
out.missingRun = await use(conn.id, "r-nope");
out.background = await use(conn.id, "r-wf"); // a workflow run is background use; this connection doesn't allow it
out.orgDev = await use(org.id, "r-org");
const heldOrg = await broker.resolveConnection(org.id, { kind: "run", runId: "r-org" }); // an adapter holding the connection
out.orgViewer = await use(org.id, "r-org-viewer"); // below the connection's minRole
// Demotion and disabling take effect at the next call.
await db.run("UPDATE users SET role = 'viewer' WHERE id = ?", [bob.id]);
out.orgDemoted = await use(org.id, "r-org");
out.heldDemoted = (await settle(heldOrg.secret())).code;
await db.run("UPDATE users SET role = 'developer', disabled = 1 WHERE id = ?", [bob.id]);
out.orgDisabled = await use(org.id, "r-org");
// The organisation's policy: local egress only.
await db.run("INSERT INTO settings (key, value) VALUES ('agents:connection-policy', ?)", [JSON.stringify({ localOnly: true })]);
out.localOnly = await use(conn.id, "r-wait");
await db.run("DELETE FROM settings WHERE key = 'agents:connection-policy'");

// secret() re-reads: a rotation applies to the next request, a revoke stops it, and so does a cancelled run.
const live = await broker.resolveConnection(conn.id, { kind: "run", runId: "r-wait" });
await insertRun("r-cancel", conn.id, "running", alice.id);
const heldRun = await broker.resolveConnection(conn.id, { kind: "run", runId: "r-cancel" });
await db.run("UPDATE agent_runs SET state = 'cancelled' WHERE id = ?", ["r-cancel"]);
out.heldCancelled = (await settle(heldRun.secret())).code;
await broker.rotateConnection(conn.id, ${JSON.stringify(KEY2)}, actor(alice));
out.afterRotate = (await live.secret()).apiKey === ${JSON.stringify(KEY2)};
// Concurrent rotations (token refresh): only one of two swaps based on the same version wins.
const v0 = (await db.get("SELECT updated_at FROM agent_connections WHERE id = ?", [conn.id])).updated_at;
const swaps = await Promise.all([broker.rotateConnection(conn.id, "sk-ant-api03-refresh-one-xxxxxxxx", "system", { ifUpdatedAt: v0 }), broker.rotateConnection(conn.id, "sk-ant-api03-refresh-two-xxxxxxxx", "system", { ifUpdatedAt: v0 })].map(settle));
out.swaps = swaps.map((s) => (s.ok ? "ok" : s.status)).sort();

// §9.5 disconnect while a run waits → paused_auth; finished runs and runs on other connections are untouched.
const changes = [];
const off = broker.onConnectionChange((e) => changes.push(e));
broker.onConnectionChange(() => { throw new Error("a broken listener"); });
const del = await call(one, "DELETE", alice, { path: "/api/agents/connections/" + conn.id, params: { id: conn.id } });
out.paused = del.json.pausedRuns.sort();
off();
out.changes = changes.map((e) => [e.type, e.connectionId === conn.id, (e.pausedRuns ?? []).length]);
out.states = Object.fromEntries(await Promise.all(["r-wait", "r-run", "r-budget", "r-done", "r-other", "r-bob", "r-wf"].map(async (id) => [id, (await runState(id)).state])));
out.pausedWhy = (await runState("r-wait")).error;
// Each pause publishes a persisted \`run\` event (the run timeline and SSE clients see it), committed with the revoke.
out.pauseEvents = (await db.all("SELECT run_id, payload FROM events WHERE type = 'run' ORDER BY seq")).map((e) => [e.run_id, JSON.parse(e.payload).state, JSON.parse(e.payload).previous]).filter((e) => e[1] === "paused_auth").sort();
out.liveAfterRevoke = await settle(live.secret());
out.resumeAttempt = await use(conn.id, "r-wait");
out.otherStillWorks = await use(other.id, "r-other");
console.log(JSON.stringify(out));
`);
  assert.deepEqual(o.ok.ok.provider, "anthropic");
  assert.equal(o.ok.ok.purpose, "run");
  assert.match(o.ok.ok.payer, /alice@acme\.test's Anthropic/);
  assert.equal(o.mismatch.code, "connection_mismatch");
  assert.equal(o.someoneElses.code, "connection_forbidden");
  assert.equal(o.spoofed.code, "delegator_mismatch");
  assert.equal(o.finished.code, "run_finished");
  assert.equal(o.missingRun.code, "run_not_found");
  assert.equal(o.background.code, "background_not_allowed");
  assert.ok(o.orgDev.ok, JSON.stringify(o.orgDev));
  assert.equal(o.orgViewer.code, "connection_forbidden");
  assert.equal(o.orgDemoted.code, "connection_forbidden", "a demotion applies at the next call");
  assert.equal(o.heldDemoted, "connection_forbidden", "…including for an adapter already holding the connection");
  assert.equal(o.heldCancelled, "run_finished", "a cancelled run's held connection gets no secret");
  assert.equal(o.orgDisabled.code, "delegator_inactive");
  assert.equal(o.localOnly.code, "policy_egress");
  assert.equal(o.afterRotate, true);
  assert.deepEqual(o.swaps, [409, "ok"], "one refresh wins, the other is refused instead of overwriting it");
  assert.deepEqual(o.paused, ["r-bob", "r-run", "r-wait", "r-wf"]);
  assert.deepEqual(o.changes, [["revoked", true, 4]], "listeners hear the revoke (a throwing listener doesn't stop it)");
  assert.deepEqual(o.states, { "r-wait": "paused_auth", "r-run": "paused_auth", "r-budget": "paused_budget", "r-done": "succeeded", "r-other": "waiting_approval", "r-bob": "paused_auth", "r-wf": "paused_auth" });
  assert.deepEqual(o.pauseEvents, [["r-bob", "paused_auth", "running"], ["r-run", "paused_auth", "running"], ["r-wait", "paused_auth", "waiting_approval"], ["r-wf", "paused_auth", "running"]], "every pause publishes a run event");
  assert.match(o.pausedWhy, /disconnected/);
  assert.match(o.pausedWhy, /never switch/);
  assert.equal(o.liveAfterRevoke.code, "connection_revoked", "an adapter holding the connection can't get the secret any more");
  assert.equal(o.resumeAttempt.code, "connection_revoked", "no fallback");
  assert.ok(o.otherStillWorks.ok);
});

test("with a real AWS account there is no scripted:demo connection and no scripted provider", () => {
  const o = run(
    `${prelude}
const out = {};
const l = await call(list, "GET", admin);
out.ids = l.json.connections.map((c) => c.id);
out.providers = l.json.providers.map((p) => p.id);
out.get = (await call(one, "GET", admin, { path: "/api/agents/connections/scripted:demo", params: { id: "scripted:demo" } })).status;
out.test = (await call(testRoute, "POST", admin, { path: "/api/agents/connections/scripted:demo/test", params: { id: "scripted:demo" } })).status;
out.resolve = (await settle(broker.resolveConnection("scripted:demo", { kind: "test", user: admin }))).code;
out.create = await call(list, "POST", admin, { body: { provider: "scripted", label: "x" } });
// The form offers only what the POST accepts: with organisation connections only, a developer can create nothing.
out.policy = (await call(list, "PUT", admin, { body: { policy: { personal: false } } })).status;
const opt = async (who) => Object.fromEntries((await call(list, "GET", who)).json.providers.map((p) => [p.id, p.canCreate ? "yes" : p.why]));
out.bobOptions = await opt(bob);
out.adminOptions = await opt(admin);
out.bobCreate = (await call(list, "POST", bob, { body: { provider: "anthropic", label: "x", secret: ${JSON.stringify(KEY)} } })).status;
console.log(JSON.stringify(out));
`,
    { CONSOLE_SOURCE: "aws", AWS_REGION: "us-east-1" },
  );
  assert.ok(!o.ids.includes("scripted:demo"));
  assert.ok(!o.providers.includes("scripted"));
  assert.ok(!o.providers.includes("chatgpt-plan"), "the plan connection is off unless CONSOLE_CHATGPT_PLAN=eligible");
  assert.equal(o.get, 404);
  assert.equal(o.test, 404);
  assert.equal(o.resolve, "connection_not_found");
  assert.equal(o.create.status, 400);
  assert.match(o.create.json.error, /simulated account/);
  assert.equal(o.policy, 200);
  assert.equal(o.bobCreate, 400);
  assert.match(o.bobOptions.anthropic, /organisation connections only — an admin creates them/);
  assert.equal(o.adminOptions.anthropic, "yes");
  assert.match(o.adminOptions["runtime:claude-code"], /organisation connections only$/, "a personal sign-in can't be an organisation connection");
});
