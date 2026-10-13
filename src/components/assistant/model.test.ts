import { test } from "node:test";
import assert from "node:assert/strict";
import { DEMO_CONNECTION_ID } from "../../lib/agents/connection-rules.ts";
import { DEMO_CONNECTION, MAX_QUESTION, NOT_SENT, checkQuestion, ecsStateWord, ecsUnhealthy, mapStateWord, mapUnhealthy, myAssistantRuns, normalizeConnections, normalizeRunList, parseThread, pickConnection, questionFor, questionToKeep, startError } from "./model.ts";

test("pickConnection: the last one used if usable, else the demo model, else the first usable", () => {
  const all = normalizeConnections({
    connections: [
      { id: "c1", label: "Mine", usable: true, status: "active", payer: "my Anthropic org" },
      { id: DEMO_CONNECTION, label: "Demo", usable: true, status: "active", builtIn: true },
      { id: "c3", label: "Revoked", usable: true, status: "revoked" },
      { id: "c4", label: "Not mine", usable: false, why: "personal connections are never shared" },
      { label: "no id" },
    ],
  });
  assert.equal(all.length, 4);
  assert.equal(all.find((c) => c.id === "c3")!.usable, false); // a revoked connection can't run, whatever "usable" says
  assert.equal(pickConnection(all, "c1")!.id, "c1");
  assert.equal(pickConnection(all, "c4")!.id, DEMO_CONNECTION);
  assert.equal(pickConnection(all, null)!.id, DEMO_CONNECTION);
  assert.equal(pickConnection(all.filter((c) => c.id !== DEMO_CONNECTION), undefined)!.id, "c1");
  assert.equal(pickConnection([], "c1"), undefined);
});

test("questionFor names the resource and its key, so the run is scoped to it", () => {
  const q = questionFor("why", { key: "ecs:service/acme-production/api", name: "api", kind: "service", envLabel: "Production", stateWord: ecsStateWord("DOWN") });
  assert.equal(q, "Why is the service api in Production down? Show the evidence and prepare a safe action for review. (ecs:service/acme-production/api)");
  assert.match(questionFor("explain", { name: "orders", kind: "SQS queue" }), /^Explain the SQS queue orders: /);
  assert.match(questionFor("explain", { name: "api", fallbackRef: "service:api" }), /\(service:api\)$/);
  assert.equal(ecsUnhealthy("DOWN") && ecsUnhealthy("DEGRADED") && ecsUnhealthy("UNKNOWN"), true);
  assert.equal(ecsUnhealthy("UP") || ecsUnhealthy("STOPPED") || ecsUnhealthy("DEPLOYING"), false);
  assert.equal(mapUnhealthy("error") && mapUnhealthy("warning"), true);
  assert.equal(mapUnhealthy("unknown") || mapUnhealthy("stopped") || mapUnhealthy("ok"), false);
  assert.match(questionFor("why", { key: "arn:aws:sqs:us-east-1:123456789012:orders", name: "orders", kind: "SQS queue", stateWord: mapStateWord("warning") }), /^Why is the SQS queue orders showing a warning\? /);
});

test("checkQuestion blocks text that looks like a secret and never echoes it", () => {
  assert.equal(checkQuestion("Why is api down in production?").ok, true);
  assert.equal(checkQuestion("why does my DB password fail to rotate?").ok, true); // talking about a password is fine
  assert.equal(checkQuestion("   ").ok, false);
  assert.equal(checkQuestion("   ").empty, true);
  for (const t of [
    "the DATABASE_PASSWORD=hunter2isgreat is wrong",
    "my key AKIAIOSFODNN7EXAMPLE secret wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    "token ghp_1234567890abcdefghijklmnopqrstuvwxyz12",
    "postgres://user:pa55word@db.example.com:5432/app",
    "-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----",
  ]) {
    const c = checkQuestion(t);
    assert.equal(c.ok, false, t);
    assert.ok(c.secrets.length > 0, t);
    assert.match(c.message!, /Variables tab/);
    for (const part of ["hunter2isgreat", "wJalrXUtnFEMI", "ghp_1234", "pa55word", "MIIEow"]) assert.ok(!c.message!.includes(part));
  }
  const both = checkQuestion("AKIAIOSFODNN7EXAMPLE wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY");
  assert.match(both.message!, /an AWS access key id and an AWS secret access key/);
  const long = checkQuestion("x".repeat(MAX_QUESTION + 1));
  assert.equal(long.ok, false);
  assert.equal(long.tooLong, true);
});

