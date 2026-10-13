// Discovery's checks of console.config.json against the account (F05), as pure rules: which clusters discovery leaves
// out and why, what the config names that the account doesn't have ("did you mean …?"), which health-check URLs may be
// probed (F33), and what counts as unassigned. src/lib/server/discovery.ts feeds them; GET /api/discovery returns the
// warnings and Settings → Environments shows them. Nothing here changes the environment list.
import type { ConsoleConfig } from "./console-config.ts";
import type { RawCluster } from "./types.ts";

export interface DiscoveryWarning {
  scope: string; // "environment staging", "service staging/api", "regions"
  message: string;
  hint?: string;
  kind: "environment" | "database" | "cache" | "region" | "healthcheck";
  env?: string;
  region?: string;
}

// AWS Batch creates (and owns) an ECS cluster per compute environment: "AWSBatch-<name>-<uuid>". Its jobs aren't
// services anyone deploys from here, so discovery skips them unless the config names one.
export const AWS_BATCH_CLUSTER = /^AWSBatch-/;

export type ClusterSkip = "inactive" | "ignored" | "batch" | "undiscovered";

// Why discovery leaves a cluster out (undefined: it becomes an environment). `pinned`: a config entry names it.
export function clusterSkip(c: Pick<RawCluster, "name" | "status" | "tags">, config: ConsoleConfig, pinned: boolean): ClusterSkip | undefined {
  if (c.status !== "ACTIVE") return "inactive";
  if ((config.ignoreClusters ?? []).includes(c.name) || c.tags["console:ignore"] === "true") return "ignored";
  if (pinned) return undefined;
  if (AWS_BATCH_CLUSTER.test(c.name)) return "batch";
  if (config.discoverClusters === false) return "undiscovered";
  return undefined;
}

// ---------- names ----------

function distance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const up = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = up;
    }
  }
  return prev[b.length];
}

// The candidate a mistyped name most likely meant: case-insensitive equal, else the closest by edit distance within
// about a third of the name. One name containing the other ("staging" → "acme-staging", "acme-valkey" → the group
// "acme" rather than its member "acme-001") counts as half as far, whatever its distance. Ties go to the first.
export function nearest(name: string, candidates: string[]): string | undefined {
  const n = name.toLowerCase();
  const pool = [...new Set(candidates)].filter((c) => c !== name);
  const same = pool.find((c) => c.toLowerCase() === n);
  if (same) return same;
  let best: { c: string; score: number } | undefined;
  for (const c of pool) {
    const l = c.toLowerCase();
    const d = distance(n, l);
    const contains = Math.min(n.length, l.length) >= 4 && (l.includes(n) || n.includes(l));
    if (!contains && d > Math.max(2, Math.floor(n.length / 3))) continue;
    const score = contains ? d / 2 : d;
    if (!best || score < best.score) best = { c, score };
  }
  return best?.c;
}

// ---------- health checks (F33) ----------

export const MAX_HEALTHCHECK_URL = 2048;

// A console:healthcheck tag (or config healthcheck) the console may probe: an absolute http(s) URL, at most 2,048
// characters, nothing that isn't part of a URL. undefined = fine. Where the URL may point is the probe's own check.
export function healthcheckProblem(url: string): string | undefined {
  if (url.length > MAX_HEALTHCHECK_URL) return `is longer than ${MAX_HEALTHCHECK_URL} characters`;
  if (/\s/.test(url)) return "contains spaces or line breaks";
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return "isn't a URL";
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return `uses ${u.protocol.replace(/:$/, "")}: only http and https are probed`;
  if (u.username || u.password) return "carries a user name or password";
  return undefined;
}

// ---------- config against the account ----------

