import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { enrichAll } from "./work-queue.ts";

// A clock the test moves: each enrichment call "takes" `cost` ms of it.
function clock(start = 1_000) {
  let now = start;
  const real = Date.now;
  Date.now = () => now;
  return { advance: (ms: number) => (now += ms), restore: () => (Date.now = real) };
}

test("the budget is checked when each item starts: late items are skipped, finished ones kept", async () => {
  const c = clock();
  try {
    const started: number[] = [];
    const r = await enrichAll([1, 2, 3, 4, 5, 6], { concurrency: 2, until: 1_030 }, async (x) => {
      started.push(x);
      c.advance(10); // items start at 1000, 1010, 1020, 1030; item 5 would start at 1040, past the budget
      await new Promise((r) => setImmediate(r));
      return x * 10;
    });
    assert.deepEqual(started, [1, 2, 3, 4]);
    assert.deepEqual(r.results, [10, 20, 30, 40, undefined, undefined]);
    assert.deepEqual(r.state, ["ok", "ok", "ok", "ok", "skipped", "skipped"]);
    assert.equal(r.skippedForTime, 2);
    assert.equal(r.capped, 0);
  } finally {
    c.restore();
  }
});

test("max caps the work (counted), errors and denials are per item, never thrown", async () => {
  const r = await enrichAll(["a", "denied", "b", "boom", "c", "d"], { concurrency: 3, max: 4 }, async (x) => {
    if (x === "denied") throw Object.assign(new Error("User: x is not authorized to perform: lambda:GetPolicy"), { name: "AccessDeniedException" });
    if (x === "boom") throw new Error("socket hang up");
    return x.toUpperCase();
  });
  assert.deepEqual(r.state, ["ok", "denied", "ok", "error", "capped", "capped"]);
  assert.deepEqual(r.results, ["A", undefined, "B", undefined, undefined, undefined]);
  assert.equal(r.capped, 2);
  assert.equal(r.skippedForTime, 0);
  assert.deepEqual(await enrichAll([], { concurrency: 4 }, async () => 1), { results: [], state: [], skippedForTime: 0, capped: 0 });
});

test("once the run's signal fires nothing more starts; the item it cut short counts as skipped", async () => {
  const ac = new AbortController();
  const started: number[] = [];
  const r = await enrichAll([1, 2, 3, 4], { concurrency: 1, signal: ac.signal }, async (x) => {
    started.push(x);
    if (x === 2) {
      ac.abort();
      throw new DOMException("aborted", "AbortError");
    }
    return x;
  });
  assert.deepEqual(started, [1, 2]);
  assert.deepEqual(r.state, ["ok", "skipped", "skipped", "skipped"]);
  assert.equal(r.skippedForTime, 3);
});

// REVIEW R18 evidence (deployment-console-budget-review.mts): optional reads queued behind a busy limiter used to pass
// the budget check at queue time and then all run after the budget. softly() now checks when the call starts.
// serverless-util imports "server-only", so this part runs in a child process under the react-server condition.
test("R18: softly() checks its budget when a queued call starts, not when it was queued", () => {
  const util = new URL("./server/providers/serverless-util.ts", import.meta.url).href;
  const script = `
    const { softly } = await import(${JSON.stringify(util)});
    const queue = [], notes = [];
    const ctx = { region: "us-east-1", mock: false, cap: 2000, signal: new AbortController().signal, note: (m) => notes.push(m),
      limit: (fn) => new Promise((resolve, reject) => queue.push(() => Promise.resolve().then(fn).then(resolve, reject))) };
    let now = 100;
    Date.now = () => now;
    const optional = softly(ctx, "test", { until: 110 });
    const requested = [1, 2, 3].map((i) => optional(async () => ({ i, startedAt: Date.now() })));
    now = 200; // the limiter only lets them start after the budget
    for (const start of queue) await start();
    const after = await optional(async () => "late");
    process.stdout.write(JSON.stringify({ result: await Promise.all(requested), notes, after, queued: queue.length }));
  `;
  const out = JSON.parse(execFileSync(process.execPath, ["--conditions=react-server", "--no-warnings", "--input-type=module", "-e", script], { encoding: "utf8", timeout: 60_000 }));
  assert.deepEqual(out.result, [null, null, null], "nothing ran after the budget");
  assert.deepEqual(out.notes, ["test: skipped for the rest (discovery time budget)"], "noted once");
  assert.equal(out.after, undefined, "later calls are skipped without queueing");
  assert.equal(out.queued, 3);
});

test("enrich(): one note per kind, a denial stops further calls of that kind, not-found is an answer", () => {
  const util = new URL("./server/providers/serverless-util.ts", import.meta.url).href;
  const script = `
    const { enrich } = await import(${JSON.stringify(util)});
    const notes = [], called = [];
    const ctx = { region: "us-east-1", mock: false, cap: 2000, signal: new AbortController().signal, note: (m) => notes.push(m), limit: (fn) => fn() };
    const fn = async (x) => {
      called.push(x);
      if (x === "gone") throw Object.assign(new Error("not found"), { name: "ResourceNotFoundException" });
      if (x === "locked") throw Object.assign(new Error("User: u is not authorized to perform: lambda:GetPolicy on resource: f"), { name: "AccessDeniedException" });
      return x.toUpperCase();
    };
    const r = await enrich(ctx, ["a", "gone", "locked", "b", "c", "d"], { label: "Lambda policies", max: 5, concurrency: 1 }, fn);
    const late = await enrich(ctx, ["x", "y"], { label: "tags", max: 10, until: Date.now() - 1 }, fn);
    process.stdout.write(JSON.stringify({ r, called, notes, late }));
  `;
  const out = JSON.parse(execFileSync(process.execPath, ["--conditions=react-server", "--no-warnings", "--input-type=module", "-e", script], { encoding: "utf8", timeout: 60_000 }));
  assert.deepEqual(out.r.state, ["ok", "ok", "denied", "denied", "denied", "capped"]);
  assert.deepEqual(out.r.results, ["A", null, null, null, null, null]);
  assert.deepEqual(out.called, ["a", "gone", "locked"], "nothing after the denial, nothing past max, nothing past the budget");
  assert.deepEqual(out.notes, ["Lambda policies read for the first 5 of 6", "Lambda policies skipped: lambda:GetPolicy denied", "tags: 2 not read (discovery time budget)"]);
  assert.deepEqual(out.late.state, ["skipped", "skipped"]);
});
