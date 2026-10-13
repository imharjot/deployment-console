// Notes people attach to any resource — what they changed, why, special traffic — keyed by the inventory's resource
// keys (`keys` in src/lib/inventory/types.ts), so the ECS panel, the cloud map, /notes and agents share one set.
// Validation is pure (../notes.ts); this file stores, searches and audits. Everyone signed in reads notes; writing
// needs `notes` (developer and up); only the author or an admin edits or deletes. Every write is audited — note id,
// key, tags and length, never the body — and refused when the audit intent can't be written.
import "server-only";
import type { Note } from "../inventory/types.ts";
import { NOTE_LIMITS, isNoteId, keyProblem, likePattern, parseNoteInput, parseNotePatch, parseSearch, sameAuthor, tagPattern } from "../notes.ts";
import { can, roleFor, type User } from "../rbac.ts";
import { writeAudit } from "./audit.ts";
import { getDb, newId } from "./db.ts";
import { HttpError, errText } from "./errors.ts";

interface Row {
  id: string;
  rkey: string;
  body: string;
  tags: string;
  pinned: number;
  author: string;
  created_at: number;
  updated_at: number;
  resource_name: string | null;
  env: string | null;
}

function tagsOf(s: string): string[] {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.filter((t): t is string => typeof t === "string") : [];
  } catch {
    return [];
  }
}

const toNote = (r: Row): Note => ({
  id: r.id,
  key: r.rkey,
  body: r.body,
  tags: tagsOf(r.tags),
  pinned: Number(r.pinned) === 1,
  author: r.author,
  createdAt: Number(r.created_at),
  updatedAt: Number(r.updated_at),
  ...(r.resource_name ? { resourceName: r.resource_name } : {}),
  ...(r.env ? { env: r.env } : {}),
});

// Who the audit log names (an operation passes `alice@x via token "bot"`; defaults to the user's email) and from where.
export interface Who {
  actor?: string;
  ip?: string;
}

function requireWrite(user: User) {
  if (!can(user, "notes")) throw new HttpError(403, `your role (${user.role}) can't write notes — needs ${roleFor("notes")}`);
}

function requireOwner(user: User, n: Note) {
  requireWrite(user);
  if (!sameAuthor(n.author, user.email) && !can(user, "admin")) throw new HttpError(403, "only the note's author or an admin can change or delete it");
}

const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

// Intent before the write, result after — like every other console write. The body is never logged: it may hold
// anything people paste (hostnames, customer names, the odd secret).
async function audited<T>(action: "note.create" | "note.update" | "note.delete", n: Note, params: Record<string, unknown>, user: User, who: Who, run: () => Promise<T>): Promise<T> {
  const base = { env: n.env ?? "", target: cut(n.resourceName || n.key, 300), action, user: who.actor ?? user.email, ip: who.ip, params: { note: n.id, key: n.key, ...params } };
  try {
    await writeAudit({ ...base, at: Date.now(), phase: "intent" });
  } catch (e) {
    throw new HttpError(503, `audit log unavailable, note not saved: ${errText(e)}`);
  }
  try {
    const out = await run();
    await writeAudit({ ...base, at: Date.now(), phase: "result", result: "ok" }).catch(() => {});
    return out;
  } catch (e) {
    await writeAudit({ ...base, at: Date.now(), phase: "result", result: "error", detail: e instanceof HttpError ? e.message : errText(e) }).catch(() => {});
    throw e;
  }
}

async function sizeOf(key: string): Promise<{ n: number; chars: number }> {
  const db = await getDb();
  const r = await db.get<{ n: number; chars: number }>("SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(body)), 0) AS chars FROM notes WHERE rkey = ?", [key]);
  return { n: Number(r?.n ?? 0), chars: Number(r?.chars ?? 0) };
}

const tooBig = () => new HttpError(409, `this resource's notes already hold ${NOTE_LIMITS.perResourceChars.toLocaleString("en-US")} characters — delete or shorten old ones first`);

// ---------- reads (anyone signed in) ----------

export async function getNote(id: string): Promise<Note | undefined> {
  if (!isNoteId(id)) return undefined;
  const db = await getDb();
  const r = await db.get<Row>("SELECT * FROM notes WHERE id = ?", [id]);
  return r ? toNote(r) : undefined;
}

// One resource's notes: pinned first, then newest.
export async function listNotes(key: string): Promise<Note[]> {
  const kp = keyProblem(key);
  if (kp) throw new HttpError(400, kp);
  const db = await getDb();
  const rows = await db.all<Row>("SELECT * FROM notes WHERE rkey = ? ORDER BY pinned DESC, created_at DESC LIMIT ?", [key, NOTE_LIMITS.perResource]);
  return rows.map(toNote);
}

// Across resources, most recently written first. `q` matches the body, the resource's name and key and the tags
// (case-insensitive for ASCII on SQLite, fully on Postgres); `tag` is a whole-tag match; `env` an exact match.
export async function searchNotes(raw: { q?: unknown; tag?: unknown; env?: unknown; limit?: unknown }): Promise<Note[]> {
  const p = parseSearch(raw);
  if (!p.ok) throw new HttpError(400, p.error);
  const { q, tag, env, limit } = p.value;
  const where: string[] = [];
  const args: unknown[] = [];
  if (q) {
    const like = likePattern(q);
    where.push("(LOWER(body) LIKE LOWER(?) ESCAPE '\\' OR LOWER(COALESCE(resource_name, '')) LIKE LOWER(?) ESCAPE '\\' OR LOWER(rkey) LIKE LOWER(?) ESCAPE '\\' OR tags LIKE LOWER(?) ESCAPE '\\')");
    args.push(like, like, like, like);
  }
  if (tag) {
    where.push("tags LIKE ? ESCAPE '\\'");
    args.push(tagPattern(tag));
  }
  if (env) {
    where.push("env = ?");
    args.push(env);
  }
  const db = await getDb();
  const rows = await db.all<Row>(`SELECT * FROM notes${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY updated_at DESC LIMIT ?`, [...args, limit]);
  return rows.map(toNote);
}

