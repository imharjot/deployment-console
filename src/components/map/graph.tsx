"use client";
// The cloud map canvas: one pannable, zoomable plane of resource nodes in lanes and columns (src/lib/inventory/
// layout.ts), joined by hairline edges. Interaction follows the ECS service map (overview/topology.tsx): drag or
// scroll to pan, pinch or ⌘/Ctrl-scroll to zoom, Fit, auto-fit until the person takes over.
//
// Built for thousands of nodes:
// - The layout is computed by the page from filters only; hover and focus never re-lay anything out.
// - Pan and zoom live in a viewport store (./viewport.ts), outside React (F47): every frame of a gesture moves the
//   plane and the screen-space labels through refs, and React re-renders only when the gesture ends.
// - Only nodes and edges inside a window around the viewport are rendered (the screen plus a screen of margin on every
//   side); a pan that stays inside it re-renders nothing.
// - Level of detail follows the settled zoom (see chips.tsx), bucketed in steps of 20%.
// - Spotlight is CSS: the canvas carries data-spot, nodes and edges on the focused paths carry data-hot, so a hover
//   re-renders only the few items whose "hot" flag changed. No opacity transitions (F46).
// - Dense maps (more than 400 connections) draw only the connections of the hovered, focused, open or matching
//   resources until "Show all" is on (ux-map-admin-9 c).
// Keyboard: Tab / Shift+Tab walk the nodes in reading order (the plane pans to follow), arrow keys move to a
// neighbour (a connected node in that direction first), Enter opens, + / − zoom, 0 fits.
import { AnimatePresence, animate, motion, useReducedMotion } from "motion/react";
import { ChevronDown, ChevronsDownUp, Lock, Maximize2, Minus, Plus, Spline, X } from "lucide-react";
import { memo, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type Ref } from "react";
import { LANE_HEAD, adjacencyOf, intersects, neighbourInDirection, type Box, type Layout, type LayoutEdge, type LayoutNode } from "@/lib/inventory/layout";
import { KIND_INFO, kindLabelOf, type Edge, type Health, type Resource } from "@/lib/inventory/types";
import { EASE, enter, exit, popover, useMediaQuery } from "../motion";
import { cx } from "../ui";
import { FULL_NAME_CHARS, NodeChip, REMOTE_TEXT, isRemote, nodeTitle, type ChipHandlers, type GroupInfo, type Lod } from "./chips";
import { CONFIDENCE, EDGE_FAMILY, EDGE_LABEL, FAMILY, HEALTH, isProblem, kindPlural, routingText } from "./kinds";
import { covers, createViewport, renderWindow, type View, type Viewport } from "./viewport";

const Z_MAX = 2;
const Z_MIN = 0.3;
const FIT_PAD = 20;
const LOD_FULL = 0.72; // at or above: full chips
const LOD_MID = 0.3; // at or above: names only; below: icons only
const BUCKET = 1.2;
export const DENSE_EDGES = 400; // above this many connections, draw only those of the resources in focus

export interface GraphHandle {
  // Pans (and zooms in to at least minZoom) so the node sits in the middle of the canvas minus `right` px (a sheet).
  centerOn(id: string, opts?: { minZoom?: number; right?: number }): void;
  focusNode(id: string): void;
  fit(): void;
}

export interface GraphProps {
  layout: Layout;
  byKey: ReadonlyMap<string, Resource>;
  edgeById: ReadonlyMap<string, Edge>;
  matches: ReadonlySet<string> | null;
  context: ReadonlySet<string>;
  selected: string | null; // node id
  lanes: boolean;
  envMeta: Record<string, { label: string; protected: boolean }>;
  fitKey: string; // changes → fit again (a new filter), unless the person moved the map since
  phone?: boolean; // F23: fit to a readable zoom, anchored on the first problem
  alarmed?: ReadonlySet<string>; // resource keys a non-scaling alarm in ALARM watches
  showAllEdges?: boolean; // dense maps: draw every connection anyway
  onShowAllEdges?(v: boolean): void;
  onActivate(n: LayoutNode): void;
  onCollapse(groupId: string): void;
  onCollapseParent?(key: string): void;
  ref?: Ref<GraphHandle>;
}

type Win = Box & { z: number };
type Gesture = { kind: "pan"; sx: number; sy: number; ox: number; oy: number; moved: boolean; onBg: boolean } | { kind: "pinch"; d0: number; mx: number; my: number; v0: View };

const push = <K, V>(m: Map<K, V[]>, k: K, v: V) => {
  const a = m.get(k);
  if (a) a.push(v);
  else m.set(k, [v]);
};

// Runs `f` on every frame the view changes, with the latest `f` (it may close over fresh props).
function useFrame(vp: Viewport, f: (v: View) => void) {
  const ref = useRef(f);
  useLayoutEffect(() => {
    ref.current = f;
    f(vp.get()); // place for this render's props straight away
  });
  useLayoutEffect(() => vp.onFrame((v) => ref.current(v)), [vp]);
}

