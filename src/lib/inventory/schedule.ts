// Which provider runs where, and what a set of runs says about the map's completeness. Pure (no I/O): the inventory
// (src/lib/server/inventory.ts) plans its runs here, classifies their failures, and reports coverage from the outcomes.
//
// Scopes (audit §6 C):
// - "regional" (the default): one run per console region.
// - "global" (or `global: true`): one run, in the provider's `homeRegion` (IAM in us-east-1, Global Accelerator in
//   us-west-2) or else the home region. CloudFront, Route 53, Cloudflare and S3's bucket list are account-wide.
// - "home": one run in the home region. The ECS-side providers read the multi-region discovery inventory, which already
//   spans every region, so running them per region would list each environment once per region.
// Runs are keyed `${id}@${region}`. With one region configured the plan is exactly one run per provider, in home.
//
// Simulated account: a regional provider runs outside home only when its mock answers per region (`multiRegionMock`),
// so the demo never shows a second copy of Acme in eu-west-1.
//
// Also here, pure so they are tested directly: run slots, the per-run deadline with its checkpoint (R18), freshness,
// and how per-region outcomes fold into one ProviderStatus row.
import { keyRegion, type InventoryCompleteness, type ProviderResult, type ProviderStatus, type RegionStatus, type Resource } from "./types.ts";

export type Scope = "regional" | "global" | "home";

// What planning needs from a provider (a subset of the server's Provider contract).
export interface Schedulable {
  id: string;
  scope?: Scope;
  global?: boolean;
  homeRegion?: string;
  multiRegionMock?: boolean;
}

export interface PlannedRun {
  key: string; // `${id}@${region}`
  id: string;
  region: string;
  scope: Scope;
  phase: 1 | 2; // 1 = home and global runs (published first); 2 = the other regions (merged when done)
}

// Until wave-B providers declare `scope` themselves: the ECS side reads the region-spanning discovery inventory (home),
// and the edge providers are account-wide (global).
export const HOME_SCOPED: ReadonlySet<string> = new Set(["ecs", "elb", "rds", "elasticache", "ecs-image", "declared"]);
export const GLOBAL_SCOPED: ReadonlySet<string> = new Set(["s3", "cloudfront", "route53", "cloudflare"]);

export function scopeOf(p: Schedulable): Scope {
  if (p.scope) return p.scope;
  if (HOME_SCOPED.has(p.id)) return "home";
  if (GLOBAL_SCOPED.has(p.id) || p.global) return "global";
  return "regional";
}

export const runKey = (id: string, region: string) => `${id}@${region}`;

// Home first, then the other regions in the order given, de-duplicated.
export const orderRegions = (regions: string[], home: string): string[] => [...new Set([home, ...regions.filter(Boolean)])];

export function planRuns(providers: Schedulable[], regions: string[], home: string, mock: boolean): PlannedRun[] {
  const all = orderRegions(regions, home);
  const out: PlannedRun[] = [];
  for (const p of providers) {
    const scope = scopeOf(p);
    if (scope === "home") out.push({ key: runKey(p.id, home), id: p.id, region: home, scope, phase: 1 });
    else if (scope === "global") {
      const region = p.homeRegion ?? home;
      out.push({ key: runKey(p.id, region), id: p.id, region, scope, phase: 1 });
    } else
      for (const region of all) {
        if (region !== home && mock && p.multiRegionMock !== true) continue;
        out.push({ key: runKey(p.id, region), id: p.id, region, scope, phase: region === home ? 1 : 2 });
      }
  }
  return out;
}

// The region a resource lives in, for its detail panel and its actions: the key's "@region" suffix or ARN region, else
// the region its provider reported, else home ("global" resources, and region-less ARNs such as IAM's).
// An S3 bucket's ARN has no region, so its own (the bucket's location) wins.
export function resourceRegion(r: Pick<Resource, "key" | "region">, home: string): string {
  const fromKey = keyRegion(r.key, "");
  if (fromKey) return fromKey;
  return r.region && r.region !== "global" ? r.region : home;
}

// ---------- failures ----------

export type RunFailure = "denied" | "skipped" | "error";

