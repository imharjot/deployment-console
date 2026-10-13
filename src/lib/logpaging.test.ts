import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decodeOlderCursor, decodeTailCursor, encodeCursor, inTargets, isPartialPage, literalPattern, mergeOlder, mergePages, scopeTargets, scopedInsightsQuery, splitKey,
  streamKey, type Event, type Target,
} from "./logpaging.ts";
import { HttpError } from "./server/errors.ts";

const ev = (...ts: number[]): Event[] => ts.map((t) => ({ ts: t, msg: `line ${t}` }));
const badCursor = (e: unknown) => e instanceof HttpError && e.status === 400 && e.message === "bad cursor";

test("cursors round-trip and malformed ones are a 400", () => {
  const tail = { s: { "/ecs/api|ecs/api/1": "f/123" }, t: 1700 };
  assert.deepEqual(decodeTailCursor(encodeCursor(tail)), tail);
  assert.equal(decodeTailCursor(null), null, "no cursor = first load");
  assert.equal(decodeTailCursor(""), null);
  assert.throws(() => decodeTailCursor("not base64 json"), badCursor);
  assert.throws(() => decodeTailCursor(Buffer.from('{"x":1}').toString("base64url")), badCursor, "missing s");

  const older = { k: ["/ecs/api|ecs/api/1"], b: 1699 };
  assert.deepEqual(decodeOlderCursor(encodeCursor(older)), older);
  assert.throws(() => decodeOlderCursor(null), badCursor);
  assert.throws(() => decodeOlderCursor(Buffer.from('{"k":[1],"b":5}').toString("base64url")), badCursor, "keys must be strings");
  assert.throws(() => decodeOlderCursor(Buffer.from('{"k":["a|b"],"b":"soon"}').toString("base64url")), badCursor, "b must be a number");
});

test("stream keys split on the first pipe", () => {
  assert.equal(streamKey("/ecs/api", "ecs/api/abc"), "/ecs/api|ecs/api/abc");
  assert.deepEqual(splitKey("/ecs/api|ecs/api/abc"), ["/ecs/api", "ecs/api/abc"]);
  assert.deepEqual(splitKey("/g|stream|with|pipes"), ["/g", "stream|with|pipes"]);
});

test("a client-held cursor key only reaches the requested targets", () => {
  const targets: Target[] = [
    { service: "api", group: "/ecs/shared", prefix: "ecs/api/", shared: true },
    { service: "worker", group: "/ecs/worker", shared: false },
  ];
  assert.ok(inTargets(targets, "/ecs/shared|ecs/api/abc"));
  assert.ok(!inTargets(targets, "/ecs/shared|ecs/billing/abc"), "another service's streams in a shared group");
  assert.ok(inTargets(targets, "/ecs/worker|anything"), "no prefix = the whole group");
  assert.ok(!inTargets(targets, "/ecs/secret|ecs/api/abc"), "a group that wasn't requested");
});

test("F62: a group shared with a hidden service counts as shared; without a stream prefix it can't be scoped", () => {
  const svcs = [
    { id: "api", logs: { group: "/ecs/app", prefix: "ecs/api/" } },
    { id: "admin", hidden: true, logs: { group: "/ecs/app", prefix: "ecs/admin/" } },
    { id: "web", logs: { group: "/ecs/web" } },
    { id: "ops", hidden: true, logs: { group: "/ecs/web" } },
    { id: "worker", logs: { group: "/ecs/worker" } },
    { id: "infra" },
  ];
  const [api] = scopeTargets(svcs, "api");
  assert.deepEqual(api, { service: "api", group: "/ecs/app", prefix: "ecs/api/", shared: true }, "shared because of the hidden service");
  assert.equal(scopedInsightsQuery([api], "stats count(*)").startsWith("filter @logStream like /^(ecs\\/api\\/)/"), true, "Insights narrowed to its streams");
  const refused = (v: string, re: RegExp) => assert.throws(() => scopeTargets(svcs, v), (e: unknown) => e instanceof HttpError && e.status === 400 && re.test(e.message));
  refused("web", /web log to a group shared with a hidden service/);
  refused("admin", /unknown service\(s\) or no logs: admin/);
  refused("infra", /no logs: infra/);
  refused(" , ", /none/);
  assert.deepEqual(scopeTargets(svcs, "all").map((t) => t.service), ["api", "worker"], "all leaves the unscopable one out");
  assert.deepEqual(scopeTargets(svcs, "worker", (t) => ({ ...t, region: "eu-west-1" })), [{ service: "worker", group: "/ecs/worker", shared: false, prefix: undefined, region: "eu-west-1" }]);
});

