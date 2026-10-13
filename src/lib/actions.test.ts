import { test } from "node:test";
import assert from "node:assert/strict";
import { actionSpecs, checkAction, checkPower, expectedConfirm, parseActionBody, powerSpecs, type ActionContext, type PowerTarget } from "./actions.ts";

const SHA = "096a5bb528e1dc7ceed8e8d420cc4bbec34497b7";
const ctx = (o: Partial<ActionContext> = {}): ActionContext => ({
  env: "staging", protected: false, service: "api", desired: 1, inProgress: false, isSelf: false, locked: false,
  liveArn: "td:9",
  revisions: [
    { arn: "td:9", imagePresent: true, sha: "a".repeat(40) },
    { arn: "td:8", imagePresent: true, sha: SHA },
    { arn: "td:7", imagePresent: false, sha: "c".repeat(40) },
    { arn: "td:6", imagePresent: true, sha: "d".repeat(40), migrations: true },
  ],
  ...o,
});

test("crafted desiredCount / missing confirm are rejected before any AWS call", () => {
  const r1 = parseActionBody({ action: "start", confirm: "yes", desiredCount: 2 });
  assert.equal(r1.ok, false);
  assert.match(!r1.ok ? r1.error : "", /desiredCount/);
  assert.equal(parseActionBody({ action: "start" }).ok, false);
  assert.equal(parseActionBody({ action: "scale", confirm: "yes" }).ok, false);
  assert.equal(parseActionBody([]).ok, false);
  assert.equal(parseActionBody({ action: "restart", confirm: "yes", reason: "x".repeat(501) }).ok, false);
});

test("staging actions need only 'yes'", () => {
  const p = parseActionBody({ action: "restart", confirm: "yes" });
  assert.ok(p.ok);
  assert.deepEqual(checkAction(p.req, ctx()), { ok: true });
  assert.equal(checkAction({ action: "restart", confirm: "no" }, ctx()).ok, false);
});

test("production needs typed confirmation + reason", () => {
  const prod = ctx({ env: "production", protected: true });
  assert.equal(expectedConfirm(true, "stop", "worker", "production"), "production/worker");
  assert.equal(expectedConfirm(false, "stop", "worker", "qa"), "yes");
  assert.equal(checkAction({ action: "restart", confirm: "api" }, prod).ok, false, "no reason");
  assert.deepEqual(checkAction({ action: "restart", confirm: "api", reason: "stuck pool" }, prod), { ok: true });
  assert.equal(checkAction({ action: "stop", confirm: "yes", reason: "maintenance" }, prod).ok, false);
  assert.deepEqual(checkAction({ action: "switch", revisionArn: "td:8", confirm: SHA.slice(0, 7), reason: "bad deploy" }, prod), { ok: true });
});

test("rollout in progress blocks all but stop", () => {
  const c = ctx({ inProgress: true });
  const r = checkAction({ action: "restart", confirm: "yes" }, c);
  assert.equal(!r.ok && r.status, 409);
  assert.deepEqual(checkAction({ action: "stop", confirm: "yes" }, c), { ok: true });
});

test("a locked service rejects a second submit", () => {
  const r = checkAction({ action: "restart", confirm: "yes" }, ctx({ locked: true }));
  assert.equal(!r.ok && r.status, 409);
});

test("console never acts on itself", () => {
  const r = checkAction({ action: "restart", confirm: "yes" }, ctx({ isSelf: true }));
  assert.equal(!r.ok && r.status, 403);
});

test("start/stop only make sense from the opposite state", () => {
  assert.equal(checkAction({ action: "start", confirm: "yes" }, ctx()).ok, false);
  assert.deepEqual(checkAction({ action: "start", confirm: "yes" }, ctx({ desired: 0 })), { ok: true });
  assert.equal(checkAction({ action: "stop", confirm: "yes" }, ctx({ desired: 0 })).ok, false);
});

test("switch revision guards", () => {
  const sw = (arn: string, ack?: boolean) => checkAction({ action: "switch", revisionArn: arn, confirm: "yes", migrationAck: ack }, ctx());
  assert.deepEqual(sw("td:8"), { ok: true });
  assert.equal(sw("td:9").ok, false, "already live");
  assert.equal(!sw("td:7").ok && (sw("td:7") as { status: number }).status, 409, "image gone");
  assert.equal(sw("td:404").ok, false, "unknown revision");
  assert.equal(sw("td:6").ok, false, "migrations need ack");
  assert.deepEqual(sw("td:6", true), { ok: true });
  assert.equal(checkAction({ action: "switch", confirm: "yes" }, ctx()).ok, false, "no revision");
});

