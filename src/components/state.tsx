"use client";
import { motion } from "motion/react";
import { useId, type CSSProperties } from "react";
import { uptimeLabel } from "@/lib/client/format";
import type { State, UptimeView } from "@/lib/types";
import { enter, useChangeCount } from "./motion";
import { cx } from "./ui";

// Healthy and parked states are still; only states that need attention move (see .dot in globals.css).
export const STATE: Record<State, { label: string; color: string; anim: "pulse" | "alarm" | "spin" | "hatch" | "none" }> = {
  UP: { label: "Up", color: "var(--up)", anim: "none" },
  DEGRADED: { label: "Degraded", color: "var(--degraded)", anim: "pulse" },
  DOWN: { label: "Down", color: "var(--down)", anim: "alarm" },
  DEPLOYING: { label: "Deploying", color: "var(--deploying)", anim: "spin" },
  STOPPED: { label: "Stopped", color: "var(--stopped)", anim: "none" },
  BOX_STOPPED: { label: "Box stopped", color: "var(--boxstopped)", anim: "none" },
  UNKNOWN: { label: "Unknown", color: "var(--unknown)", anim: "hatch" },
};

export const stateStyle = (s: State) => ({ "--dot": STATE[s].color }) as CSSProperties;

// Colour crossfades in CSS; a state change also sends out one soft ring (keyed so it replays per change).
export function StateDot({ state, className }: { state: State; className?: string }) {
  const changes = useChangeCount(state);
  return (
    <span className={cx("dot", className)} data-anim={STATE[state].anim} style={stateStyle(state)} aria-hidden>
      {changes > 0 && <span key={changes} className="dot-ping" />}
    </span>
  );
}

// Uptime strip: one bar per 2-minute bucket, worst state in the bucket. Healthy buckets stay neutral
// so the eye only lands on the ones that were not; time the console didn't observe is an empty (short) bar.
// It is the service's operational state as the console saw it — not customer availability (F39, R21).
export function UptimeBars({ u, className, verbose }: { u?: UptimeView; className?: string; verbose?: boolean }) {
  const id = useId();
  if (!u) return null;
  const covered = Math.round(u.coveredMs / 60_000);
  const gap = u.gapMs ? Math.round(u.gapMs / 60_000) : 0;
  const label = uptimeLabel(u);
  const explain = `Operational state, not customer availability: the share of the last ${covered} min the console watched (at most 2 h) in which the service was up or intentionally stopped.${gap ? ` ${gap} min it couldn't observe are left out.` : ""}`;
  return (
    <div className={cx("flex items-center gap-2", className)} title={explain}>
      <div className="flex h-3.5 flex-1 items-end gap-px" aria-hidden>
        {u.bars.map((b, i) => (
          <span key={i} className="flex-1 rounded-[1px]" style={{ height: b ? "100%" : "30%", background: !b ? "var(--border-strong)" : b === "UP" ? "var(--text-3)" : STATE[b].color, opacity: b === "UP" ? 0.4 : 1 }} />
        ))}
      </div>
      <span aria-describedby={id} className="flex-none font-mono text-[11px] text-fg-3 tabular-nums">
        {verbose && u.pct !== null ? `operational state · ${label}` : label}
      </span>
      <span id={id} className="sr-only">{explain}</span>
    </div>
  );
}

export function StateBadge({ state, className }: { state: State; className?: string }) {
  const changes = useChangeCount(state);
  return (
    <span
      style={stateStyle(state)}
      className={cx(
        "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2 py-0.5 text-[12px] font-medium transition-[color,background-color,border-color] duration-300 ease-smooth",
        "border-[color-mix(in_srgb,var(--dot)_24%,transparent)] bg-[color-mix(in_srgb,var(--dot)_7%,transparent)] text-[var(--dot)]",
        className,
      )}
    >
      <StateDot state={state} className="!size-1.5" />
      {/* The label only fades in after a change, never on first paint. */}
      <motion.span key={state} initial={changes ? { opacity: 0, y: 2 } : false} animate={{ opacity: 1, y: 0 }} transition={enter}>
        {STATE[state].label}
      </motion.span>
    </span>
  );
}
