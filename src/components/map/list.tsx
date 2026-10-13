"use client";
// The cloud map as a list (F23): phones open on it, because a map of hundreds of nodes is unreadable at phone width.
// Grouped by environment (production first, Shared last), then by category; problems first inside each group. Rows
// are at least 44 px tall (health, name, kind and the reason something is wrong), and tapping one opens the same
// panel as the map. Windowed: only the rows on screen (plus a margin) are rendered.
import { ChevronRight } from "lucide-react";
import { createElement, memo, useLayoutEffect, useMemo, useRef, useState } from "react";
import { SHARED_LANE, laneOrder } from "@/lib/inventory/layout";
import { CATEGORY_LABEL, CATEGORY_ORDER, categoryOf, kindLabelOf, type Category, type InventoryView, type Resource } from "@/lib/inventory/types";
import { catHue } from "../hue";
import { cx } from "../ui";
import { REMOTE_TEXT, isRemote } from "./chips";
import { HEALTH, HealthDot, healthStyle, iconOf, isProblem } from "./kinds";

const H_ENV = 44;
const H_CAT = 30;
const H_ROW = 60;
const OVERSCAN = 600; // px above and below the screen

type Row = { t: "env"; id: string; label: string; count: number; problems: number; protected?: boolean } | { t: "cat"; id: string; label: string; count: number } | { t: "res"; r: Resource };

export function listRows(resources: readonly Resource[], envs: InventoryView["envs"]): Row[] {
  const labels = Object.fromEntries(envs.map((e) => [e.id, e.label]));
  const byEnv = new Map<string, Resource[]>();
  for (const r of resources) {
    const k = r.env || SHARED_LANE;
    (byEnv.get(k) ?? byEnv.set(k, []).get(k)!).push(r);
  }
  const rows: Row[] = [];
  for (const env of laneOrder(byEnv.keys(), labels)) {
    const list = byEnv.get(env)!;
    const meta = envs.find((e) => e.id === env);
    rows.push({ t: "env", id: env, label: env === SHARED_LANE ? "Shared" : (labels[env] ?? env), count: list.length, problems: list.filter((r) => isProblem(r.health)).length, protected: meta?.protected });
    const byCat = new Map<Category, Resource[]>();
    for (const r of list) {
      const c = categoryOf(r);
      (byCat.get(c) ?? byCat.set(c, []).get(c)!).push(r);
    }
    for (const c of CATEGORY_ORDER) {
      const items = byCat.get(c);
      if (!items) continue;
      rows.push({ t: "cat", id: `${env}:${c}`, label: CATEGORY_LABEL[c], count: items.length });
      items.sort((a, b) => Number(isProblem(b.health)) - Number(isProblem(a.health)) || HEALTH[a.health].rank - HEALTH[b.health].rank || a.name.localeCompare(b.name) || (a.key < b.key ? -1 : 1));
      for (const r of items) rows.push({ t: "res", r });
    }
  }
  return rows;
}

const heightOf = (row: Row) => (row.t === "env" ? H_ENV : row.t === "cat" ? H_CAT : H_ROW);

export function ResourceList({ resources, envs, selected, multiRegion, onOpen }: { resources: readonly Resource[]; envs: InventoryView["envs"]; selected: string | null; multiRegion: boolean; onOpen(key: string): void }) {
  const rows = useMemo(() => listRows(resources, envs), [resources, envs]);
  const offsets = useMemo(() => {
    const o = new Array<number>(rows.length + 1);
    o[0] = 0;
    for (let i = 0; i < rows.length; i++) o[i + 1] = o[i] + heightOf(rows[i]);
    return o;
  }, [rows]);
  const box = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ top: 0, h: 800 });
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    let frame = 0;
    const read = () => {
      frame = 0;
      setView((v) => (Math.abs(v.top - el.scrollTop) < 40 && v.h === el.clientHeight ? v : { top: el.scrollTop, h: el.clientHeight }));
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
  // First row whose bottom is below the window's top (binary search over the offsets).
  const first = (() => {
    const y = Math.max(0, view.top - OVERSCAN);
    let lo = 0, hi = rows.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (offsets[mid + 1] <= y) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  })();
  const shown: number[] = [];
  for (let i = first; i < rows.length && offsets[i] < view.top + view.h + OVERSCAN; i++) shown.push(i);

  if (!rows.length) return <p className="grid h-full place-items-center p-6 text-[14px] text-fg-3">No resources match these filters.</p>;
  return (
    <div ref={box} className="h-full overflow-y-auto overscroll-contain" role="list" aria-label={`${resources.length} resources`}>
      <div className="relative" style={{ height: offsets[rows.length] }}>
        {shown.map((i) => {
          const row = rows[i];
          const style = { position: "absolute" as const, top: offsets[i], left: 0, right: 0, height: heightOf(row) };
          if (row.t === "env")
            return (
              <div key={`e:${row.id}`} style={style} role="presentation" className="flex items-end gap-2 border-b border-line bg-canvas px-4 pb-1.5">
                <span className="font-display text-[18px] leading-none text-fg">{row.label}</span>
                {row.protected && <span className="text-[12px] text-down">protected</span>}
                <span className="text-[13px] tabular-nums text-fg-3">{row.count.toLocaleString()}</span>
                {row.problems > 0 && <span className="ml-auto text-[13px] text-down">{row.problems} with problems</span>}
              </div>
            );
          if (row.t === "cat")
            return (
              <div key={`c:${row.id}`} style={style} role="presentation" className="eyebrow flex items-center gap-1.5 bg-canvas px-4 pt-2">
                {row.label} <span className="font-normal normal-case tracking-normal text-fg-3">{row.count}</span>
              </div>
            );
          return <ListRow key={row.r.key} r={row.r} style={style} selected={selected === row.r.key} multiRegion={multiRegion} onOpen={onOpen} />;
        })}
      </div>
    </div>
  );
}

const ListRow = memo(function ListRow({ r, style, selected, multiRegion, onOpen }: { r: Resource; style: React.CSSProperties; selected: boolean; multiRegion: boolean; onOpen(key: string): void }) {
  const problem = isProblem(r.health);
  const remote = isRemote(r);
  const line = remote ? REMOTE_TEXT : r.health !== "ok" && r.healthReason ? r.healthReason : r.idle ? `idle: ${r.idle.why}` : undefined;
  return (
    <div role="listitem" style={style} className="px-2">
      <button
        type="button"
        onClick={() => onOpen(r.key)}
        aria-current={selected ? "true" : undefined}
        style={healthStyle(r.health)}
        className={cx("press flex h-[56px] w-full items-center gap-3 rounded-xl px-2.5 text-left [--press-scale:0.99] hover:bg-panel-2", selected && "bg-accent-soft", remote && "opacity-80")}
      >
        {createElement(iconOf(r), { className: "hue-text size-4 flex-none", style: catHue(categoryOf(r)), strokeWidth: 1.7, "aria-hidden": true })}
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="min-w-0 truncate text-[15px] font-medium text-fg">{r.name}</span>
            <HealthDot health={r.health} still className="!size-2 flex-none" />
          </span>
          <span className="flex min-w-0 items-center gap-1.5 text-[13px] leading-4">
            <span className="flex-none text-fg-3">{kindLabelOf(r)}{multiRegion && r.region !== "global" ? ` · ${r.region}` : ""}</span>
            {line && <span className={cx("min-w-0 truncate", problem ? "text-[var(--dot)]" : "text-fg-3")}>· {line}</span>}
          </span>
        </span>
        <ChevronRight className="size-4 flex-none text-fg-3" aria-hidden />
      </button>
    </div>
  );
});
