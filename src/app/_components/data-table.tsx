"use client";
// One markup for tabular data: a real <table> when its container is wide, a stack of cards when it is narrow
// (< 42rem: phones, or a tablet beside the sidebar). It is a container query, not a viewport one, so the same
// table reflows wherever it is placed. Every cell stays available; `slot` only says where it sits on a card.
import { clsx } from "clsx";
import { AnimatePresence } from "motion/react";
import type { ReactNode } from "react";
import { Row } from "@/components/motion";

/**
 * Where a column goes on a card:
 * - title: first line, the row's name · end: first line, right-aligned (a status)
 * - line: its own full-width line · meta: small text, several on one line (who, when); prefixed with `label` if set
 * - field: full-width line labelled with the column header · actions: last line, right-aligned
 */
export type CardSlot = "title" | "end" | "line" | "meta" | "field" | "actions";

export interface Column<T> {
  key: string;
  header: ReactNode;
  /** Card label: for `field` cells when `header` is not plain text; for `meta` cells, an inline prefix. */
  label?: string;
  slot?: CardSlot;
  className?: string;
  /** Return null/undefined/"" for "no value": the table shows a dash, the card leaves the line out. */
  cell(row: T, index: number): ReactNode;
}

// Cards are a wrapping flex row; `order` places slots regardless of the column order the table uses, and a
// zero-height full-width ::before (order 3) ends the first line after title + end.
const CARD =
  "@max-2xl:flex @max-2xl:flex-wrap @max-2xl:items-center @max-2xl:gap-x-3 @max-2xl:gap-y-1.5 @max-2xl:px-4 @max-2xl:py-3.5 @max-2xl:before:order-3 @max-2xl:before:basis-full @max-2xl:before:content-['']";
const SLOT: Record<CardSlot, string> = {
  title: "@max-2xl:order-1 @max-2xl:min-w-0 @max-2xl:flex-1",
  end: "@max-2xl:order-2 @max-2xl:flex-none",
  line: "@max-2xl:order-3 @max-2xl:min-w-0 @max-2xl:basis-full",
  meta: "@max-2xl:order-4 @max-2xl:min-w-0 @max-2xl:text-xs @max-2xl:text-fg-3",
  field:
    "@max-2xl:order-5 @max-2xl:flex @max-2xl:min-w-0 @max-2xl:basis-full @max-2xl:items-baseline @max-2xl:gap-3 @max-2xl:before:w-24 @max-2xl:before:flex-none @max-2xl:before:text-[12px] @max-2xl:before:text-fg-3 @max-2xl:before:content-[attr(data-label)]",
  actions: "@max-2xl:order-6 @max-2xl:flex @max-2xl:basis-full @max-2xl:justify-end",
};

const META_LABEL = "@max-2xl:before:mr-1 @max-2xl:before:content-[attr(data-label)]";

const isEmpty = (v: ReactNode) => v === null || v === undefined || v === "" || v === false;

export function DataTable<T>({ rows, rowKey, columns, label, fresh, still, rowClassName }: {
  rows: readonly T[];
  rowKey(row: T, index: number): string;
  columns: Column<T>[];
  /** Accessible name of the table. */
  label: string;
  /** Keys of rows that just arrived (from useFresh): they tint in instead of fading up. */
  fresh?: ReadonlySet<string>;
  /** Render rows without motion (large tables). */
  still?: boolean;
  rowClassName?(row: T): string | false | undefined;
}) {
  return (
    <div className="@container">
      <table aria-label={label} className="w-full text-[14px] @max-2xl:block">
        <thead className="eyebrow border-b border-line text-left @max-2xl:hidden">
          <tr>
            {columns.map((c) => (
              <th key={c.key} scope="col" className="px-4 py-2.5 font-medium">
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-line @max-2xl:block">
          <AnimatePresence>
            {rows.map((r, i) => {
              const key = rowKey(r, i);
              return (
                <Row as="tr" key={key} index={i} fresh={fresh?.has(key)} still={still} className={clsx("transition-colors duration-150 hover:bg-panel-2/60", CARD, rowClassName?.(r))}>
                  {columns.map((c) => {
                    const slot = c.slot ?? "field";
                    const value = c.cell(r, i);
                    const empty = isEmpty(value);
                    const cardLabel = slot === "field" ? (c.label ?? (typeof c.header === "string" ? c.header : undefined)) : slot === "meta" ? c.label : undefined;
                    return (
                      <td
                        key={c.key}
                        data-label={cardLabel}
                        className={clsx("px-4 py-2.5 align-middle @max-2xl:p-0", SLOT[slot], slot === "meta" && cardLabel && META_LABEL, c.className, empty && "@max-2xl:hidden")}
                      >
                        {empty ? <span className="text-fg-3">—</span> : slot === "field" ? <div className="min-w-0 @max-2xl:flex-1">{value}</div> : value}
                      </td>
                    );
                  })}
                </Row>
              );
            })}
          </AnimatePresence>
        </tbody>
      </table>
    </div>
  );
}
