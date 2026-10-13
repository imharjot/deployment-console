"use client";
// Charts. Geometry and number rules live in src/lib/chart-scale.ts (pure, tested): the x axis is time, lines break at
// gaps, the y axis starts at 0 with 1-2-2.5-5 ticks, and neutral series are never drawn in red or amber (F13, F36).
import { motion } from "motion/react";
import { memo, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type PointerEvent } from "react";
import { asOf, nearestIndex, niceScale, rateDisplay, timePath, withUnit, xOf, yFloor, yOf, type Frame, type HoverStore, type Point } from "@/lib/chart-scale";
import { stamp } from "@/lib/client/format";
import type { MetricSeries, ObsChart, Observability } from "@/lib/types";
import { EASE } from "./motion";
import { cx } from "./ui";

function pathOf(values: number[], w: number, h: number, max: number, pad = 2) {
  if (values.length < 2) return { line: "", area: "" };
  const step = w / (values.length - 1);
  const y = (v: number) => h - pad - (Math.min(v, max) / (max || 1)) * (h - pad * 2);
  let line = "";
  values.forEach((v, i) => (line += `${i ? "L" : "M"}${(i * step).toFixed(1)},${y(v).toFixed(1)}`));
  return { line, area: `${line}L${w},${h}L0,${h}Z` };
}

// A card's trend line: evenly spaced samples of the last hour (the sampler keeps one per tick), no axes.
export function Sparkline({ values, color = "var(--accent)", height = 28, max }: { values?: number[]; color?: string; height?: number; max?: number }) {
  const id = useId();
  const w = 120;
  const data = values && values.length > 1 ? values.slice(-60) : undefined;
  const m = max ?? Math.max(10, ...(data ?? [0])) * 1.15;
  const { line, area } = useMemo(() => (data ? pathOf(data, w, height, m) : { line: "", area: "" }), [data, height, m]);
  if (!data) return <div style={{ height }} className="flex items-end"><div className="h-px w-full bg-line" /></div>;
  return (
    <svg viewBox={`0 0 ${w} ${height}`} preserveAspectRatio="none" className="w-full overflow-visible" style={{ height }} aria-hidden>
      <defs>
        <linearGradient id={id} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor={color} stopOpacity="0.16" />
          <stop offset="1" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <motion.path d={area} fill={`url(#${id})`} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.6, ease: EASE }} />
      <motion.path d={line} fill="none" stroke={color} strokeWidth="1.25" strokeLinejoin="round" vectorEffect="non-scaling-stroke" initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: 0.7, ease: EASE }} />
    </svg>
  );
}

