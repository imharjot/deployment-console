import { test } from "node:test";
import assert from "node:assert/strict";
import { ago, agoChangesAt } from "./format.ts";

test("relative times count whole minutes, never seconds, and say when they next change", () => {
  const t = Date.parse("2026-10-28T10:00:00Z");
  assert.equal(ago(t, t + 59_000), "just now");
  assert.equal(ago(t, t + 60_000), "1m ago");
  assert.equal(ago(t, t + 3_599_000), "59m ago");
  assert.equal(ago(t, t + 3_600_000), "1h ago");
  assert.equal(ago(t, t + 86_400_000), "1d ago");
  assert.equal(ago(t, t - 5_000), "just now", "a clock slightly behind the server's");
  assert.equal(ago(undefined), "—");
  assert.equal(agoChangesAt(t, t + 19_000), t + 60_000, "just now → 1m ago");
  assert.equal(agoChangesAt(t, t + 61_000), t + 120_000);
  assert.equal(agoChangesAt(t, t + 3_599_999), t + 3_600_000, "59m → 1h");
  assert.equal(agoChangesAt(t, t + 5_400_000), t + 7_200_000, "hourly from an hour on");
  assert.equal(agoChangesAt(t, t + 90_000_000), t + 172_800_000, "daily from a day on");
  assert.equal(agoChangesAt(new Date(t).toISOString(), t), t + 60_000);
  assert.equal(agoChangesAt(undefined, t), undefined);
  for (const age of [0, 19_000, 61_000, 3_599_999, 5_400_000, 90_000_000]) {
    const next = agoChangesAt(t, t + age)!;
    assert.notEqual(ago(t, next), ago(t, next - 1), `the label changes at ${next - t} ms`);
  }
});
