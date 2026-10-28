"use client";
// All resources (/resources, and /map?view=table): every row the inventory holds — including hidden, table-only and
// generic ones the map never draws — as one windowed, sortable, filterable table. Slim rows (sent without their
// properties) load their detail when opened. Filters live in the URL; "Save view" keeps them under a name (saved
// views), CSV exports what is shown. Pure helpers (filtering, sorting, CSV) are exported for tests.
import { Download, EyeOff, Map as MapIcon, Save, SlidersHorizontal } from "lucide-react";
import Link from "next/link";
import { createElement, memo, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { CATEGORY_LABEL, CATEGORY_ORDER, categoryOf, kindLabelOf, serviceOf, type Category, type Health, type Resource } from "@/lib/inventory/types";
import { SHARED, haystack } from "./filter";
import { kindKeyOf, sourceOf, tableRows, toCsv, type SortKey, type TableFilters } from "./table-rules";
import { regionLabel } from "@/lib/client/region";
import { PinButton } from "../pin-button";
import { catHue } from "../hue";
import { Button, cx } from "../ui";
import { REMOTE_TEXT, isRemote, isVanishing } from "./chips";
export { DEFAULT_TABLE, tableFromParams, tableToParams, type TableFilters } from "./table-rules";
import { HEALTH, HealthDot, healthStyle, iconOf, isProblem } from "./kinds";
import { Select } from "@/components/select";
import { SearchField } from "@/app/_components/fields";

// ---- the table ----
const ROW_H = 44;
const OVERSCAN = 12;

export interface TableProps {
  resources: readonly Resource[];
  envs: { id: string; label: string; protected: boolean }[];
  regions: string[];
  filters: TableFilters;
  onFilters(f: TableFilters): void;
  selected: string | null;
  onOpen(key: string): void;
  toolbarEnd?: ReactNode;
}

export function ResourceTable({ resources, envs, regions, filters: f, onFilters, selected, onOpen, toolbarEnd }: TableProps) {
  const hay = useMemo(() => new Map(resources.map((r) => [r.key, haystack(r)])), [resources]);
  const rows = useMemo(() => tableRows(resources, f, hay), [resources, f, hay]);
  const hiddenCount = useMemo(() => resources.filter((r) => r.hidden).length, [resources]);
  const options = useMemo(() => {
    const kinds = new Map<string, string>(), services = new Set<string>(), cats = new Set<Category>(), sources = new Set<string>();
    for (const r of resources) {
      kinds.set(kindKeyOf(r), kindLabelOf(r));
      services.add(serviceOf(r));
      cats.add(categoryOf(r));
      sources.add(sourceOf(r));
    }
    return {
      kinds: [...kinds].sort((a, b) => a[1].localeCompare(b[1])),
      services: [...services].sort((a, b) => a.localeCompare(b)),
      cats: CATEGORY_ORDER.filter((c) => cats.has(c)),
      sources: [...sources].sort(),
    };
  }, [resources]);
  const multiRegion = regions.length > 1;
  const [more, setMore] = useState(false); // phones: the filter selects fold away
  const activeCount = [f.kind, f.service, f.category, f.region && f.region !== "all" ? f.region : "", f.env, f.health, f.source].filter(Boolean).length;
  const set = (patch: Partial<TableFilters>) => onFilters({ ...f, ...patch });
  const sortBy = (k: SortKey) => set(f.sort === k ? { dir: f.dir === 1 ? -1 : 1 } : { sort: k, dir: 1 });

  const box = useRef<HTMLDivElement>(null);
  const [win, setWin] = useState({ top: 0, h: 600 });
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    let frame = 0;
    const read = () => {
      frame = 0;
      setWin((w) => (Math.abs(w.top - el.scrollTop) < ROW_H * 4 && w.h === el.clientHeight ? w : { top: el.scrollTop, h: el.clientHeight }));
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(read);
    };
    read();
    el.addEventListener("scroll", onScroll, { passive: true });
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", onScroll);
      ro.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);
  const first = Math.max(0, Math.floor(win.top / ROW_H) - OVERSCAN);
  const last = Math.min(rows.length, Math.ceil((win.top + win.h) / ROW_H) + OVERSCAN);

  const exportCsv = () => {
    const blob = new Blob([toCsv(rows)], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `resources-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  const sel = (label: string, value: string, onChange: (v: string) => void, items: [string, string][]) => (
    <label className="flex h-9 min-w-0 flex-none items-center gap-1.5 rounded-lg border border-line bg-panel pl-2.5 text-[14px] text-fg-2 hover:border-line-strong pointer-coarse:h-10">
      {label}
      <Select
        value={value}
        onChange={onChange}
        aria-label={label}
        base={cx("h-full max-w-[11rem] cursor-pointer rounded-r-lg bg-transparent pr-2 outline-none", value ? "text-fg" : "text-fg-3")}
        options={[{ value: "", label: "Any" }, ...items.map(([v, l]) => ({ value: v, label: l }))]}
      />
    </label>
  );
  const head = (k: SortKey, label: string, cls?: string) => (
    <th scope="col" aria-sort={f.sort === k ? (f.dir === 1 ? "ascending" : "descending") : undefined} className={cx("whitespace-nowrap px-3 py-2 font-medium", cls)}>
      <button type="button" onClick={() => sortBy(k)} className="inline-flex items-center gap-1 rounded hover:text-fg">
        {label}
        <span aria-hidden className={cx("text-[10px]", f.sort === k ? "text-fg-2" : "text-transparent")}>{f.dir === 1 ? "▲" : "▼"}</span>
      </button>
    </th>
  );
  const cols = multiRegion ? "grid-cols-[2.25rem_minmax(12rem,2fr)_minmax(8rem,1.1fr)_minmax(6rem,0.9fr)_minmax(6rem,0.8fr)_minmax(6rem,0.8fr)_minmax(6rem,0.7fr)_minmax(7rem,1.4fr)_minmax(6rem,0.7fr)]" : "grid-cols-[2.25rem_minmax(12rem,2fr)_minmax(8rem,1.1fr)_minmax(6rem,0.9fr)_minmax(6rem,0.8fr)_minmax(6rem,0.8fr)_minmax(7rem,1.4fr)_minmax(6rem,0.7fr)]";

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex flex-none flex-wrap items-center gap-2">
        <SearchField value={f.q} onChange={(q) => set({ q })} label="Search resources by name, key, tag or endpoint" placeholder="Search…" className="flex-1 sm:max-w-72" />
        <button type="button" onClick={() => setMore((m) => !m)} aria-expanded={more} className="press flex h-10 flex-none items-center gap-1.5 rounded-lg border border-line bg-panel px-3 text-[14px] text-fg-2 sm:hidden">
          <SlidersHorizontal className="size-4" /> Filters{activeCount ? ` · ${activeCount}` : ""}
        </button>
        <div className={cx("contents", !more && "max-sm:hidden")}>
        {sel("Kind", f.kind, (v) => set({ kind: v }), options.kinds)}
        {sel("Service", f.service, (v) => set({ service: v }), options.services.map((x) => [x, x]))}
        {sel("Category", f.category, (v) => set({ category: v }), options.cats.map((c) => [c, CATEGORY_LABEL[c]]))}
        {multiRegion && sel("Region", f.region === "all" ? "" : f.region, (v) => set({ region: v }), regions.map((r) => [r, regionLabel(r)]))}
        {sel("Environment", f.env, (v) => set({ env: v }), [...envs.map((e) => [e.id, e.label] as [string, string]), [SHARED, "Shared"]])}
        {sel("Health", f.health, (v) => set({ health: v }), [["problems", "Problems (error or warning)"], ...(["error", "warning", "unknown", "stopped", "ok"] as Health[]).map((h) => [h, HEALTH[h].label] as [string, string])])}
        {sel("Source", f.source, (v) => set({ source: v }), options.sources.map((x) => [x, SOURCE_LABEL[x] ?? x]))}
        </div>
        {hiddenCount > 0 && (
          <label className="flex h-9 flex-none cursor-pointer items-center gap-2 rounded-lg border border-line bg-panel px-2.5 text-[14px] text-fg-2 hover:border-line-strong pointer-coarse:h-10" title="AWS-managed keys, service roles and table-only types: listed here, never drawn on the map">
            <input type="checkbox" checked={f.hidden} onChange={(e) => set({ hidden: e.target.checked })} className="size-3.5" />
            <EyeOff className="size-3.5 text-fg-3" /> Hidden <span className="tabular-nums text-fg-3">{hiddenCount}</span>
          </label>
        )}
        <div className="ml-auto flex flex-none items-center gap-2">
          <span className="text-xs tabular-nums text-fg-3" aria-live="polite">{rows.length.toLocaleString()} of {resources.length.toLocaleString()}</span>
          <Button size="sm" onClick={exportCsv} title="Download the rows shown as CSV">
            <Download className="size-3.5" /> CSV
          </Button>
          {toolbarEnd}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-hidden rounded-2xl border border-line bg-panel">
        <div ref={box} className="h-full overflow-auto overscroll-contain">
          <table className="w-full min-w-[900px] table-fixed text-[13.5px]" aria-rowcount={rows.length + 1}>
            <thead className="eyebrow sticky top-0 z-[1] border-b border-line bg-panel text-left">
              <tr className={cx("grid", cols)}>
                <th scope="col" className="px-2 py-2"><span className="sr-only">Pin</span></th>
                {head("name", "Name")}
                {head("kind", "Kind")}
                {head("service", "Service")}
                {head("category", "Category")}
                {head("env", "Environment")}
                {multiRegion && head("region", "Region")}
                {head("health", "Health")}
                {head("source", "Source")}
              </tr>
            </thead>
            <tbody className="relative block" style={{ height: rows.length * ROW_H }}>
              {rows.slice(first, last).map((r, i) => (
                <TableRow key={r.key} r={r} top={(first + i) * ROW_H} cols={cols} index={first + i + 2} multiRegion={multiRegion} envLabel={envs.find((e) => e.id === r.env)?.label ?? r.env ?? "Shared"} selected={selected === r.key} onOpen={onOpen} />
              ))}
            </tbody>
          </table>
          {!rows.length && <p className="px-4 py-6 text-center text-[14px] text-fg-3">No resources match these filters.</p>}
        </div>
      </div>
    </div>
  );
}

const SOURCE_LABEL: Record<string, string> = { provider: "Provider", "resource-explorer": "Resource Explorer", tagging: "Tagging API", config: "AWS Config", cloudcontrol: "Cloud Control", reference: "Reference" };

const TableRow = memo(function TableRow({ r, top, cols, index, multiRegion, envLabel, selected, onOpen }: { r: Resource; top: number; cols: string; index: number; multiRegion: boolean; envLabel: string; selected: boolean; onOpen(key: string): void }) {
  const problem = isProblem(r.health);
  const reason = isRemote(r) ? REMOTE_TEXT : r.healthReason;
  return (
    <tr
      aria-rowindex={index}
      style={{ position: "absolute", top, left: 0, right: 0, height: ROW_H, ...healthStyle(r.health) }}
      className={cx("grid items-center border-b border-line hover:bg-panel-2/60", cols, selected && "bg-accent-soft", (r.hidden || isVanishing(r)) && "text-fg-3")}
    >
      <td className="px-2">
        <PinButton rkey={r.key} name={r.name} kind={r.kind} env={r.env} region={r.region === "global" ? undefined : r.region} size="sm" />
      </td>
      <td className="min-w-0 px-3">
        <button type="button" onClick={() => onOpen(r.key)} className="flex w-full min-w-0 items-center gap-2 text-left" title={`${r.name} · ${r.key}`}>
          {createElement(iconOf(r), { className: "hue-text size-3.5 flex-none", style: catHue(categoryOf(r)), strokeWidth: 1.7, "aria-hidden": true })}
          <span className="min-w-0 flex-1 truncate font-medium text-fg hover:text-accent">{r.name}</span>
          {r.hidden && <span className="flex-none rounded border border-line px-1 text-[11px] text-fg-3">hidden</span>}
          {r.slim && <span className="sr-only">(details load when opened)</span>}
        </button>
      </td>
      <td className="truncate px-3 text-fg-2">{kindLabelOf(r)}</td>
      <td className="truncate px-3 text-fg-2">{serviceOf(r)}</td>
      <td className="truncate px-3 text-fg-3">{CATEGORY_LABEL[categoryOf(r)]}</td>
      <td className="truncate px-3 font-mono text-[12.5px] text-fg-2">{envLabel}</td>
      {multiRegion && <td className="truncate px-3 font-mono text-[12.5px] text-fg-2">{r.region}</td>}
      <td className="min-w-0 px-3">
        <span className="flex min-w-0 items-center gap-1.5" title={reason}>
          <HealthDot health={r.health} still className="!size-2 flex-none" />
          <span className={cx("truncate", problem ? "text-[var(--dot)]" : "text-fg-2")}>{problem && reason ? reason : HEALTH[r.health].label}</span>
        </span>
      </td>
      <td className="truncate px-3 text-fg-3">{SOURCE_LABEL[sourceOf(r)] ?? sourceOf(r)}</td>
    </tr>
  );
});

// Header actions for /resources: back to the map with the same filters, and "Save view".
export function TableLinks({ search, onSave, saving }: { search: string; onSave?: () => void; saving?: boolean }) {
  const p = new URLSearchParams(search);
  const map = new URLSearchParams();
  for (const k of ["q", "env", "region"]) if (p.get(k)) map.set(k, p.get(k)!);
  if (p.get("health") === "problems") map.set("problems", "1");
  return (
    <>
      {onSave && (
        <Button size="sm" onClick={onSave} disabled={saving} title="Keep these filters under a name (Saved views)">
          <Save className="size-3.5" /> Save view
        </Button>
      )}
      <Link href={`/map${map.size ? `?${map}` : ""}`} className="press inline-flex h-8 items-center gap-1.5 rounded-lg border border-line bg-panel px-2.5 text-[13.5px] font-medium text-fg-2 shadow-card hover:border-line-strong hover:text-fg">
        {createElement(MapIcon, { className: "size-3.5" })} Map
      </Link>
    </>
  );
}
