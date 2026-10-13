// Client-side log buffer for the viewer. Plain arrays + typed parallel arrays; React never holds lines in state.
// Bounded twice (F49): by lines (default 200k) and by bytes (64 MB, 16 MB on devices reporting ≤ 4 GB of memory), and
// one line keeps at most 32k characters. Old lines drop in batches so a busy service can stream for hours without
// growing — 200k lines of 2 KB JSON would otherwise be 800 MB.
import type { Compiled } from "./logquery.ts";
import type { LogLine } from "./types.ts";

export const LEVELS = ["", "trace", "debug", "info", "warn", "error", "fatal"] as const;
export type Level = 0 | 1 | 2 | 3 | 4 | 5 | 6;

// Cheap level sniff on the first 300 chars: pino numeric levels, Go slog/zap text, plain prefixes.
export function sniffLevel(msg: string): Level {
  const head = msg.length > 300 ? msg.slice(0, 300) : msg;
  const n = /"level"\s*:\s*(\d{2})/.exec(head);
  if (n) {
    const v = Number(n[1]);
    return v >= 60 ? 6 : v >= 50 ? 5 : v >= 40 ? 4 : v >= 30 ? 3 : v >= 20 ? 2 : 1;
  }
  const t = /(?:"level"\s*:\s*"|level=|\b)(fatal|panic|error|err|warn(?:ing)?|info|debug|trace)\b/i.exec(head);
  if (!t) return 0;
  const w = t[1].toLowerCase();
  return w === "fatal" || w === "panic" ? 6 : w.startsWith("err") ? 5 : w.startsWith("warn") ? 4 : w === "info" ? 3 : w === "debug" ? 2 : 1;
}

// Readable one-line summary of a structured (JSON) log line; plain text passes through.
// Only called for the ~70 rows on screen, so parsing cost is irrelevant even on 200k-line buffers.
const SKIP = new Set(["level", "time", "pid", "hostname", "v", "ts", "msg", "message", "logger"]);
export function prettyLine(raw: string): string {
  const t = raw.trimStart();
  if (t[0] !== "{" || t.length > 20_000) return raw;
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(t);
  } catch {
    return raw;
  }
  const parts: string[] = [];
  const msg = (o.msg ?? o.message) as string | undefined;
  const req = o.req as { method?: string; url?: string } | undefined;
  const res = o.res as { statusCode?: number } | undefined;
  const request = o.request as { method?: string; uri?: string; host?: string } | undefined;
  const err = o.err as { type?: string; message?: string } | undefined;
  if (req?.method || request?.method) parts.push(`${req?.method ?? request?.method} ${req?.url ?? request?.uri ?? ""}`.trim());
  const status = res?.statusCode ?? (o.status as number | undefined);
  if (status !== undefined) parts.push(`→ ${status}`);
  if (typeof o.responseTime === "number") parts.push(`${o.responseTime}ms`);
  if (err) parts.push(`${err.type ?? "Error"}: ${err.message ?? ""}`);
  const rest: string[] = [];
  for (const [k, v] of Object.entries(o)) {
    if (SKIP.has(k) || k === "req" || k === "res" || k === "err" || k === "request" || k === "responseTime" || k === "status") continue;
    if (rest.length >= 6) break;
    rest.push(`${k}=${typeof v === "object" ? JSON.stringify(v) : String(v)}`);
  }
  return [msg, ...parts, ...rest].filter(Boolean).join("  ");
}

export interface QueryState {
  q: Compiled | null;
  minLevel: Level;
  range: [number, number] | null; // time window from the histogram brush
  mode: "filter" | "highlight";
}
const NO_QUERY: QueryState = { q: null, minLevel: 0, range: null, mode: "filter" };

// Per-line cap: a 5 MB stack dump keeps its first 32k characters and says how much was cut.
export const MAX_LINE_CHARS = 32_000;
export const clipLine = (m: string) => (m.length > MAX_LINE_CHARS ? `${m.slice(0, MAX_LINE_CHARS)} …[line cut: ${(m.length - MAX_LINE_CHARS).toLocaleString("en-US")} more characters]` : m);
// What a line costs in memory, roughly: UTF-16 text plus its slots in the parallel arrays.
export const lineBytes = (m: string) => m.length * 2 + 40;
export function defaultMaxBytes(): number {
  const mem = typeof navigator === "undefined" ? undefined : (navigator as { deviceMemory?: number }).deviceMemory;
  return typeof mem === "number" && mem <= 4 ? 16 * 1024 * 1024 : 64 * 1024 * 1024;
}

