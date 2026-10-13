"use client";
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import useSWR from "swr";
import type { CapabilityView, EnvInfo, EnvName, EnvOverview, State } from "@/lib/types";
import { ApiError, getJson } from "./api";
import { savedViewHref } from "./format";

// /api/envs adds the sampler's state; `stale` = the sampler hasn't read the env lately (its worst is then UNKNOWN).
export type EnvListItem = EnvInfo & { worst?: State; summary?: Record<State, number>; sampledAt?: number; stale?: boolean; staleReason?: string };

const Ctx = createContext<{ env: EnvName; setEnv: (e: EnvName) => void; missing?: string; dismissMissing: () => void }>({ env: "", setEnv: () => {}, dismissMissing: () => {} });
const KEY = "console.env";

// When each URL last loaded successfully in this browser (R21): a view that keeps earlier data after a failed refresh
// says how old that data is. Module-level, so every hook sharing a key reads the same time.
const LOADED = new Map<string, number>();
export const loadedAt = (key: string | null | undefined) => (key ? LOADED.get(key) : undefined);

// getJson that remembers the time of each successful load. Use it as the SWR fetcher of any view that shows a
// freshness banner from kept data.
export async function trackedJson<T>(url: string): Promise<T> {
  const v = await getJson<T>(url);
  LOADED.set(url, Date.now());
  return v;
}

// The shell and every page read these two on each render: a body of the wrong shape (a proxy's JSON, an older
// server) becomes an error state instead of a crash deep inside a component.
function shaped<T>(ok: (v: unknown) => boolean) {
  return async (url: string): Promise<T> => {
    const v = await trackedJson<unknown>(url);
    if (!ok(v)) throw new ApiError(502, "Unexpected response from the server. A proxy may be in the way; reload the page.");
    return v as T;
  };
}
const envList = shaped<EnvListItem[]>((v) => Array.isArray(v));
const overview = shaped<EnvOverview>((v) => {
  const o = v as Partial<EnvOverview> | null;
  return !!o && typeof o === "object" && Array.isArray(o.services) && Array.isArray(o.infra);
});

// Discovered environments (sorted by promotion order), refreshed with the sampler's state.
export function useEnvList() {
  return useSWR<EnvListItem[]>("/api/envs", envList, { refreshInterval: 15_000, keepPreviousData: true });
}

// The selected environment is shared by every page; ?env= in a link wins, then the last choice, then the first env.
// A ?env= that names no environment (renamed, ignored, another console's link) is remembered so the shell can say so
// instead of silently showing another one (F05).
export function EnvProvider({ children }: { children: ReactNode }) {
  const [env, set] = useState<EnvName>("");
  const [missing, setMissing] = useState<string | undefined>();
  const envs = useEnvList().data;
  useEffect(() => {
    if (!envs?.length) return;
    const fromUrl = new URLSearchParams(window.location.search).get("env");
    let saved: string | null = null;
    try {
      saved = localStorage.getItem(KEY);
    } catch {
      /* storage blocked */
    }
    const ok = (v: string | null) => !!v && envs.some((e) => e.id === v);
    const pick = ok(env) ? env : ok(fromUrl) ? fromUrl! : ok(saved) ? saved! : envs[0].id;
    if (pick === env) return;
    // Browser-only inputs (URL, localStorage) can only be read after hydration, and the list arrives async.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    set(pick);
    if (!env && fromUrl && !ok(fromUrl)) {
      setMissing(fromUrl);
      try {
        const u = new URL(window.location.href);
        u.searchParams.set("env", pick);
        window.history.replaceState(window.history.state, "", u);
      } catch {
        /* no history (embedded or sandboxed) */
      }
    }
  }, [envs, env]);
  const setEnv = useCallback((e: EnvName) => {
    set(e);
    setMissing(undefined);
    try {
      localStorage.setItem(KEY, e);
    } catch {
      /* storage blocked */
    }
    const u = new URL(window.location.href);
    u.searchParams.set("env", e);
    u.searchParams.delete("r");
    window.history.replaceState(null, "", u);
  }, []);
  const dismissMissing = useCallback(() => setMissing(undefined), []);
  return <Ctx.Provider value={{ env, setEnv, missing, dismissMissing }}>{children}</Ctx.Provider>;
}

export const useEnv = () => useContext(Ctx);

