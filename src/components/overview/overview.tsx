"use client";
import Link from "next/link";
import dynamic from "next/dynamic";
import { AnimatePresence, LayoutGroup, motion } from "motion/react";
import { AlertTriangle, ChevronRight, Cloud, Database, FlaskConical, LayoutDashboard, LayoutGrid, Network, Plus, RefreshCw, Server, Table2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import useSWR from "swr";
import { loadedAt, overviewKey, useEnv, useEnvInfo, useEnvList, useOverview } from "@/lib/client/env";
import { clientFreshness, effectiveOverview, keptFreshness } from "@/lib/client/format";
import { useRegions } from "@/lib/client/region";
import { serviceOf, type InventoryView } from "@/lib/inventory/types";
import type { EnvOverview, ResourceView, State } from "@/lib/types";
import { FreshnessBanner } from "../freshness-banner";
import { AnimatedNumber, spring, swap } from "../motion";
import { ResourcePanel } from "../panel/resource-panel";
import { STATE, StateBadge, StateDot, stateStyle } from "../state";
import { Button, Chip, RegionBadge, Segmented, Skeleton, TimeAgo, cx, useClockAt } from "../ui";
import { ResourceCard } from "./card";
import { Topology } from "./topology";

// Create & scale is loaded when the overview first needs it, not with the page (F53).
const NewResourceMenu = dynamic(() => import("../panel/provision").then((m) => m.NewResourceMenu), {
  ssr: false,
  loading: () => (
    <Button size="sm" disabled>
      <Plus className="size-3.5" /> New
    </Button>
  ),
});

const ORDER: State[] = ["DOWN", "DEGRADED", "UNKNOWN", "DEPLOYING", "BOX_STOPPED", "STOPPED", "UP"];

function useOpenParam() {
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => {
    const read = () => setOpen(new URLSearchParams(window.location.search).get("r"));
    read();
    window.addEventListener("popstate", read);
    window.addEventListener("console:open", read);
    return () => {
      window.removeEventListener("popstate", read);
      window.removeEventListener("console:open", read);
    };
  }, []);
  const set = useCallback((key: string | null) => {
    const u = new URL(window.location.href);
    if (key) u.searchParams.set("r", key);
    else u.searchParams.delete("r");
    window.history.replaceState(null, "", u);
    setOpen(key);
  }, []);
  return [open, set] as const;
}

