// Five-field cron schedules in an IANA time zone (master plan §6 C7 item 4): parse, validate and find the next fire
// times. Pure; the workflow scheduler (src/lib/server/agents/scheduler.ts) stores `next_at` from nextFire(), and the
// workflow preview shows the next few with nextFires().
//
// Fields: minute (0–59) hour (0–23) day-of-month (1–31) month (1–12 or JAN–DEC) day-of-week (0–7 or SUN–SAT; 0 and 7
// are Sunday). Each field is `*`, a value, a range `a-b`, a step `*/n`, `a-b/n` or `a/n` (from a to the field's end),
// or a comma list of those. Macros: @yearly (@annually), @monthly, @weekly, @daily (@midnight), @hourly. As in Vixie
// cron, when both day-of-month and day-of-week are restricted (neither starts with `*`), a day matching either fires.
//
// Times are the zone's wall clock. Daylight saving time:
// - a time the clocks skip (02:30 when they jump from 02:00 to 03:00) fires once, at the jump;
// - a time the clocks repeat (01:30 twice when they fall back) fires once, at its first occurrence. A schedule that
//   runs every few minutes therefore pauses during the repeated hour instead of running twice.
// A schedule that can't fire within 8 years (`0 0 30 2 *`) is refused.

export class CronError extends Error {
  status = 400;
  constructor(message: string) {
    super(message);
    this.name = "CronError";
  }
}

export interface CronSpec {
  minutes: number[];
  hours: number[];
  doms: number[];
  months: number[];
  dows: number[]; // 0–6, Sunday = 0
  domStar: boolean;
  dowStar: boolean;
}

const MACROS: Record<string, string> = {
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
  "@monthly": "0 0 1 * *",
  "@weekly": "0 0 * * 0",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@hourly": "0 * * * *",
};
const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const DAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

interface FieldDef {
  label: string;
  min: number;
  max: number;
  names?: string[]; // names[i] = min + i
}
const FIELDS: FieldDef[] = [
  { label: "minute", min: 0, max: 59 },
  { label: "hour", min: 0, max: 23 },
  { label: "day of month", min: 1, max: 31 },
  { label: "month", min: 1, max: 12, names: MONTHS },
  { label: "day of week", min: 0, max: 7, names: DAYS },
];

function value(raw: string, f: FieldDef): number {
  const up = raw.toUpperCase();
  const named = f.names?.indexOf(up) ?? -1;
  if (named >= 0) return f.min + named;
  if (!/^\d{1,2}$/.test(raw)) throw new CronError(`${f.label}: "${raw}" is not a number${f.names ? ` or a name (${f.names[0]}…)` : ""}`);
  const n = Number(raw);
  if (n < f.min || n > f.max) throw new CronError(`${f.label}: ${n} is outside ${f.min}–${f.max}`);
  return n;
}

function field(raw: string, f: FieldDef): number[] {
  const out = new Set<number>();
  for (const part of raw.split(",")) {
    if (!part) throw new CronError(`${f.label}: empty list item`);
    const [range, stepRaw, extra] = part.split("/");
    if (extra !== undefined) throw new CronError(`${f.label}: "${part}" has more than one "/"`);
    let step = 1;
    if (stepRaw !== undefined) {
      if (!/^\d{1,2}$/.test(stepRaw) || Number(stepRaw) < 1) throw new CronError(`${f.label}: step "${stepRaw}" must be a number ≥ 1`);
      step = Number(stepRaw);
    }
    let lo: number;
    let hi: number;
    if (range === "*") {
      lo = f.min;
      hi = f.max;
    } else if (range.includes("-")) {
      const [a, b, more] = range.split("-");
      if (more !== undefined || !a || !b) throw new CronError(`${f.label}: "${range}" is not a range`);
      lo = value(a, f);
      hi = value(b, f);
      if (lo > hi) throw new CronError(`${f.label}: range ${range} runs backwards`);
    } else {
      lo = value(range, f);
      hi = stepRaw !== undefined ? f.max : lo; // "5/15": from 5 to the end
    }
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return [...out].sort((a, b) => a - b);
}

export function parseCron(expr: unknown): CronSpec {
  if (typeof expr !== "string") throw new CronError("a schedule must be a cron expression");
  const trimmed = expr.trim();
  if (trimmed.length > 120) throw new CronError("the cron expression is too long");
  const text = MACROS[trimmed.toLowerCase()] ?? trimmed;
  const parts = text.split(/\s+/);
  if (parts.length !== 5) throw new CronError(`a cron expression has 5 fields (minute hour day-of-month month day-of-week), "${trimmed}" has ${parts.length}`);
  const [mi, h, dom, mon, dow] = parts.map((p, i) => field(p, FIELDS[i]));
  return {
    minutes: mi,
    hours: h,
    doms: dom,
    months: mon,
    dows: [...new Set(dow.map((d) => d % 7))].sort((a, b) => a - b),
    domStar: parts[2].startsWith("*"),
    dowStar: parts[4].startsWith("*"),
  };
}

// ---------- time zones ----------

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" });
    if (formatters.size > 200) formatters.clear();
    formatters.set(tz, f);
  }
  return f;
}

