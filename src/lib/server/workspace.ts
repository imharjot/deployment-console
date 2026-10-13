// The rest of a person's workspace (docs/dashboards.md): pinned resources, saved views and log queries, and
// preferences such as the home page. Rules are pure (../dashboards.ts); tables from migration 6. People only.
//
// Pins and preferences are personal and never audited. A saved item is private or shared with the team: sharing one
// (creating it shared, changing its visibility, deleting a shared one) is audited in the same transaction as the
// change, like dashboards. Limits: 200 pins and 200 saved items per person.
import "server-only";
import {
  WORKSPACE_LIMITS, canEditSaved, canViewSaved, isPrefKey, isSavedKind, isVisibility, isWorkspaceId, parsePin, parsePrefsPatch, parseSavedInput, parseSavedPatch,
  type Pin, type Prefs, type SavedItem, type SavedKind, type SavedPayload, type Visibility,
} from "../dashboards.ts";
import type { User } from "../rbac.ts";
import { WorkspaceInputError, visibleDashboard, withShareAudit, type ShareChange, type Who } from "./dashboards.ts";
import { getDb, newId } from "./db.ts";
import { HttpError } from "./errors.ts";

// ---------- pins ----------

interface PinRow {
  rkey: string;
  name: string;
  kind: string;
  env: string | null;
  region: string | null;
  created_at: number;
}

const toPin = (r: PinRow): Pin => ({ rkey: r.rkey, name: r.name, kind: r.kind, ...(r.env ? { env: r.env } : {}), ...(r.region ? { region: r.region } : {}), createdAt: Number(r.created_at) });

// Newest first.
export async function listPins(user: User): Promise<Pin[]> {
  const db = await getDb();
  const rows = await db.all<PinRow>("SELECT rkey, name, kind, env, region, created_at FROM pins WHERE user_id = ? ORDER BY created_at DESC, rkey LIMIT ?", [user.id, WORKSPACE_LIMITS.pinsPerUser]);
  return rows.map(toPin);
}

// Pinning something already pinned refreshes its name, kind, env and region and keeps its place.
export async function addPin(user: User, raw: unknown): Promise<Pin> {
  const p = parsePin(raw);
  if (!p.ok) throw new WorkspaceInputError(p.error, p.problems);
  const v = p.value;
  const db = await getDb();
  await db.tx(async (t) => {
    const n = await t.get<{ n: number }>("SELECT COUNT(*) AS n FROM pins WHERE user_id = ? AND rkey <> ?", [user.id, v.rkey]);
    if (Number(n?.n ?? 0) >= WORKSPACE_LIMITS.pinsPerUser) throw new HttpError(409, `you already have ${WORKSPACE_LIMITS.pinsPerUser} pins — unpin something first`);
    await t.run(
      `INSERT INTO pins (user_id, rkey, name, kind, env, region, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (user_id, rkey) DO UPDATE SET name = excluded.name, kind = excluded.kind, env = excluded.env, region = excluded.region`,
      [user.id, v.rkey, v.name, v.kind, v.env ?? null, v.region ?? null, Date.now()],
    );
  });
  const row = await db.get<PinRow>("SELECT rkey, name, kind, env, region, created_at FROM pins WHERE user_id = ? AND rkey = ?", [user.id, v.rkey]);
  return toPin(row!);
}

// Unpinning something not pinned is not an error (two tabs, a double click).
export async function removePin(user: User, rkey: unknown): Promise<{ rkey: string; removed: boolean }> {
  if (typeof rkey !== "string" || !rkey || rkey.length > 512) throw new HttpError(400, "rkey: the pinned resource's key");
  const db = await getDb();
  const n = await db.run("DELETE FROM pins WHERE user_id = ? AND rkey = ?", [user.id, rkey]);
  return { rkey, removed: n > 0 };
}

// ---------- saved views and log queries ----------

