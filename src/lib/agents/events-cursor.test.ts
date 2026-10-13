import { test } from "node:test";
import assert from "node:assert/strict";
import { GAP_GRACE_MS, SeqCursor, frame, isEventType, parseAudience, parseCursor, visibleTo, type EventLike } from "./events-cursor.ts";

const ev = (type: string, run_id: string | null, audience?: object | string): EventLike => ({ type, run_id, audience: audience === undefined ? null : typeof audience === "string" ? audience : JSON.stringify(audience) });

test("cursor: Last-Event-ID wins over ?after=; anything but a non-negative integer is no cursor", () => {
  assert.equal(parseCursor("42", "7"), 42);
  assert.equal(parseCursor(null, "7"), 7);
  assert.equal(parseCursor(" 9 ", null), 9);
  assert.equal(parseCursor("-1", null), undefined);
  assert.equal(parseCursor("1e3", "x"), undefined);
  assert.equal(parseCursor("99999999999999999", null), undefined, "beyond a safe integer");
  assert.equal(parseCursor(undefined, undefined), undefined);
  assert.equal(parseCursor("abc", "5"), 5, "a bad Last-Event-ID falls back to ?after=");
});

test("audiences: people see what is for people; API tokens their approvals plus state/action; agents only their run", () => {
  const person = { via: "session" as const, role: "developer" as const };
  const token = { via: "token" as const, tokenId: "t1" };
  const agent = { via: "agent" as const, runId: "r1" };
  assert.ok(visibleTo(ev("state", null), person));
  assert.ok(visibleTo(ev("run", "r2", { people: true }), person));
  assert.equal(visibleTo(ev("run", "r2", { people: { minRole: "admin" } }), person), false);
  assert.ok(visibleTo(ev("run", "r2", { people: { minRole: "admin" } }), { via: "dev", role: "admin" }));
  assert.equal(visibleTo(ev("x", null, { people: false }), person), false);
  // API tokens
  assert.ok(visibleTo(ev("state", null, { people: true }), token));
  assert.ok(visibleTo(ev("action", null, { people: true }), token));
  assert.ok(visibleTo(ev("approval", null, { people: true, tokens: ["t1"] }), token));
  assert.equal(visibleTo(ev("approval", null, { people: true, tokens: ["t2"] }), token), false);
  assert.equal(visibleTo(ev("run", "r1", { people: true }), token), false);
  assert.equal(visibleTo(ev("operation", null, { people: true }), token), false);
  // Agents
  assert.ok(visibleTo(ev("step", "r1"), agent));
  assert.ok(visibleTo(ev("approval", "r1", { people: true }), agent));
  assert.equal(visibleTo(ev("state", null), agent), false, "not even resource state: only its own run");
  assert.equal(visibleTo(ev("step", "r2"), agent), false);
  assert.ok(visibleTo(ev("step", "r2", { runs: ["r1"] }), agent));
  assert.equal(visibleTo(ev("step", "r1"), { via: "agent" }), false, "an agent without a run sees nothing");
  // Damaged audience: nobody but the run itself.
  assert.deepEqual(parseAudience("{"), { people: false });
  assert.equal(visibleTo(ev("run", "r1", "{"), person), false);
  assert.ok(visibleTo(ev("run", "r1", "{"), agent));
});

test("frames carry the sequence number as the SSE id", () => {
  assert.equal(frame(7, "run", '{"a":1}'), 'id: 7\nevent: run\ndata: {"a":1}\n\n');
  assert.equal(frame(8, "step", null), "id: 8\nevent: step\ndata: null\n\n");
  assert.ok(isEventType("operation") && !isEventType("replayed"));
});

test("live cursor: an event that commits after a later one is still sent, once; empty gaps are forgotten", () => {
  const c = new SeqCursor(10);
  assert.equal(c.from(0), 10);
  // 11 and 13 are visible, 12 isn't yet (its transaction commits later).
  assert.deepEqual([11, 13].map((s) => c.accept(s, 0)), [true, true]);
  assert.equal(c.last, 13);
  assert.equal(c.from(1_000), 11, "the next read looks again from before the gap");
  // The re-read returns 11 and 13 again (already sent) and now 12.
  assert.deepEqual([11, 12, 13].map((s) => c.accept(s, 1_000)), [false, true, false]);
  assert.equal(c.pendingGaps, 0);
  assert.equal(c.from(1_000), 13);
  // A gap that stays empty (a rolled-back event, another run's event) is given up after the grace period.
  c.accept(16, 2_000);
  assert.equal(c.from(2_000 + GAP_GRACE_MS - 1), 13);
  assert.equal(c.from(2_000 + GAP_GRACE_MS + 1), 16);
  assert.equal(c.accept(14, 2_000 + GAP_GRACE_MS + 2), false, "too late: forgotten, so never sent out of the blue");
});

test("live cursor: big jumps remember a bounded number of gaps, nearest first; a truncated replay skips", () => {
  const c = new SeqCursor(0);
  c.accept(50_000, 0);
  assert.equal(c.pendingGaps, 1_000);
  assert.equal(c.from(0), 50_000 - 1_001, "only the most recent gaps are looked for");
  assert.equal(c.accept(10, 0), false);
  assert.equal(c.accept(49_999, 0), true);
  c.skipTo(60_000);
  assert.equal(c.pendingGaps, 0);
  assert.equal(c.from(0), 60_000);
  c.skipTo(5);
  assert.equal(c.last, 60_000, "never moves back");
});
