// Logs: live tail (one or many services merged), history paging, CloudWatch search (literal or filter pattern),
// Logs Insights queries and view-in-context. Stateless: the browser carries its cursor. The pure paging rules
// (cursors, merge, the gap-free boundary, stream caps, the token bucket, the search loop) live in ../logpaging.ts.
import "server-only";
import { RateLimiter } from "../authn.ts";
import { LIMITS } from "../config.ts";
import { keyedLimiter, type KeyedLimiter } from "../limiter.ts";
import {
  TokenBucket, decodeOlderCursor, decodeTailCursor, encodeCursor, idle, inTargets, literalPattern, mergeOlder, mergePages, pickStreams, scanPages,
  scopeTargets, scopedInsightsQuery, splitKey, streamKey, type Target, type TailCursor,
} from "../logpaging.ts";
import type { User } from "../rbac.ts";
import type { EnvName, InsightsResult, LogLine, LogPage } from "../types.ts";
import { cached } from "./cache.ts";
import { onConnectionChange } from "./connection-state.ts";
import { HttpError } from "./errors.ts";
import { catalog, inRegion } from "./discovery.ts";
import { consoleRegions } from "./regions.ts";
import { getCloud, homeRegion, type Cloud, type EventsPage } from "./sources.ts";

// Log groups live in their env's region: servicesParam stamps it on each target, and every read below goes to that
// region's Cloud. All targets of one call come from one env, so one region — an Insights query never spans regions.
type RegionTarget = Target & { region?: string };
const regionOf = (targets: Target[]) => (targets[0] as RegionTarget | undefined)?.region;
const cloudOf = (targets: Target[]): Promise<Cloud> => getCloud(regionOf(targets));

// "a,b" or "all" → the env's discovered services that have logs (scoping rules in scopeTargets, F62). Nothing outside
// discovery ever reaches CloudWatch.
export async function servicesParam(env: EnvName, v: string | null): Promise<Target[]> {
  if (!v) throw new HttpError(400, "services required");
  const cat = await catalog(env);
  const region = cat.env.region;
  return scopeTargets<RegionTarget>([...cat.meta.values()], v, (t) => ({ ...t, region }));
}

// ---------- GetLogEvents budget (F26) ----------

