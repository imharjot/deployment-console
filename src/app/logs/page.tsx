"use client";
import { AnimatePresence, motion } from "motion/react";
import { Check, ChevronDown, Layers } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SavedLogQuery } from "@/components/logs/log-tools";
import { LogViewer, SERVICE_COLORS } from "@/components/logs/log-viewer";
import { popover } from "@/components/motion";
import { StateDot } from "@/components/state";
import { Empty, Skeleton, cx } from "@/components/ui";
import { useEnv, useOverview } from "@/lib/client/env";
import type { ResourceView } from "@/lib/types";

export default function LogsPage() {
  return (
    <Suspense>
      <Logs />
    </Suspense>
  );
}

// Logs get the whole page: services are picked from a compact menu in the log toolbar. The URL carries the view —
// ?env=, ?service=a,b, ?q= (the filter) and ?minutes= (the search range) — so a link or a saved query opens it as it was.
function Logs() {
  const { env, setEnv } = useEnv();
  const { data } = useOverview(env);
  const params = useSearchParams();
  const [picked, setPicked] = useState<string[]>(() => (params.get("service") ?? "").split(",").filter(Boolean));
  // What the viewer starts with; a saved query for another env or other services replaces it (the viewer remounts).
  const [initial, setInitial] = useState(() => ({ q: params.get("q") ?? "", minutes: Number(params.get("minutes")) || undefined, n: 0 }));
  const openSaved = useCallback(
    (s: SavedLogQuery) => {
      if (s.payload.env && s.payload.env !== env) setEnv(s.payload.env);
      if (s.payload.services?.length) setPicked(s.payload.services);
      setInitial((x) => ({ q: s.payload.query, minutes: s.payload.minutes, n: x.n + 1 }));
    },
    [env, setEnv],
  );
  const onQueryChange = useCallback((q: string) => {
    setInitial((x) => (x.q === q ? x : { ...x, q })); // kept for the next remount (another service picked); same key, no remount now
    const u = new URL(window.location.href);
    if (q) u.searchParams.set("q", q);
    else u.searchParams.delete("q");
    window.history.replaceState(null, "", u);
  }, []);
  const services = useMemo(() => (data?.services ?? []).filter((s) => s.tabs.includes("logs")), [data]); // only services with an awslogs group
  const valid = picked.filter((p) => services.some((s) => s.id === p));
  const current = valid.length ? valid : services[0] ? [services[0].id] : [];
  const key = current.join(",");

  useEffect(() => {
    if (!key) return;
    const u = new URL(window.location.href);
    u.searchParams.set("service", key);
    u.searchParams.set("env", env);
    window.history.replaceState(null, "", u);
  }, [key, env]);

  return (
    // Fills the viewport under the shell header (dvh: mobile browser bars don't push it off screen). Phones go
    // edge to edge; wider screens keep a small inset.
    <div className="flex h-[calc(100dvh-3.25rem-env(safe-area-inset-top))] flex-col sm:h-[calc(100dvh-3.5rem)] md:p-2">
      {/* The viewer fills the page, so the heading is for screen readers and the document outline only. */}
      <h1 className="sr-only">Logs</h1>
      {!data ? (
        <Skeleton className="h-full rounded-none md:rounded-2xl" />
      ) : current.length ? (
        <LogViewer
          key={`${env}/${key}/${initial.n}`}
          env={env}
          services={current}
          initialQuery={initial.q}
          initialMinutes={initial.minutes}
          onQueryChange={onQueryChange}
          onOpenSaved={openSaved}
          className="max-md:rounded-none max-md:border-x-0 max-md:border-t-0"
          toolbarStart={<ServicePicker services={services} current={current} onChange={setPicked} />}
        />
      ) : (
        <Empty title="No services in this environment" />
      )}
    </div>
  );
}

function ServicePicker({ services, current, onChange }: { services: ResourceView[]; current: string[]; onChange(v: string[]): void }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => !wrap.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [open]);
  const toggle = (id: string) => {
    const next = current.includes(id) ? current.filter((x) => x !== id) : [...current, id];
    onChange(next.length ? next : [id]);
  };
  const names = current.map((id) => services.find((s) => s.id === id)?.name ?? id);
  return (
    // Takes the free space of the toolbar's first row on phones.
    <div ref={wrap} className="relative min-w-0 max-md:flex-1">
      <button onClick={() => setOpen((o) => !o)} className="press flex h-8 w-full items-center gap-2 rounded-lg border border-line bg-panel-2 px-2.5 text-[13.5px] hover:border-line-strong aria-expanded:border-line-strong md:w-auto md:max-w-[260px] pointer-coarse:h-9" aria-haspopup="listbox" aria-expanded={open}>
        {current.length > 1 ? <Layers className="size-3.5 flex-none text-fg-3" /> : <StateDot state={services.find((s) => s.id === current[0])?.state ?? "UNKNOWN"} className="!size-2" />}
        <span className="min-w-0 flex-1 truncate text-left font-medium">{current.length > 2 ? `${current.length} services merged` : names.join(" + ")}</span>
        <ChevronDown className={cx("size-3.5 flex-none text-fg-3 transition-transform duration-200 ease-smooth", open && "rotate-180")} />
      </button>
      <AnimatePresence>
        {open && (
          <motion.div {...popover} className="absolute left-0 top-[calc(100%+6px)] z-40 max-h-[min(70dvh,480px)] w-[min(18rem,calc(100vw-1.25rem))] origin-top-left overflow-y-auto overscroll-contain rounded-xl border border-line bg-panel p-1.5 shadow-float" role="listbox" aria-multiselectable>
            <div className="eyebrow flex items-center justify-between px-2 pb-1.5 pt-0.5">
              <span>services · pick several to merge</span>
              <button className="normal-case tracking-normal text-accent hover:underline pointer-coarse:-my-1.5 pointer-coarse:py-1.5" onClick={() => onChange(current.length === services.length ? [services[0].id] : services.map((s) => s.id))}>
                {current.length === services.length ? "one" : "all"}
              </button>
            </div>
            {services.map((s) => {
              const on = current.includes(s.id);
              const idx = current.indexOf(s.id);
              return (
                <div key={s.key} className="group flex items-center gap-1">
                  <button role="option" aria-selected={on} onClick={() => toggle(s.id)} className="flex min-w-0 flex-1 items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-[14px] transition-colors duration-150 hover:bg-panel-3 pointer-coarse:py-2.5">
                    <span className="grid size-4 flex-none place-items-center rounded border border-line transition-[background-color,border-color] duration-200" style={on ? { background: SERVICE_COLORS[idx % SERVICE_COLORS.length], borderColor: "transparent" } : undefined}>
                      {on && <Check className="size-3 text-panel" />}
                    </span>
                    <StateDot state={s.state} className="!size-1.5" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{s.name}</span>
                      <span className="block truncate font-mono text-[11px] text-fg-3">{s.id}</span>
                    </span>
                  </button>
                  {/* Hover reveals it with a mouse; touch screens always show it. */}
                  <button onClick={() => { onChange([s.id]); setOpen(false); }} className="rounded-md px-1.5 py-1 text-[11.5px] text-fg-3 opacity-0 transition-opacity duration-150 hover:bg-panel-3 hover:text-fg focus-visible:opacity-100 group-hover:opacity-100 pointer-coarse:px-2.5 pointer-coarse:py-2.5 pointer-coarse:opacity-100">
                    only
                  </button>
                </div>
              );
            })}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
