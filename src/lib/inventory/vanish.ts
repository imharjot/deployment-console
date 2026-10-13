// What the map knows, and what it is still confirming — pure rules for the inventory server
// (src/lib/server/inventory.ts), tested in vanish.test.ts.
//
// Resources pending deletion confirmation (REVIEW "Make the inventory explicit about what it knows"): a resource missing
// from the latest complete run of its provider and region (ok, not cut short by the deadline, not capped) but present
// in the previous one stays on the map one more cycle, health unknown "not seen since <time> — confirming",
// facts.vanishing true. It is dropped after the second consecutive complete run without it, and comes back as normal if
// a run lists it again. An incomplete run (partial or capped) never removes anything: what it didn't list is carried
// over from before, and pending confirmations wait. (A failed or denied run keeps the previous data as it was — the
// server decides that.)
//
// Also here: the slim rows GET /api/inventory sends (CC-17), its weak ETag (F51), remote references nobody in the
// account answers to (R14 nodes), and the freshness of the coverage view.
import type { Freshness } from "../freshness.ts";
import { parseArn } from "../mutation-keys.ts";
import type { InventoryCompleteness, Link, Mention, Resource } from "./types.ts";

export interface Vanishing {
  resource: Resource; // as it was last seen
  lastSeen: number; // when a run last listed it
  misses: number; // consecutive complete runs without it (1: confirming; a second one drops it)
}

// One provider × region's view of the world: what it believes exists, when each was last listed, and what is pending
// deletion confirmation.
export interface Known {
  resources: Resource[];
  links: Link[];
  mentions: Mention[];
  seenAt: Map<string, number>;
  vanishing: Vanishing[];
}

export interface RunRead {
  resources: Resource[];
  links: Link[];
  mentions: Mention[];
  at: number;
  complete: boolean; // ok, not partial (deadline), not truncated (cap)
}

const keyed = (list: Resource[]) => new Set(list.filter((r) => r?.key).map((r) => r.key));

// A run with no history behind it (a first run, a restored run, a disabled or skipped one).
export function knownOf(r: Omit<RunRead, "complete">): Known {
  const seenAt = new Map<string, number>();
  for (const x of r.resources) if (x?.key) seenAt.set(x.key, r.at);
  return { resources: r.resources, links: r.links, mentions: r.mentions, seenAt, vanishing: [] };
}

export function reconcile(prev: Known | undefined, run: RunRead): Known {
  if (!prev) return knownOf(run);
  const listed = keyed(run.resources);
  const seenAt = new Map<string, number>();
  for (const k of listed) seenAt.set(k, run.at);
  if (!run.complete) {
    // Never removes anything: what this run didn't get to stays as it was, with its links; confirmations wait.
    const carried = prev.resources.filter((r) => r?.key && !listed.has(r.key));
    const from = keyed(carried);
    for (const r of carried) seenAt.set(r.key, prev.seenAt.get(r.key) ?? run.at);
    return {
      resources: [...run.resources, ...carried],
      links: [...run.links, ...prev.links.filter((l) => from.has(l.from))],
      mentions: [...run.mentions, ...prev.mentions.filter((m) => from.has(m.from))],
      seenAt,
      vanishing: prev.vanishing.filter((v) => !listed.has(v.resource.key)),
    };
  }
  const vanishing: Vanishing[] = [];
  for (const v of prev.vanishing) if (!listed.has(v.resource.key) && v.misses + 1 < 2) vanishing.push({ ...v, misses: v.misses + 1 });
  const pending = new Set(vanishing.map((v) => v.resource.key));
  for (const r of prev.resources)
    if (r?.key && !listed.has(r.key) && !pending.has(r.key)) vanishing.push({ resource: r, lastSeen: prev.seenAt.get(r.key) ?? run.at, misses: 1 });
  return { resources: run.resources, links: run.links, mentions: run.mentions, seenAt, vanishing };
}

const clock = (at: number) => `${new Date(at).toISOString().slice(11, 16)} UTC`;

// How a resource pending deletion confirmation is drawn: as last seen, health unknown, marked.
export function vanishingResource(v: Vanishing): Resource {
  return {
    ...v.resource,
    health: "unknown",
    healthReason: `not seen since ${clock(v.lastSeen)} — confirming`,
    facts: { ...(v.resource.facts ?? {}), vanishing: true, lastSeen: v.lastSeen },
    observedAt: v.lastSeen,
  };
}

