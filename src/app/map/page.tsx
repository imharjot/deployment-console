"use client";
// Cloud map: every resource the console can see in the account — edge, compute, messaging, data, storage, externals,
// and (as layers) network, security, monitoring, delivery and other services — in one pannable map, with filters, a
// resource panel (details, connections, actions, notes) and the status of every discovery source. Data: GET
// /api/inventory (src/lib/inventory/types.ts has the contract); layout: src/lib/inventory/layout.ts; canvas, list,
// table and panel: src/components/map/*.
//
// The URL carries the view (F44): q, env, kinds, problems, idle, region (shared with the console's region filter),
// layers, conn (connection confidence), lanes, view (map | list; table → /resources), edges=all and r (the open
// resource). Phones open on the list (F23); held upright, the map is transposed (lanes side by side).
import { AlertTriangle, BookOpen, FlaskConical, List as ListIcon, Map as MapIcon, RefreshCw, ShieldCheck, Table2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AnimatePresence } from "motion/react";
import { useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useSWRConfig } from "swr";
import { Empty, IconButton, Button, Segmented, Skeleton, TimeAgo, cx } from "@/components/ui";
import { Swap, usePhone } from "@/components/motion";
import { useToast } from "@/components/toast";
import { useMe } from "@/components/user-menu";
import { FreshnessBanner } from "@/components/freshness-banner";
import { DENSE_EDGES, Graph, type GraphHandle } from "@/components/map/graph";
import { ResourceList } from "@/components/map/list";
import { MapResourcePanel } from "@/components/map/resource-panel";
import { ConnectionList, ConnectionsPicker, EnvFilter, FiltersButton, FiltersSheet, KindList, KindPicker, LanesSelect, LayerList, LayersPicker, ProvidersFooter, RegionSelect, ResetChip, Toggle, envOptions } from "@/components/map/toolbar";
import { DEFAULT_FILTERS, SHARED, activeFilterCount, applyFilters, filtersFromParams, filtersToParams, haystack, type MapFilters } from "@/components/map/filter";
import { INVENTORY_KEY, refreshInventory, useInventory, type MapInventory } from "@/components/map/data";
import { loadLayers, saveLayers } from "@/components/map/layers";
import { NewServiceButton } from "@/components/panel/provision";
import { SearchField } from "../_components/fields";
import { ApiError } from "@/lib/client/api";
import { stamp } from "@/lib/client/format";
import { useEnv, useEnvList } from "@/lib/client/env";
import { regionLabel, useRegionFilter } from "@/lib/client/region";
import { coverageFreshness } from "@/lib/inventory/vanish";
import { layoutGraph, parentId, type LaneBy, type LayoutNode } from "@/lib/inventory/layout";
import { KIND_INFO, type Layer, type ResourceKind } from "@/lib/inventory/types";

const LANES_KEY = "console.map.lanes";
const PANEL_W = 640;
const STALE_MS = 10 * 60_000; // the map polls every minute: ten minutes without a new build is stale
const isKind = (k: string): k is ResourceKind => Object.hasOwn(KIND_INFO, k);
const LANE_VALUES: LaneBy[] = ["env", "vpc", "region", "none"];

function writeUrl(patch: Record<string, string | null | undefined>) {
  const u = new URL(window.location.href);
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    if (v === null || v === "") u.searchParams.delete(k);
    else u.searchParams.set(k, v);
  }
  window.history.replaceState(window.history.state, "", u);
}

export default function CloudMapPage() {
  const router = useRouter();
  const { data, error, isLoading } = useInventory();
  // /map?view=table is the All-resources table: same filters, its own page. Read after hydration (the server can't
  // see the query here), before the first paint.
  const [table, setTable] = useState(false);
  useLayoutEffect(() => {
    const p = new URLSearchParams(window.location.search);
    if (p.get("view") !== "table") return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the URL is only readable after hydration
    setTable(true);
    p.delete("view");
    router.replace(`/resources${p.size ? `?${p}` : ""}`);
  }, [router]);
  return (
    <div className="mx-auto flex h-[calc(100dvh-3.5rem)] min-h-[560px] w-full max-w-[1800px] flex-col gap-3 px-4 pb-4 pt-4 sm:gap-4 sm:px-6 sm:pt-6 max-sm:h-[calc(100dvh-3.25rem-env(safe-area-inset-top))]">
      {table ? (
        <Skeleton className="min-h-0 flex-1 rounded-3xl" />
      ) : error && !data ? (
        <>
          <Header />
          <div className="grid flex-1 place-items-center rounded-3xl border border-line bg-panel">
            <Empty icon={<AlertTriangle className="size-5" />} title={error instanceof ApiError && error.status === 403 ? "You can't see the cloud map" : "Couldn't load the cloud map"} hint={(error as Error).message} />
          </div>
        </>
      ) : isLoading && !data ? (
        <>
          <Header />
          <div className="flex flex-wrap gap-2">
            <Skeleton className="h-9 w-72" />
            <Skeleton className="h-9 w-28" />
            <Skeleton className="h-9 flex-1 sm:max-w-80" />
          </div>
          <Skeleton className="min-h-0 flex-1 rounded-3xl" />
          <Skeleton className="h-10 rounded-2xl" />
        </>
      ) : data ? (
        <CloudMap view={data} />
      ) : null}
    </div>
  );
}

