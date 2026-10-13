"use client";
// The dashboard grid: 12 columns from `md`, one column on phones in the same order. Each widget spans its width and
// 1–3 rows of 148 px. Below `xl` narrow widgets take half the row so nothing gets squeezed. In edit mode every
// widget carries a toolbar: move up / down, size, configure, remove.
import { ChevronDown, ChevronUp, SlidersHorizontal, Trash2 } from "lucide-react";
import type { ReactNode } from "react";
import { IconButton, cx } from "@/components/ui";
import { WIDGETS, type Height, type Widget, type Width } from "@/lib/dashboards";
import { useRegionNow } from "./data";
import { FrameCtx, WidgetBoundary } from "./frame";
import { WIDGET_VIEWS } from "./widgets";

// Literal class names (Tailwind only generates what it can read in the source).
const COLS: Record<Width, string> = {
  3: "md:col-span-6 xl:col-span-3",
  4: "md:col-span-6 xl:col-span-4",
  6: "md:col-span-6",
  8: "md:col-span-12 xl:col-span-8",
  12: "md:col-span-12",
};
const ROWS: Record<Height, string> = { 1: "row-span-1", 2: "row-span-2", 3: "row-span-3" };

export interface EditHandlers {
  move(id: string, by: -1 | 1): void;
  resize(id: string, w: Width, h: Height): void;
  configure(id: string): void;
  remove(id: string): void;
}

function Toolbar({ w, first, last, on }: { w: Widget; first: boolean; last: boolean; on: EditHandlers }) {
  const spec = WIDGETS[w.type];
  const sizes = spec.widths.flatMap((x) => spec.heights.map((y) => `${x}x${y}`));
  return (
    <div className="flex flex-none items-center gap-0.5 border-b border-line bg-panel-2 px-1.5 py-1">
      <IconButton label="Move up" disabled={first} onClick={() => on.move(w.id, -1)}>
        <ChevronUp className="size-4" />
      </IconButton>
      <IconButton label="Move down" disabled={last} onClick={() => on.move(w.id, 1)}>
        <ChevronDown className="size-4" />
      </IconButton>
      <select
        aria-label="Size (columns × rows)"
        title="Size: columns of 12 × rows"
        value={`${w.w}x${w.h}`}
        onChange={(e) => {
          const [x, y] = e.target.value.split("x").map(Number);
          on.resize(w.id, x as Width, y as Height);
        }}
        className="h-8 min-w-0 rounded-md border border-line bg-panel px-1.5 font-mono text-[12.5px] text-fg-2 outline-none hover:border-line-strong focus:border-accent pointer-coarse:h-10"
      >
        {sizes.map((s) => <option key={s} value={s}>{s.replace("x", " × ")}</option>)}
      </select>
      <span className="ml-auto flex items-center gap-0.5">
        <IconButton label="Configure" onClick={() => on.configure(w.id)}>
          <SlidersHorizontal className="size-3.5" />
        </IconButton>
        <IconButton label="Remove" onClick={() => on.remove(w.id)}>
          <Trash2 className="size-3.5" />
        </IconButton>
      </span>
    </div>
  );
}

export function DashboardGrid({ widgets, edit, empty }: { widgets: Widget[]; edit?: EditHandlers; empty?: ReactNode }) {
  const region = useRegionNow();
  if (!widgets.length) return <>{empty}</>;
  return (
    <div className="grid auto-rows-[148px] grid-cols-1 gap-4 md:grid-cols-12">
      {widgets.map((w, i) => {
        const v = WIDGET_VIEWS[w.type];
        return (
          <div key={w.id} className={cx("min-h-0 min-w-0", COLS[w.w], ROWS[w.h])}>
            <FrameCtx.Provider value={{ widget: w, region, toolbar: edit ? <Toolbar w={w} first={i === 0} last={i === widgets.length - 1} on={edit} /> : undefined }}>
              <WidgetBoundary icon={v.icon}>
                <v.View />
              </WidgetBoundary>
            </FrameCtx.Provider>
          </div>
        );
      })}
    </div>
  );
}