const DENIED_NAME = /AccessDenied|UnauthorizedOperation|AuthorizationError|Forbidden|NotAuthorized/i;
// A region the account hasn't opted into, or a service AWS doesn't offer there: nothing to read, not a fault.
const NOT_OFFERED = /ENOTFOUND|UnknownEndpoint|not (?:supported|available|offered) in (?:this|the) region|not opted.?in|OptInRequired|SubscriptionRequired/i;
// What an opt-in region answers before the account opts in. In the home region (always enabled) the same codes mean
// the credentials are bad: that's an error, never a quiet skip.
const NOT_ENABLED = /UnrecognizedClientException|InvalidClientTokenId/;

const parts = (e: unknown): { name: string; code: string; message: string } => {
  const x = (e ?? {}) as { name?: unknown; Code?: unknown; code?: unknown; message?: unknown; cause?: unknown };
  const cause = (x.cause ?? {}) as { code?: unknown; message?: unknown };
  return {
    name: String(x.name ?? x.Code ?? ""),
    code: String(x.code ?? cause.code ?? ""),
    message: `${String(x.message ?? "")} ${String(cause.message ?? "")}`,
  };
};

// denied: IAM or an SCP refused (the provider's status shows the action AWS named) · skipped: the region isn't enabled
// or the service isn't offered there · error: everything else.
// `listedBefore`: this provider × region returned resources on an earlier run. A service doesn't stop being offered in
// a region, so "not offered" signs there (ENOTFOUND when DNS or the network is down, a token error) are a fault: an error
// that keeps the last good list — never a quiet skip that empties the map and calls it complete.
export function classifyError(e: unknown, o: { home?: boolean; listedBefore?: boolean } = {}): RunFailure {
  const { name, code, message } = parts(e);
  if (DENIED_NAME.test(name) || /not authorized to perform|explicit deny in a service control policy/i.test(message)) return "denied";
  const skip = o.listedBefore ? "error" : "skipped";
  if (NOT_OFFERED.test(name) || NOT_OFFERED.test(code) || NOT_OFFERED.test(message)) return skip;
  if (NOT_ENABLED.test(name) || NOT_ENABLED.test(code)) return o.home ? "error" : skip;
  return "error";
}

// ---------- coverage ----------

// One finished run, as the inventory summarises it for coverage.
export interface RunOutcome {
  id: string;
  region: string;
  state: ProviderStatus["state"];
  covers?: string[]; // the provider's Resource Explorer types
  partial?: boolean; // the deadline cut it short (its checkpoint is shown)
  truncated?: boolean; // it hit the per-type cap: more exist than were listed
  stale?: boolean; // served from an older or persisted run, not this build
  missing?: string[]; // IAM actions AWS refused
}

// "type@region" for every type a run listed completely: ok, this build's, not cut short, not capped. The catch-all keeps
// covered types out of its generic rows; a type that is covered but unmatched is a key-format bug (audit B.4).
export function covered(runs: RunOutcome[]): Set<string> {
  const out = new Set<string>();
  for (const r of runs) if (r.state === "ok" && !r.partial && !r.truncated && !r.stale) for (const t of r.covers ?? []) out.add(`${t}@${r.region}`);
  return out;
}

// "type@region" → why the provider that covers it couldn't read it there (denied or failed; a region a service control
// policy closes is "skipped" and isn't listed). The catch-all's generic rows of those types say so rather than looking
// covered-but-unmatched or unmanaged.
export function unreadableTypes(runs: RunOutcome[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of runs) {
    if (r.state !== "denied" && r.state !== "error") continue;
    for (const t of r.covers ?? []) {
      const k = `${t}@${r.region}`;
      if (!Object.hasOwn(out, k)) out[k] = `${r.id} couldn't read it (${r.missing?.join(", ") || "error"})`;
    }
  }
  return out;
}

export interface CompletenessInput {
  resources: Pick<Resource, "enrichment">[];
  generatedAt: number;
  pendingRegions?: string[]; // phase 2 still running: not complete yet
  unresolvedRefs?: number;
  lastCompleteAt?: number; // the previous complete build, kept while this one isn't
}

// `providers` counts providers, not runs: each once, at its worst run (denied > error > partial > ok > skipped >
// disabled), so a permission missing in three regions is one denied provider, and a stub registered in every region is
// one disabled provider.
const WORST: Record<keyof InventoryCompleteness["providers"], number> = { denied: 5, error: 4, partial: 3, ok: 2, skipped: 1, disabled: 0 };

