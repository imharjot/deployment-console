// Wave C batch 2: an agent run end to end through the REST contract, with the built-in scripted:demo model on the
// simulated account — the assistant starts a run, the run reads (tool steps, evidence E1…), proposes a change that
// becomes an exact-plan approval request, nothing runs until a person grants it, the emergency stop holds even an
// approved change (and refuses a new run's proposal), and once lifted the run makes the change as the agent and
// verifies it. Only touches a staging service that is UP (a restart comes back by itself).
export default async function agentRunsSmoke({ get, post, check, atRest }) {
  const settings = (await get("/api/agents/settings")).json;
  if (settings?.enabled?.on !== true || settings?.worker?.started !== true) {
    check("agent runs: skipped — agents are off or the worker isn't running", true, JSON.stringify(settings?.enabled ?? null));
    return;
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const runOf = async (id) => (await get(`/api/agents/runs/${id}`)).json?.run;
  const until = async (id, ok, ms) => {
    const end = Date.now() + ms;
    let r = await runOf(id);
    while (!ok(r) && Date.now() < end) {
      await sleep(2_000);
      r = await runOf(id);
    }
    return r;
  };
  const FINAL = ["succeeded", "failed", "cancelled"];

  // Server-side guards on the assistant: a pasted secret is never stored as a run's goal; no question, no run.
  const secret = await post("/api/assistant", { question: "why does AKIAIOSFODNN7EXAMPLE fail?" });
  check("assistant: a question that looks like a secret is refused server-side", secret.status === 400 && secret.json?.code === "secret_in_question", `${secret.status} ${secret.json?.code ?? ""}`);
  check("assistant: an empty request is refused", (await post("/api/assistant", {})).status === 400);
  check("agent runs: identity, mode and policy can't come from the body", (await post("/api/agents/runs", { kind: "assistant", connectionId: "scripted:demo", mode: "act" })).status === 400);

  // A staging service that is UP, by its cloud-map key.
  const ov = (await get("/api/overview?env=staging")).json;
  const inv = (await get("/api/inventory")).json;
  const keyOf = (id) => inv?.resources?.find((r) => r.kind === "ecs-service" && r.env === "staging" && r.name === id)?.key;
  const svc = ov?.services?.find((s) => s.state === "UP" && s.id !== "deployment-console" && keyOf(s.id) && s.actions?.some((x) => x.name === "restart" && x.enabled));
  check("agent runs: a running staging service to work on", !!svc);
  if (!svc) return;
  await atRest("staging", svc.id);
  const resourceKey = keyOf(svc.id);

  // 1. The assistant starts a run: reads become tool steps and evidence; the change it wants becomes a proposal.
  const start = await post("/api/assistant", { question: `Restart ${svc.id} in staging, please`, resourceKey });
  check("agent run: POST /api/assistant starts a run (scripted:demo on the simulated account)", start.status === 201 && /^[0-9a-f-]{36}$/.test(start.json?.runId ?? ""), JSON.stringify(start.json));
  const id = start.json?.runId;
  if (!id) return;
  // waiting_approval comes as soon as the request exists; the model's final turn (the answer) may still be running.
  let run = await until(id, (r) => (r?.state === "waiting_approval" && r?.outcome?.ai !== "pending") || FINAL.includes(r?.state), 60_000);
  check("agent run: reaches waiting_approval", run?.state === "waiting_approval", run?.state);
  check("agent run: acts for you, paid by the demo connection, scoped to the resource", run?.kind === "assistant" && run?.connection?.id === "scripted:demo" && run?.mode === "propose" && run?.resourceKey === resourceKey, JSON.stringify({ kind: run?.kind, connection: run?.connection, mode: run?.mode, resourceKey: run?.resourceKey }));
  const tools = (run?.steps ?? []).filter((s) => s.kind === "tool" && s.state === "succeeded");
  check("agent run: the model's reads ran as tool steps, each one cited evidence", tools.length >= 3 && (run?.evidence ?? []).length >= 3 && run.evidence.every((e) => /^E\d+$/.test(e.id)), `${tools.length} tool steps, ${(run?.evidence ?? []).length} evidence`);
  const p = run?.proposals?.[0];
  check("agent run: the proposed change is an exact-plan approval request", p?.op === "services.restart" && p?.state === "pending" && /^sha256:[0-9a-f]{64}$/.test(p?.planHash ?? "") && !!p?.approvalId && p?.expiresAt > Date.now() && p?.evidence?.ids?.length > 0, JSON.stringify(p ?? null).slice(0, 300));
  check("agent run: nothing ran without a person's grant (no operation, AWS outcome none)", (run?.operations ?? []).length === 0 && run?.outcome?.aws === "none", JSON.stringify(run?.outcome ?? null));
  check("agent run: the answer cites its evidence", /\[E\d+\]/.test(run?.answer?.text ?? ""));
  const evid = run?.evidence?.[0]?.id;
  if (evid) check("agent run: ?evidence= returns one piece of evidence with its data", (await get(`/api/agents/runs/${id}?evidence=${evid}`)).json?.evidence?.id === evid);
  const list = (await get("/api/agents/runs?kind=assistant")).json?.runs ?? [];
  check("agent runs: listed under your assistant runs", list.some((r) => r.id === id));
  if (!p?.approvalId) return;
  const appr = (await get(`/api/approvals/${p.approvalId}`)).json?.approval;
  check("approval: the request names the agent's run and its grant, and you may decide it", appr?.run?.id === id && appr?.run?.grantId === p.grantId && appr?.canDecide === true && appr?.status === "pending");
  check("approval: an unknown decision is refused", (await post(`/api/approvals/${p.approvalId}`, { decision: "maybe", reason: "smoke" })).status === 400);
  // A plan that names its target (production) needs it typed; a one-click ("yes") staging plan doesn't.
  if (appr?.confirm && appr.confirm !== "yes") check("approval: approving needs the typed confirmation", (await post(`/api/approvals/${p.approvalId}`, { decision: "approve", reason: "smoke", confirm: "nope" })).status === 400);
  await sleep(2_000);
  run = await runOf(id);
  check("agent run: still nothing executed while the request waits", (run?.operations ?? []).length === 0 && !run?.steps?.some((s) => s.kind === "execute") && run?.state === "waiting_approval");

  // 2. The emergency stop holds an approved change and refuses a new run's proposal; reads go on.
  check("emergency stop: on", (await post("/api/agents/emergency-stop", { on: true, reason: "smoke: agent runs" })).json?.on === true);
  try {
    const ok = await post(`/api/approvals/${p.approvalId}`, { decision: "approve", reason: "smoke", confirm: appr?.confirm ?? "yes" });
    check("approval: a person approves the exact plan", ok.status === 200 && ok.json?.approval?.status === "approved", ok.json?.error ?? "");
    run = await until(id, (r) => r?.steps?.some((s) => s.kind === "execute" && s.state === "waiting"), 15_000);
    await sleep(3_000);
    run = await runOf(id);
    const ex = run?.steps?.find((s) => s.kind === "execute");
    check("emergency stop: the approved change waits and nothing reaches AWS", ex?.state === "waiting" && ex?.error === "emergency stop" && (run?.operations ?? []).length === 0, JSON.stringify({ ex: ex && { state: ex.state, error: ex.error }, ops: run?.operations?.length }));
    const other = ov.services.find((s) => s.state === "UP" && s.id !== svc.id && s.id !== "deployment-console" && keyOf(s.id));
    if (other) {
      const st = await post("/api/assistant", { question: `Restart ${other.id} in staging, please`, resourceKey: keyOf(other.id) });
      const r2 = st.json?.runId ? await until(st.json.runId, (r) => FINAL.includes(r?.state) || r?.state === "waiting_approval", 60_000) : undefined;
      const prop = r2?.steps?.find((s) => s.kind === "propose");
      check(
        "emergency stop: a new run still reads, but its change is refused — no request, no operation",
        st.status === 201 && r2?.state === "succeeded" && (r2?.evidence ?? []).length > 0 && /emergency stop/.test(prop?.summary ?? "") && (r2?.proposals ?? []).length === 0 && (r2?.operations ?? []).length === 0 && r2?.outcome?.aws === "none",
        JSON.stringify({ state: r2?.state, propose: prop?.summary, proposals: r2?.proposals?.length, ops: r2?.operations?.length }),
      );
    }
  } finally {
    check("emergency stop: off", (await post("/api/agents/emergency-stop", { on: false, reason: "smoke: agent runs done" })).json?.on === false);
  }

  // 3. Lifted: the run makes the change as the agent, and reports AWS acceptance and verified health separately.
  run = await until(id, (r) => (r?.operations ?? []).length > 0 || FINAL.includes(r?.state), 30_000);
  const op = run?.operations?.[0];
  check("agent run: after the stop lifts, the approved change runs once (AWS accepted)", run?.operations?.length === 1 && op?.action === "services.restart" && run?.proposals?.[0]?.state === "consumed", JSON.stringify({ ops: run?.operations, grant: run?.proposals?.[0]?.state }));
  run = await until(id, (r) => FINAL.includes(r?.state), 150_000);
  check(
    "agent run: verified — AI completed, AWS accepted, healthy, each reported apart",
    run?.state === "succeeded" && run?.outcome?.ai === "completed" && run?.outcome?.aws === "accepted" && run?.outcome?.health === "verified" && run?.operations?.[0]?.verify === "verified",
    JSON.stringify({ state: run?.state, outcome: run?.outcome && { ai: run.outcome.ai, aws: run.outcome.aws, health: run.outcome.health }, verify: run?.operations?.[0]?.verify }),
  );
  check("agent run: the change ran as the agent, not as the approver", (run?.steps ?? []).some((s) => s.kind === "execute" && s.state === "succeeded" && s.grantId === p.grantId));
  const m = (await get("/api/agents/metrics")).json;
  check("agent metrics: release metrics count the run's verified change", typeof m?.runs === "number" && m.runs >= 1 && m.verifiedChanges >= 1 && typeof m.verifiedCompletion === "number" && m.duplicateEffects === 0, JSON.stringify(m ?? null).slice(0, 200));
  await atRest("staging", svc.id);
}