// Width of a chart's box, kept in state (ResizeObserver). Grid items holding one need min-w-0 (CODEX).
function useWidth(initial: number, min: number) {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(initial);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(min, Math.round(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, [min]);
  return [ref, w] as const;
}

const sorted = (pts: [number, number][]): Point[] => (pts.every((p, i) => !i || pts[i - 1][0] <= p[0]) ? (pts as Point[]) : ([...pts].sort((a, b) => a[0] - b[0]) as Point[]));

// One metric of one resource (overview and map panels). `range` is the time the x axis spans; by default from the
// first point to when the chart first rendered with data ("now"). A last point older than two steps reads "as of".
export function MetricChart({ series, color = "var(--text-2)", height = 150, range }: { series: MetricSeries; color?: string; height?: number; range?: [number, number] }) {
  const [ref, w] = useWidth(600, 200);
  const [hover, setHover] = useState<number | null>(null);
  const [mountedAt] = useState(() => Date.now());
  const id = useId();
  const pts = useMemo(() => sorted(series.points), [series.points]);
  const live = !range;
  const r0 = range?.[0] ?? pts[0]?.[0] ?? mountedAt - 3600_000;
  const r1 = range?.[1] ?? Math.max(mountedAt, pts[pts.length - 1]?.[0] ?? 0);
  const r: [number, number] = [r0, r1];
  const unit = series.unit;
  const top = Math.max(0, ...pts.filter((p) => p[0] >= r[0] && p[0] <= r[1]).map((p) => p[1]).filter(Number.isFinite));
  const scale = useMemo(() => niceScale(top, { floor: yFloor(unit) }), [top, unit]);
  const frame: Frame = { range: r, width: w, height, max: scale.max, pad: 6 };
  const { line, area } = useMemo(() => timePath(pts, { range: [r0, r1], width: w, height, max: scale.max, pad: 6 }), [pts, r0, r1, w, height, scale.max]);
  const hv = hover !== null ? pts[hover] : undefined;
  const last = pts[pts.length - 1];
  const old = asOf(pts, r[1]);
  const fmt = (v: number) => withUnit(v, unit);

  return (
    <div className="min-w-0 rounded-2xl border border-line bg-panel p-4 shadow-card">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <div className="text-[14px] font-medium text-fg-2">{series.label}</div>
        <div className="text-right">
          <div className="font-display text-[26px] leading-none tabular-nums">{hv ? fmt(hv[1]) : last ? fmt(last[1]) : "—"}</div>
          {!hv && last && old !== undefined && <div className="mt-1 text-[11.5px] text-degraded">as of {stamp(old)}</div>}
        </div>
      </div>
      <div
        ref={ref}
        className="relative touch-pan-y"
        onPointerLeave={() => setHover(null)}
        onPointerMove={(e) => {
          if (pts.length < 1) return;
          const b = e.currentTarget.getBoundingClientRect();
          const i = nearestIndex(pts, r[0] + ((e.clientX - b.left) / b.width) * (r[1] - r[0]));
          setHover(i < 0 ? null : i);
        }}
      >
        {pts.length < 1 ? (
          <div className="grid place-items-center text-xs text-fg-3" style={{ height }}>no datapoints in this window</div>
        ) : (
          <svg width={w} height={height} className="block overflow-visible" role="img" aria-label={`${series.label}: ${last ? fmt(last[1]) : "no data"}`}>
            <defs>
              <linearGradient id={id} x1="0" x2="0" y1="0" y2="1">
                <stop offset="0" stopColor={color} stopOpacity="0.14" />
                <stop offset="1" stopColor={color} stopOpacity="0" />
              </linearGradient>
            </defs>
            {scale.ticks.slice(1).map((v) => (
              <g key={v}>
                <line x1="0" x2={w} y1={yOf(v, frame)} y2={yOf(v, frame)} stroke="var(--border)" />
                <text x="0" y={yOf(v, frame) - 3} className="fill-[var(--text-3)] text-[10.5px]">{withUnit(v, unit, true)}</text>
              </g>
            ))}
            <motion.path d={area} fill={`url(#${id})`} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.6, ease: EASE }} />
            <motion.path d={line} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" initial={{ pathLength: 0, opacity: 0 }} animate={{ pathLength: 1, opacity: 1 }} transition={{ duration: 0.7, ease: EASE }} />
            {hv && (
              <g>
                <line x1={xOf(hv[0], frame)} x2={xOf(hv[0], frame)} y1="0" y2={height} stroke="var(--border-strong)" />
                <circle cx={xOf(hv[0], frame)} cy={yOf(hv[1], frame)} r="3" fill={color} stroke="var(--panel)" strokeWidth="2" />
              </g>
            )}
          </svg>
        )}
        <div className="mt-1.5 flex justify-between gap-2 text-[11px] text-fg-3">
          <span>{stamp(r[0])}</span>
          <span>{hv ? stamp(hv[0]) : old !== undefined || !live ? stamp(r[1]) : "now"}</span>
        </div>
      </div>
    </div>
  );
}

// ---------- multi-series chart with a shared crosshair + deploy markers (metrics page) ----------

// Muted categorical colours, tuned per theme in globals.css (--series-1…8). Neutral series never take the red (4) or
// the ambers (2, 7): those read as errors. A sixth series repeats the first colours dashed.
export const SERIES_COLORS = [1, 3, 5, 6, 8].map((i) => `var(--series-${i})`);
const ERROR_CHART = /^(err|5xx|rejected)/;
function colorOf(chart: ObsChart, index: number, id: string) {
  if (ERROR_CHART.test(chart.id) && /(^|-)(all|total)$/i.test(id)) return { color: "var(--down)", dash: undefined };
  return { color: SERIES_COLORS[index % SERIES_COLORS.length], dash: index >= SERIES_COLORS.length ? "4 3" : undefined };
}

