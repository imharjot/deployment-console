"use client";
// Data for dashboards and their widgets. Every key here is namespaced (["dash", url]) so it never shares an SWR cache
// entry with another component that reads the same URL into a different shape (the palette lists /api/dashboards as
// an array, the stars read /api/pins as { pins } | null). Each value carries the time it loaded, which is what a
// widget's freshness banner reports when its API sends no freshness of its own (R21).
import useSWR, { useSWRConfig } from "swr";
import { ApiError, getJson } from "@/lib/client/api";
import { useRegionFilter, type RegionFilter } from "@/lib/client/region";
import type { Prefs } from "@/lib/dashboards";

export interface Stamped<T> {
  value: T;
  at: number; // when it loaded
}

// Last failure per URL, for "last refresh failed 20 s ago".
const failedAt = new Map<string, number>();

async function stamped<T>([, url]: readonly [string, string]): Promise<Stamped<T>> {
  try {
    const value = await getJson<T>(url);
    failedAt.delete(url);
    return { value, at: Date.now() };
  } catch (e) {
    failedAt.set(url, Date.now());
    throw e;
  }
}

export const dashKey = (url: string) => ["dash", url] as const;

// One API read for a widget or page. `data` stays the last good value when a refresh fails (`error` is then set too).
export function useApi<T>(url: string | null, refreshMs = 30_000) {
  const r = useSWR<Stamped<T>, Error, readonly [string, string] | null>(url ? dashKey(url) : null, stamped, {
    refreshInterval: refreshMs,
    revalidateOnFocus: false,
  });
  return {
    data: r.data?.value,
    at: r.data?.at,
    error: r.error,
    failedAt: url && r.error ? failedAt.get(url) : undefined,
    isLoading: r.isLoading,
    reload: () => r.mutate(),
  };
}

// Revalidate every namespaced read whose URL starts with one of these prefixes (after a write).
export function useRefresh() {
  const { mutate } = useSWRConfig();
  return (...prefixes: string[]) =>
    mutate((k) => Array.isArray(k) && k[0] === "dash" && typeof k[1] === "string" && prefixes.some((p) => (k[1] as string).startsWith(p)));
}

// An error that keeps the JSON body (a 409's current dashboard, a 400's problems).
export class SendError extends ApiError {
  body: Record<string, unknown> | null;
  constructor(status: number, message: string, body: Record<string, unknown> | null) {
    super(status, message);
    this.body = body;
  }
}

export async function send<T>(method: "POST" | "PATCH" | "DELETE", url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: { Accept: "application/json", "x-console-csrf": "1", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const parsed = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok) throw new SendError(res.status, typeof parsed?.error === "string" ? parsed.error : `HTTP ${res.status}`, parsed);
  return parsed as T;
}

export const PREFS_URL = "/api/me/prefs";

// The person's preferences; null when the API isn't there (an older server) — the home page then stays the Overview.
export function usePrefs() {
  const r = useApi<Prefs>(PREFS_URL, 0);
  const refresh = useRefresh();
  const set = async (patch: Partial<Record<keyof Prefs, string | null>>) => {
    const next = await send<Prefs>("PATCH", PREFS_URL, patch);
    await refresh(PREFS_URL);
    return next;
  };
  return { prefs: r.data, error: r.error, isLoading: r.isLoading, set };
}

// The global region filter as the shell last set it (useRegionFilter follows changes made anywhere on the page).
export function useRegionNow(): RegionFilter {
  return useRegionFilter().region;
}
