// What the cloud map shows for a set of filters. Pure (tested in filter.test.ts); the page runs it on every change.
//
// - env: "all", an environment id, or SHARED (resources no environment claims). A single environment also brings in
//   the shared resources wired to it (the logs bucket, the DNS zone), so its dependencies stay on the map.
// - region: "all" or one region. Like an environment, a region brings in the global and region-less resources wired
//   to it (CloudFront, Route 53, IAM roles), and the references to other accounts or regions it names (R14).
// - layers: the support layers that are switched on (network, security, monitoring, delivery, other services). Flow
//   categories are always drawn; hidden rows (AWS-managed keys, service roles, table-only types) never are.
// - kinds: the kinds to show (null = every kind).
// - idle / problems: only idle resources / only resources whose health is warning or error.
// - q: words that must all appear in the name, key, kind, service, tags, endpoints or aliases. Matches are shown with
//   their direct neighbours (from the filtered set) as context.
// - edgeConfidence: which connections to draw (config, allowed, mentioned; null = all).
// Pass-through: a Cloud Map service, VPC endpoint, NAT gateway or RDS proxy that sits between two resources on the map
// becomes a label on a joined connection ("via acme-production-pg-proxy") instead of a node — unless its own layer is
// on, it has a problem, or it matches the search.
import { DEFAULT_LAYERS } from "../../lib/inventory/layout.ts";
import { SUPPORT_ORDER, categoryOf, isSupport, kindLabelOf, serviceOf, type Edge, type Layer, type Resource, type ResourceKind } from "../../lib/inventory/types.ts";

export const SHARED = "__shared";
export type Confidence = Edge["confidence"];
export const CONFIDENCES: Confidence[] = ["config", "allowed", "mentioned"];
export const PASS_THROUGH: ReadonlySet<ResourceKind> = new Set<ResourceKind>(["cloudmap-service", "vpc-endpoint", "nat-gateway", "rds-proxy"]);
const VIA_PAIRS_MAX = 200; // joined connections per pass-through resource

export interface MapFilters {
  env: string;
  kinds: ReadonlySet<ResourceKind> | null;
  q: string;
  idle: boolean;
  problems: boolean;
  region: string; // "all" or a region code
  layers: ReadonlySet<Layer>; // support layers that are on
  edgeConfidence: ReadonlySet<Confidence> | null; // null = every connection
}

export const DEFAULT_FILTERS: MapFilters = { env: "all", kinds: null, q: "", idle: false, problems: false, region: "all", layers: new Set(DEFAULT_LAYERS), edgeConfidence: null };

export const isProblemResource = (r: Pick<Resource, "health">) => r.health === "error" || r.health === "warning";
// R14: a resource another account or region owns, named in configuration here.
export const isRemote = (r: Pick<Resource, "source" | "facts">) => r.source === "reference" || r.facts?.remote === true;
export const REMOTE_TEXT = "referenced — not in this account/region";

// Lower-case text a resource can be found by.
export function haystack(r: Resource): string {
  const tags = Object.entries(r.tags ?? {}).map(([k, v]) => `${k}=${v}`);
  return [r.name, r.key, r.kind, kindLabelOf(r), serviceOf(r), r.resourceType ?? "", r.env ?? "", r.region ?? "", ...tags, ...(r.endpoints ?? []), ...(r.aliases ?? [])].join("\n").toLowerCase();
}

export function matchesQuery(r: Resource, q: string, hay = haystack(r)): boolean {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  return words.every((w) => hay.includes(w));
}

export interface Filtered {
  resources: Resource[]; // what the map draws
  edges: Edge[]; // edges between them (after the confidence filter), plus joined pass-through connections
  matches: Set<string> | null; // search hits (null = no search)
  context: Set<string>; // shown only as a search hit's neighbour
  kindCounts: Map<ResourceKind, number>; // per kind, within the env, region and layer filters (for the kind picker)
  layerCounts: Map<Layer, number>; // per support layer, within the env and region filters (for the layers popover)
  confidenceCounts: Record<Confidence, number>; // connections between drawn resources, before the confidence filter
  idleCount: number; // within env + kind filters
  problemCount: number;
  offLayerMatches: number; // search hits on layers that are switched off
  passThrough: Set<string>; // resources drawn as "via" labels instead of nodes
}

const isGlobal = (r: Pick<Resource, "region">) => !r.region || r.region === "global";