export type Deploy = Observability["deploys"][number];
const EMPTY_DEPLOYS: Deploy[] = [];

function useHover(store: HoverStore) {
  return useSyncExternalStore(store.subscribe, store.get, () => null);
}

// The crosshair and the dots on it: the only part of a chart that re-renders while the pointer moves (F50).
function Crosshair({ store, series, frame }: { store: HoverStore; series: { id: string; points: Point[]; color: string }[]; frame: Frame }) {
  const t = useHover(store);
  if (t === null || t < frame.range[0] || t > frame.range[1]) return null;
  return (
    <g>
      <line x1={xOf(t, frame)} x2={xOf(t, frame)} y1={0} y2={frame.height} stroke="var(--border-strong)" />
      {series.map((s) => {
        const i = nearestIndex(s.points, t);
        const p = i < 0 ? undefined : s.points[i];
        return p ? <circle key={s.id} cx={xOf(p[0], frame)} cy={yOf(p[1], frame)} r={3.2} fill={s.color} stroke="var(--panel)" strokeWidth={1.5} /> : null;
      })}
    </g>
  );
}

function HoverStamp({ store }: { store: HoverStore }) {
  const t = useHover(store);
  return t === null ? null : <div className="font-mono text-[11.5px] text-fg-3">{stamp(t)}</div>;
}

function Legend({ store, chart, series, unit, off, toggle }: { store: HoverStore; chart: ObsChart; series: { id: string; label: string; points: Point[] }[]; unit: string; off: Set<string>; toggle(id: string): void }) {
  const t = useHover(store);
  return (
    <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 pointer-coarse:gap-y-0">
      {series.map((s, i) => {
        const k = t !== null ? nearestIndex(s.points, t) : s.points.length - 1;
        const p = k < 0 ? undefined : s.points[k];
        const { color, dash } = colorOf(chart, i, s.id);
        return (
          <button key={s.id} type="button" aria-pressed={!off.has(s.id)} onClick={() => toggle(s.id)} className={cx("press inline-flex items-center gap-1.5 rounded text-[12px] pointer-coarse:min-h-10 pointer-coarse:px-1", off.has(s.id) && "opacity-35")}>
            <svg width="10" height="6" aria-hidden className="flex-none"><line x1="0" x2="10" y1="3" y2="3" stroke={color} strokeWidth="2" strokeDasharray={dash} /></svg>
            <span className="text-fg-2">{s.label}</span>
            {p && <span className="font-mono tabular-nums text-fg">{withUnit(p[1], unit)}</span>}
          </button>
        );
      })}
    </div>
  );
}

