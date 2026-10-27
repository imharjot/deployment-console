"use client";
// Regions the console watches, and the page-level region filter. The filter lives in the URL (?region=, so a link
// carries it) with the last choice in localStorage as a fallback. With a single region there is nothing to choose:
// the filter is always "all" and the UI shows no selector. Every useRegionFilter() follows a change made anywhere on
// the page: setRegion announces it (REGION_EVENT) and each instance re-reads the URL and the saved choice.
import { useCallback, useEffect, useState } from "react";
import useSWR from "swr";

export interface RegionsInfo {
  home: string;
  regions: string[];
  allEnabled: boolean;
  source?: "env" | "config" | "default";
}

export type RegionFilter = "all" | string;

const KEY = "console.region";
export const REGION_EVENT = "console:region";

// 404 = a server without the regions API: one region, no selector. Raw fetch so a 401 never redirects from here.
async function fetchRegions(url: string): Promise<RegionsInfo | null> {
  const res = await fetch(url, { cache: "no-store", headers: { Accept: "application/json" } });
  if (res.status === 404 || res.status === 401 || res.status === 403) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const v = (await res.json().catch(() => null)) as Partial<RegionsInfo> | null;
  if (!v || typeof v.home !== "string" || !Array.isArray(v.regions)) return null;
  return { home: v.home, regions: v.regions.filter((r): r is string => typeof r === "string"), allEnabled: !!v.allEnabled, source: v.source };
}

export function useRegions() {
  const r = useSWR<RegionsInfo | null>("/api/regions", fetchRegions, { revalidateOnFocus: false, dedupingInterval: 60_000, keepPreviousData: true });
  const data = r.data ?? undefined;
  return { data, error: r.error as Error | undefined, isLoading: r.isLoading, multi: (data?.regions.length ?? 0) > 1 };
}

// Which filter applies: a valid ?region= wins, then the saved choice, else "all". One region (or none known) → "all".
export function pickRegion(fromUrl: string | null | undefined, saved: string | null | undefined, regions: string[]): RegionFilter {
  if (regions.length <= 1) return "all";
  const ok = (v: string | null | undefined): v is string => !!v && (v === "all" || regions.includes(v));
  return ok(fromUrl) ? fromUrl : ok(saved) ? saved : "all";
}

// The filter as the page has it now: a valid ?region=, then the saved choice, else "all". Browser only.
export function readRegionFilter(regions: string[]): RegionFilter {
  let saved: string | null = null;
  try {
    saved = localStorage.getItem(KEY);
  } catch {
    /* storage blocked */
  }
  return pickRegion(new URLSearchParams(window.location.search).get("region"), saved, regions);
}

export function useRegionFilter(): { region: RegionFilter; setRegion: (r: RegionFilter) => void; regions: string[]; multi: boolean } {
  const { data, multi } = useRegions();
  const regions = data?.regions ?? [];
  const list = regions.join(",");
  const [region, set] = useState<RegionFilter>("all");
  useEffect(() => {
    const read = () => set(readRegionFilter(list ? list.split(",") : []));
    // Browser-only inputs (URL, localStorage) can only be read after hydration, and the list arrives async; read them
    // again whenever any instance changes the filter or history moves.
    read();
    window.addEventListener(REGION_EVENT, read);
    window.addEventListener("popstate", read);
    return () => {
      window.removeEventListener(REGION_EVENT, read);
      window.removeEventListener("popstate", read);
    };
  }, [list]);
  const setRegion = useCallback(
    (r: RegionFilter) => {
      const known = list ? list.split(",") : [];
      const next = pickRegion(r, null, known);
      set(next);
      try {
        localStorage.setItem(KEY, next);
      } catch {
        /* storage blocked */
      }
      try {
        const u = new URL(window.location.href);
        if (next === "all") u.searchParams.delete("region");
        else u.searchParams.set("region", next);
        window.history.replaceState(window.history.state, "", u);
      } catch {
        /* no history (embedded or sandboxed) */
      }
      window.dispatchEvent(new Event(REGION_EVENT)); // every other instance (shell, dashboards, pages) follows
    },
    [list],
  );
  return { region: multi ? region : "all", setRegion, regions, multi };
}

const NAMES: Record<string, string> = {
  "us-east-1": "N. Virginia", "us-east-2": "Ohio", "us-west-1": "N. California", "us-west-2": "Oregon",
  "af-south-1": "Cape Town", "ap-east-1": "Hong Kong", "ap-east-2": "Taipei", "ap-south-1": "Mumbai", "ap-south-2": "Hyderabad",
  "ap-southeast-1": "Singapore", "ap-southeast-2": "Sydney", "ap-southeast-3": "Jakarta", "ap-southeast-4": "Melbourne",
  "ap-southeast-5": "Malaysia", "ap-southeast-7": "Thailand", "ap-northeast-1": "Tokyo", "ap-northeast-2": "Seoul", "ap-northeast-3": "Osaka",
  "ca-central-1": "Canada", "ca-west-1": "Calgary", "eu-central-1": "Frankfurt", "eu-central-2": "Zurich", "eu-west-1": "Ireland",
  "eu-west-2": "London", "eu-west-3": "Paris", "eu-north-1": "Stockholm", "eu-south-1": "Milan", "eu-south-2": "Spain",
  "il-central-1": "Tel Aviv", "me-south-1": "Bahrain", "me-central-1": "UAE", "mx-central-1": "Mexico", "sa-east-1": "São Paulo",
  "us-gov-west-1": "GovCloud West", "us-gov-east-1": "GovCloud East",
};

// "Ireland" for eu-west-1; undefined for a code the list doesn't know.
export const regionName = (r: string): string | undefined => (Object.hasOwn(NAMES, r) ? NAMES[r] : undefined);

// "eu-west-1 · Ireland"; "All regions" for the filter's "all"; unknown codes as they are.
export function regionLabel(r: RegionFilter): string {
  if (r === "all") return "All regions";
  const name = regionName(r);
  return name ? `${r} · ${name}` : r;
}
