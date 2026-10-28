"use client";
import { clsx } from "clsx";
import { Check, Copy } from "lucide-react";
import { motion } from "motion/react";
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ButtonHTMLAttributes, type ReactNode } from "react";
import { ago } from "@/lib/client/format";
import { regionLabel } from "@/lib/client/region";
import { spring } from "./motion";

export const cx = clsx;

type Variant = "primary" | "secondary" | "ghost" | "danger";
export function Button({ variant = "secondary", size = "md", className, children, ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: "sm" | "md" }) {
  return (
    <button
      {...p}
      className={cx(
        // No pointer-events-none when disabled: the title tooltip explains why.
        "press inline-flex select-none items-center justify-center gap-1.5 whitespace-nowrap rounded-lg font-medium tracking-[-0.005em]",
        // Touch screens get taller targets.
        size === "sm" ? "h-7 px-2.5 text-xs pointer-coarse:h-9 pointer-coarse:px-3" : "h-9 px-3.5 text-[14px] pointer-coarse:h-10",
        // A disabled primary recedes into the surface instead of turning into a grey slab.
        variant === "primary" && "bg-primary text-primary-fg enabled:hover:bg-primary-hover disabled:bg-panel-3 disabled:text-fg-3",
        variant === "secondary" && "border border-line bg-panel text-fg shadow-card enabled:hover:border-line-strong enabled:hover:bg-panel-2 disabled:opacity-45",
        variant === "ghost" && "text-fg-2 enabled:hover:bg-panel-3 enabled:hover:text-fg disabled:opacity-45",
        variant === "danger" && "border border-down/40 bg-down/8 text-down enabled:hover:border-down/60 enabled:hover:bg-down/14 disabled:opacity-45",
        className,
      )}
    >
      {children}
    </button>
  );
}

export function IconButton({ label, className, children, ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button
      {...p}
      aria-label={label}
      title={label}
      className={cx("press grid size-8 flex-none place-items-center rounded-lg text-fg-3 pointer-coarse:size-10 enabled:hover:bg-panel-3 enabled:hover:text-fg disabled:opacity-40", className)}
    >
      {children}
    </button>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="rounded-[5px] border border-line bg-panel-2 px-1.5 py-px font-mono text-[11px] text-fg-3">{children}</kbd>;
}

export function Chip({ children, tone, className, mono }: { children: ReactNode; tone?: "ok" | "warn" | "bad" | "muted" | "accent"; className?: string; mono?: boolean }) {
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1 rounded-md border px-1.5 py-px text-[12px] leading-4",
        mono && "font-mono",
        !tone && "border-line bg-panel-2 text-fg-2",
        tone === "ok" && "border-up/25 bg-up/8 text-up",
        tone === "warn" && "border-degraded/25 bg-degraded/8 text-degraded",
        tone === "bad" && "border-down/25 bg-down/8 text-down",
        tone === "muted" && "border-line bg-transparent text-fg-3",
        tone === "accent" && "border-accent/30 bg-accent-soft text-accent",
        className,
      )}
    >
      {children}
    </span>
  );
}

// The mark: a porcelain tile with a prompt cut into it. Monochrome, so it follows the theme.
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className={cx("size-6 flex-none", className)}>
      <rect width="24" height="24" rx="7" fill="var(--primary)" />
      <path d="M7.5 9l3 3-3 3M12.5 15.5h4" fill="none" stroke="var(--primary-fg)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

const fadeEdges = (el: HTMLElement) => {
  el.dataset.fadeStart = String(el.scrollLeft > 1);
  el.dataset.fadeEnd = String(el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
};

// Toggles the edge fades of a sideways scroller (see the edge-fade utility) without re-rendering React. `current`
// (the active value) brings the current item into view again whenever it changes — e.g. a tab taken from the URL
// hash after hydration — not only on mount.
export function useEdgeFade<T extends HTMLElement>(current?: unknown) {
  const ref = useRef<T>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => fadeEdges(el);
    el.addEventListener("scroll", update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", update);
      ro.disconnect();
    };
  }, []);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Bring the current item into view (the active tab on a narrow screen).
    const cur = el.querySelector<HTMLElement>("[aria-selected=true], [aria-current=page]");
    if (cur) el.scrollLeft = Math.max(0, cur.offsetLeft - (el.clientWidth - cur.offsetWidth) / 2);
    fadeEdges(el);
  }, [current]);
  return ref;
}

