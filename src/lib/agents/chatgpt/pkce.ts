// The one-time values of a "Sign in with ChatGPT" plan authorisation (AGENT_ARCHITECTURE §2): a PKCE S256 pair, state
// and nonce (fresh for every attempt), and the installation host id OpenAI asks a locally installed app to send with
// every registration (`ext_agent_host_id`). Pure.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

// 32 random bytes, base64url: unguessable and safe in a URL.
export const randomValue = () => randomBytes(32).toString("base64url");

export const s256 = (verifier: string) => createHash("sha256").update(verifier).digest("base64url");

// RFC 7636: a 43-character verifier from 32 random bytes; the challenge is its SHA-256, base64url without padding.
export function pkcePair(): { verifier: string; challenge: string; method: "S256" } {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: s256(verifier), method: "S256" };
}

// Constant-time equality for state, nonce and ids; anything that isn't a non-empty string of the same length is false.
export function sameValue(a: unknown, b: unknown): boolean {
  if (typeof a !== "string" || typeof b !== "string" || !a) return false;
  // Compared as bytes: a query value of the same length in characters but not in bytes ("é…") must be a mismatch,
  // not a RangeError from timingSafeEqual.
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

// The installation host id: random once per console installation (settings key agents:host-id), never derived from
// the machine, its name, its addresses or a person. Distinct per host, stable across sign-ins.
export const HOST_ID = /^dch_[A-Za-z0-9_-]{22}$/;
export const newHostId = () => `dch_${randomBytes(16).toString("base64url")}`;
export const isHostId = (v: unknown): v is string => typeof v === "string" && HOST_ID.test(v);
