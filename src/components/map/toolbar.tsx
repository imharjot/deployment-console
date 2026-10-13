"use client";
// Cloud map controls: environment, kinds, layers, lanes, region, connections, search and toggles on larger screens;
// search plus a Filters sheet on phones. And the footer that says which sources were read (and what is missing),
// per region when the console watches several.
import { AnimatePresence, motion } from "motion/react";
import { AlertTriangle, ChevronDown, ChevronRight, CircleSlash, Hourglass, Layers as LayersIcon, Lock, RotateCcw, ShieldAlert, SlidersHorizontal, Spline } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { LaneBy } from "@/lib/inventory/layout";
import { CATEGORY_LABEL, CATEGORY_ORDER, KIND_INFO, type InventoryView, type Layer, type ProviderStatus, type ResourceKind } from "@/lib/inventory/types";
import { regionLabel } from "@/lib/client/region";
import { NOT_IMPLEMENTED } from "@/lib/permissions";
import { ScrollX } from "@/app/_components/scroll-x";
import { Modal, Portal, enter, exit, popover } from "../motion";
import { Button, Chip, Segmented, cx } from "../ui";
import { CONFIDENCE, KIND_ICON } from "./kinds";
import { CONFIDENCES, SHARED, type Confidence } from "./filter";
import { LAYERS } from "./layers";

type Envs = InventoryView["envs"];

export function envOptions(envs: Envs, hasShared: boolean) {
  return [
    { value: "all", label: "All" },
    ...envs.map((e) => ({ value: e.id, label: e.label, protected: e.protected })),
    ...(hasShared ? [{ value: SHARED, label: "Shared" }] : []),
  ] as { value: string; label: string; protected?: boolean }[];
}

export function EnvFilter({ value, onChange, options }: { value: string; onChange(v: string): void; options: ReturnType<typeof envOptions> }) {
  return (
    <ScrollX className="max-w-full">
      <Segmented
        id="map-env"
        size="sm"
        value={value}
        onChange={onChange}
        options={options.map((o) => ({
          value: o.value,
          label: (
            <span className="inline-flex items-center gap-1 whitespace-nowrap">
              {o.protected && <Lock className="size-2.5 text-down" strokeWidth={2.25} aria-label="protected" />}
              {o.label}
            </span>
          ),
        }))}
      />
    </ScrollX>
  );
}

export function Toggle({ on, onChange, children, count, className }: { on: boolean; onChange(v: boolean): void; children: ReactNode; count?: number; className?: string }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={() => onChange(!on)}
      className={cx(
        "press flex h-9 flex-none items-center gap-2 rounded-lg border px-2.5 text-[14px] transition-colors duration-200 pointer-coarse:h-10",
        on ? "border-accent/40 bg-accent-soft text-fg" : "border-line bg-panel text-fg-2 hover:border-line-strong hover:text-fg",
        className,
      )}
    >
      <span className={cx("grid size-3.5 place-items-center rounded-[4px] border transition-colors duration-200", on ? "border-accent bg-accent" : "border-line-strong")} aria-hidden>
        {on && <span className="size-1.5 rounded-full bg-accent-fg" />}
      </span>
      {children}
      {count !== undefined && <span className="tabular-nums text-fg-3">{count}</span>}
    </button>
  );
}

// ---------- kinds ----------

function kindsByCategory(counts: Map<ResourceKind, number>) {
  return CATEGORY_ORDER.map((c) => ({
    category: c,
    kinds: (Object.keys(KIND_INFO) as ResourceKind[]).filter((k) => KIND_INFO[k].category === c && (counts.get(k) ?? 0) > 0),
  })).filter((g) => g.kinds.length);
}

