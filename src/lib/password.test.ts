import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_PARAMS, MIN_PASSWORD, hashPassword, needsRehash, parseHash, passwordProblem, verifyPassword } from "./password.ts";

test("hash → verify round trip; wrong password fails", async () => {
  const h = await hashPassword("correct horse battery");
  assert.equal(await verifyPassword("correct horse battery", h), true);
  assert.equal(await verifyPassword("correct horse batterY", h), false);
  assert.equal(await verifyPassword("", h), false);
});

test("encoding: scrypt$logN$r$p$salt$key with N ≥ 2^15, r=8, p=1 and a fresh salt per hash", async () => {
  const a = await hashPassword("same password here");
  const b = await hashPassword("same password here");
  assert.match(a, /^scrypt\$15\$8\$1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/);
  assert.notEqual(a, b, "salted");
  const p = parseHash(a)!;
  assert.equal(p.logN, DEFAULT_PARAMS.logN);
  assert.ok(2 ** p.logN >= 2 ** 15);
  assert.equal(p.salt.length, 16);
  assert.equal(p.key.length, 32);
  assert.equal(needsRehash(a), false);
});

test("Unicode normalisation: composed and decomposed forms are the same password", async () => {
  const h = await hashPassword("pässwörd-long-enough");
  assert.equal(await verifyPassword("pässwörd-long-enough", h), true);
});

test("malformed or tampered hashes never verify (and never throw)", async () => {
  const h = await hashPassword("tamper-proof-1234");
  const parts = h.split("$");
  const flip = (i: number, v: string) => Object.assign([...parts], { [i]: v }).join("$");
  for (const bad of [null, undefined, "", "plain", "bcrypt$x", flip(0, "argon2"), flip(1, "30"), flip(1, "10"), flip(2, "0"), flip(4, "c2FsdA"), h + "$extra"])
    assert.equal(await verifyPassword("tamper-proof-1234", bad as string), false, String(bad));
  // A valid-looking hash of a different key fails too.
  const other = await hashPassword("tamper-proof-9999");
  assert.equal(await verifyPassword("tamper-proof-1234", flip(5, other.split("$")[5])), false);
});

test("older, cheaper parameters still verify but ask for a rehash", async () => {
  const cheap = await hashPassword("legacy-password-1", { logN: 14, r: 8, p: 1 });
  assert.equal(await verifyPassword("legacy-password-1", cheap), true);
  assert.equal(needsRehash(cheap), true);
});

test("password policy: minimum length, maximum length, type", () => {
  assert.equal(MIN_PASSWORD, 10);
  assert.equal(passwordProblem("a".repeat(9)) !== null, true);
  assert.equal(passwordProblem("a".repeat(10)), null);
  assert.equal(passwordProblem("a".repeat(257)) !== null, true);
  assert.equal(passwordProblem(undefined) !== null, true);
  assert.equal(passwordProblem(12345678901) !== null, true);
  assert.equal(passwordProblem("😀".repeat(9)) !== null, true, "counts characters, not UTF-16 units");
});

test("overlong input is refused without hashing", async () => {
  const h = await hashPassword("something-reasonable");
  assert.equal(await verifyPassword("x".repeat(10_000), h), false);
});
