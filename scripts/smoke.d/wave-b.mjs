// Wave B: the 32 new providers and the catch-all, dev mode's loopback guard (F02), the streaming body cap (F64), the
// sampler's deep health, exposure (R4), autoscaling and capacity on the service view (CC-20, R11), image checks (R24),
// CI deployment binding (R03), and the workspace stores (pins, saved items, prefs). Everything it creates it deletes.
const WAVE_B = [
  "vpc", "security-group", "cloudmap", "ebs", "iam", "kms", "acm", "secrets", "ssm", "athena", "logs", "alarms", "synthetics",
  "cloudtrail", "glue", "ecr", "codepipeline", "codebuild", "codedeploy", "cloudformation", "rds-cluster",
  "elasticache-serverless", "memorydb", "redshift", "opensearch", "efs", "mq", "firehose", "scheduler", "pipes", "ses", "msk",
];

export default async function waveBSmoke({ get, post, call, check, BASE }) {
  const H = { "content-type": "application/json", "x-console-csrf": "1", origin: BASE };

  // Providers: every wave-B provider and the catch-all read the simulated account, and each finds something.
  const inv = (await get("/api/inventory")).json ?? {};
  const state = (id) => (inv.providers ?? []).filter((p) => p.id === id);
  const bad = [...WAVE_B, "catchall"].filter((id) => { const s = state(id); return !s.length || s.some((p) => p.state !== "ok") || !s.some((p) => p.count > 0); });
  check("inventory: the 32 wave-B providers and the catch-all are ok and find resources", bad.length === 0, bad.length ? bad.map((id) => `${id}:${state(id).map((p) => p.state).join("/") || "missing"}`).join(" ") : `${WAVE_B.length + 1} providers`);

  // R4: the simulated staging database is publicly addressable and its group admits 0.0.0.0/0 on 5432.
  const stgDb = (inv.resources ?? []).find((r) => r.key === "rds:acme-staging-pg");
  check("inventory: a database reachable from the internet is an error with an internet edge (R4)", stgDb?.health === "error" && /internet/.test(stgDb.healthReason ?? "") && (inv.edges ?? []).some((e) => e.from === "external:internet" && e.to === stgDb.key), stgDb?.healthReason ?? "missing");

  // F02: dev mode answers loopback hosts only, whatever a forwarding header claims.
  const fwd = await fetch(BASE + "/api/me", { headers: { "x-forwarded-host": "console.example.com" } });
  check("dev mode: a request for another host is refused (F02)", fwd.status === 403, `${fwd.status}`);

  // F64: the body cap is checked in bytes before the route parses anything.
  const big = await fetch(BASE + "/api/pins", { method: "POST", headers: H, body: JSON.stringify({ rkey: "x".repeat(6000), name: "n", kind: "service" }) });
  check("body over the route's cap is 413 (F64)", big.status === 413, `${big.status}`);

  // R21: the deep health check says when the sampler last finished, and nothing about environments.
  const deep = await get("/api/healthz?deep=1");
  check("healthz?deep=1: the sampler's last pass, no environment data", deep.status === 200 && typeof deep.json?.sampler?.lastTickAt === "number" && !/production|staging/.test(JSON.stringify(deep.json)), JSON.stringify(deep.json?.sampler ?? {}));

  // CC-20 / R11: autoscaling and capacity on the service view.
  const prod = (await get("/api/overview?env=production")).json ?? {};
  const api = prod.services?.find((s) => s.id === "api");
  check("overview: api shows its autoscaling range (CC-20)", api?.autoscaling?.min === 2 && api?.autoscaling?.max === 6, JSON.stringify(api?.autoscaling ?? null));
  check("overview: every service reports desired, running and pending (R11)", prod.services?.length > 0 && prod.services.every((s) => ["desired", "running", "pending"].every((k) => typeof s.capacity?.[k] === "number")));

  // R24: each revision says whether its images still exist.
  const revs = (await get("/api/services/production/api/revisions")).json;
  check("revisions: an image check on every revision (R24)", Array.isArray(revs) && revs.length > 0 && revs.every((r) => ["present", "missing", "unknown"].includes(r.imageCheck)), Array.isArray(revs) ? [...new Set(revs.map((r) => r.imageCheck))].join(" ") : "");

  // R03: a re-run is planned by the workflow file it runs, never by its name.
  const repo = "acme/jobs";
  const runs = (await get(`/api/ci/runs?repo=${encodeURIComponent(repo)}`)).json;
  const deploy = Array.isArray(runs) ? runs.find((r) => r.status === "completed" && r.workflow === "deploy" && r.branch === "main") : undefined;
  if (deploy) {
    const url = `/api/ci/runs/${deploy.id}/rerun?repo=${encodeURIComponent(repo)}`;
    const plan = (await post(url, { mode: "redeploy" })).json?.plan;
    check("ci rerun: without confirm, a plan bound to production by its workflow file (R03)", plan?.scope === "bound" && plan.env === "production" && plan.confirm === "production" && plan.needsReason === true, plan?.why ?? "");
    const tests = (await post(url, { mode: "tests" })).json?.plan;
    check("ci rerun: re-running only failed jobs of a deploy workflow is refused", typeof tests?.refused === "string", tests?.refused ?? "");
  }

  // /api/discovery says what in the config file matched nothing (F05).
  const disc = (await get("/api/discovery")).json ?? {};
  check("discovery: config warnings and the config's state", Array.isArray(disc.warnings) && typeof disc.config === "object");

  // Pins: add, list, remove.
  const rkey = "ecs:service/acme-staging/api";
  const pin = await post("/api/pins", { rkey, name: "api", kind: "service", env: "staging" });
  check("pins: add", pin.status === 201 && pin.json.pin?.rkey === rkey, pin.json.error ?? "");
  check("pins: listed", ((await get("/api/pins")).json.pins ?? []).some((p) => p.rkey === rkey));
  const unpin = await call("DELETE", `/api/pins?rkey=${encodeURIComponent(rkey)}`);
  check("pins: remove", unpin.status === 200 && !((await get("/api/pins")).json.pins ?? []).some((p) => p.rkey === rkey));

  // Saved log queries: create, list, delete; a payload that isn't a console page is refused.
  const saved = await post("/api/saved", { kind: "log-query", name: "smoke errors", payload: { env: "staging", services: ["api"], query: "ERROR", minutes: 60 } });
  const id = saved.json.item?.id;
  check("saved: a log query is created", saved.status === 201 && typeof id === "string", saved.json.error ?? "");
  check("saved: a view pointing at another site is refused", (await post("/api/saved", { kind: "view", name: "x", payload: { path: "//evil.example", search: "" } })).status === 400);
  if (id) {
    check("saved: listed", ((await get("/api/saved?kind=log-query")).json.items ?? []).some((x) => x.id === id));
    check("saved: delete", (await call("DELETE", `/api/saved/${encodeURIComponent(id)}`)).status === 200 && (await get(`/api/saved/${encodeURIComponent(id)}`)).status === 404);
  }

  // Prefs: readable; an unknown key is refused.
  check("prefs: read", (await get("/api/me/prefs")).status === 200);
  check("prefs: an unknown key is refused", (await call("PATCH", "/api/me/prefs", { theme: "dark" })).status === 400);
}