export const Graph = memo(function Graph({ layout, byKey, edgeById, matches, context, selected, lanes, envMeta, fitKey, phone = false, alarmed, showAllEdges = false, onShowAllEdges, onActivate, onCollapse, onCollapseParent, ref }: GraphProps) {
  const box = useRef<HTMLDivElement>(null);
  const plane = useRef<HTMLDivElement>(null);
  const [vp] = useState(() => createViewport({ x: 0, y: 0, z: 0.5 }));
  const [settled, setSettled] = useState<View>(() => vp.get()); // the view React renders for (LOD, culling)
  const [size, setSize] = useState({ w: 0, h: 0 });
  // The rendered window (plane units) and the zoom it was made for; `winRef` is ahead of React between commits.
  const [win, setWinState] = useState<Win>({ x0: -1e9, y0: -1e9, x1: 1e9, y1: 1e9, z: 0 });
  const winRef = useRef(win);
  const moveWin = useCallback((v: View, s: { w: number; h: number }) => {
    const w = { ...renderWindow(v, s), z: v.z };
    winRef.current = w;
    setWinState(w);
  }, []);
  const [hover, setHover] = useState<string | null>(null);
  const [kbd, setKbd] = useState<string | null>(null); // node with keyboard focus
  const [keep, setKeep] = useState<string | null>(null); // last focused node: stays rendered when panned away
  const [hoverEdge, setHoverEdge] = useState<string | null>(null);
  const [selEdge, setSelEdge] = useState<string | null>(null);
  const still = useReducedMotion() ?? false;
  const touch = useMediaQuery("(pointer: coarse)");
  const portrait = layout.orientation === "portrait";

  const adjacency = useMemo(() => adjacencyOf(layout), [layout]);
  const edgesOf = useMemo(() => {
    const m = new Map<string, LayoutEdge[]>();
    for (const e of layout.edges) {
      push(m, e.from, e);
      push(m, e.to, e);
    }
    return m;
  }, [layout]);
  const edgeByLayoutId = useMemo(() => new Map(layout.edges.map((e) => [e.id, e])), [layout]);
  const groupInfo = useMemo(() => {
    const m = new Map<string, GroupInfo>();
    for (const n of layout.nodes) {
      if (n.type !== "group") continue;
      let worst: Health = "ok";
      let problems = 0, idle = 0, notes = 0;
      for (const k of n.members ?? []) {
        const r = byKey.get(k);
        if (!r) continue;
        if (HEALTH[r.health].rank < HEALTH[worst].rank) worst = r.health;
        if (isProblem(r.health)) problems++;
        if (r.idle) idle++;
        notes += r.notes ?? 0;
      }
      m.set(n.id, { worst, problems, idle, notes });
    }
    return m;
  }, [layout, byKey]);
  // F41: same display name twice in one lane → the chips add the kind's short name.
  const dupes = useMemo(() => {
    const seen = new Map<string, number>();
    for (const n of layout.nodes) if (n.key) {
      const k = `${n.lane}\u0000${byKey.get(n.key)?.name ?? n.key}`;
      seen.set(k, (seen.get(k) ?? 0) + 1);
    }
    const out = new Set<string>();
    for (const n of layout.nodes) if (n.key && (seen.get(`${n.lane}\u0000${byKey.get(n.key)?.name ?? n.key}`) ?? 0) > 1) out.add(n.id);
    return out;
  }, [layout, byKey]);
  const firstProblem = useMemo(() => layout.nodes.find((n) => (n.key ? isProblem(byKey.get(n.key)?.health ?? "ok") : (groupInfo.get(n.id)?.problems ?? 0) > 0)), [layout, byKey, groupInfo]);

  // Handlers read the latest state through a ref, so they (and the memoised chips) stay stable. A layout effect,
  // declared first, so the fits below already see this render's layout and size.
  const live = useRef({ size, layout, adjacency, onActivate, selEdge, still, phone, firstProblem });
  useLayoutEffect(() => {
    live.current = { size, layout, adjacency, onActivate, selEdge, still, phone, firstProblem };
  });
  const touched = useRef(false); // the person panned/zoomed: no more automatic fits until Fit or a new filter
  const anim = useRef<{ stop(): void } | null>(null);
  const els = useRef(new Map<string, HTMLElement>());
  const pendingFocus = useRef<string | null>(null);
  const gesture = useRef<Gesture | null>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());

  // ---------- the viewport: frames move the plane, commits re-render ----------
  useEffect(() => () => vp.dispose(), [vp]);
  useLayoutEffect(
    () =>
      vp.onCommit((v) => {
        setSettled(v);
        const s = live.current.size;
        // A new zoom changes what the window holds at this detail; a pan only matters once it leaves the window.
        if (s.w && (v.z !== winRef.current.z || !covers(winRef.current, v, s))) moveWin(v, s);
      }),
    [vp, moveWin],
  );
  useFrame(vp, (v) => {
    const el = plane.current;
    if (el) el.style.transform = `translate3d(${v.x}px, ${v.y}px, 0) scale(${v.z})`;
    // A pan that leaves the rendered window brings the next one in (rare: the window is three screens wide).
    const s = live.current.size;
    if (s.w && !covers(winRef.current, v, s)) moveWin(v, s);
  });

  // ---------- view ----------
  const fitZ = useCallback((l: Layout, s: { w: number; h: number }) => {
    const b = l.bounds;
    return Math.min(1, (s.w - FIT_PAD * 2) / Math.max(1, b.x1 - b.x0), (s.h - FIT_PAD * 2) / Math.max(1, b.y1 - b.y0));
  }, []);
  const fitView = useCallback(
    (l: Layout, s: { w: number; h: number }): View | null => {
      if (!s.w || !s.h) return null;
      const b = l.bounds;
      const bw = Math.max(1, b.x1 - b.x0), bh = Math.max(1, b.y1 - b.y0);
      const z = fitZ(l, s);
      if (!live.current.phone || z >= LOD_MID) return { z, x: (s.w - bw * z) / 2 - b.x0 * z, y: (s.h - bh * z) / 2 - b.y0 * z };
      // F23: a phone gets a readable first view (names, not icons), anchored on the first problem or the top-left.
      const zr = LOD_MID * 1.1; // just inside the names-only level once bucketed
      const p = live.current.firstProblem;
      const left = FIT_PAD - b.x0 * zr, top = FIT_PAD + 24 - b.y0 * zr;
      if (!p) return { z: zr, x: left, y: top };
      return { z: zr, x: Math.min(left, s.w / 2 - (p.x + p.w / 2) * zr), y: Math.min(top, s.h / 3 - (p.y + p.h / 2) * zr) };
    },
    [fitZ],
  );
  const minZoom = useCallback(() => Math.min(Z_MIN, live.current.size.w ? fitZ(live.current.layout, live.current.size) : Z_MIN), [fitZ]);
  const goTo = useCallback(
    (target: View) => {
      anim.current?.stop();
      if (live.current.still) return vp.set(target, { commit: true });
      const from = vp.get();
      anim.current = animate(0, 1, {
        duration: 0.42,
        ease: EASE,
        onUpdate: (t) => vp.set({ x: from.x + (target.x - from.x) * t, y: from.y + (target.y - from.y) * t, z: from.z + (target.z - from.z) * t }),
        onComplete: () => vp.commit(),
      });
    },
    [vp],
  );
  const fit = useCallback(
    (smooth = false) => {
      const v = fitView(live.current.layout, live.current.size);
      if (!v) return;
      if (smooth) goTo(v);
      else {
        anim.current?.stop();
        vp.set(v, { commit: true }); // an instant fit renders at its final detail straight away
      }
    },
    [fitView, goTo, vp],
  );

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      const next = { w: r.width, h: r.height };
      setSize((s) => (s.w === next.w && s.h === next.h ? s : next));
      if (next.w) moveWin(vp.get(), next);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [vp, moveWin]);
  // Automatic fits: a new filter set (fitKey) starts fresh; otherwise refit on resize / new layout until touched.
  useLayoutEffect(() => {
    touched.current = false;
  }, [fitKey]);
  useLayoutEffect(() => {
    if (!touched.current) fit();
  }, [fit, fitKey, layout, size.w, size.h]);

  const zoomAt = useCallback(
    (cx: number, cy: number, factor: number, commit = true) => {
      touched.current = true;
      anim.current?.stop();
      const lo = minZoom();
      vp.update((v) => {
        const z = Math.min(Z_MAX, Math.max(lo, v.z * factor));
        return { z, x: cx - ((cx - v.x) * z) / v.z, y: cy - ((cy - v.y) * z) / v.z };
      });
      if (commit) vp.commit();
      else vp.commitSoon(150);
    },
    [minZoom, vp],
  );
  const zoomCenter = useCallback((f: number) => zoomAt(live.current.size.w / 2, live.current.size.h / 2, f), [zoomAt]);

  // Bring a node into view with the least movement (it is already visible → nothing happens).
  const ensureVisible = useCallback(
    (id: string) => {
      const n = live.current.layout.nodeById.get(id);
      const { size: s } = live.current;
      const v = vp.get();
      if (!n || !s.w) return;
      const m = Math.min(56, s.w / 6);
      const x0 = n.x * v.z + v.x, y0 = n.y * v.z + v.y, x1 = x0 + n.w * v.z, y1 = y0 + n.h * v.z;
      let dx = 0, dy = 0;
      if (x0 < m) dx = m - x0;
      else if (x1 > s.w - m) dx = s.w - m - x1;
      if (y0 < m + 24) dy = m + 24 - y0;
      else if (y1 > s.h - m) dy = s.h - m - y1;
      if (dx || dy) {
        touched.current = true;
        goTo({ ...v, x: v.x + dx, y: v.y + dy });
      }
    },
    [goTo, vp],
  );

  const moveFocus = useCallback(
    (id: string) => {
      setKeep(id);
      ensureVisible(id);
      const el = els.current.get(id);
      if (el) el.focus({ preventScroll: true });
      else pendingFocus.current = id;
    },
    [ensureVisible],
  );
  // A node that wasn't rendered when focus moved to it gets focus once it is.
  useLayoutEffect(() => {
    const id = pendingFocus.current;
    if (!id) return;
    const el = els.current.get(id);
    if (el) {
      pendingFocus.current = null;
      el.focus({ preventScroll: true });
    }
  });

  useImperativeHandle(
    ref,
    () => ({
      centerOn(id, opts) {
        const n = live.current.layout.nodeById.get(id);
        const { size: s } = live.current;
        const v = vp.get();
        if (!n || !s.w) return;
        touched.current = true;
        const z = Math.min(Z_MAX, Math.max(v.z, opts?.minZoom ?? 0.8));
        const w = Math.max(160, s.w - (opts?.right ?? 0));
        goTo({ z, x: w / 2 - (n.x + n.w / 2) * z, y: s.h / 2 - (n.y + n.h / 2) * z });
        setKeep(id);
      },
      focusNode: moveFocus,
      fit() {
        touched.current = false;
        fit(true);
      },
    }),
    [fit, goTo, moveFocus, vp],
  );

  // ---------- pointer & wheel ----------
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if ((e.target as Element).closest?.("[data-overlay]")) return;
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        const r = el.getBoundingClientRect();
        zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.01), false);
      } else {
        touched.current = true;
        anim.current?.stop();
        vp.update((v) => ({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY }));
        vp.commitSoon(150); // a wheel stream has no end event
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomAt, vp]);

  const setGrab = (on: boolean) => {
    if (box.current) box.current.style.cursor = on ? "grabbing" : "grab"; // no React render while panning
  };
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    const t = e.target as Element;
    if (t.closest("[data-overlay]")) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    anim.current?.stop();
    if (pointers.current.size === 2) {
      // A second finger turns the drag into a pinch around the fingers' midpoint.
      const [a, b] = [...pointers.current.values()];
      const r = box.current!.getBoundingClientRect();
      for (const id of pointers.current.keys()) {
        try {
          box.current!.setPointerCapture(id);
        } catch {
          /* pointer already gone */
        }
      }
      gesture.current = { kind: "pinch", d0: Math.hypot(b.x - a.x, b.y - a.y) || 1, mx: (a.x + b.x) / 2 - r.left, my: (a.y + b.y) / 2 - r.top, v0: vp.get() };
      touched.current = true;
      return;
    }
    if (pointers.current.size > 2) return;
    const v = vp.get();
    gesture.current = { kind: "pan", sx: e.clientX, sy: e.clientY, ox: v.x, oy: v.y, moved: false, onBg: !t.closest("[data-node],[data-edge]") };
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const g = gesture.current;
    if (!g) return;
    if (g.kind === "pinch") {
      const [a, b] = [...pointers.current.values()];
      if (!a || !b) return;
      const r = box.current!.getBoundingClientRect();
      const mx = (a.x + b.x) / 2 - r.left, my = (a.y + b.y) / 2 - r.top;
      const z = Math.min(Z_MAX, Math.max(minZoom(), (g.v0.z * Math.hypot(b.x - a.x, b.y - a.y)) / g.d0));
      const px = (g.mx - g.v0.x) / g.v0.z, py = (g.my - g.v0.y) / g.v0.z;
      vp.set({ z, x: mx - px * z, y: my - py * z });
      return;
    }
    const dx = e.clientX - g.sx, dy = e.clientY - g.sy;
    if (!g.moved && Math.abs(dx) + Math.abs(dy) > 5) {
      // Only a real drag captures the pointer: a plain click still reaches the node or edge under it.
      g.moved = touched.current = true;
      try {
        box.current!.setPointerCapture(e.pointerId);
      } catch {
        /* synthetic pointer */
      }
      setGrab(true);
      setHover(null);
      setHoverEdge(null);
    }
    if (g.moved) vp.set({ ...vp.get(), x: g.ox + dx, y: g.oy + dy });
  };
  const onPointerEnd = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!pointers.current.delete(e.pointerId)) return;
    const g = gesture.current;
    if (g?.kind === "pinch") {
      // One finger stays down: carry on as a pan from where it is, so the plane never jumps.
      const rest = [...pointers.current.values()][0];
      const v = vp.get();
      gesture.current = rest ? { kind: "pan", sx: rest.x, sy: rest.y, ox: v.x, oy: v.y, moved: true, onBg: false } : null;
      if (!rest) {
        setGrab(false);
        vp.commit();
      }
      return;
    }
    gesture.current = null;
    setGrab(false);
    if (g?.moved) vp.commit();
    if (g && !g.moved && g.onBg && e.type === "pointerup") setSelEdge(null); // a click on empty canvas
  };

  // ---------- keyboard ----------
  const onKey = useCallback(
    (e: ReactKeyboardEvent, id: string) => {
      const { layout: l, adjacency: adj } = live.current;
      const n = l.nodeById.get(id);
      if (!n || e.altKey || e.metaKey || e.ctrlKey) return;
      let to: string | undefined;
      switch (e.key) {
        case "Tab": {
          const next = l.nodes[n.order + (e.shiftKey ? -1 : 1)];
          if (!next) return; // leave the map naturally
          to = next.id;
          break;
        }
        case "ArrowRight":
          to = neighbourInDirection(l, id, "right", adj);
          break;
        case "ArrowLeft":
          to = neighbourInDirection(l, id, "left", adj);
          break;
        case "ArrowUp":
          to = neighbourInDirection(l, id, "up", adj);
          break;
        case "ArrowDown":
          to = neighbourInDirection(l, id, "down", adj);
          break;
        case "Home":
          to = l.nodes[0]?.id;
          break;
        case "End":
          to = l.nodes[l.nodes.length - 1]?.id;
          break;
        case "+":
        case "=":
          e.preventDefault();
          zoomCenter(1.25);
          return;
        case "-":
        case "_":
          e.preventDefault();
          zoomCenter(0.8);
          return;
        case "0":
          e.preventDefault();
          touched.current = false;
          fit(true);
          return;
        case "Escape":
          // F22: one Escape closes one thing — the pinned connection first; the panel only sees it otherwise.
          if (!e.defaultPrevented && live.current.selEdge) {
            e.preventDefault();
            setSelEdge(null);
          }
          return;
        default:
          return;
      }
      e.preventDefault();
      if (to && to !== id) moveFocus(to);
    },
    [fit, moveFocus, zoomCenter],
  );

  // A pinned connection is the innermost thing open beside the panel: its Escape listens in the capture phase, so it
  // closes first and the panel (which skips a used key) stays. A modal dialog above the map keeps the key for itself.
  useEffect(() => {
    if (!selEdge) return;
    const k = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || document.querySelector("[role=dialog][aria-modal]")) return;
      e.preventDefault();
      setSelEdge(null);
    };
    window.addEventListener("keydown", k, true);
    return () => window.removeEventListener("keydown", k, true);
  }, [selEdge]);

  const handlers = useMemo<ChipHandlers>(
    () => ({
      onActivate: (id) => {
        const n = live.current.layout.nodeById.get(id);
        if (n) live.current.onActivate(n);
      },
      onKey,
      onFocus: (id) => {
        setKbd(id);
        setKeep(id);
        ensureVisible(id);
      },
      onBlur: (id) => setKbd((k) => (k === id ? null : k)),
      onHover: setHover,
      register: (id, el) => {
        if (el) els.current.set(id, el);
        else els.current.delete(id);
      },
    }),
    [onKey, ensureVisible],
  );

  // ---------- culling & level of detail (from the settled view) ----------
  const zb = Math.round(Math.log(settled.z) / Math.log(BUCKET));
  const zq = Math.pow(BUCKET, zb);
  const lod: Lod = zq >= LOD_FULL - 1e-6 ? "full" : zq >= LOD_MID - 1e-6 ? "mid" : "mini";
  const visibleNodes = useMemo(() => {
    const out = layout.nodes.filter((n) => intersects({ x0: n.x, y0: n.y, x1: n.x + n.w, y1: n.y + n.h }, win));
    const forced = [keep, selected].filter((id): id is string => !!id && layout.nodeById.has(id) && !out.some((n) => n.id === id));
    if (!forced.length) return out;
    return [...out, ...forced.map((id) => layout.nodeById.get(id)!)].sort((a, b) => a.order - b.order);
  }, [layout, win, keep, selected]);
  const windowEdges = useMemo(() => layout.edges.filter((e) => intersects(e.box, win)), [layout, win]);
  const supportOn = useMemo(() => layout.edges.some((e) => EDGE_FAMILY[e.kind] === "support"), [layout]);

  // ---------- dense maps: only the connections of what is in focus (9 c) ----------
  const dense = layout.edges.length > DENSE_EDGES;
  const focusNodes = useMemo(() => {
    if (!dense || showAllEdges) return null;
    const s = new Set<string>();
    for (const id of [hover, kbd, selected]) if (id) s.add(id);
    if (matches) for (const k of matches) {
      const n = layout.nodeOf.get(k);
      if (n) s.add(n);
    }
    return s;
  }, [dense, showAllEdges, hover, kbd, selected, matches, layout]);
  const visibleEdges = useMemo(() => (focusNodes ? windowEdges.filter((e) => focusNodes.has(e.from) || focusNodes.has(e.to)) : windowEdges), [windowEdges, focusNodes]);

  // R15: routing labels ("weighted 50", "failover primary") and pass-through labels ("via acme-pg-proxy") on lines.
  const edgeLabels = useMemo(() => {
    const m = new Map<string, string>();
    for (const e of layout.edges) {
      const parts: string[] = [];
      for (const id of e.edgeIds) {
        const x = edgeById.get(id);
        const rt = routingText(x?.routing);
        if (rt && !parts.includes(rt)) parts.push(rt);
        if (x?.label?.startsWith("via ") && !parts.includes(x.label)) parts.push(x.label);
      }
      if (parts.length) m.set(e.id, parts.slice(0, 2).join(" · "));
    }
    return m;
  }, [layout, edgeById]);

  // ---------- spotlight ----------
  const edgeSpot = selEdge ?? hoverEdge;
  // F22: with nothing hovered or focused, the open resource keeps its paths lit.
  const spot = edgeSpot ? null : (hover ?? kbd ?? selected);
  const { hotNodes, hotEdges } = useMemo(() => {
    if (edgeSpot) {
      const e = edgeByLayoutId.get(edgeSpot);
      return { hotNodes: e ? new Set([e.from, e.to]) : null, hotEdges: new Set([edgeSpot]) };
    }
    if (!spot) return { hotNodes: null, hotEdges: null };
    const nodes = new Set([spot, ...(adjacency.get(spot) ?? [])]);
    return { hotNodes: nodes, hotEdges: new Set((edgesOf.get(spot) ?? []).map((e) => e.id)) };
  }, [edgeSpot, spot, edgeByLayoutId, adjacency, edgesOf]);

  const envLabel = useCallback((env?: string) => (env ? (envMeta[env]?.label ?? env) : "Shared"), [envMeta]);
  const tip = edgeSpot ? edgeByLayoutId.get(edgeSpot) : undefined;
  const expandedGroups = layout.groups.filter((g) => g.expanded);
  const pointed = hover ?? kbd;
  const pointedNode = pointed ? layout.nodeById.get(pointed) : undefined;
  const pointedRes = pointedNode?.key ? byKey.get(pointedNode.key) : undefined;
  // Below full detail the name is unreadable; at full detail it may be cut in the middle (F41): float it whole.
  const floating = pointedNode && (lod !== "full" || nodeTitle(pointedNode, pointedRes).length > FULL_NAME_CHARS || isRemote(pointedRes ?? {})) ? pointedNode : undefined;
  const zc = Math.min(zq, 1.6);

  return (
    <div
      ref={box}
      role="group"
      aria-roledescription="map"
      aria-label={`Cloud map: ${layout.nodes.length} nodes, ${layout.edges.length} connections. Tab moves between resources, arrow keys follow connections, Enter opens.`}
      data-spot={hotNodes ? "on" : undefined}
      className="group/map relative h-full touch-none select-none overflow-hidden bg-canvas"
      style={{ cursor: "grab" }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
      // Focusing a node outside the box must never scroll it (the plane moves by transform only).
      onScroll={(e) => {
        e.currentTarget.scrollLeft = 0;
        e.currentTarget.scrollTop = 0;
      }}
    >
      <div aria-hidden className="pointer-events-none absolute inset-0 bg-[radial-gradient(120%_90%_at_50%_45%,transparent_60%,color-mix(in_srgb,var(--text)_3.5%,transparent))]" />
      <div
        ref={plane}
        className="absolute left-0 top-0 origin-top-left will-change-transform"
        style={{ transform: `translate3d(${settled.x}px, ${settled.y}px, 0) scale(${settled.z})`, "--zc": zc, "--mid-font": `${Math.min(28, 11 / zq)}px` } as CSSProperties}
      >
        <Lanes layout={layout} />
        <svg className="absolute left-0 top-0 overflow-visible" width={1} height={1} aria-hidden>
          <EdgesLayer key={layout.edges.length + ":" + layout.bounds.x1 + ":" + layout.bounds.y1} edges={visibleEdges} hot={hotEdges} dots={lod !== "mini"} labels={lod === "mini" ? null : edgeLabels} viaLabels={lod === "full"} still={still} onHover={setHoverEdge} onSelect={setSelEdge} />
        </svg>
        <NodesLayer
          nodes={visibleNodes}
          byKey={byKey}
          groupInfo={groupInfo}
          lod={lod}
          hot={hotNodes}
          matches={matches}
          context={context}
          selected={selected}
          showEnv={!lanes || layout.laneBy !== "env"}
          envLabel={envLabel}
          dupes={dupes}
          alarmed={alarmed}
          laneNames={lanes && layout.laneBy === "env"}
          h={handlers}
        />
      </div>

      {portrait ? <BandHeads layout={layout} vp={vp} /> : <ColumnHeads layout={layout} vp={vp} width={size.w} />}
      {lanes && (portrait ? <LaneHeads layout={layout} vp={vp} width={size.w} envMeta={envMeta} /> : <LaneLabels layout={layout} vp={vp} size={size} envMeta={envMeta} />)}

      {floating && <FloatingLabel n={floating} r={floating.key ? byKey.get(floating.key) : undefined} vp={vp} />}

      {/* Overlays: controls, expanded groups, edge details, key. data-overlay keeps them out of pan gestures. */}
      <div data-overlay className="absolute right-3 top-3 flex items-center gap-2 max-sm:right-2 max-sm:top-2">
        <div className="flex items-center rounded-lg border border-line bg-panel/85 p-0.5 shadow-card backdrop-blur-md">
          <Ctl label="Zoom out (−)" onClick={() => zoomCenter(1 / 1.25)}><Minus className="size-3.5" /></Ctl>
          <Ctl label="Zoom in (+)" onClick={() => zoomCenter(1.25)}><Plus className="size-3.5" /></Ctl>
          <Ctl
            label="Fit the map (0)"
            onClick={() => {
              touched.current = false;
              fit(true);
            }}
          >
            <Maximize2 className="size-3.5" />
          </Ctl>
        </div>
      </div>

      <div data-overlay className="pointer-events-none absolute left-3 top-10 flex max-w-[min(24rem,calc(100%-7rem))] flex-col items-start gap-2 max-sm:left-2 max-sm:top-9">
        {(expandedGroups.length > 0 || layout.parents.length > 0) && (
          <div className="pointer-events-auto flex flex-wrap gap-1.5">
            {expandedGroups.map((g) => (
              <OverlayChip key={g.id} onClick={() => onCollapse(g.id)} title="Collapse into one node">
                <ChevronsDownUp className="size-3.5 text-fg-3" />
                {g.service ? `${g.count} ${g.service} resources` : kindPlural(g.kind, g.count)}
                <span className="text-fg-3">· {envLabel(g.lane.startsWith("__") ? undefined : g.lane)}</span>
              </OverlayChip>
            ))}
            {onCollapseParent &&
              layout.parents.map((p) => (
                <OverlayChip key={p.id} onClick={() => onCollapseParent(p.key)} title="Fold back into the parent">
                  <ChevronsDownUp className="size-3.5 text-fg-3" />
                  {p.count} inside {byKey.get(p.key)?.name ?? p.key}
                </OverlayChip>
              ))}
          </div>
        )}
        {dense && onShowAllEdges && (
          <div className="pointer-events-auto">
            <OverlayChip onClick={() => onShowAllEdges(!showAllEdges)} pressed={showAllEdges} title={showAllEdges ? "Draw only the connections of the resources in focus" : "Draw every connection (slower on a big map)"}>
              <Spline className="size-3.5 text-fg-3" />
              {showAllEdges ? "Show fewer connections" : `Show all ${layout.edges.length.toLocaleString()} connections`}
            </OverlayChip>
          </div>
        )}
        <AnimatePresence>
          {tip && <EdgeTip key={tip.id} e={tip} layout={layout} byKey={byKey} edgeById={edgeById} sticky={!!selEdge} onClose={() => setSelEdge(null)} />}
        </AnimatePresence>
      </div>

      <Legend support={supportOn} />
      <div className="pointer-events-none absolute bottom-3 right-4 hidden font-mono text-[11px] text-fg-3 lg:block">
        {dense && !showAllEdges ? "dense map: hover a resource to see its connections · " : ""}
        {touch ? "drag to pan · pinch to zoom · tap to open" : "drag to pan · ⌘ scroll to zoom · Tab / arrows to move · Enter to open"}
      </div>
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

function OverlayChip({ onClick, title, pressed, children }: { onClick(): void; title: string; pressed?: boolean; children: ReactNode }) {
  return (
    <button
      onClick={onClick}
      title={title}
      aria-pressed={pressed}
      className="press inline-flex h-7 items-center gap-1.5 rounded-lg border border-line bg-panel/90 px-2 text-[12.5px] text-fg-2 shadow-card backdrop-blur-md hover:border-line-strong hover:text-fg pointer-coarse:h-9"
    >
      {children}
    </button>
  );
}

// Lane wells, drawn once per layout (their labels are a screen-space overlay so they stay readable at any zoom).
const Lanes = memo(function Lanes({ layout }: { layout: Layout }) {
  return (
    <>
      {layout.lanes.map((l) =>
        l.label ? (
          <div
            key={l.id}
            aria-hidden
            className="pointer-events-none absolute left-0 top-0 rounded-3xl border border-line bg-panel-2/40"
            style={{ transform: `translate(${l.x}px, ${l.y}px)`, width: l.w, height: l.h, transition: "transform .45s var(--ease-out-soft), width .45s var(--ease-out-soft), height .45s var(--ease-out-soft)" }}
          />
        ) : null,
      )}
    </>
  );
});

// Screen-space labels follow the view through refs (no React render per frame): each list keeps its elements in a
// ref and `place` writes their positions.
function usePlaced<T>(items: readonly T[]) {
  void items; // one slot per item, written by the ref callbacks
  return useRef<(HTMLDivElement | null)[]>([]);
}
const show = (el: HTMLElement, on: boolean) => {
  el.style.visibility = on ? "" : "hidden";
};

// Landscape: column titles stick to the top edge.
function ColumnHeads({ layout, vp, width }: { layout: Layout; vp: Viewport; width: number }) {
  const refs = usePlaced(layout.columns);
  useFrame(vp, (v) => {
    const y = Math.max(8, (layout.headY + 6) * v.z + v.y);
    layout.columns.forEach((c, i) => {
      const el = refs.current[i];
      if (!el) return;
      const x = c.x * v.z + v.x;
      const next = layout.columns[i + 1];
      const w = (next ? next.x - c.x - 16 : c.w + 80) * v.z; // a label may use the gap up to the next column
      show(el, !(x + w < 0 || x > width || w < 64)); // too narrow to say anything useful
      el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
      el.style.maxWidth = `${w}px`;
    });
  });
  return (
    <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0">
      {layout.columns.map((c, i) => (
        <div key={c.category} ref={(el) => void (refs.current[i] = el)} className="absolute left-0 top-0">
          <div className="eyebrow flex items-center gap-1.5 truncate rounded bg-canvas/85 px-1 py-px" style={{ color: `var(--cat-${c.category}, var(--text-3))` }}>
            <span className="size-1.5 flex-none rounded-full bg-current" />
            {c.label}
          </div>
        </div>
      ))}
    </div>
  );
}

// Portrait: each category band's title sits in the gap above it, stuck to the left edge.
function BandHeads({ layout, vp }: { layout: Layout; vp: Viewport }) {
  const refs = usePlaced(layout.columns);
  useFrame(vp, (v) => {
    layout.columns.forEach((c, i) => {
      const el = refs.current[i];
      if (!el) return;
      const y = c.y * v.z + v.y - 22;
      show(el, y > -20);
      el.style.transform = `translate(10px, ${Math.round(y)}px)`;
    });
  });
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
      {layout.columns.map((c, i) => (
        <div key={c.category} ref={(el) => void (refs.current[i] = el)} className="absolute left-0 top-0">
          <div className="eyebrow flex items-center gap-1.5 whitespace-nowrap rounded bg-canvas/85 px-1 py-px" style={{ color: `var(--cat-${c.category}, var(--text-3))` }}>
            <span className="size-1.5 flex-none rounded-full bg-current" />
            {c.label}
          </div>
        </div>
      ))}
    </div>
  );
}

// Landscape: lane titles sit in the band at the top of their lane (F23: shrunk to fit it, hidden when it is too thin
// to hold a readable label), and stick under the column titles while the lane is scrolled past.
function LaneLabels({ layout, vp, size, envMeta }: { layout: Layout; vp: Viewport; size: { w: number; h: number }; envMeta: Record<string, { protected: boolean }> }) {
  const refs = usePlaced(layout.lanes);
  useFrame(vp, (v) => {
    const below = layout.columns.length ? Math.max(8, (layout.headY + 6) * v.z + v.y) + 22 : 8;
    const band = LANE_HEAD * v.z;
    const font = Math.max(9, Math.min(12, band - 4)); // shrinks to fit the band (F23)
    layout.lanes.forEach((l, i) => {
      const el = refs.current[i];
      if (!el || !l.label) return;
      const top = l.y * v.z + v.y, bottom = (l.y + l.h) * v.z + v.y;
      const stuck = top < below; // scrolled past: floats over the lane under the column titles
      show(el, !(bottom < 24 || top > size.h) && (band >= 10 || stuck)); // thinner than that: it would cover nodes
      const x = Math.max(10, (l.x + 16) * v.z + v.x);
      const y = Math.min(Math.max(top + Math.max(0, (band - font - 4) / 2), below), bottom - font - 10);
      el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
      el.style.fontSize = `${font}px`;
    });
  });
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
      {layout.lanes.map((l, i) =>
        l.label ? (
          <div key={l.id} ref={(el) => void (refs.current[i] = el)} className="absolute left-0 top-0 flex items-center gap-1.5 whitespace-nowrap rounded-md bg-canvas/85 px-1.5 py-px font-medium leading-tight text-fg-2">
            {envMeta[l.id]?.protected && <Lock className="size-3 text-down" strokeWidth={2} />}
            {l.label}
            <span className="font-normal tabular-nums text-fg-3">{l.count.toLocaleString()}</span>
          </div>
        ) : null,
      )}
    </div>
  );
}

