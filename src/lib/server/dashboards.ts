// Dashboards: each person's own and the ones shared with the team (docs/dashboards.md). The rules are pure
// (../dashboards.ts); this file stores them in the `dashboards` table (migration 6) and enforces who may see and change
// what. People only — API tokens never reach these routes (they aren't in tokenRoute, and personOf() re-checks).
//
// Optimistic concurrency: every change sends the version it edited; a stale version is refused with 409 and the
// current dashboard, never overwritten. Personal edits aren't audited; sharing is — making a dashboard visible to the
// team (or changing who on the team sees it, or deleting a shared one) writes an audit intent in the same transaction
// as the change, so the change can't land without its record.
import "server-only";
import {
  TEMPLATES, WORKSPACE_LIMITS, applyPatch, canEdit, canView, isVisibility, isWorkspaceId, normaliseLayout, parseDashboardCreate, parseDashboardPatch, storeLayout,
  type Dashboard, type DashboardDoc, type DashboardSummary, type TemplateInfo, type Visibility,
} from "../dashboards.ts";
import { isRole, type Role, type User } from "../rbac.ts";
import { writeAudit } from "./audit.ts";
import { getDb, newId, type Db } from "./db.ts";
import { HttpError, errText } from "./errors.ts";

// Who the audit log names (defaults to the person's email) and from where.
export interface Who {
  actor?: string;
  ip?: string;
}

// 400 with every problem found (the route answers { error, problems }).
export class WorkspaceInputError extends HttpError {
  problems: string[];
  constructor(error: string, problems: string[]) {
    super(400, error);
    this.name = "WorkspaceInputError";
    this.problems = problems;
  }
}

// 409: the dashboard changed since the caller loaded it. The route answers { error, code, version, dashboard }.
export class VersionConflictError extends HttpError {
  current: Dashboard;
  constructor(current: Dashboard) {
    super(409, `this dashboard was changed by someone else since you opened it (it is now version ${current.version}) — reload it and make your change again`);
    this.name = "VersionConflictError";
    this.code = "version_conflict";
    this.current = current;
  }
}

// Route wrapper for the workspace APIs: input problems and version conflicts keep their extra fields (handle() would
// keep only the message). A plain Response, so this module doesn't need next/server (tests import it under node).
const reply = (data: unknown, status: number) => Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
export async function workspaceErrors(fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof VersionConflictError) return reply({ error: e.message, code: e.code, version: e.current.version, dashboard: e.current }, 409);
    if (e instanceof WorkspaceInputError) return reply({ error: e.message, problems: e.problems }, 400);
    throw e;
  }
}

// ---------- sharing is audited ----------

export interface ShareChange {
  action: string; // "dashboard.share", "dashboard.delete", "saved.share", …
  target: string; // the item's name
  params: Record<string, unknown>; // ids and visibility — never widget configs or queries
}

const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

// Runs `fn` in one transaction; with a share change, an audit intent is written first and the result after, in the
// same transaction: a refused or conflicting change leaves neither, and no change lands without its intent.
export async function withShareAudit<T>(user: User, who: Who, share: ShareChange | undefined, fn: (db: Db) => Promise<T>): Promise<T> {
  const db = await getDb();
  return db.tx(async (t) => {
    const base = { env: "", target: cut(share?.target ?? "", 300), action: share?.action ?? "", user: who.actor ?? user.email, ip: who.ip, params: share?.params ?? {} };
    if (share) {
      try {
        await writeAudit({ ...base, at: Date.now(), phase: "intent" }, t);
      } catch (e) {
        throw new HttpError(503, `audit log unavailable, nothing was shared: ${errText(e)}`);
      }
    }
    const out = await fn(t);
    if (share) await writeAudit({ ...base, at: Date.now(), phase: "result", result: "ok" }, t);
    return out;
  });
}

// ---------- rows ----------

interface Row {
  id: string;
  owner_id: string;
  name: string;
  description: string | null;
  visibility: string;
  min_role: string | null;
  widgets: string;
  layout: string;
  template: string | null;
  version: number;
  created_at: number;
  updated_at: number;
  owner_email: string | null;
}

const SELECT = "SELECT d.*, u.email AS owner_email FROM dashboards d LEFT JOIN users u ON u.id = d.owner_id";

function parse(s: string | null, fallback: unknown): unknown {
  try {
    return s ? JSON.parse(s) : fallback;
  } catch {
    return fallback;
  }
}

