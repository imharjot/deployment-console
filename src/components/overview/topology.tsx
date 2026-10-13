"use client";
// Service map: one pannable, zoomable plane of draggable cards joined by the declared dependency edges.
// Edges are quiet hairlines; state only shows where it matters (a failing target, a parked path). Focusing
// a card brings its paths forward and lets the rest of the map step back.
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { ChevronDown, Maximize2, Minus, Plus, Undo2, X } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import type { EdgeKind, EnvOverview, ResourceView, State, TopoEdge, TopoNode } from "@/lib/types";
import { EASE, enter, exit, popover, useMediaQuery } from "../motion";
import { STATE, StateDot, stateStyle } from "../state";
import { resourceHue } from "../hue";
import { cx } from "../ui";
import { KIND_ICON } from "./card";

const W = 196, H = 70, LANE_X = [100, 374, 648, 922, 1196], ROW = 112, PAD = 48;
const Z_MIN = 0.3, Z_MAX = 2;
const KIND_LABEL: Record<EdgeKind, string> = { http: "HTTP", sql: "SQL", cache: "Cache", stream: "Stream", api: "External API" };
type Pos = Record<string, { x: number; y: number }>;
type View = { x: number; y: number; z: number };
type EdgeStatus = "ok" | "slow" | "broken" | "idle";

function defaults(nodes: TopoNode[]): Pos {
  const lanes: TopoNode[][] = [[], [], [], [], []];
  for (const n of nodes) lanes[n.lane].push(n);
  const rows = Math.max(...lanes.map((l) => l.length), 3);
  const mid = (rows * ROW) / 2 + PAD;
  const pos: Pos = {};
  lanes.forEach((l, li) => l.forEach((n, i) => (pos[n.id] = { x: LANE_X[li], y: mid + (i - (l.length - 1) / 2) * ROW })));
  return pos;
}

// Bounding box of the visible cards, so "fit" frames what is actually on the plane.
function bounds(pos: Pos, ids: Iterable<string>) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const id of ids) {
    const p = pos[id];
    if (!p) continue;
    x0 = Math.min(x0, p.x - W / 2);
    y0 = Math.min(y0, p.y - H / 2);
    x1 = Math.max(x1, p.x + W / 2);
    y1 = Math.max(y1, p.y + H / 2);
  }
  return Number.isFinite(x0) ? { x0, y0, x1, y1 } : { x0: 0, y0: 0, x1: 1, y1: 1 };
}
type Box = ReturnType<typeof bounds>;

// The zoom that frames a bounding box with padding, capped at 1.1 so a small map keeps a natural size.
const fitZoom = (r: { width: number; height: number }, b: Box) => Math.min(r.width / (b.x1 - b.x0 + PAD * 2), r.height / (b.y1 - b.y0 + PAD * 2), 1.1);

const bad = (s?: State) => s === "DOWN" || s === "UNKNOWN";
const parked = (s?: State) => s === "STOPPED" || s === "BOX_STOPPED";
const shaky = (s?: State) => s === "DEGRADED" || s === "DEPLOYING";
function edgeStatus(from?: TopoNode, to?: TopoNode): EdgeStatus {
  if (parked(from?.state) || parked(to?.state)) return "idle";
  if (bad(to?.state) || from?.state === "DOWN") return "broken";
  if (shaky(from?.state) || shaky(to?.state)) return "slow";
  return "ok";
}
const STATUS_TEXT: Record<EdgeStatus, string> = { ok: "healthy", slow: "one end degraded", broken: "target failing", idle: "idle (stopped)" };

