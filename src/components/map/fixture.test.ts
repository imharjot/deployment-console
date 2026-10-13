import { test } from "node:test";
import assert from "node:assert/strict";
import { acmeFixture, bigFixture, mulberry32 } from "./fixture.ts";
import { KIND_INFO } from "../../lib/inventory/types.ts";

test("mulberry32: integer PRNG, deterministic, uniform enough in [0, 1)", () => {
  const a = mulberry32(7), b = mulberry32(7);
  const xs = Array.from({ length: 10_000 }, () => a());
  assert.deepEqual(xs.slice(0, 5), Array.from({ length: 5 }, () => b()));
  assert.ok(xs.every((x) => x >= 0 && x < 1));
  const buckets = new Array(10).fill(0);
  for (const x of xs) buckets[Math.floor(x * 10)]++;
  assert.ok(buckets.every((c) => c > 800 && c < 1200), `buckets ${buckets.join(",")}`);
});

// F56: the old float LCG made ?fixture=big hang from about n = 2,500.
test("bigFixture(5000) finishes quickly and returns 15,000 edges, every one between known resources", () => {
  const t = performance.now();
  const v = bigFixture(5000, 0);
  assert.ok(performance.now() - t < 5000, "finishes");
  assert.equal(v.resources.length, 5000);
  assert.equal(v.edges.length, 15_000);
  const keys = new Set(v.resources.map((r) => r.key));
  assert.equal(new Set(v.edges.map((e) => e.id)).size, 15_000, "no duplicate edges");
  assert.ok(v.edges.every((e) => keys.has(e.from) && keys.has(e.to) && e.from !== e.to));
  assert.deepEqual(v.regions, ["us-east-1", "eu-west-1"]);
  // One resource can't hold any edge: the attempt cap ends the loop instead of hanging.
  assert.equal(bigFixture(1, 0).edges.length, 0);
});

test("acmeFixture: coverage fields the map draws (layers, parents, generic, remote, vanishing, routing, regions)", () => {
  const v = acmeFixture(0);
  const keys = new Set(v.resources.map((r) => r.key));
  assert.equal(keys.size, v.resources.length, "unique keys");
  assert.ok(v.resources.every((r) => !!KIND_INFO[r.kind]));
  assert.ok(v.edges.every((e) => keys.has(e.from) && keys.has(e.to)), "edges only between listed resources");
  assert.ok(v.resources.some((r) => r.parent && keys.has(r.parent)), "children with a parent on the map");
  assert.ok(v.resources.some((r) => r.hidden && r.slim));
  assert.ok(v.resources.some((r) => r.kind === "aws-resource" && r.slim && r.service));
  assert.ok(v.resources.some((r) => r.source === "reference" && r.facts?.remote === true));
  assert.ok(v.resources.some((r) => r.facts?.vanishing === true));
  assert.ok(v.resources.some((r) => Array.isArray(r.facts?.peerGroups)));
  assert.ok(v.resources.some((r) => r.region === "eu-west-1"));
  assert.ok(v.edges.some((e) => e.routing?.policy === "failover"));
  assert.ok(v.edges.some((e) => e.kind === "assumes"), "a support edge");
  assert.deepEqual(v.regions, ["us-east-1", "eu-west-1"]);
  assert.ok(v.resources.every((r) => !JSON.stringify(r).includes("password")), "no secret-looking values");
});
