import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_POLICIES } from "./policy.ts";
import { EMPTY_USAGE, addUsage, available, budgetOf, budgetView, checkCalls, checkTurn, parseReservations, parseUsage, releaseChild, reserveChild } from "./budget.ts";

const pol = DEFAULT_POLICIES["incident-investigator"];

test("a run's budget is its policy's limits; usage is read with own properties only", () => {
  assert.deepEqual(budgetOf(pol), { turns: 12, toolCalls: 40, runtimeSeconds: 600 });
  assert.equal(budgetOf({ ...pol, limits: { ...pol.limits, costUsd: 2 } }).costUsd, 2);
  assert.deepEqual(parseUsage(null), EMPTY_USAGE);
  assert.deepEqual(parseUsage("not json"), EMPTY_USAGE);
  const proto = JSON.parse('{"__proto__": {"turns": 99}, "toolCalls": 3, "costUsd": -5}');
  const u = parseUsage(proto);
  assert.equal(u.turns, 0, "an inherited field is ignored");
  assert.equal(u.toolCalls, 3);
  assert.equal(u.costUsd, 0, "a negative amount counts as nothing");
  assert.deepEqual(addUsage(EMPTY_USAGE, { turns: 1, inputTokens: 100, costUsd: 0.1234567 }), { ...EMPTY_USAGE, turns: 1, inputTokens: 100, costUsd: 0.123457 });
});

test("turns, wall time and estimated cost stop a turn; a turn's calls fit as a whole or not at all", () => {
  const b = { turns: 2, toolCalls: 5, runtimeSeconds: 60, costUsd: 0.5 };
  assert.deepEqual(checkTurn(b, EMPTY_USAGE, 0), { ok: true });
  const t = checkTurn(b, { ...EMPTY_USAGE, turns: 2 }, 0);
  assert.equal(t.ok, false);
  assert.equal(!t.ok && t.limit, "turns");
  assert.equal((checkTurn(b, EMPTY_USAGE, 61_000) as { limit: string }).limit, "runtime");
  assert.equal((checkTurn(b, { ...EMPTY_USAGE, costUsd: 0.5 }, 0) as { limit: string }).limit, "cost");
  assert.deepEqual(checkCalls(b, { ...EMPTY_USAGE, toolCalls: 3 }, 2), { ok: true });
  const c = checkCalls(b, { ...EMPTY_USAGE, toolCalls: 3 }, 3);
  assert.equal(!c.ok && c.limit, "toolCalls");
  assert.match(!c.ok ? c.message : "", /has 2 of its 5 left/);
});

