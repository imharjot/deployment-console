// Log query language — Railway-style (`@attr:value`, AND / OR / -, "phrases", parentheses, > >= < <= and a..b)
// plus /regex/flags and * wildcards. Compiled once into a predicate that runs on the raw line: fields are pulled out
// with regexes (JSON `"key": value` or logfmt `key=value`), never JSON.parse per line, so 200k lines filter in ~100ms.
//
//   level:error          level:>=warn         status:>=500        status:500..599     duration:>1000
//   path:/api/v2/orders*  method:POST          service:worker      "slow query"        /timeout|ECONNRESET/i
//   -health  NOT redis    (Prisma OR Kafka) level:error
import type { Level } from "./logstore.ts";

export interface LineCtx {
  msg: string;
  level: Level;
  stream: string;
}

type Node =
  | { t: "and" | "or"; a: Node; b: Node }
  | { t: "not"; a: Node }
  | { t: "text"; v: string; phrase: boolean }
  | { t: "re"; re: RegExp }
  | { t: "field"; key: string; op: "=" | ">" | ">=" | "<" | "<="; v: string; hi?: string };

export interface Compiled {
  test(l: LineCtx): boolean;
  highlight: RegExp | null; // positive text/regex terms, for marking matches
  fields: string[];
}

export type ParseResult = { ok: true; q: Compiled | null } | { ok: false; error: string; at: number };

// ---------- tokenizer ----------
type Tok = { k: "word" | "phrase" | "re" | "lp" | "rp" | "and" | "or" | "not" | "neg"; v: string; flags?: string; at: number };

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  const readQuoted = (): string => {
    let s = "";
    i++; // opening "
    while (i < src.length && src[i] !== '"') {
      if (src[i] === "\\" && i + 1 < src.length) {
        s += src[i + 1];
        i += 2;
      } else s += src[i++];
    }
    if (src[i] !== '"') throw Object.assign(new Error("unclosed quote"), { at: i });
    i++;
    return s;
  };
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    const at = i;
    if (c === "(") {
      out.push({ k: "lp", v: c, at });
      i++;
    } else if (c === ")") {
      out.push({ k: "rp", v: c, at });
      i++;
    } else if (c === '"') {
      out.push({ k: "phrase", v: readQuoted(), at });
    } else if (c === "/" && (out.length === 0 || /[\s(]/.test(src[i - 1] ?? " ") || src[i - 1] === "-")) {
      let j = i + 1;
      let body = "";
      while (j < src.length && src[j] !== "/") {
        if (src[j] === "\\" && j + 1 < src.length) {
          body += src[j] + src[j + 1];
          j += 2;
        } else body += src[j++];
      }
      if (src[j] !== "/") throw Object.assign(new Error("unclosed /regex/"), { at });
      j++;
      let flags = "";
      while (j < src.length && /[gimsuy]/.test(src[j])) flags += src[j++];
      out.push({ k: "re", v: body, flags, at });
      i = j;
    } else if (c === "-" && i + 1 < src.length && !/\s/.test(src[i + 1])) {
      out.push({ k: "neg", v: "-", at });
      i++;
    } else {
      // A word runs to whitespace or a closing paren; a quoted value may follow "key:".
      let w = "";
      while (i < src.length && !/[\s()]/.test(src[i])) {
        if (src[i] === '"' && /:[<>=]*$/.test(w)) {
          w += JSON.stringify(readQuoted()); // keep quoting so the field parser knows it was a phrase
          continue;
        }
        w += src[i++];
      }
      if (w === "AND") out.push({ k: "and", v: w, at });
      else if (w === "OR") out.push({ k: "or", v: w, at });
      else if (w === "NOT") out.push({ k: "not", v: w, at });
      else out.push({ k: "word", v: w, at });
    }
  }
  return out;
}

// ---------- parser ----------
const FIELD_RE = /^@?([A-Za-z_][\w.-]*):(>=|<=|>|<|=)?(.*)$/;

