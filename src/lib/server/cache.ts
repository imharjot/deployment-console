// Tiny TTL cache with in-flight de-duplication. One ECS task serves the console, so process memory is the right place.
// Errors are never served as data: a failed refresh throws, and the caller marks its tile UNKNOWN.
//
// Joiners (R26/F24): a caller that joins an in-flight fetch gets that fetch's own { value, at } and never looks the
// key up again, so an invalidate() (an action, a re-scan) during the await can neither crash it nor hand it another
// generation's data. A fetch that finishes after its entry was invalidated writes only to its detached entry: an
// older generation never repopulates current state. A fetch never inherits its starter's AWS call signal (detached()).
//
// Stale-while-revalidate (F57, opt-in with staleMs): inside ttl + staleMs the cached value is returned with its
// ORIGINAL `at` and at most one background refresh starts; a failed background refresh is recorded, never thrown,
// never clears the value, and is never served beyond the window. Bound: a caller whose `at` feeds deriveState
// (svc:, hosts:, tg:) must keep ttl + staleMs ≤ 20 s, because LIMITS.staleMs is 30 s.
//
// Bounded (F28): entries are swept at most once a minute once older than max(2 × (ttl + staleMs), 10 min), the
// cache holds at most 5,000 TTL entries (oldest written first out) and 5,000 memo() entries (least recently used
// first out). An entry with a fetch in flight is never evicted.

interface Entry {
  value?: unknown;
  at: number;
  pending?: Promise<{ value: unknown; at: number }>; // the fetch in flight, resolving to its own { value, at }
  // Set only by an older module version (a dev server's sampler keeps the module it started with): it resolves to the
  // bare value, so it is never joined here, only respected by eviction. Remove once no pre-R26 bundle can run.
  inflight?: Promise<unknown>;
  errorAt?: number;
  error?: Error;
  ttlMs?: number; // missing on entries written by an older module version
  staleMs?: number;
}

// On globalThis: Next bundles instrumentation (the sampler) and routes separately; one cache means one set of AWS calls.
// Map order = write order (TTL entries) / use order (memo entries): the first entries are evicted first.
const g = globalThis as { __consoleCache?: Map<string, Entry>; __consoleCacheMeta?: { lastSweep: number } };
const store: Map<string, Entry> = (g.__consoleCache ??= new Map());
const meta = (g.__consoleCacheMeta ??= { lastSweep: 0 });

const NEGATIVE_MS = 2_000; // don't hammer a failing API more than every 2s
const SWEEP_EVERY_MS = 60_000;
const MIN_KEEP_MS = 10 * 60_000;
export const MAX_ENTRIES = 5_000;
export const MAX_MEMO = 5_000;
const FOREVER = Number.MAX_SAFE_INTEGER;
const isMemo = (e: Entry) => (e.ttlMs ?? 0) >= FOREVER;
const busy = (e: Entry) => !!(e.pending || e.inflight);

const asError = (err: unknown) => (err instanceof Error ? err : new Error(String(err)));

// Move to the end of the map: the newest write (TTL) or the most recent use (memo) is evicted last.
function touch(key: string, e: Entry) {
  if (store.get(key) !== e) return;
  store.delete(key);
  store.set(key, e);
}

// A fetch is shared by everyone who joins it, so it runs outside the call signal of the caller that happened to start it
// (aws-limiter.ts withCallSignal: a provider run's or a detail panel's deadline). Inside it, that deadline would abort
// the fetch for every joiner — the sampler, other providers — and nothing would be cached (R19). The limiter keeps its
// AsyncLocalStorage on globalThis; it is looked up there so this module stays free of server-only imports.
type Als = { exit<R>(fn: () => R): R };
function detached<T>(fn: () => Promise<T>): Promise<T> {
  const als = (globalThis as { __consoleAwsLimiter?: { signal?: Als } }).__consoleAwsLimiter?.signal;
  return als && typeof als.exit === "function" ? als.exit(fn) : fn();
}

