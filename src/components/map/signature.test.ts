import { test } from "node:test";
import assert from "node:assert/strict";
import { inventorySignature, shareUnchanged } from "./signature.ts";
import { acmeFixture } from "./fixture.ts";

test("F51: the signature ignores build times and changes with anything the map or the panel shows", () => {
  const a = acmeFixture(1_000_000);
  const b = {
    ...acmeFixture(1_000_000),
    generatedAt: a.generatedAt + 60_000,
    completeness: { ...a.completeness!, lastCompleteAt: a.generatedAt + 60_000 },
    providers: a.providers.map((p) => ({ ...p, at: p.at + 60_000, ms: (p.ms ?? 0) + 7, ...(p.regions ? { regions: p.regions.map((x) => ({ ...x, at: x.at + 60_000 })) } : {}) })),
    resources: a.resources.map((r) => ({ ...r, observedAt: a.generatedAt + 59_000 })),
  };
  assert.equal(inventorySignature(a), inventorySignature(b), "a new build of the same account is the same map");
  const sick = { ...b, resources: b.resources.map((r, i) => (i === 3 ? { ...r, health: "error" as const } : r)) };
  assert.notEqual(inventorySignature(a), inventorySignature(sick));
  assert.notEqual(inventorySignature(a), inventorySignature({ ...b, edges: b.edges.slice(1) }));
  assert.notEqual(inventorySignature(a), inventorySignature({ ...b, resources: b.resources.map((r, i) => (i === 0 ? { ...r, notes: 9 } : r)) }));
  // The chips' second line and the panel show properties, facts and tags: a change there is news too.
  const i = a.resources.findIndex((r) => r.props.length > 0);
  assert.notEqual(inventorySignature(a), inventorySignature({ ...b, resources: b.resources.map((r, k) => (k === i ? { ...r, props: [{ ...r.props[0], value: `${r.props[0].value}!` }, ...r.props.slice(1)] } : r)) }));
  assert.notEqual(inventorySignature(a), inventorySignature({ ...b, resources: b.resources.map((r, k) => (k === 0 ? { ...r, tags: { ...r.tags, Owner: "x" } } : r)) }));
  assert.notEqual(inventorySignature(a), inventorySignature({ ...b, completeness: { ...b.completeness, lastCompleteAt: a.generatedAt } }), "complete → partial is news");
  assert.equal(inventorySignature(undefined), "");
});

test("F51: an unchanged build keeps the previous arrays but its own build time (as of, freshness stay current)", () => {
  const a = acmeFixture(1_000_000);
  const b = { ...acmeFixture(1_000_000), generatedAt: a.generatedAt + 120_000, completeness: { ...a.completeness!, lastCompleteAt: a.generatedAt + 120_000 } };
  const prev = { view: a, sig: inventorySignature(a) };
  const shared = shareUnchanged(prev, b, inventorySignature(b));
  assert.equal(shared.resources, a.resources, "same resources array: no new filter or layout");
  assert.equal(shared.edges, a.edges);
  assert.equal(shared.generatedAt, b.generatedAt, "the build time moves on, so the map never looks stale while polls succeed");
  assert.equal(shared.providers, b.providers);
  const changed = { ...b, resources: b.resources.slice(1) };
  assert.equal(shareUnchanged(prev, changed, inventorySignature(changed)), changed, "a real change is passed through");
  assert.equal(shareUnchanged(undefined, b, inventorySignature(b)), b);
});
