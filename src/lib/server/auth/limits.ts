// In-memory failure throttles (per instance, reset on restart). globalThis: each route is its own bundle.
import "server-only";
import { RateLimiter } from "../../authn.ts";

const WINDOW = 15 * 60_000;
type Name = "login" | "loginIp" | "loginEmail" | "links" | "password" | "apiToken" | "apiTokenBad";
const g = globalThis as typeof globalThis & { __consoleLimits?: Partial<Record<Name, RateLimiter>> };

const fresh = (): Record<Name, RateLimiter> => ({
  login: new RateLimiter(10, WINDOW), // per email + IP
  loginIp: new RateLimiter(50, WINDOW), // per IP across emails (password spraying)
  // Per email whatever the IP: X-Forwarded-For can be rotated by a client, so this is the cap that always holds.
  // Trade-off: someone can lock an account out of password sign-in for 15 min (SSO still works).
  loginEmail: new RateLimiter(50, WINDOW),
  links: new RateLimiter(20, WINDOW), // bad invite / reset / setup tokens per IP
  password: new RateLimiter(10, WINDOW), // wrong "current password" per user
  apiToken: new RateLimiter(120, 60_000), // requests per API token per minute (a counter here, not a failure count)
  apiTokenBad: new RateLimiter(30, WINDOW), // unknown / revoked / expired API tokens per IP
});
// Existing counters win, so a reload that adds a limiter keeps the ones already counting.
export const limits = (g.__consoleLimits = { ...fresh(), ...g.__consoleLimits }) as Record<Name, RateLimiter>;

// Per-address limits count only when the address is known, i.e. behind a proxy that appends X-Forwarded-For. Without
// one every client would share a single "unknown" bucket and anyone could lock everyone out; the per-email and
// per-token limits still hold. Returns 0 (no wait) / does nothing for an unknown address.
export const ipWait = (l: RateLimiter, ip: string | undefined, prefix = "") => (ip ? l.retryIn(prefix + ip) : 0);
export const ipFail = (l: RateLimiter, ip: string | undefined, prefix = "") => void (ip && l.fail(prefix + ip));

export const retryText = (ms: number) => `Too many attempts. Try again in ${Math.max(1, Math.ceil(ms / 60_000))} min.`;
