import { test } from "node:test";
import assert from "node:assert/strict";
import { SlotWaitError, createSlots, runtimeConcurrency } from "./slots.ts";

test("one slot by default: the second run waits, first come first served, and learns how many are ahead", async () => {
  const slots = createSlots(() => 1);
  const order: string[] = [];
  const a = await slots.acquire();
  const queued: number[] = [];
  const pb = slots.acquire({ onQueued: (n) => queued.push(n) }).then((r) => (order.push("b"), r));
  const pc = slots.acquire({ onQueued: (n) => queued.push(n) }).then((r) => (order.push("c"), r));
  assert.deepEqual(queued, [1, 2]);
  assert.deepEqual([slots.active(), slots.waiting()], [1, 2]);
  a();
  a(); // releasing twice is harmless
  const b = await pb;
  assert.deepEqual([slots.active(), slots.waiting()], [1, 1]);
  b();
  (await pc)();
  assert.deepEqual(order, ["b", "c"]);
  assert.deepEqual([slots.active(), slots.waiting()], [0, 0]);
});

test("cancelled or past its deadline while waiting: leaves the queue without taking a slot", async () => {
  const slots = createSlots(() => 1);
  const hold = await slots.acquire();
  const ac = new AbortController();
  const cancelled = slots.acquire({ signal: ac.signal });
  const late = slots.acquire({ until: Date.now() + 30 });
  const next = slots.acquire();
  ac.abort();
  await assert.rejects(cancelled, (e: unknown) => e instanceof SlotWaitError && e.reason === "cancelled");
  await assert.rejects(late, (e: unknown) => e instanceof SlotWaitError && e.reason === "deadline");
  assert.equal(slots.waiting(), 1);
  hold();
  (await next)();
  assert.equal(slots.active(), 0);
  await assert.rejects(slots.acquire({ signal: AbortSignal.abort() }), /cancelled/);
  await assert.rejects(slots.acquire({ until: Date.now() - 1 }), /deadline/);
});

test("a deadline beyond setTimeout's range keeps waiting instead of expiring at once", async () => {
  const slots = createSlots(() => 1);
  const hold = await slots.acquire();
  let settled = "";
  const far = slots.acquire({ until: Date.now() + 40 * 24 * 3_600_000 }).then(
    (release) => ((settled = "granted"), release),
    () => void (settled = "rejected"),
  );
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(settled, "", "still queued");
  hold();
  const release = await far;
  assert.equal(settled, "granted");
  release?.();
  assert.equal(slots.active(), 0);
});

test("the limit is read when slots free up; CONSOLE_RUNTIME_CONCURRENCY parsing", async () => {
  let limit = 2;
  const slots = createSlots(() => limit);
  const r1 = await slots.acquire();
  const r2 = await slots.acquire();
  limit = 1;
  const p3 = slots.acquire();
  r1();
  assert.equal(slots.waiting(), 1, "still one running, the new limit is 1");
  r2();
  (await p3)();
  assert.equal(runtimeConcurrency(undefined), 1);
  assert.equal(runtimeConcurrency("3"), 3);
  for (const v of ["0", "-1", "17", "2.5", "two", " 4x"]) assert.equal(runtimeConcurrency(v), 1, v);
});