function Header({ view, onRefresh, busy, filtered, tableHref = "/resources" }: { view?: MapInventory; onRefresh?: () => void; busy?: boolean; filtered?: { resources: number; edges: number }; tableHref?: string }) {
  // Re-discovering costs AWS calls: the server allows it from developers up, so viewers don't get the button.
  const canRefresh = !!useMe().data?.perms?.includes("act");
  const multi = (view?.regions?.length ?? 0) > 1;
  return (
    <header className="flex flex-none flex-wrap items-end justify-between gap-x-6 gap-y-2">
      <div className="min-w-0">
        <h1 className="text-[32px] leading-none sm:text-[40px]">Cloud map</h1>
        <p className="mt-2 truncate text-[13.5px] text-fg-3">
          {view ? (
            <>
              {filtered && filtered.resources !== view.resources.length ? `${filtered.resources.toLocaleString()} of ` : ""}
              {view.resources.length.toLocaleString()} resources · {(filtered?.edges ?? view.edges.length).toLocaleString()} connections ·{" "}
              <span className="font-mono">{multi ? `${view.regions!.length} regions` : view.region}</span>
              {view.accountId && <span className="max-sm:hidden"> · account <span className="font-mono">{view.accountId}</span></span>}
            </>
          ) : (
            "Everything the console can see in the account, and how it connects."
          )}
        </p>
      </div>
      {view && (
        <div className="flex items-center gap-2 text-xs text-fg-3">
          <span title={stamp(view.generatedAt)}>
            as of <TimeAgo at={view.generatedAt} />
          </span>
          <Link href={tableHref} className="press inline-flex h-8 items-center gap-1.5 rounded-lg border border-line bg-panel px-2.5 text-[13.5px] font-medium text-fg-2 shadow-card hover:border-line-strong hover:text-fg max-sm:hidden" title="Every resource as a table">
            <Table2 className="size-3.5" /> All resources
          </Link>
          {onRefresh && canRefresh && (
            <>
              <Button size="sm" onClick={onRefresh} disabled={busy} title="Discover the account again now" className="max-sm:hidden">
                <RefreshCw className={cx("size-3.5", busy && "animate-spin")} /> Refresh
              </Button>
              <IconButton label="Discover the account again now" onClick={onRefresh} disabled={busy} className="sm:hidden">
                <RefreshCw className={cx("size-4", busy && "animate-spin")} />
              </IconButton>
            </>
          )}
        </div>
      )}
    </header>
  );
}