// The resources a run contributes to the map: what it believes exists, then what it is confirming — except what
// another run still lists (`listedElsewhere`), which isn't vanishing at all.
export function contributed(k: Known, listedElsewhere?: Set<string>): Resource[] {
  return [...k.resources, ...k.vanishing.filter((v) => !listedElsewhere?.has(v.resource.key)).map(vanishingResource)];
}

// ---------- the payload (CC-17, F51) ----------

// Hidden rows (never drawn), generic rows (kind aws-resource, mostly table-only types) go out slim: no props, only the
// facts the map draws; the detail call returns the rest.
export const isSlimRow = (r: Pick<Resource, "hidden" | "kind">) => !!r.hidden || r.kind === "aws-resource";
const KEEP_FACTS = ["vanishing", "lastSeen", "remote", "idleEvidence"];

export function slimRow(r: Resource): Resource {
  if (!isSlimRow(r)) return r;
  const kept = Object.fromEntries(KEEP_FACTS.filter((k) => r.facts && Object.hasOwn(r.facts, k)).map((k) => [k, r.facts![k]]));
  const { facts: _facts, ...rest } = r;
  void _facts;
  return { ...rest, props: [], slim: true, ...(Object.keys(kept).length ? { facts: kept } : {}) };
}

// FNV-1a, 32 bits, base 36: a short signature for a weak validator (not a security boundary).
export function shortHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

// W/"<generatedAt>[-partial][-<extra>]": a new build, the end of phase 2, or (extra) anything merged in per request —
// the note counts — makes a new one.
export const etagOf = (generatedAt: number, partial: boolean, extra?: string) => `W/"${generatedAt}${partial ? "-partial" : ""}${extra ? `-${extra}` : ""}"`;

// If-None-Match: a list of entity tags or "*", compared weakly (W/ ignored, RFC 9110 §13.1.2).
export function etagMatches(header: string | null | undefined, etag: string): boolean {
  if (!header) return false;
  const bare = (t: string) => t.trim().replace(/^W\//, "");
  const want = bare(etag);
  return header.split(",").some((t) => t.trim() === "*" || bare(t) === want);
}

// ---------- coverage ----------

export interface Unresolved {
  key: string;
  ref: string;
  account?: string;
  region?: string;
}

// R14 nodes: references in configuration to something not in this account or region (source "reference", or
// facts.remote). At most `max` listed; `total` counts them all.
export function unresolvedOf(resources: Resource[], max = 200): { total: number; list: Unresolved[] } {
  const all = resources.filter((r) => r.source === "reference" || r.facts?.remote === true);
  const list = all.slice(0, max).map((r): Unresolved => {
    const ref = typeof r.facts?.ref === "string" ? r.facts.ref : r.key;
    const arn = parseArn(ref) ?? parseArn(r.key);
    const account = r.account ?? (arn?.account || undefined);
    const region = arn?.region || (r.region && r.region !== "global" ? r.region : undefined);
    return { key: r.key, ref, ...(account ? { account } : {}), ...(region ? { region } : {}) };
  });
  return { total: all.length, list };
}

// The coverage view's freshness, for <FreshnessBanner>: as of the last build; complete only when that build was.
export function coverageFreshness(
  v: { generatedAt: number; completeness?: InventoryCompleteness; pendingRegions?: string[]; vanishing?: number },
  staleAfterMs: number,
): Freshness {
  const c = v.completeness;
  const pending = v.pendingRegions ?? [];
  const complete = !!c && c.lastCompleteAt === v.generatedAt && !pending.length;
  const n = (count: number, one: string, many = `${one}s`) => `${count.toLocaleString("en-US")} ${count === 1 ? one : many}`;
  const notes = [
    c?.providers.denied ? `${n(c.providers.denied, "source")} denied` : "",
    c?.providers.error ? `${n(c.providers.error, "source")} failing` : "",
    c?.providers.partial ? `${n(c.providers.partial, "source")} cut short` : "",
    c?.cappedTypes.length ? `${n(c.cappedTypes.length, "type")} capped` : "",
    c?.staleProviders.length ? `${n(c.staleProviders.length, "source")} from an older read` : "",
    pending.length ? `${pending.join(", ")} still being read` : "",
    v.vanishing ? `${n(v.vanishing, "resource")} pending deletion confirmation` : "",
  ].filter(Boolean);
  return {
    observedAt: v.generatedAt,
    staleAfterMs,
    source: "inventory",
    completeness: !c ? "unknown" : complete ? "complete" : "partial",
    ...(notes.length ? { notes } : {}),
  };
}
