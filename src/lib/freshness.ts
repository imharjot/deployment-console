// How old and how complete a piece of observed data is (R21). Pure: shared by the server (overview, sampler,
// inventory) and the UI (banners, badges), so a stale or partial view can never look reassuring.
//
// Rule: a state derived from data that is stale, or whose age is unknown, is shown as unknown, never as the last
// good value. "Confirmed zero" (we looked and there is nothing) and "not queried" (we never looked) are different.

export type Completeness = "complete" | "partial" | "unknown";
export type EvidenceState = "observed" | "not-queried" | "denied" | "stale" | "confirmed-zero" | "unknown";

export interface Freshness {
  observedAt?: number; // ms; undefined (or ≤ 0) = age unknown
  staleAfterMs: number; // older than this = stale
  source: string; // "sampler", "inventory", "cloudwatch", … (several joined with ", " when combined)
  completeness: Completeness;
  error?: string; // the last refresh failed with this (the data shown is from before it)
  refreshFailedAt?: number;
  notes?: string[]; // "2 sources denied", "eu-west-1 pending"
}

const knownAge = (f: Freshness) => typeof f.observedAt === "number" && Number.isFinite(f.observedAt) && f.observedAt > 0;

// Stale = older than staleAfterMs, or of unknown age. Exactly staleAfterMs old is still fresh (same as deriveState).
export function isStale(f: Freshness, now: number = Date.now()): boolean {
  if (!knownAge(f)) return true;
  return now - f.observedAt! > f.staleAfterMs;
}

// The state to show: `unknown` when the data behind `state` is stale or of unknown age. No freshness attached (an
// older server, a source that has no model yet) leaves the state as it is.
export function effectiveState<S>(state: S, f: Freshness | undefined, unknown: S, now: number = Date.now()): S {
  if (!f) return state;
  return isStale(f, now) ? unknown : state;
}

// Fresh and complete: nothing to tell the user (banners render nothing).
export const isQuiet = (f: Freshness, now: number = Date.now()) => !isStale(f, now) && f.completeness === "complete" && !f.error;

// The banner's headline: what is wrong with the data, in a few words. undefined when there is nothing to say.
export function freshnessHeadline(f: Freshness, now: number = Date.now()): string | undefined {
  if (isQuiet(f, now)) return undefined;
  if (!knownAge(f)) return "Data age unknown";
  if (isStale(f, now)) return f.error ? "Showing stale data — refresh failing" : "Showing stale data";
  if (f.error) return "Last refresh failed";
  if (f.completeness === "partial") return "Partial data";
  if (f.completeness === "unknown") return "Completeness unknown";
  return undefined;
}

export function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return s < 5 ? "just now" : `${s} s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

// "14:02 UTC" today, "2026-10-04 14:02 UTC" further back. UTC so the server and every viewer agree.
function clock(at: number, now: number): string {
  const iso = new Date(at).toISOString();
  const day = now - at < 20 * 3600_000 && iso.slice(0, 10) === new Date(now).toISOString().slice(0, 10);
  return `${day ? "" : `${iso.slice(0, 10)} `}${iso.slice(11, 16)} UTC`;
}

// "as of 14:02 UTC (3 min ago) · partial: 2 sources denied"
export function describeFreshness(f: Freshness, now: number = Date.now()): string {
  const parts: string[] = [];
  if (!knownAge(f)) parts.push("age unknown");
  else {
    const stale = isStale(f, now);
    parts.push(`${stale ? "stale — " : ""}as of ${clock(f.observedAt!, now)} (${ago(now - f.observedAt!)})`);
  }
  const notes = (f.notes ?? []).filter(Boolean);
  if (f.completeness === "partial") parts.push(notes.length ? `partial: ${notes.join(", ")}` : "partial");
  else if (f.completeness === "unknown") parts.push(notes.length ? `completeness unknown: ${notes.join(", ")}` : "completeness unknown");
  else if (notes.length) parts.push(notes.join(", "));
  if (f.error) parts.push(`last refresh failed${f.refreshFailedAt ? ` ${ago(now - f.refreshFailedAt)}` : ""}: ${f.error}`);
  return parts.join(" · ");
}

const COMPLETENESS_RANK: Record<Completeness, number> = { complete: 0, partial: 1, unknown: 2 };

// One freshness for a view built from several sources: as old as its oldest part, stale as soon as any part is
// stale (the earliest deadline wins), as complete as its least complete part. Errors and notes are kept.
export function combineFreshness(list: Freshness[]): Freshness {
  if (!list.length) return { staleAfterMs: 0, source: "none", completeness: "unknown" };
  const sources = [...new Set(list.map((f) => f.source).filter(Boolean))];
  const completeness = list.reduce<Completeness>((w, f) => (COMPLETENESS_RANK[f.completeness] > COMPLETENESS_RANK[w] ? f.completeness : w), "complete");
  const notes = [...new Set(list.flatMap((f) => f.notes ?? []).filter(Boolean))];
  const errors = [...new Set(list.map((f) => f.error).filter((e): e is string => !!e))];
  const failedAt = list.map((f) => f.refreshFailedAt ?? 0).reduce((a, b) => Math.max(a, b), 0);
  const out: Freshness = { staleAfterMs: Math.min(...list.map((f) => f.staleAfterMs)), source: sources.join(", "), completeness };
  if (list.every(knownAge)) {
    const observedAt = Math.min(...list.map((f) => f.observedAt!));
    const deadline = Math.min(...list.map((f) => f.observedAt! + f.staleAfterMs));
    out.observedAt = observedAt;
    out.staleAfterMs = Math.max(0, deadline - observedAt);
  }
  if (notes.length) out.notes = notes;
  if (errors.length) out.error = errors.join("; ");
  if (failedAt > 0) out.refreshFailedAt = failedAt;
  return out;
}
