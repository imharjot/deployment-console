import { invalidate } from "@/lib/server/cache";
import { PROXY_IMAGE } from "@/lib/discover";
import { consoleConfig, discoveryWarnings, inventory, listEnvs, unreadRegions, workloadsOf } from "@/lib/server/discovery";
import { handle, json, requirePerm, userOf } from "@/lib/server/http";
import { consoleRegions } from "@/lib/server/regions";
import { getCloud } from "@/lib/server/sources";

// What discovery found and why — for Settings → Environments. Hostnames/ids only; no secrets exist in this data.
// `region` is the home region; `regions` every region read, home first (`regionsInfo` says how many environments each
// has and whether it answered); each env carries its own region. `warnings` are config-vs-account problems (F05):
// configured environments, databases and caches that weren't found, and health-check tags that aren't probed.
export const GET = handle(async (req) => {
  userOf(req);
  const [envs, inv, regions, warnings] = await Promise.all([listEnvs(), inventory(), consoleRegions(), discoveryWarnings()]);
  const cloud = await getCloud(regions.home);
  const { file, errors: configErrors, failClosed, stale } = consoleConfig();
  const down = new Map(unreadRegions().map((x) => [x.region, x.error]));
  return json({
    source: cloud.kind,
    region: cloud.region,
    regions: regions.regions,
    regionsInfo: regions.regions.map((r) => ({ region: r, home: r === regions.home, envs: envs.filter((e) => e.region === r).length, ...(down.has(r) ? { error: down.get(r) } : {}) })),
    scannedAt: inv.at,
    config: { file: file ?? null, errors: configErrors, ...(failClosed ? { failClosed: true } : {}), ...(stale ? { stale: true } : {}) },
    errors: inv.errors,
    warnings,
    envs: envs.map((e) => {
      const c = inv.catalogs.get(e.id);
      return {
        ...e,
        services:
          e.kind === "compose"
            ? // A compose env's apps are its declared workloads (AWS sees none of its containers).
              Object.entries(workloadsOf(consoleConfig().config, e.id)).map(([id, w]) => ({ id, name: w.name, repo: w.repo, repoSource: w.repo ? ("config" as const) : undefined, infra: !w.repo, hidden: false, self: false, healthcheck: w.healthcheck, proxy: PROXY_IMAGE.test(id), platform: w.platform ?? "docker compose" }))
            : c ? [...c.meta.values()].map((m) => ({ id: m.id, name: m.name, repo: m.repo, repoSource: m.repoSource, infra: m.infra, hidden: m.hidden, self: m.self, logs: m.logs, healthcheck: m.healthcheck, proxy: m.proxy })) : [],
        hosts: c?.hosts.map((h) => ({ id: h.id, name: h.tags.Name ?? h.id, state: h.state, type: h.type, asg: h.asg })) ?? [],
        databases: c?.databases.map((d) => ({ id: d.id, engine: d.engine, status: d.status })) ?? [],
        caches: c?.caches.map((x) => ({ id: x.id, engine: x.engine, status: x.status })) ?? [],
        edges: c?.edges.map((x) => ({ from: x.from, to: x.to, label: x.label, source: x.source })) ?? [],
        ingress: c?.ingress,
        warnings: c?.warnings ?? [],
      };
    }),
    unassigned: { databases: inv.unassigned.databases.map((d) => d.id), caches: inv.unassigned.caches.map((c) => c.id) },
  });
});

// Re-scan now instead of waiting for the 60 s cache.
export const POST = handle(async (req) => {
  requirePerm(userOf(req), "admin");
  invalidate("discovery:");
  invalidate("vars:refs"); // who shares which secret reference is derived from the same scan
  await inventory();
  return json({ ok: true });
});