export function completeness(runs: RunOutcome[], view: CompletenessInput): InventoryCompleteness {
  const providers: InventoryCompleteness["providers"] = { ok: 0, denied: 0, error: 0, skipped: 0, disabled: 0, partial: 0 };
  const capped = new Set<string>(), denied = new Set<string>(), stale = new Set<string>();
  const worst = new Map<string, keyof InventoryCompleteness["providers"]>();
  let complete = !view.pendingRegions?.length;
  for (const r of runs) {
    const s = r.state === "ok" && r.partial ? "partial" : r.state;
    const was = worst.get(r.id);
    if (!was || WORST[s] > WORST[was]) worst.set(r.id, s);
    if (r.truncated) for (const t of r.covers?.length ? r.covers : [r.id]) capped.add(`${t}@${r.region}`);
    for (const m of r.missing ?? []) denied.add(m);
    if (r.stale) stale.add(`${r.id}@${r.region}`);
    // Disabled (not set up) and skipped (not offered in that region) runs don't make the map incomplete.
    if (r.state === "denied" || r.state === "error" || r.partial || r.truncated || r.stale) complete = false;
  }
  for (const s of worst.values()) providers[s]++;
  let enrichmentSkipped = 0;
  for (const res of view.resources) for (const s of Object.values(res.enrichment ?? {})) if (s !== "ok") enrichmentSkipped++;
  const lastCompleteAt = complete ? view.generatedAt : view.lastCompleteAt;
  return {
    ...(lastCompleteAt ? { lastCompleteAt } : {}),
    providers,
    cappedTypes: [...capped].sort(),
    deniedActions: [...denied].sort(),
    staleProviders: [...stale].sort(),
    unresolvedRefs: view.unresolvedRefs ?? 0,
    enrichmentSkipped,
  };
}

// ---------- running ----------

const timeoutError = (what: string, ms: number) => Object.assign(new Error(`${what} timed out after ${Math.round(ms / 1000)} s`), { name: "TimeoutError" });

// At most n tasks at a time, first come first served. A waiter whose signal fires leaves the queue without running.
export type Slots = <T>(fn: () => Promise<T>, signal?: AbortSignal) => Promise<T>;
export function slots(n: number): Slots {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async <T,>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> => {
    const gaveUp = () => Object.assign(new Error("not started: out of time"), { name: "TimeoutError" });
    if (signal?.aborted) throw gaveUp();
    if (active < n) active++;
    else
      await new Promise<void>((resolve, reject) => {
        const go = () => {
          signal?.removeEventListener("abort", give);
          resolve(); // the finishing task hands its slot over: `active` stays as it is
        };
        const give = () => {
          const i = waiting.indexOf(go);
          if (i >= 0) waiting.splice(i, 1);
          reject(gaveUp());
        };
        signal?.addEventListener("abort", give, { once: true });
        waiting.push(go);
      });
    try {
      return await fn();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  };
}

export type Attempt<R> =
  | { kind: "done"; result: R; ms: number }
  | { kind: "partial"; result: R; ms: number } // the deadline cut it short: its last checkpoint
  | { kind: "failed"; error: unknown; ms: number; timedOut: boolean };

// Runs one provider pass with a deadline that starts now. `within` wraps the call so the deadline reaches every AWS call
// made inside it (withCallSignal); the signal handed to `run` aborts at the deadline and again when the attempt ends,
// so nothing it queued starts afterwards. A checkpoint taken before the deadline is what a cut-short run returns.
export async function attempt<R>(o: {
  what: string;
  deadlineMs: number;
  run: (signal: AbortSignal, checkpoint: (partial: R) => void) => Promise<R>;
  within?: <T>(signal: AbortSignal, fn: () => Promise<T>) => Promise<T>;
  now?: () => number;
}): Promise<Attempt<R>> {
  const now = o.now ?? Date.now;
  const t0 = now();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), o.deadlineMs);
  let saved: { r: R } | undefined;
  const checkpoint = (r: R) => {
    if (!ac.signal.aborted) saved = { r };
  };
  const cut = new Promise<never>((_, reject) => {
    const fire = () => reject(timeoutError(o.what, o.deadlineMs));
    if (ac.signal.aborted) fire();
    else ac.signal.addEventListener("abort", fire, { once: true });
  });
  cut.catch(() => undefined); // only observed through the race below
  try {
    const go = () => o.run(ac.signal, checkpoint);
    const result = await Promise.race([o.within ? o.within(ac.signal, go) : go(), cut]);
    return { kind: "done", result, ms: now() - t0 };
  } catch (error) {
    const timedOut = ac.signal.aborted;
    if (timedOut && saved) return { kind: "partial", result: saved.r, ms: now() - t0 };
    return { kind: "failed", error, ms: now() - t0, timedOut };
  } finally {
    clearTimeout(timer);
    ac.abort();
  }
}

