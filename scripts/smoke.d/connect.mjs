// Connect A → B (the ecs-connect provider's cloud-map actions): a round trip on staging — its services share one EC2
// host with host networking, so they reach each other over loopback and only a variable changes — the edge on the map
// right after, then disconnect; in production only plans and refusals. Nothing in production is ever run.
export default async function connectSmoke({ get, post, check, atRest }) {
  const A = "ecs:service/acme-staging/billing";
  const B = "ecs:service/acme-staging/worker";
  const act = (action, input, extra = {}) => post("/api/inventory/action", { key: A, provider: "ecs-connect", action, input, ...extra });
  const listed = (await get(`/api/inventory/actions?key=${encodeURIComponent(A)}`)).json?.actions ?? [];
  const info = listed.find((a) => a.provider === "ecs-connect" && a.id === "connect");
  check("connect: offered on ECS services as a dangerous action", info?.risk === "danger" && listed.some((a) => a.provider === "ecs-connect" && a.id === "disconnect"), info?.title);

  await atRest("staging", "billing");
  const plan = await act("connect", { to: B }, { dryRun: true });
  const changes = plan.json.plan?.changes ?? [];
  check(
    "connect: one host with host networking — loopback, no rule, a variable",
    plan.status === 200 && changes[0] === "Same EC2 host: billing reaches worker on 127.0.0.1 — no security group change" && changes.some((c) => c.startsWith("Set WORKER_URL=http://127.0.0.1:8080 on billing")),
    plan.json.error ?? changes.join(" | "),
  );
  check("connect: the name and a reason to confirm, always", plan.json.plan?.confirm === "billing");
  check("connect: a run without a reason is refused", (await act("connect", { to: B }, { confirm: "billing" })).status === 400);
  const run = await act("connect", { to: B }, { confirm: "billing", reason: "smoke: connect billing to worker" });
  check("connect: runs", run.status === 202 && run.json.result?.variable === "WORKER_URL", run.json.error ?? JSON.stringify(run.json.result));
  const inv = (await get("/api/inventory")).json ?? {};
  check("connect: the map draws the connection right after", (inv.edges ?? []).some((e) => e.from === A && e.to === B), `${(inv.edges ?? []).filter((e) => e.from === A).map((e) => e.to).join(", ")}`);

  await atRest("staging", "billing");
  const dplan = await act("disconnect", { to: B }, { dryRun: true });
  check("disconnect: plans removing the variable", dplan.status === 200 && (dplan.json.plan?.changes ?? []).some((c) => c.startsWith("Remove WORKER_URL from billing")), dplan.json.error ?? "");
  const dis = await act("disconnect", { to: B }, { confirm: "billing", reason: "smoke: undo the connection" });
  check("disconnect: runs", dis.status === 202 && dis.json.result?.variableRemoved === "WORKER_URL", dis.json.error ?? "");
  await atRest("staging", "billing");
  check("disconnect: then there is nothing left to undo", (await act("disconnect", { to: B }, { dryRun: true })).status === 409);

  // Production: plans and refusals only.
  const P = (to, extra = {}) => post("/api/inventory/action", { key: "ecs:service/acme-production/api", provider: "ecs-connect", action: "connect", input: { to }, ...extra });
  const sc = await P("ecs:service/acme-production/worker", { dryRun: true });
  const scText = [...(sc.json.plan?.changes ?? []), ...(sc.json.plan?.warnings ?? [])].join(" | ");
  check(
    "connect: service to service plans Service Connect, the namespace and the variable",
    sc.status === 200 && /Turn on Service Connect for worker/.test(scText) && /Create Cloud Map namespace acme-production/.test(scText) && /WORKER_URL=http:\/\/worker:8080/.test(scText),
    sc.json.error ?? scText,
  );
  const closed = await post("/api/inventory/action", { key: "ecs:service/acme-production/worker", provider: "ecs-connect", action: "connect", input: { to: "ecs:service/acme-production/billing" }, dryRun: true });
  check("connect: a group nobody opened is named in the plan", closed.status === 200 && (closed.json.plan?.warnings ?? []).some((w) => /tag sg-prod-billing first, or AWS refuses this rule/.test(w)), closed.json.error ?? (closed.json.plan?.warnings ?? []).join(" | "));
  check("connect: production without a reason is refused", (await P("ecs:service/acme-production/worker", { confirm: "api" })).status === 400);
  check("connect: across environments is refused", (await P("ecs:service/acme-staging/worker", { dryRun: true })).status === 400);
  check("connect: to itself is refused", (await P("ecs:service/acme-production/api", { dryRun: true })).status === 400);
  check("connect: to the console itself is refused", (await P("ecs:service/acme-production/deployment-console", { dryRun: true })).status === 409);
}
