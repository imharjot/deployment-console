// Pure helpers behind the log API (src/lib/server/logs.ts): client-held cursors, scoping them to the requested
// services, the time-ordered merge of per-stream pages, the gap-free "older" boundary and query escaping.
// No AWS calls here, so the paging rules are unit-tested (logpaging.test.ts).
import { HttpError } from "./server/errors.ts";
import type { LogLine } from "./types.ts";

// Where a service logs: its main container's awslogs group, and the stream prefix that isolates it in a shared group.
export interface Target {
  service: string;
  group: string;
  prefix?: string;
  shared: boolean; // another discovered service writes to the same group
}

// "a,b" or "all" → the services' log targets (servicesParam in server/logs.ts feeds it the env's catalog). Only a
// visible service with logs can be asked for. A log group shared with any other service — hidden ones included (F62) —
// is read through the service's stream prefix only; a shared group without one can't be scoped, so it is refused when
// it also holds a hidden service's logs ("all" just leaves such a service out).
export function scopeTargets<T extends Target>(
  services: { id: string; hidden?: boolean; logs?: { group: string; prefix?: string } }[],
  v: string,
  extra: (t: Target) => T = (t) => t as T,
): T[] {
  const byGroup = new Map<string, number>();
  const hiddenIn = new Set<string>();
  for (const m of services) {
    if (!m.logs) continue;
    byGroup.set(m.logs.group, (byGroup.get(m.logs.group) ?? 0) + 1);
    if (m.hidden) hiddenIn.add(m.logs.group);
  }
  const allowed = new Map(
    services.filter((m) => !m.hidden && m.logs).map((m): [string, T] => [m.id, extra({ service: m.id, group: m.logs!.group, prefix: m.logs!.prefix, shared: (byGroup.get(m.logs!.group) ?? 0) > 1 })]),
  );
  const list = v === "all" ? [...allowed.keys()] : [...new Set(v.split(",").map((x) => x.trim()).filter(Boolean))];
  const bad = list.filter((x) => !allowed.has(x));
  if (bad.length || !list.length) throw new HttpError(400, `unknown service(s) or no logs: ${bad.join(", ") || "none"}`);
  const unscopable = (t: Target) => !t.prefix && hiddenIn.has(t.group);
  const out = list.map((x) => allowed.get(x)!).filter((t) => v !== "all" || !unscopable(t));
  if (!out.length) throw new HttpError(400, "no service whose logs can be shown on their own");
  const unscoped = out.filter(unscopable);
  if (unscoped.length) throw new HttpError(400, `${unscoped.map((t) => t.service).join(", ")} log to a group shared with a hidden service and have no stream prefix, so their lines can't be told apart`);
  return out;
}

export interface Event {
  ts: number;
  msg: string;
}

// ---------- cursors ----------
// Tail cursor  = base64url JSON { s: { "<group>|<stream>": forwardToken }, t: fetchedAt, e?: { key: empty polls in a
//                row }, p?: { key: last polled at } } — e and p let a quiet stream be polled every 10 s instead of every
//                2 s (F26). The browser holds it; the server stays stateless.
// Search cursor = the same shape keyed by "<group>|<prefix>" with CloudWatch nextTokens, and no t.
// Older cursor = { k: ["<group>|<stream>", …], b: beforeMs } — time-based so pages across streams line up.

export interface TailCursor {
  s: Record<string, string>;
  t?: number;
  e?: Record<string, number>;
  p?: Record<string, number>;
}

export interface OlderCursor {
  k: string[];
  b: number;
}

export const encodeCursor = (o: TailCursor | OlderCursor) => Buffer.from(JSON.stringify(o)).toString("base64url");

