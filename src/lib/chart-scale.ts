// Chart geometry and number formatting (F13, F36, F09, F50). Pure: the charts (src/components/charts.tsx) and the
// metrics page draw with these, and node --test checks them (chart-scale.test.ts).
//
// Rules: the x axis is time, never the point index; a gap longer than twice the usual step breaks the line instead of
// drawing a slope across missing data; the y axis starts at 0 with 1-2-2.5-5 steps; values below 1 keep two
// significant digits so 0.04 rps never reads "0".

export type Point = [t: number, v: number];

// ---------- y scale ----------

// The step for about `raw` per tick, snapped to 1, 2, 2.5 or 5 × a power of ten.
export function niceStep(raw: number): number {
  if (!(raw > 0) || !Number.isFinite(raw)) return 1;
  const base = 10 ** Math.floor(Math.log10(raw));
  const f = raw / base;
  const m = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
  return clean(m * base);
}

// Floating-point noise off a tick (0.30000000000000004 → 0.3).
const clean = (v: number) => Number(v.toPrecision(12));

// A y axis from 0 that holds `top` with about `count` steps. `floor` keeps a quiet series from filling the chart
// (CPU at 0.4 % on a 0–10 % axis); without one, any positive value gets a scale of its own size (0.02 → 0–0.025).
export function niceScale(top: number, opts: { count?: number; floor?: number } = {}): { max: number; step: number; ticks: number[] } {
  const count = Math.max(1, opts.count ?? 4);
  const t = Math.max(Number.isFinite(top) ? top : 0, opts.floor ?? 0);
  if (!(t > 0)) return { max: 1, step: 0.25, ticks: [0, 0.25, 0.5, 0.75, 1] };
  // The smallest nice step that needs at most count + 1 bands (a tight fit, never a near-empty extra band).
  let step = niceStep(t / (count + 1));
  while (Math.ceil(clean(t / step)) > count + 1) step = niceStep(step * 1.01);
  const n = Math.max(1, Math.ceil(clean(t / step)));
  const ticks = Array.from({ length: n + 1 }, (_, i) => clean(i * step));
  return { max: ticks[ticks.length - 1], step, ticks };
}

// The y floor for a unit: percentages keep a 0–10 % minimum; anything else scales to its own values.
export const yFloor = (unit: string) => (unit === "%" ? 10 : 0);

// ---------- numbers ----------

const COUNT_UNITS = new Set(["", "count", "requests", "IOPS", "tasks"]);
export const isCountUnit = (unit: string) => COUNT_UNITS.has(unit);

// A readout: two significant digits below 1, three above, whole numbers with separators from 100 (F09, F36).
export function fmtNumber(v: number): string {
  if (!Number.isFinite(v)) return "—";
  const a = Math.abs(v);
  if (a === 0) return "0";
  if (a < 1) return String(Number(v.toPrecision(2)));
  if (a < 100) return String(Number(v.toPrecision(3)));
  return Math.round(v).toLocaleString("en-US");
}

// Axis labels: k and M from a thousand, at most one decimal ("2.5k", "1.2M"), else the readout rules.
export function fmtAxis(v: number): string {
  if (!Number.isFinite(v)) return "";
  const a = Math.abs(v);
  const short = (x: number) => String(Number(x.toFixed(1)));
  if (a >= 1e6) return `${short(v / 1e6)}M`;
  if (a >= 1e3) return `${short(v / 1e3)}k`;
  return fmtNumber(v);
}

// "12 %", "340 ms", "1,204" — with the unit as the chart names it. Counts are always whole.
export function withUnit(v: number, unit: string, axis = false): string {
  if (!Number.isFinite(v)) return "—";
  const n = axis ? fmtAxis(v) : isCountUnit(unit) && Math.abs(v) >= 1 ? Math.round(v).toLocaleString("en-US") : fmtNumber(v);
  if (unit === "%") return `${n}%`;
  return unit && !isCountUnit(unit) ? `${n} ${unit}` : n;
}

// A requests-per-second series that never reaches 1 reads better per minute ("0.4 rps" → "24 req/min").
export function rateDisplay<S extends { points: Point[] }>(unit: string, series: S[]): { unit: string; scale: number; series: S[] } {
  if (unit !== "rps") return { unit, scale: 1, series };
  const max = Math.max(0, ...series.flatMap((s) => s.points.map((p) => p[1]).filter(Number.isFinite)));
  if (max >= 1 || max === 0) return { unit, scale: 1, series };
  return { unit: "req/min", scale: 60, series: series.map((s) => ({ ...s, points: s.points.map(([t, v]) => [t, v * 60] as Point) })) };
}

// ---------- time axis ----------

