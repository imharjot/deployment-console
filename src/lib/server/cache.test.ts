import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { cacheStats, cached, invalidate, MAX_ENTRIES, MAX_MEMO, memo, sweepCache } from "./cache.ts";

// A controllable clock: the cache only reads Date.now().
const realNow = Date.now;
let clock = 1_800_000_000_000;
beforeEach(() => {
  clock = 1_800_000_000_000;
  Date.now = () => clock;
  invalidate("");
});
afterEach(() => {
  Date.now = realNow;
  invalidate("");
});

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
const tick = () => new Promise((r) => setImmediate(r));

test("hit inside ttl does not call fn again; at is the fetch time", async () => {
  let calls = 0;
  const fn = async () => ++calls;
  const a = await cached("k", 10_000, fn);
  clock += 5_000;
  const b = await cached("k", 10_000, fn);
  assert.equal(calls, 1);
  assert.deepEqual(a, { value: 1, at: 1_800_000_000_000 });
  assert.deepEqual(b, a);
  clock += 6_000;
  assert.equal((await cached("k", 10_000, fn)).value, 2);
});

test("concurrent callers share one fetch", async () => {
  let calls = 0;
  const d = deferred<string>();
  const fn = () => (calls++, d.promise);
  const p1 = cached("k", 10_000, fn);
  const p2 = cached("k", 10_000, fn);
  d.resolve("v");
  assert.deepEqual(await p1, await p2);
  assert.equal(calls, 1);
});

// R26 interleaving 1: the old code dereferenced store.get(key)!.at after the await and threw a TypeError.
test("R26: joiner, then invalidate, then release — joiner gets the value with at > 0", async () => {
  const d = deferred<string>();
  const first = cached("svc:x", 10_000, () => d.promise);
  const joiner = cached("svc:x", 10_000, () => Promise.resolve("never"));
  await tick();
  invalidate("svc:");
  clock += 100;
  d.resolve("v1");
  const [a, b] = await Promise.all([first, joiner]);
  assert.equal(b.value, "v1");
  assert.ok(b.at > 0);
  assert.deepEqual(a, b);
});

// R26 interleaving 2: a newer generation started after the invalidate; the original must neither leak into it nor
// hand its joiner the newer generation's `at`.
test("R26: joiner, invalidate, new fetch, original releases — joiner keeps the original at; cache keeps the new generation", async () => {
  const d1 = deferred<string>();
  const d2 = deferred<string>();
  const first = cached("svc:x", 10_000, () => d1.promise);
  const joiner = cached("svc:x", 10_000, () => Promise.resolve("never"));
  await tick();
  invalidate("svc:x");
  clock += 1_000;
  const second = cached("svc:x", 10_000, () => d2.promise);
  clock += 1_000;
  d2.resolve("v2");
  const s = await second;
  assert.deepEqual(s, { value: "v2", at: clock });
  clock += 1_000;
  d1.resolve("v1");
  const j = await joiner;
  assert.deepEqual(j, { value: "v1", at: clock });
  assert.deepEqual(await first, j);
  // The late original did not repopulate the cache over the newer generation.
  const now = await cached("svc:x", 10_000, () => Promise.resolve("v3"));
  assert.deepEqual(now, s);
});

// R26 interleaving 3: errors propagate unchanged to joiners, even across an invalidate.
test("R26: a joiner of a rejected fetch rejects with the same error", async () => {
  const d = deferred<string>();
  const first = cached("k", 10_000, () => d.promise);
  const joiner = cached("k", 10_000, () => Promise.resolve("never"));
  await tick();
  invalidate("k");
  const boom = new Error("AccessDeniedException");
  d.reject(boom);
  await assert.rejects(first, (e) => e === boom);
  await assert.rejects(joiner, (e) => e === boom);
});