export function KindList({ selected, counts, onChange }: { selected: ReadonlySet<ResourceKind> | null; counts: Map<ResourceKind, number>; onChange(v: Set<ResourceKind> | null): void }) {
  const groups = useMemo(() => kindsByCategory(counts), [counts]);
  const present = useMemo(() => groups.flatMap((g) => g.kinds), [groups]);
  const isOn = (k: ResourceKind) => !selected || selected.has(k);
  const set = (next: Set<ResourceKind>) => onChange(present.every((k) => next.has(k)) ? null : next);
  const toggle = (k: ResourceKind) => {
    const next = new Set(selected ?? present);
    if (next.has(k)) next.delete(k);
    else next.add(k);
    set(next);
  };
  const toggleGroup = (kinds: ResourceKind[]) => {
    const next = new Set(selected ?? present);
    const all = kinds.every((k) => next.has(k));
    for (const k of kinds) {
      if (all) next.delete(k);
      else next.add(k);
    }
    set(next);
  };
  if (!present.length) return <p className="px-2 py-3 text-xs text-fg-3">Nothing in this environment.</p>;
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 px-1 text-xs">
        <button type="button" className="rounded px-1 text-accent hover:underline disabled:text-fg-3 disabled:no-underline pointer-coarse:py-2" disabled={!selected} onClick={() => onChange(null)}>
          Show all
        </button>
        <span className="text-fg-3">·</span>
        <button type="button" className="rounded px-1 text-accent hover:underline pointer-coarse:py-2" onClick={() => onChange(new Set())}>
          Clear
        </button>
      </div>
      {groups.map((g) => {
        const all = g.kinds.every(isOn);
        return (
          <fieldset key={g.category}>
            <legend className="w-full">
              <button type="button" onClick={() => toggleGroup(g.kinds)} className="eyebrow flex w-full items-center justify-between rounded px-1 py-0.5 text-left hover:text-fg-2 pointer-coarse:py-2" aria-label={`${all ? "Hide" : "Show"} all ${CATEGORY_LABEL[g.category]}`}>
                {CATEGORY_LABEL[g.category]}
                <span className="font-normal normal-case tracking-normal text-fg-3">{all ? "hide all" : "show all"}</span>
              </button>
            </legend>
            <ul className="mt-1 space-y-px">
              {g.kinds.map((k) => {
                const I = KIND_ICON[k];
                return (
                  <li key={k}>
                    <label className="flex cursor-pointer items-center gap-2.5 rounded-lg px-1.5 py-1.5 text-[14px] text-fg-2 hover:bg-panel-3 hover:text-fg pointer-coarse:py-2.5">
                      <input type="checkbox" checked={isOn(k)} onChange={() => toggle(k)} className="size-3.5 accent-[var(--accent)]" />
                      <I className="size-3.5 flex-none text-fg-3" strokeWidth={1.6} aria-hidden />
                      <span className="min-w-0 flex-1 truncate">{KIND_INFO[k].label}</span>
                      <span className="tabular-nums text-xs text-fg-3">{counts.get(k)}</span>
                    </label>
                  </li>
                );
              })}
            </ul>
          </fieldset>
        );
      })}
    </div>
  );
}

// A toolbar button that opens a small panel under it (kinds, layers, connections). Escape or a click outside closes it.
function PopoverButton({ label, active, badge, icon, children, width = 288 }: { label: string; active: boolean; badge?: ReactNode; icon?: ReactNode; children: ReactNode; width?: number }) {
  const [pos, setPos] = useState<CSSProperties | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setPos(null), []);

  useEffect(() => {
    if (!pos) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!trigger.current?.contains(t) && !menu.current?.contains(t)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      e.preventDefault(); // one Escape closes the popover, not the panel beside the map
      close();
      trigger.current?.focus();
    };
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", close);
    menu.current?.querySelector<HTMLElement>("input, button")?.focus();
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", close);
    };
  }, [pos, close]);

  return (
    <>
      <button
        ref={trigger}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={!!pos}
        onClick={() => {
          if (pos) return close();
          const b = trigger.current!.getBoundingClientRect();
          setPos({ top: b.bottom + 8, left: Math.max(8, Math.min(b.left, window.innerWidth - width - 12)), width, maxHeight: Math.max(240, window.innerHeight - b.bottom - 24) });
        }}
        className={cx(
          "press flex h-9 flex-none items-center gap-2 rounded-lg border px-2.5 text-[14px] transition-colors duration-200",
          active ? "border-accent/40 bg-accent-soft text-fg" : "border-line bg-panel text-fg-2 hover:border-line-strong hover:text-fg",
        )}
      >
        {icon}
        {label}
        {badge !== undefined && <span className="tabular-nums text-fg-3">{badge}</span>}
        <ChevronDown className={cx("size-3.5 text-fg-3 transition-transform duration-300", pos && "rotate-180")} />
      </button>
      <Portal>
        <AnimatePresence>
          {pos && (
            <motion.div ref={menu} {...popover} role="dialog" aria-label={label} style={{ ...pos, transformOrigin: "top left" }} className="fixed z-[80] overflow-y-auto overscroll-contain rounded-xl border border-line bg-panel p-2 shadow-float">
              {children}
            </motion.div>
          )}
        </AnimatePresence>
      </Portal>
    </>
  );
}

