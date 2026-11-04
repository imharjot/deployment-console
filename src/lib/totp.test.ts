import { test } from "node:test";
import assert from "node:assert/strict";
import {
  STEP_MS, base32Decode, base32Encode, checkTotp, hashRecoveryCode, mfaPolicy, newRecoveryCodes, newTotpSecret, normalizeRecoveryCode, otpauthUri,
  spendRecoveryCode, stepAt, totpAt,
} from "./totp.ts";

const RFC_SECRET = Buffer.from("12345678901234567890"); // RFC 6238 appendix B, SHA-1

test("totpAt matches the RFC 6238 test vectors (last 6 of the 8 published digits)", () => {
  for (const [t, code] of [[59, "287082"], [1111111109, "081804"], [1111111111, "050471"], [1234567890, "005924"], [2000000000, "279037"]] as const)
    assert.equal(totpAt(RFC_SECRET, stepAt(t * 1000)), code, `T=${t}`);
});

test("base32 round trip, RFC 4648 vector, and lenient decoding of typed keys", () => {
  assert.equal(base32Encode(Buffer.from("foobar")), "MZXW6YTBOI");
  assert.deepEqual(base32Decode("mzxw 6ytb-oi=="), Buffer.from("foobar"));
  assert.equal(base32Decode("not base32!"), null);
  assert.equal(base32Decode(""), null);
  const s = newTotpSecret();
  assert.match(s, /^[A-Z2-7]{32}$/); // 160 bits
  assert.equal(base32Decode(s)!.length, 20);
  assert.notEqual(newTotpSecret(), s);
});

test("checkTotp accepts the current step and one either side, refuses older/newer ones and malformed input", () => {
  const secret = base32Encode(RFC_SECRET);
  const now = 1_700_000_000_000;
  const at = stepAt(now);
  const code = (step: number) => totpAt(RFC_SECRET, step);
  assert.equal(checkTotp(secret, code(at), now, null), at);
  assert.equal(checkTotp(secret, code(at - 1), now, null), at - 1);
  assert.equal(checkTotp(secret, code(at + 1), now, null), at + 1);
  assert.equal(checkTotp(secret, code(at - 2), now, null), null);
  assert.equal(checkTotp(secret, code(at + 2), now, null), null);
  assert.equal(checkTotp(secret, ` ${code(at).slice(0, 3)} ${code(at).slice(3)} `, now, null), at); // "123 456" as apps show it
  for (const bad of ["", "12345", "1234567", "abcdef", undefined, 123456, null]) assert.equal(checkTotp(secret, bad, now, null), null);
  assert.equal(checkTotp("not base32!", code(at), now, null), null);
});

test("checkTotp refuses replay: a step at or before the last one used never counts again", () => {
  const secret = base32Encode(RFC_SECRET);
  const now = 1_700_000_000_000;
  const at = stepAt(now);
  assert.equal(checkTotp(secret, totpAt(RFC_SECRET, at), now, at), null);
  assert.equal(checkTotp(secret, totpAt(RFC_SECRET, at - 1), now, at - 1), null);
  assert.equal(checkTotp(secret, totpAt(RFC_SECRET, at), now, at - 1), at);
  assert.equal(checkTotp(secret, totpAt(RFC_SECRET, at), now + STEP_MS, at), null); // same code half a minute later
});

test("otpauth URI: issuer in label and parameter, account encoded", () => {
  const u = otpauthUri("JBSWY3DPEHPK3PXP", "a+b@example.com");
  assert.equal(u, "otpauth://totp/Deployment%20Console:a%2Bb%40example.com?secret=JBSWY3DPEHPK3PXP&issuer=Deployment%20Console&algorithm=SHA1&digits=6&period=30");
});

test("recovery codes: 10 distinct xxxxx-xxxxx codes; each spends once, in any case or spacing", () => {
  const codes = newRecoveryCodes();
  assert.equal(codes.length, 10);
  assert.equal(new Set(codes).size, 10);
  for (const c of codes) assert.match(c, /^[a-z2-7]{5}-[a-z2-7]{5}$/);
  const hashes = codes.map((c) => hashRecoveryCode(normalizeRecoveryCode(c)!));
  const typed = ` ${codes[3].toUpperCase().replace("-", " ")} `;
  const rest = spendRecoveryCode(hashes, typed);
  assert.deepEqual(rest, hashes.filter((_, i) => i !== 3));
  assert.equal(spendRecoveryCode(rest!, codes[3]), null); // already used
  assert.equal(spendRecoveryCode(hashes, "aaaaa-aaaaa"), null);
  assert.equal(spendRecoveryCode(hashes, "123456"), null);
  assert.equal(normalizeRecoveryCode(42), null);
});

test("CONSOLE_MFA: required unless exactly off; unknown values fail safe", () => {
  assert.equal(mfaPolicy({}), "required");
  assert.equal(mfaPolicy({ CONSOLE_MFA: "required" }), "required");
  assert.equal(mfaPolicy({ CONSOLE_MFA: " OFF " }), "off");
  assert.equal(mfaPolicy({ CONSOLE_MFA: "false" }), "required");
  assert.equal(mfaPolicy({ CONSOLE_MFA: "optional" }), "required");
});
