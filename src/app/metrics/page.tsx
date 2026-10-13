"use client";
import { motion } from "motion/react";
import { Gauge, Rocket, RotateCcw } from "lucide-react";
import { useMemo, useState } from "react";
import useSWR from "swr";
import { MultiChart, Sparkline, type Deploy } from "@/components/charts";
import { FreshnessBanner } from "@/components/freshness-banner";
import { AnimatedNumber, enter } from "@/components/motion";
import { hue } from "@/components/hue";
import { Chip, Empty, Segmented, Skeleton, TimeAgo, cx } from "@/components/ui";
import { createHoverStore, fmtNumber, trimPartialBins, type HoverStore } from "@/lib/chart-scale";
import { loadedAt, trackedJson, useEnv } from "@/lib/client/env";
import { keptFreshness, shortSha, stamp } from "@/lib/client/format";
import type { Freshness } from "@/lib/freshness";
import type { EnvName, ObsChart, Observability, Performance } from "@/lib/types";
import { Page, PageHeader, SectionTitle } from "../_components/page-frame";
import { ScrollX } from "../_components/scroll-x";

const RANGES = [
  { value: "60", label: "1h" },
  { value: "360", label: "6h" },
  { value: "1440", label: "24h" },
  { value: "10080", label: "7d" },
];
const EMPTY: Deploy[] = [];

// Both APIs send their own freshness (CloudWatch's age, partial sources) beside the data.
type WithFreshness<T> = T & { freshness?: Freshness };

export default function MetricsPage() {
  const { env } = useEnv();
  const [minutes, setMinutes] = useState("360");
  // One crosshair for every chart; moving it re-renders only crosshairs and legends (F50).
  const [hover] = useState<HoverStore>(createHoverStore);
  const url = env ? `/api/observability?env=${env}&minutes=${minutes}` : null;
  const { data, error, isLoading, mutate } = useSWR<WithFreshness<Observability>>(url, trackedJson, { refreshInterval: 60_000, keepPreviousData: true });
  const latest = useMemo(() => {
    let t = 0;
    for (const s of data?.sections ?? []) for (const c of s.charts) for (const x of c.series) for (const p of x.points) if (p[0] > t) t = p[0];
    return t;
  }, [data]);
  // The window ends when the data was read (never earlier than its newest point), so metrics that stopped arriving
  // leave a visible gap at the right instead of sliding the window back to them (F13). No page-level clock (F50).
  const end = Math.max(latest, loadedAt(url) ?? 0);
  const range = useMemo<[number, number]>(() => [end - Number(minutes) * 60_000, end], [end, minutes]);
  const deploys = data?.deploys ?? EMPTY;
  const fresh = keptFreshness({ data, error, base: data?.freshness, loadedAt: loadedAt(url), source: "CloudWatch", staleAfterMs: 3 * 60_000 });

  return (
    <Page width="wide">
      <PageHeader
        title="Metrics"
        description={
          <>
            CloudWatch · {env} · <span className="pointer-coarse:hidden">hover</span><span className="hidden pointer-coarse:inline">touch</span> any chart to line them all up · dashed lines are deploys
            {data?.deploysNote && <span className="text-fg-3"> ({data.deploysNote})</span>}
          </>
        }
        actions={<Segmented id="obs-range" value={minutes} onChange={setMinutes} options={RANGES} />}
      />

      <FreshnessBanner f={fresh} onRetry={() => void mutate()} />

      {deploys.length > 0 && (
        <div className="space-y-2 text-xs">
          <span className="inline-flex items-center gap-1 text-fg-3"><Rocket className="size-3.5" />{deploys.length} deploy{deploys.length === 1 ? "" : "s"} in window</span>
          {/* One swipeable line on phones; wraps from sm. */}
          <ScrollX>
            <div className="flex gap-2 sm:flex-wrap">
              {deploys.slice(-8).reverse().map((d) => <DeployChip key={`${d.at}-${d.service}`} d={d} hover={hover} />)}
            </div>
          </ScrollX>
        </div>
      )}

      <PerformanceSection env={env} minutes={minutes} hover={hover} range={range} deploys={deploys} />

      {error && !data && <Empty title="Could not load metrics" hint={(error as Error).message} />}
      {isLoading && !data && <SectionsSkeleton />}
      {data?.sections.map((s, si) => (
        <motion.section key={s.title} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ ...enter, delay: Math.min(si, 6) * 0.04 }} className="space-y-3">
          <SectionTitle>{s.title}</SectionTitle>
          <div className={s.charts.length > 3 ? "grid gap-4 md:grid-cols-2 xl:grid-cols-3" : "grid gap-4 lg:grid-cols-2"}>
            {s.charts.map((c) => (
              <MultiChart key={c.id} chart={c} deploys={deploys} hover={hover} range={range} />
            ))}
          </div>
        </motion.section>
      ))}
    </Page>
  );
}

