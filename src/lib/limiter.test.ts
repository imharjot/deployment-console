import { test } from "node:test";
import assert from "node:assert/strict";
import { keyedLimiter } from "./limiter.ts";

// A call that runs until the test lets it finish; `started` says whether fn ever ran.
function gate() {
  let open!: () => void;
  const done = new Promise<void>((r) => (open = r));
  const g = { started: false, open, fn: async () => { g.started = true; await done; return "ok"; } };
  return g;
}
const tick = () => new Promise((r) => setImmediate(r));

test("the global cap holds across keys, and the per-key cap within one", async () => {
  const l = keyedLimiter({ global: 3, perKey: () => 2 });
  const calls = ["a", "a", "a", "b", "b", "c"].map((k) => ({ k, g: gate() }));
  const runs = calls.map((c) => l.run(c.k, c.g.fn));
  await tick();
  assert.deepEqual(calls.map((c) => c.g.started), [true, true, false, true, false, false], "a×2 + b×1 = 3 global slots");
  assert.deepEqual(l.stats(), { a: { active: 2, queued: 1 }, b: { active: 1, queued: 1 }, c: { active: 0, queued: 1 } });
  calls[0].g.open();
  await tick();
  // A global slot freed: the next in the global queue is the second "b" (queued before "c"); a's third call now holds
  // a's key slot and queues for the global slot behind "c".
  assert.deepEqual(calls.map((c) => c.g.started), [true, true, false, true, true, false]);
  assert.deepEqual(l.stats(), { a: { active: 1, queued: 1 }, b: { active: 2, queued: 0 }, c: { active: 0, queued: 1 } });
  for (const c of calls) c.g.open();
  assert.deepEqual(await Promise.all(runs), calls.map(() => "ok"));
  assert.deepEqual(l.stats(), {});
});

test("a small service is not starved by a big one (audit-plan inventory-engine 2c)", async () => {
  const l = keyedLimiter({ global: 4, perKey: (k) => (k === "big" ? 4 : 2) });
  const order: string[] = [];
  const slow = (k: string, ms: number) => () => new Promise<string>((r) => setTimeout(() => (order.push(k), r(k)), ms));
  const big = Array.from({ length: 200 }, () => l.run("big", slow("big", 2)));
  await tick();
  const small = [l.run("small", slow("small", 1)), l.run("small", slow("small", 1))];
  await Promise.all(small);
  // The big service queued 200 calls first, yet the small one finished within a few of its batches.
  const firstSmall = order.indexOf("small");
  assert.ok(firstSmall >= 0 && firstSmall < 12, `small finished after ${firstSmall} big calls`);
  await Promise.all(big);
  assert.equal(order.length, 202);
});

test("a call whose signal fires while queued rejects and never starts; its slot isn't lost", async () => {
  const l = keyedLimiter({ global: 1, perKey: () => 1 });
  const first = gate();
  const running = l.run("ecs@us-east-1", first.fn);
  const waitKey = gate();
  const ac = new AbortController();
  const queuedOnKey = l.run("ecs@us-east-1", waitKey.fn, ac.signal); // waits for the key slot
  const waitGlobal = gate();
  const ac2 = new AbortController();
  const queuedOnGlobal = l.run("logs@us-east-1", waitGlobal.fn, ac2.signal); // holds its key, waits for the global slot
  await tick();
  assert.deepEqual(l.stats(), { "ecs@us-east-1": { active: 1, queued: 1 }, "logs@us-east-1": { active: 0, queued: 1 } });
  ac.abort();
  ac2.abort(new DOMException("deadline", "TimeoutError"));
  await assert.rejects(queuedOnKey, { name: "AbortError" });
  await assert.rejects(queuedOnGlobal, { name: "TimeoutError" });
  assert.equal(waitKey.started || waitGlobal.started, false);
  assert.deepEqual(l.stats(), { "ecs@us-east-1": { active: 1, queued: 0 } });
  first.open();
  assert.equal(await running, "ok");
  // Both slots came back: the next calls on either key run at once.
  assert.equal(await l.run("logs@us-east-1", async () => "logs"), "logs");
  assert.equal(await l.run("ecs@us-east-1", async () => "ecs"), "ecs");
  const done = new AbortController();
  done.abort();
  await assert.rejects(l.run("ecs@us-east-1", async () => "never", done.signal), { name: "AbortError" });
});

test("a failing call releases its slots", async () => {
  const l = keyedLimiter({ global: 1, perKey: () => 1 });
  await assert.rejects(l.run("k", async () => { throw new Error("boom"); }), /boom/);
  assert.equal(await l.run("k", async () => 1), 1);
  assert.deepEqual(l.stats(), {});
});