function fetchInto<T>(key: string, entry: Entry, fn: () => Promise<T>): Promise<{ value: T; at: number }> {
  let p: Promise<T>;
  try {
    p = Promise.resolve(detached(fn));
  } catch (err) {
    p = Promise.reject(err);
  }
  const run: Promise<{ value: T; at: number }> = p.then(
    (value) => {
      const at = Date.now();
      entry.value = value;
      entry.at = at;
      entry.error = undefined;
      entry.errorAt = undefined;
      if (entry.pending === run) entry.pending = undefined;
      touch(key, entry);
      return { value, at };
    },
    (err) => {
      entry.error = asError(err);
      entry.errorAt = Date.now();
      if (entry.pending === run) entry.pending = undefined;
      throw entry.error;
    },
  );
  entry.pending = run;
  return run;
}

export async function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>, opts: { staleMs?: number } = {}): Promise<{ value: T; at: number }> {
  const now = Date.now();
  maybeSweep(now);
  const staleMs = Math.max(0, opts.staleMs ?? 0);
  const e = store.get(key);
  if (e) {
    e.ttlMs = ttlMs;
    e.staleMs = staleMs;
  }
  if (e && e.value !== undefined && now - e.at < ttlMs) {
    if (isMemo(e)) touch(key, e);
    return { value: e.value as T, at: e.at };
  }
  // Stale but inside the window: answer now, refresh once in the background (not while a recent refresh failed).
  if (e && e.value !== undefined && staleMs > 0 && now - e.at < ttlMs + staleMs) {
    const recentError = e.errorAt !== undefined && now - e.errorAt < NEGATIVE_MS;
    if (!e.pending && !recentError) fetchInto(key, e, fn).catch(() => {}); // recorded on the entry, never thrown
    return { value: e.value as T, at: e.at };
  }
  if (e?.error && e.errorAt && now - e.errorAt < NEGATIVE_MS) throw e.error;
  if (e?.pending) return (await e.pending) as { value: T; at: number };

  const entry: Entry = e ?? { at: 0, ttlMs, staleMs };
  if (!e) store.set(key, entry);
  const run = fetchInto(key, entry, fn);
  if (!e) enforceCaps(); // after the fetch is pending, so the new entry itself is never the one evicted
  return run;
}

// Forever-cache for immutable facts (commit metadata keyed by sha). Least recently used out beyond MAX_MEMO.
export function memo<T>(key: string, fn: () => Promise<T>) {
  return cached(key, FOREVER, fn).then((r) => r.value);
}

export function invalidate(prefix: string) {
  for (const k of store.keys()) if (k.startsWith(prefix)) store.delete(k);
}

function enforceCaps() {
  if (store.size <= Math.min(MAX_ENTRIES, MAX_MEMO)) return;
  let ttl = 0;
  let mem = 0;
  for (const e of store.values()) {
    if (isMemo(e)) mem++;
    else ttl++;
  }
  if (ttl <= MAX_ENTRIES && mem <= MAX_MEMO) return;
  for (const [k, e] of store) {
    if (ttl <= MAX_ENTRIES && mem <= MAX_MEMO) break;
    if (busy(e)) continue;
    if (isMemo(e)) {
      if (mem > MAX_MEMO) {
        store.delete(k);
        mem--;
      }
    } else if (ttl > MAX_ENTRIES) {
      store.delete(k);
      ttl--;
    }
  }
}

function maybeSweep(now: number) {
  if (now - meta.lastSweep < SWEEP_EVERY_MS) return;
  sweepCache(now);
}

// Drops entries nobody has refreshed for a long time. Exported for tests and diagnostics.
export function sweepCache(now: number = Date.now()): number {
  meta.lastSweep = now;
  let dropped = 0;
  for (const [k, e] of store) {
    if (busy(e) || isMemo(e)) continue;
    const last = Math.max(e.at, e.errorAt ?? 0);
    if (now - last > Math.max(2 * ((e.ttlMs ?? 0) + (e.staleMs ?? 0)), MIN_KEEP_MS)) {
      store.delete(k);
      dropped++;
    }
  }
  enforceCaps();
  return dropped;
}

export function cacheStats(): { entries: number; memo: number; inflight: number } {
  let mem = 0;
  let inflight = 0;
  for (const e of store.values()) {
    if (isMemo(e)) mem++;
    if (busy(e)) inflight++;
  }
  return { entries: store.size - mem, memo: mem, inflight };
}
