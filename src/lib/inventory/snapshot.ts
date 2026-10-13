// A provider run's result as it is kept in the console DB (inventory_runs.result), so a restart serves a labelled
// stale map instead of nothing (R18). Pure: gzip + base64 of one JSON document; the server (inventory-store.ts) hands
// in seal/unseal from secrets.ts.
//
// What is stored: resources (props scrubbed again), links and security-group rules (ids, ports, CIDRs — no values) in
// clear; mentions — environment values, connection strings — only sealed (AES-GCM), and dropped when sealing isn't
// possible. Nothing else of a run is stored.
// Size caps: a snapshot over MAX_ENCODED is retried without mentions, then refused (the run simply isn't persisted).
// Decoding is defensive: a bounded gunzip, and only well-formed resources and links come back.
import { gunzipSync, gzipSync } from "node:zlib";
import { scrubProps } from "./infer.ts";
import type { Link, Mention, ProviderResult, Resource, SecurityGroupFacts } from "./types.ts";

export const SNAPSHOT_VERSION = 1;
export const MAX_ENCODED = 6 * 1024 * 1024; // base64 characters in one row
export const MAX_DECODED = 64 * 1024 * 1024; // gunzip output limit (a corrupt or hostile row can't balloon)
export const MAX_ITEMS = 20_000; // resources, links and mentions each

interface Stored {
  v: number;
  resources: Resource[];
  links: Link[];
  sgRules?: SecurityGroupFacts[];
  mentions?: string; // sealed JSON of Mention[]
}

export type Encoded = { data: string; bytes: number; mentions: "sealed" | "dropped" | "none"; why?: string } | { refused: string };

const pack = (s: Stored) => gzipSync(Buffer.from(JSON.stringify(s), "utf8")).toString("base64");

export function encodeSnapshot(r: ProviderResult, o: { seal: (plain: string) => string; maxEncoded?: number }): Encoded {
  const max = o.maxEncoded ?? MAX_ENCODED;
  const base: Stored = {
    v: SNAPSHOT_VERSION, resources: (r.resources ?? []).slice(0, MAX_ITEMS).map(scrubProps), links: (r.links ?? []).slice(0, MAX_ITEMS),
    ...(r.sgRules?.length ? { sgRules: r.sgRules.slice(0, MAX_ITEMS) } : {}),
  };
  const mentions = (r.mentions ?? []).slice(0, MAX_ITEMS);
  let sealed: string | undefined, why: string | undefined;
  if (mentions.length)
    try {
      sealed = o.seal(JSON.stringify(mentions));
    } catch (e) {
      why = `mentions not stored: ${e instanceof Error ? e.message : String(e)}`;
    }
  if (sealed) {
    const data = pack({ ...base, mentions: sealed });
    if (data.length <= max) return { data, bytes: data.length, mentions: "sealed" };
    why = "mentions not stored: snapshot too large";
  }
  const data = pack(base);
  if (data.length > max) return { refused: `snapshot is ${Math.round(data.length / 1024)} KB, over the ${Math.round(max / 1024)} KB limit` };
  return { data, bytes: data.length, mentions: mentions.length ? "dropped" : "none", ...(why ? { why } : {}) };
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown) => typeof v === "string" && v.length > 0;

const okResource = (x: unknown): x is Resource =>
  isObj(x) && str(x.key) && str(x.kind) && str(x.provider) && typeof x.name === "string" && typeof x.region === "string" && isObj(x.tags) && typeof x.health === "string" && Array.isArray(x.props);
const okLink = (x: unknown): x is Link => isObj(x) && str(x.from) && str(x.to) && str(x.kind) && typeof x.evidence === "string";
const okRules = (x: unknown): x is SecurityGroupFacts => isObj(x) && str(x.groupId) && typeof x.region === "string" && Array.isArray(x.inbound) && x.inbound.every(isObj);
const okMention = (x: unknown): x is Mention => isObj(x) && str(x.from) && Array.isArray(x.refs) && x.refs.every((s) => typeof s === "string") && typeof x.via === "string";

// Throws on a row that isn't a snapshot at all (wrong version, not gzip, not JSON); drops malformed entries otherwise.
// Mentions that can't be unsealed (the key changed) are dropped: the map loses some mention edges, nothing else.
export function decodeSnapshot(data: string, o: { unseal: (sealed: string) => string }): ProviderResult & { mentionsLost?: boolean } {
  const json = gunzipSync(Buffer.from(data, "base64"), { maxOutputLength: MAX_DECODED }).toString("utf8");
  const s = JSON.parse(json) as unknown;
  if (!isObj(s) || s.v !== SNAPSHOT_VERSION) throw new Error("unknown inventory snapshot format");
  const resources = (Array.isArray(s.resources) ? s.resources : []).filter(okResource).slice(0, MAX_ITEMS);
  const links = (Array.isArray(s.links) ? s.links : []).filter(okLink).slice(0, MAX_ITEMS);
  const sgRules = (Array.isArray(s.sgRules) ? s.sgRules : []).filter(okRules).slice(0, MAX_ITEMS);
  let mentions: Mention[] = [];
  let mentionsLost = false;
  if (typeof s.mentions === "string")
    try {
      const m = JSON.parse(o.unseal(s.mentions)) as unknown;
      mentions = (Array.isArray(m) ? m : []).filter(okMention).slice(0, MAX_ITEMS);
    } catch {
      mentionsLost = true;
    }
  return { resources, links, mentions, ...(sgRules.length ? { sgRules } : {}), ...(mentionsLost ? { mentionsLost } : {}) };
}