test("merge orders by time across streams and truncates from the chosen end", () => {
  const pages = [
    { stream: "a", events: ev(1, 4, 6) },
    { stream: "b", events: ev(2, 3, 5) },
  ];
  const all = mergePages(pages, Infinity, "head");
  assert.deepEqual(all.streams, ["a", "b"]);
  assert.deepEqual(all.lines.map((l) => [l[0], l[1]]), [[1, 0], [2, 1], [3, 1], [4, 0], [5, 1], [6, 0]]);
  assert.equal(all.truncated, false);
  assert.deepEqual(mergePages(pages, 2, "tail").lines.map((l) => l[0]), [5, 6]);
  assert.deepEqual(mergePages(pages, 2, "head").lines.map((l) => l[0]), [1, 2]);
  assert.equal(mergePages(pages, 2, "head").truncated, true);
});

test("a page is partial when it hit the event count or the 1 MB limit", () => {
  assert.ok(isPartialPage(ev(1, 2, 3), 3));
  assert.ok(!isPartialPage(ev(1, 2), 3));
  assert.ok(isPartialPage([{ ts: 1, msg: "x".repeat(900_000) }], 100), "one huge line");
  assert.ok(!isPartialPage([], 100));
});

test("older pages never leave a gap: lines before the newest partial boundary wait for the next page", () => {
  // Stream a filled its page (per = 3) and only reaches back to t=50; stream b is complete back to t=10.
  const pages = [
    { k: "g|a", stream: "a", events: ev(50, 60, 70) },
    { k: "g|b", stream: "b", events: ev(10, 55) },
  ];
  const r = mergeOlder(pages, 3);
  assert.deepEqual(r.lines.map((l) => l[0]), [55, 60, 70], "only lines newer than the cut (50)");
  assert.deepEqual(r.older, { k: ["g|a", "g|b"], b: 51 }, "both streams still have lines at or before the cut");

  const done = mergeOlder([{ k: "g|b", stream: "b", events: ev(10, 20) }], 3);
  assert.deepEqual(done.lines.map((l) => l[0]), [10, 20]);
  assert.equal(done.older, null, "no stream filled its page → nothing older");

  const empty = mergeOlder([{ k: "g|a", stream: "a", events: [] }], 3);
  assert.deepEqual(empty.lines, []);
  assert.equal(empty.older, null);
});

test("literal search is one quoted CloudWatch term", () => {
  assert.equal(literalPattern("  batch committed "), '"batch committed"');
  assert.equal(literalPattern('say "hi"'), '"say \\"hi\\""');
  assert.equal(literalPattern("C:\\tmp"), '"C:\\\\tmp"');
});

test("Insights queries on a shared log group are narrowed to the selected services' streams", () => {
  const own: Target[] = [{ service: "api", group: "/ecs/api", prefix: "ecs/api/", shared: false }];
  assert.equal(scopedInsightsQuery(own, "fields @message"), "fields @message", "own group: unchanged");
  const shared: Target[] = [
    { service: "api", group: "/ecs/app", prefix: "ecs/api/", shared: true },
    { service: "web.v2", group: "/ecs/app", prefix: "ecs/web.v2/", shared: true },
  ];
  assert.equal(scopedInsightsQuery(shared, "fields @message"), "filter @logStream like /^(ecs\\/api\\/|ecs\\/web\\.v2\\/)/\n| fields @message");
});

// ---------- F26: tail at scale ----------

