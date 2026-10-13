// Cloud map: the inventory graph, a resource's detail and actions, a dry run through the action runner, the guards in
// front of a real run, and the cloud.* agent operations. Read-only apart from dry runs; nothing is changed.
export default async function inventorySmoke({ get, post, call, check, BASE }) {
  const inv = await get("/api/inventory");
  const v = inv.json ?? {};
  check("inventory: resources, edges, envs and provider statuses", inv.status === 200 && Array.isArray(v.resources) && Array.isArray(v.edges) && Array.isArray(v.envs) && Array.isArray(v.providers), `${v.resources?.length} resources, ${v.edges?.length} edges, ${inv.ms} ms`);
  check("inventory: ECS, load balancers, RDS and ElastiCache discovered", ["ecs", "elb", "rds", "elasticache"].every((id) => v.providers?.find((p) => p.id === id)?.state === "ok"), v.providers?.map((p) => `${p.id}:${p.state}`).join(" "));
  const keys = new Set((v.resources ?? []).map((r) => r.key));
  check("inventory: every edge joins two resources", (v.edges ?? []).every((e) => keys.has(e.from) && keys.has(e.to) && e.from !== e.to));
  check("inventory: no environment values or secrets in the graph", !/-pass@|sk_live|whsec_|jwt-fake|smtp-fake/.test(JSON.stringify(v)));
  const svc = (v.resources ?? []).find((r) => r.kind === "ecs-service" && r.env === "staging");
  check("inventory: ECS services carry their environment and why", !!svc && typeof svc.envWhy === "string", svc?.key);
  check("inventory: a connection string became a mentioned edge with the variable as evidence", (v.edges ?? []).some((e) => e.evidence.includes("env DATABASE_URL")));

  // Compare a home-region run, not generatedAt: other regions merge in a second phase and publish a newer view a few
  // milliseconds later, while the refresh itself was served from cache.
  const again = await get("/api/inventory?refresh=1");
  const twice = await get("/api/inventory?refresh=1");
  const ecsAt = (x) => x.json.providers?.find((p) => p.id === "ecs")?.at;
  check("inventory: refresh re-discovers, and a second refresh within 20 s is served from cache", again.status === 200 && twice.status === 200 && ecsAt(twice) !== undefined && ecsAt(twice) === ecsAt(again), `${ecsAt(again)} / ${ecsAt(twice)}`);

  // A poll that already has this build gets 304 and no body (CC-17, F51).
  const first = await fetch(BASE + "/api/inventory");
  const etag = first.headers.get("etag");
  await first.arrayBuffer();
  const same = etag ? await fetch(BASE + "/api/inventory", { headers: { "if-none-match": etag } }) : undefined;
  check("inventory: a weak ETag, and If-None-Match answers 304", !!etag && etag.startsWith("W/") && same?.status === 304, `${etag} → ${same?.status}`);
  const cov = await get("/api/inventory/coverage");
  check("inventory: the coverage view", cov.status === 200 && !!cov.json.freshness && Array.isArray(cov.json.vanishing) && Array.isArray(cov.json.unresolved), cov.json.error ?? "");

  if (svc) {
    const d = await get(`/api/inventory/detail?key=${encodeURIComponent(svc.key)}`);
    check("inventory: detail of an ECS service", d.status === 200 && d.json.key === svc.key && Array.isArray(d.json.sections), d.json.sections?.map((s) => s.title).join(", "));
    const a = await get(`/api/inventory/actions?key=${encodeURIComponent(svc.key)}`);
    check("inventory: actions of an ECS service", a.status === 200 && Array.isArray(a.json.actions), `${a.json.actions?.length} actions`);
  }
  check("inventory: unknown key is 404, missing key 400", (await get("/api/inventory/detail?key=nope:x")).status === 404 && (await get("/api/inventory/actions")).status === 400);

  // A dry run of the first action on the map that plans with an empty input (the providers that declare actions are
  // optional, and some actions need input to plan at all).
  let target, plan;
  search: for (const r of v.resources ?? []) {
    const a = await get(`/api/inventory/actions?key=${encodeURIComponent(r.key)}`);
    for (const act of (a.json.actions ?? []).filter((x) => x.allowed && !x.blocked && !x.input?.required?.length)) {
      const p = await post("/api/inventory/action", { key: r.key, provider: act.provider, action: act.id, input: {}, dryRun: true });
      if (p.status === 200) {
        [target, plan] = [{ r, act }, p];
        break search;
      }
    }
  }
  if (target) {
    const body = { key: target.r.key, provider: target.act.provider, action: target.act.id, input: {} };
    check("inventory action: dry run returns a plan and the confirmation text", typeof plan.json.plan?.summary === "string" && typeof plan.json.plan?.confirm === "string", `${target.act.provider}.${target.act.id}: ${plan.json.plan?.summary}`);
    check("inventory action: any dryRun value but false plans", (await post("/api/inventory/action", { ...body, dryRun: "yes" })).json.plan !== undefined);
    check("inventory action: a wrong confirmation is refused before anything runs", (await post("/api/inventory/action", { ...body, dryRun: false, confirm: "definitely-not-it" })).status === 400);
    check("inventory action: without the CSRF header it's refused", (await post("/api/inventory/action", { ...body, dryRun: true }, { "content-type": "application/json", origin: BASE })).status === 403);
    const dry = await post("/api/ops/cloud.action", { input: { ...body, confirm: plan.json.plan?.confirm ?? "yes" }, dryRun: true });
    check("ops: cloud.action dry run", dry.status === 200 && typeof dry.json.plan?.summary === "string", dry.json.error ?? "");
  } else check("inventory action: (no action plans with an empty input yet — dry run skipped)", true);
  check("inventory action: an action for another kind of resource is refused", svc ? [400, 404].includes((await post("/api/inventory/action", { key: svc.key, provider: "ecs", action: "nope", input: {}, dryRun: true })).status) : true);
  check("inventory action: unknown fields are refused", (await post("/api/inventory/action", { key: "x", provider: "ecs", action: "a", extra: 1 })).status === 400);

  const map = await post("/api/ops/cloud.map", { input: { env: "staging" } });
  check("ops: cloud.map summarises and lists a filtered environment", map.status === 200 && map.json.result?.counts?.resources > 0 && Array.isArray(map.json.result?.resources), JSON.stringify(map.json.result?.counts?.byKind ?? map.json.error));
  if (svc) {
    const one = await post("/api/ops/cloud.get", { input: { key: svc.key } });
    check("ops: cloud.get returns the resource and its edges", one.status === 200 && one.json.result?.resource?.key === svc.key && Array.isArray(one.json.result?.edges));
    check("ops: cloud.actions", (await post("/api/ops/cloud.actions", { input: { key: svc.key } })).status === 200);
  }
  check("ops: cloud.action refuses an unknown resource", (await call("POST", "/api/ops/cloud.action", { input: { key: "nope:x", provider: "ecs", action: "x", confirm: "yes" }, dryRun: true })).status === 404);

  // Human-only actions (a download link hands out data): never listed for a token, never run, never even requested.
  const bucket = (v.resources ?? []).find((r) => r.kind === "s3");
  const human = bucket ? (await get(`/api/inventory/actions?key=${encodeURIComponent(bucket.key)}`)).json.actions?.find((a) => a.humanOnly || a.id === "download-object") : undefined;
  if (human) {
    const tok = await post("/api/tokens", { name: "smoke-inventory", mode: "propose", role: "operator", expiresInDays: 7 });
    const B = { "content-type": "application/json", authorization: `Bearer ${tok.json.token}` };
    const listed = await call("POST", "/api/ops/cloud.actions", { input: { key: bucket.key } }, B);
    check("tokens: human-only actions aren't listed for a token", listed.status === 200 && !listed.json.result?.actions?.some((a) => a.id === human.id), listed.json.error ?? "");
    const ask = await call("POST", "/api/ops/cloud.action", { input: { key: bucket.key, provider: human.provider, action: human.id, input: { key: "x" }, confirm: "yes" } }, B);
    check("tokens: a human-only action can't even be requested", ask.status === 403 && !ask.json.approval, `${ask.status} ${ask.json.error ?? ""}`);
    await call("DELETE", `/api/tokens/${tok.json.item?.id}`);
  } else check("tokens: (no human-only action on the map — skipped)", true);
}