test("action specs mirror the server checks", () => {
  const specs = actionSpecs(ctx({ inProgress: true }));
  assert.equal(specs.find((s) => s.name === "restart")?.enabled, false);
  assert.equal(specs.find((s) => s.name === "stop")?.enabled, true);
  assert.ok(actionSpecs(ctx({ isSelf: true })).every((s) => !s.enabled));
});

test("host start refused while anything is stopping", () => {
  const host = { kind: "host" as const, state: "stopped", protected: false };
  assert.deepEqual(checkPower("start", host, "yes"), { ok: true });
  assert.equal(checkPower("start", { ...host, state: "stopping" }, "yes").ok, false);
  assert.equal(checkPower("start", { ...host, state: "running" }, "yes").ok, false);
  assert.equal(checkPower("stop", { ...host, state: "running" }, "no").ok, false);
  assert.equal(checkPower("stop", { ...host, state: "running", asg: "web-asg" }, "yes").ok, false, "ASG would replace it");
  assert.equal(checkPower("stop", { ...host, state: "running", protected: true }, "yes").ok, false, "protected env");
  const db = { kind: "database" as const, state: "available", protected: false };
  assert.deepEqual(checkPower("stop", db, "yes"), { ok: true });
  assert.equal(checkPower("stop", { ...db, aurora: "main" }, "yes").ok, false);
});

test("power guards answer with the status the API returns", () => {
  const status = (a: "start" | "stop", t: PowerTarget, confirm: unknown = "yes") => {
    const c = checkPower(a, t, confirm);
    return c.ok ? 200 : c.status;
  };
  const host: PowerTarget = { kind: "host", state: "running", protected: false };
  assert.equal(status("stop", host, "no"), 400, "confirmation is checked first");
  assert.equal(status("stop", { ...host, state: undefined }), 404, "not in this env");
  assert.equal(status("stop", { ...host, protected: true }), 403, "never on a protected env");
  assert.equal(status("stop", { ...host, asg: "web-asg" }), 409);
  assert.equal(status("start", { ...host, state: "pending" }), 409, "still settling");
  assert.equal(status("stop", { kind: "database", state: "starting", protected: false }), 409);
  assert.equal(status("stop", { kind: "database", state: "modifying", protected: false }), 409, "can't stop from an odd state");
  assert.equal(status("start", { kind: "database", state: "stopped", protected: false }), 200);
});

test("power buttons mirror the guards", () => {
  const specs = powerSpecs({ kind: "host", state: "running", protected: false });
  assert.deepEqual(specs.map((s) => [s.name, s.label, s.enabled, s.danger]), [["boxStart", "Start instance", false, false], ["boxStop", "Stop instance", true, true]]);
  assert.equal(specs[0].why, "already running");
  const locked = powerSpecs({ kind: "database", state: "available", protected: true });
  assert.deepEqual(locked.map((s) => s.label), ["Start database", "Stop database"]);
  assert.ok(locked.every((s) => !s.enabled && s.why === "power actions are disabled on protected environments"));
});

test("start refusal names the current desired count", () => {
  const r = checkAction({ action: "start", confirm: "yes" }, ctx({ desired: 3 }));
  assert.deepEqual(r, { ok: false, status: 409, error: "already started (desired count is 3)" });
});

// F07/R25: a migration check that could not be made (GitHub unreachable, a compare too large to be complete) is
// "unknown", and unknown needs the same acknowledgement as a known change.
test("switch: migrations unknown or true need migrationAck; false doesn't", () => {
  const revs = [
    { arn: "td:9", imagePresent: true, sha: "a".repeat(40) },
    { arn: "td:5", imagePresent: true, sha: "e".repeat(40), migrations: "unknown" as const, migrationsWhy: "compare incomplete (300+ files)" },
    { arn: "td:4", imagePresent: true, sha: "f".repeat(40), migrations: "unknown" as const },
    { arn: "td:3", imagePresent: true, sha: "b".repeat(40), migrations: true },
    { arn: "td:2", imagePresent: true, sha: "c".repeat(40), migrations: false },
  ];
  const sw = (arn: string, ack?: boolean) => checkAction({ action: "switch", revisionArn: arn, confirm: "yes", migrationAck: ack }, ctx({ revisions: revs }));
  const r5 = sw("td:5");
  assert.equal(r5.ok, false);
  assert.equal(!r5.ok && r5.status, 400);
  assert.equal(!r5.ok && r5.error, "could not check whether database migrations changed (compare incomplete (300+ files)) — acknowledgement required");
  assert.match(!sw("td:4").ok ? (sw("td:4") as { error: string }).error : "", /could not check .*comparison unavailable/);
  assert.equal(sw("td:5", true).ok, true);
  const r3 = sw("td:3");
  assert.equal(!r3.ok && r3.error, "database migrations changed between these commits — acknowledgement required");
  assert.equal(sw("td:3", true).ok, true);
  assert.equal(sw("td:2").ok, true);
});
