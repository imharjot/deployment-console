"use client";
// The thirteen widgets. Each reads an existing API (never one of its own), honours the global region filter, reports
// its own freshness (R21) and says which role it needs when the API refuses the viewer. Rules that can be tested
// without a browser live in src/lib/dashboards.ts.
import Link from "next/link";
import {
  Activity, BellRing, CircleCheck, Gauge, GitBranch, Globe, Hand, LayoutGrid, LineChart, Network, Rocket, ScrollText, Server, Star, TriangleAlert, Type, Wallet, X,
} from "lucide-react";
import { useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ComponentType, type ReactNode } from "react";
import useSWR, { useSWRConfig } from "swr";
import { Sparkline } from "@/components/charts";
import { PINS_KEY } from "@/components/pin-button";
import { STATE, StateBadge, StateDot } from "@/components/state";
import { Chip, TimeAgo, cx } from "@/components/ui";
import { getJson } from "@/lib/client/api";
import { regionLabel } from "@/lib/client/region";
import {
  currentFailures, filterActivity, logsHref, neighbourhood, pinHref, regionMatches, safeHref, sampledFreshness, textSegments, widgetFreshness,
  type LogQueryPayload, type Pin, type SavedItem, type WidgetType,
} from "@/lib/dashboards";
import { effectiveState, type Freshness } from "@/lib/freshness";
import { coverageFreshness } from "@/lib/inventory/vanish";
import { kindLabelOf, type InventoryView, type Resource } from "@/lib/inventory/types";
import type { ActivityItem, CiRun, EnvInfo, EnvOverview, LogPage, MetricSeries, State } from "@/lib/types";
import type { CostsView } from "@/lib/spend";
import { send, useApi, useRefresh } from "./data";
import { Frame, Loading, Quiet, WidgetError, useFrame } from "./frame";

type EnvRow = EnvInfo & { worst?: State; summary?: Record<State, number>; sampledAt?: number; stale?: boolean; staleReason?: string };
type Icon = ComponentType<{ className?: string; strokeWidth?: number; style?: CSSProperties; "aria-hidden"?: boolean }>;

const str = (v: unknown) => (typeof v === "string" ? v : undefined);
const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const errText = (e: unknown) => (e ? (e as Error).message || "refresh failed" : undefined);
const fresh = (r: { at?: number; error?: unknown; failedAt?: number }, staleAfterMs: number, source: string, server?: Freshness) =>
  widgetFreshness({ at: r.at, server, error: r.error && r.at ? errText(r.error) : undefined, failedAt: r.failedAt, staleAfterMs, source });

// Environments and their regions (shared by every widget that filters by region).
function useEnvs() {
  return useApi<EnvRow[]>("/api/envs", 15_000);
}
const regionOf = (envs: EnvRow[] | undefined, id: string | undefined) => envs?.find((e) => e.id === id)?.region;

function OutOfRegion({ region }: { region: string }) {
  return (
    <Quiet icon={<Globe className="size-4" aria-hidden />}>
      <span>In {regionLabel(region)} — hidden by the region filter.</span>
    </Quiet>
  );
}

const ROW = "flex min-w-0 items-center gap-2 rounded-lg px-1.5 py-1.5 -mx-1.5 hover:bg-panel-2 pointer-coarse:py-2.5";
const overviewHref = (env: string, key?: string) => `/?env=${encodeURIComponent(env)}&view=overview${key ? `&r=${encodeURIComponent(key)}` : ""}`;

// ---------- env-status ----------

