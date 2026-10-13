// Optional HTTP probe of a service's public health URL (tag console:healthcheck) — the real user path through the
// load balancer or reverse proxy. Two consecutive failures count as failing (flap guard).
//
// The URL comes from a tag, so anyone who can tag a service chooses it: http(s) only, at most 2,048 characters, and it
// goes through the integrations' egress guard (plugins/http.ts) — private addresses allowed (an internal load
// balancer is normal), link-local and metadata addresses never, the address pinned for the connection, no redirects.
//
// The failure counter lives on globalThis (F30): the sampler (instrumentation bundle) and the routes load separate
// copies of this module, and with a counter each they disagreed — a route's failure plus a sampler's failure never
// added up, and a success seen by one never reset the other. A count older than 60 s starts again from zero.
import { LIMITS } from "../config.ts";
import { safeFetch } from "../plugins/http.ts";
import type { ProbeResult } from "../types.ts";
import { cached } from "./cache.ts";

export const MAX_PROBE_URL = 2_048;
export const PROBE_FAILURE_TTL_MS = 60_000;

type Failures = Map<string, { n: number; at: number }>;
const failures: Failures = ((globalThis as { __consoleProbeFailures?: Failures }).__consoleProbeFailures ??= new Map());

// The next consecutive-failure count for url (0 after a pass), remembered for every module copy.
function count(url: string, pass: boolean): number {
  const now = Date.now();
  if (pass) {
    failures.delete(url);
    return 0;
  }
  const prev = failures.get(url);
  const n = prev && now - prev.at <= PROBE_FAILURE_TTL_MS ? prev.n + 1 : 1;
  failures.set(url, { n, at: now });
  if (failures.size > 5_000) for (const [k, v] of failures) if (now - v.at > PROBE_FAILURE_TTL_MS) failures.delete(k);
  return n;
}

// Why a health-check URL can't be probed, or null. The address checks happen in safeFetch.
export function probeUrlProblem(url: string): string | null {
  if (url.length > MAX_PROBE_URL) return `health-check URL is longer than ${MAX_PROBE_URL} characters`;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return "health-check URL is not a valid URL";
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return "health-check URL must be http(s)";
  if (u.username || u.password) return "health-check URL must not carry credentials";
  return null;
}

async function once(url: string): Promise<ProbeResult> {
  const bad = probeUrlProblem(url);
  if (bad) return { url, pass: false, consecutiveFailures: count(url, false), error: bad };
  const t0 = performance.now();
  try {
    const res = await safeFetch(url, { signal: AbortSignal.timeout(LIMITS.probeTimeoutMs), redirect: "manual" }, { allowPrivate: true });
    await res.body?.cancel().catch(() => {});
    const ms = Math.round(performance.now() - t0);
    const pass = res.status === 200;
    return { url, pass, consecutiveFailures: count(url, pass), status: res.status, ms };
  } catch (e) {
    const err = e as Error & { code?: string };
    return { url, pass: false, consecutiveFailures: count(url, false), error: err.name === "TimeoutError" ? "probe timeout" : err.name === "EgressRefused" ? err.message : (err.code ?? err.message) };
  }
}

export const probe = (url: string) => cached(`probe:${url}`, 10_000, () => once(url)).then((r) => r.value);