function useViewPref() {
  const [v, setV] = useState<"map" | "grid">("map");
  useEffect(() => {
    let saved: string | null = null;
    try {
      saved = localStorage.getItem("console.view");
    } catch {
      /* storage blocked */
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect -- browser-only preference, read after hydration
    if (saved === "grid" || saved === "map") setV(saved);
    // Nothing chosen yet: phones start on the grid (the map needs a wide screen). Not saved, so a wider window
    // later still opens on the map (F35).
    else if (window.matchMedia?.("(max-width: 639px)").matches) setV("grid");
  }, []);
  const set = useCallback((x: "map" | "grid") => {
    setV(x);
    try {
      localStorage.setItem("console.view", x);
    } catch {
      /* storage blocked */
    }
  }, []);
  return [v, set] as const;
}

// First run against an account with no ECS clusters (or no access yet): explain what to do instead of spinning.
function NoEnvironments({ error }: { error?: string }) {
  return (
    <div className="mx-auto grid min-h-[70vh] w-full max-w-[640px] place-items-center px-6">
      <div className="w-full rounded-3xl border border-line bg-panel p-6 shadow-card sm:p-8">
        <Server className="mb-5 size-5 text-fg-3" strokeWidth={1.5} />
        <h1 className="text-[32px] leading-tight">{error ? "Can't reach AWS" : "No environments found yet"}</h1>
        <p className="mt-1.5 text-[14px] text-fg-3">
          {error ?? "The console turns every ECS cluster in the configured account and region into an environment — none were found."}
        </p>
        <ol className="mt-4 list-decimal space-y-1.5 pl-5 text-[14px] text-fg-2">
          <li>Set <code className="rounded bg-panel-3 px-1">CONSOLE_SOURCE=aws</code> and <code className="rounded bg-panel-3 px-1">AWS_REGION</code> to the region your clusters run in.</li>
          <li>Give the console&apos;s role the read policy in <code className="rounded bg-panel-3 px-1">infra/iam-policy-readonly.json</code> (or the full one for actions).</li>
          <li>Optional: tag clusters <code className="rounded bg-panel-3 px-1">console:env</code> / <code className="rounded bg-panel-3 px-1">console:branch</code> and services <code className="rounded bg-panel-3 px-1">console:repo</code>.</li>
        </ol>
        <div className="mt-5 flex flex-wrap gap-2">
          <Link href="/docs/connect-aws" className="press rounded-lg bg-primary px-3.5 py-2 text-[14px] font-medium text-primary-fg hover:bg-primary-hover">Connect AWS</Link>
          <Link href="/settings/environments" className="press rounded-lg border border-line px-3.5 py-2 text-[14px] font-medium text-fg-2 hover:border-line-strong hover:text-fg">See what was scanned</Link>
        </div>
      </div>
    </div>
  );
}

// An account with no ECS clusters but other resources (a Lambda-only account): point at the views that cover it
// instead of saying nothing was found.
function MapOnly({ count, services }: { count: number; services: string[] }) {
  const link = "press inline-flex items-center gap-1.5 rounded-lg border border-line px-3.5 py-2 text-[14px] font-medium text-fg-2 hover:border-line-strong hover:text-fg";
  return (
    <div className="mx-auto grid min-h-[70vh] w-full max-w-[640px] place-items-center px-6">
      <div className="w-full rounded-3xl border border-line bg-panel p-6 shadow-card sm:p-8">
        <Cloud className="mb-5 size-5 text-fg-3" strokeWidth={1.5} />
        <h1 className="text-[32px] leading-tight">No ECS environments here</h1>
        <p className="mt-1.5 text-[14px] leading-relaxed text-fg-2">
          The console found {count.toLocaleString("en-US")} resource{count === 1 ? "" : "s"} in this account{services.length ? ` (${services.slice(0, 4).join(", ")}${services.length > 4 ? ", …" : ""})` : ""}, but no ECS cluster to turn into an environment. Everything is on the cloud map and in the resources table.
        </p>
        <div className="mt-5 flex flex-wrap gap-2">
          <Link href="/map" className="press inline-flex items-center gap-1.5 rounded-lg bg-primary px-3.5 py-2 text-[14px] font-medium text-primary-fg hover:bg-primary-hover"><Network className="size-3.5" /> Open the cloud map</Link>
          <Link href="/resources" className={link}><Table2 className="size-3.5" /> All resources</Link>
          <Link href="/dashboards" className={link}><LayoutDashboard className="size-3.5" /> Dashboards</Link>
        </div>
        <p className="mt-4 text-xs text-fg-3">Running services on ECS? <Link href="/settings/environments" className="text-accent hover:underline">See what was scanned</Link>.</p>
      </div>
    </div>
  );
}

// No environment: is anything else in the account? (REVIEW "Coverage": a Lambda-only account.)
function NoEnvs({ error }: { error?: string }) {
  const inv = useSWR<InventoryView>(error ? null : "/api/inventory", { revalidateOnFocus: false, shouldRetryOnError: false });
  const shown = Array.isArray(inv.data?.resources) ? inv.data.resources.filter((r) => !r.hidden && r.kind !== "external") : [];
  if (!error && !inv.data && !inv.error) {
    return (
      <div className="mx-auto w-full max-w-[1400px] space-y-6 px-4 pb-10 pt-5 sm:px-6 sm:pt-8">
        <Skeleton className="h-11 w-56" />
        <CanvasSkeleton />
      </div>
    );
  }
  if (!error && shown.length) return <MapOnly count={shown.length} services={[...new Set(shown.map(serviceOf))].filter(Boolean)} />;
  return <NoEnvironments error={error} />;
}

export function Overview() {
  const { env } = useEnv();
  const envInfo = useEnvInfo(env);
  const envList = useEnvList();
  if (envList.error || (envList.data && !envList.data.length)) return <NoEnvs error={envList.error ? (envList.error as Error).message : undefined} />;
  return <EnvOverviewPage env={env} label={envInfo?.label} region={envInfo?.region} />;
}

function EnvOverviewPage({ env, label, region }: { env: string; label?: string; region?: string }) {
  const { data: raw, error, isLoading, mutate, isValidating } = useOverview(env);
  // R21: stale data shows UNKNOWN, never the last good state. One re-render when the data turns stale, not a clock.
  const received = loadedAt(overviewKey(env));
  const now = useClockAt((n) => (raw ? effectiveOverview(raw, n, received).next : undefined));
  // Memoised: a stale view is a new object, and the memoised cards and the topology must not redraw on every render.
  const data = useMemo(() => (raw ? effectiveOverview(raw, now, received).o : undefined), [raw, now, received]);
  const fresh = keptFreshness({ data: raw, error, base: clientFreshness(raw?.freshness, received), loadedAt: received, source: "overview", staleAfterMs: 30_000 });
  const multi = useRegions().multi;
  const [open, setOpen] = useOpenParam();
  const [view, setView] = useViewPref();
  const all = data ? [...data.services, ...data.infra] : [];
  const selected = open ? all.find((r) => r.key === open) : undefined;

  return (
    <LayoutGroup>
      <div className="mx-auto w-full max-w-[1400px] space-y-5 px-4 pb-10 pt-5 sm:space-y-6 sm:px-6 sm:pt-8">
        <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
          <div className="min-w-0">
            <h1 className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[36px] leading-none sm:text-[44px]">
              {label ?? env}
              {multi && region && <RegionBadge region={region} className="font-sans" />}
            </h1>
            <p className="mt-2 truncate font-mono text-[12.5px] text-fg-3">{[data ? data.frame.subtitle : "ECS", region].filter(Boolean).join(" · ")}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2 sm:gap-3">
            <NewResourceMenu env={env} />
            <Segmented
              id="ov-view"
              size="sm"
              value={view}
              onChange={setView}
              options={[
                { value: "map", label: <span className="inline-flex items-center gap-1"><Network className="size-3" />Map</span> },
                { value: "grid", label: <span className="inline-flex items-center gap-1"><LayoutGrid className="size-3" />Grid</span> },
              ]}
            />
            <Link href={`/map?env=${encodeURIComponent(env)}`} title="Everything in the account around this environment: Lambda, queues, buckets, DNS…" className="press inline-flex h-7 items-center gap-1 rounded-lg px-2 text-xs font-medium text-fg-3 hover:bg-panel-3 hover:text-fg-2 pointer-coarse:h-9">
              <Cloud className="size-3" strokeWidth={1.75} /> Cloud map
            </Link>
            {data && <Summary summary={data.summary} />}
            <span className="flex items-center gap-1 text-xs text-fg-3">
              {raw ? <>checked <TimeAgo at={raw.checkedAt} /></> : null}
              <Button size="sm" variant="ghost" onClick={() => mutate()} aria-label="Refresh now" title="Refresh now" className="!px-2">
                <RefreshCw className={cx("size-3.5", isValidating && "animate-spin")} strokeWidth={1.75} />
              </Button>
            </span>
          </div>
        </div>

        <FreshnessBanner f={fresh} onRetry={() => void mutate()} />

        {data?.source === "mock" && (
          <div className="flex items-start gap-2.5 rounded-2xl border border-dashed border-line-strong px-4 py-3 text-[14px] leading-relaxed text-fg-2">
            <FlaskConical className="mt-0.5 size-4 flex-none text-fg-3" strokeWidth={1.5} />
            <span>
              <b className="text-fg">Mock data.</b> Simulated clusters, rollouts and logs (<code className="font-mono text-xs">CONSOLE_SOURCE=mock</code>). Actions change the simulation only.
            </span>
          </div>
        )}

        {error && !data && (
          <div className="flex items-center gap-2 rounded-2xl border border-down/30 px-4 py-3 text-[14px] text-down">
            <AlertTriangle className="size-4 flex-none" strokeWidth={1.75} /> {(error as Error).message}
          </div>
        )}

        {/* Env, view and skeleton→content changes crossfade in place (no sideways slide). Keyed by the env
            the data belongs to: SWR keeps the old env's data while the new one loads, and reusing those
            card instances would glide them into the new layout. */}
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.div key={`${data?.env ?? env}:${view}:${data ? "ready" : "loading"}`} {...swap} className="space-y-6">
            {isLoading && !data ? <CanvasSkeleton /> : data ? view === "map" && data.topology ? <Topology o={data} onOpen={setOpen} /> : <Canvas o={data} onOpen={setOpen} /> : null}
          </motion.div>
        </AnimatePresence>
      </div>

      <AnimatePresence>{selected && data && <ResourcePanel key={selected.key} r={selected} overview={data} onClose={() => setOpen(null)} onOpen={setOpen} />}</AnimatePresence>
    </LayoutGroup>
  );
}

function Summary({ summary }: { summary: Record<State, number> }) {
  return (
    <motion.div layout transition={spring} className="relative flex items-center gap-0.5 rounded-lg border border-line px-1 py-0.5">
      <AnimatePresence mode="popLayout" initial={false}>
        {ORDER.filter((s) => summary[s] > 0).map((s) => (
          <motion.span
            key={s}
            layout="position"
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.9 }}
            transition={spring}
            className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs"
            style={stateStyle(s)}
            title={STATE[s].label}
          >
            <StateDot state={s} className="!size-1.5" />
            <AnimatedNumber value={summary[s]} className="font-medium text-fg" />
            <span className="text-fg-3">{STATE[s].label.toLowerCase()}</span>
          </motion.span>
        ))}
      </AnimatePresence>
    </motion.div>
  );
}

