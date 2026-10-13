// Cloud map layout: where every node and edge goes. Pure and deterministic (same set in → same positions out, whatever
// the input order), and fast enough to run on every filter change (1,000 nodes / 3,000 edges well under 50 ms; 20,000
// input resources collapse to at most 1,500 visible nodes and lay out in under 150 ms — CC-18).
//
// The plane is a grid:
// - Columns by category, left → right in the direction requests usually flow (FLOW_ORDER: edge → compute →
//   messaging → data → storage → external), then the support layers that are switched on (network, security,
//   monitoring, delivery, other services). Empty categories take no space. Support layers are off by default except
//   "other services" (generic resources, always grouped per lane and AWS service).
// - Optional swimlanes: by environment (production first, then the others by id, "Shared" last), by VPC or by region.
// - Each (lane, column) cell stacks its nodes; a crowded cell wraps into sub-columns (row-major, so a node's order
//   still maps to its height).
// - Order inside a cell comes from a few barycenter sweeps (each node moves towards the average height of its
//   neighbours in other columns), which removes most edge crossings. Nodes of one kind stay together as a block, and
//   blocks are ordered by their own barycenter, so a column still reads "queues, then topics, then rules".
// - A lane with more than the group threshold of one kind shows them as one group node ("42 Lambda functions") until
//   that group is expanded; edges to members attach to the group. Thresholds can differ per kind or category.
// - Resources with a `parent` on the map fold into it (subnets into their VPC, Aurora members into their cluster) until
//   the parent is expanded (`parentId(key)` in `expanded`); edges to children attach to the parent.
// - Edges are smooth S-curves between ports on the facing sides of the two nodes; the ports on one side are spread out
//   in the order of the other ends' positions so lines leave without crossing each other. Nodes in the same
//   sub-column are joined by an arc on their right side.
// - Portrait (phones held upright): the same grid transposed — categories become horizontal bands top → bottom, lanes
//   stand side by side, and edges run vertically. Computed in the landscape frame with swapped node sizes, then the
//   two axes are exchanged.
import { CATEGORY_LABEL, CATEGORY_ORDER, KIND_INFO, categoryOf, isSupport, serviceOf, type Category, type Edge, type EdgeKind, type Layer, type Resource, type ResourceKind } from "./types.ts";

export const NODE_W = 216;
export const NODE_H = 64;
export const LANE_HEAD = 38; // the label band at the top of each lane (landscape), in plane units
const PAD = 40; // around everything
const MIN_ROWS = 12; // a cell wraps into sub-columns only past this many nodes

// Spacing in the landscape frame (u = flow axis, left → right; v = cross axis, top → bottom).
interface Dims {
  nw: number; // node size along u
  nh: number; // node size along v
  rowH: number; // v step between rows of one cell
  subGap: number; // u gap between sub-columns of one cell
  colGap: number; // u gap between categories: room for the curves
  laneHead: number; // lane label band (v)
  laneHeadFlat: number; // no lanes: just a little air
  lanePad: number; // below the last row of a lane
  laneGap: number;
  headH: number; // column labels band at the top (v)
  uStart: number; // where the first column starts (u)
}
const LANDSCAPE: Dims = { nw: NODE_W, nh: NODE_H, rowH: 84, subGap: 20, colGap: 132, laneHead: LANE_HEAD, laneHeadFlat: 10, lanePad: 18, laneGap: 22, headH: 34, uStart: PAD };
// Portrait: nodes keep their on-screen size (216 × 64), so in the landscape frame they are 64 along u and 216 along v.
// Category labels sit in the gap above each band; lane labels stick to the top of the screen.
const PORTRAIT: Dims = { nw: NODE_H, nh: NODE_W, rowH: NODE_W + 16, subGap: 18, colGap: 92, laneHead: 10, laneHeadFlat: 10, lanePad: 10, laneGap: 22, headH: 0, uStart: PAD + 30 };

export const SHARED_LANE = "__shared";
export const ALL_LANE = "__all";
export const GLOBAL_LANE = "global"; // laneBy "region": resources AWS keeps outside any region (CloudFront, Route 53, IAM)
export const groupId = (lane: string, kind: ResourceKind, sub?: string) => (sub ? `group:${lane}:${kind}:${sub}` : `group:${lane}:${kind}`);
export const parentId = (key: string) => `parent:${key}`; // an `expanded` entry: show this parent's children one by one
export const REF_SUFFIX = " (referenced)"; // the service of a group of remote references

// Support layers drawn by default (D.1: "other services" is on; network, security, monitoring and delivery are off).
export const DEFAULT_LAYERS: Layer[] = ["other"];
// Per kind or category: group past this many in one lane. Support layers group early; generic resources always
// group per lane and AWS service (0 = even one becomes "1 SageMaker resource"). References to resources of another
// account or region (R14, source "reference") are never mixed into those groups: they group under "reference".
export const DEFAULT_GROUP_THRESHOLDS: Readonly<Record<string, number>> = { network: 6, security: 6, observability: 6, delivery: 6, other: 6, "aws-resource": 0 };

