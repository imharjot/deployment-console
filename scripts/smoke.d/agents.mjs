// Wave C batch 1: the agent platform's foundations on the simulated account — the agents switch and emergency stop,
// external agent tokens (da_) bound to a template's policy, the policy engine in front of the registry, agent approvals
// (decided by a person, never run as the approver), MCP for agents, the persisted event stream with its replay cursor,
// and the model connections (the built-in scripted:demo connection; the ChatGPT plan stays off). Everything it creates
// it revokes or rejects; nothing is changed in the simulated account.
export default async function agentsSmoke({ get, post, call, check, BASE }) {
  const H = { "content-type": "application/json", "x-console-csrf": "1", origin: BASE };

  // The switch and the stop: on with the simulated account, stop off.
  const s = await get("/api/agents/settings");
  check("agents: on with the simulated account, emergency stop off", s.status === 200 && s.json?.enabled?.on === true && s.json?.stop?.on === false, JSON.stringify(s.json?.enabled ?? s.json));
  check("agents: anyone signed in can read the emergency stop", (await get("/api/agents/emergency-stop")).json?.on === false);
  check("agents: turning the stop on needs a reason", (await post("/api/agents/emergency-stop", { on: true })).status === 400);
  // The worker, boot reconciliation and the event bridge load from instrumentation.ts: the worker starts only after
  // both reconciliations, and its state (on globalThis) is what this route reports.
  check("agents: the step worker was started at boot (after reconciliation)", s.json?.worker?.started === true && s.json?.worker?.draining === false, JSON.stringify(s.json?.worker ?? null));

  // Model connections (C5): the built-in demo connection, its models; the ChatGPT plan is off.
  const conns = await get("/api/agents/connections");
  check("connections: the built-in scripted:demo connection is listed, without a secret", conns.status === 200 && conns.json?.connections?.some((c) => c.id === "scripted:demo" && c.hasSecret === false) && conns.json.connections.every((c) => !("secret" in c) && !("credential" in c)));
  check("connections: the demo connection's models", (await get("/api/agents/models?connection=scripted:demo")).status === 200);
  check("connections: the ChatGPT plan sign-in is off unless the flag is set", (await get("/api/agents/oauth/chatgpt")).status === 404);

  // An external agent token, bound to the incident-investigator template (propose mode).
  check("agent tokens: unknown definitions and lifetimes are refused", (await post("/api/agents/tokens", { name: "smoke", definitionId: "nope", days: 7 })).status === 404 && (await post("/api/agents/tokens", { name: "smoke", definitionId: "incident-investigator", days: 3 })).status === 400);
  const t = await post("/api/agents/tokens", { name: "smoke agent", definitionId: "incident-investigator", days: 7 });
  check("agent tokens: create (shown once) with its run and the MCP URL", t.status === 201 && /^da_[A-Za-z0-9_-]{43}$/.test(t.json?.token ?? "") && !!t.json?.runId && /\/api\/mcp$/.test(t.json?.mcpUrl ?? ""), t.json?.error ?? "");
  check("agent tokens: listed without the token", (await get("/api/agents/tokens")).json?.tokens?.some((x) => x.id === t.json?.id && !("token" in x) && x.status === "active"));
  const B = { "content-type": "application/json", authorization: `Bearer ${t.json?.token}` };
  const bearer = (method, path, body) => call(method, path, body, B);
  const bget = (path) => fetch(BASE + path, { headers: { authorization: B.authorization } }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));

  const me = await bget("/api/me");
  check("agent tokens: /api/me names the principal, not a secret", me.status === 200 && me.json?.via === "agent" && me.json?.principal?.mode === "propose" && me.json?.principal?.runId === t.json?.runId && !JSON.stringify(me.json).includes(t.json?.token ?? "~"));
  check("agent tokens: only the operations API", (await bget("/api/overview?env=staging")).status === 403 && (await bget("/api/agents/tokens")).status === 403 && (await bget("/api/agents/connections")).status === 403);
  const catalog = await bget("/api/ops");
  const allowed = new Set((catalog.json?.operations ?? []).filter((o) => o.allowed).map((o) => o.name));
  check("agent tokens: the catalog follows the policy (reads and proposals, never variables or deletions)", catalog.status === 200 && allowed.has("envs.status") && allowed.has("services.restart") && !allowed.has("variables.update") && !allowed.has("services.delete"), `${allowed.size} allowed`);
  check("agent tokens: a read inside the scope runs", (await bearer("POST", "/api/ops/envs.status", { input: { env: "staging" } })).status === 200);
  check("agent tokens: a hard-denied operation is refused with the reason", /never change environment variables/.test((await bearer("POST", "/api/ops/variables.update", { input: {} })).json?.error ?? ""));
  check("agent tokens: an agent can't acknowledge migrations itself", (await bearer("POST", "/api/ops/services.switch", { input: { env: "staging", service: "api", revision: 120, migrationAck: true, confirm: "yes" } })).status === 400);

  // A change becomes an exact-plan approval request on the agent's run; a person decides; it never runs as them.
  const ask = await bearer("POST", "/api/ops/services.restart", { input: { env: "staging", service: "api", confirm: "yes" } });
  check("agents: a proposed change is an approval request on the agent's run", ask.status === 202 && ask.json?.approval?.status === "pending" && ask.json?.approval?.run?.id === t.json?.runId, ask.json?.error ?? "");
  const id = ask.json?.approval?.id;
  if (id) {
    check("agents: the same request again returns the pending one", (await bearer("POST", "/api/ops/services.restart", { input: { env: "staging", service: "api", confirm: "yes" } })).json?.approval?.id === id);
    check("agents: the agent reads its own request", (await bget(`/api/approvals/${id}`)).json?.approval?.id === id);
    check("agents: an agent can't decide", (await bearer("POST", `/api/approvals/${id}`, { decision: "approve" })).status === 403);
    const rej = await post(`/api/approvals/${id}`, { decision: "reject", reason: "smoke" });
    check("agents: a person rejects the agent's request", rej.status === 200 && rej.json?.approval?.status === "rejected", rej.json?.error ?? "");
  }

  // MCP for agents: tools follow the policy; instructions say never to resend.
  const init = await bearer("POST", "/api/mcp", { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "0" } } });
  check("mcp (agent): initialize says changes may become approval requests", init.status === 200 && /never resend/i.test(init.json?.result?.instructions ?? ""));
  const tl = await bearer("POST", "/api/mcp", { jsonrpc: "2.0", id: 2, method: "tools/list" });
  const names = (tl.json?.result?.tools ?? []).map((x) => x.name);
  check("mcp (agent): tools/list follows the policy", names.includes("envs_status") && names.includes("services_restart") && !names.includes("variables_update"), `${names.length} tools`);

  // The emergency stop wins over every policy; the switch turns agents off entirely.
  const mark = Number((await sse("/api/events", undefined, {}, /event: ready/)).match(/"cursor":(\d+)/)?.[1] ?? 0);
  check("agents: emergency stop on (admin)", (await post("/api/agents/emergency-stop", { on: true, reason: "smoke drill" })).json?.on === true);
  const held = await bearer("POST", "/api/ops/services.restart", { input: { env: "staging", service: "worker", confirm: "yes" } });
  check("agents: while stopped, an agent change is refused with 423", held.status === 423, `${held.status} ${held.json?.error ?? ""}`);
  check("agents: reads go on while stopped", (await bearer("POST", "/api/ops/envs.status", { input: { env: "staging" } })).status === 200);
  check("agents: emergency stop off", (await post("/api/agents/emergency-stop", { on: false, reason: "smoke drill over" })).json?.on === false);
  const off = await post("/api/agents/settings", { enabled: false });
  check("agents: an admin turns agents off", off.status === 200 && (off.json?.enabled?.on === false || off.json?.overridden === true));
  if (off.json?.enabled?.on === false) check("agents: while off, agent tokens get 503", (await bget("/api/ops")).status === 503);
  await post("/api/agents/settings", { enabled: true });
  check("agents: back on", (await get("/api/agents/settings")).json?.enabled?.on === true);

  // The persisted event stream: a cursor replays what was missed, each event with its id.
  const text = await sse(`/api/events?after=0&run=${encodeURIComponent(t.json?.runId ?? "")}`);
  check("events: ?after= replays a run's persisted events with ids (its run states and approvals)", /^id: \d+$/m.test(text) && /event: approval/.test(text) && /event: run/.test(text) && /event: replayed/.test(text), `${(text.match(/^id: /gm) ?? []).length} events`);
  // The stop and the switch are audited (intent first, then the result) and go out as people-only action events.
  const audit = (await get("/api/audit?limit=200")).json;
  const rows = Array.isArray(audit) ? audit.filter((e) => e.target === "agents") : [];
  check(
    "agents: the stop and the switch are audited, intent then result",
    ["agents.emergency_stop", "agents.emergency_stop_lifted", "agents.disable", "agents.enable"].every((a) => rows.some((e) => e.action === a && e.phase === "intent") && rows.some((e) => e.action === a && e.result === "ok")),
    rows.map((e) => `${e.action}:${e.phase}`).join(" "),
  );
  const since = await sse(`/api/events?after=${mark}`);
  check("events: the stop and the switch are in the persisted stream for people", ["agents.emergency_stop", "agents.emergency_stop_lifted", "agents.disable", "agents.enable"].every((a) => since.includes(`"action":"${a}"`)), `${(since.match(/^id: /gm) ?? []).length} events since ${mark}`);
  // A brand-new server may not have had the sampler's first transition yet: wait up to about 60 s for a state event.
  let all = await sse("/api/events?after=0");
  for (let i = 0; i < 12 && !/event: state/.test(all); i++) {
    await new Promise((r) => setTimeout(r, 5_000));
    all = await sse("/api/events?after=0");
  }
  check("events: the bridge feeds the sampler's states, actions and operations into the stream", /event: action/.test(all) && /event: operation/.test(all) && /event: state/.test(all), `${(all.match(/^id: /gm) ?? []).length} events`);
  check("events: an agent's replay never shows the stop (only its own run)", !/agents\.emergency_stop/.test(await sse(`/api/events?after=${mark}`, B.authorization)));
  check("events: a cursor this console never issued resets to live", /"reset":true/.test(await sse("/api/events", undefined, { "last-event-id": "999999999999" })));
  check("agents: an agent token can't touch the stop or the switch", (await bearer("POST", "/api/agents/emergency-stop", { on: false, reason: "x" })).status === 403 && (await bearer("POST", "/api/agents/settings", { enabled: true })).status === 403);

  // Revoking stops the agent: the token fails, its run is cancelled.
  check("agent tokens: revoke", (await call("DELETE", `/api/agents/tokens/${t.json?.id}`, undefined, H)).json?.token?.status === "revoked");
  check("agent tokens: a revoked token is refused", (await bget("/api/ops")).status === 401);

  // Reads an SSE response until `until` matches (by default: the replay is done) or 4 s pass, then hangs up.
  async function sse(path, authorization, extra = {}, until = /event: replayed/) {
    const ac = new AbortController();
    const res = await fetch(BASE + path, { signal: ac.signal, headers: { ...(authorization ? { authorization } : {}), ...extra } }).catch(() => null);
    let out = "";
    if (res?.body) {
      const reader = res.body.getReader();
      const deadline = Date.now() + 4_000;
      while (Date.now() < deadline && !until.test(out)) {
        const r = await Promise.race([reader.read(), new Promise((ok) => setTimeout(() => ok({ value: undefined }), 300))]);
        if (r.done) break;
        if (r.value) out += new TextDecoder().decode(r.value);
      }
    }
    ac.abort();
    return out;
  }
}
