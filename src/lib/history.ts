// State history per resource, in process memory, bounded to WINDOW_MS. A sampler records every 30s even when nobody
// has the page open, so uptime reflects reality rather than viewing habits. Transitions are also persisted by
// src/lib/server/console.ts (state_changes, plus the spans the sampler observed each environment), and restore()
// rebuilds this history from them after a restart.
//
// Uptime is computed at read time over the window that ends *now* (R21), weighted by time (F66): each sample covers the
// time until the next one, at most SAMPLE_CAP_MS, so one old sample can't vouch for hours and a closely watched
// incident doesn't count more than a quiet hour. Time nobody observed is excluded from the percentage and shown as an
// empty bar. It measures operational state — parked and deploying count as good — not customer availability.
import type { State, UptimeView } from "./types.ts";

export const WINDOW_MS = 2 * 60 * 60_000;
export const SAMPLE_CAP_MS = 60_000;
export const UPTIME_BASIS = "operational state (not customer availability)";
const BUCKETS = 60;

// [time, state] from a sampler or a view; a third element is an explicit end of coverage (a span rebuilt by restore()).
type Sample = [t: number, s: State, until?: number];
// Shared on globalThis so the background sampler (instrumentation bundle) and the routes see one history.
const g = globalThis as { __consoleHistory?: Map<string, Sample[]>; __consoleHistorySince?: Map<string, [State, number]> };
const series: Map<string, Sample[]> = (g.__consoleHistory ??= new Map());
// When each resource's current state began, kept beyond the window (and restored from the persisted transitions).
const sinceOf: Map<string, [State, number]> = (g.__consoleHistorySince ??= new Map());

// What uptime() returns: the frozen UptimeView plus what it is a measure of and the unobserved time inside it.
export type Uptime = UptimeView & { basis: string; gapMs: number };

// The end of the time a sample vouches for.
const coverEnd = (a: Sample[], i: number, now: number) => {
  const [t, , until] = a[i];
  const next = a[i + 1]?.[0] ?? Infinity;
  return Math.min(until ?? t + SAMPLE_CAP_MS, next, now);
};

// Record a state. Repeats within 5s are dropped (several requests computing the same moment).
export function record(key: string, state: State, t = Date.now()) {
  let a = series.get(key);
  if (!a) series.set(key, (a = []));
  const last = a[a.length - 1];
  if (last && t - last[0] < 5_000 && last[1] === state) return;
  if (last && t < last[0]) return; // out of order (a slow request finishing late): the newer sample stands
  a.push([t, state]);
  const s = sinceOf.get(key);
  if (!s || s[0] !== state) sinceOf.set(key, [state, t]);
  trim(a, t);
}

const trim = (a: Sample[], now: number) => {
  const cut = now - WINDOW_MS;
  let drop = 0;
  while (drop < a.length - 1 && coverEnd(a, drop, now) < cut) drop++;
  if (drop) a.splice(0, drop);
};

// The latest recorded state (console.ts persists a row when a new one differs).
export function latestState(key: string): State | undefined {
  const a = series.get(key);
  return a?.[a.length - 1]?.[1];
}

// "Good" = serving, or deliberately parked (stopped / box stopped) or rolling out — parking isn't downtime.
const GOOD = new Set<State>(["UP", "STOPPED", "BOX_STOPPED", "DEPLOYING"]);
const WORST: State[] = ["DOWN", "UNKNOWN", "DEGRADED", "DEPLOYING", "BOX_STOPPED", "STOPPED", "UP"];