export type LayoutResource = Pick<Resource, "key" | "kind" | "name" | "env"> &
  Partial<Pick<Resource, "category" | "vpcId" | "region" | "parent" | "service" | "resourceType" | "hidden" | "source">>;
export type LayoutEdgeInput = Pick<Edge, "id" | "from" | "to" | "kind"> & { confidence?: Edge["confidence"] };
export type LaneBy = "env" | "vpc" | "region" | "none";
export type Orientation = "landscape" | "portrait";

export interface LayoutOptions {
  groupByEnv?: boolean; // alias of laneBy: false = "none", true = "env" (laneBy wins when both are given)
  laneBy?: LaneBy; // swimlanes by environment (default), VPC, region, or none
  expanded?: Iterable<string>; // group ids (groupId()) and parent ids (parentId()) to show member by member
  groupThreshold?: number; // default 12: more than this many of one kind in one lane become a group
  groupThresholds?: Partial<Record<string, number>>; // per kind or category (over DEFAULT_GROUP_THRESHOLDS)
  envLabels?: Record<string, string>; // lane titles for environments; the env id otherwise
  laneLabels?: Record<string, string>; // lane titles for VPC and region lanes (VPC names, "us-east-1 · N. Virginia")
  layers?: readonly Layer[]; // support layers to draw beside the flow columns (default DEFAULT_LAYERS)
  foldChildren?: boolean; // default true: resources with a `parent` on the map fold into it
  // Lane order for "region" (home first). Ordering only: filtering by region is applyFilters' job (components/map/
  // filter.ts), so a reference to another region (R14) or a region the console stopped watching is never dropped here.
  regions?: readonly string[];
  orientation?: Orientation; // default landscape
  sweeps?: number; // barycenter passes (alternating direction), default 4
  // The canvas the plane will be fitted into. When given, crowded cells wrap at the one row count (rows per
  // sub-column) that lets the whole plane fit this box at the largest zoom, so a wide screen gets a wide map and a
  // tall one a tall map. Without it, a cell wraps past max(12, √(2n)) nodes.
  viewport?: { w: number; h: number };
}

export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface LayoutNode {
  id: string; // resource key, or a group id
  type: "resource" | "group";
  key?: string; // type "resource": the resource key (same as id)
  members?: string[]; // type "group": resource keys, by name
  service?: string; // a group of generic resources: their AWS service ("SageMaker")
  folded?: string[]; // resource keys folded into this node (its children, and theirs), by key
  kind: ResourceKind;
  category: Category;
  lane: string;
  x: number; // top-left, plane units
  y: number;
  w: number;
  h: number;
  order: number; // reading order (lane, column, row, sub-column): what Tab follows
}

export interface LayoutEdge {
  id: string; // `${from}>${to}` (node ids)
  from: string; // node ids
  to: string;
  kind: EdgeKind; // of the strongest edge merged into this line
  kinds: EdgeKind[]; // every kind merged into it, deduped (sorted)
  edgeIds: string[]; // the inventory edges it draws (sorted)
  confidence: Edge["confidence"]; // strongest of them: config > allowed > mentioned
  path: string; // SVG path data
  start: { x: number; y: number };
  end: { x: number; y: number }; // arrival point on the target's side
  mid: { x: number; y: number }; // curve midpoint, for labels
  box: Box; // bounding box (of the control polygon), for culling
}

export interface LayoutLane {
  id: string;
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
  count: number; // resources in it (group members and folded children counted)
}

export interface LayoutColumn {
  category: Category;
  label: string;
  x: number;
  w: number;
  y: number; // portrait: the band's top; landscape: the top of the plane
  h: number; // portrait: the band's height; landscape: the plane's height
}

export interface LayoutGroup {
  id: string;
  lane: string;
  kind: ResourceKind;
  service?: string; // generic resources group per AWS service
  count: number;
  expanded: boolean;
}

export interface Layout {
  nodes: LayoutNode[]; // in reading order
  edges: LayoutEdge[];
  lanes: LayoutLane[];
  columns: LayoutColumn[];
  groups: LayoutGroup[]; // every kind set big enough to group, expanded or not
  parents: { id: string; key: string; count: number }[]; // expanded parents (their children are drawn one by one)
  bounds: Box;
  headY: number; // column labels baseline band (top of the plane)
  orientation: Orientation;
  laneBy: LaneBy;
  nodeById: Map<string, LayoutNode>;
  nodeOf: Map<string, string>; // resource key → node id (itself, its group, or the parent it folds into)
}