// Memoised: a page re-render (new range, another chart's hover) never redraws the paths of this one.
export const MultiChart = memo(function MultiChart({ chart, deploys = EMPTY_DEPLOYS, hover, range, height = 170 }: {
  chart: ObsChart;
  deploys?: Deploy[];
  hover: HoverStore;
  range: [number, number];
  height?: number;
}) {
  const [ref, w] = useWidth(480, 220);
  const [off, setOff] = useState<Set<string>>(() => new Set());
  const gid = useId();
  const [t0, t1] = range;
  const disp = useMemo(() => {
    const d = rateDisplay(chart.unit, chart.series.map((s) => ({ ...s, points: sorted(s.points) })));
    return { ...d, series: d.series.map((s, i) => ({ ...s, ...colorOf(chart, i, s.id) })) };
  }, [chart]);
  const shown = useMemo(() => disp.series.filter((s) => !off.has(s.id)), [disp, off]);
  const top = useMemo(() => Math.max(0, ...shown.flatMap((s) => s.points.filter((p) => p[0] >= t0 && p[0] <= t1).map((p) => p[1])).filter(Number.isFinite)), [shown, t0, t1]);
  const scale = useMemo(() => niceScale(top, { floor: yFloor(disp.unit) }), [top, disp.unit]);
  const frame = useMemo<Frame>(() => ({ range: [t0, t1], width: w, height, max: scale.max, pad: 4 }), [t0, t1, w, height, scale.max]);
  const paths = useMemo(() => shown.map((s) => ({ ...s, ...timePath(s.points, frame) })), [shown, frame]);
  const empty = !chart.series.length || chart.series.every((s) => s.points.length < 1);
  const toggle = (id: string) =>
    setOff((o) => {
      const n = new Set(o);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const move = (e: PointerEvent<HTMLDivElement>) => {
    if (empty) return;
    const b = e.currentTarget.getBoundingClientRect();
    hover.set(t0 + ((e.clientX - b.left) / b.width) * (t1 - t0));
  };

  return (
    <div className="min-w-0 rounded-2xl border border-line bg-panel p-4 shadow-card">
      <div className="mb-3 flex items-baseline justify-between gap-2">
        <div className="text-[14px] font-medium">
          {chart.title}
          {disp.unit !== chart.unit && <span className="ml-1.5 text-[12px] font-normal text-fg-3">per minute (under 1 per second)</span>}
        </div>
        {!empty && <HoverStamp store={hover} />}
      </div>
      <div ref={ref} className="relative touch-pan-y" onPointerMove={move} onPointerLeave={() => hover.set(null)}>
        {empty ? (
          <div className="grid place-items-center px-6 text-center text-xs text-fg-3" style={{ height }}>{chart.note ?? "no datapoints in this window"}</div>
        ) : (
          <svg width={w} height={height} className="block overflow-visible">
            <defs>
              <linearGradient id={gid} x1="0" x2="0" y1="0" y2="1">
                <stop offset="0" stopColor={paths[0]?.color ?? SERIES_COLORS[0]} stopOpacity="0.14" />
                <stop offset="1" stopColor={paths[0]?.color ?? SERIES_COLORS[0]} stopOpacity="0" />
              </linearGradient>
            </defs>
            {scale.ticks.slice(1).map((v) => (
              <g key={v}>
                <line x1="0" x2={w} y1={yOf(v, frame)} y2={yOf(v, frame)} stroke="var(--border)" />
                <text x={w} y={yOf(v, frame) - 3} textAnchor="end" className="fill-[var(--text-3)] text-[10.5px]">{withUnit(v, disp.unit, true)}</text>
              </g>
            ))}
            {deploys.filter((d) => d.at >= t0 && d.at <= t1).map((d) => {
              const rollback = d.kind === "rollback";
              const c = rollback ? "var(--degraded)" : "var(--accent)";
              return (
                <g key={`${d.at}-${d.service}`}>
                  <line x1={xOf(d.at, frame)} x2={xOf(d.at, frame)} y1={0} y2={height} stroke={c} strokeOpacity={rollback ? 0.7 : 0.4} strokeDasharray={rollback ? "3 2" : "1 3"} strokeLinecap="round" />
                  <circle cx={xOf(d.at, frame)} cy={2.5} r={2.5} fill={c}>
                    <title>{`${rollback ? "rollback" : "deploy"} · ${d.service} · ${d.sha ? d.sha.slice(0, 7) : "ECS"} ${d.title} · ${stamp(d.at)}`}</title>
                  </circle>
                </g>
              );
            })}
            {paths.map((p) =>
              p.line ? (
                <g key={p.id}>
                  {disp.series.length === 1 && p.area && <path d={p.area} fill={`url(#${gid})`} />}
                  {/* motion's pathLength draws with its own stroke-dasharray, which would erase a dashed series' dashes:
                      those fade in instead. */}
                  <motion.path d={p.line} fill="none" stroke={p.color} strokeWidth="1.5" strokeDasharray={p.dash} strokeLinejoin="round" strokeLinecap="round" initial={p.dash ? { opacity: 0 } : { pathLength: 0 }} animate={p.dash ? { opacity: 1 } : { pathLength: 1 }} transition={{ duration: 0.7, ease: EASE }} />
                </g>
              ) : null,
            )}
            <Crosshair store={hover} series={paths} frame={frame} />
          </svg>
        )}
      </div>
      {!empty && <Legend store={hover} chart={chart} series={disp.series} unit={disp.unit} off={off} toggle={toggle} />}
    </div>
  );
});