export class LogStore {
  ts: number[] = [];
  stream: number[] = [];
  msg: string[] = [];
  level: Level[] = [];
  streams: string[] = [];
  dropped = 0; // lines trimmed from the front since creation (keeps scroll position stable)
  private qs: QueryState = NO_QUERY;
  private index: number[] | null = null; // visible line indices when anything filters
  matchRows: number[] = []; // visible row numbers of query matches (for n / N navigation)
  private streamIds = new Map<string, number>();

  readonly capacity: number;
  readonly maxBytes: number;
  bytes = 0; // estimated memory held by the lines (lineBytes)

  constructor(capacity = 200_000, maxBytes = defaultMaxBytes()) {
    this.capacity = capacity;
    this.maxBytes = maxBytes;
  }

  get size() {
    return this.msg.length;
  }

  get visibleCount() {
    return this.index ? this.index.length : this.msg.length;
  }

  get query() {
    return this.qs;
  }

  // Map a visible row number to a line index.
  lineAt(row: number) {
    return this.index ? this.index[row] : row;
  }

  mapStreams(names: string[]): number[] {
    return names.map((n) => {
      let id = this.streamIds.get(n);
      if (id === undefined) {
        id = this.streams.length;
        this.streams.push(n);
        this.streamIds.set(n, id);
      }
      return id;
    });
  }

  // Pages arrive in time order, but streams flush to CloudWatch independently, so a page can start before the newest
  // line already held. The overlapping tail is merged back into order; only that tail moves.
  append(lines: LogLine[], pageStreams: string[]): { added: number; trimmed: number } {
    if (!lines.length) return { added: 0, trimmed: 0 };
    const ids = this.mapStreams(pageStreams);
    let at = this.ts.length;
    while (at > 0 && this.ts[at - 1] > lines[0][0]) at--;
    const old = { ts: this.ts.splice(at), stream: this.stream.splice(at), msg: this.msg.splice(at), level: this.level.splice(at) };
    if (old.ts.length) this.forgetFrom(at);
    let j = 0;
    const keepOld = (upTo: number) => {
      for (; j < old.ts.length && old.ts[j] <= upTo; j++) {
        this.ts.push(old.ts[j]);
        this.stream.push(old.stream[j]);
        this.msg.push(old.msg[j]);
        this.level.push(old.level[j]);
      }
    };
    for (const [t, s, raw] of lines) {
      keepOld(t);
      const m = clipLine(raw);
      this.ts.push(t);
      this.stream.push(ids[s] ?? 0);
      this.msg.push(m);
      this.level.push(sniffLevel(m));
      this.bytes += lineBytes(m);
    }
    keepOld(Infinity);
    if (this.active()) for (let i = at; i < this.msg.length; i++) this.consider(i);
    return { added: lines.length, trimmed: this.trim() };
  }

  // Drop visible rows and matches for lines at index ≥ at (they are about to be re-placed).
  private forgetFrom(at: number) {
    if (this.index) while (this.index.length && this.index[this.index.length - 1] >= at) this.index.pop();
    const limit = this.index ? this.index.length : at;
    while (this.matchRows.length && this.matchRows[this.matchRows.length - 1] >= limit) this.matchRows.pop();
  }

  // Older history (scroll-up paging) goes in front, as much of its newest end as fits both limits.
  prepend(lines: LogLine[], pageStreams: string[]): number {
    if (!lines.length) return 0;
    const ids = this.mapStreams(pageStreams);
    let room = Math.max(0, this.capacity - this.msg.length);
    let budget = this.maxBytes - this.bytes;
    const take: { t: number; s: number; m: string }[] = [];
    for (let i = lines.length - 1; i >= 0 && room > 0; i--, room--) {
      const m = clipLine(lines[i][2]);
      if (lineBytes(m) > budget) break;
      budget -= lineBytes(m);
      take.push({ t: lines[i][0], s: ids[lines[i][1]] ?? 0, m });
    }
    take.reverse();
    this.ts.unshift(...take.map((l) => l.t));
    this.stream.unshift(...take.map((l) => l.s));
    this.msg.unshift(...take.map((l) => l.m));
    this.level.unshift(...take.map((l) => sniffLevel(l.m)));
    this.bytes += take.reduce((a, l) => a + lineBytes(l.m), 0);
    this.rebuild();
    return take.length;
  }

  private trim(): number {
    // Trim in 10% batches: an O(n) splice every ~20k lines (or ~6 MB) instead of every line.
    const overLines = this.msg.length > this.capacity * 1.1;
    const overBytes = this.bytes > this.maxBytes * 1.1;
    if (!overLines && !overBytes) return 0;
    let n = Math.max(0, this.msg.length - this.capacity);
    let held = this.bytes;
    for (let i = 0; i < n; i++) held -= lineBytes(this.msg[i]);
    while (held > this.maxBytes && n < this.msg.length) held -= lineBytes(this.msg[n++]);
    if (!n) return 0;
    this.ts.splice(0, n);
    this.stream.splice(0, n);
    this.msg.splice(0, n);
    this.level.splice(0, n);
    this.bytes = held;
    this.dropped += n;
    if (this.index || this.matchRows.length) this.rebuild();
    return n;
  }