// A deploy (or rollback) in the window: points the crosshair at it. ECS-observed deploys carry no commit (F12).
function DeployChip({ d, hover }: { d: Deploy; hover: HoverStore }) {
  const rollback = d.kind === "rollback";
  const cls = cx(
    "press inline-flex flex-none items-center gap-1 whitespace-nowrap rounded-md border px-2 py-0.5 pointer-coarse:h-10 pointer-coarse:px-3",
    rollback ? "border-degraded/30 bg-degraded/8 text-degraded" : "border-line bg-panel-2 text-fg-2",
    d.url && "hover:border-line-strong hover:text-fg",
  );
  const on = () => hover.set(d.at);
  const off = () => hover.set(null);
  const body = (
    <>
      {rollback && <RotateCcw className="size-3" aria-label="rollback" />}
      {d.service} · {d.sha ? shortSha(d.sha) : <span className="font-medium">ECS</span>} · <TimeAgo at={d.at} />
    </>
  );
  const title = `${rollback ? "Rollback" : "Deploy"} · ${stamp(d.at)} · ${d.title}${d.source === "ecs" ? " · seen in ECS events" : ""}`;
  return d.url ? (
    <a href={d.url} target="_blank" rel="noreferrer" onMouseEnter={on} onMouseLeave={off} onFocus={on} onBlur={off} className={cls} title={title}>
      {body}
    </a>
  ) : (
    <span tabIndex={0} onMouseEnter={on} onMouseLeave={off} onFocus={on} onBlur={off} className={cls} title={title}>
      {body}
    </span>
  );
}

// The same layout as the loaded page, so nothing jumps when the data arrives (F52).
const CHART_H = "h-[262px]";
function SectionsSkeleton() {
  return (
    <div className="space-y-8">
      {[3, 2].map((n, i) => (
        <div key={i} className="space-y-3">
          <Skeleton className="h-4 w-32" />
          <div className={n > 2 ? "grid gap-4 md:grid-cols-2 xl:grid-cols-3" : "grid gap-4 lg:grid-cols-2"}>
            {Array.from({ length: n }, (_, k) => <Skeleton key={k} className={cx(CHART_H, "rounded-2xl")} />)}
          </div>
        </div>
      ))}
    </div>
  );
}

const SOURCE: Record<Performance["source"], string> = { alb: "load balancer · CloudWatch", "access-logs": "Caddy access logs · Logs Insights", none: "not available" };

// Logs Insights bins at the window's edges cover part of a period: drop them so the chart has no false cliff (F36).
function trimChart(c: ObsChart, stepSec: number | undefined, start: number, end: number): ObsChart {
  if (!stepSec || !end) return c;
  return { ...c, series: c.series.map((s) => ({ ...s, points: trimPartialBins(s.points, stepSec * 1000, start, end) })) };
}

// A readout with the readout rules (two significant digits under 1, three above).
const num = (v: number) => Number(fmtNumber(v).replace(/,/g, ""));

