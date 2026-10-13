"use client";
// Data for the cloud map: the inventory (GET /api/inventory), a resource's detail and its actions.
// The 60 s poll revalidates with the server's ETag (a 304 costs nothing), and a new build that shows the same thing
// keeps the previous arrays (F51): no new layout, only the build time moves on.
import useSWR from "swr";
import { ApiError, getJson } from "@/lib/client/api";
import type { ActionInfo, InventoryView, ResourceDetail } from "@/lib/inventory/types";
import { inventorySignature, shareUnchanged } from "./signature";

export type MapInventory = InventoryView & { sample?: "acme" | "big" }; // sample: development fixture, not this account

const DEV = process.env.NODE_ENV === "development";
export const INVENTORY_KEY = "/api/inventory";

const shaped = (v: unknown): v is InventoryView => {
  const o = v as Partial<InventoryView> | null;
  return !!o && typeof o === "object" && Array.isArray(o.resources) && Array.isArray(o.edges) && Array.isArray(o.providers);
};

async function sample(kind: "acme" | "big"): Promise<MapInventory> {
  const m = await import("./fixture");
  const n = Number(new URLSearchParams(window.location.search).get("n")) || 800;
  return { ...(kind === "big" ? m.bigFixture(Math.min(5000, n)) : m.acmeFixture()), sample: kind };
}

// In `next dev` only: ?fixture=acme|big shows sample data, and so does a server without the inventory API yet.
// Anything else reading INVENTORY_KEY through SWR uses this fetcher too, so the map's shared arrays stay shared (F51).
export async function fetchInventory(url: string): Promise<MapInventory> {
  return shared(await load(url));
}

async function load(url: string): Promise<MapInventory> {
  if (DEV) {
    const want = new URLSearchParams(window.location.search).get("fixture");
    if (want === "acme" || want === "big") return sample(want);
  }
  try {
    const v = await getRevalidated(url);
    if (!shaped(v)) throw new ApiError(502, "Unexpected response from the server. A proxy may be in the way; reload the page.");
    return v;
  } catch (e) {
    if (DEV && e instanceof ApiError && e.status === 404) return sample("acme");
    throw e;
  }
}

// `no-cache` (not `no-store`): the browser keeps the last body and revalidates it with If-None-Match, so an unchanged
// map comes back as a 304 the browser answers from its cache. A 401 goes through getJson (sign-in redirect).
async function getRevalidated(url: string): Promise<unknown> {
  const res = await fetch(url, { cache: "no-cache", headers: { Accept: "application/json" } });
  if (res.status === 401 || !res.ok) return getJson<unknown>(url);
  try {
    return await res.json();
  } catch {
    return getJson<unknown>(url); // not JSON: let the shared helper explain it
  }
}

// F51: a build that shows the same thing keeps the previous build's arrays (no new filter, layout or table rows) but
// its own build time, so "as of" and the freshness banner stay current. The signature is computed once per object.
const sigCache = new WeakMap<object, string>();
const sigOf = (v: InventoryView) => {
  let s = sigCache.get(v);
  if (s === undefined) sigCache.set(v, (s = inventorySignature(v)));
  return s;
};
let last: { view: MapInventory; sig: string } | undefined;
function shared(v: MapInventory): MapInventory {
  const prev = last && last.view.sample === v.sample ? last : undefined;
  const out = shareUnchanged(prev, v, sigOf(v));
  sigCache.set(out, sigOf(v));
  last = { view: out, sig: sigOf(v) };
  return out;
}

export function useInventory() {
  return useSWR<MapInventory>(INVENTORY_KEY, fetchInventory, {
    refreshInterval: 60_000,
    keepPreviousData: true,
    revalidateOnFocus: false,
    // A 304 (or the same build again) is the same data: no render at all. Cheap: both signatures are cached.
    compare: (a, b) => a === b || (!!a && !!b && a.sample === b.sample && a.generatedAt === b.generatedAt && sigOf(a) === sigOf(b)),
  });
}

// ?refresh=1 re-discovers the account (rate-limited server-side).
export const refreshInventory = async (): Promise<MapInventory> => shared(await getJson<InventoryView>(`${INVENTORY_KEY}?refresh=1`));

export const detailUrl = (key: string, prefix?: string, token?: string) =>
  `/api/inventory/detail?key=${encodeURIComponent(key)}${prefix ? `&prefix=${encodeURIComponent(prefix)}` : ""}${token ? `&token=${encodeURIComponent(token)}` : ""}`;

// prefix: browsing inside the resource (S3 folders). Keeps the previous answer while the next folder loads.
export function useResourceDetail(key: string, prefix = "") {
  return useSWR<ResourceDetail>(detailUrl(key, prefix), { revalidateOnFocus: false, keepPreviousData: true });
}

export function useResourceActions(key: string) {
  return useSWR<{ actions: ActionInfo[] }>(`/api/inventory/actions?key=${encodeURIComponent(key)}`, { revalidateOnFocus: false });
}