// Info for one env (protected flag, label, branch). Unknown while loading → treated as protected (fail safe).
export function useEnvInfo(env: EnvName): EnvListItem | undefined {
  return useEnvList().data?.find((e) => e.id === env);
}

export const overviewKey = (env: EnvName) => (env ? `/api/overview?env=${env}` : null);

// One overview request per env, shared by the canvas, palette and panels (SWR de-dupes by key). Polls every 10 s:
// only the pages that show an overview call this.
export function useOverview(env: EnvName) {
  return useSWR<EnvOverview>(overviewKey(env), overview, {
    refreshInterval: 10_000,
    keepPreviousData: true,
  });
}

// The overview if a page already loaded it, never a request of its own (F48): the shell's env dot reads the cache
// and otherwise falls back to the sampler's state from /api/envs.
export function useCachedOverview(env: EnvName) {
  return useSWR<EnvOverview>(overviewKey(env), overview, {
    refreshInterval: 0,
    revalidateOnMount: false,
    revalidateOnFocus: false,
    revalidateIfStale: false,
    revalidateOnReconnect: false,
  });
}

// What the console's AWS identity may change (/api/capability): the shell shows "Read-only AWS access" when it can
// change nothing. Every 5 minutes and on focus; hidden (undefined) when the API is missing or not for this caller.
async function fetchCapability(url: string): Promise<CapabilityView | null> {
  const res = await fetch(url, { cache: "no-store", headers: { Accept: "application/json" } });
  if (res.status === 404 || res.status === 401 || res.status === 403) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const v = (await res.json().catch(() => null)) as Partial<CapabilityView> | null;
  return v && typeof v.readOnly === "boolean" ? (v as CapabilityView) : null;
}
export function useCapability() {
  return useSWR<CapabilityView | null>("/api/capability", fetchCapability, { refreshInterval: 5 * 60_000, revalidateOnFocus: true, shouldRetryOnError: false }).data ?? undefined;
}

// ---------- saved views and dashboards (b-dashboards' APIs; hidden until they exist) ----------

export interface SavedView {
  id: string;
  name: string;
  kind: "view";
  payload: { path: string; search: string; title?: string };
}
export interface DashboardItem {
  id: string;
  name: string;
}

// null = the API isn't there (404) or isn't for this caller: callers hide whatever depends on it.
async function optionalList<T>(url: string, pick: (v: unknown) => T[] | undefined): Promise<T[] | null> {
  const res = await fetch(url, { cache: "no-store", headers: { Accept: "application/json" } });
  if (res.status === 404 || res.status === 401 || res.status === 403 || res.status === 405) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const v = (await res.json().catch(() => null)) as unknown;
  return pick(v) ?? null;
}
// A bare array, or the arrays under any of `fields` ({ items }, { mine, team }…) joined: the shapes aren't final yet.
function listOf(v: unknown, fields: string[]): unknown[] | undefined {
  if (Array.isArray(v)) return v;
  if (!v || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  const lists = fields.filter((f) => Object.hasOwn(o, f) && Array.isArray(o[f])).map((f) => o[f] as unknown[]);
  return lists.length ? lists.flat() : undefined;
}

// Rows whose link isn't a same-origin page are dropped (savedViewHref).
const isView = (x: unknown): x is SavedView => {
  const v = x as SavedView | null;
  return !!v && typeof v.id === "string" && typeof v.name === "string" && savedViewHref(v.payload) !== undefined;
};
const isDashboard = (x: unknown): x is DashboardItem => !!x && typeof (x as DashboardItem).id === "string" && typeof (x as DashboardItem).name === "string";

export const SAVED_VIEWS_KEY = "/api/saved?kind=view";
export function useSavedViews(enabled = true) {
  return useSWR<SavedView[] | null>(enabled ? SAVED_VIEWS_KEY : null, (u: string) => optionalList(u, (v) => listOf(v, ["items", "saved"])?.filter(isView)), { revalidateOnFocus: false, shouldRetryOnError: false, keepPreviousData: true });
}
export function useDashboards(enabled = true) {
  return useSWR<DashboardItem[] | null>(enabled ? "/api/dashboards" : null, (u: string) => optionalList(u, (v) => listOf(v, ["dashboards", "mine", "team"])?.filter(isDashboard)), { revalidateOnFocus: false, shouldRetryOnError: false, keepPreviousData: true });
}
