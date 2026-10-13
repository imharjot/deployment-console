import { test } from "node:test";
import assert from "node:assert/strict";
import { ciFailedEvent, createDeduper, eventKey, matches, newFailures, parseSubscription, route, type ConsoleEvent, type Subscription } from "./events.ts";

const svc = (type: "service.down" | "service.recovered", env = "staging", prot = false, at = 1): ConsoleEvent => ({
  type, at, url: "u", env, envLabel: env, protected: prot, key: "service:api", name: "api", state: type === "service.down" ? "DOWN" : "UP", previous: type === "service.down" ? "UP" : "DOWN", reasons: [],
});
const ci = (env?: string, prot?: boolean): ConsoleEvent => ({ type: "ci.failed", at: 1, url: "u", repo: "acme/api", branch: "main", workflow: "test", title: "t", sha: "abc", actor: "me", runId: 7, env, protected: prot });
const sub = (types: Subscription["types"], envs: Subscription["envs"] = "all"): Subscription => ({ types, envs });

test("subscription: event types", () => {
  assert.equal(matches(sub(["service.down"]), svc("service.down")), true);
  assert.equal(matches(sub(["service.down"]), svc("service.recovered")), false);
  assert.equal(matches(sub([]), { type: "test", at: 1, url: "u", message: "m" }), true); // tests always go through
});

test("env filter: all / protected / explicit list; CI without an env only matches 'all'", () => {
  const types: Subscription["types"] = ["service.down", "ci.failed"];
  assert.equal(matches(sub(types, "protected"), svc("service.down", "production", true)), true);
  assert.equal(matches(sub(types, "protected"), svc("service.down", "staging", false)), false);
  assert.equal(matches(sub(types, ["staging"]), svc("service.down", "staging")), true);
  assert.equal(matches(sub(types, ["staging"]), svc("service.down", "production", true)), false);
  assert.equal(matches(sub(types, "all"), ci()), true);
  assert.equal(matches(sub(types, "protected"), ci()), false);
  assert.equal(matches(sub(types, "protected"), ci("production", true)), true);
  assert.equal(matches(sub(types, ["staging"]), ci("staging", false)), true);
});

test("route: only enabled, notify-capable, subscribed integrations", () => {
  const list = [
    { id: "slack", enabled: true, capabilities: ["notify"], subscription: sub(["service.down"]) },
    { id: "hook", enabled: false, capabilities: ["notify"], subscription: sub(["service.down"]) },
    { id: "jira", enabled: true, capabilities: ["tickets"], subscription: sub(["service.down"]) },
    { id: "prod-only", enabled: true, capabilities: ["notify"], subscription: sub(["service.down"], "protected") },
  ];
  assert.deepEqual(route(list, svc("service.down")).map((i) => i.id), ["slack"]);
  assert.deepEqual(route(list, svc("service.down", "production", true)).map((i) => i.id), ["slack", "prod-only"]);
});

test("dedupe: same key per integration suppressed for the window, independent across integrations", () => {
  const ok = createDeduper(60_000);
  const k = eventKey(svc("service.down"));
  assert.equal(ok("slack", k, 0), true);
  assert.equal(ok("slack", k, 30_000), false); // flapping back down within a minute
  assert.equal(ok("hook", k, 30_000), true);
  assert.equal(ok("slack", eventKey(svc("service.recovered")), 30_000), true); // different news
  assert.equal(ok("slack", k, 60_000), true); // window elapsed
});

test("event keys: service transitions share a key across time; actions and CI attempts don't collide", () => {
  assert.equal(eventKey(svc("service.down", "staging", false, 1)), eventKey(svc("service.down", "staging", false, 999)));
  assert.notEqual(eventKey(svc("service.down", "staging")), eventKey(svc("service.down", "production")));
  const a = { type: "action", at: 1, url: "u", env: "staging", envLabel: "Staging", protected: false, target: "api", action: "restart", actor: "x", result: "ok" } as const;
  assert.notEqual(eventKey(a), eventKey({ ...a, at: 2 }));
  assert.notEqual(eventKey(ci()), eventKey({ ...(ci() as Extract<ConsoleEvent, { type: "ci.failed" }>), attempt: 2 }));
});

test("parseSubscription drops unknown types and malformed env ids", () => {
  assert.deepEqual(parseSubscription({ types: ["service.down", "nope", "service.down", "test"], envs: ["staging", "Bad Env!", 3] }), { types: ["service.down"], envs: ["staging"] });
  assert.deepEqual(parseSubscription({ types: [], envs: "protected" }), { types: [], envs: "protected" });
  assert.equal(parseSubscription(null).envs, "all");
});

