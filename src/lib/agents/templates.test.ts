// The six workflow templates (master plan §6 C7 item 2): each one validates against the operations it uses and its
// built-in policy, keeps to its authority (no model where there must be none, no deletion, no variable writes), and
// its report says what a person needs. Resolution on the simulated Acme account is in
// src/lib/server/agents/scheduler.test.ts (it needs the server).
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_POLICIES } from "./policy.ts";
import { TEMPLATES, buildReport, idleConfidence, renderMessage, templateDraft } from "./templates.ts";
import { contextFor, holds, progressOf, validateWorkflow, type OpCatalog } from "./workflows.ts";

const R = (risk: "read" | "change") => ({ risk, perm: "view" as const });
const OPS: Record<string, ReturnType<typeof R>> = {
  "services.get": R("read"), "services.stop": R("change"), "services.start": R("change"), "audit.recent": R("read"), "issues.list": R("read"), "ci.runs": R("read"),
  "costs.summary": R("read"), "costs.estimate": R("read"), "approvals.list": R("read"), "cloud.map": R("read"), "variables.compare": R("read"),
};
const catalog: OpCatalog = (op) => OPS[op];
const NOW = Date.parse("2026-10-05T12:00:00Z");

test("every template validates as drafted (with a connection where a model step needs one)", () => {
  assert.equal(TEMPLATES.length, 6);
  for (const t of TEMPLATES) {
    const d = templateDraft(t.name, { envs: ["staging"], connectionId: t.model === "none" ? undefined : "scripted:demo", tz: "Europe/Berlin" });
    assert.deepEqual(validateWorkflow(d, catalog, NOW), [], t.name);
    assert.equal(d.template, t.name);
    assert.deepEqual(d.policy, DEFAULT_POLICIES[t.name], `${t.name} runs under its built-in policy`);
    assert.equal(d.steps.some((s) => s.kind === "model"), t.model !== "none" && !!d.connectionId, `${t.name} model steps`);
  }
  // Without a connection, the model templates can't be activated (nobody would pay) — the deterministic ones can.
  assert.match(validateWorkflow(templateDraft("incident-investigator"), catalog, NOW).join("\n"), /needs a connection/);
  assert.deepEqual(validateWorkflow(templateDraft("daily-digest"), catalog, NOW), [], "the digest's model summary is optional");
});

test("nonproduction schedule: deterministic stop/start of selected services, remembered counts, verified, bounded-act only", () => {
  const d = templateDraft("nonproduction-schedule", { envs: ["staging"], services: ["api", "worker"], tz: "Europe/Berlin" });
  assert.equal(d.connectionId, "");
  assert.ok(d.steps.every((s) => s.kind !== "model"), "no model");
  assert.equal(d.policy.mode, "bounded-act");
  assert.deepEqual(d.policy.tools.act, ["services.stop", "services.start"]);
  assert.equal(d.policy.limits.modelTurns, 0);
  assert.deepEqual(d.targets, { envs: ["staging"], services: ["api", "worker"] });
  assert.deepEqual(d.triggers.map((t) => (t.type === "schedule" ? `${t.cron} ${t.tz} ${String(t.inputs?.action)}` : t.type)), ["0 19 * * 1-5 Europe/Berlin stop", "0 8 * * 1-5 Europe/Berlin start", "manual"]);
  const ops = d.steps.flatMap((s) => (s.kind === "tool" || s.kind === "verify" ? [`${s.id}:${s.op}${s.forEach ? "*" : ""}`] : []));
  assert.deepEqual(ops, ["before:services.get*", "stop:services.stop*", "start:services.start*", "stopped:services.get*", "started:services.get*"]);
  assert.deepEqual(templateDraft("nonproduction-schedule").targets, { envs: ["staging"] }, "defaults to staging");
});