// The usual distance between points: the median step (robust to the occasional gap).
export function medianStep(points: Point[]): number {
  if (points.length < 2) return 0;
  const d: number[] = [];
  for (let i = 1; i < points.length; i++) d.push(points[i][0] - points[i - 1][0]);
  d.sort((a, b) => a - b);
  const m = Math.floor(d.length / 2);
  return d.length % 2 ? d[m] : (d[m - 1] + d[m]) / 2;
}

// Runs of consecutive points with no gap longer than `gap` × the median step between them (non-finite values are gaps).
export function segments(points: Point[], gap = 2): Point[][] {
  const step = medianStep(points);
  const out: Point[][] = [];
  let cur: Point[] = [];
  for (const p of points) {
    if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) {
      if (cur.length) out.push(cur);
      cur = [];
      continue;
    }
    const prev = cur[cur.length - 1];
    if (prev && step > 0 && p[0] - prev[0] > gap * step) {
      out.push(cur);
      cur = [];
    }
    cur.push(p);
  }
  if (cur.length) out.push(cur);
  return out;
}

export interface Frame {
  range: [number, number]; // time span of the x axis
  width: number;
  height: number;
  max: number; // top of the y axis
  pad?: number; // px kept free above and below the line
}

export const xOf = (t: number, f: Frame) => ((t - f.range[0]) / Math.max(1, f.range[1] - f.range[0])) * f.width;
export const yOf = (v: number, f: Frame) => {
  const pad = f.pad ?? 4;
  return f.height - pad - (Math.max(0, Math.min(v, f.max)) / (f.max || 1)) * (f.height - pad * 2);
};

// SVG paths for a time series: x by time inside `range`, the line broken at gaps, an area under each run. A run of
// one point becomes a dot (a tiny horizontal stroke, drawn with a round cap).
export function timePath(points: Point[], f: Frame): { line: string; area: string; runs: number } {
  const [t0, t1] = f.range;
  const inside = points.filter((p) => p[0] >= t0 && p[0] <= t1);
  const runs = segments(inside);
  let line = "";
  let area = "";
  const r1 = (n: number) => n.toFixed(1);
  for (const run of runs) {
    const xs = run.map((p) => xOf(p[0], f));
    const ys = run.map((p) => yOf(p[1], f));
    if (run.length === 1) {
      line += `M${r1(xs[0])},${r1(ys[0])}h0.01`;
      continue;
    }
    const d = xs.map((x, i) => `${i ? "L" : "M"}${r1(x)},${r1(ys[i])}`).join("");
    line += d;
    area += `${d}L${r1(xs[xs.length - 1])},${f.height}L${r1(xs[0])},${f.height}Z`;
  }
  return { line, area, runs: runs.length };
}

// The index of the point nearest to time t (points sorted by time); -1 when there are none. Binary search (F50).
export function nearestIndex(points: Point[], t: number): number {
  if (!points.length) return -1;
  let lo = 0;
  let hi = points.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid][0] < t) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0 && Math.abs(points[lo - 1][0] - t) <= Math.abs(points[lo][0] - t)) return lo - 1;
  return lo;
}

// When the newest point is older than two steps (and a minute) before the range's end, the headline is "as of
// <time>", never "now" (F13). Returns that time, or undefined when the series is current.
export function asOf(points: Point[], end: number): number | undefined {
  const last = points[points.length - 1];
  if (!last) return undefined;
  const step = Math.max(medianStep(points), 60_000);
  return end - last[0] > 2 * step ? last[0] : undefined;
}

// Logs Insights bins at the window's edges cover only part of their period: a half-full first bin draws a false
// cliff. Drop a first bin that starts before the window and a last bin that hasn't closed yet (F36).
export function trimPartialBins(points: Point[], stepMs: number, start: number, end: number): Point[] {
  if (!(stepMs > 0) || points.length < 3) return points;
  let from = 0;
  let to = points.length;
  if (points[0][0] < start) from = 1;
  if (points[to - 1][0] + stepMs > end) to -= 1;
  return points.slice(from, to);
}

// ---------- hover store (F50) ----------

// One crosshair time shared by every chart on a page. Charts subscribe with useSyncExternalStore, so moving the
// pointer re-renders only the crosshairs and legends, never the page or the paths.
export interface HoverStore {
  get(): number | null;
  set(t: number | null): void;
  subscribe(fn: () => void): () => void;
}
export function createHoverStore(): HoverStore {
  let t: number | null = null;
  const subs = new Set<() => void>();
  return {
    get: () => t,
    set(v) {
      if (v === t) return;
      t = v;
      subs.forEach((f) => f());
    },
    subscribe(fn) {
      subs.add(fn);
      return () => {
        subs.delete(fn);
      };
    },
  };
}
