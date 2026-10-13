"use client";
// R21: a stale, partial or failed-refresh view must say so. Renders nothing when the data is fresh and complete;
// otherwise an amber status line with what is wrong and how old the data is ("as of 14:02 UTC (3 min ago) · …").
import { RefreshCw, TriangleAlert } from "lucide-react";
import { describeFreshness, freshnessHeadline, isStale, type Freshness } from "@/lib/freshness";
import { cx, useNow } from "./ui";

export function FreshnessBanner({ f, onRetry, compact, now: at, className }: {
  f: Freshness | undefined;
  onRetry?: () => void;
  compact?: boolean; // one line for headers and cards
  now?: number; // tests; defaults to the shared clock
  className?: string;
}) {
  const clock = useNow();
  const now = at ?? clock;
  // The shared clock reads 0 during server rendering: decide after hydration, never from the server's time.
  if (!f || !now) return null;
  const headline = freshnessHeadline(f, now);
  if (!headline) return null;
  const detail = describeFreshness(f, now);
  if (compact) {
    return (
      <span role="status" title={detail} className={cx("inline-flex min-w-0 items-center gap-1 text-[12.5px] text-degraded", className)}>
        <TriangleAlert className="size-3.5 flex-none" aria-hidden />
        <span className="truncate">{headline}</span>
        <span className="sr-only">: {detail}</span>
      </span>
    );
  }
  return (
    <div role="status" className={cx("flex items-start gap-2 rounded-lg border border-degraded/25 bg-degraded/8 px-3 py-2 text-xs text-degraded", className)}>
      <TriangleAlert className="mt-px size-3.5 flex-none" aria-hidden />
      <p className="min-w-0 flex-1 leading-5">
        <b className="font-medium">{headline}</b> <span className="break-words text-fg-2">· {detail}</span>
      </p>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="press -my-0.5 inline-flex flex-none items-center gap-1 rounded-md border border-degraded/30 px-2 py-0.5 text-[12.5px] font-medium hover:bg-degraded/10 pointer-coarse:h-10 pointer-coarse:px-3"
        >
          <RefreshCw className="size-3" aria-hidden />
          Retry
        </button>
      )}
    </div>
  );
}

// A small chip for a tile or row whose own data is stale, of unknown age or partial. Nothing when fresh.
export function StaleBadge({ f, now: at, className }: { f: Freshness | undefined; now?: number; className?: string }) {
  const clock = useNow();
  const now = at ?? clock;
  if (!f || !now || !freshnessHeadline(f, now)) return null;
  const label = !f.observedAt || f.observedAt <= 0 ? "age unknown" : isStale(f, now) ? "stale" : f.error ? "refresh failed" : f.completeness === "partial" ? "partial" : "may be incomplete";
  const detail = describeFreshness(f, now);
  return (
    <span title={detail} className={cx("inline-flex items-center gap-1 rounded-md border border-degraded/25 bg-degraded/8 px-1.5 py-px text-[12px] leading-4 text-degraded", className)}>
      {label}
      <span className="sr-only">: {detail}</span>
    </span>
  );
}
