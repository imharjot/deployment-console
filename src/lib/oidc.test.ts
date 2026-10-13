import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { SignJWT, exportJWK, generateKeyPair, type JWTPayload } from "jose";
import { OidcError, authorizeUrl, discover, emailVerified, exchangeCode, pkcePair, remoteKeys, sameValue, subjectDecision, verifyIdToken, type Discovery } from "./oidc.ts";

// ---- a throwaway OpenID provider: discovery, JWKS, and a token endpoint that enforces PKCE + client auth ----
const CLIENT = "console-client";
const SECRET = "s3cret:with/odd chars";
const REDIRECT = "http://localhost:3200/api/auth/oidc/callback";
const good = await generateKeyPair("RS256");
const evil = await generateKeyPair("RS256");
const jwk = { ...(await exportJWK(good.publicKey)), kid: "k1", alg: "RS256", use: "sig" };

let issuer = "";
const grants = new Map<string, { challenge: string; claims: JWTPayload }>();

async function idToken(claims: JWTPayload = {}, key: CryptoKey | Uint8Array = good.privateKey, alg = "RS256") {
  return new SignJWT({ email: "ada@acme.io", email_verified: true, name: "Ada Lovelace", nonce: "n-1", ...claims })
    .setProtectedHeader({ alg, kid: "k1" })
    .setIssuer((claims.iss as string) ?? issuer)
    .setAudience((claims.aud as string | string[]) ?? CLIENT)
    .setSubject("user-1")
    .setIssuedAt()
    .setExpirationTime((claims.exp as number) ?? "5m")
    .sign(key);
}

