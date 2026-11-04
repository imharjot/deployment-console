import { test } from "node:test";
import assert from "node:assert/strict";
import { IDLE_AFTER_MS, PENDING_SYNC_MS, isActive, nextSyncDelay, syncIntervalMs } from "./sync-rules.ts";

test("CONSOLE_SYNC_MINUTES: 1–60 whole minutes, default 5", () => {
  assert.equal(syncIntervalMs({}), 5 * 60_000);
  assert.equal(syncIntervalMs({ CONSOLE_SYNC_MINUTES: "1" }), 60_000);
  assert.equal(syncIntervalMs({ CONSOLE_SYNC_MINUTES: " 60 " }), 3_600_000);
  for (const bad of ["0", "61", "2.5", "-3", "five", ""]) assert.equal(syncIntervalMs({ CONSOLE_SYNC_MINUTES: bad }), 5 * 60_000, bad);
});

test("active for 15 minutes after the last request; never active before the first one", () => {
  const now = 10 * IDLE_AFTER_MS;
  assert.equal(isActive(0, now), false);
  assert.equal(isActive(now - IDLE_AFTER_MS, now), true);
  assert.equal(isActive(now - IDLE_AFTER_MS - 1, now), false);
});

test("pace: active → interval; idle → paused; a pending change → 30 s whoever is looking", () => {
  const now = 10 * IDLE_AFTER_MS;
  const intervalMs = 5 * 60_000;
  assert.equal(nextSyncDelay({ lastActiveAt: now - 1000, pending: 0, intervalMs, now }), intervalMs);
  assert.equal(nextSyncDelay({ lastActiveAt: now - IDLE_AFTER_MS - 1, pending: 0, intervalMs, now }), null);
  assert.equal(nextSyncDelay({ lastActiveAt: 0, pending: 0, intervalMs, now }), null);
  assert.equal(nextSyncDelay({ lastActiveAt: 0, pending: 2, intervalMs, now }), PENDING_SYNC_MS);
  assert.equal(nextSyncDelay({ lastActiveAt: now, pending: 1, intervalMs: 10_000, now }), 10_000); // never slower than the interval
});