const KIND_ORDER = new Map(Object.keys(KIND_INFO).map((k, i) => [k as ResourceKind, i]));
const CONF_RANK: Record<Edge["confidence"], number> = { config: 0, allowed: 1, mentioned: 2 };
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const isProd = (id: string, label?: string) => /^prod(uction)?$/i.test(id) || (!!label && /^prod(uction)?$/i.test(label));

// Lanes: production first, then the other environments by id, Shared last.
export function laneOrder(ids: Iterable<string>, labels: Record<string, string> = {}): string[] {
  const set = [...new Set(ids)];
  return set.sort((a, b) => {
    if (a === b) return 0;
    if (a === SHARED_LANE) return 1;
    if (b === SHARED_LANE) return -1;
    const pa = isProd(a, labels[a]), pb = isProd(b, labels[b]);
    if (pa !== pb) return pa ? -1 : 1;
    return cmp(a, b);
  });
}

// "arn:aws:ec2:us-east-1:1234:vpc/vpc-0abc" → "vpc-0abc" (a VPC node sits in its own lane).
export const vpcIdOfKey = (key: string) => /(?:^|[:/])(vpc-[0-9a-z]+)(?:@|$)/i.exec(key)?.[1];

// The lane a resource belongs to, for each way of laning the map.
export function laneOf(r: LayoutResource, by: LaneBy): string {
  switch (by) {
    case "env":
      return r.env || SHARED_LANE;
    case "vpc":
      return r.vpcId || (r.kind === "vpc" ? vpcIdOfKey(r.key) : undefined) || SHARED_LANE;
    case "region":
      return r.region || SHARED_LANE;
    default:
      return ALL_LANE;
  }
}

function orderLanes(ids: string[], by: LaneBy, labels: Record<string, string>, regions: readonly string[] | undefined): string[] {
  if (by === "env") return laneOrder(ids, labels);
  const set = [...new Set(ids)];
  const rank = (id: string) => (id === SHARED_LANE ? 3 : id === GLOBAL_LANE && by === "region" ? 2 : 0);
  return set.sort((a, b) => {
    const ra = rank(a), rb = rank(b);
    if (ra !== rb) return ra - rb;
    if (by === "region" && regions) {
      const ia = regions.indexOf(a), ib = regions.indexOf(b);
      if (ia !== ib) return (ia < 0 ? 1e6 : ia) - (ib < 0 ? 1e6 : ib);
    }
    return cmp((labels[a] ?? a).toLowerCase(), (labels[b] ?? b).toLowerCase()) || cmp(a, b);
  });
}

function laneLabelOf(id: string, by: LaneBy, envLabels: Record<string, string>, laneLabels: Record<string, string>) {
  if (id === ALL_LANE) return "";
  if (id === SHARED_LANE) return by === "vpc" ? "No VPC" : by === "region" ? "No region" : "Shared";
  if (by === "env") return envLabels[id] ?? laneLabels[id] ?? id;
  if (by === "region" && id === GLOBAL_LANE) return laneLabels[id] ?? "Global";
  return laneLabels[id] ?? id;
}

interface Draft {
  id: string;
  type: "resource" | "group";
  members?: string[];
  service?: string;
  kind: ResourceKind;
  kindIdx: number;
  cat: number; // column index (among present categories)
  lane: number; // lane index
  sortName: string;
  idx: number; // position in its cell
  nbr: number[]; // neighbour draft indices (both directions)
  bary: number;
}

interface Cell {
  items: number[]; // draft indices in order
  subCols: number;
  rows: number;
}

// Which resources a layout draws, and where folded children go. Shared by layoutGraph and the page's counts.
export function visibleOnLayers(r: Pick<LayoutResource, "kind" | "category" | "hidden">, layers: readonly Layer[] = DEFAULT_LAYERS): boolean {
  if (r.hidden) return false;
  const c = categoryOf(r);
  return !isSupport(c) || layers.includes(c);
}