function CloudMap({ view }: { view: MapInventory }) {
  const phone = usePhone();
  const toast = useToast();
  const { mutate } = useSWRConfig();
  const [filters, setFilters] = useState<MapFilters>(DEFAULT_FILTERS);
  const [laneBy, setLaneByState] = useState<LaneBy>("env");
  const [mode, setModeState] = useState<"map" | "list">("map");
  const [showAll, setShowAllState] = useState(false);
  const [ready, setReady] = useState(false); // the URL has been read (after hydration)
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [open, setOpen] = useState<string | null>(null);
  const [sheet, setSheet] = useState(false);
  const [busy, setBusy] = useState(false);
  const [canvas, setCanvas] = useState({ w: 0, h: 0 });
  const graph = useRef<GraphHandle>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLDivElement>(null);
  const pending = useRef<{ kind: "center" | "focus"; key: string } | null>(null);
  const [tick, setTick] = useState(0); // wakes the pending-work effect when nothing else changed
  const queue = useCallback((kind: "center" | "focus", key: string) => {
    pending.current = { kind, key };
    setTick((t) => t + 1);
  }, []);
  const lastSelected = useRef<string | null>(null);
  const checkedR = useRef<string | null>(null);
  const q = useDeferredValue(filters.q);
  const { region: globalRegion, setRegion, regions: regionList, multi: multiRegionApi } = useRegionFilter();
  const regions = useMemo(() => (view.regions?.length ? view.regions : regionList), [view.regions, regionList]);
  const multiRegion = regions.length > 1 || multiRegionApi;

  // ---- browser-only state after hydration: URL first, then the saved preferences ----
  useEffect(() => {
    const u = new URLSearchParams(window.location.search);
    const f = filtersFromParams(u, isKind);
    if (!u.has("layers")) {
      const saved = loadLayers();
      if (saved) f.layers = new Set(saved);
    }
    let saved: string | null = null;
    try {
      saved = localStorage.getItem(LANES_KEY);
    } catch {
      /* storage blocked */
    }
    const lanes = u.get("lanes");
    // Lanes are off by default on phones (F23); the old "on"/"off" preference still counts.
    const lane: LaneBy = lanes && (LANE_VALUES as string[]).includes(lanes) ? (lanes as LaneBy) : saved === "off" ? "none" : saved && (LANE_VALUES as string[]).includes(saved) ? (saved as LaneBy) : window.matchMedia("(max-width: 639px)").matches ? "none" : "env";
    const v = u.get("view");
    /* eslint-disable react-hooks/set-state-in-effect -- URL and localStorage are only readable after hydration */
    setFilters(f);
    setLaneByState(lane);
    setModeState(v === "list" || v === "map" ? v : window.matchMedia("(max-width: 639px)").matches ? "list" : "map");
    setShowAllState(u.get("edges") === "all");
    setReady(true);
    const r = u.get("r");
    if (r) {
      setOpen(r);
      lastSelected.current = r;
      queue("center", r);
    }
    /* eslint-enable react-hooks/set-state-in-effect */
    // The command palette navigates here with ?r= and then announces it.
    const onOpen = () => {
      const x = new URLSearchParams(window.location.search).get("r");
      if (x) {
        setOpen(x);
        lastSelected.current = x;
        checkedR.current = null;
        queue("center", x);
      }
    };
    window.addEventListener("console:open", onOpen);
    window.addEventListener("popstate", onOpen);
    return () => {
      window.removeEventListener("console:open", onOpen);
      window.removeEventListener("popstate", onOpen);
    };
  }, [queue]);

  // The console-wide region filter (?region=, shared with the shell) is the map's region filter.
  const region = multiRegion ? (globalRegion === "all" || regions.includes(globalRegion) ? globalRegion : "all") : "all";

  // ---- filters → URL (F44) ----
  useEffect(() => {
    if (!ready) return;
    const p = filtersToParams({ ...filters, region }, new URLSearchParams(window.location.search));
    p.set("lanes", laneBy);
    if (laneBy === (phone ? "none" : "env")) p.delete("lanes");
    if (showAll) p.set("edges", "all");
    else p.delete("edges");
    const s = p.toString();
    if (s !== window.location.search.slice(1)) window.history.replaceState(window.history.state, "", `${window.location.pathname}${s ? `?${s}` : ""}`);
  }, [ready, filters, region, laneBy, showAll, phone]);

  const setLaneBy = (v: LaneBy) => {
    setLaneByState(v);
    try {
      localStorage.setItem(LANES_KEY, v);
    } catch {
      /* storage blocked */
    }
  };
  const setMode = (v: "map" | "list") => {
    setModeState(v);
    writeUrl({ view: v === (phone ? "list" : "map") ? null : v });
  };
  const setLayers = (l: Set<Layer>) => {
    setFilters((f) => ({ ...f, layers: l }));
    saveLayers(l);
  };

  // ---- the header's environment switch and the map's environment filter follow each other ----
  const { env: globalEnv, setEnv } = useEnv();
  const ecsEnvs = useEnvList().data;
  const envIds = useMemo(() => new Set(view.envs.map((e) => e.id)), [view.envs]);
  const prevGlobal = useRef<string | null>(null);
  useEffect(() => {
    if (!globalEnv) return;
    const before = prevGlobal.current;
    prevGlobal.current = globalEnv;
    // Follows a choice made in the shell's environment switch.
    if (before !== null && before !== globalEnv && envIds.has(globalEnv)) setFilters((f) => (f.env === globalEnv ? f : { ...f, env: globalEnv }));
  }, [globalEnv, envIds]);
  const setEnvFilter = (v: string) => {
    setFilters((f) => ({ ...f, env: v }));
    if (v !== globalEnv && ecsEnvs?.some((e) => e.id === v)) {
      setEnv(v);
      writeUrl({ env: v === "all" ? null : v, r: open }); // setEnv drops ?r=; keep the open panel's
    }
  };

  // ---- filters → layout ----
  const hay = useMemo(() => new Map(view.resources.map((r) => [r.key, haystack(r)])), [view.resources]);
  const effective = useMemo(() => ({ ...filters, q, region, env: filters.env === "all" || filters.env === SHARED || envIds.has(filters.env) ? filters.env : "all" }), [filters, q, region, envIds]);
  const filtered = useMemo(() => applyFilters(view.resources, view.edges, effective, hay), [view.resources, view.edges, effective, hay]);
  const envLabels = useMemo(() => Object.fromEntries(view.envs.map((e) => [e.id, e.label])), [view.envs]);
  const envMeta = useMemo(() => Object.fromEntries(view.envs.map((e) => [e.id, { label: e.label, protected: e.protected }])), [view.envs]);
  const laneLabels = useMemo(() => {
    const m: Record<string, string> = {};
    if (laneBy === "vpc") for (const r of view.resources) if (r.kind === "vpc") for (const a of [r.key.match(/vpc-[0-9a-z]+/i)?.[0], ...(r.aliases ?? [])]) if (a && /^vpc-/.test(a)) m[a] = `${r.name} · ${a}`;
    if (laneBy === "region") for (const x of regions) m[x] = regionLabel(x);
    return m;
  }, [laneBy, view.resources, regions]);
  const effLaneBy: LaneBy = laneBy === "region" && !multiRegion ? "env" : laneBy;
  const portrait = phone && canvas.w > 0 && canvas.w / Math.max(1, canvas.h) < 0.8;
  const vp = useMemo(() => (canvas.w && canvas.h ? { w: Math.round(canvas.w / 80) * 80, h: Math.round(canvas.h / 80) * 80 } : undefined), [canvas.w, canvas.h]);
  const layout = useMemo(
    () => layoutGraph(filtered.resources, filtered.edges, { laneBy: effLaneBy, expanded, envLabels, laneLabels, layers: [...effective.layers], regions, orientation: portrait ? "portrait" : "landscape", viewport: vp }),
    [filtered, effLaneBy, expanded, envLabels, laneLabels, effective.layers, regions, portrait, vp],
  );
  const byKey = useMemo(() => new Map(view.resources.map((r) => [r.key, r])), [view.resources]);
  // Joined pass-through connections ("via …") aren't inventory edges: the canvas looks them up here too.
  const edgeById = useMemo(() => new Map([...view.edges, ...filtered.edges].map((e) => [e.id, e])), [view.edges, filtered.edges]);
  const visible = useMemo(() => new Set(filtered.resources.map((r) => r.key)), [filtered.resources]);
  const listed = useMemo(() => (filtered.passThrough.size ? [...filtered.resources, ...view.resources.filter((r) => filtered.passThrough.has(r.key))] : filtered.resources), [filtered, view.resources]);
  // D.9 badges: a resource a non-scaling alarm in ALARM watches (target-tracking alarms fire as part of normal scaling).
  const alarmed = useMemo(() => {
    const s = new Set<string>();
    for (const e of view.edges) {
      if (e.kind !== "monitors") continue;
      const a = byKey.get(e.from);
      if (a?.kind === "cloudwatch-alarm" && a.facts?.alarmState === "ALARM" && a.facts?.scaling !== true) s.add(e.to);
    }
    return s;
  }, [view.edges, byKey]);
  const fitKey = `${effective.env}|${effective.region}|${effective.kinds ? [...effective.kinds].sort().join(",") : "*"}|${effective.q}|${effective.idle}|${effective.problems}|${effLaneBy}|${[...effective.layers].sort().join(",")}|${portrait}`;
  const hasShared = view.resources.some((r) => !r.env && !r.hidden);
  const options = useMemo(() => envOptions(view.envs, hasShared), [view.envs, hasShared]);
  const regionCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of view.resources) if (!r.hidden) m.set(r.region, (m.get(r.region) ?? 0) + 1);
    return m;
  }, [view.resources]);
  // R21: the map says when it is partial, stale or still reading regions.
  const freshness = useMemo(
    () => coverageFreshness({ generatedAt: view.generatedAt, completeness: view.completeness, pendingRegions: view.partial?.pendingRegions, vanishing: view.resources.filter((r) => r.facts?.vanishing === true).length }, STALE_MS),
    [view.generatedAt, view.completeness, view.partial, view.resources],
  );

  useLayoutEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      setCanvas((c) => (Math.abs(c.w - r.width) < 1 && Math.abs(c.h - r.height) < 1 ? c : { w: r.width, h: r.height }));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [mode]);

  // A resource hidden inside a collapsed group (or folded into its parent) is shown by expanding it.
  const reveal = useCallback(
    (key: string) => {
      const node = layout.nodeOf.get(key);
      if (!node || node === key) return;
      setExpanded((s) => new Set([...s, layout.nodeById.get(node)?.type === "group" ? node : parentId(node)]));
    },
    [layout],
  );

  // F44: an ?r= the map doesn't know says so once, and is dropped from the URL.
  useEffect(() => {
    if (!open || checkedR.current === open) return;
    checkedR.current = open;
    if (byKey.has(open)) return;
    toast.push({ tone: "info", title: "That resource is no longer on the map", body: "It may have been deleted, or it is outside what the console reads." }, 6000);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- ?r= is outside input, checked once the inventory has loaded
    setOpen(null);
    writeUrl({ r: null });
  }, [open, byKey, toast]);

  // Work queued for after the next layout (centre on / focus a node that may not exist yet).
  useEffect(() => {
    const p = pending.current;
    if (!p) return;
    const node = layout.nodeOf.get(p.key);
    if (!node) {
      if (!byKey.has(p.key) || !visible.has(p.key)) pending.current = null; // not on the map (filtered out or gone)
      return;
    }
    if (node !== p.key && p.kind === "center") return reveal(p.key); // expand its group first; runs again after
    pending.current = null;
    requestAnimationFrame(() => {
      if (p.kind === "center") graph.current?.centerOn(node, { right: phone ? 0 : Math.min(PANEL_W, window.innerWidth * 0.5) });
      else graph.current?.focusNode(node);
    });
  }, [layout, byKey, visible, reveal, phone, tick]);

  const select = useCallback(
    (key: string, center = true) => {
      setOpen(key);
      lastSelected.current = key;
      checkedR.current = key;
      writeUrl({ r: key });
      if (center) queue("center", key);
    },
    [queue],
  );
  // Connections → focus another resource: the panel switches to it and the map centres it behind the panel.
  const selectFromPanel = useCallback((key: string) => select(key, true), [select]);

  // A service created from the toolbar: discover again and open it. Refreshed a moment ago (429)? The next poll draws it.
  const canCreate = !!useMe().data?.perms?.includes("provision");
  const newEnv = (ecsEnvs?.some((e) => e.id === filters.env) ? filters.env : globalEnv) || ecsEnvs?.[0]?.id || "";
  const onCreated = useCallback(
    (env: string, name: string) => {
      void refreshInventory()
        .then(async (v) => {
          await mutate(INVENTORY_KEY, v, { revalidate: false });
          const r = v.resources.find((x) => x.kind === "ecs-service" && x.env === env && x.key.split("/")[2]?.split("@")[0] === name);
          if (r) select(r.key);
        })
        .catch(() => toast.push({ tone: "info", title: `${name} appears on the map within a minute`, body: "The map was refreshed a moment ago; its next update draws it." }, 6000));
    },
    [mutate, select, toast],
  );
  const newService = canCreate && newEnv ? <NewServiceButton env={newEnv} onCreated={onCreated} compact={phone} /> : null;

  const onActivate = useCallback(
    (n: LayoutNode) => {
      if (n.type === "group") {
        setExpanded((s) => new Set([...s, n.id]));
        if (n.members?.[0]) queue("focus", n.members[0]);
        return;
      }
      select(n.id, false); // the panel is not modal on desktop: clicking another node just switches it (F22)
    },
    [select, queue],
  );
  const onCollapse = useCallback((gid: string) => {
    setExpanded((s) => {
      const x = new Set(s);
      x.delete(gid);
      return x;
    });
  }, []);
  const onCollapseParent = useCallback((key: string) => onCollapse(parentId(key)), [onCollapse]);
  const onShowChildren = useCallback((key: string) => setExpanded((s) => new Set([...s, parentId(key)])), []);
  const close = useCallback(() => {
    setOpen(null);
    writeUrl({ r: null });
    // Focus goes back to the node that was open last (Connections may have moved it since the panel opened).
    if (lastSelected.current && mode === "map") queue("focus", lastSelected.current);
  }, [queue, mode]);

  async function refresh() {
    setBusy(true);
    try {
      const v = await refreshInventory();
      await mutate(INVENTORY_KEY, v, { revalidate: false });
      toast.push({ tone: "ok", title: "Account discovered again", body: `${v.resources.length.toLocaleString()} resources, ${v.edges.length.toLocaleString()} connections.` });
    } catch (e) {
      toast.push({ tone: "error", title: e instanceof ApiError && e.status === 429 ? "Refreshed a moment ago" : "Couldn't refresh", body: (e as Error).message }, 8000);
    } finally {
      setBusy(false);
    }
  }

  // "/" jumps to the search field.
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey || t?.closest("input, textarea, select, [contenteditable]") || document.querySelector("[role=dialog][aria-modal]")) return;
      e.preventDefault();
      searchRef.current?.querySelector("input")?.focus();
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, []);

  const openRes = open ? byKey.get(open) : undefined;
  const selectedNode = open ? (layout.nodeOf.get(open) ?? null) : null;
  const setKinds = (k: Set<ResourceKind> | null) => setFilters((f) => ({ ...f, kinds: k }));
  const active = activeFilterCount(effective) + Number(region !== "all") + Number(!!effective.q.trim());
  const resetFilters = () => {
    setFilters({ ...DEFAULT_FILTERS, layers: new Set(DEFAULT_FILTERS.layers) });
    saveLayers(DEFAULT_FILTERS.layers);
    if (region !== "all") setRegion("all");
  };
  const setRegionFilter = (r: string) => setRegion(r);
  const toggles = (
    <>
      <Toggle on={filters.idle} onChange={(v) => setFilters((f) => ({ ...f, idle: v }))} count={filtered.idleCount}>Idle only</Toggle>
      <Toggle on={filters.problems} onChange={(v) => setFilters((f) => ({ ...f, problems: v }))} count={filtered.problemCount}>Problems only</Toggle>
    </>
  );
  const search = (
    <div ref={searchRef} className="min-w-0 flex-1 sm:min-w-[13rem] sm:max-w-72">
      <SearchField value={filters.q} onChange={(v) => setFilters((f) => ({ ...f, q: v }))} label="Search resources by name, key, tag or endpoint" placeholder="Search name, tag, endpoint…  /" className="w-full" />
    </div>
  );
  const matchCount = filtered.matches?.size ?? 0;
  // All resources with the same search, environment, region, kind (one) and "problems only" (tableFromParams).
  const tableParams = filtersToParams({ ...effective, layers: DEFAULT_FILTERS.layers, edgeConfidence: null, idle: false }).toString();
  const tableHref = `/resources${tableParams ? `?${tableParams}` : ""}`;

  if (!view.resources.length) {
    return (
      <>
        <Header view={view} onRefresh={refresh} busy={busy} />
        <EmptyAccount view={view} />
        <ProvidersFooter providers={view.providers} truncated={view.truncated} regions={regions} />
      </>
    );
  }

  return (
    <>
      <Header view={view} onRefresh={refresh} busy={busy} filtered={{ resources: listed.length, edges: filtered.edges.length }} tableHref={tableHref} />
      {view.sample && (
        <div className="flex flex-none items-start gap-2.5 rounded-2xl border border-dashed border-line-strong px-4 py-2.5 text-[13.5px] leading-relaxed text-fg-2">
          <FlaskConical className="mt-0.5 size-4 flex-none text-fg-3" strokeWidth={1.5} />
          <span>
            <b className="font-medium text-fg">Development sample, not this account.</b> {view.sample === "big" ? "A synthetic account for performance checks" : "The simulated Acme estate"}, shown with <code className="font-mono text-xs">?fixture=</code> or while this server has no inventory API. Details and actions need the real API.
          </span>
        </div>
      )}
      <FreshnessBanner f={freshness} onRetry={() => void mutate(INVENTORY_KEY)} className="flex-none" />

      {/* Toolbar */}
      {phone ? (
        <div className="flex flex-none items-center gap-2">
          {search}
          <FiltersButton count={active - Number(!!effective.q.trim()) + Number(laneBy !== "none")} onClick={() => setSheet(true)} />
          {newService}
        </div>
      ) : (
        <div className="flex flex-none flex-wrap items-center gap-2">
          <EnvFilter value={effective.env} onChange={setEnvFilter} options={options} />
          {multiRegion && <RegionSelect value={region} onChange={setRegionFilter} regions={regions} counts={regionCounts} />}
          <KindPicker selected={filters.kinds} counts={filtered.kindCounts} onChange={setKinds} />
          <LayersPicker on={filters.layers} counts={filtered.layerCounts} onChange={setLayers} />
          <ConnectionsPicker on={filters.edgeConfidence} counts={filtered.confidenceCounts} onChange={(c) => setFilters((f) => ({ ...f, edgeConfidence: c }))} />
          <LanesSelect value={effLaneBy} onChange={setLaneBy} regions={multiRegion} />
          {search}
          {toggles}
          {active > 0 && <ResetChip onClick={resetFilters} count={active} />}
          {newService && <div className="ml-auto">{newService}</div>}
        </div>
      )}
      <AnimatePresence>
        {sheet && (
          <FiltersSheet onClose={() => setSheet(false)}>
            <section className="space-y-2">
              <h3 className="eyebrow">Environment</h3>
              <EnvFilter value={effective.env} onChange={setEnvFilter} options={options} />
            </section>
            {multiRegion && (
              <section className="space-y-2">
                <h3 className="eyebrow">Region</h3>
                <RegionSelect value={region} onChange={setRegionFilter} regions={regions} counts={regionCounts} />
              </section>
            )}
            <section className="flex flex-wrap gap-2">{toggles}</section>
            <section className="space-y-2">
              <h3 className="eyebrow">Lanes</h3>
              <LanesSelect value={effLaneBy} onChange={setLaneBy} regions={multiRegion} />
            </section>
            <section className="space-y-2">
              <h3 className="eyebrow">Layers</h3>
              <LayerList on={filters.layers} counts={filtered.layerCounts} onChange={setLayers} />
            </section>
            <section className="space-y-2">
              <h3 className="eyebrow">Connections</h3>
              <ConnectionList on={filters.edgeConfidence} counts={filtered.confidenceCounts} onChange={(c) => setFilters((f) => ({ ...f, edgeConfidence: c }))} />
            </section>
            <section className="space-y-2">
              <h3 className="eyebrow">Kinds</h3>
              <KindList selected={filters.kinds} counts={filtered.kindCounts} onChange={setKinds} />
            </section>
            {active > 0 && (
              <Button variant="ghost" onClick={resetFilters} className="w-full">Reset filters</Button>
            )}
          </FiltersSheet>
        )}
      </AnimatePresence>

      {/* F44: the match count is announced, and a hit on a switched-off layer is pointed out. */}
      <div aria-live="polite" className="sr-only">
        {effective.q.trim() ? `${matchCount} ${matchCount === 1 ? "match" : "matches"}${filtered.offLayerMatches ? `, ${filtered.offLayerMatches} more on layers that are off` : ""}` : ""}
      </div>
      {effective.q.trim() && filtered.offLayerMatches > 0 && (
        <p className="flex-none text-[13px] text-fg-3">
          {filtered.offLayerMatches} more {filtered.offLayerMatches === 1 ? "match is" : "matches are"} on a layer that is off.{" "}
          <button className="text-accent hover:underline" onClick={() => setLayers(new Set(["network", "security", "observability", "delivery", "other"]))}>Show every layer</button>
        </p>
      )}

      {phone && (
        <div className="flex flex-none items-center justify-between gap-2">
          <Segmented
            id="map-mode"
            size="sm"
            value={mode}
            onChange={setMode}
            options={[
              { value: "list", label: <span className="inline-flex items-center gap-1.5"><ListIcon className="size-3.5" /> List</span> },
              { value: "map", label: <span className="inline-flex items-center gap-1.5"><MapIcon className="size-3.5" /> Map</span> },
            ]}
          />
          <span className="text-xs tabular-nums text-fg-3">{listed.length.toLocaleString()} resources</span>
        </div>
      )}

      {mode === "map" && (
        <a href="#map-sources" className="sr-only rounded-lg bg-panel px-3 py-2 text-[14px] text-fg shadow-float focus:not-sr-only focus:absolute focus:z-30 focus:m-2">
          Skip past the map ({layout.nodes.length} nodes)
        </a>
      )}
      <div ref={canvasRef} className={cx("relative min-h-[320px] flex-1 overflow-hidden rounded-3xl border border-line", mode === "list" && "bg-panel")}>
        {mode === "list" ? (
          <ResourceList resources={listed} envs={view.envs} selected={open} multiRegion={multiRegion} onOpen={(k) => select(k, false)} />
        ) : (
          <Swap id={filtered.resources.length ? "map" : "none"} className="h-full" bodyClassName="h-full">
            {filtered.resources.length ? (
              <Graph
                ref={graph}
                layout={layout}
                byKey={byKey}
                edgeById={edgeById}
                matches={filtered.matches}
                context={filtered.context}
                selected={selectedNode}
                lanes={effLaneBy !== "none"}
                envMeta={envMeta}
                fitKey={fitKey}
                phone={phone}
                alarmed={alarmed}
                showAllEdges={showAll}
                onShowAllEdges={layout.edges.length > DENSE_EDGES ? setShowAllState : undefined}
                onActivate={onActivate}
                onCollapse={onCollapse}
                onCollapseParent={onCollapseParent}
              />
            ) : (
              <div className="grid h-full place-items-center bg-canvas">
                <Empty
                  icon={<MapIcon className="size-5" />}
                  title={effective.q ? `Nothing matches “${effective.q}”` : "No resources match these filters"}
                  hint={
                    <>
                      {effective.q ? "Search looks at names, keys, tags, endpoints and aliases. " : ""}
                      <button onClick={resetFilters} className="text-accent hover:underline">Reset filters</button>
                    </>
                  }
                />
              </div>
            )}
          </Swap>
        )}
      </div>
      <ProvidersFooter id="map-sources" providers={view.providers} truncated={view.truncated} regions={multiRegion ? regions : undefined} />

      <AnimatePresence>{openRes && <MapResourcePanel key={openRes.key} r={openRes} view={view} visible={visible} onClose={close} onSelect={selectFromPanel} onShowChildren={onShowChildren} />}</AnimatePresence>
    </>
  );
}