test("parseThread keeps well-formed entries only, at most 8", () => {
  const good = { key: "k1", question: "Why?", runId: "run_1", at: 1 };
  assert.deepEqual(parseThread(JSON.stringify([good])), [{ ...good, resourceKey: undefined, resourceName: undefined, error: undefined, code: undefined }]);
  assert.deepEqual(parseThread("not json"), []);
  assert.deepEqual(parseThread(null), []);
  assert.deepEqual(parseThread(JSON.stringify({ key: "k" })), []);
  // A run id that couldn't be a run id (it goes into a URL) is refused.
  assert.deepEqual(parseThread(JSON.stringify([{ ...good, runId: "../../api/x" }])), []);
  const many = Array.from({ length: 12 }, (_, i) => ({ key: `k${i}`, question: "q", at: i }));
  assert.deepEqual(parseThread(JSON.stringify(many)).map((e) => e.key), ["k4", "k5", "k6", "k7", "k8", "k9", "k10", "k11"]);
});

test("the thread never keeps text that looks like a secret, on screen or in sessionStorage", () => {
  const secret = "why does DATABASE_PASSWORD=hunter2isgreat fail?";
  assert.equal(questionToKeep(secret), NOT_SENT);
  assert.equal(questionToKeep("  Why is api down?  "), "Why is api down?");
  assert.equal(questionToKeep("y".repeat(MAX_QUESTION + 50)).length, MAX_QUESTION);
  // An entry stored before this rule (or written by hand) is scrubbed when the thread is read back.
  const [e] = parseThread(JSON.stringify([{ key: "k1", question: secret, at: 1, error: "refused", code: "refused" }]));
  assert.equal(e.question, NOT_SENT);
  assert.ok(!JSON.stringify(e).includes("hunter2isgreat"));
  assert.equal(DEMO_CONNECTION, DEMO_CONNECTION_ID); // the server's built-in demo connection, not a copy that can drift
});

test("normalizeRunList and myAssistantRuns: assistant runs of mine, newest first", () => {
  const items = normalizeRunList({
    runs: [
      { id: "a", kind: "assistant", state: "succeeded", initiator: "you@example.com", createdAt: 1 },
      { id: "b", kind: "workflow", state: "running", initiator: "you@example.com", createdAt: 2 },
      { id: "c", kind: "assistant", state: "running", initiator: { email: "other@example.com" }, createdAt: 3 },
      { id: "d", kind: "assistant", state: "waiting_approval", createdAt: 4 },
      { kind: "assistant" },
      { id: "../../x", kind: "assistant" }, // could never be a run id: it goes into URLs
    ],
  });
  assert.equal(items.length, 4);
  assert.deepEqual(myAssistantRuns(items, { email: "You@Example.com", id: "u1" }).map((r) => r.id), ["d", "a"]);
  assert.deepEqual(normalizeRunList([{ id: "x" }]).map((r) => r.id), ["x"]);
  assert.deepEqual(normalizeRunList({}), []);
});

test("startError explains a missing assistant API, agents off and the emergency stop", () => {
  assert.match(startError(404, "Not found"), /isn't available/);
  assert.match(startError(503, "agents are turned off on this console"), /turned off/);
  assert.match(startError(423, "the emergency stop is on", "emergency_stop"), /emergency stop/);
  assert.equal(startError(400, "question is required"), "question is required");
  assert.equal(startError(404, "no such connection", "not_found"), "no such connection");
});