export function layoutGraph(resources: readonly LayoutResource[], edges: readonly LayoutEdgeInput[], opts: LayoutOptions = {}): Layout {
  const laneBy: LaneBy = opts.laneBy ?? (opts.groupByEnv === false ? "none" : "env");
  const lanesOn = laneBy !== "none";
  const portrait = opts.orientation === "portrait";
  const D = portrait ? PORTRAIT : LANDSCAPE;
  const fallback = Math.max(1, opts.groupThreshold ?? 12);
  const thresholds: Record<string, number> = { ...DEFAULT_GROUP_THRESHOLDS };
  for (const [k, v] of Object.entries(opts.groupThresholds ?? {})) if (typeof v === "number" && v >= 0) thresholds[k] = v;
  const thresholdOf = (kind: ResourceKind, cat: Category) => thresholds[kind] ?? thresholds[cat] ?? fallback;
  const expanded = new Set(opts.expanded ?? []);
  const envLabels = opts.envLabels ?? {};
  const laneLabels = opts.laneLabels ?? {};
  const layers = opts.layers ?? DEFAULT_LAYERS;
  const fold = opts.foldChildren ?? true;
  const sweeps = Math.max(0, opts.sweeps ?? 4);

  // Order-independent: everything below iterates in key order. Unknown kinds (a newer server) are skipped.
  const res = resources
    .filter((r) => !!KIND_INFO[r.kind] && visibleOnLayers(r, layers))
    .sort((a, b) => cmp(a.key, b.key));
  const byKey = new Map(res.map((r) => [r.key, r]));

  // ---- folding: a child is drawn inside the top-most collapsed ancestor that is on the map ----
  const foldInto = new Map<string, string>(); // child key → ancestor key
  if (fold) {
    for (const r of res) {
      if (!r.parent) continue;
      const chain: string[] = [];
      let p: string | undefined = r.parent;
      while (p && byKey.has(p) && chain.length < 8) {
        if (p === r.key || chain.includes(p)) {
          chain.length = 0; // a cycle in the data: draw it as it is rather than fold it away
          break;
        }
        chain.push(p);
        p = byKey.get(p)!.parent;
      }
      for (let i = chain.length - 1; i >= 0; i--) {
        if (!expanded.has(parentId(chain[i]))) {
          foldInto.set(r.key, chain[i]);
          break;
        }
      }
    }
  }
  const drawn = res.filter((r) => !foldInto.has(r.key));

  const laneIdsRaw = drawn.map((r) => laneOf(r, laneBy));
  const laneIds = orderLanes(laneIdsRaw, laneBy, laneBy === "env" ? envLabels : laneLabels, opts.regions);
  const laneIdx = new Map(laneIds.map((l, i) => [l, i]));
  const catOf = new Map(drawn.map((r) => [r.key, categoryOf(r)]));
  const catSet = new Set(catOf.values());
  const presentCats = CATEGORY_ORDER.filter((c) => catSet.has(c));
  const catIdx = new Map(presentCats.map((c, i) => [c, i]));

  // ---- nodes (with grouping) ----
  const buckets = new Map<string, LayoutResource[]>();
  for (let i = 0; i < drawn.length; i++) {
    const r = drawn[i];
    const sub = r.kind === "aws-resource" ? `${serviceOf(r)}${r.source === "reference" ? REF_SUFFIX : ""}` : "";
    const k = `${laneIdsRaw[i]}\u0000${catOf.get(r.key)}\u0000${r.kind}\u0000${sub}`;
    const b = buckets.get(k);
    if (b) b.push(r);
    else buckets.set(k, [r]);
  }
  const drafts: Draft[] = [];
  const nodeOf = new Map<string, string>();
  const draftOf = new Map<string, number>(); // node id → draft index
  const groups: LayoutGroup[] = [];
  const byName = (a: LayoutResource, b: LayoutResource) => cmp(a.name.toLowerCase(), b.name.toLowerCase()) || cmp(a.key, b.key);
  for (const [k, list] of [...buckets].sort((a, b) => cmp(a[0], b[0]))) {
    const [lane, cat, , sub] = k.split("\u0000") as [string, Category, string, string];
    const kind = list[0].kind;
    const ref = sub.endsWith(REF_SUFFIX);
    const base = { kind, kindIdx: KIND_ORDER.get(kind) ?? 999, cat: catIdx.get(cat)!, lane: laneIdx.get(lane)!, idx: 0, nbr: [], bary: 0 };
    if (list.length > (ref ? (thresholds.reference ?? fallback) : thresholdOf(kind, cat))) {
      const gid = groupId(lane, kind, sub || undefined);
      const open = expanded.has(gid);
      groups.push({ id: gid, lane, kind, ...(sub ? { service: sub } : {}), count: list.length, expanded: open });
      if (!open) {
        const members = [...list].sort(byName).map((r) => r.key);
        draftOf.set(gid, drafts.length);
        drafts.push({ ...base, nbr: [], id: gid, type: "group", members, ...(sub ? { service: sub } : {}), sortName: sub.toLowerCase() });
        for (const m of members) nodeOf.set(m, gid);
        continue;
      }
    }
    for (const r of list) {
      draftOf.set(r.key, drafts.length);
      nodeOf.set(r.key, r.key);
      drafts.push({ ...base, nbr: [], id: r.key, type: "resource", sortName: r.name.toLowerCase() });
    }
  }
  const folded = new Map<string, string[]>(); // node id → folded resource keys
  for (const [child, anc] of foldInto) {
    const node = nodeOf.get(anc);
    if (!node) continue;
    nodeOf.set(child, node);
    const f = folded.get(node);
    if (f) f.push(child);
    else folded.set(node, [child]);
  }

  // ---- edges, merged per node pair (numeric keys; no global sort: the result is made order-independent below) ----
  type Merged = { from: number; to: number; kinds: EdgeKind[]; ids: string[]; kind: EdgeKind; conf: Edge["confidence"]; bestId: string };
  const draftOfKey = new Map<string, number>(); // resource key → draft index of the node that draws it
  for (const [k, node] of nodeOf) draftOfKey.set(k, draftOf.get(node)!);
  const merged = new Map<number, Merged>();
  const N = drafts.length + 1;
  for (const e of edges) {
    const a = draftOfKey.get(e.from), b = draftOfKey.get(e.to);
    if (a === undefined || b === undefined || a === b) continue;
    const key = a * N + b;
    const conf = e.confidence ?? "config";
    const m = merged.get(key);
    if (!m) merged.set(key, { from: a, to: b, kinds: [e.kind], ids: [e.id], kind: e.kind, conf, bestId: e.id });
    else {
      m.ids.push(e.id);
      if (!m.kinds.includes(e.kind)) m.kinds.push(e.kind);
      const r = CONF_RANK[conf] - CONF_RANK[m.conf];
      if (r < 0 || (r === 0 && e.id < m.bestId)) {
        m.conf = conf;
        m.kind = e.kind;
        m.bestId = e.id;
      }
    }
  }
  // Drafts are built in a deterministic order, so their indices are a stable sort key.
  const list = [...merged.values()].sort((p, q) => p.from - q.from || p.to - q.to);
  for (const m of list) {
    if (m.ids.length > 1) m.ids.sort(cmp);
    if (m.kinds.length > 1) m.kinds.sort(cmp);
    drafts[m.from].nbr.push(m.to);
    drafts[m.to].nbr.push(m.from);
  }

  // ---- cells ----
  const L = laneIds.length, C = presentCats.length;
  const cells: Cell[][] = Array.from({ length: L }, () => Array.from({ length: C }, () => ({ items: [], subCols: 1, rows: 0 })));
  for (let i = 0; i < drafts.length; i++) cells[drafts[i].lane][drafts[i].cat].items.push(i);
  const initial = (a: number, b: number) => {
    const p = drafts[a], q = drafts[b];
    return p.kindIdx - q.kindIdx || (p.type === q.type ? 0 : p.type === "group" ? -1 : 1) || cmp(p.sortName, q.sortName) || cmp(p.id, q.id);
  };
  const laneHead = lanesOn ? D.laneHead : D.laneHeadFlat;
  const vp = opts.viewport && opts.viewport.w > 0 && opts.viewport.h > 0 ? (portrait ? { w: opts.viewport.h, h: opts.viewport.w } : opts.viewport) : undefined;
  const fixedCap = vp ? bestRowCap(cells.map((row) => row.map((c) => c.items.length)), laneHead, vp, D) : 0;
  const colSub = new Array<number>(C).fill(1);
  const laneRows = new Array<number>(L).fill(1);
  for (let l = 0; l < L; l++) {
    for (let c = 0; c < C; c++) {
      const cell = cells[l][c];
      cell.items.sort(initial);
      cell.items.forEach((d, i) => (drafts[d].idx = i));
      const n = cell.items.length;
      const cap = fixedCap || Math.max(MIN_ROWS, Math.ceil(Math.sqrt(2 * n)));
      cell.subCols = Math.max(1, Math.ceil(n / cap));
      cell.rows = n ? Math.ceil(n / cell.subCols) : 0;
      colSub[c] = Math.max(colSub[c], cell.subCols);
      laneRows[l] = Math.max(laneRows[l], cell.rows);
    }
  }

  // ---- cross-axis geometry (fixed by cell sizes, so sweeps can use real positions) ----
  const laneTop: number[] = [];
  const laneH: number[] = [];
  let y = PAD + D.headH;
  for (let l = 0; l < L; l++) {
    laneTop.push(y);
    const h = laneHead + (laneRows[l] - 1) * D.rowH + D.nh + D.lanePad;
    laneH.push(h);
    y += h + D.laneGap;
  }
  const rowY = (d: Draft, idx: number) => {
    const cell = cells[d.lane][d.cat];
    const off = ((laneRows[d.lane] - cell.rows) * D.rowH) / 2;
    return laneTop[d.lane] + laneHead + off + Math.floor(idx / cell.subCols) * D.rowH;
  };
  const pos = drafts.map((d) => rowY(d, d.idx));

  // ---- barycenter sweeps ----
  const reorder = (cell: Cell, dir: 1 | -1) => {
    if (cell.items.length < 2) return;
    for (const di of cell.items) {
      const d = drafts[di];
      let sum = 0, n = 0;
      for (const o of d.nbr) {
        const oc = drafts[o].cat;
        if (dir === 1 ? oc < d.cat : oc > d.cat) {
          sum += pos[o];
          n++;
        }
      }
      if (!n)
        for (const o of d.nbr)
          if (drafts[o].cat !== d.cat) {
            sum += pos[o];
            n++;
          }
      d.bary = n ? sum / n : pos[di];
    }
    // Kind blocks keep together; blocks and their members sort by barycenter, ties keep the current order.
    const blocks = new Map<number, number[]>();
    for (const di of cell.items) {
      const k = drafts[di].kindIdx;
      const b = blocks.get(k);
      if (b) b.push(di);
      else blocks.set(k, [di]);
    }
    const bl = [...blocks.entries()].map(([k, items]) => ({ k, items, b: items.reduce((s, i) => s + drafts[i].bary, 0) / items.length, first: drafts[items[0]].idx }));
    bl.sort((p, q) => p.b - q.b || p.first - q.first || p.k - q.k);
    const next: number[] = [];
    for (const blk of bl) {
      blk.items.sort((p, q) => drafts[p].bary - drafts[q].bary || drafts[p].idx - drafts[q].idx);
      next.push(...blk.items);
    }
    cell.items = next;
    next.forEach((di, i) => {
      drafts[di].idx = i;
      pos[di] = rowY(drafts[di], i);
    });
  };
  for (let s = 0; s < sweeps; s++) {
    const dir: 1 | -1 = s % 2 === 0 ? 1 : -1;
    for (let k = 0; k < C; k++) {
      const c = dir === 1 ? k : C - 1 - k;
      for (let l = 0; l < L; l++) reorder(cells[l][c], dir);
    }
  }

  // ---- flow-axis geometry ----
  const colX: number[] = [];
  const colW: number[] = [];
  let x = D.uStart;
  for (let c = 0; c < C; c++) {
    colX.push(x);
    const w = colSub[c] * D.nw + (colSub[c] - 1) * D.subGap;
    colW.push(w);
    x += w + D.colGap;
  }
  const contentEnd = C ? x - D.colGap : D.uStart;

  // Everything below is computed in the landscape frame (u, v); `out` maps it to the plane.
  type F = { x: number; y: number; w: number; h: number };
  const out = (f: F): F => (portrait ? { x: f.y, y: f.x, w: f.h, h: f.w } : f);
  const frame: F[] = drafts.map((d, i) => {
    const cell = cells[d.lane][d.cat];
    const blockW = cell.subCols * D.nw + (cell.subCols - 1) * D.subGap;
    const bx = colX[d.cat] + (colW[d.cat] - blockW) / 2;
    return { x: Math.round(bx + (d.idx % cell.subCols) * (D.nw + D.subGap)), y: Math.round(pos[i]), w: D.nw, h: D.nh };
  });
  const nodes: LayoutNode[] = drafts.map((d, i) => {
    const p = out(frame[i]);
    const f = folded.get(d.id);
    return {
      id: d.id,
      type: d.type,
      ...(d.type === "resource" ? { key: d.id } : { members: d.members }),
      ...(d.service ? { service: d.service } : {}),
      ...(f ? { folded: f.sort(cmp) } : {}),
      kind: d.kind,
      category: presentCats[d.cat],
      lane: laneIds[d.lane],
      x: p.x,
      y: p.y,
      w: p.w,
      h: p.h,
      order: 0,
    };
  });

  // ---- edges: sides, ports, paths (landscape frame) ----
  type Side = { node: number; right: boolean };
  const ports = new Map<number, { edge: number; other: number; end: 0 | 1 }[]>(); // node * 2 + right → ports on that side
  const sides: { s: Side; t: Side; same: boolean }[] = list.map((m) => {
    const a = frame[m.from], b = frame[m.to];
    if (b.x >= a.x + a.w) return { s: { node: m.from, right: true }, t: { node: m.to, right: false }, same: false };
    if (b.x + b.w <= a.x) return { s: { node: m.from, right: false }, t: { node: m.to, right: true }, same: false };
    return { s: { node: m.from, right: true }, t: { node: m.to, right: true }, same: true };
  });
  sides.forEach((sd, ei) => {
    for (const [side, end, other] of [[sd.s, 0, sd.t.node], [sd.t, 1, sd.s.node]] as const) {
      const k = side.node * 2 + (side.right ? 1 : 0);
      const arr = ports.get(k);
      const item = { edge: ei, other, end };
      if (arr) arr.push(item);
      else ports.set(k, [item]);
    }
  });
  const portV = new Float64Array(list.length * 2); // edge * 2 + end (0 = source, 1 = target) → v
  for (const [k, arr] of ports) {
    const n = frame[k >> 1];
    arr.sort((p, q) => frame[p.other].y - frame[q.other].y || frame[p.other].x - frame[q.other].x || p.edge - q.edge || p.end - q.end);
    arr.forEach((p, i) => (portV[p.edge * 2 + p.end] = n.y + (arr.length === 1 ? n.h / 2 : n.h * (0.24 + (0.52 * i) / (arr.length - 1)))));
  }
  const r1 = (v: number) => Math.round(v * 10) / 10;
  const P = (u: number, v: number) => (portrait ? `${r1(v)},${r1(u)}` : `${r1(u)},${r1(v)}`);
  const pt = (u: number, v: number) => (portrait ? { x: v, y: u } : { x: u, y: v });
  const outEdges: LayoutEdge[] = list.map((m, ei) => {
    const sd = sides[ei];
    const a = frame[m.from], b = frame[m.to];
    const sx = sd.s.right ? a.x + a.w + 2 : a.x - 2;
    const tx = sd.t.right ? b.x + b.w + 5 : b.x - 5;
    const sy = portV[ei * 2], ty = portV[ei * 2 + 1];
    let c1x: number, c2x: number;
    if (sd.same) {
      const bulge = Math.min(180, 34 + Math.abs(ty - sy) * 0.14);
      c1x = sx + bulge;
      c2x = tx + bulge;
    } else {
      const s = sd.s.right ? 1 : -1;
      const k = Math.max(40, Math.abs(tx - sx) * 0.45);
      c1x = sx + s * k;
      c2x = tx - s * k;
    }
    const path = `M${P(sx, sy)}C${P(c1x, sy)} ${P(c2x, ty)} ${P(tx, ty)}`;
    const u0 = Math.min(sx, c1x, c2x, tx), u1 = Math.max(sx, c1x, c2x, tx), v0 = Math.min(sy, ty), v1 = Math.max(sy, ty);
    return {
      id: `${drafts[m.from].id}>${drafts[m.to].id}`,
      from: drafts[m.from].id,
      to: drafts[m.to].id,
      kind: m.kind,
      kinds: m.kinds,
      edgeIds: m.ids,
      confidence: m.conf,
      path,
      start: pt(sx, sy),
      end: pt(tx, ty),
      mid: pt((sx + 3 * c1x + 3 * c2x + tx) / 8, (sy + 3 * sy + 3 * ty + ty) / 8),
      box: portrait ? { x0: v0, y0: u0, x1: v1, y1: u1 } : { x0: u0, y0: v0, x1: u1, y1: v1 },
    };
  });

  // ---- reading order: lane, column, row, sub-column ----
  const readOrder = nodes.map((_, i) => i).sort((p, q) => {
    const a = drafts[p], b = drafts[q];
    return a.lane - b.lane || a.cat - b.cat || Math.floor(a.idx / cells[a.lane][a.cat].subCols) - Math.floor(b.idx / cells[b.lane][b.cat].subCols) || a.idx - b.idx;
  });
  const ordered = readOrder.map((i, o) => ((nodes[i].order = o), nodes[i]));

  // ---- lanes, columns, bounds ----
  const counts = new Array<number>(L).fill(0);
  for (const n of ordered) counts[laneIdx.get(n.lane)!] += (n.members?.length ?? 1) + (n.folded?.length ?? 0);
  const laneU0 = portrait ? PAD - 12 : D.uStart - 20;
  const lanes: LayoutLane[] = laneIds.map((id, l) => {
    const f = out({ x: laneU0, y: laneTop[l], w: contentEnd - laneU0 + 20, h: laneH[l] });
    return { id, label: lanesOn ? laneLabelOf(id, laneBy, envLabels, laneLabels) : "", ...f, count: counts[l] };
  });
  const bottom = L ? laneTop[L - 1] + laneH[L - 1] : PAD + D.headH;
  const columns: LayoutColumn[] = presentCats.map((c, i) => {
    const f = out({ x: colX[i], y: 0, w: colW[i], h: bottom + PAD });
    return { category: c, label: CATEGORY_LABEL[c], ...f };
  });
  const frameBounds = { w: Math.max(contentEnd + PAD, 1), h: bottom + PAD };
  const bounds: Box = portrait ? { x0: 0, y0: 0, x1: frameBounds.h, y1: frameBounds.w } : { x0: 0, y0: 0, x1: frameBounds.w, y1: frameBounds.h };
  groups.sort((a, b) => laneIdx.get(a.lane)! - laneIdx.get(b.lane)! || KIND_ORDER.get(a.kind)! - KIND_ORDER.get(b.kind)! || cmp(a.service ?? "", b.service ?? ""));
  const parents = [...expanded]
    .filter((id) => id.startsWith("parent:") && byKey.has(id.slice(7)) && res.some((r) => r.parent === id.slice(7)))
    .sort(cmp)
    .map((id) => ({ id, key: id.slice(7), count: res.filter((r) => r.parent === id.slice(7)).length }));
  return { nodes: ordered, edges: outEdges, lanes, columns, groups, parents, bounds, headY: PAD, orientation: portrait ? "portrait" : "landscape", laneBy, nodeById: new Map(ordered.map((n) => [n.id, n])), nodeOf };
}