// The account has nothing the console can see: say why, and where to go next.
function EmptyAccount({ view }: { view: MapInventory }) {
  const denied = view.providers.filter((p) => p.state === "denied");
  const everythingDenied = denied.length > 0 && view.providers.every((p) => p.state !== "ok");
  const where = (view.regions?.length ?? 0) > 1 ? `${view.regions!.length} regions` : view.region;
  return (
    <div className="grid flex-1 place-items-center rounded-3xl border border-line bg-panel px-6 py-10">
      <div className="max-w-lg text-center">
        <div className="mx-auto mb-4 grid size-11 place-items-center rounded-full border border-line text-fg-3">
          <MapIcon className="size-5" strokeWidth={1.5} />
        </div>
        <h2 className="font-display text-[28px] leading-tight">{everythingDenied ? "The console can't read this account yet" : `Nothing found in ${where}`}</h2>
        <p className="mt-2 text-[14px] leading-relaxed text-fg-2">
          {everythingDenied
            ? "AWS denied every discovery call. Give the console's role the read-only policy, then refresh."
            : denied.length
              ? `${denied.length} source${denied.length === 1 ? " was" : "s were"} denied, and the others found no resources. Check the regions and the role's permissions.`
              : "Discovery ran and found no resources. If your account uses other regions, list them in CONSOLE_REGIONS; global services (CloudFront, Route 53) appear once something exists."}
        </p>
        <div className="mt-5 flex flex-wrap justify-center gap-2">
          <Link href="/settings/permissions" className="press inline-flex items-center gap-1.5 rounded-lg bg-primary px-3.5 py-2 text-[14px] font-medium text-primary-fg hover:bg-primary-hover">
            <ShieldCheck className="size-3.5" /> Check permissions
          </Link>
          <Link href="/docs/connect-aws" className="press inline-flex items-center gap-1.5 rounded-lg border border-line px-3.5 py-2 text-[14px] font-medium text-fg-2 hover:border-line-strong hover:text-fg">
            <BookOpen className="size-3.5" /> Connect AWS
          </Link>
        </div>
      </div>
    </div>
  );
}