// Client-held: every field is checked, own properties only; numbers that aren't numbers are dropped, not trusted.
export function decodeTailCursor(c: string | null): TailCursor | null {
  if (!c) return null;
  let o: unknown;
  try {
    o = JSON.parse(Buffer.from(c, "base64url").toString());
  } catch {
    throw new HttpError(400, "bad cursor");
  }
  const rec = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
  if (!rec(o) || !rec(o.s) || !Object.values(o.s).every((x) => typeof x === "string")) throw new HttpError(400, "bad cursor");
  const nums = (v: unknown) => (rec(v) ? Object.fromEntries(Object.entries(v).filter(([, x]) => typeof x === "number" && Number.isFinite(x))) as Record<string, number> : undefined);
  const out: TailCursor = { s: { ...(o.s as Record<string, string>) } };
  if (typeof o.t === "number" && Number.isFinite(o.t)) out.t = o.t;
  const e = nums(o.e), p = nums(o.p);
  if (e && Object.keys(e).length) out.e = e;
  if (p && Object.keys(p).length) out.p = p;
  return out;
}

export function decodeOlderCursor(c: string | null): OlderCursor {
  try {
    const o = JSON.parse(Buffer.from(c ?? "", "base64url").toString());
    if (Array.isArray(o.k) && o.k.every((x: unknown) => typeof x === "string") && Number.isFinite(o.b)) return o;
  } catch {
    // fall through: any malformed cursor is the same 400
  }
  throw new HttpError(400, "bad cursor");
}

export const streamKey = (group: string, stream: string) => `${group}|${stream}`;

// Log group names can't contain "|", so the first one separates group from stream.
export function splitKey(k: string): readonly [group: string, stream: string] {
  const i = k.indexOf("|");
  return [k.slice(0, i), k.slice(i + 1)] as const;
}

// A client-held cursor key is only honoured if it points inside one of the requested targets.
export function inTargets(targets: Target[], k: string): boolean {
  const [g, s] = splitKey(k);
  return targets.some((t) => t.group === g && (!t.prefix || s.startsWith(t.prefix)));
}

// ---------- merging ----------

export interface StreamPage {
  stream: string;
  events: Event[];
}

// Every line is [ts, index into streams, message]; the result is sorted by time (stable for equal timestamps).
export function mergePages(pages: StreamPage[], limit: number, keep: "head" | "tail"): { lines: LogLine[]; streams: string[]; truncated: boolean } {
  const streams = pages.map((p) => p.stream);
  const all: LogLine[] = [];
  pages.forEach((p, i) => {
    for (const e of p.events) all.push([e.ts, i, e.msg]);
  });
  all.sort((a, b) => a[0] - b[0]);
  const truncated = all.length > limit;
  return { lines: !truncated ? all : keep === "tail" ? all.slice(all.length - limit) : all.slice(0, limit), streams, truncated };
}

// GetLogEvents returns at most `per` events and at most 1 MB, so a page that hit either limit may be missing older
// events. ~26 bytes of per-event overhead is added to the message size, as CloudWatch counts it.
export const isPartialPage = (events: Event[], per: number) => events.length >= per || events.reduce((a, e) => a + e.msg.length + 26, 0) > 900_000;

// Newest lines before a point in time across streams, with no gaps. A stream that filled its page only reaches back
// to its oldest line, so anything older than the newest such boundary waits for the next page (endTime is exclusive).
// Each page is therefore strictly older than the one before it, and prepending keeps the view in time order.
// Known limit: a stream writing more than `per` lines within one millisecond stalls paging; not seen in practice.
export function mergeOlder(pages: (StreamPage & { k: string })[], per: number): { lines: LogLine[]; streams: string[]; older: OlderCursor | null } {
  const cut = Math.max(-Infinity, ...pages.filter((p) => isPartialPage(p.events, per)).map((p) => p.events[0].ts));
  const m = mergePages(pages.map((p) => ({ stream: p.stream, events: p.events.filter((e) => e.ts > cut) })), Infinity, "tail");
  const left = pages.filter((p) => p.events.length && p.events[0].ts <= cut).map((p) => p.k);
  return { lines: m.lines, streams: m.streams, older: left.length ? { k: left, b: cut + 1 } : null };
}

// ---------- queries ----------