export function uptime(key: string, now = Date.now()): Uptime {
  const a = series.get(key) ?? [];
  const bars: (State | null)[] = Array(BUCKETS).fill(null);
  const size = WINDOW_MS / BUCKETS;
  const start = now - WINDOW_MS;
  let covered = 0;
  let good = 0;
  let first: number | undefined;
  for (let i = 0; i < a.length; i++) {
    const from = Math.max(a[i][0], start);
    const to = coverEnd(a, i, now);
    if (to <= from) continue;
    const s = a[i][1];
    first ??= from;
    covered += to - from;
    if (GOOD.has(s)) good += to - from;
    // A bucket shows the worst state seen in it.
    const lo = Math.max(0, Math.floor((from - start) / size));
    const hi = Math.min(BUCKETS - 1, Math.floor((to - 1 - start) / size));
    for (let b = lo; b <= hi; b++) if (bars[b] === null || WORST.indexOf(s) < WORST.indexOf(bars[b]!)) bars[b] = s;
  }
  return {
    pct: covered > 0 ? Math.round((good / covered) * 1000) / 10 : null,
    bars,
    since: sinceFor(key, a),
    windowMs: WINDOW_MS,
    coveredMs: covered,
    gapMs: first === undefined ? 0 : now - first - covered, // unobserved time since observation started in the window
    basis: UPTIME_BASIS,
  };
}

// When the current state began: the recorded change (kept beyond the window), else the last change among the samples.
function sinceFor(key: string, a: Sample[]): number | undefined {
  const cur = a[a.length - 1]?.[1];
  const s = sinceOf.get(key);
  if (cur !== undefined && s && s[0] === cur) {
    // A change seen among the samples after the recorded one wins (an older module version may have recorded it).
    for (let i = a.length - 1; i > 0; i--) if (a[i - 1][1] !== a[i][1]) return Math.max(a[i][0], s[1]);
    return s[1];
  }
  for (let i = a.length - 1; i > 0; i--) if (a[i - 1][1] !== a[i][1]) return a[i][0];
  return undefined;
}

// ---------- restore after a restart ----------

export type Span = [from: number, to: number];
export type Transition = [t: number, s: State];

// Rebuilds samples from persisted transitions (sorted by time; the last one before the window included) and the
// spans during which the sampler was observing (sorted, not overlapping). The state between two transitions only
// counts where a span covers it; everything else stays unobserved.
export function rebuild(transitions: Transition[], spans: Span[], now = Date.now()): Sample[] {
  const out: Sample[] = [];
  const start = now - WINDOW_MS;
  for (let i = 0; i < transitions.length; i++) {
    const [t, s] = transitions[i];
    const end = Math.min(transitions[i + 1]?.[0] ?? now, now);
    for (const [f, to] of spans) {
      const from = Math.max(t, f, start);
      const until = Math.min(end, to);
      if (until > from) out.push([from, s, until]);
    }
  }
  return out.sort((x, y) => x[0] - y[0]);
}

// Merges restored samples in front of what this process has recorded since it started (never over it), and the
// time the current state began when it is older than what the process knows.
export function restore(key: string, samples: Sample[], since?: [State, number]) {
  const a = series.get(key) ?? [];
  const firstOwn = a[0]?.[0] ?? Infinity;
  const older = samples
    .filter(([t]) => t < firstOwn)
    .map(([t, s, until]): Sample => [t, s, until === undefined ? undefined : Math.min(until, firstOwn)]);
  if (older.length) series.set(key, [...older, ...a]);
  if (since) {
    const cur = a[a.length - 1]?.[1] ?? older[older.length - 1]?.[1];
    const known = sinceOf.get(key);
    if (cur === since[0] && (!known || known[0] !== cur || since[1] < known[1])) sinceOf.set(key, since);
  }
}

// Extends the last span when the next observation follows within maxGapMs, else starts a new one; keeps only spans
// that end inside keepMs. Pure: console.ts persists the result per environment.
export function extendSpans(spans: Span[], at: number, maxGapMs: number, keepMs = WINDOW_MS): Span[] {
  const out = spans.filter(([, to]) => to >= at - keepMs).map(([f, t]): Span => [f, t]);
  const last = out[out.length - 1];
  if (last && at >= last[0] && at - last[1] <= maxGapMs) last[1] = Math.max(last[1], at);
  else if (!last || at > last[1]) out.push([at, at]);
  return out;
}

export function reset() {
  series.clear();
  sinceOf.clear();
}