export function applyFilters(resources: readonly Resource[], edges: readonly Edge[], f: MapFilters, hay?: Map<string, string>): Filtered {
  const byKey = new Map(resources.map((r) => [r.key, r]));
  const nbrs = new Map<string, string[]>();
  for (const e of edges) {
    if (!byKey.has(e.from) || !byKey.has(e.to)) continue;
    (nbrs.get(e.from) ?? nbrs.set(e.from, []).get(e.from)!).push(e.to);
    (nbrs.get(e.to) ?? nbrs.set(e.to, []).get(e.to)!).push(e.from);
  }
  const listed = resources.filter((r) => !r.hidden);

  // Region (with the global resources wired to it).
  let inRegion = listed;
  if (f.region !== "all") {
    const keep = new Set<string>();
    for (const r of listed) if (r.region === f.region) keep.add(r.key);
    for (const k of [...keep])
      for (const n of nbrs.get(k) ?? []) {
        const x = byKey.get(n)!;
        if (isGlobal(x) || isRemote(x)) keep.add(n);
      }
    inRegion = listed.filter((r) => keep.has(r.key));
  }

  // Environment.
  let inEnv: Resource[];
  if (f.env === "all") inEnv = inRegion;
  else if (f.env === SHARED) inEnv = inRegion.filter((r) => !r.env);
  else {
    const scope = new Set(inRegion.map((r) => r.key));
    const own = inRegion.filter((r) => r.env === f.env);
    const keep = new Set(own.map((r) => r.key));
    for (const r of own) for (const n of nbrs.get(r.key) ?? []) if (scope.has(n) && !byKey.get(n)!.env) keep.add(n);
    inEnv = inRegion.filter((r) => keep.has(r.key));
  }

  // Layers.
  const layerCounts = new Map<Layer, number>();
  const onLayer = (r: Resource) => {
    const c = categoryOf(r);
    return !isSupport(c) || f.layers.has(c);
  };
  for (const r of inEnv) {
    const c = categoryOf(r);
    if (isSupport(c)) layerCounts.set(c, (layerCounts.get(c) ?? 0) + 1);
  }
  const inLayers = inEnv.filter(onLayer);

  const kindCounts = new Map<ResourceKind, number>();
  for (const r of inLayers) kindCounts.set(r.kind, (kindCounts.get(r.kind) ?? 0) + 1);
  const inKinds = f.kinds ? inLayers.filter((r) => f.kinds!.has(r.kind)) : inLayers;
  let idleCount = 0, problemCount = 0;
  for (const r of inKinds) {
    if (r.idle) idleCount++;
    if (isProblemResource(r)) problemCount++;
  }
  const base = inKinds.filter((r) => (!f.idle || !!r.idle) && (!f.problems || isProblemResource(r)));

  let shown = base;
  let matches: Set<string> | null = null;
  const context = new Set<string>();
  let offLayerMatches = 0;
  if (f.q.trim()) {
    matches = new Set(base.filter((r) => matchesQuery(r, f.q, hay?.get(r.key))).map((r) => r.key));
    for (const r of inEnv) if (!onLayer(r) && matchesQuery(r, f.q, hay?.get(r.key))) offLayerMatches++;
    const inBase = new Set(base.map((r) => r.key));
    const keep = new Set(matches);
    for (const k of matches)
      for (const n of nbrs.get(k) ?? [])
        if (inBase.has(n) && !keep.has(n)) {
          keep.add(n);
          context.add(n);
        }
    shown = base.filter((r) => keep.has(r.key));
  }

  // Pass-through resources: drawn as a label on the connection they carry.
  const shownKeys = new Set(shown.map((r) => r.key));
  const passThrough = new Set<string>();
  const ins = new Map<string, Edge[]>(), outs = new Map<string, Edge[]>();
  for (const e of edges) {
    if (PASS_THROUGH.has(byKey.get(e.to)?.kind as ResourceKind)) (ins.get(e.to) ?? ins.set(e.to, []).get(e.to)!).push(e);
    if (PASS_THROUGH.has(byKey.get(e.from)?.kind as ResourceKind)) (outs.get(e.from) ?? outs.set(e.from, []).get(e.from)!).push(e);
  }
  const via: Edge[] = [];
  for (const x of inEnv) {
    if (!PASS_THROUGH.has(x.kind)) continue;
    const a = (ins.get(x.key) ?? []).filter((e) => e.from !== x.key);
    const b = (outs.get(x.key) ?? []).filter((e) => e.to !== x.key);
    const drawnIn = a.filter((e) => shownKeys.has(e.from) && !passThroughKind(byKey.get(e.from)));
    const drawnOut = b.filter((e) => shownKeys.has(e.to) && !passThroughKind(byKey.get(e.to)));
    if (!drawnIn.length || !drawnOut.length) continue;
    const cat = categoryOf(x);
    const needed = isProblemResource(x) || !!matches?.has(x.key) || (isSupport(cat) && f.layers.has(cat));
    if (shownKeys.has(x.key) && needed) continue;
    passThrough.add(x.key);
    let n = 0;
    for (const ea of drawnIn)
      for (const eb of drawnOut) {
        if (ea.from === eb.to || n >= VIA_PAIRS_MAX) continue;
        n++;
        via.push({
          id: `${ea.from}->${eb.to}:via:${x.key}`,
          from: ea.from,
          to: eb.to,
          kind: eb.kind,
          label: `via ${x.name}`,
          evidence: [...new Set([...ea.evidence, ...eb.evidence])].slice(0, 4),
          confidence: weaker(ea.confidence, eb.confidence),
          ...(ea.routing ?? eb.routing ? { routing: ea.routing ?? eb.routing } : {}),
        });
      }
  }
  if (passThrough.size) shown = shown.filter((r) => !passThrough.has(r.key));

  const keys = new Set(shown.map((r) => r.key));
  const between = [...edges.filter((e) => keys.has(e.from) && keys.has(e.to)), ...via.filter((e) => keys.has(e.from) && keys.has(e.to))];
  const confidenceCounts: Record<Confidence, number> = { config: 0, allowed: 0, mentioned: 0 };
  for (const e of between) confidenceCounts[e.confidence]++;
  const drawnEdges = f.edgeConfidence ? between.filter((e) => f.edgeConfidence!.has(e.confidence)) : between;
  return { resources: shown, edges: drawnEdges, matches, context, kindCounts, layerCounts, confidenceCounts, idleCount, problemCount, offLayerMatches, passThrough };
}