const visOf = (v: string): Visibility => (isVisibility(v) ? v : "private");
const roleOf = (v: string | null): Role => (isRole(v) ? v : "viewer");
const shareOf = (r: Row) => ({ ownerId: r.owner_id, visibility: visOf(r.visibility), minRole: roleOf(r.min_role) });

function toDashboard(r: Row, user: User): Dashboard {
  const s = shareOf(r);
  return {
    id: r.id,
    name: r.name,
    ...(r.description ? { description: r.description } : {}),
    owner: { id: r.owner_id, ...(r.owner_email ? { email: r.owner_email } : {}) },
    visibility: s.visibility,
    minRole: s.minRole,
    widgets: normaliseLayout(parse(r.widgets, []), parse(r.layout, {})),
    ...(r.template ? { template: r.template } : {}),
    version: Number(r.version),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
    mine: r.owner_id === user.id,
    canEdit: canEdit(user, s),
  };
}

const docOf = (d: Dashboard): DashboardDoc => ({ name: d.name, ...(d.description ? { description: d.description } : {}), visibility: d.visibility, minRole: d.minRole, widgets: d.widgets });

async function rowOf(id: string, db?: Db): Promise<Row | undefined> {
  if (!isWorkspaceId(id)) return undefined;
  return (db ?? (await getDb())).get<Row>(`${SELECT} WHERE d.id = ?`, [id]);
}

const notFound = () => new HttpError(404, "no such dashboard (or it isn't shared with you)");

// A row the person may see, else 404 — a private dashboard of someone else is indistinguishable from none at all.
async function visibleRow(user: User, id: string, db?: Db): Promise<Row> {
  const r = await rowOf(id, db);
  if (!r || !canView(user, shareOf(r))) throw notFound();
  return r;
}

function editableRow(user: User, r: Row): Row {
  if (!canEdit(user, shareOf(r))) throw new HttpError(403, "only the dashboard's owner (or an admin, for one shared with the team) can change it");
  return r;
}

async function underLimit(db: Db, user: User) {
  const n = await db.get<{ n: number }>("SELECT COUNT(*) AS n FROM dashboards WHERE owner_id = ?", [user.id]);
  if (Number(n?.n ?? 0) >= WORKSPACE_LIMITS.dashboardsPerUser) throw new HttpError(409, `you already have ${WORKSPACE_LIMITS.dashboardsPerUser} dashboards — delete one first`);
}

async function insert(db: Db, user: User, id: string, doc: DashboardDoc, template: string | undefined, now: number): Promise<void> {
  const { widgets, layout } = storeLayout(doc.widgets);
  await db.run(
    "INSERT INTO dashboards (id, owner_id, name, description, visibility, min_role, widgets, layout, template, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)",
    [id, user.id, doc.name, doc.description ?? null, doc.visibility, doc.minRole, JSON.stringify(widgets), JSON.stringify(layout), template ?? null, now, now],
  );
}

const shareParams = (id: string, from: Visibility | null, to: Visibility, minRole: Role) => ({ dashboard: id, from, to, ...(to === "team" ? { minRole } : {}) });

// ---------- reads ----------

// Every dashboard the person may see — their own, and the team's they have the role for — newest change first, plus
// the built-in templates.
export async function listDashboards(user: User): Promise<{ dashboards: DashboardSummary[]; templates: TemplateInfo[] }> {
  const db = await getDb();
  const rows = await db.all<Row>(`${SELECT} WHERE d.owner_id = ? OR d.visibility = 'team' ORDER BY d.updated_at DESC LIMIT 2000`, [user.id]);
  const dashboards = rows
    .filter((r) => canView(user, shareOf(r)))
    .map((r) => {
      const { widgets, ...rest } = toDashboard(r, user);
      return { ...rest, widgetCount: widgets.length, types: [...new Set(widgets.map((w) => w.type))] };
    });
  return { dashboards, templates: TEMPLATES };
}

export async function getDashboard(user: User, id: string): Promise<Dashboard> {
  return toDashboard(await visibleRow(user, id), user);
}

// Whether a dashboard exists and the person may see it (the home-page preference refuses one they can't).
export async function visibleDashboard(user: User, id: string): Promise<boolean> {
  const r = await rowOf(id);
  return !!r && canView(user, shareOf(r));
}

// ---------- writes ----------