// What freshness needs to know about a finished run.
export interface RunFreshness {
  state: ProviderStatus["state"];
  count: number;
  partial?: boolean;
  ranAt: number;
  rerun?: boolean;
}

export const DEFAULT_TTL = 120_000;
export const EMPTY_TTL = 30 * 60_000;

// A run is reused while it is fresh: the provider's ttlMs (2 min by default); failures at most 2 min, so they are retried
// soon; an ok run that found nothing (an unused region) for 30 min. Forced refreshes and invalidated runs never are.
export function isFresh(r: RunFreshness | undefined, ttlMs: number | undefined, now: number, force = false): boolean {
  if (!r || r.rerun || force) return false;
  const base = ttlMs ?? DEFAULT_TTL;
  const ttl = r.state !== "ok" ? Math.min(base, DEFAULT_TTL) : r.count === 0 && !r.partial ? Math.max(base, EMPTY_TTL) : base;
  return now - r.ranAt < ttl;
}

// More of some kind than the per-type cap, or the provider said it stopped early ("showing the first 2,000 …").
export function truncatedBy(r: ProviderResult, notes: string[], cap: number): boolean {
  const n = new Map<string, number>();
  for (const x of r.resources) n.set(x.kind, (n.get(x.kind) ?? 0) + 1);
  return [...n.values()].some((c) => c >= cap) || notes.some((x) => /showing the first/i.test(x));
}

// One run's outcome, as the provider row is folded from.
export interface RunStatus {
  region: string;
  status: RegionStatus;
  scp?: boolean; // denied by a service control policy
}

// One ProviderStatus row from a provider's runs. With one run in home it is exactly that run's outcome. Otherwise the
// worst counted outcome wins (denied > error > ok) and errors name their region; a region where the service isn't
// offered (skipped) and a non-home region a service control policy closes are per-region facts, in `notes` and
// `regions`, not provider faults. `off` says why a provider that has no runs yet is turned off.
export function aggregate(p: { id: string; label: string }, runs: RunStatus[], o: { home: string; regions: string[]; off?: string }): ProviderStatus {
  const multi = o.regions.length > 1 || runs.some((r) => r.region !== o.home);
  const base = { id: p.id, label: p.label, count: runs.reduce((a, r) => a + r.status.count, 0), at: Math.max(0, ...runs.map((r) => r.status.at)) };
  // Only after a restart, before the first build has run it.
  if (!runs.length) return o.off ? { ...base, state: "disabled", error: o.off } : { ...base, state: "skipped", error: "not read yet — refreshing" };
  const counted = runs.filter((r) => r.status.state !== "skipped" && r.status.state !== "disabled" && !(r.scp && r.region !== o.home));
  const rank: Record<ProviderStatus["state"], number> = { denied: 3, error: 2, ok: 1, skipped: 0, disabled: 0 };
  const worst = counted.length ? counted.reduce((a, r) => (rank[r.status.state] > rank[a.status.state] ? r : a)).status.state : runs[0].status.state;
  const bad = counted.filter((r) => r.status.state === worst && worst !== "ok");
  const error = bad.length
    ? bad.map((r) => (multi ? `${r.region}: ${r.status.error ?? worst}` : r.status.error)).filter(Boolean).join(" · ")
    : !counted.length ? runs[0].status.error : runs.find((r) => r.status.partial)?.status.error;
  const missing = [...new Set(counted.flatMap((r) => r.status.missing ?? []))];
  const notes = runs.flatMap((r) =>
    r.status.state === "skipped" && multi ? [`skipped in ${r.region}: ${r.status.error ?? "not offered there"}`]
    : r.scp && r.region !== o.home ? [`denied in ${r.region} by a service control policy`]
    : [],
  );
  const times = runs.map((r) => r.status.ms).filter((x): x is number => typeof x === "number");
  return {
    ...base, state: worst,
    ...(error ? { error } : {}),
    ...(missing.length ? { missing } : {}),
    ...(times.length ? { ms: Math.max(...times) } : {}),
    ...(runs.some((r) => r.status.partial) ? { partial: true } : {}),
    ...(notes.length ? { notes } : {}),
    ...(multi ? { regions: runs.map((r) => r.status) } : {}),
  };
}
