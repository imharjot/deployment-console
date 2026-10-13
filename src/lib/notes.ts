// Notes on resources — the pure half: input validation, search patterns, safe rendering (plain text plus http(s)
// links, nothing else interpreted) and where a note's resource opens. Shared by the server (src/lib/server/notes.ts),
// the operations, the UI (src/components/notes.tsx, /notes) and the tests, so browser and server agree on what is valid.
import { keys, type Note } from "./inventory/types.ts";

export const NOTE_LIMITS = {
  body: 10_000, // characters after trimming (UTF-16 units, like a textarea's maxLength)
  tags: 10,
  key: 512,
  resourceName: 200,
  perResource: 500, // notes on one resource
  perResourceChars: 1_000_000, // body characters on one resource, all notes together
  total: 50_000, // notes in the whole console
  search: 200, // longest search text
  searchResults: 200,
} as const;

// Lower-case letters, digits and dashes, 1–32 characters, starting with a letter or digit ("traffic", "incident-42").
export const TAG_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const ENV_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONTROL = /[\u0000-\u001f\u007f]/;

export type Checked<T> = { ok: true; value: T } | { ok: false; error: string };
const ok = <T,>(value: T): Checked<T> => ({ ok: true, value });
const bad = <T,>(error: string): Checked<T> => ({ ok: false, error });
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
const fmt = (n: number) => n.toLocaleString("en-US");

export const isNoteId = (v: unknown): v is string => typeof v === "string" && ID_RE.test(v);

// ---------- resource keys ----------

// Every key the inventory hands out (see `keys` in ./inventory/types.ts): an ARN, or one of the console's prefixes
// for resources AWS gives no ARN (or whose ARN needs the account id).
export const KEY_PREFIXES = ["ecs:", "elb:", "rds:", "elasticache:", "ec2:", "eks:", "external:", "cloudflare:"] as const;
const ARN_RE = /^arn:aws(?:-[a-z]+)*:[a-z0-9-]+:[a-z0-9-]*:[a-z0-9-]*:\S/;

export function keyProblem(v: unknown): string | undefined {
  if (typeof v !== "string" || !v) return "key is required";
  if (v.length > NOTE_LIMITS.key) return `key must be at most ${NOTE_LIMITS.key} characters`;
  if (v !== v.trim() || CONTROL.test(v)) return "key can't contain line breaks, control characters or surrounding spaces";
  if (ARN_RE.test(v)) return undefined;
  const p = KEY_PREFIXES.find((x) => v.startsWith(x));
  if (p && v.length > p.length) return undefined;
  return `key must be a resource key: an ARN (arn:aws:…) or one starting with ${KEY_PREFIXES.join(" ")}`;
}

// ---------- input ----------

// \r\n and \r become \n; other control characters are dropped (NUL breaks Postgres TEXT); tabs and line breaks stay.
export const cleanBody = (v: string) => v.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim();
const cleanLine = (v: string) => v.replace(/[\u0000-\u001f\u007f]/g, " ").trim();

export const normalizeTag = (v: string) => v.trim().toLowerCase().replace(/^#/, "");

export function parseBody(v: unknown): Checked<string> {
  if (typeof v !== "string") return bad("body must be text");
  if (v.length > NOTE_LIMITS.body * 2) return bad(`a note is at most ${fmt(NOTE_LIMITS.body)} characters`);
  const b = cleanBody(v);
  if (!b) return bad("the note is empty — write something first");
  if (b.length > NOTE_LIMITS.body) return bad(`a note is at most ${fmt(NOTE_LIMITS.body)} characters (this one has ${fmt(b.length)})`);
  return ok(b);
}

// Lower-cased, trimmed, a leading # dropped, duplicates removed (first spelling wins).
export function parseTags(v: unknown): Checked<string[]> {
  if (v === undefined || v === null) return ok([]);
  if (!Array.isArray(v) || v.length > 50) return bad(`tags must be a list of at most ${NOTE_LIMITS.tags} short labels`);
  const out: string[] = [];
  for (const t of v) {
    if (typeof t !== "string") return bad("tags must be a list of strings");
    const n = normalizeTag(t);
    if (!TAG_RE.test(n)) return bad(`tag "${cut(t, 40)}" must be 1–32 lower-case letters, digits or dashes, starting with a letter or digit`);
    if (!out.includes(n)) out.push(n);
  }
  if (out.length > NOTE_LIMITS.tags) return bad(`at most ${NOTE_LIMITS.tags} tags`);
  return ok(out);
}

export interface NoteInput {
  key: string;
  body: string;
  tags: string[];
  pinned: boolean;
  resourceName?: string;
  env?: string;
}
export interface NotePatch {
  body?: string;
  tags?: string[];
  pinned?: boolean;
}

// Plain objects from JSON only; own properties only (a "__proto__" key is just an unknown field).
function fieldsOf(raw: unknown, allowed: readonly string[]): Checked<(k: string) => unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return bad("body must be a JSON object");
  const o = raw as Record<string, unknown>;
  const extra = Object.keys(o).filter((k) => !allowed.includes(k));
  if (extra.length) return bad(`unknown field(s): ${extra.slice(0, 5).map((k) => cut(k, 40)).join(", ")} — allowed: ${allowed.join(", ")}`);
  return ok((k: string) => (Object.hasOwn(o, k) ? o[k] : undefined));
}