// Portrait: lanes stand side by side; their titles stick to the top edge.
function LaneHeads({ layout, vp, width, envMeta }: { layout: Layout; vp: Viewport; width: number; envMeta: Record<string, { protected: boolean }> }) {
  const refs = usePlaced(layout.lanes);
  useFrame(vp, (v) => {
    layout.lanes.forEach((l, i) => {
      const el = refs.current[i];
      if (!el || !l.label) return;
      const x = Math.max(8, (l.x + 10) * v.z + v.x), right = (l.x + l.w) * v.z + v.x;
      show(el, right > 40 && x < width);
      el.style.transform = `translate(${Math.round(x)}px, ${Math.round(Math.max(6, l.y * v.z + v.y + 4))}px)`;
      el.style.maxWidth = `${Math.max(60, right - x - 8)}px`;
    });
  });
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
      {layout.lanes.map((l, i) =>
        l.label ? (
          <div key={l.id} ref={(el) => void (refs.current[i] = el)} className="absolute left-0 top-0 flex items-center gap-1.5 truncate whitespace-nowrap rounded-md bg-canvas/85 px-1.5 py-0.5 text-[13px] font-medium text-fg-2">
            {envMeta[l.id]?.protected && <Lock className="size-3 flex-none text-down" strokeWidth={2} />}
            <span className="truncate">{l.label}</span>
            <span className="font-normal tabular-nums text-fg-3">{l.count.toLocaleString()}</span>
          </div>
        ) : null,
      )}
    </div>
  );
}