// A smooth S-curve from the side of the source that faces the target to the facing side of the target.
// Neighbours in one lane join with a short vertical; cards further apart in a lane are joined by an arc
// beside the lane, so the line never runs behind the cards in between. Two-way pairs run a few pixels
// apart, or arc on opposite sides.
function geometry(a: { x: number; y: number }, b: { x: number; y: number }, offset: number, via?: number) {
  const dx = b.x - a.x, dy = b.y - a.y;
  if (Math.abs(dx) > W * 0.75) {
    const s = Math.sign(dx);
    const sx = a.x + s * (W / 2 + 2), tx = b.x - s * (W / 2 + 6), sy = a.y + offset, ty = b.y + offset;
    if (via !== undefined) {
      // Bend into the corridor in the first gap, run along it, and bend out in the last gap.
      const k = 34, y = via + offset;
      return {
        d: `M${sx},${sy} C${sx + s * k},${sy} ${sx + s * k},${y} ${sx + s * 2 * k},${y} L${tx - s * 2 * k},${y} C${tx - s * k},${y} ${tx - s * k},${ty} ${tx},${ty}`,
        end: { x: tx, y: ty },
        mid: { x: (sx + tx) / 2, y },
      };
    }
    const k = Math.max(36, Math.abs(tx - sx) * 0.5);
    return { d: `M${sx},${sy} C${sx + s * k},${sy} ${tx - s * k},${ty} ${tx},${ty}`, end: { x: tx, y: ty }, mid: { x: (sx + tx) / 2, y: (sy + ty) / 2 } };
  }
  if (Math.abs(dy) > ROW * 1.5) {
    const side = offset < 0 ? -1 : 1;
    const sx = a.x + side * (W / 2 + 2), tx = b.x + side * (W / 2 + 6), bulge = side * (26 + Math.abs(dy) * 0.12);
    return { d: `M${sx},${a.y} C${sx + bulge},${a.y} ${tx + bulge},${b.y} ${tx},${b.y}`, end: { x: tx, y: b.y }, mid: { x: (sx + tx) / 2 + bulge * 0.75, y: (a.y + b.y) / 2 } };
  }
  const s = Math.sign(dy) || 1;
  const sy = a.y + s * (H / 2 + 2), ty = b.y - s * (H / 2 + 6), sx = a.x + offset, tx = b.x + offset;
  const k = Math.max(20, Math.abs(ty - sy) * 0.5);
  return { d: `M${sx},${sy} C${sx},${sy + s * k} ${tx},${ty - s * k} ${tx},${ty}`, end: { x: tx, y: ty }, mid: { x: (sx + tx) / 2, y: (sy + ty) / 2 } };
}

// An edge that crosses a lane of cards would run behind them; instead it takes the gap between those cards
// nearest its straight line (or passes above / below the lane). Undefined when the way is already clear.
function corridor(a: { x: number; y: number }, b: { x: number; y: number }, cards: { x: number; y: number }[]) {
  const x0 = Math.min(a.x, b.x) + W * 0.75, x1 = Math.max(a.x, b.x) - W * 0.75;
  const lo = Math.min(a.y, b.y) - H / 2, hi = Math.max(a.y, b.y) + H / 2;
  const ys = cards.filter((c) => c.x > x0 && c.x < x1).map((c) => c.y).sort((p, q) => p - q);
  if (!ys.some((y) => y + H / 2 > lo && y - H / 2 < hi)) return undefined;
  const gaps = [ys[0] - H / 2 - 22, ...ys.slice(1).map((y, i) => (y + ys[i]) / 2), ys[ys.length - 1] + H / 2 + 22];
  const aim = (a.y + b.y) / 2;
  return gaps.reduce((best, y) => (Math.abs(y - aim) < Math.abs(best - aim) ? y : best));
}