// Every viewer's tail shares one bucket per process (LIMITS.logEventsTps) and at most 8 calls in flight (6 per region):
// the account-wide quota is 25/s and can't be raised. State on globalThis, like every route-shared cache.
const g = globalThis as { __consoleLogLimits?: { bucket: TokenBucket; slots: KeyedLimiter; filter: TokenBucket } };
const L = (g.__consoleLogLimits ??= {
  bucket: new TokenBucket(LIMITS.logEventsTps),
  slots: keyedLimiter({ global: 8, perKey: () => 6 }),
  filter: new TokenBucket(4), // FilterLogEvents: 5/s per account and region by default
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
class Busy extends Error {}

// One GetLogEvents within the budget. `maxWaitMs`: how long this caller may wait for a token; longer = Busy (the stream
// is skipped this poll and keeps its place in the cursor).
async function logEvents(cloud: Cloud, group: string, stream: string, o: Parameters<Cloud["logEvents"]>[2], maxWaitMs: number): Promise<EventsPage> {
  return L.slots.run(cloud.region, async () => {
    const wait = L.bucket.take(Date.now(), maxWaitMs);
    if (wait === null) throw new Busy();
    if (wait) await sleep(wait);
    return cloud.logEvents(group, stream, o);
  });
}

async function filterPage(cloud: Cloud, group: string, o: Parameters<Cloud["filterLogs"]>[1], deadline: number) {
  const wait = L.filter.take(Date.now(), Math.max(0, deadline - Date.now()));
  if (wait === null) throw Object.assign(new Error("search budget: FilterLogEvents rate"), { name: "ThrottlingException" });
  if (wait) await sleep(wait);
  return cloud.filterLogs(group, o);
}

// Newest lines before `before` across streams, with no gaps (see mergeOlder).
async function pageBack(cloud: Cloud, keys: string[], before: number | undefined, limit: number) {
  const per = Math.max(100, Math.floor(limit / Math.max(1, keys.length)));
  const pages = (
    await Promise.all(
      keys.map(async (k) => {
        const [g, s] = splitKey(k);
        try {
          return { k, stream: s, page: await logEvents(cloud, g, s, { fromHead: false, end: before, limit: per }, 8_000) };
        } catch (e) {
          if ((e as Error).name === "ResourceNotFoundException") return null;
          throw e instanceof Busy ? new HttpError(429, "log reads are busy — try again in a moment", 2_000) : e;
        }
      }),
    )
  ).filter((p) => p !== null);
  const m = mergeOlder(pages.map((p) => ({ k: p.k, stream: p.stream, events: p.page.events })), per);
  return {
    lines: m.lines,
    streams: m.streams,
    forward: Object.fromEntries(pages.map((p) => [p.k, p.page.forward])),
    older: m.older ? encodeCursor(m.older) : null,
  };
}

// Each service's streams, newest first; cached 15 s (F26: listing streams costs a call per viewer per poll otherwise).
const streamsFor = async (t: Target) =>
  (await cached(`streams:${inRegion(t.group, regionOf([t]))}|${t.prefix ?? ""}`, 15_000, async () => (await cloudOf([t])).logStreams(t.group, t.prefix))).value;
const clampLimit = (n: number) => Math.min(Math.max(100, n || 2000), LIMITS.logTailMax);
const RECENT_MS = 10 * 60_000;

function capNote(tailed: number, total: number) {
  return tailed < total ? `following ${tailed} of ${total} log streams (each service's newest first) — pick fewer services to follow all of them` : undefined;
}

export async function logTail(targets: Target[], cursor: string | null, limitIn: number): Promise<LogPage> {
  const limit = clampLimit(limitIn);
  const cloud = await cloudOf(targets);
  const cur = decodeTailCursor(cursor);
  const now = Date.now();
  const infos = new Map(await Promise.all(targets.map(async (t) => [t, await streamsFor(t)] as const)));

  if (!cur) {
    // First load: latest lines of the 2 most recently active streams of each service (current task + the one it
    // replaced), at most LIMITS.logTailMaxStreams in all.
    const picked = pickStreams(targets.map((t) => ({ service: t.service, keys: (infos.get(t) ?? []).slice(0, 2).map((s) => ({ k: streamKey(t.group, s.name), lastEventAt: s.lastEventAt })) })), LIMITS.logTailMaxStreams);
    const p = await pageBack(cloud, picked.keys, undefined, limit);
    const note = capNote(picked.keys.length, picked.total);
    return { lines: p.lines, streams: p.streams, cursor: encodeCursor({ s: p.forward, t: now }), older: p.older, streamsTailed: picked.keys.length, streamsTotal: picked.total, ...(note ? { note } : {}) };
  }

  // Follow: forward tokens for known streams, plus any new stream (a new task after a deploy) from its head. A stream
  // stays while it is one of its service's newest two or wrote in the last 10 minutes; the newest per service win
  // when there are more than the cap.
  const keep = (name: string, lastEventAt: number, list: { name: string }[]) => list.slice(0, 2).some((x) => x.name === name) || now - lastEventAt < RECENT_MS;
  const perService = targets.map((t) => {
    const list = infos.get(t) ?? [];
    const keys = list
      .filter((s) => (streamKey(t.group, s.name) in cur.s ? keep(s.name, s.lastEventAt, list) : s.lastEventAt >= (cur.t ?? 0) - 60_000))
      .map((s) => ({ k: streamKey(t.group, s.name), lastEventAt: s.lastEventAt }));
    return { service: t.service, keys };
  });
  const picked = pickStreams(perService, LIMITS.logTailMaxStreams);
  const wanted = picked.keys.filter((k) => inTargets(targets, k)); // the cursor is client-held: stay inside allowed targets
  const due = wanted.filter((k) => !idle(cur, k, now)); // quiet streams are polled every 10 s, not every 2 s (F26)
  const per = Math.max(100, Math.floor(limit / Math.max(1, due.length)));
  const pages = await Promise.all(
    due.map(async (k) => {
      const [g, s] = splitKey(k);
      const token = Object.hasOwn(cur.s, k) ? cur.s[k] : undefined;
      try {
        return { k, stream: s, page: await logEvents(cloud, g, s, token ? { token, limit: per } : { fromHead: true, limit: per }, 4_000) };
      } catch (e) {
        if ((e as Error).name === "ResourceNotFoundException" || e instanceof Busy) return { k, stream: s, page: null };
        throw e;
      }
    }),
  );
  const ok = pages.filter((p): p is { k: string; stream: string; page: EventsPage } => p.page !== null);
  const busy = pages.length - ok.length;
  // Nothing is dropped: a full page just means more is waiting (truncated → the client polls again at once).
  // Pages end at different times per stream; the client's store merges the overlap into time order.
  const m = mergePages(ok.map((p) => ({ stream: p.stream, events: p.page.events })), Infinity, "head");
  const more = ok.some((p) => p.page.events.length >= per);
  const next: TailCursor = { s: {}, t: now, e: {}, p: {} };
  for (const k of wanted) {
    const got = ok.find((p) => p.k === k);
    if (got) {
      next.s[k] = got.page.forward;
      if (got.page.events.length) delete next.e![k];
      else next.e![k] = (cur.e?.[k] ?? 0) + 1;
      next.p![k] = now;
    } else if (Object.hasOwn(cur.s, k)) {
      // Skipped (quiet, or the budget was spent): keep its place, its count and when it was last polled.
      next.s[k] = cur.s[k];
      if (cur.e?.[k] !== undefined) next.e![k] = cur.e[k];
      if (cur.p?.[k] !== undefined) next.p![k] = cur.p[k];
    }
  }
  const notes = [capNote(picked.keys.length, picked.total), busy ? `${busy} stream${busy === 1 ? "" : "s"} skipped this poll — log reads are busy` : undefined].filter(Boolean);
  return {
    lines: m.lines, streams: m.streams, truncated: more, cursor: encodeCursor(next), older: null, streamsTailed: picked.keys.length, streamsTotal: picked.total,
    ...(notes.length ? { note: notes.join(" · ") } : {}),
  };
}

export async function logOlder(targets: Target[], cursor: string | null, limitIn: number): Promise<LogPage> {
  const cur = decodeOlderCursor(cursor);
  const keys = cur.k.filter((k) => inTargets(targets, k)).slice(0, LIMITS.logTailMaxStreams); // client-held: stay inside allowed targets
  if (!keys.length) return { lines: [], streams: [], cursor: null, older: null };
  const p = await pageBack(await cloudOf(targets), keys, cur.b, clampLimit(limitIn));
  return { lines: p.lines, streams: p.streams, cursor: null, older: p.older };
}

// mode "text": the input is matched literally. mode "pattern": a CloudWatch filter pattern, passed as-is
// (e.g. { $.level >= 50 }, ?ERROR ?WARN, [ip, user, ...]). One request scans for up to LIMITS.logSearchBudgetMs
// (F27): each target pages until it has its share of matches, runs out of pages or time; what's left comes back as
// the cursor ("Continue scanning"), and `scanned` says how many pages were read.
export async function logSearch(targets: Target[], q: string, mode: string, start: number, end: number, cursor: string | null): Promise<LogPage> {
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) throw new HttpError(400, "bad time range");
  if (end - start > LIMITS.logSearchMaxRangeMs) throw new HttpError(400, "range over 24h — narrow it, or use an Insights query");
  if (q.length > 1024 || /[\r\n]/.test(q)) throw new HttpError(400, "pattern must be one line, ≤ 1024 chars");
  const cloud = await cloudOf(targets);
  const pattern = !q.trim() ? undefined : mode === "pattern" ? q.trim() : literalPattern(q);
  const tk = (t: Target) => `${t.group}|${t.prefix ?? ""}`;
  const prev = cursor ? (decodeTailCursor(cursor)?.s ?? {}) : null;
  // A next page only for targets that had more; "" = throttled before its first page, start it from the top.
  const pending = prev ? targets.filter((t) => Object.hasOwn(prev, tk(t))) : targets;
  const want = Math.max(200, Math.floor(1000 / Math.max(1, pending.length)));
  const deadline = Date.now() + LIMITS.logSearchBudgetMs;
  const results = await Promise.all(
    pending.map(async (t) => ({
      g: tk(t),
      r: await scanPages((token, limit) => filterPage(cloud, t.group, { pattern, start, end, token, limit, prefix: t.prefix }, deadline), { want, deadline, token: prev?.[tk(t)] || undefined }),
    })),
  );
  const names: string[] = [];
  const lines: LogLine[] = [];
  for (const { r } of results) {
    for (const e of r.events) {
      let i = names.indexOf(e.stream);
      if (i < 0) i = names.push(e.stream) - 1;
      lines.push([e.ts, i, e.msg]);
    }
  }
  lines.sort((a, b) => a[0] - b[0]);
  // Still to scan: a target with a next token, or one stopped by throttling or the clock (no token yet = from the top).
  const more = Object.fromEntries(results.filter((x) => x.r.next !== undefined || x.r.throttled || x.r.outOfTime).map((x) => [x.g, x.r.next ?? ""]));
  const scanned = results.reduce((a, x) => a + x.r.pages, 0);
  const notes = [
    results.some((x) => x.r.throttled) ? "CloudWatch is throttling searches — continue in a moment" : undefined,
    results.some((x) => x.r.outOfTime) ? `scanned ${scanned} page${scanned === 1 ? "" : "s"} in ${LIMITS.logSearchBudgetMs / 1000} s` : undefined,
  ].filter(Boolean);
  return { lines, streams: names, cursor: Object.keys(more).length ? encodeCursor({ s: more }) : null, older: null, scanned, ...(notes.length ? { note: notes.join(" · ") } : {}) };
}

// ---------- Logs Insights (F62) ----------

// Starting queries is rate-limited (10 per person per 5 minutes, at most 5 running across the console), and a query id
// is served only to whoever started it (or an admin), only if this console started it. On globalThis: the start and
// the results routes are separate bundles.
const INSIGHTS_PER_USER = 10;
const INSIGHTS_WINDOW_MS = 5 * 60_000;
const INSIGHTS_RUNNING_MAX = 5;
const INSIGHTS_KEEP_MS = 30 * 60_000;
const INSIGHTS_RUNNING_MS = 15 * 60_000; // a query nobody polled to the end stops counting as running after this
interface QueryOwner {
  userId: string;
  groups: string[];
  region: string;
  startedAt: number;
  done?: boolean;
}
const gi = globalThis as { __consoleInsights?: { owners: Map<string, QueryOwner>; perUser: RateLimiter } };
const I = (gi.__consoleInsights ??= { owners: new Map(), perUser: new RateLimiter(INSIGHTS_PER_USER, INSIGHTS_WINDOW_MS) });
// Logs Insights query ids belong to the account that ran them: after a switch they'd be polled with another one's.
onConnectionChange("logs", () => I.owners.clear());

const running = (now: number) => [...I.owners.values()].filter((q) => !q.done && now - q.startedAt < INSIGHTS_RUNNING_MS).length;

// Logs Insights: full query language (filter / parse / stats / sort) over up to 7 days, log groups fixed server-side.
// A query id belongs to the region it ran in: outside the home region the id handed out is "<id>@<region>".
export async function insightsStart(targets: Target[], query: string, start: number, end: number, user: Pick<User, "id">) {
  if (!query.trim() || query.length > 10_000) throw new HttpError(400, "query required (≤ 10,000 chars)");
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) throw new HttpError(400, "bad time range");
  if (end - start > 7 * 86_400_000) throw new HttpError(400, "Insights range is limited to 7 days here");
  if (new Set(targets.map((t) => (t as RegionTarget).region)).size > 1) throw new HttpError(400, "an Insights query can't span regions");
  const now = Date.now();
  for (const [id, q] of I.owners) if (now - q.startedAt > INSIGHTS_KEEP_MS) I.owners.delete(id);
  const wait = I.perUser.retryIn(user.id, now);
  if (wait > 0) throw new HttpError(429, `${INSIGHTS_PER_USER} Insights queries in 5 minutes is the limit — try again in ${Math.ceil(wait / 1000)} s`, wait);
  if (running(now) >= INSIGHTS_RUNNING_MAX) throw new HttpError(429, `${INSIGHTS_RUNNING_MAX} Insights queries are already running — try again in a moment`, 5_000);
  I.perUser.fail(user.id, now);
  const cloud = await cloudOf(targets);
  const groups = [...new Set(targets.map((t) => t.group))];
  const raw = await cloud.insightsStart(groups, scopedInsightsQuery(targets, query), start, end, 1000);
  const id = cloud.region === homeRegion() ? raw : `${raw}@${cloud.region}`;
  I.owners.set(id, { userId: user.id, groups, region: cloud.region, startedAt: now });
  return { id };
}

