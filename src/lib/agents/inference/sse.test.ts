import { test } from "node:test";
import assert from "node:assert/strict";
import { readBody, readSse, SseParser, StreamIdleError, type SseEvent } from "./sse.ts";
import { chunked } from "./fixtures/load.ts";

const all = async (body: ReadableStream<Uint8Array>, o?: { signal?: AbortSignal; idleMs?: number }) => {
  const out: SseEvent[] = [];
  for await (const e of readSse(body, o)) out.push(e);
  return out;
};

const STREAM = "\uFEFFevent: one\ndata: {\"a\":\"é😀\"}\n\n: a comment\r\ndata: line 1\r\ndata: line 2\r\nid: 7\r\n\r\nevent: ping\ndata\n\nretry: 10\nevent: nodata\n\ndata:no-space\rdata: second\r\r";

test("events parse the same whatever the chunk boundaries (lines, CRLF pairs and UTF-8 characters split)", async () => {
  const expected: SseEvent[] = [
    { event: "one", data: '{"a":"é😀"}' },
    { event: "message", data: "line 1\nline 2", id: "7" },
    { event: "ping", data: "", id: "7" },
    { event: "message", data: "no-space\nsecond", id: "7" },
  ];
  for (const size of [1, 2, 3, 5, 7, 11, 64, 4096]) assert.deepEqual(await all(chunked(STREAM, size)), expected, `chunk size ${size}`);
});

test("an event cut off before its blank line is never dispatched", async () => {
  const p = new SseParser();
  assert.deepEqual(p.feed('data: {"complete":true}\n\ndata: {"cut'), [{ event: "message", data: '{"complete":true}' }]);
  assert.deepEqual(p.end(), []);
  assert.deepEqual(await all(chunked('data: {"x":1}\n\ndata: {"partial":', 3)), [{ event: "message", data: '{"x":1}' }]);
});

test("a stream that goes silent is cut off; an abort stops it", async () => {
  await assert.rejects(all(chunked("data: 1\n\n", 64, { hangAfter: true }), { idleMs: 30 }), (e) => e instanceof StreamIdleError);
  const ac = new AbortController();
  const p = all(chunked("data: 1\n\n", 64, { hangAfter: true }), { signal: ac.signal, idleMs: 10_000 });
  setTimeout(() => ac.abort(), 10);
  await assert.rejects(p, (e) => (e as Error).name === "AbortError");
});

test("readBody keeps at most `max` bytes", async () => {
  assert.equal(await readBody(chunked("x".repeat(10_000), 333), { max: 1000 }), "x".repeat(1000));
  assert.equal(await readBody(chunked('{"ok":true}', 2)), '{"ok":true}');
  assert.equal(await readBody(null), "");
});
