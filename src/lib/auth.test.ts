import { test } from "node:test";
import assert from "node:assert/strict";
import { SignJWT, exportSPKI, generateKeyPair } from "jose";
import { stripPadding, verifyAlbToken } from "./auth.ts";

const ALB = "arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/acme-prod/abc";
const good = await generateKeyPair("ES256", { extractable: true });
const evil = await generateKeyPair("ES256", { extractable: true });
const goodPem = await exportSPKI(good.publicKey);

let kidSeq = 0;
const nowS = () => Math.floor(Date.now() / 1000);

// The native ALB shape (REVIEW R06): exp, iss and client live in the signed header; the payload is the IdP's UserInfo
// (sub, email, …) with no exp. `payloadExp` adds one anyway, to prove it never stands in for the header's.
async function token(o: { signer?: string; email?: string; exp?: number | null; payloadExp?: number; key?: CryptoKey; kid?: string; verified?: boolean } = {}) {
  const kid = o.kid ?? `kid-${++kidSeq}`;
  const header: Record<string, unknown> = { alg: "ES256", kid, signer: o.signer ?? ALB, iss: "https://idp.acme.example", client: "acme-console-client", typ: "JWT" };
  if (o.exp !== null) header.exp = o.exp ?? nowS() + 120;
  const claims: Record<string, unknown> = { sub: "00u1acme", email: o.email ?? "ada@acme.example", email_verified: o.verified ?? true, name: "Ada" };
  if (o.payloadExp !== undefined) claims.exp = o.payloadExp;
  const jwt = await new SignJWT(claims).setProtectedHeader(header as never).sign(o.key ?? good.privateKey);
  return { jwt, kid };
}
const opts = { albArn: ALB, region: "us-east-1", allowed: ["ada@acme.example"], fetchKey: async () => goodPem };

test("valid token from our ALB, allowlisted → ok", async () => {
  const { jwt } = await token();
  assert.deepEqual(await verifyAlbToken(jwt, opts), { ok: true, email: "ada@acme.example" });
});

test("ALB-style base64 padding is accepted", async () => {
  const { jwt } = await token();
  const padded = jwt.split(".").map((p) => p + "==").join(".");
  assert.equal(stripPadding(padded), jwt);
  assert.equal((await verifyAlbToken(padded, opts)).ok, true);
});

test("forged tokens → 401", async () => {
  assert.equal((await verifyAlbToken(null, opts)).ok, false, "missing");
  assert.equal((await verifyAlbToken("not.a.jwt", opts)).ok, false, "garbage");
  const wrongSigner = await token({ signer: ALB.replace("abc", "xyz") });
  assert.match(JSON.stringify(await verifyAlbToken(wrongSigner.jwt, opts)), /not signed by our load balancer/);
  const selfSigned = await token({ key: evil.privateKey });
  const r = await verifyAlbToken(selfSigned.jwt, opts);
  assert.equal(!r.ok && r.status, 401);
  const expired = await token({ exp: nowS() - 3600 });
  assert.equal((await verifyAlbToken(expired.jwt, opts)).ok, false);
});

test("R06: expiry comes from the signed header — native ALB tokens without a payload exp are accepted", async () => {
  const { jwt } = await token(); // header exp in 2 minutes, no payload exp: before the fix this was "token has no expiry"
  assert.deepEqual(await verifyAlbToken(jwt, opts), { ok: true, email: "ada@acme.example" });
  const nearly = await token({ exp: nowS() - 30 });
  assert.equal((await verifyAlbToken(nearly.jwt, opts)).ok, true, "within the 60 s clock tolerance");
});

test("R06: an expired or missing header exp is refused, whatever the payload says", async () => {
  const expired = await token({ exp: nowS() - 120 });
  assert.deepEqual(await verifyAlbToken(expired.jwt, opts), { ok: false, status: 401, error: "token expired" });
  const rescued = await token({ exp: nowS() - 120, payloadExp: nowS() + 3600 });
  assert.deepEqual(await verifyAlbToken(rescued.jwt, opts), { ok: false, status: 401, error: "token expired" }, "a future payload exp doesn't rescue an expired header");
  const none = await token({ exp: null, payloadExp: nowS() + 3600 });
  assert.deepEqual(await verifyAlbToken(none.jwt, opts), { ok: false, status: 401, error: "token has no expiry" }, "a payload exp doesn't replace a missing header exp");
  const text = await token({ exp: String(nowS() + 120) as never });
  assert.equal((await verifyAlbToken(text.jwt, opts)).ok, false, "exp must be a number");
  const fixed = await token({ exp: 1_900_000_000 });
  assert.equal((await verifyAlbToken(fixed.jwt, { ...opts, now: 1_900_000_000_000 + 59_000 })).ok, true, "opts.now is honoured");
  assert.equal((await verifyAlbToken(fixed.jwt, { ...opts, now: 1_900_000_000_000 + 61_000 })).ok, false);
  const stalePayload = await token({ payloadExp: nowS() - 3600 });
  assert.equal((await verifyAlbToken(stalePayload.jwt, opts)).ok, false, "a past payload exp is still refused (jose)");
});

