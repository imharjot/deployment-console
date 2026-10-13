"use client";
// A run's budget: each limit its policy sets (model turns, tool calls, time, cost) against what it has used. A run that
// reaches one pauses (paused_budget) instead of carrying on; cost is an estimate and says so.
import { cx, useNow } from "@/components/ui";
import { budgetRows } from "./rules";
import type { BudgetLike, BudgetViewLike, UsageLike } from "./types";

const BAR = { ok: "bg-up", warn: "bg-degraded", bad: "bg-down", muted: "bg-fg-3", accent: "bg-accent" } as const;

export function BudgetMeter({
  budget,
  usage,
  startedAt,
  finishedAt,
  compact,
  className,
}: {
  budget: BudgetLike | BudgetViewLike | null | undefined;
  usage: UsageLike | null | undefined;
  startedAt?: number;
  finishedAt?: number | null;
  compact?: boolean;
  className?: string;
}) {
  const now = useNow();
  const rows = budgetRows(budget, usage, { now: finishedAt ? undefined : now, startedAt, finishedAt });
  if (!rows.length) return null;
  const cost = budget && "cost" in budget ? budget.cost : undefined;
  return (
    <div className={className}>
      <dl aria-label="Budget" className={cx("grid gap-x-4 gap-y-2", compact ? "grid-cols-2" : "grid-cols-2 sm:grid-cols-4")}>
        {rows.map((r) => (
          <div key={r.key} className="min-w-0">
            <dt className="flex items-baseline justify-between gap-2 text-[12px] text-fg-3">
              <span>
                {r.label}
                {r.estimated && <span title="Estimated from the provider's reported usage"> (est.)</span>}
              </span>
            </dt>
            <dd className="mt-0.5">
              <div className="text-[13px] tabular-nums text-fg-2">{r.text}</div>
              <div
                role="meter"
                aria-label={`${r.label} used`}
                aria-valuemin={0}
                aria-valuemax={r.limit}
                aria-valuenow={Math.min(r.used, r.limit)}
                aria-valuetext={r.text}
                className="mt-1 h-1 overflow-hidden rounded-full bg-panel-3"
              >
                <div className={cx("h-full rounded-full transition-[width] duration-500", BAR[r.tone])} style={{ width: `${Math.max(2, r.pct * 100)}%` }} />
              </div>
            </dd>
          </div>
        ))}
      </dl>
      {cost === "not measurable" || cost === "partly estimated" ? <p className="mt-1.5 text-[12px] text-fg-3">Cost is {cost}: the provider&apos;s price is never guessed.</p> : null}
    </div>
  );
}