// A group of resources on one host or platform: a faint well with a quiet header.
function Frame({ title, subtitle, icon, state, onOpen, children, action }: { title: string; subtitle: string; icon: React.ReactNode; state?: State; onOpen?: () => void; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <section style={state ? stateStyle(state) : undefined} className="relative min-w-0 rounded-3xl border border-line bg-panel-2/40 p-3 sm:p-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3 px-1 pt-1 sm:px-0 sm:pt-0">
        <button onClick={onOpen} disabled={!onOpen} className={cx("group flex min-w-0 items-center gap-3 rounded-xl text-left disabled:cursor-default", onOpen && "press [--press-scale:0.98]")}>
          <span className="text-fg-3">{icon}</span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2 text-[16px] font-medium tracking-[-0.01em]">
              {title}
              {state && <StateBadge state={state} />}
              {onOpen && <ChevronRight className="size-4 text-fg-3 transition-transform group-hover:translate-x-0.5" />}
            </div>
            <div className="truncate text-xs text-fg-3">{subtitle}</div>
          </div>
        </button>
        {action}
      </div>
      {children}
    </section>
  );
}

// Supporting services (a proxy, a cache in a container) come from discovery metadata (F38); servers that don't send
// it fall back to the old name list.
const PLATFORM_IDS = ["caddy", "redis"];
const isPlatform = (s: ResourceView, known: boolean) => (known ? !!s.infra : PLATFORM_IDS.includes(s.id));