function usePersisted(env: string, nodes: TopoNode[]) {
  const base = useMemo(() => defaults(nodes), [nodes]);
  const key = `console.topo.${env}`;
  const [pos, setPos] = useState<Pos>(base);
  useEffect(() => {
    let saved: Pos = {};
    try {
      saved = JSON.parse(localStorage.getItem(key) ?? "{}");
    } catch {
      /* storage blocked or corrupt */
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect -- saved layout is browser-only; merge after hydration
    setPos({ ...base, ...Object.fromEntries(Object.entries(saved).filter(([id]) => id in base)) });
  }, [key, base]);
  const save = useCallback(
    (p: Pos) => {
      try {
        localStorage.setItem(key, JSON.stringify(p));
      } catch {
        /* storage blocked */
      }
    },
    [key],
  );
  return { pos, setPos, save, base };
}

type Gesture =
  | { kind: "node"; id: string; sx: number; sy: number; ox: number; oy: number; moved: boolean }
  | { kind: "pan"; sx: number; sy: number; ox: number; oy: number; moved: boolean }
  | { kind: "pinch"; d0: number; mx: number; my: number; v0: View };

// memo: opening a resource panel re-renders the page, but the map's inputs have not changed.
export const Topology = memo(function Topology({ o, onOpen }: { o: EnvOverview; onOpen: (key: string) => void }) {
  const [showExt, setShowExt] = useState(true);
  const nodes = useMemo(() => o.topology.nodes.filter((n) => showExt || n.kind !== "external"), [o.topology.nodes, showExt]);
  const ids = useMemo(() => new Set(nodes.map((n) => n.id)), [nodes]);
  const edges = useMemo(() => o.topology.edges.filter((e) => ids.has(e.from) && ids.has(e.to)), [o.topology.edges, ids]);
  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  const res = useMemo(() => new Map([...o.services, ...o.infra].map((r) => [r.key, r])), [o.services, o.infra]);
  const { pos, setPos, save, base } = usePersisted(o.env, o.topology.nodes);

  const [view, setView] = useState<View>({ x: 0, y: 0, z: 0.8 });
  const [hover, setHover] = useState<string | null>(null);
  const [hoverEdge, setHoverEdge] = useState<string | null>(null);
  const [ext, setExt] = useState<TopoNode | null>(null);
  const [grabbing, setGrabbing] = useState(false);
  const still = useReducedMotion() ?? false;
  const touch = useMediaQuery("(pointer: coarse)");
  const box = useRef<HTMLDivElement>(null);

  // Gesture handlers read the latest layout through refs, so the callbacks (and the memoised cards) stay stable.
  const live = useRef({ pos, view, byId, onOpen, ids });
  useEffect(() => {
    live.current = { pos, view, byId, onOpen, ids };
  });
  const gesture = useRef<Gesture | null>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  // Set once the user pans, zooms or moves a card: from then on the map stays where they put it (no automatic
  // fits on resize or new data) until they ask for Fit or Reset, or switch environment.
  const touched = useRef(false);

  // Zoom-out floor: Z_MIN, or lower when that is what it takes to see the whole map (a 5-lane map on a phone).
  const minZoom = useCallback(() => {
    const el = box.current;
    return el ? Math.min(Z_MIN, fitZoom(el.getBoundingClientRect(), bounds(live.current.pos, live.current.ids))) : Z_MIN;
  }, []);

  // Fit frames every visible card, centred with padding, on any screen: the first view shows the whole map.
  const fit = useCallback(
    (layout?: Pos) => {
      const el = box.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) return; // not laid out yet (hidden tab, first frame)
      const b = bounds(layout ?? live.current.pos, ids);
      const z = Math.min(Z_MAX, fitZoom(r, b));
      setView({ z, x: r.width / 2 - ((b.x0 + b.x1) / 2) * z, y: r.height / 2 - ((b.y0 + b.y1) / 2) * z });
    },
    [ids],
  );
  // Automatic fits: on first render, when the saved layout or the set of cards changes the map's extent, and when
  // the canvas is resized (rotation, sidebar, window) — only while the user hasn't taken over.
  useEffect(() => {
    touched.current = false;
  }, [o.env]);
  const extent = bounds(pos, ids);
  useEffect(() => {
    if (!touched.current) fit();
  }, [fit, o.env, extent.x0, extent.y0, extent.x1, extent.y1]);
  useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => !touched.current && fit());
    ro.observe(el);
    return () => ro.disconnect();
  }, [fit]);

  const zoomAt = useCallback((cx: number, cy: number, factor: number) => {
    touched.current = true;
    const lo = minZoom();
    setView((v) => {
      const z = Math.min(Z_MAX, Math.max(lo, v.z * factor));
      return { z, x: cx - ((cx - v.x) * z) / v.z, y: cy - ((cy - v.y) * z) / v.z };
    });
  }, [minZoom]);

  // Trackpad and wheel: scrolling pans the plane, pinching (or ⌘/Ctrl + scroll) zooms around the pointer.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        const r = el.getBoundingClientRect();
        zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.01));
      } else {
        touched.current = true;
        setView((v) => ({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY }));
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomAt]);

  const onPointerDown = useCallback((e: ReactPointerEvent, id?: string) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    e.stopPropagation();
    try {
      (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    } catch {
      /* synthetic or already-released pointer */
    }
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2) {
      // A second finger turns any drag into a pinch around the fingers' midpoint.
      const [a, b] = [...pointers.current.values()];
      const r = box.current!.getBoundingClientRect();
      gesture.current = { kind: "pinch", d0: Math.hypot(b.x - a.x, b.y - a.y) || 1, mx: (a.x + b.x) / 2 - r.left, my: (a.y + b.y) / 2 - r.top, v0: live.current.view };
      touched.current = true;
      return;
    }
    if (pointers.current.size > 2) return;
    const { pos: p, view: v } = live.current;
    gesture.current = id
      ? { kind: "node", id, sx: e.clientX, sy: e.clientY, ox: p[id]?.x ?? 0, oy: p[id]?.y ?? 0, moved: false }
      : { kind: "pan", sx: e.clientX, sy: e.clientY, ox: v.x, oy: v.y, moved: false };
    setGrabbing(true);
  }, []);

  const onPointerMove = (e: ReactPointerEvent) => {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const g = gesture.current;
    if (!g) return;
    if (g.kind === "pinch") {
      const [a, b] = [...pointers.current.values()];
      const r = box.current!.getBoundingClientRect();
      const mx = (a.x + b.x) / 2 - r.left, my = (a.y + b.y) / 2 - r.top;
      const z = Math.min(Z_MAX, Math.max(minZoom(), (g.v0.z * Math.hypot(b.x - a.x, b.y - a.y)) / g.d0));
      // Keep the plane point that started under the fingers' midpoint under the midpoint as it moves.
      const px = (g.mx - g.v0.x) / g.v0.z, py = (g.my - g.v0.y) / g.v0.z;
      setView({ z, x: mx - px * z, y: my - py * z });
      return;
    }
    const dx = e.clientX - g.sx, dy = e.clientY - g.sy;
    if (Math.abs(dx) + Math.abs(dy) > 4) g.moved = touched.current = true;
    if (g.kind === "node") {
      const z = live.current.view.z;
      setPos((ps) => ({ ...ps, [g.id]: { x: Math.round(g.ox + dx / z), y: Math.round(g.oy + dy / z) } }));
    } else setView((v) => ({ ...v, x: g.ox + dx, y: g.oy + dy }));
  };

  const onPointerEnd = (e: ReactPointerEvent) => {
    if (!pointers.current.delete(e.pointerId)) return;
    const g = gesture.current;
    if (g?.kind === "pinch") {
      // One finger stays down: carry on as a pan from where it is, so the plane never jumps.
      const rest = [...pointers.current.values()][0];
      const v = live.current.view;
      gesture.current = rest ? { kind: "pan", sx: rest.x, sy: rest.y, ox: v.x, oy: v.y, moved: true } : null;
      if (!rest) setGrabbing(false);
      return;
    }
    gesture.current = null;
    setGrabbing(false);
    if (g?.kind !== "node") return;
    if (g.moved) setPos((ps) => (save(ps), ps));
    else {
      const n = live.current.byId.get(g.id);
      if (n?.resourceKey) live.current.onOpen(n.resourceKey);
      else if (n) setExt(n);
    }
  };

  const openNode = useCallback((id: string) => {
    const n = live.current.byId.get(id);
    if (n?.resourceKey) live.current.onOpen(n.resourceKey);
    else if (n) setExt(n);
  }, []);
  const hoverNode = useCallback((id: string | null) => setHover(id), []);

  const focus = hover;
  const linked = useMemo(() => {
    if (!focus) return null;
    const s = new Set<string>([focus]);
    for (const e of edges) if (e.from === focus || e.to === focus) s.add(e.from).add(e.to);
    return s;
  }, [focus, edges]);
  const pairs = useMemo(() => new Map(edges.map((e) => [`${e.from}>${e.to}`, e])), [edges]);
  // A two-way pair with the same description and no rates shows its label once.
  const twin = (e: TopoEdge) => {
    const r = pairs.get(`${e.to}>${e.from}`);
    return !!r && !e.rate && !r.rate && r.label === e.label && e.from > e.to;
  };
  const cards = nodes.map((n) => pos[n.id]).filter(Boolean);
  const lines: LineProps[] = edges.map((e) => ({
    e,
    from: pos[e.from],
    to: pos[e.to],
    via: pos[e.from] && pos[e.to] ? corridor(pos[e.from], pos[e.to], cards) : undefined,
    status: edgeStatus(byId.get(e.from), byId.get(e.to)),
    offset: pairs.has(`${e.to}>${e.from}`) ? (e.from < e.to ? -3.5 : 3.5) : 0,
    quiet: twin(e),
    dim: !!focus && e.from !== focus && e.to !== focus,
    hot: hoverEdge === e.id || e.from === focus || e.to === focus,
  }));
  const tip = hoverEdge ? edges.find((x) => x.id === hoverEdge) : undefined;

  return (
    <div className="relative">
      <div
        ref={box}
        className="relative h-[62svh] min-h-[380px] touch-none select-none overflow-hidden rounded-3xl border border-line bg-canvas sm:h-[min(72vh,720px)] sm:min-h-[520px]"
        style={{ cursor: grabbing ? "grabbing" : "grab" }}
        onPointerDown={(e) => onPointerDown(e)}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
      >
        {/* The faintest vignette, so the plane reads as a surface rather than a void. */}
        <div aria-hidden className="pointer-events-none absolute inset-0 bg-[radial-gradient(120%_90%_at_50%_45%,transparent_60%,color-mix(in_srgb,var(--text)_3.5%,transparent))]" />
        <div style={{ transform: `translate3d(${view.x}px, ${view.y}px, 0) scale(${view.z})`, transformOrigin: "0 0", position: "absolute", inset: 0 }}>
          {/* --z keeps hairlines and labels the same size on screen at every zoom. Lines sit under the
              cards; their labels sit in a second layer above, so a label is never hidden by a card. */}
          <svg className="absolute left-0 top-0 overflow-visible" width={1} height={1} style={{ "--z": view.z } as CSSProperties}>
            {lines.map((l) => (
              <Edge key={l.e.id} {...l} still={still} onHover={setHoverEdge} />
            ))}
          </svg>
          {nodes.map((n) => {
            const p = pos[n.id];
            if (!p) return null;
            return <Node key={n.id} n={n} r={n.resourceKey ? res.get(n.resourceKey) : undefined} x={p.x} y={p.y} dim={!!linked && !linked.has(n.id)} onDown={onPointerDown} onOpen={openNode} onHover={hoverNode} />;
          })}
          <svg aria-hidden className="pointer-events-none absolute left-0 top-0 overflow-visible" width={1} height={1} style={{ "--z": view.z } as CSSProperties}>
            {lines.map((l) => (
              <EdgeLabel key={l.e.id} {...l} />
            ))}
          </svg>
        </div>

        <div className="absolute right-3 top-3 flex items-center gap-2" onPointerDown={(e) => e.stopPropagation()}>
          <button
            onClick={() => setShowExt((s) => !s)}
            aria-pressed={showExt}
            className="press flex h-8 items-center gap-2 rounded-lg border border-line bg-panel/85 px-2.5 text-xs text-fg-2 backdrop-blur-md hover:text-fg pointer-coarse:h-10"
          >
            <span className={cx("grid size-3 place-items-center rounded-[4px] border transition-colors duration-200", showExt ? "border-accent bg-accent" : "border-line-strong")}>
              {showExt && <span className="size-1 rounded-full bg-accent-fg" />}
            </span>
            External
          </button>
          <div className="flex items-center rounded-lg border border-line bg-panel/85 p-0.5 backdrop-blur-md">
            <Ctl label="Zoom out" onClick={() => zoomAt((box.current?.clientWidth ?? 0) / 2, (box.current?.clientHeight ?? 0) / 2, 1 / 1.2)}><Minus className="size-3.5" /></Ctl>
            <Ctl label="Zoom in" onClick={() => zoomAt((box.current?.clientWidth ?? 0) / 2, (box.current?.clientHeight ?? 0) / 2, 1.2)}><Plus className="size-3.5" /></Ctl>
            <Ctl
              label="Fit"
              onClick={() => {
                touched.current = false;
                fit();
              }}
            >
              <Maximize2 className="size-3.5" />
            </Ctl>
            <Ctl
              label="Reset layout"
              onClick={() => {
                touched.current = false;
                setPos(base);
                save({});
                fit(base);
              }}
            >
              <Undo2 className="size-3.5" />
            </Ctl>
          </div>
        </div>

        <Legend />
        <div className="pointer-events-none absolute bottom-3 right-4 hidden font-mono text-[11px] text-fg-3 sm:block">
          {touch ? "drag to pan · pinch to zoom" : "drag to pan · pinch or ⌘ scroll to zoom · click to open"}
        </div>

        <AnimatePresence>
          {tip && (
            <motion.div key="tip" initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0, transition: enter }} exit={{ opacity: 0, transition: exit }} className="pointer-events-none absolute left-3 top-3 max-w-xs rounded-xl border border-line bg-panel/95 px-3 py-2.5 text-xs shadow-float backdrop-blur-md">
              <div className="font-medium text-fg">
                {byId.get(tip.from)?.label} <span className="text-fg-3">→</span> {byId.get(tip.to)?.label}
              </div>
              <div className="mt-0.5 text-fg-2">{tip.label}</div>
              <div className="mt-1.5 flex flex-wrap gap-x-2.5 font-mono text-[11.5px] text-fg-3">
                <span>{KIND_LABEL[tip.kind]}</span>
                <span className={edgeStatus(byId.get(tip.from), byId.get(tip.to)) === "broken" ? "text-down" : undefined}>{STATUS_TEXT[edgeStatus(byId.get(tip.from), byId.get(tip.to))]}</span>
                <span>{tip.rate ? `${tip.rate.value.toLocaleString()} ${tip.rate.unit}` : "no traffic metric"}</span>
              </div>
              <div className="mt-1 text-[11px] text-fg-3">documented in {tip.source}</div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <AnimatePresence>
        {ext && (
          <motion.div
            initial={{ opacity: 0, scale: 0.97, y: 6 }}
            animate={{ opacity: 1, scale: 1, y: 0, transition: enter }}
            exit={{ opacity: 0, scale: 0.985, transition: exit }}
            className="absolute left-1/2 top-1/2 z-20 w-[min(20rem,calc(100%-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-line bg-panel p-4 shadow-float"
          >
            <div className="flex items-start justify-between gap-2">
              <div>
                <div className="text-[16px] font-semibold tracking-[-0.01em]">{ext.label}</div>
                <div className="font-mono text-[12px] text-fg-3">{ext.sub}</div>
              </div>
              <button className="press -m-1 grid size-8 place-items-center rounded-lg text-fg-3 hover:bg-panel-3 hover:text-fg" onClick={() => setExt(null)} aria-label="Close"><X className="size-4" /></button>
            </div>
            <p className="mt-2 text-[14px] leading-relaxed text-fg-2">{ext.note}</p>
            <ul className="mt-3 space-y-1.5 border-t border-line pt-3 text-xs">
              {edges.filter((e) => e.from === ext.id || e.to === ext.id).map((e) => (
                <li key={e.id} className="flex gap-2 text-fg-2">
                  <span className="font-mono text-fg-3">{e.from === ext.id ? "→" : "←"}</span>
                  <span>{e.from === ext.id ? byId.get(e.to)?.label : byId.get(e.from)?.label} · {e.label}</span>
                </li>
              ))}
            </ul>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
});

function Ctl({ label, onClick, children }: { label: string; onClick(): void; children: ReactNode }) {
  return (
    <button onClick={onClick} aria-label={label} title={label} className="press grid size-7 place-items-center rounded-md text-fg-3 hover:bg-panel-3 hover:text-fg pointer-coarse:size-9">
      {children}
    </button>
  );
}

type LineProps = { e: TopoEdge; from?: { x: number; y: number }; to?: { x: number; y: number }; via?: number; status: EdgeStatus; offset: number; dim: boolean; hot: boolean; quiet: boolean };
const HAIRLINE = "calc(1px / clamp(0.55, var(--z), 1.6))"; // one screen pixel, whatever the zoom
const dimStyle = (dim: boolean): CSSProperties => ({ opacity: dim ? 0.18 : 1, transition: "opacity .32s var(--ease-out-soft)" });

const Edge = memo(function Edge({ e, from, to, via, status, offset, dim, hot, still, onHover }: Omit<LineProps, "quiet"> & { still: boolean; onHover(id: string | null): void }) {
  if (!from || !to) return null;
  const { d, end } = geometry(from, to, offset, via);
  const broken = status === "broken";
  // Each kind of connection in its own hue (HTTP blue, SQL violet, cache teal, streams pink); failing ones in red.
  const color = broken ? "var(--down)" : status === "idle" ? "var(--text-3)" : `var(--edge-${e.kind}, var(--text-3))`;
  const rest = broken ? 0.75 : status === "idle" ? 0.22 : 0.55;
  return (
    <g style={dimStyle(dim)} onPointerEnter={() => onHover(e.id)} onPointerLeave={() => onHover(null)}>
      <path d={d} fill="none" stroke="transparent" strokeWidth={14} />
      <path
        d={d}
        fill="none"
        stroke={color}
        strokeOpacity={hot ? 0.9 : rest}
        strokeLinecap="round"
        strokeDasharray={broken ? "3 4" : undefined}
        style={{ strokeWidth: hot ? `calc(${HAIRLINE} * 1.3)` : HAIRLINE, transition: "stroke-opacity .32s var(--ease-out-soft)" }}
      />
      {/* One soft highlight travels the path while its card is in focus. */}
      {hot && !broken && status !== "idle" && !still && (
        <path d={d} pathLength={1} fill="none" stroke={color} strokeLinecap="round" className="edge-pulse" style={{ strokeWidth: `calc(${HAIRLINE} * 2.4)`, strokeOpacity: 1 }} />
      )}
      <circle cx={end.x} cy={end.y} r={hot ? 2.6 : 2.1} fill={color} fillOpacity={hot ? 1 : Math.min(1, rest + 0.25)} />
    </g>
  );
});

// Rates as tiny mono text on the line; the hovered path gets a pill (with its description when there is no rate).
const EdgeLabel = memo(function EdgeLabel({ e, from, to, via, offset, dim, hot, quiet }: LineProps) {
  const label = e.rate ? `${e.rate.value.toLocaleString()}/min` : hot ? e.label : null;
  if (!from || !to || !label || quiet) return null;
  const { mid } = geometry(from, to, offset, via);
  return (
    <g transform={`translate(${mid.x},${mid.y})`} style={{ ...dimStyle(dim), fontSize: "calc(11px / clamp(0.8, var(--z), 1.6))" }}>
      {hot && <rect x={-(label.length * 0.31 + 0.7) + "em"} y="-0.95em" width={label.length * 0.62 + 1.4 + "em"} height="1.9em" rx="0.95em" fill="var(--panel)" stroke="var(--border-strong)" />}
      {/* A halo in the canvas colour lifts the text off the line without a box. */}
      <text textAnchor="middle" dominantBaseline="central" fill={hot ? "var(--text)" : "var(--text-3)"} fontFamily="var(--font-mono)" stroke={hot ? "none" : "var(--canvas)"} strokeWidth={4} paintOrder="stroke" strokeLinejoin="round">
        {label}
      </text>
    </g>
  );
});

const Node = memo(function Node({ n, r, x, y, dim, onDown, onOpen, onHover }: { n: TopoNode; r?: ResourceView; x: number; y: number; dim: boolean; onDown(e: ReactPointerEvent, id: string): void; onOpen(id: string): void; onHover(id: string | null): void }) {
  const Icon = KIND_ICON[n.kind];
  const external = n.kind === "external";
  const alert = !!n.state && n.state !== "UP";
  const meta = external ? "external · not monitored" : alert ? (r?.reasons[0] ?? STATE[n.state!].label) : r?.stats.slice(0, 2).map((s) => `${s.value} ${s.label}`).join(" · ");
  return (
    <motion.div
      onPointerDown={(e) => onDown(e, n.id)}
      role="button"
      tabIndex={0}
      aria-label={`${n.label}${n.state ? `, ${STATE[n.state].label}` : ""}`}
      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), onOpen(n.id))}
      onFocus={() => onHover(n.id)}
      onBlur={() => onHover(null)}
      onPointerEnter={(e) => e.pointerType === "mouse" && onHover(n.id)}
      onPointerLeave={(e) => e.pointerType === "mouse" && onHover(null)}
      initial={{ opacity: 0, scale: 0.97 }}
      animate={{ opacity: dim ? 0.34 : 1, scale: 1 }}
      transition={{ duration: 0.32, ease: EASE }}
      style={{ left: x - W / 2, top: y - H / 2, width: W, height: H, ...(n.state ? stateStyle(n.state) : {}), ...resourceHue(n.kind, n.sub) }}
      className={cx(
        "group absolute flex cursor-pointer flex-col justify-center overflow-hidden rounded-2xl border px-3 transition-[border-color,background-color] duration-200",
        external ? "border-dashed border-line-strong bg-transparent" : "border-line bg-panel shadow-card hover:border-line-strong",
        alert && "border-[color-mix(in_srgb,var(--dot)_45%,var(--border))]",
      )}
    >
      {/* Its kind's hue down the left edge. */}
      {!external && <span aria-hidden className="pointer-events-none absolute inset-y-0 left-0 w-[3px] bg-[var(--hue)] opacity-70" />}
      <div className="flex items-center gap-2">
        {n.state ? <StateDot state={n.state} className="!size-1.5" /> : <span className="size-1.5 flex-none rounded-full border border-line-strong" />}
        <span className={cx("min-w-0 flex-1 truncate text-[14.5px] font-medium tracking-[-0.01em]", external && "text-fg-2")}>{n.label}</span>
        <Icon className="hue-text size-3.5 flex-none" strokeWidth={1.7} />
      </div>
      <div className="truncate pl-3.5 font-mono text-[12px] leading-4 text-fg-3">{n.sub}</div>
      <div className={cx("truncate pl-3.5 text-[12px] leading-4", alert ? "text-[var(--dot)]" : "text-fg-3")}>{meta}</div>
    </motion.div>
  );
});