test("authority of the other templates: proposals wait for a person, reviews only read, drift never writes variables", () => {
  for (const name of ["incident-investigator", "approved-remediation"] as const) {
    const d = templateDraft(name, { connectionId: "scripted:demo", envs: ["staging"] });
    assert.equal(d.policy.mode, "propose", name);
    assert.deepEqual(d.policy.tools.act, [], name);
    assert.deepEqual(d.triggers.map((t) => t.type), ["manual", "event"]);
  }
  const rem = templateDraft("approved-remediation", { connectionId: "scripted:demo" });
  assert.deepEqual([rem.limits.cooldownSeconds, rem.limits.maxAttempts, rem.limits.maxConcurrentRuns], [1_800, 3, 1], "cooldown and attempts come from the limits");
  assert.ok(rem.steps.some((s) => s.kind === "verify" && s.op === "services.get"), "verified healthy");
  const escalate = rem.steps.find((s) => s.kind === "notify" && s.to === "integrations")!;
  const report = rem.steps.find((s) => s.id === "report")!;
  // Exactly one of escalate / report runs: unhealthy (or nothing changed) escalates; without a service to check, the
  // agent run's own verification of its change decides.
  const at = (verify: { state: string; result?: unknown }, remediate: Record<string, unknown>) => {
    const ctx = contextFor({ inputs: {}, trigger: {}, targets: [] }, { remediate: { state: "succeeded", result: remediate }, verify });
    return [holds(escalate.when!, ctx), holds(report.when!, ctx)];
  };
  assert.deepEqual(at({ state: "succeeded", result: { ok: true } }, { changed: true, health: "pending" }), [false, true], "verified healthy");
  assert.deepEqual(at({ state: "succeeded", result: { ok: false, failed: true } }, { changed: true, health: "verified" }), [true, false], "unhealthy now");
  assert.deepEqual(at({ state: "skipped" }, { changed: true, health: "verified" }), [false, true], "no service to check: the agent run verified it");
  assert.deepEqual(at({ state: "skipped" }, { changed: true, health: "unhealthy" }), [true, false]);
  assert.deepEqual(at({ state: "skipped" }, { changed: false, health: "n/a" }), [true, false], "nothing changed: still a problem");
  for (const name of ["daily-digest", "cost-review", "config-drift"] as const) {
    const d = templateDraft(name);
    assert.equal(d.policy.mode, "observe", name);
    assert.ok(d.steps.every((s) => s.kind !== "tool" || OPS[s.op]?.risk === "read"), `${name} only reads`);
  }
  assert.ok(templateDraft("cost-review").policy.tools.deny.includes("cloud.action"), "a cost review can never act on the map");
  const drift = templateDraft("config-drift", { envs: ["staging", "production"] });
  assert.ok(!JSON.stringify(drift.steps).includes("variables.update") && !drift.policy.tools.act.length && !drift.policy.tools.propose.length, "a drift fix is a person's task");
  assert.ok(drift.policy.tools.deny.includes("variables.update"));
  assert.deepEqual(drift.inputs[0].default, ["staging", "production"]);
});

