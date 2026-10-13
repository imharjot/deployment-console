// OpenID Connect client for SSO sign-in: authorization-code flow with PKCE, state and nonce.
// Works with any standards-compliant provider (Google, Okta, Azure AD / Entra, Auth0, Keycloak…).
// Pure: fetch and the key set are injectable, so the tests run a throwaway provider in-process.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from "jose";
import { normalizeEmail } from "./authn.ts";

export interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  token_endpoint_auth_methods_supported?: string[];
}

// `code` is stable and safe to put in a redirect URL; `message` may carry provider detail and is only logged.
export class OidcError extends Error {
  readonly code: "discovery" | "state" | "token" | "id_token" | "no_email" | "unverified" | "subject";
  constructor(code: OidcError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

type Fetch = typeof fetch;
const trimSlash = (s: string) => s.replace(/\/+$/, "");

export async function discover(issuer: string, f: Fetch = fetch): Promise<Discovery> {
  let d: Record<string, unknown>;
  try {
    const res = await f(`${trimSlash(issuer)}/.well-known/openid-configuration`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    d = (await res.json()) as Record<string, unknown>;
  } catch (e) {
    throw new OidcError("discovery", `discovery failed: ${(e as Error).message}`);
  }
  // Discovery §4.3: the advertised issuer must be the one we configured, or tokens could be minted elsewhere.
  if (typeof d.issuer !== "string" || trimSlash(d.issuer) !== trimSlash(issuer)) throw new OidcError("discovery", `issuer mismatch: ${String(d.issuer)}`);
  const secure = new URL(issuer).protocol === "https:";
  for (const k of ["authorization_endpoint", "token_endpoint", "jwks_uri"] as const) {
    const v = d[k];
    if (typeof v !== "string" || (secure && !v.startsWith("https://"))) throw new OidcError("discovery", `discovery document has no usable ${k}`);
  }
  return d as unknown as Discovery;
}

const keySets = new Map<string, JWTVerifyGetKey>();
// jose caches keys and refetches on unknown kid (with a cooldown), so one set per URL is enough.
export function remoteKeys(jwksUri: string): JWTVerifyGetKey {
  let k = keySets.get(jwksUri);
  if (!k) keySets.set(jwksUri, (k = createRemoteJWKSet(new URL(jwksUri), { timeoutDuration: 5000 })));
  return k;
}

export const randomValue = () => randomBytes(24).toString("base64url");

export function pkcePair() {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

export function sameValue(a: unknown, b: unknown): boolean {
  if (typeof a !== "string" || typeof b !== "string" || !a || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export function authorizeUrl(d: Discovery, o: { clientId: string; redirectUri: string; scope: string; state: string; nonce: string; challenge: string }): string {
  const u = new URL(d.authorization_endpoint);
  const q = { response_type: "code", client_id: o.clientId, redirect_uri: o.redirectUri, scope: o.scope, state: o.state, nonce: o.nonce, code_challenge: o.challenge, code_challenge_method: "S256" };
  for (const [k, v] of Object.entries(q)) u.searchParams.set(k, v);
  return u.toString();
}

export async function exchangeCode(
  d: Discovery,
  o: { code: string; verifier: string; redirectUri: string; clientId: string; clientSecret?: string },
  f: Fetch = fetch,
): Promise<{ id_token: string }> {
  const body = new URLSearchParams({ grant_type: "authorization_code", code: o.code, redirect_uri: o.redirectUri, code_verifier: o.verifier });
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded", accept: "application/json" };
  // client_secret_basic is the spec default when the provider doesn't list its methods.
  const methods = d.token_endpoint_auth_methods_supported ?? ["client_secret_basic"];
  if (o.clientSecret && methods.includes("client_secret_basic")) {
    headers.authorization = `Basic ${Buffer.from(`${encodeURIComponent(o.clientId)}:${encodeURIComponent(o.clientSecret)}`).toString("base64")}`;
  } else {
    body.set("client_id", o.clientId);
    if (o.clientSecret) body.set("client_secret", o.clientSecret);
  }
  let res: Response;
  try {
    res = await f(d.token_endpoint, { method: "POST", headers, body, redirect: "error", signal: AbortSignal.timeout(8000) });
  } catch (e) {
    throw new OidcError("token", `token endpoint unreachable: ${(e as Error).message}`);
  }
  const j = (await res.json().catch(() => ({}))) as { id_token?: unknown; error?: unknown };
  if (!res.ok) throw new OidcError("token", `token endpoint: ${typeof j.error === "string" ? j.error : `HTTP ${res.status}`}`);
  if (typeof j.id_token !== "string") throw new OidcError("token", "token response has no id_token");
  return { id_token: j.id_token };
}

// HMAC algorithms are excluded: a provider's id_token must be verifiable with its published public keys.
const ALGS = ["RS256", "RS384", "RS512", "PS256", "PS384", "PS512", "ES256", "ES384", "ES512", "EdDSA"];

export interface IdentityClaims {
  sub: string;
  email: string;
  name: string | null;
}

// Is the email verified? email_verified true (or "true") says so. Entra ID doesn't send email_verified; its optional
// claim xms_edov ("email domain owner verified", true when the tenant verified the email's domain) counts instead.
// email_verified false always denies. With requireVerified (OIDC_REQUIRE_EMAIL_VERIFIED, the default) an absent claim
// denies too; without it only an explicit false does (the OIDC spec's minimum).
export function emailVerified(p: Record<string, unknown>, requireVerified: boolean): boolean {
  const yes = (v: unknown) => v === true || v === "true" || v === 1 || v === "1";
  const no = (v: unknown) => v === false || v === "false";
  if (no(p.email_verified)) return false;
  if (yes(p.email_verified) || (p.email_verified === undefined && yes(p.xms_edov))) return true;
  return !requireVerified;
}

// F63: a console account is bound to the SSO subject (`sub`) that first signed in to it. Emails get reassigned and
// providers can be reconfigured; the subject is the provider's stable id for the person.
//   bind  — the account has no subject yet: store this one;  match — same subject: sign in;
//   mismatch — a different subject for the same email: refuse (and audit) — an admin resolves it.
export type SubjectDecision = "bind" | "match" | "mismatch";
export function subjectDecision(bound: string | null | undefined, sub: string): SubjectDecision {
  if (!bound) return "bind";
  return sameValue(bound, sub) ? "match" : "mismatch";
}

export async function verifyIdToken(
  token: string,
  o: { issuer: string; clientId: string; nonce: string; keys: JWTVerifyGetKey; now?: Date; requireVerified?: boolean },
): Promise<IdentityClaims> {
  let p: JWTPayload;
  try {
    ({ payload: p } = await jwtVerify(token, o.keys, {
      issuer: o.issuer,
      audience: o.clientId,
      algorithms: ALGS,
      requiredClaims: ["exp", "iat", "sub"],
      clockTolerance: 60,
      currentDate: o.now,
    }));
  } catch (e) {
    throw new OidcError("id_token", `id_token rejected: ${(e as Error).message}`);
  }
  if (!sameValue(p.nonce, o.nonce)) throw new OidcError("id_token", "id_token nonce does not match this sign-in");
  // Core §3.1.3.7: with several audiences (or any azp), the authorized party must be us.
  if ((Array.isArray(p.aud) && p.aud.length > 1) || p.azp !== undefined) {
    if (p.azp !== o.clientId) throw new OidcError("id_token", "id_token azp is not this client");
  }
  const email = normalizeEmail(p.email);
  if (!email) throw new OidcError("no_email", "id_token has no email claim (request the email scope)");
  if (!emailVerified(p, o.requireVerified ?? true)) throw new OidcError("unverified", `${email} is not verified by the provider`);
  if (typeof p.sub !== "string" || !p.sub || p.sub.length > 255) throw new OidcError("id_token", "id_token sub is not a usable subject");
  const given = [p.given_name, p.family_name].filter((x) => typeof x === "string").join(" ");
  const name = typeof p.name === "string" && p.name.trim() ? p.name.trim() : given || null;
  return { sub: p.sub, email, name };
}