test("the parent itself can't spend what its children hold: together they stay within its limits", () => {
  const b = { turns: 6, toolCalls: 10, runtimeSeconds: 600, costUsd: 1 };
  const r = parseReservations({ a: { turns: 4, toolCalls: 6, costUsd: 0.5 }, b: { turns: 1, toolCalls: 1, released: true } });
  const u = { ...EMPTY_USAGE, turns: 1, toolCalls: 2, costUsd: 0.25 };
  // Without the reservations the parent would still have 5 turns and 8 tool calls.
  assert.deepEqual(checkTurn(b, u, 0), { ok: true });
  const t = checkTurn(b, u, 0, r);
  assert.equal(!t.ok && t.limit, "turns", "4 + 1 held by children, 1 used: none left");
  assert.match(!t.ok ? t.message : "", /\(5 of it held by its child runs\)/);
  assert.deepEqual(checkCalls(b, u, 1, r), { ok: true }, "10 − 7 held − 2 used = 1 left");
  const c = checkCalls(b, u, 2, r);
  assert.match(!c.ok ? c.message : "", /has 1 of its 10 left \(7 of it held/);
  const cost = checkTurn({ ...b, turns: 99 }, { ...u, costUsd: 0.5 }, 0, r);
  assert.equal(!cost.ok && cost.limit, "cost", "$0.5 used + $0.5 held = the $1 limit");
});

test("child runs reserve from what the parent has left, so parallel children can't exceed the parent's budget", () => {
  const parent = { budget: { turns: 10, toolCalls: 20, runtimeSeconds: 600 }, usage: { ...EMPTY_USAGE, turns: 2, toolCalls: 4 }, reserved: {}, elapsedMs: 100_000 };
  const a = reserveChild(parent, "a", { turns: 6, toolCalls: 12, runtimeSeconds: 600 });
  assert.equal(a.ok, true);
  if (!a.ok) return;
  assert.deepEqual(a.budget, { turns: 6, toolCalls: 12, runtimeSeconds: 500 }, "no more time than the parent has left");
  // A second child started in parallel gets only the remainder…
  const b = reserveChild({ ...parent, reserved: a.reserved }, "b", { turns: 6, toolCalls: 12, runtimeSeconds: 300 });
  assert.equal(b.ok, true);
  if (!b.ok) return;
  assert.deepEqual(b.budget, { turns: 2, toolCalls: 4, runtimeSeconds: 300 });
  // …and whatever the children do, the parent's limits hold in total.
  const left = available(parent.budget, parent.usage, b.reserved, parent.elapsedMs);
  assert.deepEqual([left.turns, left.toolCalls], [0, 0]);
  const total = (k: "turns" | "toolCalls") => parent.usage[k] + Object.values(b.reserved).reduce((n, r) => n + r[k], 0);
  assert.ok(total("turns") <= parent.budget.turns && total("toolCalls") <= parent.budget.toolCalls);
  // A third finds nothing left.
  const c = reserveChild({ ...parent, reserved: b.reserved }, "c", { turns: 1, toolCalls: 1, runtimeSeconds: 10 });
  assert.equal(c.ok, false);
  assert.match(!c.ok ? c.why : "", /no tool calls left/);
  assert.equal(reserveChild({ ...parent, reserved: a.reserved }, "a", { turns: 1, toolCalls: 1, runtimeSeconds: 1 }).ok, false, "one reservation per child");
  // A child that ends returns what it didn't use.
  const after = releaseChild(b.reserved, "a", { ...EMPTY_USAGE, turns: 1, toolCalls: 3 });
  assert.deepEqual(after.a, { turns: 1, toolCalls: 3, released: true });
  assert.deepEqual(releaseChild(after, "a", { ...EMPTY_USAGE, turns: 9 }), after, "released once");
  const again = available(parent.budget, parent.usage, after, parent.elapsedMs);
  assert.deepEqual([again.turns, again.toolCalls], [5, 9]);
  // Stored reservations are parsed with own properties only.
  assert.deepEqual(parseReservations(JSON.stringify(after)), after);
  assert.deepEqual(parseReservations("[]"), {});
  // Out of time: refused.
  assert.equal(reserveChild({ ...parent, elapsedMs: 600_000 }, "late", { turns: 1, toolCalls: 1, runtimeSeconds: 60 }).ok, false);
});

test("an estimated-cost limit is shared out the same way", () => {
  const parent = { budget: { turns: 10, toolCalls: 20, runtimeSeconds: 600, costUsd: 1 }, usage: { ...EMPTY_USAGE, costUsd: 0.2 }, reserved: {}, elapsedMs: 0 };
  const a = reserveChild(parent, "a", { turns: 2, toolCalls: 2, runtimeSeconds: 60 });
  assert.equal(a.ok && a.budget.costUsd, 0.8, "a child without its own cost limit gets what the parent has left");
  if (!a.ok) return;
  const b = reserveChild({ ...parent, reserved: a.reserved }, "b", { turns: 2, toolCalls: 2, runtimeSeconds: 60 });
  assert.equal(b.ok, false);
  assert.match(!b.ok ? b.why : "", /cost budget is used up/);
  const c = reserveChild(parent, "c", { turns: 2, toolCalls: 2, runtimeSeconds: 60, costUsd: 0.25 });
  assert.equal(c.ok && c.budget.costUsd, 0.25);
  assert.equal(releaseChild(a.reserved, "a", { ...EMPTY_USAGE, costUsd: 0.05 }).a.costUsd, 0.05);
});

test("the budget view says what is used, what is left and whether the cost is estimated", () => {
  const v = budgetView({ turns: 4, toolCalls: 10, runtimeSeconds: 600 }, { ...EMPTY_USAGE, turns: 1, toolCalls: 2, inputTokens: 900, outputTokens: 80, costUnmeasured: 1 }, { k: { turns: 1, toolCalls: 2 } }, 30_000);
  assert.deepEqual(v.used, { turns: 1, toolCalls: 2, seconds: 30, inputTokens: 900, outputTokens: 80 }, "no cost shown when it couldn't be measured");
  assert.deepEqual([v.remaining.turns, v.remaining.toolCalls, v.remaining.runtimeSeconds], [2, 6, 570]);
  assert.deepEqual(v.reservedForChildren, { turns: 1, toolCalls: 2 });
  assert.equal(v.cost, "not measurable");
  assert.equal(budgetView({ turns: 4, toolCalls: 10, runtimeSeconds: 600 }, { ...EMPTY_USAGE, turns: 1 }, {}, 0).cost, "estimated");
  assert.equal(budgetView({ turns: 4, toolCalls: 10, runtimeSeconds: 600 }, EMPTY_USAGE, {}, 0).cost, "none");
});