// The hovered / focused node's name floats above it at a readable size (below full detail, or when cut short).
function FloatingLabel({ n, r, vp }: { n: LayoutNode; r?: Resource; vp: Viewport }) {
  const ref = useRef<HTMLDivElement>(null);
  useFrame(vp, (v) => {
    const el = ref.current;
    if (!el) return;
    el.style.transform = `translate(${Math.round((n.x + n.w / 2) * v.z + v.x)}px, ${Math.round(n.y * v.z + v.y - 6)}px)`;
  });
  return (
    <div ref={ref} aria-hidden className="pointer-events-none absolute left-0 top-0 z-10">
      <div className="max-w-[min(32rem,90vw)] -translate-x-1/2 -translate-y-full truncate rounded-lg border border-line bg-panel/95 px-2 py-1 text-[13px] font-medium text-fg shadow-float backdrop-blur-md">
        {nodeTitle(n, r)}
        <span className="ml-1.5 font-normal text-fg-3">{r ? kindLabelOf(r) : (KIND_INFO[n.kind]?.label ?? n.kind)}</span>
        {r && isRemote(r) ? (
          <span className="ml-1.5 font-normal text-fg-3">{REMOTE_TEXT}</span>
        ) : (
          r && r.health !== "ok" && r.healthReason && <span className="ml-1.5 font-normal" style={{ color: HEALTH[r.health].color }}>{r.healthReason}</span>
        )}
      </div>
    </div>
  );
}

