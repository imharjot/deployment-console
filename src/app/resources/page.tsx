"use client";
// All resources: every row of the cloud map's inventory as one table — including the hidden, table-only and generic
// rows the map never draws — windowed, sortable, filterable, exportable as CSV, with a pin per row and the same
// resource panel as the map. The filters live in the URL (shareable, and /map?view=table lands here with them);
// "Save view" keeps them under a name (the command palette's save dialog). Data: GET /api/inventory (slim rows load
// their detail when opened).
import { AlertTriangle } from "lucide-react";
import { AnimatePresence } from "motion/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useSWRConfig } from "swr";
import { FreshnessBanner } from "@/components/freshness-banner";
import { INVENTORY_KEY, useInventory } from "@/components/map/data";
import { MapResourcePanel } from "@/components/map/resource-panel";
import { DEFAULT_TABLE, ResourceTable, TableLinks, tableFromParams, tableToParams, type TableFilters } from "@/components/map/table";
import { useToast } from "@/components/toast";
import { Empty, Skeleton, TimeAgo } from "@/components/ui";
import { ApiError } from "@/lib/client/api";
import { stamp } from "@/lib/client/format";
import { useRegionFilter } from "@/lib/client/region";
import { coverageFreshness } from "@/lib/inventory/vanish";

const STALE_MS = 10 * 60_000;

export default function ResourcesPage() {
  const { data: view, error, isLoading } = useInventory();
  const { mutate } = useSWRConfig();
  const toast = useToast();
  const { region: globalRegion, setRegion } = useRegionFilter();
  const [filters, setFiltersState] = useState<TableFilters>(DEFAULT_TABLE);
  const [ready, setReady] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  // URL → filters, after hydration (the URL is only readable in the browser).
  useEffect(() => {
    const u = new URLSearchParams(window.location.search);
    /* eslint-disable react-hooks/set-state-in-effect -- URL is only readable after hydration */
    setFiltersState(tableFromParams(u));
    setOpen(u.get("r"));
    setSearch(window.location.search);
    setReady(true);
    /* eslint-enable react-hooks/set-state-in-effect */
  }, []);
  // The console-wide region filter is the table's region filter too.
  const f = useMemo(() => ({ ...filters, region: globalRegion !== "all" ? globalRegion : filters.region === "all" ? "" : filters.region }), [filters, globalRegion]);
  const setFilters = useCallback(
    (next: TableFilters) => {
      setFiltersState(next);
      if ((next.region || "all") !== globalRegion) setRegion(next.region || "all");
    },
    [globalRegion, setRegion],
  );
  useEffect(() => {
    if (!ready) return;
    const p = tableToParams(f, new URLSearchParams(window.location.search));
    for (const k of ["kinds", "problems", "view"]) p.delete(k); // carried over from the map once, then the table's own
    if (open) p.set("r", open);
    else p.delete("r");
    const s = p.toString();
    if (s !== window.location.search.slice(1)) window.history.replaceState(window.history.state, "", `${window.location.pathname}${s ? `?${s}` : ""}`);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- mirrors the URL for "Save view" and the map link
    setSearch(s ? `?${s}` : "");
  }, [ready, f, open]);

  const freshness = useMemo(
    () => (view ? coverageFreshness({ generatedAt: view.generatedAt, completeness: view.completeness, pendingRegions: view.partial?.pendingRegions, vanishing: view.resources.filter((r) => r.facts?.vanishing === true).length }, STALE_MS) : undefined),
    [view],
  );
  const visible = useMemo(() => new Set(view?.resources.filter((r) => !r.hidden).map((r) => r.key) ?? []), [view]);
  const openRes = open && view ? view.resources.find((r) => r.key === open) : undefined;

  // "Save view" is the console's own: the command palette names it and saves this page with the filters in the URL
  // (kept in sync above), so the view shows up with the others under ⌘K.
  const saveView = () => window.dispatchEvent(new Event("console:save-view"));

  // An ?r= the inventory doesn't hold says so once, and is dropped (as on the map).
  useEffect(() => {
    if (!view || !open || view.resources.some((r) => r.key === open)) return;
    toast.push({ tone: "info", title: "That resource is no longer in the inventory", body: "It may have been deleted, or it is outside what the console reads." }, 6000);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- ?r= is outside input, checked once the inventory has loaded
    setOpen(null);
  }, [view, open, toast]);

  return (
    <div className="mx-auto flex h-[calc(100dvh-3.5rem)] min-h-[560px] w-full max-w-[1800px] flex-col gap-3 px-4 pb-4 pt-4 sm:gap-4 sm:px-6 sm:pt-6 max-sm:h-[calc(100dvh-3.25rem-env(safe-area-inset-top))]">
      <header className="flex flex-none flex-wrap items-end justify-between gap-x-6 gap-y-2">
        <div className="min-w-0">
          <h1 className="text-[32px] leading-none sm:text-[40px]">All resources</h1>
          <p className="mt-2 truncate text-[13.5px] text-fg-3">
            {view ? (
              <>
                {view.resources.length.toLocaleString()} rows, including the ones the map doesn&apos;t draw ·{" "}
                <span title={stamp(view.generatedAt)}>
                  as of <TimeAgo at={view.generatedAt} />
                </span>
              </>
            ) : (
              "Every resource the console can see, as a table."
            )}
          </p>
        </div>
        <div className="flex flex-none items-center gap-2">
          <TableLinks search={search} onSave={saveView} />
        </div>
      </header>
      {error && !view ? (
        <div className="grid flex-1 place-items-center rounded-3xl border border-line bg-panel">
          <Empty icon={<AlertTriangle className="size-5" />} title={error instanceof ApiError && error.status === 403 ? "You can't see the inventory" : "Couldn't load the inventory"} hint={(error as Error).message} />
        </div>
      ) : isLoading && !view ? (
        <>
          <Skeleton className="h-9 w-full max-w-3xl" />
          <Skeleton className="min-h-0 flex-1 rounded-2xl" />
        </>
      ) : view ? (
        <>
          <FreshnessBanner f={freshness} onRetry={() => void mutate(INVENTORY_KEY)} className="flex-none" />
          <ResourceTable resources={view.resources} envs={view.envs} regions={view.regions ?? [view.region]} filters={f} onFilters={setFilters} selected={open} onOpen={setOpen} />
        </>
      ) : null}
      <AnimatePresence>
        {openRes && view && (
          <MapResourcePanel
            key={openRes.key}
            r={openRes}
            view={view}
            visible={visible}
            onClose={() => setOpen(null)}
            onSelect={(k) => setOpen(k)}
          />
        )}
      </AnimatePresence>
    </div>
  );
}
