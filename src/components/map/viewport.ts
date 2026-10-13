// The map's pan and zoom, outside React (F47). Pointer moves, wheel steps and fit animations write the view here; one
// requestAnimationFrame per frame hands it to the frame listeners, which move the plane and the screen-space labels
// through refs. React hears about the view only when a gesture ends (`commit`): level of detail, culling and
// everything else that renders follow that settled view. So panning re-renders nothing.
//
// Pure (no React, no DOM): the scheduler is injectable, so tests drive frames by hand.
export interface View {
  x: number;
  y: number;
  z: number;
}

export interface Viewport {
  get(): View;
  // Moves the view; frame listeners run on the next frame. `commit: true` also tells React (a gesture's last step).
  set(v: View, opts?: { commit?: boolean }): void;
  update(f: (v: View) => View, opts?: { commit?: boolean }): void;
  commit(): void; // the gesture ended: React listeners get the current view (once per distinct view)
  commitSoon(ms?: number): void; // commit after `ms` without another change (wheel streams have no end event)
  onFrame(f: (v: View) => void): () => void; // every frame the view changed (DOM writes only)
  onCommit(f: (v: View) => void): () => void; // gesture ends (React state)
  dispose(): void;
}

type Schedule = { raf(f: () => void): number; caf(id: number): void; setTimeout(f: () => void, ms: number): unknown; clearTimeout(id: unknown): void };

const defaultSchedule = (): Schedule => ({
  raf: (f) => requestAnimationFrame(f),
  caf: (id) => cancelAnimationFrame(id),
  setTimeout: (f, ms) => setTimeout(f, ms),
  clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
});

const same = (a: View, b: View) => a.x === b.x && a.y === b.y && a.z === b.z;

export function createViewport(initial: View, schedule: Schedule = defaultSchedule()): Viewport {
  let view = initial;
  let committed = initial;
  let frame: number | null = null;
  let timer: unknown = null;
  const frameFns = new Set<(v: View) => void>();
  const commitFns = new Set<(v: View) => void>();
  const flush = () => {
    frame = null;
    for (const f of frameFns) f(view);
  };
  const request = () => {
    if (frame === null) frame = schedule.raf(flush);
  };
  const commit = () => {
    if (timer !== null) {
      schedule.clearTimeout(timer);
      timer = null;
    }
    if (same(view, committed)) return;
    committed = view;
    for (const f of commitFns) f(view);
  };
  const set = (v: View, opts?: { commit?: boolean }) => {
    if (!Number.isFinite(v.x) || !Number.isFinite(v.y) || !Number.isFinite(v.z) || v.z <= 0) return;
    if (!same(v, view)) {
      view = v;
      request();
    }
    if (opts?.commit) commit();
  };
  return {
    get: () => view,
    set,
    update: (f, opts) => set(f(view), opts),
    commit,
    commitSoon(ms = 140) {
      if (timer !== null) schedule.clearTimeout(timer);
      timer = schedule.setTimeout(commit, ms);
    },
    onFrame(f) {
      frameFns.add(f);
      return () => frameFns.delete(f);
    },
    onCommit(f) {
      commitFns.add(f);
      return () => commitFns.delete(f);
    },
    dispose() {
      if (frame !== null) schedule.caf(frame);
      if (timer !== null) schedule.clearTimeout(timer);
      frame = null;
      timer = null;
      frameFns.clear();
      commitFns.clear();
    },
  };
}

// The window of the plane to render (plane units) for a view of a canvas: the visible area plus `margin` screens on
// every side, snapped to a grid of half screens so small moves keep the same window.
export function renderWindow(v: View, size: { w: number; h: number }, margin = 1) {
  const cw = size.w / v.z / 2, ch = size.h / v.z / 2;
  const x0 = -v.x / v.z, y0 = -v.y / v.z;
  const ix = Math.floor(x0 / cw), iy = Math.floor(y0 / ch);
  const span = 2 + 2 * margin * 2; // half screens across: the screen (2) plus `margin` screens each side
  return { x0: (ix - margin * 2) * cw, y0: (iy - margin * 2) * ch, x1: (ix - margin * 2 + span + 1) * cw, y1: (iy - margin * 2 + span + 1) * ch };
}

// Is the visible area of `v` still inside the rendered window `w`?
export function covers(w: { x0: number; y0: number; x1: number; y1: number }, v: View, size: { w: number; h: number }) {
  const x0 = -v.x / v.z, y0 = -v.y / v.z;
  return x0 >= w.x0 && y0 >= w.y0 && x0 + size.w / v.z <= w.x1 && y0 + size.h / v.z <= w.y1;
}