const NodesLayer = memo(function NodesLayer({ nodes, byKey, groupInfo, lod, hot, matches, context, selected, showEnv, envLabel, dupes, alarmed, laneNames, h }: {
  nodes: LayoutNode[];
  byKey: ReadonlyMap<string, Resource>;
  groupInfo: Map<string, GroupInfo>;
  lod: Lod;
  hot: Set<string> | null;
  matches: ReadonlySet<string> | null;
  context: ReadonlySet<string>;
  selected: string | null;
  showEnv: boolean;
  envLabel(env?: string): string;
  dupes: ReadonlySet<string>;
  alarmed?: ReadonlySet<string>;
  laneNames: boolean;
  h: ChipHandlers;
}) {
  return (
    <>
      {nodes.map((n) => {
        const r = n.key ? byKey.get(n.key) : undefined;
        return (
          <NodeChip
            key={n.id}
            n={n}
            r={r}
            g={groupInfo.get(n.id)}
            lod={lod}
            hot={!!hot?.has(n.id)}
            match={!!n.key && !!matches?.has(n.key)}
            ctx={!!n.key && context.has(n.key)}
            selected={selected === n.id}
            showEnv={showEnv}
            envLabel={envLabel(r?.env ?? (laneNames && !n.lane.startsWith("__") ? n.lane : undefined))}
            lanes={laneNames}
            dupe={dupes.has(n.id)}
            alarm={!!n.key && !!alarmed?.has(n.key)}
            h={h}
          />
        );
      })}
    </>
  );
});

