// F51: the 60 s poll must not re-lay the map out when nothing it shows changed. Pure (tested in signature.test.ts).
import type { InventoryView } from "../../lib/inventory/types.ts";

// Read times change on every build and say nothing about the account: left out of the signature.
const VOLATILE = new Set(["observedAt", "at", "ms"]);
const stable = (_k: string, v: unknown) => (VOLATILE.has(_k) ? undefined : v);

// Everything the map, the list, the table and the panel show, in one string: every field of every resource, edge,
// environment and provider except read times, plus the coverage (regions, phases, completeness). generatedAt,
// providers[].at / ms and resources' observedAt change on every build and are left out.
export function inventorySignature(v: InventoryView | undefined): string {
  if (!v) return "";
  const parts: string[] = [];
  for (const r of v.resources) parts.push(JSON.stringify(r, stable));
  for (const e of v.edges) parts.push(JSON.stringify(e, stable));
  parts.push(JSON.stringify(v.envs), JSON.stringify(v.providers, stable));
  parts.push(`${(v.regions ?? []).join(",")}|${(v.partial?.pendingRegions ?? []).join(",")}|${v.completeness?.lastCompleteAt === v.generatedAt}|${(v.truncated ?? []).join(";")}|${v.accountId ?? ""}`);
  return parts.join("\n");
}

// A new build of an unchanged account keeps the previous build's arrays (so every memo keyed on them — filters,
// layout, the table — stays put) but takes its own build time, coverage and provider statuses, so "as of", the
// freshness banner (R21) and the sources footer stay current. `sig` is the signature of each side.
export function shareUnchanged<T extends InventoryView>(prev: { view: T; sig: string } | undefined, next: T, sig: string): T {
  if (!prev || prev.sig !== sig || prev.view === next) return next;
  return { ...next, resources: prev.view.resources, edges: prev.view.edges, envs: prev.view.envs };
}