  private active() {
    const q = this.qs;
    return !!(q.q || q.minLevel || q.range);
  }

  private base(i: number) {
    const q = this.qs;
    if (q.minLevel && (this.level[i] === 0 || this.level[i] < q.minLevel)) return false;
    if (q.range && (this.ts[i] < q.range[0] || this.ts[i] > q.range[1])) return false;
    return true;
  }

  private hit(i: number) {
    const q = this.qs.q;
    return !q || q.test({ msg: this.msg[i], level: this.level[i], stream: this.streams[this.stream[i]] ?? "" });
  }

  // Place line i: visible or not, match or not. Called in time order.
  private consider(i: number) {
    if (!this.base(i)) return;
    const isHit = this.hit(i);
    if (this.qs.mode === "filter") {
      if (!isHit) return;
      this.index!.push(i);
      if (this.qs.q) this.matchRows.push(this.index!.length - 1);
    } else {
      if (this.index) this.index.push(i);
      if (this.qs.q && isHit) this.matchRows.push(this.index ? this.index.length - 1 : i);
    }
  }

  setQuery(next: Partial<QueryState>) {
    this.qs = { ...this.qs, ...next };
    this.rebuild();
  }

  // Back-compat convenience: plain substring + minimum level.
  setFilter(text: string, minLevel: Level = 0) {
    const t = text.trim().toLowerCase();
    this.setQuery({
      minLevel,
      mode: "filter",
      q: t ? { test: (l) => l.msg.toLowerCase().includes(t), highlight: null, fields: [] } : null,
    });
  }

  private rebuild() {
    this.matchRows = [];
    const needIndex = !!(this.qs.minLevel || this.qs.range || (this.qs.q && this.qs.mode === "filter"));
    this.index = needIndex ? [] : null;
    if (!this.active()) return;
    for (let i = 0; i < this.msg.length; i++) this.consider(i);
  }

  // Histogram of visible lines: counts per bucket split into error / warn / other.
  histogram(buckets = 80): { t0: number; t1: number; err: number[]; warn: number[]; other: number[] } | null {
    const n = this.visibleCount;
    if (!n) return null;
    const t0 = this.ts[this.lineAt(0)];
    const t1 = this.ts[this.lineAt(n - 1)];
    const span = Math.max(1, t1 - t0);
    const err = new Array(buckets).fill(0), warn = new Array(buckets).fill(0), other = new Array(buckets).fill(0);
    for (let r = 0; r < n; r++) {
      const i = this.lineAt(r);
      const b = Math.min(buckets - 1, Math.floor(((this.ts[i] - t0) / span) * buckets));
      const l = this.level[i];
      if (l >= 5) err[b]++;
      else if (l === 4) warn[b]++;
      else other[b]++;
    }
    return { t0, t1, err, warn, other };
  }

  // Top values of a field over the newest `sample` visible lines.
  facets(get: (msg: string) => string | undefined, sample = 50_000, top = 6): { value: string; count: number }[] {
    const counts = new Map<string, number>();
    const n = this.visibleCount;
    for (let r = Math.max(0, n - sample); r < n; r++) {
      const v = get(this.msg[this.lineAt(r)]);
      if (v !== undefined) counts.set(v, (counts.get(v) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, top).map(([value, count]) => ({ value, count }));
  }

  levelCounts(sample = 200_000): number[] {
    const out = [0, 0, 0, 0, 0, 0, 0];
    const n = this.visibleCount;
    for (let r = Math.max(0, n - sample); r < n; r++) out[this.level[this.lineAt(r)]]++;
    return out;
  }

  streamCounts(): { name: string; count: number }[] {
    const c = new Array(this.streams.length).fill(0);
    const n = this.visibleCount;
    for (let r = 0; r < n; r++) c[this.stream[this.lineAt(r)]]++;
    return this.streams.map((name, i) => ({ name, count: c[i] })).filter((x) => x.count).sort((a, b) => b.count - a.count);
  }

  // Fresh start for a new target: counters back to zero.
  reset() {
    this.clear();
    this.dropped = 0;
  }

  clear() {
    this.dropped += this.msg.length;
    this.bytes = 0;
    this.ts = [];
    this.stream = [];
    this.msg = [];
    this.level = [];
    this.matchRows = [];
    if (this.index) this.index = [];
  }
}
