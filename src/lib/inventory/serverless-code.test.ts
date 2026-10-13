import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { codeSha256, decodeZip, handlerFiles, summarizePackage, zipEntries } from "./serverless-code.ts";

// A minimal valid zip (stored entries, no compression) — enough for the central-directory reader.
function makeZip(files: Record<string, string>): Uint8Array {
  const enc = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const n = enc.encode(name);
    const data = enc.encode(text);
    const local = new Uint8Array(30 + n.length + data.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, n.length, true);
    local.set(n, 30);
    local.set(data, 30 + n.length);
    const central = new Uint8Array(46 + n.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, n.length, true);
    cv.setUint32(42, offset, true);
    central.set(n, 46);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const cdSize = centrals.reduce((s, c) => s + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, centrals.length, true);
  ev.setUint16(10, centrals.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);
  const out = new Uint8Array(offset + cdSize + 22);
  let p = 0;
  for (const part of [...locals, ...centrals, eocd]) {
    out.set(part, p);
    p += part.length;
  }
  return out;
}

const b64 = (u: Uint8Array) => Buffer.from(u).toString("base64");

test("decodeZip: base64, zip magic, size cap", () => {
  const zip = makeZip({ "index.mjs": "export const handler = () => 1;" });
  assert.deepEqual(decodeZip(b64(zip)).bytes, zip);
  assert.deepEqual(decodeZip(`data:application/zip;base64,${b64(zip)}`).bytes, zip);
  assert.match(decodeZip("").problem!, /empty/);
  assert.match(decodeZip("%%%").problem!, /valid base64/);
  assert.match(decodeZip(b64(new TextEncoder().encode("just some text, not a zip file"))).problem!, /isn't a \.zip/);
  assert.match(decodeZip(b64(zip), 50).problem!, /at most|over/);
});

test("zipEntries reads the central directory", () => {
  assert.deepEqual(zipEntries(makeZip({ "index.mjs": "x", "lib/util.js": "y", "lib/": "" })), ["index.mjs", "lib/util.js", "lib/"]);
  assert.equal(zipEntries(new TextEncoder().encode("PK\u0003\u0004 but truncated nonsense")), undefined);
});

test("codeSha256 is Lambda's CodeSha256 form (base64 of the SHA-256 digest)", () => {
  const bytes = new TextEncoder().encode("hello");
  assert.equal(codeSha256(bytes), createHash("sha256").update("hello").digest("base64"));
  assert.equal(codeSha256(bytes), "LPJNul+wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ=");
});

test("handler files per runtime", () => {
  assert.deepEqual(handlerFiles("nodejs22.x", "index.handler"), ["index.js", "index.mjs", "index.cjs"]);
  assert.deepEqual(handlerFiles("nodejs22.x", "dist/lambda.handler"), ["dist/lambda.js", "dist/lambda.mjs", "dist/lambda.cjs"]);
  assert.deepEqual(handlerFiles("python3.13", "pkg.app.handler"), ["pkg/app.py"]);
  assert.deepEqual(handlerFiles("ruby3.3", "function.handler"), ["function.rb"]);
  assert.equal(handlerFiles("java21", "com.acme.Handler::handleRequest"), undefined);
  assert.equal(handlerFiles("provided.al2023", "bootstrap"), undefined);
});

test("summarizePackage warns when the handler's file is missing", () => {
  const ok = summarizePackage(makeZip({ "index.mjs": "x" }), "nodejs22.x", "index.handler");
  assert.equal(ok.handlerFound, true);
  assert.equal(ok.files, 1);
  assert.deepEqual(ok.warnings, []);
  const bad = summarizePackage(makeZip({ "src/index.mjs": "x" }), "nodejs22.x", "index.handler");
  assert.equal(bad.handlerFound, false);
  assert.match(bad.warnings[0], /expects index\.js or index\.mjs or index\.cjs/);
  assert.equal(summarizePackage(makeZip({ "a.class": "x" }), "java21", "A::h").handlerFound, undefined);
});