export function KindPicker({ selected, counts, onChange }: { selected: ReadonlySet<ResourceKind> | null; counts: Map<ResourceKind, number>; onChange(v: Set<ResourceKind> | null): void }) {
  const present = [...counts.entries()].filter(([, n]) => n > 0).length;
  const shown = selected ? [...selected].filter((k) => (counts.get(k) ?? 0) > 0).length : present;
  return (
    <PopoverButton label="Kinds" active={!!selected} badge={selected ? `${shown} of ${present}` : present}>
      <KindList selected={selected} counts={counts} onChange={onChange} />
    </PopoverButton>
  );
}

// ---------- layers (D.9) ----------

export function LayerList({ on, counts, onChange }: { on: ReadonlySet<Layer>; counts: Map<Layer, number>; onChange(v: Set<Layer>): void }) {
  return (
    <div className="space-y-1">
      <p className="px-1.5 pb-1 text-[12.5px] leading-snug text-fg-3">The flow (edge, compute, messaging, data, storage) is always drawn. Support layers add what it relies on.</p>
      {LAYERS.map((l) => (
        <label key={l.id} className="flex cursor-pointer items-start gap-2.5 rounded-lg px-1.5 py-1.5 text-[14px] text-fg-2 hover:bg-panel-3 hover:text-fg pointer-coarse:py-2.5">
          <input
            type="checkbox"
            checked={on.has(l.id)}
            onChange={() => {
              const next = new Set(on);
              if (next.has(l.id)) next.delete(l.id);
              else next.add(l.id);
              onChange(next);
            }}
            className="mt-0.5 size-3.5 accent-[var(--accent)]"
          />
          <span className="min-w-0 flex-1">
            <span className="block text-fg">{l.label}</span>
            <span className="block text-[12.5px] leading-snug text-fg-3">{l.hint}</span>
          </span>
          <span className="tabular-nums text-xs text-fg-3">{(counts.get(l.id) ?? 0).toLocaleString()}</span>
        </label>
      ))}
    </div>
  );
}

export function LayersPicker({ on, counts, onChange }: { on: ReadonlySet<Layer>; counts: Map<Layer, number>; onChange(v: Set<Layer>): void }) {
  return (
    <PopoverButton label="Layers" icon={<LayersIcon className="size-3.5 text-fg-3" />} active={!(on.size === 1 && on.has("other"))} badge={`${on.size} of ${LAYERS.length}`} width={320}>
      <LayerList on={on} counts={counts} onChange={onChange} />
    </PopoverButton>
  );
}

// ---------- connections (F14) ----------

export function ConnectionList({ on, counts, onChange }: { on: ReadonlySet<Confidence> | null; counts: Record<Confidence, number>; onChange(v: Set<Confidence> | null): void }) {
  return (
    <div className="space-y-1">
      <p className="px-1.5 pb-1 text-[12.5px] leading-snug text-fg-3">How sure the console is that two resources talk. Hiding lines never hides resources.</p>
      {CONFIDENCES.map((c) => (
        <label key={c} className="flex cursor-pointer items-start gap-2.5 rounded-lg px-1.5 py-1.5 text-[14px] text-fg-2 hover:bg-panel-3 hover:text-fg pointer-coarse:py-2.5">
          <input
            type="checkbox"
            checked={!on || on.has(c)}
            onChange={() => {
              const next = new Set(on ?? CONFIDENCES);
              if (next.has(c)) next.delete(c);
              else next.add(c);
              onChange(next.size === CONFIDENCES.length ? null : next);
            }}
            className="mt-0.5 size-3.5 accent-[var(--accent)]"
          />
          <span className="min-w-0 flex-1">
            <span className="block text-fg">{CONFIDENCE[c].label}</span>
            <span className="block text-[12.5px] leading-snug text-fg-3">{CONFIDENCE[c].hint}</span>
          </span>
          <span className="tabular-nums text-xs text-fg-3">{counts[c].toLocaleString()}</span>
        </label>
      ))}
    </div>
  );
}

export function ConnectionsPicker({ on, counts, onChange }: { on: ReadonlySet<Confidence> | null; counts: Record<Confidence, number>; onChange(v: Set<Confidence> | null): void }) {
  return (
    <PopoverButton label="Connections" icon={<Spline className="size-3.5 text-fg-3" />} active={!!on} badge={on ? `${on.size} of 3` : undefined}>
      <ConnectionList on={on} counts={counts} onChange={onChange} />
    </PopoverButton>
  );
}

// ---------- lanes and region (D.9, requirement 6) ----------