function PerformanceSection({ env, minutes, hover, range, deploys }: { env: EnvName; minutes: string; hover: HoverStore; range: [number, number]; deploys: Deploy[] }) {
  const url = env ? `/api/performance?env=${env}&minutes=${minutes}` : null;
  const { data: raw, error, isLoading, mutate } = useSWR<WithFreshness<Performance>>(url, trackedJson, { refreshInterval: 60_000, keepPreviousData: true });
  const [scopeWanted, setScope] = useState("all");
  const read = loadedAt(url) ?? 0;
  const data = useMemo(() => {
    if (!raw || raw.source !== "access-logs") return raw;
    const step = raw.stepSec ?? raw.rps.stepSec;
    const start = read - Number(minutes) * 60_000;
    const latency = Object.fromEntries(Object.entries(raw.latency).map(([k, c]) => [k, trimChart(c, step, start, read)]));
    return { ...raw, rps: trimChart(raw.rps, step, start, read), errors: trimChart(raw.errors, step, start, read), latency };
  }, [raw, read, minutes]);
  // The page's window when it has one; otherwise (CloudWatch metrics still loading or failed) this section's own read.
  const own = useMemo<[number, number]>(() => [read - Number(minutes) * 60_000, read], [read, minutes]);
  const span = range[1] > 0 ? range : own;
  // "Not available" already says why there is nothing; its "completeness unknown" would only repeat it.
  const fresh = keptFreshness({ data: raw, error, base: raw?.source === "none" ? undefined : raw?.freshness, loadedAt: read || undefined, source: "performance", staleAfterMs: 3 * 60_000 });
  const scope = data?.scopes.some((s) => s.id === scopeWanted) ? scopeWanted : "all";
  const t = data?.tiles[scope];
  const lat = data?.latency[scope];
  const rpsSeries = data?.rps.series.find((s) => (scope === "all" ? s.id === "rps-total" : s.id === `rps-${scope}`));
  const errSeries = data?.errors.series.find((s) => (scope === "all" ? s.id === "err-all" : s.id === `err-${scope}`));
  const pts = (id?: string) => (id ? lat?.series.find((s) => s.label === id)?.points.map((p) => p[1]) : undefined);
  const perMinute = t?.rps !== null && t?.rps !== undefined && t.rps > 0 && t.rps < 1;
  // Each tile in its own hue (a dot by the label, a hairline on top, its sparkline) so a row of numbers reads apart.
  const tile = (label: string, value: number | null | undefined, unit: string, o: { spark?: number[]; tone?: "bad" | "warn"; sub?: string; className?: string; hue?: string } = {}) => (
    <div className={cx("relative min-w-0 overflow-hidden rounded-xl border border-line bg-panel p-3 shadow-card", o.className)} style={hue(o.hue ?? "hue-slate")}>
      <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-0.5 bg-[var(--hue)] opacity-60" />
      <div className="flex items-center gap-1.5 text-[12px] text-fg-3"><span className="size-1.5 flex-none rounded-full bg-[var(--hue)]" />{label}</div>
      <div className={cx("mt-1 font-display text-[28px] leading-none tabular-nums transition-colors duration-300", o.tone === "bad" ? "text-down" : o.tone === "warn" ? "text-degraded" : "text-fg")}>
        {value === null || value === undefined ? "—" : <AnimatedNumber value={num(value)} />}
        <span className="ml-1 font-sans text-xs text-fg-3">{unit}</span>
      </div>
      {o.sub ? <div className="mt-1.5 truncate text-[12px] text-fg-3" title={o.sub}>{o.sub}</div> : <div className="mt-1.5"><Sparkline values={o.spark} height={22} color="var(--hue)" /></div>}
    </div>
  );
  const counts = [
    t?.errors5xx !== undefined && t.errors5xx !== null ? `${t.errors5xx.toLocaleString("en-US")} 5xx` : undefined,
    t?.rejected !== undefined && t.rejected !== null ? `${t.rejected.toLocaleString("en-US")} rejected` : undefined,
  ].filter(Boolean).join(" · ");
  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <SectionTitle className="inline-flex items-center gap-1.5"><Gauge className="size-3.5" /> Performance · requests</SectionTitle>
        <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2">
          {data && <Chip tone={data.source === "none" ? "warn" : "muted"}>{SOURCE[data.source]}</Chip>}
          {data && data.scopes.length > 1 && (
            <ScrollX>
              <Segmented id="perf-scope" size="sm" value={scope} onChange={setScope} options={data.scopes.map((s) => ({ value: s.id, label: s.id === "all" ? "All" : s.label }))} />
            </ScrollX>
          )}
        </div>
      </div>
      <FreshnessBanner f={fresh} onRetry={() => void mutate()} />
      {error && !data && <Empty title="Could not load performance" hint={(error as Error).message} />}
      {isLoading && !data && (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-7">{Array.from({ length: 7 }, (_, i) => <Skeleton key={i} className={cx("h-[98px] rounded-xl", i === 6 && "max-sm:col-span-2")} />)}</div>
          <Skeleton className="h-4 w-2/3" />
          <div className="grid gap-4 xl:grid-cols-3">{Array.from({ length: 3 }, (_, i) => <Skeleton key={i} className={cx(CHART_H, "rounded-2xl")} />)}</div>
        </div>
      )}
      {data?.source === "none" && <div className="rounded-xl border border-degraded/30 bg-degraded/8 px-4 py-2.5 text-[14px] text-fg-2">{data.note}</div>}
      {data && data.source !== "none" && (
        <>
          <div className="stagger grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-7">
            {perMinute ? tile("Requests / min", (t?.rps ?? 0) * 60, "req/min", { spark: rpsSeries?.points.map((p) => p[1]), hue: "hue-blue" }) : tile("Requests / sec", t?.rps, "rps", { spark: rpsSeries?.points.map((p) => p[1]), hue: "hue-blue" })}
            {tile("Average", t?.avg, "ms", { spark: pts("avg"), hue: "hue-cyan" })}
            {tile("p50", t?.p50, "ms", { spark: pts("p50"), hue: "hue-teal" })}
            {tile("p90", t?.p90, "ms", { spark: pts("p90"), hue: "hue-violet" })}
            {tile("p99", t?.p99, "ms", { spark: pts("p99"), tone: t?.p99 && t.p99 > 1000 ? "warn" : undefined, hue: "hue-pink" })}
            {tile("5xx rate", t?.errPct, "%", {
              hue: "hue-rose",
              spark: counts ? undefined : errSeries?.points.map((p) => p[1]),
              sub: counts || undefined,
              tone: t?.errPct && t.errPct >= 1 ? "bad" : t?.errPct && t.errPct > 0.1 ? "warn" : undefined,
            })}
            {/* The odd seventh tile spans the row in the two-column phone grid. */}
            {tile("Requests in window", t?.requests, "", { className: "max-sm:col-span-2", hue: "hue-indigo" })}
          </div>
          <div className="text-[12px] text-fg-3">Tiles: last ~5 minutes (percentiles from the newest bucket). {data.note}</div>
          <div className="stagger grid gap-4 xl:grid-cols-3">
            <MultiChart chart={data.rps} deploys={deploys} hover={hover} range={span} />
            {lat && <MultiChart chart={lat} deploys={deploys} hover={hover} range={span} />}
            <MultiChart chart={data.errors} deploys={deploys} hover={hover} range={span} />
            {data.rejected && data.rejected.series.some((s) => s.points.some((p) => p[1] > 0)) && <MultiChart chart={data.rejected} deploys={deploys} hover={hover} range={span} />}
          </div>
        </>
      )}
    </section>
  );
}