export async function createDashboard(user: User, raw: unknown, who: Who = {}): Promise<Dashboard> {
  const p = parseDashboardCreate(raw);
  if (!p.ok) throw new WorkspaceInputError(p.error, p.problems);
  const { template, ...doc } = p.value;
  const id = newId();
  const share: ShareChange | undefined = doc.visibility === "team" ? { action: "dashboard.share", target: doc.name, params: shareParams(id, null, "team", doc.minRole) } : undefined;
  await withShareAudit(user, who, share, async (t) => {
    await underLimit(t, user);
    await insert(t, user, id, doc, template, Date.now());
  });
  return getDashboard(user, id);
}

// PATCH { version, name?, description?, visibility?, minRole?, widgets? }. A stale version → 409 with the current one.
export async function updateDashboard(user: User, id: string, raw: unknown, who: Who = {}): Promise<Dashboard> {
  const p = parseDashboardPatch(raw);
  if (!p.ok) throw new WorkspaceInputError(p.error, p.problems);
  const cur = toDashboard(editableRow(user, await visibleRow(user, id)), user);
  if (p.value.version !== cur.version) throw new VersionConflictError(cur);
  const next = applyPatch(docOf(cur), p.value);
  if (!next.ok) throw new WorkspaceInputError(next.error, next.problems);
  const doc = next.value;
  const shared = doc.visibility !== cur.visibility || (doc.visibility === "team" && doc.minRole !== cur.minRole);
  const share: ShareChange | undefined = shared ? { action: "dashboard.share", target: doc.name, params: shareParams(id, cur.visibility, doc.visibility, doc.minRole) } : undefined;
  const { widgets, layout } = storeLayout(doc.widgets);
  await withShareAudit(user, who, share, async (t) => {
    const n = await t.run(
      "UPDATE dashboards SET name = ?, description = ?, visibility = ?, min_role = ?, widgets = ?, layout = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ?",
      [doc.name, doc.description ?? null, doc.visibility, doc.minRole, JSON.stringify(widgets), JSON.stringify(layout), Math.max(Date.now(), cur.updatedAt + 1), id, cur.version],
    );
    if (!n) {
      // Someone else's change landed between our read and this write.
      const now = await rowOf(id, t);
      if (!now) throw notFound();
      throw new VersionConflictError(toDashboard(now, user));
    }
  });
  // Echo the result even when the change hid it from the caller (an admin making someone's dashboard private).
  const row = await rowOf(id);
  if (!row) throw notFound();
  return toDashboard(row, user);
}

// Deleting a dashboard shared with the team takes it away from everyone, so that is audited too. Home-page
// preferences that pointed at it are cleared (their owners see the Overview again).
export async function deleteDashboard(user: User, id: string, who: Who = {}): Promise<{ id: string }> {
  const r = editableRow(user, await visibleRow(user, id));
  const s = shareOf(r);
  const share: ShareChange | undefined = s.visibility === "team" ? { action: "dashboard.delete", target: r.name, params: { dashboard: id, from: "team", owner: r.owner_id === user.id ? "self" : "other" } } : undefined;
  await withShareAudit(user, who, share, async (t) => {
    const n = await t.run("DELETE FROM dashboards WHERE id = ?", [id]);
    if (!n) throw notFound();
    await t.run("DELETE FROM user_prefs WHERE (key = 'home' AND value = ?) OR (key = 'dashboards.lastOpened' AND value = ?)", [`dashboard:${id}`, id]);
  });
  return { id };
}

// A private copy for the caller of any dashboard they may see: { name? } (default "Copy of <name>").
// A private copy shares nothing, so it isn't audited.
export async function duplicateDashboard(user: User, id: string, raw: unknown): Promise<Dashboard> {
  const src = toDashboard(await visibleRow(user, id), user);
  const body = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const extra = Object.keys(body).filter((k) => k !== "name");
  if (extra.length) throw new WorkspaceInputError(`${extra[0]}: unknown field`, extra.map((k) => `${k}: unknown field`));
  const want = Object.hasOwn(body, "name") && typeof body.name === "string" && body.name.trim() ? body.name : `Copy of ${src.name}`.slice(0, WORKSPACE_LIMITS.nameChars);
  const p = parseDashboardCreate({ name: want, ...(src.description ? { description: src.description } : {}), visibility: "private", minRole: "viewer", widgets: src.widgets });
  if (!p.ok) throw new WorkspaceInputError(p.error, p.problems);
  const copy = newId();
  await withShareAudit(user, {}, undefined, async (t) => {
    await underLimit(t, user);
    await insert(t, user, copy, p.value, src.template, Date.now());
  });
  return getDashboard(user, copy);
}