// Segmented control with a sliding indicator.
export function Segmented<T extends string>({ value, options, onChange, id, size = "md" }: { value: T; options: { value: T; label: ReactNode }[]; onChange: (v: T) => void; id: string; size?: "sm" | "md" }) {
  return (
    <div role="tablist" className="relative isolate inline-flex rounded-lg border border-line bg-panel-2 p-0.5">
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(o.value)}
            className={cx(
              "group relative rounded-md font-medium transition-colors duration-200",
              size === "sm" ? "px-2.5 py-1 text-xs pointer-coarse:py-2.5" : "px-3 py-1.5 text-[14px] pointer-coarse:py-2.5",
              active ? "text-fg" : "text-fg-3 hover:text-fg-2",
            )}
          >
            {active && <motion.span layoutId={`seg-${id}`} className="absolute inset-0 -z-10 rounded-md border border-line bg-panel shadow-card dark:bg-panel-3" transition={spring} />}
            <span className="press-content inline-block">{o.label}</span>
          </button>
        );
      })}
    </div>
  );
}

// Underlined tabs. On narrow screens the row scrolls sideways and fades at the edge with more to show.
export function Tabs<T extends string>({ value, tabs, onChange, id }: { value: T; tabs: { value: T; label: string; badge?: ReactNode }[]; onChange: (v: T) => void; id: string }) {
  const ref = useEdgeFade<HTMLDivElement>(value);
  return (
    <div className="border-b border-line">
      <div ref={ref} role="tablist" className="edge-fade no-scrollbar -mb-px flex gap-1 overflow-x-auto overscroll-x-contain">
        {tabs.map((t) => {
          const active = t.value === value;
          return (
            <button
              key={t.value}
              role="tab"
              aria-selected={active}
              onClick={() => onChange(t.value)}
              className={cx(
                "relative flex-none rounded-md px-3 pb-2.5 pt-1 text-[14px] font-medium transition-colors duration-200 focus-visible:outline-offset-[-2px] pointer-coarse:pb-3 pointer-coarse:pt-2",
                active ? "text-fg" : "text-fg-3 hover:text-fg-2",
              )}
            >
              <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
                {t.label}
                {t.badge}
              </span>
              {active && <motion.span layoutId={`tab-${id}`} className="absolute inset-x-3 bottom-0 h-[1.5px] rounded-full bg-accent" transition={spring} />}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cx("skeleton", className)} />;
}

export function Empty({ icon, title, hint }: { icon?: ReactNode; title: string; hint?: ReactNode }) {
  return (
    <div className="fade-in grid place-items-center gap-2 py-14 text-center">
      {icon && <div className="mb-1 grid size-10 place-items-center rounded-full border border-line text-fg-3">{icon}</div>}
      <div className="text-sm font-medium text-fg-2">{title}</div>
      {hint && <div className="max-w-sm text-xs leading-relaxed text-fg-3">{hint}</div>}
    </div>
  );
}

// One shared 1s clock for every relative time on screen.
let now = Date.now();
const subs = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | undefined;
function subscribe(cb: () => void) {
  subs.add(cb);
  timer ??= setInterval(() => {
    now = Date.now();
    subs.forEach((f) => f());
  }, 1000);
  return () => {
    subs.delete(cb);
    if (!subs.size && timer) {
      clearInterval(timer);
      timer = undefined;
    }
  };
}
export const useNow = () => useSyncExternalStore(subscribe, () => now, () => 0);

// A clock that only moves when asked (R21). `next(now)` names the next moment something on screen turns stale; the
// hook re-renders once then — never every second. undefined = read the time now (right after hydration). The clock
// reads 0 until then, so server and first client render agree.
export function useClockAt(next: (now: number) => number | undefined): number {
  const [t, setT] = useState(0);
  const at = next(t);
  useEffect(() => {
    const wait = at === undefined ? 0 : Math.min(Math.max(0, at - Date.now()), 2_000_000_000);
    const id = setTimeout(() => setT(Date.now()), wait);
    return () => clearTimeout(id);
  }, [at]);
  return t;
}

// The region an environment or resource lives in, shown only when the console watches more than one.
export function RegionBadge({ region, className }: { region?: string; className?: string }) {
  if (!region) return null;
  return (
    <span title={regionLabel(region)} className={cx("inline-flex flex-none items-center rounded-md border border-line px-1.5 py-px font-mono text-[11.5px] leading-4 text-fg-3", className)}>
      {region}
    </span>
  );
}

export function TimeAgo({ at, className }: { at: number | string | undefined; className?: string }) {
  const n = useNow();
  return (
    <time suppressHydrationWarning className={className} title={at ? new Date(at).toISOString() : undefined}>
      {n ? ago(at, n) : "—"}
    </time>
  );
}

export function copy(text: string) {
  return navigator.clipboard?.writeText(text);
}

export function CopyButton({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <Button
      type="button"
      size="sm"
      onClick={async () => {
        await copy(text);
        setDone(true);
        setTimeout(() => setDone(false), 1600);
      }}
    >
      {done ? <Check className="size-3.5" /> : <Copy className="size-3.5" />} {done ? "Copied" : label}
    </Button>
  );
}