export function parseNoteInput(raw: unknown): Checked<NoteInput> {
  const f = fieldsOf(raw, ["key", "body", "tags", "pinned", "resourceName", "env"]);
  if (!f.ok) return f;
  const get = f.value;
  const kp = keyProblem(get("key"));
  if (kp) return bad(kp);
  const body = parseBody(get("body"));
  if (!body.ok) return body;
  const tags = parseTags(get("tags"));
  if (!tags.ok) return tags;
  const pinned = get("pinned");
  if (pinned !== undefined && typeof pinned !== "boolean") return bad("pinned must be true or false");
  const rn = get("resourceName");
  if (rn !== undefined && rn !== null && typeof rn !== "string") return bad("resourceName must be text");
  const resourceName = typeof rn === "string" ? cleanLine(rn) : "";
  if (resourceName.length > NOTE_LIMITS.resourceName) return bad(`resourceName must be at most ${NOTE_LIMITS.resourceName} characters`);
  const env = get("env");
  if (env !== undefined && env !== null && env !== "" && (typeof env !== "string" || !ENV_RE.test(env))) return bad("env must be an environment id (letters, digits, . _ -)");
  return ok({
    key: get("key") as string,
    body: body.value,
    tags: tags.value,
    pinned: pinned === true,
    ...(resourceName ? { resourceName } : {}),
    ...(typeof env === "string" && env ? { env } : {}),
  });
}

export function parseNotePatch(raw: unknown): Checked<NotePatch> {
  const f = fieldsOf(raw, ["body", "tags", "pinned"]);
  if (!f.ok) return f;
  const get = f.value;
  const out: NotePatch = {};
  if (get("body") !== undefined) {
    const b = parseBody(get("body"));
    if (!b.ok) return b;
    out.body = b.value;
  }
  if (get("tags") !== undefined) {
    const t = parseTags(get("tags"));
    if (!t.ok) return t;
    out.tags = t.value;
  }
  const pinned = get("pinned");
  if (pinned !== undefined) {
    if (typeof pinned !== "boolean") return bad("pinned must be true or false");
    out.pinned = pinned;
  }
  if (!Object.keys(out).length) return bad("nothing to change — send body, tags or pinned");
  return ok(out);
}

// ---------- search ----------

export interface NoteSearch {
  q?: string;
  tag?: string;
  env?: string;
  limit: number;
}

// From query-string values or an operation's input. A malformed limit is clamped, not refused (like /api/audit).
export function parseSearch(p: { q?: unknown; tag?: unknown; env?: unknown; limit?: unknown }): Checked<NoteSearch> {
  const out: NoteSearch = { limit: 50 };
  if (p.q !== undefined && p.q !== null) {
    if (typeof p.q !== "string") return bad("q must be text");
    const q = cleanLine(p.q);
    if (q.length > NOTE_LIMITS.search) return bad(`search text is at most ${NOTE_LIMITS.search} characters`);
    if (q) out.q = q;
  }
  if (p.tag !== undefined && p.tag !== null && p.tag !== "") {
    const t = typeof p.tag === "string" ? normalizeTag(p.tag) : "";
    if (!TAG_RE.test(t)) return bad("tag must be 1–32 lower-case letters, digits or dashes");
    out.tag = t;
  }
  if (p.env !== undefined && p.env !== null && p.env !== "") {
    if (typeof p.env !== "string" || !ENV_RE.test(p.env)) return bad("env must be an environment id");
    out.env = p.env;
  }
  const n = typeof p.limit === "number" ? p.limit : typeof p.limit === "string" && p.limit ? Number(p.limit) : NaN;
  if (Number.isFinite(n)) out.limit = Math.min(NOTE_LIMITS.searchResults, Math.max(1, Math.floor(n)));
  return ok(out);
}