export async function insightsResults(qid: string, user: Pick<User, "id" | "role">): Promise<InsightsResult> {
  const m = /^([\w-]{1,100})(?:@([a-z0-9-]{1,30}))?$/.exec(qid);
  if (!m) throw new HttpError(400, "bad query id");
  const owner = I.owners.get(qid); // a Map: no inherited keys
  if (!owner) throw new HttpError(404, "unknown query — it wasn't started here, or it expired");
  if (owner.userId !== user.id && user.role !== "admin") throw new HttpError(403, "this query was started by someone else");
  const [, id, region] = m;
  if ((region ?? homeRegion()) !== owner.region || !(await consoleRegions()).regions.includes(owner.region)) throw new HttpError(400, "bad query id");
  const r = await (await getCloud(owner.region)).insightsResults(id);
  if (r.status !== "Running" && r.status !== "Scheduled") owner.done = true;
  return r;
}

// ±100 lines around one event of one stream.
export async function logContext(target: Target, stream: string, ts: number): Promise<LogPage & { anchor: number }> {
  if (!stream || stream.length > 512 || !Number.isFinite(ts)) throw new HttpError(400, "stream and ts required");
  if (target.prefix && !stream.startsWith(target.prefix)) throw new HttpError(400, "stream does not belong to this service");
  const r = await (await cloudOf([target])).logAround(target.group, stream, ts, 100);
  const lines: LogLine[] = [...r.before, ...r.after].map((e) => [e.ts, 0, e.msg]);
  return { lines, streams: [stream], cursor: null, older: null, anchor: r.before.length };
}