// Tags in use, most used first — suggestions for the tag input and the /notes filter.
export async function noteTags(): Promise<{ tag: string; count: number }[]> {
  const db = await getDb();
  const rows = await db.all<{ tags: string }>("SELECT tags FROM notes ORDER BY updated_at DESC LIMIT 5000");
  const counts = new Map<string, number>();
  for (const r of rows) for (const t of tagsOf(r.tags)) counts.set(t, (counts.get(t) ?? 0) + 1);
  return [...counts]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || (a.tag < b.tag ? -1 : 1))
    .slice(0, 100);
}

// Number of notes per resource key, for the map's badges. Never throws: badges are not worth failing a map for.
export async function noteCounts(): Promise<Record<string, number>> {
  try {
    const db = await getDb();
    const rows = await db.all<{ rkey: string; n: number }>("SELECT rkey, COUNT(*) AS n FROM notes GROUP BY rkey");
    return Object.fromEntries(rows.map((r) => [r.rkey, Number(r.n)]));
  } catch (e) {
    console.error(JSON.stringify({ level: 40, msg: "note counts unavailable", err: errText(e) }));
    return {};
  }
}

// ---------- writes ----------

export async function createNote(user: User, raw: unknown, who: Who = {}): Promise<Note> {
  requireWrite(user);
  const p = parseNoteInput(raw);
  if (!p.ok) throw new HttpError(400, p.error);
  const v = p.value;
  const db = await getDb();
  const [here, all] = await Promise.all([sizeOf(v.key), db.get<{ n: number }>("SELECT COUNT(*) AS n FROM notes")]);
  if (here.n >= NOTE_LIMITS.perResource) throw new HttpError(409, `this resource already has ${NOTE_LIMITS.perResource} notes — delete old ones first`);
  if (here.chars + v.body.length > NOTE_LIMITS.perResourceChars) throw tooBig();
  if (Number(all?.n ?? 0) >= NOTE_LIMITS.total) throw new HttpError(409, `the console already holds ${NOTE_LIMITS.total.toLocaleString("en-US")} notes — delete old ones first`);
  const now = Date.now();
  const note: Note = { id: newId(), key: v.key, body: v.body, tags: v.tags, pinned: v.pinned, author: who?.actor ?? user.email, createdAt: now, updatedAt: now, ...(v.resourceName ? { resourceName: v.resourceName } : {}), ...(v.env ? { env: v.env } : {}) };
  await audited("note.create", note, { tags: note.tags, length: note.body.length, pinned: note.pinned }, user, who, () =>
    db.run("INSERT INTO notes (id, rkey, body, tags, pinned, author, created_at, updated_at, resource_name, env) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [
      note.id, note.key, note.body, JSON.stringify(note.tags), note.pinned ? 1 : 0, note.author, note.createdAt, note.updatedAt, note.resourceName ?? null, note.env ?? null,
    ]),
  );
  return note;
}

// Editing the body or tags marks the note edited (updatedAt); pinning alone doesn't. A change to nothing is a no-op.
export async function updateNote(user: User, id: string, raw: unknown, who: Who = {}): Promise<Note> {
  requireWrite(user);
  const p = parseNotePatch(raw);
  if (!p.ok) throw new HttpError(400, p.error);
  const cur = await getNote(id);
  if (!cur) throw new HttpError(404, "no such note");
  requireOwner(user, cur);
  const patch = p.value;
  const body = patch.body ?? cur.body;
  const tags = patch.tags ?? cur.tags;
  const pinned = patch.pinned ?? cur.pinned;
  const changed = [...(body !== cur.body ? ["body"] : []), ...(tags.join() !== cur.tags.join() ? ["tags"] : []), ...(pinned !== cur.pinned ? ["pinned"] : [])];
  if (!changed.length) return cur;
  if (body.length > cur.body.length && (await sizeOf(cur.key)).chars - cur.body.length + body.length > NOTE_LIMITS.perResourceChars) throw tooBig();
  const edited = changed.includes("body") || changed.includes("tags");
  const next: Note = { ...cur, body, tags, pinned, updatedAt: edited ? Math.max(Date.now(), cur.createdAt + 1) : cur.updatedAt };
  const db = await getDb();
  await audited("note.update", next, { changed, tags: next.tags, length: next.body.length, pinned: next.pinned }, user, who, async () => {
    const n = await db.run("UPDATE notes SET body = ?, tags = ?, pinned = ?, updated_at = ? WHERE id = ?", [next.body, JSON.stringify(next.tags), next.pinned ? 1 : 0, next.updatedAt, id]);
    if (!n) throw new HttpError(404, "no such note (deleted meanwhile)");
  });
  return next;
}

export async function deleteNote(user: User, id: string, who: Who = {}): Promise<{ id: string }> {
  requireWrite(user);
  const cur = await getNote(id);
  if (!cur) throw new HttpError(404, "no such note");
  requireOwner(user, cur);
  const db = await getDb();
  await audited("note.delete", cur, { tags: cur.tags, length: cur.body.length }, user, who, async () => {
    const n = await db.run("DELETE FROM notes WHERE id = ?", [id]);
    if (!n) throw new HttpError(404, "no such note (deleted meanwhile)");
  });
  return { id };
}
