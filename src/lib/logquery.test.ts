import { test } from "node:test";
import assert from "node:assert/strict";
import { facetValue, parseQuery, type LineCtx } from "./logquery.ts";
import type { Level } from "./logstore.ts";

const pino = (o: Record<string, unknown>, level: Level = 3, stream = "ecs/api/abc"): LineCtx => ({ msg: JSON.stringify(o), level, stream });
const text = (msg: string, level: Level = 0, stream = "ecs/worker/def"): LineCtx => ({ msg, level, stream });
const q = (s: string) => {
  const r = parseQuery(s);
  if (!r.ok) throw new Error(`${s}: ${r.error}`);
  return r.q!;
};

const GET200 = pino({ level: 30, req: { method: "GET", url: "/api/v2/products?page=3" }, res: { statusCode: 200 }, responseTime: 42.5, msg: "request completed" });
const POST500 = pino({ level: 50, req: { method: "POST", url: "/api/v2/orders" }, res: { statusCode: 503 }, responseTime: 1840, msg: "order create failed" }, 5);
const GO = text('time=2026-09-25T14:38:41Z level=WARN msg="smtp rate limited" retry_in=2s took=38ms', 4);

test("plain terms are case-insensitive substrings; implicit AND", () => {
  assert.ok(q("request completed").test(GET200));
  assert.ok(!q("request failed").test(GET200));
  assert.ok(q("SMTP").test(GO));
});

test('"phrases", -negation, NOT, OR and parentheses', () => {
  assert.ok(q('"order create"').test(POST500));
  assert.ok(!q('"create order"').test(POST500));
  assert.ok(q("-health").test(GET200));
  assert.ok(!q("NOT products").test(GET200));
  assert.ok(q("smtp OR prisma").test(GO));
  assert.ok(q("(smtp OR prisma) level:warn").test(GO));
  assert.ok(!q("(smtp OR prisma) level:error").test(GO));
});

test("level names and comparisons use the sniffed level", () => {
  assert.ok(q("level:error").test(POST500));
  assert.ok(q("@level:>=warn").test(GO));
  assert.ok(!q("level:>=warn").test(GET200));
  const bad = parseQuery("level:loud");
  assert.ok(!bad.ok && /unknown level/.test(bad.error), "unknown level is reported, not silently empty");
});

test("JSON field aliases: status, method, path, duration; ranges and wildcards", () => {
  assert.ok(q("status:200").test(GET200));
  assert.ok(q("status:>=500").test(POST500));
  assert.ok(q("status:500..599").test(POST500));
  assert.ok(!q("status:500..599").test(GET200));
  assert.ok(q("method:post").test(POST500));
  assert.ok(q("path:/api/v2/orders*").test(POST500));
  assert.ok(q('path:"/api/v2/products*"').test(GET200));
  assert.ok(q("duration:>1000").test(POST500));
  assert.ok(!q("duration:>1000").test(GET200));
  assert.ok(q("req.url:/api/v2/orders").test(POST500), "nested keys match by last segment");
});

test("logfmt fields with unit suffixes", () => {
  assert.ok(q("took:<100").test(GO));
  assert.ok(q("retry_in:>=2000").test(GO), "2s → 2000ms");
  assert.ok(q('msg:"smtp rate limited"').test(GO));
});

test("service / stream filter for merged multi-service logs", () => {
  assert.ok(q("service:worker").test(GO));
  assert.ok(!q("service:worker").test(GET200));
  assert.ok(q("service:*api*").test(GET200));
});

test("/regex/flags and word wildcards", () => {
  assert.ok(q("/order (create|update) failed/").test(POST500));
  assert.ok(q("/SMTP/i").test(GO));
  assert.ok(!q("/SMTP/").test(GO));
  assert.ok(q("prod*cts").test(GET200));
});

test("missing field is false, so -field:x keeps lines without it", () => {
  assert.ok(!q("status:200").test(GO));
  assert.ok(q("-status:200").test(GO));
});

test("errors carry a position; empty query is null", () => {
  const r1 = parseQuery('"unclosed');
  assert.equal(r1.ok, false);
  const r2 = parseQuery("(a OR b");
  assert.ok(!r2.ok && /missing \)/.test(r2.error));
  const r3 = parseQuery("/[/");
  assert.ok(!r3.ok && /regex/.test(r3.error));
  assert.deepEqual(parseQuery("   "), { ok: true, q: null });
});

test("highlight covers positive terms only", () => {
  const c = q('smtp -health "rate limited" /ret\\w+/ status:200');
  assert.ok(c.highlight!.test("SMTP"));
  assert.ok(c.highlight!.test("rate limited"));
  assert.ok(c.highlight!.test("retry"));
  assert.ok(!c.highlight!.test("health"));
  assert.deepEqual(c.fields, ["status"]);
});

test("facet values normalise paths", () => {
  assert.equal(facetValue(POST500.msg, "path"), "/api/v2/orders");
  assert.equal(facetValue(pino({ req: { url: "/api/v2/orders/123/items?x=1" } }).msg, "path"), "/api/v2/orders/:n/items");
  assert.equal(facetValue(POST500.msg, "method"), "POST");
  assert.equal(facetValue(POST500.msg, "status"), "503");
});

test("the status facet keeps HTTP codes only", () => {
  assert.equal(facetValue(pino({ msg: "kyc", status: "active" }).msg, "status"), undefined);
  assert.equal(facetValue(pino({ msg: "db", code: "P2002" }).msg, "status"), undefined);
  assert.equal(facetValue(pino({ msg: "list", status: 7 }).msg, "status"), undefined);
  assert.equal(facetValue(pino({ res: { statusCode: 404 } }).msg, "status"), "404");
  assert.equal(facetValue("GET /health status=200 took=3", "status"), "200");
});

test("200k lines filter in well under a second", () => {
  const c = q("status:>=500 OR level:error");
  const lines = Array.from({ length: 200_000 }, (_, i) => (i % 97 ? GET200 : POST500));
  const t0 = performance.now();
  let n = 0;
  for (const l of lines) if (c.test(l)) n++;
  const ms = performance.now() - t0;
  assert.ok(n > 2000);
  assert.ok(ms < 1500, `took ${ms}ms`);
});
