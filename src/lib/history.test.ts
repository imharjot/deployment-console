import { test } from "node:test";
import assert from "node:assert/strict";
import { SAMPLE_CAP_MS, UPTIME_BASIS, WINDOW_MS, extendSpans, latestState, rebuild, record, reset, restore, uptime } from "./history.ts";

const NOW = 1_800_000_000_000;
const MIN = 60_000;

test("no samples → pct null, empty bars", () => {
  reset();
  const u = uptime("svc", NOW);
  assert.equal(u.pct, null);
  assert.ok(u.bars.every((b) => b === null));
  assert.equal(u.basis, UPTIME_BASIS);
});

// REVIEW R21: one UP sample three hours ago gave 100 %, no bars and 3 h covered for a 2 h window.
test("an expired sample no longer vouches for the window (computed at read time)", () => {
  reset();
  record("review/demo", "UP", NOW - 3 * 3600_000);
  const u = uptime("review/demo", NOW);
  assert.equal(u.pct, null);
  assert.equal(u.bars.filter(Boolean).length, 0);
  assert.equal(u.coveredMs, 0);
  assert.ok(u.coveredMs <= u.windowMs);
});

// F66: 110 min sampled only by the sampler (UP every 30 s), then 10 min DOWN polled every 10 s by a watching page.
test("uptime is weighted by time, not by how often somebody looked (≈91.7 %)", () => {
  reset();
  const start = NOW - 120 * MIN;
  for (let t = start; t < start + 110 * MIN; t += 30_000) record("svc", "UP", t);
  for (let t = start + 110 * MIN; t < NOW; t += 10_000) record("svc", "DOWN", t);
  const u = uptime("svc", NOW);
  assert.equal(u.pct, 91.7, "sample counting gave 78.6 %");
  assert.equal(u.coveredMs, 120 * MIN);
  assert.equal(u.gapMs, 0);
  assert.equal(u.since, start + 110 * MIN);
  assert.equal(u.bars.at(-1), "DOWN");
  assert.equal(u.bars[0], "UP");
});

test("parked states count as good, DOWN as bad; a sample covers at most 60 s; unobserved time is a gap", () => {
  reset();
  for (let i = 0; i < 10; i++) record("svc", "UP", NOW - 600_000 + i * 30_000); // 300 s UP
  record("svc", "DOWN", NOW - 300_000);
  record("svc", "DOWN", NOW - 270_000); // 60 s DOWN
  record("svc", "STOPPED", NOW - 240_000); // then nothing: covers only 60 s
  const u = uptime("svc", NOW);
  assert.equal(u.coveredMs, 300_000 + 60_000 + SAMPLE_CAP_MS);
  assert.equal(u.pct, Math.round((360 / 420) * 1000) / 10);
  assert.equal(u.gapMs, 180_000, "the sampler stopped 3 min ago");
  assert.equal(u.since, NOW - 240_000);
  assert.ok(u.bars.includes("DOWN"), "worst state wins its bucket");
  assert.equal(u.bars.at(-1), null, "the unobserved last minutes are empty bars");
});

test("dedupes repeats within 5s, ignores out-of-order samples and trims beyond the window", () => {
  reset();
  record("svc", "UP", NOW - WINDOW_MS - 10 * MIN);
  record("svc", "UP", NOW - 1000);
  record("svc", "UP", NOW);
  record("svc", "DOWN", NOW - 2000); // late (older than the last kept sample): the newer sample stands
  assert.equal(latestState("svc"), "UP");
  const u = uptime("svc", NOW);
  assert.equal(u.pct, 100);
  assert.ok(u.coveredMs <= WINDOW_MS);
});

test("since survives beyond the window", () => {
  reset();
  record("svc", "UP", NOW - 3 * 3600_000);
  for (let t = NOW - 10 * MIN; t <= NOW; t += 30_000) record("svc", "UP", t);
  assert.equal(uptime("svc", NOW).since, NOW - 3 * 3600_000);
});

// After a restart: transitions persisted in state_changes plus the spans the sampler observed.
test("restore rebuilds uptime from transitions inside observed spans; the downtime of the console is a gap", () => {
  reset();
  const transitions: [number, "UP" | "DOWN"][] = [
    [NOW - 5 * 3600_000, "UP"], // before the window: the state the window starts in
    [NOW - 60 * MIN, "DOWN"],
    [NOW - 50 * MIN, "UP"],
  ];
  // Observed 120..40 min ago, console down 40..20 min ago, observing again since 20 min ago.
  const spans: [number, number][] = [[NOW - 120 * MIN, NOW - 40 * MIN], [NOW - 20 * MIN, NOW]];
  const samples = rebuild(transitions, spans, NOW);
  assert.deepEqual(samples.map(([t, s, u]) => [(NOW - t) / MIN, s, (NOW - u!) / MIN]), [
    [120, "UP", 60], [60, "DOWN", 50], [50, "UP", 40], [20, "UP", 0],
  ]);
  record("svc", "UP", NOW - 30_000); // this process's own first sample
  restore("svc", samples, ["UP", NOW - 50 * MIN]);
  const u = uptime("svc", NOW);
  assert.equal(u.coveredMs, 100 * MIN, "80 min before the restart + 20 min after (own sample included)");
  assert.equal(u.pct, 90);
  assert.equal(u.gapMs, 20 * MIN);
  assert.equal(u.since, NOW - 50 * MIN);
  assert.equal(u.bars[30], "DOWN"); // 2-min buckets: 60 min ago is bucket 30
  assert.equal(u.bars[45], null, "the console was down then (40..20 min ago)");
});

test("restore never overwrites what this process recorded, nor a newer state's since", () => {
  reset();
  record("svc", "DOWN", NOW - 60_000);
  restore("svc", [[NOW - 10 * MIN, "UP", NOW - 30_000]], ["UP", NOW - 3600_000]);
  const u = uptime("svc", NOW);
  assert.equal(u.since, NOW - 60_000, "the restored since belongs to another state");
  assert.equal(u.coveredMs, 9 * MIN + 60_000, "the restored span is cut at the first own sample");
});

test("extendSpans: extends within the gap, starts a new span after it, forgets old ones", () => {
  let s = extendSpans([], NOW - 120_000, 90_000);
  s = extendSpans(s, NOW - 90_000, 90_000);
  assert.deepEqual(s, [[NOW - 120_000, NOW - 90_000]]);
  s = extendSpans(s, NOW, 90_000); // 90 s later: still one span
  assert.deepEqual(s, [[NOW - 120_000, NOW]]);
  s = extendSpans(s, NOW + 5 * MIN, 90_000);
  assert.deepEqual(s, [[NOW - 120_000, NOW], [NOW + 5 * MIN, NOW + 5 * MIN]]);
  const later = NOW + WINDOW_MS + 4 * MIN;
  assert.deepEqual(extendSpans(s, later, 90_000), [[NOW + 5 * MIN, NOW + 5 * MIN], [later, later]], "spans that ended before the window are dropped");
});