const EdgesLayer = memo(function EdgesLayer({ edges, hot, dots, labels, viaLabels, still, onHover, onSelect }: {
  edges: LayoutEdge[];
  hot: Set<string> | null;
  dots: boolean;
  labels: Map<string, string> | null;
  viaLabels: boolean;
  still: boolean;
  onHover(id: string | null): void;
  onSelect(id: string): void;
}) {
  return (
    // Appears just after the nodes start gliding to a new layout, instead of jumping ahead of them.
    <g className="fade-in" style={{ animationDelay: "120ms" }}>
      {edges.map((e) => {
        const text = labels?.get(e.id);
        const shown = text && (viaLabels || !text.startsWith("via ") || !!hot?.has(e.id)) ? text : undefined;
        return <EdgePath key={e.id} e={e} hot={!!hot?.has(e.id)} dot={dots} label={shown} still={still} onHover={onHover} onSelect={onSelect} />;
      })}
    </g>
  );
});

// Paint is what costs at scale: the wide hit area is never painted (pointer-events: stroke hit-tests the geometry
// whatever the stroke colour), and the arrival dot is left out when nodes are icons only. No opacity transition (F46).
const EdgePath = memo(function EdgePath({ e, hot, dot, label, still, onHover, onSelect }: { e: LayoutEdge; hot: boolean; dot: boolean; label?: string; still: boolean; onHover(id: string | null): void; onSelect(id: string): void }) {
  const family = FAMILY[EDGE_FAMILY[e.kind]];
  const color = hot ? family.color : "var(--text-3)";
  const dash = family.dash ?? CONFIDENCE[e.confidence].dash; // support links (roles, keys, logs…) are always dotted
  return (
    <g data-edge={e.id} data-hot={hot || undefined} className="group-data-[spot=on]/map:opacity-[0.1] data-[hot]:!opacity-100">
      <path
        d={e.path}
        fill="none"
        stroke="none"
        pointerEvents="stroke"
        style={{ strokeWidth: "calc(12px / var(--zc, 1))", cursor: "pointer" }}
        onPointerEnter={(ev) => ev.pointerType === "mouse" && onHover(e.id)}
        onPointerLeave={(ev) => ev.pointerType === "mouse" && onHover(null)}
        onClick={() => onSelect(e.id)}
      />
      <path
        d={e.path}
        fill="none"
        stroke={color}
        strokeOpacity={hot ? 0.95 : 0.45}
        strokeLinecap="round"
        pointerEvents="none"
        style={{ strokeWidth: hot ? "calc(1.6px / var(--zc, 1))" : "calc(1px / var(--zc, 1))", strokeDasharray: dash }}
      />
      {/* One soft highlight travels a spotlit path read from configuration. */}
      {hot && !still && !dash && <path d={e.path} pathLength={1} fill="none" stroke={color} strokeLinecap="round" pointerEvents="none" className="edge-pulse" style={{ strokeWidth: "calc(2.4px / var(--zc, 1))", strokeOpacity: 0.9 }} />}
      {(dot || hot) && <circle cx={e.end.x} cy={e.end.y} fill={color} fillOpacity={hot ? 1 : 0.6} pointerEvents="none" style={{ r: hot ? "calc(2.8px / var(--zc, 1))" : "calc(2.1px / var(--zc, 1))" } as CSSProperties} />}
      {label && (
        <text
          x={e.mid.x}
          y={e.mid.y}
          textAnchor="middle"
          dy="-0.4em"
          pointerEvents="none"
          className="fill-[var(--text-2)] font-mono [paint-order:stroke] [stroke:var(--canvas)] [stroke-linejoin:round]"
          style={{ fontSize: "calc(11.5px / var(--zc, 1))", strokeWidth: "calc(3px / var(--zc, 1))" }}
        >
          {label}
        </text>
      )}
    </g>
  );
});

