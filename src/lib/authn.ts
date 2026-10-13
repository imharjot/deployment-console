// Pure authentication helpers shared by the proxy, the auth routes and the tests. No DB, no server-only import.
import { createHash, randomBytes } from "node:crypto";
import { isRole, type Role } from "./rbac.ts";

export type AuthMode = "session" | "alb" | "dev";
export type Env = Record<string, string | undefined>;

export const SESSION_COOKIE = "console_session";
export const OIDC_COOKIE = "console_oidc";
export const RENEW_EVERY_MS = 10 * 60_000; // sliding renewal writes at most this often
export const MAX_SESSION_MS = 7 * 24 * 3_600_000; // absolute cap: activity can't keep a session alive forever

// AUTH_MODE unset = session. dev is refused in production builds so a leaked env file can't open the console.
export function resolveAuthMode(env: Env): { ok: true; mode: AuthMode } | { ok: false; error: string } {
  const m = (env.AUTH_MODE ?? "").trim().toLowerCase();
  if (m === "" || m === "session") return { ok: true, mode: "session" };
  if (m === "alb") return { ok: true, mode: "alb" };
  if (m === "dev") {
    if (env.NODE_ENV === "production") return { ok: false, error: "AUTH_MODE=dev is refused when NODE_ENV=production. Use session (default) or alb." };
    return { ok: true, mode: "dev" };
  }
  return { ok: false, error: `AUTH_MODE "${m}" is not one of session, alb, dev.` };
}

export interface OidcSettings {
  issuer: string;
  clientId: string;
  clientSecret?: string;
  scopes: string;
  label: string;
}

export interface AuthConfig {
  passwordLogin: boolean;
  oidc: OidcSettings | null;
  ttlMs: number;
  allowedDomains: string[];
  defaultRole: Role;
  publicUrl?: string;
  problems: string[]; // misconfiguration worth logging
}

const parseList = (v: string | undefined) => (v ?? "").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);

// Auto-provisioned (SSO/ALB) users can be at most operator: admins are always invited by name.
export function autoRole(v: string | undefined): Role {
  const r = (v ?? "").trim().toLowerCase();
  return isRole(r) && r !== "admin" ? r : "viewer";
}

const localHost = (h: string) => h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h.endsWith(".localhost");

export function readAuthConfig(env: Env): AuthConfig {
  const problems: string[] = [];
  let oidc: OidcSettings | null = null;
  const issuer = env.OIDC_ISSUER?.trim().replace(/\/+$/, "");
  if (issuer) {
    let u: URL | null = null;
    try {
      u = new URL(issuer);
    } catch {
      problems.push("OIDC_ISSUER is not a URL");
    }
    if (u && u.protocol !== "https:" && !(u.protocol === "http:" && localHost(u.hostname))) problems.push("OIDC_ISSUER must use https");
    else if (u && !env.OIDC_CLIENT_ID) problems.push("OIDC_ISSUER is set but OIDC_CLIENT_ID is missing");
    else if (u)
      oidc = {
        issuer,
        clientId: env.OIDC_CLIENT_ID!.trim(),
        clientSecret: env.OIDC_CLIENT_SECRET?.trim() || undefined,
        scopes: env.OIDC_SCOPES?.trim() || "openid email profile",
        label: env.OIDC_LABEL?.trim() || "Sign in with SSO",
      };
  }
  const hours = Number(env.SESSION_TTL_HOURS);
  const ttlHours = Number.isFinite(hours) && hours > 0 ? Math.min(hours, 24 * 30) : 12;
  const role = env.AUTH_DEFAULT_ROLE?.trim().toLowerCase();
  if (role === "admin") problems.push("AUTH_DEFAULT_ROLE=admin is not allowed; auto-created users get viewer");
  const publicUrl = env.CONSOLE_PUBLIC_URL?.trim().replace(/\/+$/, "") || undefined;
  return {
    passwordLogin: (env.AUTH_PASSWORD_LOGIN ?? "").trim().toLowerCase() !== "false",
    oidc,
    ttlMs: ttlHours * 3_600_000,
    allowedDomains: parseList(env.AUTH_ALLOWED_DOMAINS).map((d) => d.replace(/^@/, "")),
    defaultRole: autoRole(env.AUTH_DEFAULT_ROLE),
    publicUrl,
    problems,
  };
}

// ---------- tokens ----------