export function isTimeZone(tz: unknown): tz is string {
  if (typeof tz !== "string" || !tz || tz.length > 64) return false;
  try {
    formatter(tz);
    return true;
  } catch {
    return false;
  }
}

export interface Wall {
  y: number;
  m: number; // 1–12
  d: number;
  h: number;
  mi: number;
}

// The zone's wall clock at an instant (seconds dropped).
export function wallOf(t: number, tz: string): Wall {
  const p: Record<string, number> = {};
  for (const x of formatter(tz).formatToParts(new Date(t))) if (x.type !== "literal") p[x.type] = Number(x.value);
  return { y: p.year, m: p.month, d: p.day, h: p.hour % 24, mi: p.minute };
}

// The zone's UTC offset at an instant, in ms (whole minutes).
function offsetAt(t: number, tz: string): number {
  const w = wallOf(t, tz);
  const asUtc = Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi);
  return asUtc - Math.floor(t / 60_000) * 60_000;
}

// The instant a wall-clock minute happens: the first one when it happens twice (the clocks fell back), the moment the
// clocks jump when it doesn't happen at all (they sprang forward).
function instantOf(w: Wall, tz: string): number {
  const wall = Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi);
  const offs = [...new Set([offsetAt(wall - 86_400_000, tz), offsetAt(wall, tz), offsetAt(wall + 86_400_000, tz)])];
  const valid = offs.map((o) => wall - o).filter((t) => offsetAt(t, tz) === wall - t).sort((a, b) => a - b);
  if (valid.length) return valid[0];
  // A gap: the jump lies between the instant this time would have had under the later offset and under the earlier one.
  let lo = wall - Math.max(...offs);
  let hi = wall - Math.min(...offs);
  const after = offsetAt(hi, tz);
  while (hi - lo > 60_000) {
    const mid = lo + Math.floor((hi - lo) / 120_000) * 60_000;
    if (mid <= lo) break;
    if (offsetAt(mid, tz) === after) hi = mid;
    else lo = mid;
  }
  return hi;
}

// ---------- next fire ----------

const MAX_DAYS = 366 * 8;

function dateMatches(s: CronSpec, y: number, m: number, d: number): boolean {
  if (!s.months.includes(m)) return false;
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  const domOk = s.doms.includes(d);
  const dowOk = s.dows.includes(dow);
  if (s.domStar && s.dowStar) return true;
  if (s.domStar) return dowOk;
  if (s.dowStar) return domOk;
  return domOk || dowOk;
}

// The first fire time strictly after `after` (ms), or null when it doesn't fire within 8 years.
export function nextFire(expr: string | CronSpec, tz: string, after: number): number | null {
  const s = typeof expr === "string" ? parseCron(expr) : expr;
  if (!isTimeZone(tz)) throw new CronError(`unknown time zone "${String(tz)}"`);
  const start = wallOf(after, tz);
  const day0 = Date.UTC(start.y, start.m - 1, start.d);
  for (let i = 0; i < MAX_DAYS; i++) {
    const date = new Date(day0 + i * 86_400_000);
    const y = date.getUTCFullYear();
    const m = date.getUTCMonth() + 1;
    const d = date.getUTCDate();
    if (!dateMatches(s, y, m, d)) continue;
    for (const h of s.hours) {
      if (i === 0 && h < start.h) continue;
      for (const mi of s.minutes) {
        if (i === 0 && h === start.h && mi <= start.mi) continue;
        const t = instantOf({ y, m, d, h, mi }, tz);
        if (t > after) return t;
      }
    }
  }
  return null;
}

export function nextFires(expr: string, tz: string, after: number, n: number): number[] {
  const s = parseCron(expr);
  const out: number[] = [];
  let t = after;
  while (out.length < n) {
    const next = nextFire(s, tz, t);
    if (next === null) break;
    out.push(next);
    t = next;
  }
  return out;
}

// What a schedule's validator reports (empty when fine).
export function cronProblems(expr: unknown, tz: unknown, now = Date.now()): string[] {
  try {
    const s = parseCron(expr);
    if (!isTimeZone(tz)) return [`unknown time zone "${String(tz)}" (an IANA name such as "UTC" or "Europe/Berlin")`];
    if (nextFire(s, tz, now) === null) return [`"${String(expr)}" never fires`];
    return [];
  } catch (e) {
    return [(e as Error).message];
  }
}
