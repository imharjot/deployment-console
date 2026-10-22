// The operations registry with agent callers (master plan §6 C1 item 8; AGENT_ARCHITECTURE §9.1 authority, §9.2
// approval, §9.7 autoscaler / rollback), run for real against the simulated account: the registry, the policy engine,
// principals, agent tokens, exact-plan grants, the run store and an in-memory SQLite DB, in a child process (server
// modules import "server-only", which resolves only under the react-server condition; a resolve hook maps "@/…" to
// src/ and "next/server" to next/server.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";

const SRC = new URL("../../../", import.meta.url).href; // …/src/
const hooks = `
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
const SRC = ${JSON.stringify(SRC)};
export async function resolve(spec, ctx, next) {
  if (spec === "next/server") return next("next/server.js", ctx);
  if (spec.startsWith("@/")) {
    for (const ext of [".ts", ".tsx", "/index.ts"]) {
      const url = new URL(spec.slice(2) + ext, SRC);
      if (existsSync(fileURLToPath(url))) return next(url.href, ctx);
    }
  }
  return next(spec, ctx);
}`;
const register = `import { register } from "node:module"; register(${JSON.stringify(`data:text/javascript,${encodeURIComponent(hooks)}`)});`;

function run(scenario: string, env: Record<string, string> = {}) {
  const raw = execFileSync(process.execPath, ["--conditions=react-server", "--no-warnings", "--import", `data:text/javascript,${encodeURIComponent(register)}`, "--input-type=module", "-e", prelude + scenario], {
    encoding: "utf8",
    timeout: 180_000,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      CONSOLE_SOURCE: "mock",
      CONSOLE_SQLITE_PATH: ":memory:",
      CONSOLE_SECRET_KEY: randomBytes(36).toString("base64"),
      CONSOLE_TRUSTED_PROXIES: "0",
      NODE_ENV: "test",
      ...env,
    },
  });
  return JSON.parse(raw.trim().split("\n").pop()!);
}

const prelude = `
const src = (p) => new URL(p, ${JSON.stringify(SRC)}).href;
const { getDb } = await import(src("lib/server/db.ts"));
const { createUser } = await import(src("lib/server/auth/users.ts"));
const ops = await import(src("lib/server/ops/index.ts"));
const store = await import(src("lib/server/agents/store.ts"));
const tokens = await import(src("lib/server/auth/agent-tokens.ts"));
const principals = await import(src("lib/server/agents/principals.ts"));
const grants = await import(src("lib/server/agents/grants.ts"));
const stop = await import(src("lib/server/agents/stop.ts"));
const policy = await import(src("lib/agents/policy.ts"));
const db = await getDb();
const mk = async (email, role) => { const r = await createUser({ email, role }); return { id: r.id, email, role }; };
const alice = await mk("alice@acme.test", "operator");
const admin = await mk("admin@acme.test", "admin");
const bob = await mk("bob@acme.test", "admin");
const settle = (p) => p.then((v) => ({ ok: v }), (e) => ({ status: e.status, code: e.code, error: String(e.message) }));
const person = (u) => ({ user: { id: u.id, email: u.email, role: u.role }, via: "session" });
const P = (name) => JSON.parse(JSON.stringify(policy.DEFAULT_POLICIES[name]));
async function agentRun(pol, who = alice, kind = "assistant") {
  const runId = crypto.randomUUID();
  const h = policy.policyHash(pol);
  const principal = { id: "agent:" + runId, kind: "agent", runId, delegatorId: who.id, delegatorEmail: who.email, policyHash: h, mode: pol.mode };
  await store.createRun({ id: runId, kind, title: "test", initiatorId: who.id, principal, policy: pol, policyHash: h, state: "running", deadlineAt: Date.now() + 3_600_000 });
  return principal;
}
const as = (p, o) => principals.agentCaller(p, o);
const invokeAs = async (p, name, input, o = {}) => settle(as(p, o).then((c) => ops.invoke(name, input, c, o)));
const events = [];
ops.onAgentInvoke((e) => events.push({ op: e.op, outcome: e.outcome, reason: e.reason }));
const out = {};
`;

