// The ChatGPT-plan sign-in through the server module (src/lib/server/agents/chatgpt-plan.ts) and the credential broker,
// against a throwaway provider on a loopback port (discovery, key set, token, revocation, models): off unless the flag
// says eligible; the callback only on 127.0.0.1; the installation host id kept and reused; the connection bound to the
// ChatGPT subject and client registration (never an email) with its tokens sealed; a re-authorisation to another
// account refused (and the session it opened signed out again); disconnect revoking at the provider and recording
// whether it was confirmed. The server modules import "server-only", so the scenario runs in a child process with an
// in-memory database.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const server = (p: string) => JSON.stringify(new URL(`../../server/agents/${p}`, import.meta.url).href);
const lib = (p: string) => JSON.stringify(new URL(`../../${p}`, import.meta.url).href);

const scenario = `
import http from "node:http";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
const key = await generateKeyPair("RS256");
const jwk = { ...(await exportJWK(key.publicKey)), kid: "k1", alg: "RS256", use: "sig" };
const seen = { token: [], revoke: [], models: [] };
let nextSub = "sub-ada-1";
let pendingNonce = "";
let revokeStatus = 200;
let n = 0;
const srv = http.createServer(async (req, res) => {
  let raw = ""; for await (const c of req) raw += c;
  const send = (s, b) => res.writeHead(s, { "content-type": "application/json" }).end(JSON.stringify(b));
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/.well-known/openid-configuration") return send(200, { issuer: ISSUER, jwks_uri: ISSUER + "/jwks", revocation_endpoint: ISSUER + "/revoke" });
  if (url.pathname === "/jwks") return send(200, { keys: [jwk] });
  if (url.pathname === "/token") {
    const b = Object.fromEntries(new URLSearchParams(raw)); seen.token.push(b); n++;
    const id = await new SignJWT({ nonce: pendingNonce, email: "ada@acme.io", "https://api.openai.com/auth": { chatgpt_plan_type: "pro" } })
      .setProtectedHeader({ alg: "RS256", kid: "k1" }).setIssuer(ISSUER).setAudience(b.client_id).setSubject(nextSub).setIssuedAt().setExpirationTime("5m").sign(key.privateKey);
    return send(200, { access_token: "at_SENTINEL_" + n, refresh_token: "rt_SENTINEL_" + n, id_token: id, token_type: "Bearer", expires_in: 3600, scope: "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct" });
  }
  if (url.pathname === "/revoke") { seen.revoke.push(Object.fromEntries(new URLSearchParams(raw))); return res.writeHead(revokeStatus).end(); }
  if (url.pathname === "/v1/models") { seen.models.push(req.headers.authorization); return send(200, { models: [{ slug: "gpt-6.1-sol", display_name: "GPT-6.1 Sol", visibility: "list" }] }); }
  send(404, {});
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const ISSUER = "http://127.0.0.1:" + srv.address().port;
Object.assign(process.env, {
  CONSOLE_CHATGPT_ISSUER: ISSUER, CONSOLE_CHATGPT_AUTHORIZE_URL: ISSUER + "/authorize", CONSOLE_CHATGPT_TOKEN_URL: ISSUER + "/token", CONSOLE_CHATGPT_API_BASE: ISSUER + "/v1",
});
const plan = await import(${server("chatgpt-plan.ts")});
const cred = await import(${server("credentials.ts")});
const { getDb } = await import(${lib("server/db.ts")});
const out = {};
const ada = { id: "u-ada", email: "ada@acme.io", role: "developer" };
const eve = { id: "u-eve", email: "eve@acme.io", role: "developer" };
const status = async (p) => { try { await p; return "ok"; } catch (e) { return e.status ?? e.code ?? e.message; } };
const db = await getDb();
for (const u of [ada, eve]) await db.run("INSERT INTO users (id, email, name, role, disabled, created_at) VALUES (?, ?, ?, ?, 0, ?)", [u.id, u.email, u.email, u.role, Date.now()]);

delete process.env.CONSOLE_CHATGPT_PLAN;
out.off = await status(plan.startSignIn(ada, "http://127.0.0.1:3200"));
out.offAdapter = await status(plan.chatgptPlanAdapter.generate({ id: "x" }, { messages: [] }));
process.env.CONSOLE_CHATGPT_PLAN = "eligible";
out.notLoopback = await status(plan.startSignIn(ada, "http://localhost:3200"));
out.hosted = await status(plan.startSignIn(ada, "https://console.acme.io"));

const s1 = await plan.startSignIn(ada, "http://127.0.0.1:3200");
const s2 = await plan.startSignIn(ada, "http://127.0.0.1:3311");
out.authorize = Object.fromEntries(new URL(s1.url).searchParams);
out.hostIdStable = s1.flow.hostId === s2.flow.hostId;
out.hostIdSetting = (await db.get("SELECT value FROM settings WHERE key = 'agents:host-id'")).value === s1.flow.hostId;
out.flow2Redirect = s2.flow.redirectUri;

// Someone else can't finish Ada's sign-in.
pendingNonce = s1.flow.nonce;
const q1 = new URLSearchParams({ state: s1.flow.state, code: "code-1", client_id: "oaiapp_ada", scope: "openid chatgpt.tokens.use.direct" });
out.otherPerson = await status(plan.finishSignIn(q1, s1.flow, eve));
out.wrongState = await status(plan.finishSignIn(new URLSearchParams({ state: "nope", code: "c", client_id: "oaiapp_ada" }), s1.flow, ada));
const done = await plan.finishSignIn(q1, s1.flow, ada, "127.0.0.1");
out.created = done.created;
const row = await db.get("SELECT provider, auth_kind, scope, owner_id, binding, credential, status FROM agent_connections WHERE id = ?", [done.connectionId]);
out.row = { provider: row.provider, authKind: row.auth_kind, scope: row.scope, owner: row.owner_id, status: row.status, binding: JSON.parse(row.binding), sealed: row.credential.startsWith("v1:") && !row.credential.includes("SENTINEL") };
out.exchange = seen.token[0];
const view = (await cred.listConnections(ada)).find((c) => c.id === done.connectionId);
out.view = { account: view.account, payer: view.payer, json: JSON.stringify(view) };

// Through the broker: the adapter reads the token record and calls the plan API with it.
const conn = await cred.resolveConnection(done.connectionId, { kind: "models", user: ada });
out.models = (await plan.chatgptPlanAdapter.models(conn)).map((m) => m.id);
out.modelsAuth = seen.models[0];

// Signing in again to the same connection with another ChatGPT account is refused, and that session is signed out.
const r1 = await plan.startSignIn(ada, "http://127.0.0.1:3200", done.connectionId);
out.reauthClient = r1.flow.clientId;
out.reauthNoHint = !new URL(r1.url).searchParams.has("agent_name_hint");
pendingNonce = r1.flow.nonce;
nextSub = "sub-someone-else";
const revokesBefore = seen.revoke.length;
let reauthErr;
try { await plan.finishSignIn(new URLSearchParams({ state: r1.flow.state, code: "code-2" }), r1.flow, ada); } catch (e) { reauthErr = e; }
out.reauthOther = plan.signInErrorCode(reauthErr);
out.reauthSignedOut = seen.revoke.slice(revokesBefore).map((b) => b.token);
out.eveReauth = await status(plan.startSignIn(eve, "http://127.0.0.1:3200", done.connectionId));
// The same account again works and rotates the tokens.
const r2 = await plan.startSignIn(ada, "http://127.0.0.1:3200", done.connectionId);
pendingNonce = r2.flow.nonce;
nextSub = "sub-ada-1";
out.reauthSame = (await plan.finishSignIn(new URLSearchParams({ state: r2.flow.state, code: "code-3" }), r2.flow, ada)).created;
const latest = await (await cred.resolveConnection(done.connectionId, { kind: "test", user: ada })).tokens.read();
out.rotatedTo = latest.tokens.access_token;

// Disconnect: confirmed by the provider → revoke_confirmed 1; refused → 0, said honestly.
const rv = await cred.revokeConnection(done.connectionId, { user: ada });
out.revoke = { lastToken: seen.revoke.at(-1), confirmed: (await db.get("SELECT revoke_confirmed, credential FROM agent_connections WHERE id = ?", [done.connectionId])) };
const s3 = await plan.startSignIn(ada, "http://127.0.0.1:3200");
pendingNonce = s3.flow.nonce;
const second = await plan.finishSignIn(new URLSearchParams({ state: s3.flow.state, code: "code-4", client_id: "oaiapp_ada2" }), s3.flow, ada);
revokeStatus = 400;
await cred.revokeConnection(second.connectionId, { user: ada });
out.unconfirmed = (await db.get("SELECT revoke_confirmed, credential FROM agent_connections WHERE id = ?", [second.connectionId]));
const audit = await db.all("SELECT action, params, detail FROM audit ORDER BY at");
out.auditLeak = JSON.stringify(audit).includes("SENTINEL");
out.auditActions = [...new Set(audit.map((a) => a.action))];
srv.close();
console.log(JSON.stringify(out));
process.exit(0);
`;

