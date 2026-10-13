// AUTH_MODE=alb: an ALB authenticate-oidc action signs the user in with your IdP and forwards a signed x-amzn-oidc-data JWT.
// Verify: signer == our ALB, ES256 signature with the ALB's regional key, not expired, email on the allowlist (if one is set).
// Expiry (REVIEW R06): the ALB puts `exp` in the signed JWT *header*; the payload carries the IdP's user claims and
// normally has none. So exp is read from the header once the signature has proved the header is the ALB's, with 60 s of
// clock tolerance. A payload exp never stands in for a missing or past header exp (jose still refuses a past payload exp).
import { importSPKI, jwtVerify, decodeProtectedHeader } from "jose";

export interface AuthOptions {
  albArn: string;
  region: string;
  allowed?: string[]; // optional extra gate; without it the users table decides who gets in
  fetchKey?: (url: string) => Promise<string>;
  now?: number;
}

export const ALB_CLOCK_TOLERANCE_S = 60;

export type AuthResult = { ok: true; email: string } | { ok: false; status: 401 | 403; error: string };

const keyCache = new Map<string, CryptoKey>();

async function defaultFetchKey(url: string): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
  if (!res.ok) throw new Error(`key fetch ${res.status}`);
  return res.text();
}

// ALB token segments may carry base64 '=' padding, which strict JWT libraries reject.
export const stripPadding = (token: string) => token.split(".").map((p) => p.replace(/=+$/, "")).join(".");

export async function verifyAlbToken(raw: string | null, opts: AuthOptions): Promise<AuthResult> {
  if (!raw) return { ok: false, status: 401, error: "missing identity header" };
  const token = stripPadding(raw.trim());
  let header: ReturnType<typeof decodeProtectedHeader> & { signer?: string };
  try {
    header = decodeProtectedHeader(token);
  } catch {
    return { ok: false, status: 401, error: "malformed token" };
  }
  if (header.alg !== "ES256") return { ok: false, status: 401, error: "unexpected algorithm" };
  if (!opts.albArn || header.signer !== opts.albArn) return { ok: false, status: 401, error: "token not signed by our load balancer" };
  const kid = header.kid;
  if (!kid || !/^[A-Za-z0-9-]+$/.test(kid)) return { ok: false, status: 401, error: "bad key id" };

  try {
    let key = keyCache.get(kid);
    if (!key) {
      const pem = await (opts.fetchKey ?? defaultFetchKey)(`https://public-keys.auth.elb.${opts.region}.amazonaws.com/${kid}`);
      key = await importSPKI(pem, "ES256");
      keyCache.set(kid, key);
    }
    const { payload, protectedHeader } = await jwtVerify(token, key, {
      algorithms: ["ES256"],
      currentDate: opts.now ? new Date(opts.now) : undefined,
      clockTolerance: ALB_CLOCK_TOLERANCE_S,
    });
    const exp = (protectedHeader as { exp?: unknown }).exp; // the verified header (same bytes as `header` above)
    if (typeof exp !== "number" || !Number.isFinite(exp)) return { ok: false, status: 401, error: "token has no expiry" };
    if ((opts.now ?? Date.now()) / 1000 > exp + ALB_CLOCK_TOLERANCE_S) return { ok: false, status: 401, error: "token expired" };
    const email = typeof payload.email === "string" ? payload.email.toLowerCase() : "";
    if (!email) return { ok: false, status: 403, error: "no email claim" };
    if (payload.email_verified === false || payload.email_verified === "false") return { ok: false, status: 403, error: "email not verified" };
    if (opts.allowed && !opts.allowed.map((e) => e.trim().toLowerCase()).includes(email)) return { ok: false, status: 403, error: `${email} is not allowed` };
    return { ok: true, email };
  } catch (e) {
    return { ok: false, status: 401, error: `invalid token: ${(e as Error).message}` };
  }
}

export const parseAllowlist = (v: string | undefined) => (v ?? "").split(",").map((e) => e.trim()).filter(Boolean);