test("§9.1 authority: session bypass, scoped reads, forbidden operations, resource scope, demotion, agents off, emergency stop", () => {
  const o = run(`
const p = await agentRun({ ...P("incident-investigator"), scope: { envs: ["staging"] } });
// The session bypass: inside an agent run, a person's caller is refused; the agent's own works.
out.bypass = await settle(principals.withAgentContext(p, () => ops.invoke("envs.list", {}, person(alice))));
out.agentInCtx = await settle(principals.withAgentContext(p, async () => (await ops.invoke("envs.list", {}, await as(p))).kind));
const other = await agentRun(P("incident-investigator"));
out.otherRun = await settle(principals.withAgentContext(p, async () => ops.invoke("envs.list", {}, await as(other))));
// Scoped reads.
out.readIn = (await invokeAs(p, "envs.status", { env: "staging" })).ok?.kind;
out.readOut = await invokeAs(p, "envs.status", { env: "production" });
// Forbidden: hard denials and the policy's own denials, whatever the delegator may do.
const all = await agentRun({ ...P("incident-investigator"), mode: "bounded-act", tools: { read: ["*"], propose: ["*"], act: ["*"], deny: [] } }, admin);
out.vars = await invokeAs(all, "variables.update", { env: "staging", service: "api", confirm: "yes", changes: { plain: [{ container: "api", set: { A: "1" } }] } });
// A change whose targets can't be placed (no environment, no resource) is refused to agents.
out.unplaced = await invokeAs(all, "costs.refresh", {});
out.denyList = await invokeAs(p, "tasks.run", { env: "staging", service: "worker", confirm: "yes" });
out.self = await invokeAs(all, "services.restart", { env: "production", service: "deployment-console", confirm: "deployment-console", reason: "test" });
// Resource scope: a bounded agent listed for staging/api can't touch staging/worker.
const key = (await ops.resolveTargets("services.restart", { env: "staging", service: "api" }))[0].key;
const narrow = await agentRun({ ...P("incident-investigator"), scope: { envs: ["staging"], keys: [key] } });
out.otherService = await invokeAs(narrow, "services.restart", { env: "staging", service: "worker", confirm: "yes" });
out.listedService = (await invokeAs(narrow, "services.restart", { env: "staging", service: "api", confirm: "yes" })).ok?.kind;
// Owner demotion takes effect at once; a disabled delegator stops the agent.
await db.run("UPDATE users SET role = 'viewer' WHERE id = ?", [alice.id]);
out.demotedChange = await invokeAs(p, "services.restart", { env: "staging", service: "worker", confirm: "yes" });
out.demotedRead = (await invokeAs(p, "envs.status", { env: "staging" })).ok?.kind;
await db.run("UPDATE users SET disabled = 1 WHERE id = ?", [alice.id]);
out.disabled = await invokeAs(p, "envs.list", {});
await db.run("UPDATE users SET disabled = 0, role = 'operator' WHERE id = ?", [alice.id]);
// Agents off → 503; the emergency stop → 423 for changes, reads go on.
await stop.setAgentsEnabled(false, "admin@acme.test");
out.off = await invokeAs(p, "envs.list", {});
await stop.setAgentsEnabled(true, "admin@acme.test");
out.stopNeedsReason = await settle(stop.setEmergencyStop(true, "admin@acme.test"));
await stop.setEmergencyStop(true, "admin@acme.test", "incident drill");
out.stopped = await invokeAs(p, "services.restart", { env: "staging", service: "api", confirm: "yes" });
out.stoppedRead = (await invokeAs(p, "envs.status", { env: "staging" })).ok?.kind;
await stop.setEmergencyStop(false, "admin@acme.test", "drill over");
out.stopAudit = [...new Set((await db.all("SELECT action FROM audit WHERE action LIKE 'agents.%' ORDER BY at")).map((r) => r.action))]; // intent and result rows
// Listing: an observe agent sees no change tools; a proposing one is told never to resend.
const obs = await agentRun(P("daily-digest"));
out.observeTools = ops.toolSourcesFor(await as(obs)).filter((t) => t.name === "services.restart").length;
const t = ops.toolSourcesFor(await as(p)).find((x) => x.name === "services.restart");
out.proposeTool = t?.description.includes("never resend one");
out.listedVars = ops.listOps(await as(all)).find((x) => x.name === "variables.update")?.allowed;
out.events = events.slice(0, 50);
console.log(JSON.stringify(out));
`);
  assert.deepEqual(o.bypass, { status: 500, error: "agent runs must use the agent identity" });
  assert.deepEqual(o.agentInCtx, { ok: "result" });
  assert.equal(o.otherRun.status, 500, "an agent context accepts only its own run's identity");
  assert.equal(o.readIn, "result");
  assert.equal(o.readOut.status, 403);
  assert.match(o.readOut.error, /outside the agent's environments/);
  assert.match(o.vars.error, /never change environment variables/);
  assert.equal(o.vars.code, "policy_denied");
  assert.match(o.unplaced.error, /couldn't be worked out/);
  assert.match(o.denyList.error, /tasks.run is denied by the agent's policy/);
  assert.match(o.self.error, /never act on the console itself/);
  assert.match(o.otherService.error, /not one of the agent's resources/);
  assert.equal(o.listedService, "approval", "propose mode: a listed change becomes an approval request");
  assert.equal(o.demotedChange.status, 403);
  assert.match(o.demotedChange.error, /your role \(viewer\)/);
  assert.equal(o.demotedRead, "result");
  assert.equal(o.disabled.status, 401);
  assert.deepEqual([o.off.status, o.off.code], [503, "agents_off"]);
  assert.equal(o.stopNeedsReason.status, 400);
  assert.deepEqual([o.stopped.status, o.stopped.code], [423, "emergency_stop"]);
  assert.equal(o.stoppedRead, "result");
  assert.deepEqual(o.stopAudit, ["agents.disable", "agents.enable", "agents.emergency_stop", "agents.emergency_stop_lifted"]);
  assert.equal(o.observeTools, 0);
  assert.equal(o.proposeTool, true);
  assert.equal(o.listedVars, false);
  // Every agent call fired onAgentInvoke, denials included.
  const outcomes = new Set((o.events as { outcome: string }[]).map((e) => e.outcome));
  for (const k of ["result", "approval", "denied"]) assert.ok(outcomes.has(k), k);
  assert.ok((o.events as { op: string; outcome: string }[]).some((e) => e.op === "variables.update" && e.outcome === "denied"));
});

test("§9.1 authority, continued: a caller built earlier, account and tag scope, child narrowing, unread security metadata (R01), dry runs", () => {
  const o = run(`
const inv = await import(src("lib/server/inventory.ts"));
// The runner may build a caller once and reuse it: the delegator is still re-read on every call.
const p = await agentRun(P("incident-investigator"));
const cached = await as(p);
out.cachedBefore = (await settle(ops.invoke("services.restart", { env: "staging", service: "api", confirm: "yes" }, cached))).ok?.kind;
await db.run("UPDATE users SET role = 'viewer' WHERE id = ?", [alice.id]);
out.cachedDemoted = await settle(ops.invoke("services.restart", { env: "staging", service: "worker", confirm: "yes" }, cached));
await db.run("UPDATE users SET disabled = 1 WHERE id = ?", [alice.id]);
out.cachedDisabled = await settle(ops.invoke("envs.list", {}, cached));
await db.run("UPDATE users SET disabled = 0, role = 'operator' WHERE id = ?", [alice.id]);
// A principal can't borrow another person's run (a runner bug handing in the wrong delegator is refused, not obeyed).
const live = await agentRun(P("incident-investigator"));
out.borrowed = await settle(ops.invoke("envs.list", {}, { user: { id: admin.id, email: admin.email, role: "admin" }, via: "agent", principal: { ...live, delegatorId: admin.id, delegatorEmail: admin.email } }));
out.borrowedEvent = events.some((e) => e.op === "envs.list" && e.outcome === "denied" && /doesn't belong to that run/.test(e.reason));
// …and so is the run: a run that ended refuses a caller built while it ran.
await store.updateRun(p.runId, { state: "cancelled" });
out.cachedEnded = await settle(ops.invoke("envs.list", {}, cached));
// Account scope: the simulated account is 123456789012.
const acct = await agentRun({ ...P("incident-investigator"), scope: { account: "111111111111" } });
out.otherAccount = await invokeAs(acct, "envs.status", { env: "staging" });
out.otherAccountService = await invokeAs(acct, "services.get", { env: "staging", service: "api" });
const own = await agentRun({ ...P("incident-investigator"), scope: { account: "123456789012" } });
out.ownAccount = (await invokeAs(own, "services.get", { env: "staging", service: "api" })).ok?.kind;
// Tag scope works on ECS services (their tags come with the target).
const tags = (await ops.resolveTargets("services.get", { env: "staging", service: "api" }))[0].tags;
out.tagKey = Object.keys(tags ?? {}).length > 0;
const [k, v] = Object.entries(tags)[0];
const tagged = await agentRun({ ...P("incident-investigator"), scope: { tags: { [k]: v } } });
out.tagIn = (await invokeAs(tagged, "services.get", { env: "staging", service: "api" })).ok?.kind;
const wrongTag = await agentRun({ ...P("incident-investigator"), scope: { tags: { [k]: v + "-not" } } });
out.tagOut = await invokeAs(wrongTag, "services.get", { env: "staging", service: "api" });
// Child narrowing: a child run's narrowed policy is what binds it, whatever its parent may do.
const parentPol = { ...P("incident-investigator"), scope: { envs: ["staging", "production"] } };
const childPol = policy.narrow(parentPol, { ...P("incident-investigator"), scope: { envs: ["staging"] }, tools: { read: ["envs.status"], propose: [], act: [], deny: [] } });
out.broaderChild = await settle(Promise.resolve().then(() => policy.narrow(childPol, parentPol)));
const child = await agentRun(childPol);
out.childRead = (await invokeAs(child, "envs.status", { env: "staging" })).ok?.kind;
out.childOutside = await invokeAs(child, "envs.status", { env: "production" });
out.childTool = await invokeAs(child, "services.get", { env: "staging", service: "api" });
out.childChange = await invokeAs(child, "services.restart", { env: "staging", service: "api", confirm: "yes" });
// R01 through the registry: an inventory resource whose tags weren't read is never changed by an agent — not even
// as an approval request — while other unread security metadata is refused when the policy needs it complete.
const big = await agentRun({ ...P("incident-investigator"), tools: { ...P("incident-investigator").tools, propose: ["cloud.action"] } }, admin);
const key = "ecs:service/acme-staging/api";
const deploy = { key, provider: "ecs-image", action: "deploy-image", input: { image: "123456789012.dkr.ecr.us-east-1.amazonaws.com/acme/storefront-api:1.2.3" }, confirm: "api", reason: "test" };
// The other regions merge into a new graph (fresh objects) after the home one is served: mark the resource only once
// that has landed, or a slow machine's merge replaces it between the mark and the call.
for (let i = 0; (await inv.inventoryCoverage()).pendingRegions.length && i < 600; i++) await new Promise((r) => setTimeout(r, 100));
const f = await inv.findResource(key);
f.resource.tagsUnread = true;
out.unreadTags = await invokeAs(big, "cloud.action", deploy);
out.unreadRead = (await invokeAs(big, "cloud.get", { key })).ok?.kind;
f.resource.tagsUnread = undefined;
f.resource.enrichment = { policy: "denied" };
out.unreadPolicy = await invokeAs(big, "cloud.action", deploy);
const lax = await agentRun({ ...P("incident-investigator"), evidence: { maximumAgeSeconds: 300, requireCompleteSecurityMetadata: false }, tools: { ...P("incident-investigator").tools, propose: ["cloud.action"] } }, admin);
out.unreadPolicyLax = (await invokeAs(lax, "cloud.action", deploy)).ok?.kind;
f.resource.enrichment = undefined;
// The inventory's console keys carry no account: it comes from the environment's cluster, so an account-scoped agent
// can still ask for a change there (and not in another account).
const scoped = (account) => ({ ...P("incident-investigator"), scope: { account }, tools: { ...P("incident-investigator").tools, propose: ["cloud.action"] } });
out.inventoryAccount = (await ops.resolveTargets("cloud.action", deploy))[0].account;
out.inventoryOwn = (await invokeAs(await agentRun(scoped("123456789012"), admin), "cloud.action", deploy)).ok?.kind;
out.inventoryOther = await invokeAs(await agentRun(scoped("111111111111"), admin), "cloud.action", deploy);
// A dry run is a tool call: it fires onAgentInvoke too (the runner records the plan).
const before = events.length;
const dry = await settle(as(own).then((c) => ops.invoke("services.restart", { env: "staging", service: "api", confirm: "yes" }, c, { dryRun: true })));
out.dry = dry.ok?.kind;
out.dryEvent = events.slice(before).map((e) => [e.op, e.outcome]);
// A call that fails (here: invalid input) fires too, as an error the runner records for the model to read.
const errBefore = events.length;
out.badInput = (await invokeAs(own, "services.get", { env: "staging" })).status;
out.badInputEvent = events.slice(errBefore).map((e) => [e.op, e.outcome]);
// A listener that throws is its own problem: the call goes on, and the other listeners still hear it.
const unsub = ops.onAgentInvoke(() => { throw new Error("listener bug"); });
const heard = events.length;
out.throwingListener = (await invokeAs(own, "envs.list", {})).ok?.kind;
out.othersHeard = events.length - heard;
unsub();
// Deciding is for people: not even a person's caller inside an agent context may approve.
out.decideInCtx = await settle(principals.withAgentContext(own, () => ops.decide(crypto.randomUUID(), { decision: "approve" }, person(admin))));
// Agents off: no new external tokens either.
await stop.setAgentsEnabled(false, "admin@acme.test");
out.mintOff = await settle(tokens.mintExternalToken(alice, "daily-digest", 7, { name: "late" }));
await stop.setAgentsEnabled(true, "admin@acme.test");
console.log(JSON.stringify(out));
`);
  assert.equal(o.cachedBefore, "approval");
  assert.equal(o.cachedDemoted.status, 403, "a demotion applies to a caller built before it");
  assert.match(o.cachedDemoted.error, /your role \(viewer\)/);
  assert.equal(o.cachedDisabled.status, 401);
  assert.deepEqual([o.cachedEnded.status, o.cachedEnded.code], [409, "run_finished"]);
  assert.deepEqual([o.borrowed.status, o.borrowed.code], [409, "principal_mismatch"]);
  assert.equal(o.borrowedEvent, true, "a refused identity still fires onAgentInvoke");
  assert.match(o.otherAccount.error, /another AWS account/);
  assert.match(o.otherAccountService.error, /another AWS account/);
  assert.equal(o.ownAccount, "result");
  assert.equal(o.tagKey, true);
  assert.equal(o.tagIn, "result");
  assert.match(o.tagOut.error, /doesn't carry the tag/);
  assert.match(o.broaderChild.error, /broader than its parent/);
  assert.equal(o.childRead, "result");
  assert.match(o.childOutside.error, /outside the agent's environments/);
  assert.match(o.childTool.error, /not one of the agent's tools/);
  assert.match(o.childChange.error, /not one of the agent's tools/);
  assert.equal(o.unreadTags.code, "policy_denied");
  assert.match(o.unreadTags.error, /security metadata \(tags\) of .* couldn't be read/);
  assert.equal(o.unreadRead, "result", "reading it is fine");
  assert.match(o.unreadPolicy.error, /policy: denied.*requires it complete/);
  assert.equal(o.unreadPolicyLax, "approval", "a danger action still goes to a person");
  assert.equal(o.inventoryAccount, "123456789012");
  assert.equal(o.inventoryOwn, "approval");
  assert.match(o.inventoryOther.error, /another AWS account/);
  assert.equal(o.dry, "plan");
  assert.deepEqual(o.dryEvent, [["services.restart", "result"]]);
  assert.deepEqual([o.mintOff.status, o.mintOff.code], [503, "agents_off"]);
  assert.equal(o.badInput, 400);
  assert.deepEqual(o.badInputEvent, [["services.get", "error"]]);
  assert.equal(o.throwingListener, "result");
  assert.equal(o.othersHeard, 1);
  assert.deepEqual([o.decideInCtx.status, o.decideInCtx.error], [403, "agents can't approve or reject requests"]);
});

test("the agent context lasts as long as the agent's call: work it left behind (a re-armed loop) never inherits it", () => {
  const o = run(`
const p = await agentRun(P("incident-investigator"));
const later = [];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
await principals.withAgentContext(p, async () => {
  // A timer that fires during the call sees the agent; one that fires after it (a loop re-armed from inside) doesn't.
  await new Promise((r) => setTimeout(() => { out.during = principals.currentAgentContext()?.runId === p.runId; r(); }, 5));
  setTimeout(async () => {
    out.after = principals.currentAgentContext() ?? null;
    later.push(await settle(ops.invoke("envs.list", {}, person(alice))).then((x) => x.ok?.kind ?? x.status));
  }, 40);
  out.outside = principals.outsideAgentContext(() => principals.currentAgentContext()) ?? null;
});
await wait(400);
out.personLater = later[0];
// Inside the call, the bypass guard holds as before.
out.inside = await settle(principals.withAgentContext(p, () => ops.invoke("envs.list", {}, person(alice))));
console.log(JSON.stringify(out));
`);
  assert.equal(o.during, true);
  assert.equal(o.after, null, "the scope closes when the call settles");
  assert.equal(o.outside, null, "outsideAgentContext starts work with no agent context");
  assert.equal(o.personLater, "result", "a person's call from work the agent's call left behind is not refused");
  assert.deepEqual(o.inside, { status: 500, error: "agent runs must use the agent identity" });
});

test("agent tokens: external tokens bind a definition's policy and a run; revoking stops the token and cancels the run", () => {
  const o = run(`
out.badDays = await settle(tokens.mintExternalToken(alice, "incident-investigator", 3, { name: "bot" }));
out.noDef = await settle(tokens.mintExternalToken(alice, "nope", 7, { name: "bot" }));
const t = await tokens.mintExternalToken(alice, "incident-investigator", 7, { name: "ci bot" });
out.shape = /^da_[A-Za-z0-9_-]{43}$/.test(t.token);
out.stored = (await db.get("SELECT COUNT(*) AS n FROM agent_tokens WHERE hash = ?", [t.token])).n; // only the hash is stored
const v = await tokens.verifyAgentToken(t.token);
out.verify = v.ok && { mode: v.id.principal.mode, runId: v.id.principal.runId === t.runId, delegator: v.id.user.email, kind: v.id.token.kind };
const run = await store.getRun(t.runId);
out.run = { kind: run.kind, state: run.state, deadline: run.deadline_at === t.expiresAt };
out.list = (await tokens.listAgentTokens(alice, false)).map((x) => [x.name, x.status, x.definitionId]);
out.notMine = await settle(tokens.revokeAgentToken({ ...admin, role: "developer" }, t.id));
// A run token: bound to its run; ends with it.
const pr = await agentRun(P("incident-investigator"));
const rt = await tokens.mintRunToken(pr.runId, pr, 60_000);
out.runTokenOk = (await tokens.verifyAgentToken(rt)).ok;
out.wrongPrincipal = await settle(tokens.mintRunToken(pr.runId, { ...pr, policyHash: "sha256:x" }, 60_000));
// The run's hash with another person's (or another principal's) identity: refused at minting, not only when used.
out.borrowedDelegator = await settle(tokens.mintRunToken(pr.runId, { ...pr, delegatorId: admin.id, delegatorEmail: admin.email }, 60_000));
out.borrowedId = await settle(tokens.mintRunToken(pr.runId, { ...pr, id: "agent:someone-else" }, 60_000));
await store.updateRun(pr.runId, { state: "succeeded" });
out.runTokenAfterEnd = await tokens.verifyAgentToken(rt);
// Revocation.
await tokens.revokeAgentToken(alice, t.id);
out.revoked = await tokens.verifyAgentToken(t.token);
out.runAfter = (await store.getRun(t.runId)).state;
out.audit = (await db.all("SELECT action FROM audit WHERE action LIKE 'agent_token.%' ORDER BY at")).map((r) => r.action);
// The REST routes (§3.5): people only; GET lists mine (admins: ?all=1), POST shows the token once, DELETE revokes.
const { NextRequest } = await import("next/server.js");
const coll = await import(src("app/api/agents/tokens/route.ts"));
const one = await import(src("app/api/agents/tokens/[id]/route.ts"));
const hdr = (u, via = "session") => ({ "x-console-user-id": u.id, "x-console-user-email": u.email, "x-console-user-role": u.role, "x-console-auth-via": via, "content-type": "application/json" });
const req = (path, u, o = {}) => new NextRequest("http://127.0.0.1:3200" + path, { method: o.method ?? "GET", headers: { ...hdr(u, o.via), ...(o.headers ?? {}) }, ...(o.body ? { body: JSON.stringify(o.body) } : {}) });
const jr = async (r) => ({ status: r.status, body: await r.json() });
const created = await jr(await coll.POST(req("/api/agents/tokens", alice, { method: "POST", body: { name: "route bot", definitionId: "daily-digest", days: 30 } }), {}));
out.routePost = { status: created.status, keys: Object.keys(created.body).sort(), shape: /^da_/.test(created.body.token), mcp: String(created.body.mcpUrl).endsWith(":3200/api/mcp") };
out.routeBad = (await jr(await coll.POST(req("/api/agents/tokens", alice, { method: "POST", body: { name: "x", definitionId: "daily-digest", days: 14 } }), {}))).status;
const listed = (await jr(await coll.GET(req("/api/agents/tokens", alice), {}))).body.tokens;
out.routeList = { names: listed.map((x) => x.name), noSecret: listed.every((x) => !("token" in x) && !("hash" in x)), keys: ["id", "name", "kind", "definitionId", "prefix", "createdAt", "expiresAt", "lastUsedAt", "revokedAt", "uses"].every((k) => k in listed[0]) };
out.routeAllNonAdmin = (await coll.GET(req("/api/agents/tokens?all=1", alice), {})).status;
out.routeAllAdmin = (await jr(await coll.GET(req("/api/agents/tokens?all=1", admin), {}))).body.tokens.length >= 2;
out.routeAsAgent = (await coll.GET(req("/api/agents/tokens", alice, { via: "agent", headers: { "x-console-agent-principal": created.body.id, "x-console-agent-run": created.body.runId } }), {})).status;
out.routeDeleteOther = (await one.DELETE(req("/api/agents/tokens/" + created.body.id, { ...bob, role: "developer" }, { method: "DELETE" }), { params: Promise.resolve({ id: created.body.id }) })).status;
const del = await jr(await one.DELETE(req("/api/agents/tokens/" + created.body.id, alice, { method: "DELETE" }), { params: Promise.resolve({ id: created.body.id }) }));
out.routeDelete = [del.status, del.body.token.status];
// A changed policy under a live token is refused.
const t2 = await tokens.mintExternalToken(alice, "daily-digest", 30, { name: "bot2" });
await db.run("UPDATE agent_runs SET policy_hash = 'sha256:other' WHERE id = ?", [t2.runId]);
tokens.forgetAgentTokens();
out.policyChanged = await tokens.verifyAgentToken(t2.token);
console.log(JSON.stringify(out));
`);
  assert.equal(o.badDays.status, 400);
  assert.equal(o.noDef.status, 404);
  assert.equal(o.shape, true);
  assert.equal(o.stored, 0);
  assert.deepEqual(o.verify, { mode: "propose", runId: true, delegator: "alice@acme.test", kind: "external" });
  assert.deepEqual(o.run, { kind: "external", state: "running", deadline: true });
  assert.deepEqual(o.list, [["ci bot", "active", "incident-investigator"]]);
  assert.equal(o.notMine.status, 404);
  assert.equal(o.runTokenOk, true);
  assert.equal(o.wrongPrincipal.status, 409);
  assert.deepEqual([o.borrowedDelegator.status, o.borrowedId.status], [409, 409], "a run token carries the run's own principal");
  assert.deepEqual(o.runTokenAfterEnd, { ok: false, error: "invalid or revoked agent token" }, "a run that ends takes its token with it");
  assert.equal(o.revoked.ok, false);
  assert.equal(o.runAfter, "cancelled");
  assert.deepEqual(o.audit, ["agent_token.create", "agent_token.revoke"]);
  assert.match(o.policyChanged.error, /policy changed/);
  assert.deepEqual(o.routePost, { status: 201, keys: ["expiresAt", "id", "mcpUrl", "runId", "token"], shape: true, mcp: true });
  assert.equal(o.routeBad, 400);
  assert.deepEqual(o.routeList, { names: ["route bot", "ci bot"], noSecret: true, keys: true }, "active first (newest first), then the revoked one");
  assert.equal(o.routeAllNonAdmin, 403);
  assert.equal(o.routeAllAdmin, true);
  assert.equal(o.routeAsAgent, 403, "agents never manage tokens");
  assert.equal(o.routeDeleteOther, 404);
  assert.deepEqual(o.routeDelete, [200, "revoked"]);
});

test("§9.2 approvals: exact plan, run as the agent not the approver, single use, concurrent decisions, staleness, expiry", () => {
  const o = run(`
// Room for several changes per resource, so the grant's own rules are what refuse a reuse (not the hourly limit).
const p = await agentRun({ ...P("incident-investigator"), limits: { ...P("incident-investigator").limits, mutationsPerResourcePerHour: 5, concurrentMutations: 3 } });
const restart = { env: "staging", service: "api", confirm: "yes" };
const a = await invokeAs(p, "services.restart", restart);
out.kind = a.ok.kind;
const id = a.ok.approval.id;
const row = await db.get("SELECT run_id, grant_id, plan_hash, token_id, requested_by FROM approvals WHERE id = ?", [id]);
out.row = { run: row.run_id === p.runId, grant: !!row.grant_id, hash: /^sha256:/.test(row.plan_hash), token: row.token_id, by: row.requested_by === alice.id };
out.view = { run: a.ok.approval.run?.id === p.runId, owner: a.ok.approval.owner.email };
out.runWaiting = (await store.getRun(p.runId)).state;
out.dup = (await invokeAs(p, "services.restart", restart)).ok.approval.id === id;
out.agentDecides = await settle(ops.decide(id, { decision: "approve" }, await as(p)));
const opsBefore = (await db.get("SELECT COUNT(*) AS n FROM operations")).n;
const d = await ops.decide(id, { decision: "approve", confirm: "yes" }, person(admin));
out.decided = { status: d.approval.status, result: d.result };
out.notRunByApprover = (await db.get("SELECT COUNT(*) AS n FROM operations")).n === opsBefore;
const exec = await db.get("SELECT id, kind, state, grant_id, idempotency_key FROM agent_steps WHERE run_id = ? AND kind = 'execute'", [p.runId]);
out.exec = { state: exec.state, grant: exec.grant_id === row.grant_id, key: exec.idempotency_key };
out.runAfterDecision = (await store.getRun(p.runId)).state;
// The execute step, as the runner will run it: as the agent, with the grant.
const ex = await grants.grantExecution(row.grant_id, JSON.parse((await db.get("SELECT input FROM agent_steps WHERE id = ?", [exec.id])).input).human);
const done = await settle(ops.invoke(ex.op, ex.input, await as(p, { grantId: row.grant_id, stepId: exec.id })));
out.done = done.ok?.kind ?? done;
const op = await db.get("SELECT actor, actor_kind, run_id, step_id, grant_id, idempotency_key FROM operations ORDER BY created_at DESC LIMIT 1");
out.op = { kind: op.actor_kind, run: op.run_id === p.runId, step: op.step_id === exec.id, grant: op.grant_id === row.grant_id, actor: op.actor, key: op.idempotency_key?.startsWith("run:" + p.runId + ":step:" + exec.id) };
out.approvalAfter = (await ops.getApprovalView(id, person(admin))).status;
out.decisionAudit = (await db.all("SELECT phase, result, actor FROM audit WHERE action = 'approval.approve' ORDER BY at")).map((r) => [r.phase, r.result, r.actor]);
out.reuse = await settle(ops.invoke(ex.op, ex.input, await as(p, { grantId: row.grant_id })));
// Concurrent decisions: exactly one wins.
const b = (await invokeAs(p, "services.restart", { env: "staging", service: "worker", confirm: "yes" })).ok.approval.id;
const both = await Promise.all([settle(ops.decide(b, { decision: "approve", confirm: "yes" }, person(admin))), settle(ops.decide(b, { decision: "reject", reason: "no" }, person(bob)))]);
out.race = both.map((x) => (x.ok ? "won" : x.status)).sort();
// A changed resource invalidates: the plan is re-made when a person approves.
const c = (await invokeAs(p, "services.restart", { env: "staging", service: "billing", confirm: "yes" })).ok.approval.id;
const scaled = await settle(ops.invoke("services.scale", { env: "staging", service: "billing", desired: 2, confirm: "yes" }, person(admin)));
out.scaled = scaled.ok ? "ok" : scaled.error;
out.stale = await settle(ops.decide(c, { decision: "approve", confirm: "yes" }, person(admin)));
out.staleView = await ops.getApprovalView(c, person(admin)).then((v) => [v.status, v.detail]);
out.staleGrant = (await db.get("SELECT invalidation_reason FROM approval_grants WHERE approval_id = ?", [c])).invalidation_reason;
// Expiry.
const e = (await invokeAs(p, "services.restart", { env: "staging", service: "caddy", confirm: "yes" })).ok.approval.id;
await db.run("UPDATE approval_grants SET expires_at = 1 WHERE approval_id = ?", [e]);
out.expiredView = (await ops.getApprovalView(e, person(admin))).status;
out.expired = await settle(ops.decide(e, { decision: "approve", confirm: "yes" }, person(admin)));
// Two-person mode: the delegator can't approve what their agent asked for.
process.env.CONSOLE_APPROVALS_TWO_PERSON = "true";
const p2 = await agentRun(P("incident-investigator"), admin);
const f = (await invokeAs(p2, "services.restart", { env: "staging", service: "redis", confirm: "yes" })).ok.approval.id;
out.twoPerson = await settle(ops.decide(f, { decision: "approve", confirm: "yes" }, person(admin)));
out.twoPersonOther = (await ops.decide(f, { decision: "approve", confirm: "yes" }, person(bob))).approval.status;
delete process.env.CONSOLE_APPROVALS_TWO_PERSON;
// The agent sees its own run's approvals only.
out.agentList = (await ops.listApprovalViews(await as(p), { status: "all" })).every((v) => v.run?.id === p.runId);
out.agentOther = await settle(ops.getApprovalView(f, await as(p)));
console.log(JSON.stringify(out));
`);
  assert.equal(o.kind, "approval");
  assert.deepEqual(o.row, { run: true, grant: true, hash: true, token: null, by: true });
  assert.deepEqual(o.view, { run: true, owner: "alice@acme.test" });
  assert.equal(o.runWaiting, "waiting_approval");
  assert.equal(o.dup, true, "the same request again returns the pending one");
  assert.equal(o.agentDecides.status, 403);
  assert.equal(o.decided.status, "approved");
  assert.equal(o.decided.result, undefined, "approving an agent's request doesn't run it");
  assert.equal(o.notRunByApprover, true);
  assert.equal(o.exec.state, "queued");
  assert.equal(o.exec.grant, true);
  assert.match(o.exec.key, /^grant:/);
  assert.equal(o.runAfterDecision, "running");
  assert.equal(o.done, "result");
  assert.equal(o.op.kind, "agent");
  assert.equal(o.op.run, true);
  assert.equal(o.op.step, true);
  assert.equal(o.op.grant, true);
  assert.equal(o.op.key, true, "the step's idempotency key");
  assert.match(o.op.actor, /^agent run [0-9a-f]{8} for alice@acme.test$/);
  assert.equal(o.approvalAfter, "done");
  assert.deepEqual(o.decisionAudit, [["intent", null, "admin@acme.test"], ["result", "ok", "admin@acme.test"]], "the decision: intent first, result with it");
  assert.deepEqual([o.reuse.status, o.reuse.code], [409, "grant_invalid"], "a grant is single use");
  assert.deepEqual(o.race, [409, "won"]);
  assert.equal(o.scaled, "ok");
  assert.deepEqual([o.stale.status, o.stale.code], [409, "plan_changed"]);
  assert.equal(o.staleView[0], "rejected");
  assert.match(o.staleView[1], /invalidated: the plan changed/);
  assert.match(o.staleGrant, /plan changed/);
  assert.equal(o.expiredView, "expired");
  assert.equal(o.expired.status, 409);
  assert.match(o.expired.error, /expired/);
  assert.equal(o.twoPerson.status, 403);
  assert.equal(o.twoPersonOther, "approved");
  assert.equal(o.agentList, true);
  assert.equal(o.agentOther.status, 404);
});

test("§9.2 an approval given after the run's time limit still runs: grant-bound executions and verify steps don't count run time", () => {
  const o = run(`
const p = await agentRun(P("incident-investigator")); // runtimeSeconds 600
const a = (await invokeAs(p, "services.restart", { env: "staging", service: "api", confirm: "yes" })).ok.approval;
// A second request whose grant expired: no longer pending in the list or the badge count (the view says expired).
const b = (await invokeAs(p, "services.restart", { env: "staging", service: "worker", confirm: "yes" })).ok.approval;
await db.run("UPDATE approval_grants SET expires_at = 1 WHERE approval_id = ?", [b.id]);
out.pending = { count: await ops.pendingCount(person(admin)), list: (await ops.listApprovalViews(person(admin), { status: "pending" })).map((v) => v.id === a.id ? "a" : v.id === b.id ? "b" : "?"), b: (await ops.getApprovalView(b.id, person(admin))).status };
// A rejected request stays rejected when its grant is invalidated afterwards (e.g. the token is revoked).
const c = (await invokeAs(p, "services.restart", { env: "staging", service: "billing", confirm: "yes" })).ok.approval;
await ops.decide(c.id, { decision: "reject", reason: "not now" }, person(admin));
const gc = (await db.get("SELECT grant_id FROM approvals WHERE id = ?", [c.id])).grant_id;
out.invalidatedRejected = await grants.invalidateGrant(gc, "agent token revoked");
out.rejectedStays = [grants.grantStatus(await grants.getGrant(gc)), (await ops.getApprovalView(c.id, person(admin))).detail];
// The run started 11 minutes ago; the approval (open for 15) comes now.
await db.run("UPDATE agent_runs SET created_at = ? WHERE id = ?", [Date.now() - 11 * 60_000, p.runId]);
out.lateRead = await invokeAs(p, "envs.status", { env: "staging" });
await ops.decide(a.id, { decision: "approve", confirm: "yes" }, person(admin));
const row = await db.get("SELECT grant_id FROM approvals WHERE id = ?", [a.id]);
const step = await db.get("SELECT id, input FROM agent_steps WHERE run_id = ? AND kind = 'execute' AND grant_id = ?", [p.runId, row.grant_id]);
const ex = await grants.grantExecution(row.grant_id, JSON.parse(step.input).human);
const done = await settle(as(p, { grantId: row.grant_id, stepId: step.id }).then((c) => ops.invoke(ex.op, ex.input, c)));
out.done = done.ok?.kind ?? done;
// The run's verify step reads after the limit too.
const verify = await store.appendStep(p.runId, { kind: "verify", name: "verify the restart", input: {} });
out.verifyRead = (await settle(as(p, { stepId: verify.id }).then((c) => ops.invoke("envs.status", { env: "staging" }, c)))).ok?.kind;
console.log(JSON.stringify(out));
`);
  assert.equal(o.lateRead.status, 403, "an ordinary call after the time limit is still refused");
  assert.match(o.lateRead.error, /time limit \(600 s\) is reached/);
  assert.equal(o.done, "result", "the change a person approved at minute 11 runs");
  assert.equal(o.verifyRead, "result");
  assert.deepEqual(o.pending, { count: 1, list: ["a"], b: "expired" }, "an agent request whose grant expired isn't counted as pending");
  assert.equal(o.invalidatedRejected, false);
  assert.deepEqual(o.rejectedStays, ["rejected", "not now"], "a person's rejection isn't turned into an invalidation");
});

test("POST /api/assistant refuses a question that looks like it contains a secret, before any run exists", () => {
  const o = run(`
const { NextRequest } = await import("next/server.js");
const route = await import(src("app/api/assistant/route.ts"));
const headers = { "x-console-user-id": alice.id, "x-console-user-email": alice.email, "x-console-user-role": alice.role, "x-console-auth-via": "session", "content-type": "application/json" };
const r = await route.POST(new NextRequest("http://127.0.0.1:3200/api/assistant", { method: "POST", headers, body: JSON.stringify({ question: "it fails with key AKIAIOSFODNN7EXAMPLE", connectionId: "none" }) }), {});
out.secret = { status: r.status, body: await r.json() };
out.runs = Number((await db.get("SELECT COUNT(*) AS n FROM agent_runs")).n);
console.log(JSON.stringify(out));
`);
  assert.equal(o.secret.status, 400);
  assert.equal(o.secret.body.code, "secret_in_question");
  assert.equal(o.runs, 0);
});

test("§9.2 approvals, continued: drift after approval, another run's grant, ended runs, demoted delegators, the grant's expiry", () => {
  const o = run(`
const roomy = { ...P("incident-investigator"), limits: { ...P("incident-investigator").limits, mutationsPerResourcePerHour: 5, concurrentMutations: 3 } };
const p = await agentRun(roomy);
const ask = async (pr, service) => (await invokeAs(pr, "services.restart", { env: "staging", service, confirm: "yes" })).ok.approval;
const grantOf = async (approvalId) => db.get("SELECT id, invalidated_at, invalidation_reason, consumed_at, expires_at, requested_at FROM approval_grants WHERE approval_id = ?", [approvalId]);
const execOf = async (pr, g) => {
  const step = await db.get("SELECT id, input FROM agent_steps WHERE run_id = ? AND kind = 'execute' AND grant_id = ?", [pr.runId, g]);
  const ex = await grants.grantExecution(g, JSON.parse(step.input).human);
  return settle(as(pr, { grantId: g, stepId: step.id }).then((c) => ops.invoke(ex.op, ex.input, c)));
};
// The approval card shows the grant's own expiry (the policy's 15 minutes), not the 24 h of an API token's request.
const a = await ask(p, "worker");
const ga = await grantOf(a.id);
out.expiresAt = a.expiresAt === Number(ga.expires_at) && a.expiresAt - Number(ga.requested_at) === 900_000;
// Drift after the approval: the service changed between the decision and the execution — the grant refuses, once.
await ops.decide(a.id, { decision: "approve", confirm: "yes" }, person(admin));
await ops.invoke("services.scale", { env: "staging", service: "worker", desired: 3, confirm: "yes" }, person(admin));
out.drift = await execOf(p, ga.id);
const gaAfter = await grantOf(a.id);
out.driftGrant = { invalidated: !!gaAfter.invalidated_at, reason: gaAfter.invalidation_reason, consumed: gaAfter.consumed_at };
out.driftView = await ops.getApprovalView(a.id, person(admin)).then((v) => [v.status, v.detail]);
// Another run's grant: refused, and left alone (one agent can't use up or spoil another's request).
const other = await agentRun(roomy);
const b = await ask(p, "billing");
await ops.decide(b.id, { decision: "approve", confirm: "yes" }, person(admin));
const gb = await grantOf(b.id);
const ex = await grants.grantExecution(gb.id, {});
out.foreign = await settle(as(other, { grantId: gb.id }).then((c) => ops.invoke(ex.op, ex.input, c)));
out.foreignGrant = (await grantOf(b.id)).invalidated_at;
out.ownAfterForeign = (await execOf(p, gb.id)).ok?.kind;
// A run that ended before anyone decided: the request is withdrawn, not approvable.
const q = await agentRun(roomy);
const c = await ask(q, "caddy");
await store.updateRun(q.runId, { state: "cancelled", error: "stopped by a person" });
out.endedView = await ops.getApprovalView(c.id, person(admin)).then((v) => [v.status, v.detail]);
out.ended = await settle(ops.decide(c.id, { decision: "approve", confirm: "yes" }, person(admin)));
out.endedGrant = (await grantOf(c.id)).invalidation_reason;
// The run's policy was changed under a waiting request: the request was made under another policy, so it's withdrawn.
const pc = await agentRun(roomy);
const pcReq = await ask(pc, "worker");
const edited = { ...roomy, limits: { ...roomy.limits, toolCalls: roomy.limits.toolCalls - 1 } };
await db.run("UPDATE agent_runs SET policy = ?, policy_hash = ? WHERE id = ?", [JSON.stringify(edited), policy.policyHash(edited), pc.runId]);
out.policyEdited = await settle(ops.decide(pcReq.id, { decision: "approve", confirm: "yes" }, person(admin)));
out.policyEditedGrant = (await grantOf(pcReq.id)).invalidation_reason;
// The person the agent acts for was demoted (or disabled) before anyone decided: approving can only fail, so it's refused.
const r = await agentRun(roomy);
const d = await ask(r, "redis");
await db.run("UPDATE users SET role = 'viewer' WHERE id = ?", [alice.id]);
out.demoted = await settle(ops.decide(d.id, { decision: "approve", confirm: "yes" }, person(admin)));
out.demotedGrant = (await grantOf(d.id)).invalidation_reason;
await db.run("UPDATE users SET role = 'operator' WHERE id = ?", [alice.id]);
// Rejecting still works for a demoted delegator's requests.
const e = await ask(r, "worker");
await db.run("UPDATE users SET role = 'viewer' WHERE id = ?", [alice.id]);
out.rejectDemoted = (await ops.decide(e.id, { decision: "reject", reason: "no" }, person(admin))).approval.status;
await db.run("UPDATE users SET role = 'operator' WHERE id = ?", [alice.id]);
console.log(JSON.stringify(out));
`);
  assert.equal(o.expiresAt, true);
  assert.deepEqual([o.drift.status, o.drift.code], [409, "grant_invalid"]);
  assert.equal(o.driftGrant.invalidated, true);
  assert.match(o.driftGrant.reason, /the plan changed/);
  assert.equal(o.driftGrant.consumed, null, "an invalidated grant is never consumed");
  assert.equal(o.driftView[0], "rejected", "the approval card shows the change didn't run…");
  assert.match(o.driftView[1], /^invalidated: the plan changed/, "…and why");
  assert.deepEqual([o.foreign.status, o.foreign.code], [409, "grant_invalid"]);
  assert.equal(o.foreignGrant, null, "another run's grant is untouched");
  assert.equal(o.ownAfterForeign, "result", "…and still runs for its own run");
  assert.equal(o.endedView[0], "expired");
  assert.match(o.endedView[1], /run ended \(cancelled\)/);
  assert.deepEqual([o.ended.status, o.ended.code], [409, "run_finished"]);
  assert.match(o.endedGrant, /run ended/);
  assert.deepEqual([o.policyEdited.status, o.policyEdited.code], [409, "policy_changed"]);
  assert.match(o.policyEditedGrant, /policy changed/);
  assert.deepEqual([o.demoted.status, o.demoted.code], [409, "delegator_changed"]);
  assert.match(o.demotedGrant, /now viewer/);
  assert.equal(o.rejectDemoted, "rejected");
});

test("§9.2 a different image digest: a person deploys another image while an agent's requests wait — every plan that named the old image is invalidated", () => {
  const o = run(`
const p = await agentRun({ ...P("incident-investigator"), tools: { ...P("incident-investigator").tools, propose: ["services.restart", "cloud.action"] }, limits: { ...P("incident-investigator").limits, mutationsPerResourcePerHour: 5 } }, admin);
const key = "ecs:service/acme-staging/api";
const registry = "123456789012.dkr.ecr.us-east-1.amazonaws.com/acme/storefront-api";
const restart = (await invokeAs(p, "services.restart", { env: "staging", service: "api", confirm: "yes" })).ok.approval;
const deploy = (await invokeAs(p, "cloud.action", { key, provider: "ecs-image", action: "deploy-image", input: { image: registry + ":2.0.0" }, confirm: "api", reason: "ship 2.0.0" })).ok.approval;
out.kinds = [restart.status, deploy.status];
// A person deploys another image (a new digest) to the same service, and the rollout finishes.
const dry = await ops.invoke("cloud.action", { key, provider: "ecs-image", action: "deploy-image", input: { image: registry + "@sha256:" + "a".repeat(64) }, confirm: "x", reason: "hotfix" }, person(admin), { dryRun: true });
await ops.invoke("cloud.action", { key, provider: "ecs-image", action: "deploy-image", input: { image: registry + "@sha256:" + "a".repeat(64), expectedRevision: dry.plan.echo.expectedRevision }, confirm: dry.plan.confirm, reason: "hotfix" }, person(admin));
const realNow = Date.now;
Date.now = () => realNow() + 30_000; // the simulated rollout completes after 24 s
out.restart = await settle(ops.decide(restart.id, { decision: "approve", confirm: "yes" }, person(admin)));
out.deploy = await settle(ops.decide(deploy.id, { decision: "approve", confirm: "api", reason: "ok" }, person(admin)));
out.reasons = (await db.all("SELECT invalidation_reason FROM approval_grants WHERE run_id = ? ORDER BY requested_at", [p.runId])).map((r) => r.invalidation_reason);
Date.now = realNow;
console.log(JSON.stringify(out));
`);
  assert.deepEqual(o.kinds, ["pending", "pending"]);
  assert.deepEqual([o.restart.status, o.restart.code], [409, "plan_changed"]);
  assert.deepEqual([o.deploy.status, o.deploy.code], [409, "plan_changed"]);
  for (const r of o.reasons) assert.match(r, /plan changed/);
});

test("API-token approvals bind the exact plan too; the audit actor names the requester", () => {
  const o = run(`
const { createToken } = await import(src("lib/server/auth/api-tokens.ts"));
const t = await createToken(admin, { name: "bot", role: "operator", mode: "propose", expiresInDays: 7 });
const tc = { user: { id: admin.id, email: admin.email, role: "operator" }, via: "token", tokenId: t.item.id, tokenName: "bot", tokenMode: "propose" };
const a = await ops.invoke("services.restart", { env: "staging", service: "api", confirm: "yes" }, tc);
out.hash = /^sha256:/.test((await db.get("SELECT plan_hash FROM approvals WHERE id = ?", [a.approval.id])).plan_hash);
const ok = await ops.decide(a.approval.id, { decision: "approve", confirm: "yes" }, person(bob));
out.ran = ok.approval.status;
out.actor = (await db.get("SELECT actor FROM audit WHERE action = 'services.restart' ORDER BY at DESC LIMIT 1")).actor;
const b = await ops.invoke("services.restart", { env: "staging", service: "worker", confirm: "yes" }, tc);
await ops.invoke("services.scale", { env: "staging", service: "worker", desired: 2, confirm: "yes" }, person(admin));
out.stale = await settle(ops.decide(b.approval.id, { decision: "approve", confirm: "yes" }, person(bob)));
out.staleStatus = (await ops.getApprovalView(b.approval.id, person(bob))).status;
console.log(JSON.stringify(out));
`);
  assert.equal(o.hash, true);
  assert.equal(o.ran, "done");
  assert.match(o.actor, /approving token "bot" \(requested by admin@acme.test\)/);
  assert.deepEqual([o.stale.status, o.stale.code], [409, "plan_changed"]);
  assert.equal(o.staleStatus, "rejected");
});

test("§9.7: a scale on an autoscaled service is never bounded-act; agents can't acknowledge migrations", () => {
  const o = run(`
out.autoscaled = (await ops.resolveTargets("services.scale", { env: "production", service: "api", desired: 3 }))[0].autoscaled;
out.notAutoscaled = (await ops.resolveTargets("services.scale", { env: "staging", service: "api", desired: 3 }))[0].autoscaled;
const key = (await ops.resolveTargets("services.switch", { env: "staging", service: "api" }))[0].key;
const pol = { ...P("incident-investigator"), mode: "bounded-act", scope: { envs: ["staging"], keys: [key] }, tools: { read: ["*"], propose: ["services.switch", "services.restart"], act: ["services.switch", "services.restart"], deny: [] } };
const p = await agentRun(pol, admin);
const { revisions } = await import(src("lib/server/console.ts"));
const revs = await revisions("staging", "api");
const target = revs.find((r) => !r.live && (r.migrations === true || r.migrations === "unknown"));
out.migrations = target?.migrations;
out.ack = await invokeAs(p, "services.switch", { env: "staging", service: "api", revision: target.revision, migrationAck: true, confirm: "yes" });
const sw = await invokeAs(p, "services.switch", { env: "staging", service: "api", revision: target.revision, confirm: "yes" });
out.switch = sw.ok?.kind ?? sw;
out.reason = events.filter((e) => e.op === "services.switch").map((e) => e.reason).pop();
// A listed, unprotected routine change runs on its own (bounded-act), as the agent.
const r = await invokeAs(p, "services.restart", { env: "staging", service: "api", confirm: "yes" });
out.bounded = r.ok?.kind ?? r;
out.boundedOp = (await db.get("SELECT actor_kind, run_id FROM operations ORDER BY created_at DESC LIMIT 1"));
out.boundedOp.run_id = out.boundedOp.run_id === p.runId;
// Through the registry: a bounded-act agent listed for staging/worker may scale it — unless Application Auto Scaling
// manages it, when the same call becomes a request for a person (with the autoscaler's reason).
const disc = await import(src("lib/server/discovery.ts"));
const con = await import(src("lib/server/console.ts"));
const wkey = (await ops.resolveTargets("services.scale", { env: "staging", service: "worker" }))[0].key;
const scaler = await agentRun({ ...P("incident-investigator"), mode: "bounded-act", scope: { envs: ["staging"], keys: [wkey] }, tools: { read: ["*"], propose: ["services.scale"], act: ["services.scale"], deny: [] }, limits: { ...P("incident-investigator").limits, mutationsPerResourcePerHour: 5 } }, admin);
const live = await con.liveService(await disc.envInfo("staging"), "worker");
live.scalable = { min: 1, max: 4, policies: ["target tracking (CPU 60 %)"] };
const auto = await invokeAs(scaler, "services.scale", { env: "staging", service: "worker", desired: 2, confirm: "yes" });
out.autoScale = auto.ok?.kind ?? auto;
out.autoReason = events.filter((e) => e.op === "services.scale").map((e) => e.reason).pop();
delete live.scalable;
const plain = await invokeAs(scaler, "services.scale", { env: "staging", service: "worker", desired: 3, confirm: "yes" });
out.plainScale = plain.ok?.kind ?? plain;
// A service tagged console:protected is protected on an unprotected environment too: never bounded-act.
const fresh = await con.liveService(await disc.envInfo("staging"), "worker"); // the scale above refreshed the cache
const savedTags = fresh.tags;
fresh.tags = { ...savedTags, "console:protected": "true" };
out.tagProtected = (await ops.resolveTargets("services.scale", { env: "staging", service: "worker" }))[0].protected;
const tagged = await invokeAs(scaler, "services.scale", { env: "staging", service: "worker", desired: 1, confirm: "yes" });
out.taggedScale = tagged.ok?.kind ?? tagged;
out.taggedReason = events.filter((e) => e.op === "services.scale").map((e) => e.reason).pop();
fresh.tags = savedTags;
out.untagged = (await ops.resolveTargets("services.scale", { env: "staging", service: "worker" }))[0].protected;
// hosts.terminate names its instance \`id\`: the target is that host, not the whole environment.
const cat = await disc.catalog("staging");
const hostId = cat.hosts[0]?.id;
const term = (await ops.resolveTargets("hosts.terminate", { env: "staging", id: hostId, confirm: hostId, reason: "test" }))[0];
out.terminateTarget = { kind: term.kind, level: term.level ?? "resource", named: [term.key, ...(term.aliases ?? [])].some((k) => k.includes(hostId)) };
// Rolling back across changed (or unchecked) migrations: the person acknowledges it when approving, and the change
// then runs as the agent with the acknowledgement (never one the agent supplied).
const roll = await agentRun({ ...pol, limits: { ...pol.limits, mutationsPerResourcePerHour: 5, concurrentMutations: 3 } }, admin);
const req = await invokeAs(roll, "services.switch", { env: "staging", service: "api", revision: target.revision, confirm: "yes" });
const swId = req.ok.approval.id;
out.noAck = await settle(ops.decide(swId, { decision: "approve", confirm: "yes" }, person(bob)));
out.acked = (await ops.decide(swId, { decision: "approve", confirm: "yes", migrationAck: true }, person(bob))).approval.status;
const gid = (await db.get("SELECT grant_id FROM approvals WHERE id = ?", [swId])).grant_id;
const step = await db.get("SELECT id, input FROM agent_steps WHERE run_id = ? AND kind = 'execute' AND grant_id = ?", [roll.runId, gid]);
const ex = await grants.grantExecution(gid, JSON.parse(step.input).human);
out.exAck = ex.input.migrationAck;
const realNow = Date.now;
Date.now = () => realNow() + 30_000; // the restart above is still rolling out; the simulated rollout ends after 24 s
const ran = await settle(ops.invoke(ex.op, ex.input, await as(roll, { grantId: gid, stepId: step.id })));
Date.now = realNow;
out.ranSwitch = ran.ok?.kind ?? ran;
console.log(JSON.stringify(out));
`);
  assert.equal(o.autoscaled, true);
  assert.equal(o.notAutoscaled, false);
  assert.ok(o.migrations === true || o.migrations === "unknown", `the demo's staging api has migrations between revisions (${o.migrations})`);
  assert.equal(o.ack.status, 400);
  assert.match(o.ack.error, /migrationAck: only a person/);
  assert.equal(o.switch, "approval");
  assert.match(o.reason, /migrations changed/);
  assert.equal(o.bounded, "result");
  assert.deepEqual(o.boundedOp, { actor_kind: "agent", run_id: true });
  assert.equal(o.autoScale, "approval", "an autoscaled service's scale is never bounded-act");
  assert.match(o.autoReason, /Auto Scaling/);
  assert.equal(o.plainScale, "result", "the same agent scales a service no autoscaler manages on its own");
  assert.deepEqual([o.tagProtected, o.untagged], [true, false]);
  assert.equal(o.taggedScale, "approval", "a console:protected service is never bounded-act");
  assert.match(o.taggedReason, /protected resources always need a person/);
  assert.deepEqual(o.terminateTarget, { kind: "ec2", level: "resource", named: true });
  assert.equal(o.noAck.status, 400);
  assert.match(o.noAck.error, /migrationAck: true/);
  assert.equal(o.acked, "approved");
  assert.equal(o.exAck, true, "the approver's acknowledgement reaches the execute step");
  assert.equal(o.ranSwitch, "result", "the rollback runs as the agent under the grant");
});

test("the proxy: agent tokens reach only the agent routes, as the agent (forged headers and cookies dropped), throttled like API tokens, refused while agents are off", () => {
  const o = run(`
const { NextRequest } = await import("next/server.js");
const { proxy } = await import(src("proxy.ts"));
const { createToken } = await import(src("lib/server/auth/api-tokens.ts"));
const t = await tokens.mintExternalToken(alice, "daily-digest", 7, { name: "desk" });
const h = (r, k) => r.headers.get("x-middleware-request-" + k);
const call = async (path, o = {}) => {
  const r = await proxy(new NextRequest("http://127.0.0.1:3200" + path, { method: o.method ?? "GET", headers: { authorization: "Bearer " + (o.token ?? t.token), ...(o.headers ?? {}) } }));
  return { status: r.status, via: h(r, "x-console-auth-via"), user: h(r, "x-console-user-id"), role: h(r, "x-console-user-role"), principal: h(r, "x-console-agent-principal"), run: h(r, "x-console-agent-run"),
    name: h(r, "x-console-agent-token-name"), cookie: h(r, "cookie"), tokenMode: h(r, "x-console-token-mode"), retry: r.headers.get("retry-after"),
    error: r.status < 400 ? undefined : path.startsWith("/api/") ? (await r.json()).error : (await r.text()) };
};
out.me = await call("/api/me", { headers: { cookie: "console_session=stolen", "x-console-user-role": "admin", "x-console-agent-run": "someone-else", "x-console-token-mode": "act" } });
out.mcp = (await call("/api/mcp", { method: "POST" })).status;
out.approve = await call("/api/approvals/" + crypto.randomUUID(), { method: "POST" });
out.tokensRoute = await call("/api/agents/tokens");
out.page = await call("/automation");
out.malformed = await call("/api/me", { token: "da_short" });
// API tokens keep their own wording and headers.
const dc = await createToken(admin, { name: "bot", role: "operator", mode: "read", expiresInDays: 7 });
out.dcPage = await call("/automation", { token: dc.token });
out.dcMe = await call("/api/me", { token: dc.token });
// A run's own token: no token name (the audit actor names the run).
const pr = await agentRun(P("daily-digest"));
const rt = await tokens.mintRunToken(pr.runId, pr, 60_000);
const viaRun = await call("/api/me", { token: rt });
out.runToken = [viaRun.status, viaRun.via, viaRun.run === pr.runId, viaRun.name];
// Agents off: every agent token is refused with 503, API tokens are not.
await stop.setAgentsEnabled(false, "admin@acme.test");
out.off = await call("/api/me");
out.dcWhileOff = (await call("/api/me", { token: dc.token })).status;
await stop.setAgentsEnabled(true, "admin@acme.test");
// Revoked: 401 at once.
await tokens.revokeAgentToken(alice, t.id);
out.revoked = await call("/api/me");
// The per-token limiter API tokens use (120 a minute).
const t2 = await tokens.mintExternalToken(alice, "daily-digest", 7, { name: "busy" });
let last;
for (let i = 0; i < 121; i++) last = await call("/api/me", { token: t2.token });
out.throttled = [last.status, !!last.retry];
console.log(JSON.stringify(out));
`);
  assert.equal(o.me.status, 200);
  assert.deepEqual([o.me.via, o.me.role, o.me.name, o.me.cookie, o.me.tokenMode], ["agent", "operator", "desk", null, null], "forged identity headers and cookies are dropped");
  assert.ok(o.me.principal && o.me.run && o.me.run !== "someone-else");
  assert.equal(o.mcp, 200);
  assert.deepEqual(o.runToken, [200, "agent", true, null]);
  assert.deepEqual([o.approve.status, o.approve.error], [403, "Agent tokens can't approve or reject requests — a person decides in the console (Automation → Approvals)."]);
  assert.equal(o.tokensRoute.status, 403);
  assert.match(o.tokensRoute.error, /^Agent tokens can only use the operations API/);
  assert.equal(o.page.status, 403);
  assert.equal(o.malformed.status, 401);
  assert.match(o.dcPage.error, /API tokens can only use the operations API/, "the dc_ wording is unchanged");
  assert.doesNotMatch(o.dcPage.error, /Agent tokens/);
  assert.deepEqual([o.dcMe.status, o.dcMe.via, o.dcMe.tokenMode, o.dcMe.principal], [200, "token", "read", null]);
  assert.deepEqual([o.off.status, o.off.error], [503, "agents are turned off on this console"]);
  assert.equal(o.dcWhileOff, 200);
  assert.equal(o.revoked.status, 401);
  assert.deepEqual(o.throttled, [429, true]);
});

test("MCP and /api/me over the routes: agent callers see their policy's tools and their principal", () => {
  const o = run(`
const { NextRequest } = await import("next/server.js");
const mcp = await import(src("app/api/mcp/route.ts"));
const me = await import(src("app/api/me/route.ts"));
const t = await tokens.mintExternalToken(alice, "daily-digest", 7, { name: "desk" });
const v = await tokens.verifyAgentToken(t.token);
const headers = { "x-console-user-id": alice.id, "x-console-user-email": alice.email, "x-console-user-role": alice.role, "x-console-auth-via": "agent", "x-console-agent-principal": t.id, "x-console-agent-run": t.runId, "x-console-agent-token-name": "desk", "content-type": "application/json" };
const post = async (body) => { const r = await mcp.POST(new NextRequest("http://127.0.0.1:3200/api/mcp", { method: "POST", headers, body: JSON.stringify(body) }), {}); return { status: r.status, json: await r.json() }; };
const list = await post({ jsonrpc: "2.0", id: 1, method: "tools/list" });
out.tools = list.json.result.tools.map((x) => x.name);
const call = await post({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "services_restart", arguments: { env: "staging", service: "api", confirm: "yes" } } });
out.restart = call.json.error?.code ?? call.json.result?.isError;
out.restartText = JSON.parse(call.json.result?.content?.[0]?.text ?? "{}").error;
out.restartEvent = events.filter((e) => e.op === "services.restart").map((e) => ({ op: e.op, outcome: e.outcome })).pop();
const m = await me.GET(new NextRequest("http://127.0.0.1:3200/api/me", { headers }), {});
out.me = (await m.json()).principal;
out.wrongRun = (await mcp.POST(new NextRequest("http://127.0.0.1:3200/api/mcp", { method: "POST", headers: { ...headers, "x-console-agent-run": "other" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) }), {})).status;
// A proposing agent: its change comes back as an approval request on its own run, and the instructions say not to resend.
const pt = await tokens.mintExternalToken(alice, "incident-investigator", 7, { name: "claude desktop" });
const ph = { ...headers, "x-console-agent-principal": pt.id, "x-console-agent-run": pt.runId, "x-console-agent-token-name": "claude desktop" };
const ppost = async (body) => (await mcp.POST(new NextRequest("http://127.0.0.1:3200/api/mcp", { method: "POST", headers: ph, body: JSON.stringify(body) }), {})).json();
out.init = (await ppost({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } })).result.instructions;
out.proposeTools = (await ppost({ jsonrpc: "2.0", id: 2, method: "tools/list" })).result.tools.filter((x) => x.name === "services_restart").map((x) => x.description.includes("never resend one"));
const res = await ppost({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "services_restart", arguments: { env: "staging", service: "api", confirm: "yes" } } });
const text = JSON.parse(res.result.content[0].text);
out.approval = { status: text.approval?.status, note: /do not send the same request again/.test(text.note ?? "") };
out.approvalRun = (await db.get("SELECT run_id FROM approvals WHERE id = ?", [text.approval.id])).run_id === pt.runId;
// …and it reads its request back with approvals_get, but never another run's.
const back = await ppost({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "approvals_get", arguments: { id: text.approval.id } } });
out.back = JSON.parse(back.result.content[0].text).status;
const theirs = await ppost({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "approvals_get", arguments: { id: crypto.randomUUID() } } });
out.theirs = theirs.result.isError;
console.log(JSON.stringify(out));
`);
  assert.ok(o.tools.includes("envs_status") && o.tools.includes("costs_summary"));
  assert.equal(o.tools.includes("services_restart"), false, "an observe agent gets no change tools");
  assert.equal(o.tools.includes("variables_update"), false);
  assert.equal(o.restart, true, "a tool the agent's policy hides is refused with the reason, as a tool result");
  assert.match(o.restartText, /policy refuses this: services.restart is not one of the agent's tools/);
  assert.deepEqual(o.restartEvent, { op: "services.restart", outcome: "denied" }, "and the attempt is on the run's record");
  assert.deepEqual(Object.keys(o.me).sort(), ["delegator", "kind", "mode", "policyHash", "runId"]);
  assert.equal(o.me.mode, "observe");
  assert.equal(o.wrongRun, 401);
  assert.match(o.init, /Never resend one/);
  assert.deepEqual(o.proposeTools, [true]);
  assert.deepEqual(o.approval, { status: "pending", note: true });
  assert.equal(o.approvalRun, true);
  assert.equal(o.back, "pending");
  assert.equal(o.theirs, true);
});