test("tail cursors carry idle counts; anything malformed in them is dropped or refused", async () => {
  const { IDLE_EVERY_MS, idle } = await import("./logpaging.ts");
  const c = { s: { "g|a": "f/1" }, t: 5, e: { "g|a": 3 }, p: { "g|a": 1000 } };
  assert.deepEqual(decodeTailCursor(encodeCursor(c)), c);
  const odd = decodeTailCursor(Buffer.from(JSON.stringify({ s: { "g|a": "x" }, t: "soon", e: { "g|a": "3", "g|b": 2 }, p: [] })).toString("base64url"));
  assert.deepEqual(odd, { s: { "g|a": "x" }, e: { "g|b": 2 } });
  assert.throws(() => decodeTailCursor(Buffer.from('{"s":{"g|a":1}}').toString("base64url")), badCursor, "tokens are strings");
  assert.throws(() => decodeTailCursor(Buffer.from('{"s":[]}').toString("base64url")), badCursor);
  assert.equal(idle(c, "g|a", 1000 + IDLE_EVERY_MS - 1), true, "three empty polls: wait 10 s");
  assert.equal(idle(c, "g|a", 1000 + IDLE_EVERY_MS), false, "…then poll it once");
  assert.equal(idle({ ...c, e: { "g|a": 2 } }, "g|a", 1001), false, "two empty polls: still every poll");
  assert.equal(idle({ s: {} }, "g|new", 0), false);
});

test("more streams than the cap: each service's newest first, in turns", async () => {
  const { pickStreams } = await import("./logpaging.ts");
  const svc = (service: string, n: number) => ({ service, keys: Array.from({ length: n }, (_, i) => ({ k: `${service}|s${i}`, lastEventAt: 100 - i })) });
  const r = pickStreams([svc("api", 5), svc("jobs", 1), svc("billing", 3)], 5);
  assert.deepEqual(r, { keys: ["api|s0", "jobs|s0", "billing|s0", "api|s1", "billing|s1"], total: 9 });
  assert.deepEqual(pickStreams([svc("api", 2)], 24), { keys: ["api|s0", "api|s1"], total: 2 });
  const shuffled = { service: "x", keys: [{ k: "old", lastEventAt: 1 }, { k: "new", lastEventAt: 9 }] };
  assert.deepEqual(pickStreams([shuffled], 1).keys, ["new"]);
});

test("the GetLogEvents token bucket: a burst, then one call per 1/rate, and refusal past the longest wait", async () => {
  const { TokenBucket } = await import("./logpaging.ts");
  const b = new TokenBucket(12, 12, 0);
  const waits = Array.from({ length: 14 }, () => b.take(0));
  assert.deepEqual(waits.slice(0, 12), Array(12).fill(0));
  assert.deepEqual(waits.slice(12), [84, 167], "reserved one after the other");
  assert.equal(b.take(0, 100), null, "a third would wait 250 ms: refused, not counted");
  assert.equal(b.take(1000), 0, "refilled after a second");
});

// ---------- F27: search with a budget ----------

test("search pages until enough matches, no next token, or the budget — checked before each call", async () => {
  const { scanPages } = await import("./logpaging.ts");
  const ev = (n: number) => Array.from({ length: n }, (_, i) => ({ ts: i, msg: `m${i}`, stream: "s" }));
  // Nine empty pages, then the match: one request finds it (it used to take nine clicks).
  let calls = 0;
  const sparse = async (token: string | undefined) => (calls++, token === "t9" ? { events: ev(1) } : { events: [], next: `t${Number(token?.slice(1) ?? 0) + 1}` });
  const r = await scanPages(sparse, { want: 200, deadline: Infinity });
  assert.deepEqual([r.events.length, r.next, r.pages, calls], [1, undefined, 10, 10]);
  // Enough matches: stop and hand back the cursor.
  const full = await scanPages(async (_t, limit) => ({ events: ev(Math.min(limit, 150)), next: "more" }), { want: 200, deadline: Infinity });
  assert.deepEqual([full.events.length, full.next, full.pages], [200, "more", 2]);
  // Out of time: the clock is read before every call; the next token is the cursor.
  let t = 0;
  const slow = await scanPages(async (token) => ((t += 3000), { events: [], next: `${token ?? ""}x` }), { want: 200, deadline: 8000, now: () => t });
  assert.deepEqual([slow.pages, slow.next, slow.outOfTime], [3, "xxx", true]);
  assert.deepEqual(await scanPages(async () => ({ events: [] }), { want: 1, deadline: 0 }), { events: [], next: undefined, pages: 0, outOfTime: true });
});