function Canvas({ o, onOpen }: { o: EnvOverview; onOpen: (k: string) => void }) {
  const known = o.services.some((s) => s.infra !== undefined);
  const apps = o.services.filter((s) => !isPlatform(s, known));
  const platform = o.services.filter((s) => isPlatform(s, known));
  const hosts = o.infra.filter((r) => r.kind === "box");
  const box = o.infra.find((r) => r.kind === "box");
  const lb = o.infra.find((r) => r.kind === "loadbalancer");
  const data = o.infra.filter((r) => r.kind !== "box" && r.kind !== "loadbalancer");
  const grid = "stagger grid gap-3 sm:grid-cols-2 sm:gap-4 xl:grid-cols-3";

  const compute = (
    <div className="space-y-5">
      {lb && (
        <div>
          <div className="eyebrow mb-2 px-1">Ingress</div>
          <div className={grid}>
            <ResourceCard r={lb} onOpen={onOpen} />
          </div>
        </div>
      )}
      <div className={grid}>
        {apps.map((r) => (
          <ResourceCard key={r.key} r={r} onOpen={onOpen} />
        ))}
      </div>
      {hosts.length > 1 && (
        <div>
          <div className="eyebrow mb-2 px-1">EC2 hosts</div>
          <div className={grid}>
            {hosts.map((r) => (
              <ResourceCard key={r.key} r={r} onOpen={onOpen} compact />
            ))}
          </div>
        </div>
      )}
      {platform.length > 0 && (
        <div>
          <div className="eyebrow mb-2 px-1">Platform containers</div>
          <div className={grid}>
            {platform.map((r) => (
              <ResourceCard key={r.key} r={r} onOpen={onOpen} compact />
            ))}
          </div>
        </div>
      )}
    </div>
  );

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-6 xl:grid-cols-[minmax(0,1fr)_320px]">
      {o.frame.kind === "box" ? (
        <Frame
          title={o.frame.title}
          subtitle={box ? `${box.subtitle} · ${o.frame.subtitle}` : o.frame.subtitle}
          icon={<Server className="size-4" strokeWidth={1.5} />}
          state={box?.state}
          onOpen={box ? () => onOpen(box.key) : undefined}
          action={box && <Chip mono>{box.stats.map((s) => `${s.value} ${s.label}`).join(" · ")}</Chip>}
        >
          {compute}
        </Frame>
      ) : (
        <Frame title={o.frame.title} subtitle={o.frame.subtitle} icon={<Cloud className="size-4" strokeWidth={1.5} />}>
          {compute}
        </Frame>
      )}
      <div className="min-w-0 space-y-4">
        <Frame title="Data" subtitle="Managed stores" icon={<Database className="size-4" strokeWidth={1.5} />}>
          <div className="space-y-3">
            {data.map((r) => (
              <DataCard key={r.key} r={r} onOpen={onOpen} />
            ))}
          </div>
        </Frame>
      </div>
    </div>
  );
}

function DataCard({ r, onOpen }: { r: ResourceView; onOpen: (k: string) => void }) {
  return <ResourceCard r={r} onOpen={onOpen} />;
}

function CanvasSkeleton() {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-6 xl:grid-cols-[minmax(0,1fr)_320px]">
      <div className="rounded-3xl border border-line p-3 sm:p-5">
        <Skeleton className="mb-5 h-9 w-64" />
        <div className="grid gap-3 sm:grid-cols-2 sm:gap-4 xl:grid-cols-3">
          {Array.from({ length: 3 }, (_, i) => (
            <Skeleton key={i} className="h-44 rounded-2xl" />
          ))}
        </div>
      </div>
      <div className="rounded-3xl border border-line p-3 sm:p-5">
        <Skeleton className="mb-5 h-9 w-40" />
        <Skeleton className="h-44 rounded-2xl" />
      </div>
    </div>
  );
}
