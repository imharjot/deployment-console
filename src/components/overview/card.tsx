"use client";
import { motion } from "motion/react";
import { Box, Container, Database, GitCommitHorizontal, Globe, Network, Server } from "lucide-react";
import { memo } from "react";
import { capacityText, opsOf, shortSha, verificationText } from "@/lib/client/format";
import type { ResourceView } from "@/lib/types";
import { Sparkline } from "../charts";
import { AnimatedNumber, enter, spring } from "../motion";
import { STATE, StateBadge, UptimeBars, stateStyle } from "../state";
import { resourceHue } from "../hue";
import { Chip, cx } from "../ui";

export const KIND_ICON = { service: Container, box: Server, database: Database, cache: Box, loadbalancer: Network, external: Globe } as const;

// The panel's heavy tabs (logs, variables, create & scale) load on demand (F53). Pointing at or focusing a card
// starts loading them, so the panel opens with them ready.
let preloaded = false;
export function preloadPanel() {
  if (preloaded) return;
  preloaded = true;
  void import("../logs/log-viewer");
  void import("../panel/env-vars");
  void import("../panel/provision");
}

// memo: SWR keeps unchanged objects referentially equal between polls, so untouched cards never re-render.
export const ResourceCard = memo(function ResourceCard({ r, onOpen, compact }: { r: ResourceView; onOpen: (key: string) => void; compact?: boolean }) {
  const Icon = KIND_ICON[r.kind];
  const alert = r.state !== "UP";
  const short = r.state === "UNKNOWN" ? undefined : capacityText(r.capacity);
  // The newest change on this service while AWS has only accepted it, or when it didn't settle.
  const op = opsOf(r).find((o) => o.verification === "accepted" || o.verification === "failed");
  return (
    // No layoutId: a shared id made cards fly between the grid and the panel's Containers tab.
    // The press dip is CSS `scale`, so it composes with motion's transform. Nothing depends on hover.
    <motion.button
      layout="position"
      onClick={() => onOpen(r.key)}
      onPointerEnter={preloadPanel}
      onFocus={preloadPanel}
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0, transition: enter }}
      transition={spring}
      style={{ ...stateStyle(r.state), ...resourceHue(r.kind, r.id) }}
      className={cx(
        "press lift group relative flex w-full flex-col gap-3 overflow-hidden rounded-2xl border border-line bg-panel p-4 text-left shadow-card [--press-scale:0.985]",
        "hover:border-line-strong",
        alert && "border-[color-mix(in_srgb,var(--dot)_35%,var(--border))]",
      )}
    >
      {/* What it is along the top edge (its kind's hue); what's wrong takes it over when it isn't up. */}
      <span aria-hidden className={cx("pointer-events-none absolute inset-x-0 top-0 h-0.5", alert ? "bg-[var(--dot)] opacity-80" : "bg-[var(--hue)] opacity-60")} />
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="hue-chip grid size-8 flex-none place-items-center rounded-lg">
            <Icon className="size-4" strokeWidth={1.7} />
          </span>
          <div className="min-w-0">
            <div className="truncate text-[15px] font-medium leading-tight tracking-[-0.01em]">{r.name}</div>
            <div className="mt-0.5 truncate font-mono text-[12px] text-fg-3">{r.subtitle}</div>
          </div>
        </div>
        <StateBadge state={r.state} />
      </div>

      {!compact && (
        <>
          <div className="min-h-[34px] text-xs leading-snug text-fg-2">
            {r.commit ? (
              <span className="line-clamp-2">
                <GitCommitHorizontal className="-mt-0.5 mr-1 inline size-3.5 text-fg-3" />
                <span className="font-mono text-fg-3">{shortSha(r.sha)}</span> {r.commit.title}
              </span>
            ) : (
              <span className={cx("line-clamp-2", alert && "text-[var(--dot)]")}>{r.reasons[0]}</span>
            )}
          </div>
          {/* Healthy traffic in the kind's hue; the state's colour when something is off. */}
          <Sparkline values={r.spark} color={alert ? STATE[r.state].color : "var(--hue)"} />
        </>
      )}
      {r.uptime && <UptimeBars u={r.uptime} />}

      {(short || op) && (
        <div className="flex flex-wrap items-center gap-1.5">
          {short && <Chip tone="warn">{short}</Chip>}
          {op && <Chip tone={verificationText(op).tone}>{verificationText(op).text}</Chip>}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-fg-3">
        {r.stats.map((s) => (
          <span key={s.label} className="tabular-nums">
            <span className="text-fg-2">{/^\d+$/.test(s.value) ? <AnimatedNumber value={Number(s.value)} /> : s.value}</span> {s.label}
          </span>
        ))}
        {r.behindBy ? <span className="ml-auto rounded-md border border-degraded/25 px-1.5 text-degraded">{r.behindBy} behind</span> : null}
      </div>
    </motion.button>
  );
});