// A text key, folded away until asked for.
function Legend() {
  const [open, setOpen] = useState(false);
  const line = (style: CSSProperties) => <svg width="22" height="6" aria-hidden className="flex-none"><line x1="1" y1="3" x2="17" y2="3" strokeLinecap="round" style={style} /><circle cx="19.5" cy="3" r="2" fill={String(style.stroke)} opacity={Number(style.strokeOpacity ?? 1)} /></svg>;
  return (
    <div className="absolute bottom-3 left-3" onPointerDown={(e) => e.stopPropagation()}>
      <AnimatePresence>
        {open && (
          <motion.ul {...popover} style={{ originY: 1, originX: 0 }} className="mb-2 w-60 space-y-2 rounded-xl border border-line bg-panel/95 p-3 text-[12px] text-fg-2 shadow-float backdrop-blur-md">
            <li className="flex items-center gap-2.5">{line({ stroke: "var(--edge-http)", strokeWidth: 1.2 })} HTTP · the dot marks the callee</li>
            <li className="flex items-center gap-2.5">{line({ stroke: "var(--edge-sql)", strokeWidth: 1.2 })} SQL</li>
            <li className="flex items-center gap-2.5">{line({ stroke: "var(--edge-cache)", strokeWidth: 1.2 })} cache</li>
            <li className="flex items-center gap-2.5">{line({ stroke: "var(--edge-stream)", strokeWidth: 1.2 })} stream · events</li>
            <li className="flex items-center gap-2.5">{line({ stroke: "var(--edge-api)", strokeWidth: 1.2 })} external API</li>
            <li className="flex items-center gap-2.5">{line({ stroke: "var(--down)", strokeWidth: 1, strokeDasharray: "3 3" })} <span className="text-down">target failing</span></li>
            <li className="flex items-center gap-2.5">{line({ stroke: "var(--text-3)", strokeOpacity: 0.3, strokeWidth: 1 })} idle: one end is stopped</li>
            <li className="text-fg-3">Hover or focus a card to trace its paths. Labels are requests per minute.</li>
          </motion.ul>
        )}
      </AnimatePresence>
      <button onClick={() => setOpen((v) => !v)} aria-expanded={open} className="press flex h-7 items-center gap-1 rounded-lg px-2 text-[12px] font-medium text-fg-3 hover:bg-panel-3 hover:text-fg-2 pointer-coarse:h-9">
        Key <ChevronDown className={cx("size-3 transition-transform duration-300", open && "rotate-180")} />
      </button>
    </div>
  );
}
