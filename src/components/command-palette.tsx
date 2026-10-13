"use client";
// ⌘K: pages, environments, every ECS resource and everything on the cloud map, saved views and dashboards, plus
// "Save this view". An ARIA combobox (F21): focus stays in the field, the highlighted option is announced through
// aria-activedescendant and scrolled into view; options are not buttons (no nested tab stops).
import { AnimatePresence, motion } from "motion/react";
import { ArrowRight, Bookmark, LayoutDashboard, Search, Siren } from "lucide-react";
import { useRouter } from "next/navigation";
import { createElement, useEffect, useMemo, useRef, useState } from "react";
import useSWR, { useSWRConfig } from "swr";
import { postJson } from "@/lib/client/api";
import { SAVED_VIEWS_KEY, useDashboards, useEnv, useEnvList, useSavedViews } from "@/lib/client/env";
import { savedViewHref } from "@/lib/client/format";
import { readRegionFilter, useRegions } from "@/lib/client/region";
import { categoryOf, kindLabelOf, type InventoryView } from "@/lib/inventory/types";
import type { EnvName, ResourceKind, State } from "@/lib/types";
import { Modal, springFast } from "./motion";
import { KIND_ICON } from "./overview/card";
import { INVENTORY_KEY, fetchInventory } from "./map/data";
import { iconOf } from "./map/kinds";
import { catHue, hue, kindHue } from "./hue";
import { NAV, NAV_FOOT, useTheme } from "./shell";
import { StateDot } from "./state";
import { useToast } from "./toast";
import { Kbd, cx } from "./ui";

interface Res { env: EnvName; envLabel: string; key: string; id: string; kind: ResourceKind; name: string; subtitle: string; state: State; logs: boolean }

interface Item {
  id: string;
  label: string;
  hint: string;
  icon?: React.ReactNode;
  run(): void;
}

// Fuller names for some pages, so "audit log" or "promotion" finds them.
const PAGE_LABEL: Record<string, string> = {
  "/ci": "CI runs",
  "/releases": "Releases · promotion chain",
  "/audit": "Audit log",
  "/resources": "Resources · every resource in a table",
  "/settings": "Settings · environments, users, integrations",
  "/docs": "Docs · connect AWS, roles, integrations",
};
const MAX_GENERIC = 500; // aws-resource rows (Resource Explorer's long tail): enough to find, never thousands (D.11)