export interface WarningInput {
  home: string;
  regions: string[]; // the regions the console reads
  clusters: Record<string, RawCluster[] | undefined>; // every cluster per region, before any filter; undefined = not read
  config: ConsoleConfig;
  envs: { id: string; region: string; cluster: string }[]; // what discovery made of it
  databases: Record<string, string[] | undefined>; // RDS instance ids per region; undefined = not read
  caches: Record<string, string[] | undefined>; // ElastiCache ids (groups and their member clusters) per region
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function configWarnings(i: WarningInput): DiscoveryWarning[] {
  const out: DiscoveryWarning[] = [];
  const entries = Object.entries(i.config.environments ?? {});
  const workloads = Object.values(i.config.workloads ?? {});
  for (const [id, e] of entries) {
    const region = e.region ?? i.home;
    const scope = `environment ${id}`;
    const w = workloads.filter((x) => x.env === id).length;
    const mapOnly = w ? ` — its ${plural(w, "declared workload")} appear${w === 1 ? "s" : ""} on the cloud map only` : "";
    if (!i.regions.includes(region)) {
      out.push({ kind: "region", scope, env: id, region, message: `environment "${id}": region ${region} isn't one the console reads${mapOnly}`, hint: `add ${region} to CONSOLE_REGIONS or inventory.regions` });
      continue;
    }
    const here = i.clusters[region];
    if (here && e.cluster) {
      const c = here.find((x) => x.name === e.cluster);
      if (!c) {
        const elsewhere = i.regions.find((r) => r !== region && i.clusters[r]?.some((x) => x.name === e.cluster));
        const guess = nearest(e.cluster, here.map((x) => x.name));
        out.push({
          kind: "environment", scope, env: id, region,
          message: `environment "${id}": cluster "${e.cluster}" not found in ${region}${mapOnly}`,
          hint: elsewhere ? `it exists in ${elsewhere} — set environments.${id}.region to "${elsewhere}"` : guess ? `did you mean "${guess}"?` : "check the cluster name and the console's region",
        });
      } else {
        const skip = clusterSkip(c, i.config, true);
        if (skip === "inactive") out.push({ kind: "environment", scope, env: id, region, message: `environment "${id}": cluster "${e.cluster}" in ${region} is ${c.status}${mapOnly}`, hint: "only ACTIVE clusters become environments" });
        else if (skip === "ignored")
          out.push({ kind: "environment", scope, env: id, region, message: `environment "${id}": cluster "${e.cluster}" in ${region} is ignored${mapOnly}`, hint: (i.config.ignoreClusters ?? []).includes(c.name) ? "remove it from ignoreClusters" : "remove its console:ignore tag" });
        else if (!i.envs.some((x) => x.id === id)) {
          // Two entries naming one cluster: discovery keeps the last.
          const winner = entries.filter(([, x]) => x.cluster === e.cluster && (x.region ?? i.home) === region).pop()?.[0];
          out.push({ kind: "environment", scope, env: id, region, message: `environment "${id}": cluster "${e.cluster}" in ${region} is also named by environments.${winner}${mapOnly}`, hint: `only "${winner}" is used — remove one of the entries` });
        }
      }
    }
    for (const [kind, ids, have] of [["database", e.databases ?? [], i.databases], ["cache", e.caches ?? [], i.caches]] as const) {
      const list = have[region];
      if (!list) continue;
      for (const x of ids) {
        if (list.includes(x)) continue;
        const elsewhere = i.regions.find((r) => r !== region && have[r]?.includes(x));
        const guess = nearest(x, list);
        out.push({
          kind, scope, env: id, region,
          message: `environment "${id}": ${kind} "${x}" not found in ${region}${guess && !elsewhere ? ` (did you mean "${guess}"?)` : ""}`,
          hint: elsewhere ? `it is in ${elsewhere}; environments.${id}.${kind === "database" ? "databases" : "caches"} only matches ${region}` : `environments.${id}.${kind === "database" ? "databases" : "caches"} lists ${kind === "database" ? "RDS instance" : "ElastiCache replication group or cluster"} ids`,
        });
      }
    }
  }
  return out;
}

// Databases and caches nobody owns — no owner, or an owner without a catalog (an environment that isn't there).
export function unassignedOf<T extends { id: string }>(items: T[], owner: Map<string, string | undefined>, catalogs: ReadonlySet<string>): T[] {
  return items.filter((x) => {
    const o = owner.get(x.id);
    return !o || !catalogs.has(o);
  });
}
