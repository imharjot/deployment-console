// Two-step sign-in with an authenticator app (RFC 6238 TOTP: HMAC-SHA1, 30-second steps, 6 digits — what Google
// Authenticator, 1Password, Authy and the rest expect) and single-use recovery codes. Pure: no I/O, so `node --test`
// covers it; the routes and storage live in src/lib/server/auth/mfa.ts.
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const STEP_MS = 30_000;
const DIGITS = 6;
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"; // RFC 4648 base32

export function base32Encode(buf: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

// Lenient on input people type or paste: case, spaces, hyphens and "=" padding are ignored. null = not base32.
export function base32Decode(s: string): Buffer | null {
  const clean = s.toUpperCase().replace(/[\s=-]/g, "");
  if (!clean || /[^A-Z2-7]/.test(clean)) return null;
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    value = (value << 5) | ALPHABET.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

// 160 random bits, the size RFC 4226 recommends for HMAC-SHA1.
export const newTotpSecret = () => base32Encode(randomBytes(20));

export const stepAt = (now: number) => Math.floor(now / STEP_MS);

export function totpAt(secret: Buffer, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const h = createHmac("sha1", secret).update(counter).digest();
  const o = h[h.length - 1] & 15;
  const n = ((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 10 ** DIGITS).padStart(DIGITS, "0");
}

const sameText = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

// The step a code matches, or null. One step either side of now absorbs clock drift and a code typed as it rolls
// over. Only steps after `lastStep` count, so a code (or an older one) that already signed someone in can't be replayed.
export function checkTotp(secretB32: string, code: unknown, now: number, lastStep: number | null): number | null {
  const secret = base32Decode(secretB32);
  const digits = typeof code === "string" ? code.replace(/\s/g, "") : "";
  if (!secret || !/^\d{6}$/.test(digits)) return null;
  const at = stepAt(now);
  let hit: number | null = null;
  // Every candidate is computed and compared, matched or not, so timing doesn't tell which window matched.
  for (const step of [at - 1, at, at + 1]) if (sameText(totpAt(secret, step), digits) && (lastStep === null || step > lastStep)) hit = step;
  return hit;
}

// otpauth:// URI for the QR code (Key Uri Format). The issuer goes in the label and the parameter, as apps expect.
export function otpauthUri(secretB32: string, account: string, issuer = "Deployment Console"): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  return `otpauth://totp/${label}?secret=${secretB32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${STEP_MS / 1000}`;
}

// ---------- recovery codes ----------

export const RECOVERY_COUNT = 10;

// "abcde-fghij": 10 base32 characters, 50 random bits each. Shown once; only their hashes are stored.
export function newRecoveryCodes(n = RECOVERY_COUNT): string[] {
  return Array.from({ length: n }, () => {
    const c = base32Encode(randomBytes(7)).slice(0, 10).toLowerCase();
    return `${c.slice(0, 5)}-${c.slice(5)}`;
  });
}

// Typed back in any case, with or without the hyphen or spaces. null = can't be a recovery code.
export function normalizeRecoveryCode(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const c = input.toLowerCase().replace(/[\s-]/g, "");
  return /^[a-z2-7]{10}$/.test(c) ? c : null;
}

export const hashRecoveryCode = (normalized: string) => createHash("sha256").update(`recovery:${normalized}`).digest("hex");

// The stored hashes without the one this code matches, or null when it matches none.
export function spendRecoveryCode(hashes: string[], input: unknown): string[] | null {
  const n = normalizeRecoveryCode(input);
  if (!n) return null;
  const h = hashRecoveryCode(n);
  let found = false;
  const rest = hashes.filter((x) => {
    const same = sameText(x, h);
    if (same) found = true;
    return !same;
  });
  return found ? rest : null;
}

// ---------- policy ----------

export type MfaPolicy = "required" | "off";

// CONSOLE_MFA: "required" (the default) makes every password sign-in finish with an authenticator code, and someone
// without one sets it up before their first session. "off" turns two-step sign-in off entirely (a local demo).
// Anything else fails safe to required. SSO and load-balancer sign-ins rely on the identity provider's own MFA.
export function mfaPolicy(env: Record<string, string | undefined>): MfaPolicy {
  return (env.CONSOLE_MFA ?? "").trim().toLowerCase() === "off" ? "off" : "required";
}