function EnvStatus() {
  const { widget, region } = useFrame();
  const r = useEnvs();
  const want = strs(widget.config.envs);
  const envs = (r.data ?? []).filter((e) => (!want.length || want.includes(e.id)) && regionMatches(region, e.region));
  const multiRegion = new Set((r.data ?? []).map((e) => e.region)).size > 1;
  const f = r.data ? sampledFreshness(envs, 90_000) : undefined;
  const freshness = f && r.error ? { ...f, error: errText(r.error), ...(r.failedAt ? { refreshFailedAt: r.failedAt } : {}) } : f;
  const compact = widget.h === 1;
  return (
    <Frame icon={Server} href="/settings/environments" hrefLabel="Environments" freshness={freshness} onRetry={r.reload}>
      {!r.data ? (r.error ? <WidgetError error={r.error} onRetry={r.reload} /> : <Loading rows={compact ? 1 : 3} />) : !envs.length ? (
        <Quiet>{want.length ? "None of the chosen environments are in view." : "No environments found."}</Quiet>
      ) : (
        <ul className={cx(compact ? "flex flex-wrap gap-2 pt-1" : "space-y-0.5")}>
          {envs.map((e) => {
            const worst: State = e.stale ? "UNKNOWN" : (e.worst ?? "UNKNOWN");
            const s = e.summary;
            const bad = s ? (s.DOWN ?? 0) + (s.DEGRADED ?? 0) : 0;
            const total = s ? Object.values(s).reduce((a, b) => a + b, 0) : 0;
            return (
              <li key={e.id} className={cx("min-w-0", compact && "flex-[1_1_12rem]")}>
                <Link href={overviewHref(e.id)} title={e.staleReason ?? STATE[worst].label} className={cx(compact ? "flex min-w-0 items-center gap-2 rounded-xl border border-line bg-panel-2 px-3 py-2 hover:border-line-strong" : ROW)}>
                  <StateDot state={worst} className="flex-none" />
                  <span className="min-w-0 truncate text-[14px] font-medium">{e.label}</span>
                  {e.protected && <Chip tone="warn" className="flex-none">protected</Chip>}
                  {multiRegion && <Chip tone="muted" className="flex-none font-mono">{e.region}</Chip>}
                  <span className="ml-auto flex-none text-[12.5px] tabular-nums text-fg-3">
                    {e.stale ? "not sampled" : bad ? <span className="text-down">{bad} need attention</span> : total ? `${total} healthy` : "—"}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </Frame>
  );
}

// ---------- service-status ----------

function ServiceStatus() {
  const { widget, region } = useFrame();
  const env = str(widget.config.env) ?? "";
  const id = str(widget.config.service) ?? "";
  const r = useApi<EnvOverview & { region?: string }>(env ? `/api/overview?env=${encodeURIComponent(env)}` : null, 15_000);
  const svc = r.data?.services.find((s) => s.id === id || s.key === `service:${id}`);
  const f = fresh(r, 30_000, "overview", r.data?.freshness);
  const state = svc ? effectiveState(svc.state, f, "UNKNOWN" as State) : undefined;
  const inRegion = !r.data?.region || regionMatches(region, r.data.region);
  return (
    <Frame icon={Activity} title={svc ? `${svc.name} · ${env}` : `${id} · ${env}`} href={svc ? overviewHref(env, svc.key) : undefined} hrefLabel="Open the service" freshness={inRegion ? f : undefined} onRetry={r.reload}>
      {!r.data ? (r.error ? <WidgetError error={r.error} onRetry={r.reload} /> : <Loading rows={2} />) : !inRegion ? <OutOfRegion region={r.data.region!} /> : !svc ? (
        <Quiet>No service “{id}” in {env}.</Quiet>
      ) : (
        <div className="flex h-full min-h-0 flex-col gap-2 pt-0.5">
          <div className="flex min-w-0 items-center gap-2">
            <StateBadge state={state!} />
            <span className="min-w-0 truncate text-[13px] text-fg-3" title={svc.reasons.join(" · ")}>{svc.reasons[0]}</span>
          </div>
          <div className="flex flex-wrap gap-1">
            {svc.stats.slice(0, 4).map((s) => (
              <Chip key={s.label} mono>{s.label} {s.value}</Chip>
            ))}
          </div>
          {svc.spark && svc.spark.length > 1 && (
            <div className="mt-auto min-w-0" title="CPU, last hour">
              <Sparkline values={svc.spark} height={widget.h > 1 ? 64 : 26} color={STATE[state!]?.color === "var(--up)" ? "var(--accent)" : STATE[state!].color} />
            </div>
          )}
        </div>
      )}
    </Frame>
  );
}

// ---------- metric-chart ----------

function MiniChart({ series }: { series: MetricSeries }) {
  const ref = useRef<HTMLDivElement>(null);
  const id = useId();
  const [box, setBox] = useState({ w: 320, h: 100 });
  const [hover, setHover] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setBox({ w: Math.max(120, e.contentRect.width), h: Math.max(36, e.contentRect.height) }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const pts = useMemo(() => series.points.filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1])), [series.points]);
  const fmt = (v: number) => `${v >= 100 ? Math.round(v).toLocaleString("en-US") : v.toFixed(1)}${series.unit === "%" ? "%" : series.unit ? ` ${series.unit}` : ""}`;
  const geo = useMemo(() => {
    if (pts.length < 2) return null;
    const t0 = pts[0][0];
    const t1 = pts[pts.length - 1][0];
    const max = Math.max(series.unit === "%" ? 10 : 1, ...pts.map((p) => p[1])) * 1.15;
    const x = (t: number) => ((t - t0) / Math.max(1, t1 - t0)) * box.w;
    const y = (v: number) => box.h - 2 - (Math.max(0, v) / max) * (box.h - 4);
    const line = pts.map((p, i) => `${i ? "L" : "M"}${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join("");
    return { line, area: `${line}L${box.w},${box.h}L0,${box.h}Z`, x, y, t0, t1, max };
  }, [pts, box, series.unit]);
  const shown = hover !== null ? pts[hover] : pts[pts.length - 1];
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <div className="flex min-w-0 items-baseline justify-between gap-2">
        <span className="truncate text-[12.5px] text-fg-3">{hover !== null && shown ? new Date(shown[0]).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : series.label}</span>
        <span className="font-display text-[24px] leading-none tabular-nums">{shown ? fmt(shown[1]) : "—"}</span>
      </div>
      <div
        ref={ref}
        className="relative mt-1.5 min-h-0 min-w-0 flex-1"
        onPointerLeave={() => setHover(null)}
        onPointerMove={(e) => {
          if (!geo) return;
          const rect = e.currentTarget.getBoundingClientRect();
          const t = geo.t0 + ((e.clientX - rect.left) / Math.max(1, rect.width)) * (geo.t1 - geo.t0);
          let best = 0;
          for (let i = 1; i < pts.length; i++) if (Math.abs(pts[i][0] - t) < Math.abs(pts[best][0] - t)) best = i;
          setHover(best);
        }}
      >
        {!geo ? (
          <Quiet>No data points in this window.</Quiet>
        ) : (
          <svg viewBox={`0 0 ${box.w} ${box.h}`} preserveAspectRatio="none" className="absolute inset-0 h-full w-full overflow-visible" role="img" aria-label={`${series.label}: latest ${shown ? fmt(shown[1]) : "no data"}`}>
            <defs>
              <linearGradient id={id} x1="0" x2="0" y1="0" y2="1">
                <stop offset="0" stopColor="var(--accent)" stopOpacity="0.18" />
                <stop offset="1" stopColor="var(--accent)" stopOpacity="0" />
              </linearGradient>
            </defs>
            <line x1="0" x2={box.w} y1={box.h - 0.5} y2={box.h - 0.5} stroke="var(--border)" />
            <path d={geo.area} fill={`url(#${id})`} />
            <path d={geo.line} fill="none" stroke="var(--accent)" strokeWidth="1.5" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
            {hover !== null && shown && <line x1={geo.x(shown[0])} x2={geo.x(shown[0])} y1="0" y2={box.h} stroke="var(--border-strong)" vectorEffect="non-scaling-stroke" />}
            {hover !== null && shown && <circle cx={geo.x(shown[0])} cy={geo.y(shown[1])} r="3" fill="var(--accent)" />}
          </svg>
        )}
      </div>
    </div>
  );
}

const WINDOW: Record<number, string> = { 60: "1 h", 360: "6 h", 1440: "24 h", 10080: "7 d" };

function MetricChartWidget() {
  const { widget, region } = useFrame();
  const env = str(widget.config.env) ?? "";
  const key = str(widget.config.key) ?? "";
  const metric = str(widget.config.metric) ?? "cpu";
  const minutes = num(widget.config.minutes, 360);
  const envs = useEnvs();
  const r = useApi<MetricSeries[]>(env && key ? `/api/metrics?env=${encodeURIComponent(env)}&key=${encodeURIComponent(key)}&minutes=${minutes}` : null, 60_000);
  const series = r.data?.find((s) => s.id === metric);
  const envRegion = regionOf(envs.data, env);
  const inRegion = regionMatches(region, envRegion);
  return (
    <Frame
      icon={LineChart}
      title={`${series?.label ?? metric} · ${key.replace(/^service:/, "")} (${env})`}
      href={`/metrics?env=${encodeURIComponent(env)}`}
      hrefLabel="Open metrics"
      freshness={inRegion ? fresh(r, 3 * 60_000, "CloudWatch") : undefined}
      onRetry={r.reload}
      extra={<Chip tone="muted" className="flex-none">{WINDOW[minutes] ?? `${minutes} min`}</Chip>}
    >
      {!inRegion && envRegion ? <OutOfRegion region={envRegion} /> : !r.data ? (r.error ? <WidgetError error={r.error} onRetry={r.reload} /> : <Loading rows={2} />) : !series ? (
        <Quiet>{r.data.length ? `No “${metric}” for this resource — try ${r.data.map((s) => s.id).join(", ")}.` : "No metrics for this resource."}</Quiet>
      ) : (
        <div className="flex h-full min-h-0 flex-col">
          <MiniChart series={series} />
        </div>
      )}
    </Frame>
  );
}

// ---------- alarms (from the cloud map) ----------

const INVENTORY = "/api/inventory";
// A scaling alarm (facts.scaling: target tracking, or only scaling actions) in ALARM starts a scaling action, not an
// incident: it is listed with a neutral dot and never counts as firing.
const alarmRank = (r: Resource) =>
  r.facts?.scaling ? (r.facts?.alarmState === "ALARM" ? 1.5 : 2) : r.facts?.alarmState === "ALARM" || r.health === "error" ? 0 : r.facts?.alarmState === "INSUFFICIENT_DATA" || r.health === "warning" ? 1 : 2;
const inventoryFresh = (r: { data?: InventoryView; at?: number; error?: unknown; failedAt?: number }) => {
  if (!r.data) return undefined;
  const f = coverageFreshness({ generatedAt: r.data.generatedAt, completeness: r.data.completeness, pendingRegions: r.data.partial?.pendingRegions }, 10 * 60_000);
  return r.error ? { ...f, error: errText(r.error), ...(r.failedAt ? { refreshFailedAt: r.failedAt } : {}) } : f;
};

function Alarms() {
  const { widget, region } = useFrame();
  const env = str(widget.config.env);
  const only = str(widget.config.region);
  const r = useApi<InventoryView>(INVENTORY, 60_000);
  const all = (r.data?.resources ?? []).filter((x) => x.kind === "cloudwatch-alarm" && (!env || x.env === env) && (!only || x.region === only) && regionMatches(region, x.region));
  const list = [...all].sort((a, b) => alarmRank(a) - alarmRank(b) || a.name.localeCompare(b.name));
  const firing = list.filter((x) => alarmRank(x) === 0);
  const shown = list.filter((x) => alarmRank(x) < 2);
  const quiet = list.length - shown.length;
  const provider = r.data?.providers.find((p) => p.id === "alarms");
  return (
    <Frame
      icon={BellRing}
      href="/map"
      hrefLabel="Open the map"
      freshness={inventoryFresh(r)}
      onRetry={r.reload}
      extra={firing.length ? <Chip tone="bad" className="flex-none tabular-nums">{firing.length} firing</Chip> : undefined}
    >
      {!r.data ? (r.error ? <WidgetError error={r.error} onRetry={r.reload} /> : <Loading />) : !list.length ? (
        <Quiet>{provider && provider.state !== "ok" ? `Alarms aren't read: ${provider.state}${provider.error ? ` — ${provider.error}` : ""}.` : "No CloudWatch alarms here."}</Quiet>
      ) : (
        <ul className="space-y-0.5">
          {shown.map((a) => (
            <li key={a.key}>
              <Link href={`/map?r=${encodeURIComponent(a.key)}`} className={cx(ROW, "items-start")}>
                <span className="mt-1.5 size-2 flex-none rounded-full" style={{ background: alarmRank(a) === 0 ? "var(--down)" : a.facts?.scaling ? "var(--unknown)" : "var(--degraded)" }} aria-hidden />
                <span className="min-w-0">
                  <span className="block truncate text-[13.5px] font-medium" title={a.name}>{a.name}</span>
                  {a.healthReason && <span className="line-clamp-2 text-[12.5px] leading-snug text-fg-3">{a.healthReason}</span>}
                </span>
              </Link>
            </li>
          ))}
          {quiet > 0 && <li className="px-0.5 pt-1 text-[12.5px] text-fg-3">{quiet} more OK</li>}
        </ul>
      )}
    </Frame>
  );
}

// ---------- map-neighbourhood ----------

const HEALTH: Record<string, string> = { ok: "var(--up)", warning: "var(--degraded)", error: "var(--down)", stopped: "var(--stopped)", unknown: "var(--unknown)" };

function MapNeighbourhood() {
  const { widget } = useFrame();
  const key = str(widget.config.key) ?? "";
  const hops = num(widget.config.hops, 1);
  const r = useApi<InventoryView>(INVENTORY, 60_000);
  const byKey = useMemo(() => new Map((r.data?.resources ?? []).map((x) => [x.key, x])), [r.data]);
  const hood = useMemo(() => (r.data ? neighbourhood(r.data.edges, key, hops, 25) : null), [r.data, key, hops]);
  const center = byKey.get(key);
  const others = hood?.nodes.filter((n) => n.depth > 0) ?? [];
  const label = (k: string) => byKey.get(k)?.name ?? k;
  // A small radial picture: the resource in the middle, one ring per hop.
  const W = 300;
  const H = 150;
  // At most 12 around it in the picture (the nearest); the list below names them all.
  const drawn = others.slice(0, 12);
  const pos = new Map<string, { x: number; y: number }>([[key, { x: W / 2, y: H / 2 }]]);
  for (const d of [1, 2]) {
    const ring = drawn.filter((n) => n.depth === d);
    ring.forEach((n, i) => {
      const a = (i / Math.max(1, ring.length)) * Math.PI * 2 - Math.PI / 2 + (d === 2 ? Math.PI / Math.max(2, ring.length) : 0);
      pos.set(n.key, { x: W / 2 + Math.cos(a) * (d === 1 ? 58 : 120), y: H / 2 + Math.sin(a) * (d === 1 ? 44 : 66) });
    });
  }
  return (
    <Frame icon={Network} title={center ? `Around ${center.name}` : undefined} href={`/map?r=${encodeURIComponent(key)}`} hrefLabel="Open on the map" freshness={inventoryFresh(r)} onRetry={r.reload}>
      {!r.data ? (r.error ? <WidgetError error={r.error} onRetry={r.reload} /> : <Loading />) : !center ? (
        <Quiet>Not on the map: <span className="font-mono [overflow-wrap:anywhere]">{key}</span></Quiet>
      ) : (
        <div className={cx("grid min-w-0 gap-2", widget.w >= 8 && "grid-cols-[minmax(0,1fr)_minmax(0,1fr)] items-start")}>
          {others.length > 0 && widget.h >= 2 && (
            <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full max-w-[420px] justify-self-center" role="img" aria-label={`${center.name} and ${others.length} connected resources`}>
              {hood!.edges.filter((e) => pos.has(e.from) && pos.has(e.to)).map((e) => {
                const a = pos.get(e.from);
                const b = pos.get(e.to);
                return a && b ? <line key={`${e.from}>${e.to}:${e.kind}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="var(--border-strong)" strokeWidth="1" /> : null;
              })}
              {[...pos].map(([k, p]) => {
                const res = byKey.get(k);
                return (
                  <a key={k} href={`/map?r=${encodeURIComponent(k)}`} aria-label={label(k)}>
                    <title>{`${label(k)}${res ? ` · ${kindLabelOf(res)}` : ""}`}</title>
                    <circle cx={p.x} cy={p.y} r={k === key ? 7 : 4.5} fill="var(--panel)" stroke={HEALTH[res?.health ?? "unknown"]} strokeWidth={k === key ? 2.5 : 1.75} />
                  </a>
                );
              })}
            </svg>
          )}
          <ul className="min-w-0 space-y-0.5">
            {!others.length && <li className="text-[13px] text-fg-3">No connections on the map.</li>}
            {others.map((n) => {
              const res = byKey.get(n.key);
              return (
                <li key={n.key}>
                  <Link href={`/map?r=${encodeURIComponent(n.key)}`} className={ROW}>
                    <span className="size-2 flex-none rounded-full" style={{ background: HEALTH[res?.health ?? "unknown"] }} aria-hidden />
                    <span className={cx("min-w-0 truncate text-[13.5px]", n.depth === 2 && "text-fg-2")} title={n.key}>{label(n.key)}</span>
                    <span className="ml-auto max-w-[45%] flex-none truncate text-[12px] text-fg-3" title={n.via}>{res ? kindLabelOf(res) : n.via}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </Frame>
  );
}

// ---------- pinned ----------

function Pinned() {
  const { region } = useFrame();
  const r = useApi<{ pins: Pin[] }>(PINS_KEY, 60_000);
  const refresh = useRefresh();
  const { mutate } = useSWRConfig();
  const [busy, setBusy] = useState<string | null>(null);
  const pins = (r.data?.pins ?? []).filter((p) => regionMatches(region, p.region));
  const unpin = async (p: Pin) => {
    setBusy(p.rkey);
    try {
      await send("DELETE", `${PINS_KEY}?rkey=${encodeURIComponent(p.rkey)}`);
      await Promise.all([refresh(PINS_KEY), mutate(PINS_KEY)]); // this list and every star on screen
    } catch {
      /* the list refreshes and shows the real state */
    } finally {
      setBusy(null);
    }
  };
  return (
    <Frame icon={Star} freshness={fresh(r, 10 * 60_000, "pins")} onRetry={r.reload}>
      {!r.data ? (r.error ? <WidgetError error={r.error} onRetry={r.reload} /> : <Loading />) : !pins.length ? (
        <Quiet icon={<Star className="size-4" aria-hidden />}>Star a resource on the overview or the map and it shows up here.</Quiet>
      ) : (
        <ul className="space-y-0.5">
          {pins.map((p) => (
            <li key={p.rkey} className="group flex min-w-0 items-center gap-1">
              <Link href={pinHref(p)} className={cx(ROW, "flex-1")}>
                <Star className="size-3.5 flex-none text-degraded" fill="currentColor" aria-hidden />
                <span className="min-w-0 truncate text-[13.5px] font-medium" title={p.rkey}>{p.name}</span>
                <span className="ml-auto flex-none text-[12px] text-fg-3">{p.env ?? p.kind}</span>
              </Link>
              <button type="button" disabled={busy === p.rkey} onClick={() => unpin(p)} aria-label={`Unpin ${p.name}`} title="Unpin" className="press grid size-7 flex-none place-items-center rounded-md text-fg-3 opacity-60 hover:bg-panel-3 hover:text-fg group-hover:opacity-100 pointer-coarse:size-10 pointer-coarse:opacity-100">
                <X className="size-3.5" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}
    </Frame>
  );
}

// ---------- log-query ----------

function useLogQuery(q: LogQueryPayload | undefined) {
  const services = q?.services?.length ? q.services.join(",") : "all";
  const minutes = Math.min(1440, Math.max(5, q?.minutes ?? 60)); // a search spans at most a day
  const key = q?.env ? (["dash-logs", q.env, services, q.query, minutes] as const) : null;
  return useSWR(
    key,
    async ([, e, s, query, m]) => {
      const end = Date.now();
      const p = new URLSearchParams({ env: e, services: s, q: query, mode: "text", start: String(end - m * 60_000), end: String(end) });
      return { value: await getJson<LogPage>(`/api/logs/search?${p}`), at: end };
    },
    { refreshInterval: 120_000, revalidateOnFocus: false },
  );
}

function LogQuery() {
  const { widget, region } = useFrame();
  const c = widget.config;
  const savedId = str(c.savedId);
  const saved = useApi<{ item: SavedItem }>(savedId ? `/api/saved/${encodeURIComponent(savedId)}` : null, 0);
  const q: LogQueryPayload | undefined = savedId
    ? saved.data?.item.kind === "log-query" ? (saved.data.item.payload as LogQueryPayload) : undefined
    : { env: str(c.env), services: strs(c.services), query: str(c.query) ?? "", minutes: num(c.minutes, 60) };
  const envs = useEnvs();
  const r = useLogQuery(q);
  const envRegion = regionOf(envs.data, q?.env);
  const inRegion = regionMatches(region, envRegion);
  const page = r.data?.value;
  const lines = page ? page.lines.slice(-8).reverse() : [];
  const title = savedId ? (saved.data?.item.name ?? "Saved log query") : `“${q?.query}” in ${q?.env}`;
  const f = r.data ? widgetFreshness({ at: r.data.at, error: r.error ? errText(r.error) : undefined, staleAfterMs: 5 * 60_000, source: "CloudWatch Logs" }) : undefined;
  return (
    <Frame
      icon={ScrollText}
      title={title}
      href={q ? logsHref(q) : "/logs"}
      hrefLabel="Open in Logs"
      freshness={inRegion ? f : undefined}
      onRetry={() => r.mutate()}
      extra={page ? <Chip tone={page.lines.length ? "warn" : "muted"} className="flex-none tabular-nums">{page.lines.length}{page.cursor ? "+" : ""} {page.lines.length === 1 ? "match" : "matches"}</Chip> : undefined}
    >
      {savedId && !saved.data ? (saved.error ? <WidgetError error={saved.error} onRetry={saved.reload} /> : <Loading />) : !q ? (
        <Quiet>That saved item isn&apos;t a log query.</Quiet>
      ) : !q.env ? (
        <Quiet>This query names no environment — open it in Logs.</Quiet>
      ) : !inRegion && envRegion ? <OutOfRegion region={envRegion} /> : !page ? (r.error ? <WidgetError error={r.error} onRetry={() => r.mutate()} /> : <Loading />) : !lines.length ? (
        <Quiet icon={<CircleCheck className="size-4" aria-hidden />}>No matches in the last {Math.min(1440, q.minutes) >= 60 ? `${Math.round(Math.min(1440, q.minutes) / 60)} h` : `${q.minutes} min`}.</Quiet>
      ) : (
        <ol className="space-y-1 font-mono text-[12px] leading-snug">
          {lines.map(([ts, , msg], i) => (
            <li key={`${ts}-${i}`} className="flex min-w-0 gap-2">
              <time className="flex-none text-fg-3" dateTime={new Date(ts).toISOString()}>{new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</time>
              <span className="min-w-0 truncate text-fg-2" title={msg}>{msg}</span>
            </li>
          ))}
        </ol>
      )}
    </Frame>
  );
}

// ---------- costs ----------

const usd = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;

function Costs() {
  const { widget } = useFrame();
  const r = useApi<CostsView>("/api/costs", 5 * 60_000);
  const a = r.data?.actual;
  const ok = a?.status === "ok" ? a : undefined;
  const server: Freshness | undefined = ok
    ? { observedAt: ok.fetchedAt, staleAfterMs: Math.max(60_000, ok.expiresAt - ok.fetchedAt), source: "Cost Explorer", completeness: "complete", ...(ok.warning ? { error: ok.warning } : {}) }
    : undefined;
  return (
    <Frame icon={Wallet} href="/costs" hrefLabel="Open costs" freshness={fresh(r, 6 * 3_600_000, "Cost Explorer", server)} onRetry={r.reload}>
      {!r.data ? (r.error ? <WidgetError error={r.error} onRetry={r.reload} /> : <Loading rows={2} />) : !ok ? (
        <Quiet>{a && a.status === "unavailable" ? a.reason : "Spend isn't available."} {r.data.estimate ? `Run-rate estimate ${usd(r.data.estimate.monthly)}/mo.` : ""}</Quiet>
      ) : (
        <div className="flex h-full flex-col gap-2 pt-0.5">
          <div>
            <div className="text-[12.5px] text-fg-3">This month so far{ok.estimated ? " (estimated)" : ""}</div>
            <div className="font-display text-[30px] leading-none tabular-nums">{usd(ok.monthToDate)}</div>
          </div>
          <div className={cx("flex flex-wrap gap-x-4 gap-y-1 text-[13px] text-fg-2", widget.h === 1 && "mt-auto")}>
            {ok.forecast && <span>Forecast <b className="font-medium tabular-nums text-fg">{usd(ok.forecast.monthEnd)}</b></span>}
            <span>Last month <b className="font-medium tabular-nums text-fg">{usd(ok.lastMonth)}</b></span>
            {typeof ok.samePoint?.changePct === "number" && (
              <span className={cx("tabular-nums", ok.samePoint.changePct > 10 ? "text-degraded" : "text-fg-3")}>
                {ok.samePoint.changePct >= 0 ? "+" : ""}{Math.round(ok.samePoint.changePct)}% vs same point
              </span>
            )}
          </div>
          {widget.h > 1 && ok.services.length > 0 && (
            <ul className="mt-1 space-y-1 text-[13px]">
              {ok.services.slice(0, 4).map((s) => (
                <li key={s.service} className="flex min-w-0 justify-between gap-2">
                  <span className="truncate text-fg-2">{s.label}</span>
                  <span className="flex-none tabular-nums">{usd(s.amount)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Frame>
  );
}

// ---------- activity ----------

const KIND_ICON: Record<string, Icon> = { deploy: Rocket, ci: GitBranch, ecs: LayoutGrid, action: Hand };
const TONE: Record<string, string> = { ok: "var(--up)", bad: "var(--down)", warn: "var(--degraded)", info: "var(--deploying)" };

function ActivityWidget() {
  const { widget, region } = useFrame();
  const env = str(widget.config.env);
  const kind = str(widget.config.kind) ?? "deploys";
  const hours = num(widget.config.hours, 24);
  const envs = useEnvs();
  const ids = env ? [env] : (envs.data ?? []).filter((e) => regionMatches(region, e.region)).slice(0, 6).map((e) => e.id);
  const envRegion = env ? regionOf(envs.data, env) : undefined;
  const inRegion = !env || regionMatches(region, envRegion);
  const r = useSWR(
    ids.length && inRegion ? (["dash-activity", ids.join(",")] as const) : null,
    async ([, list]) => {
      const got = await Promise.allSettled(list.split(",").map((id) => getJson<ActivityItem[]>(`/api/activity?env=${encodeURIComponent(id)}`)));
      const failed = list.split(",").filter((_, i) => got[i].status === "rejected");
      if (failed.length === got.length) throw (got[0] as PromiseRejectedResult).reason;
      return { items: got.flatMap((g) => (g.status === "fulfilled" ? g.value : [])), failed, at: Date.now() };
    },
    { refreshInterval: 60_000, revalidateOnFocus: false },
  );
  const items = r.data ? filterActivity(r.data.items, { kind, hours }).slice(0, 40) : [];
  const f = r.data
    ? widgetFreshness({ at: r.data.at, error: r.error ? errText(r.error) : undefined, staleAfterMs: 3 * 60_000, source: "activity" })
    : undefined;
  const freshness = f && r.data?.failed.length ? { ...f, completeness: "partial" as const, notes: r.data.failed.map((x) => `${x} unavailable`) } : f;
  const many = ids.length > 1;
  return (
    <Frame icon={kind === "deploys" ? Rocket : Activity} title={kind === "deploys" ? "Deploys and rollbacks" : "Activity"} href={`/activity${env ? `?env=${encodeURIComponent(env)}` : ""}`} hrefLabel="Open activity" freshness={freshness} onRetry={() => r.mutate()} extra={<Chip tone="muted" className="flex-none">{hours >= 168 ? "7 d" : `${hours} h`}</Chip>}>
      {!inRegion && envRegion ? <OutOfRegion region={envRegion} /> : !r.data ? (r.error ? <WidgetError error={r.error} onRetry={() => r.mutate()} /> : envs.data && !ids.length ? <Quiet>No environments in view.</Quiet> : <Loading />) : !items.length ? (
        <Quiet>{kind === "deploys" ? "No deploys or rollbacks" : "Nothing happened"} in the last {hours >= 168 ? "7 days" : `${hours} hours`}.</Quiet>
      ) : (
        <ol className="space-y-0.5">
          {items.map((i) => {
            const K = KIND_ICON[i.kind] ?? Activity;
            return (
              <li key={`${i.env}-${i.id}`} className="flex min-w-0 items-start gap-2 py-1">
                <K className="mt-0.5 size-3.5 flex-none" style={{ color: TONE[i.tone] }} aria-hidden />
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-baseline gap-1.5">
                    <span className={cx("min-w-0 truncate text-[13.5px] font-medium", i.tone === "bad" && "text-down")}>{i.title}</span>
                    {i.service && <span className="flex-none text-[12px] text-fg-3">{i.service}</span>}
                    {many && i.env && <Chip tone="muted" className="flex-none">{i.env}</Chip>}
                    <TimeAgo at={i.at} className="ml-auto flex-none text-[12px] text-fg-3" />
                  </div>
                  {i.detail && widget.h > 1 && <div className="truncate text-[12.5px] text-fg-3" title={i.detail}>{i.detail}</div>}
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </Frame>
  );
}

// ---------- approvals ----------

interface ApprovalRow {
  id: string;
  title: string;
  op: string;
  env: string | null;
  protected: boolean;
  risk: string;
  createdAt: number;
  expiresAt: number;
  token: { name: string | null };
  owner: { email: string | null };
}

function Approvals() {
  const { region } = useFrame();
  const envs = useEnvs();
  const r = useApi<{ approvals: ApprovalRow[] }>("/api/approvals?status=pending&limit=50", 15_000);
  const list = (r.data?.approvals ?? []).filter((a) => !a.env || regionMatches(region, regionOf(envs.data, a.env)));
  return (
    <Frame icon={Hand} href="/automation#approvals" hrefLabel="Open approvals" freshness={fresh(r, 60_000, "approvals")} onRetry={r.reload} extra={list.length ? <Chip tone="accent" className="flex-none tabular-nums">{list.length}</Chip> : undefined}>
      {!r.data ? (r.error ? <WidgetError error={r.error} onRetry={r.reload} /> : <Loading rows={2} />) : !list.length ? (
        <Quiet icon={<CircleCheck className="size-4" aria-hidden />}>Nothing waiting for a person.</Quiet>
      ) : (
        <ul className="space-y-0.5">
          {list.map((a) => (
            <li key={a.id}>
              <Link href="/automation#approvals" className={ROW}>
                <span className="min-w-0 truncate text-[13.5px] font-medium" title={a.title}>{a.title}</span>
                {a.env && <Chip tone={a.protected ? "warn" : "muted"} className="flex-none">{a.env}</Chip>}
                {a.risk === "danger" && <Chip tone="bad" className="flex-none">danger</Chip>}
                <span className="ml-auto flex-none truncate text-[12px] text-fg-3">{a.token.name ?? a.owner.email ?? ""}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Frame>
  );
}

// ---------- issues ----------

interface IssueRow {
  env: string;
  envLabel: string;
  protected: boolean;
  key: string;
  kind: string;
  name: string;
  state: State;
  reasons: string[];
  since?: number;
}

function Issues() {
  const { region } = useFrame();
  const envs = useEnvs();
  const r = useApi<IssueRow[]>("/api/issues", 15_000);
  const list = (r.data ?? []).filter((i) => regionMatches(region, regionOf(envs.data, i.env)));
  return (
    <Frame icon={TriangleAlert} href="/?view=overview" hrefLabel="Open the overview" freshness={fresh(r, 90_000, "sampler")} onRetry={r.reload} extra={list.length ? <Chip tone="bad" className="flex-none tabular-nums">{list.length}</Chip> : undefined}>
      {!r.data ? (r.error ? <WidgetError error={r.error} onRetry={r.reload} /> : <Loading />) : !list.length ? (
        <Quiet icon={<CircleCheck className="size-4 text-up" aria-hidden />}>No issues — everything the console watches is up.</Quiet>
      ) : (
        <ul className="space-y-0.5">
          {list.map((i) => (
            <li key={`${i.env}/${i.key}`}>
              <Link href={overviewHref(i.env, i.key === "env" ? undefined : i.key)} className={cx(ROW, "items-start")}>
                <StateDot state={i.state} className="mt-1 flex-none" />
                <span className="min-w-0 flex-1">
                  <span className="flex min-w-0 items-baseline gap-1.5">
                    <span className="min-w-0 truncate text-[13.5px] font-medium">{i.name}</span>
                    <Chip tone={i.protected ? "warn" : "muted"} className="flex-none">{i.envLabel}</Chip>
                    {i.since ? <TimeAgo at={i.since} className="ml-auto flex-none text-[12px] text-fg-3" /> : null}
                  </span>
                  {i.reasons[0] && <span className="block truncate text-[12.5px] text-fg-3" title={i.reasons.join(" · ")}>{i.reasons[0]}</span>}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Frame>
  );
}

// ---------- ci-failures ----------

function CiFailures() {
  const { widget } = useFrame();
  const only = str(widget.config.repo);
  const repos = useApi<string[]>(only ? null : "/api/ci/repos", 10 * 60_000);
  const list = only ? [only] : (repos.data ?? []).slice(0, 8);
  const r = useSWR(
    list.length ? (["dash-ci", list.join(",")] as const) : null,
    async ([, l]) => {
      const names = l.split(",");
      const got = await Promise.allSettled(names.map((repo) => getJson<CiRun[]>(`/api/ci/runs?repo=${encodeURIComponent(repo)}`)));
      const failed = names.filter((_, i) => got[i].status === "rejected");
      if (failed.length === got.length) throw (got[0] as PromiseRejectedResult).reason;
      return { runs: got.flatMap((g) => (g.status === "fulfilled" && Array.isArray(g.value) ? g.value : [])), failed, at: Date.now() };
    },
    { refreshInterval: 2 * 60_000, revalidateOnFocus: false },
  );
  const failures = r.data ? currentFailures(r.data.runs).slice(0, 20) : [];
  const f = r.data ? widgetFreshness({ at: r.data.at, error: r.error ? errText(r.error) : undefined, staleAfterMs: 10 * 60_000, source: "GitHub" }) : undefined;
  const freshness = f && r.data?.failed.length ? { ...f, completeness: "partial" as const, notes: r.data.failed.map((x) => `${x} unavailable`) } : f;
  const err = repos.error ?? r.error;
  return (
    <Frame icon={GitBranch} href={`/ci${only ? `?repo=${encodeURIComponent(only)}` : ""}`} hrefLabel="Open CI" freshness={freshness} onRetry={() => r.mutate()} extra={failures.length ? <Chip tone="bad" className="flex-none tabular-nums">{failures.length}</Chip> : undefined}>
      {!r.data ? (err && !r.data ? <WidgetError error={err} onRetry={() => (repos.error ? repos.reload() : r.mutate())} /> : repos.data && !list.length ? <Quiet>No repositories are connected.</Quiet> : <Loading />) : !failures.length ? (
        <Quiet icon={<CircleCheck className="size-4 text-up" aria-hidden />}>Every workflow&apos;s latest run passed.</Quiet>
      ) : (
        <ul className="space-y-0.5">
          {failures.map((run) => (
            <li key={`${run.repo}#${run.id}`}>
              <a href={safeHref(run.url) ?? `/ci?repo=${encodeURIComponent(run.repo)}`} target="_blank" rel="noreferrer noopener" className={cx(ROW, "items-start")}>
                <span className="mt-1.5 size-2 flex-none rounded-full bg-down" aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="flex min-w-0 items-baseline gap-1.5">
                    <span className="min-w-0 truncate text-[13.5px] font-medium">{run.workflow} · {run.branch}</span>
                    <span className="flex-none text-[12px] text-fg-3">{run.repo.split("/").pop()}</span>
                    <TimeAgo at={run.createdAt} className="ml-auto flex-none text-[12px] text-fg-3" />
                  </span>
                  <span className="block truncate text-[12.5px] text-fg-3" title={run.title}>{run.conclusion} · {run.title}</span>
                </span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </Frame>
  );
}

// ---------- text ----------

function Text() {
  const { widget } = useFrame();
  const lines = textSegments(str(widget.config.markdownLite) ?? "");
  return (
    <Frame icon={Type} title="Note">
      <div className="space-y-1 pt-0.5 text-[14px] leading-relaxed text-fg-2 [overflow-wrap:anywhere]">
        {lines.map((segs, i) => (
          <p key={i} className={cx(!segs.some((s) => s.text.trim()) && "h-2")}>
            {segs.map((s, j) =>
              !s.href ? <span key={j}>{s.text}</span> : s.href.startsWith("/") ? (
                <Link key={j} href={s.href} className="text-accent hover:underline">{s.text}</Link>
              ) : (
                <a key={j} href={s.href} target="_blank" rel="noreferrer noopener" className="text-accent hover:underline">{s.text}</a>
              ),
            )}
          </p>
        ))}
      </div>
    </Frame>
  );
}

// ---------- registry ----------

export const WIDGET_VIEWS: Record<WidgetType, { icon: Icon; View: ComponentType }> = {
  "env-status": { icon: Server, View: EnvStatus },
  "service-status": { icon: Activity, View: ServiceStatus },
  "metric-chart": { icon: LineChart, View: MetricChartWidget },
  alarms: { icon: BellRing, View: Alarms },
  "map-neighbourhood": { icon: Network, View: MapNeighbourhood },
  pinned: { icon: Star, View: Pinned },
  "log-query": { icon: ScrollText, View: LogQuery },
  costs: { icon: Wallet, View: Costs },
  activity: { icon: Rocket, View: ActivityWidget },
  approvals: { icon: Hand, View: Approvals },
  issues: { icon: TriangleAlert, View: Issues },
  "ci-failures": { icon: GitBranch, View: CiFailures },
  text: { icon: Type, View: Text },
};

export const WidgetIcon = ({ type, className }: { type: WidgetType; className?: string }): ReactNode => {
  const I = WIDGET_VIEWS[type]?.icon ?? Gauge;
  return <I className={className} strokeWidth={1.75} aria-hidden />;
};