// A LIKE pattern matching `s` anywhere, with the wildcards escaped; use with ESCAPE '\'.
export const likePattern = (s: string) => `%${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
// Tags are stored as a JSON array; a validated tag has no LIKE wildcards, and the quotes make it a whole-tag match.
export const tagPattern = (tag: string) => likePattern(`"${tag}"`);

// ---------- presentation ----------

export const sameAuthor = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
export const isEdited = (n: Pick<Note, "createdAt" | "updatedAt">) => n.updatedAt > n.createdAt;

// Pinned first, then newest — the order of a resource's notes everywhere.
export const sortNotes = <T extends Pick<Note, "pinned" | "createdAt" | "id">>(list: T[]): T[] =>
  [...list].sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.createdAt - a.createdAt || (a.id < b.id ? -1 : 1));

// Suggestions for the tag input: prefix matches first, then substring matches, most used first; never ones chosen.
export function suggestTags(all: { tag: string; count: number }[], typed: string, chosen: string[], n = 8): string[] {
  const t = normalizeTag(typed);
  const pool = all.filter((x) => !chosen.includes(x.tag));
  const rank = (x: { tag: string }) => (!t ? 0 : x.tag.startsWith(t) ? 0 : x.tag.includes(t) ? 1 : 2);
  return pool
    .filter((x) => rank(x) < 2)
    .sort((a, b) => rank(a) - rank(b) || b.count - a.count || (a.tag < b.tag ? -1 : 1))
    .slice(0, n)
    .map((x) => x.tag);
}

// ---------- safe rendering ----------

// A note renders as text; only http(s) URLs become links. Anything else — HTML, markdown, javascript:/data: URLs —
// stays literal text, and React escapes it.
export interface Segment {
  text: string;
  href?: string; // http: or https: only, normalised by the URL parser
}

// A URL runs until whitespace, a control/format character or a delimiter that can't be part of a pasted URL.
const URL_RE = /\bhttps?:\/\/[^\s<>"'`\u0000-\u001f\u007f\u00a0\u2000-\u200f\u2028-\u202f\u2066-\u2069\ufeff]+/gi;
const MAX_URL = 2048;
const CLOSE: Record<string, string> = { ")": "(", "]": "[", "}": "{" };

// Drops trailing punctuation ("see https://x.io.") and closing brackets that don't belong to the URL
// ("(https://x.io)"), keeping balanced ones ("https://en.wikipedia.org/wiki/Foo_(bar)").
function trimUrl(u: string): string {
  let s = u;
  while (s) {
    const last = s[s.length - 1];
    if (".,;:!?*".includes(last)) s = s.slice(0, -1);
    else if (Object.hasOwn(CLOSE, last) && s.split(last).length > s.split(CLOSE[last]).length) s = s.slice(0, -1);
    else break;
  }
  return s;
}

export function safeHref(raw: string): string | undefined {
  if (raw.length > MAX_URL) return undefined;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return undefined;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return undefined;
  if (!u.hostname || u.username || u.password) return undefined; // user@host links are a phishing trick
  return u.href;
}

export function linkify(text: string): Segment[] {
  const out: Segment[] = [];
  const push = (s: Segment) => {
    if (!s.text) return;
    const prev = out[out.length - 1];
    if (!s.href && prev && !prev.href) prev.text += s.text;
    else out.push(s);
  };
  let at = 0;
  for (const m of text.matchAll(URL_RE)) {
    const start = m.index;
    const url = trimUrl(m[0]);
    const href = safeHref(url);
    push({ text: text.slice(at, start) });
    if (href) push({ text: url, href });
    else push({ text: url });
    at = start + url.length;
  }
  push({ text: text.slice(at) });
  return out;
}

// ---------- where a resource opens ----------

// The ECS resource panel's views (src/lib/server/console.ts) → the key notes use for them: the inventory key, which
// carries "@<region>" outside the home region (CC-6) when both are given.
export function ecsNoteTarget(
  r: { kind: string; id: string; name: string; subtitle: string }, cluster?: string, region?: string, home?: string,
): { key: string; name: string } | undefined {
  if (!r.id || r.id === "?") return undefined; // placeholder views for an unreadable list
  switch (r.kind) {
    case "service":
      return cluster ? { key: keys.ecsService(cluster, r.id, region, home), name: r.name || r.id } : undefined;
    case "loadbalancer":
      return r.subtitle ? { key: keys.loadBalancer(r.subtitle, region, home), name: r.subtitle } : undefined;
    case "database":
      return { key: keys.rds(r.id, region, home), name: r.id };
    case "cache":
      return { key: keys.elasticache(r.id, region, home), name: r.id };
    case "box":
      return { key: keys.ec2(r.id, region, home), name: r.name || r.id };
    default:
      return undefined;
  }
}

// Resources the ECS overview shows open there (its `r` parameter); everything else on the cloud map.
const OVERVIEW: [RegExp, (m: RegExpExecArray) => string][] = [
  [/^ecs:service\/[^/]+\/(.+)$/, (m) => `service:${m[1]}`],
  [/^elb:.+$/, () => "loadbalancer:alb"],
  [/^rds:(.+)$/, (m) => `database:${m[1]}`],
  [/^elasticache:(.+)$/, (m) => `cache:${m[1]}`],
  [/^ec2:(.+)$/, (m) => `box:${m[1]}`],
];

export const mapHref = (key: string) => `/map?r=${encodeURIComponent(key)}`;

export function resourceHref(n: Pick<Note, "key" | "env">): string {
  if (n.env)
    for (const [re, view] of OVERVIEW) {
      const m = re.exec(n.key);
      if (m) return `/?env=${encodeURIComponent(n.env)}&r=${encodeURIComponent(view(m))}`;
    }
  return mapHref(n.key);
}