// Plane size (landscape frame) for a given rows-per-sub-column cap, from cell sizes alone (counts[lane][column]).
function planeSize(counts: number[][], cap: number, laneHead: number, D: Dims) {
  const L = counts.length, C = L ? counts[0].length : 0;
  let w = D.uStart + PAD + Math.max(0, C - 1) * D.colGap;
  const rows = new Array<number>(L).fill(1);
  for (let c = 0; c < C; c++) {
    let sub = 1;
    for (let l = 0; l < L; l++) {
      const n = counts[l][c];
      if (!n) continue;
      const s = Math.ceil(n / cap);
      sub = Math.max(sub, s);
      rows[l] = Math.max(rows[l], Math.ceil(n / s));
    }
    w += sub * D.nw + (sub - 1) * D.subGap;
  }
  let h = PAD * 2 + D.headH + Math.max(0, L - 1) * D.laneGap;
  for (const r of rows) h += laneHead + (r - 1) * D.rowH + D.nh + D.lanePad;
  return { w, h };
}

// The rows-per-sub-column cap that lets the plane fit `viewport` at the largest zoom. Fewer, taller sub-columns win
// unless more columns are clearly (> 3%) better.
function bestRowCap(counts: number[][], laneHead: number, viewport: { w: number; h: number }, D: Dims) {
  const biggest = Math.max(1, ...counts.flat());
  let best = biggest, bestZ = 0;
  for (let cap = biggest; cap >= 3; cap--) {
    const { w, h } = planeSize(counts, cap, laneHead, D);
    const z = Math.min(viewport.w / w, viewport.h / h);
    if (z > bestZ * 1.03) {
      bestZ = z;
      best = cap;
    }
    if (cap > 64) cap = Math.max(64, Math.ceil(cap * 0.85)); // very large cells: coarse steps
  }
  return best;
}