test("account not on the allowlist → 403", async () => {
  const { jwt } = await token({ email: "someone@gmail.com" });
  const r = await verifyAlbToken(jwt, opts);
  assert.equal(!r.ok && r.status, 403);
  const unverified = await token({ verified: false });
  assert.equal((await verifyAlbToken(unverified.jwt, opts)).ok, false);
});

test("empty ALB ARN config refuses everything", async () => {
  const { jwt } = await token();
  assert.equal((await verifyAlbToken(jwt, { ...opts, albArn: "" })).ok, false);
});

test("kid is validated before it reaches the key URL", async () => {
  const { jwt } = await token({ kid: "../../evil" });
  assert.match(JSON.stringify(await verifyAlbToken(jwt, opts)), /bad key id/);
});

// F64: src/lib/server/http.ts (server-only, and it imports "next/server", which plain Node ESM only finds as
// next/server.js) runs in a child process under the react-server condition with a one-line resolve hook.
test("readJson (F64): 413 from Content-Length before reading, and a byte count while streaming", async () => {
  const { execFileSync } = await import("node:child_process");
  const hooks = `export async function resolve(spec, ctx, next) { return next(spec === "next/server" ? "next/server.js" : spec, ctx); }`;
  const register = `import { register } from "node:module"; register(${JSON.stringify(`data:text/javascript,${encodeURIComponent(hooks)}`)});`;
  const http = JSON.stringify(new URL("./server/http.ts", import.meta.url).href);
  const scenario = `
const { readJson } = await import(${http});
const out = {};
const status = (p) => p.then((v) => ({ ok: v }), (e) => ({ status: e.status, error: e.message }));
let pulled = 0;
const endless = () => new ReadableStream({ pull(c) { pulled++; c.enqueue(new Uint8Array(4096).fill(32)); } }); // never ends
out.small = await status(readJson(new Request("http://x/", { method: "POST", body: '{"a":1}' })));
out.empty = await status(readJson(new Request("http://x/", { method: "POST" })));
out.bad = await status(readJson(new Request("http://x/", { method: "POST", body: "{nope" })));
out.declared = await status(readJson({ headers: new Headers({ "content-length": "20000" }), body: endless() }));
out.pulledDeclared = pulled;
pulled = 0;
out.streamed = await status(readJson({ headers: new Headers(), body: endless() }));
out.pulledStreamed = pulled;
out.lying = await status(readJson({ headers: new Headers({ "content-length": "10" }), body: endless() }));
out.bigCap = await status(readJson(new Request("http://x/", { method: "POST", body: JSON.stringify({ v: "x".repeat(20000) }) }), 30000));
out.multibyte = await status(readJson(new Request("http://x/", { method: "POST", body: JSON.stringify({ v: "é".repeat(6000) }) })));
console.log(JSON.stringify({ ...out, bigCap: out.bigCap.ok ? out.bigCap.ok.v.length : out.bigCap }));`;
  const raw = execFileSync(process.execPath, ["--conditions=react-server", "--no-warnings", "--import", `data:text/javascript,${encodeURIComponent(register)}`, "--input-type=module", "-e", scenario], {
    encoding: "utf8",
    timeout: 60_000,
  });
  const o = JSON.parse(raw.trim().split("\n").pop()!);
  assert.deepEqual(o.small, { ok: { a: 1 } });
  assert.deepEqual(o.empty, { ok: {} });
  assert.deepEqual(o.bad, { status: 400, error: "body must be JSON" });
  assert.deepEqual(o.declared, { status: 413, error: "body too large" });
  assert.ok(o.pulledDeclared <= 1, `an oversized Content-Length is refused without reading the body (pulled ${o.pulledDeclared})`);
  assert.deepEqual(o.streamed, { status: 413, error: "body too large" }, "a body without a length stops at the cap");
  assert.ok(o.pulledStreamed <= 5, `read only up to the cap (pulled ${o.pulledStreamed} × 4 KB)`);
  assert.deepEqual(o.lying, { status: 413, error: "body too large" }, "a Content-Length that understates the body doesn't help");
  assert.equal(o.bigCap, 20000, "routes that pass a larger cap get it");
  assert.deepEqual(o.multibyte, { status: 413, error: "body too large" }, "the cap counts bytes, not characters");
});