test("errors are never served as data and are negatively cached for 2 s", async () => {
  let calls = 0;
  const fail = async () => {
    calls++;
    throw new Error("down");
  };
  await assert.rejects(cached("k", 10_000, fail), /down/);
  await assert.rejects(cached("k", 10_000, fail), /down/);
  assert.equal(calls, 1);
  clock += 2_500;
  await assert.rejects(cached("k", 10_000, fail), /down/);
  assert.equal(calls, 2);
  // A thrown non-Error becomes an Error.
  await assert.rejects(cached("k2", 10_000, () => Promise.reject("plain")), (e) => e instanceof Error && e.message === "plain");
});

test("a function that throws synchronously rejects instead of breaking the entry", async () => {
  await assert.rejects(cached("k", 10_000, () => { throw new Error("sync"); }), /sync/);
  clock += 3_000;
  assert.equal((await cached("k", 10_000, async () => "ok")).value, "ok");
});

test("SWR: a stale hit returns immediately with its original at and triggers exactly one refresh", async () => {
  let calls = 0;
  const d = deferred<string>();
  await cached("k", 10_000, async () => (calls++, "old"), { staleMs: 10_000 });
  const t0 = clock;
  clock += 15_000; // past ttl, inside ttl + staleMs
  const fn = () => (calls++, d.promise);
  const a = await cached("k", 10_000, fn, { staleMs: 10_000 });
  const b = await cached("k", 10_000, fn, { staleMs: 10_000 });
  assert.deepEqual(a, { value: "old", at: t0 });
  assert.deepEqual(b, { value: "old", at: t0 });
  assert.equal(calls, 2); // the first fetch + one background refresh
  d.resolve("new");
  await tick();
  const c = await cached("k", 10_000, fn, { staleMs: 10_000 });
  assert.deepEqual(c, { value: "new", at: clock });
  assert.equal(calls, 2);
});

test("SWR: without staleMs an expired entry blocks for a fresh value (as before)", async () => {
  await cached("k", 10_000, async () => "old");
  clock += 15_000;
  const d = deferred<string>();
  let settled = false;
  const p = cached("k", 10_000, () => d.promise).then((r) => ((settled = true), r));
  await tick();
  assert.equal(settled, false);
  d.resolve("new");
  assert.equal((await p).value, "new");
});

test("SWR: a failed background refresh serves the old value inside the window and throws outside it", async () => {
  await cached("k", 10_000, async () => "old", { staleMs: 10_000 });
  const t0 = clock;
  clock += 12_000;
  let calls = 0;
  const fail = async () => {
    calls++;
    throw new Error("refresh failed");
  };
  const a = await cached("k", 10_000, fail, { staleMs: 10_000 });
  assert.deepEqual(a, { value: "old", at: t0 });
  await tick();
  assert.equal(calls, 1);
  // Still inside the window: the old value, no new refresh within the 2 s negative window.
  clock += 1_000;
  assert.deepEqual(await cached("k", 10_000, fail, { staleMs: 10_000 }), { value: "old", at: t0 });
  await tick();
  assert.equal(calls, 1);
  // Beyond ttl + staleMs: blocking; the failure is thrown, never the old value.
  clock += 8_000;
  await assert.rejects(cached("k", 10_000, fail, { staleMs: 10_000 }), /refresh failed/);
});

test("invalidate forces a blocking refresh, even with staleMs", async () => {
  await cached("svc:a", 10_000, async () => "old", { staleMs: 10_000 });
  clock += 12_000;
  invalidate("svc:");
  const d = deferred<string>();
  let settled = false;
  const p = cached("svc:a", 10_000, () => d.promise, { staleMs: 10_000 }).then((r) => ((settled = true), r));
  await tick();
  assert.equal(settled, false);
  d.resolve("new");
  assert.deepEqual(await p, { value: "new", at: clock });
});