function parseTokens(toks: Tok[]): Node | null {
  let p = 0;
  const peek = () => toks[p];
  const fail = (msg: string, at = peek()?.at ?? -1): never => {
    throw Object.assign(new Error(msg), { at });
  };

  function primary(): Node {
    const t = toks[p++];
    if (!t) return fail("expected a term");
    if (t.k === "lp") {
      const n = orExpr();
      if (peek()?.k !== "rp") fail("missing )");
      p++;
      return n;
    }
    if (t.k === "phrase") return { t: "text", v: t.v, phrase: true };
    if (t.k === "re") {
      try {
        return { t: "re", re: new RegExp(t.v, t.flags) };
      } catch (e) {
        return fail(`bad regex: ${(e as Error).message}`, t.at);
      }
    }
    if (t.k === "word") {
      const m = FIELD_RE.exec(t.v);
      if (m && m[3] !== "") {
        let raw = m[3];
        if (raw.startsWith('"')) raw = JSON.parse(raw);
        const range = /^(-?\d+(?:\.\d+)?)\.\.(-?\d+(?:\.\d+)?)$/.exec(raw);
        if (range) return { t: "field", key: m[1].toLowerCase(), op: ">=", v: range[1], hi: range[2] };
        return { t: "field", key: m[1].toLowerCase(), op: (m[2] as "=" | undefined) ?? "=", v: raw };
      }
      return { t: "text", v: t.v, phrase: false };
    }
    return fail(`unexpected ${t.v}`, t.at);
  }
  function unary(): Node {
    const t = peek();
    if (t && (t.k === "neg" || t.k === "not")) {
      p++;
      return { t: "not", a: unary() };
    }
    return primary();
  }
  function andExpr(): Node {
    let n = unary();
    for (;;) {
      const t = peek();
      if (!t || t.k === "or" || t.k === "rp") return n;
      if (t.k === "and") p++;
      n = { t: "and", a: n, b: unary() };
    }
  }
  function orExpr(): Node {
    let n = andExpr();
    while (peek()?.k === "or") {
      p++;
      n = { t: "or", a: n, b: andExpr() };
    }
    return n;
  }
  if (!toks.length) return null;
  const n = orExpr();
  if (p < toks.length) fail(`unexpected ${toks[p].v}`, toks[p].at);
  return n;
}

// ---------- field extraction ----------
const LEVELS: Record<string, number> = { trace: 1, debug: 2, info: 3, warn: 4, warning: 4, error: 5, err: 5, fatal: 6, panic: 6 };
const ALIASES: Record<string, string[]> = {
  status: ["statusCode", "status", "httpStatus", "code"],
  httpstatus: ["statusCode", "status", "httpStatus"],
  path: ["url", "uri", "path"],
  url: ["url", "uri", "path"],
  method: ["method"],
  duration: ["responseTime", "took", "duration", "durationMs", "totalDuration", "elapsed"],
  responsetime: ["responseTime", "took", "duration"],
  msg: ["msg", "message"],
  message: ["msg", "message"],
  host: ["host", "hostname"],
  requestid: ["reqId", "requestId", "request_id"],
};
const extractors = new Map<string, RegExp[]>();
function extractorsFor(key: string): RegExp[] {
  let r = extractors.get(key);
  if (!r) {
    const last = key.split(".").pop()!;
    const names = [...new Set([...(ALIASES[last] ?? []), last])];
    const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    r = names.flatMap((n) => [
      new RegExp(`"${esc(n)}"\\s*:\\s*(?:"((?:[^"\\\\]|\\\\.)*)"|(-?\\d+(?:\\.\\d+)?)|(true|false|null))`, "i"),
      new RegExp(`(?:^|\\s)${esc(n)}=(?:"((?:[^"\\\\]|\\\\.)*)"|(\\S+))`, "i"),
    ]);
    extractors.set(key, r);
  }
  return r;
}
function extract(msg: string, key: string): string | undefined {
  for (const re of extractorsFor(key)) {
    const m = re.exec(msg);
    if (m) return m[1] ?? m[2] ?? m[3];
  }
  return undefined;
}
function toNumber(v: string): number {
  const m = /^(-?\d+(?:\.\d+)?)(ms|s|m)?$/i.exec(v.trim());
  if (!m) return NaN;
  const n = Number(m[1]);
  const u = m[2]?.toLowerCase();
  return u === "s" ? n * 1000 : u === "m" ? n * 60_000 : n;
}
const wildcard = (v: string) => new RegExp(`^${v.split("*").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`, "i");
const compare = (a: number, op: string, b: number) => (op === ">" ? a > b : op === ">=" ? a >= b : op === "<" ? a < b : op === "<=" ? a <= b : a === b);

