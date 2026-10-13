import { test } from "node:test";
import assert from "node:assert/strict";
import { LogStore, MAX_LINE_CHARS, defaultMaxBytes, lineBytes, sniffLevel } from "./logstore.ts";
import type { LogLine } from "./types.ts";

const lines = (from: number, n: number, text = "req"): LogLine[] =>
  Array.from({ length: n }, (_, i) => [from + i, 0, `${text} ${from + i}`]);

test("level sniffing: pino numbers, Go text, plain", () => {
  assert.equal(sniffLevel('{"level":50,"msg":"boom"}'), 5);
  assert.equal(sniffLevel('{"level":30,"msg":"ok"}'), 3);
  assert.equal(sniffLevel("time=2026 level=WARN msg=slow"), 4);
  assert.equal(sniffLevel('{"level":"error","msg":"x"}'), 5);
  assert.equal(sniffLevel("panic: runtime error"), 6);
  assert.equal(sniffLevel("GET /health 200"), 0);
});

test("bounded: trims in batches and tracks dropped lines", () => {
  const s = new LogStore(1000);
  s.append(lines(0, 1000), ["a"]);
  assert.equal(s.size, 1000);
  s.append(lines(1000, 100), ["a"]); // 1100 = capacity*1.1, not over yet
  assert.equal(s.size, 1100);
  const r = s.append(lines(1100, 1), ["a"]);
  assert.equal(r.trimmed, 101);
  assert.equal(s.size, 1000);
  assert.equal(s.dropped, 101);
  assert.equal(s.msg[0], "req 101");
});

test("filter index stays correct across appends and trims", () => {
  const s = new LogStore(100);
  s.append(lines(0, 100), ["a"]);
  s.setFilter("req 9");
  assert.equal(s.visibleCount, 11); // 9, 90..99
  s.append([[100, 0, "req 900"]], ["a"]);
  assert.equal(s.visibleCount, 12);
  s.append(lines(101, 20, "other"), ["a"]); // triggers trim of 21
  assert.ok(s.visibleCount <= 12);
  for (let r = 0; r < s.visibleCount; r++) assert.ok(s.msg[s.lineAt(r)].includes("req 9"));
  s.setFilter("");
  assert.equal(s.visibleCount, s.size);
});

test("min level filter", () => {
  const s = new LogStore();
  s.append([[1, 0, '{"level":30}'], [2, 0, '{"level":50}'], [3, 0, "plain"]], ["a"]);
  s.setFilter("", 4);
  assert.equal(s.visibleCount, 1);
});

test("a page that overlaps the newest lines is merged into time order, filters included", () => {
  const s = new LogStore();
  // stream a flushed up to t=20; stream b's lines for t=11..13 arrive a poll later
  s.append([[10, 0, "a err 10"], [15, 0, "a ok 15"], [20, 0, "a err 20"]], ["a"]);
  s.setFilter("err");
  assert.deepEqual(Array.from({ length: s.visibleCount }, (_, r) => s.msg[s.lineAt(r)]), ["a err 10", "a err 20"]);
  s.append([[11, 0, "b err 11"], [13, 0, "b ok 13"], [21, 0, "b err 21"]], ["b"]);
  assert.deepEqual(s.ts, [10, 11, 13, 15, 20, 21]);
  assert.deepEqual(s.streams, ["a", "b"]);
  assert.deepEqual(s.stream, [0, 1, 1, 0, 0, 1]);
  assert.deepEqual(Array.from({ length: s.visibleCount }, (_, r) => s.msg[s.lineAt(r)]), ["a err 10", "b err 11", "a err 20", "b err 21"]);
  assert.deepEqual(s.matchRows, [0, 1, 2, 3]);
  s.setQuery({ mode: "highlight" });
  s.append([[12, 0, "c err 12"]], ["c"]);
  assert.deepEqual(s.ts, [10, 11, 12, 13, 15, 20, 21]);
  assert.deepEqual(s.matchRows.map((i) => s.msg[i]), ["a err 10", "b err 11", "c err 12", "a err 20", "b err 21"]);
});

test("stream ids are stable across pages", () => {
  const s = new LogStore();
  s.append([[1, 0, "x"], [2, 1, "y"]], ["task-a", "task-b"]);
  s.append([[3, 0, "z"]], ["task-b"]);
  assert.deepEqual(s.stream, [0, 1, 1]);
  assert.deepEqual(s.streams, ["task-a", "task-b"]);
});

test("prepend respects capacity", () => {
  const s = new LogStore(10);
  s.append(lines(100, 8), ["a"]);
  const took = s.prepend(lines(0, 5), ["a"]);
  assert.equal(took, 2);
  assert.equal(s.msg[0], "req 3");
});

test("50k-line append + filter is fast", () => {
  const s = new LogStore();
  const t0 = performance.now();
  s.append(lines(0, 50_000, '{"level":30,"msg":"GET /api/v2/stones"}'), ["a"]);
  s.setFilter("stones 4999");
  const ms = performance.now() - t0;
  assert.ok(ms < 500, `took ${ms}ms`);
});