test("sweep drops entries older than max(2 × (ttl + stale), 10 min) and keeps entries in flight", async () => {
  await cached("old", 10_000, async () => 1);
  await cached("recent", 10_000, async () => 2);
  const d = deferred<number>();
  await cached("busy", 10_000, async () => 0);
  clock += 11 * 60_000;
  await cached("recent", 10_000, async () => 3); // refreshed now
  const busy = cached("busy", 10_000, () => d.promise); // expired, now in flight
  await tick();
  sweepCache(clock);
  const after = cacheStats();
  assert.equal(after.entries, 2); // "recent" and the in-flight "busy"
  assert.equal(after.inflight, 1);
  d.resolve(4);
  assert.equal((await busy).value, 4);
  // "old" was dropped: the next read fetches again.
  let refetched = false;
  await cached("old", 10_000, async () => ((refetched = true), 5));
  assert.equal(refetched, true);
});

test("a long ttl is not swept early (10-minute floor, 2 × ttl beyond it)", async () => {
  await cached("hour", 3_600_000, async () => 1);
  clock += 90 * 60_000; // past ttl, inside 2 × ttl
  sweepCache(clock);
  assert.equal(cacheStats().entries, 1);
  clock += 31 * 60_000;
  sweepCache(clock);
  assert.equal(cacheStats().entries, 0);
});

test("TTL entries are capped at 5,000, oldest written first out", async () => {
  for (let i = 0; i <= MAX_ENTRIES; i++) {
    clock += 1;
    await cached(`cap:${i}`, 60_000, async () => i);
  }
  assert.equal(cacheStats().entries, MAX_ENTRIES);
  let refetched = false;
  await cached("cap:0", 60_000, async () => ((refetched = true), -1));
  assert.equal(refetched, true, "the oldest entry was evicted");
  refetched = false;
  await cached(`cap:${MAX_ENTRIES}`, 60_000, async () => ((refetched = true), -1));
  assert.equal(refetched, false, "the newest entry is still cached");
});

test("memo entries are capped at 5,000, least recently used first out; never swept by age", async () => {
  for (let i = 0; i < MAX_MEMO; i++) await memo(`sha:${i}`, async () => i);
  clock += 24 * 3600_000;
  sweepCache(clock);
  assert.equal(cacheStats().memo, MAX_MEMO);
  await memo("sha:0", async () => -1); // a hit: sha:0 is now the most recently used
  await memo("sha:new", async () => 9);
  assert.equal(cacheStats().memo, MAX_MEMO);
  assert.equal(await memo("sha:0", async () => -2), 0, "recently used survives");
  assert.equal(await memo("sha:1", async () => -3), -3, "least recently used was evicted");
});

// R19: the limiter's AsyncLocalStorage (aws-limiter.ts, on globalThis) carries a caller's deadline into its AWS calls. A
// shared fetch — first fill and SWR refresh alike — runs outside it, so one joiner's deadline can't fail the others.
test("a shared fetch never inherits the call signal of the caller that started it", async () => {
  const g = globalThis as { __consoleAwsLimiter?: unknown };
  const had = Object.hasOwn(g, "__consoleAwsLimiter");
  const before = g.__consoleAwsLimiter;
  const als = new AsyncLocalStorage<AbortSignal>();
  g.__consoleAwsLimiter = { signal: als };
  try {
    const seen: (AbortSignal | undefined)[] = [];
    const fn = async () => {
      seen.push(als.getStore());
      await tick();
      seen.push(als.getStore()); // still outside after an await
      return "v";
    };
    const deadline = AbortSignal.timeout(60_000);
    const r = await als.run(deadline, async () => {
      const inside = als.getStore();
      const v = await cached("k", 1_000, fn, { staleMs: 10_000 });
      return { inside, v };
    });
    assert.equal(r.inside, deadline, "the caller itself keeps its signal");
    assert.equal(r.v.value, "v");
    clock += 2_000; // stale: the background refresh starts from inside the caller's signal too
    await als.run(deadline, () => cached("k", 1_000, fn, { staleMs: 10_000 }));
    await tick();
    await tick();
    assert.deepEqual(seen, [undefined, undefined, undefined, undefined]);
  } finally {
    if (had) g.__consoleAwsLimiter = before;
    else delete g.__consoleAwsLimiter;
  }
});
