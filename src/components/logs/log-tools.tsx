"use client";
import { AnimatePresence, motion } from "motion/react";
import { Bookmark, ChevronDown, History, Loader2, Minus, Play, Search, Sparkles, Star, Trash2, Users, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import useSWR from "swr";
import { ApiError, getJson, postJson } from "@/lib/client/api";
import { clock, stamp } from "@/lib/client/format";
import { FACET_FIELDS, facetValue } from "@/lib/logquery";
import { LEVELS, type LogStore } from "@/lib/logstore";
import type { EnvName, InsightsResult } from "@/lib/types";
import { popover } from "../motion";
import { Button, Chip, IconButton, cx } from "../ui";

// ---------- saved + recent searches (per browser) ----------
const SAVED = "console.logs.saved", RECENT = "console.logs.recent";
const read = <T,>(k: string, d: T): T => {
  try {
    return JSON.parse(localStorage.getItem(k) ?? "") as T;
  } catch {
    return d;
  }
};
const write = (k: string, v: unknown) => {
  try {
    localStorage.setItem(k, JSON.stringify(v));
  } catch {
    /* storage blocked */
  }
};
export function rememberQuery(q: string) {
  if (!q.trim()) return;
  write(RECENT, [q, ...read<string[]>(RECENT, []).filter((x) => x !== q)].slice(0, 8));
}

// ---------- saved log queries (per person or shared with the team: /api/saved, kind "log-query") ----------
// The API may not exist (an older console, or a deployment without it): a 404 hides the server list and "save"
// falls back to this browser.
export interface SavedLogQuery {
  id: string;
  name: string;
  visibility?: "private" | "team";
  mine?: boolean;
  canEdit?: boolean; // its owner, or an admin for one shared with the team
  payload: { env?: string; services?: string[]; query: string; minutes: number };
}
export interface SaveContext {
  env: EnvName;
  services: string[];
  minutes: number;
}
const SAVED_KEY = "/api/saved?kind=log-query";

// Defensive about the list's shape: items under `items` / `saved` or a bare array; anything malformed is skipped.
export function parseSaved(body: unknown): SavedLogQuery[] {
  const o = body as { items?: unknown; saved?: unknown } | unknown[] | null;
  const list = Array.isArray(o) ? o : Array.isArray(o?.items) ? o.items : Array.isArray(o?.saved) ? o.saved : [];
  const out: SavedLogQuery[] = [];
  for (const raw of list as Record<string, unknown>[]) {
    const p = raw?.payload as Record<string, unknown> | undefined;
    if (!raw || (typeof raw.id !== "string" && typeof raw.id !== "number") || typeof raw.name !== "string" || !p || typeof p.query !== "string") continue;
    const services = Array.isArray(p.services) ? p.services.filter((x): x is string => typeof x === "string") : undefined;
    out.push({
      id: String(raw.id), name: raw.name,
      ...(raw.visibility === "team" || raw.visibility === "private" ? { visibility: raw.visibility } : {}),
      ...(typeof raw.mine === "boolean" ? { mine: raw.mine } : {}),
      ...(typeof raw.canEdit === "boolean" ? { canEdit: raw.canEdit } : {}),
      payload: { ...(typeof p.env === "string" ? { env: p.env } : {}), ...(services?.length ? { services } : {}), query: p.query, minutes: typeof p.minutes === "number" ? p.minutes : 60 },
    });
  }
  return out;
}

async function savedFetcher(url: string): Promise<SavedLogQuery[] | null> {
  try {
    return parseSaved(await getJson(url));
  } catch (e) {
    if (e instanceof ApiError && (e.status === 404 || e.status === 401 || e.status === 403)) return null; // not available: hidden
    throw e;
  }
}

export function useSavedQueries() {
  const { data, mutate } = useSWR<SavedLogQuery[] | null>(SAVED_KEY, savedFetcher, { revalidateOnFocus: false });
  return { list: data ?? null, available: Array.isArray(data), refresh: mutate };
}

export const PRESETS: { label: string; q: string }[] = [
  { label: "Errors", q: "level:error" },
  { label: "Warnings and worse", q: "level:>=warn" },
  { label: "5xx responses", q: "status:>=500" },
  { label: "4xx responses", q: "status:400..499" },
  { label: "Slow requests (> 1s)", q: "duration:>1000" },
  { label: "Database errors", q: '(ECONNREFUSED OR deadlock OR "too many connections") level:>=warn' },
  { label: "Timeouts", q: "timeout OR ETIMEDOUT" },
  { label: "Crashes and restarts", q: '(panic OR "uncaught exception" OR SIGTERM OR SIGKILL) level:>=warn' },
  { label: "Hide health checks", q: '-"/health" -"/ready"' },
];

export const SYNTAX: [string, string][] = [
  ["word", "contains word (case-insensitive)"],
  ['"exact phrase"', "contains phrase"],
  ["/regex/i", "regular expression"],
  ["a OR b · -a · NOT a · ( )", "boolean logic"],
  ["level:error · level:>=warn", "by level"],
  ["status:>=500 · status:500..599", "numeric compare / range"],
  ["duration:>1000 · took:<50", "ms; 2s = 2000"],
  ["path:/api/v2/orders*", "wildcards"],
  ["method:POST · service:api", "any JSON / key=value field"],
];

export function QueryBar({ value, onChange, error, inputRef, count, onNav, matchPos, mode, onMode, className, saveContext, onOpenSaved }: {
  value: string; onChange(v: string): void; error?: string | null; inputRef: React.RefObject<HTMLInputElement | null>;
  count: number; onNav(dir: 1 | -1): void; matchPos: number | null; mode: "filter" | "highlight"; onMode(m: "filter" | "highlight"): void; className?: string;
  saveContext?: SaveContext; onOpenSaved?(q: SavedLogQuery): void;
}) {
  const [open, setOpen] = useState(false);
  const [saved, setSaved] = useState<{ name: string; q: string }[]>([]);
  const [recent, setRecent] = useState<string[]>([]);
  const server = useSavedQueries();
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  // Focusing an empty query opens the presets as a hint; typing closes them again so they never cover the lines
  // (on a phone they fill most of the screen). Opened from the button, they stay until dismissed.
  const hint = useRef(false);
  const toggle = (next: boolean, asHint = false) => {
    hint.current = next && asHint;
    if (next) {
      setSaved(read(SAVED, []));
      setRecent(read(RECENT, []));
    }
    setOpen(next);
  };
  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => !wrap.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [open]);
  const pick = (q: string) => {
    onChange(q);
    rememberQuery(q);
    setOpen(false);
    inputRef.current?.focus();
  };
  const save = async () => {
    const name = window.prompt("Name this query", value.slice(0, 40))?.trim();
    if (!name) return;
    setSaveErr(null);
    if (server.available && saveContext) {
      try {
        await postJson("/api/saved", { kind: "log-query", name: name.slice(0, 80), payload: { env: saveContext.env, services: saveContext.services, query: value, minutes: saveContext.minutes } });
        await server.refresh();
        return;
      } catch (e) {
        setSaveErr((e as Error).message);
        return;
      }
    }
    const next = [{ name, q: value }, ...read<{ name: string; q: string }[]>(SAVED, []).filter((s) => s.name !== name)].slice(0, 30);
    write(SAVED, next);
    setSaved(next);
  };
  const remove = async (q: SavedLogQuery) => {
    setSaveErr(null);
    try {
      const res = await fetch(`/api/saved/${encodeURIComponent(q.id)}`, { method: "DELETE", headers: { "x-console-csrf": "1" } });
      if (!res.ok && res.status !== 404) throw new Error(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? `HTTP ${res.status}`);
      await server.refresh();
    } catch (e) {
      setSaveErr((e as Error).message);
    }
  };
  const openSaved = (q: SavedLogQuery) => {
    setOpen(false);
    if (onOpenSaved) onOpenSaved(q);
    else pick(q.payload.query);
  };
  return (
    <div ref={wrap} className={cx("relative flex min-w-0 flex-1 items-center gap-1.5 md:min-w-[280px]", className)}>
      <div className={cx("flex h-8 min-w-0 flex-1 items-center gap-2 rounded-lg border bg-panel-2 px-2.5 transition-colors focus-within:border-accent pointer-coarse:h-10", error ? "border-down/60" : "border-line")}>
        <Search className="size-3.5 flex-none text-fg-3" />
        <input
          ref={inputRef}
          value={value}
          onChange={(e) => {
            onChange(e.target.value);
            if (hint.current && e.target.value) toggle(false);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              rememberQuery(value);
              onNav(e.shiftKey ? -1 : 1);
            } else if (e.key === "Escape") (e.target as HTMLInputElement).blur();
          }}
          onFocus={() => !value && toggle(true, true)}
          spellCheck={false}
          placeholder='filter · level:error  status:>=500  "slow query"  /timeout/i  -health'
          aria-label="Filter loaded lines"
          enterKeyHint="search"
          className="h-full min-w-0 flex-1 bg-transparent font-mono text-[13px] outline-none placeholder:font-sans placeholder:text-fg-3"
        />
        {value && (
          <span className="flex-none font-mono text-[11.5px] tabular-nums text-fg-3">
            {matchPos !== null ? `${matchPos + 1}/` : ""}
            {count.toLocaleString()} match{count === 1 ? "" : "es"}
          </span>
        )}
        {value && (
          <button onClick={() => onChange("")} aria-label="Clear" className="-mr-1 grid size-6 flex-none place-items-center rounded-md text-fg-3 hover:text-fg pointer-coarse:size-8">
            <X className="size-3.5" />
          </button>
        )}
      </div>
      <div className="flex flex-none rounded-lg border border-line bg-panel-2">
        <button className="grid h-8 w-7 place-items-center text-fg-3 hover:text-fg disabled:opacity-40 pointer-coarse:h-10 pointer-coarse:w-9" disabled={!count} onClick={() => onNav(-1)} aria-label="Previous match (shift+enter)">↑</button>
        <button className="grid h-8 w-7 place-items-center text-fg-3 hover:text-fg disabled:opacity-40 pointer-coarse:h-10 pointer-coarse:w-9" disabled={!count} onClick={() => onNav(1)} aria-label="Next match (enter)">↓</button>
      </div>
      {/* On phones this toggle lives in the viewer's options panel instead. */}
      <MatchMode value={mode} onChange={onMode} className="max-md:hidden" />
      <Button size="sm" variant="ghost" onClick={() => toggle(!open)} aria-label="Presets and saved searches" aria-expanded={open} className="flex-none">
        <Bookmark className="size-3.5" />
        <ChevronDown className="size-3" />
      </Button>
      {error && <div className="absolute left-0 top-[calc(100%+4px)] z-20 rounded-md bg-down/12 px-2 py-1 text-[12px] text-down">{error}</div>}
      <AnimatePresence>
        {open && (
          <motion.div {...popover} className="absolute right-0 top-[calc(100%+6px)] z-30 grid max-h-[min(70dvh,560px)] w-full origin-top-right gap-3 overflow-y-auto overscroll-contain rounded-xl border border-line bg-panel p-3 text-[13px] shadow-float max-md:grid-cols-[minmax(0,1fr)] md:w-[640px] md:max-w-[90vw] md:grid-cols-2">
            <div className="min-w-0 space-y-3">
              <Group title="Presets" icon={<Sparkles className="size-3" />}>
                {PRESETS.map((p) => <Item key={p.q} onClick={() => pick(p.q)} label={p.label} q={p.q} />)}
              </Group>
              {!!recent.length && (
                <Group title="Recent" icon={<History className="size-3" />}>
                  {recent.map((q) => <Item key={q} onClick={() => pick(q)} q={q} />)}
                </Group>
              )}
            </div>
            <div className="min-w-0 space-y-3">
              {server.available && (
                <Group title="Saved queries" icon={<Star className="size-3" />} action={value ? <button className="text-accent hover:underline pointer-coarse:py-1.5" onClick={save}>save query</button> : null}>
                  {server.list!.length ? (
                    server.list!.map((q) => (
                      <div key={q.id} className="group flex items-center">
                        <button onClick={() => openSaved(q)} className="flex w-full min-w-0 items-baseline gap-2 rounded-md px-2 py-1 text-left hover:bg-panel-3 pointer-coarse:py-2" title={`${q.payload.env ?? "any environment"} · ${q.payload.services?.join(", ") ?? "same services"} · last ${q.payload.minutes} min`}>
                          <span className="flex-none text-fg">{q.name}</span>
                          {q.visibility === "team" && <Users className="size-3 flex-none self-center text-fg-3" aria-label="shared with the team" />}
                          <span className="truncate font-mono text-[12px] text-fg-3">{q.payload.query || "(no filter)"}</span>
                        </button>
                        {(q.canEdit ?? q.mine) !== false && (
                          <button
                            className="grid size-7 flex-none place-items-center rounded-md text-fg-3 opacity-0 hover:text-down focus-visible:opacity-100 group-hover:opacity-100 pointer-coarse:size-9 pointer-coarse:opacity-100"
                            aria-label={`Delete ${q.name}`}
                            onClick={() => remove(q)}
                          >
                            <Trash2 className="size-3" />
                          </button>
                        )}
                      </div>
                    ))
                  ) : (
                    <div className="px-2 py-1 text-fg-3">Type a query, then “save query”: it keeps the environment, services and time range.</div>
                  )}
                  {saveErr && <div className="px-2 py-1 text-down">{saveErr}</div>}
                </Group>
              )}
              {/* With saved queries on the server, this browser's old list stays readable until it is emptied. */}
              {(!server.available || saved.length > 0) && (
                <Group title={server.available ? "In this browser" : "Saved"} icon={<Star className="size-3" />} action={value && !server.available ? <button className="text-accent hover:underline" onClick={save}>save current</button> : null}>
                  {saved.length ? (
                    saved.map((s) => (
                      <div key={s.name} className="group flex items-center">
                        <Item onClick={() => pick(s.q)} label={s.name} q={s.q} />
                        <button
                          className="grid size-7 flex-none place-items-center rounded-md text-fg-3 opacity-0 hover:text-down focus-visible:opacity-100 group-hover:opacity-100 pointer-coarse:size-9 pointer-coarse:opacity-100"
                          aria-label={`Delete ${s.name}`}
                          onClick={() => {
                            const next = saved.filter((x) => x.name !== s.name);
                            write(SAVED, next);
                            setSaved(next);
                          }}
                        >
                          <Trash2 className="size-3" />
                        </button>
                      </div>
                    ))
                  ) : (
                    <div className="px-2 py-1 text-fg-3">Type a query, then “save current”.</div>
                  )}
                </Group>
              )}
              <Group title="Syntax">
                <table className="w-full">
                  <tbody>
                    {SYNTAX.map(([a, b]) => (
                      <tr key={a}>
                        <td className="whitespace-nowrap py-0.5 pr-2 font-mono text-[12px] text-fg">{a}</td>
                        <td className="py-0.5 text-[12px] text-fg-3">{b}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Group>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function Group({ title, icon, action, children }: { title: string; icon?: React.ReactNode; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div>
      <div className="eyebrow mb-1 flex items-center justify-between px-2">
        <span className="inline-flex items-center gap-1">{icon}{title}</span>
        {action}
      </div>
      <div className="space-y-px">{children}</div>
    </div>
  );
}
function Item({ label, q, onClick }: { label?: string; q: string; onClick(): void }) {
  return (
    <button onClick={onClick} className="flex w-full min-w-0 items-baseline gap-2 rounded-md px-2 py-1 text-left hover:bg-panel-3 pointer-coarse:py-2">
      {label && <span className="flex-none text-fg">{label}</span>}
      <span className="truncate font-mono text-[12px] text-fg-3">{q}</span>
    </button>
  );
}

// Whether the query hides non-matching lines or only marks matches.
export function MatchMode({ value, onChange, className }: { value: "filter" | "highlight"; onChange(m: "filter" | "highlight"): void; className?: string }) {
  return (
    <div role="radiogroup" aria-label="Match mode" className={cx("flex flex-none rounded-lg border border-line bg-panel-2 p-0.5 text-[12px]", className)}>
      {(["filter", "highlight"] as const).map((m) => (
        <button
          key={m}
          role="radio"
          aria-checked={value === m}
          onClick={() => onChange(m)}
          className={cx("rounded-md px-2 py-1 capitalize transition-colors duration-200 pointer-coarse:py-1.5", value === m ? "bg-panel text-fg shadow-card dark:bg-panel-3" : "text-fg-3 hover:text-fg-2")}
          title={m === "filter" ? "show only matching lines" : "show everything, mark and jump between matches"}
        >
          {m}
        </button>
      ))}
    </div>
  );
}

// A value that follows `value` at most once per `ms`: at once when it has been quiet (leading), and with the latest
// value at the end of a burst (trailing). A debounce would freeze for as long as a busy stream keeps changing (F55).
export function useThrottled<T>(value: T, ms: number): T {
  const [out, setOut] = useState(value);
  const last = useRef(0);
  useEffect(() => {
    const wait = Math.max(0, last.current + ms - Date.now());
    const t = setTimeout(() => {
      last.current = Date.now();
      setOut(value);
    }, wait);
    return () => clearTimeout(t);
  }, [value, ms]);
  return out;
}

// ---------- histogram with brush ----------
export function Histogram({ store, version, range, onRange, height = 56 }: { store: LogStore; version: number; range: [number, number] | null; onRange(r: [number, number] | null): void; height?: number }) {
  // Recompute at most every 400ms: a busy stream bumps `version` many times a second.
  const tick = useThrottled(version, 400);
  const h = useMemo(() => {
    void tick;
    return store.histogram(90);
  }, [store, tick]);
  const ref = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ a: number; b: number } | null>(null);
  const [hov, setHov] = useState<number | null>(null);
  if (!h) return <div style={{ height }} className="grid place-items-center border-b border-line text-[12px] text-fg-3">no lines to chart</div>;
  const n = h.err.length;
  const totals = h.err.map((_, i) => h.err[i] + h.warn[i] + h.other[i]);
  const max = Math.max(1, ...totals);
  const span = Math.max(1, h.t1 - h.t0);
  const tAt = (f: number) => h.t0 + f * span;
  const frac = (e: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
  };
  const sel = drag ? [Math.min(drag.a, drag.b), Math.max(drag.a, drag.b)] : range && range[1] >= h.t0 ? [(range[0] - h.t0) / span, (range[1] - h.t0) / span] : null;
  return (
    <div className="relative border-b border-line px-3 pb-1 pt-2">
      <div
        ref={ref}
        // pan-y: a sideways drag selects a window, a vertical one still scrolls the page around the viewer.
        className="relative flex cursor-crosshair touch-pan-y items-end gap-px"
        style={{ height }}
        onPointerDown={(e) => {
          const f = frac(e);
          setDrag({ a: f, b: f });
          (e.target as Element).setPointerCapture?.(e.pointerId);
        }}
        onPointerMove={(e) => {
          const f = frac(e);
          setHov(Math.min(n - 1, Math.floor(f * n)));
          if (drag) setDrag({ ...drag, b: f });
        }}
        onPointerLeave={() => setHov(null)}
        onPointerCancel={() => {
          setDrag(null);
          setHov(null);
        }}
        onPointerUp={() => {
          if (!drag) return;
          const [a, b] = [Math.min(drag.a, drag.b), Math.max(drag.a, drag.b)];
          setDrag(null);
          onRange(b - a < 0.01 ? null : [Math.floor(tAt(a)), Math.ceil(tAt(b))]);
        }}
      >
        {totals.map((t, i) => (
          <div key={i} className="flex flex-1 flex-col justify-end" style={{ height: "100%", opacity: hov === null || hov === i ? 1 : 0.6 }}>
            <div style={{ height: `${(h.err[i] / max) * 100}%`, background: "var(--down)" }} />
            <div style={{ height: `${(h.warn[i] / max) * 100}%`, background: "var(--degraded)" }} />
            <div style={{ height: `${(h.other[i] / max) * 100}%`, background: "color-mix(in srgb, var(--text-3) 38%, transparent)" }} className="rounded-t-[1px]" />
          </div>
        ))}
        {sel && <div className="pointer-events-none absolute inset-y-0 rounded border border-accent/60 bg-accent/15" style={{ left: `${sel[0] * 100}%`, width: `${(sel[1] - sel[0]) * 100}%` }} />}
        {hov !== null && !drag && (
          <div className="pointer-events-none absolute -top-1 z-10 -translate-y-full rounded-md border border-line bg-panel px-2 py-1 text-[11.5px] shadow-card" style={{ left: `${Math.min(80, (hov / n) * 100)}%` }}>
            <div className="font-mono text-fg-2">{clock(tAt(hov / n))}</div>
            <div className="text-fg-3"><span className="text-down">{h.err[hov]}</span> err · <span className="text-degraded">{h.warn[hov]}</span> warn · {h.other[hov]} other</div>
          </div>
        )}
      </div>
      {/* Phones drop the hint, and the window's ends while a zoomed range is shown, to keep one line. */}
      <div className="mt-0.5 flex justify-between gap-2 font-mono text-[11px] text-fg-3">
        <span className={cx("truncate", range && "max-sm:hidden")}>{stamp(h.t0)}</span>
        {range ? (
          <button onClick={() => onRange(null)} className="inline-flex flex-none items-center gap-1 text-accent hover:underline max-sm:mx-auto pointer-coarse:-my-1 pointer-coarse:py-1" aria-label="Clear time window">
            {clock(range[0])} → {clock(range[1])} <X className="size-3" />
          </button>
        ) : (
          <span className="font-sans max-sm:hidden">drag to zoom into a time window</span>
        )}
        <span className={cx("truncate", range && "max-sm:hidden")}>{stamp(h.t1)}</span>
      </div>
    </div>
  );
}

// ---------- facets ----------
const q = (v: string) => (/[\s"():]/.test(v) ? JSON.stringify(v) : v);
export function Facets({ store, version, serviceOf, onAdd, onClose, className }: { store: LogStore; version: number; serviceOf(stream: string): string; onAdd(term: string): void; onClose?: () => void; className?: string }) {
  const tick = useThrottled(version, 900);
  const data = useMemo(() => {
    void tick;
    const lv = store.levelCounts();
    const services = new Map<string, number>();
    for (const s of store.streamCounts()) services.set(serviceOf(s.name), (services.get(serviceOf(s.name)) ?? 0) + s.count);
    return {
      level: [6, 5, 4, 3, 2, 1].filter((l) => lv[l]).map((l) => ({ value: LEVELS[l], count: lv[l] })),
      service: [...services.entries()].sort((a, b) => b[1] - a[1]).map(([value, count]) => ({ value, count })),
      ...Object.fromEntries(FACET_FIELDS.map((f) => [f, store.facets((m) => facetValue(m, f), 30_000, 8)])),
    } as Record<string, { value: string; count: number }[]>;
  }, [store, tick, serviceOf]);
  return (
    <div className={cx("w-56 flex-none space-y-4 overflow-y-auto overscroll-contain border-r border-line p-3 text-[13px]", className)}>
      {onClose && (
        <div className="-mb-1 flex items-center justify-between">
          <span className="text-[14px] font-medium text-fg">Facets</span>
          <IconButton label="Close facets" onClick={onClose}>
            <X className="size-4" />
          </IconButton>
        </div>
      )}
      {(["level", "service", "status", "method", "path"] as const).map((f) => {
        const rows = data[f] ?? [];
        if (!rows.length || (f === "service" && rows.length < 2)) return null;
        const max = Math.max(...rows.map((r) => r.count));
        return (
          <div key={f}>
            <div className="eyebrow mb-1">{f}</div>
            {rows.map((r) => (
              <div key={r.value} className="group flex items-center gap-0.5">
                <button
                  title={`click: only ${f}:${r.value} · shift-click: exclude`}
                  onClick={(e) => onAdd(`${e.shiftKey || e.altKey ? "-" : ""}${f}:${q(r.value)}`)}
                  className="relative flex min-w-0 flex-1 items-center justify-between gap-2 rounded px-1.5 py-0.5 text-left hover:bg-panel-3 pointer-coarse:py-2"
                >
                  <span className="absolute inset-y-0 left-0 rounded bg-fg-3/10" style={{ width: `${(r.count / max) * 100}%` }} />
                  <span className={cx("relative truncate font-mono text-[12px]", f === "level" && (r.value === "error" || r.value === "fatal") ? "text-down" : f === "level" && r.value === "warn" ? "text-degraded" : "text-fg-2")}>{r.value}</span>
                  <span className="relative flex-none tabular-nums text-fg-3">{r.count.toLocaleString()}</span>
                </button>
                {/* Exclude without a modifier key: always shown on touch screens, on hover or focus elsewhere. */}
                <button
                  onClick={() => onAdd(`-${f}:${q(r.value)}`)}
                  aria-label={`Exclude ${f}:${r.value}`}
                  title="exclude"
                  className="grid size-5 flex-none place-items-center rounded text-fg-3 opacity-0 hover:bg-panel-3 hover:text-down focus-visible:opacity-100 group-hover:opacity-100 pointer-coarse:size-9 pointer-coarse:opacity-100"
                >
                  <Minus className="size-3" />
                </button>
              </div>
            ))}
          </div>
        );
      })}
      <div className="text-[11.5px] leading-relaxed text-fg-3">Counts cover loaded lines (newest 30k for fields). Click to filter; shift-click or − to exclude.</div>
    </div>
  );
}

// ---------- Logs Insights ----------
export const INSIGHTS: { label: string; q: string }[] = [
  { label: "Errors per 5 min", q: 'fields @timestamp, @message\n| filter @message like /"level":5\\d|level=ERROR/\n| stats count(*) by bin(5m)' },
  { label: "Latest errors", q: 'fields @timestamp, @message, @logStream\n| filter @message like /"level":5\\d|level=ERROR/\n| sort @timestamp desc\n| limit 200' },
  { label: "Requests per minute", q: 'filter msg = "request completed"\n| stats count(*) by bin(1m)' },
  { label: "Slowest requests", q: "fields @timestamp, req.method, req.url, responseTime\n| filter responseTime > 1000\n| sort responseTime desc\n| limit 100" },
  { label: "Top paths", q: "filter ispresent(req.url)\n| stats count(*) as hits by req.url\n| sort hits desc\n| limit 25" },
  { label: "Messages matching text", q: "fields @timestamp, @message\n| filter @message like /timeout/\n| sort @timestamp desc\n| limit 200" },
];

export function InsightsPanel({ env, services, onLines }: { env: EnvName; services: string[]; onLines(rows: { ts: number; msg: string; stream: string }[]): void }) {
  const [query, setQuery] = useState(INSIGHTS[0].q);
  const [hours, setHours] = useState("3");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [res, setRes] = useState<InsightsResult | null>(null);
  const run = async () => {
    setBusy(true);
    setErr(null);
    setRes(null);
    try {
      const end = Date.now();
      const { id } = await postJson<{ id: string }>("/api/logs/insights", { env, services, query, start: end - Number(hours) * 3_600_000, end });
      for (let i = 0; i < 60; i++) {
        const r = await getJson<InsightsResult>(`/api/logs/insights/${id}`);
        if (r.status === "Complete" || r.status === "Failed" || r.status === "Cancelled" || r.status === "Timeout") {
          if (r.status !== "Complete") throw new Error(`query ${r.status.toLowerCase()}`);
          setRes(r);
          if (r.rows[0]?.["@message"] !== undefined) {
            onLines(r.rows.map((row) => ({ ts: Date.parse(`${row["@timestamp"]?.replace(" ", "T")}Z`) || 0, msg: row["@message"], stream: row["@logStream"] ?? "insights" })).reverse());
          }
          return;
        }
        await new Promise((r) => setTimeout(r, i < 5 ? 500 : 1000));
      }
      throw new Error("query still running after 60s");
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const cols = res?.rows.length ? Object.keys(res.rows[0]) : [];
  const binCol = cols.find((c) => c.startsWith("bin("));
  const numCol = cols.find((c) => c !== binCol && res!.rows.every((r) => !Number.isNaN(Number(r[c]))));
  const tabular = !!res && !cols.includes("@message");
  return (
    <div className="flex min-h-0 flex-col gap-2 border-b border-line p-3">
      <div className="flex flex-wrap items-center gap-1.5">
        {INSIGHTS.map((p) => (
          <button key={p.label} onClick={() => setQuery(p.q)} className={cx("rounded-md border px-2 py-0.5 text-[12px] transition-colors pointer-coarse:py-1.5", query === p.q ? "border-accent/50 bg-accent-soft text-accent" : "border-line text-fg-3 hover:text-fg-2")}>
            {p.label}
          </button>
        ))}
      </div>
      <div className="flex flex-col gap-2 sm:flex-row">
        <textarea
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => (e.metaKey || e.ctrlKey) && e.key === "Enter" && run()}
          rows={4}
          spellCheck={false}
          aria-label="Logs Insights query"
          className="min-w-0 flex-1 resize-y rounded-lg border border-line bg-panel-2 p-2 font-mono text-[13px] outline-none focus:border-accent"
        />
        <div className="flex flex-wrap items-center gap-2 sm:w-32 sm:flex-col sm:items-stretch">
          <select value={hours} onChange={(e) => setHours(e.target.value)} aria-label="Time range" className="h-8 rounded-lg border border-line bg-panel-2 px-2 text-xs outline-none focus:border-accent pointer-coarse:h-10">
            <option value="1">last 1 h</option>
            <option value="3">last 3 h</option>
            <option value="24">last 24 h</option>
            <option value="72">last 3 days</option>
            <option value="168">last 7 days</option>
          </select>
          <Button size="sm" variant="primary" onClick={run} disabled={busy || !services.length}>
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" />} Run
          </Button>
          <span className="text-[11px] text-fg-3"><span className="pointer-coarse:hidden">⌘↵ to run · </span>billed per GB scanned</span>
        </div>
      </div>
      {err && <div className="rounded-md bg-down/10 px-2 py-1 text-xs text-down">{err}</div>}
      {res && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-fg-3">
          <Chip tone="ok">{res.rows.length} rows</Chip>
          {res.stats && <span>{res.stats.recordsMatched.toLocaleString()} matched · {res.stats.recordsScanned.toLocaleString()} scanned · {(res.stats.bytesScanned / 1e6).toFixed(1)} MB</span>}
          {!tabular && <span>results loaded into the list below</span>}
        </div>
      )}
      {tabular && res && binCol && numCol && <BinChart rows={res.rows} bin={binCol} val={numCol} />}
      {tabular && res && (
        <div className="max-h-64 overflow-auto rounded-lg border border-line">
          <table className="w-full text-[13px]">
            <thead className="eyebrow sticky top-0 bg-panel-2 text-left">
              <tr>{cols.map((c) => <th key={c} className="px-2 py-1.5 font-medium">{c}</th>)}</tr>
            </thead>
            <tbody className="divide-y divide-line font-mono">
              {res.rows.map((r, i) => (
                <tr key={i} className="hover:bg-panel-2">{cols.map((c) => <td key={c} className="max-w-[520px] truncate px-2 py-1" title={r[c]}>{r[c]}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function BinChart({ rows, bin, val }: { rows: Record<string, string>[]; bin: string; val: string }) {
  const pts = rows.map((r) => ({ t: Date.parse(`${r[bin].replace(" ", "T")}Z`), v: Number(r[val]) })).filter((p) => Number.isFinite(p.t)).sort((a, b) => a.t - b.t);
  const max = Math.max(1, ...pts.map((p) => p.v));
  return (
    <div className="flex h-24 items-end gap-0.5 rounded-lg border border-line p-2">
      {pts.map((p) => (
        <div key={p.t} className="group relative flex-1 rounded-t bg-fg-3/40 hover:bg-fg-3/70" style={{ height: `${(p.v / max) * 100}%` }}>
          <span className="pointer-events-none absolute -top-5 left-1/2 hidden -translate-x-1/2 whitespace-nowrap rounded bg-panel px-1 text-[11px] text-fg shadow-card group-hover:block">
            {clock(p.t).slice(0, 5)} · {p.v}
          </span>
        </div>
      ))}
    </div>
  );
}