function fieldTest(n: Extract<Node, { t: "field" }>): (l: LineCtx) => boolean {
  const { key, op, v, hi } = n;
  if (key === "level") {
    const want = LEVELS[v.toLowerCase()] ?? Number(v);
    if (!Number.isFinite(want)) throw Object.assign(new Error(`unknown level "${v}"`), { at: -1 });
    return (l) => l.level !== 0 && compare(l.level, op, want);
  }
  if (key === "service" || key === "stream" || key === "task") {
    const re = v.includes("*") ? wildcard(v) : null;
    const lv = v.toLowerCase();
    return (l) => (re ? re.test(l.stream) : l.stream.toLowerCase().includes(lv));
  }
  const numeric = op !== "=" || hi !== undefined;
  const target = Number(v);
  const re = v.includes("*") ? wildcard(v) : null;
  return (l) => {
    const got = extract(l.msg, key);
    if (got === undefined) return false;
    if (numeric) {
      const x = toNumber(got);
      if (!Number.isFinite(x)) return false;
      return hi !== undefined ? x >= target && x <= Number(hi) : compare(x, op, target);
    }
    if (re) return re.test(got);
    if (Number.isFinite(target) && v.trim() !== "" && Number.isFinite(toNumber(got))) return toNumber(got) === target;
    return got.toLowerCase() === v.toLowerCase();
  };
}

function build(n: Node): (l: LineCtx) => boolean {
  switch (n.t) {
    case "and": {
      const a = build(n.a), b = build(n.b);
      return (l) => a(l) && b(l);
    }
    case "or": {
      const a = build(n.a), b = build(n.b);
      return (l) => a(l) || b(l);
    }
    case "not": {
      const a = build(n.a);
      return (l) => !a(l);
    }
    case "re":
      return (l) => {
        n.re.lastIndex = 0;
        return n.re.test(l.msg);
      };
    case "text": {
      if (!n.phrase && n.v.includes("*")) {
        const re = new RegExp(n.v.split("*").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*"), "i");
        return (l) => re.test(l.msg);
      }
      const lv = n.v.toLowerCase();
      return (l) => l.msg.toLowerCase().includes(lv);
    }
    case "field":
      return fieldTest(n);
  }
}

function collect(n: Node, neg: boolean, hl: string[], fields: string[]) {
  switch (n.t) {
    case "and":
    case "or":
      collect(n.a, neg, hl, fields);
      collect(n.b, neg, hl, fields);
      return;
    case "not":
      collect(n.a, !neg, hl, fields);
      return;
    case "field":
      fields.push(n.key);
      return;
    case "re":
      if (!neg) hl.push(n.re.source);
      return;
    case "text":
      if (!neg) hl.push(n.v.split("*").map((s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).filter(Boolean).join("|"));
  }
}

export function parseQuery(src: string): ParseResult {
  try {
    const node = parseTokens(tokenize(src));
    if (!node) return { ok: true, q: null };
    const hl: string[] = [];
    const fields: string[] = [];
    collect(node, false, hl, fields);
    const parts = hl.filter(Boolean);
    let highlight: RegExp | null = null;
    try {
      highlight = parts.length ? new RegExp(`(${parts.join("|")})`, "i") : null;
    } catch {
      highlight = null;
    }
    return { ok: true, q: { test: build(node), highlight, fields } };
  } catch (e) {
    return { ok: false, error: (e as Error).message, at: (e as { at?: number }).at ?? -1 };
  }
}

// Top values of a few common fields, for the facet sidebar. Sampled from the newest lines to stay cheap.
export const FACET_FIELDS = ["status", "method", "path"] as const;
const normPath = (p: string) =>
  p
    .split("?")[0]
    .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, ":uuid")
    .replace(/\/[0-9a-f]{24,}(?=\/|$)/gi, "/:id")
    .replace(/\/\d+(?=\/|$)/g, "/:n")
    .replace(/\/[A-Z]{2,}-\d+(?=\/|$)/g, "/:lot");

export function facetValue(msg: string, field: (typeof FACET_FIELDS)[number]): string | undefined {
  const v = extract(msg, field);
  if (v === undefined) return undefined;
  return field === "path" ? normPath(v) : field === "method" ? v.toUpperCase() : v;
}