test("prettyLine summarises pino / caddy JSON and passes plain text through", async () => {
  const { prettyLine } = await import("./logstore.ts");
  const p = prettyLine('{"level":30,"time":1,"pid":1,"hostname":"h","reqId":"r1","req":{"method":"GET","url":"/api/v2/cart"},"res":{"statusCode":200},"responseTime":12.5,"msg":"request completed"}');
  assert.equal(p, "request completed  GET /api/v2/cart  → 200  12.5ms  reqId=r1");
  assert.match(prettyLine('{"level":50,"msg":"cart add failed","err":{"type":"PrismaError","message":"boom"}}'), /cart add failed {2}PrismaError: boom/);
  assert.equal(prettyLine("time=x level=INFO msg=ok"), "time=x level=INFO msg=ok");
  assert.equal(prettyLine("{not json"), "{not json");
});

test("query modes: filter shows matches only; highlight shows all and records match rows", async () => {
  const { parseQuery } = await import("./logquery.ts");
  const s = new LogStore();
  s.append([[1, 0, '{"level":30,"msg":"ok"}'], [2, 0, '{"level":50,"msg":"boom"}'], [3, 0, '{"level":30,"msg":"ok"}'], [4, 0, '{"level":50,"msg":"boom 2"}']], ["a"]);
  const r = parseQuery("level:error");
  assert.ok(r.ok);
  s.setQuery({ q: r.q, mode: "filter" });
  assert.equal(s.visibleCount, 2);
  assert.deepEqual(s.matchRows, [0, 1]);
  s.setQuery({ mode: "highlight" });
  assert.equal(s.visibleCount, 4);
  assert.deepEqual(s.matchRows, [1, 3]);
  s.append([[5, 0, '{"level":50,"msg":"boom 3"}']], ["a"]);
  assert.deepEqual(s.matchRows, [1, 3, 4], "incremental on append");
  s.setQuery({ range: [2, 4] });
  assert.equal(s.visibleCount, 3);
  assert.deepEqual(s.matchRows, [0, 2]);
});

test("histogram buckets by level and facets count values", () => {
  const s = new LogStore();
  s.append([[0, 0, '{"level":50,"status":500}'], [50, 0, '{"level":40,"status":200}'], [100, 0, '{"level":30,"status":200}']], ["a"]);
  const h = s.histogram(2)!;
  assert.deepEqual([h.err, h.warn, h.other], [[1, 0], [0, 1], [0, 1]]);
  const f = s.facets((m) => /"status":(\d+)/.exec(m)?.[1]);
  assert.deepEqual(f, [{ value: "200", count: 2 }, { value: "500", count: 1 }]);
  assert.deepEqual(s.levelCounts().slice(3), [1, 1, 1, 0]);
});

test("F49: a byte budget beside the line cap — big lines trim from the front, in batches", () => {
  const big = "x".repeat(10_000); // ~20 KB each
  const s = new LogStore(200_000, 1_000_000);
  s.append(Array.from({ length: 80 }, (_, i) => [i, 0, `${big}${i}`] as [number, number, string]), ["a"]);
  assert.ok(s.bytes <= 1_100_000, `held ${s.bytes}`);
  assert.ok(s.size < 80 && s.dropped > 0 && s.bytes <= 1_000_000);
  assert.equal(s.msg[s.size - 1], `${big}79`, "the newest lines stay");
  assert.equal(s.bytes, s.msg.reduce((a, m) => a + lineBytes(m), 0), "the running total matches the lines held");
  // Small lines: the line cap still applies first.
  const t = new LogStore(1000, 1_000_000);
  t.append(lines(0, 1200), ["a"]);
  assert.equal(t.size, 1000);
  s.clear();
  assert.equal(s.bytes, 0);
});

test("F49: prepend respects both limits, keeping the newest end of the older page", () => {
  const s = new LogStore(1000, 50_000);
  s.append([[100, 0, "x".repeat(10_000)]], ["a"]); // ~20 KB of 50
  const took = s.prepend(Array.from({ length: 5 }, (_, i) => [i, 0, "y".repeat(5_000) + i] as [number, number, string]), ["a"]);
  assert.equal(took, 2, "only two ~10 KB lines fit in what is left");
  assert.deepEqual(s.ts, [3, 4, 100]);
  assert.ok(s.bytes <= 50_000);
});

test("F49: one line keeps at most 32k characters and says how much was cut", () => {
  const s = new LogStore();
  s.append([[1, 0, "z".repeat(MAX_LINE_CHARS + 5_000)]], ["a"]);
  assert.ok(s.msg[0].startsWith("z".repeat(MAX_LINE_CHARS)));
  assert.match(s.msg[0], /…\[line cut: 5,000 more characters\]$/);
  assert.equal(defaultMaxBytes(), 64 * 1024 * 1024, "no navigator.deviceMemory: the larger budget");
  const nav = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", { value: { deviceMemory: 4 }, configurable: true });
  try {
    assert.equal(defaultMaxBytes(), 16 * 1024 * 1024);
  } finally {
    if (nav) Object.defineProperty(globalThis, "navigator", nav);
    else delete (globalThis as { navigator?: unknown }).navigator;
  }
});
