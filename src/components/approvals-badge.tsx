"use client";
// Pending approval requests on the sidebar's Automation link: a count when expanded, a dot when collapsed.
// Shares its SWR key with the Automation page, so a decision there updates it at once.
import useSWR from "swr";
import { cx } from "./ui";

export function ApprovalsBadge({ collapsed, className }: { collapsed?: boolean; className?: string }) {
  const n = useSWR<{ pending: number }>("/api/approvals?count=pending", { refreshInterval: 30_000 }).data?.pending ?? 0;
  if (!n) return null;
  const label = `${n} approval request${n === 1 ? "" : "s"} waiting`;
  if (collapsed) return <span role="status" aria-label={label} title={label} className={cx("absolute -top-0.5 right-2 size-1.5 rounded-full bg-accent", className)} />;
  return (
    <span role="status" aria-label={label} title={label} className={cx("ml-auto rounded-full bg-accent-soft px-1.5 text-[11.5px] font-semibold leading-4 tabular-nums text-accent", className)}>
      {n}
    </span>
  );
}
