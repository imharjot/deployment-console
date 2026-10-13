"use client";
// The evidence a run collected: each tool result it read, redacted and minimised, with a citation id (E1, E2, …), where
// it came from and how old it is. Answers and plans cite these ids; `anchor` lets a citation link straight to its entry.
// Evidence is data the agent observed — never instructions it followed.
import { FileSearch } from "lucide-react";
import { Chip, cx, useNow } from "@/components/ui";
import { stamp } from "@/lib/client/format";
import { evidenceAge } from "./rules";
import type { EvidenceItem } from "./types";

export const evidenceAnchor = (runId: string, id: string) => `ev-${runId.slice(0, 12)}-${id}`;

export function EvidenceList({ runId, items, maxAgeSeconds, highlight, compact, className }: {
  runId: string;
  items: readonly EvidenceItem[] | undefined;
  maxAgeSeconds?: number;
  highlight?: readonly string[];
  compact?: boolean;
  className?: string;
}) {
  const now = useNow();
  if (!items?.length)
    return <p className={cx("text-[13.5px] text-fg-3", className)}>No evidence collected yet.</p>;
  return (
    <ol aria-label="Evidence" className={cx("space-y-1.5", className)}>
      {items.map((e) => {
        const age = evidenceAge(e.observedAt, now, maxAgeSeconds);
        const lit = highlight?.includes(e.id);
        return (
          <li
            key={e.id}
            id={evidenceAnchor(runId, e.id)}
            className={cx("scroll-mt-24 rounded-xl border px-3 py-2 target:border-accent/60 target:bg-accent-soft", lit ? "border-accent/40 bg-accent-soft" : "border-line bg-panel-2/50")}
          >
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <Chip mono tone="accent">{e.id}</Chip>
              {e.outcome === "denied" && <Chip tone="warn">refused by policy</Chip>}
              {e.outcome === "error" && <Chip tone="bad">failed</Chip>}
              {!!e.redacted?.length && <span title={`Removed before the model saw it: ${e.redacted.join(", ")}`}><Chip tone="muted">redacted</Chip></span>}
              <span className="inline-flex min-w-0 items-center gap-1 font-mono text-[12.5px] text-fg-2 [overflow-wrap:anywhere]">
                <FileSearch className="size-3 flex-none text-fg-3" aria-hidden /> {e.source}
              </span>
              <span className={cx("ml-auto text-[12px] tabular-nums", age.stale && maxAgeSeconds !== undefined ? "text-degraded" : "text-fg-3")} title={e.observedAt ? `observed ${stamp(e.observedAt)}` : undefined}>
                {now ? age.text : "—"}
                {age.stale && maxAgeSeconds !== undefined && now ? " · older than the policy allows" : ""}
              </span>
            </div>
            {e.summary && <p className={cx("mt-1 text-[13.5px] leading-relaxed text-fg-2 [overflow-wrap:anywhere]", compact && "line-clamp-2")}>{e.summary}</p>}
          </li>
        );
      })}
    </ol>
  );
}