const dir = mkdtempSync(path.join(tmpdir(), "chatgpt-plan-test-"));
// The scenario's report: loosely typed JSON, read only by the assertions below.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let out: Record<string, any>;
try {
  const stdout = execFileSync(process.execPath, ["--conditions=react-server", "--no-warnings", "--input-type=module", "-e", scenario], {
    // The scenario imports "jose" by name, which resolves from the working directory: the repository root.
    cwd: fileURLToPath(new URL("../../../../", import.meta.url)),
    encoding: "utf8",
    env: { ...process.env, CONSOLE_SOURCE: "mock", CONSOLE_SQLITE_PATH: ":memory:", CONSOLE_DATA_DIR: dir, CONSOLE_SECRET_KEY: "x".repeat(40), CONSOLE_CONFIG: "", AUTH_MODE: "dev", NODE_ENV: "test" },
    timeout: 90_000,
    maxBuffer: 16 << 20,
  });
  out = JSON.parse(stdout.trim().split("\n").pop()!);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

test("off unless CONSOLE_CHATGPT_PLAN=eligible; the sign-in starts only on 127.0.0.1", () => {
  assert.equal(out.off, 404);
  assert.equal(out.offAdapter, "disabled");
  assert.equal(out.notLoopback, "loopback");
  assert.equal(out.hosted, "loopback");
});

test("start: a first registration with the installation host id, which is kept and reused", () => {
  assert.equal(out.authorize.client_id, "dynamic_agent_client");
  assert.equal(out.authorize.agent_name_hint, "Deployment Console");
  assert.equal(out.authorize.code_challenge_method, "S256");
  assert.match(out.authorize.ext_agent_host_id, /^dch_/);
  assert.equal(out.hostIdStable, true);
  assert.equal(out.hostIdSetting, true);
  assert.equal(out.flow2Redirect, "http://127.0.0.1:3311/api/agents/oauth/chatgpt/callback", "only the port changes");
});

test("callback: only the person who started it, only with the right state; the connection is bound to subject + client, tokens sealed", () => {
  assert.equal(out.otherPerson, "state");
  assert.equal(out.wrongState, "state");
  assert.equal(out.created, true);
  assert.deepEqual(out.row.binding, { subject: "sub-ada-1", clientRegistrationId: "oaiapp_ada", installationHostId: out.authorize.ext_agent_host_id, plan: "pro" });
  assert.ok(!JSON.stringify(out.row.binding).includes("@"), "never an email");
  assert.deepEqual([out.row.provider, out.row.authKind, out.row.scope, out.row.owner, out.row.status, out.row.sealed], ["chatgpt-plan", "oauth-plan", "personal", "u-ada", "active", true]);
  assert.equal(out.exchange.client_id, "oaiapp_ada");
  assert.equal(out.exchange.redirect_uri, "http://127.0.0.1:3200/api/agents/oauth/chatgpt/callback");
  assert.equal(out.exchange.resource, "https://api.openai.com/v1");
  assert.deepEqual(out.view.account, { subject: "sub-ada-1", plan: "pro" });
  assert.ok(!out.view.json.includes("SENTINEL"), "no token in the connection view");
});

test("the adapter uses the sealed sign-in through the broker", () => {
  assert.deepEqual(out.models, ["gpt-6.1-sol"]);
  assert.equal(out.modelsAuth, "Bearer at_SENTINEL_1");
});

test("re-authorisation: the connection's own client registration; another account is refused and its new session signed out", () => {
  assert.equal(out.reauthClient, "oaiapp_ada");
  assert.equal(out.reauthNoHint, true);
  assert.equal(out.reauthOther, "account");
  assert.deepEqual(out.reauthSignedOut, ["rt_SENTINEL_2"]);
  assert.equal(out.eveReauth, 403);
  assert.equal(out.reauthSame, false);
  assert.equal(out.rotatedTo, "at_SENTINEL_3");
});

test("disconnect revokes at the provider and records honestly whether it was confirmed", () => {
  assert.equal(out.revoke.lastToken.token, "rt_SENTINEL_3");
  assert.equal(out.revoke.lastToken.token_type_hint, "refresh_token");
  assert.equal(out.revoke.lastToken.client_id, "oaiapp_ada");
  assert.deepEqual(out.revoke.confirmed, { revoke_confirmed: 1, credential: null });
  assert.deepEqual(out.unconfirmed, { revoke_confirmed: 0, credential: null });
  assert.equal(out.auditLeak, false, "no token in the audit log");
  assert.ok(out.auditActions.includes("connection.create") && out.auditActions.includes("connection.revoke"));
});

// A disconnect in a bundle that never loaded chatgpt-plan.ts (so its revoker isn't registered yet): the broker loads it
// on demand, so the session is still signed out at the provider instead of being recorded as unconfirmed.
const coldScenario = `
import http from "node:http";
const seen = [];
const srv = http.createServer(async (req, res) => {
  let raw = ""; for await (const c of req) raw += c;
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/.well-known/openid-configuration") return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ issuer: ISSUER, jwks_uri: ISSUER + "/jwks", revocation_endpoint: ISSUER + "/revoke" }));
  if (url.pathname === "/revoke") { seen.push(Object.fromEntries(new URLSearchParams(raw))); return res.writeHead(200).end(); }
  res.writeHead(404).end();
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const ISSUER = "http://127.0.0.1:" + srv.address().port;
Object.assign(process.env, { CONSOLE_CHATGPT_PLAN: "eligible", CONSOLE_CHATGPT_ISSUER: ISSUER, CONSOLE_CHATGPT_AUTHORIZE_URL: ISSUER + "/authorize", CONSOLE_CHATGPT_TOKEN_URL: ISSUER + "/token", CONSOLE_CHATGPT_API_BASE: ISSUER + "/v1" });
const cred = await import(${server("credentials.ts")});
const { getDb } = await import(${lib("server/db.ts")});
const db = await getDb();
const ada = { id: "u-ada", email: "ada@acme.io", role: "developer" };
await db.run("INSERT INTO users (id, email, name, role, disabled, created_at) VALUES (?, ?, ?, ?, 0, ?)", [ada.id, ada.email, ada.email, ada.role, Date.now()]);
const tokens = { access_token: "at_SENTINEL_cold", refresh_token: "rt_SENTINEL_cold", token_type: "Bearer", expires_at: Date.now() + 3600_000, scope: "chatgpt.tokens.use.direct", client_id: "oaiapp_ada", obtained_at: Date.now() };
const view = await cred.createConnection({ provider: "chatgpt-plan", authKind: "oauth-plan", label: "ChatGPT pro plan", scope: "personal", secret: { tokens } }, { user: ada }, { via: "oauth", binding: { subject: "sub-ada-1", clientRegistrationId: "oaiapp_ada", installationHostId: "dch_" + "a".repeat(32) } });
const out = { registeredBefore: globalThis.__consoleRemoteRevoke?.has("chatgpt-plan") ?? false };
await cred.revokeConnection(view.id, { user: ada });
out.revoked = seen.map((b) => b.token);
out.row = await db.get("SELECT revoke_confirmed, credential FROM agent_connections WHERE id = ?", [view.id]);
srv.close();
console.log(JSON.stringify(out));
process.exit(0);
`;

test("disconnect in a bundle that never loaded the plan module still signs out at the provider", () => {
  const dir2 = mkdtempSync(path.join(tmpdir(), "chatgpt-plan-cold-"));
  try {
    const stdout = execFileSync(process.execPath, ["--conditions=react-server", "--no-warnings", "--input-type=module", "-e", coldScenario], {
      cwd: fileURLToPath(new URL("../../../../", import.meta.url)),
      encoding: "utf8",
      env: { ...process.env, CONSOLE_SOURCE: "mock", CONSOLE_SQLITE_PATH: ":memory:", CONSOLE_DATA_DIR: dir2, CONSOLE_SECRET_KEY: "x".repeat(40), CONSOLE_CONFIG: "", AUTH_MODE: "dev", NODE_ENV: "test" },
      timeout: 90_000,
    });
    const cold = JSON.parse(stdout.trim().split("\n").pop()!);
    assert.equal(cold.registeredBefore, false, "the scenario starts without the plan module loaded");
    assert.deepEqual(cold.revoked, ["rt_SENTINEL_cold"]);
    assert.deepEqual(cold.row, { revoke_confirmed: 1, credential: null });
  } finally {
    rmSync(dir2, { recursive: true, force: true });
  }
});
