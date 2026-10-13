// Multi-region (wave A): the console's regions, the eu-west-1 environment the simulated account adds, its overview and
// guards, the map's per-region keys, the region rule for service copies, and the SDK-call diagnostics. Read-only apart
// from a dry-run copy that must be refused; nothing is changed.
export default async function regionsSmoke({ get, post, check }) {
  const REGION = /^[a-z]{2}(-gov|-iso[a-z]?)?-[a-z]+-\d$/;

  // /api/regions: home first, the configured list, nothing dropped.
  const rg = await get("/api/regions");
  const regions = rg.json?.regions ?? [];
  check("regions: home first, then the configured regions", rg.status === 200 && regions[0] === rg.json.home && regions.includes("eu-west-1") && regions.every((r) => REGION.test(r)) && new Set(regions).size === regions.length, `${regions.join(", ")} (${rg.json?.source})`);
  check("regions: no configuration entry was dropped", !(rg.json?.problems?.length > 0), rg.json?.problems?.join("; ") ?? "");

  // /api/envs: the colliding production cluster in eu-west-1 becomes production-eu-west-1, protected like production.
  const envs = (await get("/api/envs")).json ?? [];
  const eu = envs.find?.((e) => e.id === "production-eu-west-1");
  check("envs: production-eu-west-1 discovered with its region", !!eu && eu.region === "eu-west-1" && eu.label === "Production (eu-west-1)" && eu.protected === true, eu && `${eu.cluster} ${eu.clusterArn}`);
  check("envs: ids are unique and every env is in a console region", envs.length > 0 && new Set(envs.map((e) => e.id)).size === envs.length && envs.every((e) => regions.includes(e.region)), envs.map?.((e) => `${e.id}@${e.region}`).join(" "));
  check("envs: the home production env keeps its id and region", envs.some?.((e) => e.id === "production" && e.region === rg.json?.home));

  // The eu environment's own services, guarded like any protected env.
  const ov = await get("/api/overview?env=production-eu-west-1");
  const ids = (ov.json?.services ?? []).map((s) => s.id);
  check("overview production-eu-west-1: its own services", ov.status === 200 && ids.includes("api") && ids.includes("worker") && ov.json.services.every((s) => s.env === "production-eu-west-1"), `${ids.join(", ")}, ${ov.ms}ms`);
  const restart = await post("/api/services/production-eu-west-1/api/actions", { action: "restart", confirm: "api" });
  check("action: a restart in production-eu-west-1 needs a reason", restart.status === 400, restart.json?.error);
  const copy = await post("/api/provision/clone", { env: "staging", sourceEnv: "production-eu-west-1", source: "api", name: "smoke-xregion", desired: 0, dryRun: true });
  check("provision: a service is never copied across regions", [400, 403, 409].includes(copy.status) && !(await get("/api/overview?env=staging")).json.services.some((s) => s.id === "smoke-xregion"), `${copy.status} ${copy.json?.error ?? ""}`);

  // The map: both regions, eu resources under @eu-west-1 keys in the eu env; home keys carry no suffix.
  const inv = (await get("/api/inventory")).json ?? {};
  check("inventory: regions and home region", JSON.stringify(inv.regions) === JSON.stringify(regions) && inv.homeRegion === rg.json?.home, `${inv.regions?.join(", ")} home ${inv.homeRegion}`);
  const euSvcs = (inv.resources ?? []).filter((r) => r.kind === "ecs-service" && r.region === "eu-west-1");
  check("inventory: eu-west-1 ECS services keyed @eu-west-1 in production-eu-west-1", euSvcs.length >= 2 && euSvcs.every((r) => r.key.endsWith("@eu-west-1") && r.env === "production-eu-west-1"), euSvcs.map((r) => r.key).join(" "));
  check("inventory: home-region keys carry no region suffix", (inv.resources ?? []).filter((r) => r.region === inv.homeRegion).every((r) => !r.key.endsWith(`@${inv.homeRegion}`)));
  const c = inv.completeness;
  check("inventory: completeness counts each provider once", !!c && Object.values(c.providers ?? {}).reduce((a, b) => a + b, 0) === (inv.providers ?? []).length, c && JSON.stringify(c.providers));
  if (euSvcs[0]) {
    const d = await get(`/api/inventory/detail?key=${encodeURIComponent(euSvcs[0].key)}`);
    check("inventory: detail of an eu-west-1 service", d.status === 200 && d.json.key === euSvcs[0].key);
  }
  const bogus = await get(`/api/inventory/detail?key=${encodeURIComponent("ecs:service/acme-production/api@not-a-region")}`);
  check("inventory: a key naming no AWS region is refused, not a server error", bogus.status >= 400 && bogus.status < 500, String(bogus.status));

  // SDK-call diagnostics: per service and region (the simulated account makes no SDK calls, so the list may be empty).
  const dg = await get("/api/diagnostics/aws");
  const rows = Array.isArray(dg.json) ? dg.json : [];
  check("diagnostics/aws: per service and region call counts", dg.status === 200 && Array.isArray(dg.json) && rows.every((r) => typeof r.service === "string" && REGION.test(r.region) && ["requests", "attempts", "throttled", "errors", "p95Ms", "active", "queued"].every((k) => Number.isFinite(r[k]))), `${rows.length} rows`);
  check("diagnostics/aws: no ARNs or account ids", !/arn:aws|\b\d{12}\b/.test(JSON.stringify(dg.json ?? "")));
}
