// Password hashing with scrypt (node:crypto). Pure: no DB, no server-only, so node --test covers it.
// Encoded form carries its own parameters, so the cost can be raised later without invalidating old hashes:
//   scrypt$<log2 N>$<r>$<p>$<salt b64url>$<key b64url>
import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from "node:crypto";

export const MIN_PASSWORD = 10;
const MAX_PASSWORD = 256; // bounds hashing work per request

export interface ScryptParams {
  logN: number;
  r: number;
  p: number;
}
export const DEFAULT_PARAMS: ScryptParams = { logN: 15, r: 8, p: 1 }; // N = 32768, ~32 MiB per hash
const KEY_LEN = 32;
const SALT_LEN = 16;

// scrypt needs 128·N·r bytes; Node's default maxmem (32 MiB) is exactly that for N=2^15, r=8, so give it headroom.
const options = ({ logN, r, p }: ScryptParams): ScryptOptions => ({ N: 2 ** logN, r, p, maxmem: 256 * 2 ** logN * r });

const scrypt = (pw: string, salt: Buffer, len: number, o: ScryptOptions) =>
  new Promise<Buffer>((resolve, reject) => scryptCb(pw, salt, len, o, (e, key) => (e ? reject(e) : resolve(key))));

// NFKC so the same password typed on different keyboards/OSes (composed vs decomposed accents) still matches.
const prep = (pw: string) => pw.normalize("NFKC");

// Null when acceptable; otherwise a message safe to show the user.
export function passwordProblem(pw: unknown): string | null {
  if (typeof pw !== "string" || !pw) return "Password is required.";
  if ([...pw].length < MIN_PASSWORD) return `Use at least ${MIN_PASSWORD} characters.`;
  if (pw.length > MAX_PASSWORD) return `Use at most ${MAX_PASSWORD} characters.`;
  return null;
}

export async function hashPassword(pw: string, params: ScryptParams = DEFAULT_PARAMS): Promise<string> {
  const salt = randomBytes(SALT_LEN);
  const key = await scrypt(prep(pw), salt, KEY_LEN, options(params));
  return ["scrypt", params.logN, params.r, params.p, salt.toString("base64url"), key.toString("base64url")].join("$");
}

// Bounds stop a tampered row from making us burn unbounded CPU/memory, or accept a trivially weak hash.
export function parseHash(encoded: string): (ScryptParams & { salt: Buffer; key: Buffer }) | null {
  const parts = encoded.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return null;
  const [logN, r, p] = parts.slice(1, 4).map((x) => (/^\d{1,2}$/.test(x) ? Number(x) : NaN));
  if (!(logN >= 14 && logN <= 20 && r >= 1 && r <= 32 && p >= 1 && p <= 16)) return null;
  const salt = Buffer.from(parts[4], "base64url");
  const key = Buffer.from(parts[5], "base64url");
  if (salt.length < SALT_LEN || key.length < 16 || key.length > 64) return null;
  return { logN, r, p, salt, key };
}

export async function verifyPassword(pw: string, encoded: string | null | undefined): Promise<boolean> {
  const h = typeof encoded === "string" ? parseHash(encoded) : null;
  if (!h || typeof pw !== "string" || pw.length > MAX_PASSWORD) return false;
  const key = await scrypt(prep(pw), h.salt, h.key.length, options(h));
  return timingSafeEqual(key, h.key);
}

export const needsRehash = (encoded: string) => {
  const h = parseHash(encoded);
  return !h || h.logN < DEFAULT_PARAMS.logN || h.r < DEFAULT_PARAMS.r;
};
