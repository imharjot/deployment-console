"use client";
// Building blocks of the Costs page: headline stat, daily bar chart, share-bar list, how-to-fix callout.
// Kept here rather than in components/charts.tsx: they only make sense for money (dollar axes, a partial "today").
// Motion follows components/motion.tsx — transform and opacity only, short staggers, nothing on reduced motion.
import { motion } from "motion/react";
import { AlertTriangle, ChevronDown } from "lucide-react";
import Link from "next/link";
import { useState, type ReactNode } from "react";
import { hue } from "@/components/hue";
import { enter } from "@/components/motion";
import { cx } from "@/components/ui";
import { usd } from "@/lib/costs";
import type { Day, SpendView } from "@/lib/spend";

const dayFmt = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
const monthFmt = new Intl.DateTimeFormat(undefined, { month: "long", timeZone: "UTC" });
export const fmtDay = (d: Day) => dayFmt.format(new Date(`${d}T00:00:00Z`));
export const fmtMonth = (d: Day) => monthFmt.format(new Date(`${d}T00:00:00Z`));
export const fmtPct = (p: number) => `${p > 0 ? "+" : p < 0 ? "−" : ""}${Math.abs(p) >= 10 ? Math.round(Math.abs(p)) : Math.abs(p).toFixed(1)}%`;

// `flush` drops the padding for cards whose content (a DataTable) brings its own.
export function Card({ children, className, i = 0, flush }: { children: ReactNode; className?: string; i?: number; flush?: boolean }) {
  return (
    <motion.section initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ ...enter, delay: Math.min(i, 8) * 0.04 }} className={cx("min-w-0 rounded-2xl border border-line bg-panel shadow-card", !flush && "p-4 sm:p-5", className)}>
      {children}
    </motion.section>
  );
}

export function CardTitle({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
      <h2 className="eyebrow">{children}</h2>
      {aside && <div className="text-[12px] text-fg-3">{aside}</div>}
    </div>
  );
}

// The headline tiles in a row of hues (by position), so the four numbers read apart at a glance.
const STAT_HUES = ["hue-blue", "hue-violet", "hue-teal", "hue-pink"];

export function Stat({ label, value, sub, tone, i }: { label: string; value: string; sub?: ReactNode; tone?: "warn" | "ok"; i: number }) {
  return (
    <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ ...enter, delay: i * 0.04 }} style={hue(STAT_HUES[i % STAT_HUES.length])} className="relative min-w-0 overflow-hidden rounded-xl border border-line bg-panel p-3 shadow-card sm:p-4">
      <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-0.5 bg-[var(--hue)] opacity-60" />
      <div className="flex items-center gap-1.5 text-[12px] text-fg-3"><span className="size-1.5 flex-none rounded-full bg-[var(--hue)]" />{label}</div>
      <div className={cx("mt-1 truncate font-display text-[28px] leading-none tabular-nums sm:text-[32px]", tone === "warn" ? "text-degraded" : tone === "ok" ? "text-up" : "text-fg")}>{value}</div>
      {sub && <div className="mt-1.5 text-[12px] leading-snug text-fg-3">{sub}</div>}
    </motion.div>
  );
}

// Axis labels: whole dollars from $1 up, cents below.
const axis = (n: number) => (n >= 1 ? `$${Math.round(n).toLocaleString("en-US")}` : `$${n.toFixed(2)}`);

// Round an axis maximum up to 1 / 2 / 5 × 10ⁿ.
function niceMax(v: number) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  return ([1, 2, 5, 10].find((m) => m * p >= v) ?? 10) * p;
}

// 30 days of spend. Bars are plain flex children (no ResizeObserver): they fill any width, and pointer events work
// for mouse and touch alike. Days inside an open anomaly are tinted; today is faint because it is still counting.
export function DailyBars({ days, anomalyFrom }: { days: SpendView["daily"]; anomalyFrom?: Day }) {
  const [hover, setHover] = useState<number | null>(null);
  const full = days.filter((d) => !d.partial);
  const avg = full.length ? full.reduce((a, d) => a + d.amount, 0) / full.length : 0;
  const top = niceMax(Math.max(...days.map((d) => d.amount), 0.01));
  const shown = hover !== null ? days[hover] : undefined;
  const pick = (e: React.PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    setHover(Math.min(days.length - 1, Math.max(0, Math.floor(((e.clientX - r.left) / r.width) * days.length))));
  };
  return (
    <>
      <div className="mb-3 flex items-end justify-between gap-3">
        <div>
          <h2 className="eyebrow">Daily spend · last 30 days</h2>
          {anomalyFrom && <div className="mt-1 inline-flex items-center gap-1.5 text-[12px] text-fg-3"><span className="size-2 rounded-sm bg-degraded/70" />during an open anomaly</div>}
        </div>
        <div className="text-right">
          <div className="font-display text-[26px] leading-none tabular-nums">{usd(shown?.amount ?? avg)}</div>
          <div className="mt-1 text-[12px] text-fg-3">{shown ? `${fmtDay(shown.date)}${shown.partial ? " · so far today" : ""}` : "average per full day"}</div>
        </div>
      </div>
      <div
        role="img"
        aria-label={`Daily spend from ${fmtDay(days[0].date)} to today, ${usd(Math.min(...full.map((d) => d.amount), avg))} to ${usd(Math.max(...full.map((d) => d.amount), avg))} a day`}
        className="relative mt-2 h-36 touch-pan-y select-none sm:h-44"
      >
        {/* y labels sit in a left gutter so they never cover bars or the header */}
        {[0.5, 1].map((f) => (
          <div key={f} className="absolute inset-x-0 border-t border-dashed border-line" style={{ bottom: `${f * 100}%` }}>
            <span className="absolute left-0 top-0 -translate-y-1/2 text-[11px] leading-none tabular-nums text-fg-3">{axis(top * f)}</span>
          </div>
        ))}
        <div className="absolute inset-y-0 left-10 right-0 flex items-end gap-px border-b border-line sm:gap-[3px]" onPointerMove={pick} onPointerDown={pick} onPointerLeave={() => setHover(null)}>
          {days.map((d, i) => (
            <motion.div
              key={d.date}
              initial={{ scaleY: 0 }}
              animate={{ scaleY: 1 }}
              transition={{ ...enter, delay: Math.min(i, 30) * 0.012 }}
              style={{ height: `${Math.max(0.6, (d.amount / top) * 100)}%` }}
              className={cx(
                "min-w-0 flex-1 origin-bottom rounded-t-[3px] transition-colors duration-150",
                d.partial ? "bg-accent/20" : anomalyFrom && d.date >= anomalyFrom ? "bg-degraded/70" : "bg-accent/45",
                hover === i && (anomalyFrom && d.date >= anomalyFrom && !d.partial ? "bg-degraded" : "bg-accent"),
              )}
            />
          ))}
        </div>
      </div>
      <div className="mt-1.5 ml-10 flex justify-between text-[11px] text-fg-3">
        <span>{fmtDay(days[0].date)}</span>
        <span>{fmtDay(days[Math.floor(days.length / 2)].date)}</span>
        <span>today</span>
      </div>
    </>
  );
}