function EdgeTip({ e, layout, byKey, edgeById, sticky, onClose }: { e: LayoutEdge; layout: Layout; byKey: ReadonlyMap<string, Resource>; edgeById: ReadonlyMap<string, Edge>; sticky: boolean; onClose(): void }) {
  const name = (id: string) => {
    const n = layout.nodeById.get(id);
    return n ? nodeTitle(n, n.key ? byKey.get(n.key) : undefined) : id;
  };
  const items = e.edgeIds.map((id) => edgeById.get(id)).filter((x): x is Edge => !!x);
  const shown = items.slice(0, 4);
  return (
    <motion.div
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0, transition: enter }}
      exit={{ opacity: 0, transition: exit }}
      role={sticky ? "dialog" : "tooltip"}
      aria-label="Connection"
      className={cx("w-[min(24rem,calc(100vw-3rem))] rounded-xl border border-line bg-panel/95 px-3 py-2.5 text-xs shadow-float backdrop-blur-md", sticky ? "pointer-events-auto" : "pointer-events-none")}
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1 font-medium text-fg [overflow-wrap:anywhere]">
          {name(e.from)} <span className="text-fg-3">→</span> {name(e.to)}
        </div>
        {sticky && (
          <button onClick={onClose} aria-label="Close connection details" className="press -m-1 grid size-6 flex-none place-items-center rounded-md text-fg-3 hover:bg-panel-3 hover:text-fg pointer-coarse:size-9">
            <X className="size-3.5" />
          </button>
        )}
      </div>
      <ul className="mt-1.5 space-y-2">
        {shown.map((x) => (
          <li key={x.id}>
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="font-medium" style={{ color: FAMILY[EDGE_FAMILY[x.kind]].color }}>{EDGE_LABEL[x.kind]}</span>
              {x.label && <span className="text-fg-2">{x.label}</span>}
              {routingText(x.routing) && <span className="rounded border border-line px-1 text-[11px] text-fg-2">{routingText(x.routing)}{x.routing?.setId ? ` · ${x.routing.setId}` : ""}</span>}
              <span className="rounded border border-line px-1 font-mono text-[11px] text-fg-3" title={CONFIDENCE[x.confidence].hint}>{CONFIDENCE[x.confidence].label}</span>
            </div>
            {x.evidence.length > 0 && (
              <ul className="mt-0.5 space-y-0.5 text-[12px] leading-snug text-fg-3">
                {x.evidence.slice(0, 3).map((ev) => (
                  <li key={ev} className="[overflow-wrap:anywhere]">· {ev}</li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
      {items.length > shown.length && <div className="mt-1.5 text-[12px] text-fg-3">+ {items.length - shown.length} more connections between these two</div>}
      {!sticky && <div className="mt-1.5 text-[11.5px] text-fg-3">Click the line to keep this open.</div>}
    </motion.div>
  );
}

// The key, folded away until asked for.
// The Support family is listed only while a support layer puts its links on the map.
function Legend({ support }: { support: boolean }) {
  const [open, setOpen] = useState(false);
  const line = (color: string, dash?: string, width = 1.4) => (
    <svg width="26" height="8" aria-hidden className="flex-none">
      <line x1="1" y1="4" x2="20" y2="4" stroke={color} strokeWidth={width} strokeLinecap="round" strokeDasharray={dash} />
      <circle cx="23" cy="4" r="2.2" fill={color} />
    </svg>
  );
  return (
    <div data-overlay className="absolute bottom-3 left-3 max-sm:bottom-2 max-sm:left-2">
      <AnimatePresence>
        {open && (
          <motion.div {...popover} style={{ originY: 1, originX: 0 }} className="mb-2 max-h-[min(70vh,34rem)] w-64 space-y-3 overflow-y-auto rounded-xl border border-line bg-panel/95 p-3 text-[12px] text-fg-2 shadow-float backdrop-blur-md">
            <div>
              <div className="eyebrow mb-1.5">Connections (tinted when in focus)</div>
              <ul className="space-y-1.5">
                {Object.entries(FAMILY).filter(([k]) => support || k !== "support").map(([k, f]) => (
                  <li key={k} className="flex items-center gap-2.5">
                    {line(f.color, f.dash && "1.5 3")}
                    <span>
                      {f.label} <span className="text-fg-3">· {f.kinds.map((x) => EDGE_LABEL[x].toLowerCase()).join(", ")}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <div className="eyebrow mb-1.5">How we know</div>
              <ul className="space-y-1.5">
                <li className="flex items-center gap-2.5">{line("var(--text-2)")} config: read from AWS configuration</li>
                <li className="flex items-center gap-2.5">{line("var(--text-2)", "4 3")} allowed: a security group or IAM policy</li>
                <li className="flex items-center gap-2.5">{line("var(--text-2)", "1 3")} mentioned: a setting names it</li>
                <li className="text-fg-3">“via …” on a line: it passes through a proxy, endpoint, NAT gateway or Cloud Map service. “weighted 50”, “failover primary”: DNS routing.</li>
              </ul>
            </div>
            <div>
              <div className="eyebrow mb-1.5">Nodes</div>
              <ul className="space-y-1">
                {(["error", "warning", "unknown", "stopped", "ok"] as const).map((h) => (
                  <li key={h} className="flex items-center gap-2.5">
                    <span className="dot !size-2" style={{ "--dot": HEALTH[h].color } as CSSProperties} />
                    {HEALTH[h].label}
                  </li>
                ))}
                <li className="flex items-center gap-2.5 text-fg-3">
                  <span className="rounded border border-line px-1 text-[11px]">idle</span> no activity over the idle window
                </li>
                <li className="flex items-center gap-2.5 text-fg-3">
                  <span className="h-3 w-5 flex-none rounded border border-dashed border-line-strong" /> referenced from another account or region, or not seen in the last read
                </li>
                <li className="text-fg-3">A ring marks a problem when names are too small to read. The dot at a line&apos;s end marks the side that receives.</li>
              </ul>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      <button onClick={() => setOpen((v) => !v)} aria-expanded={open} className="press flex h-7 items-center gap-1 rounded-lg border border-line bg-panel/85 px-2 text-[12px] font-medium text-fg-3 shadow-card backdrop-blur-md hover:text-fg-2 pointer-coarse:h-9">
        Key <ChevronDown className={cx("size-3 transition-transform duration-300", open && "rotate-180")} />
      </button>
    </div>
  );
}