test("CI watcher: only completed failures newer than the mark; the mark advances past everything seen", () => {
  const runs = [
    { id: 1, status: "completed", conclusion: "failure", updatedAt: "2026-09-26T10:00:00Z" },
    { id: 2, status: "completed", conclusion: "success", updatedAt: "2026-09-26T10:05:00Z" },
    { id: 3, status: "in_progress", conclusion: null, updatedAt: "2026-09-26T10:06:00Z" },
    { id: 4, status: "completed", conclusion: "timed_out", updatedAt: "2026-09-26T10:07:00Z" },
    { id: 5, status: "completed", conclusion: "cancelled", updatedAt: "2026-09-26T10:08:00Z" },
  ];
  const mark = Date.parse("2026-09-26T10:01:00Z");
  const r = newFailures(runs, mark);
  assert.deepEqual(r.failed.map((x) => x.id), [4]);
  assert.equal(r.hwm, Date.parse("2026-09-26T10:08:00Z"));
  // A restart with the persisted mark re-announces nothing.
  assert.deepEqual(newFailures(runs, r.hwm).failed, []);
  assert.equal(newFailures(runs, r.hwm).hwm, r.hwm);
});

test("ciFailedEvent maps the branch to the env that deploys it", () => {
  const run = { id: 9, status: "completed", conclusion: "failure", updatedAt: "2026-09-26T10:00:00Z", repo: "acme/api", branch: "master", workflow: "deploy", title: "ship", sha: "abc", actor: "me", attempt: 2, url: "https://gh/run/9" };
  const envs = [{ id: "staging", protected: false, branch: "staging" }, { id: "production", protected: true, branch: "master" }];
  const e = ciFailedEvent(run, envs, "https://c/ci");
  assert.equal(e.type, "ci.failed");
  assert.deepEqual(e.type === "ci.failed" && [e.env, e.protected, e.runId, e.attempt, e.runUrl, e.url], ["production", true, 9, 2, "https://gh/run/9", "https://c/ci"]);
  const other = ciFailedEvent({ ...run, branch: "feature/x" }, envs, "https://c/ci");
  assert.equal(other.type === "ci.failed" && other.env, undefined);
});

// Wave C (C2): agent notifications, delivered through the agent outbox.
test("agent events: subscribable, keyed per request / run, rendered without secrets, env filters apply to approvals", async () => {
  const { EVENT_TYPES, describe } = await import("./events.ts");
  for (const t of ["agent.approval_needed", "agent.run_finished", "agent.run_failed"]) assert.ok((EVENT_TYPES as readonly string[]).includes(t), t);
  const ask: ConsoleEvent = { type: "agent.approval_needed", at: 1, url: "u", runId: "r1", op: "services.restart", summary: "Restart api in Production (protected)", env: "production", envLabel: "Production", protected: true, approvalId: "a1", requestedFor: "alice@acme.test" };
  assert.equal(eventKey(ask), "agent.approval_needed:a1");
  assert.equal(matches(sub(["agent.approval_needed"], "protected"), ask), true);
  assert.equal(matches(sub(["agent.approval_needed"], ["staging"]), ask), false);
  const d = describe(ask);
  assert.equal(d.tone, "warn");
  assert.match(d.title, /An agent asks to: Restart api/);
  assert.ok(d.fields.some(([k, v]) => k === "Agent acts for" && v === "alice@acme.test"));
  assert.ok(d.fields.some(([k, v]) => k === "Environment" && v === "Production (protected)"));
  assert.equal(d.fields.some(([k]) => k === "Expires"), false, "no expiry given, none shown");
  assert.deepEqual(describe({ ...ask, expiresAt: Date.UTC(2026, 9, 5, 14, 7, 30) }).fields.find(([k]) => k === "Expires"), ["Expires", "2026-10-05 14:07 UTC"]);
  assert.deepEqual(d.links, [{ label: "Review in console", url: "u" }]);
  const failed: ConsoleEvent = { type: "agent.run_failed", at: 1, url: "u", runId: "r1", title: "Investigate api", kind: "assistant", error: "deadline exceeded" };
  assert.equal(eventKey(failed), "agent.run_failed:r1");
  assert.equal(describe(failed).tone, "bad");
  assert.equal(matches(sub(["agent.run_failed"], "protected"), failed), false, "a run has no environment: only 'all' wants it");
  assert.deepEqual(parseSubscription({ types: ["agent.run_finished", "nope"] }).types, ["agent.run_finished"]);
});
