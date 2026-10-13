// Product tests for the Automation screens (AGENT_ARCHITECTURE §9.8): an understandable approval preview, an accurate
// pending / unknown state, budget visibility, reconnect and resume, the emergency stop — plus the connection form and
// the agent-client configs, checked against the server's own validators.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_CONNECTION_POLICY, PROVIDERS, checkNewConnection, type EndpointEntry } from "../../lib/agents/connection-rules.ts";
import {
  RUN_REFRESH_EVENTS, RUN_STATE, agentTokenStatus, agentsSwitchText, budgetRows, citationsIn, clientConfigs, connectionBody, draftReady, emptyDraft,
  endpointChoices, evidenceAge, invalidationText, isFinalRunState, liveLabel, metricTiles, outcomeBadges, outcomeContext, outcomeUnknownGuidance, parseAutomationHash, planFacts,
  plansMigrations, runMatches, secretBody, secretFields, shortHash, stillMoving, stopBannerText, verifyText, waitingText,
} from "./rules.ts";
import type { ProposalView, RunDetail, RunStep } from "./types.ts";

const NOW = 1_800_000_000_000;

describe("tabs", () => {
  it("opens Approvals when something waits for a decision, else Runs", () => {
    assert.deepEqual(parseAutomationHash("", 2), { tab: "approvals" });
    assert.deepEqual(parseAutomationHash("", 0), { tab: "runs" });
    assert.deepEqual(parseAutomationHash("#bogus", 0), { tab: "runs" });
  });
  it("keeps an explicit tab and a run id in the hash", () => {
    assert.deepEqual(parseAutomationHash("#connections", 5), { tab: "connections" });
    assert.deepEqual(parseAutomationHash("#runs/abc-123", 5), { tab: "runs", runId: "abc-123" });
    assert.deepEqual(parseAutomationHash("#runs/<script>", 0), { tab: "runs" });
    assert.deepEqual(parseAutomationHash("#workflows/wf-1", 0), { tab: "workflows", workflowId: "wf-1" });
    assert.deepEqual(parseAutomationHash("#tokens/x", 0), { tab: "tokens" });
  });
});