interface SavedRow {
  id: string;
  owner_id: string;
  kind: string;
  name: string;
  payload: string;
  visibility: string;
  created_at: number;
  updated_at: number;
  owner_email: string | null;
}

const SELECT_SAVED = "SELECT s.*, u.email AS owner_email FROM saved_items s LEFT JOIN users u ON u.id = s.owner_id";
const visOf = (v: string): Visibility => (isVisibility(v) ? v : "private");
const shareOf = (r: SavedRow) => ({ ownerId: r.owner_id, visibility: visOf(r.visibility) });

function payloadOf(s: string): SavedPayload | undefined {
  try {
    const v = JSON.parse(s);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as SavedPayload) : undefined;
  } catch {
    return undefined;
  }
}

function toSaved(r: SavedRow, user: User): SavedItem | undefined {
  const payload = payloadOf(r.payload);
  if (!payload || !isSavedKind(r.kind)) return undefined;
  return {
    id: r.id,
    kind: r.kind,
    name: r.name,
    payload,
    visibility: visOf(r.visibility),
    owner: { id: r.owner_id, ...(r.owner_email ? { email: r.owner_email } : {}) },
    mine: r.owner_id === user.id,
    canEdit: canEditSaved(user, shareOf(r)),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

const savedNotFound = () => new HttpError(404, "no such saved item (or it isn't shared with you)");

async function visibleSaved(user: User, id: string): Promise<SavedRow> {
  if (!isWorkspaceId(id)) throw savedNotFound();
  const r = await (await getDb()).get<SavedRow>(`${SELECT_SAVED} WHERE s.id = ?`, [id]);
  if (!r || !canViewSaved(user, shareOf(r))) throw savedNotFound();
  return r;
}

function editableSaved(user: User, r: SavedRow): SavedRow {
  if (!canEditSaved(user, shareOf(r))) throw new HttpError(403, "only its owner (or an admin, for an item shared with the team) can change it");
  return r;
}

// The person's own items and those shared with the team, newest change first; `kind` narrows to views or log queries.
export async function listSaved(user: User, kind?: unknown): Promise<SavedItem[]> {
  if (kind !== undefined && kind !== null && kind !== "" && !isSavedKind(kind)) throw new HttpError(400, "kind: view or log-query");
  const db = await getDb();
  const rows = isSavedKind(kind)
    ? await db.all<SavedRow>(`${SELECT_SAVED} WHERE (s.owner_id = ? OR s.visibility = 'team') AND s.kind = ? ORDER BY s.updated_at DESC LIMIT 1000`, [user.id, kind])
    : await db.all<SavedRow>(`${SELECT_SAVED} WHERE s.owner_id = ? OR s.visibility = 'team' ORDER BY s.updated_at DESC LIMIT 1000`, [user.id]);
  return rows.map((r) => toSaved(r, user)).filter((x): x is SavedItem => !!x);
}

export async function getSaved(user: User, id: string): Promise<SavedItem> {
  const item = toSaved(await visibleSaved(user, id), user);
  if (!item) throw savedNotFound();
  return item;
}

const savedShare = (id: string, kind: SavedKind, name: string, from: Visibility | null, to: Visibility): ShareChange => ({ action: "saved.share", target: name, params: { saved: id, kind, from, to } });

export async function createSaved(user: User, raw: unknown, who: Who = {}): Promise<SavedItem> {
  const p = parseSavedInput(raw);
  if (!p.ok) throw new WorkspaceInputError(p.error, p.problems);
  const v = p.value;
  const id = newId();
  const now = Date.now();
  await withShareAudit(user, who, v.visibility === "team" ? savedShare(id, v.kind, v.name, null, "team") : undefined, async (t) => {
    const n = await t.get<{ n: number }>("SELECT COUNT(*) AS n FROM saved_items WHERE owner_id = ?", [user.id]);
    if (Number(n?.n ?? 0) >= WORKSPACE_LIMITS.savedPerUser) throw new HttpError(409, `you already have ${WORKSPACE_LIMITS.savedPerUser} saved views and queries — delete one first`);
    await t.run("INSERT INTO saved_items (id, owner_id, kind, name, payload, visibility, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [
      id, user.id, v.kind, v.name, JSON.stringify(v.payload), v.visibility, now, now,
    ]);
  });
  return getSaved(user, id);
}

// PATCH { name?, payload?, visibility? }.
export async function updateSaved(user: User, id: string, raw: unknown, who: Who = {}): Promise<SavedItem> {
  const r = editableSaved(user, await visibleSaved(user, id));
  if (!isSavedKind(r.kind)) throw savedNotFound();
  const p = parseSavedPatch(r.kind, raw);
  if (!p.ok) throw new WorkspaceInputError(p.error, p.problems);
  const v = p.value;
  const from = visOf(r.visibility);
  const to = v.visibility ?? from;
  const name = v.name ?? r.name;
  await withShareAudit(user, who, to !== from ? savedShare(id, r.kind, name, from, to) : undefined, async (t) => {
    const n = await t.run("UPDATE saved_items SET name = ?, payload = ?, visibility = ?, updated_at = ? WHERE id = ?", [
      name, v.payload ? JSON.stringify(v.payload) : r.payload, to, Math.max(Date.now(), Number(r.updated_at) + 1), id,
    ]);
    if (!n) throw savedNotFound();
  });
  // Echo the result even when the change hid it from the caller (an admin making someone's shared item private).
  const row = await (await getDb()).get<SavedRow>(`${SELECT_SAVED} WHERE s.id = ?`, [id]);
  const item = row && toSaved(row, user);
  if (!item) throw savedNotFound();
  return item;
}

export async function deleteSaved(user: User, id: string, who: Who = {}): Promise<{ id: string }> {
  const r = editableSaved(user, await visibleSaved(user, id));
  const share: ShareChange | undefined = visOf(r.visibility) === "team" ? { action: "saved.delete", target: r.name, params: { saved: id, kind: r.kind, from: "team" } } : undefined;
  await withShareAudit(user, who, share, async (t) => {
    const n = await t.run("DELETE FROM saved_items WHERE id = ?", [id]);
    if (!n) throw savedNotFound();
  });
  return { id };
}

// ---------- preferences ----------

export async function getPrefs(user: User): Promise<Prefs> {
  const db = await getDb();
  const rows = await db.all<{ key: string; value: string }>("SELECT key, value FROM user_prefs WHERE user_id = ?", [user.id]);
  const out: Prefs = {};
  for (const r of rows) if (isPrefKey(r.key)) out[r.key] = r.value;
  return out;
}

// PATCH { home?, region?, "dashboards.lastOpened"? }: allow-listed keys; null removes one. A home dashboard must be one
// the person can see.
export async function setPrefs(user: User, raw: unknown): Promise<Prefs> {
  const p = parsePrefsPatch(raw);
  if (!p.ok) throw new WorkspaceInputError(p.error, p.problems);
  const v = p.value;
  if (typeof v.home === "string" && v.home.startsWith("dashboard:") && !(await visibleDashboard(user, v.home.slice(10))))
    throw new WorkspaceInputError("home: no such dashboard (or it isn't shared with you)", ["home: no such dashboard (or it isn't shared with you)"]);
  const db = await getDb();
  const now = Date.now();
  await db.tx(async (t) => {
    for (const [key, value] of Object.entries(v)) {
      if (value === null || value === undefined) await t.run("DELETE FROM user_prefs WHERE user_id = ? AND key = ?", [user.id, key]);
      else
        await t.run(
          `INSERT INTO user_prefs (user_id, key, value, updated_at) VALUES (?, ?, ?, ?)
           ON CONFLICT (user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
          [user.id, key, value, now],
        );
    }
  });
  return getPrefs(user);
}