test("reports: digest, cost review with evidence confidence, drift tasks without values, remediation escalation", () => {
  const now = NOW;
  const digest = buildReport("digest", progressOf([
    { nodeId: "audit", state: "succeeded", result: [{ at: "2026-10-05T10:00:00Z", phase: "result", action: "services.restart", target: "api", env: "staging", user: "alice@acme.test", result: "ok" }, { at: "2026-10-01T10:00:00Z", phase: "result", action: "old", user: "x" }] },
    { nodeId: "issues", state: "succeeded", result: [{ env: "staging", name: "Jobs", state: "DOWN", reasons: ["0/1 running"] }] },
    { nodeId: "ci", state: "succeeded", result: { failed: true, error: "GitHub isn't connected" } },
    { nodeId: "costs", state: "succeeded", result: { available: true, monthToDate: 1234.5, forecastMonthEnd: { usd: 4000 }, anomalies: [] } },
    { nodeId: "approvals", state: "succeeded", result: [{ status: "pending", title: "Restart a service", env: "staging", plan: { summary: "Restart api" } }] },
  ]), { now });
  assert.equal(digest.headline, "Daily digest: 1 change(s), 1 problem(s), 0 CI failure(s), $1,235 month to date, 1 pending approval(s)");
  assert.match(digest.text, /CI failures\n- couldn't be read: GitHub isn't connected/);
  assert.match(digest.text, /services\.restart api in staging by alice@acme\.test/);
  // An agent's approvals.list shows only its own run's requests: the console-wide count comes from the server.
  const counted = buildReport("digest", progressOf([{ nodeId: "approvals", state: "succeeded", result: [] }]), { now, pendingApprovals: 3 });
  assert.match(counted.headline, /3 pending approval\(s\)$/);
  assert.match(counted.text, /3 request\(s\) waiting in Automation → Approvals/);

  assert.equal(idleConfidence("2026-09-01T00:00:00Z", now, true), "high");
  assert.equal(idleConfidence("2026-10-04T00:00:00Z", now, true), "medium");
  assert.equal(idleConfidence("2026-09-01T00:00:00Z", now, false), "low", "a map that couldn't read everything lowers confidence");
  const cost = buildReport("cost-review", progressOf([
    { nodeId: "costs", state: "succeeded", result: { available: false, reason: "Cost Explorer is off" } },
    // costs.estimate's own shape (src/lib/server/ops/costs.ts).
    { nodeId: "estimate", state: "succeeded", result: { currency: "USD", monthlyTotal: 412.5, environments: [{ env: "staging", label: "Staging", monthly: 112.5, items: [] }, { env: "production", label: "Production", monthly: 300, items: [] }] } },
    { nodeId: "map", state: "succeeded", result: { lastCompleteAt: "2026-10-05T11:00:00Z", providers: [{ id: "lambda", state: "denied" }], idle: [{ key: "q", name: "orders-dlq", kind: "sqs-queue", why: "no messages in 14 days", since: "2026-09-01T00:00:00Z" }] } },
  ]), { now });
  assert.match(cost.text, /orders-dlq \(sqs-queue\): no messages in 14 days — confidence low/);
  assert.match(cost.text, /never deletes/);
  assert.match(cost.text, /Run rate \(list price\)\n- \$413 per month in total\n- Staging: \$113 per month\n- Production: \$300 per month/);
  assert.match(cost.headline, /1 idle resource/);

  const drift = buildReport("config-drift", progressOf([
    {
      nodeId: "compare", state: "succeeded",
      result: { envs: ["staging", "production"], services: [{ service: "api", variables: [{ name: "DATABASE_URL", status: "different", envs: { staging: "same", production: "different" } }, { name: "LOG_LEVEL", status: "same", envs: { staging: "same", production: "same" } }, { name: "NEW_FLAG", status: "missing", envs: { staging: "same", production: "missing" } }] }] },
    },
  ]), { now });
  assert.match(drift.headline, /2 variable\(s\) differ from staging — fixes are for a person/);
  assert.deepEqual(drift.tasks, [{ title: "Review 2 variable(s) of api in production", link: "/?env=production&r=service:api&tab=variables", names: ["DATABASE_URL", "NEW_FLAG"] }]);
  assert.ok(!/LOG_LEVEL/.test(drift.text), "only differences are listed");

  const unhealthy = buildReport("remediation", progressOf([
    { nodeId: "remediate", state: "succeeded", result: { runId: "r1", state: "succeeded", changed: true, operations: [{ action: "services.restart", target: "api", state: "succeeded" }] } },
    { nodeId: "verify", state: "succeeded", result: { ok: false, failed: true, polls: 30 } },
  ]), { now });
  assert.match(unhealthy.headline, /not healthy — a person should look/);
  const healthy = buildReport("remediation", progressOf([{ nodeId: "remediate", state: "succeeded", result: { changed: true } }, { nodeId: "verify", state: "succeeded", result: { ok: true } }]), { now });
  assert.equal(healthy.headline, "Remediation: verified healthy");
  const byAgent = buildReport("remediation", progressOf([{ nodeId: "remediate", state: "succeeded", result: { changed: true, health: "verified" } }, { nodeId: "verify", state: "skipped" }]), { now });
  assert.equal(byAgent.headline, "Remediation: verified healthy by the agent run");
  const none = buildReport("remediation", progressOf([{ nodeId: "remediate", state: "succeeded", result: { changed: false, health: "n/a" } }, { nodeId: "verify", state: "skipped" }]), { now });
  assert.equal(none.headline, "Remediation: no change was made — a person should look");
});

test("notify messages render leniently and never read the prototype", () => {
  assert.equal(renderMessage("{{inputs.action}} for {{targets.length}} service(s): {{steps.x.result.summary}}", { inputs: { action: "stop" }, targets: [1, 2] }), "stop for 2 service(s): (none)");
  assert.equal(renderMessage("{{inputs.__proto__}} {{inputs.constructor}}", { inputs: {} }), "(none) (none)");
});