export function LanesSelect({ value, onChange, regions }: { value: LaneBy; onChange(v: LaneBy): void; regions: boolean }) {
  const options: { value: LaneBy; label: string }[] = [
    { value: "env", label: "Environments" },
    { value: "vpc", label: "VPCs" },
    ...(regions ? [{ value: "region" as const, label: "Regions" }] : []),
    { value: "none", label: "None" },
  ];
  return (
    <label className="flex h-9 flex-none items-center gap-1.5 rounded-lg border border-line bg-panel pl-2.5 text-[14px] text-fg-2 hover:border-line-strong pointer-coarse:h-10">
      Lanes
      <select value={value} onChange={(e) => onChange(e.target.value as LaneBy)} aria-label="Lanes" className="h-full cursor-pointer rounded-r-lg bg-transparent pr-2 text-fg outline-none">
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </label>
  );
}

export function RegionSelect({ value, onChange, regions, counts }: { value: string; onChange(v: string): void; regions: string[]; counts?: Map<string, number> }) {
  return (
    <label className="flex h-9 flex-none items-center gap-1.5 rounded-lg border border-line bg-panel pl-2.5 text-[14px] text-fg-2 hover:border-line-strong pointer-coarse:h-10">
      Region
      <select value={value} onChange={(e) => onChange(e.target.value)} aria-label="Region" className="h-full max-w-[14rem] cursor-pointer rounded-r-lg bg-transparent pr-2 text-fg outline-none">
        <option value="all">All regions</option>
        {regions.map((r) => (
          <option key={r} value={r}>
            {regionLabel(r)}
            {counts?.get(r) !== undefined ? ` (${counts.get(r)!.toLocaleString()})` : ""}
          </option>
        ))}
      </select>
    </label>
  );
}

export function ResetChip({ onClick, count }: { onClick(): void; count: number }) {
  return (
    <button type="button" onClick={onClick} className="press flex h-9 flex-none items-center gap-1.5 rounded-lg px-2.5 text-[14px] text-accent hover:bg-accent-soft pointer-coarse:h-10" title="Back to the default filters">
      <RotateCcw className="size-3.5" /> Reset{count > 1 ? ` ${count} filters` : ""}
    </button>
  );
}

// Phones: everything but search lives in this sheet.
export function FiltersSheet({ onClose, children }: { onClose(): void; children: ReactNode }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  return (
    <Modal onClose={onClose} aria-label="Map filters" className="max-sm:max-h-[86dvh] sm:max-w-md">
      <div className="flex flex-none items-center justify-between px-5 pb-2 pt-1">
        <h2 className="font-display text-2xl">Filters</h2>
        <Button size="sm" variant="ghost" onClick={onClose}>Done</Button>
      </div>
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto overscroll-contain px-5 pb-6">{children}</div>
    </Modal>
  );
}

export function FiltersButton({ count, onClick }: { count: number; onClick(): void }) {
  return (
    <Button onClick={onClick} aria-haspopup="dialog" className="h-10 flex-none px-3">
      <SlidersHorizontal className="size-4" strokeWidth={1.75} />
      Filters
      {count > 0 && <span className="grid size-5 place-items-center rounded-full bg-accent text-[12px] font-semibold text-accent-fg">{count}</span>}
    </Button>
  );
}

// ---------- providers ----------

const STATE_TEXT: Record<ProviderStatus["state"], string> = { ok: "read", denied: "access denied", error: "error", disabled: "disabled", skipped: "skipped" };

// Per region: how many sources were read there and how many were refused or failed (requirement 6).
export function regionSummary(providers: ProviderStatus[], regions: string[]) {
  return regions.map((region) => {
    let ok = 0, denied = 0, error = 0, count = 0;
    for (const p of providers)
      for (const r of p.regions ?? [])
        if (r.region === region) {
          if (r.state === "ok") ok++;
          else if (r.state === "denied") denied++;
          else if (r.state === "error") error++;
          count += r.count;
        }
    return { region, ok, denied, error, count };
  });
}