describe("pending and unknown states are accurate", () => {
  it("never shows an accepted request as healthy", () => {
    const b = outcomeBadges({ ai: "completed", aws: "accepted", health: "pending" });
    assert.deepEqual(b.map((x) => x.label), ["AI completed", "AWS accepted", "Verifying health"]);
    assert.ok(!b.some((x) => x.label === "Verified healthy"));
    assert.equal(b.find((x) => x.key === "aws")!.tone, "accent"); // accepted is not "ok"
  });
  it("keeps the three answers separate", () => {
    const b = outcomeBadges({ ai: "failed", aws: "none", health: "n/a" });
    assert.deepEqual(b.map((x) => x.key), ["ai", "aws", "health"]);
    assert.equal(b[0].tone, "bad");
    assert.equal(outcomeBadges({ ai: "completed", aws: "accepted", health: "verified" })[2].label, "Verified healthy");
    assert.deepEqual(outcomeBadges(undefined), []);
    assert.equal(outcomeBadges({ ai: "pending", aws: "none", health: "n/a" }, { final: true })[0].label, "No AI answer"); // an ended run isn't "working"
  });
  it("explains an unknown outcome and says not to ask again blindly", () => {
    assert.match(outcomeUnknownGuidance({ state: "outcome_unknown" })!, /never retries/);
    assert.ok(outcomeUnknownGuidance({ state: "waiting_external", operations: [{ id: "o1", state: "outcome_unknown" }] }));
    assert.ok(outcomeUnknownGuidance({ state: "succeeded", outcome: { ai: "completed", aws: "unknown", health: "pending" } }));
    assert.equal(outcomeUnknownGuidance({ state: "succeeded", outcome: { ai: "completed", aws: "accepted", health: "verified" } }), undefined);
  });
  // The runner reports `aws: "unknown"` for a change still in flight too (evidence.ts runOutcome); only a real
  // outcome_unknown (or a run that ended that way) is "unknown" with its guidance.
  const step = (kind: RunStep["kind"], state: RunStep["state"], seq = 1): RunStep => ({ id: `s${seq}`, seq, kind, state });
  const run = (r: Partial<RunDetail>): RunDetail => ({ id: "r1", kind: "assistant", title: null, state: "running", createdAt: NOW, updatedAt: NOW, ...r });
  it("says a change still in flight is being checked, not that its outcome is unknown", () => {
    const inflight = run({ state: "waiting_external", connection: { id: "c1" }, steps: [step("model", "succeeded"), step("execute", "leased", 2)], outcome: { ai: "completed", aws: "unknown", health: "pending" } });
    const b = outcomeBadges(inflight.outcome, outcomeContext(inflight));
    assert.equal(b[1].label, "AWS: checking");
    assert.equal(b[1].tone, "accent");
    assert.equal(outcomeUnknownGuidance(inflight), undefined);
    const lost = { ...inflight, steps: [step("model", "succeeded"), step("execute", "outcome_unknown", 2)] };
    assert.equal(outcomeBadges(lost.outcome, outcomeContext(lost))[1].label, "AWS outcome unknown");
    assert.match(outcomeUnknownGuidance(lost)!, /never retries/);
    const ended = run({ state: "outcome_unknown", outcome: { ai: "completed", aws: "unknown", health: "pending" } });
    assert.equal(outcomeBadges(ended.outcome, outcomeContext(ended))[1].tone, "bad");
  });
  it("never claims an AI answer for a run without an AI step of its own", () => {
    const done = { ai: "completed", aws: "accepted", health: "verified", text: { ai: "no AI step in this run", aws: "AWS accepted the change", health: "service verified healthy after the change" } } as const;
    const deterministic = run({ kind: "workflow", state: "succeeded", connection: null, steps: [step("tool", "succeeded"), step("execute", "succeeded", 2)], outcome: done });
    const b = outcomeBadges(deterministic.outcome, outcomeContext(deterministic));
    assert.equal(b[0].label, "No AI step");
    assert.equal(b[0].hint, "no AI step in this run"); // the runner's own words
    const external = run({ kind: "external", state: "running", outcome: { ai: "pending", aws: "none", health: "n/a" } });
    assert.equal(outcomeBadges(external.outcome, outcomeContext(external))[0].label, "AI: in its client");
    // An assistant run whose first model turn is still queued isn't "AI completed", whatever the outcome says.
    const queued = run({ state: "queued", connection: { id: "c1" }, steps: [], outcome: { ai: "completed", aws: "none", health: "n/a" } });
    assert.equal(outcomeBadges(queued.outcome, outcomeContext(queued))[0].label, "AI working");
  });
  it("stops following a finished run whose failed change will never be verified", () => {
    const failed = run({ state: "failed", outcome: { ai: "completed", aws: "none", health: "n/a" }, operations: [{ id: "o1", state: "failed", verify: null }] });
    assert.equal(stillMoving(failed), false);
    assert.equal(stillMoving({ ...failed, state: "succeeded", outcome: { ai: "completed", aws: "accepted", health: "pending" } }), true);
    assert.equal(stillMoving({ ...failed, operations: [{ id: "o1", state: "running" }] }), true);
    assert.equal(stillMoving(undefined), true);
  });
  it("words an operation's verification without claiming health early", () => {
    assert.equal(verifyText({ id: "o", state: "succeeded", verify: null }).text, "AWS accepted · verifying");
    assert.equal(verifyText({ id: "o", state: "succeeded", verify: 1 }).text, "AWS accepted · verified healthy");
    assert.match(verifyText({ id: "o", state: "succeeded", verify: { ok: false, detail: "did not stabilise in 15 min" } }).text, /not healthy \(did not stabilise/);
    assert.equal(verifyText({ id: "o", state: "outcome_unknown" }).tone, "bad");
  });
  it("says what a run is waiting for", () => {
    assert.equal(waitingText({ state: "waiting_approval" }), "a person's approval");
    assert.equal(waitingText({ state: "waiting_external", waitingFor: "operation 1a2b to settle" }), "operation 1a2b to settle");
    assert.equal(waitingText({ state: "succeeded" }), undefined);
    for (const s of Object.keys(RUN_STATE)) assert.ok(RUN_STATE[s as keyof typeof RUN_STATE].label, s);
    assert.equal(isFinalRunState("outcome_unknown"), true);
    assert.equal(isFinalRunState("waiting_external"), false);
  });
  it("filters runs by what needs a person", () => {
    assert.ok(runMatches({ state: "paused_auth" }, "attention"));
    assert.ok(runMatches({ state: "outcome_unknown" }, "attention"));
    assert.ok(runMatches({ state: "waiting_approval" }, "waiting"));
    assert.ok(!runMatches({ state: "succeeded" }, "active"));
  });
});

describe("budget visibility", () => {
  it("shows each limit the run has, with how much is used", () => {
    const rows = budgetRows({ modelTurns: 12, toolCalls: 40, runtimeSeconds: 600, costUsd: 0.5 }, { turns: 10, toolCalls: 40, elapsedMs: 30_000, costUsd: 0.1 });
    assert.deepEqual(rows.map((r) => [r.key, r.text, r.tone]), [
      ["turns", "10 of 12", "warn"],
      ["tools", "40 of 40", "bad"],
      ["time", "30s of 10m", "ok"],
      ["cost", "$0.100 of $0.500", "ok"],
    ]);
    assert.equal(rows.find((r) => r.key === "cost")!.estimated, true);
    assert.equal(rows.find((r) => r.key === "tools")!.pct, 1);
  });
  it("leaves out limits the run doesn't have, and works out elapsed time from the clock", () => {
    const rows = budgetRows({ runtimeSeconds: 900, modelTurns: 0 }, null, { now: NOW, startedAt: NOW - 120_000 });
    assert.deepEqual(rows.map((r) => r.text), ["2m of 15m"]);
    assert.deepEqual(budgetRows({ runtimeSeconds: 900 }, null, { startedAt: NOW - 300_000, finishedAt: NOW - 240_000 }).map((r) => r.text), ["1m of 15m"]);
    assert.deepEqual(budgetRows(null, null), []);
  });
});

describe("an understandable approval preview", () => {
  const evidence = [
    { id: "E1", source: "services.get staging/api", observedAt: NOW - 90_000, summary: "2 of 3 tasks running" },
    { id: "E2", source: "logs.search staging/api", observedAt: NOW - 30_000, summary: "OOMKilled ×4" },
  ];
  const p: ProposalView = {
    grantId: "g1", approvalId: "a1", op: "services.restart", targets: ["ecs:service/acme-staging/api"], planHash: "sha256:" + "ab".repeat(32),
    plan: { summary: "Restart api in Staging", changes: ["new deployment of revision 123 (3 tasks, rolling)"], warnings: [] }, expiresAt: NOW + 600_000, state: "pending",
    why: "Tasks are killed for memory [E2] and one task is missing [E1].",
  };
  it("says what changes, where, why, on which evidence, how success is judged and which plan it binds", () => {
    const f = planFacts(p, evidence);
    assert.deepEqual(f.what, ["new deployment of revision 123 (3 tasks, rolling)"]);
    assert.deepEqual(f.where, ["ecs:service/acme-staging/api"]);
    assert.match(f.why!, /\[E2\]/);
    assert.deepEqual(f.evidence.found.map((e) => e.id), ["E2", "E1"]);
    assert.equal(f.evidence.oldest, NOW - 90_000);
    assert.match(f.success, /steady and healthy/);
    assert.equal(f.consumers, undefined); // not reported ≠ none
    assert.equal(f.planHash, p.planHash);
    assert.equal(shortHash(f.planHash), "sha256:abababab…abab");
  });
  it("lists cost bounds, unknown citations and migration warnings", () => {
    const f = planFacts({ ...p, evidence: ["E9"], plan: { summary: "Scale", estimate: { monthlyUsd: 42.5, note: "2 more Fargate tasks" } }, consumers: [] }, evidence);
    assert.deepEqual(f.evidence.missing, ["E9"]);
    assert.match(f.bounds[0], /\$42\.5\/month/);
    assert.deepEqual(f.consumers, []);
    assert.ok(plansMigrations({ summary: "x", warnings: ["Database migrations changed between these revisions"] }));
    assert.ok(!plansMigrations({ summary: "x" }));
  });
  it("explains why a request was invalidated", () => {
    assert.equal(invalidationText("invalidated: the plan changed since it was requested"), "the plan changed since it was requested");
    assert.equal(invalidationText("smoke"), undefined);
  });
  it("finds citations and ages evidence against the policy's limit", () => {
    assert.deepEqual(citationsIn("see E1 and [E12], not XE3 or E1"), ["E1", "E12"]);
    assert.deepEqual(evidenceAge(NOW - 30_000, NOW, 60), { text: "30s old", stale: false });
    assert.deepEqual(evidenceAge(NOW - 300_000, NOW, 60), { text: "5m old", stale: true });
    assert.equal(evidenceAge(undefined, NOW).stale, true);
  });
});

describe("release metrics", () => {
  it("shows rates, counts and a non-zero duplicate effect as a problem", () => {
    const t = metricTiles({ since: NOW, runs: 8, verifiedCompletion: 0.75, escalations: 2, outcomeUnknown: 1, preventedViolations: 3, duplicateEffects: 1, approvalsInvalidated: 0, estimatedCostUsd: 0.42 });
    const by = Object.fromEntries(t.map((x) => [x.key, x]));
    assert.equal(by.verified.value, "75%");
    assert.equal(by.escalations.value, "2 of 8");
    assert.equal(by.duplicates.tone, "bad");
    assert.equal(by.unknown.tone, "warn");
    assert.equal(by.cost.value, "$0.42");
    const z = Object.fromEntries(metricTiles({ since: NOW, runs: 0, verifiedCompletion: { rate: null, count: 0 }, escalations: { rate: 0.5 }, outcomeUnknown: 0, preventedViolations: 0, duplicateEffects: 0, approvalsInvalidated: 0, estimatedCostUsd: null }).map((x) => [x.key, x]));
    assert.equal(z.duplicates.tone, "ok");
    assert.equal(z.cost.value, "—");
    assert.equal(z.escalations.value, "50%");
    assert.equal(z.verified.value, "0");
  });
});

describe("reconnect and resume", () => {
  it("re-reads the run after its own events and after a replay", () => {
    for (const t of ["run", "step", "operation", "approval", "replayed"]) assert.ok((RUN_REFRESH_EVENTS as readonly string[]).includes(t), t);
    assert.ok(!(RUN_REFRESH_EVENTS as readonly string[]).includes("state"));
    assert.match(liveLabel("reconnecting", false), /catching up/);
    assert.equal(liveLabel("reconnecting", true), "Finished");
  });
});

describe("emergency stop and the agents switch", () => {
  it("shows the stop with who and why while it is on", () => {
    assert.equal(stopBannerText({ on: false, by: "a@b" }), undefined);
    const t = stopBannerText({ on: true, by: "ops@acme.test", reason: "bad deploy" })!;
    assert.match(t, /ops@acme\.test/);
    assert.match(t, /Reason: bad deploy/);
  });
  it("locks the toggle when CONSOLE_AGENTS decides", () => {
    assert.deepEqual(agentsSwitchText({ on: false, source: "env" }, "aws").locked, true);
    assert.match(agentsSwitchText({ on: false, source: "default" }, "aws").text, /off against a real AWS account/);
    assert.equal(agentsSwitchText({ on: true, source: "settings" }, "mock").locked, false);
  });
  it("lists active agent tokens apart from expired and revoked ones", () => {
    assert.equal(agentTokenStatus({ revokedAt: NOW - 1, expiresAt: NOW + 1 }, NOW), "revoked");
    assert.equal(agentTokenStatus({ revokedAt: null, expiresAt: NOW - 1 }, NOW), "expired");
    assert.equal(agentTokenStatus({ revokedAt: null, expiresAt: NOW + 1 }, NOW), "active");
    assert.equal(agentTokenStatus({ status: "revoked", revokedAt: null, expiresAt: null }, NOW), "revoked");
  });
});

describe("connect your agent", () => {
  const c = clientConfigs("http://127.0.0.1:3200/", "da_TOKEN");
  it("generates the Claude Code command and .mcp.json", () => {
    assert.equal(c.claudeCode, 'claude mcp add --transport http deployment-console http://127.0.0.1:3200/api/mcp --header "Authorization: Bearer da_TOKEN"');
    assert.deepEqual(JSON.parse(c.mcpJson), { mcpServers: { "deployment-console": { type: "http", url: "http://127.0.0.1:3200/api/mcp", headers: { Authorization: "Bearer da_TOKEN" } } } });
  });
  it("generates Gemini CLI settings with httpUrl and headers", () => {
    assert.deepEqual(JSON.parse(c.gemini), { mcpServers: { "deployment-console": { httpUrl: "http://127.0.0.1:3200/api/mcp", headers: { Authorization: "Bearer da_TOKEN" } } } });
  });
  it("generates curl calls for initialize and tools/list", () => {
    assert.match(c.curl, /"method":"initialize"/);
    assert.match(c.curl, /"method":"tools\/list"/);
    assert.equal((c.curl.match(/Authorization: Bearer da_TOKEN/g) ?? []).length, 2);
  });
});

describe("the connection form builds what the server accepts", () => {
  const ctx = (admin: boolean, endpoints: EndpointEntry[] = []) => ({ isAdmin: admin, mock: true, chatgptPlan: false, via: "form" as const, endpoints, policy: DEFAULT_CONNECTION_POLICY });
  const spec = (id: string) => PROVIDERS.find((p) => p.id === id)!;

  it("an API key connection", () => {
    const d = { ...emptyDraft(spec("anthropic")), secret: { apiKey: " sk-ant-test-123456 " } };
    assert.ok(draftReady(d, spec("anthropic")));
    const body = connectionBody(d, spec("anthropic"), { admin: false });
    assert.equal(body.secret, "sk-ant-test-123456");
    assert.equal(body.scope, "personal");
    assert.ok(!("endpoint" in body) && !("region" in body) && !("minRole" in body));
    const r = checkNewConnection(body, ctx(false));
    assert.ok(r.ok, r.ok ? "" : r.error);
  });
  it("a Bedrock role assumed with its own keys", () => {
    const d = {
      ...emptyDraft(spec("bedrock")), region: "eu-west-1",
      secret: { roleArn: "arn:aws:iam::123456789012:role/bedrock-invoke", accessKeyId: "AKIAABCDEFGHIJKLMNOP", secretAccessKey: "a".repeat(40) },
    };
    assert.ok(draftReady(d, spec("bedrock")));
    const body = connectionBody(d, spec("bedrock"), { admin: false });
    assert.deepEqual(body.secret, { roleArn: "arn:aws:iam::123456789012:role/bedrock-invoke", source: { accessKeyId: "AKIAABCDEFGHIJKLMNOP", secretAccessKey: "a".repeat(40) } });
    const r = checkNewConnection(body, ctx(false));
    assert.ok(r.ok, r.ok ? "" : r.error);
    assert.ok(!draftReady({ ...d, region: "" }, spec("bedrock")));
  });
  it("an organisation connection only for admins, and never for a personal-only provider", () => {
    const d = { ...emptyDraft(spec("openai")), scope: "org" as const, minRole: "operator", secret: { apiKey: "sk-test-12345678" } };
    assert.equal(connectionBody(d, spec("openai"), { admin: false }).scope, "personal");
    const body = connectionBody(d, spec("openai"), { admin: true });
    assert.equal(body.minRole, "operator");
    const r = checkNewConnection(body, ctx(true));
    assert.ok(r.ok, r.ok ? "" : r.error);
    const rt = connectionBody({ ...emptyDraft(spec("runtime:claude-code")), scope: "org" }, spec("runtime:claude-code"), { admin: true });
    assert.equal(rt.scope, "personal");
    assert.ok(!("secret" in rt));
    assert.ok(checkNewConnection(rt, ctx(true)).ok);
  });
  it("offers only endpoints the server would accept for the scope", () => {
    const reg: EndpointEntry[] = [
      { id: "gw", url: "https://llm.acme.test", label: "Gateway", providers: ["openai-compatible"], local: false, personal: false },
      { id: "mine", url: "https://llm2.acme.test", label: "Personal gateway", providers: ["openai-compatible"], local: false, personal: true },
    ];
    assert.deepEqual(endpointChoices(spec("openai-compatible"), "personal", reg).map((e) => e.value), ["https://llm2.acme.test"]);
    assert.deepEqual(endpointChoices(spec("openai-compatible"), "org", reg).map((e) => e.value), ["https://llm.acme.test", "https://llm2.acme.test"]);
    assert.deepEqual(endpointChoices(spec("anthropic"), "personal", reg).map((e) => e.value), [""]);
    const d = { ...emptyDraft(spec("openai-compatible")), authKind: "none" as const, endpoint: "https://llm2.acme.test" };
    assert.ok(checkNewConnection(connectionBody(d, spec("openai-compatible"), { admin: false }), ctx(false, reg)).ok);
  });
  it("write-only fields per auth kind; a rotate sends only the secret", () => {
    assert.deepEqual(secretFields("api-key").map((f) => [f.key, f.secret]), [["apiKey", true]]);
    assert.deepEqual(secretFields("none"), []);
    assert.equal(secretBody("none", { apiKey: "x" }), undefined);
    assert.deepEqual(secretBody("aws-keys", { accessKeyId: "AKIA1", secretAccessKey: "s", sessionToken: " " }), { accessKeyId: "AKIA1", secretAccessKey: "s" });
  });
});

describe("scope and expiry in words", () => {
  it("summarises a selector", async () => {
    const { scopeText, untilText } = await import("./rules.ts");
    assert.equal(scopeText({ envs: ["staging"], keys: ["a", "b", "c"], excludeProtected: true }), "env staging · 3 listed resources · unprotected only");
    assert.equal(scopeText({}), "everything the person it acts for can reach");
    assert.equal(scopeText(null), "not recorded");
    assert.equal(untilText(NOW + 90_000, NOW), "in 2m");
    assert.equal(untilText(NOW - 1, NOW), "expired");
    assert.equal(untilText(null, NOW), "no expiry");
  });
});

describe("workflow drafts are edited as fields, not JSON", () => {
  it("turns an input object into rows and back with types kept", async () => {
    const { inputRows, rowsToInput } = await import("./rules.ts");
    const input = { env: "staging", desired: 0, dryRun: false, services: ["api", "worker"], service: "{{ target.service }}" };
    assert.deepEqual(rowsToInput(inputRows(input)), input);
    assert.deepEqual(rowsToInput([{ key: " __proto__ ", value: "x" }, { key: "", value: "y" }, { key: "a", value: " 12 " }]), { a: 12 });
    // Editing one field never changes another: nested objects, number-like and keyword-like strings, null and
    // templates read back exactly as they were.
    const tricky = { selector: { envs: ["staging"], states: ["DOWN"] }, account: "012345678901", id: "42", flag: "true", none: null, ids: [1, 2], names: ["a,b", "c"], tpl: "{{trigger.env}}", list: "[x]", padded: " x " };
    assert.deepEqual(rowsToInput(inputRows(tricky)), tricky);
    assert.equal(inputRows({ tpl: "{{ target.service }}" })[0].value, "{{ target.service }}"); // shown bare, as typed
    assert.deepEqual(rowsToInput([{ key: "v", value: '"007"' }, { key: "o", value: '{"a":1}' }, { key: "z", value: "007" }]), { v: "007", o: { a: 1 }, z: "007" });
  });
  it("adds steps with unique ids and labels triggers", async () => {
    const { newStep, triggerLabel } = await import("./rules.ts");
    assert.equal(newStep("wait", ["wait-1"]).id, "wait-2");
    assert.equal(newStep("verify", []).timeoutSeconds, 600);
    assert.equal(triggerLabel({ type: "schedule", cron: "0 19 * * 1-5", tz: "Europe/London" }), "schedule 0 19 * * 1-5 (Europe/London)");
    assert.equal(triggerLabel({ type: "event", source: "state", selector: { envs: ["staging"] } }), "state change in staging");
    assert.equal(triggerLabel(undefined), "manual");
  });
});

describe("the runner's own shapes (src/lib/server/agents/runner.ts runDetail / runMetrics)", () => {
  it("reads operation verification as the coordinator records it", () => {
    assert.equal(verifyText({ id: "o", state: "succeeded", verify: "verified" }).text, "AWS accepted · verified healthy");
    assert.equal(verifyText({ id: "o", state: "succeeded", verify: "failed", detail: "did not stabilise in 15 min" }).text, "AWS accepted · not healthy (did not stabilise in 15 min)");
    assert.equal(verifyText({ id: "o", state: "succeeded", verify: null }).text, "AWS accepted · verifying");
  });
  it("reads the budget view { limits, used, cost }", () => {
    const rows = budgetRows({ limits: { turns: 12, toolCalls: 40, runtimeSeconds: 900 }, used: { turns: 3, toolCalls: 9, seconds: 95 }, cost: "none" }, null);
    assert.deepEqual(rows.map((r) => r.text), ["3 of 12", "9 of 40", "1m 35s of 15m"]);
  });
  it("reads a proposal's evidence record and a null plan hash", () => {
    const f = planFacts(
      { grantId: "g", approvalId: "a", op: "services.scale", targets: [], planHash: null, plan: null, expiresAt: null, state: "pending", env: "staging", evidence: { ids: ["E1", "E4"], newestAgeSeconds: 0, refreshed: "E4" } },
      [{ id: "E1", source: "s", observedAt: NOW }, { id: "E4", source: "s", observedAt: NOW }],
    );
    assert.deepEqual(f.evidence.found.map((e) => e.id), ["E1", "E4"]);
    assert.equal(f.refreshed, "E4");
    assert.equal(f.planHash, "");
    assert.deepEqual(f.where, ["staging"]);
    assert.equal(shortHash(f.planHash), "—");
  });
  it("warns when the evidence was too old and couldn't be read again", () => {
    const p: ProposalView = { grantId: "g", approvalId: "a", op: "services.restart", targets: ["staging/api"], planHash: "sha256:x", plan: null, expiresAt: null, state: "pending", evidence: { ids: ["E1"], newestAgeSeconds: 900, stale: true } };
    assert.equal(planFacts(p, [{ id: "E1", source: "s", observedAt: NOW }]).stale, true);
    assert.equal(planFacts({ ...p, evidence: ["E1"] }, []).stale, undefined);
  });
  it("shows verified completion as the share of accepted changes", () => {
    const base = { since: NOW, runs: 4, escalations: 0, outcomeUnknown: 0, preventedViolations: 0, duplicateEffects: 0, approvalsInvalidated: 0, estimatedCostUsd: 0 };
    assert.equal(metricTiles({ ...base, verifiedCompletion: 1, changes: 2, verifiedChanges: 2 }).find((t) => t.key === "verified")!.value, "100%");
    assert.equal(metricTiles({ ...base, verifiedCompletion: null, changes: 0, verifiedChanges: 0 }).find((t) => t.key === "verified")!.value, "—");
  });
});
