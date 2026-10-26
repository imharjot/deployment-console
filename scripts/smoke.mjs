// End-to-end API smoke test against a running console (mock source, AUTH_MODE=dev). It refuses any other account.
//   CONSOLE_SOURCE=mock npm run dev   # in another terminal
//   npm run smoke                     # BASE=http://localhost:3200 by default
// Exercises every route and every server-side guard. Mutating calls only touch staging, and only restart
// a service that is running (it comes back by itself); production calls must all be refused.
const BASE = process.env.BASE ?? "http://localhost:3200";
const H = { "content-type": "application/json", "x-console-csrf": "1", origin: BASE };
let failed = 0;

async function call(method, path, body, headers = H) {
  const t = performance.now();
  const send = () => fetch(BASE + path, { method, headers: method === "GET" ? {} : headers, body: body === undefined ? undefined : JSON.stringify(body) });
  // A dev server recompiling can drop a kept-alive socket ("fetch failed: other side closed"). A GET is safe to send
  // again; anything else could act twice, so it fails as it is.
  const r = await send().catch((e) => (method === "GET" ? send() : Promise.reject(e)));
  const text = await r.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: r.status, json, ms: Math.round(performance.now() - t) };
}

function check(name, cond, detail = "") {
  if (!cond) failed++;
  console.log(`${cond ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}

const get = (p) => call("GET", p);
const post = (p, b, h) => call("POST", p, b, h);

// The suite restarts services, scales them and writes variables. Run it only against the simulated account
// (CONSOLE_SOURCE=mock): a console on the same port with CONSOLE_SOURCE=aws would get those actions for real.
const DEMO_ACCOUNT = "123456789012";
const account = (await get("/api/inventory").catch(() => ({ json: {} }))).json?.accountId;
if (account !== DEMO_ACCOUNT) {
  console.error(`Refusing to run: ${BASE} is account ${account ?? "unknown"}, not the simulated ${DEMO_ACCOUNT}. Start the console with CONSOLE_SOURCE=mock.`);
  process.exit(2);
}

// --- health, identity, auth guards
check("healthz", (await get("/api/healthz")).status === 200);
const me = await get("/api/me");
check("me", me.status === 200 && typeof me.json.email === "string", me.json.email);
check("POST without CSRF header is refused", (await post("/api/infra/box", { action: "start", confirm: "yes" }, { "content-type": "application/json", origin: BASE })).status === 403);
check("POST from another origin is refused", (await post("/api/infra/box", { action: "start", confirm: "yes" }, { ...H, origin: "https://evil.example" })).status === 403);
check("unknown env is 404, malformed env is 400", (await get("/api/overview?env=dev")).status === 404 && (await get("/api/overview?env=../x")).status === 400);

// --- discovery
const envs = (await get("/api/envs")).json;
check("envs discovered from clusters", Array.isArray(envs) && envs.length >= 2, envs.map?.((e) => `${e.id}${e.protected ? "(protected)" : ""}:${e.kind}`).join(" "));
check("production-like env is protected", envs.some((e) => e.id === "production" && e.protected) && envs.some((e) => e.id === "staging" && !e.protected));
check("envs: each says when the sampler last read it, and none is stale (R21)", envs.every?.((e) => e.sampledAt > 0 && e.stale === false), envs.filter?.((e) => !(e.sampledAt > 0) || e.stale !== false).map((e) => `${e.id}:${e.staleReason ?? "unsampled"}`).join(" "));
const disc = (await get("/api/discovery")).json;
const prodEdges = disc.envs?.find((e) => e.id === "production")?.edges ?? [];
const stgEdges = disc.envs?.find((e) => e.id === "staging")?.edges ?? [];
check("connections inferred from security groups", prodEdges.some((e) => e.source.includes("security group")), `${prodEdges.length} edges in production`);
check("connections inferred from connection strings", stgEdges.some((e) => e.source.includes("task definition env") && e.to.startsWith("database:")), `${stgEdges.length} edges in staging`);
// Each env's Postgres, plus production's Aurora members (DescribeDBInstances lists them; they fold under their cluster on the map).
check("databases and caches attributed to envs", disc.envs?.every((e) => e.databases.some((d) => /-pg$/.test(d.id ?? d))) && disc.envs?.find((e) => e.id === "production")?.caches.length === 1, disc.envs?.map((e) => `${e.id}:${e.databases.map((d) => d.id ?? d).join("+")}`).join(" "));
check("discovery re-scan is admin-only and works", (await post("/api/discovery", {})).status === 200);
check("resources for the palette span every env", new Set((await get("/api/resources")).json.map((r) => r.env)).size >= 2);
check("issues list", Array.isArray((await get("/api/issues")).json));
check("CI repos come from discovery", (await get("/api/ci/repos")).json.includes("acme/jobs"));

// --- overview (both envs)
const ov = {};
for (const env of ["staging", "production"]) {
  const r = await get(`/api/overview?env=${env}`);
  ov[env] = r.json;
  const d = r.json;
  check(`overview ${env}`, r.status === 200 && d.services.length > 0, `${d.services.length} services, ${d.infra.length} infra, ${d.topology.nodes.length} nodes / ${d.topology.edges.length} edges, ${r.ms}ms`);
  check(`overview ${env}: every edge joins two nodes`, d.topology.edges.every((e) => d.topology.nodes.some((n) => n.id === e.from) && d.topology.nodes.some((n) => n.id === e.to)));
  check(`overview ${env}: every clickable node resolves to a resource`, d.topology.nodes.filter((n) => n.resourceKey).every((n) => [...d.services, ...d.infra].some((x) => x.key === n.resourceKey)));
}
const lb = ov.production.infra.find((x) => x.kind === "loadbalancer");
check("production has a load balancer view", !!lb, lb && lb.stats.map((s) => `${s.label} ${s.value}`).join(", "));
check("LB view lists routing, target groups and targets", !!lb && ["Routing", "Target groups", "Targets"].every((g) => lb.properties.some((x) => x.title.startsWith(g))));
check("staging has no load balancer view", !ov.staging.infra.some((x) => x.kind === "loadbalancer"));
const caddy = ov.staging.services.find((s) => s.id === "caddy") ?? ov.staging.infra.find((s) => s.id === "caddy");
check("Caddy shows its routing", !!caddy && caddy.properties.some((g) => g.title.startsWith("Routing")));

// --- metrics per resource
const svc = ov.staging.services.find((s) => s.id === "api");
for (const [env, key] of [["staging", svc.key], ["production", lb.key]]) {
  const r = await get(`/api/metrics?env=${env}&key=${encodeURIComponent(key)}&minutes=60`);
  check(`metrics ${env} ${key}`, r.status === 200 && r.json.length > 0 && r.json.every((c) => c.points.length > 0), r.json.map?.((c) => c.id).join(","));
}
check("metrics with an unknown key is 404", (await get("/api/metrics?env=staging&key=service:nope")).status === 404);

// --- observability, performance, activity, releases, audit
for (const env of ["staging", "production"]) {
  const o = await get(`/api/observability?env=${env}&minutes=60`);
  check(`observability ${env}`, o.status === 200 && o.json.sections.length > 0, `${o.json.sections.reduce((a, s) => a + s.charts.length, 0)} charts`);
  const p = await get(`/api/performance?env=${env}&minutes=60`);
  const t = p.json.tiles?.all;
  check(`performance ${env}`, p.status === 200 && p.json.source !== "none" && t && t.rps > 0 && t.p50 <= t.p90 && t.p90 <= t.p99, `source ${p.json.source}, rps ${t?.rps}, avg ${t?.avg}, p50 ${t?.p50}, p90 ${t?.p90}, p99 ${t?.p99}, 5xx ${t?.errPct}%, ${p.ms}ms`);
  const svcRps = Object.entries(p.json.tiles ?? {}).filter(([k]) => k !== "all" && k !== "other").reduce((a, [, v]) => a + (v.rps ?? 0), 0);
  check(`performance ${env}: services add up to the total`, Math.abs(svcRps - t.rps) <= Math.max(1, t.rps * 0.05), `${svcRps.toFixed(1)} vs ${t.rps}`);
  const a = await get(`/api/activity?env=${env}`);
  check(`activity ${env}`, a.status === 200 && a.json.length > 0, `${a.json.length} items`);
}
check("performance window is clamped", (await get("/api/performance?env=production&minutes=999999")).json.minutes === 7 * 24 * 60);
const rel = await get("/api/releases");
check("releases: promotion chain per service", rel.status === 200 && rel.json.length > 0 && rel.json.every((r) => r.stages.length >= 1 && r.steps.length === Math.max(0, r.stages.length - 1)), rel.json.map((r) => `${r.service}:${r.stages.map((s) => s.env).join("→")}:${r.steps.map((x) => x.aheadBy ?? "?").join(",")}`).join(" "));

// --- logs
const tail = await get("/api/logs/tail?env=staging&services=api,worker&limit=2000");
check("logs tail (2 services merged)", tail.status === 200 && tail.json.lines.length > 0 && tail.json.cursor, `${tail.json.lines.length} lines, ${tail.json.streams.length} streams, ${tail.ms}ms`);
check("logs tail is time-ordered", tail.json.lines.every((l, i, a) => i === 0 || a[i - 1][0] <= l[0]));
const next = await get(`/api/logs/tail?env=staging&services=api,worker&cursor=${encodeURIComponent(tail.json.cursor)}`);
check("logs tail follows its cursor", next.status === 200 && next.json.lines.every((l) => l[0] >= tail.json.lines.at(-1)[0]), `${next.json.lines.length} new lines`);
check("logs tail has an older cursor", !!tail.json.older);
let oldest = tail.json.lines[0][0], cur = tail.json.older, pages = 0, gapFree = true;
for (; cur && pages < 3; pages++) {
  const older = await get(`/api/logs/older?env=staging&services=api,worker&cursor=${encodeURIComponent(cur)}&limit=2000`);
  const ls = older.json.lines;
  if (older.status !== 200 || !ls.length || !ls.every((l, i) => l[0] < oldest && (i === 0 || ls[i - 1][0] <= l[0]))) gapFree = false;
  if (ls.length) oldest = ls[0][0];
  cur = older.json.older;
}
check("logs older: 3 pages, each strictly older and time-ordered", gapFree && pages === 3, `back to ${new Date(oldest).toISOString()}`);
check("logs for an unknown service is 400", (await get("/api/logs/tail?env=staging&services=../../etc")).status === 400);
const now = Date.now();
const search = await get(`/api/logs/search?env=staging&services=worker&q=${encodeURIComponent("batch committed")}&mode=text&start=${now - 3600e3}&end=${now}`);
check("logs text search", search.status === 200 && search.json.lines.length > 0 && search.json.lines.every((l) => l[2].includes("batch committed")), `${search.json.lines.length} lines`);
const pat = await get(`/api/logs/search?env=staging&services=worker&q=${encodeURIComponent("?ERROR ?WARN")}&mode=pattern&start=${now - 3600e3}&end=${now}`);
check("logs CloudWatch pattern search", pat.status === 200 && pat.json.lines.length > 0 && pat.json.lines.every((l) => /ERROR|WARN/.test(l[2])), `${pat.json.lines.length} lines`);
const line = tail.json.lines.at(-1);
const ctx = await get(`/api/logs/context?env=staging&service=api&stream=${encodeURIComponent(tail.json.streams.find((s) => s.startsWith("ecs/api/")))}&ts=${line[0]}`);
check("logs context", ctx.status === 200 && ctx.json.lines.length > 0 && Number.isInteger(ctx.json.anchor), `${ctx.json.lines.length} lines around`);
const ins = await post("/api/logs/insights", { env: "staging", services: ["api"], query: "stats count(*) as n by bin(5m)", start: now - 3600e3, end: now });
check("insights start", ins.status === 200 && ins.json.id, ins.json.id);
let res;
for (let i = 0; i < 20; i++) {
  res = await get(`/api/logs/insights/${ins.json.id}`);
  if (!["Scheduled", "Running"].includes(res.json.status)) break;
  await new Promise((r) => setTimeout(r, 500));
}
check("insights results", res.json.status === "Complete" && res.json.rows.length > 0, `${res.json.rows.length} rows`);
check("insights refuses > 7 days", (await post("/api/logs/insights", { env: "staging", services: ["api"], query: "fields @message", start: now - 8 * 86400e3, end: now })).status === 400);

// --- revisions, events, actions
const revs = (await get("/api/services/production/api/revisions")).json;
check("revisions", revs.length > 1 && revs.filter((r) => r.live).length === 1, `${revs.length} revisions`);
check("events", (await get("/api/services/staging/api/events")).status === 200);
const A = (env, s, b) => post(`/api/services/${env}/${s}/actions`, b);
check("action: unknown field refused", (await A("staging", "api", { action: "restart", confirm: "yes", desiredCount: 5 })).status === 400);
check("action: wrong confirm refused", (await A("staging", "api", { action: "restart", confirm: "no" })).status === 400);
check("action: production restart needs the service name", (await A("production", "api", { action: "restart", confirm: "yes", reason: "smoke" })).status === 400);
check("action: production restart needs a reason", (await A("production", "api", { action: "restart", confirm: "api" })).status === 400);
check("action: console never acts on itself", (await A("production", "deployment-console", { action: "restart", confirm: "deployment-console", reason: "smoke" })).status === 403);
const expired = revs.find((r) => !r.imagePresent);
if (expired) check("action: expired image cannot be selected", (await A("production", "api", { action: "switch", revisionArn: expired.arn, confirm: expired.sha?.slice(0, 7), reason: "smoke" })).status >= 400);
const mig = revs.find((r) => !r.live && r.imagePresent && r.migrations);
if (mig) check("action: migration rollback needs acknowledgement", (await A("production", "api", { action: "switch", revisionArn: mig.arn, confirm: mig.sha?.slice(0, 7), reason: "smoke" })).status === 400);
const restartable = ov.staging.services.find((s) => s.state === "UP" && s.id !== "deployment-console" && s.actions?.some((x) => x.name === "restart" && x.enabled));
if (restartable) {
  const r = await A("staging", restartable.id, { action: "restart", confirm: "yes" });
  check(`action: staging restart ${restartable.id} accepted`, r.status === 202 && r.json.operationId && r.json.verification === "accepted", JSON.stringify(r.json));
  check("action: second restart while rolling out is refused", (await A("staging", restartable.id, { action: "restart", confirm: "yes" })).status === 409);
  // "AWS accepted" is not done: the sampler marks the operation verified once the service is steady again (~1 min).
  let verification;
  for (const until = Date.now() + 150_000; Date.now() < until; await new Promise((res) => setTimeout(res, 3000))) {
    const op = (await get("/api/overview?env=staging")).json.services?.find((s) => s.id === restartable.id)?.operations?.find((o) => o.id === r.json.operationId);
    verification = op?.verification;
    if (verification === "verified" || verification === "failed") break;
  }
  check("action: the staging restart is verified by the sampler", verification === "verified", String(verification));
}
const hostId = ov.staging.infra.find((x) => x.kind === "box")?.id;
check("power: wrong confirm refused", (await post("/api/infra/box", { env: "staging", kind: "host", id: hostId, action: "stop", confirm: "nope" })).status === 400);
check("power: disabled on a protected env", (await post("/api/infra/box", { env: "production", kind: "database", id: "acme-production-pg", action: "stop", confirm: "yes" })).status === 403);
check("power: database outside the env is 404", (await post("/api/infra/box", { env: "staging", kind: "database", id: "acme-production-pg", action: "stop", confirm: "yes" })).status === 404);

// Mutating checks need a service at rest: a rollout from an earlier run (or someone else) makes guards answer 409.
async function atRest(env, id, ms = 120_000) {
  for (const until = Date.now() + ms; Date.now() < until; await new Promise((r) => setTimeout(r, 2000))) {
    const s = (await get(`/api/overview?env=${env}`)).json.services?.find((x) => x.id === id);
    if (s && s.state !== "DEPLOYING") return true;
  }
  return false;
}

// --- environment variables
await atRest("staging", "worker");
const VURL = (env, svc) => `/api/services/${env}/${svc}/variables`;
const vl = await get(VURL("staging", "worker"));
check("variables: list has names + sources, no values", vl.status === 200 && vl.json.vars.length > 0 && !JSON.stringify(vl.json).includes("pg-worker-staging-pass"), `${vl.json.vars?.length} vars, sources ${[...new Set(vl.json.vars?.map((v) => v.source))].join("/")}`);
const vr = await post(`${VURL("staging", "worker")}/reveal`, {});
check("variables: reveal returns values (audited)", vr.status === 200 && vr.json.values.some((v) => v.name === "DATABASE_URL" && v.value?.startsWith("postgres://")));
const vput = (env, svc, b) => call("PUT", VURL(env, svc), b);
check("variables: stale revision refused", (await vput("staging", "worker", { revision: "arn:stale", confirm: "yes", changes: { plain: [{ container: "worker", set: { X: "1" } }] } })).status === 409);
check("variables: invalid name refused", (await vput("staging", "worker", { revision: vl.json.revision, confirm: "yes", changes: { plain: [{ container: "worker", set: { "1BAD": "x" } }] } })).status === 400);
const pv = await get(VURL("production", "worker"));
check("variables: protected env needs a reason", (await vput("production", "worker", { revision: pv.json.revision, confirm: "worker", changes: { plain: [{ container: "worker", set: { SMOKE: "1" } }] } })).status === 400);
check("variables: the console never edits itself", (await vput("production", "deployment-console", { revision: (await get(VURL("production", "deployment-console"))).json.revision, confirm: "deployment-console", reason: "smoke", changes: { plain: [{ container: "deployment-console", set: { X: "1" } }] } })).status === 409);
check("variables: the console never reveals its own variables", (await post(`${VURL("production", "deployment-console")}/reveal`, {})).status === 403);
const sv = await vput("staging", "worker", { revision: vl.json.revision, confirm: "yes", changes: { plain: [{ container: "worker", set: { SMOKE_FLAG: "on" } }] } });
check("variables: plain change registers a new revision and deploys", sv.status === 202 && /:\d+$/.test(sv.json.revision ?? "") && sv.json.revision !== vl.json.revision, sv.json.revision?.split("/").pop());
check("variables: a second change during the rollout is refused", (await vput("staging", "worker", { revision: sv.json.revision, confirm: "yes", changes: { plain: [{ container: "worker", set: { Y: "1" } }] } })).status === 409);

// --- CI
const repo = "acme/jobs";
const runs = await get(`/api/ci/runs?repo=${encodeURIComponent(repo)}`);
check("ci runs", runs.status === 200 && runs.json.length > 0, `${runs.json.length} runs`);
check("ci: unknown repo refused", (await get("/api/ci/runs?repo=someone/else")).status === 400);
const done = runs.json.find((r) => r.status === "completed");
const det = await get(`/api/ci/runs/${done.id}?repo=${encodeURIComponent(repo)}`);
check("ci run detail", det.status === 200 && det.json.jobs.length > 0 && det.json.jobs[0].steps.length > 0, `${det.json.jobs.length} jobs, tests ${det.json.tests ? `${det.json.tests.total} (${det.json.tests.failed} failed)` : "none"}`);
const log = await get(`/api/ci/jobs/${det.json.jobs[0].id}/log?repo=${encodeURIComponent(repo)}`);
check("ci job log", log.status === 200 && (log.json.text ?? log.json.lines ?? "").length > 0);
check("ci rerun: wrong confirm refused", (await post(`/api/ci/runs/${done.id}/rerun?repo=${encodeURIComponent(repo)}`, { confirm: "nah" })).status === 400);
const prodDeploy = runs.json.find((r) => r.status === "completed" && r.workflow === "deploy" && r.branch === "main");
if (prodDeploy) check("ci rerun: main-branch deploy needs 'production' + reason", (await post(`/api/ci/runs/${prodDeploy.id}/rerun?repo=${encodeURIComponent(repo)}`, { confirm: "production" })).status === 400);

// --- audit: the accepted restart was recorded (intent + result)
const audit = await get("/api/audit?limit=50");
check("audit", audit.status === 200 && (!restartable || audit.json.some((e) => e.target?.includes(restartable.id) && e.phase === "intent")), `${audit.json.length} entries`);

// --- costs (operator+): Cost Explorer snapshot (simulated) + list-price estimate
const costs = await get("/api/costs");
check("costs: spend + estimate", costs.status === 200 && costs.json.actual?.status === "ok" && costs.json.estimate?.envs?.length >= 2, `MTD ${costs.json.actual?.monthToDate?.toFixed?.(0) ?? "?"}, ${costs.json.actual?.anomalies?.length ?? 0} anomalies`);
await post("/api/costs/refresh", {});
check("costs: refresh is rate-limited", (await post("/api/costs/refresh", {})).status === 429);

// --- create & scale: dry runs, refusals, then a full create → delete round trip on staging (0 tasks)
await atRest("staging", "api");
const P = (action, b) => post(`/api/provision/${action}`, b);
const cloneBody = { env: "staging", sourceEnv: "staging", source: "api", name: "smoke-copy", desired: 0 };
const plan = await P("clone", { ...cloneBody, dryRun: true });
check("provision: clone dry run returns a plan", plan.status === 200 && plan.json.summary && plan.json.confirm?.expected, plan.json.summary);
check("provision: nothing created by a dry run", !(await get("/api/overview?env=staging")).json.services.some((x) => x.id === "smoke-copy"));
check("provision: never copies out of a protected env", [400, 403, 409].includes((await P("clone", { ...cloneBody, sourceEnv: "production", dryRun: true })).status));
check("provision: never deletes what it didn't create", [403, 409].includes((await P("delete-service", { env: "staging", service: "api", confirm: "api", reason: "smoke" })).status));
check("provision: scale above the cap refused", (await P("scale", { env: "staging", service: "api", desired: 999, dryRun: true })).status === 400);
const made = await P("clone", { ...cloneBody, confirm: plan.json.confirm?.expected, reason: "smoke" });
check("provision: clone creates the service", made.status === 202 && typeof made.json.operationId === "string", made.json.error ?? "");
check("provision: the copy shows in the overview", (await get("/api/overview?env=staging")).json.services.some((x) => x.id === "smoke-copy"));
const del = await P("delete-service", { env: "staging", service: "smoke-copy", confirm: "smoke-copy", reason: "smoke cleanup" });
check("provision: console-created service can be deleted", del.status === 202, del.json.error ?? "");

// --- agents & API: operations, tokens, approvals, MCP
const opsList = await get("/api/ops");
check("ops: catalog", opsList.status === 200 && opsList.json.operations.length >= 30, `${opsList.json.operations?.length} operations`);
check("ops: tool definitions for Anthropic", (await get("/api/ops?format=anthropic")).json.tools?.every((t) => t.name && t.input_schema));
const st = await post("/api/ops/envs.status", { input: { env: "staging" } });
check("ops: envs.status for a person", st.status === 200 && st.json.result, "");
check("ops: invalid input lists problems", (await post("/api/ops/envs.status", { input: {} })).json.problems?.length > 0);
const tok = await post("/api/tokens", { name: "smoke", mode: "propose", role: "operator", expiresInDays: 7 });
check("tokens: create (shown once)", tok.status === 201 && tok.json.token?.startsWith("dc_"));
const B = { "content-type": "application/json", authorization: `Bearer ${tok.json.token}` };
const bearer = (method, path, body) => call(method, path, body, B).then((r) => r);
const bget = (path) => fetch(BASE + path, { headers: { authorization: B.authorization } }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));
check("tokens: bearer reaches the operations API", (await bget("/api/ops")).status === 200);
check("tokens: bearer can't reach other routes", (await bget("/api/overview?env=staging")).status === 403 && (await bget("/api/tokens")).status === 403);
if (restartable) {
  const ask = await bearer("POST", "/api/ops/services.restart", { input: { env: "staging", service: restartable.id, confirm: "yes" } });
  check("tokens: propose mode turns a change into an approval", ask.status === 202 && ask.json.approval?.status === "pending");
  check("tokens: a token can't decide approvals", (await bearer("POST", `/api/approvals/${ask.json.approval?.id}`, { decision: "approve" })).status === 403);
  const rej = await post(`/api/approvals/${ask.json.approval?.id}`, { decision: "reject", reason: "smoke" });
  check("approvals: a person rejects", rej.status === 200 && rej.json.approval?.status === "rejected", rej.json.error ?? "");
}
const init = await bearer("POST", "/api/mcp", { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "0" } } });
check("mcp: initialize", init.status === 200 && init.json.result?.capabilities?.tools !== undefined, init.json.result?.protocolVersion);
const tl = await bearer("POST", "/api/mcp", { jsonrpc: "2.0", id: 2, method: "tools/list" });
check("mcp: tools/list", tl.json.result?.tools?.length > 10, `${tl.json.result?.tools?.length} tools`);
const big = Array.from({ length: 21 }, (_, i) => ({ jsonrpc: "2.0", id: i, method: "ping" }));
check("mcp: batches over 20 messages are refused", (await bearer("POST", "/api/mcp", big)).status === 400);
const cmd = await bearer("POST", "/api/ops/tasks.run", { input: { env: "staging", service: "worker", command: ["echo", "hi"], confirm: "yes" } });
check("tokens: a one-off task with a command always waits for a person", cmd.status === 202 && cmd.json.approval?.risk === "danger", cmd.json.error ?? "");
if (cmd.json.approval?.id) await post(`/api/approvals/${cmd.json.approval.id}`, { decision: "reject", reason: "smoke" });
if (restartable) {
  await atRest("staging", restartable.id);
  const ask2 = await bearer("POST", "/api/ops/services.restart", { input: { env: "staging", service: restartable.id, confirm: "yes" } });
  const ok2 = await post(`/api/approvals/${ask2.json.approval?.id}`, { decision: "approve", confirm: "not-the-text" });
  check("approvals: a stray confirmation on a one-click request doesn't use it up", ok2.status === 200 && ok2.json.approval?.status === "done", ok2.json.error ?? ok2.json.approval?.status);
}
check("tokens: revoke", (await call("DELETE", `/api/tokens/${tok.json.item?.id}`)).status === 200);
check("tokens: revoked token is refused", (await bget("/api/ops")).status === 401);

// --- hardening regressions
check("unknown API routes answer JSON 404", await fetch(BASE + "/api/nope").then(async (r) => r.status === 404 && (await r.json()).error));
check("audit limit is clamped, not a 502", (await get("/api/audit?limit=1.5")).status === 200 && (await get("/api/audit?limit=-5")).json.length <= 200);
check("responses carry a Content-Security-Policy", (await fetch(BASE + "/login")).headers.get("content-security-policy")?.includes("frame-ancestors 'none'"));
check("integrations never reach cloud metadata", /link-local/.test((await post("/api/integrations/webhook/test", { config: { url: "http://169.254.169.254/latest/meta-data/", secret: "smoke" } })).json.error ?? ""));
check("ci rerun: failedOnly must be a boolean", (await post(`/api/ci/runs/${done.id}/rerun?repo=${encodeURIComponent(repo)}`, { failedOnly: "false", confirm: "yes" })).status === 400);
const vfile = (await get(VURL("staging", "api"))).json;
const fileRef = vfile.files?.[0];
if (fileRef) check("variables: a line break in an env-file value is refused", (await vput("staging", "api", { revision: vfile.revision, confirm: "yes", changes: { files: [{ container: fileRef.container, file: fileRef.file, set: { SMOKE_X: "a\nECS_EVIL=1" } }] } })).status === 400);
check("variables: two entries for one container are refused", (await vput("staging", "api", { revision: vfile.revision, confirm: "yes", changes: { plain: [{ container: "api", set: { A: "1" } }, { container: "api", set: { B: "2" } }] } })).status === 400);
check("provision: any dryRun value but false plans instead of running", (await P("clone", { ...cloneBody, name: "smoke-dry", dryRun: "yes", confirm: "yes" })).status === 200 && !(await get("/api/overview?env=staging")).json.services.some((x) => x.id === "smoke-dry"));

// --- feature suites: each scripts/smoke.d/<area>.mjs exports `default async ({ get, post, call, check, BASE, atRest })`
import { readdir } from "node:fs/promises";
for (const f of (await readdir(new URL("./smoke.d/", import.meta.url)).catch(() => [])).filter((x) => x.endsWith(".mjs")).sort()) {
  const suite = (await import(new URL(`./smoke.d/${f}`, import.meta.url).href)).default;
  await suite({ get, post, call, check, BASE, atRest });
}

// --- pages render
// /map?view=table answers 200 too: it redirects to /resources in the browser, after hydration.
for (const p of ["/", "/metrics", "/logs", "/ci", "/activity", "/releases", "/costs", "/audit", "/automation", "/assistant", "/resources", "/map?view=table", "/settings", "/settings/interface", "/settings/account", "/settings/environments", "/settings/permissions", "/settings/users", "/settings/integrations"]) {
  const r = await fetch(BASE + p);
  check(`page ${p}`, r.status === 200);
}

console.log(failed ? `\n${failed} check(s) FAILED` : "\nall checks passed");
process.exit(failed ? 1 : 0);