// The region filter as the URL (or the last choice) has it when the palette opens.
const currentRegion = (regions: string[]): string => readRegionFilter(regions);

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"search" | "save">("search");
  const [q, setQ] = useState("");
  const [idx, setIdx] = useState(0);
  const [region, setRegion] = useState("all");
  const [busy, setBusy] = useState(false);
  const router = useRouter();
  const { env, setEnv } = useEnv();
  const { toggle } = useTheme();
  const toast = useToast();
  const { mutate } = useSWRConfig();
  const list = useRef<HTMLUListElement>(null);
  const envs = useEnvList().data ?? [];
  const regionList = useRegions().data?.regions;
  const regionsRef = useRef<string[]>([]);
  useEffect(() => {
    regionsRef.current = regionList ?? [];
  }, [regionList]);
  const resources = useSWR<Res[]>(open ? "/api/resources" : null, { keepPreviousData: true }).data;
  // Everything else in the account (Lambda, queues, buckets, DNS…) opens on the cloud map. ECS services are above.
  // The map's cache entry and fetcher (only while open): opening the palette never replaces the map's shared data.
  const inventory = useSWR<InventoryView>(open ? INVENTORY_KEY : null, fetchInventory, { keepPreviousData: true, revalidateOnFocus: false }).data;
  const saved = useSavedViews(open).data;
  const dashboards = useDashboards(open).data;

  useEffect(() => {
    const show = (m: "search" | "save") => {
      setMode(m);
      setQ(m === "save" ? defaultName() : "");
      setIdx(0);
      setRegion(currentRegion(regionsRef.current));
      setOpen(true);
    };
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => {
          if (!o) {
            setMode("search");
            setQ("");
            setIdx(0);
            setRegion(currentRegion(regionsRef.current));
          }
          return !o;
        });
      }
    };
    const onOpen = () => show("search");
    const onSave = () => show("save");
    window.addEventListener("keydown", onKey);
    window.addEventListener("console:palette", onOpen);
    window.addEventListener("console:save-view", onSave);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("console:palette", onOpen);
      window.removeEventListener("console:save-view", onSave);
    };
  }, []);

  const openResource = (e: EnvName, key: string) => {
    setEnv(e);
    router.push(`/?env=${e}&r=${encodeURIComponent(key)}`);
    setTimeout(() => window.dispatchEvent(new Event("console:open")), 50);
  };

  const items = useMemo<Item[]>(() => {
    const regionOf = new Map(envs.map((e) => [e.id, e.region]));
    const inRegion = (r?: string) => region === "all" || !r || r === region || r === "global";
    const res: Item[] = [];
    // Current env first, then the rest in promotion order.
    const sorted = [...(Array.isArray(resources) ? resources : [])].filter((r) => inRegion(regionOf.get(r.env))).sort((a, b) => Number(b.env === env) - Number(a.env === env));
    for (const r of sorted) {
      const Icon = KIND_ICON[r.kind] ?? ArrowRight;
      res.push({
        id: `${r.env}:${r.key}`,
        label: r.name,
        hint: `${r.envLabel} · ${r.subtitle}`,
        icon: (
          <span className="relative">
            <Icon className="hue-text size-4" style={kindHue(r.kind)} strokeWidth={1.7} />
            <StateDot state={r.state} className="absolute -right-1 -top-1 !size-1.5" />
          </span>
        ),
        run: () => openResource(r.env, r.key),
      });
      if (r.logs) res.push({ id: `${r.env}:logs:${r.id}`, label: `Logs · ${r.name}`, hint: `${r.envLabel} live tail`, run: () => router.push(`/logs?env=${r.env}&service=${r.id}`) });
    }
    let generic = 0;
    for (const r of Array.isArray(inventory?.resources) ? inventory.resources : []) {
      // ECS services are listed above; hidden resources (AWS-managed keys, service roles) are table-only.
      if (r.kind === "ecs-service" || r.hidden || !inRegion(r.region)) continue;
      if (r.kind === "aws-resource" && ++generic > MAX_GENERIC) continue;
      res.push({
        id: `map:${r.key}`,
        label: r.name,
        hint: `${kindLabelOf(r)} · ${r.env ?? "shared"}${region === "all" && r.region && r.region !== inventory?.homeRegion && r.region !== "global" ? ` · ${r.region}` : ""} · cloud map`,
        icon: createElement(iconOf(r), { className: "hue-text size-4", style: catHue(categoryOf(r)), strokeWidth: 1.7 }),
        run: () => {
          router.push(`/map?r=${encodeURIComponent(r.key)}`);
          setTimeout(() => window.dispatchEvent(new Event("console:open")), 50);
        },
      });
    }
    const views: Item[] = (saved ?? []).map((v) => ({
      id: `view:${v.id}`,
      label: v.name,
      hint: "saved view",
      icon: <Bookmark className="size-3.5 text-fg-3" strokeWidth={1.75} />,
      run: () => {
        const href = savedViewHref(v.payload);
        if (href) router.push(href);
      },
    }));
    const boards: Item[] = (dashboards ?? []).map((d) => ({
      id: `dash:${d.id}`,
      label: d.name,
      hint: "dashboard",
      icon: <LayoutDashboard className="size-3.5 text-fg-3" strokeWidth={1.75} />,
      run: () => router.push(`/dashboards/${encodeURIComponent(d.id)}`),
    }));
    return [
      ...[...NAV, ...NAV_FOOT].map((n) => ({ id: `nav:${n.href}`, label: PAGE_LABEL[n.href] ?? n.label, hint: `page · g ${n.key}`, icon: <n.icon className="hue-text size-3.5" style={hue(n.hue)} strokeWidth={1.75} />, run: () => router.push(n.href) })),
      { id: "nav:/incident", label: "Incident view", hint: "page", icon: <Siren className="size-3.5 text-fg-3" strokeWidth={1.75} />, run: () => router.push("/incident") },
      ...(Array.isArray(saved) ? [{ id: "save-view", label: "Save this view…", hint: "name it, find it here later", icon: <Bookmark className="size-3.5 text-fg-3" strokeWidth={1.75} />, run: () => {} }] : []),
      ...views,
      ...boards,
      ...envs.filter((e) => e.id !== env && inRegion(e.region)).map((e) => ({ id: `env:${e.id}`, label: `Switch to ${e.label}`, hint: `environment${regionList && regionList.length > 1 ? ` · ${e.region}` : ""}`, run: () => setEnv(e.id) })),
      { id: "theme", label: "Toggle theme", hint: "appearance", run: toggle },
      ...res,
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resources, inventory, envs, env, region, saved, dashboards, regionList]);

  const filtered = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (!t) return items.slice(0, 40);
    return items.filter((i) => `${i.label} ${i.hint}`.toLowerCase().includes(t)).slice(0, 40);
  }, [items, q]);

  // Keep the highlighted option visible while moving with the arrow keys.
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-idx="${idx}"]`)?.scrollIntoView({ block: "nearest" });
  }, [idx, filtered]);

  const choose = (i: Item | undefined) => {
    if (!i) return;
    if (i.id === "save-view") {
      setMode("save");
      setQ(defaultName());
      return;
    }
    setOpen(false);
    i.run();
  };

  const save = async () => {
    const name = q.trim();
    if (!name || busy) return;
    setBusy(true);
    try {
      await postJson("/api/saved", { kind: "view", name: name.slice(0, 80), payload: { path: window.location.pathname, search: window.location.search } });
      toast.push({ tone: "ok", title: "View saved", body: `${name} — find it with ⌘K.` });
      void mutate(SAVED_VIEWS_KEY);
      setOpen(false);
    } catch (e) {
      toast.push({ tone: "error", title: "Couldn't save the view", body: (e as Error).message }, 8000);
    } finally {
      setBusy(false);
    }
  };

  const active = filtered[idx];
  return (
    <AnimatePresence>
      {open && (
        // A tall sheet on phones keeps the field high on the screen, clear of the keyboard.
        <Modal key="palette" z="z-[80]" align="top" onClose={() => setOpen(false)} aria-label={mode === "save" ? "Save this view" : "Command palette"} className="max-sm:h-[86dvh] sm:max-w-xl">
          {/* Escape closes the palette wherever focus is inside it. */}
          <div className="contents" onKeyDown={(e) => e.key === "Escape" && setOpen(false)}>
            <div className="flex flex-none items-center gap-3 border-b border-line px-4">
              {mode === "save" ? <Bookmark className="size-4 text-fg-3" strokeWidth={1.75} /> : <Search className="size-4 text-fg-3" strokeWidth={1.75} />}
              {mode === "save" ? (
                <input
                  autoFocus
                  value={q}
                  maxLength={80}
                  onChange={(e) => setQ(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void save();
                    } else if (e.key === "Escape") setOpen(false);
                  }}
                  placeholder="Name this view"
                  aria-label="Name for this view"
                  className="h-12 min-w-0 flex-1 bg-transparent text-[15px] outline-none placeholder:text-fg-3 sm:h-14 sm:text-[16px]"
                />
              ) : (
                <input
                  autoFocus
                  role="combobox"
                  aria-expanded
                  aria-controls="palette-list"
                  aria-autocomplete="list"
                  aria-activedescendant={active ? `palette-opt-${idx}` : undefined}
                  value={q}
                  onChange={(e) => {
                    setQ(e.target.value);
                    setIdx(0);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "ArrowDown") {
                      e.preventDefault();
                      setIdx((i) => Math.min(i + 1, filtered.length - 1));
                    } else if (e.key === "ArrowUp") {
                      e.preventDefault();
                      setIdx((i) => Math.max(i - 1, 0));
                    } else if (e.key === "Enter") {
                      e.preventDefault();
                      choose(active);
                    } else if (e.key === "Escape") setOpen(false);
                  }}
                  placeholder={region === "all" ? "Jump to a service, page or action…" : `Jump to anything in ${region}…`}
                  aria-label="Search"
                  className="h-12 min-w-0 flex-1 bg-transparent text-[15px] outline-none placeholder:text-fg-3 sm:h-14 sm:text-[16px]"
                />
              )}
              <span className="hidden sm:inline"><Kbd>esc</Kbd></span>
            </div>
            {mode === "save" ? (
              <div className="space-y-3 p-4 text-[14px] text-fg-2">
                <p>
                  Saves this page with its filters (<span className="font-mono text-xs text-fg-3 [overflow-wrap:anywhere]">{viewPath()}</span>) to your saved views. Only you see it.
                </p>
                <div className="flex justify-end gap-2">
                  <button type="button" onClick={() => setMode("search")} className="press rounded-lg px-3 py-1.5 text-[14px] text-fg-2 hover:bg-panel-3 pointer-coarse:min-h-10">Back</button>
                  <button type="button" onClick={() => void save()} disabled={!q.trim() || busy} className="press rounded-lg bg-primary px-3 py-1.5 text-[14px] font-medium text-primary-fg hover:bg-primary-hover disabled:opacity-50 pointer-coarse:min-h-10">
                    {busy ? "Saving…" : "Save view"}
                  </button>
                </div>
              </div>
            ) : (
              <ul ref={list} id="palette-list" role="listbox" aria-label="Results" className="isolate min-h-0 flex-1 overflow-y-auto overscroll-contain p-1.5 sm:max-h-[50vh]">
                {filtered.map((i, k) => (
                  <li
                    key={i.id}
                    id={`palette-opt-${k}`}
                    role="option"
                    aria-selected={k === idx}
                    data-idx={k}
                    onMouseMove={() => k !== idx && setIdx(k)}
                    onClick={() => choose(i)}
                    className={cx("relative flex w-full cursor-pointer items-center gap-3 rounded-lg px-3 py-2 text-left text-[14px] pointer-coarse:py-3 pointer-coarse:text-[16px]", k === idx ? "text-fg" : "text-fg-2")}
                  >
                    {k === idx && <motion.span layoutId="palette-hl" className="absolute inset-0 -z-10 rounded-lg bg-panel-3" transition={springFast} />}
                    <span className="grid w-5 flex-none place-items-center" aria-hidden>{i.icon ?? <ArrowRight className="size-3.5 text-fg-3" strokeWidth={1.75} />}</span>
                    <span className="min-w-0 flex-1 truncate">{i.label}</span>
                    <span className="max-w-[40%] truncate text-xs text-fg-3">{i.hint}</span>
                  </li>
                ))}
                {!filtered.length && <li role="presentation" className="fade-in px-3 py-8 text-center text-xs text-fg-3">No match</li>}
              </ul>
            )}
          </div>
        </Modal>
      )}
    </AnimatePresence>
  );
}

// The page and its query, as a saved view stores it.
const viewPath = () => (typeof window === "undefined" ? "" : `${window.location.pathname}${window.location.search}`);

// "Metrics · production" from the tab title and ?env=.
function defaultName() {
  if (typeof window === "undefined") return "";
  const page = document.title.split(" · ")[0] || window.location.pathname;
  const env = new URLSearchParams(window.location.search).get("env");
  return env ? `${page} · ${env}` : page;
}