// ---- helpers the canvas uses ----

// Does a box intersect the visible window (plane units)?
export const intersects = (b: Box, w: Box) => b.x1 >= w.x0 && b.x0 <= w.x1 && b.y1 >= w.y0 && b.y0 <= w.y1;

// The node to move to from `from` with an arrow key: a connected node in that direction when there is one (nearest
// first), otherwise the nearest node in that direction.
export function neighbourInDirection(layout: Layout, from: string, dir: "left" | "right" | "up" | "down", adjacency?: Map<string, Set<string>>): string | undefined {
  const a = layout.nodeById.get(from);
  if (!a) return undefined;
  const ax = a.x + a.w / 2, ay = a.y + a.h / 2;
  const score = (n: LayoutNode) => {
    const dx = n.x + n.w / 2 - ax, dy = n.y + n.h / 2 - ay;
    const along = dir === "left" ? -dx : dir === "right" ? dx : dir === "up" ? -dy : dy;
    const across = dir === "left" || dir === "right" ? Math.abs(dy) : Math.abs(dx);
    if (along <= (dir === "left" || dir === "right" ? a.w / 2 : a.h / 2)) return Infinity; // not in that direction
    return along + across * 2.2;
  };
  const best = (cands: Iterable<LayoutNode>) => {
    let pick: LayoutNode | undefined, s = Infinity;
    for (const n of cands) {
      if (n.id === from) continue;
      const v = score(n);
      if (v < s || (v === s && pick && n.order < pick.order)) {
        s = v;
        pick = n;
      }
    }
    return pick;
  };
  // The flow axis follows connections first: left/right in landscape, up/down in portrait.
  const flow = layout.orientation === "portrait" ? dir === "up" || dir === "down" : dir === "left" || dir === "right";
  const linked = adjacency?.get(from);
  if (linked && flow) {
    const hit = best([...linked].map((id) => layout.nodeById.get(id)).filter((n): n is LayoutNode => !!n));
    if (hit) return hit.id;
  }
  return best(layout.nodes)?.id;
}

// Node id → the ids of the nodes it shares a drawn edge with.
export function adjacencyOf(layout: Layout): Map<string, Set<string>> {
  const m = new Map<string, Set<string>>();
  const add = (a: string, b: string) => {
    const s = m.get(a);
    if (s) s.add(b);
    else m.set(a, new Set([b]));
  };
  for (const e of layout.edges) {
    add(e.from, e.to);
    add(e.to, e.from);
  }
  return m;
}
