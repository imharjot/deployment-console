// Cron schedules for workflow triggers (master plan §6 C7 item 8): five fields, macros and names, UTC and named time
// zones, and the daylight-saving edges (a skipped time fires once at the jump, a repeated one once at its first
// occurrence).
import { test } from "node:test";
import assert from "node:assert/strict";
import { CronError, cronProblems, isTimeZone, nextFire, nextFires, parseCron, wallOf } from "./cron.ts";

const at = (iso: string) => Date.parse(iso);
const iso = (t: number | null) => (t === null ? null : new Date(t).toISOString());

test("parsing: fields, ranges, steps, lists, names, macros and Sunday as 0 or 7", () => {
  const s = parseCron("*/15 9-17 * JAN,jul MON-FRI");
  assert.deepEqual(s.minutes, [0, 15, 30, 45]);
  assert.deepEqual(s.hours, [9, 10, 11, 12, 13, 14, 15, 16, 17]);
  assert.deepEqual(s.months, [1, 7]);
  assert.deepEqual(s.dows, [1, 2, 3, 4, 5]);
  assert.equal(s.domStar, true);
  assert.deepEqual(parseCron("0 0 * * 7").dows, [0]);
  assert.deepEqual(parseCron("5/20 * * * *").minutes, [5, 25, 45]);
  assert.deepEqual(parseCron("1-10/3 * * * *").minutes, [1, 4, 7, 10]);
  assert.deepEqual(parseCron("@daily"), parseCron("0 0 * * *"));
  assert.deepEqual(parseCron("@hourly").minutes, [0]);
  for (const bad of ["* * * *", "60 * * * *", "* 24 * * *", "* * 0 * *", "* * * 13 *", "* * * * 8", "5-1 * * * *", "*/0 * * * *", "a * * * *", "1,,2 * * * *", "1/2/3 * * * *", 12])
    assert.throws(() => parseCron(bad as string), CronError, String(bad));
});

test("next fire in UTC: strictly after, minute steps, day-of-week, month ends and leap days", () => {
  assert.equal(iso(nextFire("*/15 * * * *", "UTC", at("2026-10-05T10:07:30Z"))), "2026-10-05T10:15:00.000Z");
  assert.equal(iso(nextFire("*/15 * * * *", "UTC", at("2026-10-05T10:15:00Z"))), "2026-10-05T10:30:00.000Z", "strictly after");
  // 2026-10-09 is a Friday: the next weekday 08:00 after Friday evening is Monday the 12th.
  assert.equal(iso(nextFire("0 8 * * 1-5", "UTC", at("2026-10-09T19:00:00Z"))), "2026-10-12T08:00:00.000Z");
  assert.equal(iso(nextFire("0 0 31 * *", "UTC", at("2026-10-31T12:00:00Z"))), "2026-12-31T00:00:00.000Z", "November has no 31st");
  assert.equal(iso(nextFire("0 12 29 2 *", "UTC", at("2026-03-01T00:00:00Z"))), "2028-02-29T12:00:00.000Z");
  // Both day fields restricted: either matches (Vixie cron). 2026-11-13 is a Friday, the 6th too.
  assert.equal(iso(nextFire("0 0 13 * 5", "UTC", at("2026-11-01T00:00:00Z"))), "2026-11-06T00:00:00.000Z");
  assert.deepEqual(nextFires("0 0 1 * *", "UTC", at("2026-10-05T00:00:00Z"), 3).map(iso), ["2026-11-01T00:00:00.000Z", "2026-12-01T00:00:00.000Z", "2027-01-01T00:00:00.000Z"]);
});

test("named time zones: the schedule is the zone's wall clock", () => {
  // India (UTC+5:30, no DST): 09:00 IST is 03:30Z.
  assert.equal(iso(nextFire("0 9 * * *", "Asia/Kolkata", at("2026-10-05T04:00:00Z"))), "2026-10-06T03:30:00.000Z");
  assert.equal(iso(nextFire("0 9 * * *", "Asia/Kolkata", at("2026-10-05T03:00:00Z"))), "2026-10-05T03:30:00.000Z");
  // New York in summer (EDT, UTC-4).
  assert.equal(iso(nextFire("0 19 * * 1-5", "America/New_York", at("2026-10-05T12:00:00Z"))), "2026-10-05T23:00:00.000Z");
  assert.deepEqual(wallOf(at("2026-10-05T23:00:00Z"), "America/New_York"), { y: 2026, m: 10, d: 5, h: 19, mi: 0 });
});

test("DST spring forward: a skipped time fires once, at the jump; the next day is normal", () => {
  // New York 8 March 2026: 02:00 EST → 03:00 EDT (07:00Z). 02:30 doesn't exist that day.
  const t1 = nextFire("30 2 * * *", "America/New_York", at("2026-03-08T05:00:00Z"));
  assert.equal(iso(t1), "2026-03-08T07:00:00.000Z");
  assert.equal(iso(nextFire("30 2 * * *", "America/New_York", t1!)), "2026-03-09T06:30:00.000Z");
  // Every 15 minutes through the gap: 01:45 EST, then the jump (03:00 EDT), never four fires at once.
  assert.deepEqual(nextFires("*/15 * * * *", "America/New_York", at("2026-03-08T06:30:00Z"), 4).map(iso), [
    "2026-03-08T06:45:00.000Z", "2026-03-08T07:00:00.000Z", "2026-03-08T07:15:00.000Z", "2026-03-08T07:30:00.000Z",
  ]);
  // Berlin 29 March 2026: 02:00 CET → 03:00 CEST (01:00Z).
  assert.equal(iso(nextFire("30 2 * * *", "Europe/Berlin", at("2026-03-28T23:00:00Z"))), "2026-03-29T01:00:00.000Z");
});

test("DST fall back: a repeated time fires once, at its first occurrence", () => {
  // New York 1 November 2026: 02:00 EDT → 01:00 EST (06:00Z). 01:30 happens at 05:30Z (EDT) and 06:30Z (EST).
  const first = nextFire("30 1 * * *", "America/New_York", at("2026-11-01T04:00:00Z"));
  assert.equal(iso(first), "2026-11-01T05:30:00.000Z");
  assert.equal(iso(nextFire("30 1 * * *", "America/New_York", first!)), "2026-11-02T06:30:00.000Z", "not again in the repeated hour");
  // From inside the repeated hour (01:10 EST), the slot already passed in the first pass.
  assert.equal(iso(nextFire("30 1 * * *", "America/New_York", at("2026-11-01T06:10:00Z"))), "2026-11-02T06:30:00.000Z");
  // A time after the repeated hour is unaffected.
  assert.equal(iso(nextFire("0 3 * * *", "America/New_York", at("2026-11-01T04:00:00Z"))), "2026-11-01T08:00:00.000Z");
});

test("validation: unknown zones and schedules that never fire are refused", () => {
  assert.equal(isTimeZone("Europe/Berlin"), true);
  assert.equal(isTimeZone("UTC"), true);
  assert.equal(isTimeZone("Mars/Olympus"), false);
  assert.equal(isTimeZone(""), false);
  assert.deepEqual(cronProblems("0 8 * * 1-5", "UTC"), []);
  assert.match(cronProblems("0 8 * * 1-5", "Nowhere/Town")[0], /unknown time zone/);
  assert.match(cronProblems("0 0 30 2 *", "UTC")[0], /never fires/);
  assert.match(cronProblems("0 8 * *", "UTC")[0], /5 fields/);
  assert.throws(() => nextFire("0 8 * * *", "Nowhere/Town", Date.now()), CronError);
});