test("search: throttling returns what was found and the token to resume from", async () => {
  const { isThrottled, scanPages } = await import("./logpaging.ts");
  let n = 0;
  const r = await scanPages(
    async () => {
      if (n++ === 2) throw Object.assign(new Error("Rate exceeded"), { name: "ThrottlingException" });
      return { events: [{ ts: n, msg: "x", stream: "s" }], next: `p${n}` };
    },
    { want: 200, deadline: Infinity },
  );
  assert.deepEqual([r.events.length, r.next, r.throttled], [2, "p2", true]);
  const first = await scanPages(async () => Promise.reject(Object.assign(new Error("x"), { name: "LimitExceededException" })), { want: 1, deadline: Infinity });
  assert.deepEqual([first.next, first.throttled, first.pages], [undefined, true, 0], "throttled before the first page: nothing to resume, start again");
  await assert.rejects(scanPages(async () => Promise.reject(new Error("AccessDeniedException")), { want: 1, deadline: Infinity }), /AccessDenied/);
  assert.ok(isThrottled({ name: "ThrottlingException" }) && !isThrottled(new Error("boom")));
});

// ---------- F62: Logs Insights limits and ownership (server module: a child process with the react-server condition) ----------

test("Insights: a query id is served only to whoever started it (or an admin); 10 per person per 5 min; 5 running at once", async () => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const logs = new URL("./server/logs.ts", import.meta.url).href;
  const code = `
    const L = await import(${JSON.stringify(logs)});
    const out = {};
    const t = await L.servicesParam("production", "api");
    const end = Date.now(), start = end - 3_600_000;
    const alice = { id: "alice", role: "viewer" }, bob = { id: "bob", role: "developer" }, root = { id: "root", role: "admin" };
    const st = (p) => p.then(() => "ok", (e) => e.status);
    const { id } = await L.insightsStart(t, "fields @message | limit 5", start, end, alice);
    out.own = (await L.insightsResults(id, alice)).status;
    out.bob = await st(L.insightsResults(id, bob));
    out.admin = await st(L.insightsResults(id, root));
    out.forged = await st(L.insightsResults("mock-q-forged", alice));
    out.badId = await st(L.insightsResults("../etc", alice));
    for (let i = 0; i < 4; i++) await L.insightsStart(t, "fields @message", start, end, { id: "u" + i });
    out.sixth = await L.insightsStart(t, "fields @message", start, end, { id: "carol" }).then(() => "ok", (e) => [e.status, e.message, e.retryAfterMs > 0]);
    const done = () => { for (const q of globalThis.__consoleInsights.owners.values()) q.done = true; };
    done();
    let n = 1;
    for (; n < 12; n++) {
      const r = await L.insightsStart(t, "fields @message", start, end, alice).then(() => "ok", (e) => e);
      done();
      if (r !== "ok") { out.aliceStopsAt = n + 1; out.aliceErr = [r.status, /10 Insights queries in 5 minutes/.test(r.message)]; break; }
    }
    out.span = await st(L.insightsStart(t, "x", start, end, { id: "z" }).then(() => L.insightsStart([...t, { ...t[0], region: "eu-west-1" }], "x", start, end, { id: "z2" })));
    console.log(JSON.stringify(out));
  `;
  const env = { ...process.env, CONSOLE_SOURCE: "mock", CONSOLE_SQLITE_PATH: ":memory:", AUTH_MODE: "dev" };
  const { stdout } = await promisify(execFile)(process.execPath, ["--conditions=react-server", "--no-warnings", "--input-type=module", "-e", code], { env, timeout: 60_000 });
  const out = JSON.parse(stdout.trim().split("\n").pop()!);
  assert.equal(out.own, "Running");
  assert.equal(out.bob, 403, "another person's query");
  assert.equal(out.admin, "ok", "an admin may read it");
  assert.equal(out.forged, 404, "an id this console didn't start");
  assert.equal(out.badId, 400);
  assert.deepEqual(out.sixth, [429, "5 Insights queries are already running — try again in a moment", true]);
  assert.equal(out.aliceStopsAt, 11, "the 11th query in 5 minutes is refused");
  assert.deepEqual(out.aliceErr, [429, true]);
  assert.equal(out.span, 400, "never across regions");
});
