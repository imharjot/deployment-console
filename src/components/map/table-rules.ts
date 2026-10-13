// The All-resources table's rules (pure; tested in table-rules.test.ts): filtering, sorting, CSV and the URL.
import { CATEGORY_ORDER, categoryOf, kindLabelOf, serviceOf, type Health, type Resource } from "../../lib/inventory/types.ts";
import { REMOTE_TEXT, SHARED, isProblemResource as isProblem, isRemote, matchesQuery } from "./filter.ts";

const RANK: Record<Health, number> = { error: 0, warning: 1, unknown: 2, stopped: 3, ok: 4 };

export type SortKey = "name" | "kind" | "service" | "category" | "env" | "region" | "health" | "source";
export interface TableFilters {
  q: string;
  kind: string; // "" = any; a kind, or for generic rows a Resource Explorer type
  service: string;
  category: string;
  region: string; // "" | "all" | region
  env: string; // "" | env id | "__shared"
  health: string; // "" | Health | "problems"
  source: string; // "" | provider | resource-explorer | tagging | config | cloudcontrol | reference
  hidden: boolean; // include hidden rows
  sort: SortKey;
  dir: 1 | -1;
}
export const DEFAULT_TABLE: TableFilters = { q: "", kind: "", service: "", category: "", region: "", env: "", health: "", source: "", hidden: false, sort: "health", dir: 1 };

export const sourceOf = (r: Pick<Resource, "source">) => r.source ?? "provider";
export const kindKeyOf = (r: Pick<Resource, "kind" | "resourceType">) => (r.kind === "aws-resource" && r.resourceType ? r.resourceType : r.kind);

export function tableRows(resources: readonly Resource[], f: TableFilters, hay?: Map<string, string>): Resource[] {
  const out = resources.filter(
    (r) =>
      (f.hidden || !r.hidden) &&
      (!f.kind || kindKeyOf(r) === f.kind) &&
      (!f.service || serviceOf(r) === f.service) &&
      (!f.category || categoryOf(r) === f.category) &&
      (!f.region || f.region === "all" || r.region === f.region) &&
      (!f.env || (f.env === SHARED ? !r.env : r.env === f.env)) &&
      (!f.health || (f.health === "problems" ? isProblem(r) : r.health === f.health)) &&
      (!f.source || sourceOf(r) === f.source) &&
      (!f.q.trim() || matchesQuery(r, f.q, hay?.get(r.key))),
  );
  const val = (r: Resource): string | number => {
    switch (f.sort) {
      case "kind":
        return kindLabelOf(r).toLowerCase();
      case "service":
        return serviceOf(r).toLowerCase();
      case "category":
        return CATEGORY_ORDER.indexOf(categoryOf(r));
      case "env":
        return r.env ?? "￿";
      case "region":
        return r.region;
      case "health":
        return RANK[r.health];
      case "source":
        return sourceOf(r);
      default:
        return r.name.toLowerCase();
    }
  };
  return out.sort((a, b) => {
    const x = val(a), y = val(b);
    const c = x < y ? -1 : x > y ? 1 : 0;
    return c * f.dir || a.name.localeCompare(b.name) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  });
}

// RFC 4180: quote every field, double the quotes. A leading = + - @ is prefixed with ' so a spreadsheet never runs it.
export function toCsv(rows: readonly Resource[]): string {
  const cell = (v: unknown) => {
    let s = v === undefined || v === null ? "" : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return `"${s.replace(/"/g, '""')}"`;
  };
  const head = ["name", "key", "kind", "service", "category", "environment", "region", "health", "reason", "source", "hidden", "idle", "account"];
  const lines = rows.map((r) =>
    [r.name, r.key, kindLabelOf(r), serviceOf(r), categoryOf(r), r.env ?? "", r.region, r.health, isRemote(r) ? REMOTE_TEXT : (r.healthReason ?? ""), sourceOf(r), r.hidden ? "yes" : "", r.idle?.why ?? "", r.account ?? ""].map(cell).join(","),
  );
  return [head.map(cell).join(","), ...lines].join("\r\n");
}

// ---- URL ----
const KEYS: (keyof TableFilters)[] = ["q", "kind", "service", "category", "region", "env", "health", "source"];
export function tableToParams(f: TableFilters, p = new URLSearchParams()): URLSearchParams {
  for (const k of KEYS) {
    const v = f[k] as string;
    if (v && !(k === "region" && v === "all")) p.set(k, v);
    else p.delete(k);
  }
  if (f.hidden) p.set("hidden", "1");
  else p.delete("hidden");
  if (f.sort !== DEFAULT_TABLE.sort || f.dir !== DEFAULT_TABLE.dir) p.set("sort", `${f.dir < 0 ? "-" : ""}${f.sort}`);
  else p.delete("sort");
  return p;
}
const SORTS: SortKey[] = ["name", "kind", "service", "category", "env", "region", "health", "source"];
export function tableFromParams(p: URLSearchParams): TableFilters {
  const f: TableFilters = { ...DEFAULT_TABLE };
  for (const k of KEYS) (f as unknown as Record<string, string>)[k] = p.get(k) ?? "";
  f.hidden = p.get("hidden") === "1";
  const s = p.get("sort") ?? "";
  const key = s.replace(/^-/, "") as SortKey;
  if (SORTS.includes(key)) {
    f.sort = key;
    f.dir = s.startsWith("-") ? -1 : 1;
  }
  // From the map (/map?view=table&kinds=…&problems=1): one kind carries over, "problems only" becomes health.
  if (!f.kind && p.get("kinds") && !p.get("kinds")!.includes(",")) f.kind = p.get("kinds")!;
  if (!f.health && p.get("problems") === "1") f.health = "problems";
  return f;
}