const server = http.createServer(async (req, res) => {
  const send = (status: number, body: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
  const url = new URL(req.url!, issuer);
  if (url.pathname === "/.well-known/openid-configuration")
    return send(200, { issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks`, token_endpoint_auth_methods_supported: ["client_secret_basic"] });
  if (url.pathname === "/jwks") return send(200, { keys: [jwk] });
  if (url.pathname === "/token" && req.method === "POST") {
    let raw = "";
    for await (const c of req) raw += c;
    const body = new URLSearchParams(raw);
    const [id, secret] = Buffer.from((req.headers.authorization ?? "").replace(/^Basic /, ""), "base64").toString().split(":").map(decodeURIComponent);
    if (id !== CLIENT || secret !== SECRET) return send(401, { error: "invalid_client" });
    const g = grants.get(body.get("code") ?? "");
    grants.delete(body.get("code") ?? ""); // single use
    if (!g || body.get("grant_type") !== "authorization_code" || body.get("redirect_uri") !== REDIRECT) return send(400, { error: "invalid_grant" });
    const challenge = createHash("sha256").update(body.get("code_verifier") ?? "").digest("base64url");
    if (challenge !== g.challenge) return send(400, { error: "invalid_grant", error_description: "PKCE verification failed" });
    return send(200, { id_token: await idToken(g.claims), access_token: "at", token_type: "Bearer" });
  }
  send(404, { error: "not_found" });
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(() => {
  server.closeAllConnections();
  server.close();
});

// The provider's side of /authorize: remember the challenge and nonce for the code it hands back.
function grant(authUrl: string, claims: JWTPayload = {}) {
  const q = new URL(authUrl).searchParams;
  const code = `code-${grants.size}-${Math.random()}`;
  grants.set(code, { challenge: q.get("code_challenge")!, claims: { nonce: q.get("nonce")!, ...claims } });
  return code;
}

async function signIn(claims: JWTPayload = {}) {
  const d = await discover(issuer);
  const { verifier, challenge } = pkcePair();
  const url = authorizeUrl(d, { clientId: CLIENT, redirectUri: REDIRECT, scope: "openid email profile", state: "st-1", nonce: "n-1", challenge });
  const code = grant(url, claims);
  const { id_token } = await exchangeCode(d, { code, verifier, redirectUri: REDIRECT, clientId: CLIENT, clientSecret: SECRET });
  return verifyIdToken(id_token, { issuer: d.issuer, clientId: CLIENT, nonce: "n-1", keys: remoteKeys(d.jwks_uri) });
}

const rejects = async (p: Promise<unknown>, code: OidcError["code"], msg?: RegExp) => {
  await assert.rejects(p, (e: unknown) => e instanceof OidcError && e.code === code && (!msg || msg.test(e.message)));
};

test("discovery + PKCE authorize URL carry every required parameter", async () => {
  const d = await discover(`${issuer}/`);
  assert.equal(d.token_endpoint, `${issuer}/token`);
  const { verifier, challenge } = pkcePair();
  assert.equal(createHash("sha256").update(verifier).digest("base64url"), challenge);
  const q = new URL(authorizeUrl(d, { clientId: CLIENT, redirectUri: REDIRECT, scope: "openid email", state: "S", nonce: "N", challenge })).searchParams;
  assert.deepEqual(Object.fromEntries(q), { response_type: "code", client_id: CLIENT, redirect_uri: REDIRECT, scope: "openid email", state: "S", nonce: "N", code_challenge: challenge, code_challenge_method: "S256" });
});

test("full code flow: exchange with client_secret_basic + PKCE, id_token verified against the remote JWKS", async () => {
  assert.deepEqual(await signIn({ email: "Ada@Acme.io" }), { sub: "user-1", email: "ada@acme.io", name: "Ada Lovelace" });
});

test("token endpoint refusals surface as OidcError(token): PKCE mismatch, replayed code, bad client secret", async () => {
  const d = await discover(issuer);
  const p = pkcePair();
  const url = authorizeUrl(d, { clientId: CLIENT, redirectUri: REDIRECT, scope: "openid", state: "s", nonce: "n-1", challenge: p.challenge });
  const code = grant(url);
  await rejects(exchangeCode(d, { code, verifier: pkcePair().verifier, redirectUri: REDIRECT, clientId: CLIENT, clientSecret: SECRET }), "token", /invalid_grant/);
  await rejects(exchangeCode(d, { code, verifier: p.verifier, redirectUri: REDIRECT, clientId: CLIENT, clientSecret: SECRET }), "token", /invalid_grant/);
  const code2 = grant(url);
  await rejects(exchangeCode(d, { code: code2, verifier: p.verifier, redirectUri: REDIRECT, clientId: CLIENT, clientSecret: "wrong" }), "token", /invalid_client/);
});

test("discovery refuses a document that names a different issuer", async () => {
  const fake = (async () => Response.json({ issuer: "https://evil.example", authorization_endpoint: "https://evil.example/a", token_endpoint: "https://evil.example/t", jwks_uri: "https://evil.example/j" })) as typeof fetch;
  await rejects(discover("https://idp.example", fake), "discovery", /issuer mismatch/);
  const noJwks = (async () => Response.json({ issuer: "https://idp.example", authorization_endpoint: "https://idp.example/a", token_endpoint: "https://idp.example/t" })) as typeof fetch;
  await rejects(discover("https://idp.example", noJwks), "discovery", /jwks_uri/);
  const downgrade = (async () => Response.json({ issuer: "https://idp.example", authorization_endpoint: "https://idp.example/a", token_endpoint: "http://idp.example/t", jwks_uri: "https://idp.example/j" })) as typeof fetch;
  await rejects(discover("https://idp.example", downgrade), "discovery", /token_endpoint/);
});

test("id_token checks: nonce, audience, issuer, expiry, signature, algorithm, azp, email, email_verified", async () => {
  const d: Discovery = await discover(issuer);
  const verify = (t: string, nonce = "n-1") => verifyIdToken(t, { issuer: d.issuer, clientId: CLIENT, nonce, keys: remoteKeys(d.jwks_uri) });
  assert.equal((await verify(await idToken())).email, "ada@acme.io");
  await rejects(verify(await idToken(), "other-nonce"), "id_token", /nonce/);
  await rejects(verify(await idToken({ nonce: undefined })), "id_token", /nonce/);
  await rejects(verify(await idToken({ aud: "someone-else" })), "id_token", /aud/);
  await rejects(verify(await idToken({ iss: "https://evil.example" })), "id_token", /iss/);
  await rejects(verify(await idToken({ exp: Math.floor(Date.now() / 1000) - 3600 })), "id_token", /exp/);
  await rejects(verify(await idToken({}, evil.privateKey)), "id_token", /signature/);
  await rejects(verify(await idToken({}, new TextEncoder().encode("x".repeat(32)), "HS256")), "id_token", /alg/);
  await rejects(verify(await idToken({ aud: [CLIENT, "other"] })), "id_token", /azp/);
  assert.equal((await verify(await idToken({ aud: [CLIENT, "other"], azp: CLIENT }))).sub, "user-1");
  await rejects(verify(await idToken({ email: undefined })), "no_email");
  await rejects(verify(await idToken({ email_verified: false })), "unverified");
  await rejects(verify(await idToken({ email_verified: "false" })), "unverified");
  // F63: OIDC_REQUIRE_EMAIL_VERIFIED is on by default, so an absent email_verified now counts as unverified.
  await rejects(verify(await idToken({ email_verified: undefined })), "unverified");
  const lenient = (t: string) => verifyIdToken(t, { issuer: d.issuer, clientId: CLIENT, nonce: "n-1", keys: remoteKeys(d.jwks_uri), requireVerified: false });
  assert.equal((await lenient(await idToken({ email_verified: undefined }))).email, "ada@acme.io", "OIDC_REQUIRE_EMAIL_VERIFIED=false: only an explicit false denies");
  await rejects(lenient(await idToken({ email_verified: false })), "unverified");
  assert.equal((await verify(await idToken({ email_verified: undefined, xms_edov: true }))).email, "ada@acme.io", "Entra: xms_edov stands in for email_verified");
  await rejects(verify(await idToken({ email_verified: false, xms_edov: true })), "unverified");
  assert.equal((await verify(await idToken({ name: undefined, given_name: "Ada", family_name: "L" }))).name, "Ada L");
});

test("emailVerified: true, Entra xms_edov, explicit false, and the absent claim with and without the requirement", () => {
  assert.equal(emailVerified({ email_verified: true }, true), true);
  assert.equal(emailVerified({ email_verified: "true" }, true), true);
  assert.equal(emailVerified({ email_verified: false }, false), false);
  assert.equal(emailVerified({ email_verified: "false", xms_edov: true }, false), false);
  assert.equal(emailVerified({}, true), false);
  assert.equal(emailVerified({}, false), true);
  assert.equal(emailVerified({ xms_edov: true }, true), true);
  assert.equal(emailVerified({ xms_edov: "1" }, true), true);
  assert.equal(emailVerified({ xms_edov: false }, true), false);
  assert.equal(emailVerified({ email_verified: "yes" }, true), false, "only true / \"true\" count");
});

test("subjectDecision (F63): bind the first subject, match it later, refuse a different one", () => {
  assert.equal(subjectDecision(null, "sub-1"), "bind");
  assert.equal(subjectDecision(undefined, "sub-1"), "bind");
  assert.equal(subjectDecision("", "sub-1"), "bind");
  assert.equal(subjectDecision("sub-1", "sub-1"), "match");
  assert.equal(subjectDecision("sub-1", "sub-2"), "mismatch");
  assert.equal(subjectDecision("sub-1", "sub-10"), "mismatch");
});

test("state comparison is exact and length-safe", () => {
  assert.equal(sameValue("abc", "abc"), true);
  assert.equal(sameValue("abc", "abd"), false);
  assert.equal(sameValue("abc", "abcd"), false);
  assert.equal(sameValue("", ""), false);
  assert.equal(sameValue(undefined, "abc"), false);
});

// F63 against the real users table: src/lib/server/auth/users.ts imports "server-only", which only resolves under the
// react-server condition, so the scenario runs in a child process on an in-memory SQLite console DB.
test("bindSubject (F63): first SSO sign-in binds the subject; a different one is refused; a subject can't move accounts", async () => {
  const { execFileSync } = await import("node:child_process");
  const users = JSON.stringify(new URL("./server/auth/users.ts", import.meta.url).href);
  const scenario = `
const u = await import(${users});
const a = await u.createUser({ email: "ada@acme.example", role: "viewer" });
const b = await u.createUser({ email: "bob@acme.example", role: "viewer" });
const out = {
  first: await u.bindSubject(a.id, "sub-ada"),
  again: await u.bindSubject(a.id, "sub-ada"),
  other: await u.bindSubject(a.id, "sub-mallory"),
  taken: await u.bindSubject(b.id, "sub-ada"),
  bob: await u.bindSubject(b.id, "sub-bob"),
};
const cy = await u.createUser({ email: "cy@acme.example", role: "viewer" });
out.race = await Promise.all([u.bindSubject(cy.id, "sub-c1"), u.bindSubject(cy.id, "sub-c2")]); // two first sign-ins at once
out.cols = Object.keys(await u.userById(a.id)).includes("oidc_sub");
console.log(JSON.stringify(out));`;
  const raw = execFileSync(process.execPath, ["--conditions=react-server", "--no-warnings", "--input-type=module", "-e", scenario], {
    encoding: "utf8",
    env: { ...process.env, CONSOLE_SQLITE_PATH: ":memory:", CONSOLE_SOURCE: "mock", DATABASE_URL: "" },
    timeout: 60_000,
  });
  const o = JSON.parse(raw.trim().split("\n").pop()!);
  assert.deepEqual(o.first, { ok: true, bound: true });
  assert.deepEqual(o.again, { ok: true, bound: false });
  assert.deepEqual(o.other, { ok: false, reason: "mismatch" }, "same email, different subject: refused");
  assert.deepEqual(o.taken, { ok: false, reason: "taken" }, "a subject bound to one account can't sign in to another");
  assert.deepEqual(o.bob, { ok: true, bound: true });
  assert.deepEqual(o.race, [{ ok: true, bound: true }, { ok: false, reason: "mismatch" }], "concurrent first sign-ins: one subject wins, the other is refused");
  assert.equal(o.cols, false, "the subject never rides along in user rows the UI sees");
});