// Session, invite, reset and setup tokens: 32 random bytes. Only sha256(token) is ever stored.
export const newToken = () => randomBytes(32).toString("base64url");
export const hashToken = (t: string) => createHash("sha256").update(t).digest("hex");
export const isTokenShape = (t: unknown): t is string => typeof t === "string" && /^[A-Za-z0-9_-]{43}$/.test(t);

// ---------- input ----------

export function normalizeEmail(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const e = v.trim().toLowerCase();
  if (e.length > 254 || !/^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]+$/.test(e)) return null;
  return e;
}

export function cleanName(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const n = v.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 100);
  return n || null;
}

// Post-login redirect target: same-origin relative paths only (no "//host", no "/\host", no schemes).
export function safeNext(v: unknown): string {
  if (typeof v !== "string" || !v.startsWith("/") || v.startsWith("//") || v.length > 2000) return "/";
  if (/[\\\u0000-\u001f\u007f]/.test(v)) return "/";
  try {
    const base = "http://console.invalid";
    const u = new URL(v, base);
    // Dot segments can normalise "/a/../..//evil" into "//evil", which a browser reads as another host.
    if (u.origin !== base || u.pathname.startsWith("//")) return "/";
    if (/^\/(login|setup|invite)(\/|$)/.test(u.pathname) || u.pathname.startsWith("/api/")) return "/";
    return u.pathname + u.search + u.hash;
  } catch {
    return "/";
  }
}

// ---------- cookies ----------

// Secure when the public URL is https or the TLS-terminating proxy says so.
export function isSecure(o: { publicUrl?: string; forwardedProto?: string | null; protocol?: string }): boolean {
  if (o.publicUrl) return o.publicUrl.startsWith("https://");
  if (o.forwardedProto) return o.forwardedProto.split(",")[0].trim() === "https";
  return o.protocol === "https:";
}

export interface CookieSpec {
  name: string;
  value: string;
  httpOnly: true;
  sameSite: "lax";
  secure: boolean;
  path: string;
  maxAge: number; // seconds; 0 deletes
}

// Lax (not Strict) so the cookie survives the top-level redirect back from an SSO provider.
export const sessionCookie = (value: string, secure: boolean, maxAgeMs: number): CookieSpec => ({
  name: SESSION_COOKIE, value, httpOnly: true, sameSite: "lax", secure, path: "/", maxAge: Math.max(0, Math.floor(maxAgeMs / 1000)),
});

// ---------- sessions ----------

// New expiry when a renewal is due (at most every RENEW_EVERY_MS), else null. Never past the absolute cap.
export function renewedExpiry(s: { createdAt: number; expiresAt: number }, now: number, ttlMs: number): number | null {
  const lastRenewed = s.expiresAt - ttlMs;
  if (now - lastRenewed < RENEW_EVERY_MS) return null;
  const next = Math.min(now + ttlMs, s.createdAt + Math.max(MAX_SESSION_MS, ttlMs));
  return next > s.expiresAt ? next : null;
}

// ---------- SSO provisioning ----------

const domainOf = (email: string) => email.slice(email.lastIndexOf("@") + 1);
const domainAllowed = (email: string, domains: string[]) => domains.includes(domainOf(email));

export type Provision = "use" | "create" | "disabled" | "denied";

// An existing (invited) row always wins; otherwise only allow-listed domains are auto-created.
export function provisionDecision(row: { disabled: number | boolean } | undefined, email: string, domains: string[]): Provision {
  if (row) return Number(row.disabled) ? "disabled" : "use";
  return domainAllowed(email, domains) ? "create" : "denied";
}

// ---------- login throttling ----------

// Fixed-window failure counter per key (e.g. email|ip). In memory: resets on restart, per instance.
export class RateLimiter {
  private hits = new Map<string, number[]>();
  readonly max: number;
  readonly windowMs: number;
  constructor(max: number, windowMs: number) {
    this.max = max;
    this.windowMs = windowMs;
  }

  // ms until the key may try again; 0 = allowed.
  retryIn(key: string, now = Date.now()): number {
    const h = this.recent(key, now);
    return h.length >= this.max ? h[0] + this.windowMs - now : 0;
  }

  fail(key: string, now = Date.now()) {
    const h = this.recent(key, now);
    h.push(now);
    this.hits.set(key, h);
    if (this.hits.size > 10_000) this.prune(now);
  }

  reset(key: string) {
    this.hits.delete(key);
  }

  private recent(key: string, now: number) {
    return (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
  }

  private prune(now: number) {
    for (const [k, h] of this.hits) if (!h.some((t) => now - t < this.windowMs)) this.hits.delete(k);
  }
}