export interface BarRow {
  key: string;
  label: ReactNode;
  amount: number;
  sub?: ReactNode;
  muted?: boolean;
  title?: string;
}

// Amount per row with a share bar scaled to the largest row. The first `limit` rows show; the rest fold away.
export function BarList({ rows, limit = 7, label }: { rows: BarRow[]; limit?: number; label: string }) {
  const [all, setAll] = useState(false);
  const max = Math.max(...rows.map((r) => r.amount), 0.01);
  const shown = all ? rows : rows.slice(0, limit);
  return (
    <div>
      <ul aria-label={label} className="divide-y divide-line">
        {shown.map((r, i) => (
          <li key={r.key} className="py-2.5 first:pt-0" title={r.title}>
            <div className="flex items-baseline justify-between gap-3 text-[14px]">
              <span className={cx("min-w-0 truncate", r.muted && "text-fg-3")}>{r.label}</span>
              <span className={cx("flex-none font-medium tabular-nums", r.muted && "text-fg-2")}>{usd(r.amount)}</span>
            </div>
            <div className="mt-1.5 flex items-center gap-3">
              <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-panel-3">
                <motion.div
                  initial={{ scaleX: 0 }}
                  animate={{ scaleX: Math.max(0, r.amount) / max }}
                  transition={{ ...enter, delay: Math.min(i, 10) * 0.025 }}
                  className={cx("h-full origin-left rounded-full", r.muted ? "bg-fg-3/35" : "bg-accent/60")}
                />
              </div>
              {r.sub && <span className="flex-none text-[12px] tabular-nums text-fg-3">{r.sub}</span>}
            </div>
          </li>
        ))}
      </ul>
      {rows.length > limit && (
        <button onClick={() => setAll((v) => !v)} aria-expanded={all} className="press mt-1 inline-flex min-h-9 items-center gap-1 rounded-md text-xs text-fg-3 hover:text-fg">
          {all ? "Show fewer" : `Show ${rows.length - limit} more`}
          <ChevronDown className={cx("size-3.5 transition-transform duration-200 ease-smooth", all && "rotate-180")} />
        </button>
      )}
    </div>
  );
}

// What's missing and the steps to fix it. `tone` warn for "not set up yet", bad for errors.
export function Callout({ title, reason, steps, tone = "warn", docs = true }: { title: string; reason?: string; steps?: string[]; tone?: "warn" | "bad" | "muted"; docs?: boolean }) {
  return (
    <div className={cx("rounded-xl border px-4 py-3 text-[14px] leading-relaxed", tone === "bad" ? "border-down/30 bg-down/8" : tone === "warn" ? "border-degraded/30 bg-degraded/8" : "border-line bg-panel-2/60")}>
      <div className={cx("flex items-start gap-2 font-medium", tone === "bad" ? "text-down" : tone === "warn" ? "text-degraded" : "text-fg-2")}>
        <AlertTriangle className="mt-0.5 size-4 flex-none" aria-hidden />
        <span>{title}</span>
      </div>
      {reason && <div className="mt-1 break-words pl-6 font-mono text-[12.5px] text-fg-3 [overflow-wrap:anywhere]">{reason}</div>}
      {steps && steps.length > 0 && (
        <ol className="mt-2 list-decimal space-y-1 pl-10 text-fg-2 marker:text-fg-3">
          {steps.map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ol>
      )}
      {docs && (
        <Link href="/docs/costs" className="mt-2 inline-block pl-6 text-xs text-accent hover:underline pointer-coarse:py-2">
          Costs & usage docs →
        </Link>
      )}
    </div>
  );
}