// Literal text search → one quoted CloudWatch filter term (backslashes and quotes escaped).
export const literalPattern = (q: string) => `"${q.trim().replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

// A log group shared by several services is narrowed to the selected services' streams.
export function scopedInsightsQuery(targets: Target[], query: string): string {
  if (!targets.some((t) => t.shared && t.prefix)) return query;
  const esc = (p: string) => p.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  return `filter @logStream like /^(${targets.map((t) => esc(t.prefix ?? "")).join("|")})/\n| ${query}`;
}

// ---------- tail at scale (F26) ----------

// A quiet stream: after IDLE_POLLS empty polls in a row it is polled once every IDLE_EVERY_MS; one line resets it.
export const IDLE_POLLS = 3;
export const IDLE_EVERY_MS = 10_000;
export const idle = (c: TailCursor, k: string, now: number) => (c.e?.[k] ?? 0) >= IDLE_POLLS && now - (c.p?.[k] ?? 0) < IDLE_EVERY_MS;

// The streams to tail when there are more than `cap`: each service's newest first, taken in turns, so every service
// keeps its current task's stream before any service gets a third.
export function pickStreams(perService: { service: string; keys: { k: string; lastEventAt: number }[] }[], cap: number): { keys: string[]; total: number } {
  const lists = perService.map((p) => [...p.keys].sort((a, b) => b.lastEventAt - a.lastEventAt).map((x) => x.k));
  const total = new Set(lists.flat()).size;
  const out: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; out.length < cap && lists.some((l) => i < l.length); i++) {
    for (const l of lists) {
      if (out.length >= cap) break;
      const k = l[i];
      if (k !== undefined && !seen.has(k)) {
        seen.add(k);
        out.push(k);
      }
    }
  }
  return { keys: out, total };
}

// A process-wide token bucket that reserves: take() returns how long to wait before the call may go (0 = now), and
// counts the call; a wait over maxWaitMs is refused (null) and not counted. Keeps every viewer's tail together under
// CloudWatch Logs' per-account GetLogEvents quota (25/s, not raisable).
export class TokenBucket {
  readonly rate: number;
  readonly burst: number;
  private tokens: number;
  private at: number;
  constructor(ratePerSec: number, burst = ratePerSec, now = Date.now()) {
    this.rate = ratePerSec;
    this.burst = burst;
    this.tokens = burst;
    this.at = now;
  }
  take(now = Date.now(), maxWaitMs = Infinity): number | null {
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.at) / 1000) * this.rate);
    this.at = now;
    const wait = this.tokens >= 1 ? 0 : Math.ceil(((1 - this.tokens) / this.rate) * 1000);
    if (wait > maxWaitMs) return null;
    this.tokens -= 1;
    return wait;
  }
}

// ---------- search at scale (F27) ----------

const THROTTLED = /Throttl|LimitExceeded|TooManyRequests|Rate exceeded/i;
export const isThrottled = (e: unknown) => THROTTLED.test(`${(e as { name?: string })?.name ?? ""} ${(e as { message?: string })?.message ?? ""}`);

// FilterLogEvents pages until `want` events, no next token, or the deadline — checked before every call, so a page is
// never started late. Throttled: stop and hand back the token it was about to use (none: it hadn't started), so
// "Continue scanning" resumes there.
export async function scanPages(
  page: (token: string | undefined, limit: number) => Promise<{ events: { ts: number; msg: string; stream: string }[]; next?: string }>,
  o: { want: number; deadline: number; token?: string; now?: () => number },
): Promise<{ events: { ts: number; msg: string; stream: string }[]; next?: string; pages: number; throttled?: boolean; outOfTime?: boolean }> {
  const now = o.now ?? Date.now;
  const events: { ts: number; msg: string; stream: string }[] = [];
  let token = o.token;
  let pages = 0;
  for (;;) {
    if (now() >= o.deadline) return { events, next: token, pages, outOfTime: true };
    let r: Awaited<ReturnType<typeof page>>;
    try {
      r = await page(token, Math.max(1, o.want - events.length));
    } catch (e) {
      if (isThrottled(e)) return { events, next: token, pages, throttled: true }; // next undefined: not started yet
      throw e;
    }
    pages++;
    events.push(...r.events);
    token = r.next;
    if (!token || events.length >= o.want) return { events, next: token, pages };
  }
}