export function ProvidersFooter({ providers, truncated, id, regions }: { providers: ProviderStatus[]; truncated?: string[]; id?: string; regions?: string[] }) {
  const [open, setOpen] = useState(false);
  // Registered but not built yet: neither a source that was read nor one that's missing, so it stays out of the count.
  const isPlanned = (p: ProviderStatus) => p.state === "disabled" && p.error === NOT_IMPLEMENTED;
  const built = providers.filter((p) => !isPlanned(p));
  const planned = providers.length - built.length;
  const by = (s: ProviderStatus["state"]) => built.filter((p) => p.state === s);
  const denied = by("denied"), errors = by("error"), disabled = by("disabled"), ok = by("ok");
  const notes = truncated ?? [];
  const attention = denied.length + errors.length;
  const order: ProviderStatus["state"][] = ["denied", "error", "disabled", "skipped", "ok"];
  const rank = (p: ProviderStatus) => (isPlanned(p) ? order.length : order.indexOf(p.state));
  const sorted = [...providers].sort((a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label));
  return (
    <section id={id} tabIndex={-1} aria-label="Sources" className="rounded-2xl border border-line bg-panel text-xs outline-none">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex w-full flex-wrap items-center gap-x-3 gap-y-1.5 px-3.5 py-2.5 text-left sm:px-4">
        <ChevronRight className={cx("size-3.5 flex-none text-fg-3 transition-transform duration-300", open && "rotate-90")} />
        <span className="text-fg-2">
          <span className="font-medium text-fg">{ok.length}</span> of {built.length} sources read
        </span>
        {denied.length > 0 && <Chip tone="bad"><ShieldAlert className="size-3" /> {denied.length} denied</Chip>}
        {errors.length > 0 && <Chip tone="warn"><AlertTriangle className="size-3" /> {errors.length} error{errors.length === 1 ? "" : "s"}</Chip>}
        {disabled.length > 0 && <Chip tone="muted"><CircleSlash className="size-3" /> {disabled.length} off</Chip>}
        {planned > 0 && <Chip tone="muted"><Hourglass className="size-3" /> {planned} coming</Chip>}
        {notes.length > 0 && <Chip tone="muted">{notes.length} note{notes.length === 1 ? "" : "s"}</Chip>}
        {regions && regions.length > 1 &&
          regionSummary(providers, regions).map((x) => (
            <span key={x.region} title={`${regionLabel(x.region)}: ${x.ok} sources read, ${x.count.toLocaleString()} resources${x.denied ? `, ${x.denied} denied` : ""}${x.error ? `, ${x.error} failing` : ""}`}>
              <Chip tone={x.denied ? "bad" : x.error ? "warn" : "muted"} mono>
                {x.region} · {x.ok}
                {x.denied ? ` · ${x.denied} denied` : ""}
                {x.error ? ` · ${x.error} failing` : ""}
              </Chip>
            </span>
          ))}
        <span className="ml-auto text-fg-3 max-sm:hidden">{attention ? "Some of the account may be missing from the map" : "Details"}</span>
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1, transition: enter }} exit={{ height: 0, opacity: 0, transition: exit }} className="overflow-hidden">
            <div className="max-h-[min(40vh,360px)] overflow-y-auto overscroll-contain border-t border-line">
              {notes.length > 0 && (
                <ul className="space-y-1 border-b border-line px-4 py-2.5 text-fg-2">
                  {notes.map((n) => (
                    <li key={n}>· {n}</li>
                  ))}
                </ul>
              )}
              <ul className="divide-y divide-line">
                {sorted.map((p) => (
                  <li key={p.id} className="flex flex-col gap-1 px-4 py-2 sm:flex-row sm:items-baseline sm:gap-3">
                    <span className="flex min-w-0 items-baseline gap-2 sm:w-56 sm:flex-none">
                      <span className="truncate font-medium text-fg">{p.label}</span>
                      <span className={cx(p.state === "denied" ? "text-down" : p.state === "error" ? "text-degraded" : "text-fg-3")}>{isPlanned(p) ? "coming soon" : STATE_TEXT[p.state]}</span>
                    </span>
                    <span className="min-w-0 flex-1 text-fg-2 [overflow-wrap:anywhere]">
                      {p.state === "ok" && (
                        <span className="text-fg-3">
                          {p.count.toLocaleString()} resource{p.count === 1 ? "" : "s"}
                          {p.ms !== undefined ? ` · ${p.ms < 1000 ? `${p.ms} ms` : `${(p.ms / 1000).toFixed(1)} s`}` : ""}
                        </span>
                      )}
                      {p.state === "denied" && (
                        <>
                          The console&apos;s role is missing{" "}
                          {(p.missing?.length ? p.missing : ["(unknown action)"]).map((m, i) => (
                            <span key={m}>
                              {i > 0 && ", "}
                              <code className="rounded bg-panel-3 px-1 font-mono text-[12px]">{m}</code>
                            </span>
                          ))}
                          .{" "}
                          <Link href="/settings/permissions" className="text-accent hover:underline">Grant it in Settings → AWS permissions</Link>
                        </>
                      )}
                      {p.state === "error" && <>{p.error ?? "failed"}{p.count ? <span className="text-fg-3"> · {p.count} read before it failed</span> : null}</>}
                      {(p.state === "disabled" || p.state === "skipped") && <span className="text-fg-3">{isPlanned(p) ? "not built yet" : p.error ?? (p.state === "disabled" ? "turned off" : "not run")}</span>}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  );
}