const passThroughKind = (r: Resource | undefined) => !!r && PASS_THROUGH.has(r.kind);
const RANK: Record<Confidence, number> = { config: 0, allowed: 1, mentioned: 2 };
const weaker = (a: Confidence, b: Confidence): Confidence => (RANK[a] >= RANK[b] ? a : b);

// How many filters differ from the defaults (the phone's Filters button badge and the desktop Reset chip).
export const activeFilterCount = (f: MapFilters) =>
  Number(f.env !== "all") + Number(!!f.kinds) + Number(f.idle) + Number(f.problems) + Number(!!f.edgeConfidence) + Number(!sameSet(f.layers, DEFAULT_FILTERS.layers));

const sameSet = <T,>(a: ReadonlySet<T>, b: ReadonlySet<T>) => a.size === b.size && [...a].every((x) => b.has(x));

// ---- the URL (F44): filters survive a reload and can be shared ----
// q, env, kinds (comma list), problems=1, idle=1, region, layers (comma list; "none" = every support layer off),
// conn (comma list of confidences). Defaults are left out. Unknown values are ignored.
export function filtersToParams(f: MapFilters, p: URLSearchParams = new URLSearchParams()): URLSearchParams {
  const set = (k: string, v: string | null) => (v === null ? p.delete(k) : p.set(k, v));
  set("q", f.q.trim() ? f.q : null);
  set("env", f.env !== "all" ? f.env : null);
  set("kinds", f.kinds ? [...f.kinds].sort().join(",") || "none" : null);
  set("problems", f.problems ? "1" : null);
  set("idle", f.idle ? "1" : null);
  set("region", f.region !== "all" ? f.region : null);
  set("layers", sameSet(f.layers, DEFAULT_FILTERS.layers) ? null : SUPPORT_ORDER.filter((l) => f.layers.has(l)).join(",") || "none");
  set("conn", f.edgeConfidence && f.edgeConfidence.size < CONFIDENCES.length ? CONFIDENCES.filter((c) => f.edgeConfidence!.has(c)).join(",") || "none" : null);
  return p;
}

export function filtersFromParams(p: URLSearchParams, isKind: (k: string) => k is ResourceKind): MapFilters {
  const list = (k: string) => {
    const v = p.get(k);
    return v === null ? null : v === "none" ? [] : v.split(",").map((x) => x.trim()).filter(Boolean);
  };
  const kinds = list("kinds");
  const layers = list("layers");
  const conn = list("conn");
  const confs = conn ? CONFIDENCES.filter((c) => conn.includes(c)) : null;
  return {
    env: p.get("env") || "all",
    q: p.get("q") ?? "",
    kinds: kinds ? new Set(kinds.filter(isKind)) : null,
    problems: p.get("problems") === "1",
    idle: p.get("idle") === "1",
    region: p.get("region") || "all",
    layers: layers ? new Set(SUPPORT_ORDER.filter((l) => layers.includes(l))) : new Set(DEFAULT_FILTERS.layers),
    edgeConfidence: confs && confs.length < CONFIDENCES.length ? new Set(confs) : null,
  };
}
